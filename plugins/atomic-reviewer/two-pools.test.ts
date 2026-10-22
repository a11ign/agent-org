// no-token: gh -- one fake `gh` answers both pools from one table of statuses and one pull request; herdr, the spawn and the checkout are injected, and nothing is spawned
//
// TWO INSTANCES' POOLS OVER THE ATOMIC REVIEWER (A11-149, moved here by A11-161): the claim on a head is what keeps two boards from reviewing the same head, so the test drives each pool's sweep over
// the plugin's real port, which core's own tests do not build. The pools are core's, the gate is loaded for real, and GitHub, herdr and the spawn are fakes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpDir } from "../../src/lib/tmp-fixture.ts";
import { REPO } from "../../src/project-identity.ts";
import { REVIEW_LEASE_MINUTES, claimDescriptionOf } from "../../src/ticket-port/review-claim.ts";
import { loadReviewerGate, readReviewerMemory, reviewerMemoryPath, writeReviewerMemory } from "../../src/ticket-mode/reviewer-port.ts";
import { newPoolContext, type PoolContext } from "../../src/ticket-mode/pool-context.ts";
import { claimWarningOf, reviewNewHeads } from "../../src/ticket-mode/pool-reviewers.ts";
import { reviewOnDemand } from "../../src/ticket-mode/review-command.ts";
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
function atomicReviewerPort({ session, run, gh, codeHost, clones, instance, seen = new Map<string, number>(), heads = new Map<string, string>(), ...seams }: Seams & Readonly<{ session: string; run: (args: string[]) => string; gh: (args: string[]) => string; codeHost: ReturnType<typeof createFakeCodeHost>;
  clones: Record<string, string>; instance: string; seen?: Map<string, number>; heads?: Map<string, string> }>) {
  return portOver(reviewingHelpers({ session, run, gh, codeHost: () => codeHost, clones, instance, heads, seen }), seams);
}

const PR_URL = `https://github.com/${REPO}/pull/7`;
const HEAD = "h1";
/** The head of the pull request a second instance, `RIVAL`, holds in the tests of a refused claim (A11-172). */
const OTHER_HEAD = "h8";
const RIVAL = "pool-rival";
const FORBIDDEN = "Resource not accessible by integration";
const LEASE = REVIEW_LEASE_MINUTES * 60_000;
/** The tracker a pool is built over by default: the tracker contract's in-memory fake, holding no ticket (A11-159). */
const source: TicketSource = createFakeTracker();
const store = { get: () => emptyQueue(1), set: () => {} };

/**
 * One fake GitHub for every pool: a pull request on `REPO` at `HEAD` with green checks, as the code host holds it (the fake), and the statuses on each head, which are still `gh`'s.
 * A status is written at the clock's time, and read back as one line per status under the claim's context, as `claimEntriesOf` reads them. `refuse` makes the write of a status fail as
 * GitHub's 403 does for an App with no "Commit statuses" permission (A11-172); `rival` puts a second pull request first in the sweep, at head `OTHER_HEAD`, with a live claim of `RIVAL`.
 */
function githubOf(clock: { now: number }, { rival = false }: { rival?: boolean } = {}) {
  const statuses: { id: number; sha: string; context: string; created_at: string; description: string }[] = [];
  const state = { refuse: null as string | null, writes: [] as string[] };
  const shaOf = (args: string[]) => /\/commits\/([^/]+)\/statuses|\/statuses\/([^/?]+)/.exec(args.find((arg) => arg.includes("/statuses")) ?? "")!.slice(1).find(Boolean)!;
  const gh = (args: string[]) => {
    if (args[0] === "api" && args.some((arg) => arg.includes("/statuses"))) {
      const sha = shaOf(args);
      if (!args.includes("POST")) return statuses.filter((status) => status.sha === sha && status.context === "agent-org/review").map((status) => `${status.id}\t${status.created_at}\t${status.description}\n`).join("");
      const field = (name: string) => args.find((arg) => arg.startsWith(`${name}=`))!.slice(name.length + 1);
      state.writes.push(`${sha}: ${field("description")}`);
      if (state.refuse !== null) throw Object.assign(new Error(`Command failed: gh ${args.join(" ")}`), { stderr: `gh: ${state.refuse} (HTTP 403)\n{"message":"${state.refuse}"}\n` });
      statuses.push({ id: statuses.length + 1, sha, context: field("context"), created_at: new Date(clock.now).toISOString(), description: field("description") });
      return "";
    }
    throw new Error(`unexpected gh ${args.join(" ")}`);
  };
  const host = createFakeCodeHost();
  if (rival) {
    host.seedPull(REPO, 8, { head: OTHER_HEAD, settled: true, trust: "inside" });
    statuses.push({ id: 1, sha: OTHER_HEAD, context: "agent-org/review", created_at: new Date(clock.now).toISOString(), description: claimDescriptionOf({ instance: RIVAL, now: clock.now }) });
  }
  host.seedPull(REPO, 7, { head: HEAD, settled: true, trust: "inside" });
  for (const other of ["a11ign/control", "a11ign/plugin", "a11ign/nbl-ui-netbox"]) host.seedRepository(other);
  return { gh, statuses, host, state };
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
  // The instances seen are one record, shared by the port that records them and the pool that writes them, as the server wires them.
  const seen = new Map<string, number>();
  const heads = new Map<string, string>();
  const reviewerPort = atomicReviewerPort({ session: "tickets", instance, seen, heads, run: herdrOf(status), gh: github.gh, codeHost: github.host, claimGh: () => github.gh, mint: () => null,
    clones: settings.clones, now: () => clock.now, checkout: () => ({ path: "/work/pr-7", head: HEAD }),
    spawn: (order) => {
      if (refuseSpawn !== undefined) return { refusal: refuseSpawn };
      spawns.push(order.session);
      status.set(order.session, "working");
      return { label: order.session, workspace: "w7", profile: { kind: "codex", model: "m", effort: "e" } };
    } });
  return newPoolContext(store, { settings, source, codeHost: github.host, hook: { node: "/node", bin: "/tool/src/bin.ts" }, herdr: herdrOf(status), gh: github.gh, now: () => clock.now, reviewer: reviewerOver(reviewerPort), reviewerSeen: seen, reviewerHeads: heads });
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

/** One pool alone on its GitHub, over a pull request whose claim GitHub refuses to write, with a second pull request held by `RIVAL` when `rival`; the gate is loaded first. */
async function refusedPoolOf({ rival, root = tmpDir("review-claim-refused-") }: { rival: boolean; root?: string }) {
  await loadReviewerGate();
  const clock = { now: Date.UTC(2026, 9, 22, 12) };
  const github = githubOf(clock, { rival });
  github.state.refuse = FORBIDDEN;
  const status = new Map<string, string>();
  const spawns: string[] = [];
  const pool = poolOf({ instance: "pool-a", github, status, spawns, clock, root });
  return { clock, github, status, spawns, pool, root };
}

const claimAttempts = (github: ReturnType<typeof githubOf>) => github.state.writes.filter((write) => write.startsWith(`${HEAD}: claimed by pool-a`)).length;

test("A11-172: a claim GitHub refuses is not recorded as started: the head is tried again on the next sweep", async () => {
  const { github, spawns, pool, root } = await refusedPoolOf({ rival: true });
  const key = `${PR_URL}@${HEAD}`;
  reviewNewHeads(pool);
  assert.deepEqual(spawns, [], "a second instance is in sight, so no reviewer starts without a claim");
  assert.equal(pool.reviewerStarted.has(key), false, "the head is not in the pool's started set");
  assert.equal(readReviewerMemory(reviewerMemoryPath(join(root, "pool-a"))).memory.started.has(key), false, "and not on disk, where a restart or `ticket:review` reads it");
  assert.equal(claimAttempts(github), 1);
  reviewNewHeads(pool);
  assert.equal(claimAttempts(github), 2, "the next sweep writes the claim again");
  github.state.refuse = null;
  reviewNewHeads(pool);
  assert.deepEqual(spawns, ["reviewer-7"], "and once GitHub takes the claim the reviewer starts");
  assert.equal(pool.reviewerStarted.has(key), true);
  assert.equal(pullReviewText(pool.pullReads.get(PR_URL)!), "reviewing");
  assert.equal(claimWarningOf(pool), null, "and the warning is gone with the problem");
});

test("A11-172: ticket:review starts a head the pool could not claim, once the claim succeeds, and does not call it already started", async () => {
  const { github, spawns, pool, root } = await refusedPoolOf({ rival: true });
  reviewNewHeads(pool);
  const path = reviewerMemoryPath(join(root, "pool-a"));
  const command = () => reviewOnDemand({ url: PR_URL, port: pool.reviewer!, readState: (url) => github.host.readReviewState(url), started: readReviewerMemory(path).memory.started, record: () => {} });
  const refused = command();
  assert.equal(refused.code, 1);
  assert.match(refused.out, /its claim at h1 could not be made \(gh: Resource not accessible by integration \(HTTP 403\)\), so none is started/, "it says why, in GitHub's words");
  assert.doesNotMatch(refused.out, /already started/);
  github.state.refuse = null;
  const started = command();
  assert.equal(started.code, 0, started.out);
  assert.match(started.out, /started reviewer-7 for /);
  assert.deepEqual(spawns, ["reviewer-7"]);
});

test("A11-172: ticket:review says so when it starts a lone instance's reviewer without a claim", async () => {
  const { github, spawns, pool } = await refusedPoolOf({ rival: false });
  const started = reviewOnDemand({ url: PR_URL, port: pool.reviewer!, readState: (url) => github.host.readReviewState(url), started: new Set(), record: () => {} });
  assert.equal(started.code, 0, started.out);
  assert.match(started.out, /started reviewer-7 for .* at h1; started without a claim on GitHub, because no other instance is seen: gh: Resource not accessible by integration \(HTTP 403\); its verdict posts/);
  assert.deepEqual(spawns, ["reviewer-7"]);
});

test("A11-172: a head that cannot be claimed shows on its pull request's line, and once as a board warning for every such pull request", async () => {
  const { pool } = await refusedPoolOf({ rival: true });
  reviewNewHeads(pool);
  assert.equal(pullReviewText(pool.pullReads.get(PR_URL)!), "cannot claim for review: gh: Resource not accessible by integration (HTTP 403)");
  assert.equal(claimWarningOf(pool), "Reviews cannot be claimed on GitHub: gh: Resource not accessible by integration (HTTP 403) (1 pull request). Run agent-org doctor.");
  assert.match(pullReviewText(pool.pullReads.get(`https://github.com/${REPO}/pull/8`)!), /^not reviewed: another instance \(`pool-rival`\) holds the review/, "a head another instance holds is not a claim problem");
});

/** Runs `act` with the board's log (stderr) captured, and returns the lines it wrote. */
function logged(act: () => void): string[] {
  const written: string[] = [];
  const write = process.stderr.write;
  process.stderr.write = ((chunk: string) => { written.push(String(chunk)); return true; }) as typeof process.stderr.write;
  try {
    act();
  } finally {
    process.stderr.write = write;
  }
  return written;
}

test("A11-172: the claim problem is said once in the log for all its pull requests, however many sweeps meet it, and again when it comes back", async () => {
  const { github, pool } = await refusedPoolOf({ rival: true });
  const problem = `ticket:serve: reviews cannot be claimed on GitHub: gh: ${FORBIDDEN} (HTTP 403)\n`;
  // A third pull request that cannot be claimed either: the cause is said once for both.
  github.host.seedPull(REPO, 9, { head: "h9", settled: true, trust: "inside" });
  const first = logged(() => { reviewNewHeads(pool); reviewNewHeads(pool); });
  assert.equal(first.filter((line) => line === problem).length, 1, "once, for two pull requests and two sweeps");
  github.state.refuse = null;
  logged(() => reviewNewHeads(pool));
  github.state.refuse = FORBIDDEN;
  github.host.seedPull(REPO, 7, { head: "h1b", settled: true, trust: "inside" });
  assert.equal(logged(() => reviewNewHeads(pool)).filter((line) => line === problem).length, 1, "mended, then broken again on a new head: said again");
});

test("A11-172: a lone instance whose claim cannot be written starts the reviewer anyway, and the board says so", async () => {
  const { github, spawns, pool, root } = await refusedPoolOf({ rival: false });
  const key = `${PR_URL}@${HEAD}`;
  reviewNewHeads(pool);
  assert.deepEqual(spawns, ["reviewer-7"], "no other instance is seen, so nobody else can review the head twice");
  assert.equal(pool.reviewerStarted.has(key), true, "it is recorded as started, as any started reviewer is");
  assert.equal(readReviewerMemory(reviewerMemoryPath(join(root, "pool-a"))).memory.started.has(key), true);
  assert.equal(pullReviewText(pool.pullReads.get(PR_URL)!), "reviewing without a claim: gh: Resource not accessible by integration (HTTP 403)");
  assert.equal(claimWarningOf(pool), "Reviews start without a claim on GitHub: gh: Resource not accessible by integration (HTTP 403) (1 pull request); no other instance is seen. Run agent-org doctor.");
  assert.equal(github.statuses.length, 0, "nothing was written, so nothing is released");
  assert.equal(github.state.writes.every((write) => !write.includes("released by")), true);
  reviewNewHeads(pool);
  assert.equal(pullReviewText(pool.pullReads.get(PR_URL)!), "reviewing without a claim: gh: Resource not accessible by integration (HTTP 403)", "later sweeps find it running and keep saying so");
  assert.deepEqual(spawns, ["reviewer-7"], "and start nothing more");
});

test("A11-172: with a second instance present the reviewer does not start without a claim; one that goes quiet for the lease no longer counts", async () => {
  const { clock, spawns, pool } = await refusedPoolOf({ rival: true });
  reviewNewHeads(pool);
  assert.deepEqual(spawns, [], "the rival's claim on the other head was seen within the lease");
  clock.now += LEASE - 60_000;
  reviewNewHeads(pool);
  assert.deepEqual(spawns, [], "a minute short of the lease it still counts");
  // The rival's claim is on its head still, and is read again each sweep: its time is the one it was written at, which is the lease old by now, so its head is expired too.
  clock.now += 60_000;
  reviewNewHeads(pool);
  assert.deepEqual(spawns, ["reviewer-8", "reviewer-7"], "at the lease the rival is past: this instance is the only one seen, and starts both heads (the rival's own expired claim included)");
});

test("A11-172: an instance seen before a restart is still seen after it: the record is on disk", async () => {
  const first = await refusedPoolOf({ rival: true });
  reviewNewHeads(first.pool);
  const path = reviewerMemoryPath(join(first.root, "pool-a"));
  assert.deepEqual([...readReviewerMemory(path).memory.seen], [[RIVAL, first.clock.now]], "the second instance is written down");
  // A restarted pool: the same state directory, a new context, and a GitHub where the rival's head is not read again in the sweep.
  const clock = { now: first.clock.now + 60_000 };
  const github = githubOf(clock);
  github.state.refuse = FORBIDDEN;
  const spawns: string[] = [];
  const restarted = poolOf({ instance: "pool-a", github, status: new Map(), spawns, clock, root: first.root });
  reviewNewHeads(restarted);
  assert.deepEqual(spawns, [], "the restarted instance remembers a second instance and starts no reviewer without a claim");
  assert.equal(pullReviewText(restarted.pullReads.get(PR_URL)!), "cannot claim for review: gh: Resource not accessible by integration (HTTP 403)");
});

test("A11-172: a reviewer started without a claim is still said to be, after a restart, because why it has none is kept on disk", async () => {
  const first = await refusedPoolOf({ rival: false });
  reviewNewHeads(first.pool);
  const path = reviewerMemoryPath(join(first.root, "pool-a"));
  assert.deepEqual([...readReviewerMemory(path).memory.unclaimed], [[`${PR_URL}@${HEAD}`, `gh: ${FORBIDDEN} (HTTP 403)`]]);
  // The instance restarts: a new pool over the same state directory and the same herdr, whose reviewer is still running.
  const github = githubOf(first.clock);
  github.state.refuse = FORBIDDEN;
  const restarted = poolOf({ instance: "pool-a", github, status: first.status, spawns: first.spawns, clock: first.clock, root: first.root });
  reviewNewHeads(restarted);
  assert.deepEqual(first.spawns, ["reviewer-7"], "nothing new is started");
  assert.equal(pullReviewText(restarted.pullReads.get(PR_URL)!), `reviewing without a claim: gh: ${FORBIDDEN} (HTTP 403)`);
  assert.match(claimWarningOf(restarted) ?? "", /^Reviews start without a claim on GitHub: /);
});

test("A11-172: a head ticket:review started without a claim is said so on the board by the pool that adopts it, and a claim that was written clears the note", async () => {
  const { clock, github, status, spawns, pool, root } = await refusedPoolOf({ rival: false });
  const path = reviewerMemoryPath(join(root, "pool-a"));
  // `ticket:review` runs in its own process with its own port over the same state directory, and records its start in the file as the command does.
  const other = poolOf({ instance: "pool-a", github, status, spawns, clock, root: tmpDir("review-claim-hand-") });
  const started = reviewOnDemand({ url: PR_URL, port: other.reviewer!, readState: (url) => github.host.readReviewState(url), started: new Set(), record: (label, key, at, unclaimed) => {
    const latest = readReviewerMemory(path).memory;
    latest.started.add(key);
    latest.heads.set(label, at);
    if (unclaimed !== undefined) latest.unclaimed.set(key, unclaimed);
    writeReviewerMemory(path, latest);
  } });
  assert.equal(started.code, 0, started.out);
  reviewNewHeads(pool);
  assert.deepEqual(spawns, ["reviewer-7"], "the pool adopts the start and starts no second reviewer");
  assert.equal(pullReviewText(pool.pullReads.get(PR_URL)!), `reviewing without a claim: gh: ${FORBIDDEN} (HTTP 403)`);
  assert.match(claimWarningOf(pool) ?? "", /^Reviews start without a claim on GitHub: /);
});

test("A11-172: a sighting of another instance older than the lease is neither adopted from the file nor written back", async () => {
  const { clock, pool, root } = await refusedPoolOf({ rival: true });
  reviewNewHeads(pool);
  const path = reviewerMemoryPath(join(root, "pool-a"));
  assert.deepEqual([...readReviewerMemory(path).memory.seen.keys()], [RIVAL]);
  clock.now += LEASE;
  reviewNewHeads(pool);
  // The rival's status is on its head still, and read again: but its time is the lease old, so the record is gone from the file and from the pool.
  assert.deepEqual([...readReviewerMemory(path).memory.seen], [], "the old sighting is not kept");
  assert.equal(pool.reviewerMemory.seen.size, 0);
});
