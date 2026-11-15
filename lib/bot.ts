import { business, firstName, renderFirstText } from "./business.js";
import { config } from "./config.js";
import type { DraftFn } from "./claude.js";
import { evaluateInbound, isCarrierOptOutKeyword, isResubscribeKeyword, notAMessageReason, stopNeedsPersonReasons } from "./safety.js";
import { localDate, normalizePhone, type Lead, type Store, type Turn } from "./store.js";
import type { SendFn } from "./twilio.js";

export interface BotDeps {
  store: Store;
  send: SendFn;
  draft: DraftFn;
  dryRun: boolean;
  now?: () => Date;
  log?: (event: Record<string, unknown>) => void;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export class Bot {
  constructor(private deps: BotDeps) {}

  private get store() {
    return this.deps.store;
  }
  private now() {
    return this.deps.now ? this.deps.now() : new Date();
  }
  private log(event: Record<string, unknown>) {
    (this.deps.log ?? ((e) => console.log(JSON.stringify(e))))(event);
  }

  // -------------------------------------------------------------------------
  // Sending
  // -------------------------------------------------------------------------

  /** Texts a lead and records it. In dry run nothing reaches the lead. The
   * opt-out list is checked here too, so no path can text an opted-out number. */
  async textLead(lead: Lead, body: string, by: Turn["by"]): Promise<boolean> {
    if (await this.store.isOptedOut(lead.phone)) {
      this.log({ event: "blocked_opted_out", phone: lead.phone });
      return false;
    }
    if (this.deps.dryRun) {
      this.log({ event: "dry_run_text", phone: lead.phone, body });
    } else {
      await this.deps.send(lead.phone, body);
    }
    const at = this.now().toISOString();
    await this.store.addTurn(lead.phone, { dir: "out", body: this.deps.dryRun ? `[dry run, not sent] ${body}` : body, at, by });
    lead.lastOutboundAt = at;
    return true;
  }

  /** Texts you. Always sent (even in dry run); a failure is logged, never thrown. */
  async tellOwner(body: string): Promise<void> {
    const owner = normalizePhone(config.ownerPhone);
    if (!owner) {
      this.log({ event: "owner_phone_missing", body });
      return;
    }
    try {
      await this.deps.send(owner, body);
    } catch (err: any) {
      this.log({ event: "owner_text_failed", error: err?.message, body });
    }
  }

  // -------------------------------------------------------------------------
  // Incoming texts
  // -------------------------------------------------------------------------

  async handleInbound(fromRaw: string, body: string, messageSid = ""): Promise<void> {
    const from = normalizePhone(fromRaw) ?? fromRaw;
    if (!(await this.store.firstTimeSeen(messageSid))) return;

    if (from === normalizePhone(config.ownerPhone)) {
      await this.handleOwnerCommand(body);
      return;
    }

    const lead = await this.store.getLead(from);
    if (!lead) {
      await this.tellOwner(`Text from a number not on your list, ${pretty(from)}: "${clip(body)}". The bot did not answer it.`);
      return;
    }

    const now = this.now();
    await this.store.addTurn(lead.phone, { dir: "in", body, at: now.toISOString() });
    lead.lastInboundAt = now.toISOString();
    const who = label(lead);

    if (lead.status === "opted_out" || (await this.store.isOptedOut(lead.phone))) {
      if (isResubscribeKeyword(body)) await this.tellOwner(`${who} texted "${clip(body)}" after opting out. The bot will not text them again; reach out yourself if they want service.`);
      await this.store.saveLead(lead);
      return;
    }

    const verdict = evaluateInbound(body, {} as any);
    if (verdict.action === "opt_out") {
      await this.recordOptOut(lead, body);
      return;
    }

    if (lead.status === "excluded" || lead.status === "needs_you") {
      await this.store.saveLead(lead);
      await this.tellOwner(`${who}: "${clip(body)}" (the bot is not answering this one; it's yours).`);
      return;
    }

    if (this.campaignOver(lead, now)) {
      await this.store.saveLead(lead);
      await this.tellOwner(`${who} replied after the ${config.campaignDays}-day window: "${clip(body)}". The bot did not answer.`);
      return;
    }

    if (verdict.action === "escalate") {
      await this.handOff(lead, verdict.reason, body);
      return;
    }

    if (await this.store.paused()) {
      await this.store.saveLead(lead);
      await this.tellOwner(`${who}: "${clip(body)}" (bot is paused, so it did not answer. Text RESUME to turn it back on).`);
      return;
    }

    let decision;
    try {
      decision = await this.deps.draft(lead, await this.store.history(lead.phone), now);
    } catch (err: any) {
      this.log({ event: "draft_failed", phone: lead.phone, error: err?.message });
      await this.handOff(lead, "the bot hit an error writing a reply", body);
      return;
    }

    const reply = decision.reply?.trim() || null;
    const badReply = reply ? notAMessageReason(reply, firstName(lead.name)) : null;
    const handoff = decision.handoff || (badReply ? `the drafted reply looked wrong (${badReply})` : null);

    if (decision.requestedTime) {
      lead.requestedTime = decision.requestedTime;
      lead.status = "booked";
    } else if (lead.status === "texted" || lead.status === "queued") {
      lead.status = "replied";
    }

    if (reply && !badReply) {
      await this.store.dropDraftsFor(lead.phone);
      if (await this.store.autoSend()) {
        await this.textLead(lead, reply, "bot");
      } else {
        const draft = await this.store.addDraft({ phone: lead.phone, body: reply, createdAt: now.toISOString() });
        await this.tellOwner(
          `#${draft.id} ${who} said: "${clip(body)}"\nDraft: "${reply}"\nReply Y${draft.id} to send, N${draft.id} to skip, or E${draft.id} followed by your own text.`
        );
      }
    }

    if (decision.requestedTime) {
      await this.tellOwner(`BOOKING REQUEST: ${who} wants "${decision.requestedTime}". Confirm the time with them.${lead.notes ? ` Notes: ${clip(lead.notes, 120)}` : ""}`);
    }

    if (handoff) {
      await this.handOff(lead, handoff, body);
      return;
    }
    await this.store.saveLead(lead);
  }

  private async recordOptOut(lead: Lead, body: string): Promise<void> {
    await this.store.addOptOut(lead.phone);
    await this.store.dropDraftsFor(lead.phone);
    lead.status = "opted_out";
    lead.reason = `said "${clip(body, 80)}"`;
    // Twilio answers STOP, UNSUBSCRIBE and the like itself; other wordings
    // ("please don't text me") get one confirmation from us.
    if (!isCarrierOptOutKeyword(body) && !this.deps.dryRun) {
      try {
        await this.deps.send(lead.phone, `You won't get any more texts from ${business.name}. Sorry to bother you.`);
      } catch (err: any) {
        this.log({ event: "opt_out_confirmation_failed", phone: lead.phone, error: err?.message });
      }
    }
    await this.store.saveLead(lead);
    const needsYou = stopNeedsPersonReasons(body);
    await this.tellOwner(`${label(lead)} opted out: "${clip(body)}".${needsYou.length ? ` Please read it yourself (${needsYou.join(", ")}).` : ""}`);
  }

  private async handOff(lead: Lead, reason: string, body: string): Promise<void> {
    lead.status = "needs_you";
    lead.reason = reason;
    await this.store.saveLead(lead);
    await this.tellOwner(
      `NEEDS YOU: ${label(lead)} said "${clip(body)}". Reason: ${reason}. The bot stopped answering them. Text S ${lead.phone.slice(2)} followed by a message to reply from this number, or R ${lead.phone.slice(2)} to hand them back to the bot.`
    );
  }

  private campaignOver(lead: Lead, now: Date): boolean {
    if (!lead.firstTextAt) return false;
    return now.getTime() - Date.parse(lead.firstTextAt) > config.campaignDays * DAY_MS;
  }

  // -------------------------------------------------------------------------
  // Your commands (texts from OWNER_PHONE)
  // -------------------------------------------------------------------------

  async handleOwnerCommand(raw: string): Promise<void> {
    const text = raw.trim();
    const upper = text.toUpperCase();
    let m: RegExpMatchArray | null;

    if ((m = text.match(/^([YNE])\s*#?(\d+)\b\s*([\s\S]*)$/i))) {
      const [, action, idText, rest] = m;
      const id = Number(idText);
      const draft = await this.store.takeDraft(id);
      if (!draft) return this.tellOwner(`Draft #${id} is gone (already used, skipped, or replaced by a newer one).`);
      const lead = await this.store.getLead(draft.phone);
      if (!lead) return this.tellOwner(`Draft #${id}'s lead is no longer on the list.`);
      if (action!.toUpperCase() === "N") return this.tellOwner(`Skipped #${id}.`);
      const body = action!.toUpperCase() === "E" ? rest!.trim() : draft.body;
      if (!body) return this.tellOwner(`Nothing to send: put your text after E${id}.`);
      const sent = await this.textLead(lead, body, action!.toUpperCase() === "E" ? "owner" : "bot");
      await this.store.saveLead(lead);
      return this.tellOwner(sent ? `Sent #${id} to ${label(lead)}.${this.deps.dryRun ? " (dry run: logged, not texted)" : ""}` : `Not sent: ${label(lead)} opted out.`);
    }

    if ((m = text.match(/^S\s+([\d()+.\s-]{10,})\s+([\s\S]+)$/i))) {
      const lead = await this.leadByPhone(m[1]!);
      if (!lead) return this.tellOwner(`No lead with the number ${m[1]!.trim()}.`);
      const sent = await this.textLead(lead, m[2]!.trim(), "owner");
      await this.store.saveLead(lead);
      return this.tellOwner(sent ? `Sent to ${label(lead)}.` : `Not sent: ${label(lead)} opted out.`);
    }

    if ((m = text.match(/^R\s+([\d()+.\s-]{10,})$/i))) {
      const lead = await this.leadByPhone(m[1]!);
      if (!lead) return this.tellOwner(`No lead with the number ${m[1]!.trim()}.`);
      if (lead.status !== "needs_you") return this.tellOwner(`${label(lead)} isn't waiting on you (status: ${lead.status}).`);
      lead.status = "replied";
      lead.reason = undefined;
      await this.store.saveLead(lead);
      return this.tellOwner(`${label(lead)} is back with the bot. It answers their next text.`);
    }

    if ((m = text.match(/^X\s+([\d()+.\s-]{10,})$/i))) {
      const lead = await this.leadByPhone(m[1]!);
      if (!lead) return this.tellOwner(`No lead with the number ${m[1]!.trim()}.`);
      lead.status = "excluded";
      await this.store.saveLead(lead);
      await this.store.dropDraftsFor(lead.phone);
      return this.tellOwner(`${label(lead)} excluded. The bot won't text or answer them.`);
    }

    if (upper === "PAUSE" || upper === "STOP BOT") {
      await this.store.setPaused(true);
      return this.tellOwner("Bot paused. Nothing goes out to leads until you text RESUME. Incoming texts are forwarded to you.");
    }
    if (upper === "RESUME") {
      await this.store.setPaused(false);
      return this.tellOwner("Bot running again.");
    }
    if (upper === "AUTO ON") {
      await this.store.setAutoSend(true);
      return this.tellOwner("Automatic mode on: the bot sends its replies without asking you. Text AUTO OFF to go back to review mode.");
    }
    if (upper === "AUTO OFF") {
      await this.store.setAutoSend(false);
      return this.tellOwner("Review mode on: every reply waits for your Y/N/E.");
    }
    if (upper === "STATUS" || upper === "REPORT") {
      return this.tellOwner(await this.statusText());
    }

    return this.tellOwner(
      "Commands: Y12 send draft 12 / N12 skip it / E12 your text: send yours instead / S 6025551234 message: text a lead / R 6025551234: hand back to bot / X 6025551234: exclude / PAUSE / RESUME / AUTO ON / AUTO OFF / STATUS"
    );
  }

  private async leadByPhone(raw: string): Promise<Lead | null> {
    const phone = normalizePhone(raw);
    return phone ? this.store.getLead(phone) : null;
  }

  async statusText(): Promise<string> {
    const leads = await this.store.allLeads();
    const count = (s: Lead["status"]) => leads.filter((l) => l.status === s).length;
    const drafts = await this.store.pendingDrafts();
    const mode = (await this.store.paused()) ? "PAUSED" : (await this.store.autoSend()) ? "automatic" : "review";
    return [
      `${business.name} texts (${mode}${this.deps.dryRun ? ", DRY RUN" : ""})`,
      `Leads ${leads.length}: waiting ${count("queued")}, texted ${count("texted")}, replied ${count("replied")}, booking requests ${count("booked")}, need you ${count("needs_you")}, opted out ${count("opted_out")}, no response ${count("no_response")}, failed ${count("failed")}, excluded ${count("excluded")}.`,
      `Drafts waiting for you: ${drafts.length}.`,
    ].join("\n");
  }

  // -------------------------------------------------------------------------
  // Scheduled run (every ~10 minutes): first texts, nudges, wrap-up
  // -------------------------------------------------------------------------

  async tick(): Promise<Record<string, number | string>> {
    const now = this.now();
    const result: Record<string, number | string> = { firstTexts: 0, nudges: 0, closed: 0, failed: 0 };
    if (!(await this.store.lock("tick", 240))) return { skipped: "another run is in progress" };
    try {
      const leads = await this.store.allLeads();

      // Leads past their window with no reply: close them out (any time of day).
      for (const lead of leads) {
        if (lead.status === "texted" && this.campaignOver(lead, now)) {
          lead.status = "no_response";
          await this.store.saveLead(lead);
          result.closed = (result.closed as number) + 1;
        }
      }

      if (await this.store.paused()) return { ...result, skipped: "paused" };
      if (!this.inSendingHours(now)) return { ...result, skipped: "outside sending hours" };

      // Nudges first, so a big queue never starves them.
      const nudgeTexts = nudges();
      for (const lead of leads) {
        if (lead.status !== "texted" || !lead.firstTextAt || lead.nudgesSent >= config.nudgeDays.length) continue;
        if (lead.nudgesSent >= nudgeTexts.length) continue;
        const due = Date.parse(lead.firstTextAt) + config.nudgeDays[lead.nudgesSent]! * DAY_MS;
        if (now.getTime() < due || this.campaignOver(lead, now)) continue;
        const body = nudgeTexts[lead.nudgesSent]!.replaceAll("{first}", firstName(lead.name) || "there").replaceAll("{rep}", business.repName).replaceAll("{business}", business.name);
        try {
          if (await this.textLead(lead, body, "nudge")) {
            lead.nudgesSent += 1;
            result.nudges = (result.nudges as number) + 1;
          }
        } catch (err: any) {
          lead.nudgesSent += 1; // never retry a nudge endlessly
          this.log({ event: "nudge_failed", phone: lead.phone, error: err?.message });
        }
        await this.store.saveLead(lead);
      }

      // First texts, within the daily cap.
      const today = localDate(now);
      let room = Math.min(config.firstTextsPerTick, config.dailyFirstTextCap - (await this.store.firstTextsSentOn(today)));
      for (const lead of leads) {
        if (room <= 0) break;
        if (lead.status !== "queued") continue;
        if (await this.store.isOptedOut(lead.phone)) {
          lead.status = "opted_out";
          await this.store.saveLead(lead);
          continue;
        }
        if (!(await this.store.claimFirstText(lead.phone))) continue;
        room -= 1;
        await this.store.countFirstText(today);
        try {
          await this.textLead(lead, renderFirstText(lead.name), "first_text");
          lead.status = "texted";
          lead.firstTextAt = now.toISOString();
          result.firstTexts = (result.firstTexts as number) + 1;
        } catch (err: any) {
          lead.status = "failed";
          lead.reason = clip(err?.message ?? String(err), 200);
          result.failed = (result.failed as number) + 1;
          this.log({ event: "first_text_failed", phone: lead.phone, error: err?.message });
        }
        await this.store.saveLead(lead);
      }

      await this.maybeFinalReport(await this.store.allLeads(), now);
      return result;
    } finally {
      await this.store.unlock("tick");
    }
  }

  private inSendingHours(now: Date): boolean {
    const hour = Number(new Intl.DateTimeFormat("en-US", { hour: "numeric", hourCycle: "h23", timeZone: config.timezone }).format(now));
    return hour >= config.sendStartHour && hour < config.sendEndHour;
  }

  /** Once every lead has had its first text and its window has ended, texts
   * you the final numbers once. */
  private async maybeFinalReport(leads: Lead[], now: Date): Promise<void> {
    const texted = leads.filter((l) => l.firstTextAt);
    if (texted.length === 0) return;
    if (leads.some((l) => l.status === "queued")) return;
    if (texted.some((l) => !this.campaignOver(l, now))) return;
    if (!(await this.store.flagOnce("final-report"))) return;
    await this.tellOwner(`Campaign finished. ${await this.statusText()}`);
  }
}

export function nudges(): string[] {
  const raw = process.env.NUDGE_TEXTS?.trim();
  if (raw) return raw.split("||").map((s) => s.trim()).filter(Boolean);
  return [
    "Hi {first}, just checking back in. Want me to get you on the schedule with {business}? Reply STOP to opt out.",
    "Last check from me, {first}: if you'd like {business} out again, just reply with a day that works. Reply STOP to opt out.",
  ];
}

function clip(text: string, max = 300): string {
  const one = (text ?? "").replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max)}…` : one;
}

function pretty(phone: string): string {
  const d = phone.replace(/\D/g, "").slice(-10);
  return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : phone;
}

function label(lead: Lead): string {
  return `${lead.name || "Unknown"} ${pretty(lead.phone)}`;
}
