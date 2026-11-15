export interface CompanyConfig {
  /** Value that appears in the GHL "company" custom field / tag for this brand. */
  matchValue: string;
  /** First name the AI texts under, e.g. "Max". */
  repName: string;
  displayName: string;
  timezone: string;
  signupUrl: string;
  /** Human to hand off to when a conversation is escalated. */
  escalationContactName: string;
  escalationContactPhone: string;
  escalationContactEmail: string;
  /** Sent in the post-contract-submission confirmation text — see
   * mts-sync/submitContracts.ts's buildConfirmationSms(). */
  reviewLink: string;
  /**
   * Optional tone/phrasing rules distilled from a real rep's own texting
   * history — governs HOW the model talks, never WHAT's true (that's still
   * pricingAndServiceFacts/serviceAreaNotes only). Empty string for brands
   * without a captured voice profile, which fall back to the generic VOICE
   * instruction in buildSystemPrompt/buildOutreachPrompt.
   */
  voiceGuide: string;
  /**
   * Freeform pricing/service facts the model is allowed to quote verbatim.
   * Keep this as plain sentences — whatever isn't in here, the model must not invent.
   */
  pricingAndServiceFacts: string;
  /** Plain-language description of the service area / how to check serviceability. */
  serviceAreaNotes: string;
  /**
   * Real, structured 2-letter state codes this brand actually operates in —
   * separate from serviceAreaNotes (which is freeform text for the model to
   * quote from). Used as a deterministic, code-owned gate in
   * lib/signupDecision.ts: never confirm a real MTS signup for a contact
   * whose own on-file address is outside every state a brand serves, no
   * matter what upstream lead data claims. Added 2026-08-02 after a real
   * incident (Barbara Bearskin, Los Lunas NM) reached a fully AI-confirmed
   * signup for Mountain High Disposal — a Colorado-only brand — before MTS's
   * own real-time check caught it at the very last step, after the lead had
   * already been told she was all set up.
   */
  serviceStates: string[];
  /**
   * The complete list of cities this brand signs up — a deterministic,
   * code-owned allowlist alongside serviceStates, checked against the
   * contact's own on-file city in lib/signupDecision.ts's isInServiceArea().
   * A city that isn't on this list is out of area, full stop. Matched
   * case/punctuation/spacing-insensitively on the whole city name ("Ft" is
   * read as "Fort"). Also the list the model is shown, so the prompt and
   * the gate can't drift apart.
   * Thomas, 2026-10-12, after Richard Case (Monument, CO) got a real MTS
   * contract: "the city field matches a city on the list not that it
   * doesnt match the cities on a no go list". This replaced the old
   * excludedCities blocklist (Loveland only), which let every unlisted CO
   * town through. Omitted/empty means no city-level check (a brand mid-
   * setup), same fail-open as an empty serviceStates.
   */
  serviceCities?: string[];
}

export interface InboundMessage {
  contactId: string;
  /** Not available as a GHL workflow merge field — looked up separately via
   * findConversationId(). Only present if some other integration supplies it. */
  conversationId?: string;
  locationId: string;
  phone: string;
  body: string;
}

export interface ConversationTurn {
  direction: "inbound" | "outbound";
  body: string;
  dateAdded: string;
  /** True only for an outbound message GHL attributes to a real logged-in
   * user (a rep manually texting from the GHL app) — carries a `userId` in
   * the raw API response. Our own AI sends via a bare API token and never
   * carries one. Always false for inbound messages. See
   * api/webhook.ts's human-takeover check. */
  sentByHuman?: boolean;
  /** GHL's real delivery status for this message (e.g. "sent", "delivered",
   * "failed") — confirmed live 2026-08-25: our sendSms() call can return
   * success while the message fails downstream at the SMS provider (e.g.
   * Signal House) moments later, with nothing in this codebase able to
   * detect that at send time. Only meaningful for outbound turns; undefined
   * if GHL didn't return one. See mts-sync/sendFollowUps.ts's use of this
   * to tell "never actually delivered anything" apart from a normal
   * mid-conversation hiccup. */
  status?: string;
}

export type SafetyVerdict =
  | { action: "send"; reason: string }
  | { action: "escalate"; reason: string }
  | { action: "opt_out"; reason: string };

/** Structured, code-parsed output of a dedicated extraction call over the
 * conversation — feeds the deterministic "should we actually submit a real
 * MTS contract" decision in api/webhook.ts. Never used to drive reply text
 * directly; only to decide whether to act on it. */
export interface SignupState {
  discussingSignup: boolean;
  binSize: "95" | "65" | "35" | null;
  wantsRecycling: boolean | null;
  /** A specific start month the lead directly asked for or proposed, as
   * "YYYY-MM" — null if they haven't stated a preference. Only ever what
   * the lead actually requested, never a guess. Fed into
   * lib/signupSchedule.ts's computeStartDate(), which enforces the real
   * 3-week-minimum/1-year-maximum window regardless of what's requested
   * here. */
  requestedStartMonth: string | null;
  /** The literal text the lead typed as their name, in direct response to a
   * complete summary (including their service address) that explicitly
   * asked them to type their name to confirm/sign — functions as the
   * lead's e-signature. null until that's actually happened; a plain "yes"
   * or "sounds good" does NOT count, no matter how enthusiastic. Checked
   * against the contact's known name in lib/signupDecision.ts — this field
   * only carries what the model saw, the actual match is deterministic. */
  typedName: string | null;
  /** True once the rep has offered the CEO-authorized "first 3 months free"
   * incentive (to comp a lead's cancellation fee with their CURRENT
   * provider) AND the lead has since agreed to it in this conversation.
   * CEO, 2026-09-16: authorized specifically for leads who are hesitant to
   * switch because of a cancellation fee THEY'D owe their existing
   * provider — never a general discretionary discount, and never in
   * response to an objection about OUR OWN $75 fee (that one stays
   * unwaived, see prompt.ts's OBJECTIONS section). Feeds ContractPayload's
   * monthsFree so the real MTS contract actually reflects what the lead
   * was promised — see mtsContract.js's MonthsFree field. */
  freeMonthsPromoAccepted: boolean;
  /** The service address the lead typed in this conversation, when it
   * differs from or fills in what's on file (Thomas, 2026-11-07, real case:
   * Mark Birchard typed "14152 e. Idaho Dr. Aurora 80012" while GHL only had
   * "Aurora, CO 80012" in the street field, so no contract was ever
   * submitted). Only what the lead actually wrote; lib/signupDecision.ts's
   * resolveServiceAddress() re-checks it against the lead's own messages
   * before it can be used for anything. */
  typedServiceAddress: TypedServiceAddress | null;
}

export interface TypedServiceAddress {
  line1: string;
  /** city/state/postalCode are null when the lead didn't write them; they
   * can then come from the contact's on-file city/ZIP (Abraham Ixchop,
   * 2026-11-04: typed "10450 E 7th Ave", GHL had "Aurora, CO 80010"). */
  city: string | null;
  state: string | null;
  postalCode: string | null;
}

/** Everything api/webhook.ts needs to hand off to mts-sync/submitContracts.ts
 * to actually create the real MTS contract. Written as a marked JSON note on
 * the GHL contact (see AI_SIGNUP_NOTE_MARKER in lib/prompt.ts) rather than a
 * local file, since the Vercel webhook and the local mts-sync scripts share
 * no filesystem. */
export interface ContractPayload {
  firstName: string;
  lastName: string;
  phone: string;
  email?: string;
  serviceAddressLine1: string;
  serviceCity: string;
  serviceState: string;
  servicePostalCode: string;
  binSize: "95" | "65" | "35";
  wantsRecycling: boolean;
  startDate: string; // YYYY-MM-DD
  /** What the lead actually typed as their name to confirm/sign — kept
   * verbatim as the record of consent, not just a boolean. */
  signedName: string;
  /** 0 normally; 3 if the lead accepted the CEO-authorized free-months
   * incentive (see SignupState.freeMonthsPromoAccepted) — passed straight
   * through to MTS's own MonthsFree field so the real contract bills what
   * the lead was actually promised. */
  monthsFree: number;
}
