// no-token: gh -- `gh` is never reached: the code host is the in-memory one, every read is handed a fake `run` that notes the call it is asked, and the batch is a fake that notes what it was handed.
/**
 * a11ign/a11ign#3566, slice 6: THE TRACKER LANES AND THE OTHER REPOSITORIES' LISTS GO OUT AS ONE WAVE, NOT ONE WAVE EACH.
 *
 * Slices 2 and 5 made each reader's first reads wait together, but the readers still waited for one another: measured 2026-10-06 in a gate run with the
 * spawns traced, `readTrackerLanes`' three calls were one batch (1.7 s) and `readOtherScopes`' seven were the next (1.3 s). Neither needs the other's
 * answer, so they cost the slowest of the two instead of the sum. What this pins:
 *   - the control: a `run` handed in is NOT batched, so every other test of the gate sees its calls one at a time as before;
 *   - the calls of BOTH readers arrive in ONE batch, and what the readers return is what they returned asked one after the other;
 *   - a refusal in one repository is that lane's `null` beside the tracker's answers, and the tracker's refusal does not reach the repositories (#1286);
 *   - `main` asks them through this reader, AFTER the check that both of its first two reads were refused (slice 5's reason: an outage tick must not
 *     ask more refused questions), and no longer asks either on its own.
 *
 * THE POPULATION IS THE DECLARATION'S: one list per other declared code repository, so a third repository is covered the day it is declared.
 *
 * THE WAVE IS CORE'S POLICY, SO NOTHING HERE IS GITHUB'S WIRE FORMAT (A11-160, step 9): the code host is the in-memory one, whose reads act on its world and ignore the `run` they are handed. A read that goes
 * through `run` by design is made to say so, as a stand-in call (`fake-rows <read> <label>` for a tracker's lists, `fake-open-pull-list` for a repository's), so the wave can be counted without a single `gh` argument list.
 */
import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { homeProjectDeclaration } from "./project-config.ts";
import { readLanesAfterOutageCheck, readOtherScopes } from "./work-gate.ts";
import { readTrackerLanes } from "./work-gate/tick.ts";
import { scopesOf } from "./work-gate/vocabulary.ts";
import { workGateSource } from "./lib/work-gate-source.ts";
import { forgetActivation, substituteCodeHost } from "./plugins/active.ts";
import { createFakeCodeHost } from "./plugins/fakes/code-host.ts";

type Lane = ReturnType<typeof readOtherScopes>[number];
type Call = { args: string[], repo: string | undefined };
type Answer = { stdout: string } | { failed: true, stdout: string, stderr: string, status: number | null };

const OTHER_CODE = scopesOf([homeProjectDeclaration()]).filter((scope) => scope.key !== "" && scope.code !== null);
const TRACKER_CALL = "fake-rows";
const REPOSITORY_CALL = "fake-open-pull-list";
const isTrackerCall = ({ args }: Call) => args[0] === TRACKER_CALL;
const isRepositoryCall = ({ args, repo }: Call) => args[0] === REPOSITORY_CALL && repo !== undefined;

/** The code host the gate asks: its lists of a tracker's rows are made to go through the `run` they are handed, as the stand-in call `fake-rows <read> <label>`, and answer from its (empty) world. */
function hostReadingThroughRun() {
  const host = createFakeCodeHost();
  const rows = host.rows as unknown as Record<string, (request: { label?: string; run: (args: string[]) => string }) => unknown>;
  for (const read of ["readRowsByLabel", "openRowsOf"]) {
    const ownRead = rows[read];
    rows[read] = (request) => {
      request.run([TRACKER_CALL, read, request.label ?? ""]);
      return ownRead(request);
    };
  }
  return host;
}

beforeEach(() => substituteCodeHost(hostReadingThroughRun()));
afterEach(() => forgetActivation());

/** What the run answers per call: a pull request named for its repository, so a lane that reads another repository's answer is visible; a tracker's list asks and is answered by the world. */
function answerOf({ args, repo }: Call): string {
  if (args[0] === REPOSITORY_CALL) return JSON.stringify([{ number: (repo ?? "primary").length, isDraft: false, headRefOid: "abc", statusCheckRollup: [],
    author: { login: "x" }, comments: [], labels: [], files: [], changedFiles: 0, body: "", reviewDecision: "" }]);
  return "[]";
}

/** The `run` the gate hands its readers: one call at a time, noted. */
function sequentialRun(seen: Call[]) {
  return (args: string[], repo?: string) => { seen.push({ args, repo }); return answerOf({ args, repo }); };
}

/** A batch that answers as `answerOf` does, refuses what `refuse` names, and notes every call it was handed, one entry per BATCH. */
function fakeBatch(batches: Call[][], refuse: (call: Call) => boolean = () => false) {
  return (calls: Call[]): Answer[] => {
    batches.push(calls);
    return calls.map((call) => (refuse(call) ? { failed: true as const, stdout: "", stderr: "refused", status: 1 } : { stdout: answerOf(call) }));
  };
}

test("POSITIVE CONTROL: the declaration holds at least two other code repositories, so 'one wave' joins more than one reader's calls", () => {
  assert.ok(OTHER_CODE.length >= 2, `the declared other code repositories: ${OTHER_CODE.map((scope) => scope.key).join(", ")}`);
});

test("CONTROL: a run handed in is not batched -- its calls arrive one at a time, tracker's first, as before", () => {
  const seen: Call[] = [];
  const lanes = readLanesAfterOutageCheck(sequentialRun(seen));
  assert.ok(seen.some(isTrackerCall) && seen.some(isRepositoryCall), "both readers' calls reached the run");
  assert.deepEqual((lanes.otherScopes as Lane[]).map(({ scope }) => scope.key), scopesOf([homeProjectDeclaration()]).filter((s) => s.key !== "").map((s) => s.key));
});

test("the tracker's calls and every other repository's arrive in ONE batch, and nothing the rehearsal named reached the run on its own", () => {
  const batches: Call[][] = [];
  const through: Call[] = [];
  readLanesAfterOutageCheck(sequentialRun(through), fakeBatch(batches));
  assert.equal(batches.length, 1, "ONE batch for both readers");
  assert.ok(batches[0].some(isTrackerCall), "the tracker lanes are in it");
  assert.ok(batches[0].filter(isRepositoryCall).length >= OTHER_CODE.length, "and every other code repository's list");
  assert.deepEqual(through.filter((call) => batches[0].some((asked) => JSON.stringify(asked) === JSON.stringify(call))), [], "none of them was asked again");
});

test("what the readers return is what they returned asked one after the other", () => {
  const sequentialTracker = readTrackerLanes(sequentialRun([]));
  const sequentialScopes = readOtherScopes(sequentialRun([]));
  const together = readLanesAfterOutageCheck(sequentialRun([]), fakeBatch([]));
  const { otherScopes, ...tracker } = together;
  assert.deepEqual(tracker, sequentialTracker);
  assert.deepEqual(otherScopes, sequentialScopes);
});

test("a refused repository is that lane's null beside the answers of the others and of the tracker (#1286)", () => {
  const [refused] = OTHER_CODE;
  const { otherScopes, ...tracker } = readLanesAfterOutageCheck(sequentialRun([]),
    fakeBatch([], (call) => call.repo !== undefined && call.args[0] === REPOSITORY_CALL && call.repo.endsWith(refused.code!.repo.split("/")[1])));
  const refusedLane = (otherScopes as Lane[]).find(({ scope }) => scope.key === refused.key)!;
  assert.equal(refusedLane.read.prs, null, "the refused lane says so");
  assert.ok((otherScopes as Lane[]).filter(({ scope }) => scope.key !== refused.key && scope.code !== null).every(({ read }) => Array.isArray(read.prs)), "the others are read");
  assert.deepEqual(tracker, readTrackerLanes(sequentialRun([])), "and the tracker's lanes are untouched");
});

test("`main` asks through this reader AFTER the outage check, and asks neither reader on its own", () => {
  const source = workGateSource();
  const main = source.slice(source.indexOf("\nfunction main() {"));
  const outageAt = main.indexOf("cannotAskExit({");
  const waveAt = main.indexOf("readLanesAfterOutageCheck(");
  assert.ok(outageAt > 0, "the outage check (`cannotAskExit`) is still in `main`");
  assert.ok(waveAt > outageAt, "and the one wave is asked after it");
  assert.doesNotMatch(main, /readTrackerLanes\(\)|readOtherScopes\(\)/, "neither reader is asked alone");
});
