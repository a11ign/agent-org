// no-token: none -- the claim records are the fake code host's rows; `git` is the real one in a scratch repository; nothing here reaches `gh` or the network (a11ign/agent-org#1285)
/**
 * a11ign/agent-org#1285: A ROW'S OWN PUSHED BRANCH IS ADOPTED, NOT REFUSED, AFTER THE GATE RELEASED ITS CLAIM. A claim that met an existing
 * local branch of the row refused it, reading only the NEWEST claim record -- a release names no branch -- so the row's own work could never
 * be picked up again. What is pinned, each over a REAL scratch repository and a real `git worktree add`, with `gh` answering a fixture list
 * of claim records:
 *   - ADOPTION: a local branch an earlier record names, after a release, is checked out in the new tree with its commits kept;
 *   - ADOPTION: a branch carrying this row's number that origin holds is adopted the same way;
 *   - REFUSAL: another row's branch is refused by name, with the remedy for that shape, and no tree is made;
 *   - REFUSAL: a local-only branch of this row that no record names is refused, with the push remedy;
 *   - REFUSAL: a branch a tree already stands on is refused even when it is this row's own;
 *   - a claim that LOSES after an adoption removes its tree and KEEPS the branch, whose commits no remote may hold.
 */
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { sandboxGitEnv } from "./lib/git-env.ts";
import { testEach } from "./lib/test-each.ts";
import { claimRecordComment } from "./row-claim.ts";
import { REPO } from "./project-identity.ts";
import { forgetActivation, substituteCodeHost } from "./plugins/active.ts";
import { createFakeCodeHost } from "./plugins/fakes/code-host.ts";
import { fakeRow } from "./plugins/fakes/code-host-rows.ts";
import { claimWithWorktree } from "./row-claim.ts";

const ROW = 1285;
const SESSION = "worker-agent-org-1285";
const OWN = "agent/a-row-s-own-agent-org-1285";
const OTHER_ROW = "agent/a-branch-of-another-row-agent-org-999";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: sandboxGitEnv(), stdio: ["ignore", "pipe", "pipe"] });

/** A checkout with a bare origin holding `main`, and a tree path beside it that the claim may create. */
function repository() {
  const dir = mkdtempSync(resolve(tmpdir(), "row-claim-existing-"));
  const origin = resolve(dir, "origin.git");
  const checkout = resolve(dir, "checkout");
  git(dir, "init", "--quiet", "--bare", "--initial-branch=main", origin);
  git(dir, "clone", "--quiet", origin, checkout);
  for (const [key, value] of [["user.name", "probe"], ["user.email", "probe@example.invalid"], ["commit.gpgsign", "false"], ["gc.auto", "0"]]) git(checkout, "config", key, value);
  writeFileSync(resolve(checkout, "package.json"), "{\"name\":\"probe\",\"version\":\"0.0.0\"}\n");
  git(checkout, "add", "package.json");
  git(checkout, "commit", "--quiet", "-m", "probe");
  git(checkout, "push", "--quiet", "origin", "main");
  return { dir, checkout, tree: resolve(dir, "wt-1285") };
}

type Repository = ReturnType<typeof repository>;

/** A local branch one commit ahead of origin/main, pushed to origin when `push` says so; the checkout is left on main. */
function seedBranch(fx: ReturnType<typeof repository>, name: string, { push }: { push: boolean }): string {
  git(fx.checkout, "checkout", "--quiet", "-b", name);
  writeFileSync(resolve(fx.checkout, "work.txt"), `work on ${name}\n`);
  git(fx.checkout, "add", "work.txt");
  git(fx.checkout, "commit", "--quiet", "-m", `work on ${name}`);
  const tip = git(fx.checkout, "rev-parse", "HEAD").trim();
  if (push) git(fx.checkout, "push", "--quiet", "origin", name);
  git(fx.checkout, "checkout", "--quiet", "main");
  return tip;
}

/**
 * The real `git` of the scratch checkout, and the fake code host holding the claim records in `records`, oldest first, as the comments of the rows the branch names (A11-160, step 7: the comments are read
 * through the code host). Nothing else is faked: the branch, the worktree and the origin are the real ones.
 */
function runWith(records: string[]) {
  const host = createFakeCodeHost();
  host.rowsWorld.repo = REPO;
  for (const number of [ROW, 999]) {
    host.rowsWorld.rows.set(number, fakeRow(host.rowsWorld, number, { comments: records.map((body, id) => ({ id: id + 1, body, createdAt: "2026-10-04T10:00:00Z" })) }));
  }
  substituteCodeHost(host);
  return (cmd: string, args: string[]): string => {
    if (cmd === "gh") throw new Error("a claim reached `gh` through its run: GitHub is the code host's");
    return execFileSync(cmd, args, { encoding: "utf8", env: sandboxGitEnv(), stdio: ["ignore", "pipe", "pipe"] });
  };
}

afterEach(() => forgetActivation());

/** Claims row 1285 in `fx`'s checkout on `branch`; `order` records each call that would write. */
function claimIn(fx: ReturnType<typeof repository>, { branch, records, order = [] as string[], lose = false }: { branch: string; records: string[]; order?: string[]; lose?: boolean }) {
  const claim = ((_n: number, _s: string, deps: { worktree?: string }) => {
    order.push("claim");
    return lose ? { claimed: false, reason: "another session took the row" } : { claimed: true, statusMoved: true, seen: deps.worktree };
  }) as never;
  return claimWithWorktree(ROW, SESSION, {
    branch, worktree: fx.tree, clone: fx.checkout, claim, run: runWith(records),
    exists: () => false, stamp: () => {}, exec: () => "",
  });
}

const claimedRecord = (branch: string) => claimRecordComment({ session: "worker-agent-org-1285", branch, worktree: "../wt-1285" });
const releasedRecord = () => claimRecordComment({ session: "worker-agent-org-1285", released: true });

/** A claim that is refused: the branch it asks for, the records it reads, and the reason patterns it must match, each with its message. */
type Refusal = { name: string, seed: (fx: Repository) => void, branch: string, records: string[], reasons: { pattern: RegExp, message?: string }[] };

const REFUSALS: Refusal[] = [
  {
    name: "another row's branch, which no record names",
    seed: (fx) => seedBranch(fx, OTHER_ROW, { push: true }),
    branch: OTHER_ROW,
    records: [claimedRecord(OWN), releasedRecord()],
    reasons: [{ pattern: /ALREADY EXISTS locally/ }, { pattern: /row #999's newest claim record does not name this branch/, message: "the refusal names the other row" }],
  },
  {
    name: "a local-only branch of this row that no record names, and the remedy is the push",
    seed: (fx) => seedBranch(fx, OWN, { push: false }),
    branch: OWN,
    records: [],
    reasons: [{ pattern: /ALREADY EXISTS locally/ }, { pattern: new RegExp(`git push origin ${OWN}`), message: "the remedy is the push" }],
  },
  {
    name: "a branch a tree already stands on, even when it is this row's own work",
    seed: (fx) => {
      seedBranch(fx, OWN, { push: true });
      git(fx.checkout, "worktree", "add", "--quiet", resolve(fx.dir, "wt-standing"), OWN);
    },
    branch: OWN,
    records: [claimedRecord(OWN), releasedRecord()],
    reasons: [{ pattern: /held by the worktree/ }],
  },
];

test("ADOPTION: a branch an earlier record names, after the gate released the claim, is checked out in the new tree with its commits", () => {
  const fx = repository();
  try {
    const tip = seedBranch(fx, OWN, { push: false });
    const order: string[] = [];
    const result = claimIn(fx, { branch: OWN, records: [claimedRecord(OWN), releasedRecord()], order });
    assert.equal(result.claimed, true, `the row's own branch is adopted, not refused: ${JSON.stringify(result)}`);
    assert.deepEqual(order, ["claim"], "the claim is asked");
    assert.equal(git(fx.tree, "rev-parse", "--abbrev-ref", "HEAD").trim(), OWN, "the new tree is on the row's own branch");
    assert.equal(git(fx.tree, "rev-parse", "HEAD").trim(), tip, "the branch's commits are kept, not recreated from origin/main");
  } finally {
    rmSync(fx.dir, { recursive: true, force: true });
  }
});

test("ADOPTION: a branch carrying this row's number that origin holds is adopted the same way, with no record naming it", () => {
  const fx = repository();
  try {
    const tip = seedBranch(fx, OWN, { push: true });
    const result = claimIn(fx, { branch: OWN, records: [] });
    assert.equal(result.claimed, true, `a pushed branch of this row is adopted: ${JSON.stringify(result)}`);
    assert.equal(git(fx.tree, "rev-parse", "HEAD").trim(), tip, "the pushed branch's commits are checked out");
  } finally {
    rmSync(fx.dir, { recursive: true, force: true });
  }
});

testEach("REFUSAL: another row's branch is refused by name, with the remedy for that shape, and no tree or claim is made", REFUSALS, (c) => {
  const fx = repository();
  try {
    c.seed(fx);
    const order: string[] = [];
    const result = claimIn(fx, { branch: c.branch, records: c.records, order });
    assert.equal(result.claimed, false);
    if (result.claimed) return;
    for (const { pattern, message } of c.reasons) assert.match(result.reason, pattern, message);
    assert.equal(existsSync(fx.tree), false, "no tree is made");
    assert.deepEqual(order, [], "the claim is never asked");
  } finally {
    rmSync(fx.dir, { recursive: true, force: true });
  }
});

test("a claim that LOSES after an adoption removes its tree and KEEPS the branch: its commits are not deleted", () => {
  const fx = repository();
  try {
    const tip = seedBranch(fx, OWN, { push: false });
    const result = claimIn(fx, { branch: OWN, records: [claimedRecord(OWN), releasedRecord()], lose: true });
    assert.equal(result.claimed, false);
    if (result.claimed) return;
    assert.match(result.reason, /branch .* was KEPT/);
    assert.equal(existsSync(fx.tree), false, "the tree this call checked out is removed");
    assert.equal(git(fx.checkout, "rev-parse", "--verify", `refs/heads/${OWN}`).trim(), tip, "the branch and its commit survive the loss");
  } finally {
    rmSync(fx.dir, { recursive: true, force: true });
  }
});
