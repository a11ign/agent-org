// no-token: gh -- `decide` and `addressed` are pure here: every read is an injected fixture and the filesystem question is an injected `exists`; nothing imported reaches the real `gh`
/**
 * #2405: NO ENGINEER ORDER NAMES A PATH THAT DOES NOT EXIST, AND NONE SAYS TO BORROW ANOTHER SESSION'S WORKTREE.
 *
 * `rowOrders` told every woken engineer to run the claim from `/home/agent/repos/role-<you>` "(or any other linked
 * worktree `git worktree list` names)". Read on the host at `a7a91408a`, `role-<name>` existed for two of the eight
 * engineer addresses, and the fallback made the other six BORROW a peer's tree while that peer worked in it.
 *
 * The gate cannot know who takes a pool order, so it leaves `LAUNCH_PLACEHOLDER` and `wake.ts` fills it in at
 * delivery -- and these tests read the order as the ENGINEER receives it, once for each engineer role in
 * `sessions.json` and in both states of the filesystem, so a role added tomorrow is judged without anyone listing it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decide, LAUNCH_PLACEHOLDER, CAUSES, JUDGMENT_CAUSES, START_CAUSES, UNCLAIMABLE_AFTER_TICKS, claimRefusalOf,
  claimRefusalStreaksNow, nextRefusalStreaks, unclaimableRowOrders } from "./work-gate.ts";
import { profileFor } from "./worker-profile.ts";
import { worktreeTargetReason } from "./row-claim.ts";
import { addressed, engineerRoles, launchAdvice, HOST_REPOS, PRIMARY_CHECKOUT } from "./wake.ts";
import { SPARE_FAMILIES } from "./arm-pr.ts";

const PATH_RE = /\/home\/agent\/repos\/[^\s`),;]+/g;

/** The gate's own order for one Ready row -- the real `decide`, so a reworded gate is judged, not a copy of it. */
const gateOrder = () => {
  const orders = decide({ prs: [], readyRows: [{ number: 9001, title: "t", labels: [] }] }) as
    { cause: string; session: string; prompt: string }[];
  const order = orders.find((o) => o.cause === "ready-row-unclaimed");
  assert.ok(order !== undefined, "the gate offers the row -- otherwise every assertion below judges nothing");
  return order;
};

const paths = (text: string) => text.match(PATH_RE) ?? [];

test("#2405 the gate names NO directory: it leaves the placeholder, because only wake knows who took the order", () => {
  const { prompt } = gateOrder();
  assert.ok(prompt.includes(LAUNCH_PLACEHOLDER), "the placeholder is there -- so the fill-in below is not vacuous");
  assert.deepEqual(paths(prompt), [], "and nothing else in the gate's text names a host path");
});

// THE ADDRESSES A STANDING ENGINEER CAN HAVE: the roster's own (none since #2505 retired the last three) and the first
// four members of each spare family, `worker-4` to `worker-7` today. Derived from the two sources `addressed` itself reads, so a roster
// change moves this list with it rather than leaving the sweeps below running over a population that no longer exists.
const ADDRESSES = [...engineerRoles(),
  ...SPARE_FAMILIES.flatMap(({ prefix, from }) => [0, 1, 2, 3].map((i) => `${prefix}${from + i}`))];

test("#2405 the addresses the sweeps below run over are not empty, and hold the roles the row measured", () => {
  assert.deepEqual(engineerRoles(), [], "#2505: no standing engineer address is listed, so the family sample IS the population");
  assert.ok(ADDRESSES.length >= 4, `${ADDRESSES.length} addresses: the family sample`);
  assert.ok(ADDRESSES.includes("worker-4") && ADDRESSES.includes("worker-5"));
});

test("#2405 STANDING ENGINEER, role worktree EXISTS: the order names it, and the only other path is the primary, as a refusal", () => {
  for (const role of ADDRESSES) {
    const dir = `${HOST_REPOS}/role-${role}`;
    const text = addressed({ session: "engineers", prompt: gateOrder().prompt }, role, { exists: (p) => p === dir });
    assert.equal(paths(text)[0], dir, `${role}: the directory to use comes first`);
    assert.deepEqual([...new Set(paths(text))].sort(), [dir, PRIMARY_CHECKOUT].sort(), `${role}: no other path`);
    assert.match(text, /NOT the primary checkout at `[^`]+`, which the tooling refuses/);
    assert.doesNotMatch(text, /worktree add/, `${role}: it exists, so there is nothing to create`);
  }
});

test("#2405 STANDING ENGINEER, role worktree ABSENT: the order gives the ONE command that creates it, detached at origin/main", () => {
  for (const role of ADDRESSES) {
    const dir = `${HOST_REPOS}/role-${role}`;
    const text = addressed({ session: "engineers", prompt: gateOrder().prompt }, role, { exists: () => false });
    assert.equal(paths(text)[0], dir, `${role}: the directory comes before the primary`);
    assert.ok(text.includes(`git -C ${PRIMARY_CHECKOUT} worktree add --detach ${dir} origin/main`),
      `${role}: names the command that creates ${dir}`);
    assert.deepEqual([...new Set(paths(text))].sort(), [dir, PRIMARY_CHECKOUT].sort(), `${role}: names no other path`);
    assert.match(text, /does not exist/, `${role}: and says the directory is absent`);
  }
});

test("#2405 THE HOST AS MEASURED: a few addresses have a worktree, the rest do not -- and no order names an absent path it does not create", () => {
  const present = new Set([`${HOST_REPOS}/role-worker-4`, `${HOST_REPOS}/role-worker-5`]);
  const roles = ADDRESSES;
  let creating = 0;
  for (const role of roles) {
    const text = addressed({ session: "engineers", prompt: gateOrder().prompt }, role, { exists: (p) => present.has(p) });
    for (const path of new Set(paths(text))) {
      if (path === PRIMARY_CHECKOUT || present.has(path)) continue;
      assert.ok(text.includes(`worktree add --detach ${path} origin/main`), `${role}: names ${path}, which is absent and not created`);
      creating += 1;
    }
  }
  assert.equal(creating, roles.filter((r) => !present.has(`${HOST_REPOS}/role-${r}`)).length,
    "POSITIVE CONTROL: every role without a worktree was told to create it, so the loop above judged something");
});

test("#2405 NO ORDER SAYS TO BORROW: neither the delivered text nor the source carries the offer of another worktree", () => {
  const borrow = /any other linked worktree|another session'?s worktree|whichever linked worktree/i;
  for (const exists of [true, false]) {
    for (const role of ADDRESSES) {
      const text = addressed({ session: "engineers", prompt: gateOrder().prompt }, role, { exists: () => exists });
      assert.doesNotMatch(text, borrow, `${role} (role tree exists: ${exists})`);
    }
  }
  assert.doesNotMatch(launchAdvice("worker-9", { exists: () => true }), borrow);
  // THE SOURCE, for the words being GONE rather than merely unreachable: the phrase was in two files' comments once.
  // #2542: `work-gate/pr-orders.ts` holds the pull-request orders' prompts now, so an absence asserted over the
  // gate alone would pass having read less of the gate than before.
  for (const file of ["wake.ts", "work-gate.ts", "work-gate/pr-orders.ts"]) {
    const source = readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
    assert.doesNotMatch(source, /any other linked worktree/i, `${file} still says it`);
  }
});

test("#2405 an order that carries no placeholder is delivered unchanged (only the row order names a launch directory)", () => {
  const order = { session: "reviewer", prompt: "Review PR #12 at abc." };
  assert.match(addressed(order, "reviewer", { exists: () => false }), /\n\nReview PR #12 at abc\.\n\n/);
  assert.doesNotMatch(addressed(order, "reviewer", { exists: () => false }), /worktree/);
});

// --- #2845: A READY ROW THE CLAIM REFUSES, TICK AFTER TICK, WAKES `product-manager` -------------------------------------------

const N = UNCLAIMABLE_AFTER_TICKS;
const ROW = { number: 2824, title: "t", labels: [{ name: "ready" }] };
const TREE = /wt-2824$/;
type Seams = { exists: (p: string) => boolean; owner: (p: string) => string | null };
/** A host where `../wt-2824` exists and `worker-2824` stamped it -- the refusal the journal recorded 211 times. */
const treeStamped: Seams = { exists: (p) => TREE.test(p), owner: () => "worker-2824" };

/** `ticks` consecutive gate ticks over `rows`, in a scratch state directory, returning the orders of the LAST one. */
const tickNTimes = (ticks: number, rows: unknown[], host: Seams, dir: string) => {
  let streaks: Record<string, unknown> = {};
  for (let i = 0; i < ticks; i++) streaks = claimRefusalStreaksNow(rows, { stateDir: dir, worktreesDir: "/w", log: () => {}, ...host });
  const orders = decide({ prs: [], readyRows: rows as never[], claimRefusals: streaks as never }) as { cause: string }[];
  return orders.filter((o) => o.cause === "ready-row-unclaimable") as unknown as
    { session: string; prompt: string; causeKey: string; discriminator: string }[];
};

const scratch = (body: (dir: string) => void) => {
  const dir = mkdtempSync(join(tmpdir(), "a11y-2845-"));
  try { body(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
};

test("#2845 a Ready row refused N ticks running makes ONE order to product-manager, quoting the refusal and naming the row", () => {
  scratch((dir) => {
    const [order, ...rest] = tickNTimes(N, [ROW], treeStamped, dir);
    assert.ok(order !== undefined, "POSITIVE CONTROL: the order exists -- every absence below is judged against it");
    assert.equal(rest.length, 0);
    assert.equal(order.session, "product-manager");
    assert.match(order.prompt, /2824/);
    assert.ok(order.prompt.includes("--worktree=../wt-2824 ALREADY EXISTS, stamped by `worker-2824`"), "the refusal is quoted");
    assert.match(order.causeKey, /^product-manager\/ready-row-unclaimable\/2824-[0-9a-f]{12}$/);
  });
});

test("#2845 the same row refused N-1 ticks makes none -- and the offer itself is still made", () => {
  scratch((dir) => {
    assert.deepEqual(tickNTimes(N - 1, [ROW], treeStamped, dir), []);
  });
  const offered = decide({ prs: [], readyRows: [ROW] }) as { cause: string }[];
  assert.ok(offered.some((o) => o.cause === "ready-row-unclaimed"), "the row is still on offer to the engineers");
});

test("#2845 a row refused and then CLAIMED makes none: the streak is not carried past the tick the refusal stopped", () => {
  scratch((dir) => {
    tickNTimes(N - 1, [ROW], treeStamped, dir);
    const freed = tickNTimes(1, [ROW], { exists: () => false, owner: () => null }, dir);
    assert.deepEqual(freed, [], "the tree is gone: no refusal");
    // and one more refused tick afterwards starts at 1, not at N: the claim that cleared it reset the count
    assert.deepEqual(tickNTimes(1, [ROW], treeStamped, dir), []);
    // a row that LEAVES Ready (claimed, so no longer offerable) is dropped from the memory altogether
    tickNTimes(N - 1, [ROW], treeStamped, dir);
    assert.deepEqual(tickNTimes(1, [], treeStamped, dir), []);
    assert.deepEqual(tickNTimes(1, [ROW], treeStamped, dir), []);
  });
});

test("#2845 it does not nag: the key is the same for as long as the refusal is, and CHANGES when the refusal does", () => {
  scratch((dir) => {
    const first = tickNTimes(N, [ROW], treeStamped, dir)[0];
    const later = tickNTimes(1, [ROW], treeStamped, dir)[0];
    assert.equal(later.causeKey, first.causeKey, "a longer streak of the same refusal is the same question");
    const otherOwner = tickNTimes(N, [ROW], { ...treeStamped, owner: () => "worker-9" }, dir)[0];
    assert.notEqual(otherOwner.causeKey, first.causeKey, "a different owner stamped the tree: a new question");
    assert.match(otherOwner.prompt, /stamped by `worker-9`/);
  });
});

test("#2845 the refusal's WORDS are row-claim's own, for a stamped tree and for an unstamped one", () => {
  for (const owner of ["worker-2824", null]) {
    const ours = claimRefusalOf(ROW, { worktreesDir: "/w", exists: () => true, owner: () => owner });
    const theirs = worktreeTargetReason({ branch: "agent/t-2824", worktree: "../wt-2824", issueNumber: 2824 },
      { exists: () => true, owner: () => owner, run: () => "" });
    assert.equal(ours, theirs, `owner ${owner}`);
  }
});

test("#2845 a tree a release KEPT for the row is adoptable, so it is not a refusal; an absent tree is not either", () => {
  const kept = { "2824": { worktree: "/w/wt-2824" } };
  assert.equal(claimRefusalOf(ROW, { worktreesDir: "/w", kept, exists: () => true, owner: () => "worker-2824" }), null);
  assert.ok(claimRefusalOf(ROW, { worktreesDir: "/w", kept: {}, exists: () => true, owner: () => "worker-2824" }) !== null,
    "POSITIVE CONTROL: without the kept record the same tree IS a refusal");
  assert.equal(claimRefusalOf(ROW, { worktreesDir: "/w", exists: () => false }), null);
});

test("#2845 nextRefusalStreaks counts a repeated refusal, restarts a changed one and drops a cleared one", () => {
  const a = nextRefusalStreaks({}, { "1": "x", "2": "y" });
  assert.deepEqual(a, { "1": { reason: "x", ticks: 1 }, "2": { reason: "y", ticks: 1 } });
  const b = nextRefusalStreaks(a, { "1": "x", "2": "z", "3": null });
  assert.deepEqual(b, { "1": { reason: "x", ticks: 2 }, "2": { reason: "z", ticks: 1 } });
  assert.deepEqual(nextRefusalStreaks(b, {}), {}, "a row not offered this tick is not carried");
  assert.deepEqual(unclaimableRowOrders([ROW], undefined), [], "NOT ASKED is not an order");
});

test("#2845 a state directory that cannot be written reports no streaks, says so, and does not throw", () => {
  scratch((dir) => {
    const blocker = join(dir, "a-file");
    writeFileSync(blocker, "");
    const lines: string[] = [];
    // A directory path UNDER A REGULAR FILE: `mkdirSync` refuses it with ENOTDIR, on any host and as any user.
    const got = claimRefusalStreaksNow([ROW], { stateDir: join(blocker, "state"), worktreesDir: "/w", log: (l) => lines.push(l), ...treeStamped });
    assert.deepEqual(got, {});
    assert.match(lines.join(""), /claim-refusals: could not run/);
  });
});

test("#2845 the cause is declared everywhere a cause is: CAUSES, JUDGMENT (never START), and a PROFILE", () => {
  assert.ok(CAUSES.includes("ready-row-unclaimable"));
  assert.ok(JUDGMENT_CAUSES.includes("ready-row-unclaimable"), "durable, so wake's expiry does not re-ask it");
  assert.ok(!START_CAUSES.includes("ready-row-unclaimable"), "it starts no work, so a drain does not withhold it");
  const profile = profileFor("ready-row-unclaimable");
  assert.ok("model" in profile, "a refused lookup would carry `refusal`, not a profile");
  assert.equal(profile.model, "sonnet");
});
