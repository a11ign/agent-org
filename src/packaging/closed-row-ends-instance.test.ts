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
import { claimStallsNow, claimStallTick, closedClaimsNow, closedClaimsWhenWorkerListed, readOpenRowFollowUps, GH_READS,
  closedClaimLabelsWhenListed, closedClaimDebris, stripClosedClaims } from "../work-gate.ts";
import { labelsToStrip as labelsToStripOfLeaf, stripClaimLabelsVia } from "../claim-label-strip.ts";
import { labelsToStrip as labelsToStripOfCloser } from "../close-rows-for-merged-pr.ts";
import { performRelease } from "../wake.ts";
import { afterTsx } from "../tsx-import.ts";
import { claimRecordComment } from "../row-claim.ts";

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
  const byPr = closedRow("worker-3535", { closedByPullRequestsReferences: [{ number: 313, headRefName: BRANCH, title: "A closed row ends its instance (a11ign/a11ign#3535)" }] });
  const { orders, log } = closedTick([byPr], [{ label: "worker-3535", status: "working" }]);
  assert.deepEqual(orders, []);
  assert.match(log.join(""), /closed by its own pull request \(#313\)/);
});

test("#3535 (review of #313) a row closed by SOMEBODY ELSE'S pull request still releases, and interrupts the working instance", () => {
  const elsewhere = { number: 3709, headRefName: "agent/some-other-work-3600", title: "Another row's work (a11ign/a11ign#3600)" };
  const byOther = closedRow("worker-3535", { closedByPullRequestsReferences: [elsewhere] });
  const { orders, log } = closedTick([byOther], [{ label: "worker-3535", status: "working" }]);
  assert.deepEqual([orders.length, orders[0]?.release?.why, orders[0]?.release?.interrupt], [1, "closed", true]);
  assert.doesNotMatch(log.join(""), /closed by its own pull request/);
});

test("#3535 (review of #313) the claimant's pull request among several closing references is still its own: the merged release keeps it", () => {
  const refs = [{ number: 3709, headRefName: "agent/some-other-work-3600", title: "x" }, { number: 313, headRefName: BRANCH, title: "y" }];
  assert.deepEqual(closedTick([closedRow("worker-3535", { closedByPullRequestsReferences: refs })], [{ label: "worker-3535", status: "working" }]).orders, []);
  const bySuffix = [{ number: 5, headRefName: "agent/renamed-branch-3535", title: "z" }];
  assert.deepEqual(closedTick([closedRow("worker-3535", { closedByPullRequestsReferences: bySuffix })], null).orders, [], "the row-suffix rung, as the merged release reads it");
});

test("#3535 (review of #313) a closing reference that names no head and no title cannot be called the claimant's: the release happens", () => {
  const bare = closedRow("worker-3535", { closedByPullRequestsReferences: [{ number: 3709 }] });
  assert.equal(closedTick([bare], [{ label: "worker-3535", status: "working" }]).orders.length, 1);
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
  const decline = r.execs.map(afterTsx).find((a) => a[1] === "decline")!;
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
  assert.match(query, /closedByPullRequestsReferences\([^)]*\) \{ nodes \{ number headRefName title \}/, "each closing pull request with the head and title that say whose it is");
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
  const byPr = { ...issue(3535, "CLOSED", CLAIM), closedByPullRequestsReferences: { nodes: [{ number: 313, headRefName: BRANCH, title: "t" }] } };
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
  const main = readFileSync(new URL("../work-gate.ts", import.meta.url), "utf8");
  assert.match(main, /const \{[^}]*\bclosedClaims\b[^}]*\} = readOpenRowFollowUps\(allOpen\)/, "read in the follow-ups' wave");
  assert.match(main, /withClosedClaims\(claimStallsWithFacts\(openRowsRead, claimedComments, prs, otherScopes\), closedClaims\)/, "and handed to the orders");
  assert.match(main, /\.\.\.closedClaimsNow\(closedClaims, \{ trackerRepo: repoNow\(\) \}\)/, "which turns them into orders beside the open claims' own");
});

// --- #3883: THE LABELS OF A CLOSED ROW WHOSE HOLDER IS NOT LISTED ----------------------------------------------------------------------------------------

/** The org as herdr lists it: both standing panes (a COMPLETE listing) and whatever else is passed. */
const org = (...others: string[]): Agent[] => ["ceo", "orchestrator", ...others].map((label) => ({ label, status: "idle" }));
const stale = (number: number, ...names: string[]) => ({ number, labels: names.map((name) => ({ name })) });
const DEBRIS = ["in-progress", "started", "session:worker-9", "was-ready", "answer:ceo"];

/** One tick's act: the `gh issue edit` calls it made, what it said on its log, and how many rows it reports stripped. */
function stripTick(asked: Parameters<typeof stripClosedClaims>[0]) {
  const edits: string[][] = [];
  const said: string[] = [];
  const stripped = stripClosedClaims(asked, { gh: (args) => { edits.push(args); return ""; }, say: (l) => { said.push(l); }, repo: "a11ign/a11ign" });
  return { edits, said, stripped };
}
const removed = (args: string[]) => args.flatMap((a, i) => (args[i - 1] === "--remove-label" ? [a] : []));

test("#3883 (1) a CLOSED row whose `session:` holder herdr does NOT list loses in-progress, started and session:*, and keeps was-ready and answer:*", () => {
  const { edits, stripped } = stripTick({ rows: [stale(3866, ...DEBRIS)], agents: org("worker-1") });
  assert.equal(edits.length, 1, "one edit for the row");
  assert.deepEqual(edits[0].slice(0, 5), ["issue", "edit", "3866", "--repo", "a11ign/a11ign"]);
  assert.deepEqual(removed(edits[0]), ["in-progress", "started", "session:worker-9"], "the close path's own list: `answer:*` is a live debt and `was-ready` a record");
  assert.equal(stripped, 1);
});

test("#3883 (2) a closed row whose holder IS listed (in any status) is LEFT ALONE and NAMED on the log", () => {
  const agents = [...org(), { label: "worker-9", status: "blocked" }];
  const { edits, said, stripped } = stripTick({ rows: [stale(3000, "in-progress", "session:worker-9")], agents });
  assert.deepEqual([edits, stripped], [[], 0], "nothing edited");
  assert.ok(said.some((l) => /#3000 keeps its claim labels: worker-9 is listed/.test(l)), `named: ${said.join("|")}`);
});

test("#3883 (3) both in ONE tick, and a row with `in-progress` but NO `session:` label has no holder to be listed: it is stripped", () => {
  const rows = [stale(1, "in-progress", "session:orchestrator"), stale(2, "in-progress", "session:worker-9"), stale(3, "in-progress", "started")];
  const { edits, stripped } = stripTick({ rows, agents: org() });
  assert.deepEqual(edits.map((e) => e[2]), ["2", "3"], "the listed seat's row (#1) is untouched; the unlisted holder's and the holderless row go");
  assert.equal(stripped, 2);
  assert.deepEqual(closedClaimDebris(rows, org()).kept, [{ number: 1, holders: ["orchestrator"] }]);
});

// --- #3900: A STANDING SEAT IS ALWAYS LISTED, SO ITS HOLD ON A CLOSED ROW ENDS A DAY AFTER THE CLOSE --------------------------------------------------------

const TICK = Date.parse("2026-10-07T12:00:00Z");
const closedAgo = (hours: number) => new Date(TICK - hours * 3600_000).toISOString();
const closed = (number: number, holder: string, closedAt: string | undefined) => ({ ...stale(number, "in-progress", "started", `session:${holder}`), closedAt });
const tick = (rows: ReturnType<typeof closed>[]) => {
  const edits: string[][] = [];
  const said: string[] = [];
  const stripped = stripClosedClaims({ rows, agents: org("worker-3900") },
    { gh: (args) => { edits.push(args); return ""; }, say: (l) => { said.push(l); }, repo: "a11ign/a11ign", nowMs: TICK });
  return { edits, said, stripped };
};

test("#3900 (1) a standing seat's row closed 3 days ago is STRIPPED, said once as stripped and never as the keeps line", () => {
  const { edits, said, stripped } = tick([closed(3164, "ceo", closedAgo(72))]);
  assert.deepEqual(removed(edits[0]), ["in-progress", "started", "session:ceo"]);
  assert.equal(stripped, 1);
  assert.ok(said.some((l) => /#3164 stripped/.test(l)), said.join("|"));
  assert.ok(!said.some((l) => /keeps its claim labels/.test(l)), "the repeating line is gone");
});

test("#3900 (2) the same seat's row closed 1 hour ago is KEPT and named", () => {
  const { edits, said, stripped } = tick([closed(3164, "ceo", closedAgo(1))]);
  assert.deepEqual([edits, stripped], [[], 0]);
  assert.ok(said.some((l) => /#3164 keeps its claim labels: ceo is listed/.test(l)), said.join("|"));
});

test("#3900 (3) a LISTED worker's row closed 3 days ago is KEPT: the grace is for standing seats only", () => {
  const { edits, said, stripped } = tick([closed(3900, "worker-3900", closedAgo(72))]);
  assert.deepEqual([edits, stripped], [[], 0]);
  assert.ok(said.some((l) => /#3900 keeps its claim labels: worker-3900 is listed/.test(l)), said.join("|"));
});

test("#3900 (4) a missing or unparseable `closedAt` is KEPT: fail toward not stripping a label", () => {
  const { edits, stripped } = tick([closed(1, "ceo", undefined), closed(2, "orchestrator", "not a date")]);
  assert.deepEqual([edits, stripped], [[], 0]);
});

test("#3883 (4) NOT ASKED and UNREAD are said as such and strip NOTHING -- absence of a listing is not an unlisted holder", () => {
  const notAsked = stripTick(null);
  const unread = stripTick({ rows: null, agents: org() });
  for (const t of [notAsked, unread]) assert.deepEqual([t.edits, t.stripped], [[], 0]);
  assert.match(notAsked.said.join(), /NOT read.*listing was missing or incomplete/);
  assert.match(unread.said.join(), /NOT read.*refused/);
});

test("#3883 (5) a failed edit is said, counted as NOT stripped, and does not stop the next row", () => {
  const said: string[] = [];
  const gh = (args: string[]) => { if (args[2] === "7") throw new Error("HTTP 502"); return ""; };
  const stripped = stripClosedClaims({ rows: [stale(7, "in-progress"), stale(8, "in-progress")], agents: org() }, { gh, say: (l) => { said.push(l); }, repo: "r/r" });
  assert.equal(stripped, 1);
  assert.ok(said.some((l) => /#7 closed but COULD NOT STRIP in-progress -- HTTP 502/.test(l)));
  assert.ok(said.some((l) => /#8 stripped in-progress/.test(l)));
});

test("#3883 (6) the read: asked once, labels only, closed + in-progress, and ONLY with a COMPLETE listing (a partial listing reads every live holder as absent)", () => {
  const seen: string[][] = [];
  const run = (args: string[]) => { seen.push(args); return JSON.stringify([stale(1, "in-progress")]); };
  assert.equal(closedClaimLabelsWhenListed(null, run), null);
  assert.equal(closedClaimLabelsWhenListed([{ label: "worker-9", status: "idle" }], run), null, "neither standing pane listed");
  assert.equal(seen.length, 0, "no call made for either");
  const asked = closedClaimLabelsWhenListed(org(), run)!;
  assert.deepEqual(asked.rows, [stale(1, "in-progress")]);
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0].slice(0, 6), ["issue", "list", "--state", "closed", "--label", "in-progress"]);
  assert.equal(seen[0][seen[0].indexOf("--json") + 1], "number,labels,closedAt", "no comments: the page is the debris and nothing else");
  assert.deepEqual(closedClaimLabelsWhenListed(org(), () => { throw new Error("502"); })?.rows, null, "a refusal is null, never []");
  assert.deepEqual(closedClaimLabelsWhenListed(org(), () => "{}")?.rows, null);
});

test("#3883 (7) the follow-ups' wave makes the read once, from the SAME listing it hands #3535 (a second herdr read would be a second answer)", () => {
  const { batches } = followUps(org("worker-3535"), (args) => (args.includes("number,labels,closedAt") ? JSON.stringify([stale(5, "in-progress")]) : "[]"));
  const asked = batches.flat().filter((c) => c.args.includes("--state") && c.args.includes("closed") && c.args.includes("in-progress") && c.args.includes("number,labels,closedAt"));
  assert.equal(asked.length, 1);
  const calls: Call[] = [];
  const got = readOpenRowFollowUps(OPEN_ROWS, ((args: string[]) => { calls.push({ args, repo: undefined }); return "[]"; }) as never, undefined as never, undefined as never) as { closedClaimLabels: unknown };
  assert.equal(got.closedClaimLabels, null, "a test's `gh` stub carries no herdr listing: not asked, so not 'unlisted'");
});

test("#3883 (8) ONE COPY: the gate strips through the leaf, the close path re-exports it, and the gate does not import the close path", () => {
  assert.equal(labelsToStripOfCloser, labelsToStripOfLeaf);
  const said: string[] = [];
  assert.equal(stripClaimLabelsVia(1, ["answer:x", "was-ready"], "r/r", { gh: () => { throw new Error("must not be called"); }, say: (l) => { said.push(l); } }), "nothing");
  assert.equal(stripClaimLabelsVia(1, ["in-progress"], "r/r", { gh: () => "", say: (l) => { said.push(l); }, logPrefix: "SWEEP" }), "stripped");
  assert.match(said[0], /^SWEEP: #1 stripped in-progress\.$/);
  const gate = readFileSync(new URL("../work-gate.ts", import.meta.url), "utf8");
  assert.doesNotMatch(gate, /from "\.\/close-rows-for-merged-pr\.ts"/, "its import closure must stay loadable with no roles dir (#2174)");
  assert.match(gate, /import \{ stripClaimLabelsVia \} from "\.\/claim-label-strip\.ts"/);
  assert.match(gate, /const strippedClosedClaims = stripClosedClaims\(closedClaimLabels\)/, "and main acts on what the wave read");
});

test("#3883 (9) the read is counted in GH_READS", () => {
  assert.match(GH_READS.conditionalOnCompleteHerdrListing, /readClosedClaimLabelRows/);
  assert.match(GH_READS.conditionalOnCompleteHerdrListing, /--state closed --label in-progress/);
});
