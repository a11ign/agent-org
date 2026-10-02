// @ts-check
// WHAT THE CHAIRMAN MAY NOT SAY IN A CHAT (decision 2(d): "Never from chat: credentials, secrets, deletions, money"). A LEAF module that
// imports only the ledger's redactor, so it runs in this repository's `gate`.
//
// `classifyText(text)` runs on a message from the ACCEPTED chairman, before anything is forwarded, and answers one of three things:
//   forward -- nothing in it is on the list;
//   drop    -- it holds a secret-shaped string. It is not forwarded, and the caller deletes it from the chat (a credential in a chat
//              history is a leak whether or not it was forwarded);
//   refuse  -- it asks for a deletion on a repository, branch, row, data or file, or for spending. Not forwarded.
// A drop or a refusal carries ONE line of `reply` for the provider to send back: what will not be done and where the chairman does it
// himself. **The reply never quotes the input**, because for a secret that would publish it a second time.
//
// **A CLASSIFIER HAS FALSE NEGATIVES, so this is the first of three layers and not the guarantee** (the second is `ceo`'s brief, the
// third is that the outbound path can carry only checked facts). It is a pattern list, and it is tuned to refuse too much: a
// false refusal costs the chairman one sentence typed on their own, a false forward is the harm the design exists to prevent. Every
// pattern is pinned by a test that must match it and a benign sentence beside it that must NOT.

import { redact } from "./ledger.mjs";

export const VERDICT = Object.freeze({ forward: "forward", drop: "drop", refuse: "refuse" });
export const REASON = Object.freeze({ secret: "secret", deletion: "deletion", spending: "spending" });

export const REPLIES = Object.freeze({
  [REASON.secret]: "I don't take credentials in chat, so I dropped that message and did not pass it on. Put a credential in a file under ~/.config/agent-org/ on the host yourself.",
  [REASON.deletion]: "I won't delete or force-push anything from chat, so I did not pass that on. Do it yourself on GitHub or on the host.",
  [REASON.spending]: "I won't buy, subscribe or spend anything from chat, so I did not pass that on. Do it yourself in the provider's billing page.",
});

// Zero-width and soft-hyphen characters carry no meaning and would split a word the patterns look for ("de<ZWSP>lete").
const INVISIBLE = /[­​-‏⁠﻿]/g;

/** @param {string} text @returns {string} the text a pattern is matched against: compatibility-folded, no invisibles, one-space whitespace */
function normalise(text) {
  return text.normalize("NFKC").replace(INVISIBLE, "").replace(/\s+/g, " ").trim();
}

// ---- secrets ------------------------------------------------------------------------------------------------------------------------
// The ledger's `redact` already holds the token shapes (GitHub, Slack, AWS, JWT, Telegram bot token, Bearer, `password=...`, and a catch-all
// for any 32+ character run of token characters). A message `redact` would CHANGE is one that holds something it considers a secret, so
// the two cannot drift: a shape added to the redactor protects the chat the same day. These are what the redactor does not have.
/** @type {RegExp[]} */
const SECRET_SHAPES = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/,
  /\b(?:password|passwd|passphrase|pwd|secret|api[ _-]?key|private[ _-]?key|credentials?)\s+(?:is|was|are)\s+\S+/i,
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:[^\s@/]+@/i,
  /\bnpm_[A-Za-z0-9]{30,}/,
  /\bglpat-[A-Za-z0-9_-]{16,}/,
  /\bAIza[0-9A-Za-z_-]{30,}/,
  /\b[rsp]k_(?:live|test)_[A-Za-z0-9]{16,}/,
];

/** @param {string} text @returns {boolean} */
function holdsSecret(text) {
  return redact(text) !== text || SECRET_SHAPES.some((shape) => shape.test(text));
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
 * @returns {{verdict: "forward"} | {verdict: "drop" | "refuse", reason: string, reply: string}}
 */
export function classifyText(text) {
  const plain = normalise(text);
  if (holdsSecret(plain)) return /** @type {any} */ (withReply(VERDICT.drop, REASON.secret));
  const lowered = plain.toLowerCase();
  if (DELETION_SHAPES.some((shape) => shape.test(lowered))) return /** @type {any} */ (withReply(VERDICT.refuse, REASON.deletion));
  if (SPENDING_SHAPES.some((shape) => shape.test(lowered))) return /** @type {any} */ (withReply(VERDICT.refuse, REASON.spending));
  return { verdict: VERDICT.forward };
}
