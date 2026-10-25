// no-token: none -- herdr, git and the clock are all injected; nothing is spawned
//
// A11-259: A REPOSITORY WHOSE NAME HAS A DOT (`a11ign.github.io`, any GitHub Pages repository) COULD NEVER BE REVIEWED. The reviewer key was the clone's name and `clonedSeatOf` refused a name that is not already a
// key, every tick, so its pull requests waited for review for ever. The key is now made from the name (`cloneKeys`), the seat's label is the machine name, and everything that names the repository to a person
// or to GitHub (the door's `GH_REPO`, the listing's pull request url) keeps its real name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createFakeCodeHost } from "../../src/plugins/fakes/code-host.ts";
import type { CodeHost } from "../../src/plugins/contracts/code-host.ts";
import { INSIDE } from "../../src/review-trust.ts";
import { reviewerInstance } from "../../src/review-attribution.ts";
import { reviewingHelpers } from "../../src/plugins/reviewing-helpers.ts";
import { REPO } from "../../src/project-identity.ts";
import { loadReviewerGate } from "../../src/ticket-mode/reviewer-port.ts";
import { atomicReviewerPort } from "./port.ts";

const OWNER = REPO.split("/")[0];
const PAGES = "a11ign.github.io";
const PAGES_URL = `https://github.com/${OWNER}/${PAGES}/pull/3`;
const PAGES_LABEL = "reviewer-a11ign-github-io-3";

/** A code host that holds the pull request of each of `names` ready, green and inside the org, at head `h1`, and keeps the head's review claims. */
function hostWithPulls(names: string[]): CodeHost {
  const host = createFakeCodeHost("worker-bot");
  for (const name of names) host.seedPull(`${OWNER}/${name}`, 3, { head: "h1", state: "open", trust: "inside", settled: true, reviews: [] });
  const entries: { id: number; description: string; created: number }[] = [];
  return {
    ...host,
    readReviewClaims: () => ({ entries }),
    writeReviewClaim: ({ description }) => { entries.push({ id: entries.length + 1, description, created: Date.now() }); return null; },
  };
}

/** A herdr that opens workspaces and starts agents, and lists each label of `listed` as an idle workspace. */
function herdr(listed: string[] = []) {
  const calls: string[][] = [];
  const run = (args: string[]) => {
    calls.push(args);
    if (args.includes("create")) return JSON.stringify({ result: { root_pane: { pane_id: "w1:p1" }, workspace: { workspace_id: "w1" } } });
    if (args.includes("workspace") && args.includes("list")) return JSON.stringify({ result: { workspaces: listed.map((label) => ({ label, workspace_id: "w1", agent_status: "idle" })) } });
    return JSON.stringify({ type: "ok" });
  };
  return { run, calls };
}

/** A port over `clones`, which records the checkouts it makes, the removals and the reviewers it spawns, and holds a head for each of `heads`. */
function portOver(clones: Record<string, string>, { listed = [], heads = [] }: { listed?: string[]; heads?: string[] } = {}) {
  const herd = herdr(listed);
  const checkouts: object[] = [];
  const removed: object[] = [];
  const spawned: Record<string, string>[] = [];
  const codeHost = hostWithPulls(Object.keys(clones));
  const helpers = reviewingHelpers({ session: "tickets", run: herd.run, codeHost: () => codeHost, clones, instance: "work", heads: new Map(heads.map((label) => [label, "h1"])) });
  const port = atomicReviewerPort(helpers, {
    mint: () => null,
    exists: () => false,
    checkout: (args) => { checkouts.push(args); return { path: "/work/pr-3", head: "h1" }; },
    removeCheckout: (args) => { removed.push(args); return null; },
    spawn: (order, _agents, options) => { spawned.push(options.env as Record<string, string>); return { label: order.session, workspace: "w1", profile: { kind: "codex", model: "m", effort: "e" } }; },
  });
  return { port, herd, checkouts, removed, spawned };
}

test("A11-259: a pull request of a11ign.github.io is reviewed: its seat is reviewer-a11ign-github-io-3, in its clone, posting to the repository by its real name", async () => {
  await loadReviewerGate();
  const made = portOver({ [PAGES]: `/repos/${PAGES}` });
  assert.deepEqual(made.port.start({ pr: PAGES_URL, head: "h1" }), { label: PAGES_LABEL });
  assert.deepEqual(made.checkouts, [{ pr: 3, session: PAGES_LABEL, trust: INSIDE, repoRoot: `/repos/${PAGES}` }], "the checkout is made in the clone, by its real path");
  assert.equal(made.spawned[0].GH_REPO, `${OWNER}/${PAGES}`, "the reviewer's door posts to the repository by its real name");
});

test("A11-259: the seat of a11ign.github.io is read back to the real repository: live, listed by its pull request url, and retired from its clone", async () => {
  await loadReviewerGate();
  assert.deepEqual(reviewerInstance(PAGES_LABEL), { key: "a11ign-github-io", number: 3 });
  const made = portOver({ [PAGES]: `/repos/${PAGES}` }, { listed: [PAGES_LABEL], heads: [PAGES_LABEL] });
  assert.equal(made.port.live({ pr: PAGES_URL, head: "h1" }), true);
  assert.deepEqual(made.port.listedPulls(), [PAGES_URL], "the sweep names the real repository, not its key");
  assert.deepEqual(made.port.retire(PAGES_URL), { retired: true, report: null });
  assert.deepEqual(made.removed, [{ pr: 3, session: PAGES_LABEL, key: "a11ign-github-io", repoRoot: `/repos/${PAGES}` }]);
});

test("A11-259: two clones that make the same key stay two seats, each read back to its own repository, and the one whose name is already the key keeps it", async () => {
  await loadReviewerGate();
  const hyphened = "a11ign-github-io";
  const made = portOver({ [PAGES]: `/repos/${PAGES}`, [hyphened]: `/repos/${hyphened}` });
  assert.deepEqual(made.port.start({ pr: `https://github.com/${OWNER}/${hyphened}/pull/3`, head: "h1" }), { label: `reviewer-${hyphened}-3` }, "the clone already named as a key keeps its seat");
  const started = made.port.start({ pr: PAGES_URL, head: "h1" });
  assert.ok("label" in started && /^reviewer-a11ign-github-io-h[0-9a-f]{7}-3$/.test(started.label), JSON.stringify(started));
  const both = portOver({ [PAGES]: `/repos/${PAGES}`, [hyphened]: `/repos/${hyphened}` }, { listed: [`reviewer-${hyphened}-3`, started.label] });
  assert.deepEqual([...both.port.listedPulls()].sort(), [`https://github.com/${OWNER}/${hyphened}/pull/3`, PAGES_URL].sort());
});
