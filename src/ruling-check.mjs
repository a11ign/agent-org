// @ts-check
// #2997: A RULING CARRIES ITS OWN CHECK THAT IT TOOK EFFECT, AND THE TICK RE-READS IT UNTIL IT DOES (the chairman, 2026-10-02: "why do I have to keep messaging
// it?"). `ceo` ruled at 06:50Z that the freeze was over, acted on the process and ended its turn; the fields that encoded the freeze stood four hours, because a
// ruling is a claim about state and nothing re-read the state. This is the PURE half: the closed vocabulary a check is written in, and the verdict over the open
// rows and pull requests the tick already holds. `ruling-record.mjs` is the half that touches a file, `work-gate.mjs` the half that touches GitHub.
//
// THE VOCABULARY IS CLOSED ON PURPOSE: a check that is free text is a sentence, and a sentence cannot be re-read by a program. The single-reference kinds are
// #2996's own grammar (`closed #n`, `merged #n`, `labelled|unlabelled <label> #n`), parsed and decided by `wait-condition.mjs` and not restated here; the
// population kinds are this file's: `no-open-row-body-matches <regex>`, `no-open-pr-label <label>`, `no-open-row-label <label> [except #n ...]`.
import { parseWaits, conditionHolds, isItemWait } from "./wait-condition.mjs";

/** The grace a ruling gets before a failing check is offered, in minutes: the ruling's own to override (`--grace=`). */
export const DEFAULT_GRACE_MINUTES = 20;
const MS_PER_MINUTE = 60_000;
/** How many failing items an order names: the population is NAMED, and a long one is counted past this. */
const NAMED_AT_MOST = 20;
const ROW_BODY = "no-open-row-body-matches";
const PR_LABEL = "no-open-pr-label";
const ROW_LABEL = "no-open-row-label";
const EXCEPT = /\s+except\s+((?:#\d+(?:\s+|$))+)$/;

/**
 * @typedef {{ kind: "ref", text: string, wait: import("./wait-condition.mjs").ReadableWait }
 *   | { kind: "row-body", text: string, pattern: RegExp }
 *   | { kind: "pr-label", text: string, label: string }
 *   | { kind: "row-label", text: string, label: string, except: number[] }} Check
 * @typedef {{ id: string, on: number, by: string, at: number, checks: string[], grace: number, resolved: boolean, offeredAt: number | null }} Ruling
 * @typedef {{ rows: import("./wait-condition.mjs").WaitItem[] | null, prs: import("./wait-condition.mjs").WaitItem[] | null,
 *   facts: import("./wait-condition.mjs").WaitFacts }} World what the check is read against: `null` is a list the tick could not read
 * @typedef {{ verdict: "pass" | "fail" | "unknown", failing: string[] }} Reading
 */

/**
 * ONE PREDICATE, PARSED, or the reason it is not in the vocabulary. The reason names the vocabulary, because a refusal that does not is a dead end.
 * @param {string} text @returns {{ ok: true, check: Check } | { ok: false, why: string }}
 */
export function parseCheck(text) {
  const trimmed = text.trim();
  const [word = "", ...rest] = trimmed.split(/\s+/);
  const argument = trimmed.slice(word.length).trim();
  if (word === ROW_BODY) return rowBodyCheck(trimmed, argument);
  if (word === PR_LABEL && rest.length === 1) return { ok: true, check: { kind: "pr-label", text: trimmed, label: rest[0] } };
  if (word === ROW_LABEL) return rowLabelCheck(trimmed, argument);
  const [wait] = parseWaits(`Waiting-for: ${trimmed}`);
  // A release state is not in a ruling's vocabulary: its facts are read for waits (`readReleaseFacts`), not for a ruling's checks, and a check that could only ever read `unknown` would never resolve.
  if (wait && isItemWait(wait)) return { ok: true, check: { kind: "ref", text: trimmed, wait } };
  return { ok: false, why: `\`${trimmed}\` is not in the vocabulary: closed #n, merged #n, labelled|unlabelled <label> #n, ${ROW_BODY} <regex>, ${PR_LABEL} <label>, `
    + `${ROW_LABEL} <label> [except #n ...]` };
}

/**
 * The regex is MULTILINE: a row body is lines, and `^Not-before:` means a field at the start of a line, not a row that merely quotes it. (Measured 2026-10-02: the
 * row that carries this very check names its own regex mid-line, so the unanchored form failed on the row that records it.)
 * @param {string} text @param {string} argument @returns {{ ok: true, check: Check } | { ok: false, why: string }}
 */
function rowBodyCheck(text, argument) {
  const source = argument.replace(/^(["'])(.*)\1$/, "$2");
  if (source === "") return { ok: false, why: `\`${ROW_BODY}\` needs a regex` };
  try {
    return { ok: true, check: { kind: "row-body", text, pattern: new RegExp(source, "m") } };
  } catch (cause) {
    return { ok: false, why: `\`${ROW_BODY}\`'s regex does not compile: ${/** @type {Error} */ (cause).message}` };
  }
}

/** @param {string} text @param {string} argument @returns {{ ok: true, check: Check } | { ok: false, why: string }} */
function rowLabelCheck(text, argument) {
  const except = EXCEPT.exec(argument);
  const label = (except ? argument.slice(0, except.index) : argument).trim();
  if (label === "" || /\s/.test(label)) return { ok: false, why: `\`${ROW_LABEL}\` needs one label, then optionally \`except #n ...\`` };
  const numbers = except ? [...except[1].matchAll(/#(\d+)/g)].map((m) => Number(m[1])) : [];
  return { ok: true, check: { kind: "row-label", text, label, except: numbers } };
}

/**
 * ONE CHECK READ AGAINST THE WORLD. `unknown` is a read the tick could not make (a refused list, a reference it could not fetch) and is NEVER a pass: an
 * unreadable population says nothing about whether the ruling took effect. `failing` names every item that makes it fail, so the offer says WHICH twelve.
 * @param {Check} check @param {World} world @returns {Reading}
 */
export function evaluateCheck(check, { rows, prs, facts }) {
  if (check.kind === "ref") {
    const holds = conditionHolds(check.wait, facts);
    return holds === null ? { verdict: "unknown", failing: [] } : { verdict: holds ? "pass" : "fail", failing: holds ? [] : [check.wait.key] };
  }
  const population = check.kind === "pr-label" ? prs : rows;
  if (population === null) return { verdict: "unknown", failing: [] };
  const failing = population.filter((item) => offends(check, item)).map((item) => `${item.kind === "pr" ? "PR " : "row "}#${item.number}`);
  return { verdict: failing.length === 0 ? "pass" : "fail", failing };
}

/** @param {Exclude<Check, { kind: "ref" }>} check @param {import("./wait-condition.mjs").WaitItem} item @returns {boolean} */
function offends(check, item) {
  if (check.kind === "row-body") return check.pattern.test(item.body);
  if (check.kind === "pr-label") return item.labels.includes(check.label);
  return item.labels.includes(check.label) && !check.except.includes(item.number);
}

/**
 * A RULING'S READING: every one of its checks, all of which must pass. One failing check fails it however many others are unknown, because the failure is
 * evidence and the unknown is not.
 * @param {string[]} checks @param {World} world @returns {Reading}
 */
export function evaluateChecks(checks, world) {
  const readings = checks.map((text) => {
    const parsed = parseCheck(text);
    return parsed.ok ? evaluateCheck(parsed.check, world) : { verdict: /** @type {const} */ ("unknown"), failing: [] };
  });
  const failing = readings.flatMap((r) => r.failing);
  if (readings.some((r) => r.verdict === "fail")) return { verdict: "fail", failing };
  return { verdict: readings.some((r) => r.verdict === "unknown") || readings.length === 0 ? "unknown" : "pass", failing: [] };
}

/** @param {number} at @param {number} grace minutes @param {number} now @returns {boolean} */
export const pastGrace = (at, grace, now) => now - at >= grace * MS_PER_MINUTE;

/** @param {number} ms @returns {string} the clock hour, `2026-10-02T19`: what makes an offer one per hour and not one per tick */
const hourOf = (ms) => new Date(ms).toISOString().slice(0, 13);

/**
 * WHAT THE TICK DOES WITH EACH UNRESOLVED RULING: a passing check is `took-effect` (at any time, inside its grace too), a failing one past its grace is
 * `offer`, and everything else (inside the grace, or unknown) is `wait`. A resolved ruling is not read at all: RESOLVED STAYS RESOLVED, and a ruling that passed
 * and later fails is a new ruling's business.
 * @param {Ruling[]} rulings @param {World} world @param {number} now
 * @returns {{ ruling: Ruling, action: "took-effect" | "offer" | "wait", reading: Reading }[]}
 */
export function settleRulings(rulings, world, now) {
  return rulings.filter((r) => !r.resolved).map((ruling) => {
    const reading = evaluateChecks(ruling.checks, world);
    if (reading.verdict === "pass") return { ruling, action: "took-effect", reading };
    return { ruling, action: reading.verdict === "fail" && pastGrace(ruling.at, ruling.grace, now) ? "offer" : "wait", reading };
  });
}

/**
 * THE ORDER FOR A RULING THAT HAS NOT TAKEN EFFECT, to the session that recorded it. It is the `org-health` cause, as #2996's stale-wait order is: a cause of its
 * own would be declared in `cause-declaration.mjs`, outside this row's Region, and judgment-high is the right profile for an order to look and fix. The discriminator
 * carries the clock hour, so a ruling still failing is offered once an hour and not once a tick.
 * @param {Ruling} ruling @param {Reading} reading @param {number} now
 */
export function rulingOrder(ruling, reading, now) {
  const named = reading.failing.slice(0, NAMED_AT_MOST).join(", ");
  const more = reading.failing.length > NAMED_AT_MOST ? ` and ${reading.failing.length - NAMED_AT_MOST} more` : "";
  const discriminator = `${ruling.id}@${hourOf(now)}`;
  return { session: ruling.by, cause: "org-health", subject: `ruling-not-taken-${ruling.id}`, discriminator,
    prompt: `A RULING OF YOURS HAS NOT TAKEN EFFECT. Ruling ${ruling.id} on #${ruling.on} said: ${ruling.checks.map((c) => `\`${c}\``).join(" AND ")}. Its grace `
      + `(${ruling.grace} minutes) is over and the state still fails it, at ${reading.failing.length} item(s): ${named}${more}. A ruling is a claim about state, `
      + "and a claim nobody re-reads is a hope (the chairman, 2026-10-02: a freeze ended at 06:50Z and its fields stood four hours). Fix the named items, or say on "
      + `#${ruling.on} why the check is wrong. This is offered once an hour until the check passes.`,
    causeKey: `${ruling.by}/org-health/ruling-not-taken@${discriminator}` };
}
