// no-token: gh
/**
 * RULE: DOES THIS ROW'S OWN REGION OVERLAP AN OPEN PR'S ACTUAL FILES? -- B4, #462. See
 * `packages/agent-org/src/row-claim/file-overlap-rule.mjs` for the full account -- it found its first real collision
 * before it was built (two sessions independently avoiding `.github/workflows/auto-arm.yml`), and the
 * gate is usually silent (4 open PRs, 23 files, ZERO pairwise overlap, measured 2026-09-08T04:48:51Z), so
 * ITS OWN ACCEPTANCE MUST BE A CONSTRUCTED OVERLAP -- passing by never firing proves nothing.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  declaredClosedRows, fileOverlapReason, lookupMyRegionFiles, lookupOpenPrFiles,
} from "../row-claim/file-overlap-rule.mjs";
import { declaredRegionFiles } from "../region-paths.mjs";

/** An open PR whose list is COMPLETE: its count is its list's length (#1419 compares the two). */
const pr = (number: number, files: string[]) => ({ number, files, changedFiles: files.length });

// --- fileOverlapReason: THE VERDICT, PURE ---

test("#462's own acceptance shape: a CONSTRUCTED overlap refuses, naming the other PR and the files", () => {
  const { reason } = fileOverlapReason(
    ["packages/agent-org/src/merge-guard.mjs"],
    [pr(406, ["packages/agent-org/src/merge-guard.mjs", "packages/worker-fleet/src/cli-flags.test.ts"])],
  );
  assert.ok(reason);
  assert.match(reason as string, /#406/);
  assert.match(reason as string, /packages\/agent-org\/src\/merge-guard\.mjs/);
});

test("#462's own POSITIVE CONTROL: remove the overlap and it goes quiet", () => {
  const { reason } = fileOverlapReason(
    ["packages/agent-org/src/row-claim.mjs"],
    [pr(406, ["packages/agent-org/src/merge-guard.mjs"])],
  );
  assert.equal(reason, null);
});

test("an empty MY-files list is never folded into a false overlap -- nothing to compare, not a collision", () => {
  const { reason } = fileOverlapReason([], [pr(406, ["packages/agent-org/src/merge-guard.mjs"])]);
  assert.equal(reason, null);
});

test("no other open PRs at all is silent -- the common case", () => {
  const { reason } = fileOverlapReason(["packages/agent-org/src/row-claim.mjs"], []);
  assert.equal(reason, null);
});

test("CHANGESET FILES ARE EXCLUDED on both sides -- two PRs each adding their own do not collide", () => {
  const { reason } = fileOverlapReason(
    [".changeset/my-entry.md", "packages/agent-org/src/row-claim.mjs"],
    [pr(406, [".changeset/their-entry.md"])],
  );
  assert.equal(reason, null, "the only shared PATH PREFIX is .changeset/, and the files themselves differ "
    + "-- this must not read as an overlap");
});

test("a changeset entry with the SAME filename on both sides still does not collide -- changesets are excluded outright", () => {
  const { reason } = fileOverlapReason(
    [".changeset/same-name.md"],
    [pr(406, [".changeset/same-name.md"])],
  );
  assert.equal(reason, null);
});

test("AN EMPTY OTHER-PR FILE LIST IS REPORTED, never folded into 'no conflict' -- #462's own finding", () => {
  // Measured live: checking one PR's files and getting zero looked like "no overlap, proceed" and was
  // actually a MERGED PR whose head had become an ancestor of main, so its diff read empty by
  // construction. An OPEN PR reading zero files is the same shape and is surfaced, not silently trusted.
  const { reason, emptyOtherPrs } = fileOverlapReason(
    ["packages/agent-org/src/row-claim.mjs"],
    [pr(500, [])],
  );
  assert.equal(reason, null, "a zero-file PR alone must not become a hard refusal on its own");
  assert.deepEqual(emptyOtherPrs, [500]);
});

test("a zero-file PR does not hide a REAL overlap with a different PR examined after it", () => {
  const { reason, emptyOtherPrs } = fileOverlapReason(
    ["packages/agent-org/src/row-claim.mjs"],
    [pr(500, []), pr(406, ["packages/agent-org/src/row-claim.mjs"])],
  );
  assert.ok(reason);
  assert.match(reason as string, /#406/);
  assert.deepEqual(emptyOtherPrs, [500]);
});

test("MUTATION target: the overlap check compares actual paths, not merely counts", () => {
  // Two lists of equal LENGTH that share no path at all -- a count-based check would (wrongly) see two
  // ones-element lists and could be tempted to compare sizes; this must stay silent.
  const { reason } = fileOverlapReason(
    ["packages/agent-org/src/row-claim.mjs"],
    [pr(406, ["packages/agent-org/src/merge-guard.mjs"])],
  );
  assert.equal(reason, null);
});

// --- #941: a DIRECTORY in a Region is a prefix, and the overlap DECISION honours it ---

test("#941: a zero-declaration row's Region, read through the REAL parser, now overlaps an open PR under it", () => {
  // #918 and #921 declared exactly this, and to this rule they claimed nothing at all.
  const mine = declaredRegionFiles("## Region\n\n```\npackages/control/ansible/\n```\n") ?? [];
  const { reason } = fileOverlapReason(mine, [pr(950, ["packages/control/ansible/lab-reset.yml"])]);
  assert.match(reason ?? "", /overlaps #950, which already touches: packages\/control\/ansible\/lab-reset\.yml/);
});

test("#941: ...and a directory does not overlap a file BESIDE it, or one that merely shares its spelling", () => {
  const { reason } = fileOverlapReason(["packages/control/ansible/"],
    [pr(951, ["packages/control/src/fleet.mjs", "packages/control/ansible.md"])]);
  assert.equal(reason, null);
});

// --- lookupMyRegionFiles: #710 -- reads the row's DECLARED Region section, never every path its prose
// mentions anywhere (that question belongs to row-reachability.mjs's STARTABLE check, unchanged) ---

test("lookupMyRegionFiles extracts repo-relative paths from the issue body's Region section", () => {
  const run = () => JSON.stringify({ body: "Region: `packages/agent-org/src/row-claim.mjs` and its test under "
    + "`packages/lab/src/packaging/row-claim.test.ts`." });
  const files = lookupMyRegionFiles(455, { run });
  assert.deepEqual(files, ["packages/agent-org/src/row-claim.mjs", "packages/lab/src/packaging/row-claim.test.ts"]);
});

test("lookupMyRegionFiles: a Region section naming no path returns [], not null -- a real, different " +
  "state from having no Region at all", () => {
  const run = () => JSON.stringify({ body: "## Region\n\nJust prose, no paths here." });
  assert.deepEqual(lookupMyRegionFiles(455, { run }), []);
});

test("#710 ACCEPTANCE: a body with NO Region section returns null -- CANNOT_ASK, not an empty list and " +
  "not a scan of the whole body's prose", () => {
  const run = () => JSON.stringify({ body: "Just prose, no Region heading or line anywhere." });
  assert.equal(lookupMyRegionFiles(455, { run }), null);
});

test("#710 REGRESSION FIXTURE: #705-vs-#698's real shape -- a file cited in prose as a worked example, " +
  "outside the Region section, is never returned", () => {
  const run = () => JSON.stringify({ body:
    "Rescuing `packages/lab/scripts/audit-rule-coverage.ts` from `lead/inventory-bootstrap`.\n\n"
    + "## Region\n\n`scripts/` for the helper, `packages/lab/src/packaging/` for its test." });
  assert.deepEqual(lookupMyRegionFiles(455, { run }), []);
});

test("lookupMyRegionFiles returns null, never [], on a failed lookup", () => {
  const run = (): string => { throw new Error("gh: authentication required"); };
  assert.equal(lookupMyRegionFiles(455, { run }), null);
});

// --- lookupOpenPrFiles: one bulk call, never a loop of per-PR lookups ---

test("lookupOpenPrFiles reads every open PR's files AND their count in one call, and pages nothing when lists are complete", () => {
  const calls: string[][] = [];
  const run = (args: string[]) => {
    calls.push(args);
    return JSON.stringify([
      { number: 406, changedFiles: 2, files: [{ path: "packages/agent-org/src/merge-guard.mjs" }, { path: "CLAUDE.md" }] },
      { number: 472, changedFiles: 1, files: [{ path: "packages/lab/src/gates/corpus-snapshot-scope.test.ts" }] },
    ]);
  };
  const files = lookupOpenPrFiles({ run, log: () => {} });
  assert.deepEqual(calls, [["pr", "list", "--repo", "a11ign/a11ign", "--state", "open",
    "--json", "number,changedFiles,files,body"]], "one bulk call, and no REST page for a complete list");
  assert.deepEqual(files, [
    // #2101: `closes` is `[]` for a body that declares nothing -- and for no body at all, which is what
    // these two fixtures have. It is another FIELD on this one call, never another call.
    { ...pr(406, ["packages/agent-org/src/merge-guard.mjs", "CLAUDE.md"]), closes: [] },
    { ...pr(472, ["packages/lab/src/gates/corpus-snapshot-scope.test.ts"]), closes: [] },
  ]);
});

test("lookupOpenPrFiles returns null, never [], on a failed lookup", () => {
  const run = (): string => { throw new Error("network error"); };
  assert.equal(lookupOpenPrFiles({ run }), null);
});

// --- #1419: a PR's list is compared with its OWN count before it is compared with the Region ---
//
// Measured on #1412: `gh pr list --json files` returned 100 of its 113 files, all 100 of them `.changeset/*.md`, so
// the filter emptied the list and B4 printed "ZERO changed files" while `package.json` sat at position 101+.

/** #1412's measured shape: its first 100 files are changesets, and its 13 real files lie beyond the cap. */
const CHANGESETS_100 = Array.from({ length: 100 }, (_, i) => `.changeset/entry-${i}.md`);
const REAL_13 = ["package-lock.json", "package.json", "packages/cli/package.json", "packages/evidence/package.json",
  "packages/judge/package.json", "packages/lab/package.json", "packages/lab/scripts/promote-model.mjs",
  "packages/lab/src/packaging/changeset-zero-major.test.ts", "packages/lab/src/packaging/promote-model.test.ts",
  "packages/lab/src/packaging/promotion-refuses-dirty.test.ts", "packages/nvda-worker/package.json",
  "packages/scorer/package.json", "packages/worker-fleet/package.json"];

test("#1419 DONE-WHEN 2: a PR returning 100 of 113 files, the row's file being number 107, is REFUSED as not comparable", () => {
  const all = [...Array.from({ length: 106 }, (_, i) => `src/f${i}.ts`), "packages/agent-org/src/row-claim.mjs",
    ...Array.from({ length: 6 }, (_, i) => `src/g${i}.ts`)];
  assert.equal(all.length, 113);
  assert.equal(all.indexOf("packages/agent-org/src/row-claim.mjs"), 106, "the row's file is the 107th");
  const { reason } = fileOverlapReason(["packages/agent-org/src/row-claim.mjs"], [{ number: 1412, files: all.slice(0, 100), changedFiles: 113 }]);
  assert.ok(reason, "a short list must never read as 'no overlap'");
  assert.match(reason as string, /#1412/);
  assert.match(reason as string, /100 of its 113 changed files/, "both counts are named, so a reader can check them");
});

test("#1419 DONE-WHEN 2: a PR returning 0 of 113 files is REFUSED as not comparable, never skipped as empty", () => {
  const { reason, emptyOtherPrs } = fileOverlapReason(["packages/agent-org/src/row-claim.mjs"], [{ number: 1412, files: [], changedFiles: 113 }]);
  assert.match(reason as string, /0 of its 113 changed files/);
  assert.deepEqual(emptyOtherPrs, [], "an empty list with a non-zero count is not the zero-files note");
});

test("#1419 DONE-WHEN 3: #1412's shape -- 100 changesets visible of 113, the row naming package.json -- is REFUSED, never 'ZERO changed files'", () => {
  const { reason, emptyOtherPrs } = fileOverlapReason(["package.json"], [{ number: 1412, files: CHANGESETS_100, changedFiles: 113 }]);
  assert.match(reason as string, /cannot compare with #1412: its file list came back with 100 of its 113 changed files/);
  assert.deepEqual(emptyOtherPrs, [], "the changeset filter emptying a SHORT list must not become the zero-files note");
});

test("#1419 POSITIVE CONTROL: a PR whose list equals its count behaves exactly as before, overlap and no-overlap", () => {
  const full = [...CHANGESETS_100, ...REAL_13];
  assert.match(fileOverlapReason(["package.json"], [pr(1412, full)]).reason as string, /overlaps #1412, which already touches: package\.json/);
  assert.equal(fileOverlapReason(["packages/agent-org/src/row-claim.mjs"], [pr(1412, full)]).reason, null);
});

test("#1419 DONE-WHEN 4: the empty-list path, decided -- a count of 0 is the note; a complete changeset-only PR is neither note nor refusal", () => {
  const zero = fileOverlapReason(["packages/agent-org/src/row-claim.mjs"], [pr(500, [])]);
  assert.deepEqual(zero, { reason: null, emptyOtherPrs: [500] }, "#462's shape stays a note");
  const changesetsOnly = fileOverlapReason(["packages/agent-org/src/row-claim.mjs"], [pr(501, [".changeset/a.md", ".changeset/b.md"])]);
  assert.deepEqual(changesetsOnly, { reason: null, emptyOtherPrs: [] },
    "a complete list of changesets touches nothing that can collide, and is not reported as touching no files");
});

test("#1419 a list with NO count is not comparable either -- the count is what makes a list checkable", () => {
  const { reason } = fileOverlapReason(["packages/agent-org/src/row-claim.mjs"],
    [{ number: 9, files: ["packages/agent-org/src/row-claim.mjs"] } as unknown as { number: number; files: string[]; changedFiles: number }]);
  assert.match(reason as string, /cannot compare with #9: its file list came back with 1 of no changed-file count/);
});

test("#1419 THE LOOKUP PAGES A SHORT LIST through REST, once and only for that PR, and the overlap is then found", () => {
  const calls: string[][] = [];
  const run = (args: string[]) => {
    calls.push(args);
    if (args[0] === "pr") {
      return JSON.stringify([
        { number: 1412, changedFiles: 113, files: CHANGESETS_100.map((path) => ({ path })) },
        { number: 1426, changedFiles: 2, files: [{ path: "packages/guards/src/walk-scope.mjs" }, { path: "packages/lab/src/packaging/declared-walk-scope.test.ts" }] },
      ]);
    }
    return [...CHANGESETS_100, ...REAL_13].join("\n") + "\n";
  };
  const others = lookupOpenPrFiles({ run, log: () => {} });
  const rest = calls.filter((args) => args[0] === "api");
  assert.deepEqual(rest, [["api", "--paginate", "repos/a11ign/a11ign/pulls/1412/files?per_page=100", "--jq", ".[].filename"]],
    "exactly one REST page-through, for the short PR only");
  assert.equal(others?.find((o) => o.number === 1412)?.files.length, 113);
  assert.match(fileOverlapReason(["package.json"], others ?? []).reason as string, /overlaps #1412, which already touches: package\.json/,
    "paged to the real overlap -- the 101st-113th files are compared");
});

test("#1419 a FAILED page keeps the short list and says so -- the rule then refuses it; the whole read never becomes null", () => {
  const said: string[] = [];
  const run = (args: string[]) => {
    if (args[0] === "pr") return JSON.stringify([{ number: 1412, changedFiles: 113, files: CHANGESETS_100.map((path) => ({ path })) }]);
    throw new Error("HTTP 502");
  };
  const others = lookupOpenPrFiles({ run, log: (line) => said.push(line) });
  assert.notEqual(others, null, "a null read skips B4 entirely, which is this row's defect by another door");
  assert.equal(others?.[0].files.length, 100);
  assert.match(said.join("\n"), /could not page #1412's files past 100 \(HTTP 502\)/);
  assert.match(fileOverlapReason(["package.json"], others ?? []).reason as string, /cannot compare with #1412/);
});

// --- #2101: A ROW AND ITS OWN PULL REQUEST ARE ONE PIECE OF WORK ---
//
// THE THREE ASSERTIONS THAT MATTER ARE THE TWO NEGATIVES AND THE POSITIVE TOGETHER. This change is one
// `if` away from disabling B4 entirely, so "the row's own PR no longer refuses" is not a result on its
// own: an undeclared PR and a PR declaring ANOTHER row must still refuse, naming the PR and the file, or
// what shipped is "B4 no longer refuses" wearing this row's number.

const REGION_FILE = ".claude/rules/agent-practices.md";

/** #2077's real shape: an open PR touching one file, declaring the row it closes. */
const prClosing = (number: number, files: string[], closes: number[]) =>
  ({ number, files, changedFiles: files.length, closes });

test("#2101 THE POSITIVE: a PR declaring `Closes #<row>` does NOT block that row's claim", () => {
  const { reason } = fileOverlapReason([REGION_FILE], [prClosing(2077, [REGION_FILE], [2076])],
    { rowNumber: 2076 });
  assert.equal(reason, null, "#2076 was unclaimable by everybody behind #2077, which WAS #2076's work");
});

test("#2101 NEGATIVE 1: a PR touching the same file that declares NOTHING still refuses, naming PR and file", () => {
  const { reason } = fileOverlapReason([REGION_FILE], [pr(2077, [REGION_FILE])], { rowNumber: 2076 });
  assert.match(reason as string, /overlaps #2077, which already touches: \.claude\/rules\/agent-practices\.md/);
});

test("#2101 NEGATIVE 2: a PR touching the same file that declares ANOTHER row still refuses", () => {
  const { reason } = fileOverlapReason([REGION_FILE], [prClosing(2077, [REGION_FILE], [2084])],
    { rowNumber: 2076 });
  assert.match(reason as string, /overlaps #2077, which already touches: \.claude\/rules\/agent-practices\.md/);
});

test("#2101 NEGATIVE 3: no `rowNumber` at all excludes NOTHING -- every caller that cannot say which row " +
  "it is asking for gets the unconditional B4 of before", () => {
  const { reason } = fileOverlapReason([REGION_FILE], [prClosing(2077, [REGION_FILE], [2076])]);
  assert.match(reason as string, /overlaps #2077/,
    "a declaration is only ever read against a row number the caller supplied");
});

test("#2101 the exclusion is PER PR, not per call -- the row's own PR is skipped and a THIRD party's " +
  "overlap on the same file is still found", () => {
  const { reason } = fileOverlapReason([REGION_FILE], [
    prClosing(2077, [REGION_FILE], [2076]),
    pr(2084, [REGION_FILE]),
  ], { rowNumber: 2076 });
  assert.match(reason as string, /overlaps #2084/, "skipping one PR must not end the walk");
});

test("#2101 a row's own PR is excluded BEFORE #1419's comparability refusal -- a truncated list on its " +
  "own PR must not deadlock the row by the other door", () => {
  const { reason } = fileOverlapReason([REGION_FILE],
    [{ number: 2077, files: [REGION_FILE], changedFiles: 113, closes: [2076] }], { rowNumber: 2076 });
  assert.equal(reason, null);
});

test("#2101 a row's own PR reading ZERO files is not reported as an empty-list note either -- there is " +
  "nothing to compare with one's own work", () => {
  const { reason, emptyOtherPrs } = fileOverlapReason([REGION_FILE],
    [prClosing(2077, [], [2076])], { rowNumber: 2076 });
  assert.deepEqual({ reason, emptyOtherPrs }, { reason: null, emptyOtherPrs: [] });
});

test("#2101 a single declared row may be written bare, the way a row's own Open-check writes it", () => {
  const own = { number: 2077, files: [REGION_FILE], changedFiles: 1, closes: 2076 };
  assert.equal(fileOverlapReason([REGION_FILE], [own as never], { rowNumber: 2076 }).reason, null);
  assert.match(fileOverlapReason([REGION_FILE], [own as never], { rowNumber: 2084 }).reason as string,
    /overlaps #2077/, "the bare form is read as a declaration, not as a blanket exclusion");
});

// --- #2101: declaredClosedRows -- NO SECOND PARSER ---

test("#2101 declaredClosedRows reads B7's own declaration, and returns [] for every shape that is not a closure", () => {
  assert.deepEqual(declaredClosedRows("Closes #2076"), [2076]);
  assert.deepEqual(declaredClosedRows("Closes #2076, #2084"), [2076, 2084]);
  assert.deepEqual(declaredClosedRows("Closes: none -- a trunk revert"), [],
    "an opt-out declares no row, so it can never exclude one");
  assert.deepEqual(declaredClosedRows("A body that says nothing about closing anything."), []);
  assert.deepEqual(declaredClosedRows("Closes #abc"), [], "MALFORMED excludes nothing");
  assert.deepEqual(declaredClosedRows(null), []);
});

test("#2101 A BARE MENTION IS NEVER A CLOSURE -- `See #2076 for context` in a PR body must not make that " +
  "PR #2076's own work and let it through B4", () => {
  assert.deepEqual(declaredClosedRows("See #2076 for context."), []);
  const { reason } = fileOverlapReason([REGION_FILE],
    [prClosing(2077, [REGION_FILE], declaredClosedRows("See #2076 for context."))], { rowNumber: 2076 });
  assert.match(reason as string, /overlaps #2077/);
});

test("#2101 THE LOOKUP READS `body` ON THE CALL IT ALREADY MAKES, never a second one, and hands the rule " +
  "the declared rows", () => {
  const calls: string[][] = [];
  const run = (args: string[]) => {
    calls.push(args);
    return JSON.stringify([
      { number: 2077, changedFiles: 1, files: [{ path: REGION_FILE }], body: "Closes #2076\n" },
      { number: 2084, changedFiles: 1, files: [{ path: REGION_FILE }], body: "Closes: none -- unrelated" },
    ]);
  };
  const others = lookupOpenPrFiles({ run, log: () => {} });
  assert.equal(calls.length, 1, "one `gh pr list`, `body` among its fields");
  assert.ok(calls[0].join(" ").includes("number,changedFiles,files,body"));
  assert.deepEqual(others?.map((o) => o.closes), [[2076], []]);
  assert.match(fileOverlapReason([REGION_FILE], others ?? [], { rowNumber: 2076 }).reason as string,
    /overlaps #2084/, "its own #2077 is excluded; #2084, which declares nothing, is not");
});
