// #4632: a red check's failure class and route. A fake `fetch`, a fake `readKey`, a fake diagnostic and a state fixture only: no network, no real key, no corpus.
// no-token: gh -- nothing here calls `gh`; every dependency is injected (the log read's `gh` is a stub that refuses as the real one does)
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CI_FAILURE_CLASSES, MAX_ERROR_LINES, classLine, classNote, classifyCiFailure, fallbackClass, readCiFailure, routeFor, trimErrorLines,
  holdSharedFailures, notedAs, readSignature, refreshFixed, sharedFailureGroups, sharedFailureTick, type CiFailure, type FailureSignature, type RedCheck, type CiFailureClass, type RedPr, type Run,
} from "./ci-failure-class.ts";
import { MAX_STATE_BYTES, type DecisionDeps } from "./decision-provider.ts";
import { parseHostConfig } from "./host-config.ts";
import { connectionOf, readsRowsByLabel } from "./packaging/rows-by-label-fixtures.ts";
import { freshState } from "./triage-provider.ts";

const HOST = JSON.stringify({
  schema: 1, home: "/h", binDir: "/h/bin", primary: "a", projects: [{ id: "a", checkout: "/h/a" }],
  gh: { workers: "/h/w", leads: "/h/l", leadsHeader: [], leadsWorkspaces: [] },
});
const withTriage = (triage?: unknown) => parseHostConfig(triage === undefined ? HOST : JSON.stringify({ ...JSON.parse(HOST), triage }));
const JEV = { provider: "jev", keyPath: "/fake/key", minConfidence: 0.9 };

const failure = (over: Partial<CiFailure> = {}): CiFailure => ({
  errorLines: ["AssertionError [ERR_ASSERTION]: expected 3, got 4", "    at src/thing.test.ts:12"],
  redOnMain: false, redOnOtherPrs: false, readsOutsideRepository: false, rateLimitOrRunnerLost: false, rerunAlready: false,
  ...over,
});

type Reply = { status?: number; body?: unknown; throws?: boolean };
function fakeFetch(r: Reply) {
  const calls: { body: any }[] = [];
  const fn = (async (_url: string, init: any) => {
    calls.push({ body: JSON.parse(init.body) });
    if (r.throws) throw new Error("connection refused");
    return { ok: (r.status ?? 200) < 400, status: r.status ?? 200, json: async () => r.body };
  }) as unknown as typeof fetch;
  return { fn, calls };
}
const answer = (choice: string, confidence = 0.95) => ({ answers: { class: { type: "choice", choice, probabilities: {}, confidence } } });

function rig(opts: { triage?: unknown; on?: boolean; reply?: Reply; readKey?: (path: string) => string } = {}) {
  const net = fakeFetch(opts.reply ?? { body: answer("flaky") });
  const lines: string[] = [];
  const deps: DecisionDeps = {
    host: withTriage("triage" in opts ? opts.triage : JEV), fetch: net.fn, state: freshState(), timeoutMs: 50, diagnostic: (line) => lines.push(line),
    readKey: opts.readKey ?? (() => "FAKE-KEY"), switches: { "ci-failure-class": opts.on ?? true },
  };
  return { deps, net, lines };
}

test("the rule with no provider: red on main is another repository, a rate limit is infrastructure, everything else is the PR's own", () => {
  assert.equal(fallbackClass(failure()), "own-defect");
  assert.equal(fallbackClass(failure({ redOnMain: true })), "another-repository-changed");
  assert.equal(fallbackClass(failure({ rateLimitOrRunnerLost: true })), "infrastructure");
  // negative controls: a fact that is NOT the rule's trigger changes nothing
  assert.equal(fallbackClass(failure({ redOnOtherPrs: true, readsOutsideRepository: true, rerunAlready: true })), "own-defect");
  // a runner lost on main too is still not a repository that changed
  assert.equal(fallbackClass(failure({ redOnMain: true, rateLimitOrRunnerLost: true })), "infrastructure");
});

test("each class has its own route, and a flaky failure is rerun once and never a second time", () => {
  assert.deepEqual(CI_FAILURE_CLASSES.map((c) => routeFor(c, false)), ["owner", "rerun-once", "cross-repo-incident", "rerun-after-reset", "push-or-update-branch"]);
  assert.equal(routeFor("flaky", true), "owner");
  // the already-rerun fact moves only the flaky class
  for (const c of CI_FAILURE_CLASSES.filter((k) => k !== "flaky")) assert.equal(routeFor(c, true), routeFor(c, false));
});

test("provider absent: no triage block, or provider none, asks nobody and takes the rule", async () => {
  for (const triage of [undefined, { provider: "none" }]) {
    const { deps, net, lines } = rig({ triage });
    const out = await classifyCiFailure(failure({ redOnMain: true }), deps);
    assert.deepEqual([out.klass, out.route, out.via, out.fellBack], ["another-repository-changed", "cross-repo-incident", "none", true]);
    assert.equal(net.calls.length, 0);
    assert.deepEqual(lines, []);
  }
});

test("key missing: the rule, no request, and one diagnostic that does not name the path", async () => {
  const { deps, net, lines } = rig({ readKey: () => { throw new Error("ENOENT /fake/key"); } });
  const out = await classifyCiFailure(failure({ rateLimitOrRunnerLost: true }), deps);
  assert.deepEqual([out.klass, out.via], ["infrastructure", "none"]);
  assert.equal(net.calls.length, 0);
  assert.equal(lines.length, 1);
  assert.doesNotMatch(lines[0], /\/fake\/key/);
});

test("use switched off: the rule, no request; the same inputs switched on ask the provider (the positive control)", async () => {
  const off = rig({ on: false });
  const offOut = await classifyCiFailure(failure(), off.deps);
  assert.deepEqual([offOut.klass, offOut.via, offOut.reason], ["own-defect", "none", "the use is switched off"]);
  assert.equal(off.net.calls.length, 0);
  const on = rig({ on: true });
  await classifyCiFailure(failure(), on.deps);
  assert.equal(on.net.calls.length, 1);
});

test("provider on: its class and route win, for each of the five classes (the fifth is offered only with its fact)", async () => {
  for (const klass of CI_FAILURE_CLASSES) {
    const { deps, net } = rig({ reply: { body: answer(klass) } });
    const out = await classifyCiFailure(failure({ staleMergeRef: true }), deps);
    assert.deepEqual([out.klass, out.route, out.via, out.fellBack, out.confidence], [klass, routeFor(klass, false), "jev", false, 0.95]);
    assert.equal(net.calls.length, 1);
  }
});

test("provider on: the request carries the trimmed state and the four criteria (five with the stale-merge-ref fact), and never an agent-written body", async () => {
  const { deps, net } = rig();
  await classifyCiFailure(failure({ redOnOtherPrs: true }), deps);
  const sent = net.calls[0].body;
  assert.deepEqual(Object.keys(sent.state).sort(), ["errorLines", "readsOutsideRepository", "rateLimitOrRunnerLost", "redOnMain", "redOnOtherPrs"].sort());
  assert.equal(sent.state.redOnOtherPrs, true);
  assert.deepEqual(Object.keys(sent.questions.class.criteria), CI_FAILURE_CLASSES.filter((klass) => klass !== "stale-merge-ref"));
});

test("a flaky answer on a run already rerun routes to the owner and keeps the class", async () => {
  const { deps } = rig({ reply: { body: answer("flaky") } });
  const out = await classifyCiFailure(failure({ rerunAlready: true }), deps);
  assert.deepEqual([out.klass, out.route], ["flaky", "owner"]);
});

test("every way the provider can fail takes the rule: a refusal, a timeout, a thrown fetch, a malformed answer, a class that is none, a confidence under the floor", async () => {
  const cases: Record<string, Reply> = {
    refusal: { status: 403, body: {} },
    thrown: { throws: true },
    malformed: { body: { answers: { class: "flaky" } } },
    "not a class": { body: answer("a-fifth-class") },
    "under the floor": { body: answer("flaky", 0.89) },
  };
  for (const [name, reply] of Object.entries(cases)) {
    const { deps } = rig({ reply });
    const out = await classifyCiFailure(failure({ redOnMain: true }), deps);
    assert.deepEqual([out.klass, out.fellBack], ["another-repository-changed", true], name);
  }
  // the floor is the boundary: 0.9 is taken, 0.89 above is not
  const atFloor = await classifyCiFailure(failure({ redOnMain: true }), rig({ reply: { body: answer("flaky", 0.9) } }).deps);
  assert.deepEqual([atFloor.klass, atFloor.fellBack], ["flaky", false]);
});

test("trimming: at most 40 non-blank lines, colour codes stripped, each line cut, and the state fits the seam's limit", () => {
  const long = Array.from({ length: 100 }, (_, i) => `\u001b[31mline ${i}\u001b[0m ${"x".repeat(500)}`);
  const kept = trimErrorLines(["", "   ", ...long]);
  assert.ok(kept.length > 0 && kept.length <= MAX_ERROR_LINES);
  assert.ok(kept.every((l) => l.length <= 160 && !l.includes("\u001b")));
  assert.ok(kept[0].startsWith("line 0"));
  assert.ok(Buffer.byteLength(JSON.stringify({ errorLines: kept })) < MAX_STATE_BYTES);
  // the line cap binds on its own when the lines are short enough for the byte budget not to
  assert.equal(trimErrorLines(Array.from({ length: 100 }, (_, i) => `e${i}`)).length, MAX_ERROR_LINES);
  // negative control: a short, clean input is kept whole and in order
  assert.deepEqual(trimErrorLines(["a", "b"]), ["a", "b"]);
});

test("a huge error is trimmed to fit, so the provider is still asked rather than falling back on size", async () => {
  const { deps, net } = rig();
  const out = await classifyCiFailure(failure({ errorLines: Array.from({ length: 500 }, () => "y".repeat(400)) }), deps);
  assert.equal(net.calls.length, 1);
  assert.equal(out.via, "jev");
});

test("the line the order and the log carry names the class, the route and who chose", async () => {
  const rule = await classifyCiFailure(failure({ rateLimitOrRunnerLost: true }), rig({ on: false }).deps);
  assert.match(classLine(rule), /^CI failure class: infrastructure -> rerun-after-reset \(rule: the use is switched off\)$/);
  const jev = await classifyCiFailure(failure(), rig({ reply: { body: answer("flaky") } }).deps);
  assert.equal(classLine(jev), "CI failure class: flaky -> rerun-once (provider)");
});

test("the classes are the four the first row named and the one #1524 added", () => {
  const names: CiFailureClass[] = ["own-defect", "flaky", "another-repository-changed", "infrastructure", "stale-merge-ref"];
  assert.deepEqual([...CI_FAILURE_CLASSES], names);
});

// ---- the job log (#767) -------------------------------------------------------------------------------------

const SHA = "abcdef12".padEnd(40, "0");
const NOW = Date.parse("2026-10-10T12:00:00Z");
const ESC = "\u001b";
const ESCAPE_REFUSAL = "the response contains terminal escape sequences; pass --allow-escape-sequences to output it anyway";

/**
 * A `gh` that answers the reads `readCiFailure` makes, and refuses a job log as the real `gh` 2.100.0 does: exit 1 on a body holding an escape byte unless `--allow-escape-sequences`
 * is among the arguments. The refusal is by CONTENT, so a log with no escape bytes is read with or without the flag, exactly as the real one.
 */
function logGh(log: string) {
  const asked: string[][] = [];
  const read = (args: string[]): string => {
    asked.push(args);
    const path = args[1];
    if (path.endsWith("/pulls/77")) return JSON.stringify({ head: { sha: SHA, ref: "agent/x-77" } });
    if (path.includes(`/commits/${SHA}/check-runs`)) {
      return JSON.stringify({ check_runs: [{ name: "ts", conclusion: "failure", details_url: "https://github.com/o/r/actions/runs/555/job/666" }] });
    }
    if (path.endsWith("/actions/runs/555")) return JSON.stringify({ name: "CI", run_attempt: 1 });
    if (path.endsWith("/actions/jobs/666/logs")) {
      if (log.includes(ESC) && !args.includes("--allow-escape-sequences")) throw new Error(`Command failed: gh ${args.join(" ")}\n${ESCAPE_REFUSAL}`);
      return log;
    }
    if (path.includes("/actions/runs?")) return JSON.stringify({ workflow_runs: [] });
    throw new Error(`unexpected gh ${args.join(" ")}`);
  };
  return { read, asked };
}
const PR = { repo: "o/r", number: 77, head8: "abcdef12" };

test("a coloured job log is read, and its coloured `##[error]` line matches as the plain line it is", () => {
  const log = [
    `${ESC}[36;1m##[group]Run pnpm test${ESC}[0m`,
    `${ESC}[?25lError: cursor-hidden line${ESC}[?25h`,
    `${ESC}[31;1m##[error]${ESC}[0mProcess completed with exit code 1.`,
    `${ESC}[31mAssertionError${ESC}[0m [ERR_ASSERTION]: expected 3, got 4`,
    "",
  ].join("\n");
  const { read, asked } = logGh(log);
  const out = readCiFailure(PR, read, NOW);
  assert.ok(out !== null);
  assert.deepEqual(out.errorLines, ["Error: cursor-hidden line", "##[error]Process completed with exit code 1.", "AssertionError [ERR_ASSERTION]: expected 3, got 4"]);
  assert.ok(out.errorLines.every((line) => !line.includes(ESC)));
  assert.ok(asked.some((args) => args[1].endsWith("/actions/jobs/666/logs") && args.includes("--allow-escape-sequences")));
  // the stub is the real refusal: the same coloured log without the flag throws, so the read above passing is the flag's doing
  assert.throws(() => logGh(log).read(["api", "repos/o/r/actions/jobs/666/logs"]), /--allow-escape-sequences/);
});

test("escape bytes inside a phrase do not hide it from the fact that reads the whole log", () => {
  const out = readCiFailure(PR, logGh(`API rate ${ESC}[1mlimit${ESC}[0m exceeded for user\n`).read, NOW);
  assert.ok(out !== null);
  assert.equal(out.rateLimitOrRunnerLost, true);
  // negative control: the same log with nothing in it that is a rate limit says so
  assert.equal(readCiFailure(PR, logGh(`${ESC}[1mAssertionError${ESC}[0m: nope\n`).read, NOW)!.rateLimitOrRunnerLost, false);
});

test("a log with no escape bytes is read as before: the same lines, nothing stripped or lost", () => {
  const out = readCiFailure(PR, logGh("setup\nAssertionError: expected 1 to equal 2\nnot ok 1 - the thing\n").read, NOW);
  assert.ok(out !== null);
  assert.deepEqual(out.errorLines, ["AssertionError: expected 1 to equal 2", "not ok 1 - the thing"]);
  assert.equal(out.rateLimitOrRunnerLost, false);
});

// ---------------------------------------------------------------------------------------------------
// a11ign#5008: a failure SHARED by open pull requests is one incident, and its merged fix refreshes them.

const INSTALL_ERROR = "2026-10-11T09:42:11.123Z ##[error]npm ERR! 404 Not Found - GET https://registry/agent-org-0.155.4.tgz";
type Job = { steps: { name: string; conclusion: string }[]; log: string };
const jobUrl = (job: number) => `https://github.com/a11ign/a11ign/actions/runs/${job + 1000}/job/${job}`;
const redPr = (number: number, job: number, check = "checks"): RedPr =>
  ({ ref: `pr-${number}`, repo: "a11ign/a11ign", number, checks: [{ name: check, detailsUrl: jobUrl(job), completedAt: "2026-10-11T09:50:00Z" }] });
const redOrder = (number: number) => ({ cause: "pr-checks-failing", subject: `pr-${number}`, session: `worker-${number}`, discriminator: "red" });

/** A `gh` fake: jobs by number, issues by number, pulls by number; every write is recorded. */
function ghFake(over: { jobs?: Record<number, Job>; issues?: any[]; pulls?: Record<number, any>; behind?: number; refuse?: number[] } = {}) {
  const writes: string[][] = [];
  const issues = over.issues ?? [];
  const run: Run = (args) => {
    const [cmd, sub] = args;
    const read = readsRowsByLabel(args); // #5039: the incident rows are read by label over graphql, not by `issue list`
    if (read !== null) return connectionOf(issues.filter((i) => i.state === read.state.toLowerCase()));
    // #5405: the Project-membership read a board write makes first. No fixture issue is on the board, so each boarding adds it.
    if (cmd === "api" && args.includes("graphql") && args.some((a) => a.includes("projectItems"))) return JSON.stringify({ data: { repository: { issue: { projectItems: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } } } });
    const path = args.find((a) => a.startsWith("repos/")) ?? "";
    if (cmd === "api" && /actions\/jobs\/\d+\/logs/.test(path)) return (over.jobs ?? {})[Number(/jobs\/(\d+)/.exec(path)![1])]?.log ?? (() => { throw new Error("refused"); })();
    if (cmd === "api" && /actions\/jobs\/\d+$/.test(path)) return JSON.stringify((over.jobs ?? {})[Number(/jobs\/(\d+)/.exec(path)![1])] ?? (() => { throw new Error("refused"); })());
    if (cmd === "api" && args.includes("PUT")) {
      writes.push(args);
      if ((over.refuse ?? []).includes(Number(/pulls\/(\d+)/.exec(path)![1]))) throw new Error("422 merge conflict");
      return "{}";
    }
    if (cmd === "api" && /\/compare\//.test(path)) return JSON.stringify({ behind_by: over.behind ?? 3 });
    if (cmd === "api" && /\/pulls\/\d+$/.test(path)) return JSON.stringify((over.pulls ?? {})[Number(/pulls\/(\d+)/.exec(path)![1])] ?? { state: "open", head: { sha: "abc" }, base: { ref: "main" } });
    writes.push(args);
    if (cmd === "issue" && sub === "create") { issues.push({ number: 900 + issues.length, state: "open", createdAt: new Date().toISOString(), body: args[args.indexOf("--body") + 1] }); return "https://github.com/a11ign/a11ign/issues/900"; }
    // #5405: a label edit (the boarding of a new row) carries no `--body`, and must leave the body as it is
    if (cmd === "issue" && sub === "edit" && args.includes("--body")) { const row = issues.find((i) => i.number === Number(args[2])); row.body = args[args.indexOf("--body") + 1]; }
    return "";
  };
  return { run, writes, issues };
}
const installJob = (): Job => ({ steps: [{ name: "Set up job", conclusion: "success" }, { name: "Install agent-org", conclusion: "failure" }], log: `${INSTALL_ERROR}\n` });
const log = () => {};

test("shared failure -- POSITIVE CONTROL: two open PRs fail the same setup step, so the gate files ONE incident and wakes ZERO workers", () => {
  const gh = ghFake({ jobs: { 11: installJob(), 12: { ...installJob(), log: INSTALL_ERROR.replace("09:42:11", "09:43:50") + "\n" } } });
  const out = sharedFailureTick([redOrder(4969), redOrder(4977)], { prs: [redPr(4969, 11), redPr(4977, 12)], run: gh.run, log });
  assert.deepEqual(out.orders, [], "no worker is woken");
  assert.equal(out.held.length, 2);
  assert.deepEqual(gh.writes.filter((w) => w[0] === "issue" && w[1] === "create").length, 1, "one incident row");
  const body = String(gh.issues[0].body);
  assert.match(body, /Shared-failure-prs: a11ign\/a11ign#4969, a11ign\/a11ign#4977/);
  // the next tick JOINS it: the same failure on a third PR edits the one row and files no second
  const again = sharedFailureTick([redOrder(4969), redOrder(4977), redOrder(5001)], { prs: [redPr(4969, 11), redPr(4977, 12), redPr(5001, 13)], run: ghFakeWith(gh, { 13: installJob() }), log });
  assert.deepEqual(again.orders, []);
  assert.equal(gh.issues.length, 1);
  assert.match(String(gh.issues[0].body), /#5001/);
});
const ghFakeWith = (gh: ReturnType<typeof ghFake>, jobs: Record<number, Job>): Run => (args) => {
  const m = /actions\/jobs\/(\d+)/.exec(args.find((a) => a.startsWith("repos/")) ?? "");
  if (args[0] === "api" && m !== null && jobs[Number(m[1])] !== undefined) {
    return args.some((a) => a.endsWith("/logs")) ? jobs[Number(m[1])].log : JSON.stringify(jobs[Number(m[1])]);
  }
  return gh.run(args);
};

test("shared failure -- NEGATIVE CONTROL: a PR whose own diff fails is still woken as today, and writes nothing", () => {
  const own: Job = { steps: [{ name: "Run tests", conclusion: "failure" }], log: "AssertionError [ERR_ASSERTION]: expected 3, got 4\n" };
  const gh = ghFake({ jobs: { 11: installJob(), 12: installJob(), 21: own } });
  // the two shared PRs are held; the third fails `gate` at a different step with a different line, and is NOT in their group
  const out = sharedFailureTick([redOrder(4969), redOrder(4977), redOrder(5100)], { prs: [redPr(4969, 11), redPr(4977, 12), redPr(5100, 21)], run: gh.run, log });
  assert.deepEqual(out.orders.map((o) => o.subject), ["pr-5100"]);
  // alone, the same own failure is nobody's incident: no read of a log, no row, the order unchanged
  const alone = ghFake({ jobs: { 21: own } });
  const lone = sharedFailureTick([redOrder(5100)], { prs: [redPr(5100, 21)], run: alone.run, log });
  assert.deepEqual(lone.orders, [redOrder(5100)]);
  assert.deepEqual(alone.writes, []);
  // two PRs red on the same check for DIFFERENT own reasons are not one incident either
  const twoOwn = ghFake({ jobs: { 21: own, 22: { ...own, log: "AssertionError: a different test failed\n" } } });
  assert.equal(holdSharedFailures([redOrder(1), redOrder(2)], { prs: [redPr(1, 21), redPr(2, 22)], run: twoOwn.run }).held.length, 0);
});

test("shared failure: a log that cannot be read, a hung check and a PR with a second red check are never held", () => {
  const gh = ghFake({ jobs: { 11: installJob() } }); // job 12's read is refused
  assert.equal(holdSharedFailures([redOrder(1), redOrder(2)], { prs: [redPr(1, 11), redPr(2, 12)], run: gh.run }).held.length, 0);
  const both = ghFake({ jobs: { 11: installJob(), 12: installJob() } });
  const hung = { ...redOrder(1), discriminator: "hung-check" };
  assert.deepEqual(holdSharedFailures([hung, redOrder(2)], { prs: [redPr(1, 11), redPr(2, 12)], run: both.run }).orders, [hung, redOrder(2)]);
  const second = { ...redPr(2, 12), checks: [...redPr(2, 12).checks, { name: "unit", detailsUrl: jobUrl(30) }] };
  const out = holdSharedFailures([redOrder(1), redOrder(2)], { prs: [redPr(1, 11), second], run: both.run });
  assert.deepEqual(out.orders.map((o) => o.subject), ["pr-2"]);
});

test("#1557 POSITIVE: an open, UNCLAIMED incident row 16 minutes old (the shape of #5228) holds its four red PRs, wakes none, and is named in the log", () => {
  const numbers = [4969, 4977, 5001, 5008];
  const gh = ghFake({ jobs: Object.fromEntries(numbers.map((n, i) => [11 + i, installJob()])) });
  const prs = numbers.map((n, i) => redPr(n, 11 + i));
  const orders = numbers.map(redOrder);
  sharedFailureTick(orders, { prs, run: gh.run, log }); // files the row now
  const logs: string[] = [];
  const later = sharedFailureTick(orders, { prs, run: gh.run, log: (line) => logs.push(line), nowMs: Date.now() + 16 * 60_000 });
  assert.equal(gh.issues.length, 1, "one row, not joined to a second");
  assert.deepEqual(later.orders, [], "no worker is woken for the row's failure at 16 minutes");
  assert.deepEqual(later.released, []);
  assert.equal(later.held.length, 4);
  assert.match(logs.join(""), new RegExp(`incident #${gh.issues[0].number} has been open 15 minutes with no claim`));
});

test("#1557 NEGATIVE: an incident row CLOSED by its fix releases its four held PRs at once, naming the row", () => {
  const numbers = [4969, 4977, 5001, 5008];
  const gh = ghFake({ jobs: Object.fromEntries(numbers.map((n, i) => [11 + i, installJob()])) });
  const prs = numbers.map((n, i) => redPr(n, 11 + i));
  const orders = numbers.map(redOrder);
  sharedFailureTick(orders, { prs, run: gh.run, log });
  gh.issues[0].state = "closed";
  gh.issues[0].closedAt = new Date().toISOString();
  const after = sharedFailureTick(orders, { prs, run: gh.run, log, nowMs: Date.now() + 60_000 });
  assert.equal(after.orders.length, 4, "the closed row's holds are over: each worker is told the failure is its own to read");
  assert.equal(after.released.length, 4);
  assert.ok(after.orders.every((o) => String((o as { prompt?: string }).prompt).includes(`SHARED-FAILURE HOLD RELEASED (#${gh.issues[0].number}: its incident row was closed)`)));
});

test("the fix refreshes its victims: merging the incident's PR updates both branches, once, with no worker turn", () => {
  const body = ["Check: checks", "First error line: npm ERR! # Not Found - GET https://registry/agent-org-#.#.#.tgz", "Shared-failure-prs: a11ign/a11ign#4969, a11ign/a11ign#4977"].join("\n");
  const closedBy = [{ number: 5004, repository: { nameWithOwner: "a11ign/agent-org" } }];
  const gh = ghFake({ issues: [{ number: 4988, state: "closed", body, closedByPullRequestsReferences: closedBy }],
    pulls: { 5004: { merged_at: "2026-10-11T10:32:00Z" } } });
  const out = refreshFixed({ run: gh.run, log, nowMs: Date.parse("2026-10-11T10:33:00Z") });
  assert.deepEqual(out.refreshed, ["a11ign/a11ign#4969", "a11ign/a11ign#4977"]);
  assert.deepEqual(gh.writes.filter((w) => w.includes("PUT")).map((w) => w.at(-1)), ["repos/a11ign/a11ign/pulls/4969/update-branch", "repos/a11ign/a11ign/pulls/4977/update-branch"]);
  // stamped, so the next tick does it no more
  assert.match(String(gh.issues[0].body), /^Refreshed-at: /m);
  gh.issues[0].state = "closed";
  assert.deepEqual(refreshFixed({ run: gh.run, log, nowMs: Date.parse("2026-10-11T10:50:00Z") }).refreshed, []);
});

test("the fix is not merged, or a PR is not behind, or the refresh is refused: nothing is updated, and a conflict is the worker's again", () => {
  const body = "Check: checks\nFirst error line: x\nShared-failure-prs: a11ign/a11ign#1, a11ign/a11ign#2";
  const closedBy = [{ number: 5004, repository: { nameWithOwner: "a11ign/agent-org" } }];
  const unmerged = ghFake({ issues: [{ number: 7, state: "closed", body, closedByPullRequestsReferences: closedBy }], pulls: { 5004: { merged_at: null } } });
  assert.deepEqual(refreshFixed({ run: unmerged.run, log }).refreshed, []);
  assert.deepEqual(unmerged.writes, []);
  const upToDate = ghFake({ issues: [{ number: 7, state: "closed", body, closedByPullRequestsReferences: closedBy }], pulls: { 5004: { merged_at: "2026-10-11T10:32:00Z" } }, behind: 0 });
  assert.deepEqual(refreshFixed({ run: upToDate.run, log }).refreshed, []);
  const conflict = ghFake({ issues: [{ number: 7, state: "closed", body, closedByPullRequestsReferences: closedBy }], pulls: { 5004: { merged_at: "2026-10-11T10:32:00Z" } }, refuse: [2] });
  const out = refreshFixed({ run: conflict.run, log });
  assert.deepEqual([out.refreshed, out.refused], [["a11ign/a11ign#1"], ["a11ign/a11ign#2"]]);
  // the refused PR is released: its red order is delivered again instead of held
  const gh = ghFake({ jobs: { 11: installJob(), 12: installJob() }, issues: conflict.issues });
  const tick = sharedFailureTick([redOrder(1), redOrder(2)], { prs: [redPr(1, 11), redPr(2, 12)], run: gh.run, log });
  assert.deepEqual(tick.orders.map((o) => o.subject), ["pr-2"]);
});

test("the detector: a PR red before the fix merged, unnoted, is refreshed only 10 minutes after the merge", () => {
  const body = "Check: checks\nFirst error line: npm ERR! # Not Found - GET https://registry/agent-org-#.#.#.tgz\nShared-failure-prs: a11ign/a11ign#4969";
  const closedBy = [{ number: 5004, repository: { nameWithOwner: "a11ign/agent-org" } }];
  const mk = () => ghFake({ jobs: { 12: installJob() }, issues: [{ number: 4988, state: "closed", body, closedByPullRequestsReferences: closedBy }],
    pulls: { 5004: { merged_at: "2026-10-11T10:32:00Z" } } });
  const early = refreshFixed({ run: mk().run, log, nowMs: Date.parse("2026-10-11T10:35:00Z"), open: [redPr(4977, 12)] });
  assert.deepEqual(early.refreshed, ["a11ign/a11ign#4969"]);
  const late = refreshFixed({ run: mk().run, log, nowMs: Date.parse("2026-10-11T10:43:00Z"), open: [redPr(4977, 12)] });
  assert.deepEqual(late.refreshed, ["a11ign/a11ign#4969", notedAs(redPr(4977, 12))]);
});

// ---------------------------------------------------------------------------------------------------
// #5098: WHICH LINE IS THE FAILURE, and what is never a cause. The packaging test reaches these from the gate with the real control logs; these pin each rule ALONE, because
// the diff rule would also keep the same pair from being grouped and so hides a broken one beside it.

const jobRun = (failedStep: string, ...log: string[]): Run => (args) =>
  /\/logs$/.test(args.find((a) => a.startsWith("repos/")) ?? "") ? log.join("\n") : JSON.stringify({ steps: [{ name: failedStep, conclusion: "failure" }] });
const checkOf = (name: string): RedCheck => ({ name, detailsUrl: jobUrl(77) });

test("#5098 a package manager's WARN line, a command echoed by the runner and the exit code are not the failure; a test runner's FAIL line is", () => {
  const warn = "2026-10-11T13:10:30Z  WARN  Failed to create bin at /home/runner/work/control/control/core/node_modules/.bin/a11ign. ENOENT";
  const echo = "2026-10-11T13:10:31Z ##[group]Run pnpm run fail-fast";
  const exit = "2026-10-11T13:13:31Z ##[error]Process completed with exit code 1.";
  const assertion = "2026-10-11T13:13:30Z AssertionError: the racing tick found the day reserved";
  assert.match(readSignature(checkOf("checks"), jobRun("Run tests", warn, echo, assertion, exit))!.line, /^AssertionError: the racing tick found the day reserved/);
  const fail = "2026-10-11T13:13:30Z  FAIL  packages/control/src/fleet-watch.test.ts > postUseOnce: a tick that lands";
  const out = readSignature(checkOf("checks"), jobRun("Run tests", warn, assertion, fail, exit))!;
  assert.match(out.line, /^FAIL\s+packages\/control\/src\/fleet-watch\.test\.ts > postUseOnce/);
  assert.equal(out.file, "packages/control/src/fleet-watch.test.ts");
});

test("#5098 the roll-up is no cause: by its name, by the step it fails, and by the line its script prints", () => {
  const install: FailureSignature = { check: "gate", step: "Install agent-org", line: "npm ERR!", file: null };
  const pr = (n: number, name: string): RedPr => ({ ref: `pr-${n}`, repo: "a11ign/a11ign", number: n, checks: [{ name, detailsUrl: jobUrl(n) }] });
  // by NAME: were `gate` a cause, two PRs failing it on a setup-looking step would be one incident
  assert.deepEqual(sharedFailureGroups([pr(1, "gate"), pr(2, "gate")], () => install), []);
  assert.equal(sharedFailureGroups([pr(1, "checks"), pr(2, "checks")], () => ({ ...install, check: "checks" })).length, 1, "positive control: the same pair on a real job IS grouped");
  // by STEP and by LINE, for a roll-up that is named something else
  assert.equal(readSignature(checkOf("ci-ok"), jobRun("Every job ran, and ran clean", "##[error]boom")), null);
  assert.equal(readSignature(checkOf("ci-ok"), jobRun("Every job that ran, ran clean", "##[error]boom")), null, "the other spelling of the roll-up step, as the row names it");
  assert.equal(readSignature(checkOf("ci-ok"), jobRun("Check results", "##[error]a job reported 'failure', not success")), null);
  assert.deepEqual(readSignature(checkOf("ci-ok"), jobRun("Check results", "##[error]boom"))?.line, "boom", "positive control: the same step and a real error is read");
});

type RedWorld = { log?: string; checks?: { name: string; job: string }[] };

/** A `gh` over a repository with one red pull request: its checks and their logs. */
function redGh(world: RedWorld = {}) {
  const { log = "FAIL  src/x.test.ts > adds\nAssertionError: expected 3, got 4\n", checks = [{ name: "suite", job: "666" }, { name: "gate", job: "667" }] } = world;
  const asked: string[] = [];
  const read = (args: string[]): string => {
    const path = args[1];
    asked.push(path);
    if (path.endsWith("/pulls/77")) return JSON.stringify({ head: { sha: SHA, ref: "agent/x-77" } });
    if (path.includes(`/commits/${SHA}/check-runs`)) {
      return JSON.stringify({ check_runs: checks.map((c) => ({ name: c.name, conclusion: "failure", details_url: `https://github.com/o/r/actions/runs/555/job/${c.job}` })) });
    }
    if (path.endsWith("/actions/runs/555")) return JSON.stringify({ name: "ci", run_attempt: 1 });
    if (path.endsWith("/logs")) return path.includes("/jobs/667/") ? "##[error]a job reported 'failure', not success\n" : log;
    if (path.includes("/actions/runs?")) return JSON.stringify({ workflow_runs: [] });
    throw new Error(`unexpected gh ${args.join(" ")}`);
  };
  return { read, asked };
}

test("the roll-up `gate` is not the log read, whichever order the checks list in", () => {
  const gateFirst = redGh({ checks: [{ name: "gate", job: "667" }, { name: "suite", job: "666" }] });
  const out = readCiFailure(PR, gateFirst.read, NOW);
  assert.equal(fallbackClass(out!), "own-defect");
  assert.ok(gateFirst.asked.every((path) => !path.includes("/jobs/667/")), "the roll-up's log names no cause and is not read");
});

// ---------------------------------------------------------------------------------------------------
// agent-org#1524: a run that checked out a SUPERSEDED merge commit is not this pull request's defect. The commit has no parents, so the acceptance gate cannot read the diff; a rerun
// checks out that same commit again, so the route is to push or update the branch so GitHub builds a new one.

const STALE_LOG = [
  "ACCEPTANCE-SOURCE: none (the diff could not be read, so no file added under .acceptance/ was found and its author a11ign-workers[bot] is not exempt)",
  "MUTATION: UNCHECKED -- could not read the diff (the merge commit this run checked out is not a parent-bearing merge: re-push or update the branch; a rerun reuses it).",
].join("\n");

test("#1524 POSITIVE: an acceptance that could not read the diff is stale-merge-ref, routed to a push or an update of the branch, and the order says a rerun cannot clear it", async () => {
  const out = readCiFailure(PR, redGh({ log: STALE_LOG }).read, NOW);
  assert.equal(out?.staleMergeRef, true);
  assert.equal(fallbackClass(out!), "stale-merge-ref");
  assert.equal(routeFor("stale-merge-ref", false), "push-or-update-branch");
  const decision = await classifyCiFailure(out!, rig({ triage: { provider: "none" } }).deps);
  assert.equal(decision.route, "push-or-update-branch");
  assert.match(classNote(decision), /a rerun reuses the same merge commit/);
});

test("#1524 NEGATIVE: a diff that was read and a test that failed is still the pull request's own defect, routed to its owner", () => {
  const out = readCiFailure(PR, redGh().read, NOW);
  assert.equal(out?.staleMergeRef, undefined, "absent, not false: the object is the one it was before #1524");
  assert.equal(fallbackClass(out!), "own-defect");
  assert.equal(routeFor("own-defect", false), "owner");
});

test("#1524 the rule: stale-merge-ref comes after a lost runner and before main, and the provider is offered it only with its fact", async () => {
  assert.equal(fallbackClass(failure({ staleMergeRef: true })), "stale-merge-ref");
  assert.equal(fallbackClass(failure({ staleMergeRef: true, redOnMain: true })), "stale-merge-ref");
  assert.equal(fallbackClass(failure({ staleMergeRef: true, rateLimitOrRunnerLost: true })), "infrastructure");
  assert.equal(fallbackClass(failure({ staleMergeRef: false, redOnMain: true })), "another-repository-changed");
  const without = rig({ reply: { body: answer("stale-merge-ref") } });
  const out = await classifyCiFailure(failure(), without.deps);
  assert.ok(!Object.keys(without.net.calls[0].body.questions.class.criteria).includes("stale-merge-ref"));
  assert.equal(out.klass, "own-defect", "an answer outside the offered classes is the rule's");
  const withFact = rig({ reply: { body: answer("stale-merge-ref") } });
  assert.equal((await classifyCiFailure(failure({ staleMergeRef: true }), withFact.deps)).klass, "stale-merge-ref");
  assert.equal(withFact.net.calls[0].body.state.staleMergeRef, true);
});
