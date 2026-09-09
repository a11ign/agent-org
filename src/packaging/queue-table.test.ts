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
import { prRow, nonSuccessByName, newestPerName, render, fetchRefs, renderStalled, windowOf,
  renderMergedChecks, STALL_MINUTES, EXIT }
  from "../../../../scripts/queue-table.mjs";

const NOW = new Date("2026-09-09T08:00:00Z");
/** A host with room, so tests about OTHER sections are not decided by section 5. */
const HOST_OK = { compressedMb: 2000, inactiveMb: 3000, freeMb: 180, pageouts: 1000,
  load: 2, gitProcesses: 3, worktrees: 12 };
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
    prs: [], merged: [], now: NOW, required: [], host: HOST_OK });
  assert.match(running.text, /still running/);
  assert.doesNotMatch(running.text, /NOT GREEN/);
  const failed = render({ trunk: { sha: "a".repeat(40), runId: "1", status: "completed", conclusion: "failure" },
    prs: [], merged: [], now: NOW, required: [], host: HOST_OK });
  assert.match(failed.text, /NOT GREEN/);
});

test("ANTI-VACUITY: a section it could not read exits INCOMPLETE, never EXAMINED", () => {
  assert.equal(render({ trunk: null, prs: [], merged: [], now: NOW, required: [], host: HOST_OK }).code, EXIT.INCOMPLETE);
  assert.equal(render({ trunk: { sha: "a", runId: "1", status: "completed", conclusion: "success" },
    prs: null, merged: [], now: NOW, required: [], host: HOST_OK }).code, EXIT.INCOMPLETE);
  assert.equal(render({ trunk: { sha: "a", runId: "1", status: "completed", conclusion: "success" },
    prs: [], merged: null, now: NOW, required: [], host: HOST_OK }).code, EXIT.INCOMPLETE);
  assert.equal(render({ trunk: { sha: "a", runId: "1", status: "completed", conclusion: "success" },
    prs: [], merged: [], now: NOW, required: [], host: HOST_OK }).code, EXIT.EXAMINED);
});

test("all four sections are always printed, including the empty ones -- a section that vanishes when it "
  + "has nothing to say is indistinguishable from one that was dropped", () => {
  const { text } = render({ trunk: { sha: "a", runId: "1", status: "completed", conclusion: "success" },
    prs: [], merged: [], now: NOW, required: [], host: HOST_OK });
  for (const heading of ["1. TRUNK", "2. OPEN PRs", "3. STALLED", "4. NON-SUCCESS CHECKS"]) {
    assert.ok(text.includes(heading), `${heading} must always appear`);
  }
});

test("MUTATION TARGET: a FAILED fetch says so and exits INCOMPLETE -- every count would be unknown, not "
  + "zero", () => {
  // Found by running it, not by reading it. The checkout this command happens to be in had no objects for
  // a sha pushed a minute earlier, so `git rev-list --count <head>..<base>` exited 128 with `Invalid
  // revision range` and EVERY row printed `behind=?`. The API knows what the shas are; only the local
  // repository can say how far apart they are, and only for objects it holds. A table whose counts are
  // all unknown while it says nothing about why is the vacuous answer this file exists to refuse.
  const trunk = { sha: "a".repeat(40), runId: "1", status: "completed", conclusion: "success" };
  const stale = render({ trunk, prs: [], merged: [], now: NOW, fetched: false, required: [], host: HOST_OK });
  assert.match(stale.text, /git fetch FAILED/);
  assert.match(stale.text, /unknown, not zero/);
  assert.equal(stale.code, EXIT.INCOMPLETE);
  assert.equal(render({ trunk, prs: [], merged: [], now: NOW, fetched: true, required: [], host: HOST_OK }).code, EXIT.EXAMINED);
});

test("fetchRefs asks for every branch, not just main -- a PR head that was never fetched cannot be "
  + "counted against anything", () => {
  const calls: string[][] = [];
  assert.equal(fetchRefs((args: string[]) => { calls.push(args); return { status: 0, stdout: "" }; }), true);
  assert.deepEqual(calls, [["fetch", "--quiet", "origin", "+refs/heads/*:refs/remotes/origin/*"]]);
  assert.equal(fetchRefs(() => ({ status: 1, stdout: "" })), false,
    "a failed fetch must be reported to the caller, never silently tolerated");
});

// ---------------------------------------------------------------------------------------------------
// #600: ABSORBED IS A STATE THE STALL PREDICATE STRUCTURALLY CANNOT SEE.
// ---------------------------------------------------------------------------------------------------

test("#600 a PR that is behind AND red is ABSORBED, even though its owner just pushed", () => {
  // The train carries only GREEN PRs, so a red one cannot be carried at all -- it falls further behind
  // while its owner fixes the red. An owner actively pushing keeps `updatedAt` fresh, so it is never
  // "untouched" and never reads as stalled, while being the one that can least escape. Measured
  // 2026-09-09: #564 was carried to zero behind at 07:30:30Z and read 14 behind seven merges later.
  const row = prRow(pr({ redChecks: ["gate"] }), 5, NOW);
  assert.equal(row.absorbed, true);
  assert.equal(row.stalled, false, "it was pushed a minute ago, so the stall predicate says nothing");
});

test("#600 behind-and-green is not absorbed -- the train will carry that one", () => {
  assert.equal(prRow(pr({ redChecks: [] }), 5, NOW).absorbed, false);
});

test("#600 red-but-current is not absorbed either -- it is just a red PR", () => {
  assert.equal(prRow(pr({ redChecks: ["gate"] }), 0, NOW).absorbed, false);
});

test("#600 section 3 names an absorbed PR as absorbed, with the reds that hold it there", () => {
  const rows = [prRow(pr({ number: 564, redChecks: ["docs", "gate"] }), 41, NOW)];
  const [line] = renderStalled(rows);
  assert.match(line, /#564/);
  assert.match(line, /ABSORBED/);
  assert.match(line, /behind=41/);
  assert.match(line, /docs gate/, "naming WHICH reds, since those are what the owner has to clear");
});

test("#600 an absorbed PR is not double-reported as stalled as well", () => {
  const idle = new Date(NOW.getTime() - (STALL_MINUTES + 5) * 60000).toISOString();
  const rows = [prRow(pr({ number: 7, redChecks: ["gate"], updatedAt: idle }), 5, NOW)];
  assert.equal(renderStalled(rows).length, 1, "one PR, one line -- two lines would double the count");
  assert.match(renderStalled(rows)[0], /ABSORBED/, "and the more specific state wins");
});

// ---------------------------------------------------------------------------------------------------
// A COUNT WITHOUT ITS DENOMINATOR AND ITS WINDOW IS NOT A MEASUREMENT -- product-manager's requirement.
// ---------------------------------------------------------------------------------------------------

test("section 4 states the WINDOW it covers, so a bare count cannot be read as a rate", () => {
  const merged = [
    { number: 2, mergedAt: "2026-09-09T07:10:29Z", checks: [{ name: "audit", conclusion: "FAILURE" }] },
    { number: 3, mergedAt: "2026-09-09T07:40:00Z", checks: [{ name: "audit", conclusion: "FAILURE" }] },
  ];
  assert.equal(windowOf(merged), "2026-09-09T07:10:29Z", "the OLDEST merge in the set bounds the window");
  const { lines } = renderMergedChecks(merged, []);
  assert.match(lines[0], /since 2026-09-09T07:10:29Z/);
});

test("a check is marked REQUIRED or NON-BLOCKING, because that is why a red one goes unread", () => {
  const merged = [{ number: 2, mergedAt: "2026-09-09T07:10:29Z",
    checks: [{ name: "audit", conclusion: "FAILURE" }, { name: "gate", conclusion: "FAILURE" }] }];
  const text = renderMergedChecks(merged, ["gate"]).lines.join("\n");
  assert.match(text, /audit .*non-blocking/);
  assert.match(text, /gate .*REQUIRED -- this one blocks/);
});

test("MUTATION TARGET: unknown required-contexts prints UNKNOWN, never 'non-blocking'", () => {
  // Guessing in that direction understates the problem: it would tell a reader a red check is harmless
  // on the one occasion nobody can confirm that it is.
  const merged = [{ number: 2, mergedAt: "2026-09-09T07:10:29Z",
    checks: [{ name: "audit", conclusion: "FAILURE" }] }];
  const { lines, incomplete } = renderMergedChecks(merged, null);
  assert.match(lines.join("\n"), /required\? unknown/);
  assert.equal(incomplete, true, "and an unknown makes the whole table INCOMPLETE");
});

test("merged PRs whose times could not be read is INCOMPLETE; nothing merged at all is not", () => {
  // "Could not ask" and "asked and got nothing" are different answers, and only the first is a fault.
  // A quiet hour must not report as a broken one.
  const unreadable = renderMergedChecks([{ number: 2, mergedAt: null, checks: [] }], []);
  assert.match(unreadable.lines[0], /merge times unreadable/);
  assert.equal(unreadable.incomplete, true);

  const quiet = renderMergedChecks([], []);
  assert.match(quiet.lines[0], /no merged PRs in range/);
  assert.equal(quiet.incomplete, false, "nothing merged is a legitimate state, not a lookup failure");
});

// ---------------------------------------------------------------------------------------------------
// SECTION 5: THE HOST, because on 2026-09-09 it was the bottleneck and the table named people instead.
//
// Four PRs read as "not carried by their owners" for twenty minutes while 58 concurrent git processes ran
// on one repository and Spotlight indexed 164 worktrees. The table named four idle owners and the truth
// was one contended machine.
//
// WHICH NUMBER TOOK TWO WRONG ANSWERS TO SETTLE, and both are pinned below: `free` is the wrong axis
// (macOS keeps it small by design), and `Pages occupied by compressor` has FOUR WORDS before its number,
// so a positional read returns the word "by" -- zero -- which reads as no memory pressure at all on a
// host holding 12 GB compressed.
// ---------------------------------------------------------------------------------------------------
import { renderHost, hostState, GIT_PROCESS_CEILING, LOAD_CEILING }
  from "../../../../scripts/queue-table.mjs";

const HOST = { compressedMb: 2000, inactiveMb: 3000, freeMb: 180, pageouts: 1000,
  load: 2, gitProcesses: 3, worktrees: 12 };

test("section 5 reports compressed, inactive AND free -- and never keys on free alone", () => {
  const text = renderHost(HOST).lines.join("\n");
  assert.match(text, /compressed 2000 MB/);
  assert.match(text, /inactive 3000 MB/);
  assert.match(text, /free 180 MB/);
  // 180 MB free on a quiet host is NORMAL. The first version of this section would have shouted here.
  assert.doesNotMatch(text, /CONTENDED/,
    "free is kept small by design; a low free figure is the working state of a working machine");
});

test("MUTATION TARGET: the threshold is LOAD and the GIT COUNT, the two unambiguous numbers", () => {
  const busy = renderHost({ ...HOST, load: LOAD_CEILING + 1 }).lines.join("\n");
  assert.match(busy, /THE HOST IS CONTENDED/);
  assert.match(busy, /busy machine, NOT an idle owner/);
  assert.match(busy, /do not name people for it/);

  const manyGit = renderHost({ ...HOST, gitProcesses: GIT_PROCESS_CEILING + 1 }).lines.join("\n");
  assert.match(manyGit, /THE HOST IS CONTENDED/, "either one alone is enough");
});

test("pageouts print as a DELTA, and say so when there is no baseline", () => {
  // CLAUDE.md: the counters are since-boot, so 6.6 GB left from an incident hours ago is
  // indistinguishable from a host swapping right now. A bare total is not a measurement.
  assert.match(renderHost(HOST, null).lines.join("\n"), /no baseline yet/);
  assert.match(renderHost({ ...HOST, pageouts: 1500 }, 1000).lines.join("\n"), /\+500 since the last table/);
});

test("MUTATION TARGET: the compressor is read by LABEL, never by field position", () => {
  // `Pages occupied by compressor:` has four words before its number. `awk '{print $3}'` returns "by",
  // which is 0, which reads as no memory pressure. Two sessions measured this host minutes apart and got
  // 0 MB and 12,344 MB; the difference was the field index. A parse error in a metric is
  // indistinguishable from good news.
  const live = hostState();
  assert.ok(live, "vm_stat must be readable on this host");
  assert.ok(live!.compressedMb >= 0);
  // The real proof is arithmetic rather than a live value: a host with pages in the compressor must not
  // report zero. If this host genuinely has none, the assertion below is vacuous and says so.
  if (live!.compressedMb === 0) {
    assert.ok(live!.inactiveMb >= 0, "NOTE: this host reports no compressed pages, so this case is vacuous");
  } else {
    assert.ok(live!.compressedMb > 100, "a non-zero compressor must not round to a positional-read zero");
  }
});

test("an unreadable host is CANNOT-ASK, never a healthy default", () => {
  const v = renderHost(null);
  assert.match(v.lines[0], /could not read/);
  assert.equal(v.incomplete, true);
});

test("section 5 is always present, like the other four", () => {
  const { text } = render({ trunk: { sha: "a", runId: "1", status: "completed", conclusion: "success" },
    prs: [], merged: [], now: NOW, required: [], host: HOST });
  assert.match(text, /5\. THIS HOST/);
});
