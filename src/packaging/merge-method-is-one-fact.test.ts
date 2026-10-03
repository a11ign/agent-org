/**
 * THIS REPOSITORY ALLOWS MERGE COMMITS ONLY, AND NOTHING IN THE CODE SAID SO.
 *
 *     gh api repos/a11ign/a11ign -q '.allow_squash_merge, .allow_merge_commit, .allow_rebase_merge'
 *     false   true   false
 *
 * Measured 2026-09-09, when `gh pr merge 706 --auto --squash` returned:
 *
 *     GraphQL: Merge method squash merging is not allowed on this repository (enablePullRequestAutoMerge)
 *
 * IT DID EMIT AN ERROR. What made it dangerous is that the caller was `gh pr merge ... >/dev/null 2>&1 &&
 * echo armed`, which swallows it, and the exit status was the only remaining signal. The PR sat UNARMED
 * with nothing in the log -- and an unarmed PR is indistinguishable from an armed one until the queue
 * fails to take it. #698 was found in exactly that state by `ceo` earlier the same day.
 *
 * WHAT ACTUALLY CAUGHT IT was reading `autoMergeRequest` back from the API. That is already this
 * repository's rule for the mirror case -- `pr-hold-state.mjs`: "DISARM IS VERIFIED FROM THE STATE, NEVER
 * THE EXIT CODE, because `gh pr merge --disable-auto` returns success on a PR that is already merging,
 * having changed nothing." Arming has the same asymmetry in the other direction, and the same remedy.
 *
 * AND `grep '"--merge"' packages/lab/**\/*.test.ts` LOOKS LIKE COVERAGE AND IS NOT. Every hit is in
 * `merge-queue.test.ts` and every one is about `merge-queue.mjs`'s OWN `--merge=<n>` PR-selector flag
 * (#178) -- the same six characters naming an unrelated thing. A count of the adjacent thing, in the
 * search you would run to check whether this guard was needed.
 *
 * PORTED from a11ign/a11ign `packages/lab/src/packaging/` at 95cb57e33 (a11ign/a11ign#3106), where it walked this tool's source as part of
 * a larger population; it now walks `src/` here, and the sweep finds FIVE sites in four files (`pr-hold.mjs` arms and disarms).
 *
 * So: the call sites are swept out of the source rather than listed here, because a fifth added next
 * month is the case a hand-written list cannot cover -- and a fifth is exactly what happened to
 * `newestPerName` (#634 found the fifth call site of a fix applied four times).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { toolSources, type ToolFile } from "./tool-source.ts";

/** `gh(["pr", "merge", ...])` invocations, with the argument list as written. */
const GH_PR_MERGE = /gh\(\s*\[\s*"pr"\s*,\s*"merge"\s*,([^\]]*)\]/g;

type Site = { file: string; args: string };

/** Every `gh pr merge` call site in `sources`, swept -- never a hand-written list. */
function mergeCallSitesIn(sources: ToolFile[]): Site[] {
  return sources.flatMap(({ path, text }) => [...text.matchAll(GH_PR_MERGE)].map((m) => ({ file: path, args: m[1] })));
}

const describe = (site: Site) => `${site.file}: ${site.args.trim()}`;
const isDisarm = (site: Site) => /"--disable-auto"/.test(site.args);

/** The sites that name a method this repository does not allow. */
const forbiddenMethod = (sites: Site[]) => sites.filter((s) => /"--squash"|"--rebase"/.test(s.args)).map(describe);

/** The sites that arm or merge without stating `--merge`, a disarm being exempt. */
const methodUnnamed = (sites: Site[]) => sites.filter((s) => !isDisarm(s) && !/"--merge"/.test(s.args)).map(describe);

const realSites = () => mergeCallSitesIn(toolSources());

test("the sweep FINDS the call sites -- a floor, because an empty population passes every assertion below", () => {
  const sites = realSites();
  assert.ok(sites.length >= 5,
    `expected at least the five known gh pr merge call sites, found ${sites.length}. If the call shape `
    + "changed, this regex now sweeps an empty population and every assertion below passes vacuously.");
  // Five sites in four files: `pr-hold.mjs` holds the arm AND the disarm.
  const files = sites.map((s) => s.file);
  for (const expected of ["arm-pr.mjs", "auto-arm-sweep.mjs", "merge-queue.mjs", "pr-hold.mjs"]) {
    assert.ok(files.includes(`src/${expected}`), `src/${expected} carries a gh pr merge call and the sweep must reach it`);
  }
});

test("no call site passes --squash or --rebase: this repository allows merge commits only", () => {
  assert.deepEqual(forbiddenMethod(realSites()), [],
    "allow_squash_merge and allow_rebase_merge are BOTH false on this repository, so these calls fail at "
    + "the API with `Merge method squash merging is not allowed`. A caller that redirects stderr sees "
    + "only a non-zero exit, and the PR is left UNARMED with nothing in the log.");
});

test("every call site that ARMS or MERGES names --merge explicitly, rather than relying on the default", () => {
  assert.deepEqual(methodUnnamed(realSites()), [],
    "the method is stated at the call site, never inherited from whatever the repository's default is "
    + "today -- a settings change elsewhere must not silently change what these scripts do.");
});

test("--disable-auto is exempt, and deliberately so -- it names no method because it removes one", () => {
  const disarms = realSites().filter(isDisarm);
  assert.deepEqual(disarms.map((d) => d.file), ["src/pr-hold.mjs"], "pr-hold.mjs holds the only disarm");
  assert.ok(!/"--merge"|"--squash"/.test(disarms[0].args),
    "a disarm takes no merge method; requiring one here would be the guard firing on the honest use");
});

// ---- POSITIVE CONTROL: a planted fixture through the SAME sweep and predicates the real tree goes through -------------------------

const PLANTED = [
  { path: "src/arm-pr.mjs", text: 'gh(["pr", "merge", "--auto", "--merge", number, "--repo", repo], run);' },
  // The exact shape of the command that left #706 unarmed.
  { path: "src/squashes.mjs", text: 'gh(["pr", "merge", "--auto", "--squash", String(number)]);' },
  { path: "src/rebases.mjs", text: 'io.gh(["pr", "merge", String(pr.number), "--rebase"]);' },
  { path: "src/silent.mjs", text: 'gh(["pr", "merge", "--auto", String(number)]);' },
  { path: "src/disarms.mjs", text: 'gh(["pr", "merge", "--disable-auto", String(number)]);' },
];

test("POSITIVE CONTROL: a planted --squash, --rebase and method-less call are each CAUGHT and named, an honest arm and a disarm are not", () => {
  const sites = mergeCallSitesIn(PLANTED);
  assert.equal(sites.length, PLANTED.length, "the sweep must find every planted call, including the `io.gh` spelling");
  assert.deepEqual(forbiddenMethod(sites).map((d) => d.split(":")[0]), ["src/squashes.mjs", "src/rebases.mjs"]);
  assert.deepEqual(methodUnnamed(sites).map((d) => d.split(":")[0]), ["src/squashes.mjs", "src/rebases.mjs", "src/silent.mjs"],
    "a method other than --merge is not NAMING --merge, and the disarm is exempt");
});
