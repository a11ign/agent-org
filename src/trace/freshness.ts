#!/usr/bin/env node
// a11ign/agent-org#498: IS THE TRACE STORE CURRENT, AND WHO IS TOLD WHEN IT IS NOT (chairman, a11ign/a11ign#4437, class `metrics-outage`: "a trace-freshness signal. If no
// `turn` event lands for 10 minutes while any session is working, raise an incident to the owning seat").
//
// WHY A CLOCK OF ITS OWN. The transcripts reached the store only as a side effect of a `trace` command that reads it, and the one unit that runs one on a clock, the pages
// publisher, regenerates only when a head of `main` moved or its last publication is an hour old. So the store's freshness was the cadence of merges, and a quiet hour was a
// blind hour. `a11ign-trace-ingest.timer` runs THIS FILE every five minutes: it ingests (`trace -- --ingest`, in a child, so a failing ingest cannot stop the check that follows
// it) and then asks the question below.
//
// THE RULE, WHAT IS OWED (a11ign/agent-org#1570, metrics-outage repeat of 2026-10-16). STALE is not "no turn anywhere for ten minutes": a long tool call is a session that writes no
// message for ten minutes and is healthy, and the store's newest turn is then ten minutes old with nothing owed. The ingest is OWED a turn for a message it has had two runs to turn:
// the hold-back (`QUIET_MS`, store.ts) keeps a message out of the run that reads it, so it is turned on the run after, one interval (five minutes, the unit's timer) later. A message
// is owed once it was past the hold-back at the PREVIOUS run, i.e. `QUIET_MS + INGEST_EVERY_MS` (ten minutes) old now. The store is STALE when a transcript's newest owed message has
// NO turn of its own in the store. Only a turn-producing message is one: a Claude `assistant` line with its `message.usage` (the store builds a turn from it), or a Codex
// `token_usage_record`. A tool call's result is a `user` line that produces no turn, so a call that runs for ten minutes owes nothing until its own turn is due.
// A TOUCHED FILE IS NOT A MESSAGE (a11ign/a11ign#928, three false incidents on 2026-10-10): a session that has finished its last message still rewrites its `last-prompt` and
// `cost-state` lines, which carry no timestamp and no message, so its file moves while it produces no turn. The test reads the timestamp of the line, never the file's mtime,
// and the mtime is only the cheap "could it hold one" filter in front of reading it.
// THE OWED MESSAGE IS READ FROM THE TAIL of each transcript, and the store's turns are read from ITS tail, back until every owed message is answered: the store is 537 MB and the question is
// asked every five minutes (a11ign/agent-org#709: after a cold start the file's end holds the oldest turns, so the read goes on until each owed message's turn turns up or the file is exhausted).
// A message is owed only inside a window (`OWED_WINDOW_MS`) of the ten-minute mark: an owed message older than that is not evidence that the ingest is failing now.
// THE CLOCK IS READ BEFORE THE INGEST (a11ign/agent-org#1091, see `ingestThenCheck`): the ingest held a message back against ITS start, so the check judges "owed" against that same reading.
//
// ONE INCIDENT PER EPISODE. An episode OPENS the first run the store is stale and ENDS only when a `turn` is inside the window again: a run that finds the store old and nobody
// working changes nothing, so an outage that spans a quiet hour is one incident and not two. Each of the two effects (the comment on the standing row, the order to the owning seat)
// is remembered separately and a REFUSED one is tried again next run, so a failed `gh` neither loses the incident nor sends the order twice.
import { spawnSync } from "node:child_process";
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { rolloutId } from "./codex-turns.ts";
import { QUIET_MS } from "./store.ts";
import { homeProjectDeclaration } from "../project-config.ts";

/** The chairman's number: how old a message may be, and still be the one a `turn` is owed for, and how recent a transcript's newest message must be to count as working. */
export const STALE_AFTER_MS = 10 * 60 * 1000;
const MS_PER_MINUTE = 60 * 1000;
const MINUTES_PER_HOUR = 60;
/** The ingest timer's interval (host-units.ts runs this unit every five minutes): one run holds a message back, the next one turns it. */
export const INGEST_EVERY_MS = 5 * MS_PER_MINUTE;
/** A message is owed a turn once it was past the hold-back at the PREVIOUS run: the hold-back plus one interval before the check (ten minutes). */
export const OWED_AFTER_MS = QUIET_MS + INGEST_EVERY_MS;
/** Owed messages are looked for this far back from `OWED_AFTER_MS` and no further: a message older than the window is not evidence that the ingest is failing now. */
const OWED_WINDOW_MS = STALE_AFTER_MS;
/** The tail read first, and the largest chunk the read grows to while the newest turn found is older than the window or none is found (a long run of `gh_call`s, a cold start's old turns). */
const TAIL_FIRST_BYTES = 1024 * 1024;
const TAIL_LAST_BYTES = 32 * 1024 * 1024;
const TURN_KIND = "\"kind\":\"turn\"";
/** The tail of a transcript read first for its newest message, and the most it grows to when that tail holds none (a last line of one huge tool result). */
const TRANSCRIPT_TAIL_FIRST_BYTES = 256 * 1024;
const TRANSCRIPT_TAIL_LAST_BYTES = 32 * 1024 * 1024;
const INGEST_TIMEOUT_MS = 20 * MS_PER_MINUTE; // a cold start (a lost state file) re-reads every transcript, which is minutes; the unit's own limit is above this
/** `type` of a record that is a message: Claude Code's two, and Codex's `response_item` (a Codex rollout has no bookkeeping line that rewrites itself after the last item). */
const MESSAGE_TYPES = new Set(["assistant", "user", "response_item"]);
const TRACE = join(dirname(fileURLToPath(import.meta.url)), "trace.ts");

/** The standing row the incident is posted on (`fleet-watch`'s record, as `fleet-gated-nightly.ts` posts on its own), and the seat that owns the store. */
export const INCIDENT_ROW = "928";
export const OWNER_SEAT = "orchestrator";
/** How long the comment may take: a hung GitHub must not hold the unit past its next firing. */
const COMMENT_TIMEOUT_MS = 60_000;
/** `prompt:session` records an order under the `Class:` line it carries; this is the chairman's class for the outage. */
export const INCIDENT_CLASS = "metrics-outage";
/** The name the order is attributed to: a host unit is not a session, and an order with no sender is counted as an unidentified caller (the proxy for a chairman correction). */
export const SENDER = "a11ign-trace-ingest.service";

export type TranscriptRoot = { dir: string; depth: number; optional?: boolean };
/** A message the ingest is owed a turn for: a turn-producing line of the transcript `transcript` (the key the store's turn carries) at `at`. */
export type Owed = { transcript: string; at: number };
export type Freshness = { newestTurnAt: number | null; ageMs: number | null; working: boolean; unmet: Owed[]; stale: boolean };
export type Episode = { open: boolean; since: number | null; commented: boolean; ordered: boolean };

/** Where a transcript lives, as `trace.ts` reads them: Claude Code at `projects/<project>/<id>.jsonl`, Codex at `sessions/<year>/<month>/<day>/rollout-*.jsonl`; Codex may be absent. */
export function transcriptRoots(home: string = homedir()): TranscriptRoot[] {
  return [{ dir: join(home, ".claude", "projects"), depth: 1 }, { dir: join(home, ".codex", "sessions"), depth: 3, optional: true }];
}

/**
 * The time of the newest `turn` event, read from the end of the file, or `null` for a store that is absent or holds none. It is the newest by `at`, not the last on the file: one
 * ingest appends its transcripts in directory order, so the last line is not the latest turn. A line that does not parse is the one a writer is in the middle of.
 *
 * A READING OLDER THAN THE WINDOW IS NOT AN ANSWER (a11ign/agent-org#709). Right after a cold start (a `STATE_VERSION` move, a lost state file) the ingest has re-appended every transcript
 * in directory order, so the file's END holds whichever transcripts came last and may be two days old while the newest turn of the store is minutes old on the first line. The read
 * therefore goes on, one chunk further back, until a turn INSIDE the window turns up or the file is exhausted, and `TAIL_LAST_BYTES` is the size of the largest chunk and not a stop.
 * A genuinely stale store reads all of itself (each byte once) and returns the newest it saw; a healthy one stops in the first chunk.
 */
export function newestTurnAt(storePath: string, now: number = Date.now()): number | null {
  if (!existsSync(storePath)) return null;
  const inWindow = now - STALE_AFTER_MS;
  let newest: number | null = null;
  for (const lines of linesFromEnd(storePath)) {
    for (const line of lines) {
      if (!line.includes(TURN_KIND)) continue;
      try {
        const { at } = JSON.parse(line);
        if (typeof at === "number" && (newest === null || at > newest)) newest = at;
      } catch {
        // the line being written
      }
    }
    if (newest !== null && newest >= inWindow) return newest;
  }
  return newest;
}

/**
 * The whole lines of a store, a chunk at a time from its END: each yield is one chunk's lines in file order, the newest chunk first. A chunk that does not begin the file begins
 * in the middle of a line, which the chunk before it finishes, so a line is yielded only whole. Stopping early closes the file.
 */
function* linesFromEnd(storePath: string): Generator<string[]> {
  const fd = openSync(storePath, "r");
  try {
    let end = fstatSync(fd).size;
    let carry: Buffer = Buffer.alloc(0); // the head of the line the chunk after this one (nearer the end) began in the middle of
    for (let window = TAIL_FIRST_BYTES; end > 0; window = Math.min(window * 2, TAIL_LAST_BYTES)) {
      const start = Math.max(0, end - window);
      const chunk = Buffer.alloc(end - start);
      readSync(fd, chunk, 0, chunk.length, start);
      const bytes = Buffer.concat([chunk, carry]);
      const firstBreak = start > 0 ? bytes.indexOf(10) : -1; // a chunk that does not begin the file begins in the middle of a line, which the chunk before it finishes
      carry = start > 0 ? bytes.subarray(0, firstBreak < 0 ? bytes.length : firstBreak) : Buffer.alloc(0);
      const whole = start > 0 ? (firstBreak < 0 ? "" : bytes.toString("utf8", firstBreak + 1)) : bytes.toString("utf8");
      yield whole.split("\n");
      end = start;
    }
  } finally {
    closeSync(fd);
  }
}

/** Every `turn` line of the store, newest chunk first, as its time and the transcript it was built from (absent for a turn that has none). */
function* turnsFromEnd(storePath: string): Generator<{ at: number; transcript?: string }> {
  for (const lines of linesFromEnd(storePath)) {
    for (const line of lines) {
      if (!line.includes(TURN_KIND)) continue;
      let turn: any;
      try {
        turn = JSON.parse(line);
      } catch {
        continue; // the line being written
      }
      if (typeof turn?.at === "number") yield { at: turn.at, transcript: turn.transcript };
    }
  }
}

/**
 * The time of the newest message line of a transcript at or before `by`, read from its end, or `null` when the tail holds none. A message line is a Claude Code `assistant` or `user`
 * record with a timestamp of its own, or a Codex `response_item`; `last-prompt`, `cost-state`, `attachment` and the rest are bookkeeping a session rewrites after its last message. A
 * transcript is written in order, so the newest message in the tail is the last one, and a line that does not parse is the one a writer is in the middle of. A message after `by` is
 * skipped and the read goes on back, so a tail that holds only messages inside the hold-back grows to the owed message behind them.
 */
export function newestMessageAt(path: string, by: number = Infinity): number | null {
  return newestLineAt(path, by, (record) => MESSAGE_TYPES.has(record?.type))?.at ?? null;
}

/** The newest line of a transcript that `wanted` accepts and that is at or before `by`, with its time, read from the tail as `newestMessageAt` reads it; `null` when none is found. */
function newestLineAt(path: string, by: number, wanted: (record: any) => boolean): { at: number; record: any } | null {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    for (let window = TRANSCRIPT_TAIL_FIRST_BYTES; ; window *= 2) {
      const length = Math.min(size, window);
      const bytes = Buffer.alloc(length);
      readSync(fd, bytes, 0, length, size - length);
      const lines = bytes.toString("utf8").split("\n");
      if (length < size) lines.shift(); // a window that does not begin the file begins in the middle of a line
      let newest: { at: number; record: any } | null = null;
      for (const line of lines) {
        if (!line.includes("\"timestamp\"")) continue;
        try {
          const record = JSON.parse(line);
          if (!wanted(record) || typeof record.timestamp !== "string") continue;
          const at = Date.parse(record.timestamp);
          const isNewerThanNewest = !Number.isNaN(at) && at <= by && (newest === null || at > newest.at);
          if (isNewerThanNewest) newest = { at, record };
        } catch {
          // the line being written
        }
      }
      if (newest !== null || length >= size || window >= TRANSCRIPT_TAIL_LAST_BYTES) return newest;
    }
  } finally {
    closeSync(fd);
  }
}

/** A line the ingest turns into a `turn`: a Claude `assistant` line with its `message.usage` (the store builds the turn from it), or a Codex `token_usage_record` with its `response_id`. A user line, a tool's result included, makes no turn. */
const producesTurn = (record: any): boolean => (record?.type === "assistant" && !!record.message?.usage) || (record?.type === "token_usage_record" && !!record.payload?.usage && !!record.payload?.response_id);

/**
 * The message of one transcript the ingest is owed a turn for, or `null`: its newest turn-producing line at or before the ten-minute mark, when that line is inside the window.
 * The file's mtime is only the cheap filter (a message written before the window cannot be inside it); the line's own timestamp is the test.
 */
function owedOf(path: string, now: number): Owed | null {
  const since = now - OWED_AFTER_MS - OWED_WINDOW_MS;
  const modified = statSync(path, { throwIfNoEntry: false })?.mtimeMs ?? 0;
  if (modified < since) return null;
  let found: { at: number; record: any } | null;
  try {
    found = newestLineAt(path, now - OWED_AFTER_MS, producesTurn);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException)?.code === "ENOENT") return null; // gone between the listing and the read
    throw cause;
  }
  if (found === null || found.at < since) return null;
  // a Claude transcript's turns are keyed by the file's name (store.ts `transcriptId`); a Codex rollout's by its uuid, and one with no uuid has no key and is not owed
  const transcript = found.record.type === "assistant" ? basename(path, ".jsonl") : rolloutId(path);
  return transcript ? { transcript, at: found.at } : null;
}

/** Every `.jsonl` a root holds at its depth, as `sessionsWorking` walks them; an optional root that is absent holds none. */
function* transcriptPaths(roots: TranscriptRoot[]): Generator<string> {
  const walk = function* (dir: string, depth: number): Generator<string> {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (depth > 0) {
        if (entry.isDirectory()) yield* walk(path, depth - 1);
      } else if (entry.name.endsWith(".jsonl")) {
        yield path;
      }
    }
  };
  for (const { dir, depth, optional } of roots) {
    if (optional && !existsSync(dir)) continue;
    yield* walk(dir, depth);
  }
}

/** The messages the ingest is owed a turn for, one at most per transcript: the newest owed message of each transcript under `roots` (see `owedOf`). */
export function owedTurns({ roots, now }: { roots: TranscriptRoot[]; now: number; }): Owed[] {
  const owed: Owed[] = [];
  for (const path of transcriptPaths(roots)) {
    const message = owedOf(path, now);
    if (message !== null) owed.push(message);
  }
  return owed;
}

/**
 * The owed messages the store has no turn for: each transcript's turn is looked for from the store's end, until a turn of that transcript at or after its owed message turns up
 * (a turn is built from the transcript's last line of the message, so it is never older than the message), or the store is exhausted. A store that is absent holds none of them.
 */
export function unmetOwed(storePath: string, owed: Owed[]): Owed[] {
  const unmet = new Map(owed.map((message) => [message.transcript, message]));
  if (unmet.size > 0 && existsSync(storePath)) {
    for (const turn of turnsFromEnd(storePath)) {
      const message = turn.transcript === undefined ? undefined : unmet.get(turn.transcript);
      if (message !== undefined && turn.at >= message.at) unmet.delete(message.transcript);
      if (unmet.size === 0) break;
    }
  }
  return [...unmet.values()];
}

/**
 * Whether any session is working: a `.jsonl` exactly `depth` directories under a root that holds a message line inside the window AND past the hold-back, `QUIET_MS` old or
 * more, which is the one the ingest is owed a turn for. A message younger than that is held back by design and is not evidence of anything. A file not modified inside the window
 * cannot hold such a line, so it is not opened; one that was modified is opened, because a modification alone is not a message. A root that is not optional and cannot be read THROWS:
 * "could not tell whether anyone is working" is never reported as "nobody is".
 */
export function sessionsWorking({ roots, now, windowMs = STALE_AFTER_MS }: { roots: TranscriptRoot[]; now: number; windowMs?: number; }): boolean {
  const since = now - windowMs;
  const wroteSettledMessage = (path: string): boolean => {
    const modified = statSync(path, { throwIfNoEntry: false })?.mtimeMs ?? 0;
    if (modified < since) return false;
    try {
      return (newestMessageAt(path, now - QUIET_MS) ?? 0) >= since;
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException)?.code === "ENOENT") return false; // gone between the listing and the read: no message in the window; any other refusal is "could not tell"
      throw cause;
    }
  };
  const written = (dir: string, depth: number): boolean => readdirSync(dir, { withFileTypes: true }).some((entry) => {
    const path = join(dir, entry.name);
    if (depth > 0) return entry.isDirectory() && written(path, depth - 1);
    return entry.name.endsWith(".jsonl") && wroteSettledMessage(path);
  });
  return roots.some(({ dir, depth, optional }) => (optional && !existsSync(dir) ? false : written(dir, depth)));
}

/** Stale is an owed message with no turn (`unmet`, see the header). `ageMs` is `null` for a store with no turn at all; that alone is not stale, since an owed message is what makes it so. */
export function storeFreshness({ storePath, now, roots }: { storePath: string; now: number; roots: TranscriptRoot[]; }): Freshness {
  const newest = newestTurnAt(storePath, now);
  const ageMs = newest === null ? null : Math.max(0, now - newest);
  const unmet = unmetOwed(storePath, owedTurns({ roots, now }));
  return { newestTurnAt: newest, ageMs, working: sessionsWorking({ roots, now }), unmet, stale: unmet.length > 0 };
}

const minutesOf = (ms: number) => Math.floor(ms / MS_PER_MINUTE);
const howLong = (ms: number) => (minutesOf(ms) >= MINUTES_PER_HOUR ? `${Math.floor(minutesOf(ms) / MINUTES_PER_HOUR)}h ${minutesOf(ms) % MINUTES_PER_HOUR}m` : `${minutesOf(ms)}m`);

/** The one line `trace -- --freshness` and the unit print. */
export function freshnessLine(reading: Freshness): string {
  const newest = reading.newestTurnAt === null || reading.ageMs === null ? "the store holds no turn event" : `newest turn ${new Date(reading.newestTurnAt).toISOString()} (${howLong(reading.ageMs)} ago)`;
  const span = `written in the last ${minutesOf(STALE_AFTER_MS)} minutes and past the ${minutesOf(QUIET_MS)}-minute hold-back`;
  const who = reading.working ? `a session is working (a message ${span})` : `no session is working (no message ${span})`;
  const oldest = reading.unmet.reduce((min, message) => Math.min(min, message.at), Infinity);
  const stale = reading.unmet.length === 0 ? "not stale" : `STALE (${reading.unmet.length} message${reading.unmet.length === 1 ? "" : "s"} owed a turn ${reading.unmet.length === 1 ? "has" : "have"} none; the oldest is from ${new Date(oldest).toISOString()})`;
  return `trace store: ${newest}; ${who}: ${stale}`;
}

export const NO_EPISODE: Episode = Object.freeze({ open: false, since: null, commented: false, ordered: false });

/**
 * PURE. The episode after this reading. A stale store (an owed message with no turn) opens one, once: an open episode stays as it is, `since` and the effects already sent included.
 * A store that is not stale and has a turn inside the window ends it. Otherwise the reading changes nothing: a quiet store with no owed message is neither an incident nor its end.
 */
export function advance(previous: Episode, reading: Freshness, now: number): Episode {
  if (reading.stale) return previous.open ? previous : { open: true, since: now, commented: false, ordered: false };
  if (reading.ageMs !== null && reading.ageMs <= STALE_AFTER_MS) return NO_EPISODE;
  return previous;
}

/** The comment on the standing row: a marker line first, so a reader can find the episode, then what to look at. */
export function incidentComment(reading: Freshness, since: number): string {
  return `<!-- trace-freshness: stale since ${new Date(since).toISOString()} -->\n`
    + `**The trace store is stale** (class \`${INCIDENT_CLASS}\`, ${homeProjectDeclaration().tracker[0].repo}#4437). ${freshnessLine(reading)}.\n\n`
    + "Look at `systemctl --user status a11ign-trace-ingest.service` and `journalctl --user -u a11ign-trace-ingest.service -n 50`, and run `trace -- --freshness`. "
    + `The ingest runs every five minutes, so this is posted once for the episode and not again until the store has turned what it is owed, has been current since, and has gone stale again.`;
}

/** The order to the owning seat, whose `Class:` line is the one `prompt:session` records it under. */
export function incidentOrder(reading: Freshness, since: number): string {
  return `Class: ${INCIDENT_CLASS}\n\n`
    + `The trace store has stopped being written (stale since ${new Date(since).toISOString()}). ${freshnessLine(reading)}.\n\n`
    + `It is yours as the owning seat (chairman, ${homeProjectDeclaration().tracker[0].repo}#4437: "restore ingest and backfill"). Read \`journalctl --user -u a11ign-trace-ingest.service -n 50\` for why the ingest is not landing turns, `
    + `and say what you found on #${INCIDENT_ROW}. You are told once for this episode; the unit stays quiet until the store has recovered and gone stale again.`;
}

/** Each effect may be async and may throw; a refusal is the effect's own to name. */
export type Effects = { comment: (body: string) => void | Promise<void>; order: (text: string) => void | Promise<void>; log: (line: string) => void };

const firstLine = (cause: unknown): string => String((cause as Error)?.message ?? cause).split("\n")[0].slice(0, 200);

/** Whether the effect landed. A refusal is reported and returned, never thrown: the other effect and the state write still happen. */
async function landed(what: string, send: () => void | Promise<void>, log: (line: string) => void): Promise<boolean> {
  try {
    await send();
    return true;
  } catch (cause) {
    log(`trace freshness: the ${what} was refused (${firstLine(cause)}); it is tried again next run`);
    return false;
  }
}

/** The episode's file: beside the store, named for it, so a scratch store has a scratch episode. */
export const episodeFileFor = (storePath: string) => `${storePath}.freshness-episode.json`;

function readEpisode(path: string, log: (line: string) => void): Episode {
  if (!existsSync(path)) return NO_EPISODE;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (typeof parsed?.open !== "boolean" || typeof parsed.commented !== "boolean" || typeof parsed.ordered !== "boolean") throw new Error("not an episode record");
    return parsed;
  } catch (cause) {
    log(`trace freshness: ${path} could not be read (${firstLine(cause)}); the episode starts afresh, so an open one may be raised a second time`);
    return NO_EPISODE;
  }
}

/** Written to a sibling and renamed, as `ingest-state.ts` writes its own: a run killed mid-write leaves the old record. */
function writeEpisode(path: string, episode: Episode) {
  mkdirSync(dirname(path), { recursive: true });
  const partial = `${path}.${process.pid}.tmp`;
  writeFileSync(partial, JSON.stringify(episode));
  renameSync(partial, path);
}

/**
 * ONE CHECK: the episode this reading leaves, written BEFORE the effects (a run killed between the two raises it again, and does not lose it), then each effect that has not landed,
 * then the episode with what landed. `raised` names the effects sent this run.
 */
export async function checkAndRaise({ storePath, now, roots, effects }: { storePath: string; now: number; roots: TranscriptRoot[]; effects: Effects; }): Promise<{ reading: Freshness; episode: Episode; raised: string[]; }> {
  const reading = storeFreshness({ storePath, now, roots });
  const path = episodeFileFor(storePath);
  const episode = advance(readEpisode(path, effects.log), reading, now);
  writeEpisode(path, episode);
  if (!episode.open || episode.since === null) return { reading, episode, raised: [] };
  const raised: string[] = [];
  const commented = episode.commented || await landed(`comment on #${INCIDENT_ROW}`, () => effects.comment(incidentComment(reading, episode.since as number)), effects.log);
  if (commented && !episode.commented) raised.push("comment");
  const ordered = episode.ordered || await landed(`order to ${OWNER_SEAT}`, () => effects.order(incidentOrder(reading, episode.since as number)), effects.log);
  if (ordered && !episode.ordered) raised.push("order");
  const after = { ...episode, commented, ordered };
  writeEpisode(path, after);
  return { reading, episode: after, raised };
}

/**
 * The two effects against the real host: a comment through the routed `gh` (the account the unit declares), and `prompt:session`'s own delivery or queue. Everything they need is
 * imported when one runs, inside `landed`, so a declaration that cannot be read is a refused effect and the check itself has already been made and printed. Exported for its own test.
 */
export function hostEffects(log: (line: string) => void): Effects {
  return {
    log,
    comment: async (body) => {
      const { homeProjectDeclaration } = await import("../project-config.ts");
      const { rows } = await import("../plugins/rows.ts");
      const repo = homeProjectDeclaration().tracker[0].repo;
      try {
        rows().commentOnRowByInput({ repo, number: INCIDENT_ROW, body, timeoutMs: COMMENT_TIMEOUT_MS });
      } catch (cause) {
        throw new Error(`comment on ${repo}#${INCIDENT_ROW}: ${String((cause as Error).message).trim()}`, { cause });
      }
    },
    order: async (text) => {
      const { EXIT, STANCE, defaultRun, promptOrQueue } = await import("../prompt-session.ts");
      const { handoffQueuePath, ledgerPathFrom } = await import("../wake/seat-reset.ts");
const { readAgents } = await import("../herdr-agents.ts");
      // `STANCE.ORDER`: a real order that wakes its seat and asks for no answer. An undeclared or FYI order to a lead seat is HELD (`deliverOrQueue`), which an incident must not be.
      const code = promptOrQueue({ run: defaultRun, label: OWNER_SEAT, text, agents: readAgents(defaultRun), path: handoffQueuePath(ledgerPathFrom(process.argv)), stance: STANCE.ORDER, sender: SENDER });
      if (code !== EXIT.OK && code !== EXIT.QUEUED) throw new Error(`prompt:session refused the order to ${OWNER_SEAT} (exit ${code}); nothing holds it`);
    },
  };
}

/**
 * ONE RUN OF THE UNIT: the clock is read ONCE, BEFORE the ingest, and that reading is the `now` of `storeFreshness` (a11ign/agent-org#1091). The ingest
 * holds a message back against the clock it started on, so a message is "owed a turn" only if it was `OWED_AFTER_MS` old at THAT reading. A `now` taken after the ingest returns is later by
 * what the ingest took, and a message that was held back by design (4:58 old at the start) is 5:18 old at the check and is counted as owed: a false STALE for a session that spoke once after
 * a quiet spell, whose worst-case turn latency (the hold-back plus the five-minute timer) is already the whole ten-minute window. The reading is therefore as of the ingest's start; an
 * ingest that runs long makes it older, and the next run, five minutes on, reads again. `clock` and `ingest` are injected so a test can move time during the ingest.
 */
export async function ingestThenCheck<Ingested>({ storePath, roots, effects, ingest, clock = Date.now }: { storePath: string; roots: TranscriptRoot[]; effects: Effects; ingest: () => Ingested; clock?: () => number; }): Promise<{ reading: Freshness; raised: string[]; ingested: Ingested; }> {
  const now = clock();
  const ingested = ingest();
  const { reading, raised } = await checkAndRaise({ storePath, now, roots, effects });
  return { reading, raised, ingested };
}

/** The unit: ingest, then check. The exit code is the ingest's, so a unit that cannot ingest shows FAILED; a stale store is reported by the incident and is not a failed unit. */
async function main() {
  const given = process.argv.slice(2).filter((word) => word !== "--");
  const store = given.indexOf("--store");
  const { defaultStore } = await import("./otel-receiver.ts");
  const storePath = store >= 0 ? given[store + 1] : defaultStore();
  const log = (line: string) => process.stderr.write(`${line}\n`);
  const { reading, raised, ingested: ingest } = await ingestThenCheck({
    storePath, roots: transcriptRoots(), effects: hostEffects(log),
    ingest: () => spawnSync(process.execPath, [TRACE, "--", "--ingest", "--store", storePath], { stdio: "inherit", timeout: INGEST_TIMEOUT_MS }),
  });
  process.stdout.write(`${freshnessLine(reading)}${raised.length > 0 ? `; raised: ${raised.join(", ")}` : ""}\n`);
  if (ingest.error || ingest.status !== 0) {
    log(`trace freshness: the ingest ${ingest.error ? `could not run (${ingest.error.message})` : `exited ${ingest.status ?? `by ${ingest.signal}`}`}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) await main();
