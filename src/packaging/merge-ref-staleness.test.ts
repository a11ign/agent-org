import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mergeRefIsStale, mergeRefStalenessReason, DEFAULT_STALE_THRESHOLD, fetchMergeRefBehindBy,
} from "../../../../scripts/merge-guard/merge-ref-staleness-rule.mjs";

/**
 * #433: `refs/pull/N/merge` is computed at push time and never recomputed -- nine of nine open PRs were
 * measured stale, one by 374 commits, and #413's own red run failed on two fixes already on `main` and
 * absent from the tree its CI actually checked out. `strict: true` branch protection means staleness
 * cannot reach `main` (verified live, 2026-09-09: `gh api repos/.../branches/main/protection` reads
 * `strict: true`) -- what remains open is the DIAGNOSIS: a PR not yet carried can be red for a reason
 * that has nothing to do with its own code, and nothing on it says so.
 *
 * `mergeRefIsStale` is pure; `fetchMergeRefBehindBy` is the real git-calling half, tested with an
 * injected `run` so the "could not ask" path is exercised without a real network call.
 */

test("mergeRefIsStale: a ref within the threshold is not stale", () => {
  assert.deepEqual(mergeRefIsStale(3), { askable: true, stale: false, behindBy: 3 });
});

test("mergeRefIsStale: a ref beyond the threshold is stale", () => {
  assert.deepEqual(mergeRefIsStale(11), { askable: true, stale: true, behindBy: 11 });
});

test("MUTATION TARGET (#433's own instruction): a ref AT main's tip (0 behind) is not stale", () => {
  assert.deepEqual(mergeRefIsStale(0), { askable: true, stale: false, behindBy: 0 });
});

test("mergeRefIsStale: exactly at the threshold is NOT yet stale -- `>`, not `>=`", () => {
  assert.deepEqual(mergeRefIsStale(DEFAULT_STALE_THRESHOLD),
    { askable: true, stale: false, behindBy: DEFAULT_STALE_THRESHOLD });
  assert.deepEqual(mergeRefIsStale(DEFAULT_STALE_THRESHOLD + 1),
    { askable: true, stale: true, behindBy: DEFAULT_STALE_THRESHOLD + 1 });
});

test("mergeRefIsStale: null is COULD NOT ASK, never read as zero behind", () => {
  assert.deepEqual(mergeRefIsStale(null), { askable: false });
});

test("a custom threshold is honoured", () => {
  assert.deepEqual(mergeRefIsStale(2, 1), { askable: true, stale: true, behindBy: 2 });
  assert.deepEqual(mergeRefIsStale(1, 1), { askable: true, stale: false, behindBy: 1 });
});

// --- mergeRefStalenessReason: the sentence a human reads, naming the fact and what to do ---

test("mergeRefStalenessReason: not stale prints nothing", () => {
  assert.deepEqual(mergeRefStalenessReason(mergeRefIsStale(3)), []);
});

test("mergeRefStalenessReason: stale names the count and the remedy (push/update, never re-run)", () => {
  const [reason] = mergeRefStalenessReason(mergeRefIsStale(15));
  assert.match(reason, /15 commit\(s\) behind/);
  assert.match(reason, /push/i);
  assert.doesNotMatch(reason, /^$/);
});

test("mergeRefStalenessReason: could-not-ask is reported as INCONCLUSIVE, never silently dropped", () => {
  const [reason] = mergeRefStalenessReason(mergeRefIsStale(null));
  assert.match(reason, /COULD NOT TELL/);
  assert.match(reason, /INCONCLUSIVE/);
});

test("mergeRefStalenessReason: the main tip, when given, is quoted in the stale message", () => {
  const [reason] = mergeRefStalenessReason(mergeRefIsStale(20), { mainSha: "abcdef1234567890" });
  assert.match(reason, /abcdef1234/);
});

// --- fetchMergeRefBehindBy: the real git-calling half, injected `run` so no network is needed ---

test("fetchMergeRefBehindBy: the happy path fetches, resolves the base, and counts", () => {
  const calls: string[][] = [];
  const run = (cmd: string, args: string[]) => {
    calls.push([cmd, ...args]);
    if (args[0] === "fetch") return "";
    if (args.join(" ") === "rev-parse FETCH_HEAD^1") return "deadbeef00000000000000000000000000000000\n";
    if (args[0] === "rev-list") return "7\n";
    throw new Error(`unexpected call: ${args.join(" ")}`);
  };
  const behindBy = fetchMergeRefBehindBy(42, { run });
  assert.equal(behindBy, 7);
  assert.deepEqual(calls[0], ["git", "fetch", "origin", "pull/42/merge"]);
  assert.deepEqual(calls[2], ["git", "rev-list", "--count", "deadbeef00000000000000000000000000000000..origin/main"]);
});

test("fetchMergeRefBehindBy: a failed fetch returns null, never 0 -- #433's own explicit requirement", () => {
  const run = () => { throw new Error("could not fetch pull/42/merge -- not found"); };
  assert.equal(fetchMergeRefBehindBy(42, { run }), null);
});

test("fetchMergeRefBehindBy: FETCH_HEAD^1 failing to resolve (a merge ref with no parents recorded) "
  + "returns null, never 0", () => {
  const run = (_cmd: string, args: string[]) => {
    if (args[0] === "fetch") return "";
    throw new Error("fatal: ambiguous argument 'FETCH_HEAD^1'");
  };
  assert.equal(fetchMergeRefBehindBy(42, { run }), null);
});

test("fetchMergeRefBehindBy: rev-list itself failing returns null, never 0", () => {
  const run = (_cmd: string, args: string[]) => {
    if (args[0] === "fetch") return "";
    if (args.join(" ") === "rev-parse FETCH_HEAD^1") return "deadbeef\n";
    throw new Error("fatal: bad revision");
  };
  assert.equal(fetchMergeRefBehindBy(42, { run }), null);
});

test("fetchMergeRefBehindBy: unparseable count output returns null, never 0", () => {
  const run = (_cmd: string, args: string[]) => {
    if (args[0] === "fetch") return "";
    if (args.join(" ") === "rev-parse FETCH_HEAD^1") return "deadbeef\n";
    if (args[0] === "rev-list") return "not a number\n";
    throw new Error("unreachable");
  };
  assert.equal(fetchMergeRefBehindBy(42, { run }), null);
});
