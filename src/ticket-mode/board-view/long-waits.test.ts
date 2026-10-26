// no-token: gh -- the queue's view, in memory; nothing is read or spawned
// A11-298: a queued run that has waited more than two hours on the same ticket is listed, with what it waits on and whether that ticket can move
import { test } from "node:test";
import assert from "node:assert/strict";
import { holderMove, LONG_WAIT_MS, longWaits, longWaitSentence, waitedWords, waitTarget } from "./long-waits.ts";
import type { ViewEntry } from "./view-types-and-filters.ts";

const HOUR = 60 * 60_000;
const NOW = 100 * HOUR;
const FILES = ["announcement-emulator:middleware/package.json"];
const entry = (key: string, over: Record<string, unknown> = {}) => ({ ticket: { key }, phase: "queued", ...over }) as unknown as ViewEntry;
const blocker = (key: string) => ({ key, state: "started", status: "In Progress", pulls: {} });
const running = (key: string, over: Record<string, unknown> = {}) => entry(key, { phase: "running", ...over });

test("A11-298: a queued run waits on its blocker first, else on the run whose files it needs; a run that is not queued waits on nothing", () => {
  const both = entry("A11-229", { paths: FILES, blockers: [blocker("A11-231")] });
  const board = [both, running("A11-231"), running("A11-232", { paths: FILES })];
  assert.deepEqual(waitTarget(both, board), { key: "A11-231", kind: "blocker" });
  const filesOnly = entry("A11-229", { paths: FILES });
  assert.deepEqual(waitTarget(filesOnly, [filesOnly, running("A11-232", { paths: FILES })]), { key: "A11-232", kind: "files" });
  assert.equal(waitTarget(running("A11-232"), board), null);
  assert.equal(waitTarget(entry("A11-300"), [entry("A11-300")]), null);
});

test("A11-298: a wait on the same ticket for more than two hours is listed, with the ticket it waits on and since when", () => {
  const waiter = entry("A11-229", { paths: FILES, waitSince: { on: "A11-232", since: NOW - 31 * HOUR - 20 * 60_000 } });
  const holder = running("A11-232", { paths: FILES });
  const [wait, ...rest] = longWaits([waiter, holder], NOW);
  assert.equal(rest.length, 0);
  assert.deepEqual([wait.key, wait.on, wait.kind, wait.holder.moves], ["A11-229", "A11-232", "files", true]);
  assert.equal(longWaitSentence(wait, NOW), "A11-229 has waited 31 h 20 min on A11-232's files: A11-232 is In progress, so it can move by itself.");
});

test("A11-298: two hours exactly, less, a wait that began on another ticket, or no wait at all is not listed", () => {
  const holder = running("A11-232", { paths: FILES });
  const waiting = (since: { on: string; since: number } | undefined) => entry("A11-229", { paths: FILES, ...(since === undefined ? {} : { waitSince: since }) });
  assert.equal(LONG_WAIT_MS, 2 * HOUR);
  assert.deepEqual(longWaits([waiting({ on: "A11-232", since: NOW - 2 * HOUR }), holder], NOW), []);
  assert.deepEqual(longWaits([waiting({ on: "A11-232", since: NOW - 10 * 60_000 }), holder], NOW), []);
  assert.deepEqual(longWaits([waiting({ on: "A11-300", since: NOW - 40 * HOUR }), holder], NOW), [], "it waits on A11-232 now: the board has not recorded since when");
  assert.deepEqual(longWaits([waiting(undefined), holder], NOW), []);
  assert.deepEqual(longWaits([waiting({ on: "A11-232", since: NOW - 3 * HOUR }), running("A11-300")], NOW), [], "and one whose holder let go waits on nothing");
});

test("A11-298: the longest wait comes first", () => {
  const holder = running("A11-232", { paths: FILES });
  const waits = longWaits([entry("A11-300", { paths: FILES, waitSince: { on: "A11-232", since: NOW - 3 * HOUR } }), entry("A11-229", { paths: FILES, waitSince: { on: "A11-232", since: NOW - 30 * HOUR } }), holder], NOW);
  assert.deepEqual(waits.map(({ key }) => key), ["A11-229", "A11-300"]);
});

test("A11-298: a ticket with no run on the board cannot move, and a blocker that is queued behind another cannot either", () => {
  assert.deepEqual(holderMove("A11-231", [entry("A11-229")]), { moves: false, words: "A11-231 has no run on the board, so nothing is working on it" });
  const stuck = entry("A11-231", { blockers: [blocker("A11-229")] });
  const waiter = entry("A11-229", { paths: FILES, blockers: [blocker("A11-231")], waitSince: { on: "A11-231", since: NOW - 5 * HOUR } });
  const other = running("A11-229b");
  assert.deepEqual(holderMove("A11-231", [stuck, waiter, other]), { moves: false, words: "A11-231 is Blocked, waiting on A11-229, so it cannot move by itself" });
  assert.equal(longWaitSentence(longWaits([waiter, stuck], NOW)[0], NOW), "A11-229 has waited 5 h 0 min on A11-231, which blocks it: A11-231 is Blocked, waiting on A11-229, so it cannot move by itself.");
});

test("A11-298: a run waiting for a person cannot move by itself; one waiting for a review or a merge can", () => {
  const needsYou = entry("A11-231", { phase: "finished", outcome: { kind: "needs-human", reason: "q" } });
  assert.equal(holderMove("A11-231", [needsYou]).moves, false);
  assert.match(holderMove("A11-231", [needsYou]).words, /^A11-231 is Needs you, so it cannot move by itself$/);
  const awaiting = entry("A11-231", { phase: "finished", outcome: { kind: "ready-pr", prs: [{ url: "https://github.com/a11ign/x/pull/1", repo: "x" }] } });
  assert.deepEqual(holderMove("A11-231", [awaiting]), { moves: true, words: "A11-231 is Awaiting review, so it can move by itself" });
});

test("A11-298: a wait is worded in minutes under an hour, and in hours and minutes after", () => {
  assert.deepEqual([waitedWords(45 * 60_000), waitedWords(31 * HOUR + 20 * 60_000), waitedWords(-5)], ["45 min", "31 h 20 min", "0 min"]);
});
