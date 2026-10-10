// no-token: gh -- `dora.ts` reaches `gh` and the npm registry only through the readers this file injects; the clone is a throwaway git repository built in a temporary directory (a11ign/a11ign#4690)
/**
 * `src/dora.ts`, a11ign/a11ign#4690: ANCESTRY IS READ FROM THE DECLARED CLONE, SO A REPOSITORY THAT RELEASES ~70 TIMES A DAY READS ITS LEAD TIME AS A NUMBER.
 *
 * The retro of 2026-10-10 read `a11ign/agent-org: Lead time for changes: unknown -- ancestry of #569 could not be read (gh api .../compare/... hit its time limit)`: the range was 1,341
 * commits, fourteen pages of 2 to 7 s against a 90 s read timeout. `git merge-base --is-ancestor` on the checkout `host.json` declares answers the same question in 6 ms.
 *
 * THE FIXTURE IS REAL GIT: at least `MIN_RELEASES` commits in a temporary repository, a release at each and a change shipping in the very next one. THE `range` READER THROWS, so a
 * passing reading can only have come from the clone. POSITIVE CONTROLS: the same fixture with no clone declared must CALL the reader and reach it (and say so), a clone that lacks the
 * release commit must fall back and say which commit, and the population asserted below is not empty.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sandboxGitEnv } from "@a11ign/toolchain/lib/git-env";
import { readRepository, renderDora } from "./dora.ts";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

const MIN_RELEASES = 150;
const RELEASES = 160;
const MS_PER_MINUTE = 60_000;
const SHIPS_AFTER_MS = 30_000;
const SHIPS_AFTER_MINUTES = 0.5;
const NOW = Date.parse("2026-10-07T00:00:00Z");
const FIRST_RELEASE_AT = Date.parse("2026-09-30T00:00:00Z");
const REPOSITORY = { repo: "a11ign/frequent", release: { kind: "tag" as const }, releasablePaths: ["src/"] };

const scratch = mkdtempSync(join(tmpdir(), "dora-clone-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: sandboxGitEnv({ GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" }) }).trim();

/** A linear history of `commits` empty commits, returned oldest first. */
function buildClone(name: string, commits: number): string[] {
  const dir = join(scratch, name);
  execFileSync("git", ["init", "-q", dir], { env: sandboxGitEnv() });
  git(dir, "config", "user.email", "t@example.invalid");
  git(dir, "config", "user.name", "t");
  const shas: string[] = [];
  for (let index = 0; index < commits; index += 1) {
    git(dir, "commit", "-q", "--allow-empty", "-m", `c${index}`);
    shas.push(git(dir, "rev-parse", "HEAD"));
  }
  return shas;
}

const chain = buildClone("full", RELEASES);
const cloneDir = join(scratch, "full");
/** A clone holding the history but for the newest commit: fetched from the full one by sha, with no `origin` to fetch the rest from. */
const shortDir = (() => {
  const dir = join(scratch, "short");
  execFileSync("git", ["init", "-q", dir], { env: sandboxGitEnv() });
  git(dir, "fetch", "-q", cloneDir, chain[RELEASES - 2]);
  return dir;
})();
const minute = (index: number) => FIRST_RELEASE_AT + index * MS_PER_MINUTE;
const releases = chain.map((commit, index) => ({ id: `v${index}`, publishedAt: new Date(minute(index)).toISOString(), commit, deprecated: false }));
const merged = chain.slice(1).map((commit, offset) => ({ number: offset + 1, mergedAt: new Date(minute(offset + 1) - SHIPS_AFTER_MS).toISOString(), mergeCommit: commit, paths: [`src/${offset + 1}.mjs`] }));

const readers = (calls: string[], range?: Any) => ({
  releases: () => releases,
  mergedPrs: () => merged,
  regressions: () => [],
  range: range ?? (() => { calls.push("range"); throw new Error("the range reader must not be asked when the clone answers"); }),
}) as Any;

const read = (calls: string[], clones: Record<string, string>, range?: Any) => readRepository({ repository: REPOSITORY as Any, readers: readers(calls, range), now: NOW, clones: { clones } }) as Any;

test("the fixture is a repository that releases on every merge: at least 150 releases, a change in each, in a real clone", () => {
  assert.ok(releases.length >= MIN_RELEASES, `${releases.length} releases`);
  assert.ok(merged.length >= MIN_RELEASES, `${merged.length} changes`);
  assert.equal(git(cloneDir, "rev-list", "--count", "HEAD"), String(RELEASES));
});

test("with a clone declared the lead time is a number, from a `range` reader that was never called, and the reading says the clone answered", () => {
  const calls: string[] = [];
  const reading = read(calls, { frequent: cloneDir });
  assert.equal(reading.status, "read");
  assert.equal(reading.reasons.leadTime, undefined);
  assert.equal(reading.leadTime.changes, merged.length);
  assert.equal(reading.leadTime.unreleased, 0);
  assert.equal(reading.leadTime.medianMinutes, SHIPS_AFTER_MINUTES);
  assert.equal(reading.leadTime.maxMinutes, SHIPS_AFTER_MINUTES);
  assert.deepEqual(calls, []);
  assert.equal(reading.ancestry, "clone");
  assert.ok(!renderDora({ date: "2026-10-07", now: NOW, repositories: [reading] }).some((line) => line.includes("Ancestry read from")), "a clone answer needs no caveat");
});

test("POSITIVE CONTROL: the same fixture with no clone declared CALLS the reader, reaches the fallback, and names it", () => {
  const calls: string[] = [];
  const reading = read(calls, {}, (_repo: unknown, { base, head }: { base: string; head: string }) => {
    calls.push("range");
    const [from, to] = [chain.indexOf(base), chain.indexOf(head)];
    return { status: "ahead", commits: chain.slice(from + 1, to + 1) };
  });
  assert.ok(calls.length >= 1, "the control: the reader was really asked");
  assert.equal(reading.leadTime.medianMinutes, SHIPS_AFTER_MINUTES);
  assert.equal(reading.ancestry, "github compare (no clone is declared for frequent)");
  assert.ok(renderDora({ date: "2026-10-07", now: NOW, repositories: [reading] }).some((line) => line.includes("Ancestry read from github compare (no clone is declared")));
});

test("a clone that LACKS the newest release's commit falls back, says which commit, and still reads the lead time", () => {
  const calls: string[] = [];
  const reading = read(calls, { frequent: shortDir }, (_repo: unknown, { base, head }: { base: string; head: string }) => {
    calls.push(head);
    const [from, to] = [chain.indexOf(base), chain.indexOf(head)];
    return { status: "ahead", commits: chain.slice(from + 1, to + 1) };
  });
  assert.ok(calls.includes(chain[RELEASES - 1]), "the control: the reader was asked for the release the clone lacks");
  assert.equal(reading.leadTime.medianMinutes, SHIPS_AFTER_MINUTES);
  assert.match(reading.ancestry, /^github compare \(the clone of frequent lacks .* and the fetch of its tags failed/);
  assert.match(reading.ancestry, new RegExp(chain[RELEASES - 1].slice(0, 8)));
});

test("a change merged after the only release is unreleased, answered by the clone (the reader is never called)", () => {
  const calls: string[] = [];
  const reading = readRepository({
    repository: REPOSITORY as Any, now: NOW, clones: { clones: { frequent: cloneDir } },
    readers: { ...readers(calls), releases: () => [{ ...releases[10] }], mergedPrs: () => [merged[50]] } as Any,
  }) as Any;
  assert.equal(reading.leadTime.unreleased, 1, "a change merged after the only release is unreleased, read from the clone");
  assert.deepEqual(calls, []);
});

test("a release cut from history that does NOT contain the change is `diverged` in the clone, so the change reads unreleased and is never counted as shipped", () => {
  const tree = git(cloneDir, "rev-parse", `${chain[5]}^{tree}`);
  const sideCommit = git(cloneDir, "commit-tree", tree, "-p", chain[5], "-m", "a side release");
  const calls: string[] = [];
  const reading = readRepository({
    repository: REPOSITORY as Any, now: NOW, clones: { clones: { frequent: cloneDir } },
    readers: { ...readers(calls), releases: () => [{ id: "side", publishedAt: new Date(minute(60)).toISOString(), commit: sideCommit, deprecated: false }], mergedPrs: () => [merged[50]] } as Any,
  }) as Any;
  assert.equal(reading.leadTime.unreleased, 1);
  assert.deepEqual(calls, []);
});
