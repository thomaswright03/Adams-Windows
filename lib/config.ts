/** Settings read from environment variables (set them in Vercel → Project →
 * Settings → Environment Variables). Nothing secret lives in this repo: it
 * is public, so phone numbers, keys and the lead list all stay out of it. */

function env(name: string, fallback = ""): string {
  return (process.env[name] ?? fallback).trim();
}

function envInt(name: string, fallback: number): number {
  const n = Number.parseInt(env(name), 10);
  return Number.isFinite(n) ? n : fallback;
}

export const config = {
  get timezone() {
    return env("TIMEZONE", "America/Phoenix");
  },
  /** Your own cell. Drafts, bookings and anything unusual are texted here,
   * and texts from it are read as commands (see lib/owner.ts), never as a
   * lead. */
  get ownerPhone() {
    return env("OWNER_PHONE");
  },
  /** "true" only after you've reviewed real drafts in review mode. The
   * AUTO ON / AUTO OFF text commands override this at any time. */
  get autoSendDefault() {
    return env("AUTO_SEND", "false").toLowerCase() === "true";
  },
  /** Days the bot keeps answering a lead after their first text. */
  get campaignDays() {
    return envInt("CAMPAIGN_DAYS", 10);
  },
  /** Most first texts per day, and per run of the scheduler. */
  get dailyFirstTextCap() {
    return envInt("DAILY_FIRST_TEXT_CAP", 50);
  },
  get firstTextsPerTick() {
    return envInt("FIRST_TEXTS_PER_TICK", 4);
  },
  /** Days after the first text to send each gentle nudge (if no reply). */
  get nudgeDays(): number[] {
    return env("NUDGE_DAYS", "3,6")
      .split(",")
      .map((d) => Number.parseInt(d, 10))
      .filter((d) => Number.isFinite(d) && d > 0);
  },
  /** Starting and ending hour (24h, local) for texts the bot starts. */
  get sendStartHour() {
    return envInt("SEND_START_HOUR", 8);
  },
  get sendEndHour() {
    return envInt("SEND_END_HOUR", 20);
  },
  get webhookSecret() {
    return env("WEBHOOK_SECRET");
  },
  get adminPassword() {
    return env("ADMIN_PASSWORD");
  },
  get model() {
    return env("CLAUDE_MODEL", "claude-opus-5-5");
  },
};
