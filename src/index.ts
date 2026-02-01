import { env } from "cloudflare:workers";
import { Octokit } from "@octokit/rest";
import { RequestCookieStore } from "@worker-tools/request-cookie-store";
import { getDelivery, setDelivery } from "./delivery";
import { deleteToken, getToken, setToken } from "./ghtoken";
import { deleteAuth, getAuth, setAuth } from "./jwt";

type RequestExt = Request & { urlData: URL; cookieStore: RequestCookieStore };

const redirect = (location: string) =>
  new Response(undefined, { status: 302, headers: { location } });
const getWorkflowTimestamp = () =>
  new Date()
    .toISOString()
    .slice(0, 22)
    .replace(/[^0-9a-z]/i, "-");

const callback = async ({ urlData, cookieStore }: RequestExt) => {
  const code = urlData.searchParams.get("code");
  if (!code) throw new Response("Code not provided", { status: 400 });

  const r = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      code,
    }),
  });
  if (!r.ok) throw new Response(`GitHub is ${r.status}ing`, { status: 500 });

  const tokenData = await r.json<any>();
  if (tokenData.error) throw new Response(`GitHub says ${tokenData.error}`, { status: 500 });

  const accessToken = tokenData.access_token as string;
  const octokit = new Octokit({ auth: accessToken });

  const { data: userData } = await octokit.request("GET /user");
  const userId = userData.id.toString();

  await setToken(userId, accessToken);
  await setAuth(cookieStore, userId);

  return redirect("/");
};

const changeDelivery = async (request: RequestExt) => {
  const { sub } = await getAuth(request.cookieStore);

  const form = await request.formData();
  const method = form.get("method");
  if (typeof method != "string") throw new Response("Invalid data", { status: 400 });
  const data = form.get("data");
  if (data && typeof data != "string") throw new Response("Invalid data", { status: 400 });

  await setDelivery(sub, data ? `${method}:${data}` : method);

  return redirect("/");
};

const root = async (request: RequestExt): Promise<Response> => {
  if (request.urlData.pathname == "/callback") {
    if (request.method == "GET") {
      return await callback(request);
    }
    throw new Response("Method not allowed", { status: 405 });
  }
  if (request.urlData.pathname == "/changedelivery") {
    if (request.method == "POST") {
      return await changeDelivery(request);
    }
    throw new Response("Method not allowed", { status: 405 });
  }
  if (request.urlData.pathname == "/test") {
    if (request.method == "POST") {
      const { sub } = await getAuth(request.cookieStore);
      await env.WORKFLOW.create({
        id: `${sub}--manual-wet-${getWorkflowTimestamp()}`,
        params: {
          uid: sub,
          testRun: false,
        },
      });
      await request.cookieStore.set({ name: "flash-run-started", value: "yes", httpOnly: true });
      return redirect("/");
    }
    throw new Response("Method not allowed", { status: 405 });
  }
  if (request.urlData.pathname == "/debug") {
    if (request.method == "POST") {
      const { sub } = await getAuth(request.cookieStore);
      await env.WORKFLOW.create({
        id: `${sub}--manual-dry-${getWorkflowTimestamp()}`,
        params: {
          uid: sub,
          testRun: true,
        },
      });
      await request.cookieStore.set({ name: "flash-debug-started", value: "yes", httpOnly: true });
      return redirect("/");
    }
    throw new Response("Method not allowed", { status: 405 });
  }
  if (request.urlData.pathname == "/") {
    let sub: string;
    try {
      ({ sub } = await getAuth(request.cookieStore));
    } catch {
      return await env.ASSETS.fetch(new URL("/index-loggedout.html", request.url));
    }

    let userData: { login: string };
    try {
      const token = await getToken(sub);
      const octokit = new Octokit({ auth: token });
      ({ data: userData } = await octokit.request("GET /user"));
    } catch {
      await deleteToken(sub);
      await deleteAuth(request.cookieStore);
      return redirect("/revoked");
    }

    const method = (await getDelivery(sub)).split(":")[0];

    const r = await env.ASSETS.fetch(new URL("/index-loggedin.html", request.url));
    let html = await r.text();
    if (await request.cookieStore.get("flash-run-started")) {
      await request.cookieStore.delete("flash-run-started");
      html = html.replace(/<h1>.+?<\/h1>/, "<h1>Run started - be patient.</h1>");
    }
    if (await request.cookieStore.get("flash-debug-started")) {
      await request.cookieStore.delete("flash-debug-started");
      html = html.replace(/<h1>.+?<\/h1>/, "<h1>Debug run started.</h1>");
      html = html.replace("Run in debug mode", "Run again in debug mode");
    }
    html = html.replace("[username]", userData.login);
    html = html.replace(/<!-- via (.+) -->[^]+?<!-- end via \1 -->/g, (text, thisMethod) =>
      thisMethod == method ? text : "",
    );
    return new Response(html, {
      status: r.status,
      headers: r.headers,
    });
  }
  throw new Response("Page not found", { status: 404 });
};
const rootWithCatch = async (request: RequestExt): Promise<Response> => {
  try {
    return await root(request);
  } catch (e) {
    if (e instanceof Response) {
      return e;
    }
    throw e;
  }
};
export default {
  async fetch(_request) {
    const request = Object.assign(_request, {
      urlData: new URL(_request.url),
      cookieStore: new RequestCookieStore(_request),
    });
    const response = await rootWithCatch(request);
    return new Response(response.body, {
      status: response.status,
      headers: [...response.headers, ...request.cookieStore.headers],
    });
  },
} satisfies ExportedHandler<Env>;
export { BugWorkflow } from "./workflow";
