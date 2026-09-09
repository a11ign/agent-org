/**
 * `--blocked-by=#N` -- #741: releases B2 ONLY, and only when the claimant's own open PR already carries a
 * measurement comment (every failing assertion, deduplicated per check from the newest run, shown outside
 * the PR's diff) and `#N` is confirmed open. See `scripts/row-claim/blocked-by-rule.mjs` for the full
 * account and why every lookup here FAILS CLOSED -- the opposite of `own-pr-health-rule.mjs`'s own
 * fail-open convention, because this is the override path itself.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MEASUREMENT_MARKER, parseBlockedByFlag, findMeasurementComment, lookupOwnPrComments,
  lookupIssueOpenState, resolveBlockedByOverride, blockedByExceptionNote,
} from "../../../../scripts/row-claim/blocked-by-rule.mjs";

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

test("lookupOwnPrComments reads comment bodies off a real gh pr view --json comments shape", () => {
  const run = (args: string[]) => {
    assert.deepEqual(args.slice(0, 2), ["pr", "view"]);
    return JSON.stringify({ comments: [{ body: "one" }, { body: "two" }] });
  };
  assert.deepEqual(lookupOwnPrComments(900, { run }), ["one", "two"]);
});

test("lookupOwnPrComments returns null, never [], on a failed lookup", () => {
  const run = (): string => { throw new Error("gh: rate limited"); };
  assert.equal(lookupOwnPrComments(900, { run }), null);
});

test("lookupIssueOpenState reads the real gh issue view --json state shape", () => {
  const run = (args: string[]) => {
    assert.deepEqual(args.slice(0, 2), ["issue", "view"]);
    return JSON.stringify({ state: "OPEN" });
  };
  assert.equal(lookupIssueOpenState(731, { run }), "OPEN");
});

test("lookupIssueOpenState returns null, never a guessed state, on a failed lookup", () => {
  const run = (): string => { throw new Error("network error"); };
  assert.equal(lookupIssueOpenState(731, { run }), null);
});

// --- resolveBlockedByOverride: THE COMPOSED VERDICT ---

const OWN_PR = { number: 900, state: "OPEN" as const, red: true };

function routedRun(routes: { comments?: string, state?: string }) {
  return (args: string[]): string => {
    if (args[0] === "pr" && args[1] === "view") return routes.comments ?? JSON.stringify({ comments: [] });
    if (args[0] === "issue" && args[1] === "view") return routes.state ?? JSON.stringify({ state: "OPEN" });
    return "";
  };
}

test("#741's own acceptance shape: comment present, #N open -- the override is accepted", () => {
  const run = routedRun({ comments: JSON.stringify({ comments: [{ body: QUALIFYING_COMMENT }] }) });
  const result = resolveBlockedByOverride(OWN_PR, "#731", { run });
  assert.equal(result.ok, true);
  assert.deepEqual(result, { ok: true, blockedByIssueNumber: 731, ownPrNumber: 900,
    measurementComment: QUALIFYING_COMMENT });
});

test("#741's own acceptance shape: without the comment, refused, naming what the comment must contain", () => {
  const run = routedRun({ comments: JSON.stringify({ comments: [{ body: "nothing relevant" }] }) });
  const result = resolveBlockedByOverride(OWN_PR, "#731", { run });
  assert.equal(result.ok, false);
  assert.match((result as { reason: string }).reason, /measurement comment/);
  assert.match((result as { reason: string }).reason, new RegExp(MEASUREMENT_MARKER.replace(":", "")));
  assert.match((result as { reason: string }).reason, /outside the PR's diff/);
});

test("#741's own acceptance shape: with #N closed, refused", () => {
  const run = routedRun({
    comments: JSON.stringify({ comments: [{ body: QUALIFYING_COMMENT }] }),
    state: JSON.stringify({ state: "CLOSED" }),
  });
  const result = resolveBlockedByOverride(OWN_PR, "#731", { run });
  assert.equal(result.ok, false);
  assert.match((result as { reason: string }).reason, /#731/);
  assert.match((result as { reason: string }).reason, /closed/);
  assert.match((result as { reason: string }).reason, /not a blocker/);
});

test("a MERGED blocker also refuses -- landed either way is not open", () => {
  const run = routedRun({
    comments: JSON.stringify({ comments: [{ body: QUALIFYING_COMMENT }] }),
    state: JSON.stringify({ state: "MERGED" }),
  });
  const result = resolveBlockedByOverride(OWN_PR, "#731", { run });
  assert.equal(result.ok, false);
  assert.match((result as { reason: string }).reason, /merged/);
});

test("an invalid --blocked-by value is refused before any lookup runs", () => {
  let ran = false;
  const run = (): string => { ran = true; return "{}"; };
  const result = resolveBlockedByOverride(OWN_PR, "not-an-issue", { run });
  assert.equal(result.ok, false);
  assert.match((result as { reason: string }).reason, /not a valid issue reference/);
  assert.equal(ran, false, "a malformed flag value is a local, pure refusal -- it must never spend a "
    + "round trip finding out");
});

test("MUTATION TARGET (#741's own instruction): FAILS CLOSED on a failed comments lookup, never treated "
  + "as 'no comment to check', which would let the override through", () => {
  const run = (args: string[]): string => {
    if (args[0] === "pr" && args[1] === "view") throw new Error("gh: rate limited");
    return JSON.stringify({ state: "OPEN" });
  };
  const result = resolveBlockedByOverride(OWN_PR, "#731", { run });
  assert.equal(result.ok, false, "an override that can be reached by a failed lookup is an override that "
    + "fires on assertion alone -- exactly what #741 is careful not to build");
});

test("MUTATION TARGET: FAILS CLOSED on a failed blocker-state lookup too", () => {
  const run = (args: string[]): string => {
    if (args[0] === "pr" && args[1] === "view") return JSON.stringify({ comments: [QUALIFYING_COMMENT] });
    throw new Error("gh: rate limited");
  };
  const result = resolveBlockedByOverride(OWN_PR, "#731", { run });
  assert.equal(result.ok, false);
});

test("no own PR at all is refused rather than crashing", () => {
  const run = routedRun({});
  const result = resolveBlockedByOverride(null, "#731", { run });
  assert.equal(result.ok, false);
  assert.match((result as { reason: string }).reason, /no open PR/);
});

// --- blockedByExceptionNote: what actually lands in the claim comment ---

test("#741's own acceptance shape: the exception note names both the blocker and the claimant's own PR", () => {
  const note = blockedByExceptionNote({ blockedByIssueNumber: 731, ownPrNumber: 900 });
  assert.match(note, /#731/);
  assert.match(note, /#900/);
  assert.match(note, /accepted/i);
});
