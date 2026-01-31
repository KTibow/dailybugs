export default async (token: string, url: string, init?: RequestInit) => {
  const r = await fetch(`https://api.github.com${url}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "user-agent": "https://github.com/KTibow/daily-bugs",
      ...init?.headers,
    },
  });
  if (!r.ok) throw new Error(`GitHub is ${r.status}ing`);
  return await r.json<any>();
};
