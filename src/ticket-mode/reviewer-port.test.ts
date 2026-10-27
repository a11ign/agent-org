// no-token: none -- herdr, git and the clock are all injected; nothing is spawned
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "../lib/tmp-fixture.ts";
import { createFakeTracker } from "../plugins/fakes/tracker.ts";
import { createFakeCodeHost } from "../plugins/fakes/code-host.ts";
import { reviewerOver } from "../plugins/fakes/reviewer.ts";
import type { CodeHost } from "../plugins/contracts/code-host.ts";
import { INSIDE, type DoorRun } from "../review-trust.ts";
import { REPO } from "../project-identity.ts";
import { runActions, runStatus } from "./board-view/pull-status-and-notes.ts";
import { createPool, herdrName, ticketDir } from "./pool.ts";
import { REVIEWER_LOGIN, earlierReviewWord, gateReviewJudge, loadReviewerGate, readReviewerMemory, reviewWordAt, writeReviewerMemory, type ReviewerPort, type ReviewerRef } from "./reviewer-port.ts";
import { emptyQueue } from "./queue.ts";
import { enqueue, type Queue } from "./queue/queue-entries-and-outcomes.ts";
import { pauseQueue, resumeQueue } from "./queue/queue-transitions.ts";
import { parseTicketSettings } from "./settings.ts";
import { homeProjectDeclaration } from "../project-config.ts";
import { HOST_CONFIG_ENV, hostConfigPath } from "../host-config.ts";
import type { Ticket, TicketSource } from "./source.ts";

const PR_URL = `https://github.com/${REPO}/pull/7`;
const ticket = (key: string) => ({ key, title: key, description: "", url: `https://linear.app/x/${key}`, branch: key.toLowerCase(), status: "Backlog", statusOrder: 0, team: "NBF", project: null, priority: 0 }) as Ticket;
/** The tracker a pool is built over by default: the tracker contract's in-memory fake, holding no ticket (A11-159). */
const source: TicketSource = createFakeTracker();
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

/** A commit status as GitHub keeps it on a head: its id, its context, when it was written, and its description. */
type Status = { id: number; context: string; created_at: string; description: string };

/** The claim entries among a pull request's head statuses, in the order they were written. */
const claimEntriesOf = (pr: { statuses?: Status[] }) =>
  (pr.statuses ??= []).filter((status) => status.context === "agent-org/review").map((status) => ({ id: status.id, description: status.description, created: Date.parse(status.created_at) }));

/**
 * GitHub as the reviewer's tests see it: the pull request `pr` describes, held by the code host (the fake) for every read of a pull request, and its head's commit statuses, which its claim
 * operations read and write (a write adds one written now, so a claim written through one port is read back through another). `head` is its commit, `reviews` its reviews as GitHub lists them, `outside` whether its author is outside the org, `checks` its checks (green by default), `state` its
 * state (open by default), `statuses` its head's commit statuses. A test moves the pull request by changing `pr`: each read holds it as it is then.
 */
function ghFor(pr: { head: string; reviews?: unknown[]; outside?: boolean; checks?: unknown[]; state?: string; statuses?: Status[] }) {
  const host = createFakeCodeHost("worker-bot");
  type Reviewed = { author: { login: string }; state: string; commit: { oid: string }; submittedAt: string };
  const hold = (url: string): void => {
    const match = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/.exec(url);
    if (match === null) return;
    const checks = (pr.checks ?? GREEN) as { conclusion: string | null }[];
    host.seedPull(match[1], Number(match[2]), {
      head: pr.head, state: (pr.state ?? "OPEN").toLowerCase() as "open" | "merged" | "closed", trust: pr.outside === true ? "outside" : "inside", settled: checks.every(({ conclusion }) => conclusion === "SUCCESS"),
      reviews: ((pr.reviews ?? []) as Reviewed[]).map((r) => ({ author: r.author.login, state: r.state, commit: r.commit.oid, at: Date.parse(r.submittedAt) })),
    });
  };
  const codeHost: CodeHost = {
    ...host,
    readPullFeedback: (url, self, alsoIgnore) => { hold(url); return host.readPullFeedback(url, self, alsoIgnore); },
    readReviewState: (url) => { hold(url); return host.readReviewState(url); },
    readPullState: (url) => { hold(url); return host.readPullState(url); },
    readReviewClaims: () => ({ entries: claimEntriesOf(pr) }),
    writeReviewClaim: ({ description }) => {
      const statuses = pr.statuses ??= [];
      statuses.push({ id: statuses.length + 1, context: "agent-org/review", created_at: new Date().toISOString(), description });
      return null;
    },
  };
  return { pr, codeHost };
}

/** The code host a port is given, which also keeps its claims, so a claim written through one port is read back through another, and no test reaches GitHub. */
const claiming = (fake: ReturnType<typeof ghFor>) => ({ codeHost: fake.codeHost, mint: () => null });

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

function setup(github: ReturnType<typeof ghFor>, port: ReviewerPort, tickets: Record<string, unknown> = { drafts: false, reviewer: "atomic" }) {
  const root = tmpDir("ticket-reviewer-");
  const settings = parseTicketSettings({ clones: { "nbl-ui-netbox": "/repos/nbl-ui-netbox" }, stateDir: join(root, "state"), tickets });
  let queue: Queue = resumeQueue(enqueue(emptyQueue(1), [ticket("NBF-1")], { model: "sonnet", effort: "high" }, 0, null));
  const store = { get: () => queue, set: (next: Queue) => { queue = next; } };
  const status = new Map<string, string>();
  const h = herdr(status);
  const pool = createPool(store, { settings, source, codeHost: github.codeHost, hook: { node: "/node", bin: "/tool/src/bin.ts" }, herdr: h.run, hostFile: "/work/.agent-org/host.json", now: () => 100, load: () => ({ load: 1, cores: 14 }), transcriptsRoot: join(root, "transcripts"), wait: async () => {},
    pluginRecord: join(root, "no-plugin-record.json"), reviewer: reviewerOver(port) });
  const entry = (key: string) => queue.entries.find((e) => e.ticket.key === key)!;
  return { settings, pool, status, h, entry, root };
}

/** NBF-1 run to a ready pull request: its worker wrote a `ready-pr` outcome and ended, with its transcript where a round would resume it. */
async function readyPrRun(github: ReturnType<typeof ghFor>, port: ReviewerPort, tickets?: Record<string, unknown>) {
  await loadReviewerGate();
  const made = setup(github, port, tickets);
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
  const made = await readyPrRun(gh, reviewer.port);
  const dir = ticketDir(made.settings, "NBF-1");
  const brief = readFileSync(join(dir, "brief.md"), "utf8");
  assert.ok(brief.includes("open ONE READY pull request"), "the worker is told to open a ready pull request");
  assert.equal(brief.includes("gh pr create --draft"), false, "no draft is named");
  assert.ok(existsSync(join(dir, "ready-run")), "the hook lets the worker open one ready");
  assert.equal(runStatus(made.entry("NBF-1")), "awaiting-review", "the run waits for review");
  assert.deepEqual(runActions(made.entry("NBF-1")), ["respond", "talk", "dismiss"], "there is no Approve; Respond answers its feedback (A11-154)");
  await made.pool.watchFeedback();
  assert.deepEqual(reviewer.starts, [{ pr: PR_URL, head: "h1" }], "the reviewer is started for the ready head");
  assert.deepEqual(runActions(made.entry("NBF-1")), ["respond", "talk", "dismiss"], "still no Approve once the reviewer is started");
});

test("the reviewer is started once per ready head: a second watch on the same head starts nothing, and a new head starts one", async () => {
  const reviewer = fakePort();
  const gh = ghFor({ head: "h1" });
  const made = await readyPrRun(gh, reviewer.port);
  await made.pool.watchFeedback();
  await made.pool.watchFeedback();
  assert.deepEqual(reviewer.starts.map((ref) => ref.head), ["h1"], "the same head is not started again");
  gh.pr.head = "h2";
  await made.pool.watchFeedback();
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
    const made = await readyPrRun(gh, reviewer.port);
    made.h.calls.length = 0;
    await made.pool.watchFeedback();
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

test("the re-posts a pool remembers are kept on disk, and a memory file from before them reads with none", () => {
  const path = join(tmpDir("reviewer-memory-"), "reviewers.json");
  const memory = { heads: new Map([["reviewer-7", "h1"]]), started: new Set([`${PR_URL}@h1`]), resumed: new Set<string>(),
    reposts: new Map([[`${PR_URL}@h1`, { attempts: 2, reason: "no key" }]]), rereviewed: new Set([`${PR_URL}@h1`]), seen: new Map<string, number>(), unclaimed: new Map<string, string>(), looks: new Map<string, { at: number; body: string }>(), refusals: new Map<string, { reason: string; count: number }>() };
  writeReviewerMemory(path, memory);
  assert.deepEqual(readReviewerMemory(path), { memory, unreadable: false });
  writeFileSync(path, JSON.stringify({ heads: {}, started: [], resumed: [] }));
  assert.deepEqual(readReviewerMemory(path), { memory: { heads: new Map(), started: new Set(), resumed: new Set(), reposts: new Map(), rereviewed: new Set(), seen: new Map(), unclaimed: new Map(), looks: new Map(), refusals: new Map() }, unreadable: false });
  writeFileSync(path, JSON.stringify({ heads: {}, started: [], resumed: [], reposts: { k: { attempts: "two" } } }));
  assert.equal(readReviewerMemory(path).unreadable, true, "a malformed count is unreadable, never read as nothing remembered");
});

test("A11-156: the heads a reply earned a re-review of are kept on disk, a file from before them reads with none, and a malformed list is unreadable", () => {
  const path = join(tmpDir("reviewer-memory-"), "reviewers.json");
  const memory = { heads: new Map<string, string>(), started: new Set<string>(), resumed: new Set<string>(), reposts: new Map(), rereviewed: new Set([`${PR_URL}@h1`]), seen: new Map<string, number>(), unclaimed: new Map<string, string>(), looks: new Map<string, { at: number; body: string }>(), refusals: new Map<string, { reason: string; count: number }>() };
  writeReviewerMemory(path, memory);
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")).rereviewed, [`${PR_URL}@h1`], "written beside started and resumed");
  assert.deepEqual(readReviewerMemory(path), { memory, unreadable: false }, "and read back");
  writeReviewerMemory(path, { ...memory, rereviewed: new Set() });
  assert.equal("rereviewed" in JSON.parse(readFileSync(path, "utf8")), false, "a pool that re-reviewed nothing writes the file it always wrote");
  writeFileSync(path, JSON.stringify({ heads: {}, started: [], resumed: [] }));
  assert.deepEqual([...readReviewerMemory(path).memory.rereviewed], [], "a file without the key reads as an empty set");
  writeFileSync(path, JSON.stringify({ heads: {}, started: [], resumed: [], rereviewed: "h1" }));
  assert.equal(readReviewerMemory(path).unreadable, true, "a list that is not strings is unreadable, never read as nothing remembered");
});

test("A11-172: the instances seen and the starts made without a claim are kept on disk, written only when there are some, and a bad entry is left out without forgetting the started heads", () => {
  const path = join(tmpDir("reviewer-memory-"), "reviewers.json");
  const memory = { heads: new Map<string, string>(), started: new Set([`${PR_URL}@h1`]), resumed: new Set<string>(), reposts: new Map(), rereviewed: new Set<string>(),
    seen: new Map([["laptop", 1_800_000_000_000]]), unclaimed: new Map([[`${PR_URL}@h1`, "gh: Resource not accessible by integration (HTTP 403)"]]), looks: new Map<string, { at: number; body: string }>(), refusals: new Map<string, { reason: string; count: number }>() };
  writeReviewerMemory(path, memory);
  assert.deepEqual(readReviewerMemory(path), { memory, unreadable: false }, "written and read back");
  writeReviewerMemory(path, { ...memory, seen: new Map(), unclaimed: new Map(), looks: new Map() });
  const bare = JSON.parse(readFileSync(path, "utf8"));
  assert.equal("seen" in bare || "unclaimed" in bare, false, "a pool that saw no other instance and started every reviewer with its claim writes the file it always wrote");
  writeFileSync(path, JSON.stringify({ heads: {}, started: [`${PR_URL}@h1`], resumed: [], seen: { laptop: 5, tablet: "soon", phone: null }, unclaimed: { a: "why", b: 3 } }));
  const lenient = readReviewerMemory(path);
  assert.equal(lenient.unreadable, false, "a bad entry is not a reason to forget every started head, which is what keeps one from starting twice");
  assert.deepEqual([[...lenient.memory.started], [...lenient.memory.seen], [...lenient.memory.unclaimed]], [[`${PR_URL}@h1`], [["laptop", 5]], [["a", "why"]]]);
  writeFileSync(path, JSON.stringify({ heads: {}, started: [], resumed: [], seen: ["laptop"], unclaimed: "x" }));
  assert.deepEqual([...readReviewerMemory(path).memory.seen, ...readReviewerMemory(path).memory.unclaimed], [], "and a field that is not an object is left out whole");
});

test("A11-235: the look each head's newest start had is kept on disk, written only when there are some, a file from before it reads with none, and a bad look is left out without forgetting the started heads", () => {
  const path = join(tmpDir("reviewer-memory-"), "reviewers.json");
  const memory = { heads: new Map<string, string>(), started: new Set([`${PR_URL}@h1`]), resumed: new Set<string>(), reposts: new Map(), rereviewed: new Set<string>(), seen: new Map<string, number>(), unclaimed: new Map<string, string>(),
    looks: new Map([[`${PR_URL}@h1`, { at: 1_800_000_000_000, body: "## Region\n\nplugins/github" }]]), refusals: new Map<string, { reason: string; count: number }>() };
  writeReviewerMemory(path, memory);
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")).looks, { [`${PR_URL}@h1`]: { at: 1_800_000_000_000, body: "## Region\n\nplugins/github" } }, "written beside started");
  assert.deepEqual(readReviewerMemory(path), { memory, unreadable: false }, "and read back");
  writeReviewerMemory(path, { ...memory, looks: new Map() });
  assert.equal("looks" in JSON.parse(readFileSync(path, "utf8")), false, "a pool that started nothing writes the file it always wrote");
  writeFileSync(path, JSON.stringify({ heads: {}, started: [`${PR_URL}@h1`], resumed: [] }));
  assert.deepEqual([...readReviewerMemory(path).memory.looks], [], "a file from before looks reads as none");
  writeFileSync(path, JSON.stringify({ heads: {}, started: [`${PR_URL}@h1`], resumed: [], looks: { a: { at: 5, body: "b" }, b: { at: "soon", body: "b" }, c: { at: 6 }, d: null } }));
  const lenient = readReviewerMemory(path);
  assert.equal(lenient.unreadable, false, "a bad look is not a reason to forget every started head");
  assert.deepEqual([[...lenient.memory.started], [...lenient.memory.looks]], [[`${PR_URL}@h1`], [["a", { at: 5, body: "b" }]]]);
  writeFileSync(path, JSON.stringify({ heads: {}, started: [], resumed: [], looks: ["x"] }));
  assert.deepEqual([...readReviewerMemory(path).memory.looks], [], "and a field that is not an object is left out whole");
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

test("A11-160: the gate judges a pull request for the code host plugin: the fields the reviewer reads by, who is the org's own, and whether the checks settled, as the gate decides each", async () => {
  await loadReviewerGate();
  const judge = gateReviewJudge();
  assert.equal(judge.fields, "headRefOid,reviews,author,isCrossRepository,isDraft,statusCheckRollup,body", "the fields the gate's own reader asks for");
  assert.equal(judge.trustOf({ isCrossRepository: true, author: { login: "worker-bot" } }), "outside", "a fork is outside whoever its author is");
  assert.equal(judge.trustOf({ isCrossRepository: false, author: { login: "a-stranger-nobody-declared" } }), "outside", "an author the host does not declare is outside");
  assert.equal(judge.trustOf({ isCrossRepository: false, author: { login: "dependabot[bot]" } }), "inside", "a login the gate trusts by name is inside");
  assert.equal(judge.settledOf({ statusCheckRollup: GREEN }, null), true);
  assert.equal(judge.settledOf({ statusCheckRollup: [{ name: "gate", status: "IN_PROGRESS", conclusion: null }] }, null), false, "a pending check has not settled");
  assert.equal(judge.settledOf({ statusCheckRollup: [] }, null), false, "no check at all is not settled green");
});

test("A11-340: a cancelled run of a check is a duplicate while the check has another run, and decides nothing then; a check with only cancelled runs, or another run still going or red, is not settled", async () => {
  await loadReviewerGate();
  const judge = gateReviewJudge();
  const run = (name: string, conclusion: string | null, runId: number, minute: number) =>
    ({ name, status: conclusion === null ? "IN_PROGRESS" : "COMPLETED", conclusion, startedAt: `2026-10-27T02:${minute}:00Z`, completedAt: conclusion === null ? null : `2026-10-27T02:${minute}:30Z`, detailsUrl: `https://github.com/o/r/actions/runs/${runId}/job/1` });
  const settled = (...rollup: unknown[]) => judge.settledOf({ statusCheckRollup: rollup }, null);
  assert.equal(settled(run("gate", "SUCCESS", 200, 26), run("gate", "CANCELLED", 201, 27)), true, "a cancelled duplicate that is newer by run id and by time");
  assert.equal(settled(run("gate", "CANCELLED", 201, 27), run("gate", "SUCCESS", 200, 26)), true, "whatever the order the rollup lists them in");
  assert.equal(settled(run("gate", "SUCCESS", 200, 26), run("gate", "CANCELLED", 199, 27)), true, "and one from the superseded push");
  assert.equal(settled(run("gate", "CANCELLED", 201, 27)), false, "a check whose only run was cancelled has not passed");
  assert.equal(settled(run("gate", "CANCELLED", 199, 25), run("gate", null, 200, 26)), false, "the run that replaced the cancelled one is still going");
  assert.equal(settled(run("gate", "CANCELLED", 199, 25), run("gate", "FAILURE", 200, 26)), false, "or it failed");
  assert.equal(settled(run("gate", "SUCCESS", 200, 26), run("python", "CANCELLED", 201, 27)), false, "a cancelled run of one check is no pass for another");
  assert.equal(settled(run("gate", "CANCELLED", 201, 27), { context: "gate", state: "SUCCESS" }), false, "a commit status is known by its context, and is no other run of a check run's name");
  assert.equal(judge.settledOf({ statusCheckRollup: [run("gate", "SUCCESS", 200, 26), run("gate", "CANCELLED", 201, 27), run("python", "CANCELLED", 202, 27)] }, ["gate"]), true, "only the required checks count, with the duplicate set aside");
});
