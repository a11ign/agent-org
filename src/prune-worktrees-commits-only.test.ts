// no-token: gh -- every `pruneWorktrees` here is handed its own `claim` and `rowsClosed`, and the one CLI run uses trees whose names carry no row number, so no `gh` is spawned; proven by running this file with `gh` shimmed to exit 4.
/**
 * a11ign#4620 (incident #3846), agent-org#728: A DIRTY TREE IS REMOVED ONCE ITS WORK IS A REF THE PRUNE CAN READ BACK.
 *
 * The ruling: deleting another session's uncommitted work stays refused, and deleting a directory whose work is recoverable from a
 * ref is not "deleting work". So a tracked-clean tree whose HEAD reads back as its surviving branch is removable like a merged one,
 * and a tree with tracked edits is removable only after `refs/salvage/*` holds a commit carrying them. Each claim below is paired
 * with the control that makes it mean something: the same tree, one fact changed.
 *
 * Every tree is a real git worktree under one disposable base made here and removed in `after`; none of them can reach this checkout.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const BASE = realpathSync(mkdtempSync(join(tmpdir(), "prune-commits-only-")));
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
const { pruneWorktrees, formatReport, ACTIVITY_WINDOW_MS, SALVAGE_REF_PREFIX } = await import("./prune-worktrees.ts");
const { stampWorktree } = await import("./worktree-owner.ts");
const { REMOVAL_LOG_ENV } = await import("./worktree-removal.ts");
const { sandboxGitEnv } = await import("./lib/git-env.ts");

// #2782: every removal writes a line, and a fixture must not write the host's log.
process.env[REMOVAL_LOG_ENV] = join(BASE, "worktree-removals");

const PRUNE_CLI = fileURLToPath(new URL("./prune-worktrees.ts", import.meta.url));
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env: sandboxGitEnv(), encoding: "utf8" });
const NOBODY_CLAIMS = () => ({ refused: false as const });
const OPEN = () => ({ closed: false as const, reason: "row is open, so the stamp is not stale (stub)" });
const NEVER_ASKED = () => { assert.fail("must not be asked for a tree that cannot be removed anyway"); };

/** Every fixture was built moments ago, so "past the ten-minute command window (#220)" is a `now` that far ahead, standing in for time passing. */
const QUIET = () => Date.now() + ACTIVITY_WINDOW_MS + 60_000;
const REMOVE_BY_REF = { removeByRef: true, claim: NOBODY_CLAIMS, rowsClosed: OPEN, pause: () => {} };

type Primary = { root: string, tip: string };
let counter = 0;
/** A primary with `origin/main` at its one commit, a tracked file to edit, and the real `.gitignore`'s rules so a stamp does not read dirty. */
function buildPrimary(): Primary {
  counter += 1;
  const root = join(BASE, `primary-${counter}`);
  mkdirSync(root);
  git(root, "init", "--quiet", "-b", "main");
  git(root, "config", "user.email", "t@example.invalid");
  git(root, "config", "user.name", "Fixture");
  writeFileSync(join(root, ".gitignore"), "node_modules\n.a11y-owner\n");
  writeFileSync(join(root, "app.txt"), "one\n");
  git(root, "add", ".gitignore", "app.txt");
  git(root, "commit", "-q", "-m", "base");
  const tip = git(root, "rev-parse", "HEAD").trim();
  git(root, "update-ref", "refs/remotes/origin/main", tip);
  return { root, tip };
}

/** A tree on its own branch `agent/<name>`, cut from main's tip. */
function tree(primary: Primary, name: string) {
  const path = join(primary.root, name);
  git(primary.root, "worktree", "add", "--quiet", "-b", `agent/${name}`, path, primary.tip);
  return path;
}

/** The same, with one commit `origin/main` lacks: tracked-clean, unmerged, on a branch that stays. */
function committedTree(primary: Primary, name: string) {
  const path = tree(primary, name);
  writeFileSync(join(path, "work.txt"), `real work in ${name}\n`);
  git(path, "add", "work.txt");
  git(path, "commit", "-q", "-m", "not on origin/main");
  return path;
}

const salvageRefs = (primary: Primary) =>
  git(primary.root, "for-each-ref", "--format=%(refname) %(objectname)", SALVAGE_REF_PREFIX).split("\n").filter((l) => l !== "").map((l) => l.split(" "));
const sha = (cwd: string, rev: string) => git(cwd, "rev-parse", "--verify", rev).trim();
/** `git` as `pruneWorktrees` runs it, so a test can make exactly one command fail. */
const realRun = (cmd: string, args: string[], opts: { cwd: string }) => execFileSync(cmd, args, { ...opts, env: sandboxGitEnv(), encoding: "utf8" });

// --- 1. commits only ---------------------------------------------------------------------------------------------------------------

test("#4620 COMMITS: a tracked-clean tree with commits on a surviving branch is removed, and the branch still resolves to the same sha", () => {
  const primary = buildPrimary();
  const path = committedTree(primary, "wt-commits-a");
  const head = sha(path, "HEAD");
  const report = pruneWorktrees(primary.root, { now: QUIET(), ...REMOVE_BY_REF });
  assert.deepEqual(report.removed.map((r) => r.path), [path]);
  assert.deepEqual(report.dirty, []);
  assert.ok(!existsSync(path), "the directory is gone");
  assert.equal(sha(primary.root, "refs/heads/agent/wt-commits-a"), head, "and the work is still a ref, at the same sha");
  assert.equal(git(primary.root, "show", `${head}:work.txt`), "real work in wt-commits-a\n");
  assert.deepEqual(salvageRefs(primary), [], "nothing was salvaged: there was nothing uncommitted");
  assert.match(formatReport(report), /its commits stay on branch agent\/wt-commits-a at /);
});

test("#4620 COMMITS CONTROL 1/3: the same tree stays DIRTY when the caller did not ask for removal by ref (today's reading)", () => {
  const primary = buildPrimary();
  const path = committedTree(primary, "wt-commits-b");
  const report = pruneWorktrees(primary.root, { now: QUIET(), claim: NOBODY_CLAIMS, rowsClosed: OPEN });
  assert.deepEqual(report.dirty.map((r) => r.path), [path]);
  assert.deepEqual(report.removed, []);
  assert.ok(existsSync(path));
});

test("#4620 COMMITS CONTROL 2/3: the same tree on a branch whose ref is MISSING stays DIRTY, and nothing is written", () => {
  const primary = buildPrimary();
  const path = committedTree(primary, "wt-commits-c");
  git(primary.root, "update-ref", "-d", "refs/heads/agent/wt-commits-c");
  const report = pruneWorktrees(primary.root, { now: QUIET(), ...REMOVE_BY_REF });
  assert.deepEqual(report.removed, [], "a tree whose commits no ref names is not removed");
  assert.ok(existsSync(path), "the directory stands");
  assert.deepEqual(report.dirty.map((r) => r.path), [path]);
  assert.match(report.dirty[0].reason ?? "", /HEAD does not resolve to a commit/);
  assert.deepEqual(salvageRefs(primary), []);
});

test("#4620 COMMITS CONTROL 2b/3: a branch ref that reads back as a DIFFERENT commit than HEAD is not the work's ref either", () => {
  const primary = buildPrimary();
  const path = committedTree(primary, "wt-commits-e");
  const run = (cmd: string, args: string[], opts: { cwd: string }) =>
    args[0] === "rev-parse" && args.includes("refs/heads/agent/wt-commits-e^{commit}") ? `${primary.tip}\n` : realRun(cmd, args, opts);
  const report = pruneWorktrees(primary.root, { now: QUIET(), ...REMOVE_BY_REF, run });
  assert.deepEqual(report.removed, []);
  assert.ok(existsSync(path));
  assert.match(report.dirty[0].reason ?? "", /refs\/heads\/agent\/wt-commits-e reads [0-9a-f]{12}, not HEAD [0-9a-f]{12}/);
});

test("#4620 COMMITS CONTROL 3/3: a DETACHED tree whose commits no ref holds stays DIRTY (only its edits are pinned, never its history)", () => {
  const primary = buildPrimary();
  const path = committedTree(primary, "wt-commits-d");
  git(path, "checkout", "--quiet", "--detach");
  git(primary.root, "branch", "-D", "agent/wt-commits-d");
  const report = pruneWorktrees(primary.root, { now: QUIET(), ...REMOVE_BY_REF });
  assert.deepEqual(report.removed, []);
  assert.ok(existsSync(path));
  assert.match(report.dirty[0].reason ?? "", /detached at .* and no ref holds it/);
});

// --- 2. tracked edits --------------------------------------------------------------------------------------------------------------

test("#4620 SALVAGE: a tree with a tracked edit is removed only after refs/salvage/* holds a commit whose diff contains the edit", () => {
  const primary = buildPrimary();
  const path = committedTree(primary, "wt-edit-a");
  writeFileSync(join(path, "app.txt"), "one\nan edit nobody committed\n");
  const head = sha(path, "HEAD");
  // What the salvage ref held AT THE MOMENT git was asked to remove the directory: the order is the claim, so it is read there.
  const atRemoval: { refs: string[][], diff: string } = { refs: [], diff: "" };
  const report = pruneWorktrees(primary.root, {
    now: QUIET(), ...REMOVE_BY_REF,
    remove: (target: string, { run }: { run: typeof realRun }) => {
      atRemoval.refs = salvageRefs(primary);
      if (atRemoval.refs.length > 0) atRemoval.diff = git(primary.root, "diff", `${atRemoval.refs[0][1]}^`, atRemoval.refs[0][1]);
      run("git", ["worktree", "remove", target], { cwd: primary.root });
    },
  });
  assert.deepEqual(report.removed.map((r) => r.path), [path]);
  assert.ok(!existsSync(path));
  assert.equal(atRemoval.refs.length, 1, "exactly one salvage ref existed when the removal ran");
  assert.match(atRemoval.refs[0][0], /^refs\/salvage\/wt-edit-a-\d+$/);
  assert.match(atRemoval.diff, /\+an edit nobody committed/, "the salvaged commit's diff contains the edit");
  assert.equal(sha(primary.root, "refs/heads/agent/wt-edit-a"), head, "and the committed work is the surviving branch");
  assert.equal(sha(primary.root, `${atRemoval.refs[0][1]}^`), head, "the salvage commit sits on HEAD");
  assert.deepEqual(report.removed[0].salvaged, [atRemoval.refs[0][0]], "the report names the ref beside the tree it came from");
  assert.ok(formatReport(report).includes(`${path}  (agent/wt-edit-a)  [tracked changes salvaged to ${atRemoval.refs[0][0]}]`));
});

test("#4620 SALVAGE CONTROL 1/4: a FAILED update-ref leaves the tree standing, the edit in it, and no ref", () => {
  const primary = buildPrimary();
  const path = tree(primary, "wt-edit-b");
  writeFileSync(join(path, "app.txt"), "one\nprecious edit\n");
  const run = (cmd: string, args: string[], opts: { cwd: string }) => {
    if (args[0] === "update-ref") throw new Error("simulated: cannot lock ref");
    return realRun(cmd, args, opts);
  };
  const report = pruneWorktrees(primary.root, { now: QUIET(), ...REMOVE_BY_REF, run });
  assert.deepEqual(report.removed, []);
  assert.ok(existsSync(path), "the tree stands");
  assert.equal(readFileSync(join(path, "app.txt"), "utf8"), "one\nprecious edit\n", "with its edit");
  assert.deepEqual(salvageRefs(primary), []);
  assert.deepEqual(report.dirty.map((r) => r.path), [path]);
  assert.match(report.dirty[0].reason ?? "", /could not be pinned under refs\/salvage\/ and read back \(simulated: cannot lock ref\)/);
});

test("#4620 SALVAGE CONTROL 2/4: a ref that does not READ BACK as the salvage commit is not trusted", () => {
  const primary = buildPrimary();
  const path = tree(primary, "wt-edit-c");
  writeFileSync(join(path, "app.txt"), "one\nanother edit\n");
  // `update-ref` "succeeds" and the read-back answers a different commit: the shape of a ref store that lies.
  const run = (cmd: string, args: string[], opts: { cwd: string }) => {
    if (args[0] === "rev-parse" && args.some((a) => a.startsWith(SALVAGE_REF_PREFIX))) return `${primary.tip}\n`;
    return realRun(cmd, args, opts);
  };
  const report = pruneWorktrees(primary.root, { now: QUIET(), ...REMOVE_BY_REF, run });
  assert.deepEqual(report.removed, []);
  assert.ok(existsSync(path));
  assert.match(report.dirty[0].reason ?? "", /reads back as .*, not /);
});

test("#4620 SALVAGE CONTROL 3/4: untracked WORK is never salvaged -- the tree stays DIRTY before any ref is written", () => {
  const primary = buildPrimary();
  const path = tree(primary, "wt-edit-d");
  writeFileSync(join(path, "app.txt"), "one\nan edit\n");
  writeFileSync(join(path, "notes.txt"), "never added\n");
  const report = pruneWorktrees(primary.root, { now: QUIET(), ...REMOVE_BY_REF });
  assert.deepEqual(report.removed, []);
  assert.ok(existsSync(join(path, "notes.txt")));
  assert.deepEqual(salvageRefs(primary), [], "no ref for a tree git will refuse anyway, or an hourly run would leave one an hour");
  assert.match(report.dirty[0].reason ?? "", /untracked files the primary checkout does not ignore/);
});

test("#4620 SALVAGE CONTROL 4/4: untracked paths the primary IGNORES do not stop it (a tree cut before an ignore rule landed)", () => {
  const primary = buildPrimary();
  const path = tree(primary, "wt-edit-e");
  // This tree's own `.gitignore` is the stale one, so git lists `node_modules` as untracked; the primary's rule is the authority.
  writeFileSync(join(path, ".gitignore"), "# stale\n");
  git(path, "update-index", "--assume-unchanged", ".gitignore");
  mkdirSync(join(path, "node_modules"));
  writeFileSync(join(path, "node_modules", "pkg.js"), "x\n");
  writeFileSync(join(path, "app.txt"), "one\nan edit\n");
  const report = pruneWorktrees(primary.root, { now: QUIET(), ...REMOVE_BY_REF });
  assert.deepEqual(report.removed.map((r) => r.path), [path]);
  assert.equal(salvageRefs(primary).length, 1);
  assert.ok(!existsSync(path));
});

test("#4620 SALVAGE CONTROL: an edit made AFTER the salvage is not discarded -- the tree stands with it", () => {
  const primary = buildPrimary();
  const path = tree(primary, "wt-edit-h");
  writeFileSync(join(path, "app.txt"), "one\npinned edit\n");
  // The session types again in the instant between `stash create` and the discard.
  const run = (cmd: string, args: string[], opts: { cwd: string }) => {
    const out = realRun(cmd, args, opts);
    if (args.includes("stash") && args.includes("create")) writeFileSync(join(path, "app.txt"), "one\npinned edit\nand one typed since\n");
    return out;
  };
  const report = pruneWorktrees(primary.root, { now: QUIET(), ...REMOVE_BY_REF, run });
  assert.deepEqual(report.removed, []);
  assert.ok(existsSync(path));
  assert.equal(readFileSync(join(path, "app.txt"), "utf8"), "one\npinned edit\nand one typed since\n", "the newer edit is still there");
  assert.match(report.dirty[0].reason ?? "", /the tree changed since its tracked edits were pinned/);
});

test("#4620 DETACHED: a detached tree with a tracked edit has its HEAD and its edit pinned, then goes", () => {
  const primary = buildPrimary();
  const path = committedTree(primary, "wt-detached-a");
  git(path, "checkout", "--quiet", "--detach");
  writeFileSync(join(path, "app.txt"), "one\nedit on a detached head\n");
  const head = sha(path, "HEAD");
  const report = pruneWorktrees(primary.root, { now: QUIET(), ...REMOVE_BY_REF });
  assert.deepEqual(report.removed.map((r) => r.path), [path]);
  assert.ok(!existsSync(path));
  const refs = salvageRefs(primary);
  const pinnedHead = refs.find(([name]) => /^refs\/salvage\/wt-detached-a-head-\d+$/.test(name));
  const pinnedEdit = refs.find(([name]) => /^refs\/salvage\/wt-detached-a-\d+$/.test(name));
  assert.equal(pinnedHead?.[1], head, "HEAD is pinned by name");
  assert.ok(pinnedEdit, "and so is the edit");
  assert.match(git(primary.root, "diff", `${pinnedEdit![1]}^`, pinnedEdit![1]), /\+edit on a detached head/);
  assert.equal(report.removed[0].salvaged?.length, 2);
});

test("#4620 A REMOVAL GIT REFUSES leaves the tree DIRTY and its work in the ref -- the run goes on, and the next run finds a clean tree", () => {
  const primary = buildPrimary();
  const path = tree(primary, "wt-edit-f");
  writeFileSync(join(path, "app.txt"), "one\nstill here\n");
  const refuses = () => { throw new Error("fatal: cannot remove a locked working tree (simulated)"); };
  const report = pruneWorktrees(primary.root, { now: QUIET(), ...REMOVE_BY_REF, remove: refuses });
  assert.deepEqual(report.removed, []);
  assert.match(report.dirty[0].reason ?? "", /git refused the removal \(fatal: cannot remove a locked working tree \(simulated\)\); its work stays at refs\/salvage\/wt-edit-f-/);
  const [[ref, commit]] = salvageRefs(primary);
  assert.match(git(primary.root, "diff", `${commit}^`, commit), /\+still here/, "the edit is in the ref the report names");
  assert.ok(report.dirty[0].reason?.includes(ref));
  assert.ok(existsSync(path), "the tree stands");
});

test("#4620 SALVAGE IS IDEMPOTENT: a salvage whose removal could not be logged is not written twice by the next hour's run", () => {
  const primary = buildPrimary();
  const path = tree(primary, "wt-edit-g");
  writeFileSync(join(path, "app.txt"), "one\nlog disk full\n");
  const unwritable = () => { throw new Error("ENOSPC (simulated)"); };
  const first = pruneWorktrees(primary.root, { now: QUIET(), ...REMOVE_BY_REF, record: unwritable });
  assert.deepEqual(first.removed, []);
  assert.deepEqual(first.held.map((r) => r.path), [path], "a delete nobody can see is refused (#2782)");
  assert.ok(existsSync(path));
  const written = salvageRefs(primary);
  assert.equal(written.length, 1, "the work was pinned before the refused removal");
  assert.equal(readFileSync(join(path, "app.txt"), "utf8"), "one\nlog disk full\n", "and the tree still has its edit: nothing is discarded before the log line");
  const second = pruneWorktrees(primary.root, { now: QUIET() + 5000, ...REMOVE_BY_REF, record: unwritable });
  assert.deepEqual(second.held.map((r) => r.path), [path]);
  assert.deepEqual(salvageRefs(primary), written, "same work, same ref: an hourly run does not make twenty-four a day");
  const third = pruneWorktrees(primary.root, { now: QUIET() + 10_000, ...REMOVE_BY_REF });
  assert.deepEqual(third.removed.map((r) => r.path), [path]);
  assert.deepEqual(salvageRefs(primary), written, "and the removal that finally ran used the ref that was already there");
  assert.deepEqual(third.removed[0].salvaged, [written[0][0]]);
});

// --- 3. the refusals a merged tree meets come first --------------------------------------------------------------------------------

test("#4620 ACTIVE: a tree with a tracked edit and git activity inside the window is neither salvaged nor removed", () => {
  const primary = buildPrimary();
  const path = tree(primary, "wt-active-a");
  writeFileSync(join(path, "app.txt"), "one\nbeing typed right now\n");
  const report = pruneWorktrees(primary.root, { now: Date.now(), ...REMOVE_BY_REF });
  assert.deepEqual(report.active.map((r) => r.path), [path]);
  assert.deepEqual(report.removed, []);
  assert.deepEqual(salvageRefs(primary), [], "not salvaged");
  assert.ok(existsSync(path), "not removed");
  // control: the same tree, the window passed
  const later = pruneWorktrees(primary.root, { now: QUIET(), ...REMOVE_BY_REF });
  assert.deepEqual(later.removed.map((r) => r.path), [path]);
});

test("#4620 HELD: a stamped tree that delivered nothing is refused with its edit, whatever the refs would say", () => {
  const primary = buildPrimary();
  const path = tree(primary, "wt-held-a");
  stampWorktree(path, "worker-still-here");
  writeFileSync(join(path, "app.txt"), "one\nthe session's work in progress\n");
  const report = pruneWorktrees(primary.root, { now: QUIET(), ...REMOVE_BY_REF, rowsClosed: OPEN });
  assert.deepEqual(report.held.map((r) => r.path), [path]);
  assert.match(report.held[0].reason, /stamped worker-still-here/);
  assert.deepEqual(salvageRefs(primary), []);
  assert.ok(existsSync(path));
});

test("#4620 RUNS: a tree holding runs/ records the primary does not is refused before any salvage", () => {
  const primary = buildPrimary();
  const path = tree(primary, "wt-runs-a");
  mkdirSync(join(path, "runs"));
  writeFileSync(join(path, "runs", "board.json"), "{}\n");
  writeFileSync(join(path, ".gitignore"), "node_modules\n.a11y-owner\nruns\n");
  git(path, "add", ".gitignore");
  git(path, "commit", "-q", "-m", "ignore runs");
  writeFileSync(join(path, "app.txt"), "one\nand an edit\n");
  const report = pruneWorktrees(primary.root, { now: QUIET(), ...REMOVE_BY_REF });
  assert.deepEqual(report.records.map((r) => r.path), [path]);
  assert.deepEqual(salvageRefs(primary), []);
  assert.ok(existsSync(join(path, "runs", "board.json")));
});

test("#4620 THE ROW'S CLAIM comes before the salvage: a claimed tree is refused and no ref is left for it", () => {
  const primary = buildPrimary();
  const path = tree(primary, "wt-claimed-a");
  writeFileSync(join(path, "app.txt"), "one\nclaimed\n");
  const claimed = () => ({ refused: true as const, reason: "row #1 still carries session:worker-x (stub)" });
  const report = pruneWorktrees(primary.root, { now: QUIET(), ...REMOVE_BY_REF, claim: claimed });
  assert.deepEqual(report.held.map((r) => r.path), [path]);
  assert.deepEqual(salvageRefs(primary), []);
  assert.ok(existsSync(path));
});

// --- 4. the budget, the dry run and the CLI ------------------------------------------------------------------------------------------

test("#4620 BUDGET: these removals share the run's limit and pause rather than adding to them", () => {
  const primary = buildPrimary();
  const paths = ["wt-budget-a", "wt-budget-b", "wt-budget-c"].map((name) => {
    const path = tree(primary, name);
    writeFileSync(join(path, "app.txt"), `one\n${name}\n`);
    return path;
  });
  const waited: number[] = [];
  const report = pruneWorktrees(primary.root, {
    now: QUIET(), ...REMOVE_BY_REF, maxRemovals: 2, pauseMs: 9, pause: (ms: number) => { waited.push(ms); },
  });
  assert.equal(report.removed.length, 2);
  assert.equal(report.unexamined, 1, "the third is left for the next run");
  assert.deepEqual(waited, [9], "two removals have one gap");
  assert.equal(paths.filter(existsSync).length, 1);
  assert.equal(salvageRefs(primary).length, 2, "and only the removed trees were salvaged");
});

test("#4620 DRY RUN: lists the tree as one that WOULD go, writes no ref, and removes nothing", () => {
  const primary = buildPrimary();
  const path = tree(primary, "wt-dry-a");
  writeFileSync(join(path, "app.txt"), "one\ndry\n");
  const report = pruneWorktrees(primary.root, { now: QUIET(), dryRun: true, ...REMOVE_BY_REF });
  assert.deepEqual(report.removed.map((r) => r.path), [path]);
  assert.deepEqual(salvageRefs(primary), []);
  assert.ok(existsSync(path));
  assert.match(formatReport(report, true), /WOULD REMOVE 1 worktree\(s\)[^]*\[tracked changes would first be pinned under refs\/salvage\/\]/);
});

test("#4620 THE CLI is the run: `--apply` salvages a tracked edit, removes the tree and prints the ref beside it", () => {
  const primary = buildPrimary();
  const path = tree(primary, "wt-cli-a");
  // The CLI's own `git status` rewrites an index it finds racily clean, and a rewritten index is itself "activity" (#220), so, as the
  // closed-row test does: age the tracked files, let one `git status` record them, age the gitdir files to a time still NEWER than the
  // files -- and only THEN make the edit, because git refreshes the stat data of an entry whose content is unchanged and never of one
  // that is modified.
  const ago = (windows: number) => new Date(Date.now() - windows * ACTIVITY_WINDOW_MS).toISOString();
  const gitdir = git(path, "rev-parse", "--absolute-git-dir").trim();
  execFileSync("touch", ["-d", ago(3), join(path, "app.txt"), join(path, ".gitignore")]);
  git(path, "status", "--short");
  for (const file of ["index", "HEAD", "logs/HEAD"]) execFileSync("touch", ["-d", ago(2), join(gitdir, file)]);
  writeFileSync(join(path, "app.txt"), "one\nedit for the CLI\n");
  const stdout = execFileSync(process.execPath, [PRUNE_CLI, primary.root, "--apply"],
    { env: { ...sandboxGitEnv(), AGENT_ORG_HOST: process.env.AGENT_ORG_HOST }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const refs = salvageRefs(primary);
  assert.equal(refs.length, 1, stdout);
  assert.ok(!existsSync(path), stdout);
  assert.ok(stdout.includes(`${path}  (agent/wt-cli-a)  [tracked changes salvaged to ${refs[0][0]}]`), stdout);
  assert.match(git(primary.root, "diff", `${refs[0][1]}^`, refs[0][1]), /\+edit for the CLI/);
});
