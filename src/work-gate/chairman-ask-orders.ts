// @ts-check
// A WAIT THAT CLEARS ON A FACT RAISES `needs:chairman` WHEN THE ACT THAT REMAINS IS THE CHAIRMAN'S (#4020, his order relayed 2026-10-07 19:15Z: he found #2885 and #2887 himself,
// from the milestone, three days after `screenreader-fleet` 0.5.1 and `screenreader-worker` 0.3.0 shipped; the wait was the sentence "ask the chairman once the new packages have
// real releases", and no field named the condition or the ask).
//
// #4005 made the CONDITION a field (`Waiting-for:`, read from the registry) and reports a true one to `product-manager`. It does not raise the ask, and nothing in the gate could:
// `needs:chairman` is the only thing that reaches him (a BRIEF and not a ticket, #3409). So a row DECLARES THE ASK IN ADVANCE, as data:
//
//     Waiting-for: published @a11ign/screenreader-fleet@latest >= 0.5.0
//     Then-ask-chairman:
//     What is happening: ...                   (the lines `sources/requests.mjs` requires of a brief, plus `Declared: YYYY-MM-DD`)
//     Ask: ...
//
// WHEN EVERY `Waiting-for:` THE ROW DECLARES IS TRUE, the tick posts the declared brief as a comment (opening `BRIEF for the chairman`), labels the row `needs:chairman`, removes the
// declaration it has used (the block and its `Waiting-for:` lines, or the row would be ordered twice), and tells `ceo` ONCE. A condition the tick could not read is an unknown and
// raises nothing, as is a row that already carries the label, a malformed block (that goes to `product-manager` BY NAME: a brief missing a required line sends no alert, so the
// failure would be silent) and a block with no condition that can come true (`manual`, or a line outside the grammar).
//
// WHAT THIS CANNOT CHECK, AND THE BRIEF SAYS SO: that `Checked:` was true and that the ask is still needed when the condition clears. The declarer wrote it days earlier and the gate
// re-reads only the conditions. So the posted brief carries the declaration's date, and `ceo` is told when the label goes on (not before) so a stale ask is withdrawn the same tick.
//
// ONE WRITE PATH, ORDERED SO A FAILURE IS RECOVERABLE: the comment first (a label with no brief sends no alert), then the label, then the body edit. A comment already posted (a tick that
// died after it) is not posted twice: it is found by `MARKER` and only the label and the edit are redone.
//
// A LEAF OF THE GATE: it imports no binding from `work-gate.ts`, so the `gh` runner and the fact reader arrive as arguments.
import { parseWaits, conditionHolds, isItemWait, waitItemOf } from "../wait-condition.ts";
import { requestEvent, NEEDS_CHAIRMAN } from "../messaging/sources/requests.ts";
import { readReleaseFacts, registryDistTags, remoteTagExists } from "./held-on-satisfied-orders.ts";
import { subjectMention } from "../review-attribution.ts";

/** Which comment is the gate's own brief: found by this line, so a retried tick never posts a second one. */
export const MARKER = "<!-- chairman-ask-on-clear -->";
const REPORTED_TO = "product-manager";
const TOLD = "ceo";
const FENCE = /^[ \t]*(```|~~~)/;
// The block is read as a header at the START of a line, outside a fence (prose that merely quotes it declares
// nothing). It fires only when EVERY `Waiting-for:` condition on the row reads TRUE: a failed read is unknown and
// never counts, so the ask waits rather than guesses.
const ASK_HEADER =/^[ \t]*#{0,6}[ \t]*Then-ask-chairman:[ \t]*(.*?)[ \t]*$/;
const DECLARED_LINE = /^[ \t]*Declared:[ \t]*(\d{4}-\d{2}-\d{2})[ \t]*$/m;

/**
 * @typedef {{ item: import("../wait-condition.ts").WaitItem, lines: string[], declaredOn: string | null, waits: import("../wait-condition.ts").Wait[], problem: string | null }} Ask
 * A row's declared ask. `lines` are the brief's lines as written; `problem` is why it would never raise a usable alert, or `null`.
 */

/**
 * EACH LINE OF A BODY AND WHAT IT IS TO THE DECLARATION, outside fences only (a body QUOTING the grammar declares nothing, the repo's own fence rule): the `header`, the
 * `block` lines under it (to the first blank line), a `Waiting-for:` line, or `other`.
 * @param {string} body @returns {{ line: string, role: "header" | "block" | "wait" | "other" }[]}
 */
function scan(body: string): { line: string; role: "header" | "block" | "wait" | "other"; }[] {
  let fenced = false;
  let inBlock = false;
  return body.split("\n").map((line) => {
    if (FENCE.test(line)) {
      fenced = !fenced;
      inBlock = false;
      return { line, role: "other" };
    }
    if (fenced) return { line, role: "other" };
    if (ASK_HEADER.test(line)) {
      inBlock = true;
      return { line, role: "header" };
    }
    if (inBlock && line.trim() === "") inBlock = false;
    if (inBlock) return { line, role: "block" };
    return { line, role: parseWaits(line).length > 0 ? "wait" : "other" };
  });
}

/**
 * THE BODY WITHOUT THE DECLARATION: the block and every `Waiting-for:` line, which is what the raise removes. Fenced text is untouched.
 * @param {string} body @returns {string}
 */
export function withoutDeclaration(body: string): string {
  return scan(body).filter(({ role }) => role === "other").map(({ line }) => line).join("\n");
}

/** @param {string[]} lines @returns {string} the comment the alert source reads: it opens `BRIEF for the chairman`, as a labeller's would */
const briefOf = (lines: string[]): string => `BRIEF for the chairman\n\n${lines.join("\n")}`;

/**
 * WHY A DECLARED BLOCK WOULD NEVER SEND A USABLE ALERT, asked of the alert source itself (`requestEvent`), so the two cannot drift: the same lines are required, the same options and
 * steps are refused. `null` when it would send.
 * @param {string[]} lines @returns {string | null}
 */
function briefProblem(lines: string[]): string | null {
  const comment = { body: briefOf(lines), createdAt: new Date(0).toISOString(), authorAssociation: "MEMBER" };
  return requestEvent({ repo: "declared", row: { number: 0, title: "", url: "", comments: [comment] }, now: 0 }).problem;
}

/** @param {import("../wait-condition.ts").Wait[]} waits @returns {string | null} why no condition here can ever come true, or `null` */
function conditionProblem(waits: import("../wait-condition.ts").Wait[]): string | null {
  if (waits.length === 0) return "it declares no `Waiting-for:` line, so nothing says WHEN to ask";
  const unreadable = waits.filter((wait) => wait.state === "manual" || wait.state === "unreadable");
  return unreadable.length === 0 ? null : `\`Waiting-for: ${unreadable[0].text}\` is a condition the gate cannot read, so the ask would never fire`;
}

/**
 * THE ASK A ROW DECLARES, or `null` when it declares none.
 * @param {import("../wait-condition.ts").WaitItem} item @returns {Ask | null}
 */
export function askOf(item: import("../wait-condition.ts").WaitItem): Ask | null {
  const roles = scan(item.body);
  const headers = roles.filter(({ role }) => role === "header");
  if (headers.length === 0) return null;
  const lines = roles.filter(({ role }) => role === "block").map(({ line }) => line.trim());
  const waits = parseWaits(item.body);
  const declaredOn = DECLARED_LINE.exec(lines.join("\n"))?.[1] ?? null;
  const sameLine = ASK_HEADER.exec(headers[0].line)?.[1] ?? "";
  const problem = headers.length > 1 ? "`Then-ask-chairman:` is declared more than once"
    : sameLine !== "" ? "the brief's lines go on the lines UNDER `Then-ask-chairman:`, not beside it"
      : declaredOn === null ? "the block has no `Declared: YYYY-MM-DD` line, so the brief could not say how old the ask is"
        : briefProblem(lines) ?? conditionProblem(waits);
  return { item, lines, declaredOn, waits, problem };
}

/**
 * THE REFUSAL A FILING OR AN AMENDMENT EARNS for a body whose declaration could never raise an alert, or `null` (no declaration, or a sound one).
 * @param {string} body @returns {string | null}
 */
export function chairmanAskRefusal(body: string): string | null {
  const ask = askOf(waitItemOf({ number: 0, body }, "row"));
  if (ask?.problem == null) return null;
  return `row-file: REFUSING to file -- the \`Then-ask-chairman:\` block would never ask him: ${ask.problem}. A block carries every line the alert source requires of a brief `
    + "(`What is happening`, `Ask`, `Only you because`, `Checked`, `How long`, `Unblocks`, and `Not the chairman's Claude session because` for a brief with no options) and a `Declared:` date, "
    + "and rides on at least one `Waiting-for:` condition the gate reads.";
}

/**
 * WHAT THE TICK READ for one wait, in words, for the brief's `Condition true at` line.
 * @param {import("../wait-condition.ts").Wait} wait @param {import("../wait-condition.ts").WaitFacts} facts @returns {string}
 */
function readingOf(wait: import("../wait-condition.ts").Wait, facts: import("../wait-condition.ts").WaitFacts): string {
  if (isItemWait(wait)) return `${wait.text} (${facts.items[wait.key]?.state ?? "read"})`;
  if (wait.state === "manual" || wait.state === "unreadable") return wait.text; // never due, so never read; the type needs the line
  const fact = facts.releases?.[wait.key];
  if (wait.state === "tagged") return `${wait.text} (the remote has it)`;
  const tags = fact !== null && typeof fact === "object" ? JSON.stringify(fact) : "";
  return `${wait.text} (registry dist-tags ${tags})`;
}

/**
 * THE COMMENT THE TICK POSTS: the declared brief, then what the gate adds (when the condition was true and what it read) and what it did NOT check.
 * @param {Ask} ask @param {import("../wait-condition.ts").WaitFacts} facts @param {number} now @returns {string}
 */
export function postedBrief(ask: Ask, facts: import("../wait-condition.ts").WaitFacts, now: number): string {
  return [briefOf(ask.lines), "",
    `Condition true at ${new Date(now).toISOString()}: ${ask.waits.map((wait) => readingOf(wait, facts)).join("; ")}`,
    `Declared ${ask.declaredOn} by the row's author. The tick re-read only the condition above: NOT that \`Checked:\` was true then, and NOT that this ask is still needed now. `
      + `\`${TOLD}\` is told when the label goes on and withdraws a stale ask by removing \`${NEEDS_CHAIRMAN}\`.`,
    MARKER].join("\n");
}

/**
 * THE ROWS TO CONSIDER: an open row of the first repository that declares an ask, does not already carry the label, and whose block is sound. A malformed one is `broken`, reported by name.
 * @param {import("../wait-condition.ts").WaitItem[]} items @returns {{ sound: Ask[], broken: Ask[] }}
 */
export function declaredAsks(items: import("../wait-condition.ts").WaitItem[]): { sound: Ask[]; broken: Ask[]; } {
  const asks = items.filter((item) => item.kind === "row" && item.repoKey === undefined && !item.labels.includes(NEEDS_CHAIRMAN)).flatMap((item) => askOf(item) ?? []);
  return { sound: asks.filter((ask) => ask.problem === null), broken: asks.filter((ask) => ask.problem !== null) };
}

/**
 * THE ASKS WHOSE EVERY CONDITION IS TRUE. One that is false, or unknown (a read that failed, a reference nobody read), waits.
 * @param {Ask[]} asks @param {import("../wait-condition.ts").WaitFacts} facts @returns {Ask[]}
 */
export function dueAsks(asks: Ask[], facts: import("../wait-condition.ts").WaitFacts): Ask[] {
  return asks.filter((ask) => ask.waits.every((wait) => conditionHolds(wait, facts) === true));
}

/**
 * @typedef {{ run: (args: string[]) => string, log?: (line: string) => void }} Writer
 */

/** @param {Writer} io @param {number} number @returns {boolean | null} whether the gate's brief is already on the row; `null` when the comments could not be read */
function briefAlreadyPosted({ run }: Writer, number: number): boolean | null {
  try {
    const { comments } = JSON.parse(run(["issue", "view", String(number), "--json", "comments"]));
    return Array.isArray(comments) && comments.some((c) => String(c?.body ?? "").includes(MARKER));
  } catch {
    return null; // an unread comment list is an unknown, and posting blind could send the chairman a second copy
  }
}

/**
 * RAISE ONE ASK, in the order that survives a failure: comment, label, body edit. Returns whether the label went on, which is what `ceo` is told.
 * @param {Ask} ask @param {import("../wait-condition.ts").WaitFacts} facts @param {number} now @param {Writer} io @returns {boolean}
 */
export function raiseAsk(ask: Ask, facts: import("../wait-condition.ts").WaitFacts, now: number, io: Writer): boolean {
  const { run, log = (line) => process.stderr.write(`${line}\n`) } = io;
  const number = String(ask.item.number);
  const posted = briefAlreadyPosted(io, ask.item.number);
  if (posted === null) {
    log(`chairman-ask: could not read the comments of #${number}; nothing raised this tick`);
    return false;
  }
  try {
    if (!posted) run(["issue", "comment", number, "--body", postedBrief(ask, facts, now)]);
    run(["issue", "edit", number, "--add-label", NEEDS_CHAIRMAN]);
  } catch (error) {
    log(`chairman-ask: COULD NOT raise #${number} (${String(/** @type {Error} */ (error).message).split("\n")[0]}); the next tick retries, and a posted brief is not posted twice`);
    return false;
  }
  try {
    run(["issue", "edit", number, "--body", withoutDeclaration(ask.item.body)]);
  } catch (error) {
    log(`chairman-ask: raised #${number} but COULD NOT remove its declaration (${String(/** @type {Error} */ (error).message).split("\n")[0]}); remove the \`Then-ask-chairman:\` block and its \`Waiting-for:\` lines by hand`);
  }
  return true;
}

/**
 * THE ORDER TO `ceo`, once, when the label goes on: the row, the ask, its age, and the way to withdraw it.
 * @param {Ask} ask @returns {any}
 */
function toldOrder(ask: Ask): any {
  const { item } = ask;
  const discriminator = String(item.number);
  return { session: TOLD, cause: "org-health", subject: `chairman-ask-raised-${item.number}`, discriminator,
    prompt: `A DECLARED ASK WAS RAISED. ${subjectMention(item)} declared on ${ask.declaredOn} that the chairman is to be asked when its \`Waiting-for:\` condition came true; it did, so the tick posted `
      + `the brief and put \`${NEEDS_CHAIRMAN}\` on the row. The tick did NOT re-check that \`Checked:\` was true or that the ask is still needed. If it is not, remove \`${NEEDS_CHAIRMAN}\` now and say why on the row.`,
    causeKey: `${TOLD}/org-health/chairman-ask-raised-order@${discriminator}` };
}

/**
 * A MALFORMED DECLARATION, TO `product-manager` BY NAME: an alert that lacks a required line is not sent, and nothing else would say so.
 * @param {Ask} ask @returns {any}
 */
function brokenOrder(ask: Ask): any {
  const { item } = ask;
  const discriminator = String(item.number);
  return { session: REPORTED_TO, cause: "org-health", subject: `chairman-ask-malformed-${item.number}`, discriminator,
    prompt: `A DECLARED ASK WILL NEVER BE RAISED. ${subjectMention(item)} carries a \`Then-ask-chairman:\` block that cannot send an alert: ${ask.problem}. `
      + "Amend the row so the block carries every line of a brief and rides on a `Waiting-for:` condition the gate reads; until then the chairman is not asked.",
    causeKey: `${REPORTED_TO}/org-health/chairman-ask-malformed-order@${discriminator}` };
}

/**
 * @typedef {{ run: (args: string[]) => string, repo: () => string, readItemFacts: (input: { items: import("../wait-condition.ts").WaitItem[], open: any[], run: (args: string[]) => string }) => import("../wait-condition.ts").WaitFacts,
 *            limit: number, readers?: import("./held-on-satisfied-orders.ts").ReleaseReaders, log?: (line: string) => void }} AskIo
 * `readItemFacts` is `readWaitFacts` (it lives in `org-health.mjs`, which is a cycle with the gate); `repo` names the remote a `tagged` wait reads; `limit` caps raises and orders per tick.
 */

/**
 * THE TICK'S WHOLE ASK STEP over the open rows: report the broken declarations, read the facts of the SOUND ones only (a quiet org with no declaration pays no call), raise what is due.
 * `null` rows (a refused list) raise nothing.
 * @param {{ rows: any[] | null, now: number }} input @param {AskIo} io @returns {any[]} the orders
 */
export function chairmanAskOrders({ rows, now }: { rows: any[] | null; now: number; }, io: AskIo): any[] {
  if (rows === null) return [];
  const { sound, broken } = declaredAsks(rows.map((row) => waitItemOf(row, "row")));
  if (sound.length === 0) return broken.slice(0, io.limit).map(brokenOrder);
  const items = sound.map((ask) => ask.item);
  const { run } = io;
  const readers = io.readers ?? { distTags: registryDistTags, tagExists: (/** @type {string} */ tag: string) => remoteTagExists(tag, { run, repo: io.repo }) };
  const facts = { ...io.readItemFacts({ items, open: rows, run }), releases: readReleaseFacts({ items, readers }) };
  const raised = dueAsks(sound, facts).slice(0, io.limit).filter((ask) => raiseAsk(ask, facts, now, io));
  return [...broken.slice(0, io.limit).map(brokenOrder), ...raised.map(toldOrder)];
}
