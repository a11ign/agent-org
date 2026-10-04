// @ts-check
// THE REAL READS FOR THE STALL AND INCIDENT SOURCES (a11ign/a11ign#3008, row 5b of 13; design #2899). `stall.mjs` and `incidents.mjs` take every read
// INJECTED and say so; this file is what the host injects. Seven readers, each returning what its source's own typedef names, and each a
// read that THROWS on failure: the source turns the throw into `cannot-ask`, never into "all clear" and never into an event.
//
//   readLastMerge   the newest merge into `main`, from GitHub                           -> stall:no-merge
//   readTrunkRuns   the runs of `trunk.yml` on `main`                                    -> incident:trunk-red
//   readCiRuns      recent completed runs of every workflow, with their annotations      -> incident:ci-permission
//   readGateUnit    the work-tick unit's failed state, and when its last run ended       -> incident:gate-crash
//   readFleetState  the state file `fleet-watch` writes, and when it was written         -> incident:fleet-down
//
// AND TWO MORE FOR THE LIAISON'S CHECKED FACTS (a11ign/a11ign#3420), which `placeholders.mjs` calls rather than a source:
//   readFleetRoster who `fleet-watch` last saw answer, and who it did not                 -> {{fleet.workers-up}}, {{fleet.workers-down}}
//   readLastTick    when the gate last COMPLETED a tick, from the same record as above     -> {{gate.last-tick.age}}
//   readTicks       THIS WATCHER'S OWN SAMPLES, newest first                             -> stall:all-idle
//   readFixRow      the open row that holds the fix for an event, and the org's newest word on it -> the `Being done` line of every incident and stall
//   readEpisodeStart when the chairman was told of the open episode, from the ledger     -> the `Lasted` line of every cleared incident and stall
//
// A LEAF: node's own modules only (and `lib/tick-completion.mjs` and `../ledger.mjs`, which are the same). Everything that reaches outside the process is a dependency a test replaces (`github.api`, `systemctl`,
// `readSeats`), and the files it keeps are under a directory the caller names, so a test gives it a temporary one.
//
// **THE GATE'S LAST COMPLETED TICK IS A RECORD THE TICK WRITES (#3040), NOT THE UNIT'S TIMESTAMP.** `InactiveEnterTimestamp` answers "did the unit run" and a tick
// that died at import moves it as surely as a good one (2026-10-02: 63 crashed ticks). `work-tick.mjs` writes `lib/tick-completion.mjs`'s record only when
// it reaches the end of `main()`; `readGateUnit` takes `lastRecordAt` from it and keeps the unit's timestamp as `lastRunAt`, so the incident can say the ticks
// are still starting and not finishing. `failed` is the unit's `ActiveState`.
//
// **`readTicks` NEEDS A HISTORY AND NO SOURCE HOLDS ONE**, so each run appends a SAMPLE (`takeSample`) to a bounded file (a week): the time, every seat's
// state, and the rows waiting. One sample alone never makes `stall:all-idle` (it fires only after a streak of `allIdleAfterMs`), which is why
// the sample is a file and not the last tick. The period is the timer's: it must stay shorter than `allIdleAfterMs`, and a run that missed
// one leaves a gap `maxTickAgeMs` then reports as `cannot-ask`.
//
// WAITING ROWS ARE `ready` ROWS WITH NO HOLD ON THEM: the label the gate itself reads, less the labels that mean "do not start this" (`blocked`,
// `hold*`, `answer:*`). It is an approximation of the gate's own order list, which this file may not call: a row held by a `Not-before` date
// still counts, and a pull request awaiting a reviewer does not. Row 13's first week reads how many `stall:all-idle` events that produced.

import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { readCompletion } from "../../lib/tick-completion.mjs";
import { readLedgerLines } from "../ledger.mjs";

/**
 * Kept: a week at the timer's five minutes. The streak the stall source needs is ten minutes, so the rest is for the READING: row 13 counts how many
 * `stall:no-merge` events fired while the queue was empty, and the queue at each moment is on the sample, not anywhere else.
 */
export const SAMPLE_LIMIT = 2016;
/** The file is appended to and compacted only this far past the limit, so a run rewrites it about once a day rather than every five minutes. */
const COMPACT_SLACK = 288;
const MERGED_PULLS_WINDOW = 30;
const TRUNK_RUNS_WINDOW = 20;
const CI_RUNS_WINDOW = 20;
/** Failed runs whose annotations one run of the watcher will read: each costs a jobs call and one per failed job, so a backlog drains over runs. */
const ANNOTATION_READS_PER_RUN = 6;
const MS_PER_SECOND = 1000;
const MS_PER_MINUTE = 60_000;
/** Rows carrying one of these are not waiting for a session: held, blocked, or waiting on somebody's answer. */
const NOT_WAITING = /^(blocked|hold(:.*)?|answer:.*)$/;
/** `fleet-watch` stamps every answering worker with the poll's own clock and writes the file just after, so a worker that answered the last poll is within this of the write. */
const POLL_SLACK_MS = 2 * MS_PER_MINUTE;
/** `fleet-watch` runs hourly (`OnCalendar=*:47`): two missed firings and a margin is what a stopped watcher looks like (`watch.mjs`'s `FLEET_STATE_MAX_AGE_MS`, the same figure). */
export const FLEET_READING_MAX_AGE_MS = 130 * MS_PER_MINUTE;
/** The events a fix row can be named for: the keys `incidents.mjs` and `stall.mjs` emit, and the only ones whose message carries a `Doing` line. */
const FIX_ROW_KEY = /^(incident|stall):[a-z][a-z-]*$/;
const SAMPLES_FILE = "samples.jsonl";
/** The delivery ledger beside the samples (`defaultLedgerPath`'s own file name, in the directory `watch.mjs` passes as `stateDir`). */
const LEDGER_FILE = "ledger.jsonl";
const ANNOTATIONS_FILE = "ci-annotations.json";
export const SYSTEMD_PROPERTIES = "ActiveState,StateChangeTimestamp,InactiveEnterTimestamp";

/** @param {unknown} value @param {string} field @returns {any[]} */
function asArray(value, field) {
  if (!Array.isArray(value)) throw new TypeError(`${field}: an array was expected, got ${JSON.stringify(value)?.slice(0, 80)}`);
  return value;
}

/**
 * @typedef {{ api: (path: string) => Promise<any> }} Github  a GET of one REST path, as `gh api <path>` parses it
 * @typedef {{ github: Github, repo: string }} Repo
 */

/**
 * The newest merge into `main`, by the pull request's own `merged_at`. NOT the newest commit: `main` carries "Merge origin/main into <branch>"
 * commits that came in with a branch, and a clock built on them would read a merge that never happened. Closed pulls come back by last
 * update, which a merge sets, so the newest merge is among the first of them.
 * @param {Repo} deps @returns {Promise<number>}
 */
export async function readLastMerge({ github, repo }) {
  const pulls = asArray(await github.api(`repos/${repo}/pulls?state=closed&base=main&sort=updated&direction=desc&per_page=${MERGED_PULLS_WINDOW}`), "pulls");
  const merged = pulls.map((pull) => Date.parse(pull?.merged_at)).filter(Number.isFinite);
  if (merged.length === 0) throw new RangeError(`none of the ${MERGED_PULLS_WINDOW} most recently updated closed pull requests was merged, so no merge time is known`);
  return Math.max(...merged);
}

/** @param {Repo & { workflow?: string }} deps @returns {Promise<Record<string, any>[]>} */
export async function readTrunkRuns({ github, repo, workflow = "trunk.yml" }) {
  const body = await github.api(`repos/${repo}/actions/workflows/${workflow}/runs?branch=main&per_page=${TRUNK_RUNS_WINDOW}`);
  return asArray(body?.workflow_runs, "workflow_runs");
}

/**
 * The messages of one failed run's annotations: its failed jobs, then each job's annotations. A permission refusal is written on the job.
 * @param {Repo & { run: Record<string, any> }} deps @returns {Promise<string[]>}
 */
async function annotationsOf({ github, repo, run }) {
  const jobs = asArray((await github.api(`repos/${repo}/actions/runs/${run.id}/jobs?per_page=100`))?.jobs, "jobs");
  const messages = [];
  for (const job of jobs.filter((candidate) => candidate.conclusion === "failure")) {
    const notes = asArray(await github.api(`repos/${repo}/check-runs/${job.id}/annotations?per_page=100`), "annotations");
    messages.push(...notes.map((note) => String(note?.message ?? "")));
  }
  return messages;
}

/**
 * A small JSON file of `{ key: value }`. A missing file is empty (the first run); one that is not JSON is empty too and the caller is told, because
 * what it holds is a cache and the cost of losing it is a re-read.
 * @param {string} path
 */
function jsonStore(path) {
  return {
    /** @returns {Record<string, any>} */
    read() {
      let text;
      try {
        text = readFileSync(path, "utf8");
      } catch (error) {
        if (/** @type {NodeJS.ErrnoException} */ (error)?.code === "ENOENT") return {};
        throw error;
      }
      const parsed = JSON.parse(text);
      return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    },
    /** @param {Record<string, any>} value */
    write(value) {
      replaceFile(path, `${JSON.stringify(value)}\n`);
    },
  };
}

/** Atomic: a reader never sees half a file, and a crash leaves the old one. @param {string} path @param {string} text */
function replaceFile(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, text);
  renameSync(temporary, path);
}

/**
 * Recent completed runs of every workflow, each with its annotations, for the `Resource not accessible` check. Only a FAILED run is asked for its
 * annotations, and a completed run's never change, so they are kept by run id and read once. A failed run whose annotations could not be read this
 * time THROWS rather than reading as "no annotation": a run unread is not a run clear, and a clear would send "cleared" for a thing nobody checked.
 *
 * @param {Repo & { stateDir: string }} deps @returns {Promise<Record<string, any>[]>}
 */
export async function readCiRuns({ github, repo, stateDir }) {
  const body = await github.api(`repos/${repo}/actions/runs?status=completed&per_page=${CI_RUNS_WINDOW}`);
  const runs = asArray(body?.workflow_runs, "workflow_runs");
  const store = jsonStore(join(stateDir, ANNOTATIONS_FILE));
  const known = store.read();
  const unread = runs.filter((run) => run.conclusion === "failure" && known[run.id] === undefined);
  try {
    for (const run of unread.slice(0, ANNOTATION_READS_PER_RUN)) known[run.id] = await annotationsOf({ github, repo, run });
  } finally {
    store.write(Object.fromEntries(runs.filter((run) => known[run.id] !== undefined).map((run) => [run.id, known[run.id]])));
  }
  if (unread.length > ANNOTATION_READS_PER_RUN) {
    throw new RangeError(`${unread.length - ANNOTATION_READS_PER_RUN} failed run(s) have no annotations read yet (${ANNOTATION_READS_PER_RUN} are read per run)`);
  }
  return runs.map((run) => ({ ...run, annotations: (known[run.id] ?? []).map((/** @type {string} */ message) => ({ message })) }));
}

/**
 * @param {string} text `systemctl show` output, `Key=value` per line @returns {Record<string, string>}
 */
function parseProperties(text) {
  return Object.fromEntries(text.split("\n").filter((line) => line.includes("=")).map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
}

/** @param {string | undefined} text `--timestamp=unix` prints `@<seconds>`; empty or `@0` is a time the unit never had @param {string} field @returns {number} */
function unixMilliseconds(text, field) {
  const seconds = /^@(\d+)$/.exec(text ?? "")?.[1];
  if (seconds === undefined || Number(seconds) === 0) throw new RangeError(`${field}: systemd has no such time (${JSON.stringify(text)})`);
  return Number(seconds) * MS_PER_SECOND;
}

/**
 * The work-tick unit: `failed` is systemd's own state and `failedAt` when it entered it; `lastRunAt` is when the unit last RAN (systemd's
 * `InactiveEnterTimestamp`, which a tick that died moves exactly as a good one -- the 2026-10-02 outage); `lastRecordAt` is when a tick last COMPLETED,
 * from the record `work-tick.mjs` writes only at the end of `main()` (#3040). A record that is absent or unreadable THROWS: no tick known to have
 * completed is not a clean reading. `work-tick.service` declares `SuccessExitStatus=0 1 2`, so a quiet or partial tick is not a failure and `failed`
 * means the gate really crashed (exit 70, #3038).
 * @param {{ unit: string | undefined, systemctl: (argv: string[]) => Promise<string>, recordPath: string }} deps
 * @returns {Promise<import("./incidents.mjs").GateUnitReading>}
 */
export async function readGateUnit({ unit, systemctl, recordPath }) {
  if (unit === undefined) throw new TypeError("the work-tick unit's name is not known (no `units.prefix` in the project declaration)");
  const text = await systemctl(["--user", "show", unit, "--timestamp=unix", "-p", SYSTEMD_PROPERTIES]);
  const properties = parseProperties(text);
  if (properties.ActiveState === undefined) throw new TypeError(`systemctl show ${unit} printed no ActiveState`);
  const failed = properties.ActiveState === "failed";
  const lastRunAt = unixMilliseconds(properties.InactiveEnterTimestamp, "InactiveEnterTimestamp");
  const lastRecordAt = readCompletion(recordPath).at;
  return failed ? { failed, failedAt: unixMilliseconds(properties.StateChangeTimestamp, "StateChangeTimestamp"), lastRunAt, lastRecordAt } : { failed, lastRunAt, lastRecordAt };
}

/**
 * `fleet-watch`'s state: worker -> since when it has not been ready, and the time the file was written (its modification time), which is what
 * lets the source refuse a watcher that stopped. A MISSING file throws: `fleet-watch`'s own reader calls that "empty", which is right for it and
 * would be a false all-clear here. **Only the worker's NAME is kept.** The key is `<name>  <host>:<port>`, and a LAN address has no business in a
 * message to a chat provider or in a ledger.
 *
 * @param {{ path: string }} deps @returns {{ state: Record<string, number>, writtenAt: number }}
 */
export function readFleetState({ path }) {
  const stored = JSON.parse(readFileSync(path, "utf8"));
  if (stored === null || typeof stored !== "object" || Array.isArray(stored)) throw new TypeError(`${path}: an object of worker to time was expected`);
  /** @type {Record<string, number>} */
  const state = {};
  for (const [key, since] of Object.entries(stored)) {
    const name = key.trim().split(/\s+/)[0];
    state[name] = Math.min(state[name] ?? Infinity, Number(since));
  }
  return { state, writtenAt: statSync(path).mtimeMs };
}

/** `worker-2` before `worker-10`: the order a person reads a list of numbered machines in. @param {string} a @param {string} b @returns {number} */
const byNumberedName = (a, b) => a.localeCompare(b, "en", { numeric: true });

/** @param {string} key `<name>  <host>:<port>` or a bare name @returns {string} the worker's name: an address has no business in a message to a chat provider */
function workerName(key) {
  return key.trim().split(/\s+/)[0];
}

/**
 * Who `fleet-watch` last saw answer and who it did not, by NAME. **`fleet-watch-state.json` alone cannot say who is up**: it holds only the workers that
 * answered and were not ready (`advance` drops `ready`, `busy` and `unreachable`), so it is `{}` on a healthy fleet. The roster is
 * `fleet-captures-state.json`, which every answering worker is stamped into with the poll's clock (`seenAt`); a worker that did not answer keeps its
 * OLD stamp, so it is the one not within `POLL_SLACK_MS` of the file's write. Up is what answered and is not in the non-ready state; down is the rest of
 * the roster, an unreachable box included (it is down to the chairman whether or not fleet-watch calls that its resting state).
 *
 * **Both files must be fresh and the roster must be non-empty, else it THROWS**: "no worker is down" over a watcher that stopped, or over a roster nobody
 * is on, is the false all-clear this layer exists to refuse. A worker that has never answered since the roster began is not on it, and is not known.
 *
 * @param {{ statePath: string, capturesPath: string, now: number, maxAgeMs?: number }} input
 * @returns {{ up: string[], down: string[], polledAt: number }} `polledAt` is the OLDER of the two files' write times
 */
export function readFleetRoster({ statePath, capturesPath, now, maxAgeMs = FLEET_READING_MAX_AGE_MS }) {
  const notReady = Object.keys(readFleetState({ path: statePath }).state);
  const captures = JSON.parse(readFileSync(capturesPath, "utf8"));
  if (captures === null || typeof captures !== "object" || captures.workers === null || typeof captures.workers !== "object" || Array.isArray(captures.workers)) {
    throw new TypeError(`${capturesPath}: an object with a \`workers\` object was expected`);
  }
  const wroteAt = statSync(capturesPath).mtimeMs;
  const polledAt = Math.min(wroteAt, statSync(statePath).mtimeMs);
  if (now - polledAt > maxAgeMs) throw new RangeError(`fleet-watch last wrote its state ${Math.round((now - polledAt) / MS_PER_MINUTE)} minutes ago: that is not a reading of the fleet`);
  const roster = Object.entries(captures.workers).map(([key, entry]) => {
    const seenAt = /** @type {any} */ (entry)?.seenAt;
    if (!Number.isFinite(seenAt)) throw new TypeError(`${capturesPath}: ${workerName(key)} has no numeric seenAt`);
    return { name: workerName(key), answered: wroteAt - seenAt <= POLL_SLACK_MS };
  });
  if (roster.length === 0) throw new RangeError(`${capturesPath} names no worker: nothing is known to be up or down`);
  const up = roster.filter(({ name, answered }) => answered && !notReady.includes(name)).map(({ name }) => name).sort(byNumberedName);
  const down = [...new Set([...roster.filter(({ name }) => !up.includes(name)).map(({ name }) => name), ...notReady])].sort(byNumberedName);
  return { up, down, polledAt };
}

/**
 * When the gate last COMPLETED a tick (#3040's record, not the unit's timestamp: a tick that died at import moves that as surely as a good one). Absent or
 * unreadable THROWS, as `readCompletion` does.
 * @param {{ recordPath: string }} input @returns {{ at: number }}
 */
export function readLastTick({ recordPath }) {
  return { at: readCompletion(recordPath).at };
}

/**
 * The rows waiting for a session to take them: `ready` and open, no hold on them, and not a pull request (the issues listing returns both).
 * @param {Repo} deps @returns {Promise<{ number: number }[]>}
 */
export async function readWaitingRows({ github, repo }) {
  const issues = asArray(await github.api(`repos/${repo}/issues?labels=ready&state=open&per_page=100`), "issues");
  const held = (/** @type {any} */ issue) => asArray(issue.labels, "labels").some((label) => NOT_WAITING.test(String(label?.name ?? label)));
  return issues.filter((issue) => issue.pull_request === undefined && !held(issue)).map((issue) => ({ number: issue.number }));
}

/**
 * The org's own GitHub accounts, whose comments on a fix row say what is being done. Restated from `hand-fix-ledger.mjs`'s `ORG_LOGINS` because this file is a
 * leaf and that one imports the tool; a login added there must be added here.
 */
export const ORG_LOGINS = Object.freeze(["a11ign-ai-workers", "a11ign-ai-leads", "a11ign-bot"]);
const INCIDENT_LABEL = "incident";
const COMMENTS_PER_PAGE = 100;

/** @param {string} key @returns {RegExp} the `Incident: <key>` line a fix row's body carries, on a line of its own */
const incidentLine = (key) => new RegExp(`^Incident:[ \\t]*${key}[ \\t]*$`, "m");

/**
 * The newest comment an org account left on one row. Comments list oldest first, so the newest are on the LAST page, which the listing's own `comments` count
 * names; a page with no org comment sends the walk one page back. `null` when the row has none.
 *
 * @param {Repo & { number: number, count: number }} deps @returns {Promise<NonNullable<import("./stall.mjs").FixRow["comment"]> | null>}
 */
async function newestOrgComment({ github, repo, number, count }) {
  for (let page = Math.ceil(count / COMMENTS_PER_PAGE); page >= 1; page -= 1) {
    const comments = asArray(await github.api(`repos/${repo}/issues/${number}/comments?per_page=${COMMENTS_PER_PAGE}&page=${page}`), "comments");
    const ours = comments.filter((comment) => ORG_LOGINS.includes(String(comment?.user?.login)) && typeof comment?.body === "string");
    if (ours.length > 0) {
      const newest = ours.reduce((latest, comment) => (Date.parse(comment.created_at) > Date.parse(latest.created_at) ? comment : latest));
      return { author: newest.user.login, at: Date.parse(newest.created_at), text: newest.body };
    }
  }
  return null;
}

/**
 * The open row that holds the fix for one incident or stall, and what the org last said on it: **a row labelled `incident` whose body carries an
 * `Incident: <key>` line** (`Incident: incident:trunk-red`), the shape the chairman's row 3419 names. The listing filters on the label and returns bodies, so
 * the key is matched here and no search call is made. What is being done is the newest comment from an ORG account (`ORG_LOGINS`) on that row: a comment from
 * anyone else is not the org's word.
 *
 * Returns `null` ONLY when GitHub answered and no open row names the key; a failed call, or a key that is not an incident or stall key, THROWS, because "could
 * not ask" and "nobody has picked it up" are different readings and the message tells the chairman which. Several open rows: the oldest, the one first
 * opened for it. Pull requests are skipped (the issues listing returns both). A row with no org comment is `{ number }`.
 *
 * @param {Repo & { key: string }} deps @returns {Promise<import("./stall.mjs").FixRow | null>}
 */
export async function readFixRow({ github, repo, key }) {
  if (!FIX_ROW_KEY.test(key)) throw new TypeError(`readFixRow: ${JSON.stringify(key)} is not an incident or stall key`);
  const issues = asArray(await github.api(`repos/${repo}/issues?labels=${INCIDENT_LABEL}&state=open&per_page=100`), "issues");
  const named = incidentLine(key);
  const rows = issues.filter((issue) => issue?.pull_request === undefined && Number.isInteger(issue?.number) && named.test(String(issue.body ?? "")));
  if (rows.length === 0) return null;
  const oldest = rows.reduce((first, issue) => (issue.number < first.number ? issue : first));
  const count = Number.isInteger(oldest.comments) ? oldest.comments : 0;
  const comment = count === 0 ? null : await newestOrgComment({ github, repo, number: oldest.number, count });
  return comment === null ? { number: oldest.number } : { number: oldest.number, comment };
}

/**
 * When the chairman was TOLD of the episode of `key` that is open now: the ledger's first delivered line since the last clear. The ledger is the only memory
 * of an episode (the sources keep none), and what it holds is the send, not the start, so this is a floor on how long the thing stood. `null` when the ledger
 * holds no open episode for the key; an unreadable ledger throws.
 *
 * @param {{ ledgerPath: string, key: string }} deps @returns {number | null}
 */
export function readEpisodeStart({ ledgerPath, key }) {
  let told = /** @type {number | null} */ (null);
  for (const line of readLedgerLines(ledgerPath)) {
    if (line.direction === "in" || line.key !== key) continue;
    if (line.status === "withdrawn" || (line.status === "sent" && line.kind === "cleared")) told = null;
    else if (["sent", "digested"].includes(line.status) && ["first", "update", "reminder"].includes(line.kind)) told ??= Date.parse(line.ts);
  }
  return told;
}

/**
 * Append ONE sample: now, every seat's state, the rows waiting. Either read failing throws and NOTHING is appended: a sample with no seats would read as
 * "every seat idle" for an empty roster. A torn last line (a crash mid-append) costs one sample, and `readTicks` says so.
 *
 * @param {Repo & { stateDir: string, now: () => number, readSeats: () => { label: string, status: string }[] | null, limit?: number }} deps
 * @returns {Promise<void>}
 */
export async function takeSample({ github, repo, stateDir, now, readSeats, limit = SAMPLE_LIMIT }) {
  const seats = readSeats();
  if (seats === null) throw new Error("herdr could not be asked for the seats, so no sample was taken");
  const orders = await readWaitingRows({ github, repo });
  const path = join(stateDir, SAMPLES_FILE);
  const line = `${JSON.stringify({ at: now(), seats: seats.map(({ label, status }) => ({ session: label, state: status })), orders })}\n`;
  const held = readSampleLines(path);
  if (held.length < limit + COMPACT_SLACK) {
    mkdirSync(stateDir, { recursive: true });
    appendFileSync(path, line);
  } else {
    replaceFile(path, [...held.slice(-(limit - 1)).map((kept) => `${kept}\n`), line].join(""));
  }
}

/** @param {string} path @returns {string[]} the lines of the samples file, oldest first; none when it does not exist yet */
function readSampleLines(path) {
  try {
    return readFileSync(path, "utf8").split("\n").filter((line) => line.trim() !== "");
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error)?.code === "ENOENT") return [];
    throw error;
  }
}

/**
 * The newest `limit` samples, NEWEST FIRST, as `stall.mjs` reads them. A line that is not JSON is dropped and `log` says how many: it is a torn append or a
 * hand edit, and one bad line must not blind the source for as long as the file holds it.
 *
 * @param {{ stateDir: string, log?: (line: string) => void, limit?: number }} deps @returns {import("./stall.mjs").TickRecord[]}
 */
export function readTicks({ stateDir, log = () => {}, limit = SAMPLE_LIMIT }) {
  const records = [];
  let unreadable = 0;
  for (const line of readSampleLines(join(stateDir, SAMPLES_FILE))) {
    try {
      records.push(JSON.parse(line));
    } catch {
      unreadable += 1;
    }
  }
  if (unreadable > 0) log(`readTicks: ${unreadable} line(s) of ${SAMPLES_FILE} are not JSON and were skipped`);
  return /** @type {import("./stall.mjs").TickRecord[]} */ (records.slice(-limit).reverse());
}

/**
 * The eight readers, bound to one repository, one state directory and one set of outside reads, plus `takeSample`, which the stall source runs first.
 *
 * @param {{ github: Github, repo: string, stateDir: string, fleetStatePath: string, unit: string | undefined, now: () => number,
 *   systemctl: (argv: string[]) => Promise<string>, readSeats: () => { label: string, status: string }[] | null, log?: (line: string) => void,
 *   completionPath: string, ledgerPath?: string }} deps `completionPath` is where `work-tick.mjs` records a completed tick
 */
export function createReaders({ github, repo, stateDir, fleetStatePath, unit, now, systemctl, readSeats, log, completionPath, ledgerPath = join(stateDir, LEDGER_FILE) }) {
  return {
    readLastMerge: () => readLastMerge({ github, repo }),
    readTrunkRuns: () => readTrunkRuns({ github, repo }),
    readCiRuns: () => readCiRuns({ github, repo, stateDir }),
    readGateUnit: () => readGateUnit({ unit, systemctl, recordPath: completionPath }),
    readFleetState: () => readFleetState({ path: fleetStatePath }),
    readTicks: () => readTicks({ stateDir, log }),
    readFixRow: (/** @type {string} */ key) => readFixRow({ github, repo, key }),
    readEpisodeStart: (/** @type {string} */ key) => readEpisodeStart({ ledgerPath, key }),
    takeSample: () => takeSample({ github, repo, stateDir, now, readSeats }),
  };
}
