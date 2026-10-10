/**
 * #411: A MERGE CAN DELETE WORK ALREADY ON `main`, AND EVERY CHECK PASSES.
 *
 * `unexplainedDeletions` is the whole decision, as one pure function. The discovery of its discriminator
 * -- a deleted path is EXPLAINED only when a non-merge commit unique to the branch actually touched it --
 * was verified against two real commits in the project's history before being written down here: `f2cdfaf3`
 * (the incident: a deletion no branch commit ever mentions) and `fc9b89d2` (#354, a deliberate
 * consolidation: a real commit, `ca922204`, names the deletion). See trunk-revert-guard.ts's own header
 * for why the more obvious instruments -- `git merge-tree` on the merge's own two parents, and GitHub's
 * `gh pr view --json files` -- both FAIL to distinguish the two, because the loss happened several commits
 * deep inside the branch's own internal main-sync history, not at the outermost merge.
 *
 * (#3233) THE TWO SHAPES ARE BUILT HERE, not read from the project's history. The acceptance tests used to
 * clone a11ign's checkout and name those two commits, so they needed full history (`// requires: history`),
 * skipped by name on a shallow clone, and depended on a11ign never rewriting what they named. The guard's
 * behaviour is the tool's; `fixtureHistory` reproduces the two shapes the verdict depends on.
 */
// no-token: gh
//
// #827. `trunkRedOrders` takes its facts as an argument and returns the order -- `readTrunkRed`, in
// `trunk-red.ts`, does the lookups -- and this file calls the first with a fixture. The closure walk reaches
// `gh` through that module's graph rather than through anything these tests execute.
//
// The spawned script runs `git`, not `gh`.
//
// Verified against the entry's own code by #827's mechanism, so if `trunkRedOrders` ever starts doing its
// own lookups this refuses rather than trusting the comment.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
// #2154: the repository goes through the #2158 helper, so a full `/tmp` reports the HOST as the cause
// instead of a bare `Disk quota exceeded` from inside `git`.
import { buildSandbox } from "@a11ign/toolchain/lib/sandbox-exhaustion";
import { sandboxGitEnv } from "@a11ign/toolchain/lib/git-env";
import {
  unexplainedDeletions, mergeParents, deletedPaths, branchTouchedPaths, EXIT,
} from "../trunk-revert-guard.ts";
import { trunkRedOrders } from "../trunk-red.ts";

// The tool's own script, found from this file.
const SCRIPT = fileURLToPath(new URL("../trunk-revert-guard.ts", import.meta.url));

/** Run `git` in `cwd`, `GIT_*` scrubbed and identity passed per command, so nothing can write config anywhere. */
function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=Guard Fixture", "-c", "user.email=guard-fixture@example.invalid",
    "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8", stdio: "pipe", env: sandboxGitEnv() }).trim();
}

function writeFile(root: string, path: string, text = `${path}\n`): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}

/** The paths the incident merge deletes and no commit on its branch ever touches -- the shape of `f2cdfaf3`. */
const INCIDENT_PATHS = ["docs/lost-notes.md", "src/lost-guard.test.ts", "scripts/lost-prune.mjs"];
/** The path the legitimate branch deletes in a real commit of its own -- the shape of `fc9b89d2`. */
const RETIRED_PATH = "src/retired-guard.test.ts";

/** The two merges `fixtureHistory` made, by the shape the guard must tell apart. */
const MERGES = { incident: "", legit: "" };

/**
 * `main` with two merges on it.
 *
 * INCIDENT: the branch loses `INCIDENT_PATHS` at its OWN internal "merge main into the branch" step, a MERGE
 * commit whose conflict resolution dropped them, and no real commit on the branch mentions them -- so the
 * outer merge into `main` only reproduces a loss already baked into the branch tip, which is why `git
 * merge-tree` on the merge's two parents agrees with the result and cannot see it.
 *
 * LEGITIMATE: the branch deletes `RETIRED_PATH` in a commit of its own, then merges.
 */
function fixtureHistory(root: string): void {
  git(root, "init", "--quiet", "--initial-branch=main");
  for (const path of [...INCIDENT_PATHS, RETIRED_PATH, "README.md"]) writeFile(root, path);
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "base");

  git(root, "checkout", "-q", "-b", "incident");
  writeFile(root, "src/feature.ts");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "the branch's one real change");
  git(root, "checkout", "-q", "main");
  writeFile(root, "src/other-work.ts");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "work that landed on main meanwhile");
  git(root, "checkout", "-q", "incident");
  git(root, "merge", "--no-commit", "--no-ff", "main");
  git(root, "rm", "-q", ...INCIDENT_PATHS);
  git(root, "commit", "-q", "-m", "sync main into the branch, resolving by dropping three files");
  git(root, "checkout", "-q", "main");
  git(root, "merge", "--no-ff", "-q", "-m", "merge the incident branch", "incident");
  MERGES.incident = git(root, "rev-parse", "HEAD");

  git(root, "checkout", "-q", "-b", "legit");
  git(root, "rm", "-q", RETIRED_PATH);
  git(root, "commit", "-q", "-m", "retire the guard, deliberately");
  git(root, "checkout", "-q", "main");
  git(root, "merge", "--no-ff", "-q", "-m", "merge the deliberate deletion", "legit");
  MERGES.legit = git(root, "rev-parse", "HEAD");

  // The script runs `git fetch origin` unconditionally, so the repository needs an `origin` to read: itself.
  git(root, "remote", "add", "origin", root);
}

/**
 * A REPOSITORY OF ITS OWN WITH ITS OWN `origin`, BECAUSE THIS SCRIPT REALLY FETCHES.
 *
 * `trunk-revert-guard.ts` runs `git fetch origin --quiet` before it looks at anything (unconditional, and
 * deliberately so -- worker-contracts' finding that the guard must not read a remote-tracking ref that a
 * checkout happens to have fetched an hour ago). Every spawn below used to pass the checkout running the
 * suite as `cwd`, so a test run in any worktree fetched into the SHARED primary `.git`, writing its
 * remote-tracking refs while another worktree might be doing the same. A test mutating the checkout that
 * drives the fleet, with a lock in the failure mode. #640's class, found by worker-audit from a real
 * collision (#890). Built ONCE for the whole file -- none of these tests writes to it -- and removed in
 * `after()`.
 */
const FIXTURE = buildSandbox({ prefix: "a11y-revert-guard-" }, fixtureHistory);

after(() => rmSync(FIXTURE, { recursive: true, force: true }));

// Named once, so each spawn's option object below is the only thing between its braces.
const INCIDENT_ARG = `--merge=${MERGES.incident}`;
const LEGIT_ARG = `--merge=${MERGES.legit}`;

// --- unexplainedDeletions: the pure decision ---

test("unexplainedDeletions: a path no branch commit touched is unexplained", () => {
  const result = unexplainedDeletions({ deletedPaths: ["a.ts"], branchTouchedPaths: new Set() });
  assert.deepEqual(result, ["a.ts"]);
});

test("unexplainedDeletions: MUTATION TARGET -- a path the branch DID touch is explained, not reported", () => {
  const result = unexplainedDeletions({ deletedPaths: ["a.ts"], branchTouchedPaths: new Set(["a.ts"]) });
  assert.deepEqual(result, []);
});

test("unexplainedDeletions: a mixed set reports only the untouched ones", () => {
  const result = unexplainedDeletions({
    deletedPaths: ["a.ts", "b.ts", "c.ts"], branchTouchedPaths: new Set(["b.ts"]),
  });
  assert.deepEqual(result, ["a.ts", "c.ts"]);
});

test("unexplainedDeletions: no deleted paths at all reports nothing", () => {
  assert.deepEqual(unexplainedDeletions({ deletedPaths: [], branchTouchedPaths: new Set() }), []);
});

// --- mergeParents: only a real, two-parent merge has something to check ---

test("mergeParents: a two-parent commit returns both, in order", () => {
  const fakeGit = () => "aaa bbb";
  assert.deepEqual(mergeParents("sha", fakeGit), { p1: "aaa", p2: "bbb" });
});

test("mergeParents: an ordinary, single-parent commit returns null -- nothing to check", () => {
  const fakeGit = () => "aaa";
  assert.equal(mergeParents("sha", fakeGit), null);
});

test("mergeParents: a root commit (no parents) also returns null, not a crash", () => {
  const fakeGit = () => "";
  assert.equal(mergeParents("sha", fakeGit), null);
});

// --- deletedPaths: parses ONLY the D lines, never A/M/R ---

test("deletedPaths: reads D lines and strips the status prefix", () => {
  const fakeGit = () => "D\tone.ts\nM\ttwo.ts\nA\tthree.ts\nD\tfour.ts";
  assert.deepEqual(deletedPaths("p1", "merge", fakeGit), ["one.ts", "four.ts"]);
});

test("deletedPaths: no deletions at all is an empty list, not an error", () => {
  const fakeGit = () => "M\tone.ts\nA\ttwo.ts";
  assert.deepEqual(deletedPaths("p1", "merge", fakeGit), []);
});

// --- branchTouchedPaths: which of the deleted paths a real branch commit mentions ---

test("branchTouchedPaths: a path with a non-empty log is touched", () => {
  const fakeGit = () => "abc123 some commit";
  const result = branchTouchedPaths("p1", "p2", ["a.ts"], fakeGit);
  assert.deepEqual([...result], ["a.ts"]);
});

test("branchTouchedPaths: a path with an empty log is NOT touched", () => {
  const fakeGit = () => "";
  const result = branchTouchedPaths("p1", "p2", ["a.ts"], fakeGit);
  assert.deepEqual([...result], []);
});

// --- ACCEPTANCE: driven live against the two fixture merges ---

test("POSITIVE CONTROL: the fixture really holds the shapes the two verdicts below depend on", () => {
  const inFixture = (args: string[]) => git(FIXTURE, ...args);
  const incident = mergeParents(MERGES.incident, inFixture);
  assert.ok(incident, "the incident merge has two parents");
  assert.deepEqual(deletedPaths(incident.p1, MERGES.incident, inFixture).sort(), [...INCIDENT_PATHS].sort());
  assert.equal(git(FIXTURE, "log", "--no-merges", "--oneline", `${incident.p1}..${incident.p2}`, "--", INCIDENT_PATHS[0]), "",
    "no real commit on the incident branch touches what it lost");
  assert.notEqual(git(FIXTURE, "log", "--oneline", `${incident.p1}..${incident.p2}`, "--", INCIDENT_PATHS[0]), "",
    "but a MERGE commit on it does, which is why --no-merges is the discriminator");
  const legit = mergeParents(MERGES.legit, inFixture);
  assert.ok(legit);
  assert.deepEqual(deletedPaths(legit.p1, MERGES.legit, inFixture), [RETIRED_PATH]);
});

test("ACCEPTANCE (#411, criterion 2): the incident shape is REFUSED, naming the three deleted "
  + "paths no branch commit ever touched", () => {
  let out;
  try {
    execFileSync("node", [SCRIPT, INCIDENT_ARG], { cwd: FIXTURE, encoding: "utf8", stdio: "pipe" });
    assert.fail("expected the guard to refuse and exit non-zero");
  } catch (cause) {
    const err = cause as { status?: number, stderr?: string };
    assert.equal(err.status, EXIT.REFUSE);
    out = err.stderr ?? "";
  }
  for (const p of INCIDENT_PATHS) assert.ok(out.includes(p), `expected the refusal to name ${p}, got:\n${out}`);
  assert.ok(!out.includes(RETIRED_PATH), "and only the paths the merge deleted");
  // #655: naming the deleted paths is not a remedy on its own, so a human must be told what to actually DO,
  // not just what is wrong. #2356: AND THE REMEDY IS A FORWARD FIX -- the org never reverts a merge, so the
  // message names the restore command and must never hand a reader `git revert`.
  assert.ok(out.includes(`git checkout ${MERGES.incident}^1 -- <path>`),
    `expected the refusal to name the exact recovery command, got:\n${out}`);
  assert.match(out, /NOTHING REVERTS THIS MERGE/,
    `expected the refusal to say the org fixes forward, got:\n${out}`);
  assert.doesNotMatch(out, /git revert/, `a refusal that tells a reader to revert contradicts the ruling:\n${out}`);
});

test("ACCEPTANCE (#411, criterion 3): a legitimate deletion (the #354 shape) is NOT refused -- the half "
  + "that decides whether this survives a week", () => {
  const out = execFileSync("node", [SCRIPT, LEGIT_ARG], { cwd: FIXTURE, encoding: "utf8" });
  assert.match(out, /PASS/);
  assert.match(out, /explained by a real commit/, "PASS because the deletion was explained, not because nothing was checked");
});

// --- the CLI, guarded like every other argv-reading script here ---

test("trunk-revert-guard.ts refuses an unknown flag rather than silently ignoring it", () => {
  let threw = false;
  try {
    execFileSync("node", [SCRIPT, "--merge=abc", "--bogus"],
      { cwd: FIXTURE, encoding: "utf8", stdio: "pipe" });
  } catch (cause) {
    threw = true;
    const err = cause as { status?: number, stderr?: string };
    assert.equal(err.status, 2);
    assert.match(String(err.stderr), /unknown flag --bogus/);
  }
  assert.ok(threw);
});

test("trunk-revert-guard.ts refuses to run without --merge", () => {
  let threw = false;
  try {
    execFileSync("node", [SCRIPT], { cwd: FIXTURE, encoding: "utf8", stdio: "pipe" });
  } catch (cause) {
    threw = true;
    const err = cause as { status?: number, stderr?: string };
    assert.equal(err.status, 2);
    assert.match(String(err.stderr), /need --merge/);
  }
  assert.ok(threw);
});

/**
 * C3 ACCEPTANCE, COMPOSED: does the incident shape's guard verdict, once `trunkGate` fails on it, actually
 * produce a FIX-FORWARD ORDER? Neither script's own test suite asks this: this file stops at "REFUSED, naming
 * three paths"; `trunk-revert.test.ts` drives `trunkRedOrders` only against synthetic facts. This is the seam
 * -- proving a REFUSE from the guard is not merely compatible with the order's shape, but genuinely reaches a
 * fixer, with "fix forward" in it and no revert.
 */
test("C3 ACCEPTANCE, COMPOSED: the incident REFUSAL, once trunkGate fails on it, WAKES A FIXER", () => {
  // `assert.throws` returns undefined, so the error is caught by hand -- the exit CODE is the subject here
  // and `throws` alone cannot see it. That is the whole defect in one line.
  let status: number | undefined;
  try {
    execFileSync("node", [SCRIPT, INCIDENT_ARG], { cwd: FIXTURE, stdio: "pipe" });
  } catch (cause) {
    status = (cause as { status?: number }).status;
  }
  assert.equal(status, EXIT.REFUSE,
    `expected REFUSE (${EXIT.REFUSE}); PASS (${EXIT.PASS}) would mean the guard did not flag it and `
    + `CANNOT_ASK (${EXIT.CANNOT_ASK}) is an unanswerable question, not a refusal -- reading the second as `
    + "the first is how this test passed while its three siblings failed for 27.8 hours");

  // trunkGate failing on the merge is a red run whose only failed job is `trunkGate`: `trunkRecheck` records
  // `pass` for it (a question about this merge's own two parents cannot be inherited), and the gate reads
  // that as THIS MERGE'S OWN and addresses the order to the session that merged it.
  const [order] = trunkRedOrders({
    runId: 1, url: "https://example.test/runs/1", sha: MERGES.incident, failedJobs: ["trunkGate"],
    failingTests: null, recheck: "pass", parentFailingTests: null,
    originPr: { number: 232, title: "the merge that lost six files", session: "worker-tooling" },
  });
  assert.ok(order, "a REFUSE from the guard must reach somebody -- an empty result is a red main nobody hears about");
  assert.equal(order.cause, "trunk-red");
  assert.equal(order.session, "worker-tooling", "the guard's refusal is this merge's own: it goes to its session");
  assert.match(order.prompt, /FIX FORWARD -- DO NOT REVERT/);
  assert.match(order.prompt, /`trunkGate`/, "the order must name the job that failed");
});

test("C3 ACCEPTANCE, COMPOSED, POSITIVE CONTROL: an ordinary merge's PASS never even reaches trunkRecheck", () => {
  // The legitimate-deletion shape PASSES, so trunkGate's guard step succeeds and the job does not fail on this
  // step: there is no order to emit in this branch, which is the point -- the positive control for a wake is
  // "nobody is woken", not "a different, harmless order is computed".
  const out = execFileSync("node", [SCRIPT, LEGIT_ARG], { cwd: FIXTURE, encoding: "utf8", stdio: "pipe" });
  assert.match(out, /PASS/);
});

/**
 * THE FIX IS THE `cwd`, SO THE `cwd` IS PINNED.
 *
 * Every spawn in this file runs a script that calls `git fetch origin` unconditionally. Pointed at the
 * real checkout — which is what the old `cwd` did until #890 — that fetch writes remote-tracking refs in
 * the `.git` every worktree shares, so a suite run anywhere could collide with another worktree's fetch.
 * worker-audit found it from a real collision.
 *
 * Reverting one `cwd` is a one-line edit that changes nothing a type or a lint check can see, and the
 * tests pass either way — the clone has the same history. **So the only thing that can catch it is a
 * check on the text.** That is this file's own lesson from `browser-session.mjs`'s comment, applied to
 * this file: a comment saying "the position is the property" is worth nothing unless something reads it.
 */
test("#890 every spawn runs against the FIXTURE repository, never the real checkout", () => {
  // INCLUDING THE TWO FLAG-REFUSAL SPAWNS, which today exit before the fetch -- `refuseUnknownFlags` and
  // the missing-`--merge` check both run first. That is a fact about the script's current statement
  // ORDER, and this row exists because a statement's position is exactly the property nothing else
  // notices moving. A uniform `cwd` needs no such reasoning to stay correct.
  const src = readFileSync(fileURLToPath(import.meta.url), "utf8");
  const spawns = [...src.matchAll(/execFileSync\(\s*"node",[^)]*?\{([^}]*)\}/gs)].map((m) => m[1]);
  assert.ok(spawns.length >= 4,
    `only ${spawns.length} node spawn(s) found; this file had four when the guard was written, and a `
    + "check that examines fewer than it should reports cleanly about a population it never walked");
  for (const options of spawns) {
    assert.match(options, /cwd:\s*FIXTURE\b/, `a spawn runs with ${options.trim()} rather than cwd: FIXTURE`);
    assert.doesNotMatch(options, /cwd:\s*(?:process\.cwd\(\)|HOME_CHECKOUT)/,
      "the checkout that runs the suite is not the fixture, and this script FETCHES");
  }
});
