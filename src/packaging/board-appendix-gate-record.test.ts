/**
 * #429, ON THE TRACKED RECORD -- the one assertion about the appendix's verdict slot that no fixture can make.
 *
 * `board-appendix-gate-kind.test.ts` tests `latestVerdictGate` directly, so a revert at `reported()`'s CALL
 * SITE -- the slot back to "newest entry of any kind" -- leaves every one of its tests green. This reads the
 * slot `reported()` actually fills from `docs/board/reported/`, and it is the test that catches that revert.
 * In its own file because it imports `board-data.mjs`, which spawns `gh`, and CI's acceptance job refuses
 * anything that does; it runs in the ordinary `ts` suite.
 */
import { declareWalkScope } from "../lib/walk-scope.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";

import { isConformanceGate, reported, worstVerdict } from "../board-data.mjs";

// #929: THIS GUARD READS ONLY `docs`, so a diff that cannot reach it need not run this file.
// Undeclared means unbounded, which is why the selector runs 173 always-run guards on every pull
// request. The declaration is ENFORCED rather than trusted: `declareWalkScope` observes what this
// file actually reads and fails it here if anything lands outside the scope -- so a scope that is
// too narrow is loud, never a guard that silently stopped running.
// #2616: `.agent-org` IS IN THE SCOPE because importing `repo-identity.mjs` now reads the project's declaration, `.agent-org/project.json`;
// the read is real, so a change to it correctly reaches this file.
export const WALK_SCOPE = ["docs", ".agent-org"];
await declareWalkScope(import.meta.url);

test("#429, ON THE TRACKED RECORD: the appendix slot holds a conformance gate that carries a verdict, or nothing", () => {
  // Not a fixture. On `origin/main` before this fix the slot read the newest entry of ANY kind, which on
  // 2026-09-11 was `#659 step 1 -- replay of the three captures...`, an operational note with no verdict
  // line at all. The board's "Most recent automated check result" was a diagnostic, while the 2026-09-07
  // `rules-real-pages` FAIL sat three entries down. The property is stated so it survives new entries.
  const { latestGate, gates } = reported();
  assert.ok(gates.length > 0, "no gate recorded, so this asserts over nothing");
  if (latestGate === null) {
    assert.ok(!gates.some((g: unknown) => isConformanceGate(g) && worstVerdict((g as { output?: string }).output) !== null),
      "the slot is empty while a verdict-bearing conformance gate is recorded");
    return;
  }
  assert.ok(isConformanceGate(latestGate), `the slot holds a non-conformance entry: ${String(latestGate.command).split("\n")[0]}`);
  assert.notEqual(worstVerdict(latestGate.output), null, "the slot holds a conformance run with no verdict line");
});
