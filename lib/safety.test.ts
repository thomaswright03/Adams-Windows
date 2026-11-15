import { test } from "node:test";
import assert from "node:assert/strict";
import {
  evaluateInbound,
  isWithinQuietHours,
  claimsSignupComplete,
  promisesSignupInProgress,
  inProgressPhrase,
  asksForName,
  stopRequestReason,
  isStopRequest,
  isCarrierOptOutKeyword,
  isResubscribeKeyword,
  asksNoFollowUp,
  notAMessageReason,
  parseFollowUpSkip,
  readFollowUpDraft,
  stopNeedsPersonReasons,
  escalationReasons,
  isLeadTooOld,
  latestStopRequest,
  textsSinceResubscribe,
} from "./safety.js";
import type { CompanyConfig, ConversationTurn } from "./types.js";

const company: CompanyConfig = {
  matchValue: "Test Co",
  repName: "Max",
  displayName: "Test Co",
  timezone: "America/Denver",
  signupUrl: "",
  escalationContactName: "",
  escalationContactPhone: "",
  escalationContactEmail: "",
  reviewLink: "",
  voiceGuide: "",
  pricingAndServiceFacts: "",
  serviceAreaNotes: "",
  serviceStates: ["CO"],
};

test("exact opt-out keywords trigger opt_out", () => {
  for (const msg of ["STOP", "stop", "Stop.", "unsubscribe", "cancel", "quit", "end", "STOPALL"]) {
    assert.equal(evaluateInbound(msg, company).action, "opt_out", `expected opt_out for "${msg}"`);
  }
});

test("natural-language stop phrasing triggers opt_out", () => {
  for (const msg of [
    "please stop",
    "can you stop texting me",
    "Stop messaging me please",
    "don't text me anymore",
    "do not text me",
    "no more texts please",
    "take me off your list",
    "remove me from the list",
    "quit texting me",
  ]) {
    assert.equal(evaluateInbound(msg, company).action, "opt_out", `expected opt_out for "${msg}"`);
  }
});

test("cancel my service escalates instead of silently opting out", () => {
  const verdict = evaluateInbound("I need to cancel my service", company);
  assert.equal(verdict.action, "escalate");
  assert.equal(verdict.reason, "service cancellation request");
});

test("cancel my account / contract / subscription all escalate", () => {
  for (const msg of ["please cancel my account", "cancel my contract", "I want to cancel my subscription"]) {
    const verdict = evaluateInbound(msg, company);
    assert.equal(verdict.action, "escalate", `expected escalate for "${msg}"`);
  }
});

test("billing/legal/safety/crisis language escalates", () => {
  const cases: Array<[string, string]> = [
    ["I'm going to talk to my lawyer about this", "legal/regulatory mention"],
    ["you overcharged me for last month", "billing dispute"],
    ["can I talk to a manager", "explicit request for a human"],
    ["there's a gas leak near the bin", "safety/property-damage report"],
    ["who is this, wrong number", "possible wrong number"],
    ["my card number is 4111 1111 1111 1111", "payment/PII detail sent over SMS"],
    ["you guys didn't pick up again", "existing-customer service issue"],
    ["do you do dumpster rental for my HOA", "outside standard residential script"],
  ];
  for (const [msg, expectedReason] of cases) {
    const verdict = evaluateInbound(msg, company);
    assert.equal(verdict.action, "escalate", `expected escalate for "${msg}"`);
    assert.equal(verdict.reason, expectedReason, `expected reason "${expectedReason}" for "${msg}"`);
  }
});

// Real incident 2026-08-03 (Carter Bodily): "check with the property
// manager" wrongly matched the bare "manager" keyword and escalated with a
// misleading "explicit request for a human" reason, even though he never
// asked to talk to anyone — he was referring to his own apartment complex's
// contact. Must send normally.
test("mentioning a property manager in passing is not an explicit request for a human", () => {
  const verdict = evaluateInbound(
    "We would like recycling, but it looks like our complex is serviced by a dumpster so I'll need to check with the property manager and get back to you",
    company
  );
  assert.equal(verdict.action, "send");
});

test("crisis language always escalates, never auto-sends", () => {
  const verdict = evaluateInbound("I feel like I might hurt myself", company);
  assert.equal(verdict.action, "escalate");
});

test("ordinary qualifying question sends normally, any time of day — replying to an inbound text is never held for quiet hours", () => {
  const verdict = evaluateInbound("Yeah just trash, one can", company);
  assert.equal(verdict.action, "send");
});

// mts-sync/sendOutreach.ts (cold opens) deliberately does NOT call this —
// removed 2026-07-30 at Thomas's explicit instruction: a new lead found at
// 3am is, by definition, someone actively filling out a form right then, so
// there's no one being woken up. mts-sync/sendFollowUps.ts (the drip) does
// call this, since a follow-up's due time has no connection to whether the
// lead is awake right now.
test("isWithinQuietHours boundary: exactly 8:00am and 8:59am Denver", () => {
  assert.equal(isWithinQuietHours(new Date("2026-07-23T14:00:00Z"), "America/Denver"), true, "8:00am should be within the window");
  assert.equal(isWithinQuietHours(new Date("2026-07-23T13:59:00Z"), "America/Denver"), false, "7:59am should not be");
});

test("isWithinQuietHours boundary: exactly 9:00pm and 8:59pm Denver (TCPA limit)", () => {
  assert.equal(isWithinQuietHours(new Date("2026-07-24T03:00:00Z"), "America/Denver"), false, "9:00pm should not be within the window (< 21, not <=)");
  assert.equal(isWithinQuietHours(new Date("2026-07-24T02:59:00Z"), "America/Denver"), true, "8:59pm should still be within the window");
});

// Richard Case, 2026-10-08: the bot told him "you're all set Richard"
// before any contract existed.
test("claimsSignupComplete catches replies that say the signup is done", () => {
  for (const draft of [
    "got it, you're all set Richard. we'll be in touch once it's confirmed :)",
    "You’re all set!",
    "youre all set up",
    "you are now signed up for trash service",
    "you're good to go :)",
    "your signup is complete",
    "your contract has been created",
    "sweet, everything's confirmed",
    "we're all set, welcome aboard",
    "it's locked in :)",
  ]) {
    assert.equal(claimsSignupComplete(draft), true, draft);
  }
});

test("claimsSignupComplete allows the approved 'locking it in' wording and ordinary replies", () => {
  for (const draft of [
    "got it Richard, locking this in now. you'll hear back once it's confirmed :)",
    "you'll get a text when it's all set",
    "we'll let you know as soon as it's confirmed",
    "reply with your name and we'll get this locked in :)",
    "sounds good. we'd be $20 monthly for 65 gal trash, and bins are free :)",
    "does november 2nd work as a start date for you?",
    "you can cancel free within 7 days of signing",
  ]) {
    assert.equal(claimsSignupComplete(draft), false, draft);
  }
});

// Found 2026-11-11: leads who typed their name were told "locking it in"
// although nothing was saved. api/webhook.ts blocks these phrasings while no
// order is on record. Wording below follows the bot's real sent messages,
// with names left out.
const FULL_SUMMARY = [
  "sweet, here's what I've got:",
  "- 123 Test St, Denver, CO 80202 (is that right?)",
  "- one 95 gal trash bin, $20/month, billed quarterly",
  "- starts December 1, bins arrive about a week before",
  "- cancel free within 7 days of signing, after that a $75 fee if you cancel in the first 12 months",
  "- cancelling your current hauler is on you, and no refunds on prepaid money",
  "reply with your full name to confirm and we'll lock it in :)",
].join("\n");

test("promisesSignupInProgress catches replies that say the order is being locked in", () => {
  for (const draft of [
    "got it, locking it in now :)",
    "perfect, we're locking this in for you",
    "sweet, locking you in for December 1st",
    "awesome, got you locked in. you'll hear back once it's confirmed",
    "thanks! we'll get it locked in and you'll hear back once everything's confirmed :)",
    "10-4, you'll hear back once it's all set",
    "sounds good! I'll lock it in for you",
    "you're being locked in for the 95 gal",
    "great, all set to get this moving",
    "locking in 2 trash bins at $25/month",
    "Got it, we’re getting this locked in now",
  ]) {
    assert.equal(promisesSignupInProgress(draft), true, draft);
  }
});

test("promisesSignupInProgress allows asking for the name, offers, conditions and rate talk", () => {
  for (const draft of [
    FULL_SUMMARY,
    "text your name back and we'll get it locked in",
    "want me to lock it in?",
    "once that looks good, reply with your name and I'll get it locked in",
    "before we lock it in, can you confirm the address?",
    "before we lock it in, I just need the ZIP code.",
    "the 1-year rate lock means your price can't go up",
    "locking in the rate is part of the 1 year agreement",
    "no worries, a team member will follow up with the details",
    "if you're ready, just text your full name and we'll lock it in",
    "nice, thanks for letting me know!",
    "we would be $20 monthly for just trash :)",
  ]) {
    assert.equal(promisesSignupInProgress(draft), false, draft);
  }
});

test("asksForName: a request for the name, not a mention of it", () => {
  for (const text of [FULL_SUMMARY, "text your name back to confirm", "just reply with your full name to confirm", "if so, please put your first and last name"]) {
    assert.equal(asksForName(text), true, text);
  }
  for (const text of ["got your name, thanks! what size bin do you want?", "what size bin works for you?", "sweet, locking it in now :)"]) {
    assert.equal(asksForName(text), false, text);
  }
});

test("promisesSignupInProgress catches paraphrases, and a claim before a question", () => {
  for (const draft of [
    "thanks for confirming your name! we'll get it locked in and you'll hear back once it's confirmed :)",
    "got it Adam, we're locking it in now, anything else you need?",
    "I'll get you locked in for december 1st, does that work?",
    "done :)",
    "perfect, done",
    "10-4, done :)",
    "got you down for the 95 gal",
    "we're processing your order now",
    "your order is being processed",
    "lockin it in now",
    "gettin you locked in",
  ]) {
    assert.equal(promisesSignupInProgress(draft), true, draft);
  }
});

test("promisesSignupInProgress allows negations, commitment talk, rate talk and a condition after the claim", () => {
  for (const draft of [
    "no worries about being locked in long term, you can cancel free within 7 days",
    "nobody's locking you in, you can cancel free within 7 days",
    "we'll lock in your rate for 12 months",
    "we'll lock it in once you reply with your full name",
    "I can get you locked in as soon as you send your full name",
    "not done with the summary yet, one sec",
    "we'll lock in $20/month for your first year",
    "nobody likes being locked in, you can cancel free within 7 days",
    // Conditions and offers that aren't also a request for the name.
    "we'll lock it in once you confirm the address",
    "once that looks good we'll get it locked in",
    "want me to start locking it in?",
    "before we lock it in, can you confirm the address is 123 Test St?",
  ]) {
    assert.equal(promisesSignupInProgress(draft), false, draft);
  }
  // ...while the same words on their own still count.
  for (const draft of ["we'll lock it in", "we'll get it locked in", "I'll start locking it in"]) {
    assert.equal(promisesSignupInProgress(draft), true, draft);
  }
});

const SUMMARY_LINES = [
  "- 123 Test St, Denver, CO 80202",
  "- one 95 gal trash bin, $20/month, billed quarterly, starts December 1",
  "- cancel free within 7 days, after that a $75 fee in the first 12 months",
  "- cancelling your current hauler is on you, and no refunds on prepaid money",
  "reply with your full name to confirm",
];

test("inProgressPhrase: a summary's opening line and a request for the name don't count; a promise around them does", () => {
  assert.equal(inProgressPhrase(["sweet, here's what we're locking in:", ...SUMMARY_LINES].join("\n")), null);
  assert.equal(inProgressPhrase(["we're locking it in now, here's what you signed up for:", ...SUMMARY_LINES].join("\n")), "locking it in");
  assert.equal(inProgressPhrase("text your name and I'll have you locked in"), null);
  // Once the reply asks for the name, only "now" claims count, not plans.
  assert.equal(inProgressPhrase("just reply with your full name to confirm. we'll get it all locked in from there :)"), null);
  // Thanking them for a name they already gave isn't asking for it.
  assert.equal(inProgressPhrase("thanks for confirming your name and we'll get it locked in"), "we'll get it locked in");
  assert.equal(asksForName("thanks for confirming your name and we'll get it locked in"), false);
});

test("everyday follow-up words only count once the bot has asked for the lead's name", () => {
  for (const draft of [
    "awesome, ready to get you started! what size bin works for you?",
    "a team member will let you know once that's confirmed :)",
    "we'll text you once it's confirmed",
    "the exact pickup day is address specific, a team member will let you know when it's set",
  ]) {
    assert.equal(promisesSignupInProgress(draft, { nameRequested: false }), false, draft);
    assert.equal(promisesSignupInProgress(draft, { nameRequested: true }), true, draft);
    assert.equal(promisesSignupInProgress(draft), true, `${draft} (the stricter check is the default)`);
  }
  // The bot's own closing line for a saved order always counts.
  assert.equal(promisesSignupInProgress("you'll hear back once it's confirmed :)", { nameRequested: false }), true);
});

test("inProgressPhrase quotes the words that made the promise", () => {
  assert.equal(inProgressPhrase("got it Adam, locking it in now! you'll hear back once it's confirmed :)"), "locking it in");
  assert.equal(inProgressPhrase("nice, thanks for letting me know!"), null);
});


// ---------------------------------------------------------------------------
// Stop requests in everyday words (evaluation S01, 2026-11-12). Every
// "should stop" case below is a real lead's text, or close to one.
// ---------------------------------------------------------------------------

test("stop requests in everyday words are caught", () => {
  for (const msg of [
    "Lose this number",
    "Lose the number",
    "No leave me alone",
    "No, I'm all set now. Stop texts",
    "Please remove me from your text ",
    "We're already customers. Please take me off the marketing list. ",
    "Thanks but I've signed up with another company. Please remove me from your contact list.",
    "I already signed up. You can remove me from this text chain.",
    "I already signed up. You don't need to contact me anymore. ",
    "Fo.away and never contact me again ",
    "No. Stop contacting me",
    "Stop spamming me.  No.  Your services are 2x the price of competitors.",
    "You were told we are one of your customers. Stop pestering me!!!!!!!",
    "Please dont solicit to this phone number. ",
    "Check your records, you're already doing my trash service. Don't send me this AI generated spam BS ever again ",
    "I do not want to be followed up with directly I do not want to be contacted there was no issue",
    "I don't want any more contact from AI slop bots. ",
    "Yeah, no. And don't ever text me again.",
    "WHOA!  STOP! I alrd hav srvc wth u!!  Thk u!",
    "No idea what you are saying. Retired. STOP..STOP.",
    "Stop.. thank you",
    "Stop AI bot. ",
    "Take me off your text and calling list ",
    "Unsubscribe and please do not share or sell my information. Have a nice day.",
    "Revoke",
    "I revoke my consent",
    "opt-out",
    "how do I opt out?",
    "unsuscribe",
    "Remove me",
    "Ok stop",
    "STOP STOP STOP",
    "Can you stop texting me?",
    "do not text",
    "You Can stop following up please. Happy Halloween ",
  ]) {
    assert.equal(evaluateInbound(msg, company).action, "opt_out", `expected opt_out for "${msg}"`);
    assert.ok(isStopRequest(msg), `expected a stop request for "${msg}"`);
  }
});

test("ordinary texts that mention stopping, removing or opting out are not stop requests", () => {
  for (const msg of [
    "please stop by Monday",
    "Can you stop by and drop off the bin?",
    "the bus stop is right there",
    "where's the stop",
    "Don't stop now, I want to sign up",
    "Or stop taking calls?",
    "can you take me off autopay",
    "take me off the schedule for next week",
    "remove me from the account and put my wife on it",
    "please remove the extra bin",
    "Is there an opt out fee?",
    "is there an opt-out clause in the contract?",
    "can I opt out of recycling",
    "I'll stop my other service on the 15th",
    "How do I stop my old service?",
    "Don't send me a bill yet",
    "Don't call me, text me instead",
    "No more questions, sign me up",
    "I need to cancel my current service",
    "yeah just trash, one can",
  ]) {
    assert.equal(stopRequestReason(msg), null, `expected no stop request for "${msg}"`);
  }
});

test("the reasons stay the ones the opt-out note has always used", () => {
  assert.equal(stopRequestReason("STOP"), "opt-out keyword");
  assert.equal(stopRequestReason("Remove me."), "opt-out keyword");
  assert.equal(stopRequestReason("please take me off your list"), "opt-out phrase");
});

test("only the SMS company's own keywords skip the bot's confirmation", () => {
  for (const msg of ["STOP", "Stop.", "stop!!", "unsubscribe", "CANCEL", "End", "quit", "revoke", "opt out", "STOPALL"]) {
    assert.ok(isCarrierOptOutKeyword(msg), `"${msg}" is a carrier keyword`);
  }
  for (const msg of ["please stop", "Lose this number", "remove me", "stop texting me"]) {
    assert.ok(!isCarrierOptOutKeyword(msg), `"${msg}" is not a carrier keyword`);
  }
});

test("START and its kin are read as opting back in", () => {
  for (const msg of ["START", "Start.", "unstop", "opt in"]) assert.ok(isResubscribeKeyword(msg), msg);
  for (const msg of ["start date?", "when do you start", "stop"]) assert.ok(!isResubscribeKeyword(msg), msg);
});

test("asking not to be followed up with stops the nudges, without counting as a stop request", () => {
  for (const msg of ["I was doing a price check. No need to follow up.", "please don't follow up", "no need to reach out", "don't check back with me", "no need to contact me, I'll text you"]) {
    assert.ok(asksNoFollowUp(msg), `expected no-follow-up for "${msg}"`);
  }
  for (const msg of ["I don't need to reach out to my landlord first", "no need to follow up with the city", "Do I need to follow up with WM?", "yeah just trash"]) {
    assert.ok(!asksNoFollowUp(msg), `expected nothing for "${msg}"`);
  }
});

// ---------------------------------------------------------------------------
// Drafted follow-ups that aren't messages (evaluation S01/S09). The first
// group are texts the bot really sent.
// ---------------------------------------------------------------------------

test("a drafted follow-up that is a refusal or a note about the lead is not a message", () => {
  for (const draft of [
    "I apologize, but I can't write this message. Susan explicitly asked to be removed from the text list, and continuing to message her would violate that request.",
    "No further message needed here — Robert already asked to be removed and we confirmed. Sending another text would contradict that.",
    "This conversation's already wrapped up nicely, no follow-up needed here, Ford :)",
    "*(no reply needed — conversation has reached a natural close)*",
    "No message needed here — Ernie's already asked us not to reach out, so I'll leave it at that.",
    "Since this lead already declined, no further follow-up should go out per the system's own rules — this conversation is closed.",
    "Here's a follow-up message: hey Adam, still around?",
    "hey [First Name], just checking back in!",
    "SKIP: STOP they asked to be removed",
  ]) {
    assert.ok(notAMessageReason(draft), `expected not-a-message for "${draft}"`);
  }
});

test("ordinary nudges and replies are messages", () => {
  for (const draft of [
    "hey Adam, just checking back in! still want prices for trash only or trash and recycling?",
    "no worries if the timing's off, I'm around whenever you're ready :)",
    "no worries. I can't send emails myself, but a team member can shoot that link over.",
    "Ha, no promises there. If Camilla wants to stop by anyway, that's above my pay grade 😄",
    "Totally get the frustration, I don't have access to pull up an existing account from here, just the lead info from your text-in.",
    "hey there, just following up on the 95 gal trash bin. want me to resend the details?",
  ]) {
    assert.equal(notAMessageReason(draft), null, `expected a message: "${draft}"`);
  }
});

test("notes that name the lead, or say not to send, are not messages (review of 2026-11-13)", () => {
  for (const draft of [
    "Adam doesn't want any more texts, so I won't send one.",
    "Adam said he went with WM. No follow-up.",
    "Adam isn't interested, best not to send anything.",
    "Adam's not interested, skipping this one.",
    "Since Adam said he's not interested, I'll leave this one alone.",
    "I'd recommend not following up with Adam, he said he's not interested.",
    "Adam asked to be taken off the list, so I'll hold off on sending anything.",
    "Adam already signed up with WM.",
  ]) {
    assert.ok(notAMessageReason(draft, "Adam"), `expected not-a-message for "${draft}"`);
  }
  assert.ok(notAMessageReason("Adam already signed up with WM.", "ADAM"), "a name GHL has in capitals still counts");
  assert.ok(notAMessageReason("ADAM already signed up with WM.", "ADAM"));
  for (const draft of [
    "She wants to be left alone, so no nudge here.",
    "Since Dana told us to stop texting, I'll hold off.",
    "Given that Susan said she's not interested, it would be inappropriate to send another follow-up.",
    "This person has opted out.",
    "N/A",
    "Not sending a follow-up, the lead asked to be taken off the list.",
    "I won't send another follow-up here.",
    "Holding off on this one.",
    "Skip - they went with WM",
  ]) {
    assert.ok(notAMessageReason(draft, "Adam"), `expected not-a-message for "${draft}"`);
  }
});

test("friendly nudges that make it easy to say no are still messages (review of 2026-11-13)", () => {
  for (const draft of [
    "hey Adam just checking back in. no reply necessary if you're all set :)",
    "No reply needed if you're all set, just wanted to check in!",
    "No response needed if you've already found a hauler!",
    "no worries if you don't text back, we're around whenever you're ready",
    "if you'd rather we don't text you just let me know",
    "no worries Adam, I won't send another text, we're around whenever you're ready :)",
    "I apologize for the double text! just wanted to make sure you saw the price",
    "hey! don't text and drive lol, but when you get a sec, trash only or trash and recycling?",
    "you don't send a dime until service starts",
    "Adam, did you still want the 95 gal trash bin?",
    "hey Adam! you can always skip the recycling, it's just $5 more",
    "Skip the hassle of hauling your own trash! $20/month for weekly pickup.",
    "no follow-up needed here if you're all set, Adam :)",
  ]) {
    assert.equal(notAMessageReason(draft, "Adam"), null, `expected a message: "${draft}"`);
  }
});

test("the follow-up writer's SKIP line is read with its kind and reason, in any case and with markup", () => {
  assert.deepEqual(parseFollowUpSkip("SKIP: STOP lead asked to be removed"), { kind: "STOP", reason: "lead asked to be removed" });
  assert.deepEqual(parseFollowUpSkip("SKIP: NO - staying with WM"), { kind: "NO", reason: "staying with WM" });
  assert.deepEqual(parseFollowUpSkip("**SKIP: CUSTOMER already has service**"), { kind: "CUSTOMER", reason: "already has service" });
  assert.deepEqual(parseFollowUpSkip("SKIP"), { kind: "OTHER", reason: "" });
  // Found in review (2026-11-13): these were texted to the lead, or lost the STOP.
  assert.deepEqual(parseFollowUpSkip("Skip: STOP said lose this number"), { kind: "STOP", reason: "said lose this number" });
  assert.deepEqual(parseFollowUpSkip("Skip: NO went with WM"), { kind: "NO", reason: "went with WM" });
  assert.deepEqual(parseFollowUpSkip("SKIP: Stop lead asked to be removed"), { kind: "STOP", reason: "lead asked to be removed" });
  assert.deepEqual(parseFollowUpSkip("**SKIP:** STOP they asked to be removed"), { kind: "STOP", reason: "they asked to be removed" });
  assert.deepEqual(parseFollowUpSkip("SKIP: **STOP** they asked to be removed"), { kind: "STOP", reason: "they asked to be removed" });
  assert.deepEqual(parseFollowUpSkip("SKIP — STOP: they asked to be removed"), { kind: "STOP", reason: "they asked to be removed" });
  assert.deepEqual(parseFollowUpSkip("SKIP (STOP): they asked to be removed"), { kind: "STOP", reason: "they asked to be removed" });
  assert.deepEqual(parseFollowUpSkip("skip - OTHER moving away"), { kind: "OTHER", reason: "moving away" });
  assert.deepEqual(
    parseFollowUpSkip("Looking at the conversation, the lead asked to be removed.\n\nSKIP: STOP asked to be removed"),
    { kind: "STOP", reason: "asked to be removed" },
    "a SKIP line after a preamble"
  );
  // A SKIP line that names no kind is STOP only when it says stop.
  assert.deepEqual(parseFollowUpSkip("SKIP: they said to stop texting"), { kind: "STOP", reason: "they said to stop texting" });
  assert.deepEqual(parseFollowUpSkip("SKIP: they said they'd stop by the office"), { kind: "OTHER", reason: "they said they'd stop by the office" });
  assert.deepEqual(parseFollowUpSkip("SKIP: nobody answered"), { kind: "OTHER", reason: "nobody answered" });
  assert.equal(parseFollowUpSkip("hey, skip the recycling? no problem"), null);
  assert.equal(parseFollowUpSkip("Skip the hassle of hauling your own trash! $20/month for weekly pickup."), null);
});

test("leads older than 30 days, or with no readable creation date, are too old to text first", () => {
  const now = new Date("2026-11-13T18:00:00Z");
  assert.equal(isLeadTooOld({ dateAdded: "2026-11-01T00:00:00Z" }, now), false);
  assert.equal(isLeadTooOld({ dateAdded: "2026-10-15T00:00:00Z" }, now), false);
  assert.equal(isLeadTooOld({ dateAdded: "2026-10-13T00:00:00Z" }, now), true);
  assert.equal(isLeadTooOld({}, now), true);
  assert.equal(isLeadTooOld({ dateAdded: "not a date" }, now), true);
});

test("a stop request in a conversation counts until the lead texts START, and only the lead's own texts count", () => {
  const turn = (direction: ConversationTurn["direction"], body: string): ConversationTurn => ({ direction, body, dateAdded: "2026-11-01T00:00:00Z" });

  assert.equal(latestStopRequest([turn("outbound", "Reply STOP to opt out"), turn("inbound", "how much is it?")]), null);
  assert.deepEqual(latestStopRequest([turn("inbound", "Stop texting me"), turn("outbound", "got it"), turn("inbound", "STOP")]), {
    text: "STOP",
    reason: "opt-out keyword",
    dateAdded: "2026-11-01T00:00:00Z",
  });
  assert.equal(latestStopRequest([turn("inbound", "STOP"), turn("inbound", "START"), turn("inbound", "ok what are the prices")]), null);
  assert.deepEqual(latestStopRequest([turn("inbound", "STOP"), turn("inbound", "Start"), turn("inbound", "actually take me off your list")]), {
    text: "actually take me off your list",
    reason: "opt-out phrase",
    dateAdded: "2026-11-01T00:00:00Z",
  });
  assert.deepEqual(
    textsSinceResubscribe([turn("inbound", "STOP"), turn("inbound", "START"), turn("outbound", "welcome back"), turn("inbound", "hi")]).map((t) => t.body),
    ["hi"]
  );
});

// ---------------------------------------------------------------------------
// Second review (2026-11-13)
// ---------------------------------------------------------------------------

test("a SKIP line is read whatever comes after SKIP: a space, a period, markup or brackets", () => {
  for (const draft of ["SKIP STOP", "SKIP. STOP", "**SKIP** STOP: reads as no more texts", "[SKIP] STOP lead said enough", "SKIP/STOP", "SKIP | STOP", "SKIP; STOP", "Skip STOP", "SKIPPED: STOP", "Decision: SKIP: STOP asked to be removed", "<text>SKIP STOP</text>"]) {
    assert.equal(parseFollowUpSkip(draft)?.kind, "STOP", draft);
    assert.ok(notAMessageReason(draft.replace(/<\/?text>/g, "")), `never a message: "${draft}"`);
  }
  assert.deepEqual(parseFollowUpSkip("SKIP NO went with WM"), { kind: "NO", reason: "went with WM" });
  assert.deepEqual(parseFollowUpSkip("SKIP CUSTOMER already has service"), { kind: "CUSTOMER", reason: "already has service" });
});

test("a SKIP that says the lead asked to stop is STOP, whatever it is labelled, and a free-text 'no' is not the NO kind", () => {
  for (const draft of [
    "SKIP: lead asked to be removed from the list",
    "SKIP: no more texts, the lead wants to be left alone",
    "SKIP: No further contact wanted",
    "SKIP: OPT-OUT lead wants out",
    "SKIP: UNSUBSCRIBE",
    "SKIP: the lead asked not to be contacted again",
    "SKIP: NO lead said not interested and asked to be left alone",
    "SKIP: NO said take me out of your system",
    "SKIP: NO not interested. Go away.",
  ]) {
    assert.equal(parseFollowUpSkip(draft)?.kind, "STOP", draft);
  }
  for (const [draft, kind] of [
    ["SKIP: OTHER lead stopped texting back", "OTHER"],
    ["SKIP: OTHER lead never texted back", "OTHER"],
    ["SKIP: NO lead opted out of the recycling add-on, then said no", "NO"],
    ["SKIP: no - went with WM", "NO"],
    ["SKIP: No, they went with WM", "NO"],
  ] as const) {
    assert.equal(parseFollowUpSkip(draft)?.kind, kind, draft);
  }
});

test("the follow-up writer's answer is sent only from between <text> and </text>, and anything else is never sent", () => {
  assert.deepEqual(readFollowUpDraft("<text>hey Adam, still around?</text>", "Adam"), { kind: "message", text: "hey Adam, still around?" });
  assert.deepEqual(readFollowUpDraft("```\n<text>\"hey Adam, still around?\"</text>\n```", "Adam"), { kind: "message", text: "hey Adam, still around?" });
  for (const draft of ["hey Adam, still around?", "Lead opted out.", "No message.", "NONE", "Nothing to send: lead went with Republic.", "Do not send. Lead said they're all set with WM.", "*(no reply — conversation has reached a natural close)*", "Here it is: <text>hey Adam</text>", "<text>hey</text><text>again</text>"]) {
    assert.equal(readFollowUpDraft(draft, "Adam").kind, "not_a_message", draft);
  }
  for (const draft of ["<text>Lead opted out.</text>", "<text>They already opted out.</text>", "<text>No further message needed here, lead already declined.</text>", "<text>Adam said he went with WM.</text>"]) {
    assert.equal(readFollowUpDraft(draft, "Adam").kind, "not_a_message", draft);
  }
  assert.equal(readFollowUpDraft("SKIP: STOP asked to be removed").kind, "skip");
});

test("nudges that greet the lead by name, or mention someone the lead did, are messages (second review)", () => {
  for (const draft of [
    "hey Adam just wanted to check back in, trash only or trash and recycling?",
    "hey Adam wanted to see if you still needed prices, we would be $20 monthly for just trash",
    "Adam just wanted to check back in, trash only or trash and recycling?",
    "no rush if she wants to think it over, just let me know",
    "happy to answer anything she asked about!",
    "no reply needed, just wanted you to know we're here when you're ready :)",
  ]) {
    assert.equal(notAMessageReason(draft, "Adam"), null, draft);
  }
  assert.match(notAMessageReason("Adam said he went with WM.", "Adam")!, /\("Adam said"\)/, "the reason quotes the words");
});

test("a stop request is read for every reason a person must see, a possible crisis first", () => {
  assert.deepEqual(stopNeedsPersonReasons("Stop texting me. I need to talk to someone, I want to kill myself"), ["possible crisis situation", "explicit request for a human"]);
  assert.deepEqual(stopNeedsPersonReasons("Please stop texting me, I'm in the emergency room after trying to kill myself"), ["possible crisis situation", "safety/property-damage report"]);
  assert.deepEqual(stopNeedsPersonReasons("Stop texting me or I'll sue"), ["legal/regulatory mention"]);
  assert.deepEqual(stopNeedsPersonReasons("stop texting me, wrong number"), []);
  assert.equal(evaluateInbound("I need to talk to someone, I feel like I might hurt myself", company).reason, "possible crisis situation");
});

// ---------------------------------------------------------------------------
// Third review (2026-11-13)
// ---------------------------------------------------------------------------

test("a SKIP labelled NO, CUSTOMER or OTHER becomes STOP only when the reason says the lead asked to stop", () => {
  // The writer's own instructions, or a pause, keep the label: no opt-out, no do-not-disturb.
  for (const [draft, kind] of [
    ["SKIP: CUSTOMER already signed up yesterday, no further contact needed", "CUSTOMER"],
    ["SKIP: CUSTOMER already has service, take them off the follow-up list", "CUSTOMER"],
    ["SKIP: OTHER lead will reach out when ready, leave them alone for now", "OTHER"],
    ["SKIP: CUSTOMER already a customer, do not contact about signup", "CUSTOMER"],
    ["SKIP: CUSTOMER no more texts needed", "CUSTOMER"],
    ["SKIP: NO no further messages needed", "NO"],
    ["SKIP: CUSTOMER remove from the follow-up list", "CUSTOMER"],
    ["SKIP: CUSTOMER already signed up, don't text them again", "CUSTOMER"],
    ["SKIP: NO went with WM, no further contact needed", "NO"],
    ["SKIP: CUSTOMER they said they already signed up, no further contact needed", "CUSTOMER"],
    ["SKIP: OTHER lead asked not to be texted until after the holidays", "OTHER"],
    ["SKIP: OTHER lead said to text back next month", "OTHER"],
    ["SKIP: already signed up, no further contact needed", "OTHER"],
    ["SKIP: stop the drip, they're a customer", "OTHER"],
    ["SKIP: OTHER they will stop by the office", "OTHER"],
  ] as const) {
    assert.equal(parseFollowUpSkip(draft)?.kind, kind, draft);
  }
  // The lead's own words, something they did, or the writer reporting it.
  for (const draft of [
    "SKIP: CUSTOMER already has service and asked us to stop texting",
    "SKIP: OTHER lead opted out last week",
    "SKIP: OTHER they unsubscribed",
    "SKIP: NO said no, stop texting",
    "SKIP: NO lead asked us not to text him again",
    "SKIP: NO they don't want any more texts",
    "SKIP: NO lead said quit bugging me",
    'SKIP: OTHER lead said "please take me off, thanks"',
    "SKIP: OTHER lead texted STOP last month",
  ]) {
    assert.equal(parseFollowUpSkip(draft)?.kind, "STOP", draft);
  }
});

test("a SKIP that names no kind is STOP when it quotes or reports a stop, as before", () => {
  for (const draft of [
    "SKIP: lead said stop, won't nudge",
    "SKIP: lead already said STOP, no follow-up",
    "SKIP: lead replied 'stop it' to our last text",
    'SKIP: lead said "you can stop now lol"',
    "SKIP: no more texts, lead said enough",
    "<text>SKIP: no more texts, lead said enough</text>",
    "SKIP: no more texts, lead said enough\n\n",
  ]) {
    assert.equal(parseFollowUpSkip(draft)?.kind, "STOP", JSON.stringify(draft));
  }
  assert.deepEqual(parseFollowUpSkip("SKIP: STOP\nThe lead asked to be removed."), { kind: "STOP", reason: "The lead asked to be removed." }, "the reason on the next line");
});

test("a SKIP mentioned next to a message, or a lead named Skip, is not a SKIP line", () => {
  assert.equal(readFollowUpDraft("<text>hey Adam, still around?</text>\nNot a SKIP case: lead was interested.", "Adam").kind, "not_a_message");
  assert.equal(readFollowUpDraft("No SKIP: lead is engaged\n<text>hey Adam, still around?</text>", "Adam").kind, "not_a_message");
  assert.equal(readFollowUpDraft("<text>hey Adam, still around?</text>\nSKIP: NO went with WM", "Adam").kind, "not_a_message", "a message and a SKIP line: redraft");
  assert.deepEqual(readFollowUpDraft("<text>hey Adam, still around?</text>\nSKIP: STOP lead asked to be removed", "Adam"), {
    kind: "skip",
    skip: { kind: "STOP", reason: "lead asked to be removed" },
  }, "but STOP always wins");
  assert.equal(readFollowUpDraft("Here's my answer: <text>SKIP: NO went with WM</text>", "Adam").kind, "skip");
  for (const draft of [
    "<text>Skip, just checking in! trash only or trash and recycling?</text>",
    "<text>Skip! still interested in the 95 gal?</text>",
    "<text>Skip, I'll stop texting after this one, just reach out whenever :)</text>",
  ]) {
    assert.equal(readFollowUpDraft(draft, "Skip").kind, "message", draft);
  }
  assert.equal(readFollowUpDraft("SKIP: STOP asked to be removed", "Skip").kind, "skip");
  assert.deepEqual(readFollowUpDraft("```xml\n<text>hey Adam, still around?</text>\n```", "Adam"), { kind: "message", text: "hey Adam, still around?" });
});

test("notes inside the tags, and an untagged note, are never sent, and the redraft request says why", () => {
  for (const draft of [
    "No further follow-up — they already declined.",
    "Not sending anything here, lead said no thanks.",
    "They already went with Republic, no follow-up.",
    "Already a customer, not texting.",
    "They said they're all set.",
    "no problem Adam, I've taken you off our list",
    "I won't send a follow-up here, but a call might work better.",
    "She went with WM, so no need for you to follow up.",
  ]) {
    assert.equal(readFollowUpDraft(`<text>${draft}</text>`, "Adam").kind, "not_a_message", draft);
  }
  const untagged = readFollowUpDraft("No further follow-up — they already declined.", "Adam");
  assert.equal(untagged.kind, "not_a_message");
  assert.match((untagged as { why: string }).why, /^it isn't between <text> and <\/text>, and it says no message should be sent/);
});

test("final nudges and nudges about the lead's partner are messages (third review)", () => {
  for (const draft of [
    "I won't text you again, but we're around whenever you're ready :)",
    "I won't be sending another text after this one, just reach out whenever :)",
    "hey Adam, did your wife get a chance to look? She wanted to know about recycling, it's $10 more",
    "Adam just wanted to double check if you still wanted the 95 gal",
    "Adam wanted to know if the 1st still works for a start",
    "hey Adam! you can skip the hassle of hauling to the dump, $20/month for weekly pickup",
    "stop by the office anytime if you'd rather sign up in person",
    "no more bags piling up in the garage :) want me to get you set up?",
    "if you're already a customer, ignore this!",
    "No more texts from me — take care!",
  ]) {
    assert.equal(notAMessageReason(draft, "Adam"), null, draft);
  }
});

test("stop requests in the words the follow-up writer's check knew are caught from the lead too (third review)", () => {
  for (const text of [
    "Quit bugging me",
    "Take me out of your system",
    "Not interested. Go away.",
    "Please cease",
    "Enough with the texts",
    "I'd rather not hear from you guys again",
    "Not interested, lose my info",
    "Not interested and please erase my number",
    "I'm not interested, kindly refrain from texting me",
    "No further contact please",
    "Nope, I reached out months ago. Forget my number and please don't respond",
  ]) {
    assert.ok(stopRequestReason(text), text);
  }
  for (const text of ["the smell won't go away", "enough with the rain already, when is pickup?", "no further questions, sign me up", "can you take the old couch out of the garage?"]) {
    assert.equal(stopRequestReason(text), null, text);
  }
});

test("everyday crisis wordings are a possible crisis, and ordinary texts are not (third review)", () => {
  for (const text of [
    "Stop texting me. I don't want to live anymore",
    "leave me alone, I just want to end it all",
    "stop texting me, everyone would be better off if I was dead",
    "Stop texting me. I'm not going to be here much longer anyway",
    "Leave me alone, I wish I was dead",
    "Stop texting me, I have no reason to live",
    "remove me. kms",
    "Stop texting me I'm going to take all my pills",
    "I can't do this anymore, I'm done with life",
    "can't go on like this",
  ]) {
    assert.equal(stopNeedsPersonReasons(text)[0] ?? escalationReasons(text)[0], "possible crisis situation", text);
  }
  for (const text of [
    "the truck can't go on our street, it's too narrow",
    "can't go on Tuesday, can you do Wednesday",
    "I want to end it all with Republic and switch to you",
    "I need to take my pills before the pickup lol",
    "we're better off with weekly pickup",
    "I won't be here on Tuesday",
  ]) {
    assert.ok(!escalationReasons(text).includes("possible crisis situation"), text);
  }
});

// ---------------------------------------------------------------------------
// Fourth review (2026-11-13)
// ---------------------------------------------------------------------------

test("stop requests with no punctuation, or in other everyday words, are caught (fourth review)", () => {
  for (const text of [
    "Not interested go away",
    "go away please",
    "just go away",
    "Remove me I'm not interested",
    "can you take me off we went with WM",
    "Remove me or I will take legal action",
    "not interested lose my number",
    "I don't want to receive sms messages",
    "I do not wish to be contacted",
    "I'd rather you not text me",
    "I've had enough of your texts",
    "Please remove me from your records",
    "take my number out of your phone",
    "Remove this phone number",
    "Put me on your do not call list",
    "knock it off",
    "not interested, please don't message again",
  ]) {
    assert.ok(stopRequestReason(text), text);
  }
});

test("corrections, trips and other people bugging the lead are not stop requests (fourth review)", () => {
  for (const text of [
    "Forget the info I sent, the address is wrong",
    "Forget the details, how much per month?",
    "yes please. my HOA won't stop bugging me about the bins being out",
    "take my info out of the system and re-enter it",
    "get me out of the Republic system",
    "I'd rather not be texted before 9am but yes go ahead",
    "I'd rather not hear from the driver",
    "refrain from sending a paper bill",
    "there's no further contact info on the site",
    "is 65 gal big enough your texts said 95 was better",
    "Please remove me and add my wife as the account holder",
    "take me off the Tuesday route",
    "We go away for the winter, can we pause?",
    "Will the bins go away if I cancel?",
    "I don't want to get texts at work",
    "get off the phone",
  ]) {
    assert.equal(stopRequestReason(text), null, text);
  }
});

test("\"just go away\" said of a fee, a smell or old bins is not a stop request; said to us it still is (sixth review)", () => {
  for (const text of [
    "Will the bins just go away or do I need to call?",
    "So the late fee will just go away?",
    "Will the smell just go away?",
    "Will the old Republic can just go away or do I need to call them?",
    "Does it just go away?",
    "Do the old cans just go away?",
    "Does the extra cart charge just go away now?",
    "So it'll just go away?",
    "I wish the HOA would just go away lol",
  ]) {
    assert.equal(stopRequestReason(text), null, text);
  }
  for (const text of [
    "just go away",
    "please just go away",
    "Not interested just go away",
    "Can you just go away?",
    "Why don't you just go away",
    "I wish you would just go away",
    "What do I have to do to make you go away?",
    "Do I have to say it again just go away",
    "Can the bot just go away",
  ]) {
    assert.ok(stopRequestReason(text), text);
  }
});

test("crisis wordings typed with an iPhone apostrophe or in everyday spellings are a possible crisis (fourth review)", () => {
  for (const text of [
    "Stop texting me. I don’t want to live anymore",
    "Leave me alone, I can’t go on like this",
    "I don't wanna live anymore",
    "Leave me alone. I'm ending it all tonight",
    "no reason to keep living",
    "I'm done living",
    "I'd rather be dead",
    "I can't go on.",
  ]) {
    assert.equal(stopNeedsPersonReasons(text)[0] ?? escalationReasons(text)[0], "possible crisis situation", text);
  }
  assert.equal(evaluateInbound("I don’t want to live anymore", {} as any).action, "escalate");
  for (const text of ["I'm done living in Denver, moving next month", "we can't go on the 1st, can we do the 3rd", "I don't want to wake up at 5am to roll the cans out"]) {
    assert.ok(!escalationReasons(text).includes("possible crisis situation"), text);
  }
});

test("a stop request with a cease and desist, TCPA, FCC or the do-not-call list goes to a person (fourth review)", () => {
  for (const text of [
    "This is a cease and desist. Stop texting me.",
    "Stop texting me, this is a TCPA violation",
    "Stop texting me or I'll report you to the FCC",
    "Remove me or I will take legal action",
    "I'm on the do not call list, stop texting me",
  ]) {
    assert.ok(stopNeedsPersonReasons(text).includes("legal/regulatory mention"), text);
  }
});

test("a follow-up that confirms a stop request in the present or future is never sent, but an offer or a door left open is (fourth review)", () => {
  for (const draft of [
    "I'll take you off our list",
    "we won't text you again",
    "you won't hear from us again",
    "removing you from our texts now",
    "got it, we'll stop texting you. take care!",
    // Short notes wrapped in the tags after the redraft request.
    "No nudge — they went with WM.",
    "Out of service area, so no nudge.",
    "No follow-up — they asked to be added to the do not call list.",
  ]) {
    assert.equal(readFollowUpDraft(`<text>${draft}</text>`, "Adam").kind, "not_a_message", draft);
  }
  for (const draft of [
    "I won't text you again, but we're around whenever you're ready :)",
    "just reply STOP and I'll remove you",
    "we can drop off a bin whenever you're ready",
    "happy to remove your old bin when we drop off the new one",
    "no rush, no follow-up needed on your end :)",
  ]) {
    assert.equal(readFollowUpDraft(`<text>${draft}</text>`, "Adam").kind, "message", draft);
  }
});

test("a SKIP reason that says the lead did not ask to stop, or a pause, keeps its label (fourth review)", () => {
  for (const [draft, kind] of [
    ["SKIP: CUSTOMER said they signed up on the website yesterday (not a stop request)", "CUSTOMER"],
    ["SKIP: NO said no thanks, didn't ask us to stop texting", "NO"],
    ["SKIP: NO said no thanks, another nudge would feel like harassment", "NO"],
    ["SKIP: NO went with WM, so no more texts should go out", "NO"],
    ['SKIP: OTHER lead said "don\'t text me at work"', "OTHER"],
    ["SKIP: CUSTOMER they said the driver didn't stop yesterday", "CUSTOMER"],
    ["SKIP: OTHER lead said they go away for the winter", "OTHER"],
    ["SKIP: OTHER lead said they're opting out of service", "OTHER"],
    ["SKIP: OTHER asked us not to text during tax season", "OTHER"],
  ] as const) {
    assert.equal(parseFollowUpSkip(draft)?.kind, kind, draft);
  }
  for (const draft of [
    "SKIP: NO lead asked to be put on the do not call list",
    "SKIP: NO told us to never contact them again",
    "SKIP: NO asked us to remove their number",
    "SKIP: lead told us to buzz off",
    "SKIP: DNC",
    'SKIP: OTHER lead said "enough already"',
    "SKIP: NO lead said no stop texting me",
  ]) {
    assert.equal(parseFollowUpSkip(draft)?.kind, "STOP", draft);
  }
  assert.equal(readFollowUpDraft("<text>Based on the conversation:\nSKIP: STOP said knock it off</text>", "Adam").kind, "skip", "a SKIP: STOP line inside the tags");
  assert.equal(readFollowUpDraft("<text>Skip :) still want prices?</text>", "Skip").kind, "message", "a lead named Skip");
});

test("the writer's other stop reports are STOP, and bin, service and pause wording keeps its label (fifth review)", () => {
  for (const draft of [
    "SKIP: lead opted out of receiving texts",
    "SKIP: NO lead asked to opt out of getting texts",
    "SKIP: OTHER lead opted out of being contacted",
    "SKIP: NO lead unsubscribed from the SMS list",
    'SKIP: NO lead said "I would like to opt out of receiving these"',
    "SKIP: NO lead says they never requested a quote and wants to be removed from the list",
    "SKIP: NO lead asked to be removed without saying why",
    "SKIP: NO lead asked us to put a stop to the texts",
    "SKIP: NO lead asked why the texts won't stop",
    "SKIP: NO lead asked to be removed during the conversation",
    "SKIP: NO lead asked to be removed from the list during our last exchange",
    "SKIP: NO lead said stop texting during the first reply",
    "SKIP: we were told to stop texting",
  ]) {
    assert.equal(parseFollowUpSkip(draft)?.kind, "STOP", draft);
  }
  for (const [draft, kind] of [
    ["SKIP: NO lead said they decided not to get the bins at this time", "NO"],
    ["SKIP: CUSTOMER said they already signed up and asked not to get a second bin", "CUSTOMER"],
    ["SKIP: CUSTOMER already a customer, requested removal of a recycling tote", "CUSTOMER"],
    ["SKIP: OTHER lead will reach out when ready, said do not call", "OTHER"],
    ["SKIP: CUSTOMER said one bin is enough already", "CUSTOMER"],
    ["SKIP: CUSTOMER asked us to knock it off the bill", "CUSTOMER"],
    ["SKIP: OTHER lead opted out of recycling", "OTHER"],
    ["SKIP: CUSTOMER they said the driver came to a stop but didn't pick up", "CUSTOMER"],
    ["SKIP: NO has not opted out and just said not interested", "NO"],
    // A time to keep clear of, not a stop: any "during ...", not only a listed span.
    ["SKIP: OTHER asked us not to text during dinner", "OTHER"],
    ["SKIP: OTHER lead asked not to be texted during their shift", "OTHER"],
    ["SKIP: CUSTOMER asked us not to text during working hours", "CUSTOMER"],
    ["SKIP: OTHER lead asked us not to text during early morning hours", "OTHER"],
    ["SKIP: OTHER asked not to be contacted during the closing on their house", "OTHER"],
  ] as const) {
    assert.equal(parseFollowUpSkip(draft)?.kind, kind, draft);
  }
});

test("a SKIP reason about something else that won't stop, or a stop put to something other than texts, keeps its label (sixth review)", () => {
  for (const draft of [
    'SKIP: NO lead said "please put a stop to these"',
    "SKIP: NO lead asked us to put a stop to all of the texts",
    "SKIP: NO lead wants us to put a stop to contacting them",
    "SKIP: NO lead said these texts won't stop",
    "SKIP: NO lead said the calls won't stop",
  ]) {
    assert.equal(parseFollowUpSkip(draft)?.kind, "STOP", draft);
  }
  for (const [draft, kind] of [
    ["SKIP: CUSTOMER said their bin is cracked and it won't stop leaking", "CUSTOMER"],
    ["SKIP: CUSTOMER said the truck used to come down their street but it doesn't stop anymore", "CUSTOMER"],
    ["SKIP: CUSTOMER said the late fees keep coming and these won't stop", "CUSTOMER"],
    ["SKIP: CUSTOMER wants us to put a stop to the late fees", "CUSTOMER"],
    ["SKIP: CUSTOMER asked us to put a stop to the missed pickups", "CUSTOMER"],
    ["SKIP: NO said they want to put a stop to the service", "NO"],
    ["SKIP: CUSTOMER said the truck came to a stop to let a car pass and then left", "CUSTOMER"],
  ] as const) {
    assert.equal(parseFollowUpSkip(draft)?.kind, kind, draft);
  }
});

test("the bot's other stop-confirmation wordings and short no-nudge notes are never sent (fifth review)", () => {
  for (const draft of [
    "No worries, sorry for the mix-up! I'll get this number taken off our list.",
    "I'll make sure you're taken off the list",
    "just confirming you're removed from our list",
    "we won't reach out further",
    "I'll stop texting you.",
    "Got it, sounds like you'd rather not hear from us — I'll take you off our list.",
    "we won't text you again. Sorry for the confusion here!",
    "Went with WM, no follow-up needed.",
    "Out of area. No follow-up necessary.",
    "No nudge (already a customer).",
  ]) {
    assert.equal(readFollowUpDraft(`<text>${draft}</text>`, "Adam").kind, "not_a_message", draft);
  }
  for (const draft of [
    "I'll stop texting you after this one, reach out anytime",
    "no reply needed if you're all set",
    "no follow-up needed unless you want prices",
    "I won't text you again, but we're here if you ever need a bin :)",
  ]) {
    assert.equal(readFollowUpDraft(`<text>${draft}</text>`, "Adam").kind, "message", draft);
  }
});

test("a SKIP reason's negation also covers stop words before it and what 'and' adds to it (sixth review)", () => {
  for (const [draft, kind] of [
    ["SKIP: NO said no thanks (stop not requested)", "NO"],
    ["SKIP: NO said they're going with WM, opt-out not requested", "NO"],
    ["SKIP: CUSTOMER said they signed up on the website yesterday (opt-out wasn't requested)", "CUSTOMER"],
    ["SKIP: OTHER said they'll reach out when they're ready — stop was not requested", "OTHER"],
    ["SKIP: NO lead said an opt-out was not requested", "NO"],
    ["SKIP: opt-out not requested, lead just went with WM", "OTHER"],
    ["SKIP: NO the lead didn't ask to be removed and unsubscribed", "NO"],
    ["SKIP: NO lead has not unsubscribed and opted out", "NO"],
    ["SKIP: NO lead didn't ask to stop and doesn't want to be removed", "NO"],
    ["SKIP: NO lead never asked to stop and said nothing about unsubscribing", "NO"],
    ["SKIP: no stop request and no opt-out, just a wrong number", "OTHER"],
  ] as const) {
    assert.equal(parseFollowUpSkip(draft)?.kind, kind, draft);
  }
  for (const draft of [
    "SKIP: NO lead said opt-out not requested but asked to be removed",
    "SKIP: NO lead never asked for a quote and asked to be removed",
    "SKIP: NO lead never asked for this and doesn't want any more texts",
    "SKIP: NO lead said I never asked for this and remove me",
  ]) {
    assert.equal(parseFollowUpSkip(draft)?.kind, "STOP", draft);
  }
});

test("times, pauses, fees, look-ups and other people's habits are not stop requests, and the same words said to us still are (sixth review)", () => {
  for (const text of [
    "I don't want to get texts at 7am on a Saturday",
    "I'd rather you not text me at 7am",
    "Please don't text again at 10:30 at night",
    "Don't text again for a few weeks, we're traveling",
    "I was charged a late fee but I paid on time. Can you knock it off?",
    "The raccoons always knock it off",
    "We just don't bother anymore, the truck never comes for the recycling",
    "Most of my neighbors don't bother anymore",
    "Can you get my info from your records? I lost my account number",
    "Please remove this cell number from the account, my husband will be the contact",
    "Can you remove this phone number and use my email instead",
    "Am I on your do not call list? I haven't heard back about my signup",
  ]) {
    assert.equal(stopRequestReason(text), null, text);
  }
  for (const text of [
    "Knock it off",
    "please knock it off already",
    "seriously knock it off I'm not interested",
    "Can you knock it off with the texts",
    "Please just don't text again",
    "I said don't text again",
    "get me out of your records",
    "remove my number from your records",
    "remove this number",
    "Put me on your do not call list",
    "Cease & desist",
  ]) {
    assert.ok(stopRequestReason(text), text);
  }
  assert.ok(stopNeedsPersonReasons("cease-and-desist").includes("legal/regulatory mention"));
  for (const text of [
    "Am I on your do not call list? I haven't heard back about my signup",
    "This is a violation of the Telephone Consumer Protection Act",
    "I'm reporting you to the Federal Trade Commission",
  ]) {
    assert.ok(escalationReasons(text).includes("legal/regulatory mention"), text);
  }
});

test("a SKIP reason about someone else's instruction, a declined add-on or ending a service keeps its label, and the writer's other stop reports are STOP (sixth review)", () => {
  for (const [draft, kind] of [
    ["SKIP: CUSTOMER they were told to stop putting yard waste in the trash bin", "CUSTOMER"],
    ["SKIP: CUSTOMER they were asked to stop putting yard waste in the trash", "CUSTOMER"],
    ["SKIP: CUSTOMER asked us to stop charging them twice", "CUSTOMER"],
    ["SKIP: CUSTOMER said they will stop their other service in September", "CUSTOMER"],
    ["SKIP: CUSTOMER was offered recycling and yard waste and opted out of everything", "CUSTOMER"],
    ["SKIP: CUSTOMER was offered extra totes and opted out of getting them", "CUSTOMER"],
    ["SKIP: CUSTOMER opted out of the follow-up visit", "CUSTOMER"],
    ["SKIP: CUSTOMER unsubscribed from the follow-up survey", "CUSTOMER"],
  ] as const) {
    assert.equal(parseFollowUpSkip(draft)?.kind, kind, draft);
  }
  for (const draft of [
    "SKIP: we were told to stop texting",
    "SKIP: NO lead said stop wasting my time",
    "SKIP: lead opted out of follow-ups",
    "SKIP: NO lead unsubscribed from the follow-up texts",
    "SKIP: NO lead opted out of receiving these",
    "SKIP: NO lead never asked for this, stop texting",
    "SKIP: NO lead never requested a quote, no more texts",
    "SKIP: NO lead asked not to receive any further texts",
    "SKIP: NO lead asked not to get texted again",
    "SKIP: NO lead said do not call/text",
    "SKIP: NO lead requested removal of this number",
  ]) {
    assert.equal(parseFollowUpSkip(draft)?.kind, "STOP", draft);
  }
  for (const draft of [
    "Understood, I'll make sure you're not contacted again.",
    "Got it, you're all set — no further messages from us. Take care!",
    "No worries, we'll stop here. Take care.",
    "I'll make sure no one reaches back out. Take care!",
  ]) {
    assert.equal(readFollowUpDraft(`<text>${draft}</text>`, "Adam").kind, "not_a_message", draft);
  }
  assert.equal(readFollowUpDraft("<text>We'll stop here for now, reach out whenever you're ready!</text>", "Adam").kind, "message");
});
