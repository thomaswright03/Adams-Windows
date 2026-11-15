# Former-client text bot

Texts a list of former clients once from an A2P-approved Twilio number, then
lets Claude answer their replies for 10 days: it answers questions from the
facts you give it, collects the day and time they want, and hands anything
unusual to you. It runs in the cloud (Vercel + a GitHub Actions timer), so
your laptop can be closed.

Built from the Kaizen lead responder: the stop-request and escalation checks
in `lib/safety.ts` are Kaizen's, and they run in code **before** Claude is
asked anything.

## How it behaves

- **First text:** one per lead, ever, from the business they know, with their
  first name and "Reply STOP to opt out". Only 8am to 8pm Arizona time, at most
  4 every 10 minutes and 50 a day.
- **Replies:** Claude writes each reply from the conversation and your notes.
  It never invents prices or open times and never confirms a booking: when
  someone names a day and time, you get a **BOOKING REQUEST** text to confirm.
- **Review mode first:** every reply is texted to you as a numbered draft.
  Text `Y12` to send draft 12, `N12` to skip it, or `E12 your own text`.
  Text `AUTO ON` once you trust it.
- **Hand-offs:** asking for a person, complaints, legal or billing words,
  anything Claude flags, or a reply that doesn't look right: the lead goes to
  **NEEDS YOU** and the bot stops answering them. Text
  `S 6025551234 message` to reply from the business number, or
  `R 6025551234` to give them back to the bot.
- **Opt-outs:** STOP, "don't text me" and every other wording Kaizen catches
  ends it instantly and permanently. No path can text an opted-out number.
- **Nudges:** up to 2 gentle ones (day 3 and day 6) to people who never replied.
- **Day 10:** the bot stops answering that lead, marks non-repliers "no
  response", forwards late replies to you, and texts you a final report when
  the whole list is done.
- **Kill switch:** text `PAUSE` (and `RESUME`). `STATUS` gives you the numbers.
- **Dry run:** while `DRY_RUN` isn't `false`, nothing reaches a lead; you still
  get every draft and alert.

Texts from your own phone (`OWNER_PHONE`) are always read as commands, never
as a lead. Texts from numbers not on the list are forwarded to you.

## Setup

1. **Vercel:** import this repo as a new project. In **Storage**, add
   **Upstash Redis** (free tier) and connect it to the project.
2. **Environment variables:** copy `.env.example` into the project's
   Environment Variables and fill them in. Keep `DRY_RUN=true` for now.
3. **Twilio:** on the A2P number (Phone Numbers → the number → Messaging), set
   **A message comes in** to Webhook, HTTP POST,
   `https://<your-app>.vercel.app/api/sms?secret=<WEBHOOK_SECRET>`.
   If that number already has a webhook for something else, changing it moves
   all of the number's incoming texts to this bot.
4. **GitHub timer:** in this repo's Settings → Secrets and variables → Actions,
   add the variable `BOT_URL` (`https://<your-app>.vercel.app`) and the secret
   `WEBHOOK_SECRET`.
5. **Leads:** open `https://<your-app>.vercel.app/api/admin`, enter the admin
   password, and paste a CSV (`name,phone,notes`). Start with one test lead
   on a phone you have that is not `OWNER_PHONE` (texts from `OWNER_PHONE`
   are read as commands).

The lead list, conversations and keys live in Redis and Vercel, never in this
repo, because the repo is public.

## Development

```
npm install
npm test        # safety rules + bot behaviour, no network
npm run typecheck
```
