// no-token: gh -- herdr, git and the clock are all injected; nothing is spawned
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "../lib/tmp-fixture.ts";
import { INSIDE } from "../review-trust.ts";
import { REPO } from "../project-identity.ts";
import { runActions, runStatus } from "./board-view.ts";
import { createPool, herdrName, ticketDir } from "./pool.ts";
import { REVIEWER_LOGIN, REVIEW_CAUSE, atomicReviewerPort, type ReviewerPort, type ReviewerRef } from "./reviewer-port.ts";
import { emptyQueue, enqueue, setPaused, type Queue } from "./queue.ts";
import { parseTicketSettings } from "./settings.ts";
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
    if (args.includes("list")) return JSON.stringify({ result: { workspaces: [...status].map(([label, s]) => ({ label, agent_status: s })) } });
    return JSON.stringify({ type: "ok" });
  };
  return { run, calls };
}

/** The pull request as GitHub answers it: `head` is its commit, `reviews` its reviews, `outside` whether its author is outside the org. */
function ghFor(pr: { head: string; reviews?: unknown[]; outside?: boolean }) {
  const calls: string[][] = [];
  const run = (args: string[]) => {
    calls.push(args);
    if (args[1] === "user") return "worker-bot\n";
    if (args[0] === "pr") return JSON.stringify({ headRefOid: pr.head, reviews: pr.reviews ?? [], author: { login: "worker-bot" }, isCrossRepository: pr.outside === true });
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
  };
  return { port, starts };
}

function setup(gh: (args: string[]) => string, port: ReviewerPort, tickets: Record<string, unknown> = { drafts: false, reviewer: "atomic" }) {
  const root = tmpDir("ticket-reviewer-");
  const settings = parseTicketSettings({ clones: { "nbl-ui-netbox": "/repos/nbl-ui-netbox" }, stateDir: join(root, "state"), tickets });
  let queue: Queue = setPaused(enqueue(emptyQueue(1), [ticket("NBF-1")], { model: "sonnet", effort: "high" }, 0, null), false);
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
  assert.deepEqual(runActions(made.entry("NBF-1")), [], "there is no Approve");
  made.pool.watchFeedback();
  assert.deepEqual(reviewer.starts, [{ pr: PR_URL, head: "h1" }], "the reviewer is started for the ready head");
  assert.deepEqual(runActions(made.entry("NBF-1")), [], "still no Approve once the reviewer is started");
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

test("the atomic reviewer refuses a pull request whose author is outside the org, and starts nothing", () => {
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

test("the atomic reviewer starts the gate's reviewer in the tickets' session for an org pull request, and is live for its head only", () => {
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
