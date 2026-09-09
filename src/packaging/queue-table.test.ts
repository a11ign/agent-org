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
import { loadavg } from "node:os";
import { prRow, nonSuccessByName, newestPerName, render, fetchRefs, renderStalled, windowOf,
  renderMergedChecks, STALL_MINUTES, EXIT, hostState, hostContention, reliefFor, topConsumers }
  from "../../../../scripts/queue-table.mjs";

const NOW = new Date("2026-09-09T08:00:00Z");
/** A host with room, so tests about OTHER sections are not decided by section 5. */
const HOST_OK = { compressedMb: 2000, inactiveMb: 3000, freeMb: 180, pageouts: 1000,
  load: 2, gitProcesses: 3, worktrees: 12, topConsumers: null };
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
import { renderHost, GIT_PROCESS_CEILING, LOAD_CEILING }
  from "../../../../scripts/queue-table.mjs";

const HOST = { compressedMb: 2000, inactiveMb: 3000, freeMb: 180, pageouts: 1000,
  load: 2, gitProcesses: 3, worktrees: 12, topConsumers: null };

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
  // `Pages occupied by compressor:` has FOUR WORDS before its number. `awk '{print $3}'` returns "by",
  // which is 0, which reads as no memory pressure. Two sessions measured this host minutes apart and got
  // 0 MB and 12,344 MB; the difference was the field index. A parse error in a metric is
  // indistinguishable from good news.
  //
  // DRIVEN AGAINST A FIXTURE, NOT AGAINST THIS MACHINE. The first version of this test called
  // `hostState()` and asserted on the live reading -- which shells to `vm_stat`, a command that does not
  // exist on the Linux runner CI uses, so it returned null and the test failed everywhere except the Mac
  // it was written on. A test that can only pass on its author's machine is this repository's own
  // "verified on a host you did not name" defect, one door along.
  const stat = [
    "Mach Virtual Memory Statistics: (page size of 16384 bytes)",
    "Pages free:                                3872.",
    "Pages inactive:                          450645.",
    "Pages occupied by compressor:            790027.",
    "Pageouts:                              10614194.",
  ].join("\n");

  const positional = Number(stat.split("\n").find((l) => l.includes("compressor"))!.split(/\s+/)[2]);
  assert.ok(Number.isNaN(positional) || positional === 0,
    "the third field of that line is the word `by` -- this is the read that reported zero on a host "
    + "holding 12 GB, and the reason the parser must be labelled");

  const labelled = Number(/Pages occupied by compressor:\s+(\d+)/.exec(stat)![1]);
  assert.equal(labelled, 790027);
  assert.equal(Math.round((labelled * 16384) / 1048576), 12344,
    "790,027 pages at 16 KB is 12,344 MB -- the figure the positional read turned into 0");
});

test("the page size comes from vm_stat's own header, never a hard-coded 4096", () => {
  // Apple Silicon reports 16384. A parser assuming 4096 divides every figure by four and reports a
  // starved host as comfortable -- the same class as the positional read, arriving through a constant.
  const stat = "Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free: 3872.";
  assert.equal(Number((/page size of (\d+)/.exec(stat) ?? [])[1]), 16384);
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

/**
 * SECTION 5 REPORTED A CONTENDED HOST AS FINE FOR NINETY MINUTES, and the mechanism is this repository's
 * most-repeated defect wearing a new hat.
 *
 * `hostState().load` shelled to `sysctl`, which lives in `/usr/sbin` -- not on the PATH a node script
 * inherits from a shell that exported a minimal one. `ask()` caught the ENOENT and returned null, and the
 * verdict was `(host.load ?? 0) > LOAD_CEILING`: **the absence of the reading, coalesced to zero, answers
 * "is this host contended" with "no".** Measured 2026-09-09T10:44Z -- real load 15.08 against a ceiling
 * of 12, and the table printed `load ?` with no contention warning under a heading whose own text says
 * "it was the bottleneck and nothing said so."
 *
 * A metric that fails into the REASSURING answer is worse than no metric, because it is believed. This is
 * the same sentence as `INCONCLUSIVE` never folding into "not merged" (prune), as CANNOT_ASK never
 * folding into READY (row-claim), and as the publish blocker's NOT EXAMINED never folding into `found: 0`
 * -- four instances in one day, in four unrelated files.
 */
test("#681 hostContention: an UNREADABLE load is never a verdict that the host is fine", () => {
  const host = { compressedMb: 1, inactiveMb: 1, freeMb: 1, pageouts: 0, load: null,
    gitProcesses: 3, worktrees: 10, topConsumers: null };
  const { contended, unknown } = hostContention(host);
  assert.equal(contended, false, "it cannot claim contention it did not measure either");
  assert.deepEqual(unknown, ["load"], "but it must SAY the load is missing, not print a bare `no`");
  const rendered = renderHost(host).lines.join("\n");
  assert.match(rendered, /COULD NOT READ: load/);
  assert.match(rendered, /not a reading of zero/);
});

test("#681 MUTATION TARGET: restoring `host.load ?? 0` makes an unreadable load pass the ceiling test silently", () => {
  const host = { compressedMb: 1, inactiveMb: 1, freeMb: 1, pageouts: 0, load: null,
    gitProcesses: null, worktrees: 10, topConsumers: null };
  // The pre-#681 expression, written out so the defect is reproducible rather than described:
  const oldVerdict = (host.load ?? 0) > LOAD_CEILING || (host.gitProcesses ?? 0) > GIT_PROCESS_CEILING;
  assert.equal(oldVerdict, false, "the old expression says `not contended` on two unreadable metrics");
  const { contended, unknown } = hostContention(host);
  assert.equal(contended, false);
  assert.deepEqual(unknown, ["load", "git process count"],
    "the new one says the same `false` and NAMES what it could not ask -- the whole difference");
  assert.match(renderHost(host).lines.join("\n"), /COULD NOT READ: load, git process count/);
});

test("#681 a load genuinely above the ceiling is still reported as contended, with the reading printed", () => {
  const host = { compressedMb: 1, inactiveMb: 1, freeMb: 1, pageouts: 0, load: 15.08,
    gitProcesses: 2, worktrees: 10, topConsumers: null };
  assert.deepEqual(hostContention(host), { contended: true, unknown: [] });
  const rendered = renderHost(host).lines.join("\n");
  assert.match(rendered, /load 15\.08/, "the number is printed, not just its verdict");
  assert.match(rendered, /THE HOST IS CONTENDED/);
  assert.ok(!rendered.includes("COULD NOT READ"), "nothing was missing, so nothing is named missing");
});

test("#681 a NaN load is treated as unreadable, not as a number below the ceiling", () => {
  const host = { compressedMb: 1, inactiveMb: 1, freeMb: 1, pageouts: 0, load: NaN,
    gitProcesses: 1, worktrees: 10, topConsumers: null };
  // `Number("")` and `Number(undefined)` are both NaN, and `NaN > 12` is false -- the identical
  // failure-into-good-news the null case has, arriving through a parse rather than through a spawn.
  const { contended, unknown } = hostContention(host);
  assert.equal(contended, false);
  assert.deepEqual(unknown, ["load"]);
});

/**
 * AND THIS TEST NEARLY SHIPPED THE SAME DEFECT AS THE ONE ABOVE IT. Its first draft opened with
 * `const host = hostState(); assert.ok(host)` -- and `hostState()` shells to `vm_stat`, which does not
 * exist on the Linux runner, so it returned null and the assertion failed there while passing here. That
 * is precisely the fault fixed in this file hours earlier (`the compressor test ran vm_stat, so it could
 * only pass on the machine it was written on`), reintroduced by the person who fixed it, inside the
 * commit that fixes the same CLASS in the code under test.
 *
 * So the property is asserted where it actually lives: `loadavg()` is Node's own call and works on every
 * platform, which is the entire reason it replaced `sysctl`. The host-dependent half SKIPS HONESTLY.
 */
test("#681 the load reads with no PATH dependency -- os.loadavg(), never a subprocess", () => {
  const [oneMinute] = loadavg();
  assert.equal(typeof oneMinute, "number");
  assert.ok(!Number.isNaN(oneMinute), "os.loadavg() cannot ENOENT the way `sysctl` on a minimal PATH did");
  assert.ok(oneMinute >= 0);

  const host = hostState();
  if (host === null) return; // no `vm_stat`: not this test's subject, and not a pass to fake either
  assert.equal(host.load, oneMinute, "hostState reports that same number, unmediated");
});

/**
 * "CONTENDED" WITHOUT THE CONSUMER IS A VERDICT WITHOUT A CAUSE, and the remedies are disjoint enough
 * that naming the wrong one costs the whole cycle. Measured 2026-09-09T11:30Z: the table said "stop
 * running `npm test` locally" while the top five by CPU were Docker's VM at 134%, Spotlight at 61%,
 * WindowServer at 51% and Zoom at 39% -- not one of them ours. Every session could have stopped
 * everything and the load would not have moved.
 */
test("#681 reliefFor: when NONE of the top five is ours, it says so and says throttling will not help", () => {
  const lines = reliefFor([
    { command: "com.apple.Virtualization.VirtualMachine", cpu: 134 },
    { command: "mds_stores", cpu: 61 }, { command: "WindowServer", cpu: 51 },
    { command: "zoom.us", cpu: 39 }, { command: "diagnosticd", cpu: 25 },
  ]).join("\n");
  assert.match(lines, /SOMEBODY IS USING THIS MACHINE \(zoom\.us\)/);
  assert.match(lines, /one push at a time across all/);
  assert.match(lines, /Spotlight is indexing the worktrees/);
  assert.match(lines, /NONE of the top five is ours/);
  assert.ok(!lines.includes("Ours, and stoppable now"),
    "it must not name our own processes as the cause when none of them is in the list");
});

test("#681 reliefFor: when our own suites ARE the cause, it names them with their cost", () => {
  const lines = reliefFor([{ command: "node", cpu: 127 }, { command: "tsc", cpu: 88 }]).join("\n");
  assert.match(lines, /Ours, and stoppable now: node 127%, tsc 88%/);
  assert.ok(!lines.includes("NONE of the top five is ours"));
  assert.ok(!lines.includes("SOMEBODY IS USING THIS MACHINE"),
    "no user application in the list, so no claim that a person is at the keyboard");
});

test("#681 reliefFor: an unreadable consumer list refuses to guess a remedy", () => {
  assert.deepEqual(reliefFor(null), ["     No CPU reading, so no cause -- do not guess at a remedy."]);
});

/**
 * `top -l 1` REPORTS 0.0% FOR EVERY PROCESS, because one sample has no interval to measure against.
 * Measured on a host at load 35 -- five processes all reading 0.0 while `ps` put `mds_stores` at 52%.
 * That is this file's own defect class arriving through a sampling window instead of a missing PATH:
 * an unmeasurable value printed as a small number reads as good news. `ps -r` needs no interval.
 */
test("#681 topConsumers reads real percentages -- not the 0.0 a single top sample returns", () => {
  const consumers = topConsumers();
  if (consumers === null) return; // no `ps`: not this test's subject, and not a pass to fake
  assert.ok(consumers.length > 0, "something is always using the CPU");
  assert.ok(consumers.some((c) => c.cpu > 0),
    "every process reading 0.0% is the `top -l 1` signature, not a measurement");
  assert.ok(consumers.every((c) => !c.command.includes("/")),
    "the basename is what a reader recognises, not 96 characters of framework path");
  for (let i = 1; i < consumers.length; i += 1) {
    assert.ok(consumers[i - 1].cpu >= consumers[i].cpu, "sorted by cost, so the top one is the cause");
  }
});

test("#681 gitProcessCount: pgrep's exit 1 is a real ZERO, and any other failure is null", () => {
  // pgrep exits 1 for "nothing matched" and 2+/ENOENT for "I could not look". The first draft asked a
  // control question -- `pgrep -x <a name nothing has>` -- which returns the IDENTICAL exit status as
  // the real query, so it answered nothing. A control sharing the failure mode of what it controls for
  // is not a control (#645's shape).
  const host = hostState();
  if (host === null) return;
  assert.ok(host.gitProcesses === null || typeof host.gitProcesses === "number");
  assert.notEqual(host.gitProcesses, null,
    "pgrep exists on this machine, so the count is a number even when it is 0");
});

/**
 * SECTION 4 WAS BLIND TO EXACTLY THE INCIDENT ITS OWN HEADER CITES.
 *
 * That header reads: *"a red `audit` check sat on seven merged PRs for ninety minutes"* — and on
 * 2026-09-09 the section printed **NONE for three consecutive tables** while `ready-label-audit` had been
 * failing since 12:11Z. Measured on the real tree the moment the population changed:
 *
 *     commits examined: 10
 *       RED: audit                 -> 7 of 10
 *       RED: trunkBuildTest / run  -> 6 of 10
 *       RED: decideRevert          -> 4 of 10
 *
 * Seven of ten. The same number, the same check name, and the section written to catch it could not see
 * it.
 *
 * THE CAUSE IS THE POPULATION, NOT THE QUERY. It read `gh pr list --state merged --json
 * statusCheckRollup`, whose rollup hangs off `headRefOid` — the BRANCH TIP BEFORE THE MERGE. The merge
 * commit is a different sha. So the section answered *"did each PR's own CI pass before it merged"* while
 * its heading, and the chairman reading it, asked *"what is red on main"*.
 *
 * `ready-label-audit` runs on the `issues` event against main's tip, so its check-runs attach to merge
 * commits (861ffbb7, bdf9c0ba) that `gh pr list --json headRefOid` matches by construction never. It was
 * not MISSED — it was UNREACHABLE, along with every post-merge workflow, every scheduled run pinned to a
 * sha, and every non-code event. **That is precisely the class of check that can be red on main while
 * blocking nothing, which is the class this section exists to surface.**
 */
import { mergeCommitsOnMain } from "../../../../scripts/queue-table.mjs";

test("#737 mergeCommitsOnMain reads the FIRST-PARENT chain and names the PR each merge carries", () => {
  const log = [
    "aaaa1111\t2026-09-09T13:00:00+01:00\tMerge pull request #729 from DanBeckDev/agent/x",
    "bbbb2222\t2026-09-09T12:59:00+01:00\tMerge pull request #734 from DanBeckDev/dispatcher/y",
    "cccc3333\t2026-09-09T12:58:00+01:00\ta direct commit with no PR",
  ].join("\n");
  const rows = mergeCommitsOnMain(3, { run: () => log });
  assert.ok(rows, "a readable log yields rows");
  assert.deepEqual(rows.map((r) => r.pr), [729, 734, null],
    "a commit that names no PR is null, never guessed -- a direct push to main is a real thing");
  assert.deepEqual(rows.map((r) => r.sha), ["aaaa1111", "bbbb2222", "cccc3333"]);
});

test("#737 THE REGRESSION: a check on the MERGE COMMIT is counted -- the old population could not reach it", () => {
  // `ready-label-audit` runs on the `issues` event against main's tip. Its check-runs attach here and
  // nowhere else; a PR's `headRefOid` is a different sha and always will be.
  const merged = [
    { number: 729, sha: "bdf9c0ba", checks: [{ name: "audit", conclusion: "FAILURE" }] },
    { number: 734, sha: "8786c9eb", checks: [{ name: "audit", conclusion: "FAILURE" }] },
    { number: 723, sha: "861ffbb7", checks: [{ name: "gate", conclusion: "SUCCESS" }] },
  ];
  const { byName } = nonSuccessByName(merged);
  assert.deepEqual(byName.get("audit"), [729, 734],
    "the section must report a check that is red on main, whatever event produced it");
});

test("#737 a commit whose checks could not be READ is unreadable, never a clean commit", () => {
  const { byName, unreadable } = nonSuccessByName([
    { number: 1, sha: "aaaa", checks: null },
    { number: 2, sha: "bbbb", checks: [{ name: "gate", conclusion: "SUCCESS" }] },
  ]);
  assert.deepEqual(unreadable, [1], "a failed lookup is CANNOT-ASK, and folding it into clean is the "
    + "defect this file has now hit five times in other guards");
  assert.equal(byName.size, 0);
});

test("#737 a direct commit to main with a red check still counts, with no PR number to name", () => {
  const { byName } = nonSuccessByName([
    { number: null, sha: "dddd4444", checks: [{ name: "audit", conclusion: "FAILURE" }] },
  ]);
  assert.deepEqual(byName.get("audit"), [null],
    "red on main is red on main; a check that arrived without a PR is exactly the kind this section "
    + "exists to surface, and dropping it would rebuild the blind spot one level down");
});


/**
 * ONE FACT, FOUR COPIES, AND #734 CORRECTED TWO OF THEM.
 *
 * `.metadata_never_index` was measured on 2026-09-09 and does not work per-directory: placed on all 68
 * worktrees at 12:47Z and verified present, `mds_stores` read 54.8% at 12:45Z and 80% at 12:52Z. #734
 * corrected the claim in `.gitignore` and `scripts/spotlight-exclude.mjs` — and missed `queue-table.mjs`'s
 * relief line and `docs/pipeline.md`'s remedy table, **which are the two a reader actually reaches**.
 *
 * The fix was found by grepping for the SENTENCE rather than revisiting the file that was edited. That is
 * this repository's most-repeated defect stated exactly: a fact in more than one place, with nothing
 * comparing them, and a correction that reached the copies its author was looking at.
 */
test("#761 section 5 never recommends the marker, which was measured not to work", () => {
  const consumers = [{ command: "mds_stores", cpu: 80 }, { command: "WindowServer", cpu: 30 }];
  const relief = reliefFor(consumers).join("\n");
  assert.match(relief, /Spotlight is indexing the worktrees/, "the cause is still named");
  assert.match(relief, /does NOT help/, "and the marker is named as not helping");
  assert.ok(!/stops it being indexed at all/.test(relief),
    "the withdrawn claim must not survive anywhere a reader reaches");
});

test("#761 a user application makes the state say THROTTLED, not merely describe it", () => {
  const relief = reliefFor([{ command: "zoom.us", cpu: 49 }, { command: "mds_stores", cpu: 61 }]).join("\n");
  assert.match(relief, /THROTTLED/,
    "a reader must be able to SEE the state rather than infer it from a paragraph");
  assert.match(relief, /zoom\.us/, "and which application, so they can tell when it is gone");
  assert.match(relief, /carries serialise/);
});

test("#761 no user application means no THROTTLED line -- the word must stay meaningful", () => {
  const relief = reliefFor([{ command: "node", cpu: 120 }, { command: "tsc", cpu: 40 }]).join("\n");
  assert.ok(!/THROTTLED/.test(relief),
    "printing it on every contended host is how a state word stops being read");
});
