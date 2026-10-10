// no-token: gh -- `readFixRow` answers from an injected `github` seam, `trunkRedOrders` takes a fixture reading and `readTrunkRed` an injected `run`; no `gh` is spawned
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFixRow } from "./messaging/sources/readers.ts";
import { PRIMARY_TRUNK, readTrunkRed, trunkOfCodeRepository, trunkRedOrders } from "./trunk-red.ts";

/**
 * #3449: THE TRUNK-RED ORDER NAMES WHAT `readFixRow` LOOKS FOR.
 *
 * The order tells the fixer to open a pull request (or, for another repository, to file a row), and the chairman's `Doing` line reads that fix from an open
 * item labelled `incident` whose body carries `Incident: incident:trunk-red`. The two are written in different files, so the last test follows the order's own
 * sentence through the reader: an order that named a line the reader does not match would pass every other assertion here and still send `nobody has picked this up`.
 */

const SHA = "a1b2c3d4e5f6789012345678901234567890abcd";
const red = (more: Record<string, unknown> = {}) => ({
  runId: 1, url: "https://github.com/a11ign/a11ign/actions/runs/1", sha: SHA, failedJobs: ["gate"], failingTests: ["a test"], parentFailingTests: [], recheck: null,
  originPr: { number: 56, title: "t", session: "worker-1" }, repo: "a11ign/a11ign", ...more,
}) as unknown as Parameters<typeof trunkRedOrders>[0];

const OWN = () => trunkRedOrders(red())[0].prompt;
const ROUTED = () => trunkRedOrders(red({ repo: "a11ign/agent-org", repoKey: "agent-org" }))[0].prompt;

test("both prompts the order can carry (own path and routed path) name the label and the line", () => {
  for (const [path, prompt] of [["own", OWN()], ["routed", ROUTED()]]) {
    assert.match(prompt, /label it `incident`/, `${path}: the label`);
    assert.match(prompt, /`Incident: incident:trunk-red`/, `${path}: the body line, with the key exactly as readFixRow's matcher takes it`);
  }
  assert.notEqual(OWN(), ROUTED(), "positive control: the two paths ARE different prompts, so each assertion above read its own");
});

test("the line the order names is the line readFixRow matches: a PR opened as told is found, and one without it is not", async () => {
  const [, named] = /`(Incident: incident:trunk-red)`/.exec(OWN()) ?? [];
  assert.ok(named, "the order quotes a line");
  const listing = (body: string) => ({ api: (path: string) => (path.includes("issues?labels=incident&state=open") ? [{ number: 3600, body: `## Fix\n\n${body}\n`, comments: 0,
    pull_request: {}, labels: [{ name: "incident" }, { name: "session:worker-1" }] }] : []) });
  const found = await readFixRow({ github: listing(named!) as never, repo: "a11ign/a11ign", key: "incident:trunk-red" });
  assert.deepEqual(found, { number: 3600, holder: "worker-1" });
  assert.equal(await readFixRow({ github: listing("no marker") as never, repo: "a11ign/a11ign", key: "incident:trunk-red" }), null, "negative control: the same PR without the line");
});

/**
 * agent-org#539: A RED `cross-repo` LEG OR A RED NIGHTLY OF A DECLARED CODE REPOSITORY IS READ.
 *
 * The bodies are the shapes GitHub sent for lab's `ci.yml` on 2026-10-10 (measured with `gh api repos/a11ign/lab/actions/runs/<id>/jobs`): a `schedule` run
 * 38045596539 and a `push` run 38044280935 both read `success` while `checks (cross-repo)` read `failure` and `gate` read `success`.
 */
const LAB = trunkOfCodeRepository("lab", "a11ign/lab");
const LEG = "checks (cross-repo)";
const job = (name: string, conclusion: string) => ({ id: 1, name, status: "completed", conclusion });
/** The jobs of lab's ci.yml on a push or a schedule: `changeset` is skipped there, and `gate` reads what `checks` says. */
const jobsOf = (leg: string, gate = "success", own = "success") => [job("checks (own)", own), job(LEG, leg), job("changeset", "skipped"), job("gate", gate)];
const runOf = (id: number, event: string, conclusion: string, createdAt: string) =>
  ({ id, head_sha: `${id}`.padEnd(40, "0"), status: "completed", conclusion, html_url: `https://github.com/a11ign/lab/actions/runs/${id}`, created_at: createdAt, event });

/** `push` and `schedule` answer the two runs reads by their `event=`; a read with no `event=` (the primary's) is answered from `push`. */
function fakeGh(state: { push: unknown[], schedule?: unknown[], jobs: Record<number, unknown[]>, refuse?: string }) {
  const calls: string[][] = [];
  const run = (args: string[]) => {
    calls.push(args);
    const text = args.join(" ");
    if (state.refuse !== undefined && text.includes(state.refuse)) throw new Error("HTTP 403");
    if (text.includes("/actions/workflows/")) return JSON.stringify({ workflow_runs: text.includes("event=schedule") ? state.schedule ?? [] : state.push });
    const jobs = /\/actions\/runs\/(\d+)\/jobs/.exec(text);
    if (jobs) return JSON.stringify({ jobs: state.jobs[Number(jobs[1])] ?? [] });
    if (args[0] === "run" && args[1] === "view") return "";
    if (text.includes("/pulls")) return JSON.stringify([{ number: 7, title: "a lab merge", labels: [{ name: "session:worker-3" }] }]);
    throw new Error(`unexpected gh call: ${text}`);
  };
  return { run, calls };
}

test("a red cross-repo leg with a green gate is red main, and the order names the leg and says gate read green", () => {
  const push = [runOf(10, "push", "success", "2026-10-10T10:15:38Z")];
  const red = readTrunkRed(fakeGh({ push, jobs: { 10: jobsOf("failure") } }).run, LAB);
  assert.ok(red, "the leg's own conclusion is where the red is");
  assert.deepEqual([red.failedJobs, red.leg, red.runId, red.repoKey], [[LEG], LEG, 10, "lab"]);
  const [order] = trunkRedOrders(red);
  assert.match(order.prompt, /`checks \(cross-repo\)` LEG, NOT `own`, AND `gate` READ GREEN/);
  assert.match(order.prompt, /MAIN IS RED IN `a11ign\/lab`/);
  assert.doesNotMatch(order.prompt, /SCHEDULED \(NIGHTLY\)/, "a push is not the nightly");
  assert.equal(order.session, "worker-3", "a push's red goes to the merging session, as it always did, with the router as its way out");
  assert.equal(order.fallback, "product-manager");
  // NEGATIVE CONTROLS: the same run with the leg green, and a repository whose gate alone is read, are not red.
  assert.equal(readTrunkRed(fakeGh({ push, jobs: { 10: jobsOf("success") } }).run, LAB), null, "the leg green: nothing to say");
  assert.equal(readTrunkRed(fakeGh({ push, jobs: { 10: [job("checks (own)", "success"), job("gate", "success")] } }).run, LAB), null, "no leg at all: gate alone is green");
});

test("a leg that is red beside a red gate is read as the red run it always was, with no `leg` fact", () => {
  const push = [runOf(11, "push", "failure", "2026-10-10T10:15:38Z")];
  const red = readTrunkRed(fakeGh({ push, jobs: { 11: jobsOf("failure", "failure", "failure") } }).run, LAB);
  assert.ok(red);
  assert.deepEqual(red.failedJobs, ["checks (own)", LEG, "gate"], "the run page already names every failed job");
  assert.equal("leg" in red, false);
  assert.doesNotMatch(trunkRedOrders(red)[0].prompt, /LEG, NOT `own`/);
});

test("a red nightly is red main and goes to the router, not to the merger of the newest commit; a push-only read never saw it", () => {
  const push = [runOf(20, "push", "success", "2026-10-10T04:30:38Z")];
  const nightly = [runOf(21, "schedule", "success", "2026-10-10T10:38:20Z")];
  const gh = fakeGh({ push, schedule: nightly, jobs: { 20: jobsOf("success"), 21: jobsOf("failure") } });
  const red = readTrunkRed(gh.run, LAB);
  assert.ok(red);
  assert.deepEqual([red.runId, red.event, red.leg], [21, "schedule", LEG]);
  const [order] = trunkRedOrders(red);
  assert.deepEqual([order.session, order.fallback], ["product-manager", undefined]);
  assert.match(order.prompt, /SCHEDULED \(NIGHTLY\) RUN, NOT A MERGE/);
  assert.match(order.prompt, /The newest merge is #7/);
  assert.ok(gh.calls.some((c) => c.includes("event=schedule")) && gh.calls.some((c) => c.includes("event=push")), "both events were asked for");
  // NEGATIVE CONTROL: a nightly whose own gate failed is red too, and the same fixture read for `push` alone is green.
  const failed = fakeGh({ push, schedule: [runOf(22, "schedule", "failure", "2026-10-10T10:38:20Z")], jobs: { 20: jobsOf("success"), 22: jobsOf("success", "failure", "failure") } });
  assert.equal(readTrunkRed(failed.run, LAB)?.event, "schedule");
  assert.equal(readTrunkRed(gh.run, { ...LAB, eventFilters: ["event=push"] }), null, "the schedule read is what finds it");
});

test("the newest run of either event decides: a green nightly clears a red push, and a green push clears a red nightly", () => {
  const redPush = [runOf(30, "push", "failure", "2026-10-10T02:00:00Z")];
  const jobs = { 30: jobsOf("success", "failure", "failure"), 31: jobsOf("success"), 32: jobsOf("failure") };
  assert.ok(readTrunkRed(fakeGh({ push: redPush, schedule: [], jobs }).run, LAB), "POSITIVE CONTROL: with no nightly after it the push is red");
  assert.equal(readTrunkRed(fakeGh({ push: redPush, schedule: [runOf(31, "schedule", "success", "2026-10-10T04:17:00Z")], jobs }).run, LAB), null, "a green nightly after it clears it");
  const redNightly = [runOf(32, "schedule", "success", "2026-10-10T04:17:00Z")];
  assert.ok(readTrunkRed(fakeGh({ push: [], schedule: redNightly, jobs }).run, LAB), "POSITIVE CONTROL: a red leg in the nightly with no push after it");
  assert.equal(readTrunkRed(fakeGh({ push: [runOf(31, "push", "success", "2026-10-10T09:00:00Z")], schedule: redNightly, jobs }).run, LAB), null, "a green push after it clears it");
});

test("a refused runs read refuses the read: a nightly is not reported red without the push that came after it", () => {
  const gh = fakeGh({ push: [runOf(41, "push", "success", "2026-10-10T09:00:00Z")], schedule: [runOf(40, "schedule", "success", "2026-10-10T04:17:00Z")],
    jobs: { 40: jobsOf("failure"), 41: jobsOf("success") }, refuse: "event=push" });
  assert.equal(readTrunkRed(gh.run, LAB), undefined, "NOT READ, which is not the `null` of a green (agent-org#674)");
  assert.ok(readTrunkRed(fakeGh({ push: [], schedule: [runOf(40, "schedule", "success", "2026-10-10T04:17:00Z")], jobs: { 40: jobsOf("failure") } }).run, LAB),
    "POSITIVE CONTROL: unrefused, and with no push after it, the same nightly is red");
});

/**
 * agent-org#674: `null` IS A GREEN AND `undefined` IS NOT READ. The failure ledger ends a standing red on a green and must not on a refused read, so the reading says which.
 * Each case has its positive control: the same shape, read, says what it always said.
 */
test("a read that could not be made is undefined, and only a read that found main not red is null", () => {
  const push = [runOf(70, "push", "success", "2026-10-10T10:15:38Z")];
  const green = fakeGh({ push, jobs: { 70: jobsOf("success") } });
  assert.equal(readTrunkRed(green.run, LAB), null, "POSITIVE CONTROL: read, and green");
  assert.equal(readTrunkRed(fakeGh({ push, jobs: { 70: jobsOf("success") }, refuse: "/actions/workflows/" }).run, LAB), undefined, "the runs read refused");
  assert.equal(readTrunkRed(fakeGh({ push: [], jobs: {} }).run, LAB), undefined, "no completed verdict run says nothing about main");
  const inFlight = [{ ...runOf(71, "push", "failure", "2026-10-10T10:15:38Z"), status: "in_progress", conclusion: null }];
  assert.equal(readTrunkRed(fakeGh({ push: inFlight, jobs: {} }).run, LAB), undefined, "a run still in flight is not a verdict");
});

test("a green run whose jobs could not be read is not read as green: the red leg is visible only there", () => {
  const push = [runOf(72, "push", "success", "2026-10-10T10:15:38Z")];
  assert.equal(readTrunkRed(fakeGh({ push, jobs: { 72: jobsOf("failure") } }).run, LAB)?.leg, LEG, "POSITIVE CONTROL: the jobs read, the leg is red");
  assert.equal(readTrunkRed(fakeGh({ push, jobs: { 72: jobsOf("failure") }, refuse: "/jobs" }).run, LAB), undefined, "the jobs read refused: unknown, not green");
  const redRun = [runOf(73, "push", "failure", "2026-10-10T10:15:38Z")];
  const red = readTrunkRed(fakeGh({ push: redRun, jobs: { 73: jobsOf("failure") }, refuse: "/jobs" }).run, LAB);
  assert.deepEqual([red?.runId, red?.failedJobs], [73, []], "a red run whose jobs were not read is still red, with no job named");
});

test("the primary is read exactly as before: one call, no event, no jobs read for a green run, and a red carries no new fact", () => {
  const green = fakeGh({ push: [runOf(50, "push", "success", "2026-10-10T09:00:00Z")], jobs: { 50: jobsOf("failure") } });
  assert.equal(readTrunkRed(green.run), null, "a red `cross-repo` job is not read for the primary, whose runs name no such leg");
  assert.equal(readTrunkRed(green.run, PRIMARY_TRUNK), null, "omitted and explicit are one source");
  assert.deepEqual(green.calls[0], ["api", "--method", "GET", `repos/${PRIMARY_TRUNK.repo}/actions/workflows/trunk.yml/runs`, "-f", "branch=main", "-f", "per_page=10"]);
  assert.equal(green.calls.length, 2, "one call each for the two reads above, and nothing else");
  const red = readTrunkRed(fakeGh({ push: [runOf(51, "push", "failure", "2026-10-10T09:00:00Z")], jobs: { 51: [job("trunkBuildTest / run", "failure")] } }).run);
  assert.ok(red);
  assert.deepEqual(Object.keys(red), ["runId", "url", "sha", "failedJobs", "failingTests", "recheck", "parentFailingTests", "originPr"]);
});

test("a repository whose ci.yml has no cross-repo job is read as before, and a job that only contains the words is not the leg", () => {
  const push = [runOf(60, "push", "success", "2026-10-10T09:00:00Z")];
  const only = [job("gate", "success")];
  assert.equal(readTrunkRed(fakeGh({ push, jobs: { 60: only } }).run, LAB), null, "green gate, no leg");
  for (const name of ["cross-repo-copies", "not-cross-repo-at-all", "cross-repository"]) {
    assert.equal(readTrunkRed(fakeGh({ push, jobs: { 60: [...only, job(name, "failure")] } }).run, LAB), null, `${name} is not the leg`);
  }
  // The marker finds the leg under every name GitHub gives it (a reusable-workflow call prefixes `<caller> / `), or the test above is half tested.
  for (const name of ["cross-repo", LEG, "ci / checks (cross-repo)", "ci / cross-repo"]) {
    assert.equal(readTrunkRed(fakeGh({ push, jobs: { 60: [...only, job(name, "failure")] } }).run, LAB)?.leg, name, `${name} is the leg`);
  }
  const red = readTrunkRed(fakeGh({ push: [runOf(61, "push", "failure", "2026-10-10T09:00:00Z")], jobs: { 61: [job("gate", "failure")] } }).run, LAB);
  assert.ok(red);
  assert.deepEqual(Object.keys(red), ["runId", "url", "sha", "failedJobs", "failingTests", "recheck", "parentFailingTests", "originPr", "repo", "repoKey"]);
});
