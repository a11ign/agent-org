/**
 * RULE: DOES THIS ROW'S OWN REGION OVERLAP AN OPEN PR'S ACTUAL FILES? -- B4, #462. See
 * `scripts/row-claim/file-overlap-rule.mjs` for the full account -- it found its first real collision
 * before it was built (two sessions independently avoiding `.github/workflows/auto-arm.yml`), and the
 * gate is usually silent (4 open PRs, 23 files, ZERO pairwise overlap, measured 2026-09-08T04:48:51Z), so
 * ITS OWN ACCEPTANCE MUST BE A CONSTRUCTED OVERLAP -- passing by never firing proves nothing.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  fileOverlapReason, lookupMyRegionFiles, lookupOpenPrFiles,
} from "../../../../scripts/row-claim/file-overlap-rule.mjs";

// --- fileOverlapReason: THE VERDICT, PURE ---

test("#462's own acceptance shape: a CONSTRUCTED overlap refuses, naming the other PR and the files", () => {
  const { reason } = fileOverlapReason(
    ["scripts/merge-guard.mjs"],
    [{ number: 406, files: ["scripts/merge-guard.mjs", "packages/worker-fleet/src/cli-flags.test.ts"] }],
  );
  assert.ok(reason);
  assert.match(reason as string, /#406/);
  assert.match(reason as string, /scripts\/merge-guard\.mjs/);
});

test("#462's own POSITIVE CONTROL: remove the overlap and it goes quiet", () => {
  const { reason } = fileOverlapReason(
    ["scripts/row-claim.mjs"],
    [{ number: 406, files: ["scripts/merge-guard.mjs"] }],
  );
  assert.equal(reason, null);
});

test("an empty MY-files list is never folded into a false overlap -- nothing to compare, not a collision", () => {
  const { reason } = fileOverlapReason([], [{ number: 406, files: ["scripts/merge-guard.mjs"] }]);
  assert.equal(reason, null);
});

test("no other open PRs at all is silent -- the common case", () => {
  const { reason } = fileOverlapReason(["scripts/row-claim.mjs"], []);
  assert.equal(reason, null);
});

test("CHANGESET FILES ARE EXCLUDED on both sides -- two PRs each adding their own do not collide", () => {
  const { reason } = fileOverlapReason(
    [".changeset/my-entry.md", "scripts/row-claim.mjs"],
    [{ number: 406, files: [".changeset/their-entry.md"] }],
  );
  assert.equal(reason, null, "the only shared PATH PREFIX is .changeset/, and the files themselves differ "
    + "-- this must not read as an overlap");
});

test("a changeset entry with the SAME filename on both sides still does not collide -- changesets are excluded outright", () => {
  const { reason } = fileOverlapReason(
    [".changeset/same-name.md"],
    [{ number: 406, files: [".changeset/same-name.md"] }],
  );
  assert.equal(reason, null);
});

test("AN EMPTY OTHER-PR FILE LIST IS REPORTED, never folded into 'no conflict' -- #462's own finding", () => {
  // Measured live: checking one PR's files and getting zero looked like "no overlap, proceed" and was
  // actually a MERGED PR whose head had become an ancestor of main, so its diff read empty by
  // construction. An OPEN PR reading zero files is the same shape and is surfaced, not silently trusted.
  const { reason, emptyOtherPrs } = fileOverlapReason(
    ["scripts/row-claim.mjs"],
    [{ number: 500, files: [] }],
  );
  assert.equal(reason, null, "a zero-file PR alone must not become a hard refusal on its own");
  assert.deepEqual(emptyOtherPrs, [500]);
});

test("a zero-file PR does not hide a REAL overlap with a different PR examined after it", () => {
  const { reason, emptyOtherPrs } = fileOverlapReason(
    ["scripts/row-claim.mjs"],
    [{ number: 500, files: [] }, { number: 406, files: ["scripts/row-claim.mjs"] }],
  );
  assert.ok(reason);
  assert.match(reason as string, /#406/);
  assert.deepEqual(emptyOtherPrs, [500]);
});

test("MUTATION target: the overlap check compares actual paths, not merely counts", () => {
  // Two lists of equal LENGTH that share no path at all -- a count-based check would (wrongly) see two
  // ones-element lists and could be tempted to compare sizes; this must stay silent.
  const { reason } = fileOverlapReason(
    ["scripts/row-claim.mjs"],
    [{ number: 406, files: ["scripts/merge-guard.mjs"] }],
  );
  assert.equal(reason, null);
});

// --- lookupMyRegionFiles: reads the SAME extraction row-reachability.mjs's STARTABLE check uses ---

test("lookupMyRegionFiles extracts repo-relative paths from the issue body", () => {
  const run = () => JSON.stringify({ body: "Region: `scripts/row-claim.mjs` and its test under "
    + "`packages/lab/src/packaging/row-claim.test.ts`." });
  const files = lookupMyRegionFiles(455, { run });
  assert.deepEqual(files, ["scripts/row-claim.mjs", "packages/lab/src/packaging/row-claim.test.ts"]);
});

test("lookupMyRegionFiles: a row naming no path returns [], not null -- a real, different state from a failure", () => {
  const run = () => JSON.stringify({ body: "Just prose, no paths here." });
  assert.deepEqual(lookupMyRegionFiles(455, { run }), []);
});

test("lookupMyRegionFiles returns null, never [], on a failed lookup", () => {
  const run = (): string => { throw new Error("gh: authentication required"); };
  assert.equal(lookupMyRegionFiles(455, { run }), null);
});

// --- lookupOpenPrFiles: one bulk call, never a loop of per-PR lookups ---

test("lookupOpenPrFiles reads every open PR's files in one call", () => {
  const run = (args: string[]) => {
    assert.deepEqual(args, ["pr", "list", "--repo", "DanBeckDev/a11y-witness", "--state", "open",
      "--json", "number,files"]);
    return JSON.stringify([
      { number: 406, files: [{ path: "scripts/merge-guard.mjs" }, { path: "CLAUDE.md" }] },
      { number: 472, files: [{ path: "packages/lab/src/gates/corpus-snapshot-scope.test.ts" }] },
    ]);
  };
  const files = lookupOpenPrFiles({ run });
  assert.deepEqual(files, [
    { number: 406, files: ["scripts/merge-guard.mjs", "CLAUDE.md"] },
    { number: 472, files: ["packages/lab/src/gates/corpus-snapshot-scope.test.ts"] },
  ]);
});

test("lookupOpenPrFiles returns null, never [], on a failed lookup", () => {
  const run = (): string => { throw new Error("network error"); };
  assert.equal(lookupOpenPrFiles({ run }), null);
});
