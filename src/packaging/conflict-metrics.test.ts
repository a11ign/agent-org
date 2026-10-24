// no-token: gh -- `composeConflictMetrics` is driven over the fake code host's pull requests (A11-160, step 9); the live `conflictMetrics` is never called here
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
 * no test here calls it. `composeConflictMetrics` is the same composition with the listing handed in, and it
 * is driven over the fake code host's pull requests, so a local run makes no `gh` call.
 */
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import {
  mergeLifetimeMinutes, hotspotFiles, mergedPRNeededReconciliation, composeConflictMetrics, PR_WINDOW_LIMIT, REPO,
} from "../board-data.ts";
import { readFileSync } from "node:fs";
import { forgetActivation, substituteCodeHost } from "../plugins/active.ts";
import type { SinceRead } from "../plugins/contracts/code-host-rows.ts";
import { createFakeCodeHost } from "../plugins/fakes/code-host.ts";
import { type FakeRowPull } from "../plugins/fakes/code-host-rows.ts";
import { fakePull } from "../plugins/fakes/code-host-pulls.ts";
import { watchedRows } from "../plugins/fakes/watched-rows.test.support.ts";

afterEach(() => forgetActivation());

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

// --- composeConflictMetrics: THE COMPOSED FIGURE, driven over the fake code host's pull requests (#1407, #5076; A11-160, step 9) ---
//
// It was live. `conflictMetrics(since)` ran `gh pr list --limit 500 --json ...files` searches on every local run
// (worker-capture's census on #1275), and with no credentials it FAILED rather than skipped, because a refusal that
// is not `gh auth login` was rethrown. The composition is now driven over the fake code host's world: a case seeds the pull requests a window
// holds, and the three windows are the code host's `readRowsSince` reads (`created` newest-created first; `merged` and `closed` newest-updated first), each asked with its states, its order and its page bound.
// Which `gh` arguments a window is, and how GitHub's pages are read, are the plugin's tests (`plugins/github/rows/rows-since.test.ts`).
//
// WHAT THIS CANNOT CATCH: GitHub's real answer -- the field names the connection yields, how it orders rows it has updated.
// That is still exercised where it always mattered: `board-report.ts` calls the live `conflictMetrics` for every board
// edition. No local test reaches it any more, and that is the point.

const SINCE = "2026-09-08T00:00:00.000Z";

/** The run `composeConflictMetrics` is handed: the fake code host acts on its own state, so one that is reached is a mistake. */
const NO_RUN = (): string => { throw new Error("the fake code host answers from its world, never through the run it is handed"); };

/** A pull request as the world holds it: `merged` with its `mergedAt`, closed without merging (`closedAt` alone), or open. */
type Seed = Partial<FakeRowPull> & { number: number; createdAt: string };

/** The fake code host in place with its rows WATCHED, holding `pulls`. `asks` are the windows the composition read, in order, as the code host was asked. */
function windowWorld(pulls: Seed[]) {
  const host = createFakeCodeHost();
  for (const seed of pulls) fakePull(host.rowsWorld, seed.number, { title: "fixture", ...seed });
  const watched = watchedRows(host);
  substituteCodeHost(watched.host);
  return { asks: () => watched.calls.filter((call) => call.op === "readRowsSince").map((call) => call.request.ask as SinceRead) };
}

// #503 and #502 are the REAL merge commits the reconciliation tests above already use; the rest is fixture.
const RECONCILED: Seed = { number: 503, createdAt: "2026-09-08T00:00:00Z", merged: true, mergedAt: "2026-09-08T00:30:00Z",
  closedAt: "2026-09-08T00:30:00Z", mergeCommit: "5fd57e051db0784fe23d24bf91700d8ce681f69f", files: ["a.mjs"] };
const CLEAN: Seed = { number: 502, createdAt: "2026-09-08T00:00:00Z", merged: true, mergedAt: "2026-09-08T02:00:00Z",
  closedAt: "2026-09-08T02:00:00Z", mergeCommit: "67e4022226c35629a319d3eade62a0d6460fd784", files: ["a.mjs", "b.mjs"] };
const NO_COMMIT: Seed = { number: 9001, createdAt: "2026-09-08T00:00:00Z", merged: true, mergedAt: "2026-09-08T00:10:00Z",
  closedAt: "2026-09-08T00:10:00Z", files: ["a.mjs"] };
const CLOSED: Seed = { number: 9002, createdAt: "2026-09-08T01:00:00Z", merged: false, mergedAt: null,
  closedAt: "2026-09-08T01:05:00Z", files: ["c.mjs"] };
/** In the CLOSED state AND carrying a `mergedAt`, as GitHub's old `closed:` listing returned merged pull requests: created before the window, so only the `closed` window reads it, and the caller must not count it as closed unmerged. */
const CLOSED_BUT_MERGED: Seed = { number: 9003, createdAt: "2026-09-01T00:00:00Z", merged: false, mergedAt: "2026-09-08T03:00:00Z",
  closedAt: "2026-09-08T03:00:00Z", files: ["d.mjs"] };

test("composeConflictMetrics: THE COMPOSED SHAPE over the world's pull requests -- every window read, and every figure", () => {
  const { asks } = windowWorld([RECONCILED, CLEAN, NO_COMMIT, CLOSED, CLOSED_BUT_MERGED]);
  const result = composeConflictMetrics(SINCE, { run: NO_RUN });
  assert.deepEqual(asks().map(({ kind, states, orderBy, repo, since, maxPages }) => ({ kind, states, orderBy, repo, since, maxPages })), [
    { kind: "pullRequests", states: ["OPEN", "CLOSED", "MERGED"], orderBy: "CREATED_AT", repo: REPO, since: SINCE, maxPages: PR_WINDOW_LIMIT / 100 },
    { kind: "pullRequests", states: ["MERGED"], orderBy: "UPDATED_AT", repo: REPO, since: SINCE, maxPages: PR_WINDOW_LIMIT / 100 },
    { kind: "pullRequests", states: ["CLOSED"], orderBy: "UPDATED_AT", repo: REPO, since: SINCE, maxPages: PR_WINDOW_LIMIT / 100 },
  ], "the three window reads the live call makes, in order, each with its states, its order and its page bound");
  assert.equal(result.since, SINCE);
  assert.ok(result.method.length > 20, "the method must be a real sentence, not a placeholder");
  assert.equal(result.opened, 4);
  assert.equal(result.merged, 3);
  assert.equal(result.closedUnmerged, 1, "a merged PR in the `closed:` listing is not closed-unmerged");
  assert.equal(result.lifetimeMinutes.count, 3);
  assert.deepEqual(result.hotspotFiles, [{ path: "a.mjs", prCount: 3 }, { path: "b.mjs", prCount: 1 },
    { path: "c.mjs", prCount: 1 }], "deduped by PR number across the three listings, and without the merged pull request the `closed` window also held");
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

test("composeConflictMetrics with no run is REFUSED by name, before any read -- a defaulted run is a live gh", () => {
  assert.throws(() => composeConflictMetrics(SINCE), /prsBy\("created"\) needs a run/);
  assert.throws(() => composeConflictMetrics(SINCE, {}), /prsBy\("created"\) needs a run/);
});

test("a window that needs more than PR_WINDOW_LIMIT rows is refused as possibly cut short; one that fits its pages is read (#5076)", () => {
  // Each pull request is created inside the window, so the `created` window holds all of them.
  const pulls = (n: number): Seed[] => Array.from({ length: n }, (_, i) => ({ number: i + 1, createdAt: new Date(Date.parse(SINCE) + (n - i) * 1000).toISOString() }));
  const over = windowWorld(pulls(PR_WINDOW_LIMIT + 1));
  assert.throws(() => composeConflictMetrics(SINCE, { run: NO_RUN }), /may be cut short/);
  assert.deepEqual(over.asks().map((ask) => [ask.orderBy, ask.maxPages]), [["CREATED_AT", PR_WINDOW_LIMIT / 100]], "it asked for its five pages and no more, and the refusal stopped the composition at the first window");
  windowWorld(pulls(PR_WINDOW_LIMIT));
  assert.equal(composeConflictMetrics(SINCE, { run: NO_RUN }).opened, PR_WINDOW_LIMIT,
    "the positive control: exactly the limit is a whole window, which the connection can PROVE (no next page) where a bare list length could not");
});

test("wiring: conflictMetrics is the live entry and hands in gh; the composition calls no gh of its own", () => {
  const source = readFileSync(new URL("../board-data.ts", import.meta.url), "utf8");
  const body = (name: string) => {
    const start = source.indexOf(`export function ${name}(`);
    assert.ok(start >= 0, `${name} is exported from board-data.ts`);
    return source.slice(start, source.indexOf("\n}\n", start)).replace(/\/\/.*$/gm, "");
  };
  assert.match(body("conflictMetrics"), /^export function conflictMetrics\(since: string\) \{\s*return composeConflictMetrics\(since, \{ run: gh \}\);\s*$/);
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
