// no-token: gh -- pure: `decide` and `withPrOwners` over in-memory rows and pull requests; the stamp reader is handed a stubbed `git` and a stubbed stamp file, so nothing here reaches `gh`, `git` or the network
/**
 * #2941: A RED PULL REQUEST HAS AN OWNER BY A TOTAL FUNCTION. #2912 routed an unlabelled red PR to the session its closed row
 * names and left every PR with NO row going to `product-manager`, who does not fix code. The class is "a red PR whose owner the
 * gate cannot name", so this DERIVES the population -- every shape of PR from a generated grid -- and asserts the answer
 * for each cell rather than for the three the author thought of.
 *
 * THE ORDER (`ownerOfPr`): label, the live session holding the row it closes, the live session holding the row its branch suffix
 * names, a live session the head ref names, a live session that stamped its worktree, else -- #4644 -- `product-manager` for a PR whose
 * label names an ENDED session and whose every row is closed or open and UNCLAIMED -- #4808 (`owner-gone`), else `ceo`. The ORACLE below is written
 * out here, from that sentence, and not derived from the implementation -- a grid compared with the code it tests agrees by
 * construction.
 *
 * POSITIVE CONTROLS: the first two tests are #2921's shape (a labelled draft) and a PR with no label, no row and an `agent/` branch,
 * each landing on the session the order says; the all-empty cell lands on `ceo`. The grid asserts its own CELL COUNT, so a grid
 * that shrinks to nothing is red rather than green (`.claude/rules/guards-and-assertions.md`).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, withPrOwners, readWorktreeStamps, stampLookup } from "../work-gate.ts";
import { ownerOfPr, UNOWNED_PR_SESSION } from "../work-gate/pr-orders.ts";

type Fixture = Record<string, unknown>;
type Order = { cause: string, session: string, causeKey: string, prompt: string };

const RED = [{ name: "gate", status: "COMPLETED", conclusion: "FAILURE", startedAt: "2026-10-01T14:40:00Z" }];
const GREEN = [{ name: "gate", status: "COMPLETED", conclusion: "SUCCESS" }];
const NOT_CONVINCED = [{ author: { login: "reviewer-2880" }, createdAt: "2026-10-01T15:00:00Z", body: "Re-read of `24b0e94f` -- **not convinced**." }];

const row = (number: number, ...labels: string[]) => ({ number, labels: labels.map((name) => ({ name })) });
const claimed = (number: number, session: string) => row(number, "in-progress", `session:${session}`);

/** The rows every cell shares: who is LIVE is a fact about the org, not about a cell, so it does not vary across the grid. */
const ROWS = [
  claimed(11, "worker-11"), claimed(12, "worker-12"), // the rows a PR may close; two sessions, so closing both is a split
  claimed(14, "worker-14"), // the row a `-14` branch suffix names, held
  row(15, "session:worker-15"), // the row a `-15` suffix names, RELEASED: the label outlived `in-progress`
  claimed(210, "worker-21"), // a live session a head ref can name
  claimed(310, "worker-31"), // a live session that can have stamped a worktree
  claimed(7, "worker-7"), // the label cell's own session, live or not it wins
];

const prOf = (head: string, over: Fixture = {}) => ({
  number: 2880, headRefOid: "24b0e94f00000000", isDraft: false, statusCheckRollup: RED, headRefName: head, labels: [],
  closingIssuesReferences: [], ...over,
});

const LABELS = { none: [], own: ["session:worker-7"], ended: ["session:worker-8"] } as const;
const CLOSING = { none: [], live: [11], split: [11, 12], closed: [13] } as const; // 13 is in no open row: its claim is gone
const BRANCHES = {
  plain: "agent/some-slug", suffixLive: "agent/some-slug-14", suffixReleased: "agent/some-slug-15",
  sessionLive: "agent/worker-21", sessionRetired: "agent/worker-99",
} as const;
const STAMPS = { none: null, live: "worker-31", retired: "worker-98" } as const;

type Cell = { label: keyof typeof LABELS, closing: keyof typeof CLOSING, branch: keyof typeof BRANCHES, stamp: keyof typeof STAMPS };

/** Every cell of the grid, generated from the dimensions above and not listed by hand. */
const CELLS: Cell[] = Object.keys(LABELS).flatMap((label) => Object.keys(CLOSING).flatMap((closing) =>
  Object.keys(BRANCHES).flatMap((branch) => Object.keys(STAMPS).map((stamp) => ({ label, closing, branch, stamp }))))) as Cell[];

/** What `main` hands `withPrOwners`: worker-8 is absent from herdr AND recorded by a teardown, so its label is dead (#3093); worker-7's stands. */
const ENDED = { agents: () => [] as string[], ended: () => new Map([["worker-8", 1]]), say: () => {} };

/**
 * The declared order, written out. A split is a question, so it skips the two row rungs and the order goes on below them. A DEAD label is no label
 * (#3093). #4644, #4808: every row the PR names is held by NOBODY -- closed (`13`) or open and unclaimed (`15`, whose `session:` label outlived its
 * `in-progress`) -- makes the dead owner's PR `product-manager`'s, below every rung that can name a live session.
 */
function expectedOwner({ label, closing, branch, stamp }: Cell): string {
  if (label === "own") return "worker-7";
  if (closing === "live") return "worker-11";
  if (closing !== "split" && branch === "suffixLive") return "worker-14";
  if (branch === "sessionLive") return "worker-21";
  if (stamp === "live") return "worker-31";
  return deadOwnersPr({ label, closing, branch }) ? "product-manager" : "ceo";
}

/**
 * A dead owner whose PR names at least one row and NO named row is held (#4644, #4808): the closing row `13` (closed), or -- when it closes none --
 * the number a branch ends in, which `rowsNamedBy` reads as a row whether or not the branch was a row's (`agent/worker-99` names row 99, closed;
 * `agent/some-slug-15` names row 15, open and unclaimed). A split names two HELD rows, so it is nobody's to flag, and a plain branch names none.
 * (A branch ending in `14` names a HELD row, which answers before this is asked.)
 */
function deadOwnersPr({ label, closing, branch }: Pick<Cell, "label" | "closing" | "branch">): boolean {
  if (label !== "ended" || closing === "split" || closing === "live") return false;
  return closing === "closed" || branch === "sessionRetired" || branch === "suffixReleased";
}

const pullRequestFor = (cell: Cell, over: Fixture = {}) => prOf(BRANCHES[cell.branch], {
  labels: LABELS[cell.label].map((name) => ({ name })),
  closingIssuesReferences: CLOSING[cell.closing].map((number) => ({ number })), ...over,
});

/** The orders a tick builds for this PR, through the SAME wiring `main` uses (`withPrOwners`). */
function ordersFor(pr: Fixture, stamp: string | null = null): Order[] {
  return decide({ prs: withPrOwners([pr], ROWS, () => stamp, ENDED), readyRows: [], openRows: ROWS });
}

test("POSITIVE CONTROL: #2921's shape, a LABELLED DRAFT, goes to the session its label names", () => {
  const [order, ...rest] = ordersFor(prOf("agent/an-unnamed-branch", { isDraft: true, labels: [{ name: "session:worker-7" }] }));
  assert.equal(rest.length, 0);
  assert.equal(order.session, "worker-7");
  assert.equal(order.causeKey, "worker-7/pr-checks-failing/pr-2880/24b0e94f");
});

test("POSITIVE CONTROL: no label, no row and an `agent/` branch naming a live session lands on that session; the all-empty PR lands on ceo", () => {
  const [named, ...rest] = ordersFor(prOf("agent/worker-21"));
  assert.equal(rest.length, 0);
  assert.equal(named.session, "worker-21");
  assert.match(named.prompt, /its branch `agent\/worker-21` names you/);
  const [empty] = ordersFor(prOf("agent/some-slug"));
  assert.equal(empty.session, "ceo");
  assert.equal(empty.causeKey, "ceo/pr-checks-failing/pr-2880/24b0e94f");
});

test("the grid: ownerOfPr names a session for EVERY cell, product-manager only for a dead owner's PR whose rows nobody holds, and the one the order says", () => {
  assert.equal(CELLS.length, 3 * 4 * 5 * 3, "the grid is the product of its dimensions: a shrunken one is red, not green");
  assert.equal(new Set(CELLS.map((c) => JSON.stringify(c))).size, CELLS.length, "and no cell is a duplicate");
  const reached = new Set<string>();
  for (const cell of CELLS) {
    const [order, ...rest] = ordersFor(pullRequestFor(cell), STAMPS[cell.stamp]);
    const where = JSON.stringify(cell);
    assert.equal(rest.length, 0, `${where}: exactly one failing-checks order`);
    assert.equal(order.cause, "pr-checks-failing", where);
    assert.equal(order.session, expectedOwner(cell), where);
    if (order.session === "product-manager") assert.equal(cell.label, "ended", `${where}: product-manager answers a dead owner's PR and nothing else (#4644)`);
    assert.equal(order.causeKey.startsWith(`${order.session}/pr-checks-failing/`), true, `${where}: the dedupe key moves with the session`);
    reached.add(order.session);
  }
  // THE POSITIVE CONTROL OF THE EMPTINESS ABOVE: every rung's session was actually answered by some cell.
  assert.deepEqual([...reached].sort(), ["ceo", "product-manager", "worker-11", "worker-14", "worker-21", "worker-31", "worker-7"]);
});

test("the same grid for the NOT CONVINCED order: it has an owner in every cell too, and the same one", () => {
  for (const cell of CELLS) {
    const pr = pullRequestFor(cell, { statusCheckRollup: GREEN, comments: NOT_CONVINCED });
    const orders = ordersFor(pr, STAMPS[cell.stamp]).filter((o) => o.cause === "verdict-not-convinced");
    assert.equal(orders.length, 1, JSON.stringify(cell));
    assert.equal(orders[0].session, expectedOwner(cell), JSON.stringify(cell));
  }
});

test("each rung SERVES a cell of its own: strip the rungs one at a time and the owner moves down the order", () => {
  // THE MUTATION, EXPRESSED IN THE FIXTURE. Removing a rung from `ownerOfPr` leaves the cell it served on the NEXT rung's
  // answer, which is the step this walks; the same walk is what goes red when a rung is deleted from the code (recorded on #2941).
  const everything = prOf("agent/worker-21-14", {
    labels: [{ name: "session:worker-7" }], closingIssuesReferences: [{ number: 11 }],
  });
  const steps: [string, Fixture, string][] = [
    ["label", everything, "worker-7"],
    ["closing-row", { ...everything, labels: [] }, "worker-11"],
    ["branch-row", { ...everything, labels: [], closingIssuesReferences: [] }, "worker-14"],
    ["branch-name", { ...everything, labels: [], closingIssuesReferences: [], headRefName: "agent/worker-21" }, "worker-21"],
    ["stamp", { ...everything, labels: [], closingIssuesReferences: [], headRefName: "agent/some-slug" }, "worker-31"],
    ["ceo", { ...everything, labels: [], closingIssuesReferences: [], headRefName: "agent/some-slug" }, "ceo"],
  ];
  for (const [source, pr, session] of steps) {
    const [order] = ordersFor(pr, source === "ceo" ? null : "worker-31");
    assert.equal(order.session, session, source);
    assert.equal(ownerOfPr(withPrOwners([pr], ROWS, () => (source === "ceo" ? null : "worker-31"), ENDED)[0]).source, source);
  }
});

test("the last rung is `ceo` and says WHICH PR, WHICH check and HOW LONG: the PR number, the red check and its age", () => {
  assert.equal(UNOWNED_PR_SESSION, "ceo");
  const [order] = ordersFor(prOf("agent/some-slug"));
  assert.match(order.prompt, /^#2880 at `24b0e94f` has FAILING checks and is blocked\. NOBODY COULD BE NAMED/);
  assert.match(order.prompt, /#2880 is red on gate since 2026-10-01T14:40:00Z \(\d+ min ago\)/);
  assert.match(order.prompt, /session:<name>/, "and the remedy is named: re-lane it, or close it");
});

test("a live session HOLDING NO CLAIM is not named by its branch or its stamp: the limit #2912 kept, and the PR falls to ceo", () => {
  // `isLiveSession` is not asked at gate load (#2174), so live means "holds a claim". Both rungs honour the same test.
  assert.equal(ordersFor(prOf("agent/worker-99"))[0].session, "ceo");
  assert.equal(ordersFor(prOf("agent/some-slug"), "worker-98")[0].session, "ceo");
});

test("a PR with its own label is never looked up: neither a row nor a stamp is read for it", () => {
  let reads = 0;
  const [labelled] = withPrOwners([prOf("agent/worker-21", { labels: [{ name: "session:worker-7" }] })], ROWS, () => { reads += 1; return "worker-31"; });
  assert.equal(reads, 0);
  assert.equal("branchOwner" in labelled || "stampOwner" in labelled, false);
});

test("the stamp read is LAZY AND ONCE: not at all when every PR is owned, one `git worktree list` when one is not", () => {
  let reads = 0;
  const lookup = stampLookup(() => { reads += 1; return new Map([["agent/some-slug", "worker-31"]]); });
  withPrOwners([prOf("agent/worker-21"), prOf("x", { labels: [{ name: "session:worker-7" }] })], ROWS, lookup);
  assert.equal(reads, 0, "every PR already had an owner: the host was never asked");
  withPrOwners([prOf("agent/some-slug"), prOf("agent/other-slug"), prOf("agent/third-slug")], ROWS, lookup);
  assert.equal(reads, 1, "three PRs reached the stamp rung and the host was read once");
});

test("readWorktreeStamps reads the branch each worktree has checked out and who stamped it; a refused git names nobody", () => {
  const porcelain = [
    "worktree /home/agent/repos/a11y-witness\nHEAD aaaa\nbranch refs/heads/main",
    "worktree /home/agent/repos/wt-31\nHEAD bbbb\nbranch refs/heads/agent/some-slug",
    "worktree /home/agent/repos/wt-unstamped\nHEAD cccc\nbranch refs/heads/agent/unstamped",
    "worktree /home/agent/repos/wt-detached\nHEAD dddd\ndetached",
  ].join("\n\n") + "\n";
  const stamps = readWorktreeStamps(() => porcelain, (path: string) => (path.endsWith("wt-31") ? "worker-31" : null));
  assert.deepEqual([...stamps!], [["agent/some-slug", "worker-31"]]);
  assert.equal(readWorktreeStamps(() => { throw new Error("fatal: not a git repository"); }), null);
  assert.equal(stampLookup(() => null)("agent/some-slug"), null, "an unreadable host is not a stamp");
});
