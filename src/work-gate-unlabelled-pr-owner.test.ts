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
import { decide, withClosingRowOwners } from "./work-gate.ts";

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

test("the same PR with rows naming nobody, a released claim, no read at all or an unlisted row still falls to ceo", () => {
  const fallsBack = (openRows: Fixture[], closes = [2875]) => {
    const [order] = failingOrders([pr(closes)], openRows);
    assert.equal(order.session, "ceo");
    assert.equal(order.causeKey, "ceo/pr-checks-failing/pr-2880/24b0e94f");
    assert.match(order.prompt, /NOBODY COULD BE NAMED/);
  };
  fallsBack([row(2875, "in-progress")]); // claimed by nobody
  fallsBack([row(2875, "session:worker-2875")]); // a released claim: the label outlived `in-progress`
  fallsBack([]); // the rows were not read
  fallsBack([claimed(9999, "worker-9999")]); // a live row, but not the one this PR closes
  fallsBack([claimed(2875, "worker-2875")], []); // GitHub resolved no closing reference
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

test("a PR with no label and no closing row, on a branch whose suffix names a held row, goes to that row's session", () => {
  const [order, ...rest] = failingOrders([onBranch("agent/finish-the-move-to-2892")], [claimed(2892, "worker-2892")]);
  assert.equal(rest.length, 0);
  assert.equal(order.session, "worker-2892");
  assert.equal(order.causeKey, "worker-2892/pr-checks-failing/pr-2880/24b0e94f");
  assert.match(order.prompt, /branch `agent\/finish-the-move-to-2892` was claimed for row #2892, which is held by you/);
});

test("a branch naming no held row, a released claim, an unread row list or no numeric suffix still falls to ceo", () => {
  const fallsBack = (headRefName: string, openRows: Fixture[]) => {
    const [order] = failingOrders([onBranch(headRefName)], openRows);
    assert.equal(order.session, "ceo");
    assert.match(order.prompt, /NOBODY COULD BE NAMED/);
  };
  fallsBack("agent/finish-the-move-to-2892", [claimed(9999, "worker-9999")]); // a held row, but not the suffix's
  fallsBack("agent/finish-the-move-to-2892", [row(2892, "session:worker-2892")]); // released: the label outlived `in-progress`
  fallsBack("agent/finish-the-move-to-2892", [row(2892, "in-progress")]); // claimed by nobody
  fallsBack("agent/finish-the-move-to-2892", []); // the rows were not read
  fallsBack("agent/finish-the-move-to", [claimed(2892, "worker-2892")]); // no numeric suffix
  fallsBack("agent/2892-finish-the-move", [claimed(2892, "worker-2892")]); // a number that is not the SUFFIX
  fallsBack("feature/finish-the-move-to-2892", [claimed(2892, "worker-2892")]); // not an `agent/` branch
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
