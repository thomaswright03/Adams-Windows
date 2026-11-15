import { createHmac, timingSafeEqual } from "node:crypto";

/** Sends one text. Returns Twilio's message id. */
export type SendFn = (to: string, body: string) => Promise<string>;

function env(name: string): string {
  return (process.env[name] ?? "").trim();
}

/** True while DRY_RUN is not "false": texts to leads are logged, never sent.
 * Texts to you (OWNER_PHONE) still go out so you can watch it work. */
export function isDryRun(): boolean {
  return env("DRY_RUN").toLowerCase() !== "false";
}

/** Sends through Twilio's REST API. Uses an API key (TWILIO_API_KEY_SID +
 * TWILIO_API_KEY_SECRET) if set, else the account's auth token. Sends
 * through the A2P-registered Messaging Service when
 * TWILIO_MESSAGING_SERVICE_SID is set, else from TWILIO_FROM_NUMBER. */
export const twilioSend: SendFn = async (to, body) => {
  const accountSid = env("TWILIO_ACCOUNT_SID");
  const user = env("TWILIO_API_KEY_SID") || accountSid;
  const pass = env("TWILIO_API_KEY_SECRET") || env("TWILIO_AUTH_TOKEN");
  if (!accountSid || !pass) throw new Error("Twilio is not configured (TWILIO_ACCOUNT_SID and a key or auth token).");

  const form = new URLSearchParams({ To: to, Body: body });
  const service = env("TWILIO_MESSAGING_SERVICE_SID");
  if (service) form.set("MessagingServiceSid", service);
  else if (env("TWILIO_FROM_NUMBER")) form.set("From", env("TWILIO_FROM_NUMBER"));
  else throw new Error("Set TWILIO_MESSAGING_SERVICE_SID or TWILIO_FROM_NUMBER.");

  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: form,
    signal: AbortSignal.timeout(15000),
  });
  const data = (await res.json().catch(() => ({}))) as { sid?: string; message?: string; code?: number };
  if (!res.ok) throw new Error(`Twilio send failed: ${res.status} ${data.code ?? ""} ${data.message ?? ""}`.trim());
  return data.sid ?? "";
};

/** Checks Twilio's X-Twilio-Signature header (HMAC-SHA1 of the full URL
 * plus the sorted POST fields, keyed with the auth token). */
export function validTwilioSignature(authToken: string, url: string, params: Record<string, string>, signature: string): boolean {
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join("");
  const expected = createHmac("sha1", authToken).update(data).digest("base64");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature ?? "");
  return a.length === b.length && timingSafeEqual(a, b);
}
