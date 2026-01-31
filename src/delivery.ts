import { env } from "cloudflare:workers";
import { Resend } from "resend";
const resend = new Resend(env.RESEND_KEY);

export const sendEmail = async (targetEmail: string, subject: string, text: string) => {
  const { error } = await resend.emails.send({
    from: "bugs@dailybugs.kendell.dev",
    to: targetEmail,
    subject,
    text,
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
