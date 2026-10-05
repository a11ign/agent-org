// no-token: gh -- a fake `run` stands for `gh`, and the status page is a local server; nothing reaches GitHub, git or herdr
/**
 * #3723: THE GATE READS GITHUB'S OWN STATUS, so a runner outage is held as ONE signal and not woken as a hundred reds.
 *
 * THE DEFECT, 2026-10-05 (Actions degraded from 19:11:58Z): #3709's `ci` jobs sat queued 15 minutes and were abandoned, lab#4's `arm` job was
 * cancelled with an empty steps list, a11ign/toolchain#3 was ejected from the merge queue for a `gate` job that never got a runner. Each was an
 * order that woke an owner to re-run something that failed to START. Measured on the real jobs (`gh api .../actions/runs/<id>/jobs`): `conclusion:
 * "cancelled"`, `runner_name: ""`, zero steps -- the shape `neverStarted` reads below.
 *
 * THE CONTROLS ARE THE ROW'S: a red that RAN still goes out (a job with steps), a failure the gate cannot classify goes out, a status page that
 * cannot be read holds nothing, and the next reading with every component operational delivers what was held. Each assertion that something is
 * HELD also asserts the order exists without the incident, so none passes because the fixture never made an order.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decide, holdForGithubIncident, githubIncidentOf, githubIncidentOrder, startGithubStatus, GITHUB_STATUS_TIMEOUT_MS,
} from "./work-gate.mjs";

type Incident = ReturnType<typeof githubIncidentOf>;
type Order = { session: string, cause: string, subject: string, discriminator: string, causeKey: string, prompt: string };

const NOW = Date.parse("2026-10-05T21:00:00Z");
const MINUTE = 60_000;
const ago = (minutes: number) => new Date(NOW - minutes * MINUTE).toISOString();
const RUN = "https://github.com/a11ign/a11ign/actions/runs/900";

const check = (name: string, over: Record<string, unknown> = {}) => ({
  name, status: "COMPLETED", conclusion: "SUCCESS", startedAt: ago(30), completedAt: ago(20), detailsUrl: `${RUN}/job/111`, workflowName: "ci", ...over,
});
const prOf = (over: Record<string, unknown> = {}) => ({
  number: 3709, headRefOid: "0123abcd00000000", isDraft: false, headRefName: "agent/some-slug-3709", labels: [{ name: "session:worker-3709" }],
  closingIssuesReferences: [], comments: [], reviews: [], reviewDecision: "APPROVED", statusCheckRollup: [check("gate")], ...over,
});
let seen: object[] = []; // the pull requests the last `ordersOf` made orders from: what `holdForGithubIncident` is handed to find the one an order names
const ordersOf = (...prs: object[]) => { seen = prs; return decide({ prs, readyRows: [], nowMs: NOW }) as Order[]; };

/** The three components the row names, each `operational` unless a test says otherwise, as `summary.json` carries them. */
const summary = (actions = "degraded_performance", extra: Record<string, unknown> = {}) => JSON.stringify({
  components: [{ name: "Actions", status: actions }, { name: "API Requests", status: "operational" }, { name: "Git Operations", status: "operational" },
    { name: "Copilot", status: "major_outage" }],
  incidents: [{ id: "3q1yb5m7ltvb", name: "Incident with Actions", status: "investigating", components: [{ name: "Actions" }] }], ...extra,
});
const INCIDENT = githubIncidentOf({ status: 200, body: summary() });
const CLEAR = githubIncidentOf({ status: 200, body: summary("operational", { incidents: [] }) });

/** What `gh api` answers for a job id or a run id, as the REAL jobs answered on 2026-10-05; anything else is a refusal, which no order may be held on. */
const NEVER_STARTED = { conclusion: "cancelled", runner_name: "", steps: 0 };
const RAN = { conclusion: "failure", runner_name: "GitHub Actions 1000051907", steps: 12 };
const fakeGh = (answers: Record<string, unknown>, calls: string[] = []) => (args: string[]): string => {
  const path = args[1] ?? "";
  calls.push(path);
  const key = Object.keys(answers).find((k) => path.includes(k));
  if (key === undefined) throw new Error(`gh: not found ${path}`);
  return JSON.stringify(answers[key]);
};
const hold = (orders: Order[], incident: Incident, answers: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  holdForGithubIncident(orders, incident, { prs: seen, run: fakeGh(answers), nowMs: NOW, ...extra }) as { orders: Order[], held: { subject: string, session: string, why: string }[] };

const cancelledRed = () => prOf({ statusCheckRollup: [check("gate", { conclusion: "CANCELLED", detailsUrl: `${RUN}/job/111` })] });
const timedOutRed = () => prOf({ number: 3710, headRefOid: "4444abcd00000000",
  statusCheckRollup: [check("ts / run", { conclusion: "TIMED_OUT", detailsUrl: `${RUN}/job/222` })] });
const queuedPastBound = () => prOf({ number: 3711, headRefOid: "5555abcd00000000",
  statusCheckRollup: [check("gate", { status: "QUEUED", conclusion: "", startedAt: ago(75), completedAt: null, detailsUrl: `${RUN}/job/333` })] });
const ejectedPr = () => prOf({ number: 3, repo: "a11ign/toolchain", repoKey: "toolchain",
  ejection: { removedAt: "2026-10-05T20:42:05Z", runId: 37369397990, failingTests: null } });
const JOBS = { "actions/jobs/111": NEVER_STARTED, "actions/jobs/222": NEVER_STARTED };

test("control: without an incident each fixture IS an order -- or every hold below is vacuous", () => {
  const orders = ordersOf(cancelledRed(), timedOutRed(), queuedPastBound());
  assert.deepEqual(orders.map((o) => [o.cause, o.subject]).sort(), [["pr-checks-failing", "pr-3709"], ["pr-checks-failing", "pr-3710"], ["pr-checks-failing", "pr-3711"]]);
});

test("DONE-WHEN 1: under an incident a job cancelled with no steps, a check that timed out unstarted and a PR queued past its bound send NO order, and ONE signal names the incident", () => {
  const orders = ordersOf(cancelledRed(), timedOutRed(), queuedPastBound());
  const { orders: kept, held } = hold(orders, INCIDENT, JOBS);
  assert.deepEqual(kept, []);
  assert.deepEqual(held.map((h) => h.subject).sort(), ["pr-3709", "pr-3710", "pr-3711"]);
  const signals = githubIncidentOrder(INCIDENT, held) as Order[];
  assert.equal(signals.length, 1, "one signal, not one per row");
  assert.equal(signals[0].cause, "org-health", "no new order kind: an existing cause carries it");
  assert.equal(signals[0].subject, "github-incident");
  assert.equal(signals[0].session, "ceo");
  assert.match(signals[0].prompt, /Incident with Actions/);
  for (const subject of ["pr-3709", "pr-3710", "pr-3711"]) assert.match(signals[0].prompt, new RegExp(subject), "a hold is never silent: the signal names what it holds");
  assert.equal(signals[0].causeKey, "ceo/org-health/github-incident/3q1yb5m7ltvb", "keyed on the incident, so a second tick of it is the same order");
});

test("DONE-WHEN 1: a merge-queue ejection whose only failing job has an empty steps list is held (a11ign/toolchain#3, measured)", () => {
  const orders = ordersOf(ejectedPr()).filter((o) => o.cause === "pr-checks-failing"); // the PR is green and unreviewed, so a reviewer's order stands beside it
  assert.equal(orders.length, 1, "control: the ejection IS an order without the incident");
  assert.match(orders[0].causeKey, /\/ejected\/2026-10-05T20:42:05Z$/);
  const answers = {
    "actions/runs?event=merge_group": [{ id: 37369397990, head_branch: "gh-readonly-queue/main/pr-3-2e3cae9ca091", created_at: "2026-10-05T20:23:10Z" }],
    "actions/runs/37369397990/jobs": [NEVER_STARTED],
  };
  const { orders: kept, held } = hold(orders, INCIDENT, answers, { prs: [ejectedPr()] });
  assert.deepEqual(kept, []);
  assert.equal(held.length, 1);
});

test("DONE-WHEN 2: under the SAME incident a check that RAN and failed still goes out as pr-checks-failing", () => {
  const ranRed = prOf({ statusCheckRollup: [check("gate", { conclusion: "FAILURE", detailsUrl: `${RUN}/job/444` })] });
  const orders = ordersOf(ranRed);
  assert.equal(orders.length, 1);
  const { orders: kept, held } = hold(orders, INCIDENT, { "actions/jobs/444": RAN });
  assert.deepEqual(kept, orders);
  assert.deepEqual(held, []);
});

test("DONE-WHEN 2: a red made of an unstarted job AND one that ran goes out -- every red check must be a runner start to be held", () => {
  const mixed = prOf({ statusCheckRollup: [check("gate", { conclusion: "CANCELLED", detailsUrl: `${RUN}/job/111` }),
    check("ts / run", { conclusion: "FAILURE", detailsUrl: `${RUN}/job/444` })] });
  const orders = ordersOf(mixed);
  assert.equal(orders.length, 1);
  assert.deepEqual(hold(orders, INCIDENT, { ...JOBS, "actions/jobs/444": RAN }).orders, orders);
});

test("DONE-WHEN 6: a failure the gate cannot classify is NOT held -- an unreadable job, a check with no job link, an ejection with no run, a check that is running", () => {
  const unreadable = ordersOf(cancelledRed());
  assert.deepEqual(hold(unreadable, INCIDENT, {}).orders, unreadable, "the job read was refused");
  const noLink = ordersOf(prOf({ statusCheckRollup: [check("gate", { conclusion: "CANCELLED", detailsUrl: "https://example.com/status/1" })] }));
  assert.equal(noLink.length, 1);
  assert.deepEqual(hold(noLink, INCIDENT, JOBS).orders, noLink, "not an Actions job: nothing to read steps from");
  const ejected = ordersOf(ejectedPr()).filter((o) => o.cause === "pr-checks-failing");
  assert.deepEqual(hold(ejected, INCIDENT, { "actions/runs?event=merge_group": [] }, { prs: [ejectedPr()] }).orders, ejected, "no run found for the ejection");
  const hanging = ordersOf(prOf({ statusCheckRollup: [check("gate", { status: "IN_PROGRESS", conclusion: "", startedAt: ago(75), completedAt: null })] }));
  assert.equal(hanging.length, 1, "control: a hung check is an order");
  assert.deepEqual(hold(hanging, INCIDENT, {}).orders, hanging, "IN_PROGRESS ran: a hang is the owner's");
});

test("a job that never started needs both: steps AND no runner -- a cancelled job that had a runner ran something", () => {
  const orders = ordersOf(cancelledRed());
  assert.deepEqual(hold(orders, INCIDENT, { "actions/jobs/111": { conclusion: "cancelled", runner_name: "GitHub Actions 1", steps: 0 } }).orders, orders);
  assert.deepEqual(hold(orders, INCIDENT, { "actions/jobs/111": { conclusion: "cancelled", runner_name: "", steps: 3 } }).orders, orders);
});

test("only the three orders of the row are touched: another cause under the incident goes out unchanged", () => {
  const other = [{ session: "ceo", cause: "answer-owed", subject: "row-7", discriminator: "7", prompt: "x", causeKey: "ceo/answer-owed/row-7" }];
  assert.deepEqual(hold(other as Order[], INCIDENT, {}).orders, other);
});

test("DONE-WHEN 3: a fetch that timed out, returned non-JSON, an HTTP error or a status the gate does not know is UNKNOWN: no signal, nothing held", () => {
  const unreadings = [{ error: "TimeoutError" }, { status: 200, body: "<html>bad gateway</html>" }, { status: 503, body: summary() },
    { status: 200, body: summary("on_fire") }, { status: 200, body: JSON.stringify({ components: [] }) }, { status: 200, body: "null" }, null, undefined];
  const orders = ordersOf(cancelledRed());
  for (const envelope of unreadings) {
    const reading = githubIncidentOf(envelope as never);
    assert.equal((reading as { state: string }).state, "unknown", JSON.stringify(envelope));
    assert.deepEqual(hold(orders, reading, JOBS).orders, orders);
    assert.deepEqual(githubIncidentOrder(reading, []), []);
  }
  assert.equal((INCIDENT as { state: string }).state, "incident", "control: the same parser does read an incident");
});

test("a degraded component beside an unknown status is still an incident; any of the row's three components counts, and Copilot does not", () => {
  const body = (components: object[]) => JSON.stringify({ components, incidents: [] });
  const state = (components: object[]) => (githubIncidentOf({ status: 200, body: body(components) }) as { state: string }).state;
  assert.equal(state([{ name: "Actions", status: "operational" }, { name: "API Requests", status: "partial_outage" }, { name: "Git Operations", status: "operational" }]), "incident");
  assert.equal(state([{ name: "Actions", status: "operational" }, { name: "API Requests", status: "operational" }, { name: "Git Operations", status: "major_outage" }]), "incident");
  assert.equal(state([{ name: "Actions", status: "degraded_performance" }, { name: "API Requests", status: "weird" }, { name: "Git Operations", status: "operational" }]), "incident");
  assert.equal(state([{ name: "Actions", status: "operational" }, { name: "API Requests", status: "operational" }, { name: "Git Operations", status: "operational" },
    { name: "Copilot", status: "major_outage" }]), "clear");
});

test("DONE-WHEN 4: it clears itself -- the next reading with every component operational delivers what was held, with no label or file to remove", () => {
  const orders = ordersOf(cancelledRed(), queuedPastBound());
  const during = hold(orders, INCIDENT, JOBS);
  assert.deepEqual(during.orders, [], "tick 1, inside the incident");
  const calls: string[] = [];
  const after = holdForGithubIncident(orders, CLEAR, { prs: seen, run: fakeGh(JOBS, calls), nowMs: NOW }) as { orders: Order[], held: unknown[] };
  assert.deepEqual(after.orders, orders, "tick 2, the first after it clears: the held orders go out, whole");
  assert.deepEqual(after.held, []);
  assert.deepEqual(calls, [], "and clearing costs no call: the same status reading is the whole of it");
  assert.deepEqual(githubIncidentOrder(CLEAR, []), [], "no signal once clear");
});

test("a held order is classified once per job per tick, however many orders name the same job", () => {
  const calls: string[] = [];
  const twin = prOf({ number: 3712, headRefOid: "6666abcd00000000" });
  const orders = ordersOf(cancelledRed(), { ...twin, statusCheckRollup: cancelledRed().statusCheckRollup });
  assert.equal(orders.length, 2);
  hold(orders, INCIDENT, JOBS, { run: fakeGh(JOBS, calls) });
  assert.deepEqual(calls, ["repos/a11ign/a11ign/actions/jobs/111"]);
});

// ---- THE FETCH: bounded, off the critical path, fails open --------------------------------------------------------------------------------

/**
 * The status page, as a CHILD process: `settle()` blocks the gate's own thread until the bound, so a server in the test's process could never answer it.
 * That is also the real shape -- the fetch is a separate process precisely so the gate's synchronous reads do not stand in its way.
 */
const SERVER = `const http = require("node:http");
const [body, delay] = process.argv.slice(1);
const server = http.createServer((_req, res) => setTimeout(() => res.end(body), Number(delay))).listen(0, "127.0.0.1", () => console.log(server.address().port));`;
const serve = (body: string, delayMs = 0) => new Promise<{ url: string, stop: () => void }>((done) => {
  const child = spawn(process.execPath, ["-e", SERVER, body, String(delayMs)], { stdio: ["ignore", "pipe", "inherit"] });
  child.stdout.once("data", (port) => done({ url: `http://127.0.0.1:${String(port).trim()}/summary.json`, stop: () => child.kill() }));
});

test("DONE-WHEN 5: the bound is 3 s, and a status page that takes longer starts WITHOUT delaying the first read and reads UNKNOWN at its bound", async () => {
  assert.equal(GITHUB_STATUS_TIMEOUT_MS, 3000);
  const { url, stop } = await serve(summary(), 2000);
  const dir = mkdtempSync(join(tmpdir(), "github-incident-"));
  try {
    const began = performance.now();
    const status = startGithubStatus({ url, timeoutMs: 300, file: join(dir, "status.json") });
    const firstRead = performance.now() - began; // what the gate's first read would have waited: starting the fetch is all it pays
    assert.ok(firstRead < 250, `starting the fetch took ${Math.round(firstRead)} ms; it must not wait for the page`);
    const reading = status.settle() as { state: string, wallMs?: number };
    assert.equal(reading.state, "unknown", "no answer by the bound is unknown, never a hold");
    assert.ok(performance.now() - began < 1500, "and it did not wait for the 2 s answer");
  } finally {
    stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a fast status page is read by the child while the gate does its own reads, and the wall of the call comes back as a number", async () => {
  const { url, stop } = await serve(summary());
  const dir = mkdtempSync(join(tmpdir(), "github-incident-"));
  try {
    const status = startGithubStatus({ url, timeoutMs: 3000, file: join(dir, "status.json") });
    const reading = status.settle() as { state: string, name?: string, wallMs?: number };
    assert.equal(reading.state, "incident");
    assert.equal(reading.name, "Incident with Actions");
    assert.equal(typeof reading.wallMs, "number");
    assert.ok((reading.wallMs ?? Infinity) < 1000, `the call took ${reading.wallMs} ms`);
  } finally {
    stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a reading left by an EARLIER tick is never this tick's: the file is matched to the tick that asked for it", async () => {
  const { url, stop } = await serve(summary("operational", { incidents: [] }));
  const dir = mkdtempSync(join(tmpdir(), "github-incident-"));
  const file = join(dir, "status.json");
  try {
    const first = startGithubStatus({ url, timeoutMs: 3000, file });
    assert.equal((first.settle() as { state: string }).state, "clear");
    const stale = readFileSync(file, "utf8");
    stop();
    const second = startGithubStatus({ url: "http://127.0.0.1:1/unreachable", timeoutMs: 300, file });
    assert.equal((second.settle() as { state: string }).state, "unknown", `an old answer (${stale.slice(0, 30)}...) must not stand in for a refused one`);
  } finally {
    stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("main starts the fetch before its first read, and settles it only after the orders are decided", () => {
  const source = readFileSync(new URL("./work-gate.mjs", import.meta.url), "utf8");
  const main = source.slice(source.indexOf("\nfunction main() {"));
  const started = main.indexOf("startGithubStatus(");
  assert.ok(started > 0, "main must start the fetch");
  assert.ok(started < main.indexOf("diskHeadroomTick()"), "before the first read of the tick");
  assert.ok(started < main.indexOf("readPrs()"));
  assert.ok(main.indexOf("holdForIncidentNow(") > main.indexOf("decideAndTap("), "and the hold reads what was decided");
});
