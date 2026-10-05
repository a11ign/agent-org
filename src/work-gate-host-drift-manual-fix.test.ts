// no-token: hostDriftOrders -- #3703. Importing `work-gate.mjs` reaches `defaultRun` (`execFileSync("gh", ...)`), and nothing here lets it run:
// `hostDriftOrders` is a pure function of the findings it is handed, and the detector is read through an injected `readGhHosts`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hostDriftOrders } from "./work-gate.mjs";
import { humanLoginOnHost, HUMAN_LOGIN_ON_HOST } from "./host-units.mjs";
import { homeHostConfig } from "./host-config.mjs";

/**
 * #3703: A HOST DRIFT SET WHOSE FINDINGS ARE ALL `manualFix` IS NOT OFFERED TO `orchestrator`. The order's only remedy is `host:install`, which
 * writes no line of a person's login, so `orchestrator` declined it on every tick and the stuck breaker could not escalate a subject that is
 * `host-units` and not a row (30 consecutive ticks, 63 minutes, 2026-10-05).
 *
 * THE POSITIVE CONTROLS FOR THE EMPTINESS ASSERTIONS ARE THE LATER TESTS: a mixed set still orders (so `hostDriftOrders` is not simply `[]`), and
 * `host:check`'s detector still reports the manual finding (so the silence is the order's and not the detector's).
 */
const STALE = { unit: "a11ign-board-report.service", problem: "STALE", detail: "the installed copy differs from the one in the repository." };
const MANUAL_LOGIN = { unit: "/home/agent/.config/gh", problem: HUMAN_LOGIN_ON_HOST, manualFix: true, detail: "it is logged in as `DanBeckDev`." };
const MANUAL_CODEX = { unit: "/home/agent/repos/a11ign", problem: "CLONE NOT TRUSTED BY CODEX", manualFix: true, detail: "a trust grant is a ruling." };

test("#3703: a drift set of only manualFix findings is not delivered to orchestrator, on this tick or the next", () => {
  for (const set of [[MANUAL_LOGIN], [MANUAL_LOGIN, MANUAL_CODEX]]) {
    assert.deepEqual(hostDriftOrders(set), [], `${set.length} manual finding(s): nothing orchestrator can run clears them`);
    assert.deepEqual(hostDriftOrders(set), [], "and the same set a tick later mints no order under the same key either");
  }
});

test("#3703 CONTROL: a set holding one finding host:install CAN clear still orders orchestrator, with the full procedure, unchanged", () => {
  const [order, ...rest] = hostDriftOrders([MANUAL_LOGIN, STALE]);
  assert.deepEqual(rest, [], "one order for the whole set");
  assert.equal(order.session, "orchestrator");
  assert.equal(order.cause, "host-units-stale");
  // The key is the pre-#3703 one: every finding, manual included, sorted -- so an order already in the ledger is not re-minted by this change.
  assert.equal(order.causeKey, `orchestrator/host-units-stale/${[MANUAL_LOGIN, STALE].map((f) => `${f.unit}:${f.problem}`).sort().join(".")}`);
  assert.match(order.prompt, /2 finding\(s\)/, "the manual finding is still listed beside the one the remedy clears");
  assert.match(order.prompt, /THIS IS A DETECTOR, NOT AN INSTALLER/);
  assert.match(order.prompt, /SO READ BEFORE YOU RUN/, "the second-reading procedure is intact");
  assert.match(order.prompt, /pnpm run host:install/);
  assert.match(order.prompt, /REMOVED/);
  // CONTROL: the same finding on its own orders too, so the drop above is the manualFix and not the unit.
  assert.equal(hostDriftOrders([STALE]).length, 1);
});

test("#3703: the order ends by itself once the remedy has run and only the manual finding remains", () => {
  assert.equal(hostDriftOrders([MANUAL_LOGIN, STALE]).length, 1, "before host:install");
  assert.deepEqual(hostDriftOrders([MANUAL_LOGIN]), [], "after it: the STALE finding is gone, the person's login is not, and nobody is ordered");
});

test("#3703: the detector is not weakened -- host:check's own reader still reports the human login that the order no longer carries", () => {
  const root = mkdtempSync(join(tmpdir(), "work-gate-3703-"));
  const hosts = (user: string) => `github.com:\n    users:\n        ${user}:\n            oauth_token: gho_x\n    user: ${user}\n`;
  for (const [dir, user] of [["home/.config/gh", "DanBeckDev"], ["workers/gh", "a11ign-ai-workers"], ["leads/gh", "a11ign-ai-leads"]]) {
    mkdirSync(join(root, dir), { recursive: true });
    writeFileSync(join(root, dir, "hosts.yml"), hosts(user));
  }
  const base = homeHostConfig();
  const host = { ...base, home: join(root, "home"), gh: { ...base.gh, workers: join(root, "workers"), leads: join(root, "leads") } } as never;
  const found = humanLoginOnHost({ host });
  assert.equal(found.length, 1, "CONTROL: the finding exists (a reader that found nothing would make the next line vacuous)");
  assert.equal(found[0].problem, HUMAN_LOGIN_ON_HOST);
  assert.equal(found[0].manualFix, true);
  assert.deepEqual(hostDriftOrders(found), [], "and the real finding, not just a fixture of it, produces no order");
});
