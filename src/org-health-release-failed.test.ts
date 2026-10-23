// no-token: none -- the reading is a function of values handed in, and `readReleaseRuns` reads the fake code host's release runs, jobs and changesets (A11-160, step 8); nothing here calls `gh`, ssh or the fleet.
/**
 * `src/org-health.ts`, #4001: A FAILED `release.yml` RUN ON `main` IS RAISED WITHIN A TICK, NAMING THE JOB, instead of being found by a person going to look (a11ign/a11ign, 2026-10-07: it
 * failed in `guards` at 14:15Z, was found at 15:23Z, and the second failure at 15:23Z was read the same way).
 *
 * THE FIXTURE IS THAT DAY'S RUN LIST, in the shape `readReleaseRuns` projects it: two `workflow_dispatch` failures, the `status` runs between them that were skipped (the 14:26Z-14:59Z rows,
 * which must not read as a release) and the `status` success at 14:00Z. POSITIVE CONTROLS: that list trips; the same list with a later success clears; and the reader's three-call
 * path is driven (on the fake code host's release runs) to a failure it then names. MUTATIONS, each run by hand and recorded on the row: never trip (the failed-run tests go red), always trip (the clearing and
 * cancelled/skipped tests go red, and only they), read a skipped run as a success (the skipped-after-failure test goes red), and read a refused list as clear (the unknown test goes red).
 */
import { after, afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { workGateSource } from "./lib/work-gate-source.ts";
import { forgetActivation, substituteCodeHost } from "./plugins/active.ts";
import { createFakeCodeHost } from "./plugins/fakes/code-host.ts";
import { watchedRows } from "./plugins/fakes/watched-rows.test.support.ts";

afterEach(() => forgetActivation());

// THE PROJECT THIS FILE RUNS AGAINST IS A RECORDED ONE (`org-health-auto-off-refusal.test.ts`'s rule): the host file is set FIRST and the tool imported AFTER it, dynamically.
const SCRATCH = mkdtempSync(join(tmpdir(), "org-health-release-"));
after(() => rmSync(SCRATCH, { recursive: true, force: true }));
const PROJECT = join(SCRATCH, "project");
cpSync(fileURLToPath(new URL("./packaging/fixtures/org-health/project", import.meta.url)), PROJECT, { recursive: true });
const HOST_FILE = join(SCRATCH, "host.json");
writeFileSync(HOST_FILE, JSON.stringify({ schema: 1, home: SCRATCH, binDir: join(SCRATCH, "bin"), primary: "fixture",
  projects: [{ id: "fixture", checkout: PROJECT }],
  gh: { workers: join(SCRATCH, "workers"), leads: join(SCRATCH, "leads"), leadsHeader: [], leadsWorkspaces: [] } }));
process.env.AGENT_ORG_HOST = HOST_FILE;

const { SIGNALS } = await import("./org-health/thresholds.ts");
const { releaseFailedReading, readReleaseRuns, newestReleaseVerdict } = await import("./org-health/sweep-readings.ts");
const { orgHealthReadings, orgHealthOrders, orgHealthTick } = await import("./org-health/fleet-build-readings.ts");

const { orgHealthNow } = await import("./work-gate/org-health.ts");
const { GH_READS } = await import("./work-gate/reads/read-memo-and-exit.ts");

const SIGNAL = "release-run-failed";
const REPO = "a11ign/a11ign";
const NOW = Date.parse("2026-10-07T15:30:00Z");
const SHA = "bcc3429b6fd11128ed5b16c7b342239265ef4417";

type Run = { id: number; event: string; status: string; conclusion: string | null; sha: string; createdAt: string; updatedAt: string; url: string };
const run = (id: number, event: string, conclusion: string | null, at: string, status = "completed"): Run =>
  ({ id, event, status, conclusion, sha: SHA, createdAt: at, updatedAt: at.replace(/:(\d\d)Z$/, ":59Z"), url: `https://github.com/${REPO}/actions/runs/${id}` });

/** 2026-10-07's list, NEWEST FIRST as the API returns it. */
const THAT_DAY: Run[] = [
  run(37643562214, "workflow_dispatch", "failure", "2026-10-07T15:23:52Z"),
  run(37641239003, "status", "skipped", "2026-10-07T14:59:02Z"),
  run(37639207735, "status", "skipped", "2026-10-07T14:44:13Z"),
  run(37638827189, "status", "skipped", "2026-10-07T14:41:30Z"),
  run(37636701947, "status", "skipped", "2026-10-07T14:26:28Z"),
  run(37635175628, "workflow_dispatch", "failure", "2026-10-07T14:15:26Z"),
  run(37633100583, "status", "success", "2026-10-07T14:00:30Z"),
  run(37625737650, "status", "cancelled", "2026-10-07T13:04:58Z"),
];
const GUARDS = [{ name: "guards", steps: ["Coverage — the whole-repo threshold"] }];
const PENDING = ["the-release-guards-3991.md", "consumer-gate-yml-3992.md"];
const failedWith = (runs: Run[] = THAT_DAY) => ({ runs, jobs: GUARDS, pending: PENDING });
const reading = (releaseRuns: unknown) => releaseFailedReading({ releaseRuns: releaseRuns as never });

// --- the reading -------------------------------------------------------------------------------------------------------------------

test("POSITIVE CONTROL: the day's list, whose newest verdict is a failed dispatch, trips and names the job, the step, the run, the sha and what is pending", () => {
  const r = reading(failedWith());
  assert.equal(r.status, "tripped");
  assert.equal(r.signal, SIGNAL);
  assert.equal(r.discriminator, `${SIGNAL}@37643562214`);
  assert.equal(r.firstTrippedAt, Date.parse("2026-10-07T15:23:59Z"));
  assert.match(r.detail, /job `guards` \(step "Coverage — the whole-repo threshold"\)/);
  assert.match(r.detail, /run 37643562214 \(workflow_dispatch\) at bcc3429b6/);
  assert.match(r.detail, /2 changeset\(s\) pending in \.changeset\/: the-release-guards-3991\.md, consumer-gate-yml-3992\.md/);
  assert.match(r.detail, /actions\/runs\/37643562214/);
});

test("the same list with a LATER SUCCESS clears; a success older than the failure does not", () => {
  assert.equal(reading({ runs: [run(37650000000, "push", "success", "2026-10-07T15:40:00Z"), ...THAT_DAY] }).status, "clear");
  assert.equal(reading(failedWith()).status, "tripped", "the 14:00Z success is older than both failures");
});

test("a status run's SUCCESS newer than the failure does not clear it (a11ign/agent-org#1273)", () => {
  assert.equal(reading(failedWith([run(37650000000, "status", "success", "2026-10-07T15:40:00Z"), ...THAT_DAY])).status, "tripped");
});

test("a cancelled, skipped or still-running run NEITHER trips NOR clears", () => {
  for (const [conclusion, status] of [["cancelled", "completed"], ["skipped", "completed"], [null, "in_progress"], ["neutral", "completed"]] as const) {
    const later = run(37650000000, "status", conclusion, "2026-10-07T15:40:00Z", status);
    assert.equal(reading(failedWith([later, ...THAT_DAY])).status, "tripped", `a later ${conclusion ?? status} run does not clear a failure`);
    const afterSuccess = [later, run(37649999999, "push", "success", "2026-10-07T15:35:00Z"), ...THAT_DAY];
    assert.equal(reading({ runs: afterSuccess }).status, "clear", `a later ${conclusion ?? status} run does not trip after a success`);
  }
});

test("the newest verdict is chosen by creation time, not by the order the list arrived in", () => {
  assert.equal(newestReleaseVerdict([...THAT_DAY].reverse())?.id, 37643562214);
});

test("a read it cannot make is UNKNOWN, never clear: a refused list, an empty one, and a window of skipped runs", () => {
  assert.equal(reading(null).status, "unknown");
  assert.match(reading(null).detail, /could not be read/);
  assert.equal(reading({ runs: [] }).status, "unknown");
  const skippedOnly = reading({ runs: THAT_DAY.filter((r) => r.conclusion === "skipped") });
  assert.equal(skippedOnly.status, "unknown");
  assert.match(skippedOnly.detail, /none of the newest 4 release\.yml run\(s\)/);
});

test("a failure whose jobs or pending changesets could not be read is STILL TRIPPED, and says what it could not read", () => {
  const r = reading({ runs: THAT_DAY, jobs: null, pending: null });
  assert.equal(r.status, "tripped");
  assert.match(r.detail, /the failing job could not be read/);
  assert.match(r.detail, /the pending changesets could not be read/);
  assert.match(reading({ runs: THAT_DAY, jobs: [], pending: [] }).detail, /no job of it reports failure.*no changeset is pending/);
});

test("a second failure is a NEW order: the discriminator is the run", () => {
  const second = reading(failedWith([run(37660000000, "push", "failure", "2026-10-07T16:00:00Z"), ...THAT_DAY]));
  assert.equal(second.discriminator, `${SIGNAL}@37660000000`);
});

// --- the order ---------------------------------------------------------------------------------------------------------------------

const QUIET = { now: NOW, lastMergedAt: NOW - 60 * 60_000, work: { greenPrs: 0, claimableRows: 0 }, redPrs: [], refusals: {}, claimRefusals: [],
  drift: { behind: 0, ahead: 0, dirty: [] }, primarySince: null };

test("the signal is in the readings only when the fact is given, and the order says what retries it", () => {
  assert.equal(orgHealthReadings({ ...QUIET, autoOff: { refusal: null, readAt: NOW } } as never).some((r) => r.signal === SIGNAL), false, "an omitted fact is silent");
  const orders = orgHealthOrders(orgHealthReadings({ ...QUIET, releaseRuns: failedWith() } as never));
  assert.equal(orders.length, 1);
  assert.equal(orders[0].subject, SIGNAL);
  assert.equal(orders[0].session, "ceo");
  assert.match(orders[0].prompt, /ORG HEALTH: `release-run-failed` HAS TRIPPED\. release\.yml on main FAILED/);
  assert.match(orders[0].prompt, /It first tripped at 2026-10-07T15:23:59Z/);
  assert.match(orders[0].prompt, /TRANSIENT .* SAME run: `gh run rerun <run id> --failed/);
  assert.match(orders[0].prompt, /FIXED ON `main` .* `gh workflow run release\.yml --ref main/);
  assert.match(orders[0].prompt, /Do not wait for the next changeset/);
  assert.equal(SIGNALS.RELEASE_FAILED, SIGNAL);
});

test("the tick says an unread release on stderr and offers nothing; a cleared one is silent", () => {
  const said: string[] = [];
  assert.deepEqual(orgHealthTick({ ...QUIET, releaseRuns: null } as never, { log: (l) => said.push(l), readAutoOff: () => undefined as never }), []);
  assert.match(said.join(""), /org-health: release-run-failed UNKNOWN -- the runs of release\.yml on main could not be read/);
  const silent: string[] = [];
  const clearRuns = { runs: [run(37650000000, "push", "success", "2026-10-07T15:40:00Z")] };
  assert.deepEqual(orgHealthTick({ ...QUIET, releaseRuns: clearRuns } as never, { log: (l) => silent.push(l), readAutoOff: () => undefined as never }), []);
  assert.deepEqual(silent, []);
});

// --- the reader ---------------------------------------------------------------------------------------------------------------------

/**
 * The fake code host in place, watched, holding the repository's `release.yml` runs, the jobs of the runs it is given (`name`/`conclusion`, and for a failed one the steps that failed) and the files of
 * `.changeset/`. What is not given is what the code host cannot answer: a refused read.
 */
function world({ runs, jobs = {}, changesets }: { runs?: Run[]; jobs?: Record<number, { name: string; conclusion: string | null; failedSteps?: string[] }[]>; changesets?: string[] }) {
  const watched = watchedRows(createFakeCodeHost());
  substituteCodeHost(watched.host);
  const health = (watched.host as unknown as { rowsWorld: ReturnType<typeof createFakeCodeHost>["rowsWorld"] }).rowsWorld;
  if (runs !== undefined) health.reports.health.releaseRuns.set(REPO, runs);
  for (const [id, held] of Object.entries(jobs)) health.reports.health.releaseJobs.set(`${REPO}#${id}`, held.map((job, at) => ({ id: at + 1, ...job })));
  if (changesets !== undefined) health.reports.health.changesets.set(REPO, changesets);
  return { world: health, asked: () => watched.calls.map((call) => call.op), read: () => readReleaseRuns(neverRun, REPO) };
}
const neverRun = (args: string[]): string => { throw new Error(`the code host answers this, not a gh: ${args.join(" ")}`); };
const FAILED_GUARDS = [{ name: "guards", conclusion: "failure", failedSteps: GUARDS[0].steps }];
const failedJobsOf = [{ id: 1, name: "guards", steps: GUARDS[0].steps }];

test("the reader makes ONE call while the newest verdict is a success, and three while it is a failure", () => {
  const ok = world({ runs: [run(1, "push", "success", "2026-10-07T15:40:00Z")] });
  assert.deepEqual(ok.read(), { runs: [run(1, "push", "success", "2026-10-07T15:40:00Z")] });
  assert.deepEqual(ok.asked(), ["releaseRunsOf"]);

  const bad = world({ runs: THAT_DAY, jobs: { 37643562214: FAILED_GUARDS }, changesets: ["README.md", "config.json", ...PENDING] });
  const fact = bad.read();
  assert.deepEqual(bad.asked(), ["releaseRunsOf", "releaseJobsOf", "changesetNamesOf"]);
  assert.deepEqual(fact?.jobs, failedJobsOf);
  assert.deepEqual(fact?.pending, PENDING, "README.md and config.json are not changesets");
  assert.equal(reading(fact).status, "tripped");
});

// A called workflow's jobs are named `<caller job> / <job>`. release.yml calls its publishing workflow as job `release`, so the publishing job is `release / publish`.
// These are the jobs of run 38332090768 (a11ign/a11ign, `workflow_dispatch` on main, 2026-10-13T01:25:50Z), as the API names and concludes them. The fake code host's `named` jobs are the projection
// `{name, conclusion}`, so the name match runs for real: a fake that returned a pre-filtered list could not see a wrong name.
const DISPATCH = 38332090768;
const PUBLISHED_JOBS = [
  { name: "release / ci gate result on this sha", conclusion: "success" },
  { name: "release / version", conclusion: "success" },
  { name: "release / publish", conclusion: "success" },
  { name: "release / tag", conclusion: "success" },
];
// A promote-only dispatch (`action-tag-version`) skips the publishing job by its `needs`. Only `release / publish` being skipped is the row's fact; the rest is assumed.
const PROMOTE_ONLY_JOBS = [
  { name: "release / ci gate result on this sha", conclusion: "success" },
  { name: "release / version", conclusion: "skipped" },
  { name: "release / publish", conclusion: "skipped" },
  { name: "release / tag", conclusion: "skipped" },
];

test("a dispatch's success clears when its `release / publish` job succeeded, on the REAL job names of run 38332090768", () => {
  const dispatch = run(DISPATCH, "workflow_dispatch", "success", "2026-10-13T01:25:50Z");
  const published = world({ runs: [dispatch, ...THAT_DAY], jobs: { [DISPATCH]: PUBLISHED_JOBS } });
  assert.equal(reading(published.read()).status, "clear");
  assert.deepEqual(published.asked(), ["releaseRunsOf", "releaseJobsOf"], "one call for the runs and one for the dispatch's jobs");
});

test("a promote-only dispatch (its `release / publish` job skipped) is no verdict: the failure before it still trips", () => {
  const dispatch = run(DISPATCH, "workflow_dispatch", "success", "2026-10-13T01:25:50Z");
  const promoteOnly = world({ runs: [dispatch, ...THAT_DAY], jobs: { [DISPATCH]: PROMOTE_ONLY_JOBS, 37643562214: FAILED_GUARDS }, changesets: PENDING });
  const fact = promoteOnly.read();
  assert.equal(reading(fact).status, "tripped", "the dispatch that did not publish does not clear the failure before it");
  assert.equal(reading(fact).discriminator, `${SIGNAL}@37643562214`);
});

test("a job named just `release` does not publish: no run's jobs carry that name, so it was the wrong name to look for", () => {
  const dispatch = run(DISPATCH, "workflow_dispatch", "success", "2026-10-13T01:25:50Z");
  const oldName = world({ runs: [dispatch, ...THAT_DAY], jobs: { [DISPATCH]: [{ name: "release", conclusion: "success" }], 37643562214: FAILED_GUARDS }, changesets: PENDING });
  assert.equal(reading(oldName.read()).status, "tripped");
});

test("the reader's refusals are nulls, never an empty answer: the list, the jobs and the changesets", () => {
  const refused = world({});
  assert.equal(refused.read(), null, "CONTROL of the next: a code host that holds no list cannot be asked");
  const listRefused = world({ runs: THAT_DAY });
  listRefused.world.failures.set("releaseRunsOf", new Error("HTTP 403"));
  assert.equal(listRefused.read(), null);
  const partial = world({ runs: THAT_DAY }).read();
  assert.deepEqual([partial?.jobs, partial?.pending], [null, null]);
  assert.equal(reading(partial).status, "tripped");
  const changesetsRefused = world({ runs: THAT_DAY, jobs: { 37643562214: FAILED_GUARDS } });
  changesetsRefused.world.failures.set("changesetNamesOf", new Error("HTTP 404"));
  const half = changesetsRefused.read();
  assert.deepEqual([half?.jobs, half?.pending], [failedJobsOf, null]);
});

// --- the gate: the signal is WIRED, which is what "within one tick" means ------------------------------------------------------------------

test("orgHealthNow offers the order from the reader it is given, and nothing when the reader is not asked or the release is clean", () => {
  const decideArgs = { prs: [], required: [], readyRows: [], prFiles: new Map(), rowBranches: [], openRows: [], primaryDrift: null, claimRefusals: [] };
  const tick = (readReleaseRuns?: () => unknown) => orgHealthNow({ prsRead: [], readyRead: [], openRowsRead: [], decideArgs, decided: [] } as never,
    { now: NOW, lastMergedAt: () => NOW, readCaptures: () => undefined, readRefusals: () => [], readLabJobs: () => [], log: () => {}, teamAccess: () => undefined,
      readWaits: () => ({ facts: new Map(), stale: [], bare: [], manual: 0 }), ...(readReleaseRuns && { readReleaseRuns }) } as never) as { subject: string; session: string; prompt: string }[];
  const ofSignal = <T extends { subject: string }>(orders: T[]) => orders.filter((o) => o.subject === SIGNAL);
  const order = ofSignal(tick(() => failedWith()))[0];
  assert.ok(order, "a failed release is offered by the tick");
  assert.match(order.prompt, /job `guards`/);
  assert.deepEqual(ofSignal(tick()), [], "a caller that does not ask is silent");
  assert.deepEqual(ofSignal(tick(() => ({ runs: [run(1, "push", "success", "2026-10-07T15:40:00Z")] }))), []);
});

test("the gate's call site passes the real reader and the read is counted, so the signal is not dead for want of a fact (#2980's lesson)", () => {
  assert.ok(GH_READS.unconditional.some((r: string) => r.includes("readReleaseRuns") && r.includes("release.yml/runs")), "the read is counted where reads are counted");
  const gate = workGateSource();
  assert.match(gate, /onReleaseRuns: \(runs\) => \{ releaseSeen\.runs = runs; \}/); // a11ign#5100: the same read, kept for the machinery canary so it costs no second call
});
