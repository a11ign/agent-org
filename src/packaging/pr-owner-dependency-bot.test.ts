// no-token: gh -- pure: `withPrOwners`, `ownerOfPr`, `stalledPrOrders` and `unresolvedOwnerEvents` over in-memory pull requests; nothing here reaches `gh`, `git` or the network
/**
 * #4624: A PULL REQUEST A DEPENDENCY BOT OPENED HAS AN OWNER, so it is not an `owner-unresolved` event. #4386 stamped agent-org's own pull
 * requests from their row, and a11ign/a11ign#4470, #4471 and #4472 (Dependabot, opened 08:44Z on 2026-10-09, an hour after #4386 closed) fell
 * to `ceo`'s rung all the same: no session claims, labels or stamps a pull request Dependabot opens, so every rung but the last is blind to it.
 *
 * THE FIXTURE IS #4470 AS `gh pr list --json author` returned it (`app/dependabot`, branch `dependabot/npm_and_yarn/axe-core-4.14.0`, labels
 * `dependencies` and `javascript`, no closing reference). POSITIVE CONTROLS: a pull request of the same shape by a person still reaches `ceo`
 * and IS recorded (so the emptiness asserted for the bot is not an emptiness of the recorder), and a `session:` label on the bot's pull
 * request still wins.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { withPrOwners } from "../work-gate.ts";
import { ownerOfPr, isDependencyBotPr, stalledPrOrders } from "../work-gate/pr-orders.ts";
import { unresolvedOwnerEvents } from "../pr-ownership.ts";

const ROWS = [{ number: 4624, labels: [{ name: "in-progress" }, { name: "session:worker-4624" }] }];
const RED = [{ name: "gate", status: "COMPLETED", conclusion: "FAILURE", startedAt: "2026-10-09T08:50:00Z" }];

const dependabotPr = (over: Record<string, unknown> = {}) => ({
  number: 4470, headRefOid: "ab12cd34ef560000", isDraft: false, statusCheckRollup: RED, headRefName: "dependabot/npm_and_yarn/axe-core-4.14.0",
  author: { login: "app/dependabot", is_bot: true }, labels: [{ name: "dependencies" }, { name: "javascript" }], closingIssuesReferences: [], ...over,
});
const owned = (pr: Record<string, unknown>) => withPrOwners([pr], ROWS, () => null)[0];

test("a Dependabot pull request is named an owner by the ladder, and is not an owner-unresolved event", () => {
  const pr = owned(dependabotPr());
  assert.deepEqual(ownerOfPr(pr), { session: "ceo", source: "dependency-bot" });
  assert.deepEqual(unresolvedOwnerEvents([pr], ownerOfPr, "a11ign/a11ign"), []);
});

test("POSITIVE CONTROL: the same shape by a person reaches ceo's rung and IS recorded", () => {
  const pr = owned(dependabotPr({ number: 9, author: { login: "DanBeckDev" }, headRefName: "bump-axe-core" }));
  assert.equal(ownerOfPr(pr).source, "ceo");
  assert.deepEqual(unresolvedOwnerEvents([pr], ownerOfPr, "a11ign/a11ign"), [{ classKey: "owner-unresolved", ref: "a11ign/a11ign#9" }]);
});

test("every spelling of a dependency bot's login is one author, and a lookalike is not", () => {
  for (const login of ["app/dependabot", "dependabot[bot]", "dependabot", "app/renovate", "renovate[bot]"]) {
    assert.equal(isDependencyBotPr({ author: { login } }), true, login);
  }
  for (const login of ["", "dependabot-fan", "app/dependabot-preview-x", "not-dependabot", "a11ign-ai-workers"]) {
    assert.equal(isDependencyBotPr({ author: { login } }), false, login);
  }
  assert.equal(isDependencyBotPr({}), false, "a pull request that carries no author is not the bot's");
});

test("a session label on the bot's pull request still wins: somebody who took it owns it", () => {
  const pr = owned(dependabotPr({ labels: [{ name: "dependencies" }, { name: "session:worker-4624" }] }));
  assert.deepEqual(ownerOfPr(pr), { session: "worker-4624", source: "label" });
});

test("a red Dependabot pull request is ordered to ceo in words that do not claim nobody could be named", () => {
  const orders = stalledPrOrders([owned(dependabotPr())], { nowMs: Date.parse("2026-10-09T09:30:00Z") });
  assert.equal(orders.length, 1, "POSITIVE CONTROL: the red pull request is ordered at all");
  assert.equal(orders[0].session, "ceo");
  assert.match(orders[0].prompt, /dependency bot opened it/);
  assert.doesNotMatch(orders[0].prompt, /NOBODY COULD BE NAMED/);
});
