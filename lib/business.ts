/** What the bot is allowed to say about the business. Claude may only quote
 * what's written here: anything not here (a price, an open slot, a promise)
 * it must not invent, and it hands the question to you instead.
 *
 * Each value can be overridden with the environment variable named next to
 * it, so wording can change in Vercel without a code change. */

function env(name: string, fallback: string): string {
  const value = process.env[name];
  return value && value.trim() ? value.trim() : fallback;
}

export const business = {
  /** BUSINESS_NAME: the name former clients know you by. */
  get name() {
    return env("BUSINESS_NAME", "Lustra Services");
  },
  /** REP_NAME: the first name the texts come from. */
  get repName() {
    return env("REP_NAME", "Thomas");
  },
  /** BUSINESS_FACTS: services and prices, in plain sentences. TODO(Thomas):
   * replace with real services and prices before going live. */
  get facts() {
    return env(
      "BUSINESS_FACTS",
      [
        "We're a local home services company in the Phoenix area.",
        "Pricing depends on the home, so we give an exact quote after a quick look or a few details (size of the home, number of windows/areas).",
      ].join("\n")
    );
  },
  /** BOOKING_RULES: how appointments work. The bot never confirms a time
   * itself: it collects the customer's preferred day and time and passes it
   * to you to confirm. */
  get bookingRules() {
    return env(
      "BOOKING_RULES",
      [
        "Appointments are Monday to Saturday, 8am to 5pm.",
        "Ask what day and time works for them, then say Thomas will confirm the exact time shortly.",
      ].join("\n")
    );
  },
  /** FIRST_TEXT: the opening text. {first} is replaced with the customer's
   * first name, {rep} with REP_NAME and {business} with BUSINESS_NAME. It
   * must keep the opt-out line. */
  get firstText() {
    return env(
      "FIRST_TEXT",
      "Hi {first}, it's {rep} with {business}. You used us before and I wanted to see if you'd like to get on the schedule again this season. Reply STOP to opt out."
    );
  },
};

export function renderFirstText(fullName: string): string {
  const first = firstName(fullName) || "there";
  return business.firstText.replaceAll("{first}", first).replaceAll("{rep}", business.repName).replaceAll("{business}", business.name);
}

export function firstName(fullName: string): string {
  const word = (fullName ?? "").trim().split(/\s+/)[0] ?? "";
  if (!/^[\p{L}'-]{2,}$/u.test(word)) return "";
  return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
}
