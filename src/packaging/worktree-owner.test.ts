/**
 * #1128: a session standing in another session's worktree can find that out in ONE command.
 *
 * The incident: a reviewer moved HEAD inside two trees another session was working in, then counted in
 * what they believed was their branch — 16/21/8 against that tree's 21/22/9 — and was minutes from
 * filing a row on it. **Nothing was lost; the cost was a wrong measurement that looked like a right one.**
 *
 * REAL WORKTREES, not fixtures. The clause asks for two trees stamped differently, and a fake filesystem
 * would test the string handling while leaving the thing that failed — a real tree with no owner
 * recorded — untouched.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sandboxGitEnv } from "../../../../scripts/git-env.mjs";
import { stampWorktree, worktreeOwner, whoseWorktree, OWNER_FILE } from "../../../../scripts/worktree-owner.mjs";

const REPO = fileURLToPath(new URL("../../../../", import.meta.url));
const git = (...args: string[]) =>
  execFileSync("git", args, { cwd: REPO, env: sandboxGitEnv(), encoding: "utf8" });

test("#1128: two worktrees stamped differently, and the answer names the right one", () => {
  const base = mkdtempSync(join(tmpdir(), "owner-"));
  const a = join(base, "tree-a");
  const b = join(base, "tree-b");
  try {
    git("worktree", "add", "--detach", a, "HEAD");
    git("worktree", "add", "--detach", b, "HEAD");
    stampWorktree(a, "worker-capture");
    stampWorktree(b, "worker-judge");

    assert.equal(worktreeOwner(a), "worker-capture");
    assert.equal(worktreeOwner(b), "worker-judge");
    assert.match(whoseWorktree(a, "worker-capture"), /yours \(worker-capture\)/);
    assert.match(whoseWorktree(b, "worker-capture"), /worker-judge's -- NOT yours/,
      "the answer must name the OTHER session, not merely say 'not yours' -- the incident's reviewer "
      + "needed to know whom they were about to disturb");
  } finally {
    for (const w of [a, b]) { try { git("worktree", "remove", "--force", w); } catch { /* already gone */ } }
    rmSync(base, { recursive: true, force: true });
  }
});

test("#1128 MUTATION TARGET: stamped with the WRONG session, the answer changes", () => {
  const base = mkdtempSync(join(tmpdir(), "owner-"));
  const w = join(base, "tree");
  try {
    git("worktree", "add", "--detach", w, "HEAD");
    stampWorktree(w, "worker-capture");
    assert.match(whoseWorktree(w, "worker-capture"), /yours/);
    stampWorktree(w, "orchestrator");
    assert.match(whoseWorktree(w, "worker-capture"), /orchestrator's -- NOT yours/,
      "the stamp is what is read, not the asker -- if these do not move together the command answers "
      + "the same whatever the file says");
  } finally {
    try { git("worktree", "remove", "--force", w); } catch { /* already gone */ }
    rmSync(base, { recursive: true, force: true });
  }
});

test("#1128: UNSTAMPED is its own answer, and it is not 'free'", () => {
  // The third state, and the one every tree made before this shipped will give. A caller reading it as
  // unowned has made the substitution this row is about -- `whose tree is this` answered with
  // `is anyone using it`, which is the ACTIVE column's lesson one door along.
  assert.equal(worktreeOwner("/no/such/worktree"), null);
  const said = whoseWorktree("/no/such/worktree", "worker-capture");
  assert.match(said, /UNSTAMPED/);
  assert.match(said, /not "free"/,
    "the message must say so: a null that reads as permission is worse than no answer");
});

test("#1128: an empty stamp file is UNSTAMPED, not an owner named the empty string", () => {
  const base = mkdtempSync(join(tmpdir(), "owner-"));
  try {
    writeFileSync(join(base, OWNER_FILE), "\n");
    assert.equal(worktreeOwner(base), null,
      "a truncated or half-written stamp must not name a session whose id is blank");
  } finally { rmSync(base, { recursive: true, force: true }); }
});
