// no-token: gh -- one fake `gh` answers both pools from one table of statuses and one pull request; herdr, the spawn and the checkout are injected, and nothing is spawned
//
// TWO INSTANCES' POOLS OVER THE ATOMIC REVIEWER (A11-149, moved here by A11-161): the claim on a head is what keeps two boards from reviewing the same head, so the test drives each pool's sweep over
// the plugin's real port, which core's own tests do not build. The pools are core's, the gate is loaded for real, and GitHub, herdr and the spawn are fakes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpDir } from "../../src/lib/tmp-fixture.ts";
import { REPO } from "../../src/project-identity.ts";
import { REVIEW_LEASE_MINUTES } from "../../src/ticket-port/review-claim.ts";
import { loadReviewerGate } from "../../src/ticket-mode/reviewer-port.ts";
import { newPoolContext, type PoolContext } from "../../src/ticket-mode/pool-context.ts";
import { reviewNewHeads } from "../../src/ticket-mode/pool-reviewers.ts";
import { pullReviewText } from "../../src/ticket-mode/board-view/pull-review-state.ts";
import { parseTicketSettings } from "../../src/ticket-mode/settings.ts";
import { emptyQueue } from "../../src/ticket-mode/queue.ts";
import type { TicketSource } from "../../src/ticket-mode/source.ts";
import { createFakeTracker } from "../../src/plugins/fakes/tracker.ts";
import { createFakeCodeHost } from "../../src/plugins/fakes/code-host.ts";
import { reviewerOver } from "../../src/plugins/fakes/reviewer.ts";
import { reviewingHelpers } from "../../src/plugins/reviewing-helpers.ts";
import { atomicReviewerPort as portOver, type Seams } from "./port.ts";

/** The port a board makes: over the real helpers of core, with the board's collaborators these options name. */
function atomicReviewerPort({ session, run, gh, codeHost, clones, instance, ...seams }: Seams & Readonly<{ session: string; run: (args: string[]) => string; gh: (args: string[]) => string; codeHost: ReturnType<typeof createFakeCodeHost>;
  clones: Record<string, string>; instance: string }>) {
  return portOver(reviewingHelpers({ session, run, gh, codeHost: () => codeHost, clones, instance, heads: new Map<string, string>() }), seams);
}

const PR_URL = `https://github.com/${REPO}/pull/7`;
const HEAD = "h1";
const LEASE = REVIEW_LEASE_MINUTES * 60_000;
/** The tracker a pool is built over by default: the tracker contract's in-memory fake, holding no ticket (A11-159). */
const source: TicketSource = createFakeTracker();
const store = { get: () => emptyQueue(1), set: () => {} };

/**
 * One fake GitHub for every pool: a pull request on `REPO` at `HEAD` with green checks, as the code host holds it (the fake), and the statuses on its head, which are still `gh`'s.
 * A status is written at the clock's time, and read back as one line per status under the claim's context, as `claimEntriesOf` reads them.
 */
function githubOf(clock: { now: number }) {
  const statuses: { id: number; context: string; created_at: string; description: string }[] = [];
  const gh = (args: string[]) => {
    if (args[0] === "api" && args.some((arg) => arg.includes("/statuses"))) {
      if (!args.includes("POST")) return statuses.filter((status) => status.context === "agent-org/review").map((status) => `${status.id}\t${status.created_at}\t${status.description}\n`).join("");
      const field = (name: string) => args.find((arg) => arg.startsWith(`${name}=`))!.slice(name.length + 1);
      statuses.push({ id: statuses.length + 1, context: field("context"), created_at: new Date(clock.now).toISOString(), description: field("description") });
      return "";
    }
    throw new Error(`unexpected gh ${args.join(" ")}`);
  };
  const host = createFakeCodeHost();
  host.seedPull(REPO, 7, { head: HEAD, settled: true, trust: "inside" });
  for (const other of ["a11ign/control", "a11ign/plugin", "a11ign/nbl-ui-netbox"]) host.seedRepository(other);
  return { gh, statuses, host };
}

/** A herdr that lists each label in `status` as a running agent, and answers the workspace calls a close makes. */
function herdrOf(status: Map<string, string>) {
  const run = (args: string[]) => {
    if (args.includes("agent") && args.includes("list")) return JSON.stringify({ result: { agents: [...status].map(([label]) => ({ name: null, workspace_id: `w${label.replace(/\D/g, "")}`, agent_session: { value: `session-${label}` } })) } });
    if (args.includes("list")) return JSON.stringify({ result: { workspaces: [...status].map(([label, s]) => ({ label, workspace_id: `w${label.replace(/\D/g, "")}`, agent_status: s })) } });
    return JSON.stringify({ type: "ok" });
  };
  return run;
}

/** One instance's pool on the shared GitHub and herdr: its own memory, its own name, and a reviewer port that starts into the shared herdr and counts starts. */
function poolOf({ instance, github, status, spawns, clock, root, refuseSpawn }: {
  instance: string; github: ReturnType<typeof githubOf>; status: Map<string, string>; spawns: string[]; clock: { now: number }; root: string;
  /** The refusal this pool's spawn answers with, when its reviewer must not start. */
  refuseSpawn?: string;
}): PoolContext {
  const settings = parseTicketSettings({ clones: { "nbl-ui-netbox": "/repos/nbl-ui-netbox" }, stateDir: join(root, instance), tickets: { drafts: false, reviewer: "atomic", instance } });
  const reviewerPort = atomicReviewerPort({ session: "tickets", instance, run: herdrOf(status), gh: github.gh, codeHost: github.host, claimGh: () => github.gh, mint: () => null,
    clones: settings.clones, now: () => clock.now, checkout: () => ({ path: "/work/pr-7", head: HEAD }),
    spawn: (order) => {
      if (refuseSpawn !== undefined) return { refusal: refuseSpawn };
      spawns.push(order.session);
      status.set(order.session, "working");
      return { label: order.session, workspace: "w7", profile: { kind: "codex", model: "m", effort: "e" } };
    } });
  return newPoolContext(store, { settings, source, codeHost: github.host, hook: { node: "/node", bin: "/tool/src/bin.ts" }, herdr: herdrOf(status), gh: github.gh, now: () => clock.now, reviewer: reviewerOver(reviewerPort) });
}

/** Two instances' pools on one GitHub, one herdr, and one clock that starts at a fixed time, with the spawns each pool's reviewer makes. */
function twoPoolsOf(root: string) {
  const clock = { now: Date.UTC(2026, 9, 20, 12) };
  const github = githubOf(clock);
  const status = new Map<string, string>();
  const spawns: string[] = [];
  const pool = (instance: string) => poolOf({ instance, github, status, spawns, clock, root });
  return { clock, github, status, spawns, a: pool("pool-a"), b: pool("pool-b") };
}

test("A11-149: two pools against one fake pull request start one reviewer, and the second says which instance holds the head", async () => {
  await loadReviewerGate();
  const { github, spawns, a, b } = twoPoolsOf(tmpDir("review-claim-pools-"));
  reviewNewHeads(a);
  reviewNewHeads(b);
  reviewNewHeads(b);
  reviewNewHeads(a);
  assert.deepEqual(spawns, ["reviewer-7"], "one reviewer is started across both pools, however often each sweeps");
  assert.equal(github.statuses.length, 1, "one claim is on the head");
  assert.match(pullReviewText(b.pullReads.get(PR_URL)!), /^not reviewed: another instance \(`pool-a`\) holds the review of .* at h1 since /, "the second pool says who holds it");
  assert.equal(pullReviewText(a.pullReads.get(PR_URL)!), "reviewing", "the first pool shows its own reviewer");
});

test("A11-149: a claim its instance never finished is held until the lease ends, then taken over, and the board says so", async () => {
  await loadReviewerGate();
  const { clock, status, spawns, a, b } = twoPoolsOf(tmpDir("review-claim-takeover-"));
  reviewNewHeads(a);
  status.delete("reviewer-7");   // pool-a's reviewer is gone, and it never posted a verdict
  clock.now += LEASE - 60_000;
  reviewNewHeads(b);
  assert.deepEqual(spawns, ["reviewer-7"], "a live claim holds the head a minute before its lease ends");
  clock.now += 60_000;
  reviewNewHeads(b);
  assert.deepEqual(spawns, ["reviewer-7", "reviewer-7"], "at the lease the claim is taken over, and pool-b starts its reviewer");
  assert.equal(pullReviewText(b.pullReads.get(PR_URL)!), "reviewing (took over the claim of pool-a, 60 min old with no verdict)");
  reviewNewHeads(b);
  assert.equal(pullReviewText(b.pullReads.get(PR_URL)!), "reviewing (took over the claim of pool-a, 60 min old with no verdict)", "the board keeps saying so while the head is the same");
  assert.equal(spawns.length, 2, "and nothing else is started");
});

test("A11-149: a reviewer that cannot start gives its claim up, so another instance starts the head at once, not at the lease", async () => {
  await loadReviewerGate();
  const { clock, github, spawns, b } = twoPoolsOf(tmpDir("review-claim-release-"));
  const refusing = poolOf({ instance: "pool-a", github, status: new Map(), spawns, clock, root: tmpDir("review-claim-refusing-"), refuseSpawn: "herdr refused to start the reviewer" });
  reviewNewHeads(refusing);
  assert.match(pullReviewText(refusing.pullReads.get(PR_URL)!), /herdr refused to start the reviewer/, "the refusal is said on the board");
  assert.equal(github.statuses.at(-1)?.description.startsWith("released by pool-a at "), true, "its claim is released on GitHub");
  reviewNewHeads(b);
  assert.deepEqual(spawns, ["reviewer-7"], "the other instance starts its reviewer without waiting for the lease");
  assert.equal(pullReviewText(b.pullReads.get(PR_URL)!), "reviewing");
});
