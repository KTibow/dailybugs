import { env } from "cloudflare:workers";
import { Octokit } from "@octokit/rest";
import { RequestCookieStore } from "@worker-tools/request-cookie-store";
import { sign, verify } from "@tsndr/cloudflare-worker-jwt";
import { setDelivery } from "./delivery";

type RequestExt = Request & { urlData: URL; cookieStore: RequestCookieStore };
const loadAuth = async (cookieStore: RequestCookieStore) => {
  const jwtInfo = await cookieStore.get("jwt");
  if (!jwtInfo) throw new Response("Unauthorized", { status: 401 });

  const jwtDecoded = await verify(jwtInfo.value, env.JWT_SECRET);
  if (!jwtDecoded) throw new Response("Unauthorized", { status: 401 });

  const {
    payload: { sub },
  } = jwtDecoded;
  if (!sub) throw new Response("Unauthorized", { status: 401 });

  return { sub };
};

const callback = async ({ urlData, cookieStore }: RequestExt): Promise<Response> => {
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

  const jwt = await sign({ sub: userId }, env.JWT_SECRET);
  await cookieStore.set({ name: "jwt", value: jwt, httpOnly: true });
  await env.KV.put(`ghtoken:${userId}`, accessToken);

  const home = new URL("/", urlData);
  return Response.redirect(home.href);
};

const changeDelivery = async ({
  urlData,
  formData,
  cookieStore,
}: RequestExt): Promise<Response> => {
  const { sub } = await loadAuth(cookieStore);

  const form = await formData();
  const method = form.get("method");
  if (typeof method != "string") throw new Response("Invalid data", { status: 400 });
  const data = form.get("data");
  if (data && typeof data != "string") throw new Response("Invalid data", { status: 400 });

  await setDelivery(sub, data ? `${method}:${data}` : method);

  const home = new URL("/", urlData);
  return Response.redirect(home.href);
};

export default {
  async fetch(_request) {
    const request = Object.assign(_request, {
      urlData: new URL(_request.url),
      cookieStore: new RequestCookieStore(_request),
    });
    try {
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
      throw new Response("Page not found", { status: 404 });
    } catch (e) {
      if (e instanceof Response) {
        return e;
      }
      throw e;
    }
  },
} satisfies ExportedHandler<Env>;
