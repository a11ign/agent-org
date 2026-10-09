// no-token: gh -- every `gh` here is an injected `run` seam answering from a fixture; `readTrunkRed`'s default `gh` is never reached
/**
 * #3079: A RED `main` IN A DECLARED CODE REPOSITORY WAKES SOMEBODY.
 *
 * agent-org's `main` was red 20:06Z-21:03Z on 2026-10-02 with every session idle, because `readTrunkRed` read `trunk.yml` in the primary's repository
 * and agent-org has only `ci.yml`. The payload below is the real one (`f02ecda0` failed, `f187a167` passed, `1639620f` passed before it).
 *
 * EVERY "NO ORDER" ASSERTION HERE HAS ITS POSITIVE CONTROL IN THE SAME FIXTURE WITH ONE FIELD CHANGED: a green newest run yields nothing only because
 * the same payload with `failure` yields an order, and a cancelled newest run is looked through only because the run behind it decides the answer.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { homeProjectDeclaration } from "./project-config.ts";
import { PRIMARY_TRUNK, readTrunkRed, trunkOfCodeRepository, trunkRedOrders } from "./trunk-red.ts";
import { readLanes, readScopeTrunkRed, scopesOf, scopeTick } from "./work-gate.ts";
import { stuckRowOf } from "./wake.ts";

const REPO = "a11ign/agent-org";
const BAD = "f02ecda0e5a1b2c3d4e5f60718293a4b5c6d7e8f";
const RUN_URL = "https://github.com/a11ign/agent-org/actions/runs/37066000001";
const TEST = "stuck-escalation-goes-to-ceo: a trunk-red order at the cap is stuck";

const run = (id: number, conclusion: string | null, createdAt: string, status = conclusion === null ? "in_progress" : "completed") =>
  ({ id, head_sha: id === 1 ? BAD : `${id}`.padEnd(40, "0"), status, conclusion, html_url: id === 1 ? RUN_URL : `https://example.test/${id}`, created_at: createdAt });
/** The three pushes of 2026-10-02, newest first as GitHub lists them, with the middle one red. */
const ACTUAL = { workflow_runs: [run(3, "success", "2026-10-02T21:03:33Z"), run(1, "failure", "2026-10-02T20:06:20Z"), run(0, "success", "2026-10-02T20:01:37Z")] };
const RED_NOW = { workflow_runs: [run(1, "failure", "2026-10-02T20:06:20Z"), run(0, "success", "2026-10-02T20:01:37Z")] };
/** `gate` is the one job; the log is the `job\tstep\tline` form `gh run view --log-failed` prints. */
const JOBS = { jobs: [{ id: 9, name: "gate", conclusion: "failure" }] };
const LOG = `gate\tThe tool's whole suite\t2026-10-02T20:06:19.1Z not ok 7 - ${TEST}\n`;
const PULLS = [{ number: 56, title: "claim release reads one repository", labels: [{ name: "session:worker-3075" }] }];

function fakeGh(state: { runs: unknown, pulls?: unknown }) {
  const calls: string[][] = [];
  const gh = (args: string[]) => {
    calls.push(args);
    const text = args.join(" ");
    if (text.includes("/actions/workflows/ci.yml/runs") || text.includes("/actions/workflows/trunk.yml/runs")) return JSON.stringify(state.runs);
    if (/\/actions\/runs\/\d+\/jobs/.test(text)) return JSON.stringify(JOBS);
    if (args[0] === "run" && args[1] === "view") return LOG;
    if (text.includes("/pulls")) return JSON.stringify(state.pulls ?? PULLS);
    throw new Error(`unexpected gh call: ${text}`);
  };
  return { gh, calls };
}
const agentOrg = trunkOfCodeRepository("agent-org", REPO);
const readRed = (runs: unknown, pulls?: unknown) => readTrunkRed(fakeGh({ runs, pulls }).gh, agentOrg);

test("ACCEPTANCE: a newest verdict of `failure` on agent-org's main yields a trunk-red order for a session that can act, naming repository, run, job and sha", () => {
  const [order, ...rest] = trunkRedOrders(readRed(RED_NOW));
  assert.equal(rest.length, 0);
  assert.equal(order.cause, "trunk-red");
  assert.equal(order.session, "worker-3075", "the merging session holds the context");
  assert.equal(order.fallback, "product-manager", "and the way out is the seat that can act, NOT the engineer pool that refuses an order not its row's (#2407)");
  for (const named of [REPO, RUN_URL, "`gate`", BAD.slice(0, 8), TEST, "#56"]) assert.ok(order.prompt.includes(named), `the prompt names ${named}`);
  assert.match(order.prompt, /FIX FORWARD -- DO NOT REVERT/);
});

test("CONTROL: the same payload with the newest verdict `success` yields NO order, and the red one behind it is not read as current", () => {
  assert.equal(readRed(ACTUAL), null, "f187a167 passed after f02ecda0 failed: main is green again");
  assert.notEqual(readRed(RED_NOW), null, "POSITIVE CONTROL: without the passing run on top, the same payload is red");
});

test("a cancelled or in-flight newest run is LOOKED THROUGH to the one before it: red stays red, green stays green", () => {
  const cancelled = run(5, "cancelled", "2026-10-02T21:10:00Z");
  const inFlight = run(6, null, "2026-10-02T21:11:00Z");
  assert.notEqual(readRed({ workflow_runs: [cancelled, inFlight, ...RED_NOW.workflow_runs] }), null, "red stays red");
  assert.equal(readRed({ workflow_runs: [cancelled, inFlight, ...ACTUAL.workflow_runs] }), null, "green stays green");
  assert.equal(readRed({ workflow_runs: [cancelled, inFlight] }), null, "no verdict at all is nothing to say, not a red");
});

test("the read asks for PUSH runs of `ci.yml` on main, in agent-org, and a healthy main costs exactly one call", () => {
  const healthy = fakeGh({ runs: { workflow_runs: [run(3, "success", "2026-10-02T21:03:33Z")] } });
  assert.equal(readTrunkRed(healthy.gh, agentOrg), null);
  assert.deepEqual(healthy.calls, [["api", "--method", "GET", `repos/${REPO}/actions/workflows/ci.yml/runs`, "-f", "branch=main", "-f", "event=push", "-f", "per_page=10"]]);
  const red = fakeGh({ runs: RED_NOW });
  readTrunkRed(red.gh, agentOrg);
  assert.deepEqual(red.calls.slice(1).map((c) => (c[0] === "run" ? `run view ${c[3]} ${c[4]}` : c[1])), [
    `repos/${REPO}/actions/runs/1/jobs?per_page=100`, `run view --repo ${REPO}`, `repos/${REPO}/commits/${BAD}/pulls`],
  "jobs, the log, the merged PR; no annotations call, because there is no recheck job");
  assert.ok(red.calls.every((c) => !c.some((a) => a.includes("a11ign/a11ign"))), "nothing is asked of the primary's repository");
});

test("with no merged PR known, or the merging session already the router, the order goes to product-manager and carries no fallback", () => {
  const [unknownMerge] = trunkRedOrders(readRed(RED_NOW, []));
  assert.equal(unknownMerge.session, "product-manager");
  assert.equal(unknownMerge.fallback, undefined);
  assert.equal(unknownMerge.subject, `trunk-agent-org-${BAD.slice(0, 8)}`);
  const [unlabelled] = trunkRedOrders(readRed(RED_NOW, [{ number: 56, title: "t", labels: [] }]));
  assert.equal(unlabelled.session, "product-manager", "a PR with no session label is not an address");
  const [asRouter] = trunkRedOrders(readRed(RED_NOW, [{ number: 56, title: "t", labels: [{ name: "session:product-manager" }] }]));
  assert.deepEqual([asRouter.session, asRouter.fallback], ["product-manager", undefined]);
});

test("the order never blames a merge, and tells its receiver to FILE a row rather than fix it", () => {
  const [order] = trunkRedOrders(readRed(RED_NOW));
  assert.match(order.prompt, /NO PARENT RE-CHECK RUNS/);
  assert.doesNotMatch(order.prompt, /THIS MERGE'S OWN/);
  assert.match(order.prompt, /FILE ONE `ready`, `lane:any` row/);
  assert.doesNotMatch(order.prompt, /open THAT as a pull request now/, "the primary's instruction to an engineer is not the router's");
});

test("agent-org's order cannot collide with a11ign's, and the stuck breaker cannot label a11ign's #56 for it", () => {
  const [mine] = trunkRedOrders(readRed(RED_NOW));
  const [primary] = trunkRedOrders({ ...readRed(RED_NOW)!, repo: undefined, repoKey: undefined });
  assert.equal(mine.subject, "pr-agent-org#56");
  assert.equal(primary.subject, "pr-56");
  assert.notEqual(mine.causeKey, primary.causeKey);
  assert.equal(stuckRowOf(primary.causeKey), 56, "POSITIVE CONTROL: the primary's subject IS read as row 56");
  assert.equal(stuckRowOf(mine.causeKey), null, "agent-org's names no row of the primary, so nothing is labelled");
});

test("THE PRIMARY'S READ AND ORDER ARE UNCHANGED: the same calls, and the same prompt byte for byte", () => {
  const gh = fakeGh({ runs: { workflow_runs: [run(3, "success", "2026-10-02T21:03:33Z")] } });
  assert.equal(readTrunkRed(gh.gh), null);
  assert.equal(readTrunkRed(gh.gh, PRIMARY_TRUNK), null, "omitted and explicit are one source");
  assert.deepEqual(gh.calls[0], ["api", "--method", "GET", `repos/${PRIMARY_TRUNK.repo}/actions/workflows/trunk.yml/runs`, "-f", "branch=main", "-f", "per_page=10"],
    "no `event=push`, and `trunk.yml`");
  const [order] = trunkRedOrders({ runId: 1, url: "https://github.com/a11ign/a11ign/actions/runs/1", sha: "a1b2c3d4e5f6789012345678901234567890abcd",
    failedJobs: ["trunkBuildTest / run"], failingTests: ["the README's quickstart"], recheck: "pass", parentFailingTests: null,
    originPr: { number: 2372, title: "x", session: "worker-tooling" } });
  // Captured from `trunk-red.ts` at origin/main BEFORE this row, against the same facts; #3449 then added the one marker sentence (`FIX_MARKER`) and nothing else.
  assert.equal(order.prompt, "**MAIN IS RED. FIX FORWARD -- DO NOT REVERT.** This is the top of every queue: put down what you are doing.\nThe merge is #2372 (\"x\"), at `a1b2c3d4`. The failing job(s): `trunkBuildTest / run`.\nThe failing test(s): `the README's quickstart`.\nThe run: https://github.com/a11ign/a11ign/actions/runs/1\nTHE RE-CHECK SAYS THIS MERGE'S OWN: the parent does not fail this now (or fails only tests this merge did not, or only the silent-undo guard failed, which asks about this merge's own two parents) -- so the failure arrived with it.\nTHE RULING (chairman, 2026-09-24): the org always fixes forward. Nothing reverts a merge, no CI job and no session -- not a `revert/` branch, not `git revert`, not \"revert as a fallback after N minutes\". #2341 would have removed a correct doc for a two-entry map miss in a test, and the fix was smaller than the re-land.\nSO: read the failing test, find the smallest change that makes it true, and open THAT as a pull request now, naming this merge in it. Mark it so the chairman's messages can find it: label it `incident` (`gh label create incident` first if `gh` says it does not exist) and put the line `Incident: incident:trunk-red` on a line of its own in its body. Other pull requests KEEP MERGING while you do (a red main already stops the ones that touch the break, and `trunkGate` still refuses a merge that silently undoes work); the fix goes first because this order outranks every other, not because the queue stops.\nIf you cannot tell what to fix, say so on the merged pull request and route it -- but say it there, do not hold this order in silence. It is offered again every twenty minutes until `main` is green.");
  assert.deepEqual([order.session, order.fallback, order.subject], ["worker-tooling", "engineers", "pr-2372"]);
});

// --- the gate's own wiring: a scope's tick carries its `main`'s order, and one declared project asks nothing new ---

const scopeOf = (key: string) => scopesOf([homeProjectDeclaration()]).find((s) => s.key === key)!;
const NO_TRACKER = { claimedComments: [], epics: [], closedRows: [], closings: null };

function tickOf(key: string, runs: unknown) {
  const scope = scopeOf(key);
  const readings = { code: (prs: unknown[]) => ({ prs, required: null, baseTip: null, unarmed: null, trunkRed: readScopeTrunkRed(scope, fakeGh({ runs }).gh) }),
    tracker: () => NO_TRACKER };
  return scopeTick(scope, false, readLanes(scope, (args: string[]) => (args[0] === "pr" ? "[]" : "[]")), readings).orders as { cause: string, session: string, causeKey: string, prompt: string }[];
}

test("DONE-WHEN 3, replayed: the scope's tick yields the order on a red main and none on a green one", () => {
  const red = tickOf("agent-org", RED_NOW).filter((o) => o.cause === "trunk-red");
  assert.equal(red.length, 1);
  assert.ok(red[0].causeKey.startsWith("worker-3075/trunk-red/pr-agent-org#56/"), red[0].causeKey);
  assert.match(red[0].prompt, /REPOSITORY `agent-org`/, "the scope's own note about whose numbers these are is appended as for every order");
  assert.equal(tickOf("agent-org", ACTUAL).filter((o) => o.cause === "trunk-red").length, 0, "the same fixture, green on top");
});

test("a scope with no code repository has no `main` to ask, and one declared project has no scope but the primary's", () => {
  const trackerOnly = { key: "t", code: null, tracker: { repo: "a11ign/t" } };
  assert.equal(readScopeTrunkRed(trackerOnly, () => { throw new Error("must not be asked"); }), undefined);
  const one = scopesOf([{ tracker: [{ key: "", repo: "a11ign/a11ign" }], code: [{ key: "", repo: "a11ign/a11ign" }] }]);
  assert.deepEqual(one.filter((s) => s.key !== ""), [], "otherScopeTicks has nothing to tick, so a11ign alone makes the calls it made");
  assert.ok(scopeOf("agent-org").code, "POSITIVE CONTROL: the home project declares agent-org's code repository, so the population is not empty");
});
