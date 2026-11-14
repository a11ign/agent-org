// @ts-check
// module: a run whose worker hit the Claude allowance -- read from its transcript or its limit menu, and held as Waiting: allowance, never crashed (A11-434)
//
// A WORKER OUT OF ALLOWANCE IS NOT A WORKER THAT STOPPED. Claude Code ends the turn with `You've hit your weekly limit · resets 2pm (Europe/London)` as the
// session's own reply, and often puts its limit menu on the pane. Before this, the board read the first as an agent idle with no outcome and ended the run
// `no-outcome` (Failed), and the second as a dialog for a person (Needs you). Neither is true: the run waits for the reset.
//
// THE TRANSCRIPT FIRST: it is the only place the message has a time, so a short-form reset (`resets 2pm`) is fixed to the right day. The pane is read only for
// an agent herdr reads `blocked`, which is what the limit menu makes it, and only when the transcript has not said it. Both are read without holding the loop.
// A message said before the run started is not this run's: a round that resumes a session which ended on the limit has not been refused yet.
import { open, stat } from "node:fs/promises";
import { LIMIT_UNREADABLE_HOLD_MS, TRANSCRIPT_TAIL_BYTES, lastSaidInTail, spentIn, spentOnPane, type SpentAllowance } from "../account-limit-message.ts";
import { replace, type Entry, type Queue } from "./queue/queue-entries-and-outcomes.ts";
import { findTranscript } from "./pool-transcripts.ts";
import type { PoolContext } from "./pool-context.ts";
import type { RunPlace } from "./pool-paths.ts";
import { agentTargetAsync } from "./pool-resume.ts";
import { HERDR_CALL_MS } from "./pool-herdr.ts";

/** A run held on a spent Claude allowance: the message, when the allowance returns (ms), and when the board first held the run (ms). */
export type AllowanceHold = NonNullable<Entry["allowance"]>;

/** The two lines of Claude Code's limit menu that say it is the limit menu, not another dialog (captured 2026-10-14, Claude Code 2.1.299). */
const MENU_LINES = [/stop and wait for limit to reset/i, /switch to usage credits/i];

/** Whether a pane shows Claude Code's limit menu. PURE. */
export const showsLimitMenu = (pane: string): boolean => MENU_LINES.every((line) => line.test(pane));

/**
 * The allowance a pane shows spent, or null: the message on a line of its own above the limit menu, with its reset fixed from `now`. A pane has no time, so the same short-form
 * message read again after its reset would name the next day's: a message the run is already held on keeps the reset it was held with. A menu whose message has scrolled away is
 * still the limit: it is held {@link LIMIT_UNREADABLE_HOLD_MS} from `now`, or for as long as the hold already recorded says. PURE.
 */
export function spentOnLimitMenu(pane: string, now: number, held?: AllowanceHold): SpentAllowance | null {
  if (!showsLimitMenu(pane)) return null;
  const shown = spentOnPane(pane, now);
  if (shown === null) return { text: MENU_ONLY, until: held?.until ?? now + LIMIT_UNREADABLE_HOLD_MS };
  return held?.text === shown.text ? { ...shown, until: held.until } : shown;
}

/** What a hold read from a limit menu whose message has scrolled away says it was refused with. */
const MENU_ONLY = "Claude Code's limit menu";

/**
 * What the board can tell of a run's allowance: `spent`, with the message and its reset; `clear`, read and not out of allowance; or `unknown`, because what it would be read from
 * cannot be read. `unknown` is not `clear`: a hold is kept through it, and dropped only on a read that says the allowance is not spent.
 */
export type AllowanceRead = Readonly<{ state: "spent"; spent: SpentAllowance }> | Readonly<{ state: "clear" }> | Readonly<{ state: "unknown" }>;

const CLEAR: AllowanceRead = { state: "clear" };
const UNKNOWN: AllowanceRead = { state: "unknown" };
const spentRead = (spent: SpentAllowance): AllowanceRead => ({ state: "spent", spent });

/** How many transcripts each pool remembers, found and last read: the oldest is forgotten first, so a board that runs for months holds no more than this. */
const REMEMBERED = 200;
/** How long a session whose transcript was not found is not looked for again: finding one lists every project, and it is not done on every pass. */
const MISS_RETRY_MS = 60_000;

/** What was last read of one transcript: its size and time, the allowance it said was spent, and when that was said. */
type TranscriptRead = Readonly<{ size: number; mtimeMs: number; spent: SpentAllowance | null; at: number }>;
/** What one pool remembers of its workers' transcripts: where each session's is (a session's file does not move), when one was last looked for and not found, and what was last read of each. */
type TranscriptMemory = Readonly<{ paths: Map<string, string>; misses: Map<string, number>; reads: Map<string, TranscriptRead> }>;

/** Each pool's memory of its transcripts, kept with the pool and dropped with it. */
const memories = new WeakMap<PoolContext, TranscriptMemory>();

function memoryOf(ctx: PoolContext): TranscriptMemory {
  const held = memories.get(ctx) ?? { paths: new Map(), misses: new Map(), reads: new Map() };
  memories.set(ctx, held);
  return held;
}

/** Remember `value` under `key`, forgetting the oldest entry past {@link REMEMBERED}. */
function remember<V>(map: Map<string, V>, key: string, value: V): void {
  map.delete(key);
  map.set(key, value);
  if (map.size > REMEMBERED) map.delete(map.keys().next().value as string);
}

/** What the end of a transcript says: the allowance spent and when it was said, or no spent allowance. Read again only when the file changed. */
async function readTranscript(ctx: PoolContext, path: string): Promise<TranscriptRead> {
  const { size, mtimeMs } = await stat(path);
  const { reads } = memoryOf(ctx);
  const last = reads.get(path);
  if (last !== undefined && last.size === size && last.mtimeMs === mtimeMs) return last;
  const length = Math.min(size, TRANSCRIPT_TAIL_BYTES);
  const file = await open(path, "r");
  let tail: string;
  try {
    const { buffer, bytesRead } = await file.read(Buffer.alloc(length), 0, length, size - length);
    tail = buffer.toString("utf8", 0, bytesRead);
  } finally {
    await file.close();
  }
  const said = lastSaidInTail(tail);
  const read = { size, mtimeMs, spent: said?.role === "assistant" ? spentIn(said) : null, at: said?.at ?? 0 };
  remember(reads, path, read);
  return read;
}

/** The transcript of the run's Claude session, or null when herdr names none or Claude Code has not written one yet. A session not found is looked for again after {@link MISS_RETRY_MS}. */
function transcriptOf(ctx: PoolContext, entry: Entry): string | null {
  const id = entry.workspace === undefined ? undefined : ctx.claudeSessions.get(entry.workspace);
  if (id === undefined) return null;
  const { paths, misses } = memoryOf(ctx);
  const known = paths.get(id);
  if (known !== undefined) return known;
  const missed = misses.get(id);
  if (missed !== undefined && ctx.now() - missed < MISS_RETRY_MS) return null;
  const found = findTranscript(ctx.transcripts, id);
  if (found === null) remember(misses, id, ctx.now());
  else remember(paths, id, found);
  return found;
}

/** What the run's transcript says of its allowance. A limit said before the run started is not this run's, so it reads clear. One that cannot be found or read is unknown. */
async function transcriptAllowance(ctx: PoolContext, entry: Entry): Promise<AllowanceRead> {
  try {
    const path = transcriptOf(ctx, entry);
    if (path === null) return UNKNOWN;
    const { spent, at } = await readTranscript(ctx, path);
    return spent !== null && at >= (entry.startedAt ?? 0) ? spentRead(spent) : CLEAR;
  } catch {
    return UNKNOWN;
  }
}

/** What the run's pane says of its allowance: spent on the limit menu, or clear. A pane that cannot be read is unknown. */
async function paneAllowance(ctx: PoolContext, entry: Entry, place: RunPlace): Promise<AllowanceRead> {
  try {
    const pane = await ctx.herdrCall(["--session", ctx.settings.herdrSession, "agent", "read", await agentTargetAsync(ctx, place), "--source", "visible"], HERDR_CALL_MS);
    const spent = spentOnLimitMenu(pane, ctx.now(), entry.allowance);
    return spent === null ? CLEAR : spentRead(spent);
  } catch {
    return UNKNOWN;
  }
}

/**
 * What a running run's worker's allowance is, on the status herdr reads for it (`seen`). A working agent is clear, and nothing is read for it. The transcript decides first; a
 * `blocked` agent whose transcript has not said it has its pane read for the limit menu, and a pane read that shows another dialog is clear.
 */
export async function readAllowance(ctx: PoolContext, entry: Entry, place: RunPlace, seen: string): Promise<AllowanceRead> {
  if (seen === "working") return CLEAR;
  const said = await transcriptAllowance(ctx, entry);
  if (said.state === "spent" || seen === "idle" || seen === "done") return said;
  const shown = await paneAllowance(ctx, entry, place);
  return shown.state === "unknown" ? said : shown;
}

/** Whether holding `entry` on `spent` would change it: a run already held on the same message and reset, with no dialog marked, is left as it is, so a pass writes nothing for it. PURE. */
export const holdChanges = (entry: Entry, spent: SpentAllowance): boolean =>
  entry.allowance?.until !== spent.until || entry.allowance.text !== spent.text || entry.waiting === true || entry.prompt !== undefined;

/**
 * Hold the run `key` as Waiting: allowance, until the reset `spent` names, from `now` or from when it was first held. A run held on the allowance is not
 * waiting on a person, so a dialog it was marked waiting on (the limit menu) is cleared. PURE.
 */
export const holdAllowance = (queue: Queue, key: string, spent: SpentAllowance, now: number): Queue =>
  replace(queue, key, ({ prompt: _menu, ...entry }) => ({ ...entry, waiting: false, allowance: { until: spent.until, text: spent.text, since: entry.allowance?.since ?? now } }));

/** The run `key` is no longer out of allowance: its hold is dropped. PURE. */
export const releaseAllowance = (queue: Queue, key: string): Queue =>
  replace(queue, key, ({ allowance: _held, ...entry }) => entry);
