import { env } from "cloudflare:workers";

export const getToken = (id: string) => env.KV.get(`ghtoken:${id}`);
export const setToken = (id: string, token: string) => env.KV.put(`ghtoken:${id}`, token);
export const deleteToken = (id: string) => env.KV.delete(`ghtoken:${id}`);
