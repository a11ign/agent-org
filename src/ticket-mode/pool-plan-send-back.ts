// @ts-check
// module: a plan whose `## After-merge checks` section the board refuses goes back to its planner, not to the chairman (A11-288)
//
// THE REFUSAL IS A MECHANICAL FIX. On 2026-10-25 five planner runs reached **Needs you** only because an `Evidence:` line ran over 200 characters, a line held an inner quote, or a line was not copied word for word. The planner
// can fix each itself. So the board prompts the planner's own pane with the refusal and the exact format, up to {@link MAX_SEND_BACKS} times, and leaves the run running. The refusal after that is handed to the
// chairman's SESSION, never to the chairman: the board records a `working` note on the run with one `session` wait (A11-275), which the session's queue lists and answers, and the board then wakes the planner with the answer.
// The count is a file in the run's folder (`claims-retried.json` does the same for A11-212), which `pool-prepare` removes at the start of a run.
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterMergeLines } from "./done-when.ts";
import type { Move } from "./after-merge-move.ts";
import { AFTER_MERGE_CHECKS_FORMAT, AFTER_MERGE_CHECKS_HEADING } from "./after-merge/plan-section.ts";
import { MAX_ASK_CHARS } from "./wait-on/wait-parse.ts";
import { OUTCOME_FILE } from "./worker-files.ts";
import { markOutcomeStale } from "./pool-outcome.ts";
import { type PoolContext } from "./pool-context.ts";
// eslint-disable-next-line clean-code/no-duplication -- import list: the rule matches statement shape, and imports are not duplicated logic
import { log, runMembers, runPlace, updateEach } from "./pool-state.ts";
import { sendToAgent } from "./pool-resume.ts";
import { noteWorking } from "./queue/queue-transitions.ts";
import type { Entry } from "./queue/queue-entries-and-outcomes.ts";
import type { RunPlace } from "./pool-paths.ts";

/** How many times a refused section goes back to the planner before the session is asked. */
export const MAX_SEND_BACKS = 2;

/** The file in a run's folder that holds how many refusals the board has handled for the run, and what they were. */
export const SENT_BACK_FILE = "after-merge-sent-back.json";

/** How long the session has to answer a hand-off before the board wakes the planner without an answer. */
export const HAND_OFF_MS = 24 * 60 * 60 * 1000;

/** The most of a refusal the one-line prompt carries. */
const PROMPT_REFUSAL_CHARS = 500;

/** One ticket's refusal: its key, the board's words, the After-merge lines the planner was briefed with, and the lines its plan moves there. */
export type FormatRefusal = Readonly<{ key: string; refusal: string; lines: readonly string[]; moved: readonly string[] }>;

/** What {@link SENT_BACK_FILE} holds. */
type SentBack = Readonly<{ count: number; refusals: readonly string[] }>;

/** A refusal of ticket `entry`'s plan, with the After-merge lines its planner was briefed with (`briefedAgainst`, else the ticket's own text) and the lines the plan moves. PURE. */
export function formatRefusalOf(entry: Entry, refusal: string, moves: readonly Move[]): FormatRefusal {
  const description = entry.briefedAgainst?.description ?? entry.ticket.description;
  return { key: entry.ticket.key, refusal, lines: afterMergeLines(description).map(({ line }) => line), moved: moves.map(({ line }) => line) };
}

/** How many refusals the board has handled for the run whose folder is `dir`: 0 when none, or when the file cannot be read. */
function sentBefore(dir: string): SentBack {
  const path = join(dir, SENT_BACK_FILE);
  try {
    const held = existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Partial<SentBack>) : {};
    return { count: typeof held.count === "number" ? held.count : 0, refusals: Array.isArray(held.refusals) ? held.refusals.map(String) : [] };
  } catch {
    return { count: 0, refusals: [] };
  }
}

/** The text cut to `chars` characters, with an ellipsis when it was longer, and on one line. PURE. */
function oneLine(text: string, chars: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= chars ? flat : `${flat.slice(0, Math.max(0, chars - 1)).trimEnd()}…`;
}

/** One ticket's part of the file the planner reads: the board's words, the lines it was briefed with, and the lines its plan moves. PURE. */
function sectionFor({ key, refusal, lines, moved }: FormatRefusal): string[] {
  const list = (items: readonly string[]): string[] => (items.length === 0 ? ["- none"] : items.map((item) => `- ${item}`));
  return [`## ${key}`, "", `The board's words: ${refusal}`, "", "The ticket's After-merge lines, as you were briefed with them:", "", ...list(lines), "", `The lines your plan moves to After merge (its \`## Moved to After merge\`):`, "", ...list(moved), ""];
}

/** The file's body: each refusal word for word, then the format, then what to do next. PURE. */
const fileBody = (refusals: readonly FormatRefusal[], next: string): string => [...refusals.flatMap(sectionFor), AFTER_MERGE_CHECKS_FORMAT, "", next, ""].join("\n");

/** The file written beside the run's brief for the planner it is sent back to: each refusal word for word, then the format. PURE. */
const sendBackText = (refusals: readonly FormatRefusal[], n: number): string =>
  [`# The board refused your plan's ${AFTER_MERGE_CHECKS_HEADING} section (send-back ${n} of ${MAX_SEND_BACKS})`, "", fileBody(refusals, "Fix the section in your plan files, then write `{\"kind\":\"planned\"}` again as the last thing you do.")].join("\n");

/** The file written for the person's session after {@link MAX_SEND_BACKS}, which the planner reads too when the session's answer wakes it. PURE. */
const handOffText = (refusals: readonly FormatRefusal[], n: number): string =>
  [`# The board refused the plan's ${AFTER_MERGE_CHECKS_HEADING} section ${n} times`, "",
    fileBody(refusals, "The person's session answers with the corrected section. Apply it to your plan files exactly, then write `{\"kind\":\"planned\"}` again as the last thing you do. If you are woken at the wait's deadline with no answer, write `planned` again unchanged.")].join("\n");

/** Each refusal under its ticket's key, so a batch's planner knows which plan it is about. PURE. */
const namedRefusals = (refusals: readonly FormatRefusal[]): string => refusals.map(({ key, refusal }) => `${key}: ${refusal}`).join("; ");

/** The one-line prompt for the planner: the board prompts are one line, because a new line typed into a pane would submit it early. PURE. */
const promptFor = (refusals: readonly FormatRefusal[], n: number, file: string): string =>
  `The board refused your plan's ${AFTER_MERGE_CHECKS_HEADING} section (send-back ${n} of ${MAX_SEND_BACKS}): ${oneLine(namedRefusals(refusals), PROMPT_REFUSAL_CHARS)}. `
  + `Read ${file} for the exact format, fix the section in your plan files, and write {"kind":"planned"} again as the last thing you do. `
  + `If the board later wakes you with the person's session's answer to this refusal, apply the section it gives to your plan files exactly and write {"kind":"planned"} again; if it wakes you at the deadline with no answer, write {"kind":"planned"} again unchanged.`;

/** The ask the session is handed after {@link MAX_SEND_BACKS} refusals, at most {@link MAX_ASK_CHARS} characters: what was refused, where to read it, and what a pass is. PURE. */
function askFor(refusals: readonly FormatRefusal[], n: number, file: string): string {
  const around = (latest: string): string => `${refusals.map(({ key }) => key).join(", ")}'s plan: the board refused its ${AFTER_MERGE_CHECKS_HEADING} section ${n} times (${latest}). `
    + `Read ${file}, then answer with the corrected section; the board sends your answer to the planner, which writes it into the plan. A pass is the board attaching the plan.`;
  return around(oneLine(namedRefusals(refusals), Math.max(0, MAX_ASK_CHARS - around("").length)));
}

/** What one refusal round is about: the run, where its files are, the round's number, the file written for it and the refusals so far. */
type Round = Readonly<{ entry: Entry; place: RunPlace; n: number; file: string; refusals: readonly FormatRefusal[]; before: readonly string[] }>;

/** The run's name for the board's log. */
const whoOf = ({ entry }: Round): string => entry.batch ?? entry.ticket.key;

/**
 * Count the round and mark the run's `planned` outcome stale, so the board and the stop hook settle that file no more: the planner's next write is its answer. Done only once the planner or the session has been told, so a
 * prompt herdr refused is offered again by the next pass, which settles the same `planned`.
 */
function closeRound(ctx: PoolContext, { place, n, refusals, before }: Round): void {
  writeFileSync(join(place.dir, SENT_BACK_FILE), `${JSON.stringify({ count: n, refusals: [...before, ...refusals.map(({ key, refusal }) => `${key}: ${refusal}`)] })}\n`);
  const written = join(place.dir, OUTCOME_FILE);
  markOutcomeStale(place.dir, existsSync(written) ? statSync(written).mtimeMs : ctx.now());
}

/** Prompt the planner's own pane with the round's refusals and the file that holds the format. The run stays running. */
function sendToPlanner(ctx: PoolContext, round: Round): void {
  writeFileSync(round.file, sendBackText(round.refusals, round.n));
  const refused = sendToAgent(ctx, round.place, promptFor(round.refusals, round.n, round.file));
  if (refused !== null) return log(`${whoOf(round)}'s plan could not be sent back to its planner: ${refused}`);
  closeRound(ctx, round);
  log(`${whoOf(round)}'s plan: the board refused its ${AFTER_MERGE_CHECKS_HEADING} section, sent back to its planner (${round.n} of ${MAX_SEND_BACKS})`);
}

/** Hand the run to the person's session: a `working` note with one `session` wait on every ticket of the run, which the session's queue lists. The planner is woken with the session's answer. */
function handToSession(ctx: PoolContext, round: Round): void {
  const { entry, n, refusals, file } = round;
  writeFileSync(file, handOffText(refusals, n));
  closeRound(ctx, round);
  const at = ctx.now();
  const ask = askFor(refusals, n, file);
  updateEach(ctx, runMembers(ctx, entry), (queue, member) =>
    noteWorking(queue, member, `the board refused the plan's ${AFTER_MERGE_CHECKS_HEADING} section ${n} times`, at, at, { waits: [{ kind: "session", ask }], until: at + HAND_OFF_MS }));
  log(`${whoOf(round)}'s plan: the board refused its ${AFTER_MERGE_CHECKS_HEADING} section ${n} times, so the person's session is asked`);
}

/**
 * Handle the refusals of the `## After-merge checks` sections of the plans a planning run (one ticket, or a batch's members all together) wrote, instead of ending the run on them. While the run has had fewer than
 * {@link MAX_SEND_BACKS} refusals, the planner's own pane is prompted ({@link sendToPlanner}); after that the run is handed to the person's session ({@link handToSession}), which never ends it for the chairman.
 */
export function sendBack(ctx: PoolContext, entry: Entry, refusals: readonly FormatRefusal[]): void {
  const place = runPlace(ctx, entry);
  const { count, refusals: before } = sentBefore(place.dir);
  const n = count + 1;
  const round = { entry, place, n, file: join(place.dir, `after-merge-refused-${n}.md`), refusals, before };
  return count < MAX_SEND_BACKS ? sendToPlanner(ctx, round) : handToSession(ctx, round);
}
