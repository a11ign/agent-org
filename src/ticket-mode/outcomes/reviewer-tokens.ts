// @ts-check
// module: the Codex reviewer's tokens for one review (A11-430) -- the turns of the reviewer's Codex sessions for a pull request's seat since the review before it
//
// THE REVIEWER WRITES NO TRANSCRIPT THE BOARD KNOWS BY NAME. Codex writes one rollout per session under `<CODEX_HOME>/sessions/YYYY/MM/DD/rollout-*.jsonl`, and its first record
// (`session_meta`) names the folder it ran in: the seat's checkout, whose last part is the seat's label (`reviewer-<n>`, or `reviewer-<key>-<n>` for another repository). So a review's
// sessions are the rollouts whose folder ends in its seat's label, read with the trace's own Codex reader (`src/trace/codex-turns.ts`), which splits and prices a request as the trace does.
//
// A REVIEW OWNS THE TURNS MADE AFTER THE REVIEW BEFORE IT, as a round owns the turns after the round before it (`round-tokens.ts`): a re-review in the same seat starts another session, or
// resumes one, and a turn is counted once, in the review that made it. A review whose turns cannot be found or read is UNREAD, never 0: it posted a verdict, so it spent something.

import { open, readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { eventsOfCodexSession } from "../../trace/codex-turns.ts";
import { type Turn, type TranscriptRead } from "./round-tokens.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

/** How much of a rollout is read to find its first record; a `session_meta` holds the session's instructions, measured at about 19 KB. */
const HEAD_BYTES = 256 * 1024;

/** Where Codex keeps its session rollouts: `$CODEX_HOME/sessions`, else `~/.codex/sessions`. */
export const codexSessionsDir = (env: Record<string, string | undefined> = process.env, home: string = homedir()): string => join(env.CODEX_HOME || join(home, ".codex"), "sessions");

/** The date folders, `YYYY/MM/DD` in local time as Codex names them, from the day before `after` to the day after `now`, so a session that crossed midnight in any zone is in one. PURE. */
export function dayFolders(after: number, now: number): string[] {
  const folders: string[] = [];
  for (let at = after - DAY_MS; at <= now + DAY_MS; at += DAY_MS) {
    const day = new Date(at);
    folders.push(join(String(day.getFullYear()), String(day.getMonth() + 1).padStart(2, "0"), String(day.getDate()).padStart(2, "0")));
  }
  return [...new Set(folders)];
}

/** The folder name the rollout at `file` ran in, from its first record, or null when its first record names none. */
async function sessionFolderOf(file: string): Promise<string | null> {
  const handle = await open(file, "r");
  try {
    const buffer = Buffer.alloc(HEAD_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, HEAD_BYTES, 0);
    const first = buffer.subarray(0, bytesRead).toString("utf8").split("\n", 1)[0];
    const record = JSON.parse(first) as { type?: string; payload?: { cwd?: unknown } };
    return record.type === "session_meta" && typeof record.payload?.cwd === "string" ? basename(record.payload.cwd) : null;
  } catch {
    return null;
  } finally {
    await handle.close();
  }
}

/** The rollouts in one date folder, by path; none when the folder does not exist. */
async function rolloutsIn(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).filter((name) => name.startsWith("rollout-") && name.endsWith(".jsonl")).map((name) => join(dir, name));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

/** The turns of one rollout, or why it cannot be read: a line that is not JSON anywhere but at its end (a live session's last line may be half written) makes it unreadable. */
function turnsOfRollout(text: string, file: string): readonly Turn[] | string {
  const read = eventsOfCodexSession({ text, file, rowRepo: "" });
  const halfWritten = read.consumed < Buffer.byteLength(text) ? 1 : 0;
  if (read.unreadable > halfWritten) return `the reviewer's Codex session ${file} has a line that is not JSON`;
  return read.events.flatMap(({ id, at, model, tokens }) => (tokens === undefined ? [] : [{ id, at, model: model ?? "unknown", tokens }]));
}

export type ReviewerSessions = Readonly<{ dir: string; label: string; after: number; now: number }>;

/**
 * The turns the reviewer of seat `label` made after `after` and up to `now`, from every Codex rollout under `dir` that ran in a folder of that name, or why they cannot be read: a rollout of
 * the seat that cannot be read, or no turn at all, since a review that posted a verdict spent tokens.
 */
export async function reviewerTurns({ dir, label, after, now }: ReviewerSessions): Promise<TranscriptRead> {
  const turns: Turn[] = [];
  try {
    for (const folder of dayFolders(after, now)) {
      for (const file of await rolloutsIn(join(dir, folder))) {
        if (await sessionFolderOf(file) !== label) continue;
        const read = turnsOfRollout(await readFile(file, "utf8"), file);
        if (typeof read === "string") return { unreadable: read };
        turns.push(...read.filter(({ at }) => at > after && at <= now));
      }
    }
  } catch (err) {
    return { unreadable: `the reviewer's Codex sessions under ${dir} could not be read (${(err as Error).message})` };
  }
  return turns.length === 0 ? { unreadable: `no Codex turn of ${label} was found under ${dir} after ${new Date(after).toISOString()}` } : { turns };
}
