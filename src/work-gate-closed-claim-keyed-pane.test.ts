// no-token: gh -- every `gh` and `herdr` call here is an injected seam (`run`, `log`); nothing imported reaches the real one
/**
 * agent-org#757 (a11ign#4437): A CLOSED ROW ENDS ITS KEYED WORKER PANE, `worker-agent-org-<n>` AS WELL AS `worker-<n>`.
 *
 * The closed-claim pass asked herdr for panes named `worker-<number>` only, and `familyNumber("worker-agent-org-730")` is `null` BY DESIGN (730 alone would name the first
 * tracker's row 730), so a keyed pane's row was never asked about, open or closed. These drive the gate's own decision (`closedClaimsWhenWorkerListed` for the read,
 * `withClosedClaims` for the orders), never a copy of it, and each "nothing is ordered" assertion is read against the same fixture with the row CLOSED.
 *
 * The project is a RECORDED one (`wake-teardown-keyed-rows.test.ts`'s shape): the host file is set FIRST and the tool imported AFTER it, because a keyed name is a member of a
 * spare family only for a key the project declares (`familyMember`).
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRATCH = mkdtempSync(join(tmpdir(), "closed-claim-keyed-"));
after(() => rmSync(SCRATCH, { recursive: true, force: true }));
const PROJECT = join(SCRATCH, "project");
cpSync(fileURLToPath(new URL("./packaging/fixtures/row-claim-file-overlap-rule/project", import.meta.url)), PROJECT, { recursive: true });
const DECLARATION = join(PROJECT, ".agent-org", "project.json");
const declared = JSON.parse(readFileSync(DECLARATION, "utf8")) as { tracker: { key: string; repo: string; board: { owner: string; number: number } }[] };
declared.tracker.push({ key: "agent-org", repo: "a11ign/agent-org", board: { owner: "a11ign", number: 2 } });
writeFileSync(DECLARATION, JSON.stringify(declared));
const HOST_FILE = join(SCRATCH, "host.json");
writeFileSync(HOST_FILE, JSON.stringify({ schema: 1, home: SCRATCH, binDir: join(SCRATCH, "bin"), primary: "fixture",
  projects: [{ id: "fixture", checkout: PROJECT }], clones: { "agent-org": "/clones/agent-org" },
  gh: { workers: join(SCRATCH, "workers"), leads: join(SCRATCH, "leads"), leadsHeader: [], leadsWorkspaces: [] } }));
process.env.AGENT_ORG_HOST = HOST_FILE;

const { closedClaimsWhenWorkerListed, withClosedClaims } = await import("./work-gate/tick.ts");
const { closedClaimDebris } = await import("./work-gate/causes/rows-claims-closed.ts");
const { readOpenRowFollowUps } = await import("./work-gate.ts");
const { homeProjectDeclaration } = await import("./project-config.ts");
const { claimRecordComment } = await import("./row-claim.ts");

type Agent = { label: string; status: string };
type Order = { session: string; subject: string; causeKey: string; release?: { row: number; tracker?: string; session: string; why: string; interrupt?: boolean;
  branch: string | null; worktree: string | null } };

const AGENT_ORG = "a11ign/agent-org";
const KEYED = "worker-agent-org-730";
const BARE = "worker-4877";
const BRANCH = "agent/a-closed-row-ends-agent-org-730";

const record = (session: string) => ({ body: claimRecordComment({ session, branch: BRANCH, worktree: "../wt-agent-org-730" }),
  created_at: "2026-10-10T19:30:00Z", user: { login: "a11ign-ai-workers" } });

/** One row, as the REST reads answer it (agent-org#1113): `state` decides whether it comes back as a closed claim, and its labels and comments carry `session`. */
type IssueRow = { number: number; state: "OPEN" | "CLOSED"; session: string; };
const issueRow = (number: number, state: IssueRow["state"], session: string): IssueRow => ({ number, state, session });
/** The REST answers for the rows handed in, by path: `issues/<n>`, its comments and its timeline. Any other path is an absent row (HTTP 404). */
const restFor = (...rows: IssueRow[]) => (call: Call) => {
  for (const { number, state, session } of rows) {
    if (pathOf(call) === `issues/${number}`) return JSON.stringify({ number, state: state.toLowerCase(), labels: ["in-progress", "started", `session:${session}`].map((name) => ({ name })), comments: 1 });
    if (pathOf(call) === `issues/${number}/comments?per_page=100&page=1`) return JSON.stringify([record(session)]);
    if (pathOf(call) === `issues/${number}/timeline`) return "[]";
  }
  throw Object.assign(new Error("Command failed: gh api"), { status: 1, stderr: "gh: Not Found (HTTP 404)" });
};

type Call = { args: string[]; repo: string | undefined };
/** A `gh` seam that records every call with the repository it was aimed at, and answers `answer(call)`. */
function seam(answer: (call: Call) => string) {
  const calls: Call[] = [];
  const run = (args: string[], repo?: string) => {
    const call = { args, repo };
    calls.push(call);
    return answer(call);
  };
  return { calls, run };
}
const pathOf = (call: Call) => call.args[call.args.length - 1].replace(/^repos\/[^/]+\/[^/]+\//, "");
const repoOf = (call: Call) => call.args[call.args.length - 1].match(/^repos\/([^/]+\/[^/]+)\//)?.[1];
/** The row numbers a call asks for: an `issues/<n>` read only, not the comments or the timeline of a row. */
const rowsAsked = (call: Call) => { const number = pathOf(call).match(/^issues\/(\d+)$/); return number ? [Number(number[1])] : []; };
const issueReads = (calls: Call[]) => calls.filter((call) => rowsAsked(call).length > 0);

/** The orders the gate hands the stall pass for one tick's closed claims, decided as `main` decides them. */
function ordersOf(agents: Agent[], answer: (call: Call) => string, log: (line: string) => void = () => {}) {
  const { run, calls } = seam(answer);
  const read = closedClaimsWhenWorkerListed(agents, run, log);
  const stalls = withClosedClaims({ claimStalls: [] } as never, read) as unknown as { claimStalls: Order[] };
  return { orders: stalls.claimStalls, read, calls };
}

test("positive control: the fixture project DECLARES agent-org, so a keyed pane names a row and not a stranger", () => {
  assert.equal(homeProjectDeclaration().tracker.find((t) => t.key === "agent-org")?.repo, AGENT_ORG);
});

test("agent-org#757 (1): a CLOSED row held by worker-agent-org-<n> yields the release, in ITS tracker, and the interrupt when the pane is mid-turn", () => {
  const closed = (call: Call) => (call.repo === AGENT_ORG ? restFor(issueRow(730, "CLOSED", KEYED))(call) : "{}");
  const { orders, calls } = ordersOf([{ label: KEYED, status: "working" }], closed);
  assert.deepEqual(issueReads(calls).map((c) => c.repo), [AGENT_ORG], "ONE issue read, for the one tracker the listed pane is of");
  assert.deepEqual([calls[0].repo, repoOf(calls[0]), rowsAsked(calls[0])], [AGENT_ORG, AGENT_ORG, [730]],
    "asked of agent-org's repository, for agent-org's row 730 -- the home tracker's 730 is a different row");
  assert.equal(orders.length, 1);
  const [order] = orders;
  assert.equal(order.session, KEYED);
  assert.deepEqual([order.release?.row, order.release?.tracker, order.release?.why, order.release?.interrupt], [730, "agent-org", "closed", true],
    "the release carries the tracker's key (agent-org#834), so `performRelease` declines the row THERE");
  assert.equal(order.release?.branch, BRANCH);
  assert.equal(order.subject, "row-agent-org#730", "spelled as the stall pass spells another tracker's row");
  assert.match(order.causeKey, /^worker-agent-org-730\/claim-stalled\/row-agent-org#730\/release-closed$/);
});

test("agent-org#757 (1) an IDLE keyed pane on a closed row is released and NOT interrupted (there is nothing to interrupt)", () => {
  const { orders } = ordersOf([{ label: KEYED, status: "idle" }], restFor(issueRow(730, "CLOSED", KEYED)));
  assert.deepEqual(orders.map((o) => [o.release?.row, o.release?.tracker, o.release?.why, o.release?.interrupt]), [[730, "agent-org", "closed", undefined]]);
});

test("agent-org#757 (1) CONTROL: the SAME keyed pane whose row is still OPEN yields nothing", () => {
  const { orders, calls } = ordersOf([{ label: KEYED, status: "working" }], restFor(issueRow(730, "OPEN", KEYED)));
  assert.deepEqual(issueReads(calls).map((c) => c.repo), [AGENT_ORG], "the read IS made: the row is asked about, and found open");
  assert.deepEqual(orders, []);
});

test("agent-org#757 (2) the existing path: worker-4877 on a CLOSED home row still yields the release, with no tracker key", () => {
  const { orders, calls } = ordersOf([{ label: BARE, status: "working" }], restFor(issueRow(4877, "CLOSED", BARE)));
  assert.deepEqual([calls[0].repo, rowsAsked(calls[0])], [undefined, [4877]], "the home tracker's read is made exactly as it always was: no repository aimed");
  assert.deepEqual(orders.map((o) => [o.session, o.release?.row, o.release?.tracker, o.release?.why, o.release?.interrupt, o.subject]),
    [[BARE, 4877, undefined, "closed", true, "row-4877"]]);
});

test("agent-org#757 (1) both spellings of ONE number are two rows: each is asked of its own tracker, and neither answers for the other", () => {
  const answer = (call: Call) => (call.repo === AGENT_ORG ? restFor(issueRow(730, "CLOSED", KEYED))(call) : restFor(issueRow(730, "OPEN", "worker-730"))(call));
  const { orders, calls } = ordersOf([{ label: "worker-730", status: "working" }, { label: KEYED, status: "idle" }], answer);
  assert.deepEqual(issueReads(calls).map((c) => [c.repo, rowsAsked(c)]), [[undefined, [730]], [AGENT_ORG, [730]]]);
  assert.deepEqual(orders.map((o) => [o.session, o.release?.tracker]), [[KEYED, "agent-org"]], "only agent-org's 730 is closed");
});

test("agent-org#757 (1) one tracker's refused read is said, and does NOT hold the other tracker's closed row", () => {
  const log: string[] = [];
  const answer = (call: Call) => {
    if (call.repo === AGENT_ORG) throw Object.assign(new Error("Command failed: gh"), { status: 1, stderr: "HTTP 502", stdout: "" });
    return restFor(issueRow(4877, "CLOSED", BARE))(call);
  };
  const { orders, read } = ordersOf([{ label: BARE, status: "idle" }, { label: KEYED, status: "idle" }], answer, (l) => log.push(l));
  assert.deepEqual(orders.map((o) => o.release?.row), [4877]);
  assert.notEqual(read?.rows, null, "partly read is not 'unread'");
  assert.equal(log.filter((l) => /tracker `agent-org` were NOT read/.test(l)).length, 1, "said once, naming the tracker");
  const every = ordersOf([{ label: KEYED, status: "idle" }], answer);
  assert.equal(every.read?.rows, null, "every read refused: null, never an empty list (#1286)");
  assert.deepEqual(every.orders, []);
});

test("agent-org#757 (3) a keyed label naming a tracker the project does NOT declare yields no read, and SAYS so", () => {
  const log: string[] = [];
  const { calls, read, orders } = ordersOf([{ label: "worker-capture-2407", status: "working" }], () => { throw new Error("must not be asked"); }, (l) => log.push(l));
  assert.deepEqual(calls, [], "no read: nothing says whose row it holds");
  assert.equal(read, null, "not asked");
  assert.deepEqual(orders, []);
  assert.equal(log.length, 1);
  assert.match(log[0], /worker-capture-2407 names tracker `capture`, which the project does not declare/);
  // CONTROL: the declared spelling of the same shape IS read, so the refusal above is the key's and not the shape's.
  const declaredRead = ordersOf([{ label: "worker-agent-org-2407", status: "working" }], restFor(issueRow(2407, "OPEN", "worker-agent-org-2407")));
  assert.deepEqual(declaredRead.calls.map((c) => c.repo), [AGENT_ORG]);
});

test("agent-org#757 a listing with no instance at all asks nothing, as before", () => {
  const { calls, read } = ordersOf([{ label: "ceo", status: "working" }, { label: "worker-3", status: "idle" }], () => { throw new Error("must not be asked"); });
  assert.deepEqual(calls, []);
  assert.equal(read, null);
});

test("agent-org#757 the read is made in the follow-ups' wave, so a keyed pane costs one more call in it and none outside it", () => {
  const open = [{ number: 41, title: "open row", labels: [{ name: "ready" }], body: "", blockedBy: { nodes: [] }, updatedAt: "2026-10-06T05:00:00Z" }];
  const seen: Call[] = [];
  const run = (args: string[], repo?: string) => {
    seen.push({ args, repo });
    return args[0] === "api" && args[args.length - 1].includes("/issues/730") ? restFor(issueRow(730, "CLOSED", KEYED))({ args, repo }) : "[]";
  };
  const got = readOpenRowFollowUps(open, run as never, undefined as never, () => [{ label: KEYED, status: "idle" }]) as unknown as
    { closedClaims: ReturnType<typeof closedClaimsWhenWorkerListed> };
  assert.deepEqual(got.closedClaims?.rows?.map((r) => [r.number, r.tracker?.key]), [[730, "agent-org"]]);
});

test("agent-org#757 a keyed pane's closed row is DEBRIS ten minutes after the close, as a bare-number one's is -- not a standing seat's day", () => {
  const closedAt = "2026-10-10T19:49:39Z";
  const row = (session: string) => ({ number: 730, closedAt, labels: ["in-progress", "started", `session:${session}`], repo: AGENT_ORG });
  const nowMs = Date.parse("2026-10-10T20:01:00Z"); // 11 min 21 s after the close
  const idle = (label: string) => [{ label, status: "idle" }];
  assert.deepEqual(closedClaimDebris([row(KEYED)], idle(KEYED), nowMs).strip.map((r) => r.number), [730], "idle keyed pane, past the worker grace: stripped");
  assert.deepEqual(closedClaimDebris([row(BARE)], idle(BARE), nowMs).strip.map((r) => r.number), [730], "the bare-number pane, as it already was");
  assert.deepEqual(closedClaimDebris([row(KEYED)], [{ label: KEYED, status: "working" }], nowMs).kept.map((r) => r.number), [730], "CONTROL: a working keyed pane may be mid-turn on it");
  assert.deepEqual(closedClaimDebris([row(KEYED)], idle(KEYED), Date.parse("2026-10-10T19:55:00Z")).kept.map((r) => r.number), [730], "CONTROL: inside the ten minutes it is held");
});
