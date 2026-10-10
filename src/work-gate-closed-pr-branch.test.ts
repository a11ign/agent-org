// no-token: gh -- imports `work-gate.ts`, whose default reader spawns `gh`; every read here is handed an injected `run`, so nothing is spawned (#3892)
/**
 * #3892: A READY ROW WHOSE BRANCH'S PULL REQUEST WAS CLOSED UNMERGED IS OFFERED, NOT SHELVED.
 *
 * #3505's shape: finished, approved work on `agent/the-split-move-3-3505`, #3834 closed unmerged on purpose, no open pull request. The gate shelved the row for
 * the branch ahead of every other reason and sent the only order to `product-manager`, whose login was the refused one; nothing could start the replacement.
 *
 * POSITIVE CONTROLS, one per way the row must STAY shelved: a branch with NO pull request (#2000's shape), one with an OPEN pull request (#3010's), one whose
 * pull request MERGED, and a row holding one closed branch and one bare branch. Each is the SAME fixture as the offered row with one thing changed, so "shelved" is
 * not what this harness says of every row, and each is red against an implementation that offers everything.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sandboxGitEnv } from "./lib/git-env.ts";

// THE PROJECT THIS RUNS AGAINST IS A RECORDED ONE (`claimed-region-overlap.test.ts`'s shape): the host file is set FIRST and the tool imported AFTER it, so the
// acceptance command as written -- no `$AGENT_ORG_HOST` -- runs.
const SCRATCH = mkdtempSync(join(tmpdir(), "closed-pr-branch-"));
after(() => rmSync(SCRATCH, { recursive: true, force: true }));
const PROJECT = join(SCRATCH, "project");
cpSync(fileURLToPath(new URL("./packaging/fixtures/row-claim-file-overlap-rule/project", import.meta.url)), PROJECT, { recursive: true });
const HOST_FILE = join(SCRATCH, "host.json");
writeFileSync(HOST_FILE, JSON.stringify({ schema: 1, home: SCRATCH, binDir: join(SCRATCH, "bin"), primary: "fixture",
  projects: [{ id: "fixture", checkout: PROJECT }],
  gh: { workers: join(SCRATCH, "workers"), leads: join(SCRATCH, "leads"), leadsHeader: [], leadsWorkspaces: [] } }));
process.env.AGENT_ORG_HOST = HOST_FILE;
// A Region names a path under a top-level directory the project TRACKS, or it declares nothing (#3073): `docs/` is tracked here.
mkdirSync(join(PROJECT, "docs"), { recursive: true });
writeFileSync(join(PROJECT, "docs", "tracked"), "");
execFileSync("git", ["init", "--quiet"], { cwd: PROJECT, env: sandboxGitEnv() });
execFileSync("git", ["add", "-A"], { cwd: PROJECT, env: sandboxGitEnv() });
process.chdir(PROJECT);

const { partitionUnclaimed, rowBranchOrders, readBranchPrs, readBranchPrsOfUnclaimed, branchesToReplace, decide } = await import("./work-gate.ts");
const { spawnClaimer, spawnableRole, spawnedPrompt } = await import("./wake.ts");
const { writeFileSync: stamp } = await import("node:fs");

const ROW = 3505;
const BRANCH = "agent/the-split-move-3-3505";
const SHA = "992fadf81a27b0c3d1e2f3a4b5c6d7e8f9a0b1c2";
const row = (n = ROW, labels: string[] = ["ready"]) =>
  ({ number: n, title: "The split move 3", body: "## Region\n\n- `docs/messaging.md`\n\n## Acceptance\n\nnone\n\n## Open-check\n\nnone\n", labels: labels.map((name) => ({ name })) });
const onOrigin = (...branches: string[]) => branches.map((branch) => ({ branch, head: SHA, row: ROW }));
const pr = (branch: string, number: number, state: string) => ({ branch, number, state });

const closedUnmerged = [pr(BRANCH, 3834, "CLOSED")];
const part = (rowBranches: ReturnType<typeof onOrigin> | null, branchPrs: ReturnType<typeof pr>[] | null) =>
  partitionUnclaimed([row()], new Map() as never, { rowBranches, branchPrs, openRows: [] });

test("#3505's shape (one origin branch, a closed-unmerged PR, no open PR) is OFFERABLE", () => {
  const { offerable, blocked } = part(onOrigin(BRANCH), closedUnmerged);
  assert.deepEqual(offerable.map((r: { number: number }) => r.number), [ROW]);
  assert.deepEqual(blocked, []);
});

test("positive control: the same row with the branch's PR ABSENT from the answer stays shelved, naming the branch and its sha", () => {
  const { offerable, blocked } = part(onOrigin(BRANCH), []);
  assert.deepEqual(offerable, [], "a branch with NO pull request is #2000's shape, and nobody knows whether it is finished");
  assert.match(blocked[0].reason, /the-split-move-3-3505/);
  assert.match(blocked[0].reason, /992fadf81a27/);
});

test("positive control: an OPEN pull request on the branch keeps the row shelved", () => {
  assert.deepEqual(part(onOrigin(BRANCH), [pr(BRANCH, 3999, "OPEN")]).offerable, []);
});

test("positive control: a MERGED pull request on the branch keeps the row shelved", () => {
  assert.deepEqual(part(onOrigin(BRANCH), [pr(BRANCH, 3834, "MERGED")]).offerable, []);
});

test("positive control: a closed PR beside a MERGED one on the same branch keeps the row shelved", () => {
  assert.deepEqual(part(onOrigin(BRANCH), [pr(BRANCH, 3834, "CLOSED"), pr(BRANCH, 3900, "MERGED")]).offerable, []);
});

test("positive control: one closed branch and one branch with no pull request keep the row shelved", () => {
  assert.deepEqual(part(onOrigin(BRANCH, "agent/other-3505"), closedUnmerged).offerable, []);
});

test("an answer that was NOT READ (null or absent) releases nothing", () => {
  assert.deepEqual(part(onOrigin(BRANCH), null).offerable, []);
  assert.deepEqual(partitionUnclaimed([row()], new Map() as never, { rowBranches: onOrigin(BRANCH), openRows: [] }).offerable, []);
});

test("a closed PR on a branch ends the shelving for that row only", () => {
  const rows = [row(), row(3600)];
  const branches = [...onOrigin(BRANCH), { branch: "agent/bare-3600", head: SHA, row: 3600 }];
  const { offerable } = partitionUnclaimed(rows, new Map() as never, { rowBranches: branches, branchPrs: closedUnmerged, openRows: [] });
  assert.deepEqual(offerable.map((r: { number: number }) => r.number), [ROW]);
});

test("the replaced row gets NO `row-branch-unshipped` order; the control still does", () => {
  assert.deepEqual(rowBranchOrders([row()], onOrigin(BRANCH), [], closedUnmerged), []);
  assert.equal(rowBranchOrders([row()], onOrigin(BRANCH), [], []).length, 1, "the same row with no PR is asked about, so an empty answer above is not the harness's default");
});

type Order = { session: string; cause: string; causeKey: string; prompt: string; replaces?: { branch: string; head: string }[] };
const decided = (branchPrs: ReturnType<typeof pr>[] | null): Order[] => decide({
  prs: [], required: [], readyRows: [row()], promotableRows: [], chairmanBlocked: [], prFiles: new Map(), drain: false, openRows: [],
  claimedComments: [], rowBranches: onOrigin(BRANCH), branchPrs, hostDrift: null, primaryDrift: null, claimRefusals: [],
} as never) as Order[];

test("the order is a `ready-row-unclaimed` to the pool that names the branch and sha and says `--adopt`", () => {
  const offered = decided(closedUnmerged).filter((o) => o.cause === "ready-row-unclaimed");
  assert.equal(offered.length, 1);
  const [order] = offered;
  assert.equal(order.session, "engineers");
  assert.equal(order.causeKey, `engineers/ready-row-unclaimed/${ROW}`);
  assert.match(order.prompt, /the-split-move-3-3505/);
  assert.match(order.prompt, /992fadf81a27/);
  assert.match(order.prompt, /--adopt=/);
  assert.match(order.prompt, /#3834/);
  assert.deepEqual(order.replaces, [{ branch: BRANCH, head: SHA }]);
  assert.equal(decided(closedUnmerged).filter((o) => o.cause === "row-branch-unshipped").length, 0);
});

test("positive control: with no PR in the answer the pool is offered nothing and the shelving's order goes out", () => {
  const orders = decided([]);
  assert.equal(orders.filter((o) => o.cause === "ready-row-unclaimed").length, 0);
  assert.equal(orders.filter((o) => o.cause === "row-branch-unshipped").length, 1);
});

test("`spawnableRole` accepts that order for the engineer pool", () => {
  const [order] = decided(closedUnmerged).filter((o) => o.cause === "ready-row-unclaimed");
  assert.deepEqual(spawnableRole(order, [], ["worker-capture"]), { role: "worker-capture" });
});

test("readBranchPrs asks one `pr list --head <branch> --state all` per branch, and a refused read is `null`, not `[]`", () => {
  const asked: string[][] = [];
  const run = (args: string[]) => { asked.push(args); return JSON.stringify([{ number: 3834, state: "CLOSED" }]); };
  assert.deepEqual(readBranchPrs([{ branch: BRANCH }], run), [pr(BRANCH, 3834, "CLOSED")]);
  assert.deepEqual(asked[0].slice(0, 5), ["pr", "list", "--head", BRANCH, "--state"]);
  assert.equal(asked[0][5], "all");
  assert.equal(readBranchPrs([{ branch: BRANCH }], () => { throw new Error("rate limited"); }), null);
});

test("readBranchPrs refuses a FULL page: `gh` cuts the oldest, so a merged pull request can hide beyond the limit (#3892 review)", () => {
  let limit = 0;
  const page = (size: number) => (args: string[]) => {
    limit = Number(args[args.indexOf("--limit") + 1]);
    // newest first, as `gh` returns them: the cut-off merged one is the OLDEST and is not in the page
    return JSON.stringify(Array.from({ length: size }, (_, i) => ({ number: 5000 - i, state: "CLOSED" })));
  };
  assert.equal(readBranchPrs([{ branch: BRANCH }], page(1))?.length, 1);
  assert.ok(limit > 1, "the page limit is read off the call itself");
  // positive control: one short of the limit is the whole list and is read
  assert.equal(readBranchPrs([{ branch: BRANCH }], page(limit - 1))?.length, limit - 1);
  assert.equal(readBranchPrs([{ branch: BRANCH }], page(limit)), null, "a page exactly at the limit may have been cut");
  assert.equal(readBranchPrs([{ branch: BRANCH }, { branch: "agent/other-3835" }], page(limit)), null);
});

test("a full page leaves the row SHELVED through the tick's reader, not offered", () => {
  const full = () => JSON.stringify(Array.from({ length: 1000 }, (_, i) => ({ number: 5000 - i, state: "CLOSED" })));
  assert.equal(readBranchPrsOfUnclaimed([row()], onOrigin(BRANCH), full), null);
  const ok = () => JSON.stringify([{ number: 3834, state: "CLOSED" }]);
  assert.deepEqual(readBranchPrsOfUnclaimed([row()], onOrigin(BRANCH), ok), [pr(BRANCH, 3834, "CLOSED")]);
});

test("readBranchPrsOfUnclaimed asks only about branches of UNCLAIMED ready rows, and nothing when there are none", () => {
  const asked: string[][] = [];
  const run = (args: string[]) => { asked.push(args); return "[]"; };
  assert.equal(readBranchPrsOfUnclaimed([row(ROW, ["ready", "in-progress"])], onOrigin(BRANCH), run), null);
  assert.equal(asked.length, 0, "a claimed row's branch is its holder's");
  assert.deepEqual(readBranchPrsOfUnclaimed([row()], onOrigin(BRANCH), run), []);
  assert.equal(asked.length, 1, "the same fixture, unclaimed, DOES ask");
  assert.equal(readBranchPrsOfUnclaimed([row()], null, run), null);
});

test("branchesToReplace names the closed PRs per branch", () => {
  assert.deepEqual(branchesToReplace(onOrigin(BRANCH), [pr(BRANCH, 3834, "CLOSED"), pr(BRANCH, 3700, "CLOSED")]).get(ROW),
    [{ branch: BRANCH, head: SHA, prs: [3834, 3700] }]);
});

// --- the spawner's claim: the half that makes the order startable -----------------------------------------------------

type Ran = { cmd: string; args: string[]; cwd: string };
/** An `exec` that answers the git reads a replacement's claim makes and records every call; `tree` is the porcelain block for the previous holder's tree. */
function fakeHost(tree: string, { status = "", ahead = "0" }: { status?: string; ahead?: string } = {}) {
  const ran: Ran[] = [];
  const exec = (cmd: string, rawArgs: string[], { cwd }: { cwd: string }) => {
    const args = rawArgs;
    ran.push({ cmd, args, cwd });
    if (cmd === "git" && args[0] === "worktree") return { status: 0, output: `worktree /host/primary\nHEAD abc\nbranch refs/heads/main\n\n${tree}\n` };
    if (cmd === "git" && args[0] === "status") return { status: 0, output: status };
    if (cmd === "git" && args[0] === "rev-list") return { status: 0, output: `${ahead}\n` };
    if (cmd === "node") return { status: 0, output: "STARTED #3505" };
    return { status: 0, output: "" };
  };
  return { exec, ran };
}

function claimWith(tree: string, order: Record<string, unknown>, host: { treeDir: string; owner: string | null }) {
  if (host.owner !== null) stamp(join(host.treeDir, ".a11y-owner"), `${host.owner}\n`);
  const { exec, ran } = fakeHost(tree);
  const claimer = spawnClaimer({ exec, exists: () => true, worktreesDir: SCRATCH, primary: "/host/primary" });
  const out = claimer.claim({ causeKey: `engineers/ready-row-unclaimed/${ROW}`, title: "The split move 3", ...order } as never, "worker-3505", {});
  return { out, ran };
}

const TREE_DIR = join(SCRATCH, "wt-3505");
cpSync(PROJECT, TREE_DIR, { recursive: true });
const block = `worktree ${TREE_DIR}\nHEAD ${SHA}\nbranch refs/heads/${BRANCH}`;

test("the spawn's claim ADOPTS the previous holder's tree on the closed-PR branch, with --branch and --worktree", () => {
  const { out, ran } = claimWith(block, { replaces: [{ branch: BRANCH, head: SHA }] }, { treeDir: TREE_DIR, owner: "worker-3505" });
  assert.ok(!("refusal" in out), JSON.stringify(out));
  const claim = ran.find((r) => r.cmd === "node");
  assert.ok(claim, "row-claim was run");
  assert.deepEqual(claim.args.slice(1), ["claim", String(ROW), "--session=worker-3505", `--branch=${BRANCH}`, `--worktree=${TREE_DIR}`, "--adopt=worker-3505"]);
  assert.match(spawnedPrompt({ title: "t" }, out as never), /CLOSED UNMERGED/);
});

test("positive control: the SAME tree without `replaces` on the order is NOT adopted (a fresh claim, as before)", () => {
  const { ran } = claimWith(block, {}, { treeDir: TREE_DIR, owner: "worker-3505" });
  const claim = ran.find((r) => r.cmd === "node");
  assert.ok(claim);
  assert.ok(!claim.args.some((a) => a.startsWith("--adopt")), claim.args.join(" "));
  assert.equal(ran.filter((r) => r.args[0] === "worktree").length, 0, "the host is not even asked for its trees");
});

test("positive control: an UNSTAMPED tree is not adopted either", () => {
  const unstamped = join(SCRATCH, "wt-unstamped");
  cpSync(PROJECT, unstamped, { recursive: true });
  const { ran } = claimWith(`worktree ${unstamped}\nHEAD ${SHA}\nbranch refs/heads/${BRANCH}`, { replaces: [{ branch: BRANCH, head: SHA }] }, { treeDir: unstamped, owner: null });
  const claim = ran.find((r) => r.cmd === "node");
  assert.ok(claim && !claim.args.some((a) => a.startsWith("--adopt")), claim?.args.join(" "));
});
