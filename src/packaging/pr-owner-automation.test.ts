// no-token: gh -- pure: `withPrOwners`, `ownerOfPr`, `stalledPrOrders` and `unresolvedOwnerEvents` over in-memory pull requests; nothing here reaches `gh`, `git` or the network
/**
 * a11ign/agent-org#1239: A PULL REQUEST THE RE-PIN WRITER OPENS HAS AN OWNER -- `ceo`, by the `automation-writer` rung -- and is not an
 * `owner-unresolved` event. a11ign/a11ign#5210 (`automation/consumer-gate-pin`) and #5283 (`automation/docs-pin-write`, red 2026-10-12T19:18Z)
 * are authored by the `octo-sts` app, carry no label and close no row, and fell to `ceo`'s last rung: the ledger recorded a correct address as
 * "nobody could be named", and the class repeat (#5283, #5210) kept the count from falling.
 *
 * THE FIXTURE IS #5283 as `gh pr list --json author` returned it. CONTROLS, each the same PR with ONE fact changed: a `session:` label of a
 * live session still wins; the same writer on a branch that is not `automation/` still reaches `ceo`'s last rung and IS recorded; a worker
 * account on an `automation/` branch still reaches it too (so the rung is not "any branch" and not "any bot"); and a lookalike login is not
 * the writer.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { withPrOwners } from "../work-gate/pr-owners.ts";
import { ownerOfPr, isAutomationWriterPr, stalledPrOrders } from "../work-gate/pr-orders/red-only-by-superseded-run.ts";
import { unresolvedOwnerEvents } from "../pr-ownership.ts";

const WRITER = "octo-sts";
const WORKER_ACCOUNT = "a11ign-ai-workers";
const row = (number: number, ...labels: string[]) => ({ number, labels: labels.map((name) => ({ name })) });
/** Open rows the gate read: an unrelated one a live session holds, and none the fixture's branch or body names. */
const OPEN = [row(4437, "in-progress", "session:worker-4437")];
const LIVE = { agents: () => ["worker-4437"], ended: () => new Map<string, number>(), say: () => {} };
const RED = [{ name: "gate", status: "COMPLETED", conclusion: "FAILURE", startedAt: "2026-10-12T19:10:00Z" }];
const NOW = Date.parse("2026-10-12T19:40:00Z");

const pr5283 = (over: Record<string, unknown> = {}) => ({
  number: 5283, headRefOid: "5283cafe1234abcd", isDraft: false, statusCheckRollup: RED, headRefName: "automation/docs-pin-write",
  author: { login: WRITER }, labels: [], closingIssuesReferences: [], ...over,
});
const owned = (pr: Record<string, unknown>, rows: unknown[] = OPEN, io: typeof LIVE = LIVE) => withPrOwners([pr], rows as never, () => null, io)[0];

test("a re-pin writer pull request on an automation/ branch with no label is named ceo by the automation-writer rung, and is not recorded", () => {
  const pr = owned(pr5283());
  assert.deepEqual(ownerOfPr(pr), { session: "ceo", source: "automation-writer" });
  assert.deepEqual(unresolvedOwnerEvents([pr], ownerOfPr, "a11ign/a11ign"), []);
});

test("every spelling of the writer's login is one author, and a lookalike is not", () => {
  for (const login of [WRITER, `app/${WRITER}`, `${WRITER}[bot]`]) {
    assert.equal(isAutomationWriterPr(owned(pr5283({ author: { login } }))), true, login);
  }
  for (const login of [`${WRITER}-fan`, `not-${WRITER}`, "someone-else", ""]) {
    assert.equal(isAutomationWriterPr(owned(pr5283({ author: { login } }))), false, login);
  }
  assert.equal(isAutomationWriterPr(owned(pr5283({ author: undefined }))), false, "a pull request with no author is not the writer's");
});

test("CONTROL: a writer pull request carrying a live session label still names that session", () => {
  const pr = owned(pr5283({ labels: [{ name: "session:worker-4437" }] }));
  assert.deepEqual(ownerOfPr(pr), { session: "worker-4437", source: "label" });
});

test("CONTROL: the same writer on a branch that is not automation/ still reaches ceo's last rung and IS recorded", () => {
  const pr = owned(pr5283({ headRefName: "agent/docs-pin-write" }));
  assert.deepEqual(ownerOfPr(pr), { session: "ceo", source: "ceo" });
  assert.deepEqual(unresolvedOwnerEvents([pr], ownerOfPr, "a11ign/a11ign"), [{ classKey: "owner-unresolved", ref: "a11ign/a11ign#5283" }]);
});

test("CONTROL: a worker account's pull request on an automation/ branch still reaches ceo's last rung and IS recorded", () => {
  const pr = owned(pr5283({ author: { login: WORKER_ACCOUNT } }));
  assert.deepEqual(ownerOfPr(pr), { session: "ceo", source: "ceo" });
  assert.deepEqual(unresolvedOwnerEvents([pr], ownerOfPr, "a11ign/a11ign"), [{ classKey: "owner-unresolved", ref: "a11ign/a11ign#5283" }]);
});

test("a red writer pull request is ordered to ceo in words that name the writer, not that nobody could be named", () => {
  const orders = stalledPrOrders([owned(pr5283())], { nowMs: NOW });
  assert.equal(orders.length, 1, "POSITIVE CONTROL: the red pull request is ordered at all");
  assert.equal(orders[0].session, "ceo");
  assert.match(orders[0].prompt, /writer app opened it on an `automation\/` branch/);
  assert.doesNotMatch(orders[0].prompt, /NOBODY COULD BE NAMED/);
  const worker = stalledPrOrders([owned(pr5283({ author: { login: WORKER_ACCOUNT } }))], { nowMs: NOW });
  assert.match(worker[0].prompt, /NOBODY COULD BE NAMED/, "CONTROL: the worker account's pull request is still the nobody-order");
});
