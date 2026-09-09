/**
 * `primary:update` is the ONE sanctioned way to move the primary checkout (#126), which makes it the only
 * place a rebuild can live and be reached every time.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { updatePrimary } from "../../../../scripts/update-primary.mjs";
import { UPDATE_PRIMARY_VERBS } from "./update-primary-argv.mjs";

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
    // `update-primary-argv.mjs` for why that is one constant rather than two.
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
 * THE COPY MUST NOT COME BACK. Both argv assertions now read `update-primary-argv.mjs`; nothing stops a
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
