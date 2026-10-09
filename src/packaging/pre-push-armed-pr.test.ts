/**
 * #386: pushing to a branch whose PR is armed with auto-merge AND already green races a merge that can
 * complete in the window between the commit and the push. Measured three times in one evening, all by
 * the person who wrote the rule against it -- each time the commit was correct and the push succeeded,
 * and the bot completed the merge before the push finished, leaving the commit stranded on a branch that
 * `branches:stranded` correctly excludes (it is not unmerged) and the tracker has no record of.
 *
 * #442: that guard's premise moved when strict branch protection was restored (02:15Z) -- a merge cannot
 * FIRE while the head is behind `main`, so armed + green + BEHIND is not a race, it is the frozen state
 * this closes (a PR that goes green and then falls behind, which every merge to `main` produces for every
 * OTHER open PR, could neither merge -- blocked for being behind -- nor be synced -- refused by this
 * guard for being green). `behindBy` is the new axis; the other three states are unchanged.
 *
 * `racesAnArmedMerge` is the pure predicate, driven here against every state the acceptance section
 * names: no PR, an unarmed PR, an armed-but-not-green PR, armed + green + up-to-date (must still refuse,
 * #386's real case), armed + green + BEHIND (must now allow, #442), and armed + green + behindBy
 * unknowable (must allow, the fail-open direction one level in). `lookupArmedPrStatus` (the `gh`-calling
 * half) is exercised only for its FAIL-OPEN contract, never against the network -- see its own comment
 * for why `null` must always mean allow.
 *
 * The hook's own bash side (the `A11Y_ALLOW_ARMED_PUSH` override, the refusal message, the exit code), which
 * used to be driven here by extracting the #386 block from the project's `scripts/git-hooks/pre-push`, is the
 * project's script and left this file with #3233.
 */
// no-token: gh
//
// #1408. `lookupArmedPrStatus` is called here only with an injected `run`, `requiredContexts` and `checkRuns`, and
// `racesAnArmedMerge` is pure, so nothing in this file calls `gh`. The closure walk reaches it through `merge-guard.ts`'s
// module graph (`lookups.mjs`) rather than through anything this file runs -- #1275's census shim shows that: 0 `gh`
// calls from this file, against 1 before.
import { test } from "node:test";
import assert from "node:assert/strict";
import { racesAnArmedMerge, lookupArmedPrStatus } from "../merge-guard.ts";

test("no PR yet is ALLOWED -- the first push is how a PR gets opened", () => {
  assert.equal(racesAnArmedMerge({ armed: false, green: false }), false);
});

test("an unarmed PR is ALLOWED, whatever its gate says", () => {
  assert.equal(racesAnArmedMerge({ armed: false, green: true }), false);
});

test("an armed PR whose gate is still PENDING is ALLOWED -- pushing before green is the sanctioned route", () => {
  assert.equal(racesAnArmedMerge({ armed: true, green: false }), false);
});

test("an armed PR whose gate FAILED is ALLOWED -- fixing it up is exactly what a push here is for", () => {
  assert.equal(racesAnArmedMerge({ armed: true, green: false }), false);
});

test("armed, green AND up to date is the one case that REFUSES -- the window where a merge can land, #386's real case, unchanged", () => {
  assert.equal(racesAnArmedMerge({ armed: true, green: true, behindBy: 0 }), true);
});

test("#442 ACCEPTANCE: armed, green and BEHIND is ALLOWED -- under strict protection the merge this "
  + "guards against cannot fire while behind, so there is no race left and the push IS the remedy", () => {
  assert.equal(racesAnArmedMerge({ armed: true, green: true, behindBy: 9 }), false);
});

test("MUTATION TARGET (#442): armed, green, behindBy could not be determined (null) is ALLOWED -- "
  + "the fail-open direction applied to the new axis, one level in from the top-level null case below", () => {
  assert.equal(racesAnArmedMerge({ armed: true, green: true, behindBy: null }), false);
});

test("armed, green, `behindBy` OMITTED entirely is ALLOWED -- a status shape from before #442 must "
  + "never silently read as up to date", () => {
  assert.equal(racesAnArmedMerge({ armed: true, green: true }), false);
});

test("armed but green-ness ITSELF could not be confirmed is ALLOWED -- the fail-open direction, one level in", () => {
  assert.equal(racesAnArmedMerge({ armed: true, green: null }), false);
});

test("`null` (could not ask) is ALLOWED -- a convenience guard against a race must fail open, loudly, "
  + "never refuse a push because the network or `gh` failed", () => {
  assert.equal(racesAnArmedMerge(null), false);
});

test("lookupArmedPrStatus returns null rather than throwing when `gh` cannot answer -- through an injected run, never the live gh -- #1408", () => {
  // #1408: this asked the LIVE `gh` for a head that cannot exist, on every local run -- one GraphQL-backed
  // `gh pr list`, counted by #1275's census. The contract is unchanged: ANY failure inside the lookup is `null`,
  // "could not ask", which `racesAnArmedMerge` allows. What reaches gh is now the injected `run`.
  const asked: string[][] = [];
  const status = lookupArmedPrStatus("agent/some-branch", {
    run: (args: string[]) => { asked.push(args); throw new Error("gh: could not answer"); },
  });
  assert.equal(status, null, "a failed lookup is null, never an answer");
  assert.equal(asked.length, 1, "the injected run is what was asked, once -- nothing went to the real gh");
  assert.deepEqual(asked[0].slice(0, 2), ["pr", "list"]);
  assert.equal(asked[0][asked[0].indexOf("--head") + 1], "agent/some-branch", "for the branch being pushed");
});

test("#1408: no open PR for the branch is the unarmed shape, read through the injected run", () => {
  const status = lookupArmedPrStatus("agent/no-pr-yet", { run: () => "[]" });
  assert.deepEqual(status, { number: null, armed: false, green: false, behindBy: null });
});

test("#1408: an ARMED PR whose required checks are green reads its behind-by through the injected run -- the compare call is driven, not assumed", () => {
  const asked: string[][] = [];
  const run = (args: string[]) => {
    asked.push(args);
    if (args[0] === "pr" && args[1] === "list") {
      return JSON.stringify([{ number: 7, autoMergeRequest: { enabledAt: "2026-09-13T20:00:00Z" }, headRefOid: "abc1234def" }]);
    }
    if (args[0] === "api" && String(args[1]).endsWith("/compare/main...abc1234def")) return JSON.stringify({ behind_by: 3 });
    throw new Error(`an unexpected call reached run: ${args.join(" ")}`);
  };
  const status = lookupArmedPrStatus("agent/armed", {
    run,
    requiredContexts: () => ["gate"],
    checkRuns: (sha: string) => {
      assert.equal(sha, "abc1234def", "the check runs are read for the PR's own head");
      return [{ name: "gate", status: "completed", conclusion: "success", completedAt: "2026-09-13T20:00:30Z" }];
    },
  });
  assert.deepEqual(status, { number: 7, armed: true, green: true, behindBy: 3 },
    "armed, green by the real checkReasons, and behind by what the injected compare said");
  assert.deepEqual(asked.map((args) => args[0] === "api" ? [args[0], args[1].replace(/^repos\/[^/]+\/[^/]+\//, "")] : args.slice(0, 2)),
    [["pr", "list"], ["api", "compare/main...abc1234def"]], "the pr list, then the compare -- both through run");
});
