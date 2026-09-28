/**
 * RULE: DOES THIS ROW'S BODY WAIT IN PROSE WHILE DECLARING NO NATIVE `blocked-by`/`blocking` LINK? --
 * #1832, follow-up implementation for `ceo`'s ruling on #1734 (2026-09-19T11:32:02Z, "Adopt C"). See
 * `packages/agent-org/src/row-claim/waiting-language-rule.mjs` for the full account: a warning, never a
 * refusal, printed by `row-file.mjs` alongside `directoryRegionWarning` and `unrecognisedRegionWarning`.
 */
import { declareWalkScope } from "../lib/walk-scope.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { waitingLanguageWarning } from "../row-claim/waiting-language-rule.mjs";

// #929: THIS GUARD READS ONLY `packages/agent-org`, so a diff that cannot reach it need not run this file.
// #2619 (child 3d of #69): `.agent-org` joins the scope -- `waiting-condition.mjs` now imports
// `ANSWER_PREFIX` from `project-vocabulary.mjs`, which reads `.agent-org/project.json` at import time.
export const WALK_SCOPE = ["packages/agent-org", ".agent-org"];
await declareWalkScope(import.meta.url);

// --- each of the three named patterns alone triggers the warning ---

test("\"waits for\" alone triggers the warning", () => {
  const body = "## Region\n\nfoo\n\nThis work waits for #1734 to close before it can start.\n";
  assert.ok(waitingLanguageWarning(body, []));
});

test("\"waits on\" alone triggers the warning", () => {
  const body = "This row waits on the publish pipeline finishing its next run.";
  assert.ok(waitingLanguageWarning(body, []));
});

test("\"blocked by\" alone triggers the warning", () => {
  const body = "This is blocked by the pending review on #900.";
  assert.ok(waitingLanguageWarning(body, []));
});

test("\"after the ... publishes\" alone triggers the warning", () => {
  const body = "We'll proceed after the release publishes tonight.";
  assert.ok(waitingLanguageWarning(body, []));
});

test("\"after the ... lands\" alone triggers the warning", () => {
  const body = "Pick this up after the fix lands on main.";
  assert.ok(waitingLanguageWarning(body, []));
});

test("\"after the ... merges\" alone triggers the warning", () => {
  const body = "Start once this is filed, but the real work is after #1827 merges.";
  assert.ok(waitingLanguageWarning(body, []));
});

// --- a body with waiting language plus `## Not-before:` does not warn ---

test("waiting language plus a `## Not-before:` field does not warn", () => {
  const body = "This row waits for the freeze to lift.\n\n## Not-before: 2026-10-01\n";
  assert.equal(waitingLanguageWarning(body, []), null);
});

// --- a body with waiting language plus --blocked-by=/--blocking= in argv does not warn ---

test("waiting language plus --blocked-by= in argv does not warn", () => {
  const body = "This row is blocked by the migration finishing first.";
  assert.equal(waitingLanguageWarning(body, ["--blocked-by=123"]), null);
});

test("waiting language plus --blocking= in argv does not warn", () => {
  const body = "This row waits for #900 to close.";
  assert.equal(waitingLanguageWarning(body, ["--blocking=900"]), null);
});

/**
 * #1977: THE SPACE FORM IS THE SAME DECLARATION. `gh issue create --help`'s own example is
 * `--blocked-by 200,201 --blocking 300`, and filing #1976 with `--blocked-by 1953` wrote the edge
 * (`gh issue view 1976 --json blockedBy` -> `{"blockedBy":[1953]}`) while this warning fired anyway. The
 * two cases below are the positive control for the fix: before it, both warned.
 */
test("#1977: waiting language plus `--blocked-by N` (space form) does not warn", () => {
  const body = "This row waits: it is blocked by #1953.";
  assert.equal(waitingLanguageWarning(body, ["--blocked-by", "1953"]), null);
});

test("#1977: waiting language plus `--blocking N` (space form) does not warn", () => {
  const body = "This row waits for #900 to close.";
  assert.equal(waitingLanguageWarning(body, ["--blocking", "900"]), null);
});

test("#1977: the space form is read mid-argv, not only as the last flag", () => {
  const body = "This row is blocked by the migration finishing first.";
  assert.equal(
    waitingLanguageWarning(body, ["--title", "t", "--blocked-by", "1953", "--label", "ready"]), null);
});

// --- a flag with no VALUE declares nothing, and still warns (`declaresRelease`'s own rule) ---

test("#1977: a trailing bare `--blocked-by` with no value still warns", () => {
  const body = "This row is blocked by the migration finishing first.";
  assert.ok(waitingLanguageWarning(body, ["--blocked-by"]));
});

test("#1977: an empty `--blocked-by=` declares nothing and still warns", () => {
  const body = "This row is blocked by the migration finishing first.";
  assert.ok(waitingLanguageWarning(body, ["--blocked-by="]));
});

test("#1977: an empty `--blocking=` declares nothing and still warns", () => {
  const body = "This row waits for #900 to close.";
  assert.ok(waitingLanguageWarning(body, ["--blocking="]));
});

test("#1977: a flag whose NAME merely starts with the blocker flag is not one -- `--blocking-only=x`", () => {
  const body = "This row waits for #900 to close.";
  assert.ok(waitingLanguageWarning(body, ["--blocking-only=x"]));
});

// --- negative cases: "after" or "waits" (or "blocked") in ordinary prose, no blocking sense ---

test("\"waits\" with no blocking sense does not warn", () => {
  const body = "The animation waits half a second before fading in.";
  assert.equal(waitingLanguageWarning(body, []), null);
});

test("\"blocked\" with no \"by\" does not warn", () => {
  const body = "The queue was blocked, but only briefly, and cleared on its own.";
  assert.equal(waitingLanguageWarning(body, []), null);
});

test("\"after\" with no publish/lands/merges nearby does not warn", () => {
  const body = "After the meeting, we regrouped and wrote up the notes.";
  assert.equal(waitingLanguageWarning(body, []), null);
});

test("prose with none of the three patterns does not warn -- #1734's own 11:10Z comment shape", () => {
  const body = "I did that at 07:48Z.";
  assert.equal(waitingLanguageWarning(body, []), null);
});

test("prose naming nothing to link to yet does not warn -- #1734's own 11:28Z table shape", () => {
  const body = "worker-4: I cannot capture.";
  assert.equal(waitingLanguageWarning(body, []), null);
});

// --- the warning itself names the remedy ---

test("the warning names both native doors -- --blocked-by and Not-before", () => {
  const warning = waitingLanguageWarning("This row waits for #1734 to close.", []);
  assert.ok(warning);
  assert.match(warning as string, /--blocked-by/);
  assert.match(warning as string, /Not-before/);
});
