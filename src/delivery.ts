import { env } from "cloudflare:workers";
import { parse } from "marked";

const REVOKE_URL = `https://github.com/settings/connections/applications/${env.GITHUB_CLIENT_ID}`;

export const getDelivery = async (uid: string) => {
  const result = await env.KV.get(`delivery:${uid}`);
  return result || "email";
};
export const setDelivery = async (uid: string, method: string) => {
  if (method == "email") {
    await env.KV.delete(`delivery:${uid}`);
  } else {
    await env.KV.put(`delivery:${uid}`, method);
  }
};
export const sendEmail = async (targetEmail: string, subject: string, markdown: string) => {
  const html = parse(`${markdown}

Unsubscribe by revoking access at ${REVOKE_URL}.`) as string;
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.RESEND_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      from: "Daily Bugs <bugs@dailybugs.kendell.dev>",
      to: targetEmail,
      subject,
      html,
      headers: {
        "list-unsubscribe": `<${REVOKE_URL}>`,
      },
    }),
  });
  if (!r.ok) throw new Error(`Resend is ${r.status}ing`);
};
export const sendDiscord = async (markdown: string) => {
  const postToDiscord = async (content: string) => {
    const r = await fetch(env.DISCORD_WEBHOOK, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content }),
    });
    if (!r.ok) throw new Error(`Discord is ${r.status}ing`);
  };

  let chunk = "";
  for (const line of markdown.split("\n")) {
    if ((chunk + "\n" + line).length > 2000) {
      await postToDiscord(chunk);
      chunk = line;
    } else {
      chunk = chunk ? chunk + "\n" + line : line;
    }
  }
  if (chunk) await postToDiscord(chunk);
};
