import { env } from "cloudflare:workers";
import github from "./github";

const callback = async (_: Request, url: URL): Promise<Response> => {
  const code = url.searchParams.get("code");
  if (!code) return new Response("Code not provided", { status: 400 });

  const r = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      code,
    }),
  });
  if (!r.ok) return new Response(`GitHub is ${r.status}ing`, { status: 500 });

  const tokenData = await r.json<any>();
  if (tokenData.error) return new Response(`GitHub says ${tokenData.error}`, { status: 500 });
  const accessToken = tokenData.access_token as string;

  const userData = await github(accessToken, "/user");
  await env.USERS.put(userData.id, accessToken);

  return new Response("OK");
};

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname == "/callback") {
      if (request.method == "GET") {
        return await callback(request, url);
      }
      return new Response("Method not allowed", { status: 405 });
    }
    return new Response("Page not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
