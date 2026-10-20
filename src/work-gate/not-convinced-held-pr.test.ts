// no-token: gh -- pure: `decide` and `withClosingRowOwners` over in-memory rows and pull requests; nothing reaches `gh`, `git` or the network
/**
 * agent-org#1466: A PULL REQUEST HELD ON A DECLARED WAIT GETS NO NOT CONVINCED REWORK ORDER, FOR AS LONG AS THE HOLD OR THE WAIT STANDS.
 *
 * THE READING, 2026-10-15: a11ign#5496 carried `hold:orchestrator` and `Waiting-for: closed a11ign/agent-org#1426`, and its reviewer had returned NOT CONVINCED at
 * the head. The order builder read no hold, so the verdict was re-ordered every tick until `MAX_DELIVERIES` (6) escalated it to `ceo`, for a wait that was a field
 * the tick already read. `failingChecksOrder` has excused a held or waiting PR since #2376 and #4606; this is the same exemption on the verdict path.
 *
 * THE POSITIVE CONTROL is the first test: the SAME pull request with no hold and no wait is ordered, so an empty result in the held cases is a reading of a wired
 * dispatch and not of a fixture that never reaches it. Each negative differs from that control by ONE fact. The ENDINGS are asserted as well: the hold removed, the
 * edge closed, and a new head each bring the order back on the next tick. A convinced verdict on a held pull request is not a rework and is left as it was.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { decide } from "./tick/tick-decisions-and-flags.ts";
import { withClosingRowOwners } from "./pr-owners.ts";

type Fixture = Record<string, any>;

const HEAD = "24b0e94f00000000";
const NEW_HEAD = "9d1c2e7a00000000";
const GREEN = [{ name: "gate", status: "COMPLETED", conclusion: "SUCCESS", startedAt: "2026-10-15T10:00:00Z" }];
const NOT_CONVINCED = [{ author: { login: "reviewer-2880" }, createdAt: "2026-10-15T10:30:00Z", body: "Re-read of `24b0e94f` -- **not convinced**." }];
const CONVINCED = [{ author: { login: "reviewer-2880" }, createdAt: "2026-10-15T10:30:00Z", body: "Re-read of `24b0e94f` -- **convinced**." }];
/** A NOT CONVINCED verdict on `sha`: a verdict is about one head, so a new head needs its own. */
const verdictAt = (sha: string) => [{ author: { login: "reviewer-2880" }, createdAt: "2026-10-15T10:30:00Z", body: `Re-read of \`${sha.slice(0, 8)}\` -- **not convinced**.` }];

const row = (number: number, ...labels: string[]) => ({ number, labels: labels.map((name) => ({ name })) });
const claimed = (number: number, session: string) => row(number, "in-progress", `session:${session}`);
const OPEN_ROWS = [claimed(2875, "worker-2875")];
/** The org's own identities, passed in so the reading does not depend on the host the test runs on: the pull request is authored by one of them, so it is INSIDE, not review-only. */
const DECLARED = { exact: ["worker-bot"], pattern: [] };

/** The pull request a `session:` label or a closed row names; `over` changes one fact at a time. */
const pr = (over: Fixture = {}): Fixture => ({
  number: 2880, headRefOid: HEAD, isDraft: false, statusCheckRollup: GREEN, headRefName: "agent/an-unnamed-branch",
  isCrossRepository: false, author: { login: "worker-bot" },
  labels: [], closingIssuesReferences: [{ number: 2875 }], comments: NOT_CONVINCED, ...over,
});

/** The verdict orders a tick builds for these pull requests, through the same wiring `main` uses. */
function verdictOrders(prs: Fixture[], openRows: Fixture[] = OPEN_ROWS): Fixture[] {
  return decide({ prs: withClosingRowOwners(prs, openRows), readyRows: [], openRows, identities: DECLARED }).filter((order: Fixture) => order.cause === "verdict-not-convinced");
}

test("POSITIVE CONTROL: a NOT CONVINCED pull request with no hold and no wait is ordered to the session its row holds", () => {
  const [order, ...rest] = verdictOrders([pr()]);
  assert.equal(rest.length, 0);
  assert.equal(order.session, "worker-2875");
  assert.equal(order.causeKey, "worker-2875/verdict-not-convinced/pr-2880/24b0e94f");
});

test("a standing hold label silences the NOT CONVINCED order, whoever placed it", () => {
  assert.deepEqual(verdictOrders([pr({ labels: [{ name: "hold:orchestrator" }] })]), []);
  assert.deepEqual(verdictOrders([pr({ labels: [{ name: "hold:ceo" }, { name: "session:worker-2875" }] })]), []);
});

test("the hold ends with the label: the order is back on the next tick once `hold:*` is removed", () => {
  assert.deepEqual(verdictOrders([pr({ labels: [{ name: "hold:orchestrator" }] })]), []);
  const [order] = verdictOrders([pr({ labels: [] })]);
  assert.ok(order, "a removed hold is no exemption");
  assert.equal(order.causeKey, "worker-2875/verdict-not-convinced/pr-2880/24b0e94f");
});

test("an open edge at the head silences the NOT CONVINCED order: the row waits as data, the way a hold waits", () => {
  const waiting = pr({ waitingOn: { edges: [4426], head: HEAD } });
  assert.deepEqual(verdictOrders([waiting]), []);
});

test("the edge closing brings the order back: an empty edge list is no wait", () => {
  const cleared = pr({ waitingOn: { edges: [], head: HEAD } });
  assert.equal(verdictOrders([cleared]).length, 1);
});

test("a push brings the order back: a stamp at the old head excuses nothing at the new one", () => {
  const pushed = pr({ headRefOid: NEW_HEAD, comments: verdictAt(NEW_HEAD), waitingOn: { edges: [4426], head: HEAD } });
  const [order] = verdictOrders([pushed]);
  assert.ok(order, "a new head is new work, and a verdict on it still reaches its owner");
  assert.equal(order.causeKey, "worker-2875/verdict-not-convinced/pr-2880/9d1c2e7a");
});

test("a stamp with no head, or no edges at all, excuses nothing", () => {
  assert.equal(verdictOrders([pr({ waitingOn: { edges: [4426] } })]).length, 1, "absent is not equal to the head");
  assert.equal(verdictOrders([pr({ waitingOn: { edges: [4426], head: "" } })]).length, 1, "an empty head matches nothing");
});

test("a CONVINCED verdict on a held pull request is left as it was: the hold changes nothing for it", () => {
  // The same pull request with the hold and without it: whatever the gate says about a convinced verdict, it says the same either way.
  const held = verdictOrders([pr({ comments: CONVINCED, labels: [{ name: "hold:orchestrator" }] })]);
  const unheld = verdictOrders([pr({ comments: CONVINCED })]);
  assert.deepEqual(held, unheld);
  const everything = (prs: Fixture[]) => decide({ prs: withClosingRowOwners(prs, OPEN_ROWS), readyRows: [], openRows: OPEN_ROWS, identities: DECLARED }).map((o: Fixture) => o.cause);
  assert.deepEqual(everything([pr({ comments: CONVINCED, labels: [{ name: "hold:orchestrator" }] })]), everything([pr({ comments: CONVINCED })]));
});
