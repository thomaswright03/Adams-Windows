import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Bot } from "./bot.js";
import type { ReplyDecision } from "./claude.js";
import { MemoryKv } from "./kv.js";
import { importLeads } from "./leads.js";
import { Store } from "./store.js";

const OWNER = "+16025550000";
process.env.OWNER_PHONE = "602-555-0000";
process.env.TIMEZONE = "America/Phoenix";

interface Harness {
  bot: Bot;
  store: Store;
  sent: Array<{ to: string; body: string }>;
  toLeads: () => Array<{ to: string; body: string }>;
  toOwner: () => string[];
  clock: { now: Date };
  nextDecision: ReplyDecision;
  drafts: number;
}

// 10:00 AM in Phoenix (UTC-7), a Monday.
const MORNING = new Date("2026-11-16T17:00:00Z");

function harness(opts: { dryRun?: boolean; failSendTo?: string } = {}): Harness {
  const store = new Store(new MemoryKv());
  const h = {
    store,
    sent: [] as Array<{ to: string; body: string }>,
    clock: { now: new Date(MORNING) },
    nextDecision: { reply: "Great, what day works for you?", handoff: null, requestedTime: null } as ReplyDecision,
    drafts: 0,
  } as Harness;
  h.bot = new Bot({
    store,
    dryRun: opts.dryRun ?? false,
    now: () => h.clock.now,
    log: () => {},
    send: async (to, body) => {
      if (to === opts.failSendTo) throw new Error("Twilio send failed: 400 21211 invalid number");
      h.sent.push({ to, body });
      return "SM" + h.sent.length;
    },
    draft: async () => {
      h.drafts++;
      return h.nextDecision;
    },
  });
  h.toLeads = () => h.sent.filter((s) => s.to !== OWNER);
  h.toOwner = () => h.sent.filter((s) => s.to === OWNER).map((s) => s.body);
  return h;
}

async function addLeads(h: Harness, csv = "name,phone,notes\nJane Doe,(602) 555-1111,Paid $180\nBob Smith,602.555.2222,\n") {
  return importLeads(h.store, csv, new Date("2026-11-15T00:00:00Z"));
}

beforeEach(() => {
  delete process.env.AUTO_SEND;
  delete process.env.DAILY_FIRST_TEXT_CAP;
  delete process.env.FIRST_TEXTS_PER_TICK;
});

test("import reads names, normalizes phones, skips repeats and marks excluded", async () => {
  const h = harness();
  const first = await importLeads(h.store, 'First Name,Last Name,Phone,Notes,Exclude\nJane,Doe,602-555-1111,"Front, back windows",\nBob,,602 555 2222,,yes\nNope,,12345,,\n');
  assert.deepEqual({ ...first, badPhone: first.badPhone }, { added: 1, alreadyOnList: 0, excluded: 1, optedOut: 0, badPhone: ["12345"] });
  const again = await importLeads(h.store, "phone,name\n6025551111,Jane Doe\n");
  assert.equal(again.alreadyOnList, 1);
  const jane = await h.store.getLead("+16025551111");
  assert.equal(jane?.name, "Jane Doe");
  assert.equal(jane?.notes, "Front, back windows");
  assert.equal((await h.store.getLead("+16025552222"))?.status, "excluded");
});

test("first texts go out once, use the first name, carry the opt-out line, and respect the caps", async () => {
  const h = harness();
  process.env.FIRST_TEXTS_PER_TICK = "1";
  await addLeads(h);
  await h.bot.tick();
  assert.equal(h.toLeads().length, 1);
  assert.match(h.toLeads()[0]!.body, /^Hi Jane, /);
  assert.match(h.toLeads()[0]!.body, /Reply STOP to opt out/);
  await h.bot.tick();
  await h.bot.tick();
  assert.deepEqual(h.toLeads().map((s) => s.to), ["+16025551111", "+16025552222"]);
  assert.equal((await h.store.getLead("+16025551111"))?.status, "texted");
});

test("daily cap stops first texts for the day", async () => {
  const h = harness();
  process.env.DAILY_FIRST_TEXT_CAP = "1";
  await addLeads(h);
  await h.bot.tick();
  await h.bot.tick();
  assert.equal(h.toLeads().length, 1);
  h.clock.now = new Date(MORNING.getTime() + 24 * 3600e3);
  await h.bot.tick();
  assert.equal(h.toLeads().length, 2);
});

test("nothing the bot starts goes out at night or while paused", async () => {
  const h = harness();
  await addLeads(h);
  h.clock.now = new Date("2026-11-16T05:00:00Z"); // 10 PM Phoenix
  await h.bot.tick();
  assert.equal(h.toLeads().length, 0);
  h.clock.now = new Date(MORNING);
  await h.store.setPaused(true);
  await h.bot.tick();
  assert.equal(h.toLeads().length, 0);
});

test("a failed first text is recorded and never retried", async () => {
  const h = harness({ failSendTo: "+16025551111" });
  await addLeads(h);
  await h.bot.tick();
  await h.bot.tick();
  const jane = await h.store.getLead("+16025551111");
  assert.equal(jane?.status, "failed");
  assert.match(jane?.reason ?? "", /21211/);
  assert.equal(h.toLeads().length, 1); // only Bob
});

test("review mode: a reply becomes a draft you approve by text", async () => {
  const h = harness();
  await addLeads(h);
  await h.bot.tick();
  const before = h.toLeads().length;
  await h.bot.handleInbound("+16025551111", "Yes we'd love that", "SMa");
  assert.equal(h.toLeads().length, before, "nothing sent to the lead before approval");
  const note = h.toOwner().at(-1)!;
  assert.match(note, /#1 Jane Doe/);
  assert.match(note, /Y1 to send/);
  await h.bot.handleInbound(OWNER, "y1", "SMb");
  assert.equal(h.toLeads().at(-1)!.body, "Great, what day works for you?");
  assert.equal((await h.store.getLead("+16025551111"))?.status, "replied");
  // A second Y1 does nothing.
  await h.bot.handleInbound(OWNER, "Y1", "SMc");
  assert.equal(h.toLeads().length, before + 1);
});

test("review mode: E sends your own wording instead", async () => {
  const h = harness();
  await addLeads(h);
  await h.bot.tick();
  await h.bot.handleInbound("+16025551111", "How much?", "SMa");
  await h.bot.handleInbound(OWNER, "E1 It'd be $180 like last time, want Saturday?", "SMb");
  assert.equal(h.toLeads().at(-1)!.body, "It'd be $180 like last time, want Saturday?");
});

test("automatic mode sends the reply straight away", async () => {
  const h = harness();
  await addLeads(h);
  await h.bot.tick();
  await h.bot.handleOwnerCommand("AUTO ON");
  await h.bot.handleInbound("+16025551111", "Yes please", "SMa");
  assert.equal(h.toLeads().at(-1)!.body, "Great, what day works for you?");
});

test("a retried webhook is handled once", async () => {
  const h = harness();
  await addLeads(h);
  await h.bot.tick();
  await h.bot.handleInbound("+16025551111", "Yes", "SMsame");
  await h.bot.handleInbound("+16025551111", "Yes", "SMsame");
  assert.equal(h.drafts, 1);
});

test("STOP in any wording opts out, and nothing is texted to them again", async () => {
  const h = harness();
  await h.bot.handleOwnerCommand("AUTO ON");
  await addLeads(h);
  await h.bot.tick();
  await h.bot.handleInbound("+16025551111", "please don't text me anymore", "SMa");
  const jane = await h.store.getLead("+16025551111");
  assert.equal(jane?.status, "opted_out");
  assert.equal(h.drafts, 0, "Claude is never asked");
  assert.match(h.toLeads().at(-1)!.body, /won't get any more texts/);
  assert.match(h.toOwner().at(-1)!, /opted out/);
  const toJane = () => h.toLeads().filter((s) => s.to === "+16025551111").length;
  const count = toJane();
  await h.bot.handleInbound("+16025551111", "hello?", "SMb");
  h.clock.now = new Date(MORNING.getTime() + 4 * 24 * 3600e3);
  await h.bot.tick();
  assert.equal(toJane(), count);
});

test("plain STOP gets no second confirmation (Twilio sends its own)", async () => {
  const h = harness();
  await addLeads(h);
  await h.bot.tick();
  const count = h.toLeads().length;
  await h.bot.handleInbound("+16025551111", "STOP", "SMa");
  assert.equal(h.toLeads().length, count);
  assert.equal(await h.store.isOptedOut("+16025551111"), true);
});

test("an opted-out number is never first-texted, even if imported again", async () => {
  const h = harness();
  await h.store.addOptOut("+16025551111");
  await addLeads(h);
  await h.bot.tick();
  assert.deepEqual(h.toLeads().map((s) => s.to), ["+16025552222"]);
});

test("asking for a person hands the lead to you and the bot goes quiet", async () => {
  const h = harness();
  await h.bot.handleOwnerCommand("AUTO ON");
  await addLeads(h);
  await h.bot.tick();
  const count = h.toLeads().length;
  await h.bot.handleInbound("+16025551111", "Can I talk to a real person?", "SMa");
  assert.equal((await h.store.getLead("+16025551111"))?.status, "needs_you");
  assert.match(h.toOwner().at(-1)!, /NEEDS YOU/);
  await h.bot.handleInbound("+16025551111", "hello?", "SMb");
  assert.equal(h.toLeads().length, count);
  assert.equal(h.drafts, 0);
  // You reply from the number, then hand them back.
  await h.bot.handleInbound(OWNER, "S 602-555-1111 Hi Jane, Thomas here. Calling you now.", "SMc");
  assert.equal(h.toLeads().at(-1)!.body, "Hi Jane, Thomas here. Calling you now.");
  await h.bot.handleInbound(OWNER, "R 6025551111", "SMd");
  assert.equal((await h.store.getLead("+16025551111"))?.status, "replied");
});

test("Claude's handoff and booking request both reach you", async () => {
  const h = harness();
  await h.bot.handleOwnerCommand("AUTO ON");
  await addLeads(h);
  await h.bot.tick();
  h.nextDecision = { reply: "Thanks! Thomas will confirm the exact time shortly.", handoff: null, requestedTime: "Saturday morning" };
  await h.bot.handleInbound("+16025551111", "Saturday morning works", "SMa");
  const jane = await h.store.getLead("+16025551111");
  assert.equal(jane?.status, "booked");
  assert.equal(jane?.requestedTime, "Saturday morning");
  assert.match(h.toOwner().at(-1)!, /BOOKING REQUEST: Jane Doe .* "Saturday morning"/);

  h.nextDecision = { reply: "Let me have Thomas reach out on that.", handoff: "asked about a discount", requestedTime: null };
  await h.bot.handleInbound("+16025552222", "Any discount for repeat customers?", "SMb");
  assert.equal((await h.store.getLead("+16025552222"))?.status, "needs_you");
});

test("a draft that isn't a real message is never sent", async () => {
  const h = harness();
  await h.bot.handleOwnerCommand("AUTO ON");
  await addLeads(h);
  await h.bot.tick();
  const count = h.toLeads().length;
  h.nextDecision = { reply: "I apologize, but I can't write this message.", handoff: null, requestedTime: null };
  await h.bot.handleInbound("+16025551111", "ok", "SMa");
  assert.equal(h.toLeads().length, count);
  assert.equal((await h.store.getLead("+16025551111"))?.status, "needs_you");
});

test("texts from numbers not on the list are forwarded, not answered", async () => {
  const h = harness();
  await h.bot.handleInbound("+14805559999", "Who is this?", "SMa");
  assert.equal(h.toLeads().length, 0);
  assert.match(h.toOwner().at(-1)!, /not on your list/);
});

test("nudges go out on day 3 and 6 to people who never replied, then the window closes with a report", async () => {
  const h = harness();
  await addLeads(h);
  await h.bot.tick();
  await h.bot.handleInbound("+16025552222", "Yes!", "SMa"); // Bob replied
  const day = (n: number) => new Date(MORNING.getTime() + n * 24 * 3600e3);
  h.clock.now = day(2);
  await h.bot.tick();
  assert.equal(h.toLeads().filter((s) => s.to === "+16025551111").length, 1);
  h.clock.now = day(3);
  await h.bot.tick();
  await h.bot.tick();
  h.clock.now = day(6);
  await h.bot.tick();
  h.clock.now = day(8);
  await h.bot.tick();
  const toJane = h.toLeads().filter((s) => s.to === "+16025551111");
  assert.equal(toJane.length, 3);
  assert.match(toJane[1]!.body, /checking back in/);
  assert.equal(h.toLeads().filter((s) => s.to === "+16025552222").length, 1, "no nudges to someone who replied");
  h.clock.now = day(11);
  await h.bot.tick();
  assert.equal((await h.store.getLead("+16025551111"))?.status, "no_response");
  assert.match(h.toOwner().at(-1)!, /Campaign finished/);
  await h.bot.tick();
  assert.equal(h.toOwner().filter((m) => /Campaign finished/.test(m)).length, 1);
  // A late reply after the window goes to you, not the bot.
  const drafts = h.drafts;
  await h.bot.handleInbound("+16025552222", "Still want it", "SMz");
  assert.equal(h.drafts, drafts);
  assert.match(h.toOwner().at(-1)!, /after the 10-day window/);
});

test("dry run never texts a lead, but still texts you", async () => {
  const h = harness({ dryRun: true });
  await h.bot.handleOwnerCommand("AUTO ON");
  await addLeads(h);
  await h.bot.tick();
  await h.bot.handleInbound("+16025551111", "please stop texting me", "SMa");
  await h.bot.handleInbound("+16025552222", "yes", "SMb");
  assert.equal(h.toLeads().length, 0);
  assert.ok(h.toOwner().length > 0);
  const history = await h.store.history("+16025552222");
  assert.match(history.at(-1)!.body, /^\[dry run, not sent\]/);
});

test("PAUSE stops replies and forwards texts to you", async () => {
  const h = harness();
  await h.bot.handleOwnerCommand("AUTO ON");
  await addLeads(h);
  await h.bot.tick();
  await h.bot.handleInbound(OWNER, "pause", "SMp");
  const count = h.toLeads().length;
  await h.bot.handleInbound("+16025551111", "Yes!", "SMa");
  assert.equal(h.toLeads().length, count);
  assert.match(h.toOwner().at(-1)!, /bot is paused/);
});
