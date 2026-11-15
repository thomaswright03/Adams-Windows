import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import * as z from "zod/v4";
import { config } from "./config.js";
import { buildSystemPrompt, renderConversation } from "./prompt.js";
import type { Lead, Turn } from "./store.js";

export const ReplyDecision = z.object({
  /** The text to send, or null when the bot should not answer. */
  reply: z.string().nullable(),
  /** Set when you (the owner) need to see this conversation: why. */
  handoff: z.string().nullable(),
  /** The day/time the customer asked for, in their words, if they did. */
  requestedTime: z.string().nullable(),
});
export type ReplyDecision = z.infer<typeof ReplyDecision>;

export type DraftFn = (lead: Lead, history: Turn[], now: Date) => Promise<ReplyDecision>;

let client: Anthropic | undefined;

export const draftReply: DraftFn = async (lead, history, now) => {
  client ??= new Anthropic();
  const response = await client.beta.messages.parse({
    model: config.model,
    max_tokens: 2000,
    betas: ["server-side-fallback-2026-07-01"],
    // If the model declines, the API retries on its fallback model itself.
    fallbacks: "default",
    output_config: { effort: "low", format: betaZodOutputFormat(ReplyDecision) },
    system: buildSystemPrompt(),
    messages: [{ role: "user", content: renderConversation(lead, history, now) }],
  });

  if (response.stop_reason === "refusal") {
    return { reply: null, handoff: "Claude declined to answer this one", requestedTime: null };
  }
  const parsed = response.parsed_output;
  if (!parsed) return { reply: null, handoff: "Claude's answer could not be read", requestedTime: null };
  return parsed;
};
