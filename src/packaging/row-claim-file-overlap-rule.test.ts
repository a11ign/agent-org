// no-token: gh
/**
 * RULE: DOES THIS ROW'S OWN REGION OVERLAP AN OPEN PR'S ACTUAL FILES? -- B4, #462. See
 * `packages/agent-org/src/row-claim/file-overlap-rule.mjs` for the full account -- it found its first real collision
 * before it was built (two sessions independently avoiding `.github/workflows/auto-arm.yml`), and the
 * gate is usually silent (4 open PRs, 23 files, ZERO pairwise overlap, measured 2026-09-08T04:48:51Z), so
 * ITS OWN ACCEPTANCE MUST BE A CONSTRUCTED OVERLAP -- passing by never firing proves nothing.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sandboxGitEnv } from "../lib/git-env.mjs";

// --- (#3233) THE PROJECT THIS FILE RUNS AGAINST IS A RECORDED ONE, NOT A11IGN'S CHECKOUT ---
//
// The rule's defaults -- which tracker a row's `Closes` is read against, which repository `lookupBlockersOf` asks -- come from the project the tool serves,
// and `declaredRegionFiles` asks that project's git for its root files. With no `$AGENT_ORG_HOST` the layout answers a11ign's live checkout, so a11ign
// changing its declaration or its root changed this file's verdict. The host file is set FIRST and the tool imported AFTER it, dynamically; the project is
// `fixtures/row-claim-file-overlap-rule/project`, copied to a temp directory that is made a git repository with no commit (so the root files read as none, whatever
// a11ign holds). `trackedTopLevelDirs` asks `git ls-files` of the PROCESS'S working directory, which under CI was a11ign's root and is now the project: the
// Region's `packages/` and `scripts/` are recognised as paths because THIS tree tracks them, not because a11ign does.
const TRACKED_DIRS = ["packages", "scripts", "docs", ".github", ".claude"];
const SCRATCH = mkdtempSync(join(tmpdir(), "row-claim-file-overlap-"));
after(() => rmSync(SCRATCH, { recursive: true, force: true }));
const PROJECT = join(SCRATCH, "project");
cpSync(fileURLToPath(new URL("./fixtures/row-claim-file-overlap-rule/project", import.meta.url)), PROJECT, { recursive: true });
const HOST_FILE = join(SCRATCH, "host.json");
writeFileSync(HOST_FILE, JSON.stringify({ schema: 1, home: SCRATCH, binDir: join(SCRATCH, "bin"), primary: "fixture",
  projects: [{ id: "fixture", checkout: PROJECT }],
  gh: { workers: join(SCRATCH, "workers"), leads: join(SCRATCH, "leads"), leadsHeader: [], leadsWorkspaces: [] } }));
process.env.AGENT_ORG_HOST = HOST_FILE;
for (const dir of TRACKED_DIRS) {
  mkdirSync(join(PROJECT, dir), { recursive: true });
  writeFileSync(join(PROJECT, dir, "tracked"), "");
}
execFileSync("git", ["init", "--quiet"], { cwd: PROJECT, env: sandboxGitEnv() });
execFileSync("git", ["add", "-A"], { cwd: PROJECT, env: sandboxGitEnv() });
process.chdir(PROJECT);

const { declaredClosedRows, fileOverlapReason, lookupBlockersOf, lookupMyRegionFiles, lookupOpenPrFiles } = await import("../row-claim/file-overlap-rule.mjs");
const { declaredRegionFiles } = await import("../region-paths.mjs");

/** An open PR whose list is COMPLETE: its count is its list's length (#1419 compares the two). */
const pr = (number: number, files: string[]) => ({ number, files, changedFiles: files.length });
/** These tests are about the lookup's MECHANICS over ONE repository; the declaration now lists two (#2969), and `keyed-repo-review.test.ts` pins that the real lookup reads both. */
const ONE_REPOSITORY = [{ key: "", repo: "a11ign/a11ign" }];

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
  const files = lookupOpenPrFiles({ run, log: () => {}, repos: ONE_REPOSITORY });
  assert.deepEqual(calls, [["pr", "list", "--repo", "a11ign/a11ign", "--state", "open",
    "--json", "number,changedFiles,files,body,labels,headRefName"]], "one bulk call, and no REST page for a complete list");
  assert.deepEqual(files, [
    // #2101: `closes` is `[]` for a body that declares nothing -- and for no body at all, which is what
    // these two fixtures have. It is another FIELD on this one call, never another call.
    // #2493: `held` is false for a PR with no `hold:` label, and for one whose `labels` came back absent.
    { ...pr(406, ["packages/agent-org/src/merge-guard.mjs", "CLAUDE.md"]), closes: [], held: false },
    { ...pr(472, ["packages/lab/src/gates/corpus-snapshot-scope.test.ts"]), closes: [], held: false },
  ]);
});

test("lookupOpenPrFiles returns null, never [], on a failed lookup", () => {
  const run = (): string => { throw new Error("network error"); };
  assert.equal(lookupOpenPrFiles({ run, repos: ONE_REPOSITORY }), null);
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
  const others = lookupOpenPrFiles({ run, log: () => {}, repos: ONE_REPOSITORY });
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
  const others = lookupOpenPrFiles({ run, log: (line) => said.push(line), repos: ONE_REPOSITORY });
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
  const others = lookupOpenPrFiles({ run, log: () => {}, repos: ONE_REPOSITORY });
  assert.equal(calls.length, 1, "one `gh pr list`, `body` among its fields");
  assert.ok(calls[0].join(" ").includes("number,changedFiles,files,body"));
  assert.deepEqual(others?.map((o) => o.closes), [[2076], []]);
  assert.match(fileOverlapReason([REGION_FILE], others ?? [], { rowNumber: 2076 }).reason as string,
    /overlaps #2084/, "its own #2077 is excluded; #2084, which declares nothing, is not");
});

// --- #2493: A HELD PR WAITING ON THIS ROW IS NOT A COMPETITOR FOR ITS FILES ---
//
// #2399 was refused for a file #2376 held, and #2376 was waiting on #2399: it declared `Closes #2359`, so it was a
// stranger to the asking row and its wait was a comment. `ceo` (#2400 section 2): exclude ONLY when the PR is
// held AND every row it closes is `blockedBy` the asking row. Each clause below breaks one half.

const ASKING = 2399;
const HELD_CLOSING = (closes: number[], held = true) => ({ ...prClosing(2376, [REGION_FILE], closes), held });
/** `blockersOf` over a fixed table; a row not in it is a FAILED lookup (`null`), as `lookupBlockersOf` reports. */
const edges = (table: Record<number, number[]>) => (row: number) => table[row] ?? null;

test("#2493 THE POSITIVE: a held PR whose every closed row is blockedBy the asking row is EXCLUDED", () => {
  const { reason } = fileOverlapReason([REGION_FILE], [HELD_CLOSING([2359])],
    { rowNumber: ASKING, blockersOf: edges({ 2359: [ASKING] }) });
  assert.equal(reason, null, "#2399 sat behind #2376, which was waiting on it, until it was broken by hand");
});

test("#2493 NEGATIVE: the same held PR with NO edge still refuses", () => {
  const { reason } = fileOverlapReason([REGION_FILE], [HELD_CLOSING([2359])],
    { rowNumber: ASKING, blockersOf: edges({ 2359: [] }) });
  assert.match(reason as string, /overlaps #2376/);
});

test("#2493 NEGATIVE: an edge to a DIFFERENT row is not an edge to the asking row", () => {
  const { reason } = fileOverlapReason([REGION_FILE], [HELD_CLOSING([2359])],
    { rowNumber: ASKING, blockersOf: edges({ 2359: [2084] }) });
  assert.match(reason as string, /overlaps #2376/);
});

test("#2493 NEGATIVE: an edge but NO `hold:` label still refuses -- an unheld PR may merge first", () => {
  const { reason } = fileOverlapReason([REGION_FILE], [HELD_CLOSING([2359], false)],
    { rowNumber: ASKING, blockersOf: edges({ 2359: [ASKING] }) });
  assert.match(reason as string, /overlaps #2376/);
  const noField = fileOverlapReason([REGION_FILE], [prClosing(2376, [REGION_FILE], [2359])],
    { rowNumber: ASKING, blockersOf: edges({ 2359: [ASKING] }) });
  assert.match(noField.reason as string, /overlaps #2376/, "a PR that says nothing about a hold is not held");
});

test("#2493 NEGATIVE: a held PR that declares `Closes: none`, or closes nothing, still refuses -- `every` is " +
  "vacuously true of an empty list", () => {
  const asked: number[] = [];
  const blockersOf = (row: number) => { asked.push(row); return [ASKING]; };
  for (const closes of [[], undefined, null]) {
    const { reason } = fileOverlapReason([REGION_FILE],
      [{ ...pr(2376, [REGION_FILE]), held: true, closes } as never], { rowNumber: ASKING, blockersOf });
    assert.match(reason as string, /overlaps #2376/, `closes=${JSON.stringify(closes)}`);
  }
  assert.deepEqual(asked, [], "nothing to ask about when nothing is closed");
});

test("#2493 NEGATIVE: a held PR closing TWO rows, one without the edge, still refuses", () => {
  const { reason } = fileOverlapReason([REGION_FILE], [HELD_CLOSING([2359, 2360])],
    { rowNumber: ASKING, blockersOf: edges({ 2359: [ASKING], 2360: [2084] }) });
  assert.match(reason as string, /overlaps #2376/);
  const both = fileOverlapReason([REGION_FILE], [HELD_CLOSING([2359, 2360])],
    { rowNumber: ASKING, blockersOf: edges({ 2359: [ASKING], 2360: [ASKING, 2084] }) });
  assert.equal(both.reason, null, "the control: every closed row carrying the edge excludes it");
});

test("#2493 a FAILED lookup of a closed row's blockers reads as NOT excluded, never as excluded", () => {
  const { reason } = fileOverlapReason([REGION_FILE], [HELD_CLOSING([2359, 2360])],
    { rowNumber: ASKING, blockersOf: edges({ 2359: [ASKING] }) });
  assert.match(reason as string, /overlaps #2376/, "2360 could not be read");
});

test("#2493 no `blockersOf`, or no `rowNumber`, excludes NOTHING", () => {
  assert.match(fileOverlapReason([REGION_FILE], [HELD_CLOSING([2359])], { rowNumber: ASKING }).reason as string,
    /overlaps #2376/);
  assert.match(fileOverlapReason([REGION_FILE], [HELD_CLOSING([2359])],
    { blockersOf: edges({ 2359: [ASKING] }) }).reason as string, /overlaps #2376/);
});

test("#2493 the exclusion is PER PR: a held PR waiting on the row is skipped and a THIRD party's overlap is found", () => {
  const { reason } = fileOverlapReason([REGION_FILE], [HELD_CLOSING([2359]), pr(2500, [REGION_FILE])],
    { rowNumber: ASKING, blockersOf: edges({ 2359: [ASKING] }) });
  assert.match(reason as string, /overlaps #2500/);
});

test("#2493 no extra call: `blockersOf` is asked only for a held PR that OVERLAPS", () => {
  const asked: number[] = [];
  const blockersOf = (row: number) => { asked.push(row); return [ASKING]; };
  fileOverlapReason([REGION_FILE], [
    { ...prClosing(2376, ["elsewhere.md"], [2359]), held: true },
    prClosing(2377, [REGION_FILE], [2361]),
  ], { rowNumber: ASKING, blockersOf });
  assert.deepEqual(asked, [], "a held PR on other files, and an unheld one on this file, cost nothing");
  fileOverlapReason([REGION_FILE], [HELD_CLOSING([2359])], { rowNumber: ASKING, blockersOf });
  assert.deepEqual(asked, [2359]);
});

test("#2493 lookupOpenPrFiles reads `held` from a `hold:<session>` label and from no other", () => {
  const run = () => JSON.stringify([
    { number: 1, changedFiles: 1, files: [{ path: "a" }], labels: [{ name: "hold:product-manager" }] },
    { number: 2, changedFiles: 1, files: [{ path: "b" }], labels: [{ name: "session:worker-1" }] },
    { number: 3, changedFiles: 1, files: [{ path: "c" }], labels: [] },
  ]);
  assert.deepEqual(lookupOpenPrFiles({ run, log: () => {}, repos: ONE_REPOSITORY })?.map((p) => [p.number, p.held]),
    [[1, true], [2, false], [3, false]]);
});

test("#2493 lookupBlockersOf reads GitHub's `blockedBy` edge for one row, and a failed read is null", () => {
  const calls: string[][] = [];
  const run = (args: string[]) => {
    calls.push(args);
    return JSON.stringify({ blockedBy: { nodes: [{ number: 2399, state: "OPEN" }, { number: 7, state: "CLOSED" }] } });
  };
  assert.deepEqual(lookupBlockersOf({ run })(2359), [2399, 7]);
  assert.deepEqual(calls, [["issue", "view", "2359", "--repo", "a11ign/a11ign", "--json", "blockedBy"]]);
  assert.equal(lookupBlockersOf({ run: () => { throw new Error("boom"); } })(2359), null);
  assert.deepEqual(lookupBlockersOf({ run: () => JSON.stringify({ blockedBy: { nodes: [] } }) })(2359), []);
});

test("#2493 END TO END through the claim's own lookup: a held PR waiting on the row is excluded with NO `blockersOf` " +
  "passed, and `gh issue view` is spent only on a held PR that overlaps", () => {
  const calls: string[][] = [];
  const edgesOf: Record<string, number[]> = { "2359": [ASKING], "2400": [] };
  const run = (args: string[]) => {
    calls.push(args);
    if (args[0] === "issue") return JSON.stringify({ blockedBy: { nodes: (edgesOf[args[2]] ?? []).map((number) => ({ number, state: "OPEN" })) } });
    return JSON.stringify([
      { number: 2376, changedFiles: 1, files: [{ path: REGION_FILE }], body: "Closes #2359", labels: [{ name: "hold:product-manager" }] },
      { number: 2377, changedFiles: 1, files: [{ path: "elsewhere.md" }], body: "Closes #2400", labels: [{ name: "hold:product-manager" }] },
      { number: 2378, changedFiles: 1, files: [{ path: REGION_FILE }], body: "Closes #2401", labels: [] },
    ]);
  };
  const prs = lookupOpenPrFiles({ run, log: () => {}, repos: ONE_REPOSITORY }) ?? [];
  assert.deepEqual(calls.map((c) => c[0]), ["pr"], "the lookup itself makes no per-row call");
  assert.match(fileOverlapReason([REGION_FILE], prs, { rowNumber: ASKING }).reason as string, /overlaps #2378/,
    "the held PR waiting on the row is skipped; the UNHELD one on the same file still refuses");
  assert.deepEqual(calls.filter((c) => c[0] === "issue").map((c) => c[2]), ["2359"],
    "asked about #2376's closed row only: #2377 does not overlap and #2378 is not held");
  // The control: the same PRs with the edge absent refuse on #2376 first.
  edgesOf["2359"] = [];
  assert.match(fileOverlapReason([REGION_FILE], prs, { rowNumber: ASKING }).reason as string, /overlaps #2376/);
});

// --- #2769: `--adopt` RECOGNISES THE TREE IT IS RE-STAMPING AS ITS OWN, EVEN WHEN ITS PR DECLARES `Closes: none` ---
//
// The row's Open-check: a PR overlapping the Region, `closes: []` (the sanctioned split shape), whose branch is the one being adopted.
// Each NEGATIVE breaks one half of the exclusion (the branch, the flag, the repository), so a guard that always fires or never fires
// cannot pass all of them.

const ADOPTED = "agent/reachable-region-2760";
const splitPr = (over: Record<string, unknown> = {}) => ({ ...prClosing(2766, [REGION_FILE], []), branch: ADOPTED, ...over });

test("#2769 THE POSITIVE: a `Closes: none` PR from the adopted branch does NOT block the adopting claim", () => {
  const { reason } = fileOverlapReason([REGION_FILE], [splitPr()], { rowNumber: 2760, adoptedBranch: ADOPTED });
  assert.equal(reason, null, "#2766 WAS #2760's work; the released claim's PR could not get a fresh CI run without this");
});

test("#2769 CONTROL: the same PR with NO `adoptedBranch` still refuses -- a fresh claim is unchanged (#2101 stands)", () => {
  assert.match(fileOverlapReason([REGION_FILE], [splitPr()], { rowNumber: 2760 }).reason as string, /overlaps #2766/);
  assert.match(fileOverlapReason([REGION_FILE], [splitPr()], { rowNumber: 2760, adoptedBranch: null }).reason as string, /overlaps #2766/);
});

test("#2769 NEGATIVE: a PR from ANOTHER branch on the same file still refuses, adopting or not", () => {
  const stranger = splitPr({ number: 2790, branch: "agent/someone-else-2790" });
  assert.match(fileOverlapReason([REGION_FILE], [stranger], { rowNumber: 2760, adoptedBranch: ADOPTED }).reason as string, /overlaps #2790/);
  const unnamed = { ...prClosing(2791, [REGION_FILE], []) };
  assert.match(fileOverlapReason([REGION_FILE], [unnamed], { rowNumber: 2760, adoptedBranch: ADOPTED }).reason as string, /overlaps #2791/,
    "a PR whose branch was not read is not matched by an empty-vs-empty accident");
});

test("#2769 NEGATIVE: an empty `adoptedBranch` matches nothing, and a same-named branch in ANOTHER repository is not this row's", () => {
  assert.match(fileOverlapReason([REGION_FILE], [splitPr({ branch: "" })], { rowNumber: 2760, adoptedBranch: "" }).reason as string, /overlaps #2766/);
  const layer = splitPr({ repo: "a11ign/nvda-worker", repoKey: "nvda-worker" });
  assert.match(fileOverlapReason([`nvda-worker:${REGION_FILE}`], [layer], { rowNumber: 2760, adoptedBranch: ADOPTED }).reason as string,
    /overlaps #2766 in a11ign\/nvda-worker/);
});

test("#2769 the exclusion is PER PR: the adopted branch's PR is skipped and a THIRD party's overlap is still found", () => {
  const third = splitPr({ number: 2792, branch: "agent/third-2792" });
  assert.match(fileOverlapReason([REGION_FILE], [splitPr(), third], { rowNumber: 2760, adoptedBranch: ADOPTED }).reason as string, /overlaps #2792/);
});

test("#2769 the adopted PR is excluded BEFORE #1419's comparability refusal -- a truncated list on its own PR is not a reason to refuse", () => {
  const truncated = splitPr({ files: [REGION_FILE], changedFiles: 113 });
  assert.equal(fileOverlapReason([REGION_FILE], [truncated], { rowNumber: 2760, adoptedBranch: ADOPTED }).reason, null);
});

test("#2769 THE LOOKUP READS `headRefName` ON THE CALL IT ALREADY MAKES and hands the rule `branch`, absent when not read", () => {
  const calls: string[][] = [];
  const run = (args: string[]) => {
    calls.push(args);
    return JSON.stringify([
      { number: 2766, changedFiles: 1, files: [{ path: REGION_FILE }], body: "Closes: none -- Done-when 3 is still open", headRefName: ADOPTED },
      { number: 2790, changedFiles: 1, files: [{ path: REGION_FILE }], body: "" },
    ]);
  };
  const others = lookupOpenPrFiles({ run, log: () => {}, repos: ONE_REPOSITORY }) ?? [];
  assert.equal(calls.length, 1, "one `gh pr list`, `headRefName` among its fields");
  assert.ok(calls[0].join(" ").includes("headRefName"));
  assert.deepEqual(others.map((o) => o.branch), [ADOPTED, undefined]);
  assert.match(fileOverlapReason([REGION_FILE], others, { rowNumber: 2760, adoptedBranch: ADOPTED }).reason as string, /overlaps #2790/,
    "END TO END from the lookup's own shape: #2766 is skipped by branch, the branchless #2790 is not");
});
