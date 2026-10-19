// no-token: gh -- pure: `decide` and `withClosingRowOwners` over in-memory rows and pull requests; nothing reaches `gh`, `git` or the network
/**
 * #2882: AN UNLABELLED RED PULL REQUEST GOES TO THE SESSION ITS OWN ROW NAMES.
 *
 * #2880 (`Closes #2875`) was opened before its worktree was stamped, so it carried no `session:` label while row #2875
 * carried `session:worker-2875`, and `pr-checks-failing` went to `product-manager` six times. The POSITIVE CONTROL for
 * every "falls back to `ceo`" assertion (it was `product-manager` until #2941) is the same fixture with ONE thing changed -- the rows that DO name
 * one live session -- which is the first test; nothing here is asserted against an empty population.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { decide } from "./work-gate/tick/blocker-cleared-reading.ts";
import { withClosingRowOwners } from "./work-gate/pr-owners.ts";
import { testEach } from "./lib/test-each.ts";

type Fixture = Record<string, unknown>;

const RED = [{ name: "gate", status: "COMPLETED", conclusion: "FAILURE", startedAt: "2026-10-01T14:40:00Z" }];

const row = (number: number, ...labels: string[]) => ({ number, labels: labels.map((name) => ({ name })) });
const claimed = (number: number, session: string) => row(number, "in-progress", `session:${session}`);
const pr = (closes: number[], ...labels: string[]) => ({
  number: 2880, headRefOid: "24b0e94f00000000", isDraft: false, statusCheckRollup: RED, headRefName: "agent/an-unnamed-branch",
  labels: labels.map((name) => ({ name })), closingIssuesReferences: closes.map((number) => ({ number })),
});

/** The `pr-checks-failing` orders a tick builds for these pull requests and rows, through the same wiring `main` uses. */
function failingOrders(prs: Fixture[], openRows: Fixture[]) {
  return decide({ prs: withClosingRowOwners(prs, openRows), readyRows: [], openRows })
    .filter((order) => order.cause === "pr-checks-failing");
}

test("an unlabelled red PR whose closed row holds one live session is addressed to it, under a causeKey carrying it", () => {
  const [order, ...rest] = failingOrders([pr([2875])], [claimed(2875, "worker-2875")]);
  assert.equal(rest.length, 0);
  assert.equal(order.session, "worker-2875");
  assert.equal(order.causeKey, "worker-2875/pr-checks-failing/pr-2880/24b0e94f");
  assert.match(order.prompt, /row it closes \(#2875\) is held by you/);
});

/**
 * #5201: a PR with NO label whose closing row is not held is OWNER-GONE, to `product-manager`, not "nobody could be named": the row it
 * closes is open and unheld, or closed and absent from the open list. Only a row list that was not read, or a PR naming no row, is still `ceo`.
 */
type Order = ReturnType<typeof failingOrders>[number];

const OWNER_GONE = (order: Order) => {
  assert.equal(order.session, "product-manager");
  assert.equal(order.causeKey, "product-manager/pr-checks-failing/pr-2880/24b0e94f");
  assert.doesNotMatch(order.prompt, /NOBODY COULD BE NAMED/);
};

const FALLS_BACK = (order: Order) => {
  assert.equal(order.session, "ceo");
  assert.equal(order.causeKey, "ceo/pr-checks-failing/pr-2880/24b0e94f");
  assert.match(order.prompt, /NOBODY COULD BE NAMED/);
};

const FALLS_BACK_NOBODY_NAMED = (order: Order) => {
  assert.equal(order.session, "ceo");
  assert.match(order.prompt, /NOBODY COULD BE NAMED/);
};

const CLOSED_ROW_ROUTES: { name: string; openRows: Fixture[]; closes?: number[]; check: (order: Order) => void }[] = [
  { name: "an open row claimed by nobody is owner-gone (#5201)", openRows: [row(2875, "in-progress")], check: OWNER_GONE },
  {
    name: "a released claim is owner-gone (#5201)",
    openRows: [row(2875, "session:worker-2875")],
    check: OWNER_GONE,
  },
  {
    name: "a live row that is not the one this PR closes is owner-gone (#5201)",
    openRows: [claimed(9999, "worker-9999")],
    check: OWNER_GONE,
  },
  { name: "the rows were not read fall to ceo", openRows: [], check: FALLS_BACK },
  {
    name: "no closing reference falls to ceo",
    openRows: [claimed(2875, "worker-2875")],
    closes: [],
    check: FALLS_BACK,
  },
];

testEach("the same PR whose closed row nobody holds is owner-gone to product-manager, a released claim too; no read at all or no row named still falls to ceo", CLOSED_ROW_ROUTES, (c) => {
  const [order] = failingOrders([pr(c.closes ?? [2875])], c.openRows);
  c.check(order);
});

test("two rows naming two different sessions are a question, so ceo keeps it; two naming the SAME one are an answer", () => {
  const [split] = failingOrders([pr([2875, 2876])], [claimed(2875, "worker-2875"), claimed(2876, "worker-2876")]);
  assert.equal(split.session, "ceo");
  const [same] = failingOrders([pr([2875, 2876])], [claimed(2875, "worker-2875"), claimed(2876, "worker-2875")]);
  assert.equal(same.session, "worker-2875");
});

test("a PR WITH its own label keeps it, whatever the row says", () => {
  const [order] = failingOrders([pr([2875], "session:worker-1")], [claimed(2875, "worker-2875")]);
  assert.equal(order.session, "worker-1");
  assert.equal(order.causeKey, "worker-1/pr-checks-failing/pr-2880/24b0e94f");
  assert.match(order.prompt, /carries your session label/);
});

test("the NOT CONVINCED order takes the row's session too, and keeps ceo when the row names nobody", () => {
  const convinced = (closes: number[]) => ({
    ...pr(closes), statusCheckRollup: [{ name: "gate", status: "COMPLETED", conclusion: "SUCCESS" }],
    comments: [{ author: { login: "reviewer-2880" }, createdAt: "2026-10-01T15:00:00Z", body: "Re-read of `24b0e94f` -- **not convinced**." }],
  });
  const verdictOrders = (rows: Fixture[]) => decide({ prs: withClosingRowOwners([convinced([2875])], rows), readyRows: [], openRows: rows })
    .filter((order) => order.cause === "verdict-not-convinced");
  const [owned] = verdictOrders([claimed(2875, "worker-2875")]);
  assert.equal(owned?.session, "worker-2875");
  assert.match(owned.prompt, /row it closes \(#2875\) is held by you/);
  assert.equal(owned.causeKey.startsWith("worker-2875/verdict-not-convinced/"), true);
  const [unowned] = verdictOrders([]);
  assert.equal(unowned?.session, "ceo");
});

/**
 * #2928: THE BRANCH SUFFIX IS THE LAST AUTHORITY. #2925 (`agent/finish-the-move-to-2892`) said `Closes: none` because the
 * done-when was someone else's, so GitHub resolved no closing row and the order went to `product-manager` while
 * `worker-2892` sat idle. `row-claim claim <n> --branch=agent/<slug>-<n>` writes the suffix, so it names the row.
 * The positive control is the first test; every fallback below is the SAME fixture with one thing changed.
 */
const onBranch = (headRefName: string, ...labels: string[]) => ({ ...pr([], ...labels), headRefName });

const SUFFIX_ROW_CHECKS: { name: string; check: (order: Order, rest: Order[]) => void }[] = [
  { name: "one order", check: (_order, rest) => assert.equal(rest.length, 0) },
  { name: "to the row's session", check: (order) => assert.equal(order.session, "worker-2892") },
  {
    name: "under a causeKey carrying the session",
    check: (order) => assert.equal(order.causeKey, "worker-2892/pr-checks-failing/pr-2880/24b0e94f"),
  },
  {
    name: "names the branch and the row it was claimed for",
    check: (order) => assert.match(order.prompt, /branch `agent\/finish-the-move-to-2892` was claimed for row #2892, which is held by you/),
  },
];

testEach("a PR with no label and no closing row, on a branch whose suffix names a held row, goes to that row's session", SUFFIX_ROW_CHECKS, (c) => {
  const [order, ...rest] = failingOrders([onBranch("agent/finish-the-move-to-2892")], [claimed(2892, "worker-2892")]);
  c.check(order, rest);
});

/** #5201: a suffix naming a row nobody holds (open, or closed and absent from the open list) is owner-gone, `product-manager`, as above. */
const BRANCH_ROUTES: { name: string; headRefName: string; openRows: Fixture[]; check: (order: Order) => void }[] = [
  {
    name: "a held row that is not the suffix's is owner-gone",
    headRefName: "agent/finish-the-move-to-2892",
    openRows: [claimed(9999, "worker-9999")],
    check: OWNER_GONE,
  },
  {
    name: "a released claim on the suffix's row is owner-gone",
    headRefName: "agent/finish-the-move-to-2892",
    openRows: [row(2892, "session:worker-2892")],
    check: OWNER_GONE,
  },
  {
    name: "an unclaimed suffix row is owner-gone",
    headRefName: "agent/finish-the-move-to-2892",
    openRows: [row(2892, "in-progress")],
    check: OWNER_GONE,
  },
  { name: "the rows were not read fall to ceo", headRefName: "agent/finish-the-move-to-2892", openRows: [], check: FALLS_BACK_NOBODY_NAMED },
  {
    name: "no numeric suffix falls to ceo",
    headRefName: "agent/finish-the-move-to",
    openRows: [claimed(2892, "worker-2892")],
    check: FALLS_BACK_NOBODY_NAMED,
  },
  {
    name: "a number that is not the suffix falls to ceo",
    headRefName: "agent/2892-finish-the-move",
    openRows: [claimed(2892, "worker-2892")],
    check: FALLS_BACK_NOBODY_NAMED,
  },
  {
    name: "a branch that is not agent/ falls to ceo",
    headRefName: "feature/finish-the-move-to-2892",
    openRows: [claimed(2892, "worker-2892")],
    check: FALLS_BACK_NOBODY_NAMED,
  },
];

testEach("a branch whose suffix names a row nobody holds is owner-gone to product-manager; an unread row list, no numeric suffix or no `agent/` branch still falls to ceo", BRANCH_ROUTES, (c) => {
  const [order] = failingOrders([onBranch(c.headRefName)], c.openRows);
  c.check(order);
});

test("a closing row naming a different session than the suffix keeps the closing row's; a closing split stays a question", () => {
  const rows = [claimed(2875, "worker-2875"), claimed(2892, "worker-2892"), claimed(2893, "worker-2893")];
  const withCloses = (closes: number[]) => ({ ...pr(closes), headRefName: "agent/finish-the-move-to-2892" });
  const [closing] = failingOrders([withCloses([2875])], rows);
  assert.equal(closing.session, "worker-2875");
  assert.match(closing.prompt, /row it closes \(#2875\) is held by you/);
  const [split] = failingOrders([withCloses([2875, 2893])], rows);
  assert.equal(split.session, "ceo");
});

test("a PR WITH its own label keeps it over its branch suffix", () => {
  const [order] = failingOrders([onBranch("agent/finish-the-move-to-2892", "session:worker-1")], [claimed(2892, "worker-2892")]);
  assert.equal(order.session, "worker-1");
  const [labelled] = withClosingRowOwners([onBranch("agent/finish-the-move-to-2892", "session:worker-1")], [claimed(2892, "worker-2892")]);
  assert.equal("rowOwner" in labelled, false, "the row is not even looked up for a PR that carries its own label");
});

test("the suffix is read when GitHub's closing references were not, and the NOT CONVINCED order takes it too", () => {
  const unread: Fixture = onBranch("agent/finish-the-move-to-2892");
  delete unread.closingIssuesReferences;
  const [order] = failingOrders([unread], [claimed(2892, "worker-2892")]);
  assert.equal(order.session, "worker-2892");
  const convinced = {
    ...onBranch("agent/finish-the-move-to-2892"), statusCheckRollup: [{ name: "gate", status: "COMPLETED", conclusion: "SUCCESS" }],
    comments: [{ author: { login: "reviewer-2880" }, createdAt: "2026-10-01T15:00:00Z", body: "Re-read of `24b0e94f` -- **not convinced**." }],
  };
  const rows = [claimed(2892, "worker-2892")];
  const [verdict] = decide({ prs: withClosingRowOwners([convinced], rows), readyRows: [], openRows: rows })
    .filter((o) => o.cause === "verdict-not-convinced");
  assert.equal(verdict?.session, "worker-2892");
});
