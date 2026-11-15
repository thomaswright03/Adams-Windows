import type { VercelRequest, VercelResponse } from "@vercel/node";
import { config } from "../lib/config.js";
import { makeBot } from "../lib/runtime.js";
import { validTwilioSignature } from "../lib/twilio.js";

/** Twilio calls this for every text that comes in to the number.
 * Set the number's "A message comes in" webhook (HTTP POST) to
 * https://<your-app>.vercel.app/api/sms?secret=<WEBHOOK_SECRET> */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  const empty = () => res.status(200).setHeader("Content-Type", "text/xml").send("<Response></Response>");
  if (req.method !== "POST") return res.status(405).send("POST only");

  if (!config.webhookSecret || req.query.secret !== config.webhookSecret) return res.status(403).send("Forbidden");
  const params = Object.fromEntries(Object.entries((req.body ?? {}) as Record<string, unknown>).map(([k, v]) => [k, String(v)]));
  const authToken = process.env.TWILIO_AUTH_TOKEN?.trim();
  if (authToken) {
    const url = `https://${req.headers["x-forwarded-host"] ?? req.headers.host}${req.url}`;
    if (!validTwilioSignature(authToken, url, params, String(req.headers["x-twilio-signature"] ?? ""))) {
      console.log(JSON.stringify({ event: "bad_twilio_signature", url }));
      return res.status(403).send("Bad signature");
    }
  }

  const from = params.From ?? "";
  const body = params.Body ?? "";
  if (!from) return empty();
  try {
    await makeBot().bot.handleInbound(from, body, params.MessageSid ?? "");
  } catch (err: any) {
    // Logged, not retried: a Twilio retry could double-send a reply.
    console.log(JSON.stringify({ event: "inbound_failed", from, error: err?.message, stack: err?.stack }));
  }
  return empty();
}
