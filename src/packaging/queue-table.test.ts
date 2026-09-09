/**
 * THE HOURLY TABLE AS A COMMAND -- ceo's ruling 2026-09-08, after a missed 19:17Z edition, a merge
 * unrelayed for an hour, and a red `audit` check the chairman found on seven merged PRs before anyone in
 * the org read the same view. A missed table produced by a habit is invisible; a missed table produced by
 * a script is a missing paste.
 *
 * These pin the parts that would silently give a wrong table rather than no table.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { prRow, nonSuccessByName, newestPerName, render, STALL_MINUTES, EXIT }
  from "../../../../scripts/queue-table.mjs";

const NOW = new Date("2026-09-09T08:00:00Z");
const pr = (over = {}) => ({
  number: 1, headRefName: "pm/x", headRefOid: "a".repeat(40), mergeStateStatus: "BLOCKED",
  armed: true, updatedAt: "2026-09-09T07:55:00Z", redChecks: [], ...over,
});

test("the owner comes from the branch PREFIX, and a prefixless branch says so rather than guessing", () => {
  assert.equal(prRow(pr({ headRefName: "dispatcher/x" }), 0, NOW).owner, "dispatcher");
  assert.equal(prRow(pr({ headRefName: "main" }), 0, NOW).owner, "(no prefix)");
});

test("behind=null survives to the row as null -- an unreadable count must not print as zero", () => {
  // Zero and unknown are opposite answers: one says "current", the other says "I could not ask". A table
  // that renders both as 0 tells the reader every PR is current on the morning nothing can be measured.
  assert.equal(prRow(pr(), null, NOW).behind, null);
  assert.equal(prRow(pr(), 0, NOW).behind, 0);
});

test(`stalled means BEHIND and untouched for ${STALL_MINUTES}+ minutes -- neither alone`, () => {
  const idle = new Date(NOW.getTime() - (STALL_MINUTES + 5) * 60000).toISOString();
  assert.equal(prRow(pr({ updatedAt: idle }), 3, NOW).stalled, true, "behind and idle");
  assert.equal(prRow(pr({ updatedAt: idle }), 0, NOW).stalled, false, "idle but current is not stalled");
  assert.equal(prRow(pr(), 3, NOW).stalled, false, "behind but just pushed is waiting, not stalled");
});

test("MUTATION TARGET: SKIPPED and NEUTRAL are not red -- otherwise every path-filtered job reads as a "
  + "failure on every PR that did not touch its paths", () => {
  const { byName } = nonSuccessByName([{ number: 7, checks: [
    { name: "python", conclusion: "SKIPPED" }, { name: "docs", conclusion: "NEUTRAL" },
    { name: "gate", conclusion: "SUCCESS" }, { name: "audit", conclusion: "FAILURE" },
  ] }]);
  assert.deepEqual([...byName.keys()], ["audit"]);
});

test("section 4 counts BY NAME, so one check red on ten PRs and ten checks red on one PR differ", () => {
  const merged = [1, 2, 3].map((n) => ({ number: n, checks: [{ name: "audit", conclusion: "FAILURE" }] }));
  const { byName } = nonSuccessByName(merged);
  assert.deepEqual(byName.get("audit"), [1, 2, 3]);
});

test("a PR whose checks could not be read is NAMED, never counted as clean", () => {
  const { byName, unreadable } = nonSuccessByName([{ number: 9, checks: null }]);
  assert.equal(byName.size, 0);
  assert.deepEqual(unreadable, [9], "a table that omits what it could not read is worse than no table -- "
    + "the reader counts what is there");
});

test("newestPerName takes the NEWEST run of a name, never the first (#498/#500/#517/#582)", () => {
  const rollup = [
    { name: "gate", conclusion: "FAILURE", completedAt: "2026-09-09T07:00:00Z" },
    { name: "gate", conclusion: "SUCCESS", completedAt: "2026-09-09T07:30:00Z" },
  ];
  assert.equal(newestPerName(rollup)[0].conclusion, "SUCCESS");
  assert.equal(newestPerName([...rollup].reverse())[0].conclusion, "SUCCESS",
    "and the answer must not depend on the order GitHub happened to return them in");
});

test("an in-flight check reports the ZERO DATE and must not outrank a real completion", () => {
  const rollup = [
    { name: "gate", conclusion: "SUCCESS", completedAt: "2026-09-09T07:30:00Z" },
    { name: "gate", conclusion: "", completedAt: "0001-01-01T00:00:00Z", startedAt: "0001-01-01T00:00:00Z" },
  ];
  assert.equal(newestPerName(rollup)[0].conclusion, "SUCCESS");
});

test("STILL RUNNING IS NOT RED -- a table that shouts on every in-flight run is one people stop reading", () => {
  const running = render({ trunk: { sha: "a".repeat(40), runId: "1", status: "in_progress", conclusion: "" },
    prs: [], merged: [], now: NOW });
  assert.match(running.text, /still running/);
  assert.doesNotMatch(running.text, /NOT GREEN/);
  const failed = render({ trunk: { sha: "a".repeat(40), runId: "1", status: "completed", conclusion: "failure" },
    prs: [], merged: [], now: NOW });
  assert.match(failed.text, /NOT GREEN/);
});

test("ANTI-VACUITY: a section it could not read exits INCOMPLETE, never EXAMINED", () => {
  assert.equal(render({ trunk: null, prs: [], merged: [], now: NOW }).code, EXIT.INCOMPLETE);
  assert.equal(render({ trunk: { sha: "a", runId: "1", status: "completed", conclusion: "success" },
    prs: null, merged: [], now: NOW }).code, EXIT.INCOMPLETE);
  assert.equal(render({ trunk: { sha: "a", runId: "1", status: "completed", conclusion: "success" },
    prs: [], merged: null, now: NOW }).code, EXIT.INCOMPLETE);
  assert.equal(render({ trunk: { sha: "a", runId: "1", status: "completed", conclusion: "success" },
    prs: [], merged: [], now: NOW }).code, EXIT.EXAMINED);
});

test("all four sections are always printed, including the empty ones -- a section that vanishes when it "
  + "has nothing to say is indistinguishable from one that was dropped", () => {
  const { text } = render({ trunk: { sha: "a", runId: "1", status: "completed", conclusion: "success" },
    prs: [], merged: [], now: NOW });
  for (const heading of ["1. TRUNK", "2. OPEN PRs", "3. STALLED", "4. NON-SUCCESS CHECKS"]) {
    assert.ok(text.includes(heading), `${heading} must always appear`);
  }
});
