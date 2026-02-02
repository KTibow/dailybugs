import { env } from "cloudflare:workers";
import { sign, verify } from "@tsndr/cloudflare-worker-jwt";
import { RequestCookieStore } from "@worker-tools/request-cookie-store";

const maxAge = 30 * 24 * 60 * 60 * 1000;
export const getAuth = async (cookieStore: RequestCookieStore) => {
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
export const setAuth = async (cookieStore: RequestCookieStore, sub: string) => {
  const jwt = await sign({ sub }, env.JWT_SECRET);
  await cookieStore.set({ name: "jwt", value: jwt, httpOnly: true, expires: Date.now() + maxAge });
};
export const deleteAuth = async (cookieStore: RequestCookieStore) => {
  await cookieStore.delete("jwt");
};
