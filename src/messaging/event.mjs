// @ts-check
// THE EVENT A WATCHER OBSERVES, AND NOTHING ELSE (a11ign/a11ign#2899, decision 1). A LEAF module: no import but node's own, so
// `node --test src/messaging/` runs in this repository's `gate`, which has no project checkout to read.
//
// **DEDUPE IS BY `key`, NEVER BY TEXT.** A tick that re-observes the same fact must send nothing, and the text of a fact is
// exactly the part that drifts (a count, an age, a run number). `key` is the stable identity of the THING:
// `request:a11ign/a11ign#2885`, `incident:trunk-red`, `stall:no-merge`, `summary:2026-10-02`,
// `release:a11ign/agent-org@v0.7.8`, `milestone:split-move-1`, `watch:pr:3418`.
//
// `state` is the one field beyond the design's event shape, and it exists for the reminder rule ("then silence until the state
// changes"): the watcher declares what "the state" of the fact IS (a request's labels, an incident's failing check), and the core
// compares its fingerprint rather than guessing from text. Absent means the state never changes, so a request is reminded up to
// three times and then left alone.

import { createHash } from "node:crypto";

export const EVENT_KINDS = Object.freeze(["request", "incident", "stall", "summary", "release", "milestone", "watch"]);
export const SEVERITIES = Object.freeze(["info", "warning", "critical"]);

const MAX_KEY_LENGTH = 200;
const FINGERPRINT_LENGTH = 16;

/**
 * @typedef {{
 *   key: string, kind: string, severity: string, firstSeenAt: number, text: string,
 *   links: string[], resolved: boolean, state: string, actions: readonly {label: string, data: string}[]
 * }} MessagingEvent  `firstSeenAt` is milliseconds since the epoch once normalised. `actions` are the buttons the watcher offers under this fact (none for most
 *   kinds); the core hands them to a provider that declares `buttons`, and whether the data means anything is the answers path's, not this module's.
 */

/** @param {unknown} value @param {string} field @returns {string} */
function requireText(value, field) {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`event.${field}: a non-empty string is required`);
  return value;
}

/** @param {unknown} value @param {string} field @param {readonly string[]} allowed @returns {string} */
function requireOneOf(value, field, allowed) {
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new TypeError(`event.${field}: ${JSON.stringify(value)} is not one of ${allowed.join(", ")}`);
  }
  return value;
}

/** @param {unknown} value @returns {number} */
function toEpochMs(value) {
  const ms = typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : NaN;
  if (!Number.isFinite(ms)) throw new TypeError(`event.firstSeenAt: ${JSON.stringify(value)} is not a time (epoch ms or an ISO string)`);
  return ms;
}

/** @param {unknown} value @returns {string[]} */
function toLinks(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((link) => typeof link !== "string")) throw new TypeError("event.links: an array of strings is required");
  return [...value];
}

/** @param {unknown} value @returns {{label: string, data: string}[]} */
function toActions(value) {
  if (value === undefined) return [];
  const valid = Array.isArray(value) && value.every((action) => action !== null && typeof action === "object" && typeof action.label === "string" && typeof action.data === "string");
  if (!valid) throw new TypeError("event.actions: an array of {label, data} strings is required");
  return value.map(({ label, data }) => Object.freeze({ label, data }));
}

/** @param {unknown} key @returns {string} */
function toKey(key) {
  const text = requireText(key, "key");
  if (text.length > MAX_KEY_LENGTH || /\s/.test(text)) throw new TypeError(`event.key: at most ${MAX_KEY_LENGTH} characters and no whitespace`);
  return text;
}

/**
 * The one door an event comes in through. It throws a TypeError naming the field rather than coercing, because a watcher that
 * emits a malformed event has a bug, and a coerced one would dedupe under a key nobody chose.
 *
 * @param {unknown} raw @returns {MessagingEvent}
 */
export function normalizeEvent(raw) {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new TypeError("event: an object is required");
  const candidate = /** @type {Record<string, unknown>} */ (raw);
  return Object.freeze({
    key: toKey(candidate.key),
    kind: requireOneOf(candidate.kind, "kind", EVENT_KINDS),
    severity: requireOneOf(candidate.severity, "severity", SEVERITIES),
    firstSeenAt: toEpochMs(candidate.firstSeenAt),
    text: requireText(candidate.text, "text"),
    links: toLinks(candidate.links),
    resolved: candidate.resolved === true,
    state: typeof candidate.state === "string" ? candidate.state : "",
    actions: Object.freeze(toActions(candidate.actions)),
  });
}

/** @param {{state: string}} event @returns {string} a short fingerprint of the declared state, comparable and safe to log */
export function stateFingerprint(event) {
  return createHash("sha256").update(event.state).digest("hex").slice(0, FINGERPRINT_LENGTH);
}
