// @ts-check
// module: a ticket's readiness score (A11-443, F4) -- a cheap model scores how ready a ticket is to be worked unattended, and the score is kept by the description's hash
//
// OFF UNLESS `tickets.readiness` IS TRUE: the feature ships off and turns on only when the offline check (the plan's step 2) shows low scores go with more rounds, re-plans or Needs-you.
//
// AT MOST ONE MODEL CALL PER DESCRIPTION. A score is kept in `<stateDir>/tickets/readiness.json` with the hash of the description it was made from (`descriptionHash`, the one every brief
// stamps with). A ticket whose description hashes the same is answered from the file and the model is not asked. A call that fails is kept too, by the same hash: it is not tried again until
// the description changes, so a model that is down costs one call per ticket, not one per page read. A call already under way for that hash is never started twice.
// A kept file that is there but cannot be read fails closed: every ticket is answered `failed` with why, the model is not asked and the file is not written, so a broken file never costs a
// second call for a description already scored, nor loses the scores it holds. Only a missing file means nothing is scored yet.
//
// THE PAGE NEVER WAITS FOR THE MODEL. A ticket with no score for its description is answered `pending` at once, and its call starts in the background, at most READINESS_PARALLEL at a time;
// the page asks again while any is pending. The model runs under `execFile` (`realExecAsync`), so the board's loop is never held.
//
// IT ONLY ADVISES. Nothing reads a score to hold a ticket back from the queue (the ticket's out of scope).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ExecResult } from "../plugins/manifest.ts";
import type { Json } from "./local-http.ts";
import { objectIn, replyOf } from "./retro/retro-prompt.ts";
import { askHeadless, type ClaudeBounds } from "./headless-claude.ts";
import { realExecAsync } from "../plugins/real-seams.ts";
import type { Ticket } from "./source.ts";
import { descriptionHash } from "./ticket-read.ts";

/** The longest one score may take before its run is cut. */
const READINESS_TIMEOUT_MS = 120_000;

/** The cheap model a ticket is scored with, the most one score may spend, and how long it may take. */
export const READINESS_BOUNDS: ClaudeBounds = { model: "haiku", maxBudgetUsd: 0.1, timeoutMs: READINESS_TIMEOUT_MS };

/** A score under this is low: the page shows its reasons and offers the writer. */
export const LOW_READINESS = 60;

/** How many scores are asked of the model at once. */
const READINESS_PARALLEL = 2;

/** The most reasons a score keeps, and the longest each is kept. */
const MAX_REASONS = 3;
const REASON_CHARS = 200;

/** The longest part of a description the model is given: a longer one is cut, and the score is still kept by the whole description's hash. */
const DESCRIPTION_CHARS = 20_000;

/** A score as it is kept: the hash of the description it was made from, the score (0 to 100) and its reasons, or the reason it could not be made; and when. */
export type ReadinessRecord = Readonly<{ hash: string; at: number } & ({ score: number; reasons: readonly string[] } | { failed: string })>;

/** One ticket's readiness as the page is told it. */
export type ReadinessView = Readonly<{ state: "scored"; score: number; reasons: readonly string[]; low: boolean } | { state: "pending" } | { state: "failed"; reason: string }>;

/** What `POST /api/readiness` answers: whether the feature is on, and each named ticket's readiness. A ticket the page has no copy of is left out. */
export type ReadinessAnswer = Readonly<{ on: boolean; scores: Readonly<Record<string, ReadinessView>> }>;

export type ReadinessDeps = Readonly<{
  stateDir: string;
  /** Ask the model `prompt`, headless: the board's is `askClaude` with {@link READINESS_BOUNDS}. */
  ask: (prompt: string) => Promise<ExecResult>;
  now: () => number;
  log: (line: string) => void;
}>;

/** The file the scores are kept in. */
export const readinessPath = (stateDir: string): string => join(stateDir, "tickets", "readiness.json");

/** The kept scores, by ticket key, or why the file that holds them cannot be read. */
type KeptRecords = Readonly<{ records: Map<string, ReadinessRecord> } | { unreadable: string }>;

/** Whether `value` is a plain object, as the file's `scores` must be. PURE. */
const isPlainObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The kept scores, by ticket key. A missing file is none: nothing has been scored yet. A file that is there but cannot be read, or does not hold `{ scores: {...} }`, FAILS CLOSED: it is
 * answered `unreadable`, so the scorer neither asks the model again for scores it may already hold nor writes over the file (A11-443 review of #2062).
 */
function readRecords(stateDir: string): KeptRecords {
  const path = readinessPath(stateDir);
  if (!existsSync(path)) return { records: new Map() };
  try {
    const kept = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!isPlainObject(kept) || !isPlainObject(kept.scores ?? {})) return { unreadable: `${path} does not hold { "scores": { ... } }` };
    return { records: new Map(Object.entries((kept.scores ?? {}) as Record<string, ReadinessRecord>)) };
  } catch (error) {
    return { unreadable: `${path} cannot be read: ${(error as Error).message}`.slice(0, REASON_CHARS) };
  }
}

function writeRecords(stateDir: string, records: ReadonlyMap<string, ReadinessRecord>): void {
  const path = readinessPath(stateDir);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ scores: Object.fromEntries(records) })}\n`);
}

/** What the model is asked about `ticket`: the three things a ticket needs to be worked unattended, and the ticket. PURE. */
export function readinessPrompt(ticket: Pick<Ticket, "key" | "title" | "project" | "description">): string {
  return [
    "You score how ready a ticket is for a coding agent to build it unattended, with nobody to answer its questions.",
    "Check three things:",
    "1. Acceptance criteria: the ticket says how to tell it is done, in terms a test or a check can prove.",
    "2. Scope: what is in and what is out is clear enough that two people would build the same thing.",
    "3. Repository: the codebase the work lands in is named, in the description or by the project.",
    "",
    `Answer with JSON only, no prose: {"score": <0 to 100, where 100 is ready to build>, "reasons": ["<what is missing or vague, one short sentence each>"]}. Give at most ${MAX_REASONS} reasons, and none when nothing is missing.`,
    "",
    `Ticket ${ticket.key}: ${ticket.title}`,
    `Project: ${ticket.project ?? "(none)"}`,
    "Description:",
    ticket.description.slice(0, DESCRIPTION_CHARS),
  ].join("\n");
}

/** The highest score: a ticket ready to build. */
const MAX_SCORE = 100;

/** Whether the model's answer is an object with a finite number for its score. PURE. */
function holdsScore(answer: { score?: unknown; reasons?: unknown } | null): answer is { score: number; reasons?: unknown } {
  return answer !== null && typeof answer === "object" && typeof answer.score === "number" && Number.isFinite(answer.score);
}

/** The score and reasons in the model's `reply`, checked: a whole number from 0 to 100, and at most {@link MAX_REASONS} reasons, each on one line. Null when the reply holds no score. PURE. */
export function scoreOf(reply: string): { score: number; reasons: string[] } | null {
  const answer = objectIn(reply) as { score?: unknown; reasons?: unknown } | null;
  if (!holdsScore(answer)) return null;
  const score = Math.min(MAX_SCORE, Math.max(0, Math.round(answer.score)));
  const listed = Array.isArray(answer.reasons) ? answer.reasons : [];
  const reasons = listed.filter((reason): reason is string => typeof reason === "string").map((reason) => reason.replace(/\s+/g, " ").trim().slice(0, REASON_CHARS)).filter(Boolean);
  return { score, reasons: reasons.slice(0, MAX_REASONS) };
}

/** A kept record as the page is told it. PURE. */
function viewOf(record: ReadinessRecord): ReadinessView {
  if ("failed" in record) return { state: "failed", reason: record.failed };
  return { state: "scored", score: record.score, reasons: record.reasons, low: record.score < LOW_READINESS };
}

/** The first line of what a failed run said, for its kept reason. PURE. */
const failureOf = (answer: ExecResult): string => `the model's answer could not be read (exit ${String(answer.status)}): ${(answer.stderr || answer.stdout).trim().split("\n")[0] ?? ""}`.slice(0, REASON_CHARS);

/**
 * The kept scores, read once; or, while the file cannot be read, why. An unreadable file is read again on the next load (nothing is kept from it), so a file put right is used without a
 * restart, and until then the scorer asks nothing of the model and writes nothing. The unreadable file is said once per reason, not on every page read.
 */
function keptScores(deps: Pick<ReadinessDeps, "stateDir" | "log">) {
  let records: Map<string, ReadinessRecord> | null = null;
  let saidUnreadable: string | null = null;
  function load(): KeptRecords {
    if (records !== null) return { records };
    const read = readRecords(deps.stateDir);
    if ("records" in read) records = read.records;
    else if (saidUnreadable !== read.unreadable) {
      saidUnreadable = read.unreadable;
      deps.log(`the readiness scores are not used, and none is asked for or written, until the file is put right or removed: ${read.unreadable}`);
    }
    return read;
  }
  /** The kept scores, once {@link load} has read them: the scorer only keeps a score after a load that succeeded, so this never runs before one. */
  function loaded(): Map<string, ReadinessRecord> {
    if (records === null) throw new Error("the readiness scores were kept to before the file was read");
    return records;
  }
  return { load, loaded };
}

/** The scorer the board keeps for its life: what it has kept, read once from the file, and the calls under way. */
export function createReadiness(deps: ReadinessDeps) {
  const store = keptScores(deps);
  const kept = store.loaded;
  /** The calls under way and waiting, each by `<key> <hash>`, so one description is never asked twice at once. */
  const asked = new Set<string>();
  /** The hash of each ticket's latest description asked for: an answer for an older one, which ends after the newer one's, is dropped rather than kept over it. */
  const latest = new Map<string, string>();
  const waiting: Ticket[] = [];
  const settling = new Set<Promise<void>>();
  let running = 0;

  function keep(key: string, record: ReadinessRecord): void {
    kept().set(key, record);
    writeRecords(deps.stateDir, kept());
  }

  async function score(ticket: Ticket, hash: string): Promise<void> {
    let answer: ExecResult;
    try {
      answer = await deps.ask(readinessPrompt(ticket));
    } catch (error) {
      answer = { status: null, stdout: "", stderr: (error as Error).message };
    }
    const reply = answer.status === 0 ? replyOf(answer.stdout) : null;
    const scored = reply === null ? null : scoreOf(reply);
    if (latest.get(ticket.key) !== hash) return;
    if (scored === null) deps.log(`the readiness of ${ticket.key} could not be scored: ${failureOf(answer)}`);
    keep(ticket.key, { hash, at: deps.now(), ...(scored ?? { failed: failureOf(answer) }) });
  }

  /** Start the waiting calls while fewer than {@link READINESS_PARALLEL} run. */
  function drain(): void {
    while (running < READINESS_PARALLEL && waiting.length > 0) {
      const ticket = waiting.shift()!;
      const hash = descriptionHash(ticket.description);
      running += 1;
      const call = score(ticket, hash).catch((error: unknown) => deps.log(`the readiness of ${ticket.key} could not be kept: ${(error as Error).message}`)).finally(() => {
        running -= 1;
        asked.delete(`${ticket.key} ${hash}`);
        settling.delete(call);
        drain();
      });
      settling.add(call);
    }
  }

  /**
   * `ticket`'s readiness now: its kept score when its description is the one scored, or pending, with its call started when none is under way. A ticket with no description is scored 0 with
   * no call. While the kept scores cannot be read, every ticket is failed with that reason, and no call starts.
   */
  function readinessOf(ticket: Ticket): ReadinessView {
    const read = store.load();
    if ("unreadable" in read) return { state: "failed", reason: `The kept scores cannot be read: ${read.unreadable}`.slice(0, REASON_CHARS) };
    const hash = descriptionHash(ticket.description);
    const record = read.records.get(ticket.key);
    if (record?.hash === hash) return viewOf(record);
    if (ticket.description.trim() === "") {
      const empty: ReadinessRecord = { hash, at: deps.now(), score: 0, reasons: ["The ticket has no description."] };
      keep(ticket.key, empty);
      return viewOf(empty);
    }
    latest.set(ticket.key, hash);
    if (!asked.has(`${ticket.key} ${hash}`)) {
      asked.add(`${ticket.key} ${hash}`);
      waiting.push(ticket);
      drain();
    }
    return { state: "pending" };
  }

  /** Settles once every call under way and waiting has ended: a test's way to wait for the background, never the board's. A call that ends starts the next waiting one before it settles. */
  async function idle(): Promise<void> {
    while (settling.size > 0) await Promise.all([...settling]);
  }

  return { readinessOf, idle };
}

export type Readiness = ReturnType<typeof createReadiness>;

/** The instance's scorer over `stateDir`: the cheap model asked through `realExecAsync`, unless `ask` is given (a test's), and a failure said on stderr. */
export function instanceReadiness(stateDir: string, ask: ReadinessDeps["ask"] = askHeadless(realExecAsync, stateDir, READINESS_BOUNDS)): Readiness {
  return createReadiness({ stateDir, ask, now: Date.now, log: (line) => process.stderr.write(`ticket:serve: ${line}\n`) });
}

/** The most tickets one request may name. */
const MAX_KEYS = 1000;

/**
 * `POST /api/readiness` with `{ keys }`: each named ticket's readiness, from the page's own copy of it (`known`). Off, it answers `on: false` and asks nothing; a ticket the page has no copy of
 * is left out. Any other route is not this one's.
 */
export function readinessRoute(board: Readonly<{ on: boolean; readiness: Readiness; known: ReadonlyMap<string, Ticket> }>, method: string, path: string, body: Json): [number, ReadinessAnswer] | undefined {
  if (method !== "POST" || path !== "/api/readiness") return undefined;
  if (!Array.isArray(body.keys) || body.keys.length > MAX_KEYS || !body.keys.every((key) => typeof key === "string")) throw new Error(`keys must be a list of at most ${MAX_KEYS} ticket keys`);
  if (!board.on) return [200, { on: false, scores: {} }];
  const scores: Record<string, ReadinessView> = {};
  for (const key of body.keys as string[]) {
    const ticket = board.known.get(key);
    if (ticket !== undefined) scores[key] = board.readiness.readinessOf(ticket);
  }
  return [200, { on: true, scores }];
}
