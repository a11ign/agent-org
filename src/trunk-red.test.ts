// no-token: gh -- `readFixRow` answers from an injected `github` seam, `trunkRedOrders` takes a fixture reading and `readTrunkRed` an injected `run`; no real `gh` is spawned (one test puts a shim named `gh` first on a child's PATH)
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFixRow } from "./messaging/sources/readers.ts";
import { NO_WORKFLOW_RECHECK_EVERY_MS, PRIMARY_TRUNK, readTrunkRed, trunkOfCodeRepository, trunkRedOrders } from "./trunk-red.ts";

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

/**
 * agent-org#693: A DECLARED CODE REPOSITORY WITH NO `ci.yml` (a11ign/.github) IS "NO TRUNK WORKFLOW HERE", NOT A REFUSED READ, AND IS SAID ONCE A DAY.
 *
 * The error is the shape `gh` throws for the call that measured it on 2026-10-10 (`gh api --method GET repos/a11ign/.github/actions/workflows/ci.yml/runs ...`
 * answers `gh: Not Found (HTTP 404)` on stderr, exit 1). Each case has its negative control beside it: the same read answering 403, 5xx or a timeout is still refused.
 */
const DOT_GITHUB = trunkOfCodeRepository("dot-github", "a11ign/.github");
const NOT_FOUND = () => Object.assign(new Error("Command failed: gh api --method GET repos/a11ign/.github/actions/workflows/ci.yml/runs\ngh: Not Found (HTTP 404)\n"),
  { status: 1, stderr: "gh: Not Found (HTTP 404)\n" });
const refusing = (error: Error) => {
  const calls: string[][] = [];
  return { calls, run: (args: string[]) => { calls.push(args); throw error; } };
};
const NOW = Date.parse("2026-10-10T16:00:00Z");
const told = () => {
  const lines: string[] = [];
  return { lines, report: (line: string) => { lines.push(line); } };
};
const NO_WORKFLOW_LINE = "a11ign/.github: no ci.yml on main, so its trunk is not read";
/** One directory under the private TMPDIR, removed once the file is done; each call gives a state directory of its own. */
const SCRATCH = mkdtempSync(join(tmpdir(), "trunk-red-693-"));
after(() => rmSync(SCRATCH, { recursive: true, force: true }));
let scratchCount = 0;
const freshState = () => {
  const dir = join(SCRATCH, String(scratchCount++));
  mkdirSync(dir);
  return dir;
};

test("no trunk workflow: a 404 on the runs read of a repository that never had runs is null and said once, and any other refusal is still undefined", () => {
  const said = told();
  const gh = refusing(NOT_FOUND());
  assert.equal(readTrunkRed(gh.run, DOT_GITHUB, { stateDir: freshState(), now: NOW, report: said.report }), null, "nothing to be red: null, not the `undefined` of a refused read");
  assert.deepEqual(said.lines, [NO_WORKFLOW_LINE]);
  assert.equal(gh.calls.length, 1, "the second event filter would answer the same 404, so it is not asked");
  // NEGATIVE CONTROLS (done-when b): a 403, a 5xx and a timeout are NOT "no workflow", and a fault that says nothing of a 404 is not one either.
  const refusals: [string, Error][] = [
    ["403", Object.assign(new Error("gh: Forbidden (HTTP 403)"), { stderr: "gh: Forbidden (HTTP 403)\n" })],
    ["502", Object.assign(new Error("gh: Bad Gateway (HTTP 502)"), { stderr: "gh: Bad Gateway (HTTP 502)\n" })],
    ["timeout", Object.assign(new Error("spawnSync gh ETIMEDOUT"), { code: "ETIMEDOUT" })],
    ["a bare message", new Error("HTTP 403")],
  ];
  for (const [name, error] of refusals) {
    const quiet = told();
    assert.equal(readTrunkRed(refusing(error).run, DOT_GITHUB, { stateDir: freshState(), now: NOW, report: quiet.report }), undefined, `${name}: refused, not "no workflow"`);
    assert.deepEqual(quiet.lines, [], `${name}: this file says nothing of it either, as before`);
  }
});

test("no trunk workflow: the second read inside a day makes no call and prints no line, and a read a day later asks and says it again", () => {
  const stateDir = freshState();
  const first = told();
  const gh = refusing(NOT_FOUND());
  assert.equal(readTrunkRed(gh.run, DOT_GITHUB, { stateDir, now: NOW, report: first.report }), null);
  assert.deepEqual([gh.calls.length, first.lines], [1, [NO_WORKFLOW_LINE]], "POSITIVE CONTROL: the first read paid its call and said its line");
  const again = told();
  for (const later of [2 * 60_000, 60 * 60_000, NO_WORKFLOW_RECHECK_EVERY_MS - 1]) {
    assert.equal(readTrunkRed(gh.run, DOT_GITHUB, { stateDir, now: NOW + later, report: again.report }), null, "still null");
  }
  assert.deepEqual([gh.calls.length, again.lines], [1, []], "no call and no line inside the day");
  // NEGATIVE CONTROL: the marker expires, and the line is then once per day, not once ever.
  const nextDay = told();
  assert.equal(readTrunkRed(gh.run, DOT_GITHUB, { stateDir, now: NOW + NO_WORKFLOW_RECHECK_EVERY_MS, report: nextDay.report }), null);
  assert.deepEqual([gh.calls.length, nextDay.lines], [2, [NO_WORKFLOW_LINE]]);
});

test("no trunk workflow: a repository the marker knows had the workflow, now 404, is unread and says so every tick", () => {
  const stateDir = freshState();
  const push = [runOf(80, "push", "success", "2026-10-10T09:00:00Z")];
  const had = told();
  assert.equal(readTrunkRed(fakeGh({ push, jobs: { 80: jobsOf("success") } }).run, DOT_GITHUB, { stateDir, now: NOW, report: had.report }), null, "POSITIVE CONTROL: it answered 200 and was green");
  assert.deepEqual(had.lines, []);
  const gh = refusing(NOT_FOUND());
  for (const minutes of [2, 4, 6]) {
    const said = told();
    assert.equal(readTrunkRed(gh.run, DOT_GITHUB, { stateDir, now: NOW + minutes * 60_000, report: said.report }), undefined,
      "unread, not green: the failure ledger must not end a standing red on a workflow that went missing");
    assert.deepEqual(said.lines, ["a11ign/.github: ci.yml on main answered 404 though it had runs before, so its trunk is not read"], `tick +${minutes}m says it again`);
  }
  assert.equal(gh.calls.length, 3, "and asks again every tick: it is not the quiet case");
  // NEGATIVE CONTROL: a repository with no marker at all, read at the same instants, is the quiet once-a-day case.
  const never = told();
  const neverAsked = refusing(NOT_FOUND());
  for (const minutes of [2, 4, 6]) readTrunkRed(neverAsked.run, DOT_GITHUB, { stateDir: freshState(), now: NOW + minutes * 60_000, report: never.report });
  assert.equal(neverAsked.calls.length, 3, "three states, three first reads");
  const quiet = told();
  const sharedDir = freshState();
  for (const minutes of [2, 4, 6]) readTrunkRed(neverAsked.run, DOT_GITHUB, { stateDir: sharedDir, now: NOW + minutes * 60_000, report: quiet.report });
  assert.deepEqual([neverAsked.calls.length, quiet.lines], [4, [NO_WORKFLOW_LINE]], "one state directory: one call and one line for three ticks");
});

test("no trunk workflow: a workflow that appears after a 404 is read again, and a 404 after that is the loud case", () => {
  const stateDir = freshState();
  assert.equal(readTrunkRed(refusing(NOT_FOUND()).run, DOT_GITHUB, { stateDir, now: NOW, report: told().report }), null);
  const push = [runOf(81, "push", "failure", "2026-10-10T09:00:00Z")];
  const red = readTrunkRed(fakeGh({ push, jobs: { 81: jobsOf("success", "failure", "failure") } }).run, DOT_GITHUB, { stateDir, now: NOW + NO_WORKFLOW_RECHECK_EVERY_MS, report: told().report });
  assert.equal(red?.runId, 81, "a day later the workflow exists, and its red is read");
  const said = told();
  assert.equal(readTrunkRed(refusing(NOT_FOUND()).run, DOT_GITHUB, { stateDir, now: NOW + NO_WORKFLOW_RECHECK_EVERY_MS + 120_000, report: said.report }), undefined);
  assert.match(said.lines[0], /answered 404 though it had runs before/);
});

test("no trunk workflow: a state directory that cannot be written is said and never thrown into the tick", () => {
  const notADirectory = join(freshState(), "a-file");
  writeFileSync(notADirectory, "");
  const said = told();
  assert.equal(readTrunkRed(refusing(NOT_FOUND()).run, DOT_GITHUB, { stateDir: notADirectory, now: NOW, report: said.report }), null);
  assert.equal(said.lines.length, 2);
  assert.match(said.lines[0], /was not written/);
  assert.equal(said.lines[1], NO_WORKFLOW_LINE);
});

test("no trunk workflow: `gh`'s own stderr line is captured in the call, not filtered after it, and a refusal that is not a 404 is still heard", () => {
  const run = (answer: string) => {
    const binDir = freshState();
    writeFileSync(join(binDir, "gh"), `#!/bin/sh\necho '${answer}' >&2\nexit 1\n`);
    chmodSync(join(binDir, "gh"), 0o755);
    const script = `const m = await import(${JSON.stringify(new URL("./trunk-red.ts", import.meta.url).href)});
      const said = [];
      const answer = m.readTrunkRed(undefined, m.trunkOfCodeRepository("dot-github", "a11ign/.github"), { stateDir: process.argv[1], report: (l) => said.push(l) });
      process.stdout.write(JSON.stringify({ answer: answer === undefined ? "undefined" : answer, said }));`;
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", script, freshState()],
      { encoding: "utf8", env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` }, cwd: fileURLToPath(new URL("..", import.meta.url)) });
    assert.equal(child.status, 0, child.stderr);
    return { stderr: child.stderr, ...JSON.parse(child.stdout) };
  };
  const notFound = run("gh: Not Found (HTTP 404)");
  assert.deepEqual([notFound.answer, notFound.said], [null, [NO_WORKFLOW_LINE]]);
  assert.equal(notFound.stderr, "", "nothing of `gh`'s own line reaches the tick's stderr");
  // NEGATIVE CONTROL: the same shim answering 403 is refused, and `gh`'s line is still the tick's to hear.
  const forbidden = run("gh: Forbidden (HTTP 403)");
  assert.deepEqual([forbidden.answer, forbidden.said], ["undefined", []]);
  assert.match(forbidden.stderr, /gh: Forbidden \(HTTP 403\)/);
});
