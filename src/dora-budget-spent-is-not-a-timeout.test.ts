// no-token: gh -- every `gh` here is a script written into a temp directory and put first on PATH; the clone is a throwaway git repository in a temporary directory (a11ign/agent-org#754)
/**
 * `src/dora.ts`, a11ign/agent-org#754: THE RETRO SAYS WHICH LIMIT ENDED A READ, AND READS THE TAG COMMITS FROM THE CLONE.
 *
 * The retro of 2026-10-10 read `a11ign/agent-org: Lead time for changes: unknown -- its merged pull requests could not be read (gh pr list hit its time limit)`. Measured: the
 * release list, then 409 `commits/<tag>` calls (218 s together), then `gh pr list` with the 17 s of the 240 s budget that were left, which is less than the 24 s it takes. The
 * words `hit its time limit` were the same for that, for a call that ran its own 90 s, and for one never started, so the reader could not tell a slow `gh pr list` from a spent budget.
 *
 * PART ONE: THE WORDS. Through the real `readRepository`, the real `run` and the real `githubReaders`, with a `gh` script in a temp directory. Each `commits/<tag>` call costs
 * `COMMIT_MS` of a FAKE clock (`Date.now` counts the calls the script has logged), so a budget is about the count of tags and not about how fast this machine spawns. A call that
 * runs past its limit is a real `sleep` the real timeout kills.
 * PART TWO: THE TAGS. At least `MIN_TAGS` tags in a real clone, half of them annotated; the reader that stands for `gh api .../commits/<tag>` is a spy. POSITIVE CONTROL: the same
 * fixture with no clone declared calls the spy once per tag, so a zero is not a spy that was never wired.
 */
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sandboxGitEnv } from "./lib/git-env.ts";
import { tmpDirForFile } from "./lib/tmp-fixture.ts";
import { githubReaders, readRepository, tagReleasesFrom } from "./dora.ts";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

const MIN_TAGS = 100;
const TAGS = 120;
const COMMIT_MS = 1_000;
const MS_PER_MINUTE = 60_000;
const NOW = Date.parse("2026-10-06T00:00:00Z");
const FIRST_RELEASE_AT = Date.parse("2026-10-05T00:00:00Z");
const SHA = "0123456789012345678901234567890123456789";
const PARENT = "9876543210987654321098765432109876543210";
const REPOSITORY = { repo: "a11ign/frequent", release: { kind: "tag" as const }, releasablePaths: ["src/"] };

const scratch = tmpDirForFile("dora-budget-");
const releaseRows = (count: number) => Array.from({ length: count }, (_, index) => ({ tag_name: `v${index}`, published_at: new Date(FIRST_RELEASE_AT + index * MS_PER_MINUTE).toISOString(), draft: false }));

// ---------------------------------------------------------------------------------------------------------------------
// PART ONE: which limit ended the call

const log = join(scratch, "calls.log");
const bin = join(scratch, "bin");
execFileSync("mkdir", ["-p", bin]);
/** A `gh` that lists the releases from a file, answers a `commits/<tag>` at once, and takes `$FAKE_PR_SLEEP` seconds over `pr list`; every call is one line of the log. */
writeFileSync(join(bin, "gh"), `#!/bin/sh
echo "$*" >> "${log}"
case "$1 $2" in
  "api repos/a11ign/frequent/releases") cat "${scratch}/releases.json";;
  "api repos/a11ign/frequent/commits/"*) echo "${SHA} ${PARENT}";;
  "pr list") exec sleep "\${FAKE_PR_SLEEP:-0}";;
  "repo view") echo '{"hasIssuesEnabled":false}';;
esac
`);
chmodSync(join(bin, "gh"), 0o755);
process.env.PATH = `${bin}:${process.env.PATH}`;

const callsLogged = () => readFileSync(log, "utf8").split("\n").filter((line) => line !== "");
const realNow = Date.now;
afterEach(() => { Date.now = realNow; delete process.env.FAKE_PR_SLEEP; });

/** `tags` releases, each resolved by its own `commits/<tag>` call that costs `COMMIT_MS` of the fake clock; no clone is declared, so nothing else answers them. */
function readWith({ tags, budgetMs, timeoutMs, prSleep = 0 }: { tags: number; budgetMs: number; timeoutMs: number; prSleep?: number }) {
  writeFileSync(log, "");
  writeFileSync(join(scratch, "releases.json"), JSON.stringify([releaseRows(tags)]));
  process.env.FAKE_PR_SLEEP = String(prSleep);
  Date.now = () => NOW + COMMIT_MS * callsLogged().filter((line) => line.includes("/commits/")).length;
  const reading = readRepository({ repository: REPOSITORY as Any, readers: githubReaders, now: NOW, limits: { timeoutMs, repositoryMs: budgetMs }, clones: { clones: {} } }) as Any;
  return { reading, calls: callsLogged() };
}

const NOT_STARTED = /^its merged pull requests could not be read \(gh pr list was not started: this repository's read budget is spent\)$/;

test("the fixture is a repository that releases on every merge: at least 100 tags, each of them a call of its own when no clone answers", () => {
  assert.ok(TAGS >= MIN_TAGS);
  const { calls } = readWith({ tags: TAGS, budgetMs: 10 * TAGS * COMMIT_MS, timeoutMs: 5_000 });
  assert.equal(calls.filter((line) => line.includes("/commits/")).length, TAGS);
});

test("a budget spent by the tag reads says `was not started: ... budget is spent` for the pull request list, for every metric it ended, and the list was never asked", () => {
  const { reading, calls } = readWith({ tags: TAGS, budgetMs: TAGS * COMMIT_MS, timeoutMs: 5_000 });
  assert.equal(reading.status, "read");
  assert.match(reading.reasons.leadTime, NOT_STARTED);
  assert.ok(!calls.some((line) => line.startsWith("pr list")), "the control: `gh pr list` really was not started");
  assert.equal(calls.filter((line) => line.includes("/commits/")).length, TAGS, "the control: the tag reads are what spent it");
  assert.doesNotMatch(reading.reasons.leadTime, /timed out/);
});

test("a `gh pr list` that runs past its OWN limit says `timed out after N s`, and not a word of the budget", () => {
  const { reading, calls } = readWith({ tags: 3, budgetMs: 10 * TAGS * COMMIT_MS, timeoutMs: 1_000, prSleep: 5 });
  assert.ok(calls.some((line) => line.startsWith("pr list")), "the control: the list was started");
  assert.match(reading.reasons.leadTime, /^its merged pull requests could not be read \(gh pr list timed out after 1 s\)$/);
  assert.doesNotMatch(reading.reasons.leadTime, /budget/);
});

test("a `gh pr list` given only what was left of the budget says so, with its own limit beside it: neither of the two words above", () => {
  const { reading } = readWith({ tags: 3, budgetMs: 3 * COMMIT_MS + 1_000, timeoutMs: 5_000, prSleep: 8 });
  const reason: string = reading.reasons.leadTime;
  assert.match(reason, /\(gh pr list timed out after 1 s, all that was left of this repository's read budget \(a call's own limit is 5 s\)\)$/);
  assert.doesNotMatch(reason, NOT_STARTED);
});

test("the three are three different strings, and none says only `hit its time limit`", () => {
  const spent = readWith({ tags: 3, budgetMs: 3 * COMMIT_MS, timeoutMs: 5_000 }).reading.reasons.leadTime;
  const own = readWith({ tags: 3, budgetMs: 100 * COMMIT_MS, timeoutMs: 1_000, prSleep: 5 }).reading.reasons.leadTime;
  const left = readWith({ tags: 3, budgetMs: 3 * COMMIT_MS + 1_000, timeoutMs: 5_000, prSleep: 8 }).reading.reasons.leadTime;
  assert.equal(new Set([spent, own, left]).size, 3);
  for (const reason of [spent, own, left]) assert.doesNotMatch(reason, /hit its time limit/);
});

// ---------------------------------------------------------------------------------------------------------------------
// PART TWO: the tags are read from the clone

const gitEnv = sandboxGitEnv({ GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" });
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: gitEnv }).trim();

/** A linear history of `TAGS` empty commits in a real repository, a tag `v<i>` at each: the even ones lightweight, the odd ones annotated (a tag OBJECT, whose commit is the peeled one). */
const cloneDir = join(scratch, "full");
execFileSync("git", ["init", "-q", cloneDir], { env: sandboxGitEnv() });
git(cloneDir, "config", "user.email", "t@example.invalid");
git(cloneDir, "config", "user.name", "t");
const chain: string[] = [];
for (let index = 0; index < TAGS; index += 1) {
  git(cloneDir, "commit", "-q", "--allow-empty", "-m", `c${index}`);
  chain.push(git(cloneDir, "rev-parse", "HEAD"));
  if (index % 2 === 0) git(cloneDir, "tag", `v${index}`);
  else git(cloneDir, "tag", "-a", "-m", `v${index}`, `v${index}`);
}
/** A clone that has the history and none of the tags, with the full one as its `origin`: the first tag asked fetches them. */
const bareDir = join(scratch, "no-tags");
execFileSync("git", ["clone", "-q", "--no-tags", cloneDir, bareDir], { env: sandboxGitEnv() });

/** `readRepository` over the fixture's tags with `commitOf` standing for `gh api .../commits/<tag>`; returns what that was asked for and the commits the releases ended up with. */
function readTags({ clones, rows = releaseRows(TAGS) }: { clones: Record<string, string>; rows?: Any[] }) {
  const asked: string[] = [];
  let placed: { id: string, commit: string | null }[] = [];
  const readers = {
    releases: (repository: Any, window: Any) => {
      const listed = tagReleasesFrom({ rows, repository, since: window.since, commits: { commitOf: (_repo: string, ref: string) => { asked.push(ref); return SHA; }, tagCommit: window.tagCommit } });
      placed = listed.map((release) => ({ id: release.id, commit: release.commit }));
      return listed;
    },
    mergedPrs: () => [],
    regressions: () => [],
    range: () => null,
  } as Any;
  const reading = readRepository({ repository: REPOSITORY as Any, readers, now: NOW, clones: { clones } }) as Any;
  return { asked, placed, reading };
}

test("the fixture holds at least 100 tags, half of them annotated, in a real clone", () => {
  assert.ok(TAGS >= MIN_TAGS);
  assert.equal(git(cloneDir, "tag", "--list").split("\n").length, TAGS);
  assert.equal(git(cloneDir, "cat-file", "-t", "v1"), "tag");
  assert.equal(git(cloneDir, "cat-file", "-t", "v0"), "commit");
});

test("POSITIVE CONTROL: with no clone declared every tag is a call of its own to the injected reader", () => {
  const { asked, placed } = readTags({ clones: {} });
  assert.equal(asked.length, TAGS);
  assert.ok(placed.every((release) => release.commit === SHA));
});

test("with a clone declared N tags resolve to their commits with the injected reader called ZERO times, the annotated ones peeled to the commit", () => {
  const { asked, placed, reading } = readTags({ clones: { frequent: cloneDir } });
  assert.deepEqual(asked, []);
  assert.deepEqual(placed.map((release) => release.commit), chain);
  assert.equal(reading.status, "read");
  assert.equal(reading.deploymentFrequency.value, TAGS);
});

test("a clone that holds the history but none of the tags fetches them once, and still makes no call per tag", () => {
  assert.equal(git(bareDir, "tag", "--list"), "", "the control: the clone really has no tags before");
  const { asked, placed } = readTags({ clones: { frequent: bareDir } });
  assert.deepEqual(asked, []);
  assert.deepEqual(placed.map((release) => release.commit), chain);
});

test("a tag the clone does NOT hold, even after the fetch, is asked of GitHub: that tag only", () => {
  const rows = [...releaseRows(TAGS), { tag_name: "v-only-on-github", published_at: new Date(FIRST_RELEASE_AT + TAGS * MS_PER_MINUTE).toISOString(), draft: false }];
  const { asked, placed } = readTags({ clones: { frequent: cloneDir }, rows });
  assert.deepEqual(asked, ["v-only-on-github"]);
  assert.equal(placed.find((release) => release.id === "v-only-on-github")?.commit, SHA);
  assert.deepEqual(placed.slice(0, TAGS).map((release) => release.commit), chain);
});
