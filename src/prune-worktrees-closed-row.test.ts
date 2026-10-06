// no-token: gh -- every `pruneWorktrees` here is handed its own `claim` and `rowsClosed`, and the one CLI run uses trees whose names carry no row number, so no `gh` is spawned; proven by running this file with `gh` shimmed to exit 4.
/**
 * a11ign/a11ign#3850: A STAMPED TREE WHOSE ROW HAS CLOSED IS RELEASED, AND ONE RUN REMOVES A BOUNDED NUMBER.
 *
 * The incident (#3846): the 2026-10-06 run refused 269 of 336 worktrees as HELD, because `.a11y-owner` is a copy of a claim nobody releases.
 * A closed row plus enough git quiet is the evidence the session is gone; a tree that is dirty, unmerged or whose row is open must stay refused,
 * and a backlog of removable trees drains over several runs rather than all at once.
 *
 * Every tree is a real git worktree under one disposable base made here and removed in `after`; none of them can reach this checkout.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const BASE = realpathSync(mkdtempSync(join(tmpdir(), "prune-closed-row-")));
after(() => { rmSync(BASE, { recursive: true, force: true }); });

/** The smallest declaration the tool's modules read at import: a project of nobody's, so nothing here is a11ign's (`prune-tmp-janitor.test.ts`'s). */
const DECLARATION = {
  schema: 1,
  tracker: [{ key: "", repo: "acme/widgets", board: { owner: "acme", number: 1 } }],
  code: [{ key: "", repo: "acme/widgets" }],
  units: { prefix: "acme-", boardReportWorkflow: "board.yml", own: [] },
  vocabulary: {
    labels: { backlog: "backlog", needsChairman: "needs:chairman", outOfRelease: "out-of-release", blocked: "blocked" },
    prefixes: { lane: "lane:", session: "session:", answer: "answer:" },
    milestones: { roadToVersionOne: "Road to one", outOfRelease: "Out of release" },
    lanesFile: "lanes.json",
    templateFields: { acceptance: "Acceptance", closes: "Closes", fleet: "Fleet" },
    fleetQuestion: "Does it need the fleet?",
    resources: [],
  },
};

/** A host file naming that project, made here so no run of this file depends on the layout it sits in or on a variable the caller exported. */
const HOST = (() => {
  const project = join(BASE, "project");
  mkdirSync(join(project, ".agent-org"), { recursive: true });
  writeFileSync(join(project, ".agent-org", "project.json"), JSON.stringify(DECLARATION));
  const host = join(BASE, "host.json");
  writeFileSync(host, JSON.stringify({ schema: 1, primary: "p", projects: [{ id: "p", checkout: project }] }));
  return host;
})();
// The tool's modules resolve their project when IMPORTED, so the host is named BEFORE they are, and only when the caller named none.
if (!process.env.AGENT_ORG_HOST) process.env.AGENT_ORG_HOST = HOST;
const { pruneWorktrees, formatReport, CLOSED_ROW_RELEASE_AGE_MS, ACTIVITY_WINDOW_MS, MAX_REMOVALS_PER_RUN, PAUSE_BETWEEN_REMOVALS_MS } =
  await import("./prune-worktrees.mjs");
const { stampWorktree } = await import("./worktree-owner.mjs");
const { REMOVAL_LOG_ENV } = await import("./worktree-removal.mjs");
const { sandboxGitEnv } = await import("./lib/git-env.mjs");

// #2782: every removal writes a line, and a fixture must not write the host's log.
process.env[REMOVAL_LOG_ENV] = join(BASE, "worktree-removals");

const PRUNE_CLI = fileURLToPath(new URL("./prune-worktrees.mjs", import.meta.url));
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env: sandboxGitEnv(), encoding: "utf8" });
const NOBODY_CLAIMS = () => ({ refused: false as const });
const CLOSED = () => ({ closed: true as const });
const OPEN = () => ({ closed: false as const, reason: "row is open, so the stamp is not stale (stub)" });
const NEVER_ASKED = () => { assert.fail("the row must not be read for a tree that cannot be removed anyway"); };

/** Every fixture was built moments ago, so "idle past the release age" is a `now` that far ahead, standing in for time passing. */
const IDLE_PAST_AGE = () => Date.now() + CLOSED_ROW_RELEASE_AGE_MS + 60_000;
/** Past the ten-minute command window (#220) and well inside the release age. */
const QUIET_BUT_NOT_LONG = () => Date.now() + ACTIVITY_WINDOW_MS + 60_000;

let counter = 0;
/** A primary with `origin/main` at its one commit; the `.gitignore` is the real one's, so a stamp does not make a tree read dirty. */
function buildPrimary() {
  counter += 1;
  const root = join(BASE, `primary-${counter}`);
  mkdirSync(root);
  git(root, "init", "--quiet", "-b", "main");
  git(root, "config", "user.email", "t@example.invalid");
  git(root, "config", "user.name", "Fixture");
  writeFileSync(join(root, ".gitignore"), "node_modules\n.a11y-owner\n");
  git(root, "add", ".gitignore");
  git(root, "commit", "-q", "-m", "base");
  const tip = git(root, "rev-parse", "HEAD").trim();
  git(root, "update-ref", "refs/remotes/origin/main", tip);
  return { root, tip };
}

/** A tree a session CLAIMED and delivered nothing from: branched at main's tip, stamped, merged, clean -- HELD by `heldByOwner`. */
function heldTree(primary: { root: string, tip: string }, name: string, { stamped = true } = {}) {
  const path = join(primary.root, name);
  git(primary.root, "worktree", "add", "--quiet", "-b", `agent/${name}`, path, primary.tip);
  if (stamped) stampWorktree(path, "worker-gone");
  return path;
}

test("#3850: a HELD tree whose row is closed, clean, nothing unpushed and idle past the age is REMOVED", () => {
  const primary = buildPrimary();
  const tree = heldTree(primary, "wt-3001");
  const report = pruneWorktrees(primary.root, { now: IDLE_PAST_AGE(), claim: NOBODY_CLAIMS, rowsClosed: CLOSED });
  assert.deepEqual(report.removed.map((r) => r.path), [tree]);
  assert.deepEqual(report.held, []);
  assert.ok(!existsSync(tree), "the released tree must really be gone");
});

test("#3850 NEGATIVE 1/3: the same tree with its row OPEN is still refused, and the reason names the row", () => {
  const primary = buildPrimary();
  const tree = heldTree(primary, "wt-3002");
  const report = pruneWorktrees(primary.root, { now: IDLE_PAST_AGE(), claim: NOBODY_CLAIMS, rowsClosed: OPEN });
  assert.deepEqual(report.held.map((r) => r.path), [tree]);
  assert.match(report.held[0].reason, /row is open/);
  assert.match(report.held[0].reason, /stamped worker-gone/, "the owner's own reason must survive beside the row's");
  assert.ok(existsSync(tree));
});

test("#3850 NEGATIVE 2/3: the same tree DIRTY is refused, and the row is never read for it", () => {
  const primary = buildPrimary();
  const tree = heldTree(primary, "wt-3003");
  writeFileSync(join(tree, "wip.txt"), "not committed\n");
  const report = pruneWorktrees(primary.root, { now: IDLE_PAST_AGE(), claim: NOBODY_CLAIMS, rowsClosed: NEVER_ASKED });
  assert.deepEqual(report.dirty.map((r) => r.path), [tree]);
  assert.deepEqual(report.removed, []);
  assert.ok(existsSync(join(tree, "wip.txt")));
});

test("#3850 NEGATIVE 3/3: the same tree with an UNPUSHED commit is refused, and the row is never read for it", () => {
  const primary = buildPrimary();
  const tree = heldTree(primary, "wt-3004");
  writeFileSync(join(tree, "work.txt"), "real work\n");
  git(tree, "add", "work.txt");
  git(tree, "commit", "-q", "-m", "not on origin/main");
  const report = pruneWorktrees(primary.root, { now: IDLE_PAST_AGE(), claim: NOBODY_CLAIMS, rowsClosed: NEVER_ASKED });
  assert.deepEqual(report.dirty.map((r) => r.path), [tree]);
  assert.deepEqual(report.removed, []);
  assert.ok(existsSync(tree));
});

test("#3850: a closed row does NOT release a tree that git touched inside the age -- and the row is not read for it", () => {
  const primary = buildPrimary();
  const tree = heldTree(primary, "wt-3005");
  const report = pruneWorktrees(primary.root, { now: QUIET_BUT_NOT_LONG(), claim: NOBODY_CLAIMS, rowsClosed: NEVER_ASKED });
  assert.deepEqual(report.held.map((r) => r.path), [tree]);
  assert.ok(existsSync(tree));
});

test("#3850: a tree the owner does not hold is removed WITHOUT reading its row (the release is for held trees only)", () => {
  const primary = buildPrimary();
  const tree = heldTree(primary, "wt-3006", { stamped: false });
  const report = pruneWorktrees(primary.root, { now: IDLE_PAST_AGE(), claim: NOBODY_CLAIMS, rowsClosed: NEVER_ASKED });
  assert.deepEqual(report.removed.map((r) => r.path), [tree]);
});

test("#3850: a run over 3N removable trees removes N, says how many remain, and the next runs drain the rest", () => {
  const primary = buildPrimary();
  const perRun = 2;
  const trees = ["wt-3011", "wt-3012", "wt-3013", "wt-3014", "wt-3015", "wt-3016"].map((name) => heldTree(primary, name));
  const run = () => pruneWorktrees(primary.root,
    { now: IDLE_PAST_AGE(), claim: NOBODY_CLAIMS, rowsClosed: CLOSED, maxRemovals: perRun, pause: () => {} });

  const first = run();
  assert.equal(first.removed.length, perRun, "N removed");
  assert.equal(first.unexamined, trees.length - perRun, "and the report counts the rest");
  assert.match(formatReport(first), new RegExp(`${trees.length - perRun} worktree\\(s\\) not examined`));
  assert.equal(trees.filter(existsSync).length, trees.length - perRun, "on disk, exactly N are gone");

  assert.equal(run().removed.length, perRun);
  const last = run();
  assert.equal(last.removed.length, perRun);
  assert.equal(last.unexamined, 0, "the third run reaches the end of the list");
  assert.deepEqual(trees.filter(existsSync), []);
  assert.ok(!formatReport(last).includes("not examined"), "a run that reached the end says nothing about a limit");
});

test("#3850: the pause comes between removals, not before the first or after the last", () => {
  const primary = buildPrimary();
  for (const name of ["wt-3021", "wt-3022", "wt-3023"]) heldTree(primary, name);
  const waited: number[] = [];
  pruneWorktrees(primary.root, { now: IDLE_PAST_AGE(), claim: NOBODY_CLAIMS, rowsClosed: CLOSED, pauseMs: 7, pause: (ms: number) => { waited.push(ms); } });
  assert.deepEqual(waited, [7, 7], "three removals have two gaps");
});

test("#3850: a DRY run never waits, and counts the limit the way a real run does", () => {
  const primary = buildPrimary();
  for (const name of ["wt-3031", "wt-3032", "wt-3033"]) heldTree(primary, name);
  const report = pruneWorktrees(primary.root, {
    now: IDLE_PAST_AGE(), dryRun: true, claim: NOBODY_CLAIMS, rowsClosed: CLOSED, maxRemovals: 2,
    pause: () => { assert.fail("a listing removes nothing, so it has nothing to space out"); },
  });
  assert.equal(report.removed.length, 2);
  assert.equal(report.unexamined, 1);
});

/** Letters, not digits: a branch ending in a number names a row, and a row is read over `gh`, which this file never spawns. */
const letterNames = (count: number) => Array.from({ length: count }, (_, i) => `wt-tree-${String.fromCharCode(97 + i)}`);

test("#3850: THE CLI is the run -- `--apply` removes MAX_REMOVALS_PER_RUN, pauses between them, and reports the rest", () => {
  const primary = buildPrimary();
  const names = letterNames(MAX_REMOVALS_PER_RUN + 1);
  const trees = names.map((name) => heldTree(primary, name, { stamped: false }));
  // The fixtures are seconds old and the ten-minute command window (#220) keeps such a tree, so age each one's gitdir files. The CLI's own
  // `git status` REWRITES an index it finds racily clean (older than a file it records), and a rewritten index is itself "activity" (the
  // reason `formatReport` is exported for tests that cannot go through argv). So: age the tracked file first, let one `git status` record it,
  // then age the gitdir files to a time still NEWER than the file.
  const ago = (windows: number) => new Date(Date.now() - windows * ACTIVITY_WINDOW_MS).toISOString();
  for (const name of names) {
    const tree = join(primary.root, name);
    const gitdir = git(tree, "rev-parse", "--absolute-git-dir").trim();
    execFileSync("touch", ["-d", ago(3), join(tree, ".gitignore")]);
    git(tree, "status", "--short");
    for (const file of ["index", "HEAD", "logs/HEAD"]) execFileSync("touch", ["-d", ago(2), join(gitdir, file)]);
  }
  const started = Date.now();
  const stdout = execFileSync(process.execPath, [PRUNE_CLI, primary.root, "--apply"],
    { env: { ...sandboxGitEnv(), AGENT_ORG_HOST: process.env.AGENT_ORG_HOST }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const elapsed = Date.now() - started;
  assert.match(stdout, new RegExp(`^removed ${MAX_REMOVALS_PER_RUN} worktree\\(s\\):`));
  assert.match(stdout, /1 worktree\(s\) not examined/);
  assert.equal(trees.filter(existsSync).length, 1, "exactly one tree is left for the next run");
  assert.ok(elapsed >= (MAX_REMOVALS_PER_RUN - 1) * PAUSE_BETWEEN_REMOVALS_MS,
    `${MAX_REMOVALS_PER_RUN} removals have ${MAX_REMOVALS_PER_RUN - 1} pauses; the run took ${elapsed} ms`);
});
