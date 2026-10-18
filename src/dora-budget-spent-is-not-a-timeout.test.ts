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
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { sandboxGitEnv } from "./lib/git-env.ts";
import { removeAll, tmpDirForFile } from "./lib/tmp-fixture.ts";
import { githubReaders, readRepository, tagReleasesFrom } from "./dora.ts";

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
/** A `gh` that lists the releases from a file, answers a `commits/<tag>` at once, and takes `$FAKE_PR_SLEEP` seconds over the merged list (`api graphql`, #5076: it was `pr list --search`); every call is one line of the log. */
writeFileSync(join(bin, "gh"), `#!/bin/sh
echo "$*" >> "${log}"
case "$1 $2" in
  "api repos/a11ign/frequent/releases") cat "${scratch}/releases.json";;
  "api repos/a11ign/frequent/commits/"*) echo "${SHA} ${PARENT}";;
  "api graphql") exec sleep "\${FAKE_PR_SLEEP:-0}";;
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

const NOT_STARTED = /^its merged pull requests could not be read \(gh api graphql was not started: this repository's read budget is spent\)$/;

test("the fixture is a repository that releases on every merge: at least 100 tags, each of them a call of its own when no clone answers", () => {
  assert.ok(TAGS >= MIN_TAGS);
  const { calls } = readWith({ tags: TAGS, budgetMs: 10 * TAGS * COMMIT_MS, timeoutMs: 5_000 });
  assert.equal(calls.filter((line) => line.includes("/commits/")).length, TAGS);
});

test("a budget spent by the tag reads says `was not started: ... budget is spent` for the pull request list, for every metric it ended, and the list was never asked", () => {
  const { reading, calls } = readWith({ tags: TAGS, budgetMs: TAGS * COMMIT_MS, timeoutMs: 5_000 });
  assert.equal(reading.status, "read");
  assert.match(reading.reasons.leadTime, NOT_STARTED);
  assert.ok(!calls.some((line) => line.startsWith("api graphql")), "the control: the merged list (`gh api graphql`) really was not started");
  assert.equal(calls.filter((line) => line.includes("/commits/")).length, TAGS, "the control: the tag reads are what spent it");
  assert.doesNotMatch(reading.reasons.leadTime, /timed out/);
});

test("a merged-list read (`gh api graphql`) that runs past its OWN limit says `timed out after N s`, and not a word of the budget", () => {
  const { reading, calls } = readWith({ tags: 3, budgetMs: 10 * TAGS * COMMIT_MS, timeoutMs: 1_000, prSleep: 5 });
  assert.ok(calls.some((line) => line.startsWith("api graphql")), "the control: the list was started");
  assert.match(reading.reasons.leadTime, /^its merged pull requests could not be read \(gh api graphql timed out after 1 s\)$/);
  assert.doesNotMatch(reading.reasons.leadTime, /budget/);
});

test("a merged-list read given only what was left of the budget says so, with its own limit beside it: neither of the two words above", () => {
  const { reading } = readWith({ tags: 3, budgetMs: 3 * COMMIT_MS + 1_000, timeoutMs: 5_000, prSleep: 8 });
  const reason: string = reading.reasons.leadTime;
  assert.match(reason, /\(gh api graphql timed out after 1 s, all that was left of this repository's read budget \(a call's own limit is 5 s\)\)$/);
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
/**
 * (#1623) A CLONE WITH NO TAGS, MADE AGAIN ONCE IF ITS DIRECTORY WAS REMOVED WHILE GIT WAS WRITING IT. Run 38911039522 failed at import with git's
 * `failed to copy file to '.../no-tags/.git/objects/64/...': No such file or directory`, so the file ran no case, and the teardown found `no-tags` gone. A clone
 * that fails that way is removed and made again; any other failure, or a second one, is thrown as it is.
 */
function cloneWithoutTags(from: string, to: string, clone: (from: string, to: string) => void = (src, dst) => execFileSync("git", ["clone", "-q", "--no-tags", src, dst], { env: sandboxGitEnv(), stdio: ["ignore", "ignore", "pipe"] })): void {
  for (let attempt = 1; ; attempt += 1) {
    rmSync(to, { recursive: true, force: true });
    try { clone(from, to); return; } catch (error) {
      const removedUnderIt = /failed to copy file to .*: No such file or directory/.test(String((error as { stderr?: unknown }).stderr ?? error));
      if (attempt >= 2 || !removedUnderIt) throw error;
    }
  }
}

/** A clone that has the history and none of the tags, with the full one as its `origin`: the first tag asked fetches them. */
const bareDir = join(scratch, "no-tags");
cloneWithoutTags(cloneDir, bareDir);

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

// ---------------------------------------------------------------------------------------------------------------------
// PART THREE (#987): THE DIRECTORY THIS FILE MAKES IS REMOVED, OR THIS FILE FAILS. The merge-queue run 38150393779 left `dora-budget-*` holding 4 of its 5 entries
// with all ten cases green, which ejected an unrelated pull request. These two are the helper's two halves, kept in the file that leaked.

const FIXTURE = fileURLToPath(new URL("./lib/tmp-fixture.ts", import.meta.url));

/** A child that makes a `tmpDirForFile` directory with a file in it and exits through `process.exit`, so the helper's `after` never gets to run. Returns the directory it made. */
function childMakingADirectory(name: string, { exitFallback }: { exitFallback: boolean }): string {
  const script = join(scratch, `${name}.ts`);
  writeFileSync(script, `import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDirForFile } from ${JSON.stringify(FIXTURE)};
const dir = tmpDirForFile("fixture-exit-");
writeFileSync(join(dir, "kept"), "1");
console.log(dir);
${exitFallback ? "" : "process.removeAllListeners('exit');"}
process.exit(0);
`);
  const out = execFileSync("node", [script], { env: { ...sandboxGitEnv(), PATH: process.env.PATH, TMPDIR: scratch }, encoding: "utf8" });
  return out.trim();
}

test("a fork that exits before the helper's `after` runs still has its directory removed, and with the exit fallback taken away the same child leaves it (the positive control)", () => {
  const left = childMakingADirectory("without-fallback", { exitFallback: false });
  assert.ok(existsSync(join(left, "kept")), "the control: a child whose `after` never runs and has no exit fallback leaves its directory");
  const removed = childMakingADirectory("with-fallback", { exitFallback: true });
  assert.ok(!existsSync(removed), `${removed} is still there after its process exited`);
});

test("a directory that cannot be removed does not stop the others, and is named in a failure thrown at the end", () => {
  const made = new Set([join(scratch, "stuck-a"), join(scratch, "stuck-b"), join(scratch, "stuck-c")]);
  for (const dir of made) mkdirSync(dir);
  const stuck = join(scratch, "stuck-b");
  const remove = (dir: string) => { if (dir === stuck) throw Object.assign(new Error("busy"), { code: "ENOTEMPTY" }); execFileSync("rmdir", [dir]); };
  assert.throws(() => removeAll(made, remove), (error: Error) => error.message.includes(`${stuck}: ENOTEMPTY`) && !error.message.includes("stuck-a"));
  assert.ok(!existsSync(join(scratch, "stuck-a")) && !existsSync(join(scratch, "stuck-c")), "the directories either side of the stuck one are removed");
  assert.deepEqual([...made], [stuck], "only the one that failed stays registered, for the exit fallback");
  removeAll(made);
  assert.ok(!existsSync(stuck));
});

// (#1623) THE CLONE'S DIRECTORY REMOVED WHILE GIT WRITES IT: made again once, and anything else is thrown as it is.
test("a clone whose directory is removed while git writes it is made again once, and the second clone is the whole history", () => {
  const made = join(scratch, "removed-while-written");
  let calls = 0;
  cloneWithoutTags(cloneDir, made, (src, dst) => {
    calls += 1;
    if (calls > 1) {
      execFileSync("git", ["clone", "-q", "--no-tags", src, dst], { env: sandboxGitEnv() });
      return;
    }
    mkdirSync(join(dst, ".git", "objects", "64"), { recursive: true });
    throw Object.assign(new Error("Command failed"), { stderr: Buffer.from(`fatal: failed to copy file to '${dst}/.git/objects/64/2165ec9c474d50279dd78b9ae0e6b2a18bbe16': No such file or directory\n`) });
  });
  assert.equal(calls, 2, "the removal is made good with one more clone");
  assert.equal(git(made, "rev-parse", "HEAD"), chain[TAGS - 1]);
  assert.equal(git(made, "tag", "--list"), "", "--no-tags: the clone holds none of the tags");
});

test("a clone that fails any other way, or fails with the removal twice, is thrown as it is, and the removal is tried at most twice", () => {
  let calls = 0;
  const denied = () => {
    calls += 1;
    throw Object.assign(new Error("Command failed\nfatal: repository not found"), { stderr: Buffer.from("fatal: repository not found\n") });
  };
  assert.throws(() => cloneWithoutTags(cloneDir, join(scratch, "denied"), denied), /repository not found/);
  assert.equal(calls, 1, "the control: a failure that is not the removal is not made again");
  calls = 0;
  const removedTwice = () => {
    calls += 1;
    throw Object.assign(new Error("Command failed\nfatal: failed to copy file to 'x': No such file or directory"), { stderr: Buffer.from("fatal: failed to copy file to 'x': No such file or directory\n") });
  };
  assert.throws(() => cloneWithoutTags(cloneDir, join(scratch, "twice"), removedTwice), /No such file or directory/);
  assert.equal(calls, 2);
});
