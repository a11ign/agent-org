// command: npm run prompt:session -- <label> "<text>"   (text may also come on stdin)
//
// PROMPT A SESSION THE WAY THE GATE DOES: CLEARED FIRST.
//
// `wake.mjs` clears a session's context before every order it delivers, and its own comment carries the
// measurement -- 690k -> 37k input tokens on a real session, an 18x cut, written after a day that spent
// 786M input tokens against 782k output and 7% of a weekly allowance while very little shipped.
//
// BUT THE GATE IS NOT THE ONLY THING THAT PROMPTS. `.claude/rules/agent-practices.md` tells the author of
// a draft to prompt its parity reviewer directly, and spelled the raw call:
//
//     herdr --session org agent prompt reviewer "Draft #<n> (odd) ..."
//
// which reaches herdr WITHOUT passing through `wake.mjs`, and therefore without the clear. Measured
// 2026-09-19 on a real `reviewer` transcript: six reviews in one unbroken session -- #1765, #1767, #1769,
// #1771, #1775, #1777 -- of which only #1765 arrived through the gate. The session carried 2.29M cached
// input tokens and had auto-compacted at least once. FIVE OF THE SIX PROMPTS WERE THE DOCUMENTED PATH,
// and one of those five was the chairman following the same documented pattern.
//
// So this is not a new mechanism. It is the SAME mechanism, given a name an author can be told to use,
// because "remember to clear first" is the kind of instruction this repository has repeatedly proved it
// cannot keep by habit -- which is what `clearContext`'s own comment already says about the rule it
// mechanised.
//
// THE RAW `herdr` CALL IS STILL RIGHT sometimes, and this does not remove it: a re-prompt about the SAME
// draft after a push wants the reviewer's existing context, not a floor. This command is for the first
// prompt about a topic, which is the "unrelated topic" the clear rule is actually about.
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { realpathSync, readFileSync, appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { refuseUnknownFlags } from "./lib/cli-flags.mjs";
import { clearBeforeOrder, isPerRowInstance, readAgents, WAKEABLE, queueHandoff, handoffQueuePath, ledgerPathFrom,
  handoffBacklog, readHandoffs, waitedFor, addressed } from "./wake.mjs";

/**
 * `1` the order is LOST -- nothing holds it and nothing will retry it; `2` it was not delivered now and
 * IS QUEUED for the next tick.
 *
 * `2` WAS `NOT_WAKEABLE` AND THE RENAME IS THE CHANGE (#1966). The number is the same because the shell
 * contract is; what it means is not. It used to say "this session may not receive a prompt", full stop,
 * and the order ended there -- the author was the only thing in the world that knew an order existed. It
 * now says the order is on the queue `wake.mjs` delivers from, so `2` is a DEFERRAL rather than a
 * failure, and `1` is the only code that means somebody has to send something again.
 */
export const EXIT = { OK: 0, REFUSED: 1, QUEUED: 2 };

const defaultRun = (args) => execFileSync("herdr", args, { encoding: "utf8", timeout: 30_000 });

/**
 * PURE. Whether this session may be prompted at all, and why not when it may not.
 *
 * THE SAME RULE `wake` APPLIES, AND FOR ITS REASON: `agent prompt` types into a live terminal, so sending
 * to a WORKING agent interleaves with whatever it is mid-turn on. `blocked` is herdr's own refusal and
 * `unknown` is no agent at all -- neither is a session, and neither becomes one by being typed at.
 *
 * @param {string} label @param {{label: string, status: string}[] | null} agents
 * @returns {string | null} the refusal, or `null` when the session may be prompted
 */
export function promptable(label, agents) {
  if (agents === null) return `could not ask herdr which sessions exist -- refusing to type blind`;
  const found = agents.find((a) => a.label === label);
  if (!found) return `no session named "${label}" (herdr knows: ${agents.map((a) => a.label).join(", ")})`;
  if (!WAKEABLE.includes(found.status)) {
    return `"${label}" is ${found.status}, and only ${WAKEABLE.join(" or ")} may receive a prompt `
      + `-- typing into a live turn interleaves with it`;
  }
  return null;
}

/**
 * CAN THE GATE OUTLAST THIS REFUSAL, or is it one only the author can fix?
 *
 * THE WHOLE VALUE OF THE QUEUE IS THAT IT DELIVERS WITHOUT ANYONE WATCHING, which is exactly why a
 * misaddressed order must never reach it: `"reviewr"` is not a session that will be free later, it is a
 * typo, and queueing it would hold an order nobody is waiting for until `HANDOFF_STALE_MS` names it two
 * hours from now. An author who is still at the terminal can fix that in one second.
 *
 * Everything else queues, INCLUDING a failed roster read. `agents === null` is "could not ask herdr",
 * not "no such session" -- the target may be perfectly fine and the next tick can ask again, so the
 * order survives. Queueing on a refusal we could not classify errs toward the order existing somewhere,
 * which is this file's whole subject.
 *
 * @param {string} label @param {{label: string, status: string}[] | null} agents
 * @returns {boolean}
 */
export function queueable(label, agents) {
  if (agents === null) return true;
  return agents.some((a) => a.label === label);
}

/**
 * PURE. The session name of the caller, from herdr's own workspace list -- or `null` when it is not there.
 *
 * `null` IS "UNKNOWN", NEVER A GUESS. A caller with no `HERDR_WORKSPACE_ID` (a systemd unit, a person's
 * shell) or one herdr does not list is not any session, and naming it as one -- the nearest, the last to
 * prompt -- would send the reader's reply to somebody who never asked. `workspace_id` and `label` are on
 * every entry herdr returns, so no roster of our own is kept to drift from it.
 *
 * @param {unknown} workspaces `result.workspaces` from `herdr workspace list`
 * @param {string | undefined} workspaceId
 * @returns {string | null}
 */
export function senderName(workspaces, workspaceId) {
  if (!workspaceId || !Array.isArray(workspaces)) return null;
  const found = workspaces.find((w) => String(w?.workspace_id ?? "") === workspaceId);
  const label = String(found?.label ?? "");
  return label === "" ? null : label;
}

/**
 * Who is calling, resolved from `HERDR_WORKSPACE_ID` against herdr. A failed read is an unknown sender,
 * not a failed prompt: the order is worth delivering with its asker unnamed.
 *
 * @param {(args: string[]) => string} run @param {string | undefined} workspaceId
 * @returns {string | null}
 */
export function resolveSender(run, workspaceId) {
  if (!workspaceId) return null;
  try {
    return senderName(JSON.parse(run(["--session", "org", "workspace", "list"]))?.result?.workspaces,
      workspaceId);
  } catch {
    return null;
  }
}

/**
 * PURE. The order's text with WHO ASKED in front of it -- said as what it is when nobody can be named.
 *
 * THE SENDER TRAVELS IN THE TEXT, and that is what makes the queued path the same order as the direct
 * one: the queue entry's `prompt` is this string, so the gate later delivers it through `addressed` with
 * the asker still on it. Recording it anywhere the delivery does not read would be this defect one hop
 * later.
 *
 * @param {string} text @param {string | null} sender
 * @returns {string}
 */
export function attributed(text, sender) {
  const from = sender
    ? `\`${sender}\` (reply by messaging that session, or on the row)`
    : "a caller `prompt:session` could not identify (no workspace id, or one herdr does not list) -- "
      + "do not assume it was any particular session";
  return `Sent to you by ${from}, through \`prompt:session\`:\n\n${text}`;
}

/**
 * THE TEXT THE CLEARED SESSION RECEIVES: `wake.mjs`'s `addressed`, the ONE function, around the asker and
 * the order. A second wrapper here would be a second place for the autonomy clause to drift (#2344).
 *
 * A SESSION NOT CLEARED FIRST is a per-row instance mid-row (#2483), whose window already holds the first-contact preamble, so
 * `followUp` gives it the one-line header instead (#2538); a standing seat, cleared, gets the whole of it.
 *
 * @param {string} label @param {string} text @param {string | null} sender @param {{followUp?: boolean}} [how]
 */
export function deliveredText(label, text, sender, { followUp = false } = {}) {
  return addressed({ session: label, prompt: attributed(text, sender) }, label, { followUp });
}

/** Prefix on {@link clearThenPrompt}'s return value when the PROMPT ITSELF failed -- the order never
 * reached the session, unlike a refused clear (text still went, just on a bloated context). A caller that
 * needs to tell "delivered anyway" apart from "never delivered" matches this rather than re-deriving it. */
export const PROMPT_REFUSED_PREFIX = "prompt refused: ";

/**
 * Clear, then prompt -- the clear only for a standing seat ({@link clearBeforeOrder}; a per-row instance keeps its
 * context, #2483). Returns what to report, or `null` when the prompt landed.
 *
 * THE PROMPT IS {@link deliveredText}: clearing strips everything the session knew, so what it wakes to
 * must say who it is and who asked. `sender` is `null` (the default) for a caller that is not a known
 * session -- a systemd unit such as the nightly firing is named as unidentified, never guessed.
 *
 * @param {(args: string[]) => string} run @param {string} label @param {string} text
 * @param {{sender?: string | null, sleep?: (ms: number) => void}} [options] `sleep` is the clear's settle
 *   ({@link clearBeforeOrder}): real by default, injected only by a test that is not about the delay (#2546)
 */
export function clearThenPrompt(run, label, text, { sender = null, sleep } = {}) {
  const { sent, refusal: clearRefusal } = clearBeforeOrder(run, label, sleep);
  try {
    run(["--session", "org", "agent", "prompt", label, deliveredText(label, text, sender, { followUp: !sent })]);
  } catch (/** @type {any} */ err) {
    return `${PROMPT_REFUSED_PREFIX}${String(err?.message ?? err).split("\n")[0].slice(0, 120)}`;
  }
  // A REFUSED CLEAR IS NOT A REFUSED PROMPT (`clearContext`'s own rule): the text went, on a context that
  // is more expensive than it should be, and saying so is strictly better than silence.
  return clearRefusal;
}

/**
 * THE REFUSAL PATH, WHICH IS NOW A WRITE. Returns the exit code, and reports on stderr either way.
 *
 * `wake.mjs`'s `deliver` has handled this case since #912: a busy target means the order is simply not
 * written to the ledger, and the next tick offers it again. This path had no equivalent -- it printed and
 * exited, and that was the end of the order -- so the routing rule's *"the author of a draft prompts its
 * parity reviewer the moment the PR opens"* was satisfiable only when the reviewer happened to be idle at
 * that moment. Measured 2026-09-22 on draft #1963: three refusals in 4m37s, no trace of any of them.
 *
 * WHAT IT DOES NOT DO IS RETRY, and `wake.mjs`'s handoff section carries why at length: the refusal is
 * load-bearing, because a standing seat is CLEARED first and a retry that wins the race wipes the work it
 * interrupted (a per-row instance is not cleared, #2483, so for one the retry is only a second copy). The gate
 * delivers when the gate judges the session free.
 *
 * AND IT IS ALSO WHERE AN ORDER CAN BE REFUSED THE QUEUE (#2167). {@link deepQueueRefusal} runs between
 * the two refusals above: the name is checked first, because a typo is an author error whatever the depth
 * is, and the depth second, because a report joining a stalled inbox is not a message at all.
 *
 * THE ORDER IS WRITTEN WITH ITS DECLARATION (#2222): `stance` says whether the sender declared it a
 * decision, an FYI, or nothing, and the queue entry records the first as `decision: true`. The author is
 * told what was recorded ({@link stanceNote}), including when it was the default.
 *
 * THE ENTRY CARRIES ITS SENDER (#2344): the asker is known only at this call, so the queued `prompt` is
 * {@link attributed} text and the gate's later delivery names who asked. `sender` is `null` when unknown.
 *
 * @param {{label: string, text: string, why: string, agents: {label: string, status: string}[] | null,
 *          path: string, stance?: Stance, sender?: string | null}} refusal
 * @returns {number}
 */
export function queueOrLose({ label, text, why, agents, path, stance = STANCE.UNDECLARED, sender = null }) {
  const decision = stance === STANCE.DECISION;
  if (!queueable(label, agents)) {
    process.stderr.write(`${NOT_QUEUED_PREFIX}${why}. Nothing will retry this -- a name the org `
      + "does not know is an author error, not a busy session. Fix the name and run it again.\n");
    return EXIT.REFUSED;
  }
  // BEFORE THE WRITE, DELIBERATELY. Refusing after the append would leave the order on the queue it was
  // refused for joining, which is the one outcome the row that asked for this ruled out by name.
  const tooDeep = deepQueueRefusal(queueDepth(label, path).mine, { label, text, decision });
  if (tooDeep) {
    process.stderr.write(tooDeep);
    return EXIT.REFUSED;
  }
  let entry;
  try {
    entry = queueHandoff(path, { session: label, prompt: attributed(text, sender), decision });
  } catch (err) {
    // THE ONE CASE WHERE AN ORDER REALLY IS LOST, so it is the loudest line this file can print.
    process.stderr.write(`NOT PROMPTED, AND NOT QUEUED: ${why}; and the queue at ${path} could not be `
      + `written (${String(/** @type {any} */ (err)?.message ?? err).split("\n")[0].slice(0, 120)}). `
      + "THIS ORDER IS LOST -- nothing else holds a copy. Send it again.\n");
    return EXIT.REFUSED;
  }
  process.stderr.write(`NOT PROMPTED NOW: ${why}.\n`
    + `QUEUED ${entry.id} -- the next \`npm run work:tick\` delivers it to "${label}" once the gate judges `
    + "that session between tasks. DO NOT RETRY: a retry that lands the instant it goes idle is a second "
    + "copy, and for a standing seat, which is cleared first, it also wipes whatever it was working on "
    + "(a per-row instance -- a spawned `worker-<n>`, a `reviewer-<n>` -- is never cleared).\n");
  process.stderr.write(stanceNote(stance));
  process.stderr.write(queueDepthNote(label, path));
  return EXIT.QUEUED;
}

/**
 * WHAT THIS ORDER IS JOINING -- said to the author, at the one moment they can still act on it (#2102).
 *
 * `QUEUED <id>` is true and tells the author nothing about whether anyone will ever read it. On
 * 2026-09-23 the same line was printed to fifty-seven successive authors, each of whom was correctly told
 * their order was held and none of whom was told that it was fifty-seventh in a queue whose oldest entry
 * had been waiting ten hours. The tick reports the same backlog to the org ({@link backlogReport}); this
 * reports it to the only person who can still choose to put the thing on the row instead.
 *
 * A FAILED READ IS A DIAGNOSTIC, NEVER A FAILURE. The order is already on disk by the time this runs, so
 * the exit code is settled -- and `readHandoffs` throws on a malformed line by design. Letting that
 * throw would turn a queued order into a crash and send the author back to retrying, which is the one
 * thing this command tells them not to do.
 *
 * @param {string} label @param {string} path @returns {string}
 */
export function queueDepthNote(label, path) {
  const { mine, unreadable } = queueDepth(label, path);
  if (unreadable !== undefined) {
    return `(could not read ${path} back to say how deep "${label}"'s queue is: ${unreadable}. Your order `
      + "is written; this note is not.)\n";
  }
  if (!mine || mine.waiting <= 1) return "";
  return `QUEUE DEPTH: this is order ${mine.waiting} waiting for "${label}", and the oldest has waited `
    + `${waitedFor(mine.oldestMs)}. A deep queue means that session is never between tasks, so it is not `
    + "reading its inbox -- if this order needs an answer, put it on the row where the org can see it "
    + "(`answer:<session>`, a `blocked-by` edge, or the row body) rather than only here.\n";
}

/**
 * WHAT IS ALREADY WAITING FOR ONE TARGET, or why that could not be answered.
 *
 * TWO CALLERS, ONE READ, AND THEY WANT OPPOSITE THINGS FROM A FAILURE. {@link queueDepthNote} runs AFTER
 * the write and degrades to a diagnostic; {@link deepQueueRefusal} runs BEFORE it and must not refuse an
 * order on a depth it could not measure. Returning the failure rather than throwing it is what lets each
 * decide that for itself -- and an `unreadable` that is a STRING rather than a thrown error is also why
 * neither of them has an empty `catch`.
 *
 * @param {string} label @param {string} path
 * @returns {{mine?: {session: string, waiting: number, oldestMs: number, stale: number,
 *              decisions: number},
 *            unreadable?: string}}
 */
export function queueDepth(label, path) {
  try {
    return { mine: handoffBacklog(readHandoffs(path)).find((b) => b.session === label) };
  } catch (err) {
    return { unreadable: String(/** @type {any} */ (err)?.message ?? err).split("\n")[0].slice(0, 120) };
  }
}

/**
 * HOW MANY ORDERS ALREADY WAITING FOR ONE TARGET MAKES THE NEXT ONE A ROW WRITE INSTEAD (#2167).
 *
 * TEN, AND THE MEASUREMENT PICKED IT rather than roundness. Read on the agent host 2026-09-23T15:03Z:
 * 60 pending orders, **55 of them for `product-manager`**, the oldest about eight hours old -- and every
 * other session in the org at 2 or fewer. So the observed traffic is bimodal: ordinary authoring, which
 * never exceeded 2, and one inbox that had stopped draining. Ten sits five times above the first and a
 * fifth of the way to the second, which is the widest gap the data offers: no ordinary author meets it,
 * and a stalling inbox meets it long before eight hours have accumulated.
 *
 * **A STARTING POINT, NOT A RULING**, and the row that asked for it says so in those words. Moving it is
 * this one line; what should not move without a measurement is the SHAPE -- a threshold picked from the
 * gap between two populations rather than from what looks tidy.
 */
export const DEEP_QUEUE = 10;

/**
 * THE SENDER'S DECLARATION, AND THE ONLY PLACE IT CAN COME FROM (#2222). Whether an order asks its reader
 * for an answer is known to whoever wrote it and computable by nobody else: on the delivery that filed
 * the row, 22 of the 30 orders that OPENED as a routine report also asked for a decision, so a classifier
 * on the text is wrong in the dangerous direction. It is declared here, recorded on the queue entry, and
 * surfaced in the bundle header ({@link decisionHeader} in `wake.mjs`).
 *
 * It does NOT replace `answer:<session>`. Where a row exists the label stays the answer -- it found 8 of
 * 8 on that delivery. This is for the ask with no row to put it on: a constant to ratify, a policy
 * question, a cross-row ruling.
 */
export const DECISION_FLAG = "--decision";

/** Declares that this order asks for no answer. Also the DEFAULT, so it changes nothing -- it exists so
 * a sender can say so on purpose, and so `--decision --fyi` can be refused as the contradiction it is. */
export const FYI_FLAG = "--fyi";

/** The spelling #2167 shipped, for the same declaration: it exempts a decision from
 * {@link deepQueueRefusal}. It is kept as an ALIAS rather than removed -- the rules file tells authors to
 * type it -- so one declaration does both jobs and there is no second way to say the same thing. */
export const NEEDS_DECISION_FLAG = "--needs-decision";

/** @typedef {"decision" | "fyi" | "undeclared"} Stance */
/** @type {{DECISION: "decision", FYI: "fyi", UNDECLARED: "undeclared"}} */
export const STANCE = { DECISION: "decision", FYI: "fyi", UNDECLARED: "undeclared" };

/**
 * PURE. Split the declaration off the arguments -- and NEVER LEAVE A FLAG IN THE TEXT.
 *
 * `rest.join(" ")` is the order's text, and its id hashes that text, so a flag left in it would be typed
 * at the reader AND make the same order sent with and without the flag queue twice. That matters most
 * for the declaration: an author who adds `--decision` when re-sending must not thereby send a SECOND
 * order.
 *
 * BOTH FLAGS AT ONCE IS REFUSED, not resolved: an order cannot be both, and picking one for the sender
 * would be inferring the thing this row exists to stop inferring.
 *
 * @param {readonly string[]} args
 * @returns {{stance: Stance, rest: string[], refusal?: undefined} | {refusal: string}}
 */
export function parseStance(args) {
  const asks = args.some((a) => a === DECISION_FLAG || a === NEEDS_DECISION_FLAG);
  const fyi = args.includes(FYI_FLAG);
  if (asks && fyi) {
    return { refusal: `${DECISION_FLAG} and ${FYI_FLAG} contradict each other: this order either asks its `
      + "reader for an answer or it does not. Pick one -- nothing else can know which.\n" };
  }
  const flags = [DECISION_FLAG, FYI_FLAG, NEEDS_DECISION_FLAG];
  const rest = args.filter((a) => !a.startsWith("--ledger=") && !flags.includes(a));
  return { stance: asks ? STANCE.DECISION : fyi ? STANCE.FYI : STANCE.UNDECLARED, rest };
}

/**
 * PURE. What the author is told the queue recorded -- the DEFAULT INCLUDED, so it is stated, never silent.
 *
 * A DECISION IS ASKED TO NAME WHAT CLEARS IT (SHOULD, not must). A conclusion that changes what happens
 * next belongs in a field, and the reader of a bundle triages by the header line and then has to act: a
 * row to label `answer:<session>`, or "reply on #928". Where a row exists the label is the answer and
 * this order is the pointer to it, which is why this only advises and refuses nothing.
 *
 * @param {Stance} stance @returns {string}
 */
export function stanceNote(stance) {
  if (stance === STANCE.DECISION) {
    return "DECLARED DECISION -- recorded on the queue entry, so the bundle header lists this order. "
      + "Say in the text WHAT CLEARS IT: a row to label `answer:<session>`, or \"reply on #928\". Where a "
      + "row exists, the label is the answer and this order only points at it.\n";
  }
  if (stance === STANCE.FYI) return "DECLARED FYI -- recorded: this order asks for no answer.\n";
  return `NO DECLARATION, SO THIS IS RECORDED AS FYI (the default). If it asks for an answer, send it `
    + `again with ${DECISION_FLAG} -- the same words are the same order, so it is not queued twice.\n`;
}

/** Prefix on {@link deepQueueRefusal}'s message. Shared with {@link queueOrLose}'s unknown-session
 * refusal deliberately: both mean the same thing to a script reading stderr -- nothing holds this. */
export const NOT_QUEUED_PREFIX = "NOT PROMPTED, AND NOT QUEUED: ";

/**
 * PURE. A REPORT THAT NEEDS NO DECISION IS A ROW WRITE, NOT AN ORDER -- so refuse it the queue (#2167).
 *
 * {@link queueDepthNote} above tells an author what they joined; it changed no outcome, and on the day it
 * shipped the queue still reached 60 orders with 55 for one session. A note is advice at the end of a
 * command that has already succeeded, and the measured behaviour is that authors read it and carried on.
 * THIS IS THE SAME FACT MOVED IN FRONT OF THE WRITE, where it decides instead of informs.
 *
 * ## Why a refusal rather than delivering faster
 *
 * Delivery CLEARS its target first, so a larger or more eager delivery wipes work in progress -- the
 * defect #912 fixed and the reason `deliver()` refuses a second order to a session it already woke this
 * tick. Capacity cannot come from the delivery path. It comes from not sending what a row can carry.
 *
 * ## The escape hatch is the whole design, not a concession to it
 *
 * Without {@link DECISION_FLAG} this is a mute button on the one inbox that must never be muted: a
 * stop-the-line, a ruling, a question whose answer changes what somebody does next are exactly the orders
 * a deep queue must still accept, and they are the orders a deep queue makes most urgent. The flag costs
 * the author one declaration and is not checked -- it cannot be. What it buys is that the DEFAULT stopped
 * being "add it to the pile".
 *
 * @param {{session: string, waiting: number, oldestMs: number, stale: number} | undefined} mine
 *   what is already waiting for the target, or `undefined` for a queue this target is not in
 * @param {{label: string, text: string, decision: boolean}} order
 * @returns {string | null} the refusal to print, or `null` when this order may queue
 */
export function deepQueueRefusal(mine, { label, text, decision }) {
  if (decision) return null;
  if (!mine || mine.waiting < DEEP_QUEUE) return null;
  return `${NOT_QUEUED_PREFIX}"${label}" already has ${mine.waiting} order(s) waiting and the oldest has `
    + `waited ${waitedFor(mine.oldestMs)}. Yours would be number ${mine.waiting + 1}. An order is `
    + "delivered only when the gate judges its target BETWEEN TASKS, so a queue this deep is a session "
    + "that is not reading its inbox at all -- joining it is not sending a message.\n"
    + "REMEDY -- WRITE IT ON THE ROW. A completion, a claim report, a merge close-out needs no decision: "
    + "the comment plus the label change IS the report, it costs no turn, and it is there exactly when "
    + "its reader next acts on that row (`.claude/rules/agent-practices.md`, *Routing -- who reads "
    + "what*).\n"
    + "IF IT NEEDS A DECISION -- a ruling, a stop-the-line, a question whose answer changes what somebody "
    + `does next -- re-run with ${DECISION_FLAG} (or ${NEEDS_DECISION_FLAG}, the same declaration) `
    + "and it queues at any depth.\n"
    + "YOUR REPORT, UNCHANGED, so this refusal does not swallow it -- the text may have come on stdin and "
    + `exist nowhere else:\n${text}\n`;
}

/** The record of what was DELIVERED, beside {@link queueHandoff}'s record of what is WAITING (#2500). */
export const DIRECT_RECORD_FILE = "prompt-session-direct";

/** How much of the order a direct record keeps: enough to tell which order it was, not a second copy of it. */
const DIRECT_RECORD_PROMPT_CHARS = 300;

/** @param {string} queuePath the handoff queue's path @returns {string} */
export function directRecordPath(queuePath) {
  return `${dirname(queuePath)}/${DIRECT_RECORD_FILE}`;
}

/**
 * APPEND ONE LINE SAYING AN ORDER WENT STRAIGHT TO AN IDLE SESSION (#2500). Returns whether it was written.
 *
 * Only the queued path used to leave a record, so an order that WAS sent read as one that never was: #2494
 * grepped the ledger for a reviewer's prompts, found none, and took nobody-asked from a file that was
 * silent by construction. The receiver's own transcript was the only witness, and it is swept.
 *
 * A SEPARATE FILE, NEVER A LINE IN THE QUEUE. A line shaped like a queue entry (`id`, `session`, `prompt`,
 * `queuedAt`) would be read by `readHandoffs` as an order still waiting and delivered AGAIN, and a
 * per-PR reviewer or spawned engineer is cleared before every order (#2483), so the second delivery wipes
 * the work the first started.
 *
 * A FAILED APPEND DOES NOT FAIL THE DELIVERY: the order has gone, and reporting it lost would send the
 * author back to retrying, which #1966 says never to do. The loss of the record is one stderr line.
 *
 * @param {string} queuePath the handoff queue's path; the record lands in its directory
 * @param {{label: string, text: string, sender: string | null, cleared: boolean, now?: number}} delivery
 * @returns {boolean}
 */
export function recordDirectDelivery(queuePath, { label, text, sender, cleared, now = Date.now() }) {
  const path = directRecordPath(queuePath);
  const line = { session: label, sender, sentAt: now, prompt: text.slice(0, DIRECT_RECORD_PROMPT_CHARS), cleared };
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(line)}\n`);
    return true;
  } catch (/** @type {any} */ err) {
    process.stderr.write(`the order to ${label} WAS delivered, but its record could not be written to ${path} `
      + `(${String(err?.message ?? err).split("\n")[0].slice(0, 120)}). Do not send it again.\n`);
    return false;
  }
}

/**
 * Deliver the order if the session is between tasks, queue it if not. Returns the exit code.
 *
 * ONE ORDER, ONE RECORD: an order leaves a queue entry ({@link queueOrLose}) or a direct line
 * ({@link recordDirectDelivery}), never both, and the direct line is written only once the prompt landed.
 *
 * @param {{run: (args: string[]) => string, label: string, text: string, agents: {label: string, status: string}[] | null,
 *          path: string, stance: Stance, sender: string | null, sleep?: (ms: number) => void}} order
 *   `sleep` is the clear's settle, passed to {@link clearThenPrompt} (#2546)
 * @returns {number}
 */
export function promptOrQueue({ run, label, text, agents, path, stance, sender, sleep }) {
  const why = promptable(label, agents);
  if (why) return queueOrLose({ label, text, why, agents, path, stance, sender });

  // NO DEPTH GATE ON THIS PATH, AND THE ASYMMETRY IS THE POINT. `promptable` said the target is between
  // tasks, so this order is DELIVERED rather than queued: it joins nothing, and a session that is idle is
  // a session whose queue the next tick will drain. The refusal is about JOINING A PILE, not about the
  // pile existing.
  const report = clearThenPrompt(run, label, text, { sender, sleep });
  // A PROMPT REFUSED AT THE LAST MOMENT IS THE SAME LOSS ONE STEP LATER. `promptable` said idle and herdr
  // said no, which means the session went to work in between -- the race the queue exists for. A refused
  // CLEAR is not this: the text went, on a bloated context, and re-queueing it would deliver it twice.
  if (report?.startsWith(PROMPT_REFUSED_PREFIX)) {
    return queueOrLose({ label, text, why: report, agents, path, stance, sender });
  }
  recordDirectDelivery(path, { label, text, sender, cleared: !isPerRowInstance(label) && !report });
  if (report) {
    process.stderr.write(`${report}\n`);
    return EXIT.REFUSED;
  }
  process.stdout.write(isPerRowInstance(label)
    ? `PROMPTED ${label}, context kept (a per-row instance is never cleared)\n`
    : `PROMPTED ${label}, on a cleared context\n`);
  return EXIT.OK;
}

function main() {
  // `--ledger` IS READ, THOUGH NOT BY THIS FILE. It names the ledger whose DIRECTORY holds the handoff
  // queue, so it must mean here exactly what it means to `wake.mjs` -- `ledgerPathFrom` is the one
  // definition both use. Accepting it is what lets a test, or an operator on a second org, point both
  // halves of the queue at the same place.
  refuseUnknownFlags(["--ledger", DECISION_FLAG, FYI_FLAG, NEEDS_DECISION_FLAG], {
    entry: import.meta.url, command: "node packages/agent-org/src/prompt-session.mjs" });
  // NO FLAG IS PART OF THE PROMPT -- `parseStance` strips them, and its comment carries why.
  const parsed = parseStance(process.argv.slice(2));
  if (parsed.refusal) {
    process.stderr.write(parsed.refusal);
    process.exit(EXIT.REFUSED);
  }
  const { stance } = parsed;
  const [label, ...rest] = parsed.rest;
  // STDIN IS THE DEFAULT FOR THE TEXT, because a prompt that names a PR contains backticks and quotes,
  // and passing that through a shell argument is how a `gh pr comment` in this repo once ran as command
  // substitution inside the very message it was quoting.
  const text = rest.join(" ") || readFileSync(0, "utf8").trim();
  if (!label || !text) {
    process.stderr.write("usage: npm run prompt:session -- <label> \"<text>\"   (or text on stdin)\n");
    process.exit(EXIT.REFUSED);
  }
  const queue = handoffQueuePath(ledgerPathFrom(process.argv));
  const agents = readAgents(defaultRun);
  const sender = resolveSender(defaultRun, process.env.HERDR_WORKSPACE_ID);
  process.exit(promptOrQueue({ run: defaultRun, label, text, agents, path: queue, stance, sender }));
}

if (import.meta.url === pathToFileURL(process.argv[1] ? realpathSync(process.argv[1]) : "").href) main();
