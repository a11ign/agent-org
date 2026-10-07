// @ts-check
// a11ign/a11ign#3526: WHAT THE TRACE INGEST HAS ALREADY READ. One small JSON file beside the store, so `trace` re-reads only the bytes a transcript gained.
//
// PER TRANSCRIPT it keeps: `offset` (the byte up to which every record has been turned into events), `size` and `mtimeMs` as they were at that read, a hash of the
// first bytes (`headHash` over `headBytes`), and `carry`, which is what the reader needs to resume in the MIDDLE of a conversation: the session's name, the wake in
// force at the offset (a turn takes its row from the wake before it, so without this the first turn after the offset has `row: null`), the time of the last record
// (a turn's wall-clock runs from the record before it), and the ledger lines already paired (a line is consumed by one wake).
//
// THE STATE IS A HINT, NEVER A FACT ABOUT THE STORE. Every record keeps its stable id, so a state that is lost, older than the store, or distrusted costs a re-read and
// nothing else: it is never an error and never a silent skip. A state is distrusted (read again from zero, and SAID) when the file SHRANK, when its first bytes
// changed, when the file is not valid JSON, when the state is of another version, or when the store is SMALLER than it was at the last run (a deleted or replaced
// store would otherwise leave events missing for good). Equal size AND equal mtime is the only condition that skips a file: mtime alone is not enough, because a
// file that grew within one mtime tick keeps its mtime.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

// A version moves when a fix to what a turn CARRIES must reach turns already stored: the state of another version is a cold start, every transcript is read from byte 0, and
// `appendToStore` supersedes each stored turn with the differing copy. 3: `toolMs` (a11ign/a11ign#3669), absent from every turn stored before it, so its tool time printed as `unexplained` (#3680). 4: `toolRead` (a11ign/a11ign#3967), the tokens a `Read`, `Grep` or `Glob` result added to the window, absent from every turn stored before it.
export const STATE_VERSION = 4;

/** The first bytes hashed to tell a rewritten file from a grown one. Small, so that checking a grown file costs next to nothing. */
export const HEAD_BYTES = 256;

/**
 * @typedef {{ window: number, output: number, tools: string[], clean: boolean }} Previous the last message of a thread: its window, its output, the tools it called, and whether only tool results followed it in the read
 * @typedef {{ session: string | null, owner: { at: number, id: string, row: number | null, pr: number | null, repo: string | null, rows?: number[], prs?: number[], cause: string | null, causeKey: string | null } | null,
 *   lastAt: number | null, used: { at: number, key: string }[], previous?: { main: Previous | null, side: Previous | null } }} Carry
 * @typedef {{ offset: number, size: number, mtimeMs: number, headBytes: number, headHash: string, firstReadAt: number, settleAt: number | null, carry: Carry }} FileState
 * @typedef {{ version: number, firstRunAt: number, firstRunSince: number, storeBytes: number, files: Record<string, FileState> }} IngestState
 */

/** The state file of a store: beside it, named for it, so a scratch `--store` has a scratch state. @param {string} storePath */
export const stateFileFor = (storePath) => `${storePath}.ingest-state.json`;

/** @param {Buffer | Uint8Array} bytes */
export const fingerprint = (bytes) => createHash("sha1").update(bytes).digest("hex");

/** @param {{ now: number, since: number }} input @returns {IngestState} */
export function emptyState({ now, since }) {
  return { version: STATE_VERSION, firstRunAt: now, firstRunSince: since, storeBytes: 0, files: {} };
}

/**
 * The state to resume from, or an empty one and the reason it is empty. `coldStart` is `null` only when a state was read and trusted.
 * @param {{ statePath: string, storePath: string, now: number, since: number }} input
 * @returns {{ state: IngestState, coldStart: string | null }}
 */
export function loadState({ statePath, storePath, now, since }) {
  const cold = (/** @type {string} */ reason) => ({ state: emptyState({ now, since }), coldStart: reason });
  if (!existsSync(statePath)) return cold("no state file: first run against this store");
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(statePath, "utf8"));
  } catch (cause) {
    return cold(`state file unreadable (${/** @type {Error} */ (cause).message})`);
  }
  if (parsed?.version !== STATE_VERSION || typeof parsed.files !== "object" || parsed.files === null) return cold(`state file is not version ${STATE_VERSION}`);
  const storeBytes = existsSync(storePath) ? statSync(storePath).size : 0;
  if (storeBytes < parsed.storeBytes) return cold(`the store is smaller (${storeBytes} bytes) than at the last run (${parsed.storeBytes}): it was deleted or replaced`);
  return { state: parsed, coldStart: null };
}

/** Written to a sibling and renamed, so a run killed mid-write leaves the old state, not half of a new one. @param {string} statePath @param {IngestState} state */
export function saveState(statePath, state) {
  mkdirSync(dirname(statePath), { recursive: true });
  const partial = `${statePath}.${process.pid}.tmp`;
  writeFileSync(partial, JSON.stringify(state));
  renameSync(partial, statePath);
}

/**
 * What to do with one transcript. `headMatches` is a thunk because checking it costs a read, which a skipped file must not pay.
 * `settleAt` is when a message held back as possibly still being written has been quiet long enough: a file whose stat has not changed is read again from then.
 * @param {{ entry: FileState | undefined, stat: { size: number, mtimeMs: number }, now: number, headMatches: () => boolean }} input
 * @returns {{ action: "skip" | "resume" | "from-zero", reason: string | null }}
 */
export function planRead({ entry, stat, now, headMatches }) {
  if (!entry) return { action: "from-zero", reason: null };
  const unchanged = stat.size === entry.size && stat.mtimeMs === entry.mtimeMs;
  if (unchanged && !(entry.settleAt !== null && now >= entry.settleAt)) return { action: "skip", reason: null };
  if (stat.size < entry.size) return { action: "from-zero", reason: `shrank from ${entry.size} to ${stat.size} bytes` };
  if (!headMatches()) return { action: "from-zero", reason: "its first bytes changed" };
  return { action: "resume", reason: null };
}
