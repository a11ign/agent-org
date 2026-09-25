// no-token: gh -- every `gh` and `herdr` here is a stub on PATH or an injected seam; nothing imported reaches the real one
/**
 * `packages/agent-org/src/wake.mjs`, #2401: ONE CODEX REVIEWER PER PULL REQUEST, addressed by herdr name.
 *
 * Its own file, and not a block in `wake.test.ts`, for #2280's reason: that file reaches `gh`, so the token-less
 * acceptance job refused it and verified nothing. Every fact read here -- herdr, GitHub, git -- is an injected seam
 * or a stub on PATH.
 *
 * WHAT IS PINNED, in the row's own order: the instance for PR n is the workspace `reviewer-<n>` started with
 * `A11Y_REVIEWER_SESSION=reviewer-<n>` and the reviewer's own account, IN a checkout of PR n's head that exists before
 * the order is typed; the SAME instance answers the next head, re-pointed; there is NO count limit (12 live and one
 * more is placed); `reviewer-<n>` receives PR n's orders and nobody else's; the checkout goes when the instance does;
 * and the engineer path -- `spawnableRole`, `SPAWN_CAUSES`, `registerSpawn`, the `spare-cycles` ledger -- reads
 * exactly as it did.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, chmodSync, existsSync, mkdirSync, symlinkSync, readdirSync,
  realpathSync, lstatSync, readlinkSync, rmSync as removeSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deliver, route, spawnableRole, SPAWN_CAUSES,
  REVIEWER_CAUSES, REVIEWER_GH_CONFIG_DIR, reviewerEnvironment, spawnableReviewer, isReviewerOrder,
  liveReviewers, endFinishedReviewers, registerReviewer, reviewerPathsFrom, sparePathsFrom, spawnEnvironment,
  MAX_SPAWNS_PER_TICK, orderPullRequest, reviewerMismatch, prepareReviewCheckout, removeReviewCheckout,
  reviewCheckoutPath, withReviewCheckout, linkReviewDependencies,
} from "./wake.mjs";
import { readReviewerRegistry, REVIEWER_REGISTRY_FILE } from "./work-gate.mjs";
import { parityOwner } from "./review-attribution.mjs";
import { sandboxGitEnv } from "../../guards/src/git-env.mjs";

const agents = (spec: Record<string, string>) =>
  Object.entries(spec).map(([label, status]) => ({ label, status }));
/** `engineerRoles()` since #2505: the three standing engineers are retired and the spares are a FAMILY, so no address is listed. */
const ROSTER: string[] = [];
const STUB_MODE = 0o755; // the tick invokes `herdr` and `gh` as commands, so the stubs have to be runnable
const TICK_ENTRY = fileURLToPath(new URL("./work-tick.mjs", import.meta.url));

/** The order the gate emits for PR `n`: addressed to `reviewer-<n>`, the name `parityOwner` returns. */
const reviewOrder = (n: number, cause = "draft-awaiting-verdict") => ({
  session: `reviewer-${n}`, cause, causeKey: `reviewer-${n}/${cause}/pr-${n}/abc12345`,
  prompt: `Draft #${n} is green with no verdict at its head.`,
});
/** No engineer process runs and no standing address is listed, so a row's spare is named for the ROW: `worker-2131` (#2469). */
const NO_ENGINEERS = agents({});
const ROW_ORDER = {
  session: "engineers", cause: "ready-row-unclaimed", causeKey: "engineers/ready-row-unclaimed/2131",
  prompt: "Ready row #2131 is unclaimed.",
};

/** Every herdr and git call in the order it was made, so a test can say what happened BEFORE what. */
type Events = string[];

/** A `herdr` that records every call and answers `workspace create` as the live org did on 2026-09-23. */
function recordingHerdr(events: Events = []) {
  const calls: string[][] = [];
  const run = (args: string[]) => {
    calls.push(args);
    events.push(`herdr ${args.join(" ")}`);
    if (args.join(" ").includes("workspace create")) {
      return JSON.stringify({ result: { root_pane: { pane_id: "wB:p1" }, workspace: { workspace_id: "wB" } } });
    }
    return "{}";
  };
  const said = (verb: string) => calls.map((c) => c.join(" ")).filter((s) => s.includes(verb));
  return { calls, run, said, events };
}

const REVIEW_ROOT = "/reviews-root";
const PRIMARY = "/primary";
/** A head for pull request `pr` -- a 40-hex string, `gen` being which push it is. */
const headOf = (pr: number, gen = 1) => `${String(gen).padStart(8, "d")}${String(pr).padStart(32, "0")}`;

/**
 * A `git` and a filesystem that behave as the checkout path needs and record what was asked, in the same event log
 * as herdr. NOTHING here touches a disk: a checkout is a set of paths and the head each one is at.
 */
function fakeCheckout(events: Events = [], { failFetch = false, failRemove = false, failLink = false } = {}) {
  const trees = new Map<string, string>();
  const gen = new Map<number, number>();
  const refs = new Set<number>();
  const git = (_cmd: string, args: string[]) => {
    const line = args.join(" ");
    events.push(`git ${line}`);
    const pr = Number(/pr-(\d+)/.exec(line)?.[1] ?? 0);
    if (line.includes(" fetch ")) {
      if (failFetch) throw new Error("fatal: couldn't find remote ref refs/pull/x/head\nmore");
      refs.add(Number(/pull\/(\d+)\/head/.exec(line)?.[1]));
      return "";
    }
    if (line.includes("rev-parse --verify")) return `${headOf(pr, gen.get(pr) ?? 1)}\n`;
    if (line.includes("worktree add")) { trees.set(args[args.length - 2], args[args.length - 1]); return ""; }
    if (line.includes(" checkout ")) { trees.set(args[1], args[args.length - 1]); return ""; }
    if (line.endsWith("rev-parse HEAD")) return `${trees.get(args[1])}\n`;
    if (line.includes("worktree remove")) {
      if (failRemove) throw new Error("fatal: cannot remove: locked\nmore");
      trees.delete(args[args.length - 1]);
      return "";
    }
    if (line.includes("update-ref -d")) { refs.delete(pr); return ""; }
    throw new Error(`unexpected git ${line}`);
  };
  /** The dependency step (#2498): recorded in the event log so a test can say it ran BEFORE the pane opened. */
  const link = ({ path }: { path: string }) => {
    events.push(`link ${path}`);
    return failLink ? `${PRIMARY}/node_modules does not exist: the tick's own checkout has no dependencies to link` : null;
  };
  return { git, trees, refs, exists: (path: string) => trees.has(path), push: (pr: number) => gen.set(pr, (gen.get(pr) ?? 1) + 1),
    seams: { git, link, exists: (path: string) => trees.has(path), root: REVIEW_ROOT, repoRoot: PRIMARY } };
}
/** The reviewer path's seams for one test: herdr, git and the tree set, sharing an event log. */
function world(over: { failFetch?: boolean; failLink?: boolean } = {}) {
  const events: Events = [];
  const h = recordingHerdr(events);
  const co = fakeCheckout(events, over);
  return { h, co, events, deps: { run: h.run, checkout: co.seams } };
}

// --- the instance for PR n is the workspace `reviewer-<n>` ------------------------------------------------

test("#2401 (1): with no `reviewer-<n>` live, the order STARTS one -- a codex in a workspace of that name, "
  + "as the reviewer's account, with its own session name in the environment", () => {
  const w = world();
  const told: string[] = [];
  const out = deliver([reviewOrder(2398)], agents({ ceo: "working" }), ROSTER,
    { ...w.deps, registerReviewer: (s) => told.push(s) });

  assert.match(out.sent[0], /^reviewer-2398 <- reviewer-2398\/draft-awaiting-verdict\/pr-2398\/abc12345 \(STARTED gpt-5\.6-luna\/medium\)$/);
  const [create] = w.h.said("workspace create");
  assert.match(create, /--label reviewer-2398/);
  assert.ok(create.includes(`--env GH_CONFIG_DIR=${REVIEWER_GH_CONFIG_DIR}`), create);
  assert.ok(create.includes("--env A11Y_REVIEWER_SESSION=reviewer-2398"), create);
  assert.ok(create.includes("--env npm_config_cache=/reviews-root/reviewer-2398/node_modules/.cache/npm"),
    `a cache under the instance's own tree, the one place its sandbox can write (#2498); got ${create}`);
  const [start] = w.h.said("agent start");
  assert.match(start, /agent start reviewer-2398 --kind codex --pane wB:p1/, "a codex, named for the pull request");
  assert.deepEqual(told, ["reviewer-2398"], "the start is registered, for the detector and the teardown");
  assert.equal(w.h.said("/clear").length, 0, "a process that has existed for two seconds has nothing to clear");
  assert.match(w.h.said("agent prompt reviewer-2398")[0], /Draft #2398/, "and the order is delivered to it");
});

test("#2401 (1b): the reviewer's own account is `/home/agent/reviewer/gh`, never the workers' -- and an "
  + "override wins key by key", () => {
  assert.equal(REVIEWER_GH_CONFIG_DIR, "/home/agent/reviewer/gh");
  assert.notEqual(REVIEWER_GH_CONFIG_DIR, spawnEnvironment().GH_CONFIG_DIR);
  assert.deepEqual(reviewerEnvironment("reviewer-7", {}, "/r/reviewer-7"), { GH_CONFIG_DIR: "/home/agent/reviewer/gh",
    A11Y_REVIEWER_SESSION: "reviewer-7", npm_config_cache: "/r/reviewer-7/node_modules/.cache/npm" });
  assert.equal(reviewerEnvironment("reviewer-7").npm_config_cache, `${reviewCheckoutPath("reviewer-7")}/node_modules/.cache/npm`,
    "the default tree is the instance's own checkout");
  assert.equal(reviewerEnvironment("reviewer-7", { GH_CONFIG_DIR: "/x" }).GH_CONFIG_DIR, "/x");
});

test("#2401 (2): a LIVE idle `reviewer-<n>` answers the next head -- the same instance, NOT cleared (#2483), no second one", () => {
  const w = world();
  const told: string[] = [];
  const out = deliver([reviewOrder(2398, "verdict-comment-unreviewed")], agents({ "reviewer-2398": "idle" }), ROSTER,
    { ...w.deps, registerReviewer: (s) => told.push(s) });
  assert.deepEqual(out.sent, ["reviewer-2398 <- reviewer-2398/verdict-comment-unreviewed/pr-2398/abc12345 (no clear)"]);
  assert.equal(w.h.said("workspace create").length, 0, "no second workspace under a label that exists");
  assert.equal(w.h.said("agent start").length, 0);
  assert.equal(w.h.said("/clear").length, 0, "an instance's context is its one pull request: never cleared (#2483)");
  assert.deepEqual(told, [], "and a reused instance is not re-registered");
});

test("#2401: a `reviewer-<n>` that is WORKING waits for the next tick -- it is not started a second time", () => {
  const w = world();
  const out = deliver([reviewOrder(2398)], agents({ "reviewer-2398": "working" }), ROSTER, w.deps);
  assert.deepEqual(out.sent, []);
  assert.match(out.refused[0], /"reviewer-2398" is working/);
  assert.equal(w.h.said("workspace create").length, 0);
  assert.equal(w.co.trees.size, 0, "and no tree was prepared for an order that was not going to be sent");
});

test("#2401: `route` finds the instance by its herdr LABEL, so an order addressed to it needs no roster entry", () => {
  assert.deepEqual(route("reviewer-2398", agents({ "reviewer-2398": "idle" }), ROSTER), { label: "reviewer-2398" });
  assert.match(String((route("reviewer-2398", agents({}), ROSTER) as { refusal: string }).refusal), /no workspace labelled/);
});

test("#2401 (1c): the owner of PR n is `reviewer-<n>` for every n, and no two pull requests share one", () => {
  const spread = [1, 2, 3, 4, 9, 10, 2398, 2410];
  assert.deepEqual(spread.map(parityOwner), spread.map((n) => `reviewer-${n}`));
  assert.equal(new Set(spread.map(parityOwner)).size, spread.length, "a name is never reused for another pull request");
});

// --- NO CEILING: the pool follows the pull requests waiting (chairman, 2026-09-24) -----------------------------

test("#2401 (2c) NO COUNT LIMIT: with TWELVE instances already live, an order for one more is PLACED and started", () => {
  const twelve = agents(Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`reviewer-${101 + i}`, i % 2 ? "working" : "idle"])));
  const w = world();
  const out = deliver([reviewOrder(2398)], twelve, ROSTER, w.deps);
  assert.equal(out.sent.length, 1, `placed, not refused; got ${JSON.stringify(out.refused)}`);
  assert.deepEqual(out.refused, []);
  assert.equal(w.h.said("workspace create").length, 1);
  assert.match(w.h.said("agent start")[0], /agent start reviewer-2398 /);
});

test("#2401 (2d): TWO waiting pull requests are BOTH started in one tick, and no refusal anywhere names a count", () => {
  const w = world();
  const out = deliver([reviewOrder(201), reviewOrder(202), reviewOrder(203)], agents({}), ROSTER, w.deps);
  assert.equal(out.sent.length, 3, JSON.stringify(out.refused));
  assert.equal(w.h.said("workspace create").length, 3);
  assert.deepEqual(w.h.said("workspace create").map((c) => /--label (\S+)/.exec(c)?.[1]), ["reviewer-201", "reviewer-202", "reviewer-203"]);
  // The refusal a reviewer start CAN produce names its cause, never a number of instances.
  const refusals = [
    deliver([reviewOrder(9)], agents({ "reviewer-9": "working" }), ROSTER, w.deps).refused[0],
    deliver([reviewOrder(9)], agents({}), ROSTER, world({ failFetch: true }).deps).refused[0],
  ];
  for (const line of refusals) assert.doesNotMatch(line, /ceiling|live reviewer instance|MAX_|already started \d+/i, line);
});

test("#2401 (2e): an instance the tick STARTED and herdr does not list now is REFUSED, not started a second time -- "
  + "the partial-list case the old per-tick limit stood for, with a named cause", () => {
  const w = world();
  const registry = { "reviewer-2398": { spawnedAt: Date.UTC(2026, 8, 24, 12, 0, 0) } };
  const out = deliver([reviewOrder(2398)], agents({}), ROSTER, { ...w.deps, registry: () => registry });
  assert.deepEqual(out.sent, []);
  assert.match(out.refused[0], /"reviewer-2398" was started at 2026-09-24T12:00:00\.000Z and herdr does not list it now/);
  assert.match(out.refused[0], /delete its key from reviewer-instances\.json/);
  assert.equal(w.h.said("workspace create").length, 0, "no second process under a label that may already be live");
  assert.deepEqual(w.co.trees.size, 0, "and no tree was prepared for it");
});

test("#2401: the retired standing pair are NOT instances -- they are not counted and not started into", () => {
  const standing = agents({ reviewer: "idle", "reviewer-2": "idle", "reviewer-101": "working", "reviewer-102": "working" });
  assert.deepEqual(liveReviewers(standing), ["reviewer-101", "reviewer-102"]);
  assert.ok("session" in spawnableReviewer(reviewOrder(105), standing));
  assert.equal(isReviewerOrder({ session: "reviewer-2", cause: "draft-awaiting-verdict" }), false,
    "`reviewer-2` is the retired pane, so no instance is ever started under its name");
  assert.equal(isReviewerOrder({ session: "reviewer", cause: "draft-awaiting-verdict" }), false);
});

test("#2401: only the two reviewer causes start an instance -- a `pr-checks-failing` order to `reviewer-<n>` does not", () => {
  assert.deepEqual([...REVIEWER_CAUSES], ["draft-awaiting-verdict", "verdict-comment-unreviewed"]);
  assert.equal(isReviewerOrder({ session: "reviewer-9", cause: "pr-checks-failing" }), false);
  assert.equal(isReviewerOrder({ session: "worker-4", cause: "draft-awaiting-verdict" }), false);
  const w = world();
  const out = deliver([reviewOrder(9, "pr-checks-failing")], agents({}), ROSTER, w.deps);
  assert.equal(w.h.said("workspace create").length, 0);
  assert.equal(out.refused.length, 1);
});

// --- DONE-WHEN 7: a per-PR checkout that EXISTS before the order names it ---------------------------------------

test("#2401 (7a): the checkout is prepared BEFORE the pane opens, the pane opens IN it, and the order names that path", () => {
  const w = world();
  deliver([reviewOrder(2398)], agents({}), ROSTER, w.deps);
  const path = `${REVIEW_ROOT}/reviewer-2398`;
  const at = (needle: string) => w.events.findIndex((e) => e.includes(needle));
  assert.ok(at("worktree add") >= 0 && at("worktree add") < at("workspace create"), "tree first, pane second");
  assert.ok(w.events[at("worktree add")].includes(`${path} ${headOf(2398)}`), "at PR 2398's head, detached");
  assert.ok(w.events[at("workspace create")].includes(`--cwd ${path}`), "the workspace starts IN the tree");
  assert.ok(at("workspace create") < at("agent prompt"));
  const [typed] = w.h.said("agent prompt reviewer-2398");
  assert.ok(typed.includes(`\`${path}\``), "the order names the path");
  assert.ok(typed.includes(headOf(2398).slice(0, 8)), "and the head it is at");
  assert.match(typed, /cannot write `\.git`/, "and says what it cannot do there, measured");
  assert.equal(w.co.exists(path), true, "and the path it names exists");
});

test("#2401 (7b): a HEAD-CHANGING PUSH re-points the SAME tree and the same instance -- the order names the new head", () => {
  const w = world();
  deliver([reviewOrder(2398)], agents({}), ROSTER, w.deps);
  w.co.push(2398);
  const out = deliver([{ ...reviewOrder(2398), causeKey: "reviewer-2398/draft-awaiting-verdict/pr-2398/eeee5555" }],
    agents({ "reviewer-2398": "idle" }), ROSTER, w.deps);
  assert.equal(out.sent.length, 1);
  assert.equal(w.co.trees.get(`${REVIEW_ROOT}/reviewer-2398`), headOf(2398, 2), "the tree is at the NEW head");
  assert.equal(w.events.filter((e) => e.includes("worktree add")).length, 1, "re-pointed, not re-created");
  assert.equal(w.h.said("workspace create").length, 1, "and no second workspace");
  const typed = w.h.said("agent prompt reviewer-2398").filter((c) => c.includes("Your checkout of #2398"));
  assert.equal(typed.length, 2, "one order per head, and each names its checkout");
  assert.ok(typed[1].includes(headOf(2398, 2).slice(0, 8)), "the second order names the second head");
  assert.ok(!typed[1].includes(headOf(2398, 1).slice(0, 8)));
});

test("#2401 (7c): a checkout that CANNOT be made refuses the order -- no pane, no prompt, no path named", () => {
  const w = world({ failFetch: true });
  const out = deliver([reviewOrder(2398)], agents({}), ROSTER, w.deps);
  assert.deepEqual(out.sent, []);
  assert.match(out.refused[0], /no review checkout for PR #2398 at \/reviews-root\/reviewer-2398 \(fatal: couldn't find remote ref/);
  assert.equal(w.h.said("workspace create").length, 0);
  assert.equal(w.h.said("agent prompt").length, 0, "an order naming a missing path is a review of nothing");
  const idle = world({ failFetch: true });
  const again = deliver([reviewOrder(2398)], agents({ "reviewer-2398": "idle" }), ROSTER, idle.deps);
  assert.deepEqual([again.sent, idle.h.said("agent prompt")], [[], []], "an EXISTING instance is not prompted either");
});

test("#2401 (7d): `prepareReviewCheckout` and `removeReviewCheckout` are a pair -- what one makes the other removes, "
  + "including the private ref, and a tree that is already gone is done", () => {
  const co = fakeCheckout();
  const made = prepareReviewCheckout({ pr: 7, session: "reviewer-7", ...co.seams });
  assert.deepEqual(made, { path: `${REVIEW_ROOT}/reviewer-7`, head: headOf(7) });
  assert.equal(co.refs.has(7), true);
  assert.equal(removeReviewCheckout({ pr: 7, session: "reviewer-7", ...co.seams }), null);
  assert.deepEqual([co.trees.size, co.refs.has(7)], [0, false]);
  assert.equal(removeReviewCheckout({ pr: 7, session: "reviewer-7", ...co.seams }), null, "twice is still done");
  const stuck = fakeCheckout([], { failRemove: true });
  prepareReviewCheckout({ pr: 7, session: "reviewer-7", ...stuck.seams });
  assert.match(String(removeReviewCheckout({ pr: 7, session: "reviewer-7", ...stuck.seams })), /could not remove \/reviews-root\/reviewer-7 \(fatal: cannot remove: locked\)/);
});

test("#2401 (7e): the checkout is REAL git, not only a fake -- fetched from `refs/pull/<n>/head`, re-pointed on a push, "
  + "removed with its ref", () => {
  const dir = mkdtempSync(join(tmpdir(), "wake-rv-real-git-"));
  const git = (cwd: string, ...args: string[]) => {
    const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args],
      { cwd, encoding: "utf8", env: sandboxGitEnv() });
    assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
    return r.stdout.trim();
  };
  try {
    const origin = join(dir, "origin");
    mkdirSync(origin);
    git(origin, "init", "-q", "-b", "main");
    writeFileSync(join(origin, "a.txt"), "one\n");
    mkdirSync(join(origin, "packages", "a"), { recursive: true });
    writeFileSync(join(origin, "packages", "a", "index.js"), "// package a\n");
    git(origin, "add", "."); git(origin, "commit", "-q", "-m", "one");
    const first = git(origin, "rev-parse", "HEAD");
    git(origin, "update-ref", "refs/pull/7/head", first);
    const primary = join(dir, "primary");
    git(dir, "clone", "-q", origin, primary);
    mkdirSync(join(primary, "node_modules", "left-pad"), { recursive: true }); // what the tick's own checkout carries (#2498)
    const root = join(dir, "reviews");

    const one = prepareReviewCheckout({ pr: 7, session: "reviewer-7", root, repoRoot: primary });
    assert.deepEqual(one, { path: join(root, "reviewer-7"), head: first }, JSON.stringify(one));
    assert.equal(readFileSync(join(root, "reviewer-7", "a.txt"), "utf8"), "one\n");
    const modules = join(root, "reviewer-7", "node_modules");
    assert.equal(realpathSync(join(modules, "left-pad")), realpathSync(join(primary, "node_modules", "left-pad")),
      "a third-party package resolves to the tick's checkout, with no install");
    assert.equal(realpathSync(join(modules, "@a11ign", "a")), realpathSync(join(root, "reviewer-7", "packages", "a")),
      "and an `@a11ign/*` one to THIS tree, never to the primary's source");

    writeFileSync(join(origin, "a.txt"), "two\n");
    git(origin, "commit", "-aq", "-m", "two");
    const second = git(origin, "rev-parse", "HEAD");
    git(origin, "update-ref", "refs/pull/7/head", second);
    const two = prepareReviewCheckout({ pr: 7, session: "reviewer-7", root, repoRoot: primary });
    assert.deepEqual(two, { path: join(root, "reviewer-7"), head: second }, "the SAME path, at the new head");
    assert.equal(readFileSync(join(root, "reviewer-7", "a.txt"), "utf8"), "two\n");

    assert.equal(removeReviewCheckout({ pr: 7, session: "reviewer-7", root, repoRoot: primary }), null);
    assert.equal(existsSync(join(root, "reviewer-7")), false, "the tree is gone");
    assert.equal(git(primary, "worktree", "list", "--porcelain").includes("reviewer-7"), false, "and so is its metadata");
    assert.equal(spawnSync("git", ["-C", primary, "rev-parse", "--verify", "-q", "refs/review/pr-7"], { env: sandboxGitEnv() }).status, 1, "and its ref");
    const gone = prepareReviewCheckout({ pr: 404, session: "reviewer-404", root, repoRoot: primary });
    assert.match(String((gone as { refusal: string }).refusal), /no review checkout for PR #404/, "a pull request with no head is refused");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#2401 (7f): the path is named for the INSTANCE, so two pull requests can never share a tree", () => {
  assert.equal(reviewCheckoutPath("reviewer-7", "/r"), "/r/reviewer-7");
  assert.notEqual(reviewCheckoutPath("reviewer-7", "/r"), reviewCheckoutPath("reviewer-8", "/r"));
  assert.match(withReviewCheckout({ prompt: "P", session: "reviewer-7" }, { path: "/r/reviewer-7", head: "a".repeat(40) }, 7).prompt,
    /^P\n\nYour checkout of #7 is `\/r\/reviewer-7`, detached at the pull request's current head `aaaaaaaa`/);
});

// --- #2498: THE INSTANCE CAN RUN ITS PULL REQUEST'S ACCEPTANCE, AND SIGNS ITS VERDICT ----------------------------------------
//
// Measured 2026-09-25 with `codex sandbox -c sandbox_mode="workspace-write"` (the reviewer's own policy): the checkout and `/tmp`
// are writable, `~/.npm` and the checkout's parent are not, and `npx` in a tree with NO `node_modules` died with `rofs` writing
// `~/.npm/_logs` -- #2376's "0/4; `npx` failed before execution". With the tree's dependencies linked in, the same `npx` runs.

const realFs = { existsSync, mkdirSync, readdirSync, lstatSync, readlinkSync, symlinkSync, rmSync: removeSync };

/** A tick checkout with dependencies and a review tree with two packages, on a real disk, so a link is a real link. */
function depsWorld() {
  const dir = mkdtempSync(join(tmpdir(), "wake-rv-deps-"));
  const primary = join(dir, "primary");
  const tree = join(dir, "reviews", "reviewer-7");
  for (const d of ["node_modules/left-pad", "node_modules/@a11ign/a", "node_modules/.bin", "node_modules/.cache/rstest", ".venv"]) {
    mkdirSync(join(primary, d), { recursive: true });
  }
  writeFileSync(join(primary, "node_modules", ".package-lock.json"), "{}");
  for (const p of ["a", "b"]) mkdirSync(join(tree, "packages", p), { recursive: true });
  return { dir, primary, tree, modules: join(tree, "node_modules") };
}
/** `realFs` that counts what it WROTE, so a second run can be shown to write nothing. */
function countingFs(writes: string[]) {
  return { ...realFs,
    symlinkSync: (...a: Parameters<typeof symlinkSync>) => { writes.push(`symlink ${a[1]}`); return symlinkSync(...a); },
    rmSync: (...a: Parameters<typeof removeSync>) => { writes.push(`rm ${a[0]}`); return removeSync(...a); } };
}

test("#2498 (1a): the dependency step runs AFTER the tree exists and BEFORE the pane opens, and again on a re-point", () => {
  const w = world();
  deliver([reviewOrder(2398)], agents({}), ROSTER, w.deps);
  const at = (needle: string) => w.events.findIndex((e) => e.includes(needle));
  assert.ok(at("worktree add") < at("link /reviews-root/reviewer-2398"), "the tree first: there is nothing to link into before it");
  assert.ok(at("link /reviews-root/reviewer-2398") < at("workspace create"), "and the pane opens on a tree whose Acceptance can run");
  w.co.push(2398);
  deliver([{ ...reviewOrder(2398), causeKey: "reviewer-2398/draft-awaiting-verdict/pr-2398/eeee5555" }],
    agents({ "reviewer-2398": "idle" }), ROSTER, w.deps);
  assert.equal(w.events.filter((e) => e.startsWith("link ")).length, 2, "every head-changing push re-links: the PR may add a package");
});

test("#2498 (1b): a tree whose dependencies could NOT be prepared REFUSES the order -- no pane, no prompt, the reason said", () => {
  const w = world({ failLink: true });
  const out = deliver([reviewOrder(2398)], agents({}), ROSTER, w.deps);
  assert.deepEqual(out.sent, []);
  assert.match(out.refused[0], /no review dependencies for PR #2398 at \/reviews-root\/reviewer-2398 \(.*node_modules does not exist/);
  assert.equal(w.h.said("workspace create").length, 0, "the pane never opens on a tree that cannot run its Acceptance");
  const idle = world({ failLink: true });
  const again = deliver([reviewOrder(2398)], agents({ "reviewer-2398": "idle" }), ROSTER, idle.deps);
  assert.deepEqual([again.sent, idle.h.said("agent prompt")], [[], []], "an EXISTING instance is not prompted onto such a tree either");
  const control = world();
  assert.equal(deliver([reviewOrder(2398)], agents({}), ROSTER, control.deps).sent.length, 1, "CONTROL: the same order is placed when they can");
});

test("#2498 (1c): `linkReviewDependencies` builds the HYBRID `node_modules` -- third-party and `.bin` to the tick's checkout, "
  + "`@a11ign/*` to THIS tree, and never `.cache`", () => {
  const w = depsWorld();
  try {
    assert.equal(linkReviewDependencies({ path: w.tree, repoRoot: w.primary }), null);
    assert.deepEqual(readdirSync(w.modules).sort(), [".bin", "@a11ign", "left-pad"],
      "exactly these: `.cache` is where the instance's npm cache lives, and a link there would send its writes to the primary");
    for (const e of ["left-pad", ".bin"]) assert.equal(readlinkSync(join(w.modules, e)), join(w.primary, "node_modules", e));
    assert.deepEqual(readdirSync(join(w.modules, "@a11ign")).sort(), ["a", "b"], "one per package of THIS tree");
    assert.equal(readlinkSync(join(w.modules, "@a11ign", "a")), join(w.tree, "packages", "a"),
      "to the review tree's source, which `assert-glob-not-empty --run` requires (#2378), and not the primary's `@a11ign/a`");
    assert.equal(readlinkSync(join(w.tree, ".venv")), join(w.primary, ".venv"), "and the Python leg's environment");
    assert.equal(lstatSync(join(w.primary, "node_modules", "@a11ign", "a")).isDirectory(), true, "nothing was written into the primary");
    assert.equal(existsSync(join(w.primary, "node_modules", ".cache", "rstest")), true);
  } finally {
    removeSync(w.dir, { recursive: true, force: true });
  }
});

test("#2498 (1d): it is IDEMPOTENT, follows a PR that adds or removes a package, and replaces a wrong entry", () => {
  const w = depsWorld();
  try {
    linkReviewDependencies({ path: w.tree, repoRoot: w.primary });
    const writes: string[] = [];
    assert.equal(linkReviewDependencies({ path: w.tree, repoRoot: w.primary, fs: countingFs(writes) as never }), null);
    assert.deepEqual(writes, [], "a second run on a right tree writes nothing: it runs on every push");

    removeSync(join(w.tree, "packages", "b"), { recursive: true });
    mkdirSync(join(w.tree, "packages", "c"));
    linkReviewDependencies({ path: w.tree, repoRoot: w.primary });
    assert.deepEqual(readdirSync(join(w.modules, "@a11ign")).sort(), ["a", "c"], "b's link is gone, c's is there");

    removeSync(join(w.modules, "left-pad"));
    mkdirSync(join(w.modules, "left-pad"));
    writeFileSync(join(w.modules, "left-pad", "stale.txt"), "x");
    linkReviewDependencies({ path: w.tree, repoRoot: w.primary });
    assert.equal(readlinkSync(join(w.modules, "left-pad")), join(w.primary, "node_modules", "left-pad"), "a wrong real directory is replaced");
    assert.equal(existsSync(join(w.primary, "node_modules", "left-pad")), true, "and the primary's is untouched");
  } finally {
    removeSync(w.dir, { recursive: true, force: true });
  }
});

test("#2498 (1e): it answers WHY, never throws -- no dependencies in the tick's checkout, no `packages/`, or a write that fails", () => {
  const w = depsWorld();
  try {
    assert.match(String(linkReviewDependencies({ path: w.tree, repoRoot: join(w.dir, "nowhere") })),
      /nowhere\/node_modules does not exist: the tick's own checkout has no dependencies to link/);
    removeSync(join(w.tree, "packages"), { recursive: true });
    assert.match(String(linkReviewDependencies({ path: w.tree, repoRoot: w.primary })), /could not link dependencies into .*node_modules: ENOENT/);
    mkdirSync(join(w.tree, "packages", "a"), { recursive: true });
    const broken = { ...realFs, symlinkSync: () => { throw new Error("EROFS: read-only file system\nmore"); } };
    assert.match(String(linkReviewDependencies({ path: w.tree, repoRoot: w.primary, fs: broken as never })),
      /could not link dependencies into .*node_modules: EROFS: read-only file system$/);
    assert.equal(linkReviewDependencies({ path: w.tree, repoRoot: w.primary }), null, "CONTROL: the same trees link when nothing is wrong");
  } finally {
    removeSync(w.dir, { recursive: true, force: true });
  }
});

test("#2498 (2a): `A11Y_REVIEWER_SESSION` reaches the pane by EVERY path the tick has -- a start whose caller named other "
  + "variables, and an order to a live instance it did not start", () => {
  const started = world();
  deliver([reviewOrder(2398)], agents({}), ROSTER, { ...started.deps, reviewerEnv: { A_OTHER: "1", GH_CONFIG_DIR: "/x" } });
  const [create] = started.h.said("workspace create");
  assert.ok(create.includes("--env A11Y_REVIEWER_SESSION=reviewer-2398"), `a caller's variables are laid OVER the reviewer's, not instead of them: ${create}`);
  assert.ok(create.includes("--env A_OTHER=1") && create.includes("--env GH_CONFIG_DIR=/x"), "and win key by key");

  const live = world();
  deliver([reviewOrder(2398)], agents({ "reviewer-2398": "idle" }), ROSTER, live.deps);
  const [typed] = live.h.said("agent prompt reviewer-2398");
  assert.match(typed, /A11Y_REVIEWER_SESSION=reviewer-2398 pr-review-verdict/,
    "a pane the tick did not start (a `codex resume` by hand) holds no variable, so the ORDER carries the name: it is the one thing every path delivers");
  assert.match(typed, /node_modules\/\.cache\/npm/, "and the cache path, for the same pane");
});

test("#2498 (2b): the tick has exactly ONE way to open a reviewer's pane and ONE to start its agent -- and neither is a resume", () => {
  const source = readFileSync(fileURLToPath(new URL("./wake.mjs", import.meta.url)), "utf8");
  // Measured 2026-09-25: `reviewer-2485`'s live codex was `codex resume <uuid>`, started 92 minutes after the registry's spawn, and this
  // file had no path that resumes a PROCESS (its `resume` is a plain PROMPT to a pane that exists, #2470). So a pane with no
  // `A11Y_REVIEWER_SESSION` was made outside this file. A NEW site that opens or starts one must carry `reviewerEnvironment`, and this
  // count is where that is decided: change it deliberately, and pin the new site's environment in (2a).
  assert.equal((source.match(/"workspace",\s*"create"/g) ?? []).length, 1, "the one `workspace create`, in openPane");
  assert.equal((source.match(/"agent",\s*"start"/g) ?? []).length, 1, "the one `agent start`, in spawnInvocation");
  assert.doesNotMatch(source, /["'`]codex["'`]\s*,\s*["'`]resume["'`]|--resume/, "and no codex/claude process is resumed from here");
});

test("#2498 (2c): the order names the dependencies, the cache and the session for ANY pane, on the first head and on every later one", () => {
  const order = withReviewCheckout({ prompt: "P", session: "reviewer-7" }, { path: "/r/reviewer-7", head: "a".repeat(40) }, 7).prompt;
  assert.match(order, /already linked in \(`node_modules`/);
  assert.match(order, /`\/r\/reviewer-7\/node_modules\/\.cache\/npm`, the one place npm can write: set `npm_config_cache` to it/);
  assert.match(order, /SIGN AS `reviewer-7`.*`A11Y_REVIEWER_SESSION=reviewer-7 pr-review-verdict <n> <convinced\|not-convinced> <file>`/);
});

// --- #2498 Done-when 3: `reviewer.md` says what a verdict that did not execute must say -----------------------------------------

/** One `## ` section of a file: from its heading to the next `## `, so a phrase elsewhere in the file cannot satisfy a pin on it. */
function section(text: string, heading: RegExp): string {
  const start = text.search(heading);
  assert.notEqual(start, -1, `no section matching ${heading}`);
  const rest = text.slice(start + 1);
  const end = rest.search(/\n## /);
  return end === -1 ? rest : rest.slice(0, end);
}

test("#2498 (3): `reviewer.md` pins the rule for a verdict whose Acceptance did not execute -- environmental is never "
  + "`not runnable`, and a `convinced` names the CI run it relies on or is `not convinced (environment)`", () => {
  const doc = readFileSync(fileURLToPath(new URL("../docs/roles/reviewer.md", import.meta.url)), "utf8");
  const rule = section(doc, /^## A verdict whose Acceptance did not execute/m).replace(/\s+/g, " ");
  assert.match(rule, /never says the Acceptance is "not runnable" for an ENVIRONMENTAL reason/);
  assert.match(rule, /A `convinced` verdict whose Acceptance did not execute names the CI run it relies on \(run id or job URL\) in the verdict line/);
  assert.match(rule, /Without one it is `not convinced \(environment\)`/);
});

// --- DONE-WHEN 8: `reviewer-<n>` reviews PR n and NOTHING ELSE ---------------------------------------------------

test("#2401 (8a): an order for PR m is NEVER routed to `reviewer-<n>`, even when it is idle and the only reviewer alive", () => {
  const w = world();
  const onlyOne = agents({ "reviewer-5": "idle" });
  const out = deliver([reviewOrder(6)], onlyOne, ROSTER, w.deps);
  assert.equal(out.sent.length, 1, "PR 6's order was placed -- on a NEW instance");
  assert.deepEqual(w.h.said("agent prompt").map((c) => c.split(" ")[4]), ["reviewer-6"]);
  assert.equal(w.h.said("agent prompt reviewer-5").length, 0, "`reviewer-5` was not prompted");
  assert.equal(w.h.said("/clear").length, 0, "nor cleared");
});

test("#2401 (8b): an order MIS-ADDRESSED to `reviewer-<n>` for another pull request is REFUSED with the reason -- "
  + "by cause key, whatever the cause, and one that names no pull request at all", () => {
  const w = world();
  const wrong = { ...reviewOrder(5), causeKey: "reviewer-5/draft-awaiting-verdict/pr-6/abc12345" };
  const out = deliver([wrong], agents({ "reviewer-5": "idle" }), ROSTER, w.deps);
  assert.deepEqual([out.sent, w.h.said("agent prompt")], [[], []]);
  assert.match(out.refused[0], /"reviewer-5" reviews PR #5 and nothing else, and this order is about PR #6/);

  const other = { session: "reviewer-5", cause: "pr-checks-failing", causeKey: "reviewer-5/pr-checks-failing/pr-6/x",
    prompt: "checks" };
  assert.match(deliver([other], agents({ "reviewer-5": "idle" }), ROSTER, w.deps).refused[0], /about PR #6/);

  const nameless = { ...reviewOrder(5), causeKey: "reviewer-5/draft-awaiting-verdict" };
  assert.match(deliver([nameless], agents({ "reviewer-5": "idle" }), ROSTER, w.deps).refused[0], /about no pull request/);
  assert.equal(w.h.said("agent prompt").length, 0, "FAIL CLOSED: not one prompt in all three");
});

test("#2401 (8c): a FALLBACK cannot carry another pull request's order into an instance", () => {
  const w = world();
  const viaFallback = { session: "worker-9", fallback: "reviewer-5", cause: "trunk-red", causeKey: "trunk-red/pr-6/abc", prompt: "red" };
  const out = deliver([viaFallback], agents({ "reviewer-5": "idle" }), ROSTER, w.deps);
  assert.deepEqual([out.sent, w.h.said("agent prompt")], [[], []]);
  assert.match(out.refused[0], /"reviewer-5" reviews PR #5 and nothing else/);
  // And a reviewer order's own `fallback` is never consulted -- it would name another instance.
  const reviewerFallback = { ...reviewOrder(6), fallback: "reviewer-5" };
  const placed = deliver([reviewerFallback], agents({ "reviewer-5": "idle" }), ROSTER, w.deps);
  assert.equal(placed.sent.length, 1);
  assert.equal(w.h.said("agent prompt reviewer-5").length, 0);
});

test("#2401 (8d): `orderPullRequest` and `reviewerMismatch` read the cause key, and judge only an INSTANCE's label", () => {
  assert.equal(orderPullRequest({ causeKey: "reviewer-7/draft-awaiting-verdict/pr-7/abc" }), 7);
  assert.equal(orderPullRequest({ causeKey: "engineers/ready-row-unclaimed/2131" }), null);
  assert.equal(orderPullRequest({ causeKey: "x/pr-07/y" }), null, "a leading zero is not a pull request number");
  assert.equal(reviewerMismatch({ causeKey: "a/pr-7/b" }, "reviewer-7"), null);
  assert.notEqual(reviewerMismatch({ causeKey: "a/pr-8/b" }, "reviewer-7"), null);
  for (const label of ["worker-4", "reviewer", "reviewer-2", "engineers", "ceo"]) {
    assert.equal(reviewerMismatch({ causeKey: "a/pr-8/b" }, label), null, `${label} is not an instance`);
  }
});

// --- THE ENGINEER PATH IS NOT CHANGED (Done-when 3) ---------------------------------------------------------------

test("#2401 (3b): `spawnableRole`, `SPAWN_CAUSES` and `MAX_SPAWNS_PER_TICK` read exactly as before -- a reviewer "
  + "cause is still not a pilot cause", () => {
  assert.deepEqual([...SPAWN_CAUSES], ["ready-row-unclaimed"]);
  assert.equal(MAX_SPAWNS_PER_TICK, 1);
  const refused = spawnableRole(reviewOrder(5), NO_ENGINEERS, ROSTER) as { refusal: string };
  assert.match(refused.refusal, /no spawn: the pilot covers the engineer pool, and this order is addressed to "reviewer-5"/);
  assert.deepEqual(spawnableRole(ROW_ORDER, NO_ENGINEERS, ROSTER), { role: "worker-2131" });
});

test("#2401 (3c): an engineer order still starts an engineer and REGISTERS it as a spare -- a reviewer start in the "
  + "same tick neither spends its allowance nor touches the spare registry", () => {
  const w = world();
  const spares: string[] = [];
  const reviewers: string[] = [];
  const out = deliver([reviewOrder(2398), ROW_ORDER], NO_ENGINEERS, ROSTER,
    { ...w.deps, registerSpawn: (r) => spares.push(r), registerReviewer: (s) => reviewers.push(s) });
  assert.equal(out.sent.length, 2, "both were started in one tick: each has its own allowance");
  assert.deepEqual(spares, ["worker-2131"], "only the ENGINEER start reaches `registerSpawn`, which feeds `spare-cycles`");
  assert.deepEqual(reviewers, ["reviewer-2398"]);
  assert.match(out.sent.join("\n"), /worker-2131 <- engineers\/ready-row-unclaimed\/2131 \(STARTED sonnet\/high\)/);
});

test("#2401 (3d): the reviewer registry is its OWN file -- it is never the spare registry or the `spare-cycles` ledger", () => {
  const dir = mkdtempSync(join(tmpdir(), "wake-rv-paths-"));
  try {
    const ledger = join(dir, "wake-ledger");
    const rv = reviewerPathsFrom(ledger);
    const sp = sparePathsFrom(ledger);
    assert.equal(rv.registry, join(dir, REVIEWER_REGISTRY_FILE));
    assert.ok(![sp.registry, sp.cycles].includes(rv.registry) && ![sp.registry, sp.cycles].includes(rv.endings));
    registerReviewer(rv, "reviewer-77", 1234);
    assert.deepEqual(readReviewerRegistry(rv.registry), { "reviewer-77": { spawnedAt: 1234 } },
      "what `wake` writes is what the gate's detector reads");
    assert.equal(existsSync(sp.cycles), false, "a reviewer start writes no `spare-cycles` line");
    assert.equal(existsSync(sp.registry), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- THE TEARDOWN: an instance ends when its pull request merges or closes -----------------------------------

const T0 = Date.UTC(2026, 8, 24, 12, 0, 0);

function teardown(over: Record<string, unknown> = {}, live = { "reviewer-9001": "idle" } as Record<string, string>) {
  const closed: string[] = [];
  const removed: string[] = [];
  const records: { session: string; pr: number; state: string; workspace: string; checkout: string }[] = [];
  const warned: string[] = [];
  const run = (args: string[]) => {
    const said = args.join(" ");
    if (said.endsWith("workspace list")) {
      return JSON.stringify({ result: { workspaces: Object.entries(live).map(([label, agent_status], i) =>
        ({ label, agent_status, workspace_id: `wR${i}` })) } });
    }
    if (said.includes("workspace close")) closed.push(said);
    return "{}";
  };
  const deps = { registry: { "reviewer-9001": { spawnedAt: T0 } }, now: T0 + 3_600_000, run,
    prState: () => "closed" as string | null,
    removeCheckout: (session: string, pr: number) => { removed.push(`${session}:${pr}`); return null as string | null; },
    record: (l: object) => records.push(l as (typeof records)[number]),
    warn: (l: string) => warned.push(l), ...over };
  const got = endFinishedReviewers(agents(live), deps as never);
  return { got, closed, removed, records, warned };
}

test("#2401 (2b): an idle instance whose pull request has MERGED OR CLOSED is ended, and the ending is one ledger line", () => {
  const { got, closed, records } = teardown();
  assert.deepEqual(got.ended, ["reviewer-9001"]);
  assert.deepEqual(closed, ["--session org workspace close wR0"]);
  assert.deepEqual(got.registry, {}, "and it leaves the registry");
  assert.deepEqual([records[0].session, records[0].pr, records[0].state, records[0].workspace],
    ["reviewer-9001", 9001, "closed", "closed"]);
});

test("#2401 CONTROL: an OPEN pull request's instance survives -- head-changing pushes re-review on the same one", () => {
  const { got, closed } = teardown({ prState: () => "open" });
  assert.deepEqual([got.ended, closed], [[], []]);
  assert.deepEqual(Object.keys(got.registry), ["reviewer-9001"]);
});

test("#2401 (7g): ENDING an instance REMOVES ITS CHECKOUT, after the workspace closes, and the ledger line says so", () => {
  const { got, removed, records } = teardown();
  assert.deepEqual(removed, ["reviewer-9001:9001"]);
  assert.equal(records[0].checkout, "removed");
  assert.deepEqual(got.ended, ["reviewer-9001"]);
  const kept = teardown({ prState: () => "open" });
  assert.deepEqual(kept.removed, [], "CONTROL: an open pull request's tree is not touched");
});

test("#2401 (7h): a tree that will NOT be removed leaves the instance REGISTERED and writes NO ending -- the next tick "
  + "finds the workspace gone and retries just the removal", () => {
  const stuck = teardown({ removeCheckout: () => "could not remove /reviews/reviewer-9001 (locked)" });
  assert.deepEqual([stuck.got.ended, stuck.records], [[], []]);
  assert.deepEqual(Object.keys(stuck.got.registry), ["reviewer-9001"]);
  assert.match(stuck.warned[0], /its checkout was not removed \(could not remove \/reviews\/reviewer-9001 \(locked\)\) -- retried next tick/);
  // The retry: the workspace is already gone, so nothing is closed a second time and the ending is recorded.
  const retry = teardown({}, {});
  assert.deepEqual([retry.closed, retry.removed, retry.records[0].workspace], [[], ["reviewer-9001:9001"], "already gone"]);
});

test("#2401: a WORKING instance is left until it is between turns, and an unreadable state ends nothing, said", () => {
  assert.deepEqual(teardown({}, { "reviewer-9001": "working" }).closed, []);
  const unread = teardown({ prState: () => null });
  assert.deepEqual([unread.got.ended, unread.closed], [[], []]);
  assert.match(unread.warned[0], /could not read PR #9001's state -- leaving "reviewer-9001" running/);
});

test("#2401: a workspace that will not close is left, said and retried -- no ledger line for an ending that did not happen", () => {
  const { got, records, warned } = teardown({
    run: (args: string[]) => {
      if (args.join(" ").endsWith("workspace list")) {
        return JSON.stringify({ result: { workspaces: [{ label: "reviewer-9001", workspace_id: "wR0", agent_status: "idle" }] } });
      }
      throw new Error("herdr: refused\nstack");
    },
  });
  assert.deepEqual([got.ended, records], [[], []]);
  assert.match(warned[0], /could not be closed \(herdr: refused\) -- retried next tick/);
});

test("#2401 (6): THE STANDING PANES ARE NEVER ENDED -- not in the registry, so a merged PR 2 and a `reviewer` label "
  + "close nothing (cutover is `ceo`'s)", () => {
  const { got, closed } = teardown({ registry: {} },
    { reviewer: "idle", "reviewer-2": "idle", "reviewer-9001": "idle" });
  assert.deepEqual([got.ended, closed], [[], []], "a workspace that merely LOOKS like an instance is not one");
  // And a registry entry for the retired name is refused too: it names no pull request an instance could own.
  const stray = teardown({ registry: { "reviewer-2": { spawnedAt: T0 } } }, { "reviewer-2": "idle" });
  assert.deepEqual([stray.got.ended, stray.closed], [[], []]);
});

/**
 * A `git` on PATH for the process tests: it logs every call, answers the head, makes a tree on `worktree add` and
 * removes it on `worktree remove` -- so the checkout the tick makes is a real directory the test can look for.
 */
function writeGitStub(dir: string) {
  writeFileSync(join(dir, "git"), `#!/bin/sh
echo "$*" >> ${join(dir, "git-calls")}
case "$*" in
  *"rev-parse --verify"*) echo 0123456789abcdef0123456789abcdef01234567 ;;
  *"rev-parse HEAD"*) echo 0123456789abcdef0123456789abcdef01234567 ;;
  *"worktree add"*) for a; do p2=$p1; p1=$a; done; mkdir -p "$p2/packages/a" ;;
  *"worktree remove"*) for a; do last=$a; done; rm -rf "$last" ;;
  *) : ;;
esac
`);
  chmodSync(join(dir, "git"), STUB_MODE);
}

// --- THE WIRING, AS PROCESSES ----------------------------------------------------------------------------------
//
// `work-tick` must call the teardown on a QUIET gate (a merge produces no order, and `wake` is never run on a quiet
// gate), and `wake` must register what it starts. Neither is reachable by a test that injects the seam.

test("#2401 THE TICK: a QUIET gate still ends a finished reviewer instance, and never closes the standing pair", () => {
  const dir = mkdtempSync(join(tmpdir(), "wake-tick-reviewer-"));
  try {
    const ledger = join(dir, "wake-ledger");
    const log = join(dir, "herdr-calls");
    writeFileSync(join(dir, "herdr"), "#!/bin/sh\necho \"$*\" >> " + log + "\ncase \"$*\" in\n  *'workspace list') printf '%s' "
      + `'{"result":{"workspaces":[{"label":"reviewer-9001","workspace_id":"wR","agent_status":"idle"},`
      + `{"label":"reviewer","workspace_id":"w7","agent_status":"idle"},`
      + `{"label":"reviewer-2","workspace_id":"wA","agent_status":"idle"}]}}'`
      + " ;;\n  *) : ;;\nesac\n");
    writeFileSync(join(dir, "gh"), "#!/bin/sh\ncase \"$*\" in\n  \"issue list\"*) printf '%s' '[]' ;;\n"
      + "  *'pulls/9001'*) printf '%s' 'closed' ;;\n  *) exit 1 ;;\nesac\n");
    chmodSync(join(dir, "herdr"), STUB_MODE);
    chmodSync(join(dir, "gh"), STUB_MODE);
    writeGitStub(dir);
    const tree = join(dir, "reviews", "reviewer-9001");
    mkdirSync(tree, { recursive: true });
    writeFileSync(reviewerPathsFrom(ledger).registry, JSON.stringify({ "reviewer-9001": { spawnedAt: T0 } }));
    const ran = spawnSync(process.execPath, [TICK_ENTRY, `--ledger=${ledger}`], { encoding: "utf8",
      env: { ...process.env, HOME: dir, PATH: `${dir}:${process.env.PATH ?? ""}` } });

    const calls = readFileSync(log, "utf8");
    assert.match(calls, /workspace close wR/, `the tick closed the finished instance; got ${ran.stderr}`);
    assert.doesNotMatch(calls, /workspace close w7|workspace close wA/, "the standing pair stay running");
    assert.match(ran.stderr, /ENDED reviewer-9001: its pull request is no longer open/);
    assert.deepEqual(readReviewerRegistry(reviewerPathsFrom(ledger).registry), {});
    assert.equal(existsSync(tree), false, "and its CHECKOUT was removed with it");
    assert.match(readFileSync(join(dir, "git-calls"), "utf8"), /update-ref -d refs\/review\/pr-9001/, "and its private ref");
    assert.equal(existsSync(sparePathsFrom(ledger).cycles), false, "and no `spare-cycles` line was written");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#2401 THE WAKE ENTRY: a started reviewer instance is REGISTERED with its start time, in a file of its own", () => {
  const dir = mkdtempSync(join(tmpdir(), "wake-rv-reg-"));
  try {
    const ledger = join(dir, "wake-ledger");
    writeFileSync(join(dir, "herdr"), "#!/bin/sh\necho \"$*\" >> " + join(dir, "herdr-calls")
      + "\ncase \"$*\" in\n  *'workspace list') printf '%s' '{\"result\":{\"workspaces\":[]}}' ;;\n"
      + "  *'workspace create'*) printf '%s' '{\"result\":{\"root_pane\":{\"pane_id\":\"wB:p1\"},\"workspace\":{\"workspace_id\":\"wB\"}}}' ;;\n"
      + "  *) : ;;\nesac\n");
    chmodSync(join(dir, "herdr"), STUB_MODE);
    writeFileSync(join(dir, "gh"), "#!/bin/sh\nprintf '%s' '[]'\n");
    chmodSync(join(dir, "gh"), STUB_MODE);
    writeGitStub(dir);
    const before = Date.now();
    const ran = spawnSync(process.execPath, [TICK_ENTRY.replace("work-tick.mjs", "wake.mjs"), `--ledger=${ledger}`,
      "--roster=worker-4"], { input: `${JSON.stringify(reviewOrder(2398))}\n`, encoding: "utf8",
      env: { ...process.env, HOME: dir, PATH: `${dir}:${process.env.PATH ?? ""}` } });
    assert.match(ran.stdout, /WOKE reviewer-2398 <- reviewer-2398\/draft-awaiting-verdict\/pr-2398\/abc12345 \(STARTED gpt-5\.6-luna\/medium\)/, ran.stderr);
    const registry = JSON.parse(readFileSync(reviewerPathsFrom(ledger).registry, "utf8"));
    assert.deepEqual(Object.keys(registry), ["reviewer-2398"]);
    assert.ok(registry["reviewer-2398"].spawnedAt >= before, "stamped at the start, which the detector compares to `last_refresh`");
    assert.equal(existsSync(sparePathsFrom(ledger).registry), false, "the engineer registry is untouched");
    const tree = join(dir, "reviews", "reviewer-2398");
    assert.equal(existsSync(tree), true, "the checkout the order names exists");
    assert.match(readFileSync(join(dir, "herdr-calls"), "utf8"), new RegExp(`workspace create .*--cwd ${tree}`),
      "and the workspace was opened in it");
    assert.match(readFileSync(join(dir, "herdr-calls"), "utf8"), new RegExp(`--env A11Y_REVIEWER_SESSION=reviewer-2398 --env npm_config_cache=${tree}/node_modules/\\.cache/npm`),
      "with its own name and a cache it can write, from the real entry");
    assert.equal(realpathSync(join(tree, "node_modules", "@a11ign", "a")), realpathSync(join(tree, "packages", "a")),
      "and the tree's dependencies were linked in BEFORE the pane opened, by the real entry");
    assert.match(readFileSync(join(dir, "git-calls"), "utf8"), /fetch --quiet origin \+refs\/pull\/2398\/head:refs\/review\/pr-2398/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
