import { env } from "cloudflare:workers";
import { Resend } from "resend";
const resend = new Resend(env.RESEND_KEY);

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
export const sendEmail = async (targetEmail: string, subject: string, text: string) => {
  const { error } = await resend.emails.send({
    from: "bugs@dailybugs.kendell.dev",
    to: targetEmail,
    subject,
    text: `${text}

Unsubscribe by revoking access at ${REVOKE_URL}.`,
    headers: {
      "list-unsubscribe": `<${REVOKE_URL}>`,
    },
  });
  if (error) {
    throw new Error(error.name);
  }
};
export const sendDiscord = async (text: string) => {
  const r = await fetch(env.DISCORD_WEBHOOK, {
    method: "POST",
    body: JSON.stringify({
      content: text,
    }),
  });
};
