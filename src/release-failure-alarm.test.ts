// no-token: none -- every reading is a function of values handed in; the reader reads the fake code host's release runs, jobs and changesets (A11-160, step 8), the failed job's log and the incident tracker answer through a stub `run` (the ticket port, not the code host's rows); nothing here calls `gh`, ssh or the fleet.
/**
 * `src/org-health.ts`, agent-org#887 (a11ign/agent-org#885 class 1): A FAILED RELEASE ON ANY REPOSITORY THE ORG RELEASES RAISES AN INCIDENT NAMING THE RUN'S FIRST ERROR LINE WITHIN ONE TICK, AND A SECOND
 * CONSECUTIVE FAILURE WAKES `ceo`. Five failures of agent-org's own `release.yml` from 08:42Z on 2026-10-11 were read by nobody for 50+ minutes, because `readReleaseRuns` was asked of the project's
 * repository only.
 *
 * THE FIXTURE IS THAT MORNING: agent-org's streak (the new lockfile made the release run `changeset`, which was never declared) beside the project, which released fine, and then both failing.
 * POSITIVE CONTROLS: each repository's failure trips under its own discriminator; the first failure is an incident and no order; the second is the order; the reader's four-call path is driven to a
 * failure it names; the incident is filed once and closed when that repository releases. MUTATIONS, each run by hand and recorded on the row: read only the project's repository (the agent-org tests go red),
 * share one discriminator (the own-discriminator test), wake on the first failure (the single-failure tests), never wake (the second-failure tests), and quote the `##[error]` line instead of the line
 * before it (the first-error tests).
 */
import { after, afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { workGateSource } from "./lib/work-gate-source.ts";
import { forgetActivation, substituteCodeHost } from "./plugins/active.ts";
import { createFakeCodeHost } from "./plugins/fakes/code-host.ts";
import { fakeRow } from "./plugins/fakes/code-host-rows.ts";
import { watchedRows } from "./plugins/fakes/watched-rows.test.support.ts";

afterEach(() => forgetActivation());

// THE PROJECT THIS FILE RUNS AGAINST IS A RECORDED ONE (`org-health-release-failed.test.ts`'s rule): the host file is set FIRST and the tool imported AFTER it, dynamically.
const SCRATCH = mkdtempSync(join(tmpdir(), "release-failure-alarm-"));
after(() => rmSync(SCRATCH, { recursive: true, force: true }));
const PROJECT = join(SCRATCH, "project");
cpSync(fileURLToPath(new URL("./packaging/fixtures/org-health/project", import.meta.url)), PROJECT, { recursive: true });
const HOST_FILE = join(SCRATCH, "host.json");
writeFileSync(HOST_FILE, JSON.stringify({ schema: 1, home: SCRATCH, binDir: join(SCRATCH, "bin"), primary: "fixture",
  projects: [{ id: "fixture", checkout: PROJECT }],
  gh: { workers: join(SCRATCH, "workers"), leads: join(SCRATCH, "leads"), leadsHeader: [], leadsWorkspaces: [] } }));
process.env.AGENT_ORG_HOST = HOST_FILE;

const { SIGNALS } = await import("./org-health/thresholds.ts");
const { releaseFailureReadings, releaseFailedReading, readReleaseFailures, failureStreak, firstErrorLine, fileReleaseIncidents, RELEASE_INCIDENT_KEY, RELEASE_FAILURES_TO_WAKE } = await import("./org-health/sweep-readings.ts");
const { orgHealthReadings, orgHealthOrders } = await import("./org-health/fleet-build-readings.ts");
const { orgHealthNow, releaseRepositories } = await import("./work-gate/org-health.ts");
const { GH_READS } = await import("./work-gate/reads/read-memo-and-exit.ts");

const SIGNAL = "release-run-failed";
const PROJECT_REPO = "a11ign/a11ign";
const AGENT_ORG = "a11ign/agent-org";
const NOW = Date.parse("2026-10-11T09:30:00Z");
const SHA = "1a1fe388b6fd11128ed5b16c7b342239265ef4417";

type Run = { id: number; event: string; status: string; conclusion: string | null; sha: string; createdAt: string; updatedAt: string; url: string };
const run = (repo: string, id: number, conclusion: string | null, at: string, status = "completed", event = "push"): Run =>
  ({ id, event, status, conclusion, sha: SHA, createdAt: at, updatedAt: at.replace(/:(\d\d)Z$/, ":59Z"), url: `https://github.com/${repo}/actions/runs/${id}` });

/** agent-org's morning, NEWEST FIRST as the API returns it: five failures since 08:42Z, a skipped `status` run between two of them, and the release before them. */
const AGENT_ORG_STREAK: Run[] = [
  run(AGENT_ORG, 5005, "failure", "2026-10-11T09:22:10Z"),
  run(AGENT_ORG, 5004, "failure", "2026-10-11T09:10:04Z"),
  run(AGENT_ORG, 5003, "skipped", "2026-10-11T09:02:00Z", "completed", "status"),
  run(AGENT_ORG, 5002, "failure", "2026-10-11T08:58:41Z"),
  run(AGENT_ORG, 5001, "failure", "2026-10-11T08:42:30Z"),
  run(AGENT_ORG, 4990, "success", "2026-10-11T07:30:00Z"),
];
const AGENT_ORG_ONE_FAILURE: Run[] = [run(AGENT_ORG, 5001, "failure", "2026-10-11T08:42:30Z"), run(AGENT_ORG, 4990, "success", "2026-10-11T07:30:00Z")];
const PROJECT_GREEN: Run[] = [run(PROJECT_REPO, 7002, "success", "2026-10-11T09:00:00Z"), run(PROJECT_REPO, 7001, "success", "2026-10-11T07:00:00Z")];
const PROJECT_FAILED: Run[] = [run(PROJECT_REPO, 7003, "failure", "2026-10-11T09:20:00Z"), ...PROJECT_GREEN];

const JOB = [{ id: 880001, name: "release", steps: ["Version the release"] }];
const QUOTE = 'ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL  Command "changeset" not found';
/** A job log as GitHub prints it: stamped lines, an earlier green step that says "error" in passing, and the failing step with its command echoed. */
const LOG = [
  "2026-10-11T08:42:01.1000000Z ##[group]Run actions/checkout@v4",
  "2026-10-11T08:42:01.2000000Z with:",
  "2026-10-11T08:42:02.0000000Z ##[endgroup]",
  "2026-10-11T08:42:03.0000000Z ##[group]Run pnpm install --frozen-lockfile",
  "2026-10-11T08:42:03.1000000Z pnpm install --frozen-lockfile",
  "2026-10-11T08:42:03.2000000Z ##[endgroup]",
  "2026-10-11T08:42:09.0000000Z Done in 5.1s, 0 errors, 0 warnings",
  "2026-10-11T08:42:09.5000000Z Retrying after a network error (1/3)",
  "2026-10-11T08:42:10.0000000Z ##[group]Run pnpm dlx changeset version  # an error here is not the failure",
  "2026-10-11T08:42:10.1000000Z pnpm exec changeset version || echo \"error: the version step\"",
  "2026-10-11T08:42:10.2000000Z shell: /usr/bin/bash -e {0}",
  "2026-10-11T08:42:10.3000000Z ##[endgroup]",
  `2026-10-11T08:42:11.0000000Z \u001b[31m ${QUOTE}\u001b[39m`,
  "2026-10-11T08:42:11.1000000Z Did you mean \"changesets\"?",
  "2026-10-11T08:42:11.2000000Z ##[error]Process completed with exit code 1.",
  "2026-10-11T08:42:11.3000000Z Post job cleanup.",
].join("\n");

const failed = (runs: Run[]) => ({ runs, jobs: JOB, pending: ["a-change.md"] }) as never;
const read = (repo: string, runs: Run[] | null, error?: { line: string } | { unread: string }) =>
  ({ repo, runs: runs === null ? null : failed(runs), ...(error ? { firstError: error } : {}) }) as never;
const LINE = { line: QUOTE };
const readings = (reads: unknown[] | null) => releaseFailureReadings({ failures: reads as never });
const tripped = (reads: unknown[]) => readings(reads).filter((r) => r.status === "tripped");

// --- the first error line ----------------------------------------------------------------------------------------------------------

test("the first error line is the failing step's own, not the `##[error]` marker, not an earlier step's retry notice, and not the command echoed above its output", () => {
  assert.deepEqual(firstErrorLine(LOG), { line: QUOTE });
});

test("a log with nothing to quote says why, and a marker with no line before it quotes the marker's text", () => {
  assert.deepEqual(firstErrorLine("##[group]Run x\nplain\n##[endgroup]\nplain"), { unread: "the failed job's log holds no `##[error]` line" });
  assert.deepEqual(firstErrorLine("##[group]Run x\n##[endgroup]\n##[error]Process completed with exit code 2."), { line: "Process completed with exit code 2." });
  const long = firstErrorLine(`##[group]Run x\n##[endgroup]\n${"E".repeat(400)} error\n##[error]x`);
  assert.ok("line" in long && long.line.length === 240, "a line of any length is quoted at 240 characters");
});

// --- one reading per repository ----------------------------------------------------------------------------------------------------

test("POSITIVE CONTROL: agent-org's streak trips under agent-org's own discriminator, names the run and quotes the first error line; the project, released fine, is silent", () => {
  const r = tripped([read(PROJECT_REPO, PROJECT_GREEN), read(AGENT_ORG, AGENT_ORG_STREAK, LINE)]);
  assert.equal(r.length, 1);
  assert.equal(r[0].signal, SIGNAL);
  assert.equal(r[0].discriminator, `${SIGNAL}@${AGENT_ORG}@5001`, "the first failed run of the streak");
  assert.equal(r[0].firstTrippedAt, Date.parse("2026-10-11T08:42:59Z"));
  assert.match(r[0].detail, /release\.yml on a11ign\/agent-org's main FAILED 4 times running \(since run 5001\)/);
  assert.match(r[0].detail, /run 5005 \(push\) at 1a1fe388b/);
  assert.match(r[0].detail, /job `release` \(step "Version the release"\)/);
  assert.ok(r[0].detail.includes(`its first error line: "${QUOTE}"`), r[0].detail);
  assert.match(r[0].detail, /actions\/runs\/5005/);
});

test("BOTH repositories failing trip under their OWN discriminators, and a later success on one clears only that one", () => {
  const both = tripped([read(PROJECT_REPO, PROJECT_FAILED, LINE), read(AGENT_ORG, AGENT_ORG_STREAK, LINE)]);
  assert.deepEqual(both.map((r) => r.discriminator).sort(), [`${SIGNAL}@${PROJECT_REPO}@7003`, `${SIGNAL}@${AGENT_ORG}@5001`]);
  assert.match(both.find((r) => r.discriminator?.includes(PROJECT_REPO))!.detail, /release\.yml on a11ign\/a11ign's main FAILED and no later run succeeded/);

  const agentOrgFixed = [run(AGENT_ORG, 5006, "success", "2026-10-11T09:40:00Z"), ...AGENT_ORG_STREAK];
  const remaining = tripped([read(PROJECT_REPO, PROJECT_FAILED, LINE), read(AGENT_ORG, agentOrgFixed)]);
  assert.deepEqual(remaining.map((r) => r.discriminator), [`${SIGNAL}@${PROJECT_REPO}@7003`], "agent-org cleared; the project's reading is the same key");
});

test("no repository failing is `clear`; a cancelled, skipped or running run neither trips nor clears", () => {
  const clear = readings([read(PROJECT_REPO, PROJECT_GREEN), read(AGENT_ORG, [run(AGENT_ORG, 6000, "success", "2026-10-11T09:00:00Z")])]);
  assert.deepEqual(clear.map((r) => r.status), ["clear"]);
  for (const [conclusion, status] of [["cancelled", "completed"], ["skipped", "completed"], [null, "in_progress"]] as const) {
    const later = run(AGENT_ORG, 5100, conclusion, "2026-10-11T09:40:00Z", status);
    assert.equal(tripped([read(AGENT_ORG, [later, ...AGENT_ORG_STREAK], LINE)]).length, 1, `a later ${conclusion ?? status} run does not clear`);
    assert.deepEqual(failureStreak([later, ...AGENT_ORG_STREAK]).failures.map((r) => r.id), [5005, 5004, 5002, 5001], `nor does it break or join the streak`);
  }
});

// --- a status run's success is a promotion, not a release (a11ign/agent-org#1273) -----------------------------------------------------

/** The 2026-10-12 sequence, NEWEST FIRST as the API returns it: two failed push runs, a successful `status` run between them and two around them. The streak is TWO. */
const AGENT_ORG_2026_10_12: Run[] = [
  run(AGENT_ORG, 6106, "success", "2026-10-12T19:13:07Z", "completed", "status"),
  run(AGENT_ORG, 6105, "failure", "2026-10-12T18:48:11Z"),
  run(AGENT_ORG, 6104, "success", "2026-10-12T18:19:27Z", "completed", "status"),
  run(AGENT_ORG, 6103, "success", "2026-10-12T18:17:46Z", "completed", "status"),
  run(AGENT_ORG, 6102, "failure", "2026-10-12T18:13:33Z"),
  run(AGENT_ORG, 6101, "success", "2026-10-12T18:12:18Z", "completed", "status"),
];

test("the 2026-10-12 sequence is a streak of TWO: the successful status runs neither clear it nor join it, and the second failure is an order to `ceo` quoting the first error line", () => {
  assert.deepEqual(failureStreak(AGENT_ORG_2026_10_12).failures.map((r) => r.id), [6105, 6102]);
  assert.equal(failureStreak(AGENT_ORG_2026_10_12).ended, false, "no push success is in the window");
  const r = tripped([read(AGENT_ORG, AGENT_ORG_2026_10_12, LINE)]);
  assert.equal(r.length, 1);
  assert.equal(r[0].incidentOnly, undefined, "a second failure is not an incident only");
  assert.match(r[0].detail, /FAILED 2 or more times running \(since run 6102\)/);
  const orders = ordersOf([read(AGENT_ORG, AGENT_ORG_2026_10_12, LINE)]);
  assert.equal(orders.length, 1);
  assert.equal(orders[0].session, "ceo");
  assert.ok(orders[0].prompt.includes(QUOTE));
});

test("a status run's SUCCESS newest of all does not clear the streak, however many follow it", () => {
  const newest = run(AGENT_ORG, 6107, "success", "2026-10-12T19:30:00Z", "completed", "status");
  assert.deepEqual(failureStreak([newest, ...AGENT_ORG_2026_10_12]).failures.map((r) => r.id), [6105, 6102]);
  assert.equal(tripped([read(AGENT_ORG, [newest, ...AGENT_ORG_2026_10_12], LINE)]).length, 1);
});

test("a push's success clears; a dispatch's clears only when its release job published; a promote-only dispatch neither clears nor joins", () => {
  const push = run(AGENT_ORG, 6110, "success", "2026-10-12T19:40:00Z");
  assert.deepEqual(readings([read(AGENT_ORG, [push, ...AGENT_ORG_2026_10_12])]).map((x) => x.status), ["clear"]);
  const published = { ...run(AGENT_ORG, 6111, "success", "2026-10-12T19:40:00Z", "completed", "workflow_dispatch"), published: true };
  assert.deepEqual(readings([read(AGENT_ORG, [published, ...AGENT_ORG_2026_10_12])]).map((x) => x.status), ["clear"]);
  const promoteOnly = { ...run(AGENT_ORG, 6112, "success", "2026-10-12T19:40:00Z", "completed", "workflow_dispatch"), published: false };
  assert.equal(tripped([read(AGENT_ORG, [promoteOnly, ...AGENT_ORG_2026_10_12], LINE)]).length, 1);
  assert.deepEqual(failureStreak([promoteOnly, ...AGENT_ORG_2026_10_12]).failures.map((r) => r.id), [6105, 6102]);
});

test("a repository that could not be read is UNKNOWN and NEVER clear, and does not hide another's trip", () => {
  const r = readings([read(PROJECT_REPO, null), read(AGENT_ORG, AGENT_ORG_STREAK, LINE)]);
  assert.deepEqual(r.map((x) => x.status), ["tripped", "unknown"]);
  assert.match(r[1].detail, /a11ign\/a11ign: the runs of release\.yml on main could not be read/);
  assert.deepEqual(readings([read(AGENT_ORG, null)]).map((x) => x.status), ["unknown"]);
  assert.deepEqual(readings([read(AGENT_ORG, [run(AGENT_ORG, 1, "skipped", "2026-10-11T09:00:00Z")])]).map((x) => x.status), ["unknown"], "a window of skipped runs says nothing");
  assert.equal(readings(null)[0].status, "unknown");
});

test("a first error line that could not be read is said, and the failure is STILL tripped", () => {
  const r = tripped([read(AGENT_ORG, AGENT_ORG_ONE_FAILURE, { unread: "the failed job's log could not be read" }), read(PROJECT_REPO, PROJECT_FAILED)]);
  assert.equal(r.length, 2);
  assert.match(r[0].detail, /its first error line is not quoted \(the failed job's log could not be read\)/);
  assert.match(r[1].detail, /its first error line was not read/);
});

// --- one failure is an incident, the second wakes ceo ----------------------------------------------------------------------------------

const QUIET = { now: NOW, lastMergedAt: NOW - 60 * 60_000, work: { greenPrs: 0, claimableRows: 0 }, redPrs: [], refusals: {},
  drift: { behind: 0, ahead: 0, dirty: [] }, primarySince: null };
const ordersOf = (reads: unknown[]) => orgHealthOrders(orgHealthReadings({ ...QUIET, releaseFailures: reads } as never)).filter((o) => o.subject === SIGNAL);

test("a SINGLE failure is the incident only: tripped, and no order to anyone", () => {
  const r = tripped([read(AGENT_ORG, AGENT_ORG_ONE_FAILURE, LINE)]);
  assert.equal(r.length, 1);
  assert.equal(r[0].incidentOnly, true);
  assert.deepEqual(ordersOf([read(AGENT_ORG, AGENT_ORG_ONE_FAILURE, LINE)]), []);
});

test("a SECOND consecutive failure on one repository is an order to `ceo`, quoting the first error line, and a third is the SAME order", () => {
  assert.equal(RELEASE_FAILURES_TO_WAKE, 2);
  const two = ordersOf([read(AGENT_ORG, [AGENT_ORG_STREAK[0], AGENT_ORG_STREAK[1], AGENT_ORG_STREAK[5]], LINE)]);
  assert.equal(two.length, 1);
  assert.equal(two[0].session, "ceo");
  assert.equal(two[0].cause, "org-health");
  assert.match(two[0].prompt, /ORG HEALTH: `release-run-failed` HAS TRIPPED\. release\.yml on a11ign\/agent-org's main FAILED 2 times running/);
  assert.ok(two[0].prompt.includes(QUOTE));
  assert.match(two[0].prompt, /It first tripped at 2026-10-11T09:10:59Z/);
  assert.equal(two[0].causeKey, "ceo/org-health/release-run-failed@a11ign/agent-org@5004", "exactly two: the streak's first failed run is 5004");
  const three = ordersOf([read(AGENT_ORG, AGENT_ORG_STREAK.slice(1), LINE)]);
  assert.match(three[0].prompt, /FAILED 3 times running/);
  const five = ordersOf([read(AGENT_ORG, AGENT_ORG_STREAK, LINE)]);
  assert.equal(five[0].causeKey, "ceo/org-health/release-run-failed@a11ign/agent-org@5001", "keyed on the streak, so the suppression window keeps it one page");
});

test("the ORDER is per repository: one repository's single failure and another's streak give ONE order, for the streak", () => {
  const orders = ordersOf([read(PROJECT_REPO, PROJECT_FAILED, LINE), read(AGENT_ORG, AGENT_ORG_STREAK, LINE)]);
  assert.deepEqual(orders.map((o) => o.discriminator), [`${SIGNAL}@${AGENT_ORG}@5001`]);
});

test("the signal is `release-run-failed` still, and a caller that gives only `releaseRuns` gets the project-only reading it always did", () => {
  assert.equal(SIGNALS.RELEASE_FAILED, SIGNAL);
  assert.equal(RELEASE_INCIDENT_KEY, "incident:release-run-failed");
  const legacy = releaseFailedReading({ releaseRuns: failed(PROJECT_FAILED) });
  assert.equal(legacy.status, "tripped");
  assert.equal(legacy.incidentOnly, undefined);
  const viaFacts = orgHealthReadings({ ...QUIET, releaseRuns: failed(PROJECT_FAILED) } as never).filter((r) => r.signal === SIGNAL);
  assert.deepEqual(viaFacts.map((r) => r.discriminator), [`${SIGNAL}@7003`]);
});

// --- the reader --------------------------------------------------------------------------------------------------------------------

/**
 * The fake code host in place, watched, holding each repository's runs, the jobs of the runs it is given and its `.changeset/`; what it is not given it cannot answer (a refused read). The fake does not model a
 * job's log (`jobLogOf` is unmodeled there), so the test seeds it here: the code host answers `log` for any job (or throws it, a refused read), and `logAsked` is the jobs it was asked for.
 */
function world({ runs = { [PROJECT_REPO]: PROJECT_GREEN, [AGENT_ORG]: AGENT_ORG_STREAK } as Record<string, Run[]>, jobs = { [`${AGENT_ORG}#5005`]: [{ id: 880001, name: "release", conclusion: "failure", failedSteps: JOB[0].steps }] } as Record<string, { id: number; name: string; conclusion: string | null; failedSteps?: string[] }[]>,
  changesets = { [AGENT_ORG]: ["README.md", "a-change.md"] } as Record<string, string[]>, log = LOG as string | Error } = {}) {
  const watched = watchedRows(createFakeCodeHost());
  substituteCodeHost(watched.host);
  const health = (watched.host as unknown as { rowsWorld: ReturnType<typeof createFakeCodeHost>["rowsWorld"] }).rowsWorld;
  for (const [repo, held] of Object.entries(runs)) health.reports.health.releaseRuns.set(repo, held);
  for (const [key, held] of Object.entries(jobs)) health.reports.health.releaseJobs.set(key, held);
  for (const [repo, held] of Object.entries(changesets)) health.reports.health.changesets.set(repo, held);
  const logAsked: string[] = [];
  watched.host.rows!.jobLogOf = (repo, jobId) => {
    logAsked.push(`${repo} job ${jobId}`);
    if (log instanceof Error) throw log;
    return log;
  };
  return { health, run: neverRun, logAsked, asked: (repo?: string) => watched.calls.filter((c) => repo === undefined || c.request.repo === repo).map((c) => c.op) };
}
const neverRun = (args: string[]): string => { throw new Error(`the code host answers this, not a gh: ${args.join(" ")}`); };

test("the reader asks ONE call of a repository that released, and FOUR of one that failed (runs, jobs, changesets, and the failed job's log)", () => {
  const { run, logAsked, asked } = world();
  const reads = readReleaseFailures(run, [PROJECT_REPO, AGENT_ORG]);
  assert.deepEqual(asked(PROJECT_REPO), ["releaseRunsOf"]);
  assert.deepEqual(asked(AGENT_ORG), ["releaseRunsOf", "releaseJobsOf", "changesetNamesOf"]);
  assert.deepEqual(logAsked, [`${AGENT_ORG} job 880001`], "and the one log read, of the failed job");
  assert.deepEqual(reads[1].firstError, LINE);
  assert.deepEqual(reads[1].runs?.pending, ["a-change.md"]);
  assert.deepEqual(tripped(reads).map((r) => r.discriminator), [`${SIGNAL}@${AGENT_ORG}@5001`]);
  assert.match(tripped(reads)[0].detail, /FAILED 4 times running/);
});

test("the reader reuses runs the tick already read, and says what it could not read: a refused list, a refused log, no job id", () => {
  const { run, asked } = world();
  const known = readReleaseFailures(run, [PROJECT_REPO], { known: { [PROJECT_REPO]: failed(PROJECT_GREEN) } });
  assert.deepEqual(asked(), [], "the project's runs were read once this tick");
  assert.equal(known[0].runs?.runs.length, 2);

  const listRefused = world();
  listRefused.health.failures.set("releaseRunsOf", new Error("HTTP 403"));
  assert.deepEqual(readReleaseFailures(listRefused.run, [AGENT_ORG]), [{ repo: AGENT_ORG, runs: null }]);
  const noLog = readReleaseFailures(world({ log: new Error("HTTP 410") }).run, [AGENT_ORG]);
  assert.deepEqual(noLog[0].firstError, { unread: "the failed job's log could not be read" });
  assert.equal(tripped(noLog).length, 1, "a log that cannot be read does not turn the trip into an unknown");
  const noJobs = readReleaseFailures(world({ jobs: {} }).run, [AGENT_ORG]);
  assert.deepEqual(noJobs[0].firstError, { unread: "the failed job could not be read" });
});

// --- the incident ------------------------------------------------------------------------------------------------------------------

type Item = { number: number; title: string; createdAt: string; body: string };
/**
 * The tracker as the fake code host's rows: an incident item is a row labelled `incident`, open or closed. `filed()` is the incident rows that were not seeded, `closedNow()` the seeded open ones that are closed now,
 * and `asked` the operations called, with the tracker each was given. `unreadable` names the incident reads the code host answers `null` to (it could not ask: the contract's word for a refused read of a list).
 */
function tracker({ open = [] as Item[], closed = [] as Item[], unreadable = [] as ("openIncidentsOf" | "closedIncidentsOf")[] } = {}) {
  const watched = watchedRows(createFakeCodeHost());
  substituteCodeHost(watched.host);
  const code = (watched.host as unknown as { rowsWorld: ReturnType<typeof createFakeCodeHost>["rowsWorld"] }).rowsWorld;
  for (const [state, items] of [["OPEN", open], ["CLOSED", closed]] as const) {
    for (const { number, title, createdAt, body } of items) code.rows.set(number, fakeRow(code, number, { title, body, createdAt, labels: ["incident"], state, closedAt: state === "CLOSED" ? createdAt : null }));
  }
  const seeded = new Set(code.rows.keys());
  const rows = watched.host.rows as unknown as Record<string, () => null>;
  for (const op of unreadable) rows[op] = () => null;
  watched.calls.length = 0;
  return { code, asked: () => watched.calls.map((c) => c.op),
    writes: () => watched.calls.filter((c) => c.op === "createIncident" || c.op === "closeIncident").map((c) => `${c.op} ${c.request}`),
    filed: () => [...code.rows.values()].filter((row) => !seeded.has(row.number)),
    closedNow: () => open.filter(({ number }) => code.rows.get(number)?.state === "CLOSED").map(({ number }) => number) };
}
const TRACKER = PROJECT_REPO;
const never = (): string => { throw new Error("a gh was run: the incident reads and writes are the code host's"); };
const item = (repo: string, episode: number, number = 40): Item =>
  ({ number, title: "x", createdAt: "2026-10-11T08:43:00Z", body: `Incident: ${RELEASE_INCIDENT_KEY}\nRelease-failure: ${repo}@${episode}\n` });
const quiet = (lines: string[]) => (line: string) => { lines.push(line); };

test("a first failure FILES ONE incident item: labelled `incident`, naming the repository, the run and the first error line, carrying the Incident key and the line it is found by", () => {
  const t = tracker();
  const out = fileReleaseIncidents([read(PROJECT_REPO, PROJECT_GREEN), read(AGENT_ORG, AGENT_ORG_ONE_FAILURE, LINE)], { run: never, tracker: TRACKER, say: quiet([]) });
  assert.equal(out.filed.length, 1);
  assert.equal(t.filed().length, 1);
  const [filed] = t.filed();
  assert.deepEqual(filed.labels, ["incident"]);
  assert.equal(filed.title, `Release failed on ${AGENT_ORG}: ${QUOTE}`);
  assert.ok(filed.body.includes(`its first error line: "${QUOTE}"`));
  assert.ok(filed.body.includes(`\nIncident: ${RELEASE_INCIDENT_KEY}\n`));
  assert.ok(filed.body.includes(`\nRelease-failure: ${AGENT_ORG}@5001\n`));
  assert.deepEqual(t.writes(), [`createIncident ${TRACKER}`], "filed in the tracker it read, not in whichever repository the process stands in");
});

test("the incident is filed ONCE: an open item for the repository, or a closed one for the same streak, files nothing; the NEXT streak files again", () => {
  const rows = [read(AGENT_ORG, AGENT_ORG_STREAK, LINE)];
  const filedWith = (seed: Parameters<typeof tracker>[0]) => { const t = tracker(seed); const out = fileReleaseIncidents(rows, { run: never, tracker: TRACKER, say: quiet([]) }); return { t, out }; };
  const openOne = filedWith({ open: [item(AGENT_ORG, 5001)] });
  assert.deepEqual(openOne.out, { filed: [], closed: [] });
  assert.deepEqual(openOne.t.writes(), []);
  const openOlder = filedWith({ open: [item(AGENT_ORG, 4000)] });
  assert.deepEqual(openOlder.t.writes(), [], "a streak that slid out of the run window is not a second incident");
  const closedSame = filedWith({ closed: [item(AGENT_ORG, 5001)] });
  assert.deepEqual(closedSame.t.writes(), [], "a person who closed it did not ask for it again");
  const closedOlder = filedWith({ closed: [item(AGENT_ORG, 4000)] });
  assert.equal(closedOlder.out.filed.length, 1);
  assert.equal(closedOlder.t.filed().length, 1);
});

test("a closed list that cannot be read files NOTHING and says so: an unread list is never 'no one closed it'", () => {
  const said: string[] = [];
  const t = tracker({ unreadable: ["closedIncidentsOf"] });
  const out = fileReleaseIncidents([read(AGENT_ORG, AGENT_ORG_STREAK, LINE)], { run: never, tracker: TRACKER, say: quiet(said) });
  assert.deepEqual(out, { filed: [], closed: [] });
  assert.deepEqual(t.writes(), []);
  assert.equal(said.length, 1);
  assert.ok(said[0].includes("could not read the closed incidents"), said[0]);
  const control = tracker();
  assert.equal(fileReleaseIncidents([read(AGENT_ORG, AGENT_ORG_STREAK, LINE)], { run: never, tracker: TRACKER, say: quiet([]) }).filed.length, 1, "CONTROL: the same streak, the list read, is filed");
  assert.equal(control.filed().length, 1);
});

test("a repository that RELEASES again closes its open incident, and only its own", () => {
  const t = tracker({ open: [item(AGENT_ORG, 5001, 41), item(PROJECT_REPO, 7003, 42)] });
  const fixed = [run(AGENT_ORG, 5006, "success", "2026-10-11T09:40:00Z"), ...AGENT_ORG_STREAK];
  const out = fileReleaseIncidents([read(AGENT_ORG, fixed), read(PROJECT_REPO, PROJECT_FAILED, LINE)], { run: never, tracker: TRACKER, say: quiet([]) });
  assert.deepEqual(out.closed, [41]);
  assert.deepEqual(t.closedNow(), [41], "the item that was closed is the agent-org one");
  assert.deepEqual(t.writes(), [`closeIncident ${TRACKER}`], "in the tracker");
  assert.match(t.code.rows.get(41)!.comments.at(-1)!.body, /release\.yml on a11ign\/agent-org's main succeeded again/);
});

test("a tracker that cannot be read files and closes NOTHING and says so; a tick with no verdict to act on makes no call at all", () => {
  const said: string[] = [];
  const refused = tracker({ unreadable: ["openIncidentsOf"] });
  assert.deepEqual(fileReleaseIncidents([read(AGENT_ORG, AGENT_ORG_ONE_FAILURE, LINE)], { run: never, tracker: TRACKER, say: quiet(said) }), { filed: [], closed: [] });
  assert.deepEqual(refused.writes(), []);
  assert.match(said.join(""), /could not read the open incidents of a11ign\/a11ign, so none is filed or closed this tick/);
  const idle = tracker();
  const unread = fileReleaseIncidents([read(AGENT_ORG, null)], { run: never, tracker: TRACKER, say: quiet([]) });
  assert.deepEqual([unread, idle.asked()], [{ filed: [], closed: [] }, []]);
});

// --- the gate: the reading is WIRED, which is what "within one tick" means ------------------------------------------------------------------

const decideArgs = { prs: [], required: [], readyRows: [], prFiles: new Map(), rowBranches: [], openRows: [], primaryDrift: null, claimRefusals: [] };
const tick = (io: Record<string, unknown>) => orgHealthNow({ prsRead: [], readyRead: [], openRowsRead: [], decideArgs, decided: [] } as never,
  { now: NOW, lastMergedAt: () => NOW, readCaptures: () => undefined, readLabJobs: () => [], log: () => {}, teamAccess: () => undefined,
    readWaits: () => ({ facts: new Map(), stale: [], bare: [], manual: 0 }), ...io } as never) as { subject: string; session: string; prompt: string }[];
const ofSignal = <T extends { subject: string }>(orders: T[]) => orders.filter((o) => o.subject === SIGNAL);

test("orgHealthNow reads each repository ONCE, raises the incidents from the same reads, and orders `ceo` only for a second failure", () => {
  const seen: unknown[][] = [];
  const first = tick({ readReleaseFailures: () => [read(AGENT_ORG, AGENT_ORG_ONE_FAILURE, LINE)], raiseReleaseIncidents: (reads: unknown[]) => { seen.push(reads); } });
  assert.deepEqual(ofSignal(first), [], "one failure: the incident only");
  assert.equal(seen.length, 1);
  assert.equal((seen[0][0] as { repo: string }).repo, AGENT_ORG);

  const second = ofSignal(tick({ readReleaseFailures: () => [read(AGENT_ORG, AGENT_ORG_STREAK.slice(2), LINE)] }));
  assert.equal(second.length, 1);
  assert.equal(second[0].session, "ceo");
  assert.ok(second[0].prompt.includes(QUOTE));
});

test("the replacement is by ASKING: the project-only read still orders as it did, and a caller that asks for neither is silent", () => {
  assert.equal(ofSignal(tick({ readReleaseRuns: () => failed(PROJECT_FAILED) })).length, 1);
  assert.deepEqual(ofSignal(tick({})), []);
  assert.deepEqual(ofSignal(tick({ readReleaseFailures: () => null })), [], "an unread list is said on stderr and orders nothing");
});

test("the gate's call site passes the per-repository read and the incident, and the reads are counted, so the signal is not dead for want of a fact (#2980's lesson)", () => {
  const gate = workGateSource();
  assert.match(gate, /readReleaseFailures\(run, releaseRepositories\(\), \{ known: \{ \[gh\.repo\]: releaseRuns \} \}\)/);
  assert.match(gate, /raiseReleaseIncidents: \(reads\) => \{ fileReleaseIncidents\(reads, \{ run: defaultRun, tracker: repoNow\(\) \}\); \}/);
  assert.ok(GH_READS.unconditional.some((r: string) => r.includes("readReleaseRuns") && r.includes("release.yml/runs")));
});

test("the repositories the org releases are the project's and every `dora` entry, each once", () => {
  const list = releaseRepositories();
  assert.equal(new Set(list).size, list.length);
  assert.ok(list.length >= 1, "at least the project's own is read, as before");
  const declared = JSON.parse(readFileSync(join(PROJECT, ".agent-org", "project.json"), "utf8"));
  for (const entry of declared.dora ?? []) assert.ok(list.includes(entry.repo), `${entry.repo} is a released repository`);
});
