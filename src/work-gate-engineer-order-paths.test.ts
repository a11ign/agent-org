// no-token: gh -- `decide` and `addressed` are pure here: every read is an injected fixture and the filesystem question is an injected `exists`; nothing imported reaches the real `gh`
/**
 * #2405: NO ENGINEER ORDER NAMES A PATH THAT DOES NOT EXIST, AND NONE SAYS TO BORROW ANOTHER SESSION'S WORKTREE.
 *
 * `rowOrders` told every woken engineer to run the claim from `/home/agent/repos/role-<you>` "(or any other linked
 * worktree `git worktree list` names)". Read on the host at `a7a91408a`, `role-<name>` existed for two of the eight
 * engineer addresses, and the fallback made the other six BORROW a peer's tree while that peer worked in it.
 *
 * The gate cannot know who takes a pool order, so it leaves `LAUNCH_PLACEHOLDER` and `wake.mjs` fills it in at
 * delivery -- and these tests read the order as the ENGINEER receives it, once for each engineer role in
 * `sessions.json` and in both states of the filesystem, so a role added tomorrow is judged without anyone listing it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { decide, LAUNCH_PLACEHOLDER } from "./work-gate.mjs";
import { addressed, engineerRoles, launchAdvice, HOST_REPOS, PRIMARY_CHECKOUT } from "./wake.mjs";

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

test("#2405 the roster the sweep below runs over is not empty, and holds the roles the row measured", () => {
  const roles = engineerRoles();
  assert.ok(roles.length >= 8, `sessions.json lists ${roles.length} engineer roles`);
  assert.ok(roles.includes("worker-tooling") && roles.includes("worker-4"));
});

test("#2405 STANDING ENGINEER, role worktree EXISTS: the order names it, and the only other path is the primary, as a refusal", () => {
  for (const role of engineerRoles()) {
    const dir = `${HOST_REPOS}/role-${role}`;
    const text = addressed({ session: "engineers", prompt: gateOrder().prompt }, role, { exists: (p) => p === dir });
    assert.equal(paths(text)[0], dir, `${role}: the directory to use comes first`);
    assert.deepEqual([...new Set(paths(text))].sort(), [dir, PRIMARY_CHECKOUT].sort(), `${role}: no other path`);
    assert.match(text, /NOT the primary checkout at `[^`]+`, which the tooling refuses/);
    assert.doesNotMatch(text, /worktree add/, `${role}: it exists, so there is nothing to create`);
  }
});

test("#2405 STANDING ENGINEER, role worktree ABSENT: the order gives the ONE command that creates it, detached at origin/main", () => {
  for (const role of engineerRoles()) {
    const dir = `${HOST_REPOS}/role-${role}`;
    const text = addressed({ session: "engineers", prompt: gateOrder().prompt }, role, { exists: () => false });
    assert.equal(paths(text)[0], dir, `${role}: the directory comes before the primary`);
    assert.ok(text.includes(`git -C ${PRIMARY_CHECKOUT} worktree add --detach ${dir} origin/main`),
      `${role}: names the command that creates ${dir}`);
    assert.deepEqual([...new Set(paths(text))].sort(), [dir, PRIMARY_CHECKOUT].sort(), `${role}: names no other path`);
    assert.match(text, /does not exist/, `${role}: and says the directory is absent`);
  }
});

test("#2405 THE HOST AS MEASURED: two roles have a worktree, six do not -- and no order names an absent path it does not create", () => {
  const present = new Set([`${HOST_REPOS}/role-worker-tooling`, `${HOST_REPOS}/role-worker-5`]);
  const roles = engineerRoles();
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
    for (const role of engineerRoles()) {
      const text = addressed({ session: "engineers", prompt: gateOrder().prompt }, role, { exists: () => exists });
      assert.doesNotMatch(text, borrow, `${role} (role tree exists: ${exists})`);
    }
  }
  assert.doesNotMatch(launchAdvice("worker-9", { exists: () => true }), borrow);
  // THE SOURCE, for the words being GONE rather than merely unreachable: the phrase was in two files' comments once.
  for (const file of ["wake.mjs", "work-gate.mjs"]) {
    const source = readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
    assert.doesNotMatch(source, /any other linked worktree/i, `${file} still says it`);
  }
});

test("#2405 an order that carries no placeholder is delivered unchanged (only the row order names a launch directory)", () => {
  const order = { session: "reviewer", prompt: "Review PR #12 at abc." };
  assert.match(addressed(order, "reviewer", { exists: () => false }), /\n\nReview PR #12 at abc\.\n\n/);
  assert.doesNotMatch(addressed(order, "reviewer", { exists: () => false }), /worktree/);
});
