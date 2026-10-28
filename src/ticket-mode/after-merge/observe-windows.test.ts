// no-token: none -- pure readers over facts in memory
// A11-302: the board watches a window over one source and passes the check when it closes clean, fails it on the first breach (citing the event), or hands it to an agent when it cannot say
import { test } from "node:test";
import assert from "node:assert/strict";
import type { RunEvent } from "../queue/run-log.ts";
import type { Queue } from "../queue/queue-entries-and-outcomes.ts";
import { describeObserve, isWindowed, parseObserve, parseWindow, watchedCiHistories, watchedReviewUrls, watchedSources, watchStep, watchWindows, windowEnd, WINDOW_MAX_MS, type DoctorLine, type ObserveFacts, type ObserveSpec, type Release, type Sighting } from "./observe.ts";
import type { CheckRecord, ChecksFile } from "./checks.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** When the check was listed, and when its change was installed (the window began): the clock of every test starts here. */
const BEGAN = 100 * DAY;

/** An open board check watching `spec`, its window begun at {@link BEGAN} unless `began` says otherwise (null: not begun). */
const watching = (spec: ObserveSpec, over: Partial<CheckRecord["observe"] & object> = {}, began: number | null = BEGAN): CheckRecord => ({
  id: "A11-294#1", key: "A11-294", url: null, line: "a line", owner: null, runner: "board", listedAt: BEGAN - DAY, state: "open",
  observe: { spec, from: BEGAN - DAY, ...(began === null ? {} : { began }), ...over },
});
const fileOf = (...checks: CheckRecord[]): ChecksFile => ({ checks: Object.fromEntries(checks.map((one) => [one.id, one])) });
const facts = (over: Partial<ObserveFacts> = {}): ObserveFacts => ({ dependencyTickets: {}, queue: { entries: [] }, reviewOn: () => null, ...over });
const queueWith = (runLog: Record<string, readonly RunEvent[]>, entries: unknown[] = []): Pick<Queue, "entries" | "runLog"> => ({ entries, runLog }) as unknown as Pick<Queue, "entries" | "runLog">;
const closedBy = (file: ChecksFile) => file.checks["A11-294#1"];

/** The spec as a plan writes it, with its Pass and Window. */
const spec = (observe: string, pass: string, window: string): ObserveSpec => {
  const read = parseObserve(observe, { pass, window });
  assert.ok(typeof read === "object", `${observe} parses: ${String(read)}`);
  return read;
};

// --- THE PLAN'S WORDS ---

test("A11-302: the five windowed sources parse with their pass condition and window, and the first four specs take neither", () => {
  assert.deepEqual(parseObserve("run-log finished \"lost in a restart\"", { pass: "absent", window: "7d" }), { kind: "run-log", event: "finished", match: "lost in a restart", pass: "absent", windowMs: 7 * DAY });
  assert.deepEqual(parseObserve("merge-queue a11ign/agent-org request-thread-load", { pass: "absent", window: "7d" }), { kind: "merge-queue", repository: "a11ign/agent-org", match: "request-thread-load", pass: "absent", windowMs: 7 * DAY });
  assert.deepEqual(parseObserve("ci-history a11ign/agent-org CI main", { pass: "absent", window: "48h" }), { kind: "ci-history", repository: "a11ign/agent-org", workflow: "CI", branch: "main", pass: "absent", windowMs: 48 * HOUR });
  assert.deepEqual(parseObserve("doctor agents-host herdr-web-ui", { pass: "present", window: "6h" }), { kind: "doctor", host: "agents-host", check: "herdr-web-ui", pass: "present", windowMs: 6 * HOUR });
  assert.deepEqual(parseObserve("release-assets a11ign/agent-org ui-build 3", { pass: "present", window: "30d" }), { kind: "release-assets", repository: "a11ign/agent-org", asset: "ui-build", count: 3, pass: "present", windowMs: 30 * DAY });
  assert.deepEqual(parseObserve("wake"), { kind: "wake" });
  assert.match(String(parseObserve("wake", { pass: "absent", window: "7d" })), /takes no Pass or Window/);
});

test("A11-302: a windowed source without its pass condition or window, or with a bad one, is refused naming what is wrong", () => {
  assert.match(String(parseObserve("run-log finished", { window: "7d" })), /needs `Pass: absent \| present`/);
  assert.match(String(parseObserve("run-log finished", { pass: "never", window: "7d" })), /needs `Pass: absent \| present`, not "never"/);
  assert.match(String(parseObserve("run-log finished", { pass: "absent" })), /the window is missing/);
  assert.match(String(parseObserve("run-log finished", { pass: "absent", window: "a week" })), /"a week" is not a number of minutes, hours or days/);
  assert.match(String(parseObserve("run-log finished", { pass: "absent", window: "32d" })), /longer than 31 days/);
  assert.match(String(parseObserve("run-log lunch", { pass: "absent", window: "7d" })), /event kind "lunch", which is not one of/);
  assert.match(String(parseObserve("merge-queue agent-org", { pass: "absent", window: "7d" })), /is not `merge-queue <owner\/repo>/);
  assert.match(String(parseObserve("release-assets a11ign/agent-org ui-build 3", { pass: "absent", window: "7d" })), /needs `Pass: present`/);
  assert.match(String(parseObserve("release-assets a11ign/agent-org ui-build 0", { pass: "present", window: "7d" })), /is not `release-assets/);
  assert.equal(parseWindow("31d"), WINDOW_MAX_MS);
  assert.equal(parseWindow("0m"), "the window is empty");
});

test("A11-302: a spec is described as the ticket's Run detail says what the board watches", () => {
  assert.equal(describeObserve(spec("run-log finished \"lost in a restart\"", "absent", "7d")), "no finished event in the run log naming \"lost in a restart\" within 7 d");
  assert.equal(describeObserve({ kind: "wake", wait: "ciRun" }), "the board waking a run on its declared wait (ciRun)");
  assert.equal(isWindowed(spec("doctor here herdr", "absent", "1h")), true);
  assert.equal(isWindowed({ kind: "wake" }), false);
});

// --- THE RUN LOG ---

const lost = (at: number, key = "A11-310"): Record<string, readonly RunEvent[]> => ({ [key]: [{ kind: "finished", outcome: "needs-human", reason: "lost in a restart", at }] });

test("A11-302: run-log, absent: a window that closes with no such event passes, citing the window", () => {
  const check = watching(spec("run-log finished \"lost in a restart\"", "absent", "7d"));
  const unrelated = queueWith({ "A11-310": [{ kind: "finished", outcome: "ready-pr", at: BEGAN + DAY }, { kind: "started", model: "m", effort: "e", instance: null, at: BEGAN + DAY }] });
  const midway = watchWindows(fileOf(check), facts({ queue: unrelated }), BEGAN + 3 * DAY);
  assert.equal(closedBy(midway).state, "open", "still inside its window");
  assert.equal(closedBy(midway).observe?.reads, 1, "and it has been read");
  const closed = closedBy(watchWindows(midway, facts({ queue: unrelated }), BEGAN + 7 * DAY));
  assert.equal(closed.state, "passed");
  assert.equal(closed.closedBy, "board");
  assert.match(closed.result ?? "", /^no finished event in the run log naming "lost in a restart" from 1970-04-11 00:00 to 1970-04-18 00:00 \(7 d window, read 2 times\)$/);
});

test("A11-302: run-log, absent: the first breach fails the check at once, citing the event, and an event from before the window began is no breach", () => {
  const check = watching(spec("run-log finished \"lost in a restart\"", "absent", "7d"));
  const before = watchWindows(fileOf(check), facts({ queue: queueWith(lost(BEGAN - HOUR)) }), BEGAN + DAY);
  assert.equal(closedBy(before).state, "open", "a crash from before the release says nothing about it");
  const breach = closedBy(watchWindows(fileOf(check), facts({ queue: queueWith({ ...lost(BEGAN + 2 * DAY, "A11-312"), ...lost(BEGAN + DAY, "A11-311") }) }), BEGAN + 3 * DAY));
  assert.equal(breach.state, "failed");
  assert.equal(breach.closedAt, BEGAN + 3 * DAY);
  assert.match(breach.result ?? "", /^A11-311: finished needs-human lost in a restart at 1970-04-12 00:00: a finished event in the run log naming "lost in a restart" inside the 7 d window from 1970-04-11 00:00$/, "the earliest breach is cited");
});

test("A11-302: run-log, present: the first matching event passes it, and a window that closes without one hands the check to an agent instead of failing it", () => {
  const check = watching(spec("run-log needs-you", "present", "2d"));
  const event = queueWith({ "A11-310": [{ kind: "needs-you", reason: "escalation", at: BEGAN + HOUR }] });
  const passed = closedBy(watchWindows(fileOf(check), facts({ queue: event }), BEGAN + 2 * HOUR));
  assert.deepEqual([passed.state, passed.result], ["passed", "A11-310: needs-you escalation at 1970-04-11 01:00"]);
  const handed = closedBy(watchWindows(fileOf(check), facts(), BEGAN + 2 * DAY));
  assert.deepEqual([handed.state, handed.runner], ["open", "agent"], "the board cannot say it did not happen");
  assert.match(handed.handedOff ?? "", /^the window of 2 d closed and the board did not see a needs-you event in the run log$/);
});

// --- THE MERGE QUEUE ---

const removed = (url: string, head: string, removals: number, jobs: string[]) => ({ ticket: { key: "A11-320" }, queueHeads: { [url]: { head, step: "round", removals, jobs } } });
const POOL = "https://github.com/a11ign/agent-org/pull/1960";

test("A11-302: merge-queue, absent: removals already recorded when the window began are the baseline, and the first new one for the named job fails the check, citing it", () => {
  const check = watching(spec("merge-queue a11ign/agent-org request-thread-load", "absent", "7d"));
  const old = facts({ queue: queueWith({}, [removed(POOL, "abc", 1, ["request-thread-load"])]) });
  const begun = watchWindows(fileOf(check), old, BEGAN);
  assert.equal(closedBy(begun).state, "open", "the removal that stood when the window began is not a breach");
  assert.deepEqual(closedBy(begun).observe?.seen, [`${POOL}@abc#1`]);
  const other = facts({ queue: queueWith({}, [removed(POOL, "abc", 1, ["request-thread-load"]), removed("https://github.com/a11ign/lab/pull/9", "d", 1, ["request-thread-load"]), removed("https://github.com/a11ign/agent-org/pull/1961", "e", 2, ["lint"])]) });
  assert.equal(closedBy(watchWindows(begun, other, BEGAN + DAY)).state, "open", "another repository's removal, and a removal for another job, are not it");
  const second = facts({ queue: queueWith({}, [removed(POOL, "abc", 2, ["request-thread-load", "lint"])]) });
  const failed = closedBy(watchWindows(begun, second, BEGAN + DAY));
  assert.equal(failed.state, "failed");
  assert.match(failed.result ?? "", /^a11ign\/agent-org #1960 removed from the merge queue \(failed: request-thread-load, lint\): a removal from a11ign\/agent-org's merge queue naming "request-thread-load" inside the 7 d window/);
});

test("A11-302: merge-queue, absent: a window that closes with no new removal passes", () => {
  const check = watching(spec("merge-queue a11ign/agent-org request-thread-load", "absent", "7d"));
  const same = facts({ queue: queueWith({}, [removed(POOL, "abc", 1, ["request-thread-load"])]) });
  const begun = watchWindows(fileOf(check), same, BEGAN);
  const closed = closedBy(watchWindows(begun, same, BEGAN + 7 * DAY));
  assert.equal(closed.state, "passed");
  assert.match(closed.result ?? "", /^no removal from a11ign\/agent-org's merge queue naming "request-thread-load" from 1970-04-11 00:00 to 1970-04-18 00:00 \(7 d window, read 2 times\)$/);
});

// --- CI HISTORY ---

const ciRun = (id: number, at: number): Sighting => ({ id: `a11ign/agent-org#${id}`, at, text: `CI run https://github.com/a11ign/agent-org/actions/runs/${id} failed on main` });

test("A11-302: ci-history, absent: a failed run after the window began fails the check, citing the run; one from before does not; a window with none passes", () => {
  const check = watching(spec("ci-history a11ign/agent-org CI", "absent", "7d"));
  const seen: string[] = [];
  const reader = (failures: Sighting[]) => facts({ ciFailures: (repository, workflow, branch) => { seen.push(`${repository} ${workflow} ${branch ?? "-"}`); return failures; } });
  assert.equal(closedBy(watchWindows(fileOf(check), reader([ciRun(1, BEGAN - HOUR)]), BEGAN + DAY)).state, "open", "a failure from before the release");
  assert.deepEqual(seen, ["a11ign/agent-org CI -"], "the host is asked for the repository, the workflow and the default branch");
  const failed = closedBy(watchWindows(fileOf(check), reader([ciRun(1, BEGAN - HOUR), ciRun(2, BEGAN + 2 * DAY)]), BEGAN + 3 * DAY));
  assert.equal(failed.state, "failed");
  assert.match(failed.result ?? "", /^CI run https:\/\/github\.com\/a11ign\/agent-org\/actions\/runs\/2 failed on main at 1970-04-13 00:00: a failed CI run of a11ign\/agent-org inside the 7 d window/);
  const clean = closedBy(watchWindows(fileOf(check), reader([ciRun(1, BEGAN - HOUR)]), BEGAN + 7 * DAY));
  assert.deepEqual([clean.state, clean.closedBy], ["passed", "board"]);
});

// --- THE DOCTOR ---

const line = (name: string, ok: boolean, detail = ""): DoctorLine => ({ name, ok, detail });

test("A11-302: doctor, present: the named check passing on the named host passes the check; failing, or a doctor that cannot be read, does not", () => {
  const check = watching(spec("doctor agents-host herdr-web-ui", "present", "6h"));
  const doctor = (lines: DoctorLine[] | null) => facts({ doctor: (host) => (host === "agents-host" ? lines : null) });
  assert.equal(closedBy(watchWindows(fileOf(check), doctor([line("herdr-web-ui", false, "0.4.1, not the newest")]), BEGAN + HOUR)).state, "open", "failing");
  const passed = closedBy(watchWindows(fileOf(check), doctor([line("node", true), line("herdr-web-ui", true, "0.5.0")]), BEGAN + HOUR));
  assert.deepEqual([passed.state, passed.result], ["passed", "agents-host doctor: herdr-web-ui ok (0.5.0) at 1970-04-11 01:00"]);
  const unread = closedBy(watchWindows(fileOf(check), doctor(null), BEGAN + 6 * HOUR));
  assert.deepEqual([unread.state, unread.runner], ["open", "agent"], "a doctor the board cannot read hands the check on when the window closes");
  assert.match(unread.handedOff ?? "", /^the window of 6 h closed and the board could not read /);
  assert.equal(closedBy(watchWindows(fileOf(check), doctor([line("node", true)]), BEGAN + 6 * HOUR)).runner, "agent", "a doctor that shows no such check says nothing either");
});

test("A11-302: doctor, absent: the named check failing fails the check, citing the line; ok for the whole window passes it", () => {
  const check = watching(spec("doctor agents-host herdr-web-ui", "absent", "1h"));
  const doctor = (ok: boolean) => facts({ doctor: () => [line("herdr-web-ui", ok, ok ? "" : "stale")] });
  const failed = closedBy(watchWindows(fileOf(check), doctor(false), BEGAN + 10 * MINUTE));
  assert.deepEqual([failed.state, failed.result?.startsWith("agents-host doctor: herdr-web-ui not ok (stale)")], ["failed", true]);
  const begun = watchWindows(fileOf(check), doctor(true), BEGAN + 10 * MINUTE);
  assert.equal(closedBy(begun).state, "open");
  assert.equal(closedBy(watchWindows(begun, doctor(true), BEGAN + HOUR)).state, "passed");
});

// --- A RELEASE'S ASSETS ---

const release = (tag: string, at: number, assets: string[]): Release => ({ tag, at, assets });

test("A11-302: release-assets: the next releases each carrying the asset pass the check, and the first one without it fails it, citing the release", () => {
  const check = watching(spec("release-assets a11ign/agent-org ui-build 2", "present", "30d"));
  const releases = (list: Release[]) => facts({ releases: (repository) => (repository === "a11ign/agent-org" ? list : null) });
  const old = release("v1.0.0", BEGAN - DAY, []);
  assert.equal(closedBy(watchWindows(fileOf(check), releases([old, release("v1.0.1", BEGAN + DAY, ["ui-build.tgz"])]), BEGAN + 2 * DAY)).state, "open", "one of two, and a release from before does not count");
  const passed = closedBy(watchWindows(fileOf(check), releases([old, release("v1.0.2", BEGAN + 2 * DAY, ["ui-build.tgz", "x"]), release("v1.0.1", BEGAN + DAY, ["ui-build.tgz"])]), BEGAN + 3 * DAY));
  assert.deepEqual([passed.state, passed.result], ["passed", "the next 2 releases of a11ign/agent-org carrying ui-build: v1.0.1, v1.0.2"]);
  const failed = closedBy(watchWindows(fileOf(check), releases([release("v1.0.1", BEGAN + DAY, ["ui-build.tgz"]), release("v1.0.2", BEGAN + 2 * DAY, ["source.tgz"])]), BEGAN + 3 * DAY));
  assert.deepEqual([failed.state, failed.result], ["failed", "release v1.0.2 of a11ign/agent-org (1970-04-13 00:00) has no ui-build asset"]);
});

test("A11-302: release-assets: only the next `count` releases are judged: a later release without the asset does not undo a satisfied count, and an earlier one breaks it", () => {
  const check = watching(spec("release-assets a11ign/agent-org ui-build 2", "present", "30d"));
  const releases = (list: Release[]) => facts({ releases: () => list });
  const good = (tag: string, day: number) => release(tag, BEGAN + day * DAY, ["ui-build.tgz"]);
  const satisfied = closedBy(watchWindows(fileOf(check), releases([good("v1.0.1", 1), good("v1.0.2", 2), release("v1.0.3", BEGAN + 3 * DAY, ["source.tgz"])]), BEGAN + 4 * DAY));
  assert.deepEqual([satisfied.state, satisfied.result], ["passed", "the next 2 releases of a11ign/agent-org carrying ui-build: v1.0.1, v1.0.2"]);
  const broken = closedBy(watchWindows(fileOf(check), releases([good("v1.0.1", 1), release("v1.0.2", BEGAN + 2 * DAY, ["source.tgz"]), good("v1.0.3", 3)]), BEGAN + 4 * DAY));
  assert.deepEqual([broken.state, broken.result], ["failed", `release v1.0.2 of a11ign/agent-org (${new Date(BEGAN + 2 * DAY).toISOString().slice(0, 16).replace("T", " ")}) has no ui-build asset`]);
});

test("A11-302: release-assets: a window that closes before enough releases came, or a repository whose releases cannot be read, hands the check to an agent", () => {
  const check = watching(spec("release-assets a11ign/agent-org ui-build 3", "present", "7d"));
  const some = facts({ releases: () => [release("v1.0.1", BEGAN + DAY, ["ui-build.tgz"])] });
  const short = closedBy(watchWindows(fileOf(check), some, BEGAN + 7 * DAY));
  assert.deepEqual([short.runner, short.handedOff], ["agent", "the window of 7 d closed and the board saw 1 of 3 releases in 7 d"]);
  assert.equal(closedBy(watchWindows(fileOf(check), facts(), BEGAN + 7 * DAY)).runner, "agent", "no reader on this host");
});

// --- THE WINDOW ITSELF ---

test("A11-302: a window begins when the change is installed, not when the check was listed, and an installed change fixes its start for good", () => {
  const check = watching(spec("run-log finished \"lost in a restart\"", "absent", "7d"), {}, null);
  const notYet = facts({ installed: () => false, queue: queueWith(lost(BEGAN)) });
  assert.equal(watchStep(check, notYet, BEGAN + DAY), null, "nothing is read, and nothing is breached, before it is installed");
  assert.equal(watchWindows(fileOf(check), notYet, BEGAN + DAY).checks["A11-294#1"], check);
  const begun = closedBy(watchWindows(fileOf(check), facts({ installed: () => true }), BEGAN + 2 * DAY));
  assert.equal(begun.observe?.began, BEGAN + 2 * DAY);
  assert.equal(windowEnd(begun.observe!), BEGAN + 9 * DAY);
  assert.equal(closedBy(watchWindows(fileOf(begun), facts({ installed: () => false }), BEGAN + 3 * DAY)).observe?.began, BEGAN + 2 * DAY, "once begun, it stays begun");
  assert.equal(windowEnd({ spec: { kind: "wake" }, from: 5 }), 5 + 7 * DAY, "an event the board waits for is watched for a week");
});

test("A11-302: only an open board check with a windowed spec is watched, and the sources it needs are named so the sweep reads only those", () => {
  const closed: CheckRecord = { ...watching(spec("doctor a b", "absent", "1h")), id: "A11-1#1", state: "passed" };
  const agent: CheckRecord = { ...watching(spec("doctor a b", "absent", "1h")), id: "A11-2#1", runner: "agent" };
  const legacy: CheckRecord = { ...watching({ kind: "wake" }), id: "A11-3#1" };
  const ci: CheckRecord = { ...watching(spec("ci-history a11ign/lab CI", "absent", "1h")), id: "A11-4#1" };
  assert.deepEqual([...watchedSources(fileOf(closed, agent, legacy, ci))], ["ci-history"]);
  for (const one of [closed, agent, legacy]) assert.equal(watchStep(one, facts(), BEGAN), null);
});

test("A11-356: the runs the sweep reads for ci-history watches are those of a watch that has begun or whose change is installed, once for each repository, workflow and branch", () => {
  const lab = { ...watching(spec("ci-history a11ign/lab CI", "absent", "1h"), {}, null), id: "A11-4#1", key: "A11-4" };
  const labAgain = { ...watching(spec("ci-history a11ign/lab CI", "absent", "2h"), {}, null), id: "A11-5#1", key: "A11-5" };
  const waiting = { ...watching(spec("ci-history a11ign/agent-org CI", "absent", "1h"), {}, null), id: "A11-6#1", key: "A11-6" };
  const begun = { ...watching(spec("ci-history a11ign/agent-org CI main", "absent", "1h"), { began: BEGAN }, BEGAN), id: "A11-7#1" };
  const file = fileOf(lab, labAgain, waiting, begun);
  const installedKeys = new Set(["A11-4", "A11-5"]);
  const asked = watchedCiHistories(file, (check) => installedKeys.has(check.key)).map(({ repository, workflow, branch }) => `${repository} ${workflow} ${branch ?? "-"}`);
  assert.deepEqual(asked, ["a11ign/lab CI -", "a11ign/agent-org CI main"], "the lab's two watches are one read, the one not installed and not begun is none, the begun one is read");
  assert.equal(watchedCiHistories(file).length, 3, "with no word on what is installed, every watch is read");
});

test("A11-356: the pull requests the sweep reads for review watches are those of the open review checks, once each", () => {
  const review = (id: string, url: string, state: CheckRecord["state"] = "open"): CheckRecord => ({ ...watching({ kind: "review", url }), id, state });
  const file = fileOf(review("A11-1#1", "https://github.com/a11ign/lab/pull/1"), review("A11-2#1", "https://github.com/a11ign/lab/pull/1"), review("A11-3#1", "https://github.com/a11ign/lab/pull/2", "passed"));
  assert.deepEqual(watchedReviewUrls(file), ["https://github.com/a11ign/lab/pull/1"]);
});
