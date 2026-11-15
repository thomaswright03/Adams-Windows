import type { Kv } from "./kv.js";
import { config } from "./config.js";

export type LeadStatus =
  | "queued" // waiting for its first text
  | "texted" // first text sent, no reply yet
  | "replied" // in a conversation with the bot
  | "booked" // asked for a time; you confirm it
  | "needs_you" // the bot stepped back; you take it from here
  | "opted_out"
  | "excluded" // you marked it: not interested, wrong number, not a customer
  | "failed" // the first text could not be sent
  | "no_response"; // campaign window ended with no reply

export interface Lead {
  phone: string; // E.164, e.g. +16025551234
  name: string;
  notes: string;
  status: LeadStatus;
  addedAt: string;
  firstTextAt?: string;
  nudgesSent: number;
  lastInboundAt?: string;
  lastOutboundAt?: string;
  /** Why the bot handed this one to you, or the send error. */
  reason?: string;
  /** The day and time they asked for, in their words. */
  requestedTime?: string;
}

export interface Turn {
  dir: "in" | "out";
  body: string;
  at: string;
  /** Who wrote an outbound text. */
  by?: "bot" | "owner" | "first_text" | "nudge";
}

export interface Draft {
  id: number;
  phone: string;
  body: string;
  createdAt: string;
  /** Set when Claude asked to tell you something with this reply. */
  note?: string;
  booking?: string;
}

/** Turns "(602) 555-1234", "602.555.1234" or "+1 602 555 1234" into
 * "+16025551234". Returns null for anything that isn't a US number. */
export function normalizePhone(raw: string): string | null {
  const digits = (raw ?? "").replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}

export function localDate(now: Date, timezone = config.timezone): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

export class Store {
  constructor(public kv: Kv) {}

  async getLead(phone: string): Promise<Lead | null> {
    const raw = await this.kv.get(`lead:${phone}`);
    return raw ? (JSON.parse(raw) as Lead) : null;
  }

  async saveLead(lead: Lead): Promise<void> {
    await this.kv.set(`lead:${lead.phone}`, JSON.stringify(lead));
    await this.kv.sadd("leads", lead.phone);
  }

  async allLeads(): Promise<Lead[]> {
    const phones = await this.kv.smembers("leads");
    const leads = await Promise.all(phones.map((p) => this.getLead(p)));
    return leads.filter((l): l is Lead => l !== null).sort((a, b) => a.addedAt.localeCompare(b.addedAt) || a.phone.localeCompare(b.phone));
  }

  async history(phone: string): Promise<Turn[]> {
    return (await this.kv.lrange(`convo:${phone}`, 0, -1)).map((t) => JSON.parse(t) as Turn);
  }

  async addTurn(phone: string, turn: Turn): Promise<void> {
    await this.kv.rpush(`convo:${phone}`, JSON.stringify(turn));
  }

  async isOptedOut(phone: string): Promise<boolean> {
    return this.kv.sismember("optout", phone);
  }

  async addOptOut(phone: string): Promise<void> {
    await this.kv.sadd("optout", phone);
  }

  /** True the first time it's called for this Twilio message, so a retried
   * webhook is handled once. */
  async firstTimeSeen(messageSid: string): Promise<boolean> {
    if (!messageSid) return true;
    return this.kv.set(`msg:${messageSid}`, "1", { nx: true, exSeconds: 60 * 60 * 24 * 30 });
  }

  /** Claims this lead's one and only first text. False if it was already
   * claimed, so no number is ever first-texted twice. */
  async claimFirstText(phone: string): Promise<boolean> {
    return this.kv.set(`first:${phone}`, new Date().toISOString(), { nx: true });
  }

  async paused(): Promise<boolean> {
    return (await this.kv.get("setting:paused")) === "1";
  }

  async setPaused(paused: boolean): Promise<void> {
    await this.kv.set("setting:paused", paused ? "1" : "0");
  }

  async autoSend(): Promise<boolean> {
    const value = await this.kv.get("setting:auto");
    if (value === "1") return true;
    if (value === "0") return false;
    return config.autoSendDefault;
  }

  async setAutoSend(auto: boolean): Promise<void> {
    await this.kv.set("setting:auto", auto ? "1" : "0");
  }

  async firstTextsSentOn(date: string): Promise<number> {
    return Number((await this.kv.get(`sent:${date}`)) ?? "0");
  }

  async countFirstText(date: string): Promise<number> {
    return this.kv.incr(`sent:${date}`, 60 * 60 * 48);
  }

  async addDraft(draft: Omit<Draft, "id">): Promise<Draft> {
    const id = await this.kv.incr("draftseq");
    const full = { ...draft, id };
    await this.kv.set(`draft:${id}`, JSON.stringify(full));
    await this.kv.sadd("drafts", String(id));
    return full;
  }

  async getDraft(id: number): Promise<Draft | null> {
    const raw = await this.kv.get(`draft:${id}`);
    return raw ? (JSON.parse(raw) as Draft) : null;
  }

  /** Removes the draft and returns it, or null if it was already used. */
  async takeDraft(id: number): Promise<Draft | null> {
    const draft = await this.getDraft(id);
    if (!draft) return null;
    if (!(await this.kv.sismember("drafts", String(id)))) return null;
    await this.kv.srem("drafts", String(id));
    await this.kv.del(`draft:${id}`);
    return draft;
  }

  async pendingDrafts(): Promise<Draft[]> {
    const ids = (await this.kv.smembers("drafts")).map(Number).sort((a, b) => a - b);
    const drafts = await Promise.all(ids.map((id) => this.getDraft(id)));
    return drafts.filter((d): d is Draft => d !== null);
  }

  /** Drops any waiting draft for this lead (a newer text replaces it). */
  async dropDraftsFor(phone: string): Promise<void> {
    for (const draft of await this.pendingDrafts()) {
      if (draft.phone === phone) await this.takeDraft(draft.id);
    }
  }

  async lock(name: string, seconds: number): Promise<boolean> {
    return this.kv.set(`lock:${name}`, "1", { nx: true, exSeconds: seconds });
  }

  async unlock(name: string): Promise<void> {
    await this.kv.del(`lock:${name}`);
  }

  async flagOnce(name: string): Promise<boolean> {
    return this.kv.set(`flag:${name}`, "1", { nx: true });
  }
}
