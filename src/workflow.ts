import { env, WorkflowEntrypoint, WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { Octokit } from "@octokit/rest";
import { Endpoints } from "@octokit/types";
import { getDelivery, sendDiscord, sendEmail } from "./delivery";
import { deleteToken, getToken } from "./ghtoken";

type Params = { uid: string; testRun: boolean };
type CommitEventBase = Endpoints["GET /users/{username}/events/public"]["response"]["data"][0];
type CommitEvent = CommitEventBase & {
  repo: { name: string };
  payload: { ref: string; head: string; before: string };
  created_at: string;
};
type DiffData = { repo: string; ref: string; old: string; new: string; diff: string };
type BugData = { repo: string; path: string; old: string; new: string; description: string };
const collapseLockFiles = (diff: string) =>
  diff.replace(
    /(?<=\n|^)diff --git a\/((?:[a-z-]+\/)*(?:pnpm-lock.yaml|package-lock.json|yarn.lock|uv.lock)) b\/\1\nindex .+\n--- .+\n\+\+\+ .+\n[^]+?(?=\ndiff --git|$)/g,
    "[Collapsed diff for $1]",
  );
const batchDiffs = (diffs: DiffData[], softLimit: number) => {
  const batches: DiffData[][] = [];
  for (const diff of diffs) {
    const lastBatch = batches.at(-1);
    if (!lastBatch) {
      batches.push([diff]);
      continue;
    }
    const currentWeight = lastBatch.reduce((acc, { diff }) => acc + diff.length, 0);
    const newWeight = currentWeight + diff.diff.length;
    if (newWeight > softLimit) {
      batches.push([diff]);
      continue;
    }
    lastBatch.push(diff);
  }
  return batches;
};
export class BugWorkflow extends WorkflowEntrypoint<Env, Params> {
  async run({ timestamp, payload }: WorkflowEvent<Params>, step: WorkflowStep) {
    const mustSucceed = async <T>(fn: () => Promise<T>) => {
      try {
        return await fn();
      } catch (e) {
        await step.do("delete token", () => deleteToken(payload.uid));
        throw e;
      }
    };
    const { octokit, userData, email, method, data } = await mustSucceed(async () => {
      const deliveryStep = step.do("get delivery", async () => {
        const delivery = await getDelivery(payload.uid);
        return delivery.split(":");
      });

      const token = await step.do("load token", () => getToken(payload.uid));
      const octokit = new Octokit({ auth: token });
      const userData = await step.do("load user data", async () => {
        const { data } = await octokit.request("GET /user");
        return data;
      });
      const email = await step.do("load user email", async () => {
        const { data } = await octokit.request("GET /user/emails");
        return data.find((email) => email.verified && email.primary)?.email;
      });

      const [method, data] = await deliveryStep;
      return { octokit, userData, email, method, data };
    });

    const username = userData.login;

    const cutoff = new Date(timestamp.getTime() - 24 * 3600 * 1000);
    const commitEvents = await step.do("load all pages", () =>
      octokit.paginate(
        "GET /users/{username}/events/public",
        { username, per_page: 100 },
        (response, done) => {
          const events = response.data.filter(
            (event): event is CommitEvent => event.type == "PushEvent",
          );
          const eventsInScope = events.filter(
            (event) => new Date(event.created_at).getTime() > cutoff.getTime(),
          );
          if (eventsInScope.length < events.length) {
            done();
          }
          return eventsInScope;
        },
      ),
    );
    const aggregatedCommits: Record<string, Record<string, { old: string; new: string }>> = {};
    for (const commit of commitEvents) {
      const repo = (aggregatedCommits[commit.repo.name] ??= {});
      if (repo[commit.payload.ref]) {
        repo[commit.payload.ref].old = commit.payload.before;
      } else {
        repo[commit.payload.ref] = { new: commit.payload.head, old: commit.payload.before };
      }
    }

    const diffs: DiffData[] = [];
    const warnings: string[] = [];
    for (const repo in aggregatedCommits) {
      for (const ref in aggregatedCommits[repo]) {
        const { old, new: neww } = aggregatedCommits[repo][ref];
        const diff = await step.do(`load diff for ${ref} from ${repo}`, async () => {
          const { data } = await octokit.request(
            "GET /repos/{owner}/{repo}/compare/{base}...{head}",
            {
              owner: repo.split("/")[0],
              repo: repo.split("/")[1],
              base: old,
              head: neww,
              mediaType: {
                format: "diff",
              },
            },
          );
          return collapseLockFiles(data as unknown as string);
        });
        if (diff.length > 100000 * 4) {
          warnings.push(`Changes on ${ref} from ${repo} were ignored`);
          continue;
        }
        diffs.push({ repo, ref, old, new: neww, diff });
      }
    }
    diffs.sort((a, b) => a.diff.length - b.diff.length);

    let batches = batchDiffs(diffs, 8192 * 4);
    if (batches.length > 8) {
      const discardedBatches = batches.length - 8;
      warnings.push(
        `Only 8 batches of diffs could be scanned; ${discardedBatches} ${discardedBatches == 1 ? "batch" : "batches"} were ignored`,
      );
      batches = batches.slice(0, 8);
    }

    let title: string;
    let message: string;
    if (payload.testRun) {
      title = "Daily Bugs test run successful";
      message = `Test run successful.

Created ${batches.length} batches, made of ${diffs.length} diffs from ${commitEvents.length} commits across ${Object.keys(aggregatedCommits).length} repos.`;
    } else {
      const bugs: BugData[] = [];
      let batchNumber = 0;
      for (const batch of batches) {
        console.debug(`processing batch ${batchNumber}...`);
        const batchBugs = await step.do(`process batch ${batchNumber}`, async () => {
          const prompt = `You are the Daily Bugs agent. You are reviewing yesterday's changes:

${batch
  .map(
    ({
      repo,
      ref,
      old,
      new: neww,
      diff,
    }) => `# ${repo} (${ref}) (old: ${old.slice(0, 6)}, new: ${neww.slice(0, 6)})
<diff>
${diff}
</diff>`,
  )
  .join("\n\n")}

Task:
Identify HIGH-CONFIDENCE bugs introduced by these diffs.

Calibration:
- It is NORMAL for a diff to have zero bugs.
- It is NORMAL for the entire batch to have zero bugs; many days should output [].
- False positives are worse than false negatives. If unsure, do not report it. If your confidence is below ~80%, skip it.
- Only report an issue if it is directly supported by the diff (no speculation about unseen context).
- Ignore intentional changes, refactors, stylistic changes, modern language features, or anything requiring extra context to judge.

Context:
- Today is ${new Date().toLocaleDateString()}.
- You can assume that the CSS Functions and Mixins module is active, which allows for syntax like @function --echo(--val) { result: var(--val) }, @mixin --red { color: red }, and @apply --red.

Output:
Return JSON using schema:
{repo: string; old: string; new: string; path: string; description: string}[].
- "old" and "new" must be SHAs diffable with each other.
- "description" must be no more than a sentence or two.
- If you find no high-confidence bugs, output [] and nothing else.`;
          const r = await fetch("https://ai.hackclub.com/proxy/v1/chat/completions", {
            method: "POST",
            headers: {
              authorization: `Bearer ${env.HCAI_KEY}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({
              model: "google/gemini-3-flash-preview",
              messages: [{ role: "user", content: prompt }],
              reasoning: { enabled: true },
            }),
          });
          if (!r.ok) throw new Error(`HCAI is ${r.status}ing: ${await r.text()}`);

          const {
            choices: [{ message }],
          } = await r.json<any>();
          console.debug(message);
          const json = message.content.slice(
            message.content.indexOf("["),
            message.content.lastIndexOf("]") + 1,
          );
          return JSON.parse(json);
        });
        bugs.push(...batchBugs);
        batchNumber++;
      }
      console.debug("done processing batches...");

      title = "Your daily bugs";
      message = bugs
        .map((b) => {
          const name = b.repo.split("/")[1];
          return `- ${name}: ${b.description} ([file](<https://github.com/${b.repo}/blob/${b.new}/${b.path}>), [changes](<https://github.com/${b.repo}/compare/${b.old}...${b.new}>))`;
        })
        .join("\n");
    }

    if (warnings.length) {
      message = `${message}

${warnings.map((w) => `⚠️ ${w}`).join("\n")}`;
    }

    if (!message) return;

    if (method == "email") {
      if (!email) {
        await step.do("delete token", () => deleteToken(payload.uid));
        throw new Error("No available email");
      }
      await step.do("send email message", () => sendEmail(email, title, message));
    } else if (method == "discord") {
      if (!data) {
        await step.do("delete token", () => deleteToken(payload.uid));
        throw new Error("No available data");
      }
      message = `<@${data}>
${message}`;
      await step.do("send discord message", () => sendDiscord(message));
    } else {
      await step.do("delete token", () => deleteToken(payload.uid));
      throw new Error("Unreachable");
    }
  }
}
