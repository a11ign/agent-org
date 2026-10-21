// no-token: gh -- one fake `gh` answers both pools from one table of statuses and one pull request; herdr, the spawn and the checkout are injected, and nothing is spawned
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpDir } from "../lib/tmp-fixture.ts";
import { REPO } from "../project-identity.ts";
import { REVIEW_LEASE_MINUTES } from "../ticket-port/review-claim.ts";
import { atomicReviewerPort, loadReviewerGate } from "./reviewer-port.ts";
import { newPoolContext, type PoolContext } from "./pool-context.ts";
import { reviewNewHeads } from "./pool-reviewers.ts";
import { pullReviewText } from "./board-view/pull-review-state.ts";
import { parseTicketSettings } from "./settings.ts";
import { emptyQueue } from "./queue.ts";
import type { TicketSource } from "./source.ts";

const PR_URL = `https://github.com/${REPO}/pull/7`;
const HEAD = "h1";
const DECLARED = { exact: ["worker-bot"], pattern: [] };
const GREEN = [{ name: "gate", status: "COMPLETED", conclusion: "SUCCESS" }];
const LEASE = REVIEW_LEASE_MINUTES * 60_000;
const source: TicketSource = { assigned: async () => [], read: async () => null, download: async () => [] };
const store = { get: () => emptyQueue(1), set: () => {} };

/**
 * One fake GitHub for every pool: a pull request on `REPO` at `HEAD` with green checks, and the statuses on its head. A status is written at the clock's
 * time, and read back as one line per status under the claim's context, as `claimEntriesOf` reads them.
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
    if (args[0] === "pr" && args[1] === "list") return args[args.indexOf("--repo") + 1] === REPO ? JSON.stringify([{ number: 7, body: "" }]) : "[]";
    if (args[0] === "pr") return JSON.stringify({ state: "OPEN", headRefOid: HEAD, reviews: [], author: { login: "worker-bot" }, isCrossRepository: false, isDraft: false, statusCheckRollup: GREEN });
    throw new Error(`unexpected gh ${args.join(" ")}`);
  };
  return { gh, statuses };
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
  const reviewerPort = atomicReviewerPort({ session: "tickets", instance, run: herdrOf(status), gh: github.gh, claimGh: () => github.gh, mint: () => null, declared: DECLARED,
    clones: settings.clones, now: () => clock.now, checkout: () => ({ path: "/work/pr-7", head: HEAD }),
    spawn: (order) => {
      if (refuseSpawn !== undefined) return { refusal: refuseSpawn };
      spawns.push(order.session);
      status.set(order.session, "working");
      return { label: order.session, workspace: "w7", profile: { kind: "codex", model: "m", effort: "e" } };
    } });
  return newPoolContext(store, { settings, source, hook: { node: "/node", bin: "/tool/src/bin.ts" }, herdr: herdrOf(status), gh: github.gh, now: () => clock.now, reviewerPort });
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
