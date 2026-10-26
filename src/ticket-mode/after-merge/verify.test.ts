// no-token: none -- pure functions over records and outcome files in memory
// A11-302: the verifier run's brief and result, and the one-time migration that gives every check a session ran a runner of the org's, or supersedes it
import { test } from "node:test";
import assert from "node:assert/strict";
import { auditChecks, closeCheck, emptyChecks, isUnmigrated, seedChecks, type CheckRecord, type ChecksFile } from "./checks.ts";
import { BOARD_LINES_2026_10_25 } from "./board-lines-fixture.ts";
import { applyMigration, giveToAgent, isCheckRun, migrationBriefSections, migrationOf, unmigratedChecks, verifierBriefSections, verifierRequest, verifyOutcomeOf, type MigrationEntry } from "./verify.ts";

const DAY = 24 * 60 * 60 * 1000;
const NOW = 100 * DAY;

const check = (id: string, over: Partial<CheckRecord> = {}): CheckRecord => ({
  id, key: id.split("#")[0], url: `https://linear.app/a11ign/issue/${id.split("#")[0]}`, line: "Chairman session: re-running onboard on the laptop reads cleanly.", owner: "Chairman session", runner: "session", listedAt: NOW - 10 * DAY, state: "open", ...over,
});
const fileOf = (...checks: CheckRecord[]): ChecksFile => ({ checks: Object.fromEntries(checks.map((one) => [one.id, one])) });

// --- THE VERIFIER RUN ---

test("A11-302: a verifier run's outcome is passed, failed or superseded with one line of evidence, and nothing else", () => {
  assert.deepEqual(verifyOutcomeOf({ kind: "passed", evidence: "  the doctor shows 0.5.0  " }), { kind: "passed", evidence: "the doctor shows 0.5.0" });
  assert.deepEqual(verifyOutcomeOf({ kind: "failed", evidence: "still 0.4.1" }), { kind: "failed", evidence: "still 0.4.1" });
  assert.deepEqual(verifyOutcomeOf({ kind: "superseded", evidence: "that machine is retired" }), { kind: "superseded", evidence: "that machine is retired" });
  assert.match(String(verifyOutcomeOf({ kind: "created" })), /ends on "passed", "failed" or "superseded", not "created"/);
  assert.match(String(verifyOutcomeOf({ kind: "passed" })), /gives no evidence/);
  assert.match(String(verifyOutcomeOf({ kind: "passed", evidence: "one\ntwo" })), /evidence must be one line/);
  assert.match(String(verifyOutcomeOf({ kind: "passed", evidence: "x".repeat(301) })), /at most 300 characters/);
});

test("A11-302: the verifier's brief carries the check's ticket, its line quoted, the plan's evidence spec, the outcome file and the three results, and says to change nothing", () => {
  const brief = verifierBriefSections(check("A11-310#1", { runner: "agent", evidence: "run the doctor on the host and quote the version line" }), "/state/writer/c1");
  for (const words of ["# Verify an After-merge check: A11-310#1", "**Ticket:** A11-310 (https://linear.app/a11ign/issue/A11-310)", "> Chairman session: re-running onboard on the laptop reads cleanly.",
    "run the doctor on the host and quote the version line", "Write `/state/writer/c1/outcome.json`", "`passed`", "`failed`", "`superseded`", "change nothing", "nobody will answer a question"]) {
    assert.ok(brief.includes(words), words);
  }
  assert.ok(brief.includes("one line saying what you saw, and where") === false, "the plan's spec is used when it has one");
  assert.ok(verifierBriefSections(check("A11-310#2", { runner: "agent" }), "/d").includes("one line saying what you saw, and where"), "and a default when it has none");
  assert.equal(verifierRequest(check("A11-310#1")), "Verify A11-310#1: Chairman session: re-running onboard on the laptop reads cleanly.");
  assert.deepEqual(["verify", "migrate", "quick", "grill"].map(isCheckRun), [true, true, false, false]);
});

// --- THE MIGRATION ---

const ENTRIES = { kind: "migrated", checks: [
  { id: "A11-294#1", runner: "board", observe: "run-log finished \"lost in a restart\"", pass: "absent", window: "7d", evidence: "the run log, quoted if a run was lost" },
  { id: "A11-225#1", runner: "agent", evidence: "run the command on the host and quote its steps" },
  { id: "A11-233#1", runner: "person", escalation: "legal", evidence: "the person's choice, recorded on the ticket" },
  { id: "A11-186#1", runner: "superseded", reason: "the laptop is not in use, so its onboarding is not run" },
] };

test("A11-302: a migration outcome is read entry by entry under the plan check's own rules, and one bad entry refuses the outcome, naming it", () => {
  const read = migrationOf(ENTRIES);
  assert.ok(Array.isArray(read));
  assert.deepEqual((read as MigrationEntry[]).map((entry) => ("superseded" in entry ? [entry.id, "superseded", entry.superseded] : [entry.id, entry.planned.runner, entry.planned.evidence])), [
    ["A11-294#1", "board", "the run log, quoted if a run was lost"], ["A11-225#1", "agent", "run the command on the host and quote its steps"], ["A11-233#1", "person", "the person's choice, recorded on the ticket"],
    ["A11-186#1", "superseded", "the laptop is not in use, so its onboarding is not run"],
  ]);
  const bad = (entry: Record<string, unknown>) => String(migrationOf({ kind: "migrated", checks: [entry] }));
  assert.match(bad({ id: "A11-1#1", runner: "session", evidence: "x" }), /A11-1#1" has the runner "session", which is no runner/);
  assert.match(bad({ id: "A11-1#1", runner: "Chairman session", evidence: "x" }), /names the chairman's session in its runner/);
  assert.match(bad({ id: "A11-1#1", runner: "agent", evidence: "the Chairman session reads the log" }), /names the chairman's session in its evidence/);
  assert.match(bad({ id: "A11-1#1", runner: "person", evidence: "x" }), /names no escalation item/);
  assert.match(bad({ id: "A11-1#1", runner: "board", evidence: "x" }), /observe spec is missing/);
  assert.match(bad({ id: "A11-1#1", runner: "board", observe: "run-log finished", evidence: "x" }), /needs `Pass: absent \| present`/);
  assert.match(bad({ id: "A11-1#1", runner: "board", observe: "doctor here node", pass: "present", window: "7d" }), /needs its evidence on one line/);
  assert.match(bad({ id: "A11-1#1", runner: "superseded" }), /superseded and its reason is refused/);
  assert.match(bad({ id: "one", runner: "agent", evidence: "x" }), /has no check id such as A11-12#1/);
  assert.match(String(migrationOf({ kind: "migrated", checks: [] })), /lists its checks/);
});

test("A11-302: the migration rewrites a session check as a board check whose watch begins now, supersedes another with the pass's reason, and keeps a person's on its item", () => {
  const file = fileOf(
    check("A11-294#1", { line: "Chairman session: no `lost in a restart` crash for a starting run in the run log for a week.", sentAt: 5, overdueAt: 6 }),
    check("A11-225#1"), check("A11-233#1", { runner: "person", owner: "The chairman" }), check("A11-186#1"), check("A11-999#1", { runner: "agent" }),
  );
  const entries = migrationOf(ENTRIES) as MigrationEntry[];
  const migrated = applyMigration(file, entries, NOW);
  const board = migrated.checks["A11-294#1"];
  assert.deepEqual([board.runner, board.observe, board.evidence, board.migrated, board.sentAt, board.overdueAt], [
    "board", { spec: { kind: "run-log", event: "finished", match: "lost in a restart", pass: "absent", windowMs: 7 * DAY }, from: NOW }, "the run log, quoted if a run was lost", { from: "session", at: NOW }, undefined, undefined,
  ]);
  const superseded = migrated.checks["A11-186#1"];
  assert.deepEqual([superseded.state, superseded.result, superseded.closedBy, superseded.closedAt], ["superseded", "the laptop is not in use, so its onboarding is not run", "board", NOW]);
  assert.deepEqual([migrated.checks["A11-233#1"].runner, migrated.checks["A11-233#1"].escalation, migrated.checks["A11-233#1"].migrated?.from], ["person", "legal", "person"]);
  assert.equal(migrated.checks["A11-999#1"], file.checks["A11-999#1"], "a check that was not on the retired runner is not touched");
  assert.equal(applyMigration(migrated, entries, NOW + DAY), migrated, "and a second pass over the same answers changes nothing");
  assert.deepEqual(unmigratedChecks(migrated).map(({ id }) => id), [], "none is left on the retired runner");
});

test("A11-302: a check the pass did not answer is given to an agent, keeping what the line says to quote, and never left on the session", () => {
  const file = fileOf(check("A11-1#1"), check("A11-2#1", { evidence: "quote the status line" }), check("A11-3#1", { runner: "agent" }));
  const given = giveToAgent(file, ["A11-1#1", "A11-2#1", "A11-3#1", "A11-9#9"], NOW);
  assert.deepEqual([given.checks["A11-1#1"].runner, given.checks["A11-1#1"].evidence, given.checks["A11-1#1"].migrated], ["agent", "do what the line says and quote what you saw", { from: "session", at: NOW }]);
  assert.equal(given.checks["A11-2#1"].evidence, "quote the status line");
  assert.equal(given.checks["A11-3#1"], file.checks["A11-3#1"]);
});

test("A11-302: the migration brief lists each check with its ticket, age, recorded runner and line, and the four things it may decide", () => {
  const brief = migrationBriefSections([check("A11-294#1", { owner: null, line: "no crash for a week" }), check("A11-225#1", { runner: "person" })], "/state/writer/c2", NOW);
  for (const words of ["# Migrate 2 After-merge checks", "`A11-294#1` (A11-294, https://linear.app/a11ign/issue/A11-294; listed 10 days ago; recorded runner: session, no owner named)", "> no crash for a week",
    "recorded runner: person, owner: Chairman session", "**`board`**", "**`agent`**", "**`person`**", "**`superseded`**", "run-log <event kind> [<text>]", "doctor <host> <check>", "Write `/state/writer/c2/outcome.json`", "do not supersede a check only because it is old"]) {
    assert.ok(brief.includes(words), words);
  }
});

// --- THE LIST OF 2026-10-25, MIGRATED ---

test("A11-302: the 33 session checks of the board's list are each given a runner of the org's or superseded by one pass, and the audit of the Done-when then holds", () => {
  const byKey = new Map<string, string[]>();
  for (const [key, line] of BOARD_LINES_2026_10_25) byKey.set(key, [...(byKey.get(key) ?? []), line]);
  const listed = [...byKey].map(([key, lines]) => ({ ticket: { key }, finishedAt: NOW - 8 * DAY, afterMerge: lines.map((line) => ({ line, owner: null })) }));
  const seeded = seedChecks(emptyChecks(), listed, NOW);
  // Before the release, the list is on the retired runner: that is what A11-302 found.
  const before: ChecksFile = { checks: Object.fromEntries(Object.values(seeded.checks).map((one) => [one.id, { ...one, runner: "session" as const, sentAt: NOW - 8 * DAY }])) };
  assert.equal(before && unmigratedChecks(before).length, 33);
  assert.equal(auditChecks(before, NOW).ok, false);
  assert.deepEqual(auditChecks(before, NOW).unmigrated.length, 33);
  // The pass: the chairman's own check is the person's, an onboarding on a laptop is superseded, a line about "the next" event is watched or run by an agent.
  const answers = unmigratedChecks(before).map((one): Record<string, unknown> => {
    if (one.key === "A11-233") return { id: one.id, runner: "person", escalation: "legal", evidence: "the person's choice, recorded on the ticket" };
    if (/laptop/i.test(one.line)) return { id: one.id, runner: "superseded", reason: "the laptop is not in use, so this check cannot be run" };
    if (/next/i.test(one.line)) return { id: one.id, runner: "board", observe: "wake", evidence: "the board's log of the event" };
    return { id: one.id, runner: "agent", evidence: "run the command on the host and quote what it prints" };
  });
  const entries = migrationOf({ kind: "migrated", checks: answers }) as MigrationEntry[];
  assert.ok(Array.isArray(entries), String(entries));
  const after = applyMigration(before, entries, NOW);
  const runners = Object.values(after.checks).map((one) => (one.state === "open" ? one.runner : one.state));
  assert.deepEqual(Object.fromEntries(["board", "agent", "person", "superseded"].map((kind) => [kind, runners.filter((each) => each === kind).length])), { board: 14, agent: 12, person: 1, superseded: 6 });
  assert.equal(runners.includes("session"), false);
  assert.equal(Object.values(after.checks).some(isUnmigrated), false);
  assert.deepEqual(auditChecks(after, NOW), { ok: true, unmigrated: [], stale: [] }, "no open check is on the session, and every open org check is at most 3 days old (its clock is the migration's)");
  assert.equal(auditChecks(after, NOW + 4 * DAY).stale.length, 12, "four days on, the 12 agent checks nobody has settled are counted, as the pool bar counts them; the 14 board checks are inside their week");
  assert.equal(auditChecks(after, NOW + 8 * DAY).stale.length, 26, "and once the board's week is out, those it did not settle are counted too");
  assert.equal(closeCheck(after, "A11-233#1", { result: "passed", evidence: "the person chose", by: "person" }, NOW).ok, true);
});
