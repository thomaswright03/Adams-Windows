import type { CompanyConfig, ConversationTurn, SafetyVerdict } from "./types.js";

// ---------------------------------------------------------------------------
// Stop requests
//
// Found 2026-11-12 (evaluation S01): of about 50 leads who asked the bot to
// stop in everyday words ("please remove me from your contact list", "leave
// me alone", "Stop texts", "revoke"), the old rules caught fewer than 20, and
// three of the missed ones were later sent follow-up nudges. Biased toward
// catching too much: treating a borderline message as a stop request costs a
// lead we'd have had to win back anyway, while missing a real one is a
// compliance problem (47 CFR 64.1200(a)(10): a request to stop in any
// reasonable words must be honored).
// ---------------------------------------------------------------------------

/** Whole-message keywords the SMS company itself acts on: it blocks the
 * number and sends its own "you have been opted out" reply, so the bot must
 * not send a second confirmation for these (see isCarrierOptOutKeyword).
 * Deliberately NOT matched as a prefix/substring: "cancel my service" must
 * NOT silently opt someone out of texts when what they actually want is a
 * human to process a service cancellation (see the "service cancellation
 * request" escalation pattern below). */
const CARRIER_OPT_OUT_KEYWORDS = [
  "stop", "stopall", "stop all", "unsubscribe", "cancel", "end", "quit", "revoke", "opt out", "optout", "opt-out",
];

/** Other whole-message replies that mean the same thing. */
const OTHER_OPT_OUT_KEYWORDS = [
  "unsub", "remove", "remove me", "remove please", "please remove", "pls remove", "plz remove",
  "stop it", "stop now", "stop please", "stop pls", "stop plz", "pls stop", "plz stop", "stop stop",
  "stop texting", "stop texts", "stop txt", "stop msg", "no thanks stop", "not interested stop",
  "do not text", "dont text", "don't text", "do not contact", "dont contact", "don't contact",
  "no more please", "no more pls", "no more thanks", "no more thank you", "no more texts please",
];

// "stop by Tuesday", "stop in", "stop over": a visit, not a stop request.
const STOP_VISIT = String.raw`(?!\s+(?:by|in|at|over|on|for|here|there|and\s+(?:see|get|grab|pick|drop|look)|the\s+(?:service|pickup|pickups|truck|bin|bins|trash|recycling|delivery|order|contract))\b)`;

/** Right before the end of the text or of a clause: punctuation, an emoji,
 * or nothing. Patterns that use it need the "u" flag. */
const CLAUSE_END = String.raw`(?=\s*(?:[^\p{L}\p{N}\s]|$))`;

/** "don't text me before 9am", "don't text me right now", "at 10:30 at
 * night", "for a few weeks": about when to text, not whether. Sixth review:
 * "at 7am" and "at 10 pm" are times too. */
const NOT_ABOUT_WHEN = String.raw`(?!\s+(?:before|after|until|till|til|during|between|while|when|if|unless|yet|today|tonight|so\s+(?:early|late)|this\s+(?:early|late|morning|afternoon|evening|week)|right\s+now|in\s+the\s+(?:morning|evening|afternoon)|at\s+(?:night|work|\d{1,2}(?::\d{2})?(?:\s*[ap]\.?m)?)|on\s+(?:weekends?|sundays?|saturdays?|holidays?)|tomorrow|for\s+(?:a\s+(?:few|couple|while|bit)|\d+|the\s+next|now))\b)`;

/** Words that start a new thought after "remove me" or "go away" when the
 * lead didn't type a comma: "Remove me I'm not interested", "go away we
 * already have service". */
const NEW_THOUGHT = String.raw`(?:i|i'm|im|i've|ive|i'd|we|we're|were|we've|not|no|nope|never|or|stop|don't|dont|do\s+not|already|please|pls|plz|now|asap|thanks|thank|thx|ty|wrong|this\s+is|it'?s|its|lol|bye)\b`;

/** Before "go away": not said of something else, as in "Will the smell just
 * go away?", "so the late fee will just go away?" or "do the old cans just
 * go away or do I call WM?" (sixth review). That is "will", "does", "can"
 * and the like (or "'ll") up to six words before it in the same clause,
 * with none of US_OR_ME right before that word or between. Still a stop:
 * "can you just go away", "I wish you would just go away", "what do I have
 * to do to make you go away", "can the bot just go away". */
const US_OR_ME = String.raw`(?:you|u|ya|y'?all|i|we|bot|robot|ai|company|texts?|messages?)`;
const NOT_SAID_OF_IT = String.raw`(?<!(?:\b(?<!\b${US_OR_ME}\s+)(?:will|would|does|do|did|can|could|should|might|may)|(?<!\b${US_OR_ME})'ll)\s+(?:(?!(?:${US_OR_ME}|not)\b)[\w'-]+\s+){0,6})`;

// What a lead asks to be taken off: "your contact list", "this text chain",
// "marketing", "any further communications". Not "autopay", "the schedule",
// "the account" or "the waitlist", which are about the service.
const LIST_NOUN = String.raw`(?:lists?|texts?|texting|txts?|messages?|messaging|msgs?|contacts?|database|system|chain|thread|group|marketing|follow[\s-]?ups?|outreach|sms|campaigns?|number|communications?|notifications?|alerts?|calls?)`;
const OFF_THE_LIST =
  String.raw`(?:` +
  // The end of the text or of a clause: "remove me", "Remove me, thanks",
  // "Can you remove me?", "Please remove me 🙏".
  String.raw`\s*(?:[^\p{L}\p{N}\s]\s*)*$|\s*[,;:]|\s+[-–—]+\s` +
  // "remove me please", "take me off now"
  String.raw`|\s+(?:please|pls|plz|now|asap|thanks|thank|thx|ty|immediately|already|too)\b` +
  // "take me off this", "remove me from here", "unsubscribe from all", but
  // only right before the end of a clause: not "take me off autopay for this
  // month".
  String.raw`|\s+(?:(?:from|off)\s+(?:of\s+)?|of\s+)?(?:this|here|there|all|everything|it)${CLAUSE_END}` +
  // "your contact list", "this text chain", "any further communications"
  String.raw`|\s+(?:(?:from|off)\s+)?(?:of\s+)?(?:(?:your|the|this|these|all|ur|any|future|further|my|our|that|y'?all'?s)\s+)*(?:[\w'-]+\s+){0,3}?${LIST_NOUN}\b` +
  String.raw`)`;

const UNSUBSCRIBE = String.raw`unsu(?:bs?|s)c?ri(?:be|bed|bing)`;
const DONT_TEXT = String.raw`(?:don'?t|dont|do\s+not|quit|no\s+more)\s+(?:ever\s+)?(?:(?:call|calling|email|emailing)\s+(?:or|and|&|n|nor|\/)\s+)?(?:text|texting|txt|txting|message|messaging|msg|contact|contacting|bother|bothering|spam|spamming|harass|harassing)`;

/** Matched anywhere in the message (after normalizing apostrophes, case and
 * spacing). */
const OPT_OUT_PHRASES: RegExp[] = [
  new RegExp(String.raw`\b(?:please|pls|plz|kindly)\s+stop\b${STOP_VISIT}`),
  /\b(?:stop|quit)\s+(?:the\s+|these\s+|all\s+|your\s+|with\s+the\s+)?(?:text|texts|texting|txt|txts|txting|messag(?:e|es|ing)|msg|msgs|sms)\b/,
  // "stop sending me texts", "stop contacting me", "stop calling and texting me"
  /\b(?:stop|quit)\s+(?:sending\s+(?:me|us|texts?|messages?|these|this|those|them|stuff)|contacting|calling|bothering|spamming|harassing|pestering|hounding|nagging|soliciting|reaching\s+out|following\s+up|checking\s+in|blowing\s+up)\b/,
  // "quit bugging me", but not "my HOA won't stop bugging me about the bins"
  // (fourth review).
  /(?<!\b(?:won'?t|wont|doesn'?t|don'?t|didn'?t|never|keeps?|always)\s+)\b(?:stop|quit)\s+bugging\s+(?:me|us)\b/,
  // "knock it off", "buzz off" (fourth review). Sixth review: "knock it
  // off" only as a command, at the start or after "please", "just" and the
  // like, or "knock it off with the texts", and not "can you knock it off?"
  // about a late fee or "the raccoons always knock it off".
  new RegExp(String.raw`(?:^|[.!?,;:]\s*|\b(?:please|pls|plz|just|now|seriously|ok|okay|so|and|dude|man|lol|omg|guys|y'?all)\s+)knock\s+it\s+off(?:${CLAUSE_END}|\s+(?:already\b|${NEW_THOUGHT}))|\bknock\s+it\s+off\s+with\s+(?:the\s+|these\s+|your\s+|all\s+(?:the|these|your)\s+)?(?:texts?|txts?|texting|messages?|msgs?|spam|calls?)\b`, "u"),
  /\bbuzz\s+off\b/,
  /^stop\s+wasting\b/,
  // "don't text me", "do not call or text this number", "Please DO NOT
  // TEXT.", but not "don't text me before 9am", "don't text and drive",
  // "don't email me, text me instead" or "they don't text".
  new RegExp(String.raw`\b${DONT_TEXT}\s+(?:me|us|this\s+(?:number|phone|cell|#)|my\s+(?:number|phone|cell|#))\b${NOT_ABOUT_WHEN}`),
  new RegExp(String.raw`(?<!\b(?:they|he|she|i|we|you|who|it|mom|dad|parents)\s+)\b${DONT_TEXT}${CLAUSE_END}${NOT_ABOUT_WHEN}`, "u"),
  // "never text me again", but not "you never text me back"
  /\bnever\s+(?:ever\s+)?(?:text|txt|message|contact|call|bother)\s+(?:me|us)\s+(?:again|anymore|any\s+more)\b/,
  // "don't reach out to me again", "never reach out to me again"
  /\b(?:don'?t|dont|do\s+not|never)\s+(?:ever\s+)?(?:reach\s+out|contact)\s+(?:to\s+)?(?:me|us)\s+(?:again|anymore|any\s+more|ever)\b/,
  // "Please dont solicit to this phone number."
  /\b(?:don'?t|dont|do\s+not|never|stop|quit|no\s+more)\s+(?:ever\s+)?solicit/,
  // "Don't send me this AI generated spam ever again", but not "don't send
  // me a bill yet".
  /\b(?:don'?t|dont|do\s+not|never)\s+(?:ever\s+)?send\s+(?:me|us)\b[^.!?]{0,60}?\b(?:again|anymore|any\s+more)\b/,
  // "Please don't send any more of these", but not "don't send me more info
  // yet".
  new RegExp(
    String.raw`\b(?:don'?t|dont|do\s+not|never|stop|quit)\s+(?:ever\s+)?send(?:ing)?\s+(?:me\s+|us\s+)?(?:(?:any\s*more|more)\s+(?:of\s+(?:these|this|those|them|your\s+(?:texts?|messages?))|texts?|txts?|messages?|msgs?)\b|(?:these|this|those|them)${CLAUSE_END})`,
    "u"
  ),
  // "I do not want to be contacted", "I don't want any more contact from AI
  // bots", "I don't want these texts".
  /\b(?:don'?t|dont|do\s+not|never)\s+(?:want|wish)\s+(?:to\s+be\s+(?:contacted|texted|messaged|followed\s+up)|(?:any\s*more|any|further|your|these|this|those|more|the)\s+(?:contact|texts?|txts?|messages?|msgs?|sms|calls?\s+or\s+texts?)|(?:you|anyone|y'?all)\s+to\s+(?:contact|text|message)\s+(?:me|us))\b/,
  // "I don't want to receive sms messages", "I do not wish to get texts",
  // but not "I don't want to get texts at work" (fourth review).
  new RegExp(String.raw`\b(?:don'?t|dont|do\s+not|never)\s+(?:want|wish)\s+to\s+(?:receive|get)\s+(?:any\s*more\s+|any\s+|these\s+|your\s+|the\s+|more\s+|further\s+)?(?:sms\s+|text\s+)?(?:texts?|txts?|messages?|msgs?|sms)\b${NOT_ABOUT_WHEN}`),
  // "please don't message again", "do not text again" (fourth review), but
  // not "we just don't bother anymore" (sixth review).
  new RegExp(String.raw`(?<!\b(?:they|he|she|i|we|you|who|it|people|folks|neighbou?rs?|everyone|everybody|nobody|most)\s+(?:(?:just|really|honestly|usually|generally|normally|typically|even|actually|kinda|basically|also|still|simply)\s+)?)\b${DONT_TEXT}\s+(?:me\s+|us\s+)?(?:ever\s+)?(?:again|anymore|any\s+more)\b${NOT_ABOUT_WHEN}`),
  /\b(?:don'?t|dont|do\s+not)\s+need\s+to\s+(?:contact|text|message)\s+(?:me|us)\s+(?:anymore|any\s+more|again)\b/,
  /\bno\s+more\s+(?:texts?|texting|txts?|txting|text\s+messages?|messages?|messaging|msgs?|sms|contact|contacting|calls?\s+or\s+texts?)\b/,
  // "No further contact please", "enough with the texts", "I'd rather not
  // hear from you guys again", "kindly refrain from texting me" (third
  // review). Fourth review: only as a request ("no further contact", not
  // "there's no further contact info"; "enough of your texts", not "is 65
  // gal big enough your texts said"), only about us and only about whether
  // to text, not when ("I'd rather not be texted before 9am").
  /(?:^|[.!?,;:]\s*|\b(?:please|pls|plz|want|and|so|just|request|requesting)\s+)no\s+further\s+(?:texts?|texting|txts?|text\s+messages?|messages?|messaging|msgs?|sms|contact|contacting|communications?)\b/,
  /(?:\benough\s+(?:with|of|already\s+with)\s+|(?:^|[.!?,;:]\s*)enough\s+)(?:the|these|your|this|all\s+(?:the|these|your))\s+(?:texts?|txts?|text\s+messages?|messages?|msgs?|texting|spam)\b/,
  new RegExp(
    String.raw`\b(?:i'?d|i\s+would|we'?d|we\s+would)\s+(?:rather|prefer)\s+(?:not\s+(?:to\s+)?(?:hear\s+from\s+(?:you|u|ya|y'?all|your|any\s+of\s+you|anyone|this|these)\b|be\s+(?:texted|contacted|messaged)\b(?!\s+by\s+(?:phone|call|email|mail))|(?:get|receive)\s+(?:any\s*more\s+|more\s+|these\s+|your\s+)?(?:texts?|messages?)\b)|(?:you|u)\s+(?:not|didn'?t|did\s+not|don'?t|do\s+not)\s+(?:text|message|contact)\s+(?:me|us)\b)${NOT_ABOUT_WHEN}(?!\s+(?:at|on|during)\s+(?:work|weekends?|night))`
  ),
  /\brefrain\s+from\s+(?:(?:calling|emailing)\s+(?:or|and|&|\/)\s+)?(?:texting|txting|messaging|contacting|reaching\s+out|sending\s+(?:me|us)\s+(?:any\s*more\s+|more\s+)?(?:texts?|messages?))\b/,
  new RegExp(String.raw`\btake\s+(?:me|us|my\s+(?:number|name|phone|info|information|contact)|this\s+number)\s+off${OFF_THE_LIST}`, "u"),
  new RegExp(String.raw`\b(?:remove|delete|unenroll|unenrol)\s+(?:me|us)${OFF_THE_LIST}`, "u"),
  // Not "remove this cell number from the account" or "remove my number
  // and use my email" (sixth review).
  /\b(?:remove|delete|unsubscribe|unenroll|unenrol)\s+(?:my\s+(?:number|phone|info|information|contact|cell|details)|this\s+(?:phone\s+|cell\s+)?number)\b(?!\s+(?:from\s+(?:the|our|my|this|their)\s+account|and\s+(?:use|add|put|text|call|replace))\b)/,
  // "Please remove me from your records", "delete me from your phone", "take
  // my number out of your phone" (fourth review). "phone" and "records" only
  // here, after "your": not "get off the phone" or "off the record".
  // Sixth review: "get" only with "out of", not "can you get my info from
  // your records?".
  /\b(?:(?:remove|delete|erase|take)\s+(?:me|us|my\s+(?:number|phone\s+number|cell(?:\s+number)?|info|information|name|contact(?:\s+info)?|details)|this\s+(?:phone\s+|cell\s+)?number)\s+(?:from|out\s+of)|get\s+(?:me|us|my\s+(?:number|phone\s+number|cell(?:\s+number)?|info|information|name|contact(?:\s+info)?|details)|this\s+(?:phone\s+|cell\s+)?number)\s+out\s+of)\s+(?:your|ur|y'?all'?s)\s+(?:records?|files?|phones?|cell)\b/,
  // "Remove from list", "remove from your texts"
  new RegExp(String.raw`\bremove\s+from\s+(?:(?:your|the|this|these|all|ur|any|future|further|my|our|that)\s+)*(?:[\w'-]+\s+){0,2}?${LIST_NOUN}\b`, "u"),
  new RegExp(String.raw`\bget\s+(?:me|us|my\s+number)\s+off${OFF_THE_LIST}`, "u"),
  // "Take me out of your system", "get my number out of your database",
  // "take my name out of your contact list". Fourth review: not "get me out
  // of the Republic system" or "take my info out of the system and re-enter
  // it": other words before the list only after "your" or "this".
  new RegExp(
    String.raw`\b(?:take|get|remove|delete|erase)\s+(?:(?:me|us|my\s+(?:number|phone|contact)|this\s+number)\s+out\s+of\s+(?:(?:your|ur|y'?all'?s|this|these)\s+(?:[\w'-]+\s+){0,2}?|(?:the|all)\s+(?:(?:text|texting|sms|contact|marketing|mailing|call|calling|phone|email)\s+)?)|my\s+(?:name|info|information)\s+out\s+of\s+(?:your|ur|y'?all'?s)\s+(?:[\w'-]+\s+){0,2}?)${LIST_NOUN}\b`,
    "u"
  ),
  // "I want off this list", "How do I get off this list?", "I'd like to be
  // taken off your list", "I want to be removed"
  new RegExp(String.raw`\b(?:want|wanna|get|getting|be|been)\s+(?:taken\s+)?off\s+(?:of\s+)?(?:(?:this|your|the|that|these|ur|all|any)\s+)+(?:[\w'-]+\s+){0,2}?${LIST_NOUN}\b`, "u"),
  new RegExp(String.raw`\bbe\s+(?:removed|taken\s+off|unsubscribed|deleted)${OFF_THE_LIST}`, "u"),
  /\bleave\s+(?:me|us)\s+alone\b/,
  // "I asked you to stop", "I already asked to be removed", "I said stop"
  new RegExp(
    String.raw`\b(?:i|we)\s+(?:already\s+|have\s+|'ve\s+|just\s+)*(?:asked|told|said|requested)\s+(?:you\s+|y'?all\s+|u\s+)?(?:already\s+)?(?:(?:to\s+)?stop\b${STOP_VISIT}|to\s+be\s+(?:removed|taken\s+off|unsubscribed)|to\s+(?:remove|unsubscribe)\s+(?:me|us)|(?:you\s+)?not\s+to\s+(?:text|contact|message))`
  ),
  /\bwhy\s+(?:are|r)\s+(?:you|u|y'?all)\s+still\s+(?:texting|txting|messaging|contacting)\b/,
  // "unsubscribe", "unsubscribe me", "how do I unsubscribe?", but not "do I
  // need to unsubscribe from Republic first?"
  new RegExp(String.raw`\b${UNSUBSCRIBE}(?:\s+(?:me|us|my\s+number|this\s+number)\b|${OFF_THE_LIST})`, "u"),
  // "Unsubscribe and please do not share my information", "please unsubscribe"
  new RegExp(String.raw`(?:^|[.!?,;:]\s*|\b(?:please|pls|plz|kindly|just)\s+)${UNSUBSCRIBE}\b`),
  /\brevoke\b/,
  /\b(?:withdraw|withdrawing|rescind|rescinding|revoking)\s+(?:my\s+|all\s+|any\s+|of\s+)?consent\b/,
  // "I do not consent to these texts", "I never consented to this", but not
  // "I don't consent to auto-renewal".
  new RegExp(
    String.raw`\b(?:do\s+not|don'?t|dont|did\s+not|didn'?t|never)\s+(?:give\s+(?:my\s+|you\s+)?|gave\s+(?:my\s+|you\s+)?)?consent(?:ed)?\b(?:${CLAUSE_END}|\s+to\s+(?:(?:these|this|your|any|the|being|receiving|getting)\s+)*(?:texts?|texting|messages?|messaging|contact|contacted|texted|sms|marketing)\b|\s+to\s+(?:this|that|it)${CLAUSE_END})`,
    "u"
  ),
  /\bcease\s*(?:(?:and|&|n)\s*|-and-)desist\b|\bcease\s+(?:(?:all\s+)?(?:contact|communications?|texts?|texting|messages?|messaging))\b/,
  /\bopt\s+me\s+out\b/,
  // "how do I opt out?", "I'd like to opt-out", "opt out of these texts", but
  // not "can I opt out of recycling", "can I opt out after the first year?"
  // or "is there an opt out fee?", which are about the service.
  new RegExp(
    String.raw`\bopt(?:ing)?[\s-]?out\b(?:${CLAUSE_END}|\s+(?:please|pls|plz|now|asap|thanks|thank|thx|already)\b|\s+of\s+(?:this|that|it|all|everything)${CLAUSE_END}|\s+(?:of|from)\s+(?:(?:these|this|the|your|all|any|future|receiving|getting|further)\s+)*(?:texts?|texting|text\s+messages?|messages?|messaging|msgs?|sms|list|mailing|marketing|contact|communications?|notifications?|alerts?|outreach)\b)`,
    "u"
  ),
  // "Lose this number", "please lose my number", "not interested lose my
  // number", but not "did you lose my number?", "don't lose my number" or
  // "forget the info I sent, the address is wrong" (fourth review).
  /(?:^|[.!?,;:]\s*|\b(?:please|pls|plz|just|and|so|kindly|interested|thanks|no\s+thanks)\s+)(?:lose\s+(?:my|this|the|our)\s+(?:number|#|digits)\b(?!\s+of\b)|lose\s+my\s+(?:info|information|contact\s+info|details)\b|erase\s+(?:my|this|our)\s+(?:number|#|digits|info|information|contact\s+info|details)\b|forget\s+(?:my|this|our)\s+(?:number|#|digits)\b(?!\s+of\b))/,
  // "Remove me I'm not interested", "can you take me off we went with WM",
  // "Not interested go away", "go away please": stop words followed by more
  // words with no punctuation (fourth review). Only before words that start
  // a new thought, so not "remove me and add my wife" or "take me off the
  // Tuesday route".
  new RegExp(String.raw`(?:^|[.!?,;:]\s*|\b(?:please|pls|plz|just|interested|thanks|no\s+thanks|so|ok|okay|and|you|u|ya|can|could|would|will|kindly|to)\s+)(?:(?:remove|delete)\s+(?:me|us)|take\s+(?:me|us)\s+off)\s+${NEW_THOUGHT}`, "u"),
  new RegExp(String.raw`(?:^|[.!?,;:]\s*|\b(?:please|pls|plz|just|now|interested|thanks|no\s+thanks|so|ok|okay|and|you|u)\s+)${NOT_SAID_OF_IT}go\s+away(?:${CLAUSE_END}|\s+(?:${NEW_THOUGHT}|forever\b|and\s+(?:leave|stop|don'?t|dont|never|lose)\b))`, "u"),
  // "Put me on your do not call list", "I'm on the DNC list" (fourth review),
  // but not "Am I on your do not call list?" or "I was on the do not call
  // list but I'm interested now", which go to a person (sixth review).
  /(?<!\b(?:am\s+i|are\s+we|is\s+(?:my|this)\s+(?:phone\s+|cell\s+)?(?:number|#)|was\s+i|were\s+we|i\s+was|we\s+were)\s+(?:still\s+)?on\s+(?:your|the|a|ur)\s+)\b(?:do[\s-]not[\s-](?:call|contact|text)|dnc)\s+(?:list|registry)\b/,
  /\b(?:wrong|stop)\s+(?:person|number)[,.!\s]+(?:please\s+)?(?:stop|remove|delete)\b/,
];

// A short message with "stop" in it ("Ok stop", "STOP STOP STOP", "Stop.
// Wrong number") is a stop request, unless "stop" is part of something else:
// "stop by", "bus stop", "don't stop", "the truck didn't stop", or it's a
// question ("Or stop taking calls?").
const SHORT_STOP = new RegExp(
  String.raw`(?<!\b(?:bus|pickup|pick-up|last|first|next|truck|route|one|full|pit|the|a|my|your|our|their|this|that|every|each|don'?t|dont|do\s+not|never|not|can'?t|cant|cannot|won'?t|will\s+not|didn'?t|didnt|did\s+not|doesn'?t|doesnt|does\s+not|isn'?t|wasn'?t|wouldn'?t|couldn'?t|shouldn'?t)\s+)\bstop\b${STOP_VISIT}`
);
const SHORT_STOP_MAX_WORDS = 4;
const LAST_WORD_STOP = new RegExp(SHORT_STOP.source.replace(String.raw`\bstop\b`, String.raw`\bstop\b(?=[^\p{L}\p{N}]*$)`), "u");
const FIRST_WORD_STOP = new RegExp(String.raw`^[^\p{L}\p{N}]*STOP\b(?!\s+(?:BY|IN|AT|OVER|ON|FOR|HERE|THERE)\b)(?=\W+\w)`, "u");
const POLITE_REQUEST = /^(?:can|could|will|would)\s+(?:you|u|ya|y'?all)\b/;

/** A sentence or line that is nothing but a stop request, inside a longer
 * message ("WHOA! STOP! I already have service with you", "We already have
 * service\nSTOP"), or the first or last part of one around a comma or dash
 * ("STOP, I already have trash service", "I never signed up for this,
 * stop"). Only the unambiguous words: a sentence of "cancel" or "end" in a
 * longer message can be about the service. */
const STOP_SENTENCES = [
  "stop", "stop it", "stop now", "stop please", "please stop", "pls stop", "stop stop", "stop all", "stopall",
  "stop texting", "stop texts", "stop texting me", "stop messaging me", "unsubscribe", "unsubscribe me",
  "opt out", "optout", "opt-out", "opt me out", "revoke", "remove", "remove me", "remove me please",
  "please remove me", "please remove", "take me off", "please take me off", "remove from list",
  "remove me from list", "do not text", "don't text", "dont text", "do not text me", "don't text me",
  "dont text me", "do not contact me", "don't contact me", "dont contact me", "leave me alone",
  "lose this number", "lose my number", "no more texts", "go away", "please go away", "cease", "please cease",
  "quit bugging me", "no further contact", "no further contact please",
];

/** Lower-case, straight apostrophes, single spaces. */
function normalizeForStop(messageBody: string): string {
  return messageBody
    .replace(/[\u2018\u2019\u02BC\u0060\u00B4]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** The message without anything around its words: "STOP!!", "\"stop\"",
 * "Stop 🛑" all become "stop". */
function bareMessage(normalized: string): string {
  return normalized.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
}

/** The reasons the opt-out note has always used, so the office's searches
 * still find them. */
export type StopReason = "opt-out keyword" | "opt-out phrase";

/** Why this text is a request to stop texting, or null if it isn't one. */
export function stopRequestReason(messageBody: string): StopReason | null {
  const text = normalizeForStop(messageBody);
  const bare = bareMessage(text);
  if (!bare) return null;
  if (CARRIER_OPT_OUT_KEYWORDS.includes(bare) || OTHER_OPT_OUT_KEYWORDS.includes(bare)) return "opt-out keyword";
  if (OPT_OUT_PHRASES.some((p) => p.test(text))) return "opt-out phrase";
  // Split before the spacing is normalized, so a new line still separates.
  for (const sentence of messageBody.split(/[.!?;\n\r\u2026]+/)) {
    const parts = sentence
      .split(/,|\s[-\u2013\u2014]+\s|[\u2013\u2014]/)
      .map((part) => bareMessage(normalizeForStop(part)))
      .filter(Boolean);
    if (parts.length > 0 && (STOP_SENTENCES.includes(parts[0]!) || STOP_SENTENCES.includes(parts[parts.length - 1]!))) return "opt-out phrase";
  }
  const words = bare.split(/[^\p{L}\p{N}']+/u).filter(Boolean);
  const question = /\?\s*$/.test(text) && !POLITE_REQUEST.test(bare);
  if (words.length <= SHORT_STOP_MAX_WORDS && !question && SHORT_STOP.test(text)) return "opt-out phrase";
  // "We already have service STOP", "STOP I already have trash service":
  // "stop" as the last word, or a shouted STOP as the first.
  if (!question && LAST_WORD_STOP.test(text)) return "opt-out phrase";
  if (FIRST_WORD_STOP.test(messageBody)) return "opt-out phrase";
  return null;
}

/** Is this text a request to stop texting? See stopRequestReason. */
export function isStopRequest(messageBody: string): boolean {
  return stopRequestReason(messageBody) !== null;
}

/** A whole-message keyword the SMS company acts on by itself (blocking the
 * number and replying), so the bot sends no confirmation of its own. */
export function isCarrierOptOutKeyword(messageBody: string): boolean {
  return CARRIER_OPT_OUT_KEYWORDS.includes(bareMessage(normalizeForStop(messageBody)));
}

/** "Text START to opt back in": words a lead uses to undo a stop. The bot
 * never undoes one itself; it flags the lead for a person. */
export function isResubscribeKeyword(messageBody: string): boolean {
  return ["start", "unstop", "resume", "subscribe", "opt in", "optin", "opt-in"].includes(bareMessage(normalizeForStop(messageBody)));
}

/** "no need to follow up", "don't reach out again": not a request to stop
 * every text (they may still sign up), but the drip nudges must stop. */
// Only at the end of what they say about it: not "no need to follow up on
// that, just trash is fine" or "don't need to contact me about recycling".
const NO_FOLLOW_UP_END = String.raw`(?=\s*(?:[.!,;]|$|(?:with|to)\s+(?:me|us)\b|again\b|anymore\b|any\s+more\b))`;
const NO_FOLLOW_UP = new RegExp(
  String.raw`\b(?:no\s+need\s+(?:for\s+you\s+)?to|(?:please\s+)?(?:don'?t|dont|do\s+not)\s+(?:need\s+to\s+)?|no\s+more)\s*(?:(?:follow(?:ing)?[\s-]?(?:up|ups)|reach(?:ing)?\s+out|check(?:ing)?\s+(?:in|back))${NO_FOLLOW_UP_END}|contact(?:ing)?\s+(?:me|us)${NO_FOLLOW_UP_END}|text(?:ing)?\s+(?:me|us)\s+back\b)`
);

/** Does this text ask the bot to stop following up? See NO_FOLLOW_UP. */
export function asksNoFollowUp(messageBody: string): boolean {
  return NO_FOLLOW_UP.test(normalizeForStop(messageBody));
}

/** The lead's own texts that still count, oldest first: the ones after
 * their last START (or similar), which takes back any earlier request to
 * stop. */
export function textsSinceResubscribe(history: ConversationTurn[]): ConversationTurn[] {
  const leadTexts = history.filter((t) => t.direction === "inbound");
  let lastResubscribe = -1;
  leadTexts.forEach((t, i) => {
    if (isResubscribeKeyword(t.body ?? "")) lastResubscribe = i;
  });
  return leadTexts.slice(lastResubscribe + 1);
}

/** The lead's latest request to stop that no later START (or similar) took
 * back, or null if there is none. Used by every job that reads back over a
 * conversation, so they all agree on who asked to stop. */
export function latestStopRequest(history: ConversationTurn[]): { text: string; reason: StopReason; dateAdded: string } | null {
  for (const turn of textsSinceResubscribe(history).reverse()) {
    const reason = stopRequestReason(turn.body ?? "");
    if (reason) return { text: turn.body ?? "", reason, dateAdded: turn.dateAdded };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Drafted follow-ups that aren't messages
//
// Found 2026-11-12 (evaluation S01/S09): when a lead had asked to be removed,
// the follow-up writer twice answered with its own refusal ("I apologize,
// but I can't write this message. Susan explicitly asked to be removed..."),
// and the job texted that to the lead word for word. The follow-up prompts
// now ask for the message between <text> and </text>, or a SKIP line instead
// (see readFollowUpDraft): anything else is never sent. Found 2026-11-13
// (second review): with the answer read as the message unless it looked like
// a note, short notes ("Lead opted out.", "NONE") and SKIP lines without a
// colon ("SKIP STOP") were texted to the lead. notAMessageReason is now the
// second check, on what is between the tags.
// ---------------------------------------------------------------------------

/** What a note says after "he", "she" or the lead's own first name: "Adam
 * said he went with WM", "Since Dana told us to stop texting", "she's not
 * interested". */
const NOTE_VERB = String.raw`(?:'s|\s+(?:has|had|is|was))?\s+(?:already\s+|explicitly\s+|clearly\s+|just\s+)*(?:asked|said|declined|wants|wanted|requested|indicated|stated|opted|told\s+(?:us|me)|went\s+with|signed\s+up\s+(?:with|elsewhere)|made\s+it\s+clear|not\s+interested|isn'?t\s+interested|is\s+not\s+interested|doesn'?t\s+want|does\s+not\s+want|didn'?t\s+want|did\s+not\s+want|replied|responded)\b`;

/** "he" or "she" with NOTE_VERB, starting a sentence ("She wants to be left
 * alone") or after "since", "because" and the like. Not "no rush if she
 * wants to think it over" or "happy to answer anything she asked about": a
 * lead's spouse comes up in real nudges (review of 2026-11-13). */
const HE_SHE_NOTE = new RegExp(String.raw`(?:^|[.!?;:\n]\s*|\b(?:since|because|given\s+that|looks\s+like|seems\s+like|sounds\s+like)\s+)(?:he|she)${NOTE_VERB}`, "i");

/** A nudge that has already named the lead's partner ("did your wife get a
 * chance to look? She wanted to know about recycling"): then "she" is the
 * partner, not the lead (third review). */
const NAMES_PARTNER = /\byour\s+(?:wife|husband|spouse|partner|girlfriend|boyfriend|fianc[eé]e?|other\s+half|roommate|landlord|mom|dad|mother|father|son|daughter)\b/i;

/** Lets a nudge say "no reply needed" when it goes on to make that easy:
 * "if you're all set", "whenever you're ready". */
const UNLESS_EASY_OUT = String.raw`(?![^.!?\n]*\b(?:if|unless|but|though|whenever|when|anytime|any\s+time|once)\b)`;

// Each pattern is written to leave alone what the follow-up prompts ask
// for: "no reply needed if you're all set", "I won't keep bugging you",
// "I won't text you again, but...", "I apologize for the double text".
const NOT_A_MESSAGE_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /^\W*(?:N\/?A|none|nothing|no\s+(?:message|text|reply|response|follow[\s-]?up|nudge))\W*$/i, reason: "it is not a message" },
  { pattern: /^\s*[*_]*\s*[(\[][^()\[\]]*[)\]]\s*[*_]*\s*$/, reason: "it is a note in brackets" },
  { pattern: /\b(?:the|this)\s+(?:lead|contact|prospect|recipient)(?:'s)?\s+(?:has|had|is|was|already|asked|said|declined|explicitly|clearly|wants|wanted|requested|indicated|stated|opted|does|did|didn'?t|hasn'?t|isn'?t|never|replied|responded|seems|appears|might|may|told)\b/i, reason: "it talks about the lead instead of to them" },
  { pattern: /(?:^|[.!?;:\n]\s*)(?:lead|contact|prospect|recipient|customer)\s+(?:has|had|is|was|already|asked|said|declined|explicitly|clearly|wants|wanted|requested|indicated|stated|opted|does|did|didn'?t|hasn'?t|isn'?t|never|replied|responded|seems|appears|told|went)\b/i, reason: "it talks about the lead instead of to them" },
  { pattern: /\bthis\s+person\s+(?:has|had|is|was|already|asked|said|declined|wants|wanted|requested|opted|doesn'?t|does\s+not|isn'?t|told)\b/i, reason: "it talks about the lead instead of to them" },
  // "They already went with Republic", "They said they're all set" (third review).
  { pattern: /(?:^|[.!?;:\n]\s*)they(?:'re|'ve|\s+are|\s+have|\s+were)?\s+(?:already\s+|clearly\s+|just\s+|explicitly\s+)*(?:went\s+with|said|declined|asked|opted|signed\s+up|told\s+(?:us|me)|chose|picked|decided|replied|responded|confirmed|indicated|stated|requested|aren'?t\s+interested|are\s+not\s+interested|not\s+interested|don'?t\s+want|do\s+not\s+want|have\s+(?:service|a\s+(?:provider|hauler))|already\s+(?:have|has|signed|went|a\s+customer))\b/i, reason: "it talks about the lead instead of to them" },
  { pattern: /(?:^|[.!?;:\n]\s*)already\s+(?:a\s+)?customers?\b/i, reason: "it talks about the lead instead of to them" },
  { pattern: /\bI\s+(?:can(?:'|no)?t|cannot|am\s+not\s+able\s+to|'m\s+not\s+able\s+to|am\s+unable\s+to|'m\s+unable\s+to|shouldn'?t|should\s+not)\s+(?:write|draft|send|create|compose|generate|provide)\s+(?:this|that|a|the|another|any|such\s+a)?\s*(?:(?:final|follow[\s-]?up|warm|friendly|check[\s-]?in)\s+)*(?:message|follow[\s-]?up|text|nudge|reply|response|check[\s-]?in)\b/i, reason: "it refuses to write the message" },
  { pattern: /^\s*(?:I\s+apologi[sz]e,?\s+but\b|I'?m\s+sorry,?\s+but\s+I\b|I\s+apologi[sz]e\s+for\s+(?:any|the)\s+confusion)/i, reason: "it opens with a refusal" },
  { pattern: /\bas\s+an\s+AI\b/i, reason: "it says \"as an AI\"" },
  { pattern: new RegExp(String.raw`^\W*no\s+(?:further\s+|more\s+|additional\s+)?(?:reply|response|follow[\s-]?up|message|nudge|text)\s+(?:is\s+|should\s+be\s+)?(?:needed|necessary|required|warranted|appropriate|sent|here)\b${UNLESS_EASY_OUT}`, "i"), reason: "it says no message should be sent" },
  // "No further follow-up — they already declined." (third review)
  // Not "No more texts from me — take care!", a goodbye the bot really sent.
  { pattern: new RegExp(String.raw`^\W*no\s+(?:further|more|additional)\s+(?:replies|reply|responses?|follow[\s-]?ups?|messages?|nudges?|texts?|contact)\b(?!\s+from\s+(?:me|us)\b)${UNLESS_EASY_OUT}`, "i"), reason: "it says no message should be sent" },
  { pattern: /\b(?:should\s*n'?t|should\s+not|must\s+not|mustn'?t)\s+be\s+(?:contacted|texted|messaged|followed\s+up|sent\s+(?:a|any|another))\b/i, reason: "it says the lead shouldn't be contacted" },
  { pattern: /\b(?:we|I)\s+(?:should\s*n'?t|should\s+not|must\s+not|mustn'?t|shall\s+not)\s+(?:contact|text|message|send|reach\s+out|follow\s+up)\b/i, reason: "it says the lead shouldn't be contacted" },
  { pattern: /\b(?:inappropriate|not\s+appropriate|best\s+not|better\s+not|wise\s+not)\s+to\s+(?:send|text|contact|message|follow\s+up|reach\s+out|nudge)\b/i, reason: "it says the lead shouldn't be contacted" },
  { pattern: /\brecommend(?:ed|ing)?\s+(?:not|against)\s+(?:sending|texting|contacting|following|reaching|messaging|nudging)\b/i, reason: "it says the lead shouldn't be contacted" },
  { pattern: /\b(?:asked|requested|told\s+(?:us|me))\s+(?:us\s+|me\s+)?(?:to\s+be\s+(?:removed|taken\s+off|left\s+alone|unsubscribed)|to\s+stop(?:\s+(?:texting|messaging|contacting|reaching|receiving|getting|following))?\b(?!\s+(?:by|in|over))|to\s+opt\s+out|not\s+to\s+(?:be\s+)?(?:contact|contacted|text|texted|reach|reached))/i, reason: "it says the lead asked to stop" },
  { pattern: /\b(?:wants?|wanted)\s+(?:to\s+be\s+(?:left\s+alone|removed|taken\s+off)|off\s+(?:the|this|our|your)\s+(?:list|texts))\b/i, reason: "it says the lead asked to stop" },
  { pattern: /\bopted[\s-]out\b/i, reason: "it says the lead opted out" },
  // "no problem Adam, I've taken you off our list": a stop confirmation the
  // AI never recorded, not a nudge (third review).
  { pattern: /\b(?:taken|took|removed|remove|deleted|unsubscribed)\s+you\s+(?:off|from|out\s+of)\b|\byou(?:'ve|\s+have)\s+been\s+(?:removed|unsubscribed|taken\s+off)\b|\byou(?:'re|\s+are)\s+(?:now\s+)?(?:off\s+(?:our|the|my)\s+(?:text(?:ing)?\s+)?list|unsubscribed)\b/i, reason: "it confirms a stop request instead of nudging" },
  // The same in the present or future: "I'll take you off our list",
  // "removing you now", "we won't text you again", "you won't hear from us
  // again". Not an offer ("if you'd like I'll take you off", "just reply STOP
  // and I'll remove you") or a final nudge that leaves the door open ("I
  // won't text you again, but we're here whenever"). Found 2026-11-13
  // (fourth review): all 6 real stop confirmations the bot sent were worded
  // like this.
  { pattern: /(?<!\b(?:if|let\s+(?:me|us)\s+know|say|reply|text\s+(?:me|us|back)|want|(?<!\b(?:sounds|looks|seems|feels)\s+)like)\b[^.!?\n]*)(?:\b(?:I'?ll|I\s+will|we'?ll|we\s+will|I'?m|we'?re|going\s+to|gonna)\s+)?\b(?:(?:take|taking|drop|dropping)\s+you\s+(?:off\s+(?:of\s+)?(?:our|the|my|this|that|your)\b|from\b|out\s+of\b)|(?:remove|removing|delete|deleting|unsubscribe|unsubscribing)\s+(?:you|your\s+(?:number|info))\b|(?:removed|deleted)\s+your\s+(?:number|info)\b)|\byour\s+number\s+(?:has\s+been|is|was)\s+(?:removed|deleted)\b/i, reason: "it confirms a stop request instead of nudging" },
  // The bot's other real wordings: "I'll get you taken off the list", "I'll
  // make sure you're taken off the list", "We'll get this number taken off
  // the list", "just confirming you're removed from our list" (fifth review).
  // The next pattern also has "I'll make sure you're not contacted again",
  // "no further messages from us" and "we'll stop here" (sixth review); not
  // a sign-off such as "No more texts from me, take care!" (third review).
  { pattern: /(?<!\b(?:if|let\s+(?:me|us)\s+know|say|reply|text\s+(?:me|us|back)|want|(?<!\b(?:sounds|looks|seems|feels)\s+)like)\b[^.!?\n]*)\b(?:(?:get|getting|have|having)\s+(?:you|this\s+(?:phone\s+)?number|your\s+(?:phone\s+)?number)\s+(?:taken\s+off|removed)\b|make\s+sure\s+(?:you(?:'re|\s+are)|this\s+number\s+is|your\s+number\s+is)\s+(?:taken\s+off|removed|off\s+(?:our|the|my)\b)|(?:take|taking)\s+(?:your|this)\s+(?:phone\s+)?number\s+(?:off|out\s+of)\b|(?:take|taking)\s+you\s+off(?=\s*(?:[.!,;:—–]|now\b|right\s+away\b|$))|you(?:'re|\s+are)\s+(?:now\s+)?(?:removed|taken\s+off)\b)/i, reason: "it confirms a stop request instead of nudging" },
  { pattern: /(?:\b(?:won'?t|will\s+not|not\s+going\s+to)\s+(?:be\s+)?(?:(?:text|texting|message|messaging|contact|contacting|bother|bothering)\s+you|(?:reach|reaching)\s+out(?:\s+to\s+you)?)\s+(?:again|anymore|any\s+more|further)\b|\byou\s+won'?t\s+(?:be\s+hearing|hear)\s+from\s+(?:us|me)\b|\byou\s+won'?t\s+(?:be\s+)?(?:get|getting|receive|receiving)\s+any\s*more\s+(?:texts|messages)\b|\b(?:we'?ll|we\s+will|I'?ll|I\s+will)\s+stop\s+(?:texting|messaging|contacting|reaching\s+out|sending\s+(?:you\s+)?(?:texts|messages)|here)\b|\bmake\s+sure\s+(?:you(?:'re|\s+are)\s+not\s+(?:contacted|texted|messaged|bothered)|no\s+one\s+(?:reaches|texts|contacts|messages)\b)|\bno\s+(?:further|more)\s+(?:messages|texts)\s+from\s+us\b)(?![\s\S]*\b(?:but|if|unless|whenever|when\s+you(?:'re|\s+are)\s+ready|anytime|any\s+time|around|(?:I'?m|we'?re|I\s+am|we\s+are|still|always)\s+here|here\s+(?:if|whenever|for\s+you|anytime)|reach\s+out|feel\s+free|text\s+(?:us|me|back))\b)/i, reason: "it confirms a stop request instead of nudging" },
  // "Not sending a follow-up here", "won't be sending one", but not "I won't
  // be sending another text after this one, just reach out whenever".
  { pattern: /\b(?:not\s+sending|won'?t\s+be\s+sending|will\s+not\s+be\s+sending|skipping)\s+(?:a|any|this|the|another)?\s*(?:follow[\s-]?up|nudge|message|text|one)\b(?!\s+after\s+this)/i, reason: "it says no message should be sent" },
  // "Not sending anything here", "Already a customer, not texting." (third review)
  { pattern: /(?:^|[.!?;:,\n]\s*)(?:(?:I'?m|I\s+am|we'?re|we\s+are)\s+)?not\s+(?:sending|texting|messaging|nudging|following\s+up)(?:\s+(?:anything|them|him|her|this\s+(?:one|lead)))?\s*(?:here|now|today|again)?\s*(?:[.!,;:\n—–-]|$)/i, reason: "it says no message should be sent" },
  { pattern: new RegExp(String.raw`\bno\s+(?:nudge|follow[\s-]?up|message)\s+(?:(?:is\s+)?needed\s+)?(?:here|for\s+(?:this\s+one|now))\b${UNLESS_EASY_OUT}`, "i"), reason: "it says no message should be sent" },
  // "Out of service area, so no nudge.", "No nudge — they went with WM."
  // (fourth review: wrapped in the tags after the redraft request).
  { pattern: /\bno\s+(?:nudge|nudging|follow[\s-]?ups?)(?=\s*(?:[.!,;:(]|[—–]|-+\s|$))/i, reason: "it says no message should be sent" },
  // "Went with WM, no follow-up needed.", "Out of area. No nudge necessary."
  // Not "no follow-up needed on your end" or "...needed if you're all set".
  { pattern: new RegExp(String.raw`\bno\s+(?:nudge|nudging|follow[\s-]?ups?)\s+(?:is\s+|are\s+)?(?:needed|necessary|required|warranted)(?=\s*(?:[.!,;:(]|[—–]|-+\s|$))${UNLESS_EASY_OUT}`, "i"), reason: "it says no message should be sent" },
  { pattern: /\b(?:nothing\s+to\s+send|nothing\s+(?:should|will)\s+be\s+sent|no\s+(?:message|text|follow[\s-]?up)\s+(?:should|will)\s+(?:be\s+sent|go\s+out))\b/i, reason: "it says no message should be sent" },
  { pattern: /(?:^|[.!?]\s+)(?:do\s+not|don'?t)\s+send\b/i, reason: "it says no message should be sent" },
  // "I won't send a follow-up here", but not "I won't text you again, but..."
  { pattern: /^\W*(?:I\s+won'?t|I\s+will\s+not|I'?m\s+not\s+going\s+to|not\s+going\s+to)\s+(?:send|text|message|nudge|follow\s+up)\b(?!\s+(?:you|ya|u)\b)/i, reason: "it says no message should be sent" },
  { pattern: /^\W*(?:(?:I'?ll|I\s+will|I'?m\s+going\s+to|going\s+to)\s+)?hold(?:ing)?\s+off\b/i, reason: "it says no message should be sent" },
  { pattern: /\bleave\s+this\s+one\s+alone\b/i, reason: "it says no message should be sent" },
  { pattern: /\bconversation(?:'s|\s+has|\s+is|\s+was)?\s+(?:already\s+)?(?:reached\s+(?:a|its)\s+(?:natural\s+)?(?:close|end)|(?:closed|over|wrapped(?:\s+up)?|finished|ended))\b/i, reason: "it talks about the conversation instead of to the lead" },
  { pattern: /\b(?:system\s+prompt|instructions?\s+(?:say|tell|ask)|conversation\s+history|the\s+conversation\s+(?:above|shows))\b/i, reason: "it mentions its own instructions" },
  { pattern: /^\s*(?:here'?s|here\s+is)\s+(?:a|the|my|your)\s+(?:follow[\s-]?up|draft|message|text|nudge)\b/i, reason: "it introduces a draft instead of being the message" },
  { pattern: /\[(?:first\s*)?name\]|\[(?:lead|customer|contact)[^\]]*\]|\{\{[^}]*\}\}|<\/?text>/i, reason: "it has a placeholder or tag in it" },
];

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The words a check matched, for the note and the redraft request. */
function quoteMatch(words: string): string {
  const oneLine = words.replace(/^[\s.!?;:,]+/, "").replace(/\s+/g, " ").trim();
  return oneLine.length > 60 ? `${oneLine.slice(0, 60)}…` : oneLine;
}

/** A greeting just before the lead's name: "hey Adam", "hi Adam,". Then the
 * name is who the text is to, not who it is about. */
const GREETING_BEFORE = /(?:^|[^\p{L}])(?:hey|hi|hello|yo|hiya|howdy|morning|afternoon|evening|thanks|thank\s+you|sorry)[\s,!.]*$/iu;
/** "Adam just wanted to check back in": the writer wanting to, not the lead. */
const WRITER_WANTED = /^\s+(?:just\s+)?wanted\s+to\s+(?:check|double[\s-]?check|see|follow|reach|touch|circle|make|let|say|ask|send|give|share|remind|pass|confirm|offer|swing|drop|pop|loop|bump|update|find\s+out|know\s+(?:if|whether|when|what|how)|hear\s+(?:if|whether|back|how))\b/i;

/** True when the lead's first name is Skip, so "Skip, just checking in" is a
 * greeting, not a SKIP line (third review). */
function leadNamedSkip(leadFirstName?: string): boolean {
  return /^skip$/i.test((leadFirstName ?? "").trim());
}

/** Why a drafted follow-up must not be sent because it isn't a text to the
 * lead at all (a refusal, a note about them, a placeholder), or null if it
 * reads as a message. The reason quotes the words that matched, so the
 * redraft request and the office's note say what was wrong. Pass the lead's
 * first name, so a note like "Adam said he went with WM" is caught too, but
 * not "hey Adam just wanted to check back in" (review of 2026-11-13). */
export function notAMessageReason(draft: string, leadFirstName?: string): string | null {
  const text = draft.replace(/[‘’]/g, "'");
  if (!text.trim()) return "it is empty";
  const marker = findSkipMarker(text, leadFirstName);
  if (marker) return `it contains the SKIP marker ("${quoteMatch(text.slice(marker.index, marker.index + 20))}")`;
  for (const { pattern, reason } of NOT_A_MESSAGE_PATTERNS) {
    const match = pattern.exec(text);
    if (match) return `${reason} ("${quoteMatch(match[0])}")`;
  }
  const heShe = HE_SHE_NOTE.exec(text);
  if (heShe && !NAMES_PARTNER.test(text.slice(0, heShe.index))) return `it talks about the lead instead of to them ("${quoteMatch(heShe[0])}")`;
  const name = (leadFirstName ?? "").trim();
  if (name.length >= 2 && /^[\p{L}' -]+$/u.test(name)) {
    // As GHL has it, and capitalized ("ADAM" or "adam" is written "Adam").
    const spellings = new Set([name, name.toLowerCase()].map((n) => n.charAt(0).toUpperCase() + n.slice(1)));
    const verb = new RegExp(`^${NOTE_VERB}`, "u");
    for (const spelling of spellings) {
      for (const found of text.matchAll(new RegExp(String.raw`(?<![\p{L}\p{N}])${escapeRegExp(spelling)}(?![\p{L}\p{N}])`, "gu"))) {
        const after = text.slice(found.index! + found[0].length);
        const said = verb.exec(after);
        if (!said) continue;
        if (GREETING_BEFORE.test(text.slice(0, found.index))) continue;
        if (WRITER_WANTED.test(after)) continue;
        return `it talks about the lead instead of to them ("${quoteMatch(found[0] + said[0])}")`;
      }
    }
  }
  return null;
}

export type FollowUpSkipKind = "STOP" | "NO" | "CUSTOMER" | "OTHER";

/** "skip" first on a line (after any markup), followed by punctuation, the
 * end of the line, or a kind word: "SKIP: STOP", "SKIP STOP", "**SKIP**
 * STOP", "[SKIP] NO", "SKIP. STOP", "Skip - customer". Not "Skip the hassle
 * of hauling your own trash!". */
const SKIP_AT_LINE_START = /^[^\p{L}\p{N}\n]*(skip(?:ped|ping)?)(?![\p{L}\p{N}])(?=[^\p{L}\p{N}\n]*?(?:[^\s\p{L}\p{N}]|$)|\s+(?:stop|no|customer|other)(?![\p{L}\p{N}]))/iu;
/** SKIP in capitals anywhere: "Decision: SKIP: STOP ...". Not "No SKIP here"
 * or "Not a SKIP case", which say the opposite (third review). */
const SKIP_IN_CAPITALS = /(?<![\p{L}\p{N}])(?<!\b(?:no|not|not\s+a|don'?t|won'?t|isn'?t|wasn'?t|never|no\s+need\s+to)\s+)SKIP(?:PED|PING)?(?![\p{L}\p{N}])/iu;

/** Where the SKIP marker is: the first line that starts with one, or (unless
 * only line starts count) SKIP in capitals anywhere, whichever comes first.
 * For a lead named Skip, a line that starts "Skip," is a greeting: only SKIP
 * in capitals or "Skip:" counts there. */
function findSkipMarker(text: string, leadFirstName?: string, options: { lineStartOnly?: boolean } = {}): { index: number; end: number } | null {
  const namedSkip = leadNamedSkip(leadFirstName);
  let lineStart: { index: number; end: number } | null = null;
  let offset = 0;
  for (const line of text.split("\n")) {
    const m = SKIP_AT_LINE_START.exec(line);
    if (m) {
      const word = m[1]!;
      const at = m.index + m[0].lastIndexOf(word);
      // "Skip :)" is a greeting too (fourth review).
      const greeting = namedSkip && word !== word.toUpperCase() && !/^[*_\])]*\s*:(?![)(DPp3])/.test(line.slice(at + word.length));
      if (!greeting) {
        lineStart = { index: offset + at, end: offset + at + word.length };
        break;
      }
    }
    offset += line.length + 1;
  }
  if (options.lineStartOnly) return lineStart;
  const caps = new RegExp(SKIP_IN_CAPITALS.source, "giu");
  for (const m of text.matchAll(caps)) {
    // Case-sensitive in effect: the pattern's lookbehinds want any case, the word itself capitals.
    if (m[0] !== m[0].toUpperCase()) continue;
    const found = { index: m.index!, end: m.index! + m[0].length };
    return lineStart && lineStart.index <= found.index ? lineStart : found;
  }
  return lineStart;
}

/** After "opt out": nothing, or "of" texts or a list. Not "of recycling" or
 * "of service". */
const OUT_OF_TEXTS_ONLY = String.raw`(?!\s+of\s+(?!(?:(?:these|this|the|your|our|all|any|future|further|receiving|getting|being|more|automated|promotional|marketing|ai|follow[\s-]?up|text|sms|calls?\s+(?:and|or|&))\s+)*(?:texts?|texting|texted|text\s+messages?|messages?|messaging|messaged|msgs?|sms|list|mailing|marketing|contact|contacted|communications?|notifications?|alerts?|outreach|follow[\s-]?ups?(?=\s*(?:[^\s\w]|$)|\s+(?:texts?|messages?|msgs?|sms)\b)|drip)\b|(?:receiving|getting)\s+these(?!\s+\w)))`;

/** "go away for the winter", "go away on vacation": a trip, not a stop. */
const GO_AWAY_NOT_TRIP = String.raw`(?!\s+(?:for|on|every|each|during|over|in|to|this|next|until|till|after|before|with|from|at|when|while)\b)`;

/** Stop wording in a SKIP reason, whoever is speaking: "stop texting",
 * "removed from the list", "left alone", "no more texts", "opted out". The
 * writer's own instructions use the same words ("no further contact needed",
 * "take them off the follow-up list"), so for a SKIP labelled NO, CUSTOMER or
 * OTHER they count only where the reason says the lead said or asked it
 * (see leadAskedToStop). */
const STOP_WORDING = new RegExp(
  [
    String.raw`\bstop\s+(?:all\s+)?(?:texting|texts|messaging|messages|contacting|contact|reaching\s+out)\b`,
    String.raw`\b(?:be|being|get|getting)\s+(?:removed|taken\s+off|left\s+alone|unsubscribed|opted\s+out)\b`,
    String.raw`\bremov(?:e|ed|al|ing)\b[^.!?\n]{0,30}\b(?:list|texts?|texting|messages?|contacts?|database|system|chain|thread)\b`,
    String.raw`\btake\s+(?:them|him|her|me|us)\s+off\b`,
    String.raw`\boff\s+(?:the|your|our|this|that|their|his|her)\s+(?:text\s+|texting\s+|contact\s+|mailing\s+)?list\b`,
    String.raw`\bunsu(?:bs?|s)c?ri\w*`,
    String.raw`\bopt(?:ed|s|ing)?[\s-]?out\b${OUT_OF_TEXTS_ONLY}`,
    String.raw`\b(?:left|leave\s+(?:them|him|her|me|us))\s+alone\b`,
    String.raw`\bno\s+(?:more|further)\s+(?:texts?|texting|messages?|messaging|contact|contacting)\b`,
    String.raw`\b(?:asked|asks|wants?|wanted|said|says|told\s+(?:us|me)|requested|prefers?)\s+(?:us\s+|me\s+)?(?:not|never)\s+to\s+(?:be\s+)?(?:texted|text|contacted|contact|messaged|message|reached)\b`,
    String.raw`\bnot\s+to\s+be\s+(?:texted|contacted|messaged|reached)\b`,
    String.raw`\b(?:don'?t|do\s+not|dont)\s+(?:text|contact|message)\s+(?:me|them|him|her|us)\s+(?:again|anymore|any\s+more)\b`,
    String.raw`\b(?:don'?t|doesn'?t|do\s+not|does\s+not|didn'?t|did\s+not)\s+want\s+(?:any\s*more\s+|any\s+|more\s+|further\s+|our\s+|your\s+|these\s+|the\s+)?(?:texts?|messages?|contact)\b`,
    String.raw`\bcease\b`,
    String.raw`\bharass\w*`,
    String.raw`\b(?:lose|erase|delete)\s+(?:my|this|the|their|his|her)\s+(?:number|info|information|contact)\b`,
    // Fourth review: "asked to be put on the do not call list", "told us to
    // never contact them again", "asked us to remove their number",
    // "requested removal", "DNC", "buzz off".
    String.raw`\bdo[\s-]not[\s-](?:contact|text)\b|\bdo[\s-]not[\s-]call\s*(?:[\s-]+(?:list|registry)\b|(?:\/|&|\s+or\s+|\s+and\s+|\s+n\s+)\s*(?:text|txt|message))|\bDNC\b`,
    String.raw`\bnot\s+to\s+(?:reach\s+out\b|(?:receive|get)\s+(?:(?:any\s*more|any|more|further|these|those|our|your|the|promotional|marketing|automated|text|sms)\s+){0,3}(?:texts?|texted|messages?|sms|contact|communications?|calls?\s+(?:or|and|&)\s+texts?)\b)`,
    String.raw`(?<!\b(?:they|he|she|lead)(?:'ll|'d)?\s+(?:will\s+|would\s+)?)\b(?:never|not)\s+(?:to\s+)?(?:contact|text|message)\s+(?:them|him|her|us|me)\b`,
    String.raw`\bremov(?:e|al|ing)\s+(?:of\s+)?(?:their|his|her|the|my|this|that)\s+(?:number|phone|info|information|details|contact)\b`,
    String.raw`\b(?:requested|requesting|request|asked\s+for)\s+(?:removal\b(?!\s+of\b)|to\s+be\s+removed\b|an?\s+opt[\s-]?out\b)|\bremoval\s+request\b`,
    String.raw`\bbuzz\s+off\b|\bknock\s+it\s+off\b(?!\s+(?:the|my|our|their|of)\b)`,
    String.raw`\bquit\s+(?:bugging|texting|messaging|contacting|bothering)\b`,
    String.raw`\btake\s+(?:me|them|him|her)\s+out\s+of\b`,
    String.raw`\bout\s+of\s+(?:your|the|our)\s+(?:system|database|list)\b`,
    String.raw`\bgo\s+away\b${GO_AWAY_NOT_TRIP}`,
    String.raw`\brefrain\s+from\b`,
    String.raw`\b(?:rather\s+not|don'?t\s+want\s+to)\s+(?:hear\s+from|be\s+(?:texted|contacted|messaged))\b`,
    String.raw`\benough\s+(?:with\s+)?(?:the|these|your)\s+(?:texts|messages)\b`,
  ].join("|"),
  "i"
);

/** A plain "stop" ("lead said stop", "replied 'stop it'"), not "stop by",
 * "stop in", "stop paying", "stop the drip" or "stop texting them". Sixth
 * review: nor "stop" before doing something else ("were asked to stop
 * putting yard waste in the trash", "asked us to stop charging them twice")
 * or ending a service ("will stop my other service in September"). */
const BARE_STOP = /(?<![\p{L}\p{N}])stop(?![\p{L}\p{N}])(?!\s+(?:by|in|at|over|on|for|here|there|paying|payment|the\s+(?:drip|nudges?|follow[\s-]?ups?|service|pickups?|truck|sequence)|nudg\w*|follow\w*|the\s+outreach|(?:texting|messaging|contacting|sending)\s+(?:them|him|her|this)|(?:my|our|their|his|her)\s+(?:[\w'-]+\s+)?(?:services?|accounts?|subscriptions?|plans?|contracts?|pickups?)\b|(?!(?:texting|txting|messaging|contacting|calling|sending|reaching|bugging|bothering|spamming|harassing|emailing|hounding|pestering|nagging|soliciting|blowing|checking|wasting|asking|pushing|trying|selling|marketing|advertising|pinging|hitting|blasting|responding|replying)\b)(?!\w*thing\b)\w{2,}ing\b))/iu;

/** The lead's own words, as the writer may repeat them: first person ("take
 * me off", "lose my number", "stop texting me") or said to us ("go away",
 * "out of your system"). The writer's own instructions say "them" instead. */
const LEAD_VOICE_STOP = new RegExp(
  [
    String.raw`\b(?:take|get|remove|delete|drop|erase|scratch)\s+me\s+(?:off|out|from)\b`,
    String.raw`\bremove\s+me\b`,
    String.raw`\b(?:lose|erase|delete|remove|forget|toss)\s+my\s+(?:number|info|information|contact|details|phone|#)\b`,
    String.raw`\bleave\s+me\s+alone\b`,
    String.raw`\b(?:stop|quit|cease)\s+(?:texting|messaging|contacting|bugging|bothering|calling|harassing|spamming|pestering)\s+me\b`,
    String.raw`\b(?:don'?t|do\s+not|dont|never)\s+(?:ever\s+)?(?:text|contact|message|bother)\s+me\b${NOT_ABOUT_WHEN}`,
    String.raw`\bquit\s+(?:bugging|bothering|pestering)\b`,
    String.raw`\bgo\s+away\b${GO_AWAY_NOT_TRIP}`,
    String.raw`(?<!\b(?:is|are|was|were|be|been|have|has|had)\s+)\benough\s+already\b|\bbuzz\s+off\b|\bknock\s+it\s+off\b(?!\s+(?:the|my|our|their|of)\b)`,
    String.raw`\benough\s+(?:with\s+)?(?:the|these|your|all\s+(?:the|these))\s+(?:texts|messages)\b`,
    String.raw`\b(?:I'?d|I\s+would|we'?d|we\s+would)\s+rather\s+not\s+(?:hear|be\s+(?:texted|contacted|messaged))\b`,
    String.raw`\b(?:I|we)\s+(?:don'?t|do\s+not)\s+want\s+(?:any\s*more\s+|any\s+|more\s+|your\s+|these\s+|the\s+)?(?:texts|messages|contact)\b`,
    String.raw`\bout\s+of\s+your\s+(?:system|database|list|contacts)\b`,
    String.raw`\bunsubscribe\s+me\b`,
    String.raw`\brefrain\s+from\s+(?:texting|contacting|messaging)\s+me\b`,
  ].join("|"),
  "i"
);

/** Something the lead did: "lead opted out", "they unsubscribed", "opted
 * out of texts". Not "opted out of recycling" or "opting out of service":
 * after "of", only texts or a list count (fourth review). */
const LEAD_OPTED_OUT = new RegExp(String.raw`\b(?:opted|opting)[\s-]?out\b${OUT_OF_TEXTS_ONLY}|\bunsubscribed\b(?!\s+from\s+(?:their|the|his|her)\s+(?!(?:(?:sms|text|texting|marketing|automated|promotional|follow[\s-]?up|ai|mailing|contact)\s+)*(?:texts?|messages?|list|follow[\s-]?ups?(?=\s*(?:[^\s\w]|$)|\s+(?:texts?|messages?|msgs?|sms)\b)|drip|sms|alerts?|notifications?|campaign)\b)\w+)`, "i");

/** The writer reporting what the lead said or wants ("asked", "said", "told
 * us", "wants"), as against its own "no further contact needed". */
const LEAD_SAID = /\b(?:(?:we\s+were|we'?ve\s+been|we\s+have\s+been|i\s+was|i'?ve\s+been|i\s+have\s+been)\s+told|asked|asks|asking|requested|requests|requesting|said|says|saying|told\s+(?:us|me|you)|tells\s+(?:us|me)|wants?|wanted|wanting|texted|replied|replies|responded|wrote|writes|demanded|insisted|begged|made\s+(?:it\s+)?clear|indicated|stated|let\s+(?:us|me)\s+know|would\s+(?:like|rather|prefer)|prefers?|preferred)\b/i;

/** A pause, not a stop for good: "not until after the holidays", "text back
 * next month", "for now", "not during dinner" or "during their shift". Not
 * "during the conversation" or "during our last exchange": that is when they
 * asked, not a time to keep clear of (sixth review). */
const ONLY_FOR_NOW = /\b(?:until|till|til|for\s+now|right\s+now|at\s+the\s+moment|for\s+a\s+(?:while|bit|few\s+\w+|couple\s+\w+)|this\s+(?:week|month)|next\s+(?:week|month|year|spring|summer|fall|winter)|after\s+the\s+holidays?|later|before\s+(?:spring|summer|fall|autumn|winter|the\s+(?:holidays?|new\s+year|move)|january|february|march|april|may|june|july|august|september|october|november|december)|while\s+(?:they'?re|they\s+are|he'?s|she'?s|in\s+the|at\s+the|away)|during\s+(?!(?:\w+\s+){0,2}(?:conversation|convo|call|chat|exchange|reply|replies|response|text|message|thread)s?\b)(?:the\s+)?\w+(?:\s+season)?|over\s+the\s+(?:holidays?|winter|summer|weekend)|for\s+the\s+(?:winter|summer|season|holidays?))\b/i;

/** The writer's own instruction to us: "no further contact needed", "don't
 * text them again", "take them off the follow-up list". */
const WRITER_INSTRUCTION = /\b(?:needed|necessary|required|warranted|appropriate|advised|recommended)\b|\b(?:them|him|her)\b|\bthis\s+(?:lead|person|one|contact)\b|\bthe\s+lead\b|\b(?:should|would|could|best|better|we|our|another)\b|\bgo\s+out\b/i;

/** The writer saying what the lead did NOT do: "never asked us to stop",
 * "didn't ask to be removed", "not a stop request", "no opt-out request".
 * Found 2026-11-13 (fourth review): these were read as stop requests. */
const NEGATED_REPORT = /\b(?:not|never|didn'?t|did\s+not|hasn'?t|has\s+not|haven'?t|have\s+not|wasn'?t|was\s+not|isn'?t|is\s+not|without)\s+(?:(?:us|me|a|an|any|actually|explicitly|really|ever|yet|been|once)\s+)*(?:stop\b|request\w*|ask\w*|said\b|say\w*|opt\w*|unsubscrib\w*|told\b|tell\w*)|\bno\s+(?:stop|opt[\s-]?out|unsubscribe|removal)\s+request\b/i;

/** A negation after the words it covers: "opt-out not requested", "an
 * opt-out was not requested", "stop wasn't requested" (sixth review). */
const NEGATED_BEFORE = String.raw`\b(?:(?!(?:and|but|or|so|said|says|asked|asks|told|tells|wants?|wanted|requested)\b)[\w'\/-]+\s+){1,4}?(?:(?:was|were|is|are|has\s+been|have\s+been|been)\s+)?(?:not|never|wasn'?t|weren'?t|isn'?t|aren'?t|hasn'?t\s+been|haven'?t\s+been)\s+(?:(?:been|ever|once|actually|explicitly|really|yet)\s+)*(?:requested|asked\s+for)\b(?!\s+(?!(?:and|but|or|so|just|by|yet|either)\b)[\w'])`;

/** What "and" joins to a negation with no verb of its own ("didn't ask to
 * be removed and unsubscribed", "has not unsubscribed and opted out"), or as
 * another denial ("and doesn't want to be removed", "and said nothing about
 * unsubscribing", "and no opt-out"): still covered by it (sixth review). */
const STILL_NEGATED = String.raw`(?:\band\s+(?:(?:to\s+)?(?:be\s+|being\s+|get\s+|getting\s+)?(?:unsubscrib\w*|opt(?:ed|ing|s)?[\s-]?out|remov(?:e|ed|ing)|taken\s+off)(?!\s+(?:me|us)\b)|(?:doesn'?t|does\s+not|don'?t|do\s+not)\s+want\s+to\s+(?:be\s+)?(?:removed|unsubscrib\w*|opt\w*|taken\s+off)|(?:said|says|mentioned)\s+nothing\s+about|no\s+(?:opt[\s-]?out|unsubscrib\w*|removal)\b)[\s\S]*?(?=\b(?:and|but)\b|$))*`;

/** The clause without what a NEGATED_REPORT covers, which runs to the next
 * "and" or "but": "never requested a quote and wants to be removed" keeps
 * "and wants to be removed"; "asked to be removed without saying why" keeps
 * "asked to be removed"; "didn't ask us to stop texting" keeps nothing. */
function withoutNegated(clause: string): string {
  return clause
    .replace(new RegExp(NEGATED_BEFORE, "gi"), " ")
    .replace(new RegExp(String.raw`(?:${NEGATED_REPORT.source})[\s\S]*?(?=\b(?:and|but)\b|$)${STILL_NEGATED}`, "gi"), " ");
}

/** "stop" that isn't a request: "the driver didn't stop", "skipped their
 * stop" (fourth review), "it won't stop leaking", "put a stop to the late
 * fees" (sixth review). "The texts won't stop" and "put a stop to the texts"
 * or "to these" are requests. */
const STOP_NOT_REQUEST = /\b(?:bus|pickup|pick-up|last|first|next|truck|route|their|his|her|the|my|your|our)\s+stop\b|\ba\s+stop\b(?!\s+to\s+(?:[\w']+\s+){0,3}?(?:texts?|texting|txts?|messages?|messaging|msgs?|sms|calls?|calling|contact(?:ing)?|outreach|spam\w*)\b|\s+to\s+(?:all\s+(?:of\s+)?)?these\b(?!\s*\w))|(?<!\b(?:texts?|messages?|calls?)\s+)\b(?:didn'?t|did\s+not|doesn'?t|don'?t|won'?t|can'?t|cannot|never|not|wouldn'?t|couldn'?t)\s+stop\b/i;

/** Quoted words ("...", “...”, or '...' around a phrase). */
function quotedParts(text: string): string[] {
  const parts: string[] = [];
  for (const m of text.matchAll(/["“]([^"“”]{1,200})["”]|(?<![\p{L}\p{N}])'([^']{1,120})'(?![\p{L}\p{N}])/gu)) parts.push((m[1] ?? m[2])!);
  return parts;
}

/** A SKIP reason split into sentences, and each sentence into the parts
 * between commas and dashes. */
function reasonSentences(reason: string): string[][] {
  return reason
    .split(/[.!?;\n]+/)
    .map((sentence) => sentence.split(/,|\s[-–—]+\s|[–—]/).map((c) => c.trim()).filter(Boolean))
    .filter((clauses) => clauses.length > 0);
}

/** True when a SKIP reason says the lead asked to stop: their own words
 * (quoted, or first person), something they did ("opted out"), or the writer
 * reporting it ("lead asked to be removed", "they said stop"). Not the
 * writer's own instruction ("already signed up, no further contact needed",
 * "leave them alone for now"), and not a pause ("asked not to be texted
 * until after the holidays"). Found 2026-11-13 (third review): any stop
 * wording counted, so "SKIP: CUSTOMER already signed up yesterday, no further
 * contact needed" switched on do-not-disturb for a new customer. */
function leadAskedToStop(reason: string): boolean {
  for (const quoted of quotedParts(reason)) {
    if (!ONLY_FOR_NOW.test(quoted) && (stopRequestReason(quoted) || LEAD_VOICE_STOP.test(quoted))) return true;
  }
  for (const clauses of reasonSentences(reason)) {
    // What follows "said" in the same sentence is what they said ("said no,
    // stop texting"), unless it reads as the writer's own instruction ("said
    // they signed up, no further contact needed").
    let reported = false;
    for (const whole of clauses) {
      const clause = withoutNegated(whole);
      const saidHere = LEAD_SAID.test(clause);
      // "never asked for this, Stop": what follows is still their words.
      const reportsHere = saidHere || LEAD_SAID.test(whole);
      if (ONLY_FOR_NOW.test(whole)) {
        reported ||= reportsHere;
        continue;
      }
      if (LEAD_VOICE_STOP.test(clause) || LEAD_OPTED_OUT.test(clause)) return true;
      const stopWords = STOP_WORDING.test(clause) || (BARE_STOP.test(clause) && !STOP_NOT_REQUEST.test(clause));
      if (stopWords && (saidHere || (reported && !WRITER_INSTRUCTION.test(clause)))) return true;
      reported ||= reportsHere;
    }
  }
  return false;
}

/** For a SKIP that names no kind: any stop wording that isn't the writer's
 * own instruction or a pause ("SKIP: no more texts, lead said enough",
 * "SKIP: UNSUBSCRIBE", "SKIP: lead said stop"). */
function kindlessSkipSaysStop(reason: string): boolean {
  if (leadAskedToStop(reason)) return true;
  return reasonSentences(reason)
    .flat()
    .filter((whole) => !ONLY_FOR_NOW.test(whole))
    .map(withoutNegated)
    .some(
      (clause) =>
        !WRITER_INSTRUCTION.test(clause) &&
        (STOP_WORDING.test(clause) || (BARE_STOP.test(clause) && !STOP_NOT_REQUEST.test(clause)))
    );
}

/** The follow-up prompts let the writer answer "SKIP: STOP <why>" (the lead
 * asked to stop), "SKIP: NO <why>" (they clearly said no), "SKIP: CUSTOMER
 * <why>" (they already have service or signed up elsewhere) or "SKIP: OTHER
 * <why>" instead of a message. Found anywhere in the answer, in any case,
 * with any markup or punctuation after SKIP (see findSkipMarker); with
 * lineStartOnly, only a line that starts with SKIP counts. The kind and the
 * reason are read from the rest of that line (or the next line when that is
 * empty). A kind is read as written, except a lowercase "no" followed by more
 * words ("SKIP: no more texts, ...") is part of the reason. A reason that
 * says the lead asked to stop makes it STOP (see leadAskedToStop): found
 * 2026-11-13 (second review), "SKIP: lead asked to be removed from the list"
 * only ended the drip, with no opt-out and no do-not-disturb. Null when there
 * is no SKIP. */
export function parseFollowUpSkip(
  draft: string,
  leadFirstName?: string,
  options: { lineStartOnly?: boolean } = {}
): { kind: FollowUpSkipKind; reason: string } | null {
  // A SKIP line put between the message tags still counts, on a line of its own.
  const text = draft.replace(/[‘’]/g, "'").replace(/<\/?text>/gi, "\n");
  const marker = findSkipMarker(text, leadFirstName, options);
  if (!marker) return null;
  const after = text.slice(marker.end);
  const lineEnd = after.indexOf("\n");
  let line = (lineEnd === -1 ? after : after.slice(0, lineEnd)).replace(/^[^\p{L}\p{N}]*/u, "");
  let named: FollowUpSkipKind | undefined;
  const kind = /^(stop|no|customer|other)(?![\p{L}\p{N}])/iu.exec(line);
  if (kind) {
    const word = kind[1]!;
    const rest = line.slice(word.length);
    // "no" counts in capitals ("SKIP: NO went with WM") or followed by
    // punctuation or the end of the line ("SKIP: no - went with WM"), not
    // "SKIP: no more texts". "stop" counts unless it is part of what the
    // writer says to do: "SKIP: stop the drip, they're a customer".
    const lower = word.toLowerCase();
    const isKind =
      lower === "no" ? word === "NO" || /^\s*(?:[^\s\p{L}\p{N}]|$)/u.test(rest) : lower === "stop" ? word === "STOP" || BARE_STOP.test(line) : true;
    if (isKind) {
      named = word.toUpperCase() as FollowUpSkipKind;
      line = rest.replace(/^[^\p{L}\p{N}]*/u, "");
    }
  }
  let reason = line;
  if (!reason.trim() && lineEnd !== -1) {
    reason = after.slice(lineEnd + 1).split("\n").map((l) => l.trim()).find((l) => /[\p{L}\p{N}]/u.test(l)) ?? "";
  }
  reason = reason.replace(/[*_`\])]+\s*$/u, "").trim();
  const isStop = named === "STOP" || (named ? leadAskedToStop(reason) : kindlessSkipSaysStop(reason));
  return { kind: isStop ? "STOP" : (named ?? "OTHER"), reason: reason.slice(0, 300) };
}

/** What the follow-up writer answered, read the one way it may be sent: the
 * message between <text> and </text>, with nothing but markup outside the
 * tags, or a SKIP line. Anything else is not a message, so it is never
 * texted (it gets one redraft in mts-sync/sendFollowUps.ts). */
export type FollowUpDraft =
  | { kind: "skip"; skip: { kind: FollowUpSkipKind; reason: string } }
  | { kind: "message"; text: string }
  | { kind: "not_a_message"; why: string };

const TEXT_TAGS = /<text>([\s\S]*?)<\/text>/gi;

export function readFollowUpDraft(draft: string, leadFirstName?: string): FollowUpDraft {
  const parts = [...draft.matchAll(TEXT_TAGS)];
  if (parts.length === 0) {
    const skip = parseFollowUpSkip(draft, leadFirstName);
    if (skip) return { kind: "skip", skip };
    // Say what else was wrong, so the redraft request can (third review).
    const also = notAMessageReason(draft, leadFirstName);
    return { kind: "not_a_message", why: `it isn't between <text> and </text>${also ? `, and ${also}` : ""}` };
  }
  // A SKIP: STOP line outside the tags wins over the message in them: the
  // writer read the conversation as a request to stop.
  const outside = draft.replace(TEXT_TAGS, "\n").replace(/```[\w-]*/g, " ");
  const skipOutside = parseFollowUpSkip(outside, leadFirstName, { lineStartOnly: true });
  if (skipOutside?.kind === "STOP") return { kind: "skip", skip: skipOutside };
  if (parts.length > 1) return { kind: "not_a_message", why: "it has more than one <text> part" };
  let text = parts[0]![1]!.trim();
  if (/^["“][\s\S]*["”]$/.test(text)) text = text.slice(1, -1).trim();
  // A SKIP: STOP line anywhere between the tags wins too: "<text>Based on the
  // conversation:\nSKIP: STOP said knock it off</text>" (fourth review).
  const skipInside = parseFollowUpSkip(text, leadFirstName, { lineStartOnly: true });
  if (skipInside?.kind === "STOP") return { kind: "skip", skip: skipInside };
  // All that is between the tags is a SKIP line.
  if (findSkipMarker(text.split("\n")[0] ?? "", leadFirstName, { lineStartOnly: true })) {
    const skip = parseFollowUpSkip(text, leadFirstName, { lineStartOnly: true });
    if (skip) return { kind: "skip", skip };
  }
  // A code fence ("```" or "```xml") around the tags is markup. Any other
  // words outside them get a redraft, a SKIP line next to a message included,
  // and so do "No SKIP here" and "Not a SKIP case" (third review).
  if (/[\p{L}\p{N}]/u.test(outside)) return { kind: "not_a_message", why: `it has words outside the <text> tags ("${quoteMatch(outside)}")` };
  const why = notAMessageReason(text, leadFirstName);
  return why ? { kind: "not_a_message", why } : { kind: "message", text };
}

// ---------------------------------------------------------------------------
// Lead age
// ---------------------------------------------------------------------------

/** No first text or follow-up goes to a lead whose contact was created more
 * than this many days ago. The first text always goes out within a week of
 * the contact being created (checked 2026-11-12 over about 7,150 leads), and
 * the second follow-up a week after that, so 30 days leaves room for every
 * normal case. Found 2026-11-12 (evaluation): the follow-up job's queue held
 * about 3,150 leads, most of them months old, and nudged people 76 to 78
 * days after they asked to be removed; with this limit the queue is about
 * 150. */
export const MAX_LEAD_AGE_DAYS = 30;

/** True when the contact is too old to text first, or has no readable
 * creation date (GHL always sends one, so a missing date means something is
 * wrong and the safe answer is not to text). */
export function isLeadTooOld(contact: Record<string, any>, now: Date = new Date()): boolean {
  const added = Date.parse(contact?.dateAdded ?? "");
  if (Number.isNaN(added)) return true;
  return now.getTime() - added > MAX_LEAD_AGE_DAYS * 24 * 60 * 60 * 1000;
}

/** The escalation reason for a possible crisis: a stop request with it gets
 * no automatic confirmation text, only a person. */
export const CRISIS_REASON = "possible crisis situation";

// Deliberately broad / high-recall. False positives just mean a human looks at
// it — that's cheap. False negatives mean the bot improvises on something it
// shouldn't. Bias toward escalating.
const ESCALATION_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  // First, so a text that also has other words ("I need to talk to someone,
  // I want to kill myself", "I'm in the emergency room after...") is read as
  // a crisis. Found 2026-11-13 (second review): only the first matching
  // reason counted, and those got the automatic confirmation text.
  // Found 2026-11-13 (third review): everyday wordings ("I don't want to
  // live anymore", "better off without me", "end it all") were missed. Not
  // "end it all with Republic", "can't go on Tuesday" or "take my pills".
  // Fourth review: their everyday spellings too ("don't wanna live", "ending
  // it all", "I can't go on."), and with an iPhone apostrophe (see
  // escalationReasons).
  {
    pattern: new RegExp(
      [
        String.raw`\b(?:suicid\w*|self.?harm\w*|kill(?:ing)? myself|hurt(?:ing)? myself|harm(?:ing)? myself|end(?:ing)? my (?:own )?life|take my (?:own )?life|want(?:ed)? to die|wanna die|overdos\w*)\b`,
        String.raw`\b(?:hang(?:ing)?|shoot(?:ing)?|drown(?:ing)?)\s+myself\b|\bslit(?:ting)?\s+my\s+wrists?\b|\bjump(?:ing)?\s+off\s+(?:a|the)\s+(?:bridge|building|roof|cliff)\b`,
        String.raw`\b(?:don'?t|dont|do\s+not|doesn'?t|no\s+longer)\s+(?:want\s+to|wanna)\s+(?:live|be\s+alive|exist|wake\s+up(?!\s+(?:at|early|before|so|that|in\s+the|for|to|every|on|and)\b)|be\s+here\s+any\s*more)\b`,
        String.raw`\b(?:wish|want)\s+(?:i\s+(?:was|were)|to\s+be)\s+dead\b|\bbetter\s+off\s+(?:dead|without\s+me|if\s+i\s+(?:was|were)n?'?t?\s*(?:dead|gone|here|around))\b`,
        String.raw`\bend(?:ing)?\s+it\s+all\b(?!\s+(?:with|for)\b)|\bno\s+(?:reason|point)\s+(?:to|in)\s+(?:live|living|be\s+alive|go(?:ing)?\s+on|keep\s+(?:going|living))\b|\bdone\s+with\s+(?:life|living)\b|\b(?:i'?m|im|i\s+am)\s+(?:so\s+)?done\s+living\b(?!\s+(?:in|at|with|there|here|next|by|near|on)\b)|\brather\s+be\s+dead\b`,
        String.raw`\bcan'?t\s+go\s+on\s+(?:any\s*more|like\s+this|living)\b|\bcan'?t\s+go\s+on(?=\s*(?:[.!]|$))|\b(?:not\s+going\s+to|won'?t|gonna\s+not)\s+be\s+(?:here|around)\s+much\s+longer\b`,
        String.raw`\b(?:kms|unalive)\b|\b(?:take|swallow(?:ed)?|took)\s+all\s+(?:my|the|of\s+my|these)\s+(?:pills|meds|medication)\b`,
      ].join("|"),
      "i"
    ),
    reason: CRISIS_REASON,
  },
  // Fourth review: "cease and desist", "TCPA", "FCC", "legal action" and the
  // do-not-call list were missed, so a stop text with them reached nobody.
  { pattern: /\b(attorney|lawyer|lawsuit|sue|suing|bbb|better business bureau|regulator|complain\w*|cease\s*(?:(?:and|&|n)\s*|-and-)desist|tcpa|fcc|ftc|telephone consumer protection|federal (?:trade|communications) commission|legal action|(?:do[\s-]not[\s-]call|dnc)\s+(?:list|registry))\b/i, reason: "legal/regulatory mention" },
  { pattern: /\b(refunds?|overcharg\w*|billing error|wrong charge|disput\w*)\b/i, reason: "billing dispute" },
  { pattern: /\b(real person|human|talk to someone|speak to someone)\b/i, reason: "explicit request for a human" },
  // Root-caused live 2026-08-03 (Carter Bodily): a bare "manager"/"supervisor"
  // match caught "check with the property manager" — the lead's OWN
  // apartment complex contact, not a request to escalate to one of ours.
  // Requires an actual "talk/speak to/with" request immediately before the
  // word, so it still catches "can I talk to a manager" (see safety.test.ts)
  // without firing on every unrelated mention of "manager."
  { pattern: /\b(talk|speak)\s+(to|with)\s+(a|the|your)?\s*(manager|supervisor)\b/i, reason: "explicit request for a human" },
  { pattern: /\b(spill\w*|leak\w*|injur\w*|hurt|hazard\w*|fire|gas leak|emergency)\b/i, reason: "safety/property-damage report" },
  { pattern: /\b(wrong number|who is this|do i know you)\b/i, reason: "possible wrong number" },
  { pattern: /\b(credit card|debit card|card number|cvv|ssn|social security)\b/i, reason: "payment/PII detail sent over SMS" },
  { pattern: /\b(missed pickup|didn't pick up|didnt pick up|wasn't picked up|wasnt picked up|late pickup)\b/i, reason: "existing-customer service issue" },
  { pattern: /\b(commercial|multi.?unit|hoa|dumpster rental)\b/i, reason: "outside standard residential script" },
  { pattern: /\bcancel (my )?(service|account|subscription|contract)\b/i, reason: "service cancellation request" },
];

// True when it's an OK hour to send a text we started (not a quiet hour).
// Gates mts-sync/sendOutreach.ts's cold open and mts-sync/sendFollowUps.ts's
// drip follow-ups. Deliberately NOT used for reactive replies (see
// evaluateInbound below) — per Thomas's call 2026-07-29: if someone texts
// us, they're already awake and engaged, so holding a reply in an ongoing
// conversation they started serves no one.
// Window: 8am-9pm local time, the TCPA limit for marketing texts (47 CFR
// 64.1200(c)(1)). Tightened 2026-10-12 from 8am-10pm (Thomas, 2026-08-07),
// which ran an hour past the legal limit.
export function isWithinQuietHours(now: Date, timezone: string): boolean {
  const hour = Number(
    new Intl.DateTimeFormat("en-US", { hour: "numeric", hour12: false, timeZone: timezone }).format(now)
  );
  return hour >= 8 && hour < 21;
}

/** Why a stop request still needs a person to read it: every reason the
 * same text has, a possible crisis first, then a legal threat, a billing
 * dispute or another ESCALATION_PATTERNS reason. Empty when there's none.
 * Not a wrong number or a commercial account: once texts stop, those need
 * nothing more. Found 2026-11-13 (review): stop requests are checked before
 * the escalation patterns, so "Stop texting me or I'll sue" was recorded as a
 * stop and marked read, and nobody saw the threat. All of them, not only the
 * first (second review): the crisis rule only worked when no other reason
 * matched first. */
export function stopNeedsPersonReasons(messageBody: string): string[] {
  return escalationReasons(messageBody).filter((reason) => reason !== "possible wrong number" && reason !== "outside standard residential script");
}

/** iPhones type ’ for an apostrophe. Found 2026-11-13 (fourth review): "I
 * don’t want to live anymore" wasn't read as a crisis. */
function straightApostrophes(messageBody: string): string {
  return messageBody.replace(/[‘’ʼ`´]/g, "'");
}

/** Every ESCALATION_PATTERNS reason this text has, a possible crisis first. */
export function escalationReasons(messageBody: string): string[] {
  const text = straightApostrophes(messageBody);
  const reasons: string[] = [];
  for (const { pattern, reason } of ESCALATION_PATTERNS) {
    if (pattern.test(text) && !reasons.includes(reason)) reasons.push(reason);
  }
  return reasons;
}

export function evaluateInbound(messageBody: string, company: CompanyConfig): SafetyVerdict {
  const stopReason = stopRequestReason(messageBody);
  if (stopReason) {
    return { action: "opt_out", reason: stopReason };
  }

  const text = straightApostrophes(messageBody);
  for (const { pattern, reason } of ESCALATION_PATTERNS) {
    if (pattern.test(text)) {
      return { action: "escalate", reason };
    }
  }

  return { action: "send", reason: "no triggers matched" };
}

// Phrasings that tell the lead their signup is finished. The prompt already
// says never to claim that (the contract doesn't exist until
// mts-sync/submitContracts.ts creates it, and that can still fail or be
// held), but Richard Case was told "you're all set Richard" on 2026-10-08,
// so this backs the prompt up in code.
const COMPLETION_CLAIM_PATTERNS: RegExp[] = [
  /\byou(?:'re| are|re) (?:all |now |officially )*(?:set|signed up|good to go|locked in|booked|scheduled|registered|enrolled)\b/i,
  /\b(?:sign ?-?up|contract|account|service|order|subscription)(?: is| has been| was) (?:all |now |officially )*(?:complete|completed|confirmed|done|created|set up|finalized|locked in|active)\b/i,
  /\b(?:it(?:'s| is)|that(?:'s| is)|everything(?:'s| is)|we(?:'re| are)) (?:all |now |officially )*(?:set|done|confirmed|locked in|finalized)\b/i,
  /\bwelcome (?:aboard|to the (?:family|team))\b/i,
];

// "you'll hear back once it's confirmed" is the approved closing line, so a
// match right after one of these words is about the future, not a claim.
const FUTURE_LEAD_IN = /\b(?:once|when|after|until|till|if|soon as|before)\s+(?:\w+\s+){0,2}$/i;

/** Does a drafted reply tell the lead their signup is already done? Used by
 * api/webhook.ts to redraft (and, failing that, fall back to fixed text)
 * before anything is sent. */
export function claimsSignupComplete(draft: string): boolean {
  const text = draft.replace(/[‘’]/g, "'");
  return COMPLETION_CLAIM_PATTERNS.some((pattern) => {
    const global = new RegExp(pattern.source, "gi");
    for (const match of text.matchAll(global)) {
      if (!FUTURE_LEAD_IN.test(text.slice(0, match.index))) return true;
    }
    return false;
  });
}

// Phrasings that tell the lead their order is being processed right now
// ("locking it in", "you'll hear back once it's confirmed"). That is only
// true when api/webhook.ts has saved the order (the ai-signup-confirmed tag
// and payload note that mts-sync/submitContracts.ts picks up). Found
// 2026-11-11: the reply and the save are decided separately, so leads who
// typed their name were told "locking this in now" while nothing was saved
// and nobody was told. Like claimsSignupComplete above, this backs the
// prompt up in code. The wording comes from the bot's own sent messages.
const LOCK_OBJECT = String.raw`(?:it|this|that|you|u|ya|everything|things|your\s+(?!rate|price|pricing)\w+|the\s+(?!rate|price|pricing)\w+)`;
const FIRST_PERSON_FUTURE = String.raw`(?:i'?ll|we'?ll|i\s+will|we\s+will|let\s+me|lemme|i'?m\s+going\s+to|we'?re\s+going\s+to|i'?m\s+gonna|we'?re\s+gonna|gonna)`;
// "locked in long term", "locking you into a contract": talk about how long
// the lead is committed for, not about their order.
const NOT_COMMITMENT = String.raw`(?!\s+(?:long[\s-]?term|to\s+(?:a|any|the)\b|into\b|for\s+(?:a|the|any|\d+)\s+(?:years?|months?|contract|term)\b))`;
const ORDER_NOUN = String.raw`(?:order|signup|sign-?up|service|contract|account|info|information|paperwork)`;
const ORDER_OBJECT = String.raw`(?:it|this|that|everything|your\s+(?:order|signup|sign-?up|contract|paperwork|info|information|details)|the\s+(?:order|signup|sign-?up|contract|paperwork))`;
// "...over to the team to finalize", "...along so they can process it": the
// purpose is what makes "pass it along" about the order.
const HANDED_ON_TO_FINISH = String.raw`(?:(?:over|along|on|through|in)\s+)?(?:to\s+(?:the|our|my)\s+(?:team|office)\s+)?(?:to|so\s+(?:they|we|it)\s+can)\s+(?:get\s+(?:it|this|that|everything)\s+)?(?:finali[sz]e|process|submit|lock|enter|set\s+up|schedule|finish)`;

/** Said as something happening now: "locking it in", "got you locked in". */
const IN_PROGRESS_NOW_PATTERNS: RegExp[] = [
  new RegExp(String.raw`\block(?:ing|in'?)\s+${LOCK_OBJECT}\s+in\b${NOT_COMMITMENT}`, "i"),
  // "locking in 2 trash bins at $25/month", but not "locking in a rate" or
  // "locking in now is just confirming the order".
  new RegExp(
    String.raw`(?:^|[,;—–-]\s*|\b(?:i'?m|we'?re|i\s+am|we\s+are)\s+(?:now\s+)?)lock(?:ing|in'?)\s+in\b(?!\s+(?:now\s+)?(?:is|means|would)\b)(?!\s+(?:(?:a|the|that|your|our)\s+)?(?:rate|price|pricing)\b)${NOT_COMMITMENT}`,
    "i"
  ),
  new RegExp(String.raw`\b(?:got|getting|gettin'?|have|having)\s+${LOCK_OBJECT}\s+(?:all\s+)?locked\s+in\b${NOT_COMMITMENT}`, "i"),
  new RegExp(String.raw`\b(?:it|this|that|everything|you|your\s+${ORDER_NOUN})(?:'s|'re|\s+is|\s+are)\s+(?:now\s+)?being\s+(?:locked\s+in|processed|submitted|finalized|set\s+up)\b`, "i"),
  new RegExp(String.raw`\b(?:submitting|processing|finalizing|finalising)\s+(?:it|this|that|everything|your\s+${ORDER_NOUN})\b`, "i"),
  new RegExp(String.raw`\bput(?:ting)?\s+(?:it|this|that|everything|your\s+${ORDER_NOUN})\s+through\b`, "i"),
  // Not "got you down for a 65 gal bin at...", the opening of a summary.
  /\bgot\s+(?:you|ya|u)\s+(?:all\s+)?down\b(?!\s+for\s+(?:a|an|one|two|three|\d))/i,
  /\b(?:getting|gettin'?|setting)\s+(?:you|ya|u|it|this|that|everything)\s+(?:all\s+)?set\s+up\s+(?:now|right\s+now|on\s+(?:our|my)\s+end)\b/i,
  // "getting you scheduled now", "getting your order entered".
  new RegExp(String.raw`\b(?:getting|gettin'?)\s+(?:you|ya|u|it|this|that|everything|your\s+${ORDER_NOUN})\s+(?:all\s+)?(?:scheduled|entered|submitted|processed|finali[sz]ed|on\s+the\s+schedule|in\s+the\s+system)\b`, "i"),
  // "your order's in!", "your signup has been placed", "your order is in progress".
  /\b(?:order|signup|sign-?up|contract|request)(?:'s|\s+is|\s+has\s+been|\s+was)\s+(?:now\s+)?(?:all\s+)?(?:in(?=\s*(?:[^\w\s]|$|and\b|now\b))|placed|submitted|received|through|in\s+progress|in\s+the\s+system|on\s+its\s+way|being\s+(?:processed|reviewed|handled|entered))/i,
  // "you're on the schedule for December 1".
  /\byou(?:'re|\s+are|re)\s+(?:now\s+)?(?:all\s+)?on\s+(?:the|our)\s+(?:schedule|books|route|calendar)\b/i,
  // "we've submitted your order", "I've sent your info to the office", "I've
  // passed it to the team to finalize"; but "I've passed that along" is
  // about a message, not an order.
  new RegExp(
    String.raw`\b(?:i'?ve|we'?ve|i\s+have|we\s+have)\s+(?:just\s+|already\s+|now\s+)?(?:(?:submitted|entered|placed|filed)\s+${ORDER_OBJECT}|(?:passed|sent|handed|forwarded|put)\s+(?:your|the)\s+${ORDER_NOUN}|(?:passed|sent|handed|forwarded)\s+(?:it|this|that|everything)\s+${HANDED_ON_TO_FINISH})`,
    "i"
  ),
  /\b(?:consider\s+it\s+done|all\s+done)\b/i,
];

/** Said as something happening now, in words that are also everyday sales
 * talk ("nope, it's all on file! what size bin?", "done! switched you to the
 * 65 gal"), so these only count once the bot has asked for the lead's name
 * (see inProgressPhrase). */
const IN_PROGRESS_NOW_CONFIRMATION_PATTERNS: RegExp[] = [
  /\b(?:that'?s|everything'?s)\s+(?:all\s+)?on\s+file\b|\bit'?s\s+all\s+on\s+file\b/i,
  // A reply that opens with "done": "done! :)", "perfect, done".
  /^(?:(?:ok(?:ay)?|got\s+it|perfect|great|awesome|sweet|cool|alright|10-4|bet)[\s,!.]+)?done\b(?!\s+(?:with|comparing|shopping|looking)\b)/i,
];

// "...once it's confirmed", "...when your order is processed".
const ONCE_ORDER_DONE = String.raw`[^.!?\n]{0,40}\b(?:once|when|as\s+soon\s+as|after)\s+(?:it'?s|it\s+is|it\s+has|that'?s|that\s+is|everything'?s|everything\s+is|everything\s+has|this\s+is|your\s+(?:order|signup|sign-?up|contract)(?:'s|\s+is|\s+has))\s+(?:been\s+)?(?:all\s+)?(?:confirmed|set(?!\s+up)|locked\s+in|finalized|processed|submitted|official|approved|done|complete|completed|good\s+to\s+go|ready)\b`;
/** Said as what happens next: "we'll get it locked in", "you'll hear back
 * once it's confirmed". Normal inside a message that asks for the lead's
 * name ("reply with your name and we'll get it locked in"), so these only
 * count when the message doesn't ask for it. */
const IN_PROGRESS_NEXT_PATTERNS: RegExp[] = [
  new RegExp(
    String.raw`\b${FIRST_PERSON_FUTURE}\s+(?:go\s+ahead\s+and\s+)?lock\s+(?:${LOCK_OBJECT}\s+in\b${NOT_COMMITMENT}|in\s+(?!(?:(?:a|the|that|this|your|our)\s+)?(?:\$|(?:rate|price|pricing|deal|discount|promo)\b)))`,
    "i"
  ),
  new RegExp(String.raw`\b${FIRST_PERSON_FUTURE}\s+(?:go\s+ahead\s+and\s+)?get\s+${LOCK_OBJECT}\s+(?:all\s+)?locked\s+in\b${NOT_COMMITMENT}`, "i"),
  new RegExp(String.raw`\b(?:hear\s+back|hear\s+from\s+(?:us|me|the\s+(?:team|office))|get\s+(?:a\s+)?confirmation|be\s+notified|get\s+notified)\b${ONCE_ORDER_DONE}`, "i"),
  // "I'll submit your order now", "we'll process it today", "I'll send it
  // over to the team".
  new RegExp(
    String.raw`\b${FIRST_PERSON_FUTURE}\s+(?:go\s+ahead\s+and\s+)?(?:(?:submit|process|finali[sz]e|place|file|enter)\s+${ORDER_OBJECT}\b|(?:send|pass|hand)\s+(?:(?:over|along|on|in)\s+)?(?:your|the)\s+(?:order|signup|sign-?up|contract|paperwork)\b|(?:send|pass|hand)\s+(?:it|this|that|everything)\s+${HANDED_ON_TO_FINISH})`,
    "i"
  ),
  // "I'll get this finalized", "we'll get your order submitted".
  new RegExp(String.raw`\b${FIRST_PERSON_FUTURE}\s+(?:go\s+ahead\s+and\s+)?get\s+${ORDER_OBJECT}\s+(?:all\s+)?(?:finali[sz]ed|processed|submitted|entered|placed|filed|through|in\s+the\s+system)\b`, "i"),
];

/** Same, in words that are also everyday sales talk or follow-up: "a team
 * member will let you know once that's set" is a normal answer about a pickup
 * day, so these only count once the bot has asked for the lead's name (see
 * inProgressPhrase). */
const IN_PROGRESS_NEXT_CONFIRMATION_PATTERNS: RegExp[] = [
  // "all set to get this moving" after a name, but not "ready to get you
  // started! what size bin..." while still selling.
  /\b(?:all\s+set|ready|good)\s+to\s+get\s+(?:this|it|that|you|things)\s+(?:moving|going|started|rolling|processed)\b/i,
  new RegExp(
    String.raw`\b(?:be\s+in\s+touch|follow\s+up|reach\s+out|let\s+you\s+know|get\s+back\s+to\s+you|text\s+you|call\s+you|email\s+you|update\s+you|get\s+(?:a\s+)?(?:text|call|email))\b${ONCE_ORDER_DONE}`,
    "i"
  ),
  // "I'll get you scheduled", "we'll set up your service": a promise once
  // the bot has asked for the name, but "I'll get you set up with a 95 gal"
  // is ordinary sales talk before that.
  new RegExp(String.raw`\b${FIRST_PERSON_FUTURE}\s+(?:go\s+ahead\s+and\s+)?get\s+(?:you|ya|u|it|this|that|everything)\s+(?:all\s+)?(?:scheduled|set\s+up|on\s+the\s+schedule)\b`, "i"),
  new RegExp(String.raw`\b${FIRST_PERSON_FUTURE}\s+(?:go\s+ahead\s+and\s+)?(?:schedule|set\s+up)\s+(?:you|ya|u|it|this|that|everything|your\s+(?:service|order|bins?|delivery|first\s+pickup))\b`, "i"),
];

const NAME_WORDS = String.raw`(?:full\s+|first\s*(?:and|&|\+|n)\s*last\s+|first\s+|last\s+|whole\s+|actual\s+|real\s+|legal\s+)?name`;
/** An actual request for the lead's name. A mention ("thanks for confirming
 * your name", "under your name") isn't one. */
const NAME_REQUEST = new RegExp(
  [
    // "reply with your full name", "text your name back", "send over your
    // name", "go ahead and sign by replying with your full name"
    String.raw`\b(?:repl(?:y|ying|ies)|respond(?:ing)?|text(?:ing)?|send(?:ing)?|shoot(?:ing)?|typ(?:e|ing)|drop(?:ping)?|giv(?:e|ing)|shar(?:e|ing)|provid(?:e|ing)|enter(?:ing)?|writ(?:e|ing)|confirm(?:ing)?|sign(?:ing)?)\b[^.!?\n]{0,30}?\b(?:your|ur|ya|the|a)\s+${NAME_WORDS}\b`,
    // "your full name is all I need to lock it in"
    String.raw`\b(?:your|ur)\s+${NAME_WORDS}\s+is\s+all\s+(?:i|we)\s+need\b`,
    // "please put your first and last name", "sign with your name"
    String.raw`\bput\s+(?:down\s+)?(?:your|ur)\s+${NAME_WORDS}\b`,
    String.raw`\bsign\s+(?:it\s+|off\s+)?with\s+(?:your|ur)\s+${NAME_WORDS}\b`,
    // "just need your name", "all I need is your full name"
    String.raw`\bneed(?:s|ed)?\b[^.!?\n]{0,20}?\b(?:your|ur)\s+${NAME_WORDS}\b`,
    // "what's your name", "can I get your full name"
    String.raw`\bwhat(?:'?s|\s+is)\s+(?:your|ur)\s+${NAME_WORDS}\b`,
    String.raw`\b(?:can|could|may)\s+(?:i|we)\s+(?:get|have|grab)\s+(?:your|ur)\s+${NAME_WORDS}\b`,
    // "your full name to confirm", "your name and we'll lock it in", "last
    // step: your full name, and we're good to go"
    String.raw`\b(?:your|ur)\s+${NAME_WORDS}\s*,?\s+(?:to|and|so)\s+(?:(?:i|we|you)(?:'ll|\s+will|\s+can|'re|\s+are)?\s+)?(?:be\s+)?(?:confirm|lock|sign|finali[sz]e|finish|get|make|seal|good|all\s+set|set|ready)\b`,
    String.raw`\bname\s+on\s+it\b`,
  ].join("|"),
  "i"
);
// "got your name, so...", "thanks for confirming your name" mention the name
// without asking for it.
const NAME_ALREADY_GIVEN =
  /\b(?:got|have|received|thanks?\s+for|thank\s+you\s+for|appreciate)\s+(?:\w+\s+){0,2}?(?:your|ur)\s+(?:full\s+)?name\b|\b(?:your|ur)\s+name\s+(?:matches|checks\s+out|is\s+on\s+file|on\s+file)\b/i;
// "before we lock it in", "once that looks good we'll get it locked in",
// "say the word and I'll lock it in", and an opening condition followed by
// a comma: "If that all looks good, I'll lock it in".
const CONDITIONAL_LEAD_IN =
  /\b(?:before|once|when|whenever|after|until|till|if|unless|lmk|let\s+(?:me|us)\s+know|say\s+the\s+word)\b[^,;]*$|^\s*(?:(?:and|so|ok(?:ay)?|but|then|great|perfect|awesome|sweet|cool)[\s,]+)?(?:if|once|when|whenever|after|as\s+soon\s+as|before)\b[^;]*?,\s*$/i;
// "we'll lock it in once you confirm": a condition on the lead, after the
// claim but in the same clause.
const CONDITIONAL_TAIL = /^[^.!?\n,;]*?\b(?:once|when|whenever|as\s+soon\s+as|after|if)\s+(?:you|u|ya|(?:we|i)\s+(?:get|have)\s+(?:your|ur))\b/i;
// "nobody's locking you in", "we aren't locking it in yet".
const NEGATED_LEAD_IN = /\b(?:not|never|nobody'?s?|no\s+one'?s?|without|isn'?t|aren'?t|won'?t|don'?t|doesn'?t|wasn'?t|nothing'?s?|cannot|can'?t)\s+(?:\S+\s+){0,1}$/i;
const TRAILING_DECORATION = /[\s:;)(\-\p{Extended_Pictographic}️]+$/u;

function splitSentences(text: string): string[] {
  return text.split(/(?<=[.!?:])\s+|\n+/).filter((s) => s.trim());
}

function isNameRequest(sentence: string): boolean {
  return NAME_REQUEST.test(sentence) && !NAME_ALREADY_GIVEN.test(sentence);
}

/** Does this text ask the lead for their name? */
export function asksForName(text: string): boolean {
  return splitSentences(text.replace(/[‘’]/g, "'")).some(isNameRequest);
}

/** Is this the full signup summary? The prompt makes every summary state
 * the $75 cancellation fee and the no-refunds policy, which other messages
 * rarely both mention. */
export function looksLikeFullSummary(text: string): boolean {
  return /\$\s?75\b/.test(text) && /\brefund/i.test(text) && asksForName(text);
}

export interface InProgressCheckOptions {
  /** The bot has asked the lead for their name at some point (or they've
   * typed it), so the signup is at its confirmation step and "we'll text you
   * once it's confirmed" reads as a promise about their order. Defaults to
   * true, the stricter check. */
  nameRequested?: boolean;
}

// A bullet line of the summary: "- one 95 gal trash bin, $20/month".
const BULLET_LINE = /^\s*(?:[-•*·]|\d+[.)])\s*/;
// The line that opens a summary describes it: "sweet, here's what we're
// locking in:". Only at the start of its sentence, so "locking it in now,
// here's what you signed up for:" still counts.
const SUMMARY_OPENER =
  /^(?:(?:sweet|great|perfect|awesome|ok(?:ay)?|cool|got\s+it|alright|thanks|thank\s+you)[\s,!.]+)*(?:here'?s|here\s+is|this\s+is)\s+(?:what|everything)\b[^.!?]*:$/i;

/** The words in a drafted reply that tell the lead their order is being
 * locked in or processed, or null if there are none. Used by api/webhook.ts
 * to redraft (and, failing that, send fixed text and flag the lead) whenever
 * no order has been saved, and to quote in the office's note. The summary's
 * bullet points, asking for the name, offers ("want me to lock it in?"),
 * conditions ("once that looks good we'll lock it in") and negations don't
 * count; the lines around a summary ("locking it in now! here's everything
 * again:") do. */
export function inProgressPhrase(draft: string, options: InProgressCheckOptions = {}): string | null {
  const nameRequested = options.nameRequested ?? true;
  const text = draft.replace(/[‘’]/g, "'");
  const asksName = asksForName(text);
  const isSummary = looksLikeFullSummary(text);
  const checked = isSummary
    ? text
        .split("\n")
        .filter((line) => !BULLET_LINE.test(line))
        .join("\n")
    : text;
  const sentences = splitSentences(checked);
  const now = nameRequested ? [...IN_PROGRESS_NOW_PATTERNS, ...IN_PROGRESS_NOW_CONFIRMATION_PATTERNS] : IN_PROGRESS_NOW_PATTERNS;
  const next = nameRequested ? [...IN_PROGRESS_NEXT_PATTERNS, ...IN_PROGRESS_NEXT_CONFIRMATION_PATTERNS] : IN_PROGRESS_NEXT_PATTERNS;
  const patterns = asksName ? now : [...now, ...next];
  for (const raw of sentences) {
    let sentence = raw.trim();
    if (isNameRequest(sentence) || (isSummary && SUMMARY_OPENER.test(sentence))) continue;
    // A question only counts for the clauses before it: "locking it in
    // now, anything else?" still claims it; "want me to lock it in?" doesn't.
    if (sentence.replace(TRAILING_DECORATION, "").endsWith("?")) {
      const lastBreak = Math.max(sentence.lastIndexOf(","), sentence.lastIndexOf(";"), sentence.lastIndexOf(" - "), sentence.lastIndexOf("—"), sentence.lastIndexOf("–"));
      if (lastBreak <= 0) continue;
      sentence = sentence.slice(0, lastBreak);
    }
    for (const pattern of patterns) {
      for (const match of sentence.matchAll(new RegExp(pattern.source, "gi"))) {
        const before = sentence.slice(0, match.index);
        const after = sentence.slice(match.index! + match[0].length);
        if (CONDITIONAL_LEAD_IN.test(before) || CONDITIONAL_TAIL.test(after) || NEGATED_LEAD_IN.test(before)) continue;
        return match[0].trim();
      }
    }
  }
  return null;
}

/** Does a drafted reply tell the lead their order is being locked in or
 * processed? See inProgressPhrase. */
export function promisesSignupInProgress(draft: string, options: InProgressCheckOptions = {}): boolean {
  return inProgressPhrase(draft, options) !== null;
}
