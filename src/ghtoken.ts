import { env } from 'cloudflare:workers';

export const getToken = async (id: string) => {
  const token = await env.KV.get(`ghtoken:${id}`);
  if (!token) throw new Error('No token found');
  return token;
};
export const setToken = (id: string, token: string) => env.KV.put(`ghtoken:${id}`, token);
export const deleteToken = (id: string) => env.KV.delete(`ghtoken:${id}`);
export const listUIDs = async () => {
  const result = await env.KV.list({ prefix: 'ghtoken:' });
  return result.keys.map((k) => k.name.replace('ghtoken:', ''));
};
