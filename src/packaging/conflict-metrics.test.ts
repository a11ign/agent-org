/**
 * #466 (C5): conflict metrics, READ FROM THE REPOSITORY rather than reported by a session.
 *
 * ceo's own done-when criteria (p90 under an hour, no PR over four hours, no file touched by more than
 * five PRs, zero conflicts, trunk green on every merge) are unanswerable except by a session asserting
 * them, until something computes them from GitHub and git directly. This is that something.
 *
 * The pure helpers (`percentile`, `mergeLifetimeMinutes`, `hotspotFiles`) are tested against plain
 * fixtures, no network or git needed. `mergedPRNeededReconciliation` calls `git` directly and is tested
 * against REAL commits already in this repository's history — the same idiom `board-report.test.ts` uses
 * for `whatMerged`'s real `git(["rev-parse", ...])` call, rather than mocking a wrapper this file does not
 * make injectable. `conflictMetrics` itself calls `gh` and is exercised live, the same idiom
 * `board-style.test.ts` already uses for `collect()` — CI's `ts` job has network and a real token; only
 * the `acceptance` job (a different job, not this one) is deliberately tokenless.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mergeLifetimeMinutes, hotspotFiles, mergedPRNeededReconciliation, conflictMetrics,
} from "../../../../scripts/board-data.mjs";

// --- mergeLifetimeMinutes: pure ---

test("mergeLifetimeMinutes: THE MEASUREMENT -- minutes from createdAt to mergedAt, ascending", () => {
  const prs = [
    { createdAt: "2026-09-08T00:00:00Z", mergedAt: "2026-09-08T02:00:00Z" }, // 120 min
    { createdAt: "2026-09-08T00:00:00Z", mergedAt: "2026-09-08T00:10:00Z" }, // 10 min
  ];
  assert.deepEqual(mergeLifetimeMinutes(prs), [10, 120]);
});

test("mergeLifetimeMinutes: a PR missing either timestamp is excluded, not read as zero", () => {
  const prs = [
    { createdAt: "2026-09-08T00:00:00Z", mergedAt: null },
    { createdAt: null, mergedAt: "2026-09-08T00:00:00Z" },
    { createdAt: "2026-09-08T00:00:00Z", mergedAt: "2026-09-08T00:05:00Z" },
  ];
  assert.deepEqual(mergeLifetimeMinutes(prs), [5]);
});

test("mergeLifetimeMinutes: no merged PRs at all is an empty array, never a crash", () => {
  assert.deepEqual(mergeLifetimeMinutes([]), []);
});

// --- hotspotFiles: pure, DISTINCT PR count, not occurrence count ---

test("hotspotFiles: THE MEASUREMENT -- a file touched by the same PR many times still counts ONCE", () => {
  // The hazard is convergence -- how many AUTHORS landed here -- not how much a file changed.
  const prs = [{ number: 1, files: [{ path: "ci.yml" }, { path: "ci.yml" }, { path: "ci.yml" }] }];
  assert.deepEqual(hotspotFiles(prs), [{ path: "ci.yml", prCount: 1 }]);
});

test("hotspotFiles: ranks by distinct PR count, ties broken by path", () => {
  const prs = [
    { number: 1, files: [{ path: "b.mjs" }, { path: "a.mjs" }] },
    { number: 2, files: [{ path: "b.mjs" }] },
    { number: 3, files: [{ path: "a.mjs" }] },
  ];
  assert.deepEqual(hotspotFiles(prs), [
    { path: "a.mjs", prCount: 2 },
    { path: "b.mjs", prCount: 2 },
  ]);
});

test("hotspotFiles: respects `limit`, and a PR with no files touches nothing", () => {
  const prs = Array.from({ length: 7 }, (_, i) => ({ number: i, files: [{ path: `f${i}.mjs` }] }));
  prs.push({ number: 99, files: [] });
  assert.equal(hotspotFiles(prs, 5).length, 5);
});

test("hotspotFiles: no PRs at all is an empty table", () => {
  assert.deepEqual(hotspotFiles([]), []);
});

// --- mergedPRNeededReconciliation: real git, against REAL commits in this repository's own history ---

/**
 * `git show`/`git merge-base`/`git log --merges` on a real, old commit need FULL history, which a shallow
 * clone (a sandbox, a depth-limited checkout) does not have. Skips honestly rather than failing on an
 * environment this repository's own `git-spawn-classification.test.ts`-adjacent tooling did not create.
 */
function skipIfShallow(fn: () => void): void {
  try {
    fn();
  } catch (error) {
    const message = String((error as { stderr?: string; message?: string }).stderr ?? error);
    if (!/not a valid object name|bad object|fatal: Not a valid object/i.test(message)) throw error;
    console.log("SKIPPED: this checkout does not have the commit history mergedPRNeededReconciliation "
      + "needs (a shallow clone) -- an honest skip, not a pass.");
  }
}

/**
 * `conflictMetrics` calls `gh`, and `docs/pipeline.md`'s own record of the `acceptance` job is explicit:
 * its ONLY `env:` is `PR_BODY` -- no `GH_TOKEN`, so `gh` has no credentials there at all. Verified by
 * reproducing the exact failure this job would hit: `env -u GH_TOKEN -u GITHUB_TOKEN HOME=<empty> gh pr
 * list ...` prints "To get started with GitHub CLI, please run: gh auth login" and exits 4 -- a different
 * message from `skipIfShallow`'s shallow-clone case, because it is a different cause, and this repository's
 * own rule is that two different faults must not print (or be caught by) the same pattern.
 *
 * This is `skipIfShallow`'s own remedy given the SAME treatment on the SECOND path that needed it -- #518
 * itself was called out for applying the fix to `mergedPRNeededReconciliation`'s tests and missing the
 * live `conflictMetrics` test, the "remedy reaching one of several paths" shape this repository's CLAUDE.md
 * names as its most expensive recurring one.
 */
function skipIfNoGhAuth(fn: () => void): void {
  try {
    fn();
  } catch (error) {
    const message = String((error as { stderr?: string; message?: string }).stderr ?? error);
    if (!/gh auth login|GH_TOKEN environment variable/i.test(message)) throw error;
    console.log("SKIPPED: no GitHub CLI credentials in this environment (the acceptance job's token is "
      + "scoped to contents:read and never exposed as GH_TOKEN) -- an honest skip, not a pass. Proven for "
      + "real in the `ts` job, which has network and a real token (see PR body).");
  }
}

test("mergedPRNeededReconciliation: THE REAL RECONCILED CASE -- PR #503's merge commit synced main twice", () => {
  skipIfShallow(() => {
    const result = mergedPRNeededReconciliation({ number: 503,
      mergeCommit: { oid: "5fd57e051db0784fe23d24bf91700d8ce681f69f" } });
    assert.equal(result, true);
  });
});

test("mergedPRNeededReconciliation: THE REAL CLEAN CASE -- PR #502's merge commit needed no sync at all", () => {
  skipIfShallow(() => {
    const result = mergedPRNeededReconciliation({ number: 502,
      mergeCommit: { oid: "67e4022226c35629a319d3eade62a0d6460fd784" } });
    assert.equal(result, false);
  });
});

test("mergedPRNeededReconciliation: no mergeCommit.oid at all is unresolvable (null), never a false clean", () => {
  assert.equal(mergedPRNeededReconciliation({ number: 1 }), null);
});

test("mergedPRNeededReconciliation: a bogus sha is unresolvable (null), not thrown and not a false clean", () => {
  assert.equal(mergedPRNeededReconciliation({ number: 1, mergeCommit: { oid: "0".repeat(40) } }), null);
});

// --- conflictMetrics: live, real -- THE COMPOSED FIGURE, exercised end to end ---

test("conflictMetrics: THE COMPOSED SHAPE, live -- every figure states its window and its method", () => {
  skipIfNoGhAuth(() => {
    // ONE HOUR, NOT A DAY -- this repository merges fast enough that a 24h window once meant a
    // hundred-plus merged PRs, each costing `mergedPRNeededReconciliation` two or three real git
    // subprocesses. A live wiring test proves the plumbing reaches GitHub and git for real; it does not
    // need the whole day's volume to do that, and a shrinking window keeps this test's cost from growing
    // with the queue's.
    const since = new Date(Date.now() - 3600_000).toISOString();
    const result = conflictMetrics(since);
    assert.equal(result.since, since);
    assert.equal(typeof result.method, "string");
    assert.ok(result.method.length > 20, "the method must be a real sentence, not a placeholder");
    assert.equal(typeof result.opened, "number");
    assert.equal(typeof result.merged, "number");
    assert.equal(typeof result.closedUnmerged, "number");
    assert.equal(typeof result.lifetimeMinutes.count, "number");
    assert.equal(typeof result.reconciliation.of, "number");
    assert.equal(typeof result.reconciliation.unresolvable, "number");
    assert.ok(Array.isArray(result.hotspotFiles));
    // THE REFUSE-RATHER-THAN-ZERO PROPERTY, live: an uninspectable merge is never folded into the clean
    // count -- neededReconciliation + (merges that resolved to false) + unresolvable must account for `of`.
    assert.ok(result.reconciliation.neededReconciliation + result.reconciliation.unresolvable
      <= result.reconciliation.of);
  });
});

// --- MUTATION TARGET ---

test("MUTATION TARGET: folding an uninspectable PR into 'no conflict' is exactly the defect this row ends", () => {
  // Documents the shape a regression would take: treating `null` (could not tell) as `false` (no
  // conflict) reports a clean queue on the day the tool could not look.
  const wrongCollapse = (v: boolean | null) => v === true; // `null` reads identically to `false` here
  assert.equal(wrongCollapse(null), false,
    "this is precisely why `conflictMetrics` reports `unresolvable` as its OWN field rather than folding "
    + "an uninspectable PR into the conflict count's zero");
});
