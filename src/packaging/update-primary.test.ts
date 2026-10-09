// no-token: claimRefusal -- updatePrimary and readPrimaryDrift reach prune-worktrees.ts only for `isPrimaryWorktree`, a `.git`-is-a-directory check; nothing here asks GitHub, and the gate's cases live in work-gate.test.ts
/**
 * `primary:update` is the ONE sanctioned way to move the primary checkout (#126), which makes it the only
 * place a rebuild can live and be reached every time.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { existsSync, mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { sandboxGitEnv } from "../lib/git-env.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { updatePrimary, lockfileMoved, readPrimaryDrift } from "../update-primary.ts";
import { changedFiles } from "../lib/changed-files.ts";
import { withGitSandbox } from "../lib/git-sandbox.ts";
import { UPDATE_PRIMARY_VERBS } from "./update-primary-argv.ts";

/**
 * MOVING THE PRIMARY MOVES EVERY WORKTREE'S `dist`, AND NOTHING ELSE DOES.
 *
 * Every linked worktree shares the primary's `node_modules`, so a cross-package import from any of them
 * resolves to THE PRIMARY'S `dist` — CLAUDE.md states it, and `docs/operational-lessons.md` records the
 * afternoon spent finding that "resolves to dist" does not say whose. So a fast-forward advances the
 * SOURCE nine worktrees compile against while leaving the COMPILED OUTPUT wherever it last was.
 *
 * Measured 2026-09-09: the orchestrator's DOCS-ONLY push was refused by the pre-push hook on a module
 * `main` has and the primary's `dist` did not. A docs change, refused by a resolution failure, in a
 * worktree that had never been anything but current — and nothing in the message could point at the
 * primary, because the primary was not what they had touched.
 *
 * The build belongs IN the update rather than beside it: anything a human has to remember is something
 * that does not happen, and `primary:update` is already the one sanctioned way to move this checkout
 * (#126), which makes it the only place this can live and be reached every time.
 */
test("#749 updatePrimary BUILDS after the fast-forward -- the source moves and dist must follow", () => {
  const calls: string[][] = [];
  const root = mkdtempSync(join(tmpdir(), "a11y-primary-build-"));
  try {
    mkdirSync(join(root, ".git"));
    const built: string[] = [];
    updatePrimary(root, (args) => { calls.push(args); return "abc123\n"; }, (cwd) => built.push(cwd));
    assert.deepEqual(built, [root], "the build runs, once, in the primary");
    const order = calls.map((c) => c[0]);
    // The second `rev-parse` is `moveLocalMain` reading `refs/heads/main`; this stub returns the same sha
    // for everything, so it finds the branch already at the target and stops there. The order that
    // matters is unchanged: the build runs AFTER the checkout.
    // The verbs come from the SAME list `primary-checkout-guard.test.ts` asserts in full -- see
    // `update-primary-argv.ts` for why that is one constant rather than two.
    assert.deepEqual(order, [...UPDATE_PRIMARY_VERBS],
      "and it runs AFTER the checkout -- building the tree you are about to move is building the wrong tree");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("#749 a FAILED build throws, naming what it means, and does NOT roll the checkout back", () => {
  const root = mkdtempSync(join(tmpdir(), "a11y-primary-buildfail-"));
  try {
    mkdirSync(join(root, ".git"));
    const calls: string[][] = [];
    assert.throws(
      () => updatePrimary(root, (args) => { calls.push(args); return "abc123\n"; },
        () => { throw Object.assign(new Error("boom"), { status: 2 }); }),
      /worktree resolves THIS checkout's dist/,
      "the message must say what a stale dist DOES, not merely that a build failed");
    assert.ok(calls.some((c) => c[0] === "checkout"),
      "the fast-forward already happened and is correct; a failed build must not revert a checkout "
      + "somebody else may already be reading");
    assert.ok(!calls.some((c) => c[0] === "reset" || c[0] === "revert"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("#749 MUTATION TARGET: without the build call the source moves and dist does not, silently", () => {
  // The pre-#749 shape, written out: fetch, checkout, rev-parse, return. Nothing announces that every
  // worktree is now compiling against a dist one or more commits behind its own source.
  const calls: string[][] = [];
  const root = mkdtempSync(join(tmpdir(), "a11y-primary-mutation-"));
  try {
    mkdirSync(join(root, ".git"));
    const built: string[] = [];
    updatePrimary(root, (args) => { calls.push(args); return "abc123\n"; }, (cwd) => built.push(cwd));
    assert.notDeepEqual(built, [], "if this passes with an empty list, the build is no longer wired");
  } finally { rmSync(root, { recursive: true, force: true }); }
});


// ---------------------------------------------------------------------------------------------------
// THE LOCAL `main` BRANCH IS SHARED BY EVERY WORKTREE, AND NOTHING MOVED IT.
//
// The primary is detached at `origin/main` deliberately — that is what makes it read-only except
// fast-forward. But `main` is a branch in the same `.git`, checked out nowhere. Measured 2026-09-09: it
// sat at `11d77ade` from 07 Sep while `origin/main` was `cb9dfbce`, **1405 commits behind**, and all 76
// worktrees resolve that one ref.
//
// A range against bare `main` therefore answers a two-day-old question, and the answer looks exactly
// like an answer: `rev-list --count main..<branch>` reported 502 where `origin/main..<branch>` reported
// 1, and a session called a one-commit `wip` branch an old divergent rewrite on the strength of it.

/** Drives `updatePrimary` with a scripted `run`, recording every argv. */
function driveUpdate(reply: (args: string[]) => string) {
  const calls: string[][] = [];
  const root = mkdtempSync(join(tmpdir(), "a11y-primary-main-"));
  try {
    mkdirSync(join(root, ".git"));
    updatePrimary(root, (args) => { calls.push(args); return reply(args); }, () => {});
  } finally { rmSync(root, { recursive: true, force: true }); }
  return calls;
}

test("the local `main` branch is fast-forwarded to the same sha the primary moved to", () => {
  const calls = driveUpdate((args) =>
    args[0] === "rev-parse" && args[1] === "refs/heads/main" ? "old111\n" : "new222\n");
  const update = calls.find((c) => c[0] === "update-ref");
  assert.deepEqual(update, ["update-ref", "refs/heads/main", "new222", "old111"],
    "and it passes the EXPECTED OLD VALUE, so the write refuses rather than races if another session "
    + "moved the ref first");
});

test("MUTATION: a DIVERGED local `main` is left alone -- it is somebody's unpushed work, and this "
  + "command destroys nothing", () => {
  const calls = driveUpdate((args) => {
    if (args[0] === "merge-base") throw new Error("not an ancestor");
    return args[1] === "refs/heads/main" ? "old111\n" : "new222\n";
  });
  assert.equal(calls.some((c) => c[0] === "update-ref"), false,
    "`git branch -f` would move it without complaint, which is the one thing this must not do");
});

test("CONTROL: no local `main` at all is not an error, and does not create one", () => {
  const calls = driveUpdate((args) => {
    if (args[0] === "rev-parse" && args[1] === "refs/heads/main") throw new Error("unknown revision");
    return "new222\n";
  });
  assert.equal(calls.some((c) => c[0] === "update-ref"), false);
  assert.equal(calls.some((c) => c[0] === "branch"), false, "creating one is not this command's job");
});

test("CONTROL: a `main` already at the target writes nothing -- no ref update, no merge-base", () => {
  const calls = driveUpdate(() => "same333\n");
  assert.equal(calls.some((c) => c[0] === "update-ref"), false);
  assert.equal(calls.some((c) => c[0] === "merge-base"), false);
});

/**
 * THE COPY MUST NOT COME BACK. Both argv assertions now read `update-primary-argv.ts`; nothing stops a
 * future edit from inlining the list again, and inlining it is exactly what produced the merge-blocking
 * red on 2026-09-09 — one file updated, the other found by CI.
 *
 * So this asserts on the SOURCE of both test files: neither may contain the argv literal itself. It is a
 * text check because that is what the defect is — two copies of one fact — and no behavioural test can
 * see the difference between one constant and two identical ones.
 */
test("neither argv assertion carries its own copy of the list -- the fact is stated once", () => {
  const here = (name: string) =>
    readFileSync(fileURLToPath(new URL(name, import.meta.url)), "utf8");
  for (const name of ["update-primary.test.ts", "primary-checkout-guard.test.ts"]) {
    const src = here(name);
    assert.match(src, /UPDATE_PRIMARY_(ARGV|VERBS)/,
      `${name} must assert THROUGH the shared list`);
    assert.doesNotMatch(src.replace(/^\s*\/\/.*$/gm, ""),
      /\["checkout", "--detach", "origin\/main", "--quiet"\]/,
      `${name} carries its own copy of the argv list -- that is the fact stated twice, and the copy `
      + "that survives is the one nobody is looking at");
  }
});


// ---------------------------------------------------------------------------------------------------
// #1384: A MERGE THAT MOVES THE LOCKFILE MUST INSTALL, OR EVERY WORKTREE'S PUSH FAILS.
//
// Every linked worktree resolves the primary's `node_modules`. Measured 2026-09-13: #1380 (`8fe2db08`)
// added `@rstest/core` as a root devDependency, `primary:update` moved the primary to the new lockfile and
// rebuilt, nothing installed, and every push from the host failed its pre-push typecheck with TS2307 from
// 18:46Z until `ceo` installed by hand.
//
// The expected file name is written as a literal throughout, never imported from the script: a constant
// read from the source it checks would pass with the wrong name in both places.

type Asked = { range: string[]; pathspec: string[] };

/**
 * Drives `updatePrimary` across a MOVED head: HEAD reads `old111` before the checkout and `new222` after,
 * and the shared `main` is already at `new222`. The changed-paths helper answers `changedAnswer`. Records
 * every git argv, every question put to the helper and every npm argv, and returns what was thrown rather
 * than throwing it.
 */
function driveMove(changedAnswer: string[], npm: (args: string[]) => void = () => {}) {
  const git: string[][] = [];
  const asked: Asked[] = [];
  const npmCalls: string[][] = [];
  let headReads = 0;
  let thrown: unknown;
  const root = mkdtempSync(join(tmpdir(), "a11y-primary-lockfile-"));
  try {
    mkdirSync(join(root, ".git"));
    const run = (args: string[]) => {
      git.push(args);
      if (args[0] === "rev-parse" && args[1] === "HEAD") return headReads++ === 0 ? "old111\n" : "new222\n";
      return args[0] === "rev-parse" ? "new222\n" : "";
    };
    const changed = (range: string[], pathspec: string[]) => { asked.push({ range, pathspec }); return changedAnswer; };
    try {
      updatePrimary(root, run, (_cwd, args) => { npmCalls.push(args); npm(args); }, changed);
    } catch (error) {
      thrown = error;
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
  return { git, asked, npmCalls, thrown };
}

test("#1384 ACCEPTANCE: a move that changed the lockfile runs pnpm install, BEFORE the build", () => {
  const { git, asked, npmCalls, thrown } = driveMove(["pnpm-lock.yaml"]);
  assert.equal(thrown, undefined);
  assert.deepEqual(asked, [{ range: ["old111", "new222"], pathspec: ["pnpm-lock.yaml"] }],
    "the question is asked of the commit the checkout LEFT and the one it ARRIVED at, for the root lockfile");
  assert.equal(git.some((argv) => argv[0] === "diff"), false,
    "#939: the paths come from packages/guards/src/changed-files.ts, never from a second spelling of the diff");
  assert.deepEqual(npmCalls, [["pnpm", "install", "--frozen-lockfile"], ["pnpm", "run", "build"]],
    "install first: a build before it compiles the new source against the old node_modules");
});

test("#1384 CONTROL: a move that did NOT change the lockfile asks the question and installs nothing", () => {
  const { asked, npmCalls, thrown } = driveMove([]);
  assert.equal(thrown, undefined);
  assert.equal(asked.length, 1,
    "the positive control for the absence below: the lockfile question WAS asked, and answered no");
  assert.deepEqual(npmCalls, [["pnpm", "run", "build"]]);
});

test("#1384 the install is NEVER npm ci -- it would delete node_modules from under every worktree", () => {
  const { npmCalls } = driveMove(["pnpm-lock.yaml"]);
  const installs = npmCalls.filter((argv) => argv[1] !== "run");
  assert.deepEqual(installs, [["pnpm", "install", "--frozen-lockfile"]],
    "exactly one install, and it is pnpm's (#2301: the lockfile it reads is pnpm-lock.yaml, not npm's)");
  assert.equal(npmCalls.some((argv) => argv.includes("ci") || argv.includes("clean-install")), false,
    "`npm ci` deletes node_modules before installing, which removes it from under every running worktree");
});

test("#1384 a HEAD that did not move asks no lockfile question at all", () => {
  const npmCalls: string[][] = [];
  const asked: Asked[] = [];
  const root = mkdtempSync(join(tmpdir(), "a11y-primary-unmoved-"));
  try {
    mkdirSync(join(root, ".git"));
    updatePrimary(root, () => "same333\n", (_cwd, args) => npmCalls.push(args),
      (range, pathspec) => { asked.push({ range, pathspec }); return ["pnpm-lock.yaml"]; });
  } finally { rmSync(root, { recursive: true, force: true }); }
  assert.deepEqual(asked, [], "a range from a commit to itself is empty by construction, so it is not asked");
  assert.deepEqual(npmCalls, [["pnpm", "run", "build"]]);
});

test("#1384 the lockfile is matched BY NAME: a nested pnpm-lock.yaml in the answer does not install", () => {
  const { npmCalls } = driveMove(["packages/x/pnpm-lock.yaml"]);
  assert.deepEqual(npmCalls, [["pnpm", "run", "build"]]);
});

test("#1384 a FAILED install throws naming the stale node_modules, skips the build, and rolls nothing back", () => {
  const { git, npmCalls, thrown } = driveMove(["pnpm-lock.yaml"], (args) => {
    if (args[1] === "install") throw Object.assign(new Error("boom"), { status: 7 });
  });
  assert.ok(thrown instanceof Error, "reported, never swallowed");
  assert.match(thrown.message, /stale node_modules/, "the message says what a failed install DOES to every worktree");
  assert.match(thrown.message, /exit 7/);
  assert.match(thrown.message, /will NOT retry/, "a re-run finds HEAD at the target and asks nothing, so it must say so");
  assert.match(thrown.message, /never `npm ci`/, "the by-hand remedy must not be the one that breaks every worktree");
  assert.equal((thrown.cause as Error).message, "boom");
  assert.deepEqual(npmCalls, [["pnpm", "install", "--frozen-lockfile"]], "the build does not run against a node_modules known to be stale");
  assert.ok(git.some((argv) => argv[0] === "checkout"), "the checkout already moved and is correct");
  assert.equal(git.some((argv) => argv[0] === "reset" || argv[0] === "revert" || argv.includes("old111") && argv[0] === "checkout"),
    false, "a failed install must not revert a checkout somebody else may already be reading");
});

test("#1384 lockfileMoved through the REAL changed-files helper: the root lockfile, across one commit or several", () => {
  withGitSandbox((sandbox) => {
    const commitWith = (path: string, content: string) => {
      mkdirSync(join(sandbox.dir, path, ".."), { recursive: true });
      writeFileSync(join(sandbox.dir, path), content);
      sandbox.run(["add", path]);
      sandbox.commit(`write ${path}`);
      return sandbox.run(["rev-parse", "HEAD"]).trim();
    };
    const changed = (range: string[], pathspec: string[]) => changedFiles(range, { repoRoot: sandbox.dir, pathspec });
    const first = commitWith("pnpm-lock.yaml", '{"lockfileVersion":3}\n');
    const readmeOnly = commitWith("README.md", "docs\n");
    const nestedOnly = commitWith("packages/x/pnpm-lock.yaml", "{}\n");
    const lockfile = commitWith("pnpm-lock.yaml", '{"lockfileVersion":3,"packages":{}}\n');
    sandbox.run(["mv", "pnpm-lock.yaml", "moved-lock.json"]);
    sandbox.commit("move the lockfile away");
    const movedAway = sandbox.run(["rev-parse", "HEAD"]).trim();
    assert.equal(lockfileMoved(changed, first, readmeOnly), false, "a README-only move is not a lockfile move");
    assert.equal(lockfileMoved(changed, readmeOnly, nestedOnly), false, "a nested pnpm-lock.yaml is not the root one");
    assert.equal(lockfileMoved(changed, nestedOnly, lockfile), true, "the root lockfile changed");
    assert.equal(lockfileMoved(changed, first, lockfile), true, "a fast-forward spanning several commits, the real shape");
    assert.equal(lockfileMoved(changed, lockfile, movedAway), true,
      "a lockfile moved AWAY is a lockfile move. NOT a pin on #939's --no-renames: measured, this stays true with "
      + "the flag removed from changed-files.ts, because the pathspec excludes the destination. What keeps this "
      + "read on the helper is changed-files-renames.test.ts and the ACCEPTANCE test's no-diff-through-run line");
  });
});

// --- #2781: a dirty primary is a SIGNAL ---------------------------------------------------------------------------------
//
// `a11ign-work-tick.service` runs `primary:update` as `ExecStartPre=-`, so a failed update is invisible to systemd. On
// 2026-09-28T12:01Z a tracked edit in the primary began refusing every checkout and the gate ran 22 hours on old code.
// These drive REAL repositories: an origin, a clone that is the "primary" (its `.git` is a directory), and the exact scenario.

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd, env: sandboxGitEnv(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

/** An origin with `a.txt`, and a clone of it standing at `origin/main`. `advance()` lands a newer commit on origin and fetches it. */
function primaryAndOrigin() {
  const base = mkdtempSync(join(tmpdir(), "a11y-primary-drift-"));
  const origin = join(base, "origin");
  const primary = join(base, "primary");
  mkdirSync(origin);
  git(origin, "init", "-q", "-b", "main");
  writeFileSync(join(origin, "a.txt"), "one\n");
  git(origin, "add", "a.txt");
  git(origin, "commit", "-q", "-m", "first");
  git(base, "clone", "-q", origin, primary);
  const advance = () => {
    writeFileSync(join(origin, "a.txt"), `${readFileSync(join(origin, "a.txt"), "utf8")}more\n`);
    git(origin, "commit", "-q", "-am", "newer");
    git(primary, "fetch", "-q", "origin");
  };
  return { base, origin, primary, advance };
}

test("#2781 a CLEAN primary at origin/main reads current -- the control every signal below is measured against", () => {
  const { base, primary } = primaryAndOrigin();
  try {
    const drift = readPrimaryDrift(primary)!;
    assert.deepEqual({ behind: drift.behind, ahead: drift.ahead, dirty: drift.dirty }, { behind: 0, ahead: 0, dirty: [] });
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("#2781 ACCEPTANCE: a tracked edit that CONFLICTS with a newer origin/main makes updatePrimary fail, and the read then names the path", () => {
  const { base, primary, advance } = primaryAndOrigin();
  try {
    writeFileSync(join(primary, "a.txt"), "an interactive session's edit\n");
    advance();
    assert.throws(() => updatePrimary(primary, undefined, () => {}), /would be overwritten|local changes/i,
      "the failure the journal recorded 2,652 times is reproduced, not assumed");
    const drift = readPrimaryDrift(primary)!;
    assert.deepEqual({ behind: drift.behind, dirty: drift.dirty }, { behind: 1, dirty: ["a.txt"] });
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("#2781 done-when 4: a dirty primary is read BEFORE any update fails -- no newer origin/main is needed", () => {
  const { base, primary } = primaryAndOrigin();
  try {
    writeFileSync(join(primary, "a.txt"), "edited\n");
    const drift = readPrimaryDrift(primary)!;
    assert.equal(drift.behind, 0, "origin has not moved, so the update would still succeed");
    assert.deepEqual(drift.dirty, ["a.txt"]);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("#2781 an UNTRACKED file is not a dirty path: the build writes them here and the checkout never refuses over one", () => {
  const { base, primary } = primaryAndOrigin();
  try {
    writeFileSync(join(primary, "scratch.log"), "x\n");
    assert.deepEqual(readPrimaryDrift(primary)!.dirty, []);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("#2781 a primary AHEAD of origin/main (an unpushed commit) is reported as ahead", () => {
  const { base, primary } = primaryAndOrigin();
  try {
    writeFileSync(join(primary, "b.txt"), "local\n");
    git(primary, "add", "b.txt");
    git(primary, "commit", "-q", "-m", "local only");
    assert.equal(readPrimaryDrift(primary)!.ahead, 1);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("#2781 UNASKABLE is null, never a clean reading: a linked worktree, and a repository with no origin/main", () => {
  const { base, primary } = primaryAndOrigin();
  try {
    mkdirSync(join(base, "not-primary"));
    writeFileSync(join(base, "not-primary", ".git"), "gitdir: elsewhere\n");
    assert.equal(readPrimaryDrift(join(base, "not-primary")), null, "its .git is a file, as in a linked worktree");
    git(primary, "update-ref", "-d", "refs/remotes/origin/main");
    assert.equal(readPrimaryDrift(primary), null, "no origin/main to compare against");
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("#2781 the CLI `--drift` only READS: from a worktree it answers asked:false and moves nothing", () => {
  const entry = fileURLToPath(new URL("../update-primary.ts", import.meta.url));
  const run = spawnSync(process.execPath, [entry, "--drift"], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  const parsed = JSON.parse(run.stdout);
  assert.equal(typeof parsed.asked, "boolean");
  assert.equal(parsed.asked, parsed.drift !== null, "asked and the reading agree");
  const refused = spawnSync(process.execPath, [entry, "--nonsense"], { encoding: "utf8" });
  assert.notEqual(refused.status, 0, "an unknown flag is still refused (#164)");
});

test("#2781 done-when 3: the `-` on ExecStartPre may stay ONLY while the gate reads the primary and has a cause for it", () => {
  const unit = readFileSync(fileURLToPath(new URL("../../host/work-tick.service.in", import.meta.url)), "utf8");
  const silent = /^ExecStartPre=-.*primary:update/m.test(unit);
  const gate = readFileSync(fileURLToPath(new URL("../work-gate.ts", import.meta.url)), "utf8");
  assert.ok(/^ExecStartPre=.*primary:update/m.test(unit), "control: the unit still runs the update, so this test is asking about something");
  if (silent) {
    assert.match(gate, /readPrimaryDriftNow\(\)/, "a silent update with no reader is the 22 hours");
    assert.match(gate, /cause: "primary-stale"/);
    assert.match(unit, /primary-stale/, "and the unit says where its failure is reported");
  }
});

/**
 * #3566 -- THE BUILD RAN ON EVERY TICK, WHETHER OR NOT THE PRIMARY MOVED.
 *
 * Measured 2026-10-06 on a scratch clone at an idle host: `pnpm run build` with nothing changed took 11.6 to
 * 12.4 s of wall and 27.6 to 29.9 s of CPU, run by the `work-tick` unit's `ExecStartPre` 30 times an hour.
 * The skip needs all three of: HEAD unmoved, the last SUCCESSFUL build was of this sha, its output still there.
 */
const SHA = "abc123";
const STAMP = join(".git", "primary-build-stamp.json");

/** A primary checkout holding one built package (`packages/cli/dist`), unless `dist: false`. */
function primaryWithDist({ dist = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), "a11y-primary-skip-"));
  mkdirSync(join(root, ".git"));
  if (dist) {
    mkdirSync(join(root, "packages", "cli", "dist"), { recursive: true });
    writeFileSync(join(root, "packages", "cli", "dist", "index.js"), "x");
  }
  return root;
}

/** A `run` that answers `before` to the first `rev-parse HEAD` (the checkout before the move) and `SHA` to everything else. */
function gitAnswering(before: string) {
  let heads = 0;
  return (args: string[]) => (args[0] === "rev-parse" && args[1] === "HEAD" && heads++ === 0 ? `${before}\n` : `${SHA}\n`);
}

/** One tick of `primary:update` at `root`, returning how many builds it ran and how many it was asked for. */
function tick(root: string, { before = SHA, failBuild = false } = {}) {
  let builds = 0;
  const attempt = () => {
    updatePrimary(root, gitAnswering(before), () => { builds += 1; if (failBuild) throw new Error("boom"); }, () => []);
  };
  if (failBuild) assert.throws(attempt, /primary moved, but `pnpm run build` failed/);
  else attempt();
  return builds;
}

test("#3566 ACCEPTANCE: a second update at the SAME sha does not build again", () => {
  const root = primaryWithDist();
  try {
    assert.equal(tick(root), 1, "the first tick at a sha builds: nothing is recorded yet");
    assert.equal(tick(root), 0, "the second changed nothing, and 12 s of wall and 28 s of CPU were the price of finding out");
    assert.equal(tick(root), 0, "and so is the third");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("#3566 CONTROL: a FAILED build leaves no stamp, so the next tick builds again -- a loud failure never goes quiet", () => {
  const root = primaryWithDist();
  try {
    assert.equal(tick(root, { failBuild: true }), 1);
    assert.ok(!existsSync(join(root, STAMP)), "no stamp for a build that did not succeed");
    assert.equal(tick(root), 1, "HEAD is already at the target, and the build is still retried");
    assert.equal(tick(root), 0, "and once it has succeeded, it is not");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("#3566 CONTROL: a MOVED sha builds, and the stamp follows it", () => {
  const root = primaryWithDist();
  try {
    assert.equal(tick(root), 1);
    assert.equal(tick(root, { before: "old999" }), 1, "HEAD moved: the source is not the one the stamp names");
    assert.equal(tick(root), 0, "the stamp now names the new sha");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("#3566 CONTROL: a stamp for ANOTHER sha does not license a skip", () => {
  const root = primaryWithDist();
  try {
    writeFileSync(join(root, STAMP), JSON.stringify({ sha: "someone-else", outputs: [join("packages", "cli", "dist")] }));
    assert.equal(tick(root), 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("#3566 CONTROL: a stamp that names the sha but whose `dist` is GONE builds -- a stamp cannot see a deleted output", () => {
  const root = primaryWithDist();
  try {
    assert.equal(tick(root), 1);
    rmSync(join(root, "packages", "cli", "dist"), { recursive: true });
    assert.equal(tick(root), 1, "stamp present, output missing: the silent-stale case `buildAt` forbids");
    mkdirSync(join(root, "packages", "cli", "dist"), { recursive: true });
    assert.equal(tick(root), 1, "an EMPTY dist is a missing one");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("#3566 CONTROL: a build that left NO output records none, and never licenses a skip", () => {
  const root = primaryWithDist({ dist: false });
  try {
    assert.equal(tick(root), 1);
    assert.equal(tick(root), 1, "nothing to see, so nothing to trust");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("#3566 CONTROL: an unreadable or unusable stamp builds, and is replaced by a good one", () => {
  const root = primaryWithDist();
  try {
    for (const junk of ["not json", "null", JSON.stringify({ sha: SHA }), JSON.stringify({ sha: SHA, outputs: [7] })]) {
      writeFileSync(join(root, STAMP), junk);
      assert.equal(tick(root), 1, `stamp ${junk}`);
    }
    assert.equal(tick(root), 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("#3566 the stamp lives inside .git: it is not a tracked file and `git status` cannot report it", () => {
  const root = primaryWithDist();
  try {
    execFileSync("git", ["init", "-q"], { cwd: root, env: sandboxGitEnv() });
    tick(root);
    assert.ok(existsSync(join(root, STAMP)));
    assert.equal(execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: root, env: sandboxGitEnv(), encoding: "utf8" })
      .split("\n").filter((line) => line.includes("primary-build-stamp")).length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
