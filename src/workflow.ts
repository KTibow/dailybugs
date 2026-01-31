import { WorkflowEntrypoint, WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { Octokit } from "@octokit/rest";
import { Endpoints } from "@octokit/types";

type Params = { token: string };
type CommitEventBase = Endpoints["GET /users/{username}/events/public"]["response"]["data"][0];
type CommitEvent = CommitEventBase & {
  repo: { name: string };
  payload: { ref: string; head: string; before: string };
  created_at: string;
};
export class BugWorkflow extends WorkflowEntrypoint<Env, Params> {
  async run({ timestamp, payload }: WorkflowEvent<Params>, step: WorkflowStep) {
    const octokit = new Octokit({ auth: payload.token });
    const cutoff = new Date(timestamp.getTime() - 24 * 3600 * 1000);

    const username = await step.do("get username", async () => {
      const { data } = await octokit.request("GET /user");
      return data.login;
    });

    const commitEvents = await step.do(`load all pages`, () =>
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
          return response.data;
        },
      ),
    );

    // TODO: process commit events
  }
}
