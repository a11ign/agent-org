// @ts-check
// WHAT THE CHAIRMAN MAY NOT SAY IN A CHAT (decision 2(d): "Never from chat: credentials, secrets, deletions, money"). A LEAF module that
// imports only the ledger's redactor, so it runs in this repository's `gate`.
//
// `classifyText(text)` runs on a message from the ACCEPTED chairman, before anything is forwarded, and answers one of four things:
//   forward  -- nothing in it is on the list;
//   drop     -- it holds a DEFINITE secret: a credential word with its value beside it, or a known token shape. It is not forwarded, and the
//               caller deletes it from the chat (a credential in a chat history is a leak whether or not it was forwarded);
//   withhold -- it holds ONE token shaped like a pasted secret and nothing else says so. Handled exactly as a drop, and the reply says the
//               chairman may send it again with "not a secret". The phrase releases this tier and no other;
//   refuse   -- it asks for a deletion on a repository, branch, row, data or file, or for spending. Not forwarded.
// A drop, a withhold or a refusal carries ONE line of `reply` for the provider to send back: what will not be done and where the chairman
// does it on the host. **The reply never quotes the input**, because for a secret that would publish it a second time.
//
// **A CLASSIFIER HAS FALSE NEGATIVES, so this is the first of three layers and not the guarantee** (the second is `ceo`'s brief, the
// third is that the outbound path can carry only checked facts). It is a pattern list, and it is tuned to refuse too much: a
// false refusal costs the chairman one sentence typed on their own, a false forward is the harm the design exists to prevent. Every
// pattern is pinned by a test that must match it and a benign sentence beside it that must NOT.

import { redact } from "./ledger.mjs";

export const VERDICT = Object.freeze({ forward: "forward", drop: "drop", withhold: "withhold", refuse: "refuse" });
export const REASON = Object.freeze({ secret: "secret", unsure: "unsure", deletion: "deletion", spending: "spending" });

export const REPLIES = Object.freeze({
  [REASON.secret]: "I don't take credentials in chat, so I dropped that message and did not pass it on. Put a credential in a file under ~/.config/agent-org/ on the host yourself.",
  [REASON.unsure]: "That looks like a credential, so I haven't passed it on; send it again with 'not a secret' if it isn't.",
  [REASON.deletion]: "I won't delete or force-push anything from chat, so I did not pass that on. Do it yourself on GitHub or on the host.",
  [REASON.spending]: "I won't buy, subscribe or spend anything from chat, so I did not pass that on. Do it yourself in the provider's billing page.",
});

// Zero-width and soft-hyphen characters carry no meaning and would split a word the patterns look for ("de<ZWSP>lete").
const INVISIBLE = /[­​-‏⁠﻿]/g;

// NFKC folds the full-width hyphen-minus (U+FF0D) and the small one (U+FE63) and NOT these: the hyphen, non-breaking hyphen, figure dash,
// en and em dash, horizontal bar and the minus sign (U+2010-2015, U+2212), nor the two-em and three-em dashes. All of them LOOK like the
// "-" in "force-push" and "rm -rf", so each is made one before a pattern is matched.
const DASHES = /[\u2010-\u2015\u2212\u2E3A\u2E3B\uFE58]/g;

/** @param {string} text @returns {string} the text a pattern is matched against: compatibility-folded, no invisibles, one hyphen, one-space whitespace */
function normalise(text) {
  return text.normalize("NFKC").replace(INVISIBLE, "").replace(DASHES, "-").replace(/\s+/g, " ").trim();
}

// ---- secrets ------------------------------------------------------------------------------------------------------------------------
// TWO TIERS, and which one a message lands in decides what the chairman can do about it (#3442, the #2913 live miss):
//   DEFINITE -- a credential word with a value beside it, or a known token shape. `drop`: nothing releases it.
//   UNSURE   -- one token that has the shape of a pasted secret and no keyword. `withhold`: the same handling as a drop (nothing is forwarded,
//               the message is deleted from the chat), and the chairman may resend it with "not a secret". The phrase releases THIS tier only.
// The ledger's `redact` holds the token shapes (GitHub, Slack, AWS, JWT, Telegram bot token, Bearer, `password=...`, and a catch-all for
// any 32+ character run of token characters). A message `redact` would CHANGE is one that holds something it considers a secret, so the
// two cannot drift: a shape added to the redactor protects the chat the same day. The lists below are what the redactor does not have.
/** @type {RegExp[]} */
const SECRET_SHAPES = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/,
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:[^\s@/]+@/i,
  /\bnpm_[A-Za-z0-9]{30,}/,
  /\bglpat-[A-Za-z0-9_-]{16,}/,
  /\bAIza[0-9A-Za-z_-]{30,}/,
  /\b[rsp]k_(?:live|test)_[A-Za-z0-9]{16,}/,
  /\bASIA[0-9A-Z]{16}\b/,
];

// The catch-all in `redact` takes ANY 32+ character run of token characters, which includes two things a chairman types all day: a git
// object name (40 or 64 hex digits) and a branch or file slug (`chairman-messaging-a-credential-3442`). Those are told apart BEFORE the
// redactor looks, and a run holding a specific shape (`ghp_...`, `xoxb-...`) is never exempt: its first 31 characters are too short for the
// catch-all, so `redact` answers for the specific shapes alone.
const LONG_RUN = /\b[A-Za-z0-9_-]{32,}\b/g;
const GIT_OBJECT_NAME = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const SLUG = /^[a-z0-9]{1,16}(?:[-_][a-z0-9]{1,16}){2,}$/;
const CATCH_ALL_MINIMUM = 32;

/** @param {string} run @returns {boolean} */
function isOrdinaryRun(run) {
  if (!GIT_OBJECT_NAME.test(run) && !SLUG.test(run)) return false;
  const head = run.slice(0, CATCH_ALL_MINIMUM - 1);
  return redact(head) === head;
}

/** @param {string} text @returns {boolean} whether `redact` would change it, the ordinary long runs aside */
function holdsRedactableShape(text) {
  const masked = text.replace(LONG_RUN, (run) => (isOrdinaryRun(run) ? "ordinary" : run));
  return redact(masked) !== masked;
}

// A CREDENTIAL WORD, then up to two filler words and a separator, then a value (`My password is: X`, `pw: X`, `pwd=X`, `here's my password X`).
// A STRONG word with a separator takes ANY value, as the old pattern did; without one, or for a WEAK word (common English: `pass`, `pin`, `token`,
// `login`), the value must itself look like a credential, or `the password reset page is slow` and `rotate the token tomorrow` are refused.
// (A plain lowercase word after a strong word with NO separator is not caught: `my password please` is a sentence, and nobody types a password so.)
const CREDENTIAL_WORD = /(?<![A-Za-z0-9])(pass(?:word|wd|phrase|code)s?|pw|pwd|secrets?|api[ _-]?keys?|private[ _-]?keys?|credentials?|pass|pin|tokens?|logins?)(?![A-Za-z0-9])/gi;
const WEAK_WORD = /^(?:pass|pin|tokens?|logins?)$/i;
const FOR_WHAT = /^\s*(?:for|of|on|to)\s+(?:(?:the|my|our|a)\s+)?[^\s:=]+/i;
const SEPARATOR = /^\s*(?:->|=>|[:=]|-(?=\s)|(?:is|was|are)(?![A-Za-z0-9']))(?::)?/i;
const FILLER = /^\s*(?:my|the|our|new|old|now|a|an|just|actually|currently|again|still|to)(?![A-Za-z0-9'])/i;
const MAX_FILLERS = 2;
const PRONOUN = /^(?:it|this|that|which|what|here|there|he|she|they|who|one|mine|yours|all|nothing|something|everything)$/i;
const MINIMUM_CREDENTIAL_LENGTH = 4;

/** @param {string} value @returns {string} the value without the punctuation a sentence puts round it (a trailing `!` can be part of a password, so it stays inside) */
function bare(value) {
  return value.replace(/^["'`(\[<]+/, "").replace(/["'`)\]>.,;:?!]+$/, "");
}

/** @param {string} value @returns {boolean} whether it has the look of a credential: long enough, and a digit, a symbol or a capital after the first letter */
function looksLikeCredential(value) {
  const inner = bare(value);
  if (inner.length < MINIMUM_CREDENTIAL_LENGTH) return false;
  return /\d/.test(inner) || /[^A-Za-z0-9]/.test(inner) || (/[a-z]/.test(inner) && /[A-Z]/.test(inner.slice(1)));
}

/** @param {string} rest what follows a credential word @returns {{ explicit: boolean, value: string | null }} */
function readValue(rest) {
  let remaining = rest.replace(FOR_WHAT, "");
  let explicit = false;
  let fillers = 0;
  for (;;) {
    const separator = SEPARATOR.exec(remaining);
    const filler = separator === null && fillers < MAX_FILLERS ? FILLER.exec(remaining) : null;
    const taken = separator ?? filler;
    if (taken === null) break;
    if (separator === null) fillers += 1;
    else explicit = true;
    remaining = remaining.slice(taken[0].length);
  }
  const value = /^\s*(\S+)/.exec(remaining)?.[1];
  return { explicit, value: value === undefined ? null : value };
}

/** @param {string} text @param {RegExpExecArray} match a credential word in it @returns {boolean} whether a credential's value sits beside it */
function hasValueBeside(text, match) {
  const rest = text.slice(match.index + match[0].length);
  const { explicit, value } = readValue(rest);
  if (value === null || bare(value) === "") return false;
  const weak = WEAK_WORD.test(match[1]);
  if (explicit) return !weak || looksLikeCredential(value);
  return /^\s/.test(rest) && looksLikeCredential(value);
}

// `<value> is my password`: the value comes first. The pronoun list keeps `that is my password` and `this is the secret` from being values.
const VALUE_FIRST = /(\S+) (?:is|was|are) (?:my|the|our|its|their) (?:(?:new|old|current|temp\w*|admin|root|login|wi-?fi|account) )?(pass(?:word|wd|phrase|code)|pw|pwd|secret|pin|token|api[ _-]?key|private[ _-]?key|credentials?|login)(?![A-Za-z0-9])(?! (?:reset|manager|policy|page))/gi;

/** @param {string} text @returns {boolean} */
function holdsValueFirst(text) {
  return [...text.matchAll(VALUE_FIRST)].some(([, value, word]) => {
    if (PRONOUN.test(bare(value)) || bare(value) === "") return false;
    return !WEAK_WORD.test(word) || looksLikeCredential(value);
  });
}

/** @param {string} text @returns {boolean} whether a credential word has a value beside it, in either order */
function holdsKeyedCredential(text) {
  return [...text.matchAll(CREDENTIAL_WORD)].some((match) => hasValueBeside(text, match)) || holdsValueFirst(text);
}

const RELEASE_PHRASE = /\bnot a secret\b/gi;

/** @param {string} text @returns {boolean} whether it holds a DEFINITE secret: no phrase releases it, so the phrase is taken out first (it holds the word `secret`) */
function holdsSecret(text) {
  const withoutPhrase = text.replace(RELEASE_PHRASE, " ").replace(/\s+/g, " ");
  return holdsRedactableShape(withoutPhrase) || SECRET_SHAPES.some((shape) => shape.test(withoutPhrase)) || holdsKeyedCredential(withoutPhrase);
}

// ONE token that has the shape of a pasted secret and nothing a chairman types in a sentence: 16 or more characters that mix at least three of
// lower, upper, digit and symbol. `-_./:` are not symbols (they join the words of a slug, a path, a filename), and a token must hold one
// unbroken stretch of 12 or more between them, so `Report_Final_v2.pdf` and `agent/foo-bar-3442` are not secrets and `Aq9Zx7Lm2Kp4Vb8Nc3Jd5Hs6` is.
const UNSURE_MINIMUM_LENGTH = 16;
const UNSURE_STRETCH = 12;
const UNSURE_CLASSES = 3;
const URL_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;
const EMAIL_ADDRESS = /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i;

/** @param {string} token @returns {boolean} */
function looksLikePastedSecret(token) {
  if (token.length < UNSURE_MINIMUM_LENGTH || URL_SCHEME.test(token) || EMAIL_ADDRESS.test(token)) return false;
  if (!token.split(/[-_./:]/).some((stretch) => stretch.length >= UNSURE_STRETCH)) return false;
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9\-_./:]/].filter((kind) => kind.test(token));
  return classes.length >= UNSURE_CLASSES;
}

/** @param {string} text @returns {boolean} whether some token in it is unsure, and the chairman has not said it is not a secret */
function holdsUnsureToken(text) {
  if (new RegExp(RELEASE_PHRASE.source, "i").test(text)) return false;
  return text.split(" ").some((word) => looksLikePastedSecret(word.replace(/^["'`(\[<]+/, "").replace(/["'`)\]>.,;:]+$/, "")));
}

// ---- deletions ----------------------------------------------------------------------------------------------------------------------
const DELETE_VERB = "(?:delete|remove|destroy|wipe|erase|purge|nuke|drop|trash|obliterate|get rid of)";
const DELETE_OBJECT = "(?:repos?|repositor(?:y|ies)|branch(?:es)?|rows?|issues?|data|databases?|db|files?|folders?|director(?:y|ies)|ledgers?|corpus|backups?|history|volumes?|main|trunk|everything)";
/** @type {RegExp[]} */
const DELETION_SHAPES = [
  // A verb, then up to four words of "the agent-org" / "my old", then what is being deleted.
  new RegExp(`\\b${DELETE_VERB}\\b(?: [\\w:./@#-]+){0,4}? ${DELETE_OBJECT}\\b`),
  /\bforce[- ]?push/,
  /\bpush\b.* (?:-f|--force(?:-with-lease)?)\b/,
  /\brm -\w*[rf]\w*/,
  /\bgit (?:reset --hard|clean -\w*f)/,
];

// ---- spending -----------------------------------------------------------------------------------------------------------------------
/** @type {RegExp[]} */
const SPENDING_SHAPES = [
  /\b(?:buy|purchase|subscribe|renew)\b/,
  /\bpay (?:for|the|a|an|my|[$£€\d])/,
  /\b(?:upgrade|switch|move|change)\b[^.?!]{0,30}\b(?:plan|tier|subscription)\b/,
  /\b(?:pro|team|enterprise|paid|premium|max) (?:plan|tier|subscription)\b/,
  /\b(?:credit|debit) card\b/,
  // An amount: a currency sign before a number, or a number before a currency word.
  /[$£€¥] ?\d/,
  /\d[\d,.]* ?(?:usd|gbp|eur|dollars?|pounds?|euros?|bucks|quid)\b/,
  /\b(?:usd|gbp|eur) ?\d/,
];

/** @param {string} reason @param {string} verdict */
function withReply(verdict, reason) {
  return { verdict, reason, reply: REPLIES[reason] };
}

/**
 * @param {string} text  the message the accepted chairman sent
 * @returns {{verdict: "forward"} | {verdict: "drop" | "withhold" | "refuse", reason: string, reply: string}}
 */
export function classifyText(text) {
  const plain = normalise(text);
  if (holdsSecret(plain)) return /** @type {any} */ (withReply(VERDICT.drop, REASON.secret));
  if (holdsUnsureToken(plain)) return /** @type {any} */ (withReply(VERDICT.withhold, REASON.unsure));
  const lowered = plain.toLowerCase();
  if (DELETION_SHAPES.some((shape) => shape.test(lowered))) return /** @type {any} */ (withReply(VERDICT.refuse, REASON.deletion));
  if (SPENDING_SHAPES.some((shape) => shape.test(lowered))) return /** @type {any} */ (withReply(VERDICT.refuse, REASON.spending));
  return { verdict: VERDICT.forward };
}
