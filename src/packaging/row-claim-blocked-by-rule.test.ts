/**
 * `--blocked-by=#N` -- #741: releases B2 ONLY, and only when the claimant's own open PR already carries a
 * measurement comment (every failing assertion, deduplicated per check from the newest run, shown outside
 * the PR's diff) and `#N` is confirmed open. See `packages/agent-org/src/row-claim/blocked-by-rule.ts` for the full
 * account and why every lookup here FAILS CLOSED -- the opposite of `own-pr-health-rule.ts`'s own
 * fail-open convention, because this is the override path itself.
 */
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { forgetActivation, substituteCodeHost } from "../plugins/active.ts";
import { createFakeCodeHost } from "../plugins/fakes/code-host.ts";
import { fakeRow, type FakeRowPull } from "../plugins/fakes/code-host-rows.ts";
import {
  MEASUREMENT_MARKER, parseBlockedByFlag, findMeasurementComment, lookupOwnPrComments,
  lookupIssueOpenState, resolveBlockedByOverride, blockedByExceptionNote,
} from "../row-claim/blocked-by-rule.ts";

// THE LOOKUPS ASK THE CODE HOST'S ROWS (A11-160, step 7; they were a stubbed `gh` before). The fake code host answers from a world the test seeds and ignores the `run` it is handed, so the `run` below is one that fails
// the test if anything reaches it. What the lookups SEND to GitHub (the argument lists) is asserted by `plugins/github/rows/` and the claim's route table, not here.
afterEach(() => forgetActivation());

const unreached = (): string => { throw new Error("a run was made: the code host's rows answer from the world, not from a `gh`"); };

const ownPullAt = (number: number, comments: string[]): FakeRowPull => ({ number, body: "", headRefName: `branch-${number}`, labels: [], isDraft: false, armed: false, merged: false, mergedAt: null, createdAt: "2026-10-01T00:00:00Z", comments });

/** The fake code host, with pull request `900` carrying `comments` and the blocker `731` in `state`; returns the world and the options every lookup is given. */
function fakeHost({ comments = [] as string[], state = "OPEN" as "OPEN" | "CLOSED" } = {}) {
  const host = createFakeCodeHost();
  const world = host.rowsWorld;
  world.pulls.set(900, ownPullAt(900, comments));
  world.rows.set(731, fakeRow(world, 731, { state }));
  substituteCodeHost(host);
  return { world, deps: { run: unreached, repo: world.repo } };
}

// --- parseBlockedByFlag: pure ---

test("parseBlockedByFlag reads #731 as 731", () => {
  assert.equal(parseBlockedByFlag("#731"), 731);
});

test("parseBlockedByFlag reads a bare 731 the same way", () => {
  assert.equal(parseBlockedByFlag("731"), 731);
});

test("parseBlockedByFlag refuses garbage, never NaN or 0", () => {
  assert.equal(parseBlockedByFlag("abc"), null);
  assert.equal(parseBlockedByFlag(""), null);
  assert.equal(parseBlockedByFlag("#0"), null);
  assert.equal(parseBlockedByFlag(undefined), null);
});

// --- findMeasurementComment: pure -- SHAPE ONLY, never judges the claim's truth ---

const QUALIFYING_COMMENT = `${MEASUREMENT_MARKER} #722 is red only on assertions introduced by #718's `
  + "merge, outside this PR's diff.\n\n"
  + "- ts (newest run): \"Cannot find module './closure'\" -- outside the diff\n"
  + "- lint (newest run): \"no-undef: closure\" -- outside the diff\n";

test("#741's own acceptance shape: a properly-marked comment is found", () => {
  assert.equal(findMeasurementComment(["just chatting", QUALIFYING_COMMENT]), QUALIFYING_COMMENT);
});

test("no comment at all is null, never a false positive", () => {
  assert.equal(findMeasurementComment([]), null);
  assert.equal(findMeasurementComment(["lgtm", "ready for review"]), null);
});

test("MUTATION TARGET: the marker alone, with no outside/diff claim and no listed assertion, does not qualify", () => {
  assert.equal(findMeasurementComment([`${MEASUREMENT_MARKER} trust me`]), null);
});

test("MUTATION TARGET: outside/diff language with no marker header does not qualify", () => {
  assert.equal(findMeasurementComment(["- ts: fails, outside the diff"]), null,
    "the marker is what makes this a MEASUREMENT comment rather than an ordinary status update that "
    + "happens to use the words 'outside' and 'diff'");
});

test("MUTATION TARGET: a marker and outside/diff language with no bulleted assertion does not qualify", () => {
  assert.equal(findMeasurementComment([`${MEASUREMENT_MARKER} everything is outside the diff, trust me`]),
    null, "a comment that never actually NAMES a failing assertion is not a measurement, whatever else it says");
});

test("the FIRST qualifying comment wins when more than one exists", () => {
  const second = `${MEASUREMENT_MARKER} a later one\n\n- also outside the diff\n`;
  assert.equal(findMeasurementComment([QUALIFYING_COMMENT, second]), QUALIFYING_COMMENT);
});

// --- lookupOwnPrComments / lookupIssueOpenState: fail CLOSED (null) on any lookup trouble ---

test("lookupOwnPrComments reads comment bodies off the pull request", () => {
  const { deps } = fakeHost({ comments: ["one", "two"] });
  assert.deepEqual(lookupOwnPrComments(900, deps), ["one", "two"]);
});

test("lookupOwnPrComments returns null, never [], on a failed lookup", () => {
  const { world, deps } = fakeHost({ comments: ["one"] });
  world.failures.set("readPullComments", new Error("gh: rate limited"));
  assert.equal(lookupOwnPrComments(900, deps), null);
});

test("lookupIssueOpenState reads the row's state", () => {
  const { deps } = fakeHost();
  assert.equal(lookupIssueOpenState(731, deps), "OPEN");
});

test("lookupIssueOpenState returns null, never a guessed state, on a failed lookup", () => {
  const { world, deps } = fakeHost();
  world.failures.set("stateOfRow", new Error("network error"));
  assert.equal(lookupIssueOpenState(731, deps), null);
});

// --- resolveBlockedByOverride: THE COMPOSED VERDICT ---

const OWN_PR = { number: 900, state: "OPEN" as const, reasons: ["FAILING: ts (failure)."] };

test("#741's own acceptance shape: comment present, #N open -- the override is accepted", () => {
  const { deps } = fakeHost({ comments: [QUALIFYING_COMMENT] });
  const result = resolveBlockedByOverride(OWN_PR, "#731", deps);
  assert.equal(result.ok, true);
  assert.deepEqual(result, { ok: true, blockedByIssueNumber: 731, ownPrNumber: 900,
    measurementComment: QUALIFYING_COMMENT });
});

test("#741's own acceptance shape: without the comment, refused, naming what the comment must contain", () => {
  const { deps } = fakeHost({ comments: ["nothing relevant"] });
  const result = resolveBlockedByOverride(OWN_PR, "#731", deps);
  assert.equal(result.ok, false);
  assert.match((result as { reason: string }).reason, /measurement comment/);
  assert.match((result as { reason: string }).reason, new RegExp(MEASUREMENT_MARKER.replace(":", "")));
  assert.match((result as { reason: string }).reason, /outside the PR's diff/);
});

test("#741's own acceptance shape: with #N closed, refused", () => {
  const { deps } = fakeHost({ comments: [QUALIFYING_COMMENT], state: "CLOSED" });
  const result = resolveBlockedByOverride(OWN_PR, "#731", deps);
  assert.equal(result.ok, false);
  assert.match((result as { reason: string }).reason, /#731/);
  assert.match((result as { reason: string }).reason, /closed/);
  assert.match((result as { reason: string }).reason, /not a blocker/);
});

test("an invalid --blocked-by value is refused before any lookup runs", () => {
  const { world, deps } = fakeHost({ comments: [QUALIFYING_COMMENT] });
  world.failures.set("readPullComments", new Error("LOOKED UP the comments"));
  world.failures.set("stateOfRow", new Error("LOOKED UP the state"));
  const result = resolveBlockedByOverride(OWN_PR, "not-an-issue", deps);
  assert.equal(result.ok, false);
  assert.match((result as { reason: string }).reason, /not a valid issue reference/);
  assert.doesNotMatch((result as { reason: string }).reason, /LOOKED UP/, "a malformed flag value is a local, pure refusal -- it must never spend "
    + "a round trip finding out (a lookup would have been refused by name, and the reason would say so)");
});

test("MUTATION TARGET (#741's own instruction): FAILS CLOSED on a failed comments lookup, never treated "
  + "as 'no comment to check', which would let the override through", () => {
  const { world, deps } = fakeHost({ comments: [QUALIFYING_COMMENT] });
  world.failures.set("readPullComments", new Error("gh: rate limited"));
  const result = resolveBlockedByOverride(OWN_PR, "#731", deps);
  assert.equal(result.ok, false, "an override that can be reached by a failed lookup is an override that "
    + "fires on assertion alone -- exactly what #741 is careful not to build");
});

test("MUTATION TARGET: FAILS CLOSED on a failed blocker-state lookup too", () => {
  const { world, deps } = fakeHost({ comments: [QUALIFYING_COMMENT] });
  world.failures.set("stateOfRow", new Error("gh: rate limited"));
  const result = resolveBlockedByOverride(OWN_PR, "#731", deps);
  assert.equal(result.ok, false);
});

test("no own PR at all is refused rather than crashing -- and the refusal is FOLLOWABLE (#989)", () => {
  // After #989 this is the COMMON case, not an edge: B2's only remaining refusal is a row IN BUILD, which
  // has no PR by definition. Naming the missing PR alone would point at an action the claimant cannot
  // take, so it names the door that exists -- the same one B2's own refusal names.
  const { deps } = fakeHost();
  const result = resolveBlockedByOverride(null, "#731", deps);
  assert.equal(result.ok, false);
  const reason = (result as { reason: string }).reason;
  assert.match(reason, /no PR of this session's own to attach a measurement comment to/);
  assert.match(reason, /decline/, "following a refusal exactly must pass; this one must name how");
});

// --- blockedByExceptionNote: what actually lands in the claim comment ---

test("#741's own acceptance shape: the exception note names both the blocker and the claimant's own PR", () => {
  const note = blockedByExceptionNote({ blockedByIssueNumber: 731, ownPrNumber: 900 });
  assert.match(note, /#731/);
  assert.match(note, /#900/);
  assert.match(note, /accepted/i);
});
