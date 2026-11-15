import { Bot } from "./bot.js";
import { draftReply } from "./claude.js";
import { getKv } from "./kv.js";
import { Store } from "./store.js";
import { isDryRun, twilioSend } from "./twilio.js";

/** The bot wired to the real services (Redis, Twilio, Claude). */
export function makeBot(): { bot: Bot; store: Store } {
  const store = new Store(getKv());
  return { store, bot: new Bot({ store, send: twilioSend, draft: draftReply, dryRun: isDryRun() }) };
}
