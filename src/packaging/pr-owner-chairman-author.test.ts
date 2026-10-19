// no-token: gh -- pure: `withPrOwners`, `ownerOfPr`, `stalledPrOrders`, `sharedFileOrders` and `unresolvedOwnerEvents` over in-memory pull requests; nothing here reaches `gh`, `git` or the network
/**
 * agent-org#950: A PULL REQUEST THE CHAIRMAN OPENED HAS AN OWNER -- `ceo`, by the `chairman-author` rung -- and is not an `owner-unresolved` event.
 * a11ign/a11ign#5041 (the chairman's own outage mitigation, author `DanBeckDev`, branch `agent/scheduler-search-mitigation`, no label, closing no
 * row) fell off the ladder onto `ceo`'s last rung, so the ledger recorded a correct address as "nobody could be named", the seventh time, and the
 * count could not fall.
 *
 * THE FIXTURE IS #5041 as `gh pr list --json author` returned it. CONTROLS, each the same PR with ONE fact changed: authored by the shared worker
 * account it still reaches `ceo`'s last rung and IS recorded (so the emptiness asserted for the chairman is not an emptiness of the recorder); a
 * `session:` label of a live session still wins; a login that merely CONTAINS the chairman's is not the chairman; and a label naming an ended
 * session with its rows closed is still `owner-gone`, not this rung.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { withPrOwners } from "../work-gate/pr-owners.ts";
import { CHAIRMAN_LOGINS } from "../work-gate/vocabulary.ts";
import { ownerOfPr, isChairmanAuthoredPr, stalledPrOrders } from "../work-gate/pr-orders/red-only-by-superseded-run.ts";
import { sharedFileOrders } from "../work-gate/shared-file-orders.ts";
import { unresolvedOwnerEvents } from "../pr-ownership.ts";

const CHAIRMAN = CHAIRMAN_LOGINS[0];
const WORKER_ACCOUNT = "a11ign-ai-workers";
const row = (number: number, ...labels: string[]) => ({ number, labels: labels.map((name) => ({ name })) });
/** Open rows the gate read: an unrelated one a live session holds, and none the fixture's branch or body names. */
const OPEN = [row(4437, "in-progress", "session:worker-4437")];
const LIVE = { agents: () => ["worker-4437"], ended: () => new Map<string, number>(), say: () => {} };
const RED = [{ name: "gate", status: "COMPLETED", conclusion: "FAILURE", startedAt: "2026-10-11T12:00:00Z" }];
const NOW = Date.parse("2026-10-11T12:40:00Z");

const pr5041 = (over: Record<string, unknown> = {}) => ({
  number: 5041, headRefOid: "5041cafe1234abcd", isDraft: false, statusCheckRollup: RED, headRefName: "agent/scheduler-search-mitigation",
  author: { login: CHAIRMAN }, labels: [], closingIssuesReferences: [], ...over,
});
const owned = (pr: Record<string, unknown>, rows: unknown[] = OPEN, io: typeof LIVE = LIVE) => withPrOwners([pr], rows as never, () => null, io)[0];

test("a chairman-authored pull request with no label and a branch naming no row is named ceo by the chairman-author rung, and is not recorded", () => {
  const pr = owned(pr5041());
  assert.deepEqual(ownerOfPr(pr), { session: "ceo", source: "chairman-author" });
  assert.deepEqual(unresolvedOwnerEvents([pr], ownerOfPr, "a11ign/a11ign"), []);
});

test("CONTROL: the same pull request authored by the worker account still reaches ceo's last rung and IS recorded", () => {
  const pr = owned(pr5041({ author: { login: WORKER_ACCOUNT } }));
  assert.deepEqual(ownerOfPr(pr), { session: "ceo", source: "ceo" });
  assert.deepEqual(unresolvedOwnerEvents([pr], ownerOfPr, "a11ign/a11ign"), [{ classKey: "owner-unresolved", ref: "a11ign/a11ign#5041" }]);
});

test("CONTROL: a person who is not the chairman, a lookalike login and a pull request with no author are not the chairman", () => {
  for (const author of [{ login: "someone-else" }, { login: `${CHAIRMAN}-fan` }, undefined]) {
    const pr = owned(pr5041({ author }));
    assert.equal(isChairmanAuthoredPr(pr), false, JSON.stringify(author));
    assert.equal(ownerOfPr(pr).source, "ceo", JSON.stringify(author));
    assert.equal(unresolvedOwnerEvents([pr], ownerOfPr, "a11ign/a11ign").length, 1, JSON.stringify(author));
  }
  assert.equal(isChairmanAuthoredPr(owned(pr5041())), true, "POSITIVE CONTROL: the chairman's own login is read");
});

test("CONTROL: a chairman's pull request carrying a live session label still names that session", () => {
  const pr = owned(pr5041({ labels: [{ name: "session:worker-4437" }] }));
  assert.deepEqual(ownerOfPr(pr), { session: "worker-4437", source: "label" });
});

test("CONTROL: a row its body closes and a live session holds still names that session, ahead of the author", () => {
  const rows = [row(4437, "in-progress", "session:worker-4437")];
  const pr = owned(pr5041({ closingIssuesReferences: [{ number: 4437 }] }), rows);
  assert.deepEqual(ownerOfPr(pr), { session: "worker-4437", source: "closing-row" });
});

test("CONTROL: a chairman's pull request whose label names an ended session and whose rows are closed is still owner-gone", () => {
  const ended = { ...LIVE, ended: () => new Map([["worker-4624", 1]]) };
  const pr = owned(pr5041({ labels: [{ name: "session:worker-4624" }], closingIssuesReferences: [{ number: 4624 }] }), OPEN, ended);
  assert.deepEqual(ownerOfPr(pr), { session: "product-manager", source: "owner-gone" });
});

test("a red chairman-authored pull request is ordered to ceo in words that do not claim nobody could be named", () => {
  const orders = stalledPrOrders([owned(pr5041())], { nowMs: NOW });
  assert.equal(orders.length, 1, "POSITIVE CONTROL: the red pull request is ordered at all");
  assert.equal(orders[0].session, "ceo");
  assert.match(orders[0].prompt, /chairman opened it/);
  assert.doesNotMatch(orders[0].prompt, /NOBODY COULD BE NAMED/);
  const worker = stalledPrOrders([owned(pr5041({ author: { login: WORKER_ACCOUNT } }))], { nowMs: NOW });
  assert.match(worker[0].prompt, /NOBODY COULD BE NAMED/, "CONTROL: the worker account's pull request is still the nobody-order");
});

test("a shared-file order for a chairman's pull request says the chairman opened it, not that a label names the reader", () => {
  const ahead = { number: 5000, repoKey: "a11ign/a11ign", labels: [{ name: "session:worker-4437" }], closingIssuesReferences: [], headRefName: "agent/x-4437",
    author: { login: WORKER_ACCOUNT }, files: [{ path: "src/a.ts" }], changedFiles: 1 };
  const later = { ...owned(pr5041()), repoKey: "a11ign/a11ign", files: [{ path: "src/a.ts" }], changedFiles: 1 };
  const [order] = sharedFileOrders([owned(ahead), later], () => {});
  assert.equal(order.session, "ceo");
  assert.match(order.prompt, /The chairman opened it and no session works it/);
  assert.doesNotMatch(order.prompt, /IT HAS NO OWNER/);
  const [workerOrder] = sharedFileOrders([owned(ahead), { ...later, author: { login: WORKER_ACCOUNT } }], () => {});
  assert.match(workerOrder.prompt, /IT HAS NO OWNER/, "CONTROL: the same overlap by the worker account is still ownerless");
});
