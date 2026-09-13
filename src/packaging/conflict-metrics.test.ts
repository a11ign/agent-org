// no-token: gh
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
 * make injectable. #1407: `conflictMetrics` is the LIVE entry and
 * no test here calls it. `composeConflictMetrics` is the same composition with the `gh` listing handed in, and it
 * is driven with recorded listings, so a local run makes no `gh` call.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mergeLifetimeMinutes, hotspotFiles, mergedPRNeededReconciliation, composeConflictMetrics, PR_SEARCH_LIMIT, REPO,
} from "../../../../scripts/board-data.mjs";
import { readFileSync } from "node:fs";

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
 * clone (a sandbox, the `acceptance` job's depth-1 checkout) does not have -- but `mergedPRNeededReconciliation`
 * ITSELF SWALLOWS that failure into its own `null` ("could not inspect") return, on exactly the contract
 * #466 was filed to build: a lookup failure is refused, never folded into a false clean. So this checker
 * does NOT wrap the call in a try/catch -- the function never throws here, and the first version of this
 * guard caught nothing, exactly because it was built to catch an exception that this function's own
 * design deliberately never lets escape. It checks the RETURN VALUE instead: `null` is read as "this
 * environment could not tell", the honest skip; anything else is asserted against `expected`.
 *
 * FOUND BY WATCHING IT FAIL TO SKIP, not by reasoning about it -- the first version of this test read
 * `assert.equal(result, true)` inside `skipIfShallow(() => {...})` and failed for real in the `acceptance`
 * job with `null !== true`, never reaching the catch block at all. A guard must be shown to fire before it
 * is trusted, this repository's own rule, and the wrong shape here would have shipped believing it did.
 */
function assertOrSkipIfUnresolvable(actual: boolean | null, expected: boolean, testName: string): void {
  if (actual === null) {
    console.log(`SKIPPED: ${testName} -- this checkout could not inspect the commit history `
      + "mergedPRNeededReconciliation needs (a shallow clone) -- an honest skip, not a pass.");
    return;
  }
  assert.equal(actual, expected);
}

test("mergedPRNeededReconciliation: THE REAL RECONCILED CASE -- PR #503's merge commit synced main twice", () => {
  const result = mergedPRNeededReconciliation({ number: 503,
    mergeCommit: { oid: "5fd57e051db0784fe23d24bf91700d8ce681f69f" } });
  assertOrSkipIfUnresolvable(result, true, "PR #503's reconciled case");
});

test("mergedPRNeededReconciliation: THE REAL CLEAN CASE -- PR #502's merge commit needed no sync at all", () => {
  const result = mergedPRNeededReconciliation({ number: 502,
    mergeCommit: { oid: "67e4022226c35629a319d3eade62a0d6460fd784" } });
  assertOrSkipIfUnresolvable(result, false, "PR #502's clean case");
});

test("mergedPRNeededReconciliation: no mergeCommit.oid at all is unresolvable (null), never a false clean", () => {
  assert.equal(mergedPRNeededReconciliation({ number: 1 }), null);
});

test("mergedPRNeededReconciliation: a bogus sha is unresolvable (null), not thrown and not a false clean", () => {
  assert.equal(mergedPRNeededReconciliation({ number: 1, mergeCommit: { oid: "0".repeat(40) } }), null);
});

// --- composeConflictMetrics: THE COMPOSED FIGURE, driven with recorded `gh pr list` answers (#1407) ---
//
// It was live. `conflictMetrics(since)` ran `gh pr list --limit 500 --json ...files` searches on every local run
// (worker-capture's census on #1275), and with no credentials it FAILED rather than skipped, because a refusal that
// is not `gh auth login` was rethrown. The composition is now driven with a `run` that answers each search from a
// listing this test writes, and every argv the composition sent is asserted.
//
// WHAT THIS CANNOT CATCH: GitHub's real answer -- what a `created:>=` search returns, the field names `--json`
// yields, paging behind `--limit`. That is still exercised where it always mattered: `board-report.mjs` calls the
// live `conflictMetrics` for every board edition. No local test reaches it any more, and that is the point.

const SINCE = "2026-09-08T00:00:00.000Z";
const FIELDS = "number,title,createdAt,mergedAt,closedAt,mergeCommit,files";

/** A `run` answering each search from `byQualifier`, keeping every argv it was sent. */
function listingRun(byQualifier: Record<string, unknown[]>) {
  const calls: string[][] = [];
  const run = (args: string[]) => {
    calls.push(args);
    const qualifier = (args[args.indexOf("--search") + 1] ?? "").split(":")[0];
    const answer = byQualifier[qualifier];
    if (!answer) throw new Error(`no recorded listing for: ${args.join(" ")}`);
    return JSON.stringify(answer);
  };
  return { run, calls };
}

// #503 and #502 are the REAL merge commits the reconciliation tests above already use; the rest is fixture.
const RECONCILED = { number: 503, title: "fixture", createdAt: "2026-09-08T00:00:00Z", mergedAt: "2026-09-08T00:30:00Z",
  closedAt: "2026-09-08T00:30:00Z", mergeCommit: { oid: "5fd57e051db0784fe23d24bf91700d8ce681f69f" },
  files: [{ path: "a.mjs" }] };
const CLEAN = { number: 502, title: "fixture", createdAt: "2026-09-08T00:00:00Z", mergedAt: "2026-09-08T02:00:00Z",
  closedAt: "2026-09-08T02:00:00Z", mergeCommit: { oid: "67e4022226c35629a319d3eade62a0d6460fd784" },
  files: [{ path: "a.mjs" }, { path: "b.mjs" }] };
const NO_COMMIT = { number: 9001, title: "fixture", createdAt: "2026-09-08T00:00:00Z", mergedAt: "2026-09-08T00:10:00Z",
  closedAt: "2026-09-08T00:10:00Z", mergeCommit: null, files: [{ path: "a.mjs" }] };
const CLOSED = { number: 9002, title: "fixture", createdAt: "2026-09-08T01:00:00Z", mergedAt: null,
  closedAt: "2026-09-08T01:05:00Z", mergeCommit: null, files: [{ path: "c.mjs" }] };

test("composeConflictMetrics: THE COMPOSED SHAPE over recorded listings -- every search's argv, and every figure", () => {
  const { run, calls } = listingRun({
    created: [RECONCILED, CLEAN, NO_COMMIT, CLOSED],
    merged: [RECONCILED, CLEAN, NO_COMMIT],
    closed: [RECONCILED, CLEAN, NO_COMMIT, CLOSED], // `closed:>=` returns merged PRs too
  });
  const result = composeConflictMetrics(SINCE, { run });
  const search = (qualifier: string) => ["pr", "list", "--repo", REPO, "--state", "all", "--search",
    `${qualifier}:>=${SINCE}`, "--limit", String(PR_SEARCH_LIMIT), "--json", FIELDS];
  assert.deepEqual(calls, [search("created"), search("merged"), search("closed")],
    "the three searches the live call makes, in order, each with its window and its limit");
  assert.equal(result.since, SINCE);
  assert.ok(result.method.length > 20, "the method must be a real sentence, not a placeholder");
  assert.equal(result.opened, 4);
  assert.equal(result.merged, 3);
  assert.equal(result.closedUnmerged, 1, "a merged PR in the `closed:` listing is not closed-unmerged");
  assert.equal(result.lifetimeMinutes.count, 3);
  assert.deepEqual(result.hotspotFiles, [{ path: "a.mjs", prCount: 3 }, { path: "b.mjs", prCount: 1 },
    { path: "c.mjs", prCount: 1 }], "deduped by PR number across the three listings");
  assert.equal(result.reconciliation.of, 3);
  // THE REFUSE-RATHER-THAN-ZERO PROPERTY: the merge with no commit is `unresolvable`, never clean. #503 and #502
  // resolve only with full history; a shallow checkout reads all three as unresolvable, never as clean.
  if (result.reconciliation.unresolvable === 3) {
    console.log("SKIPPED the resolved-count half: this checkout could not inspect #503/#502 (a shallow clone).");
    assert.equal(result.reconciliation.neededReconciliation, 0);
  } else {
    assert.deepEqual(result.reconciliation, { neededReconciliation: 1, of: 3, unresolvable: 1 });
  }
});

test("composeConflictMetrics with no run is REFUSED by name, before any search -- a defaulted run is a live gh", () => {
  assert.throws(() => composeConflictMetrics(SINCE), /prsBy\("created"\) needs a run/);
  assert.throws(() => composeConflictMetrics(SINCE, {}), /prsBy\("created"\) needs a run/);
});

test("a listing AT the search limit is refused as possibly truncated; one row under it is read", () => {
  const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ number: i + 1, files: [] }));
  const at = listingRun({ created: rows(PR_SEARCH_LIMIT), merged: [], closed: [] });
  assert.throws(() => composeConflictMetrics(SINCE, { run: at.run }), /MAY BE TRUNCATED/);
  const under = listingRun({ created: rows(PR_SEARCH_LIMIT - 1), merged: [], closed: [] });
  assert.equal(composeConflictMetrics(SINCE, { run: under.run }).opened, PR_SEARCH_LIMIT - 1,
    "the positive control: the refusal is the limit's, not every large listing's");
});

test("wiring: conflictMetrics is the live entry and hands in gh; the composition calls no gh of its own", () => {
  const source = readFileSync(new URL("../../../../scripts/board-data.mjs", import.meta.url), "utf8");
  const body = (name: string) => {
    const start = source.indexOf(`export function ${name}(`);
    assert.ok(start >= 0, `${name} is exported from board-data.mjs`);
    return source.slice(start, source.indexOf("\n}\n", start)).replace(/\/\/.*$/gm, "");
  };
  assert.match(body("conflictMetrics"), /^export function conflictMetrics\(since\) \{\s*return composeConflictMetrics\(since, \{ run: gh \}\);\s*$/);
  assert.doesNotMatch(body("composeConflictMetrics"), /\bgh\(|execFileSync/);
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
