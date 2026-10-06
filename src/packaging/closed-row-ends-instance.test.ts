// no-token: gh -- every `gh`, `git`, `herdr` and `row-claim` call here is an injected seam; nothing imported reaches the real one
/**
 * #3535: A CLOSED ROW ENDS ITS INSTANCE.
 *
 * #3530 was claimed by `worker-3530` at 19:32:06Z, closed NOT_PLANNED 51 seconds later, and its claim labels came off by hand at 19:47:05Z, 14 min 8 s
 * after the close, with the instance still building. The gate had releases for `stalled`, `blocked`, `merged` and `gone`, and none for `closed`.
 *
 * EVERY CASE CALLS THE GATE'S OWN DECISION FOR A CLAIMED ROW (`closedClaimsNow`, and `claimStallsNow` for the open-row control), never a copy of it, and
 * THE CONTROL EVERY "NOTHING IS ORDERED" ASSERTION IS READ AGAINST is the same fixture with the row still open: it yields neither the release nor the
 * interrupt, so the closed row's two orders are not what any claimed row yields.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { claimStallsNow, claimStallTick, closedClaimsNow, closedClaimsWhenWorkerListed, readOpenRowFollowUps, GH_READS } from "../work-gate.mjs";
import { performRelease } from "../wake.mjs";
import { claimRecordComment } from "../row-claim.mjs";

type Agent = { label: string; status: string };
type Order = { session: string; cause: string; causeKey: string; release?: { row: number; session: string; why: string; interrupt?: boolean;
  branch: string | null; worktree: string | null } };

const REPO = "/home/agent/repos/a11y-witness";
const BRANCH = "agent/a-closed-row-ends-3535";
const NOW = Date.parse("2026-10-04T19:33:00Z");

const record = (session: string) => ({ body: claimRecordComment({ session, branch: BRANCH, worktree: "../wt-3535" }),
  createdAt: "2026-10-04T19:32:06Z", author: { login: "a11ign-ai-workers" } });

/** A CLOSED row as `gh issue list --state closed --label in-progress` returns it. */
const closedRow = (session: string, extra: object = {}) => ({ number: 3535, title: "a closed row ends its instance",
  labels: ["in-progress", "started", `session:${session}`].map((name) => ({ name })), comments: [record(session)], closedByPullRequestsReferences: [], ...extra });

/** The gate's decision for the closed rows of one tick, as `closedClaimsWhenWorkerListed` hands it over: the rows read, and herdr's listing they were decided with. */
function closedTick(rows: unknown[] | null, agents: Agent[] | null) {
  const log: string[] = [];
  const orders = closedClaimsNow({ rows: rows as never, agents }, { repo: REPO, log: (l) => { log.push(l); } }) as Order[];
  return { orders, log };
}

test("#3535 (2, 3) a row CLOSED while its worker-<n> is mid-turn yields the release AND the interrupt, in the one decision", () => {
  const { orders } = closedTick([closedRow("worker-3535")], [{ label: "worker-3535", status: "working" }]);
  assert.equal(orders.length, 1, "ONE order per row: the interrupt rides the release, so both happen on the first tick that sees the close");
  const [order] = orders;
  assert.equal(order.session, "worker-3535");
  assert.equal(order.cause, "claim-stalled");
  assert.deepEqual([order.release?.row, order.release?.why, order.release?.interrupt], [3535, "closed", true]);
  assert.equal(order.release?.branch, BRANCH, "the claim record's branch, so the worktree can be KEPT");
  assert.equal(order.release?.worktree, `/home/agent/repos/wt-3535`);
});

test("#3535 (4) CONTROL: the SAME row still OPEN yields neither the release nor the interrupt", () => {
  const open = { number: 3535, title: "t", labels: [{ name: "in-progress" }, { name: "session:worker-3535" }], body: "", blockedBy: { nodes: [] } };
  const git = (_dir: string, args: string[]) => {
    if (args[0] === "log") return { status: 0, out: `${Math.floor((NOW - 30_000) / 1000)}\n` };
    if (args[0] === "rev-list") return { status: 0, out: "0\n" };
    return { status: 0, out: "" };
  };
  const openTick = (now: number) => claimStallsNow([open], [{ number: 3535, comments: [record("worker-3535")] }], [], {
    tick: (inputs: object) => claimStallTick({ ...inputs, io: { git, exists: () => true, mtime: () => NOW - 30_000 }, repo: REPO, now, stateDir: "/nonexistent",
      agents: [{ label: "worker-3535", status: "working" }], restartAt: null, ledger: () => "", log: () => {}, read: () => ({}), write: () => {} } as never),
    merged: () => [], elsewhere: () => ({ open: [], merged: [] }), log: () => {} }) as Order[];
  assert.deepEqual(openTick(NOW), [], "an open row, claimed a minute ago and moving, is released and interrupted by nothing");
  // POSITIVE CONTROL FOR THAT EMPTINESS: the same fixture, three hours on with nothing moving, DOES evaluate and orders -- so the empty reading above is the
  // gate looking at a live claim and finding it healthy, not a fixture the tick could not read.
  const stalled = openTick(NOW + 3 * 60 * 60_000);
  assert.deepEqual(stalled.map((o) => [o.session, o.release?.why]), [["worker-3535", undefined]], "a nudge to the holder: an order, and not a closed release");
  // ...and the closed row, the only difference, IS released and interrupted: the two readings are not the same population.
  assert.equal(closedTick([closedRow("worker-3535")], [{ label: "worker-3535", status: "working" }]).orders[0].release?.interrupt, true);
});

test("#3535 (4) closed while the instance is IDLE: the release, and no interrupt", () => {
  const { orders } = closedTick([closedRow("worker-3535")], [{ label: "worker-3535", status: "idle" }]);
  assert.equal(orders.length, 1);
  assert.deepEqual([orders[0].release?.why, orders[0].release?.interrupt], ["closed", undefined], "nothing to stop between turns, and `spareDecision` ends it");
});

test("#3535 (4) closed with the row's state UNREADABLE (null): nothing is done, and it is reported as UNREAD", () => {
  const { orders, log } = closedTick(null, [{ label: "worker-3535", status: "working" }]);
  assert.deepEqual(orders, []);
  assert.match(log.join(""), /NOT read.*NOT evaluated/s, "said as unread: not as open, and not as closed");
  const none = closedTick([], [{ label: "worker-3535", status: "working" }]);
  assert.deepEqual([none.orders, none.log], [[], []], "CONTROL: an EMPTY read is a read -- nothing closed holds a claim, and nothing is said");
  const herdrDown = closedTick(null, null);
  assert.deepEqual(herdrDown.orders, []);
  assert.match(herdrDown.log.join(""), /herdr could not be asked/, "an unreadable herdr is said as such, not as an unread row list");
});

test("#3535 (4) closed with a STANDING SEAT as the holder: the release, and no interrupt", () => {
  const { orders } = closedTick([closedRow("worker-capture")], [{ label: "worker-capture", status: "working" }]);
  assert.equal(orders.length, 1);
  assert.deepEqual([orders[0].release?.session, orders[0].release?.why, orders[0].release?.interrupt], ["worker-capture", "closed", undefined]);
});

test("#3535 (5) NOT ASKED (herdr listed no worker-<n>) is null and orders nothing, and says nothing", () => {
  assert.deepEqual(closedClaimsNow(null), []);
});

test("#3535 herdr that cannot be asked is NOT idle: the release still happens, no interrupt, and it is said", () => {
  const { orders, log } = closedTick([closedRow("worker-3535")], null);
  assert.deepEqual([orders.length, orders[0].release?.interrupt], [1, undefined]);
  assert.match(log.join(""), /herdr's state of worker-3535 was not read/);
});

test("#3535 a row closed by its OWN merged pull request keeps the merged release it has: no closed order, and it is said", () => {
  const byPr = closedRow("worker-3535", { closedByPullRequestsReferences: [{ number: 3709 }] });
  const { orders, log } = closedTick([byPr], [{ label: "worker-3535", status: "working" }]);
  assert.deepEqual(orders, []);
  assert.match(log.join(""), /closed by its own pull request/);
});

// --- THE PERFORMER ----------------------------------------------------------------------------------------------------------

function performer(request: object, { spare = true, interruptFails = false }: { spare?: boolean; interruptFails?: boolean } = {}) {
  const runs: string[][] = [];
  const execs: string[][] = [];
  const comments: string[] = [];
  const cycles: { role: string; released?: string }[] = [];
  const kept: string[] = [];
  const dropped: string[] = [];
  const warns: string[] = [];
  const deps = {
    run: (args: string[]) => { runs.push(args); if (interruptFails && args.includes("send-keys")) throw new Error("herdr: refused"); return ""; },
    exec: (_cmd: string, args: string[]) => { execs.push(args); return { status: 0, output: "DECLINED -- #3535 is unclaimed again (closed: nothing restored)\n" }; },
    io: { git: (_d: string, args: string[]) => (args[0] === "rev-list" ? { status: 0, out: "2\n" } : args[0] === "status" ? { status: 0, out: " M a.mjs\n" }
      : { status: 0, out: "" }), exists: () => true, mtime: () => NOW - 60_000, cloneOf: () => ({ clone: REPO }) },
    now: NOW, agents: [{ label: "worker-3535", status: "working" }], isSpare: () => spare,
    host: { worktreesDir: "/home/agent/repos", primary: REPO, exists: () => true }, env: {}, warn: (l: string) => { warns.push(l); },
    gh: (a: string[]) => { if (a[1] === "view") return JSON.stringify({ labels: [{ name: "session:worker-3535" }] }); if (a[1] === "comment") comments.push(a.join(" ")); return ""; },
    cycle: (c: { role: string; released?: string }) => { cycles.push(c); }, dropInstance: (r: string) => { dropped.push(r); return { spawnedAt: 1, rows: [3535] }; },
    keepInstance: (r: string, row: number) => { kept.push(r); return { spawnedAt: 1, rows: [row] }; },
    remember: () => {},
  };
  const got = performRelease({ row: 3535, session: "worker-3535", why: "closed", branch: BRANCH, worktree: "/home/agent/repos/wt-3535", idleMinutes: null,
    nudgedAt: null, ...request } as never, deps as never);
  return { got, runs, execs, comments, cycles, kept, dropped, warns };
}

test("#3535 (2) the performer STOPS a working instance with Escape and no prompt, releases the claim KEEPING the work, and does not close the workspace", () => {
  const r = performer({ interrupt: true });
  assert.equal(r.got.released, true, JSON.stringify(r.got));
  assert.deepEqual(r.runs.filter((a) => a.includes("send-keys")), [["--session", "org", "agent", "send-keys", "worker-3535", "esc"]]);
  assert.equal(r.runs.some((a) => a.includes("prompt")), false, "no prompt: a prompt is a wake");
  assert.equal(r.runs.some((a) => a.includes("close")), false, "the workspace is left for `spareDecision`, which ends an instance holding no open row");
  const decline = r.execs.find((a) => a[1] === "decline")!;
  assert.deepEqual(decline.slice(1), ["decline", "3535", "--session=worker-3535", "--keep-worktree"], "the work in the tree is kept: a closed row's holder is not refused for holding some");
  assert.match(r.comments[0], /Claim released by the gate.*CLOSED.*interrupted.*NOT back in the pool/s);
  assert.deepEqual(r.cycles.map((c) => [c.role, c.released]), [["worker-3535", "closed"]], "ONE spare-ledger line, with the release reason `closed`");
  assert.deepEqual([r.kept, r.dropped], [["worker-3535"], []], "the registry entry STAYS (with the row), so the instance is ended as a finished one and not as one that never claimed");
});

test("#3535 CONTROL: an idle instance's release sends no interrupt; a standing seat's order is never interrupted even if it asks", () => {
  const idle = performer({});
  assert.equal(idle.got.released, true);
  assert.equal(idle.runs.some((a) => a.includes("send-keys")), false);
  const seat = performer({ interrupt: true }, { spare: false });
  assert.equal(seat.got.released, true);
  assert.equal(seat.runs.some((a) => a.includes("send-keys")), false, "`isSpare` is the performer's own check, so a seat is never interrupted by this cause");
  assert.deepEqual(seat.cycles, [], "and a standing seat has no spare-ledger line");
});

test("#3535 an interrupt herdr refuses is NOT a release: nothing is changed and the next tick asks again", () => {
  const r = performer({ interrupt: true }, { interruptFails: true });
  assert.equal(r.got.released, false);
  assert.match(r.got.why, /could not be interrupted -- nothing was changed/);
  assert.deepEqual(r.execs, [], "the claim was not declined");
  assert.match(r.warns.join(""), /could not be interrupted/);
});

// --- THE READ IS CONDITIONAL (Done-when 5) -----------------------------------------------------------------------------------

type Call = { args: string[]; repo: string | undefined };
const isClosedClaimRead = (args: string[]) => args[0] === "api" && args[1] === "graphql" && args.some((a) => a.includes("issue(number:"));
const OPEN_ROWS = [{ number: 41, title: "open row", labels: [{ name: "ready" }], body: "", blockedBy: { nodes: [] }, updatedAt: "2026-10-06T05:00:00Z" }];

/** What GraphQL answers for the listed workers' rows: `state` and `labels` decide which come back as a closed claim. */
const issue = (number: number, state: string, labels: string[]) => ({ number, state, labels: { nodes: labels.map((name) => ({ name })) },
  comments: { nodes: [record(`worker-${number}`)] }, closedByPullRequestsReferences: { nodes: [] as { number: number }[] } });
const graphql = (...issues: ReturnType<typeof issue>[]) => JSON.stringify({ data: { repository: Object.fromEntries(issues.map((i) => [`r${i.number}`, i])) } });
const CLAIM = ["in-progress", "started", "session:worker-3535"];

/** Every `gh` call one `readOpenRowFollowUps` makes, batched or not, with herdr's listing handed in. */
function followUps(agents: Agent[] | null, answer: (args: string[]) => string = () => "[]") {
  const seen: Call[] = [];
  const batches: Call[][] = [];
  const batch = (calls: Call[]) => { batches.push(calls); return calls.map((c) => ({ stdout: answer(c.args) })); };
  const run = (args: string[], repo?: string) => { seen.push({ args, repo }); return answer(args); };
  const got = readOpenRowFollowUps(OPEN_ROWS, run as never, batch as never, () => agents) as { closedClaims: ReturnType<typeof closedClaimsWhenWorkerListed> };
  const asked = [...batches.flat(), ...seen].filter((c) => isClosedClaimRead(c.args));
  return { got, asked, batches };
}

test("#3535 (5) herdr lists NO worker-<n> (only standing seats): the closed-claim read is NOT made, and the result is null (not asked)", () => {
  const { got, asked } = followUps([{ label: "ceo", status: "working" }, { label: "orchestrator", status: "idle" }, { label: "worker-3", status: "idle" }]);
  assert.deepEqual(asked, [], "no gh call for the closed claims (`worker-3` is below the family's first number, so it is no instance)");
  assert.equal(got.closedClaims, null);
  assert.equal(closedClaimsWhenWorkerListed([], () => { throw new Error("must not be asked"); }), null);
});

test("#3535 (5) CONTROL: herdr lists worker-<n>: the SAME read IS made, ONCE, for THOSE rows' numbers only, in the follow-ups' own batch", () => {
  const agents = [{ label: "ceo", status: "idle" }, { label: "worker-3535", status: "working" }, { label: "worker-3600", status: "idle" }];
  const { got, asked, batches } = followUps(agents, (args) => (isClosedClaimRead(args) ? graphql(issue(3535, "CLOSED", CLAIM), issue(3600, "OPEN", CLAIM)) : "[]"));
  assert.equal(asked.length, 1, "exactly one call for every listed instance's row");
  const query = asked[0].args.find((a) => a.startsWith("query="))!;
  assert.deepEqual([...query.matchAll(/issue\(number: (\d+)\)/g)].map((m) => m[1]), ["3535", "3600"], "the listed workers' rows, and no other row");
  assert.deepEqual(got.closedClaims?.rows?.map((r) => r.number), [3535], "only the CLOSED row that still carries the claim: worker-3600's row is open");
  assert.deepEqual(got.closedClaims?.agents, agents, "with the listing the interrupt is decided from");
  assert.ok(batches.some((b) => b.some((c) => isClosedClaimRead(c.args))), "asked together with the other follow-ups, not after them");
});

test("#3535 (5) a listed worker's row that is closed WITHOUT the claim label, or does not exist, is not a closed claim", () => {
  const agents = [{ label: "worker-3535", status: "working" }, { label: "worker-3600", status: "working" }];
  const rows = (answer: string) => closedClaimsWhenWorkerListed(agents, () => answer)?.rows;
  assert.deepEqual(rows(graphql(issue(3535, "CLOSED", ["started"]), issue(3600, "CLOSED", ["in-progress", "session:worker-3600"])))?.map((r) => r.number), [3600]);
  assert.deepEqual(rows(JSON.stringify({ data: { repository: { r3535: null, r3600: null } } })), [], "an absent row is no claim");
});

test("#3535 (5) the shape the decision reads: labels, the claim record's comments and the closing pull requests", () => {
  const [row] = closedClaimsWhenWorkerListed([{ label: "worker-3535", status: "working" }], () => graphql(issue(3535, "CLOSED", CLAIM)))!.rows!;
  const { orders } = closedTick([row], [{ label: "worker-3535", status: "working" }]);
  assert.deepEqual([orders[0].release?.branch, orders[0].release?.interrupt], [BRANCH, true], "the claim record is found in the comments as the read returns them");
  const byPr = { ...issue(3535, "CLOSED", CLAIM), closedByPullRequestsReferences: { nodes: [{ number: 3709 }] } };
  const [merged] = closedClaimsWhenWorkerListed([{ label: "worker-3535", status: "working" }], () => graphql(byPr))!.rows!;
  assert.deepEqual(closedTick([merged], [{ label: "worker-3535", status: "working" }]).orders, [], "a row closed by its own pull request is left to the merged release");
});

test("#3535 (5) the call is refused, or herdr is unreadable: UNREAD (rows null), never an empty list and never 'not asked'", () => {
  const agents = [{ label: "worker-9", status: "working" }];
  const refused = () => { throw Object.assign(new Error("Command failed: gh"), { status: 1, stderr: "HTTP 502", stdout: "" }); };
  assert.deepEqual(closedClaimsWhenWorkerListed(agents, refused), { rows: null, agents });
  assert.deepEqual(closedClaimsWhenWorkerListed(agents, () => "not json"), { rows: null, agents });
  assert.deepEqual(closedClaimsWhenWorkerListed(agents, () => JSON.stringify({ data: null })), { rows: null, agents });
  assert.deepEqual(closedClaimsWhenWorkerListed(null, () => "[]"), { rows: null, agents: null });
});

test("#3535 (5) the read is counted in GH_READS as conditional on a listed worker, and is NOT one of the unconditional reads", () => {
  assert.match(GH_READS.conditionalOnListedWorker, /readClosedClaimedRows/);
  assert.match(GH_READS.conditionalOnListedWorker, /worker-<n>/);
  assert.ok(!GH_READS.unconditional.some((r: string) => r.includes("readClosedClaimedRows")));
});

test("#3535 the gate's `main` hands the follow-ups' closed claims to the orders: the read is not dropped between the wave and `decide`", () => {
  const main = readFileSync(new URL("../work-gate.mjs", import.meta.url), "utf8");
  assert.match(main, /const \{[^}]*\bclosedClaims\b[^}]*\} = readOpenRowFollowUps\(allOpen\)/, "read in the follow-ups' wave");
  assert.match(main, /withClosedClaims\(claimStallsWithFacts\(openRowsRead, claimedComments, prs, otherScopes\), closedClaims\)/, "and handed to the orders");
  assert.match(main, /\.\.\.closedClaimsNow\(closedClaims\)/, "which turns them into orders beside the open claims' own");
});
