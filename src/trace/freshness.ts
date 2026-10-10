#!/usr/bin/env node
// a11ign/agent-org#498: IS THE TRACE STORE CURRENT, AND WHO IS TOLD WHEN IT IS NOT (chairman, a11ign/a11ign#4437, class `metrics-outage`: "a trace-freshness signal. If no
// `turn` event lands for 10 minutes while any session is working, raise an incident to the owning seat").
//
// WHY A CLOCK OF ITS OWN. The transcripts reached the store only as a side effect of a `trace` command that reads it, and the one unit that runs one on a clock, the pages
// publisher, regenerates only when a head of `main` moved or its last publication is an hour old. So the store's freshness was the cadence of merges, and a quiet hour was a
// blind hour. `a11ign-trace-ingest.timer` runs THIS FILE every five minutes: it ingests (`trace -- --ingest`, in a child, so a failing ingest cannot stop the check that follows
// it) and then asks the question below.
//
// "WORKING" IS A TRANSCRIPT THAT GAINED A MESSAGE INSIDE THE WINDOW, which needs no GitHub call: nobody working means silence is not an outage, and the same eleven-minute-old store with
// every transcript quiet for an hour is NOT stale. A TOUCHED FILE IS NOT A MESSAGE (a11ign/a11ign#928, three false incidents on 2026-10-10): a session that has finished its last message
// still rewrites its `last-prompt` and `cost-state` lines, which carry no timestamp and no message, so its file moves while it produces no turn. The test is therefore the timestamp of the
// newest `assistant`/`user` line (a Codex rollout's `response_item`), and the file's mtime is only the cheap "could it hold one" filter in front of reading it.
// THE NEWEST MESSAGE AND THE NEWEST TURN ARE BOTH READ FROM THE TAIL of the file, not from all of it: the store is 537 MB and the question is asked every five minutes. The turn read goes
// back past the tail only while what it has found is older than the window (a11ign/agent-org#709: after a cold start the file's end holds the oldest turns).
//
// A KNOWN EDGE, measured from the code and not from a run: a turn is held back until its message is `QUIET_MS` (5 minutes) old and then waits for the next ingest, so a turn can be up to
// ten minutes behind its transcript in a HEALTHY store. The check runs right after an ingest, when the lag is the five minutes of quiet and no more, so a healthy store reads about five
// minutes old; a single tool call longer than ten minutes that is the only thing running can still read as stale, and that is one incident per episode, never one per run.
//
// ONE INCIDENT PER EPISODE. An episode OPENS the first run the store is stale and ENDS only when a `turn` is inside the window again: a run that finds the store old and nobody
// working changes nothing, so an outage that spans a quiet hour is one incident and not two. Each of the two effects (the comment on the standing row, the order to the owning seat)
// is remembered separately and a REFUSED one is tried again next run, so a failed `gh` neither loses the incident nor sends the order twice.
import { spawnSync } from "node:child_process";
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** The chairman's number: no `turn` for this long while a session is working. Also how recent a transcript's newest message must be to count as working. */
export const STALE_AFTER_MS = 10 * 60 * 1000;
const MS_PER_MINUTE = 60 * 1000;
const MINUTES_PER_HOUR = 60;
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
/** `prompt:session` records an order under the `Class:` line it carries; this is the chairman's class for the outage. */
export const INCIDENT_CLASS = "metrics-outage";
/** The name the order is attributed to: a host unit is not a session, and an order with no sender is counted as an unidentified caller (the proxy for a chairman correction). */
export const SENDER = "a11ign-trace-ingest.service";

export type TranscriptRoot = { dir: string; depth: number; optional?: boolean };
export type Freshness = { newestTurnAt: number | null; ageMs: number | null; working: boolean; stale: boolean };
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
  const fd = openSync(storePath, "r");
  try {
    let newest: number | null = null;
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
      for (const line of whole.split("\n")) {
        if (!line.includes(TURN_KIND)) continue;
        try {
          const { at } = JSON.parse(line);
          if (typeof at === "number" && (newest === null || at > newest)) newest = at;
        } catch {
          // the line being written
        }
      }
      if (newest !== null && newest >= inWindow) return newest;
      end = start;
    }
    return newest;
  } finally {
    closeSync(fd);
  }
}

/**
 * The time of the newest message line of a transcript, read from its end, or `null` when the tail holds none. A message line is a Claude Code `assistant` or `user` record with a
 * timestamp of its own, or a Codex `response_item`; `last-prompt`, `cost-state`, `attachment` and the rest are bookkeeping a session rewrites after its last message. A transcript is
 * written in order, so the newest message in the tail is the last one, and a line that does not parse is the one a writer is in the middle of.
 */
export function newestMessageAt(path: string): number | null {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    for (let window = TRANSCRIPT_TAIL_FIRST_BYTES; ; window *= 2) {
      const length = Math.min(size, window);
      const bytes = Buffer.alloc(length);
      readSync(fd, bytes, 0, length, size - length);
      const lines = bytes.toString("utf8").split("\n");
      if (length < size) lines.shift(); // a window that does not begin the file begins in the middle of a line
      let newest: number | null = null;
      for (const line of lines) {
        if (!line.includes("\"timestamp\"")) continue;
        try {
          const record = JSON.parse(line);
          if (!MESSAGE_TYPES.has(record?.type) || typeof record.timestamp !== "string") continue;
          const at = Date.parse(record.timestamp);
          if (!Number.isNaN(at) && (newest === null || at > newest)) newest = at;
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

/**
 * Whether any session is working: a `.jsonl` exactly `depth` directories under a root whose newest message line is inside the window. A file not modified inside the window cannot
 * hold such a line, so it is not opened; one that was modified is opened, because a modification alone is not a message. A root that is not optional and cannot be read THROWS: "could
 * not tell whether anyone is working" is never reported as "nobody is".
 */
export function sessionsWorking({ roots, now, windowMs = STALE_AFTER_MS }: { roots: TranscriptRoot[]; now: number; windowMs?: number; }): boolean {
  const since = now - windowMs;
  const wroteMessage = (path: string): boolean => {
    const modified = statSync(path, { throwIfNoEntry: false })?.mtimeMs ?? 0;
    if (modified < since) return false;
    try {
      return (newestMessageAt(path) ?? 0) >= since;
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException)?.code === "ENOENT") return false; // gone between the listing and the read: no message in the window; any other refusal is "could not tell"
      throw cause;
    }
  };
  const written = (dir: string, depth: number): boolean => readdirSync(dir, { withFileTypes: true }).some((entry) => {
    const path = join(dir, entry.name);
    if (depth > 0) return entry.isDirectory() && written(path, depth - 1);
    return entry.name.endsWith(".jsonl") && wroteMessage(path);
  });
  return roots.some(({ dir, depth, optional }) => (optional && !existsSync(dir) ? false : written(dir, depth)));
}

/** Stale is old AND somebody working. `ageMs` is `null` for a store with no turn at all, which is older than any window and so stale while anyone is working. */
export function storeFreshness({ storePath, now, working }: { storePath: string; now: number; working: boolean; }): Freshness {
  const newest = newestTurnAt(storePath, now);
  const ageMs = newest === null ? null : Math.max(0, now - newest);
  return { newestTurnAt: newest, ageMs, working, stale: working && (ageMs === null || ageMs > STALE_AFTER_MS) };
}

const minutesOf = (ms: number) => Math.floor(ms / MS_PER_MINUTE);
const howLong = (ms: number) => (minutesOf(ms) >= MINUTES_PER_HOUR ? `${Math.floor(minutesOf(ms) / MINUTES_PER_HOUR)}h ${minutesOf(ms) % MINUTES_PER_HOUR}m` : `${minutesOf(ms)}m`);

/** The one line `trace -- --freshness` and the unit print. */
export function freshnessLine(reading: Freshness): string {
  const newest = reading.newestTurnAt === null || reading.ageMs === null ? "the store holds no turn event" : `newest turn ${new Date(reading.newestTurnAt).toISOString()} (${howLong(reading.ageMs)} ago)`;
  const who = reading.working ? `a session is working (a message was written in the last ${minutesOf(STALE_AFTER_MS)} minutes)` : "no session is working";
  return `trace store: ${newest}; ${who}: ${reading.stale ? `STALE (no turn for ${minutesOf(STALE_AFTER_MS)} minutes while a session works)` : "not stale"}`;
}

export const NO_EPISODE: Episode = Object.freeze({ open: false, since: null, commented: false, ordered: false });

/**
 * PURE. The episode after this reading. A turn inside the window ends it. Old with nobody working changes nothing (it neither opens one nor closes the one that is open).
 * Old with somebody working opens one, once: an open episode stays as it is, `since` and the effects already sent included.
 */
export function advance(previous: Episode, reading: Freshness, now: number): Episode {
  if (reading.ageMs !== null && reading.ageMs <= STALE_AFTER_MS) return NO_EPISODE;
  if (!reading.stale) return previous;
  return previous.open ? previous : { open: true, since: now, commented: false, ordered: false };
}

/** The comment on the standing row: a marker line first, so a reader can find the episode, then what to look at. */
export function incidentComment(reading: Freshness, since: number): string {
  return `<!-- trace-freshness: stale since ${new Date(since).toISOString()} -->\n`
    + `**The trace store is stale** (class \`${INCIDENT_CLASS}\`, a11ign/a11ign#4437). ${freshnessLine(reading)}.\n\n`
    + "Look at `systemctl --user status a11ign-trace-ingest.service` and `journalctl --user -u a11ign-trace-ingest.service -n 50`, and run `trace -- --freshness`. "
    + `The ingest runs every five minutes, so this is posted once for the episode and not again until the store has had a turn inside ${minutesOf(STALE_AFTER_MS)} minutes and has gone stale after that.`;
}

/** The order to the owning seat, whose `Class:` line is the one `prompt:session` records it under. */
export function incidentOrder(reading: Freshness, since: number): string {
  return `Class: ${INCIDENT_CLASS}\n\n`
    + `The trace store has stopped being written (stale since ${new Date(since).toISOString()}). ${freshnessLine(reading)}.\n\n`
    + `It is yours as the owning seat (chairman, a11ign/a11ign#4437: "restore ingest and backfill"). Read \`journalctl --user -u a11ign-trace-ingest.service -n 50\` for why the ingest is not landing turns, `
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
export async function checkAndRaise({ storePath, now, working, effects }: { storePath: string; now: number; working: boolean; effects: Effects; }): Promise<{ reading: Freshness; episode: Episode; raised: string[]; }> {
  const reading = storeFreshness({ storePath, now, working });
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
 * imported when one runs, inside `landed`, so a declaration that cannot be read is a refused effect and the check itself has already been made and printed.
 */
function hostEffects(log: (line: string) => void): Effects {
  return {
    log,
    comment: async (body) => {
      const { homeProjectDeclaration } = await import("../project-config.ts");
      const repo = homeProjectDeclaration().tracker[0].repo;
      const ran = spawnSync("gh", ["issue", "comment", INCIDENT_ROW, "--repo", repo, "--body-file", "-"], { input: body, encoding: "utf8", timeout: 60_000 });
      if (ran.error || ran.status !== 0) throw new Error(`gh issue comment ${INCIDENT_ROW} --repo ${repo}: ${ran.error?.message ?? (ran.stderr || `exit ${ran.status}`).trim()}`);
    },
    order: async (text) => {
      const { EXIT, STANCE, defaultRun, promptOrQueue } = await import("../prompt-session.ts");
      const { handoffQueuePath, ledgerPathFrom, readAgents } = await import("../wake.ts");
      // `STANCE.ORDER`: a real order that wakes its seat and asks for no answer. An undeclared or FYI order to a lead seat is HELD (`deliverOrQueue`), which an incident must not be.
      const code = promptOrQueue({ run: defaultRun, label: OWNER_SEAT, text, agents: readAgents(defaultRun), path: handoffQueuePath(ledgerPathFrom(process.argv)), stance: STANCE.ORDER, sender: SENDER });
      if (code !== EXIT.OK && code !== EXIT.QUEUED) throw new Error(`prompt:session refused the order to ${OWNER_SEAT} (exit ${code}); nothing holds it`);
    },
  };
}

/** The unit: ingest, then check. The exit code is the ingest's, so a unit that cannot ingest shows FAILED; a stale store is reported by the incident and is not a failed unit. */
async function main() {
  const given = process.argv.slice(2).filter((word) => word !== "--");
  const store = given.indexOf("--store");
  const { defaultStore } = await import("./otel-receiver.ts");
  const storePath = store >= 0 ? given[store + 1] : defaultStore();
  const ingest = spawnSync(process.execPath, [TRACE, "--", "--ingest", "--store", storePath], { stdio: "inherit", timeout: INGEST_TIMEOUT_MS });
  const now = Date.now();
  const log = (line: string) => process.stderr.write(`${line}\n`);
  const { reading, raised } = await checkAndRaise({ storePath, now, working: sessionsWorking({ roots: transcriptRoots(), now }), effects: hostEffects(log) });
  process.stdout.write(`${freshnessLine(reading)}${raised.length > 0 ? `; raised: ${raised.join(", ")}` : ""}\n`);
  if (ingest.error || ingest.status !== 0) {
    log(`trace freshness: the ingest ${ingest.error ? `could not run (${ingest.error.message})` : `exited ${ingest.status ?? `by ${ingest.signal}`}`}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) await main();
