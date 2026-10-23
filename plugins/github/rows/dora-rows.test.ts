// no-token: gh -- the operations are handed a stub `run`, and the budget cases run the plugin's runner over an injected `exec` (one of them over a `gh` script written into a temp directory, so a real child is cut); nothing reaches the real `gh`
/**
 * A11-160 (step 8): WHAT THE DORA READER ASKS GITHUB AND HOW GITHUB'S ANSWER IS READ, AND THE BUDGET THAT BOUNDS EVERY ONE OF THOSE CALLS. Core's tests of the reader (`src/dora-*.test.ts`) run on the fake code host's world;
 * the argument lists of the five operations, their `--paginate --slurp` shapes and how a refusal or a non-JSON answer is thrown are held here, and so are the cases that need the PLUGIN'S runner:
 * a call that ran past its limit is recorded as the one the budget (or its own limit) ended, `ETIMEDOUT` through the code host's runner, and said so in the reading's reason (moved from
 * `src/dora-budget-spent-is-not-a-timeout.test.ts` and `src/org-retro-dora-resumes.test.ts`, which stubbed a `gh` on PATH).
 */
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readRepository, githubReaders } from "../../../src/dora.ts";
import { forgetActivation, substituteCodeHost } from "../../../src/plugins/active.ts";
import { fakePluginDeps } from "../../../src/plugins/fakes/deps.ts";
import { realExec } from "../../../src/plugins/real-seams.ts";
import type { ExecOptions, ExecResult } from "../../../src/plugins/manifest.ts";
import { tmpDirForFile } from "../../../src/lib/tmp-fixture.ts";
import { createCodeHost } from "../code-host.ts";
import { compareRangeOf, commitAndParentsTextOf, hasIssuesEnabled, pullMergeOf, releasesOf } from "./dora-rows.ts";
import { recording } from "./recording-run.test.support.ts";

type Any = any;

// ---------------------------------------------------------------------------------------------------------------------
// THE FIVE OPERATIONS: the argument list each builds and how the answer is read

test("the commit a tag names is ONE read that carries the parents: the tag is encoded in the path, and the text is handed back as printed", () => {
  const { run, asked } = recording("0123 9876,5555\n");
  assert.equal(commitAndParentsTextOf({ repo: "a11ign/frequent", ref: "v1.0.0+build/7", run }), "0123 9876,5555\n");
  assert.deepEqual(asked, [["api", "repos/a11ign/frequent/commits/v1.0.0%2Bbuild%2F7", "--jq", "[.sha, (.parents | map(.sha) | join(\",\"))] | join(\" \")"]]);
  assert.throws(() => commitAndParentsTextOf({ repo: "o/r", ref: "v1", run: recording(new Error("HTTP 404")).run }), /HTTP 404/);
});

test("the releases are every page of `repos/<repo>/releases` slurped, and flattened out of the pages", () => {
  const { run, asked } = recording([[{ tag_name: "v1" }, { tag_name: "v2" }], [{ tag_name: "v3" }]]);
  assert.deepEqual(releasesOf({ repo: "a11ign/frequent", run }).map((release) => release.tag_name), ["v1", "v2", "v3"]);
  assert.deepEqual(asked, [["api", "repos/a11ign/frequent/releases", "--paginate", "--slurp"]]);
  assert.deepEqual(releasesOf({ repo: "o/r", run: recording([[]]).run }), [], "a repository with no release is the empty list");
});

test("the releases of a refused read, or of an answer that is not JSON, are THROWN and never an empty list", () => {
  assert.throws(() => releasesOf({ repo: "o/r", run: recording(new Error("HTTP 502")).run }), /HTTP 502/);
  assert.throws(() => releasesOf({ repo: "o/r", run: recording("not json").run }), SyntaxError);
});

test("whether issues are enabled is `repo view --json hasIssuesEnabled`, true only for true", () => {
  const { run, asked } = recording({ hasIssuesEnabled: true });
  assert.equal(hasIssuesEnabled({ repo: "a11ign/frequent", run }), true);
  assert.deepEqual(asked, [["repo", "view", "a11ign/frequent", "--json", "hasIssuesEnabled"]]);
  assert.equal(hasIssuesEnabled({ repo: "o/r", run: recording({ hasIssuesEnabled: false }).run }), false);
  assert.equal(hasIssuesEnabled({ repo: "o/r", run: recording({}).run }), false, "an answer without the field is not an enabled repository");
  assert.throws(() => hasIssuesEnabled({ repo: "o/r", run: recording(new Error("HTTP 502")).run }), /HTTP 502/);
});

test("a comparison is `base...head` at 100 a page, paginated and slurped, and its pages are handed back as they came", () => {
  const pages = [{ status: "ahead", commits: [{ sha: "a" }] }, { commits: [{ sha: "b" }] }];
  const { run, asked } = recording(pages);
  assert.deepEqual(compareRangeOf({ repo: "a11ign/frequent", base: "v1", head: "main", run }), pages);
  assert.deepEqual(asked, [["api", "repos/a11ign/frequent/compare/v1...main?per_page=100", "--paginate", "--slurp"]]);
  assert.throws(() => compareRangeOf({ repo: "o/r", base: "a", head: "b", run: recording(new Error("HTTP 404")).run }), /HTTP 404/);
});

test("the merge of a pull request is `pr view <n> -R <repo> --json mergeCommit,mergedAt`", () => {
  const answer = { mergeCommit: { oid: "abc" }, mergedAt: "2026-10-05T00:00:00Z" };
  const { run, asked } = recording(answer);
  assert.deepEqual(pullMergeOf({ repo: "a11ign/frequent", number: 569, run }), answer);
  assert.deepEqual(asked, [["pr", "view", "569", "-R", "a11ign/frequent", "--json", "mergeCommit,mergedAt"]]);
  assert.throws(() => pullMergeOf({ repo: "o/r", number: 1, run: recording("nope").run }), SyntaxError);
});

// ---------------------------------------------------------------------------------------------------------------------
// THE BUDGET: which limit ended a call. Through the real `readRepository` and `githubReaders`, over the plugin's runner with an injected `exec`.
// Each `commits/<tag>` call costs `COMMIT_MS` of a FAKE clock (`Date.now` counts the calls made), so a budget is about the count of tags and not about how fast this machine spawns.

const COMMIT_MS = 1_000;
const TAGS = 120;
const MS_PER_MINUTE = 60_000;
const NOW = Date.parse("2026-10-06T00:00:00Z");
const FIRST_RELEASE_AT = Date.parse("2026-10-05T00:00:00Z");
const SHA = "0123456789012345678901234567890123456789";
const PARENT = "9876543210987654321098765432109876543210";
const REPOSITORY = { repo: "a11ign/frequent", release: { kind: "tag" as const }, releasablePaths: ["src/"] };
const releaseRows = (count: number) => Array.from({ length: count }, (_, index) => ({ tag_name: `v${index}`, published_at: new Date(FIRST_RELEASE_AT + index * MS_PER_MINUTE).toISOString(), draft: false }));
const EMPTY_MERGED_PAGE = JSON.stringify({ data: { repository: { pullRequests: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } } });
const TIMED_OUT: ExecResult = { status: null, stdout: "", stderr: "spawnSync gh ETIMEDOUT", spawnError: "spawnSync gh ETIMEDOUT", signal: "SIGTERM" };

const realNow = Date.now;
afterEach(() => { Date.now = realNow; forgetActivation(); });

/**
 * The GitHub plugin in place over an `exec` that stands for `gh`: it lists `tags` releases of `REPOSITORY`, answers a `commits/<tag>` at once, and takes `prSleepMs` over the merged list (`api graphql`), which is cut at the
 * limit it was given, as the real child would be. Every call is recorded with the bound it was given.
 */
function readWith({ tags, budgetMs, timeoutMs, prSleepMs = 0 }: { tags: number; budgetMs: number; timeoutMs: number; prSleepMs?: number }) {
  const calls: { line: string; timeoutMs: number | undefined }[] = [];
  const exec = (_file: string, args: readonly string[], options: ExecOptions = {}): ExecResult => {
    const line = args.join(" ");
    calls.push({ line, timeoutMs: options.timeoutMs });
    if (line.startsWith("api repos/a11ign/frequent/releases")) return { status: 0, stdout: JSON.stringify([releaseRows(tags)]), stderr: "" };
    if (line.startsWith("api repos/a11ign/frequent/commits/")) return { status: 0, stdout: `${SHA} ${PARENT}\n`, stderr: "" };
    if (line.startsWith("api graphql")) return prSleepMs > (options.timeoutMs ?? Infinity) ? TIMED_OUT : { status: 0, stdout: EMPTY_MERGED_PAGE, stderr: "" };
    if (line.startsWith("repo view")) return { status: 0, stdout: JSON.stringify({ hasIssuesEnabled: false }), stderr: "" };
    return { status: 1, stdout: "", stderr: `unexpected: ${line}` };
  };
  substituteCodeHost(createCodeHost(fakePluginDeps({ exec })));
  const commitCalls = () => calls.filter(({ line }) => line.includes("/commits/")).length;
  Date.now = () => NOW + COMMIT_MS * commitCalls();
  const reading = readRepository({ repository: REPOSITORY as Any, readers: githubReaders, now: NOW, limits: { timeoutMs, repositoryMs: budgetMs }, clones: { clones: {} } }) as Any;
  return { reading, calls, commitCalls: commitCalls() };
}

const NOT_STARTED = /^its merged pull requests could not be read \(gh api graphql was not started: this repository's read budget is spent\)$/;

test("the fixture is a repository that releases on every merge: with no clone every tag is a call of its own, and a roomy budget reads the repository", () => {
  const { reading, commitCalls } = readWith({ tags: TAGS, budgetMs: 10 * TAGS * COMMIT_MS, timeoutMs: 5_000 });
  assert.equal(commitCalls, TAGS);
  assert.equal(reading.status, "read");
});

test("a budget spent by the tag reads says `was not started: ... budget is spent` for the pull request list, for every metric it ended, and the list was never asked", () => {
  const { reading, calls, commitCalls } = readWith({ tags: TAGS, budgetMs: TAGS * COMMIT_MS, timeoutMs: 5_000 });
  assert.equal(reading.status, "read");
  assert.match(reading.reasons.leadTime, NOT_STARTED);
  assert.ok(!calls.some(({ line }) => line.startsWith("api graphql")), "the control: the merged list (`gh api graphql`) really was not started");
  assert.equal(commitCalls, TAGS, "the control: the tag reads are what spent it");
  assert.doesNotMatch(reading.reasons.leadTime, /timed out/);
});

test("a merged-list read (`gh api graphql`) that runs past its OWN limit says `timed out after N s`, and not a word of the budget", () => {
  const { reading, calls } = readWith({ tags: 3, budgetMs: 10 * TAGS * COMMIT_MS, timeoutMs: 1_000, prSleepMs: 5_000 });
  const asked = calls.find(({ line }) => line.startsWith("api graphql"));
  assert.ok(asked, "the control: the list was started");
  assert.equal(asked.timeoutMs, 1_000, "and was given its own limit");
  assert.match(reading.reasons.leadTime, /^its merged pull requests could not be read \(gh api graphql timed out after 1 s\)$/);
  assert.doesNotMatch(reading.reasons.leadTime, /budget/);
});

test("a merged-list read given only what was left of the budget says so, with its own limit beside it: neither of the two words above", () => {
  const { reading, calls } = readWith({ tags: 3, budgetMs: 3 * COMMIT_MS + 1_000, timeoutMs: 5_000, prSleepMs: 8_000 });
  const reason: string = reading.reasons.leadTime;
  assert.equal(calls.find(({ line }) => line.startsWith("api graphql"))?.timeoutMs, 1_000, "the call was given what was left of the budget, less than its own 5 s");
  assert.match(reason, /\(gh api graphql timed out after 1 s, all that was left of this repository's read budget \(a call's own limit is 5 s\)\)$/);
  assert.doesNotMatch(reason, NOT_STARTED);
});

test("the three are three different strings, and none says only `hit its time limit`", () => {
  const spent = readWith({ tags: 3, budgetMs: 3 * COMMIT_MS, timeoutMs: 5_000 }).reading.reasons.leadTime;
  const own = readWith({ tags: 3, budgetMs: 100 * COMMIT_MS, timeoutMs: 1_000, prSleepMs: 5_000 }).reading.reasons.leadTime;
  const left = readWith({ tags: 3, budgetMs: 3 * COMMIT_MS + 1_000, timeoutMs: 5_000, prSleepMs: 8_000 }).reading.reasons.leadTime;
  assert.equal(new Set([spent, own, left]).size, 3);
  for (const reason of [spent, own, left]) assert.doesNotMatch(reason, /hit its time limit/);
});

// ---------------------------------------------------------------------------------------------------------------------
// THE CHILD: a `gh` that never returns is ended by the bound on the child (a11ign/a11ign#3736). The plugin's runner is built over `realExec` and a script written into a temp directory, so what ends it is
// the real timeout and not a stub that answers "timed out".

const FIRST = "a11ign/first";
const HUNG = "a11ign/hung";
const TIGHT = { timeoutMs: 400, repositoryMs: 2_000 };

/** The GitHub plugin in place over a `gh` script that answers every read with an empty world and never returns for `HUNG` (`exec`, so the sleep IS the child and killing it ends it). `started` counts the calls made. */
function installHangingGh() {
  const bin = tmpDirForFile("fake-gh-");
  const script = join(bin, "gh");
  writeFileSync(script, `#!/bin/sh
case "$*" in *${HUNG}*) exec sleep 30;; esac
case "$1 $2" in
  "api repos/"*) echo '[[]]';;
  "api graphql") echo '${EMPTY_MERGED_PAGE}';;
  "repo view") echo '{"hasIssuesEnabled":false}';;
esac
`);
  chmodSync(script, 0o755);
  const started: string[] = [];
  substituteCodeHost(createCodeHost(fakePluginDeps({ exec: (_file, args, options) => { started.push(args.join(" ")); return realExec(script, args, options); } })));
  return { started };
}
const declared = (repo: string) => ({ repo, release: { kind: "tag" as const }, releasablePaths: ["src/"] });

test("THE CONTROL: a repository whose `gh` never returns ends at the bound on the child, and the reading is unknown naming the call that ran out", () => {
  installHangingGh();
  const began = Date.now();
  const reading = readRepository({ repository: declared(HUNG) as Any, now: NOW, limits: TIGHT, clones: { clones: {} } }) as Any;
  const wall = Date.now() - began;
  assert.ok(wall < 10_000, `the read must finish inside the bound and not wait out the 30 s sleep, took ${wall} ms`);
  assert.equal(reading.status, "unknown");
  assert.match(reading.reason, /gh api repos\/a11ign\/hung\/releases timed out after 400 ms/, "the unknown names the call that ran out");
});

test("a repository that reads fine through the same `gh` is read, not unknown (the script is healthy outside the hung repository)", () => {
  installHangingGh();
  const reading = readRepository({ repository: declared(FIRST) as Any, now: NOW, limits: TIGHT, clones: { clones: {} } }) as Any;
  assert.equal(reading.status, "no release yet");
});

test("a repository whose own budget is spent starts no more children and is unknown naming the call", () => {
  const { started } = installHangingGh();
  const reading = readRepository({ repository: declared(FIRST) as Any, now: NOW, limits: { timeoutMs: 400, repositoryMs: 0 }, clones: { clones: {} } }) as Any;
  assert.equal(reading.status, "unknown");
  assert.match(reading.reason ?? "", /gh api repos\/a11ign\/first\/releases was not started: this repository's read budget is spent/);
  assert.deepEqual(started, [], "and not one `gh` was started");
});
