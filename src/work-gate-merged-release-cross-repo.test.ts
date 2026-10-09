// no-token: gh -- every `gh`, `git`, `herdr` and `row-claim` call here is an injected seam, and the clock is a constant; nothing imported reaches the real network, a worktree or a workspace
/**
 * #3453: A CLAIM WHOSE PULL REQUEST MERGED IS RELEASED ONLY AFTER THE HOLDER'S WORKTREES IN THE PULL REQUEST'S REPOSITORY WERE READ.
 *
 * #3390's claim named `agent/a-needs-chairman-row-3390` and a worktree of THIS repository, both clean and untouched; its work was `a11ign/agent-org`'s #134
 * on `agent/chairman-answered-3390`, in a worktree of THAT clone. A holder with a follow-up dirty or unpushed there read `none` and would have been released
 * with its workspace closed. The fixture below is #3390's own: the claim record as the real writer makes it, #134's head and merge time.
 *
 * THE POSITIVE CONTROL IS (1): the clean, fully pushed clone is released, and each refusal of (2)-(5) differs from it in exactly one fact, so none of them
 * is asserted against an empty population. (1)-(3) fail on code that never reads the other repository's worktrees; (4) is the ownership test's.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { claimRecordComment } from "./row-claim.ts";
import { performRelease } from "./wake.ts";
import {
  claimFactsFrom, readClaim, claimStalledOrders, holderWorkAtRisk, workAtRiskInPrRepo, cloneOfKey,
} from "./claim-stall.ts";

const CLAIMED_AT = Date.parse("2026-10-04T10:37:40Z");
const MERGED_AT = "2026-10-04T11:19:39Z";
const NOW = Date.parse("2026-10-04T12:28:47Z");
const REPO = "/home/agent/repos/a11y-witness";
const HOME_TREE = "/home/agent/repos/wt-3390";
const CLONE = "/home/agent/repos/agent-org";
const PR_TREE = "/home/agent/repos/agent-org-wt-3390";
const CLAIMED_BRANCH = "agent/a-needs-chairman-row-3390";
const PR_HEAD = "agent/chairman-answered-3390";

const comment = { body: claimRecordComment({ session: "worker-3390", branch: CLAIMED_BRANCH, worktree: "../wt-3390" }),
  createdAt: new Date(CLAIMED_AT).toISOString(), author: { login: "a11ign-ai-workers" } };
/** #134, as `gh pr list --state merged` reports it, tagged with the key the gate gives every pull request of another tracked repository. */
const PR_134 = { number: 134, headRefName: PR_HEAD, mergedAt: MERGED_AT, repoKey: "agent-org", repo: "a11ign/agent-org" };

type Tree = { path: string; branch: string | null; dirty?: number; unpushed?: number };
interface World {
  /** The clone's worktrees, as `git worktree list` reports them. */
  trees?: Tree[];
  /** `git worktree list` in the clone fails with this status. */
  listFails?: number;
  /** The clone's declaration: `false` is a key `host.json` does not declare. */
  declared?: boolean;
}

/** The porcelain listing of `trees`, in git's own format: one block per worktree, a blank line between. */
const porcelain = (trees: Tree[]) => trees.map((t) => [`worktree ${t.path}`, "HEAD 0123456789abcdef0123456789abcdef01234567",
  t.branch === null ? "detached" : `branch refs/heads/${t.branch}`].join("\n")).join("\n\n") + "\n";

const HOLDER_TREE: Tree = { path: PR_TREE, branch: PR_HEAD };
/** The clone's own checkout and ANOTHER row's worktree: neither is the holder's, and neither may hold a release. */
const BYSTANDERS: Tree[] = [{ path: CLONE, branch: null }, { path: "/home/agent/repos/agent-org-wt-3399", branch: "agent/other-row-3399", dirty: 4, unpushed: 2 }];

/** A fake host for two repositories: a home tree that is clean and a clone whose worktrees `world` describes. */
function host(world: World = {}) {
  const trees = world.trees ?? [...BYSTANDERS, HOLDER_TREE];
  const known = new Map<string, Tree>([[HOME_TREE, { path: HOME_TREE, branch: CLAIMED_BRANCH }], ...trees.map((t): [string, Tree] => [t.path, t])]);
  const calls: string[] = [];
  const git = (dir: string, args: string[]) => {
    calls.push(`${dir}: ${args.join(" ")}`);
    if (args[0] === "worktree") return world.listFails === undefined ? { status: 0, out: porcelain(trees) } : { status: world.listFails, out: "" };
    if (args[0] === "rev-parse") return { status: 1, out: "" };
    if (args[0] === "log") return { status: 0, out: "" };
    const tree = known.get(dir);
    if (tree === undefined) throw new Error(`unexpected git in ${dir}: ${args.join(" ")}`);
    if (args[0] === "status") return { status: 0, out: Array.from({ length: tree.dirty ?? 0 }, (_, i) => ` M file-${i}.mjs\n`).join("") };
    if (args[0] === "rev-list") return { status: 0, out: `${tree.unpushed ?? 0}\n` };
    throw new Error(`unexpected git ${args.join(" ")}`);
  };
  const cloneOf = (key: string) => (world.declared === false ? { refusal: `host.json declares no absolute \`clones.${key}\` path` } : { clone: CLONE });
  return { calls, io: { git, exists: (p: string) => known.has(p), mtime: () => null, cloneOf } };
}

const NO_AGENTS = null;
const readingOf = (world: World = {}, input: { open?: object[]; elsewhereOpen?: object[]; merged?: import("./claim-stall.ts").MergedPr[] } = {}) => {
  const h = host(world);
  const facts = claimFactsFrom({ row: 3390, session: "worker-3390", waiting: null, blockedBy: [], comments: [comment], openPrs: input.open ?? [],
    mergedPrs: [], elsewhere: { open: input.elsewhereOpen ?? [], merged: input.merged ?? [PR_134] }, repo: REPO, trackerRepo: "a11ign/a11ign", sessionRows: 1 }, h.io);
  assert.ok(!("skip" in facts), "the fixture's claim record reads");
  const reading = readClaim(facts, { now: NOW, restartAt: null, agents: NO_AGENTS, nudge: null, goneSince: null, idleSince: null });
  return { facts, reading, h };
};

/** Everything a release reaches, in ONE trace, so the ORDER the close, the decline and the comment happen in is assertable. */
function releaseHost(world: World, { spare = true } = {}) {
  const h = host(world);
  const trace: string[] = [];
  const execs: { args: string[]; cwd: string }[] = [];
  const run = (args: string[]) => {
    if (args.includes("list")) return JSON.stringify({ result: { workspaces: [{ label: "worker-3390", workspace_id: "w0", agent_status: "idle" }] } });
    trace.push(args.includes("close") ? "close" : args.join(" "));
    return "";
  };
  const exec = (_cmd: string, args: string[], opts: { cwd: string }) => {
    if (/row-claim\.mjs$/.test(args[0] ?? "") && args[1] === "decline") {
      trace.push("decline");
      execs.push({ args, cwd: opts.cwd });
      return { status: 0, output: "DECLINED -- #3390 is unclaimed again and labelled `answer:product-manager` (NOT returned to `ready`)\n" };
    }
    return { status: 0, output: "" };
  };
  const gh = (a: string[]) => {
    if (a[1] === "comment") { trace.push("comment"); return ""; }
    return a[1] === "view" ? JSON.stringify({ labels: [{ name: "in-progress" }, { name: "session:worker-3390" }] }) : "";
  };
  const deps = { run, exec, io: h.io, now: NOW, agents: [{ label: "worker-3390", status: "idle" }], isSpare: () => spare,
    host: { worktreesDir: "/home/agent/repos", primary: REPO, exists: () => true }, env: {}, warn: () => {}, gh,
    cycle: () => {}, dropInstance: () => ({ spawnedAt: 1, rows: [3390] }), remember: () => {} } as unknown as Parameters<typeof performRelease>[1];
  return { deps, trace, decline: () => execs[0], h };
}

/** The order the gate would send for a reading, and the release it carries: what `performRelease` is handed. */
const releaseOf = (world: World = {}) => {
  const { facts, reading } = readingOf(world);
  const [order] = claimStalledOrders([{ facts, reading }], NOW);
  return order?.release;
};

// --- (1) the #3390 fixture, and the control the refusals below are read against -------------------------------------------------------

test("#3453 (1) the #3390 fixture: a clean, fully pushed worktree on #134's head releases, and the release is PERFORMED close -> decline -> comment", () => {
  const { reading } = readingOf();
  assert.deepEqual(reading, { kind: "release", why: "merged", lastMoveAt: null, idleMs: null, nudgedAt: null, mergedPr: 134, mergedPrRepoKey: "agent-org",
    mergedPrHead: PR_HEAD });
  const release = releaseOf()!;
  assert.deepEqual([release.why, release.mergedPr, release.mergedPrRepoKey, release.answer], ["merged", 134, "agent-org", "product-manager"]);

  const r = releaseHost({});
  const got = performRelease(release, r.deps);
  assert.equal(got.released, true, JSON.stringify(got));
  assert.deepEqual(r.trace, ["close", "decline", "comment"], "the workspace is closed first, then the decline, then the comment");
  assert.ok(r.decline()!.args.includes("--answer=product-manager"), "and the decline carries the answer");
});

test("#3453 (1) the trees READ are the holder's alone: another row's dirty worktree in the same clone does not hold the release, and the clone's own checkout is not read", () => {
  const { h } = readingOf();
  const work = holderWorkAtRisk(h.io, { worktree: HOME_TREE, branch: CLAIMED_BRANCH, repo: REPO,
    merged: { repoKey: "agent-org", head: PR_HEAD, claimant: { row: 3390, branch: CLAIMED_BRANCH, session: "worker-3390" } } });
  assert.deepEqual(work, { state: "none", dirty: 0, unpushed: 0, trees: [PR_TREE] });
  assert.equal(h.calls.some((c) => c.startsWith("/home/agent/repos/agent-org-wt-3399")), false, "another row's tree was never even asked");
});

test("#3453 (1) the holder's other branches in the clone are read by the SAME test the pull request was found by: one ending `-<row>`, or the claimed branch", () => {
  const trees = [...BYSTANDERS, HOLDER_TREE, { path: "/home/agent/repos/agent-org-wt-3390b", branch: "agent/a-second-change-3390", dirty: 1 },
    { path: "/home/agent/repos/agent-org-wt-3390c", branch: CLAIMED_BRANCH, unpushed: 1 }];
  const { h } = readingOf({ trees });
  const work = workAtRiskInPrRepo(h.io, { repoKey: "agent-org", head: PR_HEAD, claimant: { row: 3390, branch: CLAIMED_BRANCH, session: "worker-3390" } });
  assert.deepEqual([work.state, work.dirty, work.unpushed, work.trees!.length], ["at-risk", 1, 1, 3]);
});

// --- (2)-(5) each differs from (1) in exactly one fact ----------------------------------------------------------------------------------

test("#3453 (2) THE DANGER CASE: ONE dirty file in the worktree on that head reads `holding`, naming the count and the tree; nothing is closed and no decline runs", () => {
  const world = { trees: [...BYSTANDERS, { ...HOLDER_TREE, dirty: 1 }] };
  const { reading } = readingOf(world);
  assert.equal(reading.kind, "holding");
  assert.match(reading.kind === "holding" ? reading.why : "", /agent-org#134 merged, but the holder still has 1 dirty file\(s\) and 0 unpushed commit\(s\)/);
  assert.match(reading.kind === "holding" ? reading.why : "", /agent-org-wt-3390/, "and names WHICH worktree");
  assert.equal(releaseOf(world), undefined, "so no release order exists");
});

test("#3453 (3) ONE commit on no remote in that worktree reads `holding`", () => {
  const { reading } = readingOf({ trees: [...BYSTANDERS, { ...HOLDER_TREE, unpushed: 1 }] });
  assert.equal(reading.kind, "holding");
  assert.match(reading.kind === "holding" ? reading.why : "", /0 dirty file\(s\) and 1 unpushed commit\(s\)/);
});

test("#3453 (4) an OPEN pull request of the holder's in ANY tracked repository is `pr-owned`, never `release`", () => {
  const second = { number: 135, headRefName: "agent/a-second-change-3390", repoKey: "agent-org", repo: "a11ign/agent-org" };
  assert.equal(readingOf({}, { elsewhereOpen: [second] }).reading.kind, "pr-owned", "a second pull request in the other repository");
  assert.equal(readingOf({}, { open: [{ number: 3500, headRefName: "agent/a-follow-up-3390" }] }).reading.kind, "pr-owned", "and one in the home repository");
});

test("#3453 (5) FAILS CLOSED: a `git worktree list` that fails, and a key with no clone in host.json, read `holding` with the reason, and nothing releases", () => {
  const failing = readingOf({ listFails: 128 }).reading;
  assert.equal(failing.kind, "holding");
  assert.match(failing.kind === "holding" ? failing.why : "", /could not be read.*git worktree list.* exited 128/);

  const undeclared = readingOf({ declared: false }).reading;
  assert.equal(undeclared.kind, "holding");
  assert.match(undeclared.kind === "holding" ? undeclared.why : "", /could not be read.*no clone of `agent-org`.*declares no absolute `clones\.agent-org` path/);
  assert.equal(releaseOf({ listFails: 128 }), undefined);
  assert.equal(releaseOf({ declared: false }), undefined);
});

test("#3453 (5) a clone that LISTED and holds no tree of the holder's is `none`; a tree that cannot be read is `unknown`, never `none`", () => {
  assert.equal(readingOf({ trees: BYSTANDERS }).reading.kind, "release", "listed, nothing of the holder's there: an answer, not a failure");
  const h = host({});
  const unreadable = { ...h.io, git: (dir: string, args: string[]) => (args[0] === "status" && dir === PR_TREE ? { status: 128, out: "" } : h.io.git(dir, args)) };
  const work = holderWorkAtRisk(unreadable, { worktree: HOME_TREE, branch: CLAIMED_BRANCH, repo: REPO,
    merged: { repoKey: "agent-org", head: PR_HEAD, claimant: { row: 3390, branch: CLAIMED_BRANCH, session: "worker-3390" } } });
  assert.equal(work.state, "unknown");
  assert.match(work.why ?? "", /agent-org-wt-3390/);
});

test("#3453 (5) `host.json`'s clones: a declared key answers, an undeclared one and an unreadable file are REFUSALS naming the file", () => {
  // A host declaration `host-config.mjs` accepts (`packaging/keyed-repo-review.test.ts`'s own shape): `cloneOfKey` reads through that reader.
  const file = (clones: object) => JSON.stringify({ schema: 1, home: "/h", binDir: "/h/bin", primary: "p", projects: [{ id: "p", checkout: "/h/p" }],
    gh: { workers: "/h/w", leads: "/h/l", leadsHeader: [], leadsWorkspaces: [] }, clones });
  const declared = cloneOfKey("agent-org", { path: "/h.json", read: (() => file({ "agent-org": CLONE })) as never });
  const absent = cloneOfKey("agent-org", { path: "/h.json", read: (() => file({})) as never });
  const unreadable = cloneOfKey("agent-org", { path: "/h.json", read: (() => { throw new Error("ENOENT"); }) as never });
  assert.ok("clone" in declared ? declared.clone === CLONE : false, JSON.stringify(declared));
  assert.match("refusal" in absent ? absent.refusal : "", /declares no absolute `clones\.agent-org` path/);
  assert.match("refusal" in unreadable ? unreadable.refusal : "", /\/h\.json cannot be read as the host declaration/);
});

// --- (6) the performer's own fresh re-read -----------------------------------------------------------------------------------------

test("#3453 (6) `performRelease` re-reads the PULL REQUEST'S repository too: the gate read `none`, the tree has since gone dirty, and the release is REFUSED before anything closes", () => {
  const release = releaseOf()!;
  assert.equal(release.mergedPrHead, PR_HEAD, "the order carries the head, so the performer can find the same trees");
  const r = releaseHost({ trees: [...BYSTANDERS, { ...HOLDER_TREE, dirty: 1 }] });
  const got = performRelease(release, r.deps);
  assert.equal(got.released, false);
  assert.match(got.why, /the holder now holds work \(at-risk: 1 dirty, 0 unpushed\)/);
  assert.deepEqual(r.trace, [], "no workspace closed, no decline, no comment");

  const unread = releaseHost({ listFails: 128 });
  const refused = performRelease(release, unread.deps);
  assert.equal(refused.released, false);
  assert.match(refused.why, /unknown/);
  assert.deepEqual(unread.trace, []);
});

// --- (7) a standing seat is kept ----------------------------------------------------------------------------------------------------

test("#3453 (7) a STANDING SEAT is `kept`: its release declines and comments, and its process is NOT closed", () => {
  const r = releaseHost({}, { spare: false });
  const got = performRelease(releaseOf()!, r.deps);
  assert.equal(got.released, true, JSON.stringify(got));
  assert.deepEqual(r.trace, ["decline", "comment"], "no `close`: only a spare's workspace is ended");
  assert.equal(r.decline()!.args.includes("--predecessor-gone"), false, "and it does not attest the process gone");
});

// --- (8) whose merge it is ---------------------------------------------------------------------------------------------------------

test("#3453 (8) a merge dated BEFORE the claim, and a pull request that is not the holder's, release nothing", () => {
  const before = readingOf({}, { merged: [{ ...PR_134, mergedAt: "2026-10-04T09:00:00Z" }] });
  assert.equal(before.facts.mergedPr, null);
  assert.notEqual(before.reading.kind, "release");
  const other = readingOf({}, { merged: [{ ...PR_134, headRefName: "agent/chairman-answered-3391" }] });
  assert.equal(other.facts.mergedPr, null);
  assert.notEqual(other.reading.kind, "release");
  assert.equal(readingOf({}, { merged: [PR_134] }).reading.kind, "release", "CONTROL: the same fixture with #134 as it was IS released");
});
