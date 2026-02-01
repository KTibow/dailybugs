import { WorkflowEntrypoint, WorkflowEvent, WorkflowStep } from "cloudflare:workers";
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

    let title: string;
    let message: string;
    if (payload.testRun) {
      title = "Daily Bugs test run successful";
      message = `Test run successful.

Found ${commitEvents.length} commits.`;
    } else {
      title = "Your daily bugs";
      message = "TODO";
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
