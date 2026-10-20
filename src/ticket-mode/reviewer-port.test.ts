// no-token: gh -- herdr, git and the clock are all injected; nothing is spawned
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "../lib/tmp-fixture.ts";
import { INSIDE, type DoorRun } from "../review-trust.ts";
import { REPO } from "../project-identity.ts";
import { runActions, runStatus } from "./board-view/settled-by-pulls.ts";
import { createPool, herdrName, ticketDir } from "./pool.ts";
import { REVIEWER_LOGIN, REVIEW_CAUSE, atomicReviewerPort, clonedSeatOf, earlierReviewWord, loadReviewerGate, openPullUrlsOf, readPullState, readReviewerMemory, reviewWordAt, verdictFileIn, writeReviewerMemory, type ReviewerPort, type ReviewerRef } from "./reviewer-port.ts";
import { emptyQueue } from "./queue.ts";
import { enqueue, type Queue } from "./queue/declared-remains.ts";
import { pauseQueue, resumeQueue } from "./queue/approve.ts";
import { parseTicketSettings } from "./settings.ts";
import { homeProjectDeclaration } from "../project-config.ts";
import { HOST_CONFIG_ENV, hostConfigPath } from "../host-config.ts";
import type { Ticket, TicketSource } from "./source.ts";

const PR_URL = `https://github.com/${REPO}/pull/7`;
const DECLARED = { exact: ["worker-bot"], pattern: [] };
const ticket = (key: string) => ({ key, title: key, description: "", url: `https://linear.app/x/${key}`, branch: key.toLowerCase(), status: "Backlog", statusOrder: 0, team: "NBF", project: null, priority: 0 }) as Ticket;
const source: TicketSource = { assigned: async () => [], read: async () => null, download: async () => [] };
const at = (ms: number) => new Date(ms).toISOString();
const review = (login: string, state: string, commit: string, ms: number) => ({ author: { login }, state, commit: { oid: commit }, submittedAt: at(ms) });

/** A herdr that opens workspaces and starts agents, and lists each label in `status` as a workspace. */
function herdr(status: Map<string, string>) {
  const calls: string[][] = [];
  let next = 0;
  const run = (args: string[]) => {
    calls.push(args);
    if (args.includes("create")) {
      next += 1;
      return JSON.stringify({ result: { root_pane: { pane_id: `w${next}:p1` }, workspace: { workspace_id: `w${next}` } } });
    }
    if (args.includes("agent") && args.includes("list")) return JSON.stringify({ result: { agents: [...status].map(([label]) => ({ name: null, workspace_id: `w${label.replace(/\D/g, "")}`, agent_session: { value: `session-${label}` } })) } });
    if (args.includes("list")) return JSON.stringify({ result: { workspaces: [...status].map(([label, s]) => ({ label, workspace_id: `w${label.replace(/\D/g, "")}`, agent_status: s })) } });
    return JSON.stringify({ type: "ok" });
  };
  return { run, calls };
}

const GREEN = [{ name: "gate", status: "COMPLETED", conclusion: "SUCCESS" }];

/** The pull request as GitHub answers it: `head` is its commit, `reviews` its reviews, `outside` whether its author is outside the org, `checks` its checks (green by default), `state` its state (open by default). */
function ghFor(pr: { head: string; reviews?: unknown[]; outside?: boolean; checks?: unknown[]; state?: string }) {
  const calls: string[][] = [];
  const run = (args: string[]) => {
    calls.push(args);
    if (args[1] === "user") return "worker-bot\n";
    if (args[0] === "pr") return JSON.stringify({ state: pr.state ?? "OPEN", headRefOid: pr.head, reviews: pr.reviews ?? [], author: { login: "worker-bot" }, isCrossRepository: pr.outside === true,
      isDraft: false, statusCheckRollup: pr.checks ?? GREEN });
    const number = Number(args.find((arg) => arg.startsWith("number="))?.slice("number=".length));
    if (number !== 7) throw new Error("gh exited 1");
    const nodes = pr.reviews ?? [];
    return JSON.stringify({ data: { repository: { pullRequest: { state: "OPEN", reviews: { nodes }, comments: { nodes: [] }, reviewThreads: { nodes: [] }, commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: [] } } } }] } } } } });
  };
  return { run, calls, pr };
}

/** A reviewer port that records each start and reports none live, so only the pool's own once-per-head memory stops a second start. */
function fakePort() {
  const starts: ReviewerRef[] = [];
  const port: ReviewerPort = {
    start(ref) { starts.push(ref); return { label: "reviewer-7" }; },
    live: () => false,
    close: () => ({ state: "gone" }), retire: () => ({ retired: true, report: null }), listedPulls: () => [],
    settled: () => "working", verdictFileOf: () => null, repostVerdict: () => ({ posted: true }), reprompt: () => ({ prompted: true }),
  };
  return { port, starts };
}

function setup(gh: (args: string[]) => string, port: ReviewerPort, tickets: Record<string, unknown> = { drafts: false, reviewer: "atomic" }) {
  const root = tmpDir("ticket-reviewer-");
  const settings = parseTicketSettings({ clones: { "nbl-ui-netbox": "/repos/nbl-ui-netbox" }, stateDir: join(root, "state"), tickets });
  let queue: Queue = resumeQueue(enqueue(emptyQueue(1), [ticket("NBF-1")], { model: "sonnet", effort: "high" }, 0, null));
  const store = { get: () => queue, set: (next: Queue) => { queue = next; } };
  const status = new Map<string, string>();
  const h = herdr(status);
  const pool = createPool(store, { settings, source, hook: { node: "/node", bin: "/tool/src/bin.ts" }, herdr: h.run, hostFile: "/work/.agent-org/host.json", now: () => 100, load: () => ({ load: 1, cores: 14 }), transcriptsRoot: join(root, "transcripts"), wait: async () => {},
    pluginRecord: join(root, "no-plugin-record.json"), gh, reviewerPort: port });
  const entry = (key: string) => queue.entries.find((e) => e.ticket.key === key)!;
  return { settings, pool, status, h, entry, root };
}

/** NBF-1 run to a ready pull request: its worker wrote a `ready-pr` outcome and ended, with its transcript where a round would resume it. */
async function readyPrRun(gh: (args: string[]) => string, port: ReviewerPort, tickets?: Record<string, unknown>) {
  await loadReviewerGate();
  const made = setup(gh, port, tickets);
  mkdirSync(join(made.root, "transcripts", "-Users-me-work"), { recursive: true });
  writeFileSync(join(made.root, "transcripts", "-Users-me-work", "session-t-nbf-1.jsonl"), "{}\n");
  await made.pool.tick();
  made.status.set(herdrName("NBF-1"), "idle");
  writeFileSync(join(ticketDir(made.settings, "NBF-1"), "outcome.json"), JSON.stringify({ kind: "ready-pr", prs: [{ repo: "nbl-ui-netbox", url: PR_URL }] }));
  await made.pool.tick();
  made.status.delete(herdrName("NBF-1"));
  return made;
}

/** Let the tick that a feedback round wakes, which `watchFeedback` does not wait for, start the round. */
const roundStarted = async () => { for (let i = 0; i < 50; i += 1) await new Promise((resolve) => setImmediate(resolve)); };

test("a drafts-off run opens no draft and reaches the reviewer with no Approve", async () => {
  const reviewer = fakePort();
  const gh = ghFor({ head: "h1" });
  const made = await readyPrRun(gh.run, reviewer.port);
  const dir = ticketDir(made.settings, "NBF-1");
  const brief = readFileSync(join(dir, "brief.md"), "utf8");
  assert.ok(brief.includes("open ONE READY pull request"), "the worker is told to open a ready pull request");
  assert.equal(brief.includes("gh pr create --draft"), false, "no draft is named");
  assert.ok(existsSync(join(dir, "ready-run")), "the hook lets the worker open one ready");
  assert.equal(runStatus(made.entry("NBF-1")), "awaiting-review", "the run waits for review");
  assert.deepEqual(runActions(made.entry("NBF-1")), ["dismiss"], "there is no Approve");
  made.pool.watchFeedback();
  assert.deepEqual(reviewer.starts, [{ pr: PR_URL, head: "h1" }], "the reviewer is started for the ready head");
  assert.deepEqual(runActions(made.entry("NBF-1")), ["dismiss"], "still no Approve once the reviewer is started");
});

test("the reviewer is started once per ready head: a second watch on the same head starts nothing, and a new head starts one", async () => {
  const reviewer = fakePort();
  const gh = ghFor({ head: "h1" });
  const made = await readyPrRun(gh.run, reviewer.port);
  made.pool.watchFeedback();
  made.pool.watchFeedback();
  assert.deepEqual(reviewer.starts.map((ref) => ref.head), ["h1"], "the same head is not started again");
  gh.pr.head = "h2";
  made.pool.watchFeedback();
  assert.deepEqual(reviewer.starts.map((ref) => ref.head), ["h1", "h2"], "a new head is started");
});

test("a not-convinced verdict resumes the same worker for a round with the reviewer's line, and a convinced one starts no round", async () => {
  const cases: [string, unknown[], boolean][] = [
    ["changes requested", [review(REVIEWER_LOGIN, "CHANGES_REQUESTED", "h1", 200)], true],
    ["approved", [review(REVIEWER_LOGIN, "APPROVED", "h1", 200)], false],
    ["no verdict yet", [], false],
  ];
  for (const [verdict, reviews, resumes] of cases) {
    const reviewer = fakePort();
    const gh = ghFor({ head: "h1", reviews });
    const made = await readyPrRun(gh.run, reviewer.port);
    made.h.calls.length = 0;
    made.pool.watchFeedback();
    await roundStarted();
    const run = made.entry("NBF-1");
    if (!resumes) {
      assert.equal(run.phase, "finished", `${verdict}: no round starts`);
      assert.equal(made.h.calls.some((args) => args.includes("start")), false, `${verdict}: no worker starts`);
      continue;
    }
    assert.deepEqual([run.phase, run.rounds], ["running", 1]);
    assert.equal(run.feedback, `${REVIEWER_LOGIN} requested changes on ${PR_URL} at h1: fix what its review found, then push.`);
    const start = made.h.calls.find((args) => args.includes("start"))!;
    const tail = start.slice(start.indexOf("--") + 1);
    assert.deepEqual(tail.slice(tail.indexOf("--resume"), tail.indexOf("--resume") + 2), ["--resume", "session-t-nbf-1"], "the same worker's session");
    assert.match(readFileSync(join(ticketDir(made.settings, "NBF-1"), "brief.md"), "utf8"), /feedback round for NBF-1/);
  }
});

test("the atomic reviewer refuses a pull request whose author is outside the org, and starts nothing", async () => {
  await loadReviewerGate();
  const herd = herdr(new Map());
  const spawned: unknown[] = [];
  const port = atomicReviewerPort({ session: "tickets", run: herd.run, gh: ghFor({ head: "h1", outside: true }).run, declared: DECLARED,
    spawn: (order) => { spawned.push(order); return { label: order.session, workspace: "w7", profile: { kind: "codex", model: "m", effort: "e" } }; },
    checkout: () => ({ path: "/work/pr-7", head: "h1" }) });
  const started = port.start({ pr: PR_URL, head: "h1" });
  assert.match("refusal" in started ? started.refusal : "", /outside the org/);
  assert.deepEqual(spawned, []);
  assert.equal(herd.calls.some((args) => args.includes("prompt")), false, "no prompt is sent");
});

test("the atomic reviewer starts the gate's reviewer in the tickets' session for an org pull request, and is live for its head only", async () => {
  await loadReviewerGate();
  const listed = new Map<string, string>();
  const herd = herdr(listed);
  const spawned: { order: unknown; cwd: unknown }[] = [];
  const port = atomicReviewerPort({ session: "tickets", run: herd.run, gh: ghFor({ head: "h1" }).run, declared: DECLARED,
    spawn: (order, _agents, options) => { spawned.push({ order, cwd: options.cwd }); return { label: order.session, workspace: "w7", profile: { kind: "codex", model: "m", effort: "e" } }; },
    checkout: () => ({ path: "/work/pr-7", head: "h1" }) });
  assert.deepEqual(port.start({ pr: PR_URL, head: "h1" }), { label: "reviewer-7" });
  assert.deepEqual(spawned, [{ order: { session: "reviewer-7", cause: REVIEW_CAUSE, causeKey: `${PR_URL}@h1`, trust: INSIDE }, cwd: "/work/pr-7" }]);
  const prompt = herd.calls.find((args) => args.includes("prompt"))!;
  assert.deepEqual(prompt.slice(0, 5), ["--session", "tickets", "agent", "prompt", "reviewer-7"]);
  assert.equal(port.live({ pr: PR_URL, head: "h1" }), false, "not live until herdr lists its workspace");
  listed.set("reviewer-7", "working");
  assert.equal(port.live({ pr: PR_URL, head: "h1" }), true, "live for the head it was started for");
  assert.equal(port.live({ pr: PR_URL, head: "h2" }), false, "not live for a head it was not started for");
});

test("the reviewer is asked the gate's own verdict prompt for the pull request and its head, which names the reviewer role file", async () => {
  await loadReviewerGate();
  const herd = herdr(new Map());
  const port = atomicReviewerPort({ session: "tickets", run: herd.run, gh: ghFor({ head: "h1" }).run, declared: DECLARED,
    spawn: (order) => ({ label: order.session, workspace: "w7", profile: { kind: "codex", model: "m", effort: "e" } }),
    checkout: () => ({ path: "/work/pr-7", head: "h1" }) });
  assert.deepEqual(port.start({ pr: PR_URL, head: "h1" }), { label: "reviewer-7" });
  const prompt = herd.calls.find((args) => args.includes("prompt"))!;
  assert.equal(prompt[prompt.length - 1], "Ready (not a draft) #7 at `h1` has settled green checks and no verdict at that head. "
    + "Review it per .agent-org/roles/reviewer.md and post the verdict as it says.");
});

test("the atomic reviewer starts nothing for a head whose checks have not settled green", async () => {
  await loadReviewerGate();
  const herd = herdr(new Map());
  const spawned: unknown[] = [];
  const checks = [{ name: "gate", status: "IN_PROGRESS", conclusion: null }];
  const port = atomicReviewerPort({ session: "tickets", run: herd.run, gh: ghFor({ head: "h1", checks }).run, declared: DECLARED,
    spawn: (order) => { spawned.push(order); return { label: order.session, workspace: "w7", profile: { kind: "codex", model: "m", effort: "e" } }; },
    checkout: () => ({ path: "/work/pr-7", head: "h1" }) });
  const started = port.start({ pr: PR_URL, head: "h1" });
  assert.match("refusal" in started ? started.refusal : "", /have not settled green/);
  assert.deepEqual(spawned, []);
});

test("a port given the heads a pool remembers is live for the head its reviewer was started for, across a restart", async () => {
  await loadReviewerGate();
  const herd = herdr(new Map([["reviewer-7", "working"]]));
  const heads = new Map([["reviewer-7", "h1"]]);
  const port = atomicReviewerPort({ session: "tickets", run: herd.run, gh: ghFor({ head: "h1" }).run, declared: DECLARED, heads });
  assert.equal(port.live({ pr: PR_URL, head: "h1" }), true, "live for the remembered head");
  assert.equal(port.live({ pr: PR_URL, head: "h2" }), false, "not live for a head it was not started for");
});

/**
 * A port over a herdr that lists `status`, for the close and the teardown. Its checkout's uncommitted paths are `paths`, or the read fails, and its
 * removal answers `removal`; nothing is removed and no git runs. `events` names each close, each git read and each removal, in the order they happen.
 */
function teardownPort(status: Map<string, string>, { paths = [] as string[], pathsFail = false, removal = null as string | null } = {}) {
  const herd = herdr(status);
  const events: string[] = [];
  const removed: { pr: number; session: string; key: string }[] = [];
  const heads = new Map([["reviewer-7", "h1"]]);
  const port = atomicReviewerPort({ session: "tickets", run: (args) => { if (args.includes("close")) events.push("close"); return herd.run(args); },
    gh: ghFor({ head: "h1" }).run, declared: DECLARED, heads, exists: () => true,
    uncommittedPaths: () => { events.push("read"); if (pathsFail) throw new Error("fatal: not a git repository"); return paths; },
    removeCheckout: ({ pr, session, key }) => { events.push("removed"); removed.push({ pr, session: String(session), key: String(key) }); return removal; } });
  return { port, herd, events, removed, heads };
}

test("a reviewer is closed once its verdict is posted: its workspace closes, and its checkout is kept", async () => {
  await loadReviewerGate();
  const made = teardownPort(new Map([["reviewer-7", "idle"]]));
  assert.deepEqual(made.port.close({ pr: PR_URL, head: "h1" }), { state: "closed" });
  assert.deepEqual(made.herd.calls.filter((args) => args.includes("close")), [["--session", "tickets", "workspace", "close", "w7"]]);
  assert.deepEqual(made.removed, [], "the checkout is kept for the next reviewer of the seat");
  assert.equal(made.heads.get("reviewer-7"), "h1", "the head it was started for is still remembered");
});

test("close waits for a reviewer still working: nothing closes, and it answers busy", async () => {
  await loadReviewerGate();
  const made = teardownPort(new Map([["reviewer-7", "working"]]));
  assert.deepEqual(made.port.close({ pr: PR_URL, head: "h1" }), { state: "busy" });
  assert.equal(made.herd.calls.some((args) => args.includes("close")), false, "no workspace is closed");
});

test("close answers gone for a reviewer herdr no longer lists, and closes nothing", async () => {
  await loadReviewerGate();
  const made = teardownPort(new Map());
  assert.deepEqual(made.port.close({ pr: PR_URL, head: "h1" }), { state: "gone" });
  assert.equal(made.herd.calls.some((args) => args.includes("close")), false);
});

test("close closes nothing for a head the seat's reviewer was not started for", async () => {
  await loadReviewerGate();
  const made = teardownPort(new Map([["reviewer-7", "idle"]]));
  const answer = made.port.close({ pr: PR_URL, head: "h2" });
  assert.match("refusal" in answer ? answer.refusal : "", /was not started for h2/);
  assert.equal(made.herd.calls.some((args) => args.includes("close")), false, "no workspace is closed");
});

test("retire closes every workspace under the seat's label, then removes its checkout, and forgets the head", async () => {
  await loadReviewerGate();
  const made = teardownPort(new Map([["reviewer-7", "idle"]]));
  assert.deepEqual(made.port.retire(PR_URL), { retired: true, report: null });
  assert.deepEqual(made.events, ["close", "read", "removed"], "the workspace first, then the checkout");
  assert.deepEqual(made.removed, [{ pr: 7, session: "reviewer-7", key: "" }]);
  assert.equal(made.heads.has("reviewer-7"), false, "the head is forgotten once the checkout is gone");
});

test("retire on a pull request whose seat has no workspace removes only its checkout", async () => {
  await loadReviewerGate();
  const made = teardownPort(new Map());
  assert.deepEqual(made.port.retire(PR_URL), { retired: true, report: null });
  assert.equal(made.herd.calls.some((args) => args.includes("close")), false);
  assert.deepEqual(made.removed, [{ pr: 7, session: "reviewer-7", key: "" }]);
});

test("retire on a reviewer still working refuses, and removes nothing", async () => {
  await loadReviewerGate();
  const made = teardownPort(new Map([["reviewer-7", "working"]]));
  const answer = made.port.retire(PR_URL);
  assert.match("refusal" in answer ? answer.refusal : "", /still working/);
  assert.deepEqual(made.removed, []);
  assert.equal(made.heads.get("reviewer-7"), "h1");
});

test("a checkout with uncommitted changes is reported, naming the seat, the head and the paths, and is removed", async () => {
  await loadReviewerGate();
  const made = teardownPort(new Map([["reviewer-7", "idle"]]), { paths: ["src/a.ts", "node_modules/x"] });
  const answer = made.port.retire(PR_URL);
  assert.ok("retired" in answer, "the pull request is retired");
  assert.match(answer.report ?? "", /^reviewer teardown: reviewer-7 for https:\/\/github\.com\/[^ ]+\/pull\/7 at h1 had 2 uncommitted change\(s\) in .+\/reviewer-7, discarded with the checkout: src\/a\.ts, node_modules\/x$/);
  assert.equal(made.removed.length, 1, "and the checkout is removed with them");
});

test("a report of uncommitted changes names the first 20 paths and how many more there were", async () => {
  await loadReviewerGate();
  const paths = Array.from({ length: 23 }, (_, i) => `f${i}.ts`);
  const made = teardownPort(new Map([["reviewer-7", "idle"]]), { paths });
  const answer = made.port.retire(PR_URL);
  const report = "retired" in answer ? answer.report ?? "" : "";
  assert.match(report, /had 23 uncommitted change\(s\)/);
  assert.match(report, /: f0\.ts, .*, f19\.ts and 3 more$/);
  assert.equal(report.includes("f20.ts"), false, "the paths past the twentieth are counted, not named");
});

test("a clean checkout is removed with no report", async () => {
  await loadReviewerGate();
  const made = teardownPort(new Map([["reviewer-7", "idle"]]), { paths: [] });
  assert.deepEqual(made.port.retire(PR_URL), { retired: true, report: null });
  assert.equal(made.removed.length, 1);
});

test("a checkout whose changes cannot be read is kept, and the head is remembered for the next sweep", async () => {
  await loadReviewerGate();
  const made = teardownPort(new Map([["reviewer-7", "idle"]]), { pathsFail: true });
  const answer = made.port.retire(PR_URL);
  assert.match("refusal" in answer ? answer.refusal : "", /could not be read, so it is kept/);
  assert.deepEqual(made.removed, [], "nothing is removed that could not be inspected");
  assert.equal(made.heads.get("reviewer-7"), "h1");
});

test("a removal that fails is a refusal, keeps the head, and reports no discard", async () => {
  await loadReviewerGate();
  const made = teardownPort(new Map([["reviewer-7", "idle"]]), { paths: ["a.ts"], removal: "could not remove /home/x/reviews/reviewer-7 (busy)" });
  const answer = made.port.retire(PR_URL);
  assert.match("refusal" in answer ? answer.refusal : "", /could not remove .* \(busy\)/);
  assert.equal(made.heads.get("reviewer-7"), "h1", "the head is kept, so the next sweep retries");
});

test("listedPulls names the pull request of each reviewer workspace the session lists, and of no other workspace", async () => {
  await loadReviewerGate();
  const made = teardownPort(new Map([["reviewer-7", "idle"], ["NBF-1", "idle"], ["reviewer-2", "idle"]]));
  assert.deepEqual(made.port.listedPulls(), [PR_URL]);
});

test("readPullState reads a pull request's state as GitHub names it, and null for one it cannot read", async () => {
  const answers: (string | Error)[] = [JSON.stringify({ state: "MERGED" }), JSON.stringify({ state: "OPEN" }), JSON.stringify({ state: "CLOSED" }), JSON.stringify({}), new Error("gh exited 1")];
  const gh = (args: string[]) => {
    assert.deepEqual(args.slice(0, 2), ["pr", "view"]);
    const answer = answers.shift()!;
    if (answer instanceof Error) throw answer;
    return answer;
  };
  assert.equal(readPullState(PR_URL, gh), "MERGED");
  assert.equal(readPullState(PR_URL, gh), "OPEN");
  assert.equal(readPullState(PR_URL, gh), "CLOSED");
  assert.equal(readPullState(PR_URL, gh), null, "an answer with no state is unread");
  assert.equal(readPullState(PR_URL, gh), null, "a refused read is unread");
  assert.equal(readPullState("https://example.com/not-a-pull", gh), null, "a url that is no pull request is unread");
});

// A11-83: a reviewer that ended without its verdict on the pull request. The verdict file is found by what it says, posted again through the
// door with its token minted first, and a reviewer that ended with no file is prompted again.

/** The heads the verdict tests use: hex, as the door and the verdict parser read them. */
const H1 = "a1".repeat(20);
const H2 = "c3".repeat(20);

/** The verdict line a reviewer writes for pull request 7 at `head`, as the door reads it. */
const verdictLine = (head: string, word: string) => `**Review of #7 at \`${head.slice(0, 8)}\`, by reviewer-7: ${word} (CI run 41)**`;

/** An atomic port over a checkout `tree`, whose reviewer is listed as `status`, recording each mint and door run in order. */
function verdictPort(tree: string, { status = new Map([["reviewer-7", "idle"]]), mint = (() => null) as (path: string) => string | null, door = (() => {}) as DoorRun } = {}) {
  const order: string[] = [];
  const herd = herdr(status);
  const port = atomicReviewerPort({ session: "tickets", run: herd.run, gh: ghFor({ head: "h1" }).run, declared: DECLARED, heads: new Map([["reviewer-7", "h1"]]),
    checkoutOf: () => tree,
    mint: (path) => { order.push(`mint ${path}`); return mint(path); },
    door: (file, args, env) => { order.push("door"); door(file, args, env); } });
  return { port, herd, order };
}

/** A fresh checkout whose `verdict-7.md` holds `content`: the checkout and the file's path. */
function verdictTree(prefix: string, content: string): { tree: string; file: string } {
  const tree = tmpDir(prefix);
  const file = join(tree, "verdict-7.md");
  writeFileSync(file, content);
  return { tree, file };
}

test("a verdict file is found by what it says, in the checkout or one folder down, for the head it names, and the newest one wins", async () => {
  await loadReviewerGate();
  const tree = tmpDir("reviewer-tree-");
  mkdirSync(join(tree, "sub"));
  mkdirSync(join(tree, "node_modules"));
  writeFileSync(join(tree, "notes.md"), "not a verdict\n");
  writeFileSync(join(tree, "old-head.md"), `${verdictLine(H2, "convinced")}\n`);
  writeFileSync(join(tree, "node_modules", "skipped.md"), `${verdictLine(H1, "convinced")}\n`);
  writeFileSync(join(tree, "verdict-7.md"), `${verdictLine(H1, "convinced")}\n`);
  utimesSync(join(tree, "verdict-7.md"), new Date(1_000), new Date(1_000));
  writeFileSync(join(tree, "sub", "verdict.md"), `${verdictLine(H1, "not convinced")}\n`);
  assert.equal(verdictFileIn(tree, 7, H1), join(tree, "sub", "verdict.md"), "the newer of the two files for the head, one folder down");
  assert.equal(verdictFileIn(tree, 7, H2), join(tree, "old-head.md"), "a file for the head it names");
  assert.equal(verdictFileIn(tree, 8, H1), null, "none for another pull request");
  assert.equal(verdictFileIn(join(tree, "missing"), 7, H1), null, "none in a checkout that is not there");
});

test("a verdict file is posted again through the door: the token is minted first, and the door is given the word the file opens with", async () => {
  await loadReviewerGate();
  const { tree, file } = verdictTree("reviewer-repost-", `${verdictLine(H1, "not convinced")}\n\nfindings\n`);
  const doorCalls: { file: string; args: string[]; env: Record<string, string> }[] = [];
  const made = verdictPort(tree, { door: (path, args, env) => { doorCalls.push({ file: path, args, env }); } });
  assert.deepEqual(made.port.repostVerdict({ pr: PR_URL, head: H1 }, file), { posted: true });
  assert.deepEqual(made.order, [`mint ${tree}`, "door"], "the token is minted before the door posts");
  assert.deepEqual(doorCalls.map((call) => call.args), [["7", "not-convinced", file]]);
  assert.equal(doorCalls[0].env.A11Y_REVIEWER_SESSION, "reviewer-7", "the door posts with the reviewer's own identity");
  assert.equal(doorCalls[0].env.A11Y_APP_TOKEN_DIR, join(tree, "node_modules", ".cache", "app-tokens"), "from the token directory the reviewer reads");
});

test("a token that will not mint stops the repost before the door runs, and its reason is the refusal, which a later attempt may cure", async () => {
  await loadReviewerGate();
  const { tree, file } = verdictTree("reviewer-mint-", `${verdictLine(H1, "convinced")}\n\nbody\n`);
  const doorCalls: string[][] = [];
  const made = verdictPort(tree, { mint: () => "the reviewer's app token could not be minted: no key", door: (_path, args) => { doorCalls.push(args); } });
  assert.deepEqual(made.port.repostVerdict({ pr: PR_URL, head: H1 }, file), { refusal: "the reviewer's app token could not be minted: no key", final: false });
  assert.deepEqual(doorCalls, [], "the door is not run without a token");
});

test("a door refusal is said with the door's own last line: a refusal a repost would repeat is final, and one for the token is not", async () => {
  await loadReviewerGate();
  const { tree, file } = verdictTree("reviewer-refused-", `${verdictLine(H1, "convinced")}\n\nbody\n`);
  for (const [status, reason, final] of [
    [5, "The head moved since you reviewed it: your verdict names a1a1a1a1.", true],
    [3, "#7 already has a review at an equal patch: APPROVED", true],
    [6, "the reviewer App token could not be minted: no key", false],
  ] as const) {
    const made = verdictPort(tree, { door: () => { throw Object.assign(new Error("door"), { status, stderr: `pr-review-verdict: NOT POSTED. ${reason}\n` }); } });
    assert.deepEqual(made.port.repostVerdict({ pr: PR_URL, head: H1 }, file), { refusal: reason, final }, `door exit ${status}`);
  }
});

test("a verdict file that names another head, or no verdict, is not posted", async () => {
  await loadReviewerGate();
  const { tree, file } = verdictTree("reviewer-wrong-", `${verdictLine(H2, "convinced")}\n\nbody\n`);
  const made = verdictPort(tree);
  assert.deepEqual(made.port.repostVerdict({ pr: PR_URL, head: H1 }, file), { refusal: `the verdict file ${file} does not open with a verdict for ${H1.slice(0, 8)}`, final: true });
  assert.deepEqual(made.order, [], "nothing is minted or posted");
});

test("settled reads the reviewer for its head: working while its agent works, ended once it is idle, and gone when herdr lists none for the head", async () => {
  await loadReviewerGate();
  const status = new Map([["reviewer-7", "working"]]);
  const made = verdictPort(tmpDir("reviewer-settled-"), { status });
  const ref = { pr: PR_URL, head: "h1" };
  assert.equal(made.port.settled(ref), "working");
  status.set("reviewer-7", "idle");
  assert.equal(made.port.settled(ref), "ended");
  status.set("reviewer-7", "unknown");
  assert.equal(made.port.settled(ref), "ended", "no agent in the pane: its process exited");
  status.delete("reviewer-7");
  assert.equal(made.port.settled(ref), "gone");
  assert.equal(made.port.settled({ pr: PR_URL, head: H2 }), "gone", "and for a head it was not started for");
});

test("reprompt sends the gate's verdict prompt to the seat's agent again, naming the head", async () => {
  await loadReviewerGate();
  const made = verdictPort(tmpDir("reviewer-prompt-"));
  assert.deepEqual(made.port.reprompt({ pr: PR_URL, head: "h1" }), { prompted: true });
  const prompt = made.herd.calls.find((args) => args.includes("prompt"))!;
  assert.deepEqual(prompt.slice(0, 5), ["--session", "tickets", "agent", "prompt", "reviewer-7"]);
  assert.ok(prompt[5].includes("`h1`"), "the prompt names the head it is for");
});

test("the re-posts a pool remembers are kept on disk, and a memory file from before them reads with none", () => {
  const path = join(tmpDir("reviewer-memory-"), "reviewers.json");
  const memory = { heads: new Map([["reviewer-7", "h1"]]), started: new Set([`${PR_URL}@h1`]), resumed: new Set<string>(),
    reposts: new Map([[`${PR_URL}@h1`, { attempts: 2, reason: "no key" }]]) };
  writeReviewerMemory(path, memory);
  assert.deepEqual(readReviewerMemory(path), { memory, unreadable: false });
  writeFileSync(path, JSON.stringify({ heads: {}, started: [], resumed: [] }));
  assert.deepEqual(readReviewerMemory(path), { memory: { heads: new Map(), started: new Set(), resumed: new Set(), reposts: new Map() }, unreadable: false });
  writeFileSync(path, JSON.stringify({ heads: {}, started: [], resumed: [], reposts: { k: { attempts: "two" } } }));
  assert.equal(readReviewerMemory(path).unreadable, true, "a malformed count is unreadable, never read as nothing remembered");
});

/** A repository this host clones and the project does not declare, under the primary's owner: the atomic reviewer takes its pull requests. */
const OWNER = REPO.split("/")[0];
const PLUGIN_URL = `https://github.com/${OWNER}/plugin/pull/7`;
const refusalOf = (answer: object | null): string => answer !== null && "refusal" in answer && typeof answer.refusal === "string" ? answer.refusal : "";

/** An atomic port whose only clone is `plugin`, recording each checkout and each spawn; herdr lists `listed`. */
function clonedPort(listed: Map<string, string>, clones: Record<string, string> = { plugin: "/repos/plugin" }) {
  const herd = herdr(listed);
  const checkouts: object[] = [];
  const spawned: { options: object; env: unknown; cwd: unknown }[] = [];
  const port = atomicReviewerPort({ session: "tickets", run: herd.run, gh: ghFor({ head: "h1" }).run, declared: DECLARED, clones,
    checkout: (args) => { checkouts.push(args); return { path: "/work/pr-7", head: "h1" }; },
    spawn: (order, _agents, options) => { spawned.push({ options, env: options.env, cwd: options.cwd }); return { label: order.session, workspace: "w7", profile: { kind: "codex", model: "m", effort: "e" } }; } });
  return { port, herd, checkouts, spawned };
}

test("the atomic reviewer starts a reviewer for a repository the host clones and the project does not declare, in its clone, naming its repository", async () => {
  await loadReviewerGate();
  const made = clonedPort(new Map());
  assert.deepEqual(made.port.start({ pr: PLUGIN_URL, head: "h1" }), { label: "reviewer-plugin-7" });
  assert.deepEqual(made.checkouts, [{ pr: 7, session: "reviewer-plugin-7", trust: INSIDE, repoRoot: "/repos/plugin" }], "the checkout is made in the clone");
  assert.deepEqual(made.spawned[0].env, { GH_REPO: `${OWNER}/plugin`, [HOST_CONFIG_ENV]: hostConfigPath() }, "the reviewer's door posts to the clone's repository");
  const prompt = made.herd.calls.find((args) => args.includes("prompt"))!;
  assert.equal(prompt[4], "reviewer-plugin-7", "the gate's prompt goes to the clone's seat");
});

test("a cloned-only reviewer is live for its head, is listed by its pull request, and is retired from its clone", async () => {
  await loadReviewerGate();
  const removed: object[] = [];
  const herd = herdr(new Map([["reviewer-plugin-7", "idle"], ["reviewer-foo-3", "idle"]]));
  const port = atomicReviewerPort({ session: "tickets", run: herd.run, gh: ghFor({ head: "h1" }).run, declared: DECLARED, clones: { plugin: "/repos/plugin" },
    heads: new Map([["reviewer-plugin-7", "h1"]]), exists: () => false,
    removeCheckout: (args) => { removed.push(args); return null; } });
  assert.equal(port.live({ pr: PLUGIN_URL, head: "h1" }), true, "live for the head it was started for");
  assert.deepEqual(port.listedPulls(), [PLUGIN_URL], "the sweep finds the clone's pull request, and no reviewer of a repository neither declared nor cloned");
  assert.deepEqual(port.retire(PLUGIN_URL), { retired: true, report: null });
  assert.deepEqual(removed, [{ pr: 7, session: "reviewer-plugin-7", key: "plugin", repoRoot: "/repos/plugin" }], "the checkout is removed from the clone under its own ref");
});

test("a verdict of a cloned-only reviewer is posted through the door with its repository in the environment", async () => {
  await loadReviewerGate();
  const { tree, file } = verdictTree("reviewer-clone-repost-", `${verdictLine(H1, "convinced")}\n\nbody\n`);
  const doorCalls: { args: string[]; env: Record<string, string> }[] = [];
  const port = atomicReviewerPort({ session: "tickets", run: herdr(new Map()).run, gh: ghFor({ head: "h1" }).run, declared: DECLARED, clones: { plugin: "/repos/plugin" },
    checkoutOf: () => tree, mint: () => null, door: (_path, args, env) => { doorCalls.push({ args, env }); } });
  assert.deepEqual(port.repostVerdict({ pr: PLUGIN_URL, head: H1 }, file), { posted: true });
  assert.deepEqual(doorCalls.map((call) => call.args), [["7", "convinced", file]]);
  assert.equal(doorCalls[0].env.GH_REPO, `${OWNER}/plugin`, "the door posts to the clone's pull request, not the primary's pull request of the same number");
});

test("a repository neither declared nor cloned, or cloned under another owner, is refused, and the refusal names the project's declaration and the host's clones", async () => {
  await loadReviewerGate();
  const made = clonedPort(new Map());
  for (const pr of [`https://github.com/someone-else/plugin/pull/7`, `https://github.com/${OWNER}/not-cloned/pull/7`]) {
    const refusal = refusalOf(made.port.start({ pr, head: "h1" }));
    assert.match(refusal, /project\.json/, `${pr} names the project's declaration`);
    assert.match(refusal, /host\.json/, `${pr} names the host's clones`);
  }
  assert.deepEqual(made.checkouts, [], "nothing is checked out for a refused repository");
});

test("a clone whose name cannot be a reviewer key is refused by name, and no checkout is made", async () => {
  await loadReviewerGate();
  const made = clonedPort(new Map(), { Foo: "/repos/Foo" });
  assert.match(refusalOf(made.port.start({ pr: `https://github.com/${OWNER}/Foo/pull/7`, head: "h1" })), /its name `Foo` cannot be a reviewer key/);
  assert.deepEqual(made.checkouts, []);
});

test("a declared repository whose name is also a clone keeps its declared key, with no clone as its checkout and nothing added to its environment", async () => {
  await loadReviewerGate();
  const declared = homeProjectDeclaration().code.find((code) => code.key !== "")!;
  const made = clonedPort(new Map(), { [declared.key]: "/repos/elsewhere" });
  assert.deepEqual(made.port.start({ pr: `https://github.com/${declared.repo}/pull/7`, head: "h1" }), { label: `reviewer-${declared.key}-7` });
  assert.equal("repoRoot" in made.checkouts[0], false, "the gate takes the declared clone, as it does now");
  assert.equal("env" in made.spawned[0].options, false, "the spawn is called with no environment of its own, as it was");
});

test("clonedSeatOf takes a clone only of the primary's owner, refuses a name that cannot be a key, and refuses a name a declared repository is keyed by", () => {
  const clones = { plugin: "/repos/plugin", ".github": "/repos/github", github: "/repos/github-clone" };
  const codes = [{ key: "", repo: `${OWNER}/${OWNER}` }, { key: "github", repo: `${OWNER}/.github` }];
  assert.deepEqual(clonedSeatOf(`${OWNER}/plugin`, { owner: OWNER, clones, codes }), { key: "plugin", clone: "/repos/plugin" });
  assert.equal(clonedSeatOf("someone-else/plugin", { owner: OWNER, clones, codes }), null, "another owner's repository is no clone of this org's");
  assert.equal(clonedSeatOf(`${OWNER}/not-cloned`, { owner: OWNER, clones, codes }), null, "a repository the host does not clone is no seat");
  assert.match(refusalOf(clonedSeatOf(`${OWNER}/.github`, { owner: OWNER, clones: { ".github": "/repos/github" }, codes: [] })), /its name `\.github` cannot be a reviewer key \(lowercase letters, digits and hyphens, not ending in a number\)/);
  assert.ok(refusalOf(clonedSeatOf(`${OWNER}/github`, { owner: OWNER, clones, codes })).includes(`declares \`github\` as the key of ${OWNER}/.github`), "the clone named as a declared key would take that key's seat");
});

test("A11-119: the reviewer's word on a head, and the newest word on an earlier one, read off its reviews only", () => {
  const review = (state: string, commit: string, at: number, author = REVIEWER_LOGIN) => ({ author, state, commit, at });
  const reviews = [review("CHANGES_REQUESTED", "68bd2e8d", 1), review("APPROVED", "68bd2e8d", 3, "a-person"), review("COMMENTED", "91bf0677", 4), review("DISMISSED", "91bf0677", 2)];
  assert.equal(reviewWordAt(reviews, "91bf0677"), "dismissed", "a comment is no verdict, the dismissal is the newest verdict on that head");
  assert.equal(reviewWordAt(reviews, "68bd2e8d"), "changes requested", "a person's approval is not the reviewer's");
  assert.equal(reviewWordAt(reviews, "abcdef12"), null);
  assert.deepEqual(earlierReviewWord(reviews, "91bf0677"), { head: "68bd2e8d", word: "changes requested" });
  assert.deepEqual(earlierReviewWord(reviews, "68bd2e8d"), { head: "91bf0677", word: "dismissed" }, "the newest on any other head");
  assert.equal(earlierReviewWord([review("CHANGES_REQUESTED", "68bd2e8d", 1)], "68bd2e8d"), null, "a head is never earlier than itself");
});

test("A11-119: a repository's open pull request urls are listed, and an unanswered or cut-short list is no reading", () => {
  const listed = (answer: () => string) => openPullUrlsOf("a11ign/control", (args) => { assert.deepEqual(args.slice(0, 5), ["pr", "list", "--repo", "a11ign/control", "--state"]); return answer(); });
  assert.deepEqual(listed(() => JSON.stringify([{ number: 119, body: "" }])), ["https://github.com/a11ign/control/pull/119"]);
  assert.deepEqual(listed(() => "[]"), [], "none open is a reading");
  assert.equal(listed(() => { throw new Error("gh exited 1"); }), null, "a refused gh is no reading");
  assert.equal(listed(() => "not json"), null);
  assert.equal(listed(() => JSON.stringify(Array.from({ length: 200 }, (_, i) => ({ number: i, body: "" })))), null, "a list at the limit may be cut short");
});
