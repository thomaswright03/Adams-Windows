import type { VercelRequest, VercelResponse } from "@vercel/node";
import { config } from "../lib/config.js";
import { makeBot } from "../lib/runtime.js";

/** The scheduled run: first texts, nudges, closing out the campaign. Called
 * every 10 minutes by .github/workflows/tick.yml with the WEBHOOK_SECRET. */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  const secret = String(req.headers["x-bot-secret"] ?? req.query.secret ?? "");
  if (!config.webhookSecret || secret !== config.webhookSecret) return res.status(403).send("Forbidden");
  try {
    const result = await makeBot().bot.tick();
    console.log(JSON.stringify({ event: "tick", ...result }));
    return res.status(200).json(result);
  } catch (err: any) {
    console.log(JSON.stringify({ event: "tick_failed", error: err?.message, stack: err?.stack }));
    return res.status(500).json({ error: err?.message });
  }
}
