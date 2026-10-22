// no-token: gh -- herdr, git, Linear and the clock are all injected; nothing is spawned
import type { PreflightExec } from "./preflight.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { execFileSync } from "node:child_process";
import { sandboxGitEnv } from "../lib/git-env.ts";
import { tmpDir } from "../lib/tmp-fixture.ts";
import { stopVerdict } from "./hook.ts";
import { isParked, rebaseNote, runStatus, terminalLink, waitNote } from "./board-view/pull-status-and-notes.ts";
import { checkNote, reasonOf } from "./board-view/run-reason.ts";
import { stackBaseFile, writeStackBase } from "./stack-rebase.ts";
import { worktreePath } from "./worktree.ts";
import { TICKET_ENV, main as worktreeMain } from "./worktree-command.ts";
import {
  batchDir, batchFolder, countTokens, createPool, feedbackSince, findFolderSession, findTranscript, herdrName, herdrServerCommand, isStartDialog, parseOutcome, publishDir, publishResult,
  ticketDir, ticketFolder, worktreesIn,
} from "./pool.ts";
import { approve, completableRuns, finish, markResumed, park, queuePublish, recordPullStates, recordStackBase, respond, pauseQueue, resumeQueue } from "./queue/queue-transitions.ts";
import { talk } from "./queue/talk.ts";
import { BACKGROUND_GONE_MS, enqueue, liveRunCount, retry, talkRound, writerStatus, type Outcome, type Queue } from "./queue/queue-entries-and-outcomes.ts";
// eslint-disable-next-line clean-code/no-duplication -- import list: the rule matches statement shape, and imports are not duplicated logic
import { emptyQueue, queueWriter, writerOf } from "./queue.ts";
import { writerDir, writerFolder } from "./ticket-paths.ts";
import { claimantOf, parseTicketSettings } from "./settings.ts";
import type { ReviewBrief } from "../plugins/contracts/reviewer.ts";
import { REVIEWER_LOGIN, loadReviewerGate, readReviewerMemory, reviewerMemoryPath, type RepostAnswer, type ReviewerPort, type ReviewerRef, type ReviewerSettled, writeReviewerMemory } from "./reviewer-port.ts";
import type { Blocker, PullState, Ticket, TicketSource } from "./source.ts";
// eslint-disable-next-line clean-code/no-duplication -- import list: the rule matches statement shape, and imports are not duplicated logic
import { descriptionHash, ticketReadOf } from "./ticket-read.ts";
import { parseStamp, stampedPlan } from "./plan-stamp.ts";
import { parsePaths } from "./overlap.ts";
import { learnsFrom, learnsLine } from "./board-view/ticket-change.ts";
import { createFakeTracker } from "../plugins/fakes/tracker.ts";
import type { CodeHost, PullFeedback } from "../plugins/contracts/code-host.ts";
import { createFakeCodeHost } from "../plugins/fakes/code-host.ts";
import { createFakePublisher } from "../plugins/fakes/publisher.ts";
import { createFakeReviewer, reviewerOver } from "../plugins/fakes/reviewer.ts";
import { corePolicy } from "../plugins/policy.ts";
import { CREATED_FILE, DECISIONS_FILE } from "./writer.ts";
import { STALE_OUTCOME_FILE, STOP_ACTIVE_FILE, WRITER_FILE } from "./worker-files.ts";

const ticket = (key: string) => ({ key, title: key, description: "", url: `https://linear.app/x/${key}`, branch: key.toLowerCase(), status: "Backlog", statusOrder: 0, team: "NBF", project: null, priority: 0 }) as Ticket;
/**
 * The tracker a pool is built over by default: the tracker contract's in-memory fake (A11-159), holding no ticket, with the operations the contract requires and its keywords. The fake's
 * optional reads (`blockers`, `projectSummaries`) are left out: with them a start goes on in the background after a test has ended and writes into the state folder the test removed, and
 * the tests that exercise those reads name them (`{ ...source, blockers }`).
 */
const fake = createFakeTracker();
const source: TicketSource = { assigned: fake.assigned, read: fake.read, download: fake.download, keywords: fake.keywords };

/** A herdr that opens workspaces and starts agents, and reports each label's status from `status`. A verb in `refused` fails as herdr does. */
function herdr(status: Map<string, string>, screen: { text: string } = { text: "" }) {
  const calls: string[][] = [];
  const refused = new Set<string>();
  /** What herdr says when it refuses a verb in `refused`, where that is not the default, `workspace_not_found`. */
  const reasons = new Map<string, string>();
  /** Workspaces herdr holds that no run of the queue does, such as the leftover of a talk session (A11-154): listed with their agent, and gone once closed by their id. */
  const extra: { workspace_id: string; label: string; name: string | null; session: string | null; status: string }[] = [];
  /** The error codes herdr refuses the next agent starts with, in order, as it refuses a pane whose shell is not at its prompt yet; after them starts go through. */
  const refusals: string[] = [];
  let next = 0;
  const run = (args: string[]) => {
    calls.push(args);
    if (args.includes("agent") && args.includes("start") && refusals.length > 0) {
      throw Object.assign(new Error("herdr exited 1"), { stderr: JSON.stringify({ error: { code: refusals.shift(), message: "agent target pane is not an available shell" } }) });
    }
    const refusing = args.find((arg) => refused.has(arg));
    if (refusing !== undefined) throw Object.assign(new Error("herdr exited 1"), { stdout: JSON.stringify({ error: { message: reasons.get(refusing) ?? "workspace_not_found" } }) });
    if (args.includes("read")) return screen.text;
    if (args.includes("create")) {
      next += 1;
      return JSON.stringify({ result: { root_pane: { pane_id: `w${next}:p1` }, workspace: { workspace_id: `w${next}` } } });
    }
    if (args.includes("agent") && args.includes("list")) {
      const own = [...status].map(([label, s]) => ({ name: null, workspace_id: `w${label.replace(/\D/g, "")}`, agent_session: { value: `session-${label}` }, agent_status: s }));
      return JSON.stringify({ result: { agents: [...own, ...extra.map((x) => ({ name: x.name, workspace_id: x.workspace_id, agent_session: x.session === null ? undefined : { value: x.session }, agent_status: x.status }))] } });
    }
    if (args.includes("workspace") && args.includes("close") && extra.some((x) => x.workspace_id === args[args.indexOf("close") + 1])) {
      extra.splice(extra.findIndex((x) => x.workspace_id === args[args.indexOf("close") + 1]), 1);
      return JSON.stringify({ type: "ok" });
    }
    if (args.includes("list")) return JSON.stringify({ result: { workspaces: [...[...status].map(([label, s]) => ({ label, agent_status: s })), ...extra.map((x) => ({ label: x.label, agent_status: x.status, workspace_id: x.workspace_id }))] } });
    return JSON.stringify({ type: "ok" });
  };
  return { run, calls, refused, reasons, refusals, extra };
}

/** `parents` gives a ticket its parent's key. A ticket without one is shaped as a run queued before tickets carried a parent. */
function setup(max = 2, keys = ["NBF-1", "NBF-2", "NBF-3"], tickets: Record<string, unknown> = {},
  { source: tracker = source, parents = {}, planFirst = [], batch = false, pluginRecord, gh, reviewerPort, preflight, now = () => 100, clones, wait }:
    { source?: TicketSource; parents?: Record<string, string>; planFirst?: string[]; batch?: boolean; pluginRecord?: string; gh?: World;
      reviewerPort?: ReviewerPort; preflight?: PreflightExec; now?: () => number; clones?: Record<string, string>; wait?: (ms: number) => Promise<void> } = {}) {
  const root = tmpDir("ticket-pool-");
  const settings = parseTicketSettings({ clones: clones ?? { "nbl-ui-netbox": "/repos/nbl-ui-netbox", "nbl-ui-platform-libs": "/repos/libs" }, stateDir: join(root, "state"), tickets });
  const queued = keys.map((key) => (key in parents ? { ...ticket(key), parent: parents[key] } : ticket(key)));
  const plan = planFirst.length === 0 ? null : { keys: new Set(planFirst), choice: { model: "opus", effort: "max" }, batch };
  let queue: Queue = resumeQueue(enqueue(emptyQueue(max), queued, { model: "sonnet", effort: "high" }, 0, plan));
  const store = { get: () => queue, set: (next: Queue) => { queue = next; } };
  const status = new Map<string, string>();
  const screen = { text: "" };
  const h = herdr(status, screen);
  const deps = { settings, source: tracker, hook: { node: "/node", bin: "/tool/src/bin.ts" }, herdr: h.run, hostFile: "/work/.agent-org/host.json", now, load: () => ({ load: 1, cores: 14 }), transcriptsRoot: join(root, "transcripts"), wait: async () => {},
    pluginRecord: pluginRecord ?? join(root, "no-plugin-record.json"), codeHost: gh?.codeHost ?? createFakeCodeHost(), ...(gh ? { gh: gh.run } : {}), ...(reviewerPort ? { reviewer: reviewerOver(reviewerPort) } : {}),
    // The publisher plugin, as the fake: what the host file names as its connectors, model and effort (A11-161).
    ...(settings.publish === null ? {} : { publisher: createFakePublisher(settings.publish.connectors, { model: settings.publish.model, effort: settings.publish.effort }) }), ...(preflight ? { preflight } : {}), ...(wait ? { wait } : {}) };
  const pool = createPool(store, deps);
  const entry = (key: string) => queue.entries.find((e) => e.ticket.key === key)!;
  /** A pool started over the same queue and state directory, as the board's pool is after a restart. */
  const restart = () => createPool(store, deps);
  return { settings, pool, restart, status, h, entry, store, root, screen };
}

/** A pool over `queue` whose herdr takes the person's Stop for `key` while a start is in flight, so the Stop lands during the start. */
function stopDuringStart(queue: Queue, key: string, deps: Omit<Parameters<typeof createPool>[1], "herdr" | "herdrAsync">) {
  let current = queue;
  const store = { get: () => current, set: (next: Queue) => { current = next; } };
  const h = herdr(new Map());
  let pool: ReturnType<typeof createPool>;
  const herdrAsync = async (args: string[]) => { pool.stop(key); return h.run(args); };
  pool = createPool(store, { ...deps, herdr: h.run, herdrAsync });
  return { pool, store, h };
}

/** `setup` on NBF-1 alone, then one tick: the run is started, and `dir` is its ticket folder. */
async function startedRun(tickets: Record<string, unknown> = {}, options: NonNullable<Parameters<typeof setup>[3]> = {}) {
  const made = setup(1, ["NBF-1"], tickets, options);
  await made.pool.tick();
  return { ...made, dir: ticketDir(made.settings, "NBF-1") };
}

/** The agent under `name` goes to `state`, and the pool's next tick reads it. */
async function agentIs(run: Pick<ReturnType<typeof setup>, "pool" | "status">, name: string, state: string) {
  run.status.set(name, state);
  await run.pool.tick();
}

/** The run's worker writes `outcome` in `dir`, goes idle under `name`, and the pool's next tick reads it. */
async function endWith(run: Pick<ReturnType<typeof setup>, "pool" | "status">, dir: string, name: string, outcome: Record<string, unknown>) {
  writeFileSync(join(dir, "outcome.json"), JSON.stringify(outcome));
  await agentIs(run, name, "idle");
}

test("a tick starts as many as `max` allows, each in ticket mode's own herdr session, prompt first and the tool list last", async () => {
  const { pool, h, entry, settings } = setup(2);
  await pool.tick();
  assert.deepEqual(["NBF-1", "NBF-2", "NBF-3"].map((k) => entry(k).phase), ["running", "running", "queued"]);
  assert.ok(h.calls.every((args) => args[0] === "--session" && args[1] === "tickets"), "never the org's session");
  assert.ok(h.calls.some((args) => args.includes("start") && args.includes("t-nbf-1")), "herdr's agent name is the key in lower case, which herdr requires");
  const start = h.calls.find((args) => args.includes("start"))!;
  const tail = start.slice(start.indexOf("--") + 1);
  assert.equal(tail[0], `Read ${ticketDir(settings, "NBF-1")}/brief.md and follow it.`);
  assert.deepEqual(tail.slice(-2), ["--disallowedTools", "AskUserQuestion"]);
  assert.ok(tail.includes("--dangerously-skip-permissions") && tail.includes("sonnet"));
  const folder = ticketFolder(settings, "NBF-1");
  const written = JSON.parse(readFileSync(join(folder, ".claude", "settings.local.json"), "utf8"));
  assert.equal(written.permissions.defaultMode, "bypassPermissions", "the settings sit in the ticket's folder, where the worker starts");
  assert.deepEqual(worktreesIn(folder), [], "no worktree is made for it: the worker chooses the repository");
  assert.ok(existsSync(join(ticketDir(settings, "NBF-1"), "brief.md")));
  const create = h.calls.find((args) => args.includes("create"))!;
  assert.ok(create.includes("--cwd") && create.includes(folder), "the worker starts in the ticket's folder");
  for (const pair of ["AGENT_ORG_TICKET=NBF-1", "AGENT_ORG_TICKET_BRANCH=nbf-1", "AGENT_ORG_TICKET_HOST=/work/.agent-org/host.json"]) {
    assert.ok(create.includes(pair), `its shell carries ${pair}, which ticket:worktree reads`);
  }
});

test("each run's brief carries the machine's notes, and its ticket dir a copy of the machine's refusals", async () => {
  const notes = join(tmpDir("ticket-notes-"), "notes.md");
  writeFileSync(notes, "Start apps with `npm run dev:atomic`.\n");
  const deny = [{ pattern: "\\bnpm\\s+run\\s+dev\\b(?!:atomic)", reason: "a fixed port collides with other workers" }];
  const { pool, settings } = setup(1, ["NBF-1"], { brief: notes, deny });
  await pool.tick();
  const dir = ticketDir(settings, "NBF-1");
  assert.match(readFileSync(join(dir, "brief.md"), "utf8"), /## On this machine\n\nStart apps with `npm run dev:atomic`\./);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "deny.json"), "utf8")), deny);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "connectors.json"), "utf8")), [], "a machine that names no connectors allows none");
  // A11-84: the host's own programs are named beside the outcome file, where the hook refuses a worker's write to them.
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "protected-paths.json"), "utf8")), [join(settings.binDir, "gh"), join(settings.binDir, "agent-org")]);
});

test("a run's brief names the connectors the machine allows, and its ticket dir holds the copy the hook reads", async () => {
  const connectors = ["^mcp__claude_ai_Linear__(get|list|search|extract)_"];
  const { dir } = await startedRun({ connectors });
  assert.match(readFileSync(join(dir, "brief.md"), "utf8"), /## Connectors\n\nThis machine lets you call/);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "connectors.json"), "utf8")), connectors);
});

test("a ticket's parent joins its brief, quoted, with the parent's files in a folder of their own", async () => {
  const reads: string[] = [];
  const downloads: string[] = [];
  const tracker: TicketSource = {
    ...source,
    read: async (key) => {
      reads.push(key);
      return key === "NBF-100" ? { ...ticket(key), description: "Every app moves to error." } : null;
    },
    download: async (t, dir) => {
      downloads.push(`${t.key} ${dir}`);
      return [join(dir, `attachment-1-${t.key}-0001-plan.md`)];
    },
  };
  const { pool, settings } = setup(3, ["NBF-1", "NBF-2", "NBF-3"], {}, { source: tracker, parents: { "NBF-1": "NBF-100", "NBF-2": "NBF-404" } });
  await pool.tick();
  const dir = ticketDir(settings, "NBF-1");
  const brief = readFileSync(join(dir, "brief.md"), "utf8");
  assert.match(brief, /## The parent ticket\n\nNBF-100: NBF-100\n/);
  assert.match(brief, /\n> Every app moves to error\.\n/);
  assert.ok(brief.includes(join(dir, "parent", "attachment-1-NBF-100-0001-plan.md")), "the parent's plan is named in the brief");
  assert.ok(brief.includes(join(dir, "attachment-1-NBF-1-0001-plan.md")), "and so is the ticket's own");
  assert.ok(downloads.includes(`NBF-100 ${join(dir, "parent")}`), "the parent's files land beside the ticket's, not over them");
  assert.equal(readFileSync(join(ticketDir(settings, "NBF-2"), "brief.md"), "utf8").includes("## The parent ticket"), false, "a parent the tracker has no ticket for adds nothing");
  assert.ok(reads.includes("NBF-404"), "a parent the tracker has no ticket for is still asked for");
  assert.ok(reads.every((key) => typeof key === "string"), "a run queued before tickets carried a parent asks for none");
});

test("a run is briefed from its ticket as the tracker has it now, on the branch it was queued with", async () => {
  const tracker: TicketSource = {
    ...source,
    read: async (key) => (key === "NBF-1" ? { ...ticket(key), title: "Edited title", description: "Edited after it was queued.", branch: "nbf-1-edited-title" } : null),
  };
  const { pool, settings, h } = setup(2, ["NBF-1", "NBF-2"], {}, { source: tracker });
  await pool.tick();
  const brief = readFileSync(join(ticketDir(settings, "NBF-1"), "brief.md"), "utf8");
  assert.match(brief, /^# NBF-1: Edited title\n/);
  assert.ok(brief.includes("Edited after it was queued."));
  assert.ok(brief.includes("`nbf-1`") && !brief.includes("nbf-1-edited-title"), "Linear renames the branch with the title; a retry's worktree is on the queued one");
  assert.ok(h.calls.find((args) => args.includes("create") && args.includes("AGENT_ORG_TICKET=NBF-1"))!.includes("AGENT_ORG_TICKET_BRANCH=nbf-1"));
  assert.match(readFileSync(join(ticketDir(settings, "NBF-2"), "brief.md"), "utf8"), /^# NBF-2: NBF-2\n/, "a ticket the tracker no longer has is briefed as queued");
});

test("the machine's plugins are enabled in each worker's settings file", async () => {
  const { pool, settings } = setup(1, ["NBF-1"], { plugins: ["nbl-ui@applied-ai"] });
  await pool.tick();
  const written = JSON.parse(readFileSync(join(ticketFolder(settings, "NBF-1"), ".claude", "settings.local.json"), "utf8"));
  assert.deepEqual(written.enabledPlugins, { "nbl-ui@applied-ai": true });
});

test("a notes file that cannot be read fails the run, naming the setting", async () => {
  const { pool, entry } = setup(1, ["NBF-1"], { brief: "/nowhere/notes.md" });
  await pool.tick();
  const outcome = entry("NBF-1").outcome;
  assert.equal(outcome?.kind, "crashed");
  assert.match(outcome?.kind === "crashed" ? outcome.reason : "", /tickets\.brief names \/nowhere\/notes\.md/);
});

test("a run ends on its outcome file once the agent is idle; idle before it ever worked is not an end", async () => {
  const { pool, status, entry, settings, root } = setup(1, ["NBF-1"]);
  await pool.tick();
  status.set(herdrName("NBF-1"), "idle");
  await pool.tick();
  assert.equal(entry("NBF-1").phase, "running", "idle with no outcome and never seen working: the prompt may not be taken yet");
  writeFileSync(join(ticketDir(settings, "NBF-1"), "outcome.json"), JSON.stringify({ kind: "draft-pr", prs: [{ repo: "nbl-ui-netbox", url: "https://github.com/x/pull/1" }] }));
  // The session's transcript, filed under a project that is not the worktree's, found by the id herdr reports for the run's workspace.
  mkdirSync(join(root, "transcripts", "-Users-me-work"), { recursive: true });
  writeFileSync(join(root, "transcripts", "-Users-me-work", "session-t-nbf-1.jsonl"), JSON.stringify({ message: { usage: { input_tokens: 3, output_tokens: 4 } } }));
  await pool.tick();
  assert.deepEqual(entry("NBF-1").tokens, { input: 3, output: 4 });
  assert.deepEqual(entry("NBF-1").outcome, { kind: "draft-pr", prs: [{ repo: "nbl-ui-netbox", url: "https://github.com/x/pull/1" }] });
  assert.deepEqual([entry("NBF-1").workspace, entry("NBF-1").pane], [undefined, undefined], "its workspace was closed");
  assert.equal(entry("NBF-1").session, "session-t-nbf-1", "the session it ran in is kept, for a review run to resume");
});

const approvedPr = { repo: "nbl-ui-netbox", url: "https://github.com/x/nbl-ui-netbox/pull/1" };

/** The repository the sweep tests open pull requests in: the org's own, a clone of this host (`clones` names it under the primary's owner). */
const SWEPT_REPO = "a11ign/nbl-ui-netbox";
const sweptPr = `https://github.com/${SWEPT_REPO}/pull/1`;
const SWEPT_REPO_PULL_2 = `https://github.com/${SWEPT_REPO}/pull/2`;
const SWEPT_REPO_PULL_3 = `https://github.com/${SWEPT_REPO}/pull/3`;

/** A pool whose one run, NBF-1, ended with a draft pull request in a session herdr called `session-t-nbf-1`, then was approved. */
async function approvedRun(tickets: Record<string, unknown> = {},
  { transcript = true, gh, reviewerPort, tracker }: { transcript?: boolean; gh?: World; reviewerPort?: ReviewerPort; tracker?: TicketSource } = {}) {
  const ctx = setup(1, ["NBF-1"], tickets, { gh, reviewerPort, source: tracker });
  const { pool, status, settings, root, store } = ctx;
  await pool.tick();
  status.set(herdrName("NBF-1"), "idle");
  writeFileSync(join(ticketDir(settings, "NBF-1"), "outcome.json"), JSON.stringify({ kind: "draft-pr", prs: [approvedPr] }));
  if (transcript) {
    mkdirSync(join(root, "transcripts", "-Users-me-work"), { recursive: true });
    writeFileSync(join(root, "transcripts", "-Users-me-work", "session-t-nbf-1.jsonl"), "{}\n");
  }
  await pool.tick();
  status.delete(herdrName("NBF-1"));
  store.set(approve(store.get(), "NBF-1", 200));
  ctx.h.calls.length = 0;
  await pool.tick();
  const start = ctx.h.calls.find((args) => args.includes("start"))!;
  return { ...ctx, tail: start.slice(start.indexOf("--") + 1), dir: ticketDir(settings, "NBF-1") };
}

test("an approved run starts a review run that resumes the worker's own session, told it was approved, with the machine's review notes", async () => {
  const notes = join(tmpDir("ticket-review-notes-"), "review.md");
  writeFileSync(notes, "Wait for the github-actions[bot] comment that starts \"Claude finished\".\n");
  const { tail, dir, entry } = await approvedRun({ review: notes });
  assert.equal(entry("NBF-1").phase, "running");
  assert.equal(tail[0], `A person reviewed this ticket's pull requests and approved them. Read ${dir}/brief.md and follow it.`);
  assert.deepEqual(tail.slice(tail.indexOf("--resume"), tail.indexOf("--resume") + 2), ["--resume", "session-t-nbf-1"]);
  const brief = readFileSync(join(dir, "brief.md"), "utf8");
  assert.match(brief, /review round for NBF-1/);
  assert.match(brief, /You wrote these pull requests earlier in this conversation\./);
  assert.ok(brief.includes(approvedPr.url));
  assert.match(brief, /## How this machine reviews\n\nWait for the github-actions\[bot\] comment/);
  assert.ok(existsSync(join(dir, "review-run")), "the hook's mark that this run may mark its pull requests ready");
});

test("A11-86: with tickets.prReview named, a worker's and a review run's folder carry the skill for the gate, and a run without it carries none", async () => {
  const skill = "a11ign:clean-code-review";
  const { pool, settings } = setup(1, ["NBF-1"], { prReview: skill });
  await pool.tick();
  const dir = ticketDir(settings, "NBF-1");
  assert.equal(readFileSync(join(dir, "pr-review.json"), "utf8"), `"${skill}"\n`, "the gate's copy of the setting");
  assert.match(readFileSync(join(dir, "brief.md"), "utf8"), /call the Skill tool with `a11ign:clean-code-review`/);
  const plain = await approvedRun({});
  assert.equal(existsSync(join(plain.dir, "pr-review.json")), false, "POSITIVE CONTROL: with no setting, no copy");
  const named = await approvedRun({ prReview: skill });
  assert.equal(readFileSync(join(named.dir, "pr-review.json"), "utf8"), `"${skill}"\n`, "a review run is gated too, since it pushes its fixes");
});

test("A11-86: a planning run pushes nothing, so it is given no copy of the setting even when one is named", async () => {
  const { pool, settings } = setup(1, ["NBF-1"], { ...PLANNER, prReview: "a11ign:clean-code-review" }, { source: planTracker().tracker, planFirst: ["NBF-1"] });
  await pool.tick();
  assert.equal(existsSync(join(ticketDir(settings, "NBF-1"), "pr-review.json")), false);
});

test("A11-86: a run starts with its earlier pre-PR review log cleared, since a new session has not reviewed what it commits", async () => {
  const { pool, status, store, settings } = setup(1, ["NBF-1"], { prReview: "a11ign:clean-code-review" });
  await pool.tick();
  const dir = ticketDir(settings, "NBF-1");
  writeFileSync(join(dir, "pr-review-log"), "review\n");
  status.set(herdrName("NBF-1"), "idle");
  store.set(retry(finish(store.get(), "NBF-1", { kind: "crashed", reason: "x" }, 300), "NBF-1", 301));
  status.delete(herdrName("NBF-1"));
  await pool.tick();
  assert.equal(existsSync(join(dir, "pr-review-log")), false, "the next run's log starts empty");
  assert.ok(existsSync(join(dir, "pr-review.json")), "and the setting is still given to it");
});

test("a review run whose worker's session is gone starts a fresh worker, told to read the pull requests first", async () => {
  const { tail, dir } = await approvedRun({}, { transcript: false });
  assert.equal(tail.includes("--resume"), false);
  assert.match(readFileSync(join(dir, "brief.md"), "utf8"), /Another worker wrote these pull requests/);
});

test("a review run ends Ready to merge with the pull requests the person approved, and the next run of the ticket loses the review mark", async () => {
  const { pool, status, entry, dir, store } = await approvedRun();
  status.set(herdrName("NBF-1"), "idle");
  writeFileSync(join(dir, "outcome.json"), JSON.stringify({ kind: "reviewed" }));
  await pool.tick();
  assert.deepEqual(entry("NBF-1").outcome, { kind: "reviewed", prs: [approvedPr] });
  assert.equal(runStatus(entry("NBF-1")), "ready-to-merge");
  store.set(retry(finish(store.get(), "NBF-1", { kind: "crashed", reason: "x" }, 300), "NBF-1", 301));
  status.delete(herdrName("NBF-1"));
  const plain = { ...entry("NBF-1"), review: undefined };
  store.set({ ...store.get(), entries: [plain] });
  await pool.tick();
  assert.equal(existsSync(join(dir, "review-run")), false, "a run that is not a review run may not mark pull requests ready");
});

test("a reviewed outcome from a run that was not a review run hands the run back", async () => {
  const { pool, status, entry, settings } = setup(1, ["NBF-1"]);
  await pool.tick();
  status.set(herdrName("NBF-1"), "idle");
  writeFileSync(join(ticketDir(settings, "NBF-1"), "outcome.json"), JSON.stringify({ kind: "reviewed" }));
  await pool.tick();
  assert.equal(entry("NBF-1").outcome?.kind, "needs-human");
});

test("a ticket folder's newest session is found in that folder's own project, by the folder its transcript records", () => {
  const root = tmpDir("ticket-sessions-");
  const folder = "/Users/me/work/.tickets/NBF-1";
  const own = "-Users-me-work--tickets-NBF-1";
  const write = (project: string, id: string, cwd: string, at: number) => {
    mkdirSync(join(root, project), { recursive: true });
    const file = join(root, project, `${id}.jsonl`);
    writeFileSync(file, `${JSON.stringify({ type: "summary" })}\n${JSON.stringify({ cwd, message: {} })}\n`);
    utimesSync(file, at, at);
  };
  write(own, "old", folder, 1_000);
  write(own, "new", folder, 2_000);
  write(own, "moved-in", "/Users/me/work/.tickets/NBF-1/app", 3_000);
  write("-Users-me-work", "from-above", folder, 4_000);
  assert.equal(findFolderSession(root, folder), "new");
  assert.equal(findFolderSession(root, "/Users/me/work/.tickets/NBF-9"), null);
});

test("working then idle with no outcome is `no-outcome`; a workspace gone from two listings is `crashed`", async () => {
  const { pool, status, entry } = setup(2, ["NBF-1", "NBF-2"]);
  await pool.tick();
  status.set(herdrName("NBF-1"), "working");
  status.set(herdrName("NBF-2"), "working");
  await pool.tick();
  status.set(herdrName("NBF-1"), "idle");
  status.delete(herdrName("NBF-2"));
  await pool.tick();
  assert.deepEqual(entry("NBF-1").outcome, { kind: "no-outcome" });
  assert.equal(entry("NBF-2").phase, "running", "one missing listing is not enough");
  await pool.tick();
  assert.equal(entry("NBF-2").outcome?.kind, "crashed");
});

test("the repositories a worker has made worktrees in are recorded on its entry as it makes them", async () => {
  const { pool, status, entry, settings } = setup(1, ["NBF-1"]);
  await pool.tick();
  status.set(herdrName("NBF-1"), "working");
  const folder = ticketFolder(settings, "NBF-1");
  mkdirSync(join(folder, "nbl-ui-netbox"), { recursive: true });
  writeFileSync(join(folder, "nbl-ui-netbox", ".git"), "gitdir: /repos/nbl-ui-netbox/.git/worktrees/x\n");
  mkdirSync(join(folder, "notes"), { recursive: true });
  await pool.tick();
  assert.deepEqual(entry("NBF-1").repos, ["nbl-ui-netbox"], "a directory that holds no worktree is not a repository");
});

test("an agent waiting on a person is shown as waiting and keeps running", async () => {
  const { pool, status, entry } = setup(1, ["NBF-1"]);
  await pool.tick();
  status.set(herdrName("NBF-1"), "blocked");
  await pool.tick();
  assert.deepEqual([entry("NBF-1").phase, entry("NBF-1").waiting], ["running", true]);
});

test("stop closes a live run's workspace and records it", async () => {
  const { pool, entry, h } = setup(1, ["NBF-1"]);
  await pool.tick();
  pool.stop("NBF-1");
  assert.deepEqual(entry("NBF-1").outcome, { kind: "stopped" });
  assert.ok(h.calls.some((args) => args.includes("close")));
});

test("after a restart, a run herdr no longer lists is `crashed`, and one it lists carries on", async () => {
  const { pool, status, entry } = setup(2, ["NBF-1", "NBF-2"]);
  await pool.tick();
  status.set(herdrName("NBF-1"), "working");
  pool.reconcile();
  assert.equal(entry("NBF-1").phase, "running");
  assert.equal(entry("NBF-2").outcome?.kind, "crashed");
});

test("an outcome file that cannot be read is `needs-human`, saying so", () => {
  assert.deepEqual(parseOutcome("{\"kind\":\"wrong-repo\",\"where\":\"netbox_physical_geometry\"}"), { kind: "wrong-repo", where: "netbox_physical_geometry" });
  assert.equal(parseOutcome("nonsense").kind, "needs-human");
  assert.equal(parseOutcome("{\"kind\":\"merged\"}").kind, "needs-human");
});

test("tokens are read from the session's own transcript, found by its id in whichever project Claude Code filed it", () => {
  const root = tmpDir("ticket-tokens-");
  mkdirSync(join(root, "-Users-me-work"), { recursive: true });
  const file = join(root, "-Users-me-work", "u-123.jsonl");
  writeFileSync(file, [
    JSON.stringify({ message: { usage: { input_tokens: 10, cache_read_input_tokens: 100, cache_creation_input_tokens: 5, output_tokens: 7 } } }),
    JSON.stringify({ type: "user", message: { content: "no usage here" } }),
    "{\"message\":{\"usage\":", // a live transcript's partial last line
  ].join("\n"));
  assert.equal(findTranscript(root, "u-123"), file);
  assert.equal(findTranscript(root, "u-404"), null);
  assert.deepEqual(countTokens(file), { input: 115, output: 7 });
  assert.deepEqual(countTokens(null), { input: 0, output: 0 });
});

test("a session whose herdr server does not answer is started once, and waited for", async () => {
  const root = tmpDir("ticket-session-");
  const settings = parseTicketSettings({ clones: { a: "/r/a" }, stateDir: root });
  let up = false;
  const started: string[] = [];
  const run = (args: string[]) => {
    if (!up) throw new Error("server_not_running");
    return JSON.stringify({ result: { workspaces: [] } });
  };
  let queue = emptyQueue(1);
  const pool = createPool({ get: () => queue, set: (q) => { queue = q; } }, {
    settings, source, codeHost: createFakeCodeHost(), hook: { node: "n", bin: "b" }, herdr: run, wait: async () => { up = true; }, startServer: (s) => started.push(s),
  });
  await pool.ensureSession();
  await pool.ensureSession();
  assert.deepEqual(started, ["tickets"], "started in ticket mode's own session, and only when it did not answer");
});

// A11-169: the instance no longer spawns the server in a scope of its own: herdr has a service, and a machine without one spawns the server directly.
test("the session's herdr server is spawned directly, with no systemd-run: the unit is how a machine that runs services starts it", () => {
  assert.deepEqual(herdrServerCommand("tickets"), { file: "herdr", args: ["--session", "tickets", "server"] });
  assert.deepEqual(herdrServerCommand("a b/c"), { file: "herdr", args: ["--session", "a b/c", "server"] });
});

test("an instance that starts up sends a live worker's pane nothing: no key, no prompt and no second start, whatever its pane shows", async () => {
  const { pool, status, h, entry, settings, screen, restart } = setup(1, ["NBF-1"]);
  await pool.tick();
  status.set(herdrName("NBF-1"), "working");
  await pool.tick();
  // Mid-turn, the worker waits on a prompt, and its pane quotes the trust dialog for its own folder: the worst a restarted pool could misread.
  status.set(herdrName("NBF-1"), "blocked");
  screen.text = TRUST(ticketFolder(settings, "NBF-1"));
  h.calls.length = 0;
  const next = restart();
  await next.ensureSession();
  next.reconcile();
  for (let i = 0; i < 3; i += 1) await next.tick();
  const touched = h.calls.filter((args) => ["send-keys", "prompt", "start", "create", "close"].some((verb) => args.includes(verb)));
  assert.deepEqual(touched, [], "only listings and reads reach herdr");
  assert.deepEqual([entry("NBF-1").phase, entry("NBF-1").workspace, entry("NBF-1").waiting], ["running", "w1", true], "adopted, and shown waiting on the person");
  status.set(herdrName("NBF-1"), "idle");
  writeFileSync(join(ticketDir(settings, "NBF-1"), "outcome.json"), JSON.stringify({ kind: "draft-pr", prs: [approvedPr] }));
  await next.tick();
  assert.equal(entry("NBF-1").outcome?.kind, "draft-pr", "the restarted pool carries on watching it, and records how it ends");
});

test("a ticket's herdr name is lower case, starts with a letter and fits herdr's 32 characters", () => {
  assert.equal(herdrName("NBF-1270"), "t-nbf-1270");
  assert.equal(herdrName("VE-9"), "t-ve-9");
  assert.ok(herdrName("ABCDEFGHIJKLMNOPQRSTUVWXYZ-123456789").length <= 32);
  assert.match(herdrName("X.Y 1"), /^[a-z][a-z0-9_-]*$/);
});

const TRUST = (path: string) => [
  " Accessing workspace:", "", ` ${path.slice(0, 40)}`, ` ${path.slice(40)}`, "",
  " Quick safety check: Is this a project you created or one you trust? (Like your own code, a",
  " ❯ No, exit", "   Yes, I trust this folder",
].join("\n");

test("the two start dialogs are recognised for the pool's own worktree, a wrapped path included, and nothing else is", () => {
  const worktree = "/Users/me/Documents/repos/work/.tickets/NBF-1";
  assert.equal(isStartDialog(TRUST(worktree), worktree), true);
  assert.equal(isStartDialog(TRUST("/somewhere/else/entirely/that/is/not/ours/at/all"), worktree), false, "a trust dialog for another folder is the person's");
  assert.equal(isStartDialog("  Allow external CLAUDE.md file imports?\n  /Users/me/Documents/repos/work/AGENTS.md", worktree), true);
  assert.equal(isStartDialog("Do you want to proceed?\n ❯ 1. Yes", worktree), false, "a permission prompt is not answered");
});

test("a run showing a start dialog for its worktree is answered with down-enter rather than marked waiting, a bounded number of times", async () => {
  const { pool, status, entry, settings, h, screen } = setup(1, ["NBF-1"]);
  await pool.tick();
  status.set(herdrName("NBF-1"), "blocked");
  screen.text = TRUST(ticketFolder(settings, "NBF-1"));
  await pool.tick();
  const answers = () => h.calls.filter((args) => args.includes("send-keys"));
  assert.deepEqual(answers()[0], ["--session", "tickets", "agent", "send-keys", "t-nbf-1", "down", "enter"]);
  assert.notEqual(entry("NBF-1").waiting, true, "an answered dialog is not a person's to clear");
  for (let i = 0; i < 6; i += 1) await pool.tick();
  assert.equal(answers().length, 4, "a dialog that keeps coming back is answered four times, then left");
  assert.equal(entry("NBF-1").waiting, true);
});

test("a retry's earlier outcome does not end it before it starts", async () => {
  const { pool, status, entry, settings, store } = await startedRun();
  status.set(herdrName("NBF-1"), "working");
  await pool.tick();
  status.set(herdrName("NBF-1"), "idle");
  await pool.tick();
  assert.deepEqual(entry("NBF-1").outcome, { kind: "no-outcome" });
  pool.close("NBF-1");
  writeFileSync(join(ticketDir(settings, "NBF-1"), "outcome.json"), JSON.stringify({ kind: "needs-human", reason: "stale" }));
  store.set(retry(store.get(), "NBF-1", 200));
  status.set(herdrName("NBF-1"), "idle");
  await pool.tick();
  assert.equal(entry("NBF-1").phase, "running", "the stale outcome was cleared, so an idle agent that has not worked yet is not finished");
  assert.ok(!existsSync(join(ticketDir(settings, "NBF-1"), "outcome.json")));
});

test("a run stopped while it was starting stays stopped, and the workspace its start raced is closed", async () => {
  const root = tmpDir("ticket-race-");
  const settings = parseTicketSettings({ clones: { "nbl-ui-netbox": "/repos/nbl-ui-netbox" }, stateDir: root });
  // The person presses Stop while Claude is starting.
  const racing = stopDuringStart(resumeQueue(enqueue(emptyQueue(1), [ticket("NBF-1")], { model: "sonnet", effort: "high" }, 0)), "NBF-1", {
    settings, source, codeHost: createFakeCodeHost(), hook: { node: "n", bin: "b" }, wait: async () => {}, load: () => ({ load: 0, cores: 1 }),
  });
  await racing.pool.tick();
  assert.deepEqual(racing.store.get().entries[0].outcome, { kind: "stopped" });
  assert.ok(racing.h.calls.some((args) => args.includes("close") && args.includes("w1")), "the raced workspace is closed");
});

test("a tick asked for during a tick runs once more after it, so a ticket queued meanwhile does not wait for the next interval", async () => {
  const { pool, entry, store } = setup(2, ["NBF-1"]);
  const first = pool.tick();
  store.set(enqueue(store.get(), [ticket("NBF-2")], { model: "sonnet", effort: "high" }, 1));
  await pool.tick();
  await first;
  assert.equal(entry("NBF-2").phase, "running");
});

test("a paused queue starts nothing, however much room there is", async () => {
  const { pool, store, entry, h } = setup(3, ["NBF-1"]);
  store.set(pauseQueue(store.get()));
  await pool.tick();
  assert.equal(entry("NBF-1").phase, "queued");
  assert.ok(!h.calls.some((args) => args.includes("create")), "no workspace was opened");
});

test("the tracker is asked about finished runs only, its answer is recorded, and a refused read changes nothing", async () => {
  const asked: string[][] = [];
  let answer: Map<string, string> | Error = new Map([["NBF-1", "completed"]]);
  const tracker: TicketSource = { ...source, stateTypes: async (keys) => { asked.push([...keys]); if (answer instanceof Error) throw answer; return answer; } };
  const root = tmpDir("ticket-pool-tracker-");
  const settings = parseTicketSettings({ clones: { "nbl-ui-netbox": "/repos/nbl-ui-netbox" }, stateDir: join(root, "state") });
  let queue: Queue = finish(enqueue(emptyQueue(2), [ticket("NBF-1"), ticket("NBF-2")], { model: "sonnet", effort: "high" }, 0), "NBF-1", { kind: "draft-pr", prs: [] }, 5);
  const store = { get: () => queue, set: (next: Queue) => { queue = next; } };
  const pool = createPool(store, { settings, source: tracker, codeHost: createFakeCodeHost(), hook: { node: "/node", bin: "/b" }, herdr: () => "{}", now: () => 9, load: () => ({ load: 0, cores: 1 }), transcriptsRoot: root, wait: async () => {} });
  await pool.refreshTracker();
  assert.deepEqual(asked, [["NBF-1"]], "the queued NBF-2 is not asked about");
  assert.equal(queue.entries.find((e) => e.ticket.key === "NBF-1")!.trackerState, "completed");
  await pool.refreshTracker();
  assert.equal(asked.length, 1, "a completed ticket is not asked about again");
  queue = finish(queue, "NBF-2", { kind: "crashed", reason: "r" }, 6);
  answer = new Error("Linear answered 500");
  await pool.refreshTracker();
  assert.equal(queue.entries.find((e) => e.ticket.key === "NBF-2")!.trackerState, undefined);
});

test("a run whose pull request merged reads as completed while its ticket is still in progress, and is not asked about again", async () => {
  const url = "https://github.com/netboxlabs/nbl-ui-platform-libs/pull/775";
  const asked: string[][] = [];
  const tracker: TicketSource = {
    ...source,
    stateTypes: async (keys) => new Map(keys.map((key) => [key, "started"])),
    pullStates: async (keys) => { asked.push([...keys]); return new Map([["NBF-1", { [url]: "merged" as const }]]); },
  };
  const root = tmpDir("ticket-pool-pulls-");
  const settings = parseTicketSettings({ clones: { "nbl-ui-netbox": "/repos/nbl-ui-netbox" }, stateDir: join(root, "state") });
  let queue: Queue = finish(enqueue(emptyQueue(2), [ticket("NBF-1")], { model: "sonnet", effort: "high" }, 0), "NBF-1", { kind: "draft-pr", prs: [{ repo: "r", url }] }, 5);
  const store = { get: () => queue, set: (next: Queue) => { queue = next; } };
  const pool = createPool(store, { settings, source: tracker, codeHost: createFakeCodeHost(), hook: { node: "/node", bin: "/b" }, herdr: () => "{}", now: () => 9, load: () => ({ load: 0, cores: 1 }), transcriptsRoot: root, wait: async () => {} });
  await pool.refreshTracker();
  assert.equal(runStatus(queue.entries[0]), "completed");
  await pool.refreshTracker();
  assert.equal(asked.length, 1);
});

test("A11-92: a worker's outcome keeps its partial declaration when it wrote a non-empty one, and a blank one is none", () => {
  const pr = { repo: "r", url: "https://github.com/netboxlabs/nbl-ui-platform-libs/pull/801" };
  assert.deepEqual(parseOutcome(JSON.stringify({ kind: "ready-pr", prs: [pr], partial: " the settings page " })), { kind: "ready-pr", prs: [pr], partial: "the settings page" });
  assert.deepEqual(parseOutcome(JSON.stringify({ kind: "draft-pr", prs: [pr], partial: "  " })), { kind: "draft-pr", prs: [pr] }, "a blank declaration is none");
  assert.deepEqual(parseOutcome(JSON.stringify({ kind: "ready-pr", prs: [pr] })), { kind: "ready-pr", prs: [pr] }, "no declaration, as before");
  assert.deepEqual(parseOutcome(JSON.stringify({ kind: "ready-pr", prs: [pr], partial: "<what remains>" })), { kind: "ready-pr", prs: [pr] }, "the brief's placeholder is none, as pr:open reads it");
});

const MERGED_PR = "https://github.com/netboxlabs/nbl-ui-platform-libs/pull/801";
const OPEN_PR = "https://github.com/netboxlabs/nbl-ui-platform-libs/pull/802";

/**
 * A pool over one finished run of NBF-1 that ended with `outcome`, whose pull request is `pull` and whose ticket the tracker reads as `state`. `complete`
 * records each call (and throws when `refuse` says so), and `reads` each state read, so a test sees what the board asked the tracker.
 */
function completing(outcome: Outcome, { state = "started", pull = "merged", refuse = 0, keywords, note = null, without, pulls }: {
  state?: string; pull?: PullState; refuse?: number; keywords?: TicketSource["keywords"]; note?: string | null; without?: "complete";
  pulls?: Record<string, PullState>;
} = {}) {
  const root = tmpDir("ticket-pool-complete-");
  const settings = parseTicketSettings({ clones: { "nbl-ui-netbox": "/repos/nbl-ui-netbox" }, stateDir: join(root, "state") });
  const calls: [string, string][] = [];
  const reads: string[][] = [];
  let attempts = 0;
  const tracker: TicketSource = {
    ...source,
    keywords,
    stateTypes: async (keys) => { reads.push([...keys]); return new Map(keys.map((key) => [key, state])); },
    pullStates: async () => new Map([["NBF-1", pulls ?? { [MERGED_PR]: pull }]]),
    complete: async (key, comment) => {
      attempts += 1;
      if (attempts <= refuse) throw new Error("Linear answered 500");
      calls.push([key, comment]);
      return note;
    },
  };
  if (without === "complete") delete tracker.complete;
  let queue: Queue = finish(enqueue(emptyQueue(2), [ticket("NBF-1")], { model: "sonnet", effort: "high" }, 0), "NBF-1", outcome, 5);
  const store = { get: () => queue, set: (next: Queue) => { queue = next; } };
  const pool = createPool(store, { settings, source: tracker, codeHost: createFakeCodeHost(), hook: { node: "/node", bin: "/b" }, herdr: () => "{}", now: () => 9, load: () => ({ load: 0, cores: 1 }), transcriptsRoot: root, wait: async () => {} });
  return { pool, calls, reads, entry: () => queue.entries[0] };
}

test("A11-92: a ready pull request that merged while its ticket is still started completes the ticket once, naming the merged pull request", async () => {
  const { pool, calls, entry } = completing({ kind: "ready-pr", prs: [{ repo: "r", url: MERGED_PR }] });
  await pool.refreshTracker();
  assert.equal(calls.length, 1, "completed once");
  assert.equal(calls[0][0], "NBF-1");
  assert.ok(calls[0][1].includes(MERGED_PR), "the comment names the merged pull request");
  assert.equal(entry().closedByBoard, true);
  await pool.refreshTracker();
  assert.equal(calls.length, 1, "not completed again at the next refresh");
});

test("A11-92: a run with two pull requests completes its ticket only when both have settled and one merged", async () => {
  const pair = [{ repo: "r", url: MERGED_PR }, { repo: "s", url: OPEN_PR }];
  const open = completing({ kind: "ready-pr", prs: pair }, { pulls: { [MERGED_PR]: "merged", [OPEN_PR]: "open" } });
  await open.pool.refreshTracker();
  assert.equal(open.calls.length, 0, "the second pull request is still open");
  const closedToo = completing({ kind: "ready-pr", prs: pair }, { pulls: { [MERGED_PR]: "merged", [OPEN_PR]: "closed" } });
  await closedToo.pool.refreshTracker();
  assert.equal(closedToo.calls.length, 1, "both merged");
});

test("A11-92: a source without complete is left to the tracker, and the board completes nothing", async () => {
  const { pool, entry } = completing({ kind: "ready-pr", prs: [{ repo: "r", url: MERGED_PR }] }, { without: "complete" });
  await pool.refreshTracker();
  assert.equal(entry().closedByBoard, undefined, "nothing is marked as the board's");
});

test("A11-92: a team with no completed state is logged and left alone, with its run marked handled so the note is not repeated", async () => {
  const { pool, calls, reads, entry } = completing({ kind: "ready-pr", prs: [{ repo: "r", url: MERGED_PR }] }, { note: "NBF-1's team has no completed state, so it stays in In Progress" });
  await pool.refreshTracker();
  const readsAfterFirst = reads.length;
  await pool.refreshTracker();
  assert.equal(calls.length, 1, "asked once");
  assert.equal(reads.length, readsAfterFirst, "not read again once handled");
  assert.equal(entry().closedByBoard, true);
});

test("A11-92: a reviewed run whose pull request merged completes its ticket the same way", async () => {
  const { pool, calls } = completing({ kind: "reviewed", prs: [{ repo: "r", url: MERGED_PR }] });
  await pool.refreshTracker();
  assert.equal(calls.length, 1);
});

test("A11-92: a run declared partial leaves its ticket open when its pull request merges", async () => {
  const { pool, calls, entry } = completing({ kind: "ready-pr", prs: [{ repo: "r", url: MERGED_PR }], partial: "the settings page" });
  await pool.refreshTracker();
  assert.equal(calls.length, 0);
  assert.equal(entry().closedByBoard, undefined);
});

test("A11-92: a checked run and a run with an open pull request leave their tickets open", async () => {
  const checked = completing({ kind: "checked", reason: "nothing to change" });
  await checked.pool.refreshTracker();
  const open = completing({ kind: "ready-pr", prs: [{ repo: "r", url: MERGED_PR }] }, { pull: "open" });
  await open.pool.refreshTracker();
  assert.deepEqual([checked.calls.length, open.calls.length], [0, 0]);
});

test("A11-153: a draft whose pull request merged completes its ticket as a ready one does, whatever kind the outcome was", async () => {
  const draft = completing({ kind: "draft-pr", prs: [{ repo: "r", url: MERGED_PR }] });
  await draft.pool.refreshTracker();
  assert.equal(draft.calls.length, 1);
  assert.equal(draft.entry().closedByBoard, true);
});

test("A11-92: a ticket the tracker has already finished or canceled is left alone, and is not read again", async () => {
  for (const state of ["completed", "canceled", "duplicate"]) {
    const { pool, calls, reads, entry } = completing({ kind: "ready-pr", prs: [{ repo: "r", url: MERGED_PR }] }, { state });
    await pool.refreshTracker();
    await pool.refreshTracker();
    assert.equal(calls.length, 0, `${state}: no completion`);
    assert.equal(entry().closedByBoard, undefined, state);
    assert.equal(reads.length, 1, `${state}: read once, then settled`);
  }
});

test("A11-92: a completion Linear refuses is logged and tried again at the next refresh, and not recorded as done", async () => {
  const { pool, calls, entry } = completing({ kind: "ready-pr", prs: [{ repo: "r", url: MERGED_PR }] }, { refuse: 1 });
  await pool.refreshTracker();
  assert.equal(entry().closedByBoard, undefined, "not done yet");
  await pool.refreshTracker();
  assert.equal(calls.length, 1);
  assert.equal(entry().closedByBoard, true);
});

test("A11-92: a pull request outcome sets its run's partial declaration, a crash keeps it, and a retry starts a fresh worker without it", () => {
  const pr = { repo: "r", url: MERGED_PR };
  let queue: Queue = finish(enqueue(emptyQueue(2), [ticket("NBF-1")], { model: "sonnet", effort: "high" }, 0), "NBF-1", { kind: "ready-pr", prs: [pr], partial: "the settings page" }, 5);
  assert.equal(queue.entries[0].partial, "the settings page");
  queue = finish(queue, "NBF-1", { kind: "crashed", reason: "r" }, 6);
  assert.equal(queue.entries[0].partial, "the settings page", "a crash says nothing of it, so the run keeps it");
  queue = retry(queue, "NBF-1", 7);
  assert.equal(queue.entries[0].partial, undefined, "a retry is a fresh worker");
  queue = finish(queue, "NBF-1", { kind: "ready-pr", prs: [pr] }, 8);
  assert.equal(queue.entries[0].partial, undefined, "an outcome with no declaration says the pull request completes the ticket");
});

test("A11-92: a review round keeps its run's partial declaration, so its own merge does not complete the ticket", () => {
  const pr = { repo: "r", url: MERGED_PR };
  let queue: Queue = finish(enqueue(emptyQueue(2), [ticket("NBF-1")], { model: "sonnet", effort: "high" }, 0), "NBF-1", { kind: "draft-pr", prs: [pr], partial: "the settings page" }, 5);
  queue = approve(queue, "NBF-1", 6);
  assert.equal(queue.entries[0].partial, "the settings page", "the review round carries it");
  queue = finish(queue, "NBF-1", { kind: "reviewed", prs: [pr] }, 7);
  assert.equal(queue.entries[0].partial, "the settings page", "a reviewed outcome does not say it, so the run keeps it");
  assert.deepEqual(completableRuns({ ...queue, entries: queue.entries.map((e) => ({ ...e, pullStates: { [MERGED_PR]: "merged" as const }, trackerState: "started" })) }), []);
});

test("A11-92: the brief names the words the tracker reads a pull request by, and the defaults when the tracker names none", async () => {
  const named = { closing: "Resolves", nonClosing: "Relates" };
  const { pool, settings } = setup(1, ["NBF-1"], {}, { source: { ...source, keywords: named } });
  await pool.tick();
  const brief = readFileSync(join(ticketDir(settings, "NBF-1"), "brief.md"), "utf8");
  assert.ok(brief.includes("names the ticket `Resolves NBF-1` when this pull request completes it"));
  assert.equal(brief.includes("Closes"), false);
  const plain = setup(1, ["NBF-2"]);
  await plain.pool.tick();
  assert.ok(readFileSync(join(ticketDir(plain.settings, "NBF-2"), "brief.md"), "utf8").includes("names the ticket `Closes NBF-2` when this pull request completes it"));
});

const blocks = (key: string, state: string, status: string, pulls: Record<string, "open" | "merged" | "closed"> = {}) => ({ key, state, status, pulls });

test("a run waits on its blocker: its blockers are read before anything starts, a later unblocked run starts first, and it starts once the blocker is done", async () => {
  let lib = blocks("LIB-1", "started", "In Review");
  const asked: string[][] = [];
  const tracker: TicketSource = { ...source, blockers: async (keys) => { asked.push([...keys]); return new Map([["NBF-1", [lib]]]); } };
  const { pool, entry } = setup(2, ["NBF-1", "NBF-2"], {}, { source: tracker });
  await pool.tick();
  assert.deepEqual(asked, [["NBF-1", "NBF-2"]], "read once, for both, before either started");
  assert.deepEqual([entry("NBF-1").phase, entry("NBF-2").phase], ["queued", "running"]);
  assert.deepEqual(entry("NBF-2").blockers, [], "a ticket the tracker names no blocker for has none");
  await pool.tick();
  assert.equal(entry("NBF-1").phase, "queued", "still blocked, and not read again on a tick");
  lib = blocks("LIB-1", "completed", "Done", { "https://github.com/x/libs/pull/9": "merged" });
  await pool.refreshTracker();
  await pool.tick();
  assert.equal(entry("NBF-1").phase, "running");
});

test("A11-154: a run whose blocker's pull request merged starts though the blocker's ticket is still In Progress, and a canceled blocker still holds it", async () => {
  const merged = { "https://github.com/a11ign/agent-org/pull/1800": "merged" as const };
  for (const [state, started] of [["started", true], ["canceled", false]] as const) {
    const tracker: TicketSource = { ...source, blockers: async () => new Map([["NBF-1", [blocks("NBF-0", state, "In Progress", merged)]]]) };
    const { pool, entry, store } = setup(1, ["NBF-1"], {}, { source: tracker });
    await pool.tick();
    assert.equal(entry("NBF-1").phase, started ? "running" : "queued", `a ${state} blocker whose pull request merged`);
    if (!started) assert.equal(waitNote(entry("NBF-1"), store.get().entries), "NBF-0 was canceled: a person decides");
  }
});

test("nothing starts while the tracker cannot say what blocks a run, and a source that cannot say holds nothing back", async () => {
  const down: TicketSource = { ...source, blockers: async () => { throw new Error("Linear answered 503"); } };
  const refused = setup(2, ["NBF-1"], {}, { source: down });
  await refused.pool.tick();
  assert.equal(refused.entry("NBF-1").phase, "queued");
  assert.equal(refused.entry("NBF-1").blockers, undefined, "asked again on the next tick");
  const unsupported = setup(2, ["NBF-1"]);
  await unsupported.pool.tick();
  assert.equal(unsupported.entry("NBF-1").phase, "running");
});

test("a run that waited names its blockers and their pull requests in its brief", async () => {
  const pr = "https://github.com/netboxlabs/nbl-ui-platform-libs/pull/800";
  const tracker: TicketSource = { ...source, blockers: async () => new Map([["NBF-1", [blocks("NBF-1944", "completed", "Done", { [pr]: "merged" })]]]) };
  const { pool, settings } = setup(1, ["NBF-1"], {}, { source: tracker });
  await pool.tick();
  const brief = readFileSync(join(ticketDir(settings, "NBF-1"), "brief.md"), "utf8");
  assert.match(brief, /## Tickets that blocked this one\n\nThis ticket waited until each of these was done:\n\n- NBF-1944, Done: https:\/\/github\.com\/netboxlabs\/nbl-ui-platform-libs\/pull\/800 \(merged\)/);
  assert.match(brief, /check that the release is out before you rely on it/);
});

test("a source that cannot read states never marks a run completed", async () => {
  const root = tmpDir("ticket-pool-nostates-");
  const settings = parseTicketSettings({ clones: { "nbl-ui-netbox": "/repos/nbl-ui-netbox" }, stateDir: join(root, "state") });
  let queue: Queue = finish(enqueue(emptyQueue(2), [ticket("NBF-1")], { model: "sonnet", effort: "high" }, 0), "NBF-1", { kind: "draft-pr", prs: [] }, 5);
  const store = { get: () => queue, set: (next: Queue) => { queue = next; } };
  const pool = createPool(store, { settings, source, codeHost: createFakeCodeHost(), hook: { node: "/node", bin: "/b" }, herdr: () => "{}", now: () => 9, load: () => ({ load: 0, cores: 1 }), transcriptsRoot: root, wait: async () => {} });
  await pool.refreshTracker();
  assert.equal(queue.entries[0].trackerState, undefined);
});

/** Run NBF-1 until it ends on `outcome` (null for none), and return the setup. */
async function endedOn(outcome: Record<string, unknown> | null, max = 1, keys = ["NBF-1"], tickets: Record<string, unknown> = {}, options: NonNullable<Parameters<typeof setup>[3]> = {}) {
  const made = setup(max, keys, tickets, options);
  await made.pool.tick();
  made.status.set(herdrName("NBF-1"), "working");
  await made.pool.tick();
  if (outcome !== null) writeFileSync(join(ticketDir(made.settings, "NBF-1"), "outcome.json"), JSON.stringify(outcome));
  made.status.set(herdrName("NBF-1"), "idle");
  await made.pool.tick();
  return made;
}
const closes = (h: { calls: string[][] }, workspace: string) => h.calls.filter((args) => args.includes("close") && args.includes(workspace)).length;

/** A run that asked a person a question and parked, on a machine that moves its ticket to In Progress; its workspace is closed and a retry is queued. */
async function retriedParked(tracker: TicketSource) {
  const parked = await endedOn({ kind: "needs-human", reason: "which colour?" }, 1, ["NBF-1"], { workingState: "In Progress" }, { source: tracker });
  parked.pool.close("NBF-1");
  parked.store.set(retry(parked.store.get(), "NBF-1", 200));
  return parked;
}

test("a run that hands its ticket back is parked: its workspace and pane stay, and it holds no slot", async () => {
  for (const outcome of [{ kind: "needs-human", reason: "which colour?" }, { kind: "wrong-repo", where: "netbox" }, null]) {
    const { entry, h } = await endedOn(outcome, 1, ["NBF-1", "NBF-2"]);
    assert.deepEqual([entry("NBF-1").phase, entry("NBF-1").workspace, entry("NBF-1").pane], ["finished", "w1", "w1:p1"], JSON.stringify(outcome));
    assert.equal(closes(h, "w1"), 0, "the person can still answer it");
    assert.equal(entry("NBF-2").phase, "running", "NBF-2 took the one slot as NBF-1 parked");
  }
});

test("a parked run whose agent works again is resumed: its outcome is marked stale and left in place, its stop count cleared, and it ends again on a new one", async () => {
  const { pool, status, entry, settings, h } = await endedOn({ kind: "needs-human", reason: "which colour?" });
  const dir = ticketDir(settings, "NBF-1");
  writeFileSync(join(dir, "stop-refusals"), "2");
  await pool.tick();
  assert.equal(entry("NBF-1").phase, "finished", "an idle parked agent stays parked");
  status.set(herdrName("NBF-1"), "working");
  await pool.tick();
  assert.deepEqual([entry("NBF-1").phase, entry("NBF-1").outcome], ["running", undefined]);
  assert.match(readFileSync(join(dir, "outcome.json"), "utf8"), /which colour/, "the worker's file is not moved");
  assert.equal(readFileSync(join(dir, STALE_OUTCOME_FILE), "utf8"), "100\n", "marked stale at the time the run parked (the clock is 100)");
  assert.ok(!existsSync(join(dir, "stop-refusals")), "a fresh count, so the hook refuses a stop without an outcome again");
  // The file was written before the run parked, as on a real clock, so the stop hook judges it stale and refuses the stop.
  utimesSync(join(dir, "outcome.json"), 0.05, 0.05);
  assert.equal(stopVerdict(dir).code, 2, "the stop hook asks for a new outcome");
  writeFileSync(join(dir, "outcome.json"), JSON.stringify({ kind: "draft-pr", prs: [{ repo: "nbl-ui-netbox", url: "https://github.com/x/pull/2" }] }));
  status.set(herdrName("NBF-1"), "idle");
  await pool.tick();
  assert.equal(entry("NBF-1").outcome?.kind, "draft-pr");
  assert.equal(closes(h, "w1"), 1, "a draft pull request closes the workspace");
});

test("Close closes a parked run's workspace and keeps its outcome; a refused close leaves it parked and says why", async () => {
  const { pool, entry, h } = await endedOn({ kind: "needs-human", reason: "which colour?" });
  h.refused.add("close");
  assert.throws(() => pool.close("NBF-1"), /herdr could not close NBF-1's workspace \(workspace_not_found\)/);
  assert.equal(entry("NBF-1").workspace, "w1");
  h.refused.clear();
  pool.close("NBF-1");
  assert.deepEqual(h.calls.at(-1), ["--session", "tickets", "workspace", "close", "w1"]);
  assert.deepEqual([entry("NBF-1").workspace, entry("NBF-1").pane, entry("NBF-1").outcome?.kind], [undefined, undefined, "needs-human"]);
});

test("Close does nothing to a run that is not parked", async () => {
  const { pool, entry, h } = setup(1, ["NBF-1"]);
  await pool.tick();
  pool.close("NBF-1");
  assert.equal(closes(h, "w1"), 0);
  assert.equal(entry("NBF-1").phase, "running");
});

test("a parked run whose workspace is gone from two listings in a row is unparked and keeps its outcome", async () => {
  const { pool, status, entry } = await endedOn({ kind: "needs-human", reason: "r" });
  status.delete(herdrName("NBF-1"));
  await pool.tick();
  assert.equal(entry("NBF-1").workspace, "w1", "one missing listing is not enough");
  await pool.tick();
  assert.deepEqual([entry("NBF-1").workspace, entry("NBF-1").outcome?.kind], [undefined, "needs-human"]);
});

test("after a restart, a parked run herdr no longer lists is unparked", async () => {
  const { pool, status, entry } = await endedOn({ kind: "needs-human", reason: "r" });
  status.delete(herdrName("NBF-1"));
  pool.reconcile();
  assert.deepEqual([entry("NBF-1").workspace, entry("NBF-1").outcome?.kind], [undefined, "needs-human"]);
});

const PLANNER = { plan: "-plan-[^/]*\\.md$", planner: { run: "Run the planner with: unattended: plan {key} into {dir}", state: "Planned" } };
/** A tracker that records each plan it is asked to attach, and refuses with `refusal` when one is given. */
function planTracker(refusal: string | null = null) {
  const attached: { key: string; files: string[]; state: string | null }[] = [];
  const tracker: TicketSource = { ...source, attachPlan: async (key, files, state) => {
    if (refusal !== null) throw new Error(refusal);
    attached.push({ key, files: [...files], state });
    return null;
  } };
  return { tracker, attached };
}
/** Run `act` with the board's log captured, and return the lines it wrote. */
async function captureStderr(act: () => Promise<void>): Promise<string[]> {
  const written: string[] = [];
  const write = process.stderr.write;
  process.stderr.write = ((chunk: string) => { written.push(String(chunk)); return true; }) as typeof process.stderr.write;
  try {
    await act();
  } finally {
    process.stderr.write = write;
  }
  return written;
}

/** Let the pool's attaching, which a tick starts and does not wait for, finish. */
const settled = async () => { for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve)); };

/** Starts NBF-1 on a machine whose working state is In Progress, on `tracker`, with the board's log captured and the move settled. */
async function startingOn(tracker: TicketSource) {
  let made!: ReturnType<typeof setup>;
  const written = await captureStderr(async () => {
    made = setup(1, ["NBF-1"], { workingState: "In Progress" }, { source: tracker });
    await made.pool.tick();
    await settled();
  });
  return { ...made, written };
}

test("a ticket queued to be planned first starts a planning run: it plans and changes no code, on the planning model, with the planning refusals added", async () => {
  const { tracker } = planTracker();
  const { h, settings, dir } = await startedRun(PLANNER, { source: tracker, planFirst: ["NBF-1"] });
  const brief = readFileSync(join(dir, "brief.md"), "utf8");
  assert.match(brief, /^# Plan NBF-1: NBF-1\n/);
  assert.ok(brief.includes(`Run the planner with: unattended: plan NBF-1 into ${join(dir, "plan")}`), "the machine's instruction, with the ticket and its plan folder filled in");
  assert.match(brief, /\{ "kind": "planned" \}/);
  const tail = h.calls.find((args) => args.includes("start"))!;
  assert.deepEqual([tail[tail.indexOf("--model") + 1], tail[tail.indexOf("--effort") + 1]], ["opus", "max"], "the planning model and effort, not the run's");
  assert.equal(JSON.parse(readFileSync(join(ticketFolder(settings, "NBF-1"), ".claude", "settings.local.json"), "utf8")).model, "opus");
  const deny = JSON.parse(readFileSync(join(dir, "deny.json"), "utf8")) as { pattern: string }[];
  for (const command of ["git commit -m plan", "gh pr create --draft", "node bin.ts ticket:worktree nbl-ui-netbox"]) {
    assert.ok(deny.some(({ pattern }) => new RegExp(pattern).test(command)), `a planning run is refused ${command}`);
  }
  assert.equal(deny.some(({ pattern }) => new RegExp(pattern).test("gh pr view 12")), false, "it may still read a pull request");
});

test("a planning run that writes planned has its plan attached, and its ticket is queued again to be worked on its own model, told the plan was not a person's", async () => {
  const { tracker, attached } = planTracker();
  const { pool, h, status, entry, settings } = setup(1, ["NBF-1"], PLANNER, { source: tracker, planFirst: ["NBF-1"] });
  await pool.tick();
  const dir = ticketDir(settings, "NBF-1");
  writeFileSync(join(dir, "plan", "NBF-1-0001-plan-fit.md"), "# Fit\n");
  writeFileSync(join(dir, "outcome.json"), JSON.stringify({ kind: "planned" }));
  status.set(herdrName("NBF-1"), "idle");
  await pool.tick();
  await settled();
  assert.deepEqual(attached, [{ key: "NBF-1", files: [join(dir, "plan", "NBF-1-0001-plan-fit.md")], state: "Planned" }]);
  assert.ok(h.calls.some((args) => args.includes("close") && args.includes("w1")), "the planning run's workspace is closed");
  // The slot it freed is filled in the same tick, so the ticket is worked at once, as a fresh run.
  assert.deepEqual([entry("NBF-1").phase, entry("NBF-1").workspace, entry("NBF-1").plan, entry("NBF-1").planned, entry("NBF-1").outcome], ["running", "w2", undefined, true, undefined]);
  const brief = readFileSync(join(dir, "brief.md"), "utf8");
  assert.match(brief, /^# NBF-1: NBF-1\n/);
  assert.match(brief, /written by an unattended planning run, not agreed with a person/);
  const start = h.calls.filter((args) => args.includes("start")).at(-1)!;
  assert.equal(start[start.indexOf("--model") + 1], "sonnet");
});

test("a plan is attached once, though more ticks see its outcome while it is attached", async () => {
  let release: () => void = () => {};
  const calls: string[] = [];
  const tracker: TicketSource = { ...source, attachPlan: (key) => { calls.push(key); return new Promise<string | null>((resolve) => { release = () => resolve(null); }); } };
  const made = setup(1, ["NBF-1"], PLANNER, { source: tracker, planFirst: ["NBF-1"] });
  await plannedRun(made);
  await made.pool.tick();
  release();
  await settled();
  assert.deepEqual(calls, ["NBF-1"]);
  assert.equal(made.entry("NBF-1").phase, "queued");
});

test("a plan the tracker will not take, a planning run that wrote no plan, and a planned outcome from a run that was not planning each end for a person", async () => {
  const cases = [
    { name: "refused", tracker: planTracker("Linear answered 400").tracker, files: true, planFirst: ["NBF-1"], reason: /the plan could not be attached \(Linear answered 400\): its files are in .*plan/ },
    { name: "no plan", tracker: planTracker().tracker, files: false, planFirst: ["NBF-1"], reason: /the planning run wrote no plan in .*plan/ },
    { name: "not planning", tracker: planTracker().tracker, files: false, planFirst: [], reason: /wrote a planned outcome, but its run was not a planning run/ },
  ];
  for (const c of cases) {
    const { pool, status, entry, settings } = setup(1, ["NBF-1"], PLANNER, { source: c.tracker, planFirst: c.planFirst });
    await pool.tick();
    const dir = ticketDir(settings, "NBF-1");
    if (c.files) writeFileSync(join(dir, "plan", "NBF-1-0001-plan-fit.md"), "# Fit\n");
    await endWith({ pool, status }, dir, herdrName("NBF-1"), { kind: "planned" });
    await settled();
    const outcome = entry("NBF-1").outcome;
    assert.equal(outcome?.kind, "needs-human", c.name);
    assert.match(outcome?.kind === "needs-human" ? outcome.reason : "", c.reason, c.name);
    if (c.files) assert.ok(existsSync(join(dir, "plan", "NBF-1-0001-plan-fit.md")), "the refused plan's files are kept");
  }
});

test("a stop while a plan is attached is the person's last word: the ticket is not queued again", async () => {
  let release: () => void = () => {};
  const tracker: TicketSource = { ...source, attachPlan: () => new Promise<string | null>((resolve) => { release = () => resolve(null); }) };
  const made = setup(1, ["NBF-1"], PLANNER, { source: tracker, planFirst: ["NBF-1"] });
  await plannedRun(made);
  made.pool.stop("NBF-1");
  release();
  await settled();
  assert.equal(made.entry("NBF-1").outcome?.kind, "stopped");
});

test("a planning outcome is read as planned, and nothing else is", () => {
  assert.deepEqual(parseOutcome(JSON.stringify({ kind: "planned" })), { kind: "planned" });
});

test("a planning run starts with an empty plan folder, so an earlier attempt's files are never attached as its own", async () => {
  const { tracker, attached } = planTracker();
  const { pool, status, settings } = setup(1, ["NBF-1"], PLANNER, { source: tracker, planFirst: ["NBF-1"] });
  const planDir = join(ticketDir(settings, "NBF-1"), "plan");
  mkdirSync(planDir, { recursive: true });
  writeFileSync(join(planDir, "NBF-1-0001-plan-old.md"), "# An earlier attempt\n");
  await pool.tick();
  writeFileSync(join(planDir, "NBF-1-0001-plan-new.md"), "# This run\n");
  writeFileSync(join(ticketDir(settings, "NBF-1"), "outcome.json"), JSON.stringify({ kind: "planned" }));
  status.set(herdrName("NBF-1"), "idle");
  await pool.tick();
  await settled();
  assert.deepEqual(attached.map((a) => a.files), [[join(planDir, "NBF-1-0001-plan-new.md")]]);
});

/** A tracker whose attach waits until the test lets it go, then succeeds or fails. */
function heldTracker() {
  const held: { release: () => void; fail: (err: Error) => void } = { release: () => {}, fail: () => {} };
  const calls: string[] = [];
  const tracker: TicketSource = { ...source, attachPlan: (key) => {
    calls.push(key);
    return new Promise<string | null>((resolve, reject) => { held.release = () => resolve(null); held.fail = reject; });
  } };
  return { tracker, held, calls };
}
/** Start NBF-1's planning run and have it write a plan and `planned`, then tick so its attach begins. */
async function plannedRun(made: ReturnType<typeof setup>) {
  await made.pool.tick();
  writeFileSync(join(ticketDir(made.settings, "NBF-1"), "plan", "NBF-1-0001-plan-fit.md"), "# Fit\n");
  writeFileSync(join(ticketDir(made.settings, "NBF-1"), "outcome.json"), JSON.stringify({ kind: "planned" }));
  made.status.set(herdrName("NBF-1"), "idle");
  await made.pool.tick();
}

/** A planning run of NBF-1 that has written its plan and `planned`, its attach held by `heldTracker` until the test lets it go. */
async function heldPlanning() {
  const { tracker, held } = heldTracker();
  const made = setup(1, ["NBF-1"], PLANNER, { source: tracker, planFirst: ["NBF-1"] });
  await plannedRun(made);
  return { ...made, held };
}

test("a run stopped and retried while its plan was attached is a new run, which the old attach leaves alone", async () => {
  const made = await heldPlanning();
  made.pool.stop("NBF-1");
  made.store.set(retry(made.store.get(), "NBF-1", 200));
  made.status.delete(herdrName("NBF-1"));
  await made.pool.tick();
  assert.equal(made.entry("NBF-1").workspace, "w2", "the retried planning run has started");
  made.held.release();
  await settled();
  assert.deepEqual([made.entry("NBF-1").phase, made.entry("NBF-1").workspace, made.entry("NBF-1").plan !== undefined], ["running", "w2", true]);
});

test("a run stopped while its plan was attached stays stopped when the attach then fails", async () => {
  const made = await heldPlanning();
  made.pool.stop("NBF-1");
  made.held.fail(new Error("Linear answered 500"));
  await settled();
  assert.equal(made.entry("NBF-1").outcome?.kind, "stopped");
});

test("a plan folder holding a link or a file too big to be a plan attaches nothing, and the run ends for a person", async () => {
  for (const write of [
    (dir: string) => { const secret = join(tmpDir("ticket-secret-"), "board.key"); writeFileSync(secret, "a".repeat(48)); symlinkSync(secret, join(dir, "NBF-1-0001-plan-fit.md")); },
    (dir: string) => writeFileSync(join(dir, "NBF-1-0001-plan-fit.md"), "x".repeat(1_000_001)),
    (dir: string) => writeFileSync(join(dir, "diagram.png"), "png"),
  ]) {
    const { tracker, attached } = planTracker();
    const { pool, status, entry, settings } = setup(1, ["NBF-1"], PLANNER, { source: tracker, planFirst: ["NBF-1"] });
    await pool.tick();
    write(join(ticketDir(settings, "NBF-1"), "plan"));
    await endWith({ pool, status }, ticketDir(settings, "NBF-1"), herdrName("NBF-1"), { kind: "planned" });
    await settled();
    assert.deepEqual(attached, []);
    const outcome = entry("NBF-1").outcome;
    assert.match(outcome?.kind === "needs-human" ? outcome.reason : "", /which is not a markdown file of 1 MB or less, so nothing was attached/);
  }
});

test("a ticket whose plan reached it after it was queued is worked from that plan, not planned again", async () => {
  const tracker: TicketSource = { ...source, read: async (key) => ({ ...ticket(key), uploads: [`${key}-0001-plan-by-hand.md`] }), attachPlan: async () => { throw new Error("not called"); } };
  const { pool, entry, settings } = setup(1, ["NBF-1"], PLANNER, { source: tracker, planFirst: ["NBF-1"] });
  await pool.tick();
  assert.deepEqual([entry("NBF-1").phase, entry("NBF-1").plan, entry("NBF-1").planned], ["queued", undefined, undefined], "not marked as a plan nobody agreed");
  await pool.tick();
  assert.equal(entry("NBF-1").phase, "running");
  assert.match(readFileSync(join(ticketDir(settings, "NBF-1"), "brief.md"), "utf8"), /^# NBF-1: NBF-1\n/);
});

test("a plan attached without the planner's state still sends the ticket to be worked, and the board's log says why its state stayed", async () => {
  const tracker: TicketSource = { ...source, attachPlan: async () => "NBF-1's team has no state named Planned, so it stays in Todo" };
  const written = await captureStderr(async () => {
    const made = setup(1, ["NBF-1"], PLANNER, { source: tracker, planFirst: ["NBF-1"] });
    await plannedRun(made);
    await settled();
    assert.deepEqual([made.entry("NBF-1").plan, made.entry("NBF-1").planned], [undefined, true]);
  });
  assert.ok(written.includes("ticket:serve: NBF-1's team has no state named Planned, so it stays in Todo\n"));
});

test("a run whose plugin is installed only for another folder is not started, and says how to install it for every folder", async () => {
  const record = join(tmpDir("ticket-plugins-"), "installed_plugins.json");
  writeFileSync(record, JSON.stringify({ version: 2, plugins: { "nbl-ui@applied-ai": [{ scope: "project", projectPath: "/work", installPath: "/cache/nbl-ui/0.17.0" }] } }));
  const { h, entry } = await startedRun({ plugins: ["nbl-ui@applied-ai"] }, { pluginRecord: record });
  const outcome = entry("NBF-1").outcome;
  assert.equal(outcome?.kind, "crashed");
  assert.match(outcome?.kind === "crashed" ? outcome.reason : "", /nbl-ui@applied-ai is installed only for \/work, so a worker in .* runs without it: install it for every folder with `claude plugin install nbl-ui@applied-ai --scope user`/);
  assert.equal(h.calls.some((args) => args.includes("start")), false, "no worker was started");
});

/** A plugin installed for the user, whose files hold `manifest` when it is given one, and the record that names those files. */
function installedPlugin(manifest: unknown = null): string {
  const root = tmpDir("ticket-plugin-contract-");
  const install = join(root, "cache", "a11ign", "1.0.0");
  mkdirSync(join(install, ".claude-plugin"), { recursive: true });
  if (manifest !== null) writeFileSync(join(install, ".claude-plugin", "plugin.json"), JSON.stringify(manifest));
  const record = join(root, "installed_plugins.json");
  writeFileSync(record, JSON.stringify({ version: 2, plugins: { "a11ign@m": [{ scope: "user", installPath: install }] } }));
  return record;
}
const contractManifest = (needs: unknown) => ({ name: "a11ign", metadata: { agentOrg: { contract: "1.0", agentOrg: ">=0.0.0 <1.0.0", provides: {}, needs } } });

test("a run whose plugin declares a contract the host's keys do not meet is not started, and the mismatch is named", async () => {
  const { h, entry } = await startedRun({ plugins: ["a11ign@m"] }, { pluginRecord: installedPlugin(contractManifest({ connectors: ["^mcp__linear__get_"] })) });
  const { outcome } = entry("NBF-1");
  assert.deepEqual([outcome?.kind, h.calls.some((args) => args.includes("start"))], ["crashed", false], "refused before any worker started");
  assert.match(outcome?.kind === "crashed" ? outcome.reason : "", /^a11ign@m needs the connector tools matched by \^mcp__linear__get_, which tickets\.connectors does not allow: add the pattern to tickets\.connectors\.$/);
});

test("a run whose plugin's contract the host's keys meet starts, and so does one whose plugin declares no contract", async () => {
  const matched = await startedRun({ plugins: ["a11ign@m"], connectors: ["^mcp__linear__get_"] }, { pluginRecord: installedPlugin(contractManifest({ connectors: ["^mcp__linear__get_"] })) });
  assert.deepEqual([matched.entry("NBF-1").outcome, matched.h.calls.some((args) => args.includes("start"))], [undefined, true]);
  const none = await startedRun({ plugins: ["a11ign@m"] }, { pluginRecord: installedPlugin() });
  assert.deepEqual([none.entry("NBF-1").outcome, none.h.calls.some((args) => args.includes("start"))], [undefined, true]);
});

/** A tracker that records each ticket it is asked to move as work starts, answering with `note`, or failing with `failure`. */
function startTracker(note: string | null = null, failure: string | null = null) {
  const moved: string[] = [];
  const tracker: TicketSource = { ...source, moveToWorkingState: async (key, state) => {
    moved.push(`${key} ${state}`);
    if (failure !== null) throw new Error(failure);
    return { moved: note === null ? { from: "Todo", to: state } : null, note };
  } };
  return { tracker, moved };
}

/**
 * A tracker that keeps each ticket's state by name, as Linear does: a ticket still in Todo moves to the working state, and a restore moves it back
 * only while it is still there. `control.refuseRestore` is the message a restore is refused with, while it is set, and `control.hold` keeps a restore
 * waiting until it resolves.
 */
function stateTracker() {
  const current = new Map([["NBF-1", "Todo"]]);
  const control = { refuseRestore: null as string | null, hold: null as Promise<void> | null };
  const tracker: TicketSource = { ...source,
    moveToWorkingState: async (key, state) => {
      const from = current.get(key) ?? "Todo";
      if (from !== "Todo") return { moved: null, note: null };
      current.set(key, state);
      return { moved: { from, to: state }, note: null };
    },
    restoreState: async (key, move) => {
      if (control.hold !== null) await control.hold;
      if (control.refuseRestore !== null) throw new Error(control.refuseRestore);
      if (current.get(key) === move.to) current.set(key, move.from);
      return null;
    } };
  return { tracker, current, control };
}

test("a ticket moves to the working state as its worker starts, and a planning run moves nothing", async () => {
  const { tracker, moved } = startTracker();
  const { pool } = setup(2, ["NBF-1", "NBF-2"], { ...PLANNER, workingState: "In Progress" }, { source: tracker, planFirst: ["NBF-2"] });
  await pool.tick();
  await settled();
  assert.deepEqual(moved, ["NBF-1 In Progress"]);
});

test("a machine that names no working state moves nothing", async () => {
  const { tracker, moved } = startTracker();
  const { pool } = setup(1, ["NBF-1"], {}, { source: tracker });
  await pool.tick();
  await settled();
  assert.deepEqual(moved, []);
});

test("a move the tracker refuses, or one its team has no state for, goes to the board's log, and the run carries on", async () => {
  for (const [note, failure, line] of [
    ["NBF-1's team has no state named In Progress, so it stays in Todo", null, "ticket:serve: NBF-1's team has no state named In Progress, so it stays in Todo\n"],
    [null, "Linear answered 500", "ticket:serve: NBF-1 could not be moved to In Progress: Linear answered 500\n"],
  ] as const) {
    const { tracker } = startTracker(note, failure);
    const { entry, written } = await startingOn(tracker);
    assert.equal(entry("NBF-1").phase, "running");
    assert.ok(written.includes(line), line);
  }
});

test("a tracker that throws before it answers the move cannot stop the run, and one that cannot move tickets is not asked", async () => {
  const throwing: TicketSource = { ...source, moveToWorkingState: () => { throw new Error("not ready"); } };
  const { entry, written } = await startingOn(throwing);
  assert.equal(entry("NBF-1").phase, "running");
  assert.ok(written.includes("ticket:serve: NBF-1 could not be moved to In Progress: not ready\n"));
  const plain = setup(1, ["NBF-1"], { workingState: "In Progress" });
  await plain.pool.tick();
  assert.equal(plain.entry("NBF-1").phase, "running", "a source without the move starts the run as before");
});

test("a run that is stopped puts its ticket back in the state the board moved it out of", async () => {
  const { tracker, current } = stateTracker();
  const { pool, entry } = setup(1, ["NBF-1"], { workingState: "In Progress" }, { source: tracker });
  await pool.tick();
  await settled();
  assert.equal(current.get("NBF-1"), "In Progress");
  pool.stop("NBF-1");
  await settled();
  assert.deepEqual([current.get("NBF-1"), entry("NBF-1").movedFrom], ["Todo", undefined]);
});

test("a run a restart crashes puts its ticket back at the next tracker refresh, not before", async () => {
  const { tracker, current } = stateTracker();
  const { pool, status, entry, restart } = setup(1, ["NBF-1"], { workingState: "In Progress" }, { source: tracker });
  await pool.tick();
  await settled();
  status.delete(herdrName("NBF-1"));
  const restarted = restart();
  restarted.reconcile();
  await settled();
  assert.equal(entry("NBF-1").outcome?.kind, "crashed");
  assert.equal(current.get("NBF-1"), "In Progress", "nothing is put back until the tracker is asked again");
  await restarted.refreshTracker();
  assert.deepEqual([current.get("NBF-1"), entry("NBF-1").movedFrom], ["Todo", undefined]);
});

test("a run that checked its ticket puts the ticket back at once", async () => {
  const { tracker, current } = stateTracker();
  const { entry } = await endedOn({ kind: "checked", reason: "nothing to change" }, 1, ["NBF-1"], { workingState: "In Progress" }, { source: tracker });
  await settled();
  assert.deepEqual([current.get("NBF-1"), entry("NBF-1").movedFrom], ["Todo", undefined]);
});

test("a run that hands its ticket back keeps the ticket In Progress while it is parked, and Dismiss puts it back and takes the run off", async () => {
  for (const outcome of [{ kind: "needs-human", reason: "which colour?" }, { kind: "wrong-repo", where: "netbox" }, null]) {
    const { tracker, current } = stateTracker();
    const parked = await endedOn(outcome, 1, ["NBF-1"], { workingState: "In Progress" }, { source: tracker });
    await settled();
    assert.equal(current.get("NBF-1"), "In Progress", `POSITIVE CONTROL: parked while ${JSON.stringify(outcome)}`);
    await parked.pool.dismiss("NBF-1");
    assert.deepEqual([current.get("NBF-1"), parked.store.get().entries], ["Todo", []], JSON.stringify(outcome));
  }
});

test("a parked run that is closed keeps its ticket In Progress, and a refresh does not put it back: the run is still on the board", async () => {
  const { tracker, current } = stateTracker();
  const parked = await endedOn({ kind: "needs-human", reason: "which colour?" }, 1, ["NBF-1"], { workingState: "In Progress" }, { source: tracker });
  parked.pool.close("NBF-1");
  await parked.pool.refreshTracker();
  assert.deepEqual([current.get("NBF-1"), parked.entry("NBF-1").phase, parked.entry("NBF-1").movedFrom?.from], ["In Progress", "finished", "Todo"]);
});

test("removing a queued retry that carries the record puts its ticket back, and the retry carries the record from the parked run", async () => {
  const { tracker, current } = stateTracker();
  const parked = await retriedParked(tracker);
  assert.deepEqual([parked.entry("NBF-1").phase, parked.entry("NBF-1").movedFrom], ["queued", { from: "Todo", to: "In Progress" }]);
  await parked.pool.remove("NBF-1");
  assert.deepEqual([current.get("NBF-1"), parked.store.get().entries], ["Todo", []]);
});

test("removing a queued review round restores nothing, even where it still holds the record of its run", async () => {
  const { tracker, current } = stateTracker();
  const made = await endedOn({ kind: "draft-pr", prs: [{ repo: "nbl-ui-netbox", url: "https://github.com/x/pull/2" }] }, 1, ["NBF-1"], { workingState: "In Progress" }, { source: tracker });
  const run = made.entry("NBF-1");
  made.store.set({ ...made.store.get(), entries: [{ ...run, phase: "queued", outcome: undefined, review: [{ repo: "nbl-ui-netbox", url: "https://github.com/x/pull/2" }] }] });
  await made.pool.remove("NBF-1");
  assert.deepEqual([current.get("NBF-1"), made.store.get().entries], ["In Progress", []]);
});

test("a run that opened a pull request keeps its ticket where it is when it is dismissed: the tracker's integration owns the state from there", async () => {
  const { tracker, current } = stateTracker();
  const made = await endedOn({ kind: "draft-pr", prs: [{ repo: "nbl-ui-netbox", url: "https://github.com/x/pull/2" }] }, 1, ["NBF-1"], { workingState: "In Progress" }, { source: tracker });
  await settled();
  assert.equal(current.get("NBF-1"), "In Progress");
  await made.pool.dismiss("NBF-1");
  assert.deepEqual([current.get("NBF-1"), made.store.get().entries], ["In Progress", []]);
});

test("a person who moved the ticket since the run started keeps it where they put it: the board leaves it alone and clears its record", async () => {
  const stopped = stateTracker();
  const run = setup(1, ["NBF-1"], { workingState: "In Progress" }, { source: stopped.tracker });
  await run.pool.tick();
  await settled();
  stopped.current.set("NBF-1", "Done");
  run.pool.stop("NBF-1");
  await settled();
  assert.deepEqual([stopped.current.get("NBF-1"), run.entry("NBF-1").movedFrom], ["Done", undefined]);

  const parked = stateTracker();
  const made = await endedOn({ kind: "needs-human", reason: "which colour?" }, 1, ["NBF-1"], { workingState: "In Progress" }, { source: parked.tracker });
  parked.current.set("NBF-1", "In Review");
  await made.pool.dismiss("NBF-1");
  assert.deepEqual([parked.current.get("NBF-1"), made.store.get().entries], ["In Review", []]);
});

test("a restore the tracker refuses is logged at the run's end and kept, the next refresh puts the ticket back, and Dismiss throws and keeps the run", async () => {
  const { tracker, current, control } = stateTracker();
  control.refuseRestore = "Linear answered 500";
  let made!: Awaited<ReturnType<typeof endedOn>>;
  const written = await captureStderr(async () => {
    made = await endedOn({ kind: "checked", reason: "nothing to change" }, 1, ["NBF-1"], { workingState: "In Progress" }, { source: tracker });
    await settled();
  });
  assert.ok(written.includes("ticket:serve: NBF-1 could not be put back to Todo: Linear answered 500\n"), written.join(""));
  assert.equal(made.entry("NBF-1").movedFrom?.from, "Todo", "the record is kept for the next try");
  control.refuseRestore = null;
  await made.pool.refreshTracker();
  assert.deepEqual([current.get("NBF-1"), made.entry("NBF-1").movedFrom], ["Todo", undefined]);

  const refused = stateTracker();
  const parked = await endedOn({ kind: "needs-human", reason: "which colour?" }, 1, ["NBF-1"], { workingState: "In Progress" }, { source: refused.tracker });
  refused.control.refuseRestore = "Linear answered 500";
  await assert.rejects(parked.pool.dismiss("NBF-1"), /NBF-1 could not be put back to Todo: Linear answered 500/);
  assert.deepEqual([parked.entry("NBF-1").phase, parked.entry("NBF-1").workspace], ["finished", "w1"], "the run stays on the board, parked and answerable");
  assert.equal(closes(parked.h, "w1"), 0, "its workspace is not closed for a restore that did not happen");
  refused.control.refuseRestore = null;
  await parked.pool.dismiss("NBF-1");
  assert.deepEqual([refused.current.get("NBF-1"), parked.store.get().entries], ["Todo", []]);
});

test("Remove of a queued retry whose ticket the tracker refuses to put back throws, and the run stays queued", async () => {
  const { tracker, control } = stateTracker();
  const parked = await retriedParked(tracker);
  control.refuseRestore = "Linear answered 500";
  await assert.rejects(parked.pool.remove("NBF-1"), /NBF-1 could not be put back to Todo: Linear answered 500/);
  assert.equal(parked.entry("NBF-1").phase, "queued");
});

test("no tick starts a queued run while Remove puts its ticket back, so the run Remove takes off is the one that was queued", async () => {
  const { tracker, current, control } = stateTracker();
  const parked = await retriedParked(tracker);
  const starts = () => parked.h.calls.filter((args) => args.includes("start")).length;
  const before = starts();
  let release!: () => void;
  control.hold = new Promise<void>((resolve) => { release = resolve; });
  const removing = parked.pool.remove("NBF-1");
  await settled();
  await parked.pool.tick();
  assert.equal(starts(), before, "the queued run is not started while its ticket is being put back");
  control.hold = null;
  release();
  await removing;
  assert.deepEqual([current.get("NBF-1"), parked.store.get().entries], ["Todo", []]);
});

test("a retried run that finds its ticket already started keeps the record its first run made", async () => {
  const { tracker, current } = stateTracker();
  const parked = await retriedParked(tracker);
  await parked.pool.tick();
  await settled();
  assert.deepEqual([parked.entry("NBF-1").phase, current.get("NBF-1"), parked.entry("NBF-1").movedFrom], ["running", "In Progress", { from: "Todo", to: "In Progress" }]);
});

test("a restore that comes before the move has resolved waits for it, and puts the ticket back only after it", async () => {
  const calls: string[] = [];
  const states = new Map([["NBF-1", "Todo"]]);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const tracker: TicketSource = { ...source,
    moveToWorkingState: async (key, state) => {
      await gate;
      calls.push(`move ${state}`);
      states.set(key, state);
      return { moved: { from: "Todo", to: state }, note: null };
    },
    restoreState: async (key, move) => {
      calls.push(`restore ${move.from}`);
      if (states.get(key) === move.to) states.set(key, move.from);
      return null;
    } };
  const { pool, entry } = setup(1, ["NBF-1"], { workingState: "In Progress" }, { source: tracker });
  await pool.tick();
  pool.stop("NBF-1");
  await settled();
  assert.deepEqual(calls, [], "the restore waits while the move is still on its way");
  release();
  await settled();
  assert.deepEqual([calls, states.get("NBF-1"), entry("NBF-1").movedFrom], [["move In Progress", "restore Todo"], "Todo", undefined]);
});

const BATCH_PLANNER = { plan:"-plan-[^/]*\\.md$", planner: { run: "Run the planner with: unattended: plan {keys} into {dir}", state: "Planned" } };
/** The batch `setup` queues its tickets in: `enqueue`'s first batch at the time 0. */
const BATCH = "b0-0";
/** A tracker that takes plans and records the blockers the board adds, reading them back as Linear would. */
function batchTracker(base: TicketSource = source) {
  const attached: string[] = [];
  const relations = new Map<string, string[]>();
  const tracker: TicketSource = {
    ...base,
    attachPlan: async (key) => { attached.push(key); return null; },
    addBlockers: async (key, blockerKeys) => { relations.set(key, [...(relations.get(key) ?? []), ...blockerKeys]); },
    blockers: async (keys) => new Map(keys.map((key) => [key, (relations.get(key) ?? []).map((blocker) => ({ key: blocker, state: "unstarted", status: "Planned", pulls: {} }))])),
  };
  return { tracker, attached, relations };
}
/** Write a file, making its folder. */
const put = (path: string, text: string) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
};
/** Writes each file of a batch's plan folder, keyed by its path under the folder. */
function writePlans(plan: string, files: Record<string, string>) {
  for (const [path, text] of Object.entries(files)) put(join(plan, path), text);
}

test("the tickets queued together are planned by one run in one slot: each shows Planning on the run's workspace and pane, and one agent starts", async () => {
  const { tracker } = batchTracker({ ...source, download: async (t, dir) => [join(dir, `attachment-1-${t.key}.png`)] });
  const { pool, h, entry, settings, store } = setup(2, ["NBF-1", "NBF-2", "NBF-3", "NBF-4"], BATCH_PLANNER, { source: tracker, planFirst: ["NBF-1", "NBF-2", "NBF-3"], batch: true });
  await pool.tick();
  for (const key of ["NBF-1", "NBF-2", "NBF-3"]) {
    assert.deepEqual([entry(key).phase, entry(key).workspace, entry(key).pane, runStatus(entry(key), store.get().entries)], ["running", "w1", "w1:p1", "planning"], key);
  }
  assert.deepEqual([entry("NBF-4").phase, entry("NBF-4").workspace], ["running", "w2"], "the batch held one of the two slots, so NBF-4 took the other");
  const starts = h.calls.filter((args) => args.includes("start"));
  assert.equal(starts.length, 2);
  assert.ok(starts[0].includes(herdrName(BATCH)), "the batch's run is named after the batch, not one of its tickets");
  const dir = batchDir(settings, BATCH);
  const brief = readFileSync(join(dir, "brief.md"), "utf8");
  assert.match(brief, /^# Plan 3 tickets together: NBF-1, NBF-2, NBF-3\n/);
  assert.ok(brief.includes(`Run the planner with: unattended: plan NBF-1, NBF-2, NBF-3 into ${join(dir, "plan")}`));
  assert.ok(brief.includes(join(ticketDir(settings, "NBF-2"), "attachment-1-NBF-2.png")), "each ticket's files are downloaded into its own folder, as a run of its own has them");
  const tail = starts[0].slice(starts[0].indexOf("--") + 1);
  assert.equal(tail[0], `Read ${dir}/brief.md and follow it.`);
  assert.deepEqual([tail[tail.indexOf("--model") + 1], tail[tail.indexOf("--effort") + 1]], ["opus", "max"], "the planning model and effort");
  const written = JSON.parse(readFileSync(join(batchFolder(settings, BATCH), ".claude", "settings.local.json"), "utf8"));
  assert.ok(written.hooks.Stop[0].hooks[0].args.includes(dir), "the stop hook reads the run's outcome file, in the batch's folder");
  const deny = JSON.parse(readFileSync(join(dir, "deny.json"), "utf8")) as { pattern: string }[];
  assert.ok(deny.some(({ pattern }) => new RegExp(pattern).test("git commit -m plan")), "the planning refusals hold for a batch too");
  const create = h.calls.find((args) => args.includes("create"))!;
  assert.equal(create.some((arg) => arg.startsWith("AGENT_ORG_TICKET=")), false, "a batch's run has no one ticket to make a worktree for");
});

test("a batch's planned outcome attaches each ticket's plan, hands back the one it asked about and the one it wrote nothing for, and records the order as blockers", async () => {
  const { tracker, attached, relations } = batchTracker();
  const keys = ["NBF-1", "NBF-2", "NBF-3", "NBF-4", "NBF-5"];
  const { pool, h, status, entry, settings, store } = setup(1, keys, BATCH_PLANNER, { source: tracker, planFirst: keys, batch: true });
  await pool.tick();
  const plan = join(batchDir(settings, BATCH), "plan");
  put(join(plan, "NBF-1", "NBF-1-0001-plan-libs.md"), "# Libs\n");
  put(join(plan, "NBF-2", "NBF-2-0001-plan-netbox.md"), "# Netbox\n");
  put(join(plan, "NBF-3", "QUESTION.md"), `\nWhich of the two layouts does the design mean? ${"x".repeat(600)}`);
  mkdirSync(join(plan, "NBF-4"));
  put(join(plan, "order.json"), JSON.stringify({ "NBF-1": { repo: "nbl-ui-platform-libs", after: [] }, "NBF-2": { repo: "nbl-ui-netbox", after: ["NBF-1"] },
    "NBF-3": { repo: null, after: [] }, "NBF-4": { repo: null, after: [] } }));
  writeFileSync(join(batchDir(settings, BATCH), "outcome.json"), JSON.stringify({ kind: "planned" }));
  status.set(herdrName(BATCH), "idle");
  await pool.tick();
  await settled();
  assert.deepEqual(attached, ["NBF-1", "NBF-2"]);
  assert.deepEqual([...relations], [["NBF-2", ["NBF-1"]]], "NBF-1 blocks NBF-2, as the order said");
  assert.equal(h.calls.some((args) => args.includes("close") && args.includes("w1")), false, "the run's workspace stays open: it asked a person, who answers it there (A11-171)");
  assert.deepEqual(["NBF-3", "NBF-4", "NBF-5"].map((key) => [entry(key).phase, entry(key).workspace, entry(key).pane, entry(key).batch, isParked(entry(key))]),
    [3, 4, 5].map(() => ["finished", "w1", "w1:p1", BATCH, true]), "the tickets it handed back are parked on the run's one pane");
  const asked = entry("NBF-3").outcome;
  assert.equal(asked?.kind, "needs-human");
  const reason = asked?.kind === "needs-human" ? asked.reason : "";
  assert.ok(reason.startsWith("the planner needs a person: Which of the two layouts does the design mean? x"), reason);
  assert.equal(reason.length, "the planner needs a person: ".length + 500, "the question's first 500 characters");
  for (const key of ["NBF-4", "NBF-5"]) {
    const empty = entry(key).outcome;
    assert.match(empty?.kind === "needs-human" ? empty.reason : "", new RegExp(`the planning run wrote nothing for ${key}: no plan and no QUESTION\\.md`), "an empty folder, or none");
  }
  assert.deepEqual(["NBF-1", "NBF-2"].map((key) => [entry(key).phase, entry(key).plan, entry(key).planned, entry(key).plannedRepo, entry(key).batch]),
    [["queued", undefined, true, "nbl-ui-platform-libs", undefined], ["queued", undefined, true, "nbl-ui-netbox", undefined]]);
  await pool.tick();
  assert.equal(entry("NBF-1").phase, "running", "the next pass reads the blockers again and starts NBF-1");
  assert.deepEqual([entry("NBF-2").blockers?.map((b) => b.key), runStatus(entry("NBF-2"), store.get().entries)], [["NBF-1"], "blocked"], "NBF-2 waits on NBF-1, as Linear now says");
});

test("an order.json that fails its checks records no blockers and is logged, and the plans are still attached", async () => {
  const { tracker, attached, relations } = batchTracker();
  const { entry, written } = await plannedBatch(tracker, (plan) => {
    put(join(plan, "NBF-1", "NBF-1-0001-plan-a.md"), "# A\n");
    put(join(plan, "NBF-2", "NBF-2-0001-plan-b.md"), "# B\n");
    put(join(plan, "order.json"), JSON.stringify({ "NBF-1": { repo: "a", after: ["NBF-2"] }, "NBF-2": { repo: "b", after: ["NBF-1"] } }));
  });
  assert.deepEqual(["NBF-1", "NBF-2"].map((key) => [entry(key).planned, entry(key).plannedRepo]), [[true, null], [true, null]]);
  assert.deepEqual([attached, [...relations]], [["NBF-1", "NBF-2"], []]);
  assert.ok(written.some((line) => /order\.json was not used, so no order was recorded: its order goes round in a cycle: NBF-1 -> NBF-2 -> NBF-1/.test(line)), written.join(""));
});

test("A11-152: a worker that writes its outcome and ends its turn while the watcher runs is never told to write it again", async () => {
  // The first rewrite is the outcome the run parked on, written again during the stop hook; the second is a new one. Neither is moved, and both pass the hook.
  for (const written of [{ kind: "needs-human", reason: "which colour?" }, { kind: "needs-human", reason: "which shade?" }]) {
    const { pool, status, settings } = await endedOn({ kind: "needs-human", reason: "which colour?" });
    const dir = ticketDir(settings, "NBF-1");
    status.set(herdrName("NBF-1"), "working");
    writeFileSync(join(dir, "outcome.json"), JSON.stringify(written));
    await pool.tick();
    assert.ok(existsSync(join(dir, "outcome.json")), `the board does not move the worker's file (${written.reason})`);
    assert.equal(stopVerdict(dir).code, 0, `the stop hook passes on the outcome the worker wrote (${written.reason})`);
  }
});

test("A11-152: a resumed run whose worker ends its turn with no new outcome ends with no outcome, not on the one it parked on", async () => {
  const { pool, status, entry, settings } = await endedOn({ kind: "needs-human", reason: "which colour?" });
  const dir = ticketDir(settings, "NBF-1");
  status.set(herdrName("NBF-1"), "working");
  await pool.tick();
  utimesSync(join(dir, "outcome.json"), 0.05, 0.05);
  status.set(herdrName("NBF-1"), "idle");
  await pool.tick();
  assert.equal(entry("NBF-1").outcome?.kind, "no-outcome", "the stale file is not the worker's outcome");
});

test("A11-152: a talk session seen idle before it answers does not settle on the outcome its run finished on", async () => {
  const { pool, status, entry } = await draftOfNbf1();
  pool.talk("NBF-1");
  await pool.tick();
  status.set(herdrName("NBF-1"), "idle");
  await pool.tick();
  assert.notEqual(entry("NBF-1").outcome?.kind, "draft-pr", "the file it finished on is no outcome of this session");
});

test("A11-152: an outcome the board marked stale is no outcome for the stop hook, and the watcher keeps the worker's file where it is", async () => {
  const { pool, status, settings } = await endedOn({ kind: "needs-human", reason: "which colour?" });
  const dir = ticketDir(settings, "NBF-1");
  status.set(herdrName("NBF-1"), "working");
  await pool.tick();
  assert.ok(existsSync(join(dir, STALE_OUTCOME_FILE)), "answered: the run is marked stale");
  assert.ok(existsSync(join(dir, "outcome.json")), "the file it parked on stays");
  utimesSync(join(dir, "outcome.json"), 0.05, 0.05);
  assert.equal(stopVerdict(dir).code, 2, "the stop hook refuses the old outcome");
});

test("A11-152: the watcher and the start never rename a file: the board moves an outcome only for a Grill question", () => {
  for (const file of ["pool-watch.ts", "pool-start.ts"]) {
    assert.doesNotMatch(readFileSync(new URL(`./${file}`, import.meta.url), "utf8"), /\brenameSync\b/, file);
  }
});

/** A Grill run that asks `needs-human` and goes idle, with `beforeIdle` (the stop hook's marks, if any) set beside its outcome first (A11-152). */
async function grillAsks(id: string, beforeIdle: (dir: string) => void = () => {}, now?: () => number) {
  const fixture = writing({ id, mode: "grill" }, WRITER, source, now);
  await fixture.pool.tick();
  await agentIs(fixture, fixture.name, "working");
  leaveOutcome(fixture.dir, { kind: "needs-human", reason: "Which goal does it serve?" });
  beforeIdle(fixture.dir);
  await agentIs(fixture, fixture.name, "idle");
  await writerSettled();
  return fixture;
}

test("A11-152: a stop-active mark the board cannot read holds the Grill question, as a fresh one does", async () => {
  // A directory where the mark should be: it is there, and reading it fails.
  const unreadable = await grillAsks("w5", (dir) => mkdirSync(join(dir, STOP_ACTIVE_FILE)));
  assert.deepEqual([existsSync(join(unreadable.dir, "outcome.json")), existsSync(join(unreadable.dir, "asked.json"))], [true, false], "a mark that cannot be read is not known to be old: nothing is moved");
});

test("A11-152: a stop-active mark that holds no time holds the Grill question, as a fresh one does", async () => {
  for (const [id, text] of [["w6", "not a time"], ["w7", ""]]) {
    const malformed = await grillAsks(id, (dir) => writeFileSync(join(dir, STOP_ACTIVE_FILE), text));
    assert.deepEqual([existsSync(join(malformed.dir, "outcome.json")), existsSync(join(malformed.dir, "asked.json"))], [true, false], `a mark reading ${JSON.stringify(text)} is not known to be old: nothing is moved`);
  }
});

test("A11-152: a Grill question waits while its stop hook reads the outcome, and is taken once that hook has ended or crashed", async () => {
  const held = await grillAsks("w3", (dir) => writeFileSync(join(dir, STOP_ACTIVE_FILE), "100"));
  assert.deepEqual([existsSync(join(held.dir, "outcome.json")), existsSync(join(held.dir, "asked.json"))], [true, false], "the hook is reading: nothing is moved yet");
  rmSync(join(held.dir, STOP_ACTIVE_FILE));
  await agentIs(held, held.name, "idle");
  await writerSettled();
  assert.deepEqual([existsSync(join(held.dir, "outcome.json")), existsSync(join(held.dir, "asked.json"))], [false, true], "the hook has ended: the question is moved");

  // A hook that began over a minute before now crashed without removing its mark: the board does not wait for it.
  const crashed = await grillAsks("w4", (dir) => writeFileSync(join(dir, STOP_ACTIVE_FILE), "100"), () => 100_000);
  assert.equal(existsSync(join(crashed.dir, "asked.json")), true, "a mark older than STOP_ACTIVE_MS is ignored");
});

test("a batch's run that hands back hands back every ticket on its one workspace, which a person answers once and closes once", async () => {
  const { tracker } = batchTracker();
  const { pool, status, entry, settings, h } = setup(1, ["NBF-1", "NBF-2"], BATCH_PLANNER, { source: tracker, planFirst: ["NBF-1", "NBF-2"], batch: true });
  await pool.tick();
  const dir = batchDir(settings, BATCH);
  writeFileSync(join(dir, "outcome.json"), JSON.stringify({ kind: "needs-human", reason: "which design?" }));
  status.set(herdrName(BATCH), "idle");
  await pool.tick();
  for (const key of ["NBF-1", "NBF-2"]) assert.deepEqual([entry(key).outcome, entry(key).workspace], [{ kind: "needs-human", reason: "which design?" }, "w1"], key);
  status.set(herdrName(BATCH), "working");
  await pool.tick();
  assert.deepEqual(["NBF-1", "NBF-2"].map((key) => entry(key).phase), ["running", "running"], "answered once, both are live again");
  assert.equal(readFileSync(join(dir, STALE_OUTCOME_FILE), "utf8"), "100\n", "the run's own outcome is marked stale, not moved");
  writeFileSync(join(dir, "outcome.json"), JSON.stringify({ kind: "needs-human", reason: "still unsure" }));
  status.set(herdrName(BATCH), "idle");
  await pool.tick();
  pool.close("NBF-2");
  assert.deepEqual(["NBF-1", "NBF-2"].map((key) => [entry(key).workspace, entry(key).outcome?.kind]), [[undefined, "needs-human"], [undefined, "needs-human"]]);
  assert.equal(h.calls.filter((args) => args.includes("close")).length, 1, "the one workspace is closed once");
});

test("only a batch's run is watched: its tickets without an agent are never crashed, and every one crashes when the run's workspace is gone", async () => {
  const { tracker } = batchTracker();
  const { pool, status, entry } = setup(1, ["NBF-1", "NBF-2"], BATCH_PLANNER, { source: tracker, planFirst: ["NBF-1", "NBF-2"], batch: true });
  await pool.tick();
  status.set(herdrName(BATCH), "working");
  for (let i = 0; i < 3; i += 1) await pool.tick();
  pool.reconcile();
  assert.deepEqual(["NBF-1", "NBF-2"].map((key) => entry(key).phase), ["running", "running"], "no listing names NBF-2's own agent, and it lives on");
  status.delete(herdrName(BATCH));
  await pool.tick();
  assert.deepEqual(["NBF-1", "NBF-2"].map((key) => entry(key).phase), ["running", "running"], "one listing without it is one miss, counted once for the run");
  await pool.tick();
  assert.deepEqual(["NBF-1", "NBF-2"].map((key) => entry(key).outcome), Array(2).fill({ kind: "crashed", reason: "its herdr workspace is gone" }));
  assert.deepEqual([entry("NBF-1").tokens, entry("NBF-2").tokens], [{ input: 0, output: 0 }, undefined], "the run's tokens are counted once, on the ticket it was watched through");
});

test("stopping any ticket of a batch stops its whole run, and a retried ticket is planned again on its own", async () => {
  const { tracker } = batchTracker();
  const { pool, h, entry, settings, store } = setup(1, ["NBF-1", "NBF-2", "NBF-3"], BATCH_PLANNER, { source: tracker, planFirst: ["NBF-1", "NBF-2", "NBF-3"], batch: true });
  await pool.tick();
  pool.stop("NBF-2");
  assert.deepEqual(["NBF-1", "NBF-2", "NBF-3"].map((key) => entry(key).outcome?.kind), ["stopped", "stopped", "stopped"]);
  assert.equal(h.calls.filter((args) => args.includes("close")).length, 1, "their one workspace is closed once");
  store.set(retry(store.get(), "NBF-2", 200));
  await pool.tick();
  assert.deepEqual([entry("NBF-2").phase, entry("NBF-2").batch, entry("NBF-2").workspace], ["running", undefined, "w2"]);
  assert.ok(h.calls.filter((args) => args.includes("start")).at(-1)!.includes(herdrName("NBF-2")), "its own run, named after it");
  assert.match(readFileSync(join(ticketDir(settings, "NBF-2"), "brief.md"), "utf8"), /^# Plan NBF-2: NBF-2\n/);
});

test("a machine whose planner names only {key} plans each ticket of a batch alone, and a batch left with one ticket to plan plans it alone", async () => {
  const { pool, h, entry } = setup(3, ["NBF-1", "NBF-2"], PLANNER, { source: batchTracker().tracker, planFirst: ["NBF-1", "NBF-2"], batch: true });
  await pool.tick();
  assert.deepEqual(["NBF-1", "NBF-2"].map((key) => [entry(key).workspace, entry(key).batch]), [["w1", undefined], ["w2", undefined]]);
  assert.ok(h.calls.some((args) => args.includes("start") && args.includes(herdrName("NBF-2"))));
  const reached: TicketSource = { ...batchTracker().tracker, read: async (key) => (key === "NBF-1" ? { ...ticket(key), uploads: ["NBF-1-0001-plan-x.md"] } : null) };
  const second = setup(3, ["NBF-1", "NBF-2"], BATCH_PLANNER, { source: reached, planFirst: ["NBF-1", "NBF-2"], batch: true });
  await second.pool.tick();
  assert.deepEqual([second.entry("NBF-1").plan, second.entry("NBF-1").batch], [undefined, undefined], "NBF-1's plan reached it, so it is worked from that");
  assert.deepEqual([second.entry("NBF-2").batch, second.entry("NBF-2").phase], [undefined, "running"]);
  assert.ok(second.h.calls.some((args) => args.includes("start") && args.includes(herdrName("NBF-2"))), "NBF-2 is planned alone, in its own run");
});

test("a batch's run is answered at its own folder's trust dialog, and a QUESTION.md that is a link is not read", async () => {
  const { tracker } = batchTracker();
  const { pool, status, entry, settings, h, screen } = setup(1, ["NBF-1", "NBF-2"], BATCH_PLANNER, { source: tracker, planFirst: ["NBF-1", "NBF-2"], batch: true });
  await pool.tick();
  status.set(herdrName(BATCH), "blocked");
  screen.text = TRUST(batchFolder(settings, BATCH));
  await pool.tick();
  assert.deepEqual(h.calls.find((args) => args.includes("send-keys")), ["--session", "tickets", "agent", "send-keys", herdrName(BATCH), "down", "enter"]);
  const plan = join(batchDir(settings, BATCH), "plan");
  const secret = join(settings.stateDir, "secret.txt");
  put(secret, "lin_api_secret");
  mkdirSync(join(plan, "NBF-1"), { recursive: true });
  symlinkSync(secret, join(plan, "NBF-1", "QUESTION.md"));
  put(join(plan, "NBF-2", "NBF-2-0001-plan-b.md"), "# B\n");
  await endWith({ pool, status }, batchDir(settings, BATCH), herdrName(BATCH), { kind: "planned" });
  await settled();
  const outcome = entry("NBF-1").outcome;
  const reason = outcome?.kind === "needs-human" ? outcome.reason : "";
  assert.match(reason, /QUESTION\.md, which is not a plain file/);
  assert.equal(reason.includes("lin_api_secret"), false);
  assert.equal(entry("NBF-2").planned, true, "one ticket's question does not stop the others");
});

test("a batch's ticket queued again while a pass reads blockers waits for the next pass's read, so it never starts before the order it was just given", async () => {
  const { tracker, relations } = batchTracker();
  let recorded: () => void = () => {};
  const orderRecorded = new Promise<void>((resolve) => { recorded = resolve; });
  const racing: TicketSource = {
    ...tracker,
    addBlockers: async (key, keys) => { await tracker.addBlockers!(key, keys); recorded(); },
    // The read this pass makes for NBF-3 answers only once the batch's plans are attached and its tickets queued again.
    blockers: async (keys) => {
      if (keys.includes("NBF-3")) {
        await orderRecorded;
        await settled();
      }
      return tracker.blockers!(keys);
    },
  };
  const { pool, status, entry, settings, store } = setup(3, ["NBF-1", "NBF-2"], BATCH_PLANNER, { source: racing, planFirst: ["NBF-1", "NBF-2"], batch: true });
  await pool.tick();
  writePlans(join(batchDir(settings, BATCH), "plan"), {
    "NBF-1/NBF-1-0001-plan-a.md": "# A\n",
    "NBF-2/NBF-2-0001-plan-b.md": "# B\n",
    "order.json": JSON.stringify({ "NBF-1": { repo: "nbl-ui-platform-libs", after: [] }, "NBF-2": { repo: "nbl-ui-netbox", after: ["NBF-1"] } }),
  });
  writeFileSync(join(batchDir(settings, BATCH), "outcome.json"), JSON.stringify({ kind: "planned" }));
  status.set(herdrName(BATCH), "idle");
  store.set(enqueue(store.get(), [ticket("NBF-3")], { model: "sonnet", effort: "high" }, 50));
  await pool.tick();
  assert.deepEqual([...relations], [["NBF-2", ["NBF-1"]]]);
  assert.deepEqual(["NBF-1", "NBF-2", "NBF-3"].map((key) => entry(key).phase), ["queued", "queued", "running"], "only the ticket whose blockers this pass read starts");
  await pool.tick();
  assert.deepEqual([entry("NBF-1").phase, runStatus(entry("NBF-2"), store.get().entries)], ["running", "blocked"]);
});

test("A11-77: an order that says a ticket waits on its blocker to merge keeps that mark on the ticket, and only on the ticket that said it", async () => {
  const { tracker, relations } = batchTracker();
  const keys = ["NBF-1", "NBF-2", "NBF-3"];
  const { pool, status, entry, settings } = setup(1, keys, BATCH_PLANNER, { source: tracker, planFirst: keys, batch: true });
  await pool.tick();
  const plan = join(batchDir(settings, BATCH), "plan");
  for (const key of keys) put(join(plan, key, `${key}-0001-plan.md`), `# ${key}\n`);
  put(join(plan, "order.json"), JSON.stringify({ "NBF-1": { repo: "nbl-ui-platform-libs", after: [] },
    "NBF-2": { repo: "nbl-ui-netbox", after: ["NBF-1"], wait: "merged" }, "NBF-3": { repo: "nbl-ui-netbox", after: ["NBF-1"], wait: "stacked" } }));
  await endWith({ pool, status }, batchDir(settings, BATCH), herdrName(BATCH), { kind: "planned" });
  await settled();
  assert.deepEqual([...relations].sort(), [["NBF-2", ["NBF-1"]], ["NBF-3", ["NBF-1"]]], "the order is recorded as blockers either way");
  assert.deepEqual(keys.map((key) => [entry(key).plannedRepo, entry(key).waitMerged]),
    [["nbl-ui-platform-libs", undefined], ["nbl-ui-netbox", ["NBF-1"]], ["nbl-ui-netbox", undefined]], "wait merged is kept, and stacked is the default");
});

test("a batch whose start fails crashes every ticket of it, and a stop while it starts stops them all and closes the workspace its start raced", async () => {
  const failing = { ...batchTracker().tracker, download: async (t: Ticket) => { if (t.key === "NBF-2") throw new Error("Linear answered 500\nmore"); return []; } };
  const broken = setup(1, ["NBF-1", "NBF-2"], BATCH_PLANNER, { source: failing, planFirst: ["NBF-1", "NBF-2"], batch: true });
  await broken.pool.tick();
  assert.deepEqual(["NBF-1", "NBF-2"].map((key) => broken.entry(key).outcome), Array(2).fill({ kind: "crashed", reason: "Linear answered 500" }));
  const root = tmpDir("ticket-batch-race-");
  const settings = parseTicketSettings({ clones: { "nbl-ui-netbox": "/repos/nbl-ui-netbox" }, stateDir: root, tickets: BATCH_PLANNER });
  // The person presses Stop on the second ticket while the batch's Claude is starting.
  const racing = stopDuringStart(resumeQueue(enqueue(emptyQueue(1), [ticket("NBF-1"), ticket("NBF-2")], { model: "sonnet", effort: "high" }, 0,
    { keys: new Set(["NBF-1", "NBF-2"]), choice: { model: "opus", effort: "max" }, batch: true })), "NBF-2", {
    settings, source: batchTracker().tracker, codeHost: createFakeCodeHost(), hook: { node: "n", bin: "b" }, wait: async () => {}, load: () => ({ load: 0, cores: 1 }),
    pluginRecord: join(root, "none.json"),
  });
  await racing.pool.tick();
  assert.deepEqual(racing.store.get().entries.map((e) => e.outcome), [{ kind: "stopped" }, { kind: "stopped" }]);
  assert.ok(racing.h.calls.some((args) => args.includes("close") && args.includes("w1")), "the raced workspace is closed");
});

/** Run a batch of NBF-1 and NBF-2 to a planned outcome, after `write` has filled its plan folder. Returns the setup and the board's log. */
async function plannedBatch(tracker: TicketSource, write: (plan: string) => void) {
  let ran: ReturnType<typeof setup> | undefined;
  const written = await captureStderr(async () => {
    ran = setup(1, ["NBF-1", "NBF-2"], BATCH_PLANNER, { source: tracker, planFirst: ["NBF-1", "NBF-2"], batch: true });
    await ran.pool.tick();
    write(join(batchDir(ran.settings, BATCH), "plan"));
    writeFileSync(join(batchDir(ran.settings, BATCH), "outcome.json"), JSON.stringify({ kind: "planned" }));
    ran.status.set(herdrName(BATCH), "idle");
    await ran.pool.tick();
    await settled();
  });
  return { ...ran!, written };
}
const ORDERED = (plan: string) => {
  put(join(plan, "NBF-1", "NBF-1-0001-plan-a.md"), "# A\n");
  put(join(plan, "NBF-2", "NBF-2-0001-plan-b.md"), "# B\n");
  put(join(plan, "order.json"), JSON.stringify({ "NBF-1": { repo: "nbl-ui-platform-libs", after: [] }, "NBF-2": { repo: "nbl-ui-netbox", after: ["NBF-1"] } }));
};

test("a relation the tracker refuses is logged and the plans stand, and a tracker that cannot record an order is not asked", async () => {
  const refusing = { ...batchTracker().tracker, addBlockers: async () => { throw new Error("Linear answered 400"); } };
  const refused = await plannedBatch(refusing, ORDERED);
  assert.ok(refused.written.includes("ticket:serve: NBF-1 could not be recorded as blocking NBF-2: Linear answered 400\n"), refused.written.join(""));
  assert.deepEqual(["NBF-1", "NBF-2"].map((key) => [refused.entry(key).planned, refused.entry(key).plannedRepo]), [[true, "nbl-ui-platform-libs"], [true, "nbl-ui-netbox"]]);
  const { addBlockers: _none, ...plain } = batchTracker().tracker;
  const unordered = await plannedBatch(plain, ORDERED);
  assert.deepEqual(["NBF-1", "NBF-2"].map((key) => unordered.entry(key).planned), [true, true]);
});

test("a ticket's folder that is a link is not read, and a folder the board cannot read hands every ticket of the batch back", async () => {
  const { tracker, attached } = batchTracker();
  const linked = await plannedBatch(tracker, (plan) => {
    const elsewhere = join(plan, "..", "..", "elsewhere");
    put(join(elsewhere, "NBF-1-0001-plan-secret.md"), "lin_api_secret");
    mkdirSync(plan, { recursive: true });
    symlinkSync(elsewhere, join(plan, "NBF-1"));
    put(join(plan, "NBF-2", "NBF-2-0001-plan-b.md"), "# B\n");
  });
  const outcome = linked.entry("NBF-1").outcome;
  assert.match(outcome?.kind === "needs-human" ? outcome.reason : "", /NBF-1, which is not a plain folder/);
  assert.deepEqual(attached, ["NBF-2"], "nothing behind the link is uploaded");
  const locked = await plannedBatch(batchTracker().tracker, (plan) => {
    put(join(plan, "NBF-1", "NBF-1-0001-plan-a.md"), "# A\n");
    chmodSync(join(plan, "NBF-1"), 0o000);
  });
  chmodSync(join(batchDir(locked.settings, BATCH), "plan", "NBF-1"), 0o755);
  for (const key of ["NBF-1", "NBF-2"]) {
    const ended = locked.entry(key).outcome;
    assert.match(ended?.kind === "needs-human" ? ended.reason : "", /^the plans could not be attached \(EACCES/, key);
  }
});

test("a run whose blocker has an open pull request in its planned repository starts stacked on it, and one with no planned repository waits", async () => {
  const draft = "https://github.com/acme/nbl-ui-netbox/pull/12";
  const tracker: TicketSource = { ...source, blockers: async (keys) => new Map(keys.map((key) => [key, key === "NBF-1" ? []
    : [{ key: "NBF-1", state: "started", status: "In Review", branch: "nbf-1-fit", pulls: { [draft]: "open" as const } }]])) };
  const { pool, entry, settings, store } = setup(3, ["NBF-2", "NBF-3"], {}, { source: tracker });
  store.set({ ...store.get(), entries: store.get().entries.map((e) => (e.ticket.key === "NBF-2" ? { ...e, plannedRepo: "nbl-ui-netbox" } : e)) });
  await pool.tick();
  assert.deepEqual([entry("NBF-2").phase, entry("NBF-3").phase], ["running", "queued"], "NBF-3 has no planned repository, so it waits as before");
  assert.equal(runStatus(entry("NBF-3"), store.get().entries), "blocked");
  const brief = readFileSync(join(ticketDir(settings, "NBF-2"), "brief.md"), "utf8");
  assert.ok(brief.includes(`- NBF-1: ${draft}, on branch \`nbf-1-fit\``), brief);
  assert.ok(brief.includes("ticket:worktree nbl-ui-netbox --from <branch>"));
});

/** Real git with every `GIT_*` scrubbed, for the pool's own reads of a clone's remote in these tests. */
const gitIn = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, env: sandboxGitEnv(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
/** The committer the real-repository tests commit as. */
const identity = ["-c", "user.name=t", "-c", "user.email=t@example.invalid"];

/** A bare `origin` with `main` pushed, and a clone of it: the real repositories a stacked run is rebased in. */
function originAndClone(prefix: string): { root: string; origin: string; clone: string } {
  const root = tmpDir(prefix);
  const origin = join(root, "origin.git");
  const clone = join(root, "nbl-ui-netbox");
  gitIn(root, ["init", "-q", "--bare", "-b", "main", origin]);
  gitIn(root, ["clone", "-q", origin, clone]);
  gitIn(clone, [...identity, "commit", "-q", "--allow-empty", "-m", "main"]);
  gitIn(clone, ["push", "-q", "origin", "HEAD:main"]);
  return { root, origin, clone };
}

test("A11-116: a ticket in a project that names a repository is planned for it, and starts on its blocker's branch once that branch is pushed, with no pull request", async () => {
  // The blocker's branch lives in a clone of this machine's `nbl-ui-netbox`, pushed to a bare origin, and is not pushed until the second pass.
  const { clone } = originAndClone("ticket-pool-stacked-branch-");
  gitIn(clone, ["checkout", "-q", "-b", "nbf-1-fit"]);
  gitIn(clone, [...identity, "commit", "-q", "--allow-empty", "-m", "blocker"]);
  const tracker: TicketSource = { ...source,
    blockers: async (keys) => new Map(keys.map((key) => [key, [{ key: "NBF-1", state: "started", status: "In Progress", branch: "nbf-1-fit", pulls: {} }]])),
    projectSummaries: async (keys) => new Map(keys.map((key) => [key, "github.com/a11ign/nbl-ui-netbox"])) };
  const { pool, entry, settings, store } = setup(3, ["NBF-2"], {}, { source: tracker, clones: { "nbl-ui-netbox": clone } });
  await pool.tick();
  assert.equal(entry("NBF-2").projectRepo, "nbl-ui-netbox", "the project's address names the repository, which is this machine's clone");
  assert.equal(entry("NBF-2").phase, "queued", "the blocker's branch is not pushed yet: the run waits");
  assert.equal(runStatus(entry("NBF-2"), store.get().entries), "blocked");
  assert.equal(waitNote(entry("NBF-2"), store.get().entries), "Waits for NBF-1 to push its branch");
  gitIn(clone, ["push", "-q", "origin", "nbf-1-fit"]);
  // The tracker read is what re-reads a waiting run's blockers, so its branch's push is seen on the next one, as on the server's cadence.
  await pool.refreshTracker();
  await pool.tick();
  assert.equal(entry("NBF-2").phase, "running", "pushed, with no pull request: the run starts on it");
  const brief = readFileSync(join(ticketDir(settings, "NBF-2"), "brief.md"), "utf8");
  assert.ok(brief.includes("- NBF-1: its branch `nbf-1-fit` is pushed in `nbl-ui-netbox`; there is no pull request yet"), brief);
  assert.ok(brief.includes("ticket:worktree nbl-ui-netbox --from <branch>"), "the worktree is made from the pushed branch");
});

/** Commit `text` to `file` in `cwd` as the test's committer, and return the new head. */
const commitTo = (cwd: string, file: string, text: string, message: string) => {
  writeFileSync(join(cwd, file), text);
  gitIn(cwd, ["add", file]);
  gitIn(cwd, [...identity, "commit", "-q", "-m", message]);
  return gitIn(cwd, ["rev-parse", "HEAD"]);
};

const BLOCKER = { key: "NBF-1", state: "started", status: "In Progress", branch: "nbf-1-fit", pulls: {} };
const PULL = { repo: "nbl-ui-netbox", url: "https://github.com/x/nbl-ui-netbox/pull/2" };
/** NBF-2 stopped with its pull request open, which the board resumes on a conflict: the state a stacked run's sweep merges in. */
const FINISHED_WATCHED = { phase: "finished", outcome: { kind: "ready-pr", prs: [PULL] }, workspace: undefined, finishedAt: 1 };

/**
 * NBF-2 stacked on NBF-1's branch `nbf-1-fit`, in a clone of `nbl-ui-netbox` on a bare origin. Its worktree is on its own branch, with its own commit
 * to `ticket.txt`, and its `stack-base.json` names the commit it was branched at. `setRun` sets the run's fields, and `moveBlocker` commits to the
 * blocker's branch and pushes it, returning the new head.
 */
function stackedRun(prefix: string) {
  const { root, clone } = originAndClone(prefix);
  gitIn(clone, ["checkout", "-q", "-b", "nbf-1-fit"]);
  commitTo(clone, "blocker.txt", "one\n", "blocker: first");
  gitIn(clone, ["push", "-q", "origin", "nbf-1-fit"]);
  const branchedAt = gitIn(clone, ["rev-parse", "HEAD"]);
  const made = setup(3, ["NBF-2"], { worktreeRoot: join(root, "tickets") }, { clones: { "nbl-ui-netbox": clone } });
  const worktree = worktreePath(made.settings.worktreeRoot, "NBF-2", "nbl-ui-netbox");
  gitIn(clone, ["worktree", "add", "-q", "-b", "nbf-2", worktree, "origin/nbf-1-fit"]);
  commitTo(worktree, "ticket.txt", "ours\n", "ticket: its work");
  gitIn(worktree, ["push", "-q", "origin", "HEAD:nbf-2"]);
  writeStackBase(stackBaseFile(made.settings, "NBF-2"), { repo: "nbl-ui-netbox", branch: "nbf-1-fit", sha: branchedAt });
  const setRun = (fields: Record<string, unknown>) => made.store.set({ ...made.store.get(), entries: made.store.get().entries.map((e) => (e.ticket.key === "NBF-2"
    ? { ...e, blockers: [BLOCKER], ...fields } : e)) });
  const moveBlocker = (file: string, text: string) => {
    const head = commitTo(clone, file, text, `blocker: ${file}`);
    gitIn(clone, ["push", "-q", "origin", "nbf-1-fit"]);
    return head;
  };
  return { ...made, clone, worktree, branchedAt, setRun, moveBlocker };
}

test("A11-150: a stacked run's blocker branch that moved is merged in by agent-org once its worker has stopped, and only noted while it runs", async () => {
  const { pool, entry, worktree, branchedAt, setRun, moveBlocker, clone } = stackedRun("ticket-pool-merge-");
  const own = gitIn(worktree, ["rev-parse", "HEAD"]);
  setRun({ phase: "running", outcome: undefined, workspace: "w1" });
  // The blocker's branch moves while the run's worker is still running: it is noted, and nothing is merged.
  const moved = moveBlocker("blocker.txt", "one\ntwo\n");
  await pool.rebaseStacked();
  assert.equal(gitIn(worktree, ["rev-parse", "HEAD~1"]), branchedAt, "a live worker's branch is left alone");
  assert.equal(entry("NBF-2").stackBase?.seen, moved);
  assert.equal(rebaseNote(entry("NBF-2")), "Will have NBF-1 merged in when the worker stops");
  // Its worker stopped: the next sweep merges the blocker's new head into the run's branch, and pushes its own branch.
  setRun(FINISHED_WATCHED);
  await pool.rebaseStacked();
  assert.equal(gitIn(worktree, ["rev-parse", "HEAD^2"]), moved, "the blocker's new head is merged into the run's branch");
  assert.equal(gitIn(worktree, ["rev-parse", "HEAD^1"]), own, "the run's own commit is the first parent");
  assert.equal(gitIn(clone, ["rev-parse", "origin/nbf-2"]), gitIn(worktree, ["rev-parse", "HEAD"]), "its own branch is pushed");
  assert.deepEqual(entry("NBF-2").stackBase, { key: "NBF-1", repo: "nbl-ui-netbox", branch: "nbf-1-fit", sha: moved, merged: { from: branchedAt, to: moved, at: 100 } });
  assert.equal(rebaseNote(entry("NBF-2")), `Merged NBF-1 into the branch by agent-org (${branchedAt.slice(0, 7)} → ${moved.slice(0, 7)})`);
});

test("A11-150: a stacked run whose blocker's moved branch conflicts with it is handed a conflict round by agent-org, and no person is asked", async () => {
  const { pool, entry, worktree, branchedAt, setRun, moveBlocker } = stackedRun("ticket-pool-stack-conflict-");
  setRun(FINISHED_WATCHED);
  const before = gitIn(worktree, ["rev-parse", "HEAD"]);
  const moved = moveBlocker("ticket.txt", "theirs\n");
  await pool.rebaseStacked();
  assert.deepEqual(entry("NBF-2").stackBase, { key: "NBF-1", repo: "nbl-ui-netbox", branch: "nbf-1-fit", sha: branchedAt, seen: moved, conflict: { head: moved, files: ["ticket.txt"] } },
    "still at the commit it was branched from, conflicted against the new head");
  assert.equal(gitIn(worktree, ["rev-parse", "HEAD"]), before, "the merge is aborted, and the run's branch is as it was");
  assert.equal(gitIn(worktree, ["status", "--porcelain"]), "", "no merge is left in progress");
  assert.deepEqual([entry("NBF-2").phase, entry("NBF-2").rounds], ["queued", 1], "the conflict round is queued for the run's own worker");
  assert.equal(entry("NBF-2").feedback, `${PULL.url} conflicts with its base branch nbf-1-fit.\nMerging NBF-1's branch \`nbf-1-fit\` conflicted in ticket.txt.`);
  assert.equal(rebaseNote(entry("NBF-2")), "Resolving a conflict with NBF-1 in ticket.txt", "the board names the conflict, not a person");
});

test("A11-150: a parked run's workspace is open, so the sweep merges nothing into its worktree; its round merges the base when it starts", async () => {
  const { pool, entry, worktree, branchedAt, setRun, moveBlocker, h } = stackedRun("ticket-pool-stack-parked-");
  setRun({ phase: "finished", outcome: { kind: "needs-human", reason: "which colour?" }, review: [PULL], workspace: "w1", finishedAt: 1 });
  const before = gitIn(worktree, ["rev-parse", "HEAD"]);
  moveBlocker("ticket.txt", "theirs\n");
  await pool.rebaseStacked();
  assert.equal(gitIn(worktree, ["rev-parse", "HEAD"]), before, "the worktree is left as it was");
  assert.deepEqual([entry("NBF-2").phase, entry("NBF-2").rounds, entry("NBF-2").stackBase?.sha], ["finished", undefined, branchedAt]);
  assert.equal(closes(h, "w1"), 0, "the parked workspace is not closed by the sweep");
});

test("A11-150: a conflicting merge at the board's round cap starts no round, and the note names the cap, not the conflict", async () => {
  const { pool, entry, setRun, moveBlocker } = stackedRun("ticket-pool-stack-capped-");
  setRun({ ...FINISHED_WATCHED, rounds: 3 });
  const moved = moveBlocker("ticket.txt", "theirs\n");
  await pool.rebaseStacked();
  assert.equal(entry("NBF-2").phase, "finished", "no round is queued");
  assert.match(entry("NBF-2").handedBack ?? "", /^The pull requests keep getting feedback: the board answered 3 rounds/);
  assert.deepEqual(entry("NBF-2").stackBase?.conflict, { head: moved, files: ["ticket.txt"], capped: 3 });
  assert.equal(rebaseNote(entry("NBF-2")), "The board's 3 rounds are used up before the merge with NBF-1 was resolved: Respond to review starts another");
});

test("A11-150: a finished run with no pull request is merged in when its blocker moves, and a conflict there starts no round", async () => {
  const { pool, entry, worktree, branchedAt, setRun, moveBlocker } = stackedRun("ticket-pool-stack-no-pull-");
  setRun({ phase: "finished", outcome: { kind: "checked", reason: "nothing to change" }, workspace: undefined, finishedAt: 1 });
  const moved = moveBlocker("blocker.txt", "one\ntwo\n");
  await pool.rebaseStacked();
  assert.equal(gitIn(worktree, ["rev-parse", "HEAD^2"]), moved, "the blocker's new head is merged in, as for any stacked run");
  assert.deepEqual(entry("NBF-2").stackBase, { key: "NBF-1", repo: "nbl-ui-netbox", branch: "nbf-1-fit", sha: moved, merged: { from: branchedAt, to: moved, at: 100 } });
});

test("A11-150: a draft run whose blocker's moved branch conflicts records nothing and starts no round: its approval merges the base in", async () => {
  const { pool, entry, worktree, branchedAt, setRun, moveBlocker } = stackedRun("ticket-pool-stack-draft-");
  setRun({ phase: "finished", outcome: { kind: "draft-pr", prs: [PULL] }, workspace: undefined, finishedAt: 1 });
  const before = gitIn(worktree, ["rev-parse", "HEAD"]);
  const moved = moveBlocker("ticket.txt", "theirs\n");
  await pool.rebaseStacked();
  assert.equal(gitIn(worktree, ["rev-parse", "HEAD"]), before, "the merge is aborted, and the branch is as it was");
  assert.deepEqual([entry("NBF-2").phase, entry("NBF-2").rounds, entry("NBF-2").stackBase], ["finished", undefined, { key: "NBF-1", repo: "nbl-ui-netbox", branch: "nbf-1-fit", sha: branchedAt, seen: moved }],
    "the head is seen, not recorded as a conflict: no note claims a round that does not exist");
  assert.equal(rebaseNote(entry("NBF-2")), null);
});

test("A11-150: a conflict the run's worker resolved by merging the blocker's branch in is cleared by the next sweep, and the run is branched from that head", async () => {
  const { pool, entry, worktree, setRun, moveBlocker } = stackedRun("ticket-pool-stack-cleared-");
  setRun(FINISHED_WATCHED);
  const moved = moveBlocker("ticket.txt", "theirs\n");
  await pool.rebaseStacked();
  assert.deepEqual(entry("NBF-2").stackBase?.conflict, { head: moved, files: ["ticket.txt"] }, "the conflict is recorded first");
  // The round's worker merges the base in by hand, keeps both changes, and pushes.
  assert.throws(() => gitIn(worktree, [...identity, "merge", "--no-edit", "origin/nbf-1-fit"]), "its own merge conflicts too");
  writeFileSync(join(worktree, "ticket.txt"), "both\n");
  gitIn(worktree, ["add", "ticket.txt"]);
  gitIn(worktree, [...identity, "commit", "-q", "--no-edit"]);
  gitIn(worktree, ["push", "-q", "origin", "HEAD:nbf-2"]);
  setRun(FINISHED_WATCHED);
  await pool.rebaseStacked();
  assert.equal(entry("NBF-2").stackBase?.conflict, undefined, "no conflict is named once its head is in the branch");
  assert.equal(entry("NBF-2").stackBase?.sha, moved, "the run is branched from the head the worker merged in");
});

test("A11-116: two tickets of one project run in order over real repositories: the second starts on the first's pushed branch before any pull request, and once the first merges its own is retargeted to the default branch, so both merge in order", async () => {
  const { root, clone } = originAndClone("ticket-pool-two-tickets-");
  const pullOne = "https://github.com/x/nbl-ui-netbox/pull/1";
  const pullTwo = "https://github.com/x/nbl-ui-netbox/pull/2";
  // What the tracker says of NBF-1, the blocker of NBF-2: its branch, and its pull request's state once one is open.
  const blockerPulls: Record<string, PullState> = {};
  const tracker: TicketSource = { ...source,
    blockers: async (keys) => new Map(keys.map((key) => [key, key === "NBF-2" ? [{ key: "NBF-1", state: "started", status: "In Progress", branch: "nbf-1", pulls: { ...blockerPulls } }] : []])),
    projectSummaries: async (keys) => new Map(keys.map((key) => [key, "github.com/a11ign/nbl-ui-netbox"])) };
  // The code host holds both pull requests: the second is stacked on the first's branch. Its sweep is the fake's, which moves a stacked pull request whose base merged to the default branch.
  const github = ghFor({});
  github.host.seedPull("x/nbl-ui-netbox", 1, { head: "nbf-1", base: "main" });
  github.host.seedPull("x/nbl-ui-netbox", 2, { head: "nbf-2", base: "nbf-1" });
  const { pool, entry, settings, status } = setup(2, ["NBF-1", "NBF-2"], { drafts: false, worktreeRoot: join(root, "tickets") }, { source: tracker, gh: github, clones: { "nbl-ui-netbox": clone } });
  await pool.tick();
  assert.deepEqual([entry("NBF-1").phase, entry("NBF-2").phase], ["running", "queued"], "the first starts; the second waits for its branch to be pushed");
  // The first's worker pushes its branch, with no pull request yet.
  gitIn(clone, ["checkout", "-q", "-b", "nbf-1"]);
  gitIn(clone, [...identity, "commit", "-q", "--allow-empty", "-m", "NBF-1: its work"]);
  gitIn(clone, ["push", "-q", "origin", "nbf-1"]);
  await pool.refreshTracker();
  await pool.tick();
  const second = entry("NBF-2");
  assert.equal(second.phase, "running", "the second starts on the pushed branch before any pull request exists");
  assert.ok(readFileSync(join(ticketDir(settings, "NBF-2"), "brief.md"), "utf8").includes("- NBF-1: its branch `nbf-1` is pushed in `nbl-ui-netbox`; there is no pull request yet"));
  // The second's worker makes its worktree the way ticket:worktree does, from the first's branch, and pushes its own.
  const made = await worktreeMain(["nbl-ui-netbox", "--from", "nbf-1"], { [TICKET_ENV.key]: "NBF-2", [TICKET_ENV.branch]: "nbf-2" }, () => settings);
  assert.equal(made.code, 0, made.out);
  const worktree = worktreePath(settings.worktreeRoot, "NBF-2", "nbl-ui-netbox");
  gitIn(worktree, [...identity, "commit", "-q", "--allow-empty", "-m", "NBF-2: its work"]);
  gitIn(worktree, ["push", "-q", "origin", "HEAD:nbf-2"]);
  assert.equal(gitIn(worktree, ["rev-parse", "HEAD~1"]), gitIn(clone, ["rev-parse", "origin/nbf-1"]), "its worktree sits on the first's pushed branch");
  // Both open their pull requests, the second based on the first's branch, and both finish.
  status.set(herdrName("NBF-1"), "idle");
  writeFileSync(join(ticketDir(settings, "NBF-1"), "outcome.json"), JSON.stringify({ kind: "ready-pr", prs: [{ repo: "nbl-ui-netbox", url: pullOne }] }));
  status.set(herdrName("NBF-2"), "idle");
  writeFileSync(join(ticketDir(settings, "NBF-2"), "outcome.json"), JSON.stringify({ kind: "ready-pr", prs: [{ repo: "nbl-ui-netbox", url: pullTwo }] }));
  await pool.tick();
  assert.deepEqual([entry("NBF-1").phase, entry("NBF-2").phase], ["finished", "finished"]);
  pool.retargetStacked();
  assert.deepEqual(github.host.retargets, [], "the first's pull request is still open: the second's base is current, so nothing moves");
  // The first merges: its branch lands on the default branch, the tracker says so, and the second's pull request is moved to the default branch.
  gitIn(clone, ["checkout", "-q", "main"]);
  gitIn(clone, [...identity, "merge", "-q", "--no-ff", "-m", "merge NBF-1", "nbf-1"]);
  gitIn(clone, ["push", "-q", "origin", "main"]);
  github.host.pullAt(pullOne)!.state = "merged";
  blockerPulls[pullOne] = "merged";
  await pool.refreshTracker();
  pool.retargetStacked();
  assert.deepEqual(github.host.retargets, [{ url: pullTwo, base: "main" }], "once the first merged, the second's pull request moves to the default branch, and nothing else moves");
  assert.equal(github.host.pullAt(pullTwo)?.base, "main");
  // The second merges after it, into the default branch that already holds the first's commits: no conflict, no hand edit.
  gitIn(clone, [...identity, "merge", "-q", "--no-ff", "-m", "merge NBF-2", "nbf-2"]);
  gitIn(clone, ["push", "-q", "origin", "main"]);
  github.host.pullAt(pullTwo)!.state = "merged";
  assert.deepEqual(gitIn(clone, ["log", "--format=%s", "origin/main"]).split("\n").filter((line) => line.startsWith("NBF-")), ["NBF-2: its work", "NBF-1: its work"], "both are on the default branch, the second's after the first's");
});

/** A review run, NBF-1, that ended with no outcome after it was seen working, and parked: its worker waited by ending its turn (NBF-1463). */
async function parkedReview() {
  const ctx = await approvedRun();
  ctx.status.set(herdrName("NBF-1"), "working");
  await ctx.pool.tick();
  ctx.status.set(herdrName("NBF-1"), "idle");
  await ctx.pool.tick();
  assert.deepEqual([ctx.entry("NBF-1").outcome?.kind, ctx.entry("NBF-1").workspace], ["no-outcome", "w2"], "parked mid-review");
  return ctx;
}

test("a parked review run whose worker wrote reviewed between two looks, never seen working, settles Ready to merge and closes its workspace", async () => {
  const { pool, entry, dir, h, status } = await parkedReview();
  await endWith({ pool, status }, dir, herdrName("NBF-1"), { kind: "reviewed" });
  assert.deepEqual(entry("NBF-1").outcome, { kind: "reviewed", prs: [approvedPr] });
  assert.equal(runStatus(entry("NBF-1")), "ready-to-merge");
  assert.equal(entry("NBF-1").workspace, undefined);
  assert.equal(closes(h, "w2"), 1);
  assert.ok(existsSync(join(dir, "outcome.json")), "the outcome is read where the worker wrote it, not moved aside");
});

test("a parked run stays parked on an outcome file written before it parked, and on the one it parked on", async () => {
  const { pool, entry, dir } = await parkedReview();
  writeFileSync(join(dir, "outcome.json"), JSON.stringify({ kind: "reviewed" }));
  utimesSync(join(dir, "outcome.json"), 0.05, 0.05);
  await pool.tick();
  assert.deepEqual([entry("NBF-1").outcome?.kind, entry("NBF-1").phase], ["no-outcome", "finished"], "a file older than the parking is not the run's new outcome");
  const handed = await endedOn({ kind: "needs-human", reason: "which colour?" });
  await handed.pool.tick();
  assert.deepEqual([handed.entry("NBF-1").outcome, handed.entry("NBF-1").workspace], [{ kind: "needs-human", reason: "which colour?" }, "w1"], "the outcome it parked on");
});

/** NBF-1 started on a machine that opens ready pull requests, its agent working: nothing has ended yet (A11-118). */
async function workingReadyRun() {
  const ctx = setup(1, ["NBF-1"], { drafts: false }, { gh: ghFor({ 1: feedbackPull({}) }) });
  await ctx.pool.tick();
  ctx.status.set(herdrName("NBF-1"), "working");
  await ctx.pool.tick();
  return ctx;
}

test("A11-118: a pool that reads `pr` for `prs` records the one pull request it names: the stop hook refuses that file, and the pool is the safety net", async () => {
  const ctx = setup(1, ["NBF-1"], { drafts: false }, { gh: ghFor({ 1: feedbackPull({}) }) });
  await ctx.pool.tick();
  ctx.status.set(herdrName("NBF-1"), "idle");
  writeFileSync(join(ticketDir(ctx.settings, "NBF-1"), "outcome.json"), JSON.stringify({ kind: "ready-pr", pr: approvedPr.url, reason: "the pull request is open" }));
  await ctx.pool.tick();
  assert.deepEqual(ctx.entry("NBF-1").outcome, { kind: "ready-pr", prs: [{ repo: "x/nbl-ui-netbox", url: approvedPr.url }] });
  assert.equal(runStatus(ctx.entry("NBF-1")), "awaiting-review");
});

test("A11-118: a parked run whose outcome file was unreadable, with its agent idle, ends on the corrected file with no Dismiss", async () => {
  const ctx = await workingReadyRun();
  ctx.status.set(herdrName("NBF-1"), "idle");
  const file = join(ticketDir(ctx.settings, "NBF-1"), "outcome.json");
  writeFileSync(file, JSON.stringify({ kind: "ready-pr", prs: "one", reason: "the pull request is open" }));
  await ctx.pool.tick();
  assert.deepEqual([ctx.entry("NBF-1").phase, ctx.entry("NBF-1").workspace, ctx.entry("NBF-1").outcome?.kind], ["finished", "w1", "needs-human"], "parked on the unreadable file");
  assert.equal(runStatus(ctx.entry("NBF-1")), "needs-you");
  writeFileSync(file, JSON.stringify({ kind: "ready-pr", prs: [approvedPr], reason: "the pull request is open" }));
  await ctx.pool.tick();
  assert.deepEqual([ctx.entry("NBF-1").phase, ctx.entry("NBF-1").workspace, ctx.entry("NBF-1").outcome], ["finished", undefined, { kind: "ready-pr", prs: [approvedPr] }]);
  assert.equal(runStatus(ctx.entry("NBF-1")), "awaiting-review");
});

test("A11-118: a finished run with no workspace whose outcome file was unreadable is read again when the file changes; a file that is still wrong changes nothing", async () => {
  const ctx = setup(1, ["NBF-1"], { drafts: false }, { gh: ghFor({ 1: feedbackPull({}) }) });
  const unreadable: Outcome = { kind: "needs-human", reason: "the worker's outcome file is not valid: ready-pr prs[0] needs url: a string, you wrote link", unreadable: true };
  ctx.store.set(finish(ctx.store.get(), "NBF-1", unreadable, 100));
  const file = join(ticketDir(ctx.settings, "NBF-1"), "outcome.json");
  mkdirSync(ticketDir(ctx.settings, "NBF-1"), { recursive: true });
  writeFileSync(file, JSON.stringify({ kind: "ready-pr", prs: [{ repo: "nbl-ui-netbox", link: approvedPr.url }], reason: "x" }));
  await ctx.pool.tick();
  assert.deepEqual(ctx.entry("NBF-1").outcome, unreadable, "the file is still wrong: nothing changes");
  writeFileSync(file, JSON.stringify({ kind: "ready-pr", prs: "one", reason: "x", again: true }));
  await ctx.pool.tick();
  assert.deepEqual([ctx.entry("NBF-1").phase, ctx.entry("NBF-1").outcome], ["finished", unreadable], "still wrong, rewritten: nothing changes either");
  writeFileSync(file, JSON.stringify({ kind: "ready-pr", prs: [approvedPr], reason: "x" }));
  await ctx.pool.tick();
  assert.deepEqual([ctx.entry("NBF-1").phase, ctx.entry("NBF-1").outcome], ["finished", { kind: "ready-pr", prs: [approvedPr] }], "corrected: the run ends on its real outcome");
  assert.equal(runStatus(ctx.entry("NBF-1")), "awaiting-review");
});

test("A11-118: a worker that writes `pr` for `prs` is refused at its stop naming prs, corrects the file in its turn, and the board shows the pull request awaiting review with no human step", async () => {
  const ctx = await workingReadyRun();
  const dir = ticketDir(ctx.settings, "NBF-1");
  const file = join(dir, "outcome.json");
  writeFileSync(file, JSON.stringify({ kind: "ready-pr", pr: approvedPr.url, reason: "the pull request is open" }));
  const refused = stopVerdict(dir);
  assert.equal(refused.code, 2, "POSITIVE: the stop is refused");
  assert.match(refused.say[0], /ready-pr needs prs: \[\{repo, url\}\], you wrote pr/, "naming prs");
  writeFileSync(file, JSON.stringify({ kind: "ready-pr", prs: [approvedPr], reason: "the pull request is open" }));
  assert.equal(stopVerdict(dir).code, 0, "CONTROL: the corrected file lets the stop through");
  ctx.status.set(herdrName("NBF-1"), "idle");
  await ctx.pool.tick();
  assert.deepEqual(ctx.entry("NBF-1").outcome, { kind: "ready-pr", prs: [approvedPr] });
  assert.equal(runStatus(ctx.entry("NBF-1")), "awaiting-review", "the board shows the pull request awaiting review, with no human step");
});

test("a parked run seen working after it wrote a new outcome keeps that outcome, and ends on it once idle", async () => {
  const { pool, entry, dir, status } = await parkedReview();
  writeFileSync(join(dir, "outcome.json"), JSON.stringify({ kind: "reviewed" }));
  status.set(herdrName("NBF-1"), "working");
  await pool.tick();
  assert.equal(entry("NBF-1").phase, "running");
  assert.ok(existsSync(join(dir, "outcome.json")), "not moved aside: it is the run's new outcome");
  status.set(herdrName("NBF-1"), "idle");
  await pool.tick();
  assert.equal(runStatus(entry("NBF-1")), "ready-to-merge");
});

/**
 * GitHub as the pool's tests see it (A11-160): the pull requests `pulls` describes, by number, in GitHub's own shapes, held by the code host (the fake) for every read of one, and a
 * `gh` for the calls the code host does not make yet, which only `withCi` answers (a failed check's job log, and its re-run). `pulls` is read as each read is made, so a test moves a pull
 * request by changing it; a number it has no answer for is one the code host cannot read, as `gh` refusing it was. The fake holds what the plugin would have made of the answer: the
 * feedback is worked out here from the description, as the plugin works it out from GitHub's (that is `plugins/github`'s own tests, not this file's).
 */
type World = { run: (args: string[]) => string; calls: string[][]; codeHost: CodeHost; host: ReturnType<typeof createFakeCodeHost> };

type Node = { author?: { login?: string } | null; state?: string; submittedAt?: string; createdAt?: string; commit?: { oid?: string }; body?: string; url?: string };
type Described = { state: string; headRefOid: string; mergeable: string; mergeStateStatus: string; baseRefName: string;
  files: { pageInfo: { hasNextPage: boolean }; nodes: { path: string }[] }; reviews: { nodes: Node[] }; comments: { nodes: Node[] };
  commits: { nodes: { commit: { statusCheckRollup: { contexts: { nodes: Record<string, any>[] } } } }[] } };

/** The files a described page lists, and whether it is all of them: a page that is missing or of another shape lists none and is not complete, as the plugin reads one. */
function filesOfDescribed(page: Partial<Described["files"]> | null | undefined): Pick<PullFeedback, "files" | "filesComplete"> {
  const valid = page !== null && typeof page === "object" && Array.isArray(page.nodes) && page.nodes.every((file) => typeof file?.path === "string") && typeof page.pageInfo?.hasNextPage === "boolean";
  return valid ? { files: page.nodes!.map(({ path }) => path), filesComplete: !page.pageInfo!.hasNextPage } : { files: [], filesComplete: false };
}

/** The feedback on a described pull request that is not `self`'s and not `ignored`'s: what the plugin reads of GitHub's answer. */
function feedbackOfDescribed(pull: Described, self: string, ignored: readonly string[]): Partial<PullFeedback> {
  const others = (author: Node["author"]) => author?.login !== undefined && author.login !== self && !ignored.includes(author.login);
  const items = [
    ...pull.reviews.nodes.filter((r) => ["COMMENTED", "CHANGES_REQUESTED"].includes(String(r.state)) && others(r.author)).map((r) => ({ at: Date.parse(r.submittedAt ?? ""), author: r.author!.login! })),
    ...pull.comments.nodes.filter((c) => others(c.author)).map((c) => ({ at: Date.parse(c.createdAt ?? ""), author: c.author!.login! })),
  ];
  const contexts = pull.commits.nodes[0].commit.statusCheckRollup.contexts.nodes;
  const required = new Set(contexts.filter((check) => check.isRequired === true).map((check) => String(check.name)));
  const red = corePolicy().redChecksOf({ rollup: contexts, labels: [] }).map(({ name, failedAt }) => ({ name, at: Number.isNaN(failedAt) ? null : failedAt,
    detailsUrl: (contexts.filter((check) => check.name === name).at(-1)?.detailsUrl ?? null) as string | null, counted: required.size === 0 || required.has(name) }));
  const failing = red.filter(({ counted }) => counted);
  const newest = (times: (number | null)[]) => times.reduce<number | null>((max, at) => (at !== null && (max === null || at > max) ? at : max), null);
  return {
    feedbackAt: newest(items.map(({ at }) => at)), authors: [...new Set(items.sort((x, y) => y.at - x.at).map(({ author }) => author))],
    failing: failing.map(({ name }) => name), failures: red.map(({ name, detailsUrl }) => ({ name, detailsUrl })), failedAt: newest(failing.map(({ at }) => at)),
    conflicting: pull.mergeable === "CONFLICTING" || pull.mergeStateStatus === "DIRTY", mergeable: pull.mergeable === "MERGEABLE",
    ...filesOfDescribed(pull.files),
  };
}

function ghFor(pulls: Record<number, unknown>): World {
  const calls: string[][] = [];
  const run = (args: string[]): string => {
    calls.push(args);
    throw new Error("gh exited 1");
  };
  const host = createFakeCodeHost("worker-bot");
  const described = (url: string) => pulls[Number(/\/pull\/(\d+)/.exec(url)?.[1])] as Described | undefined;
  /** The fake holds the pull request at `url` as it is described now, or says there is none. */
  const hold = (url: string, feedback: Partial<PullFeedback> = {}): boolean => {
    const pull = described(url);
    const match = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/.exec(url);
    if (pull === undefined || match === null) return false;
    const rollup = [GATE_GREEN, ...pull.commits.nodes[0].commit.statusCheckRollup.contexts.nodes];
    host.seedPull(match[1], Number(match[2]), {
      head: pull.headRefOid, base: pull.baseRefName, state: pull.state.toLowerCase() as "open" | "merged" | "closed", settled: rollup.every((check) => check.conclusion === "SUCCESS"), feedback,
      reviews: pull.reviews.nodes.map((r) => ({ author: r.author?.login ?? "", state: String(r.state), commit: r.commit?.oid ?? "", at: Date.parse(r.submittedAt ?? "") || 0 })),
      // The conversation comments that carry a text are the replies the plugin would read (A11-156); the fake keeps the ones the caller names.
      replies: pull.comments.nodes.filter((c) => typeof c.body === "string" && c.body !== "").map((c) => ({ author: c.author?.login ?? "", at: Date.parse(c.createdAt ?? "") || 0, url: c.url ?? "", text: c.body! })),
    });
    return true;
  };
  const codeHost: CodeHost = {
    ...host,
    readPullFeedback: (url, self, ignored = []) => {
      const pull = described(url);
      if (pull === undefined || !hold(url, feedbackOfDescribed(pull, self, ignored))) {
        host.calls.push(`readPullFeedback ${url}`);
        return null;
      }
      return host.readPullFeedback(url, self, ignored);
    },
    readReviewState: (url) => (hold(url) ? host.readReviewState(url) : null),
    readPullState: (url) => (hold(url) ? host.readPullState(url) : null),
    // The pull requests are in SWEPT_REPO only: every other repository the sweep asks about has none open.
    openPullUrlsOf: (repository) => {
      host.calls.push(`openPullUrlsOf ${repository}`);
      return repository !== SWEPT_REPO ? [] : Object.keys(pulls).filter((number) => (pulls[Number(number)] as Described).state === "OPEN").map((number) => `https://github.com/${SWEPT_REPO}/pull/${number}`);
    },
  };
  return { run, calls, codeHost, host };
}
const at = (ms: number) => new Date(ms).toISOString();
const feedbackPull = ({ state = "OPEN", head = "h1", reviews = [] as unknown[], comments = [] as unknown[], checks = [] as unknown[], mergeable = "MERGEABLE",
  mergeStateStatus = "CLEAN", base = "main", files = [] as string[], more = false } = {}) =>
  ({ state, headRefOid: head, mergeable, mergeStateStatus, baseRefName: base, files: { pageInfo: { hasNextPage: more, endCursor: more ? "c1" : null }, nodes: files.map((path) => ({ path })) },
    reviews: { nodes: reviews },
    comments: { nodes: comments }, reviewThreads: { nodes: [] }, commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: checks } } } }] } });
/** The gate's check on a head, green: a reviewer starts only where the checks have settled green. */
const GATE_GREEN = { name: "gate", status: "COMPLETED", conclusion: "SUCCESS" };

/** NBF-1 Ready to merge at 100, its review run ended, watched with `gh`. */
async function readyRun(gh: World, tickets: Record<string, unknown> = {}, reviewerPort?: ReviewerPort) {
  await loadReviewerGate();
  const ctx = await approvedRun(tickets, { gh, reviewerPort });
  ctx.status.set(herdrName("NBF-1"), "idle");
  writeFileSync(join(ctx.dir, "outcome.json"), JSON.stringify({ kind: "reviewed" }));
  await ctx.pool.tick();
  ctx.status.delete(herdrName("NBF-1"));
  assert.deepEqual([runStatus(ctx.entry("NBF-1")), ctx.entry("NBF-1").finishedAt], ["ready-to-merge", 100]);
  return ctx;
}
/** Let the tick that a feedback round wakes, which `watchFeedback` does not wait for, start the round. */
const roundStarted = async () => { for (let i = 0; i < 50; i += 1) await new Promise((resolve) => setImmediate(resolve)); };
/** Watches for feedback once, then waits for the round it starts. */
async function watchRound(pool: ReturnType<typeof createPool>) {
  pool.watchFeedback();
  await roundStarted();
}

test("new review feedback on a run Ready to merge starts a feedback round that resumes its worker and names the feedback; its own account's does not", async () => {
  const gh = ghFor({ 1: feedbackPull({
    reviews: [{ state: "COMMENTED", submittedAt: at(300), author: { login: "worker-bot" } }, { state: "CHANGES_REQUESTED", submittedAt: at(200), author: { login: "a11ign-reviewer" } }],
  }) });
  const { pool, entry, dir, h } = await readyRun(gh);
  h.calls.length = 0;
  await watchRound(pool);
  assert.deepEqual([entry("NBF-1").phase, entry("NBF-1").rounds, entry("NBF-1").review], ["running", 1, [approvedPr]]);
  assert.equal(entry("NBF-1").feedback, `New review feedback on ${approvedPr.url}, the newest from a11ign-reviewer.`);
  const start = h.calls.find((args) => args.includes("start"))!;
  const tail = start.slice(start.indexOf("--") + 1);
  assert.equal(tail[0], `New feedback reached this ticket's pull requests. Read ${dir}/brief.md and follow it.`);
  assert.deepEqual(tail.slice(tail.indexOf("--resume"), tail.indexOf("--resume") + 2), ["--resume", "session-t-nbf-1"]);
  assert.match(readFileSync(join(dir, "brief.md"), "utf8"), /feedback round for NBF-1/);
  assert.equal(gh.host.calls.filter((call) => call === "readOwnLogin").length, 1, "the account is read once");
});

test("feedback from before the run's last round ended, from the workers' own account, or on a pull request that could not be read starts no round", async () => {
  for (const [why, pulls] of [
    ["older than the round", { 1: feedbackPull({ comments: [{ createdAt: at(50), author: { login: "alice" } }] }) }],
    ["the workers' own", { 1: feedbackPull({ comments: [{ createdAt: at(500), author: { login: "worker-bot" } }] }) }],
    ["merged since", { 1: feedbackPull({ state: "MERGED", comments: [{ createdAt: at(500), author: { login: "alice" } }] }) }],
    ["could not ask", {}],
  ] as const) {
    const gh = ghFor(pulls);
    const { pool, entry } = await readyRun(gh);
    const logged = await captureStderr(async () => { pool.watchFeedback(); await roundStarted(); });
    assert.deepEqual([entry("NBF-1").phase, entry("NBF-1").rounds], ["finished", undefined], why);
    const said = logged.some((line) => line.includes(`NBF-1: the feedback on ${approvedPr.url} could not be read, so it was not checked`));
    assert.equal(said, why === "could not ask", `${why}: an unread pull request is said in the board's log, and only that`);
  }
});

test("a check that is red at the head commit starts a round naming it, and a run the board does not watch is never read", async () => {
  const gh = ghFor({ 1: feedbackPull({ checks: [{ __typename: "CheckRun", name: "typecheck", conclusion: "FAILURE", completedAt: at(400), isRequired: false }] }) });
  const { pool, entry } = await readyRun(gh);
  pool.watchFeedback();
  assert.equal(entry("NBF-1").feedback, `typecheck failed on the head commit of ${approvedPr.url}; its log could not be read.`, "a check with no job page has no log to quote, and is named as such");
  const unwatched = ghFor({});
  const { pool: other } = setup(1, ["NBF-1"], {}, { gh: unwatched });
  other.watchFeedback();
  assert.deepEqual([unwatched.calls, unwatched.host.calls], [[], []], "nothing Ready to merge: GitHub is not asked, not even who the workers are");
});

test("what triggers a round names each pull request's new feedback and nothing older than the round, and leaves failed checks to the check rule", () => {
  const read = { state: "open" as const, feedbackAt: 200, authors: ["alice", "bob"], failing: ["typecheck", "suite"], failures: [], failedAt: 300, conflicting: false, mergeable: true, head: null, approvedAtHead: false, base: "main", files: [], filesComplete: true };
  assert.equal(feedbackSince([{ url: "u1", read }], 100), "New review feedback on u1, the newest from alice.", "failed checks are answered once for each head, with their log lines, not here (A11-154)");
  assert.equal(feedbackSince([{ url: "u1", read }], 250), null, "a failed check newer than the round names nothing here either");
  assert.equal(feedbackSince([{ url: "u1", read }], 300), null);
  assert.equal(feedbackSince([{ url: "u1", read: { ...read, state: "closed" } }], 100), null);
});

test("A11-82: a pull request that conflicts with its base names its base on every watch, whatever the round's time, and a closed one is not named", () => {
  const read = { state: "open" as const, feedbackAt: null, authors: [], failing: [], failures: [], failedAt: null, conflicting: true, mergeable: false, head: null, approvedAtHead: false, base: "main", files: [], filesComplete: true };
  const line = "https://github.com/acme/repo/pull/7 conflicts with its base branch main.";
  assert.equal(feedbackSince([{ url: "https://github.com/acme/repo/pull/7", read }], 900), line, "a conflict is a state, so no time passes it by");
  assert.equal(feedbackSince([{ url: "https://github.com/acme/repo/pull/7", read: { ...read, state: "merged" as const } }], 0), null);
});

/**
 * A tracker whose download writes each ticket's plan file, which declares the paths `paths` gives it as its `## Paths` section. `refuse` runs
 * before each download, so a test can make the tracker refuse one.
 */
/** `max` workers, the tickets of `paths` queued, and one pass of the pool: `down` names the tickets whose plans cannot be downloaded (A11-125). */
async function queuedWithPlans(max: number, paths: Record<string, string[]>, down: Set<string>) {
  const ctx = setup(max, Object.keys(paths), { plan: "-plan-[^/]*\\.md$" }, { source: planFilesDown(paths, down) });
  await ctx.pool.tick();
  return ctx;
}

/** `planFiles`, whose download refuses the tickets in `down`, as a link that is gone does. */
function planFilesDown(paths: Record<string, string[]>, down: Set<string>): TicketSource {
  return planFiles(paths, (key) => {
    if (down.has(key)) throw new Error("the attachment link is gone");
  });
}

function planFiles(paths: Record<string, string[]>, refuse: (key: string) => void = () => {}): TicketSource {
  return { ...source, download: async (ticket, dir) => {
    refuse(ticket.key);
    const file = join(dir, `${ticket.key}-plan-x.md`);
    writeFileSync(file, `## Paths\n${(paths[ticket.key] ?? []).map((path) => `- \`${path}\``).join("\n")}\n`);
    return [file];
  } };
}

/** NBF-1 started on `tickets`, then ended on pull requests of `kind` (draft or ready), watched with `gh` and not approved. */
async function endedWithPulls(gh: World, tickets: Record<string, unknown>, kind: "draft-pr" | "ready-pr") {
  const ctx = setup(1, ["NBF-1"], tickets, { gh });
  await ctx.pool.tick();
  ctx.status.set(herdrName("NBF-1"), "idle");
  writeFileSync(join(ticketDir(ctx.settings, "NBF-1"), "outcome.json"), JSON.stringify({ kind, prs: [approvedPr] }));
  await ctx.pool.tick();
  ctx.status.delete(herdrName("NBF-1"));
  return ctx;
}

/** NBF-1 finished with a draft pull request, watched with `gh` and not approved: a draft is read for its footprint, and never woken. */
async function draftRun(gh: World) {
  const ctx = await endedWithPulls(gh, {}, "draft-pr");
  assert.equal(runStatus(ctx.entry("NBF-1")), "awaiting-review");
  return ctx;
}

/** NBF-1 finished with ready pull requests, on a machine that opens them ready, so no Approve comes and the board watches them. */
async function readyPrRun(gh: World) {
  const ctx = await endedWithPulls(gh, { drafts: false }, "ready-pr");
  assert.equal(runStatus(ctx.entry("NBF-1")), "awaiting-review");
  return ctx;
}

test("A11-82: a pull request that conflicts with its base resumes its worker once, the round names the conflict and its base, and the brief has the worker merge the base in", async () => {
  const gh = ghFor({ 1: feedbackPull({ mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" }) });
  const { pool, entry, dir, h } = await readyRun(gh);
  h.calls.length = 0;
  pool.watchFeedback();
  pool.watchFeedback();
  await roundStarted();
  assert.deepEqual([entry("NBF-1").phase, entry("NBF-1").rounds, entry("NBF-1").review], ["running", 1, [approvedPr]]);
  assert.equal(entry("NBF-1").feedback, `${approvedPr.url} conflicts with its base branch main.`);
  const starts = h.calls.filter((args) => args.includes("start"));
  assert.equal(starts.length, 1, "the same worker is started once, not once per watch");
  assert.deepEqual(starts[0].slice(starts[0].indexOf("--resume"), starts[0].indexOf("--resume") + 2), ["--resume", "session-t-nbf-1"]);
  const brief = readFileSync(join(dir, "brief.md"), "utf8");
  assert.match(brief, /^1\. The text above says a pull request conflicts with its base branch\. Merge the base branch into your branch before anything else: `git fetch`, then `git merge origin\/<base>`/m);
  assert.match(brief, /Never rebase, and never force-push\. Resolve each conflict keeping both changes' intent/, "never a rebase, and both changes kept");
  assert.match(brief, /^3\. Fix each finding that is right/m, "the feedback steps follow, renumbered after the merge");
});

test("A11-82: a conflict on a run awaiting review is a round too, and a draft's read records the files it changes without waking the worker", async () => {
  const gh = ghFor({ 1: feedbackPull({ mergeable: "CONFLICTING", files: ["src/ticket-mode/pool.ts"] }) });
  const ready = await readyPrRun(gh);
  ready.pool.watchFeedback();
  assert.deepEqual([ready.entry("NBF-1").phase, ready.entry("NBF-1").rounds], ["queued", 1], "a ready-pr run waiting for review is watched");
  const draft = await draftRun(ghFor({ 1: feedbackPull({ mergeable: "CONFLICTING", files: ["src/ticket-mode/pool.ts"] }) }));
  draft.pool.watchFeedback();
  await roundStarted();
  assert.deepEqual([draft.entry("NBF-1").phase, draft.entry("NBF-1").rounds, draft.entry("NBF-1").pullFiles], ["finished", undefined, { [approvedPr.url]: ["src/ticket-mode/pool.ts"] }],
    "a draft is not woken, and its files are kept for the footprint");
});

test("A11-82: a merged pull request that reads conflicting gets no round, and a run at its cap hands a conflict to a person, whose Respond to review starts again", async () => {
  const merged = await readyRun(ghFor({ 1: feedbackPull({ state: "MERGED", mergeable: "CONFLICTING" }) }));
  merged.pool.watchFeedback();
  await roundStarted();
  assert.deepEqual([merged.entry("NBF-1").phase, merged.entry("NBF-1").rounds], ["finished", undefined], "merged: nothing to resolve");

  const capped = await readyRun(ghFor({ 1: feedbackPull({ mergeable: "CONFLICTING" }) }));
  capped.store.set({ ...capped.store.get(), entries: capped.store.get().entries.map((e) => (e.ticket.key === "NBF-1" ? { ...e, rounds: 3 } : e)) });
  capped.h.calls.length = 0;
  capped.pool.watchFeedback();
  await roundStarted();
  assert.equal(capped.entry("NBF-1").phase, "finished", "the fourth conflict starts no run");
  assert.equal(capped.h.calls.filter((args) => args.includes("start")).length, 0);
  assert.equal(capped.entry("NBF-1").handedBack, `The pull requests keep getting feedback: the board answered 3 rounds on its own and stopped. Respond to review starts another. The latest: ${approvedPr.url} conflicts with its base branch main.`);
  capped.store.set(respond(capped.store.get(), "NBF-1", 200));
  await capped.pool.tick();
  assert.deepEqual([capped.entry("NBF-1").phase, capped.entry("NBF-1").rounds, capped.entry("NBF-1").asked], ["running", undefined, true], "Respond to review starts the count again");
});

/**
 * NBF-1, a review run that asked a person a question and parked: its worker wrote `needs-human` with its workspace still open, as a review run
 * whose checks did not start does. The worker's session is the one the review run resumed (`session-t-nbf-1`).
 */
async function parkedOnQuestion(gh: World, tracker?: TicketSource) {
  const ctx = await approvedRun({}, { gh, tracker });
  ctx.status.set(herdrName("NBF-1"), "working");
  await ctx.pool.tick();
  writeFileSync(join(ctx.dir, "outcome.json"), JSON.stringify({ kind: "needs-human", reason: "which colour?" }));
  ctx.status.set(herdrName("NBF-1"), "idle");
  await ctx.pool.tick();
  assert.deepEqual([ctx.entry("NBF-1").phase, ctx.entry("NBF-1").outcome?.kind, ctx.entry("NBF-1").workspace], ["finished", "needs-human", "w2"], "parked on a question");
  return ctx;
}

test("A11-89: a parked run whose pull request conflicts is resumed: its workspace is closed once, the same worker resumes once with the conflict named, and its brief merges the base in", async () => {
  const { pool, entry, dir, h } = await parkedOnQuestion(ghFor({ 1: feedbackPull({ mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" }) }));
  h.calls.length = 0;
  pool.watchFeedback();
  await watchRound(pool);
  assert.deepEqual([entry("NBF-1").phase, entry("NBF-1").rounds, entry("NBF-1").review], ["running", 1, [approvedPr]]);
  assert.equal(entry("NBF-1").feedback, `${approvedPr.url} conflicts with its base branch main.`);
  const starts = h.calls.filter((args) => args.includes("start"));
  assert.equal(closes(h, "w2"), 1, "the parked workspace is closed once, before the round starts");
  const brief = readFileSync(join(dir, "brief.md"), "utf8");
  assert.equal(starts.length, 1, "the same worker is started once, not once per watch");
  assert.deepEqual(starts[0].slice(starts[0].indexOf("--resume"), starts[0].indexOf("--resume") + 2), ["--resume", "session-t-nbf-1"]);
  assert.match(brief, /^1\. The text above says a pull request conflicts with its base branch\. Merge the base branch into your branch before anything else/m);
  assert.equal(existsSync(join(dir, "outcome.json")), false, "the needs-human it parked on is cleared, so it does not end this round");
});

test("A11-89: a parked run whose pull request is clear, unknown, or has only new review feedback is left alone", async () => {
  const pulls = [
    feedbackPull({ mergeable: "MERGEABLE", mergeStateStatus: "CLEAN" }),
    feedbackPull({ mergeable: "UNKNOWN", mergeStateStatus: "UNKNOWN" }),
    feedbackPull({ reviews: [{ state: "CHANGES_REQUESTED", submittedAt: at(300), author: { login: "a11ign-reviewer" } }] }),
  ];
  for (const pull of pulls) {
    const { pool, entry, h } = await parkedOnQuestion(ghFor({ 1: pull }));
    h.calls.length = 0;
    pool.watchFeedback();
    await roundStarted();
    assert.deepEqual([entry("NBF-1").phase, entry("NBF-1").rounds, entry("NBF-1").workspace, entry("NBF-1").outcome?.kind], ["finished", undefined, "w2", "needs-human"],
      "a parked run with no conflict is not woken, and keeps its question");
    assert.deepEqual(h.calls, [], "no workspace is closed and no worker is started");
  }
});

test("A11-89: a parked run whose conflicting pull request merged, or whose run was stopped, gets no round", async () => {
  const gh = ghFor({ 1: feedbackPull({ state: "MERGED", mergeable: "CONFLICTING" }) });
  const merged = await parkedOnQuestion(gh);
  await watchRound(merged.pool);
  assert.deepEqual([merged.entry("NBF-1").phase, merged.entry("NBF-1").rounds], ["finished", undefined], "merged: nothing to resolve");

  const stopped = await parkedOnQuestion(ghFor({ 1: feedbackPull({ mergeable: "CONFLICTING" }) }));
  stopped.store.set({ ...stopped.store.get(), entries: stopped.store.get().entries.map((e) => (e.ticket.key === "NBF-1" ? { ...e, outcome: { kind: "stopped" as const } } : e)) });
  stopped.h.calls.length = 0;
  stopped.pool.watchFeedback();
  await roundStarted();
  assert.deepEqual([stopped.entry("NBF-1").phase, stopped.entry("NBF-1").rounds, stopped.entry("NBF-1").workspace], ["finished", undefined, "w2"], "stopped is a person's act");
  assert.deepEqual(stopped.h.calls, [], "nothing is closed or started");
});

test("A11-89: a parked run whose workspace herdr will not close stays parked, names it in the log, and the next watch asks again", async () => {
  const gh = ghFor({ 1: feedbackPull({ mergeable: "CONFLICTING" }) });
  const { pool, entry, h } = await parkedOnQuestion(gh);
  h.refused.add("close");
  const logged = await captureStderr(async () => { pool.watchFeedback(); await roundStarted(); });
  assert.deepEqual([entry("NBF-1").phase, entry("NBF-1").rounds, entry("NBF-1").workspace], ["finished", undefined, "w2"], "still parked, no round queued");
  assert.ok(logged.some((line) => line.includes("NBF-1: its workspace could not be closed, so the conflict round was not started")), logged.join("\n"));
  h.refused.clear();
  pool.watchFeedback();
  await roundStarted();
  assert.deepEqual([entry("NBF-1").phase, entry("NBF-1").rounds], ["running", 1], "the next watch asks again, and the round starts");
});

test("A11-89: a parked run at the cap of rounds is left parked: nothing is closed or started", async () => {
  const gh = ghFor({ 1: feedbackPull({ mergeable: "CONFLICTING" }) });
  const capped = await parkedOnQuestion(gh);
  capped.store.set({ ...capped.store.get(), entries: capped.store.get().entries.map((e) => (e.ticket.key === "NBF-1" ? { ...e, rounds: 3 } : e)) });
  capped.h.calls.length = 0;
  await watchRound(capped.pool);
  assert.deepEqual([capped.entry("NBF-1").phase, capped.entry("NBF-1").rounds, capped.entry("NBF-1").workspace, capped.entry("NBF-1").handedBack], ["finished", 3, "w2", undefined]);
  assert.deepEqual(capped.h.calls, [], "nothing is closed or started");
});

test("A11-82: a run waits on a path a live run holds and starts once that run's pull request merges, while runs sharing no path start beside both", async () => {
  const planned = setup(3, ["NBF-1", "NBF-2", "NBF-3"], { plan: "-plan-[^/]*\\.md$" }, { source: planFiles({
    "NBF-1": ["nbl-ui-netbox:src/a.ts"], "NBF-2": ["nbl-ui-netbox:src/"], "NBF-3": ["nbl-ui-platform-libs:src/a.ts"],
  }) });
  const { pool, entry, store, status } = planned;
  await pool.tick();
  assert.deepEqual([entry("NBF-1").phase, entry("NBF-2").phase, entry("NBF-3").phase], ["running", "queued", "running"], "NBF-2 shares src/ with NBF-1; NBF-3 shares no path");
  assert.equal(runStatus(entry("NBF-2"), store.get().entries), "blocked");
  assert.equal(waitNote(entry("NBF-2"), store.get().entries), "Waits on NBF-1: both touch src/");
  status.set(herdrName("NBF-1"), "idle");
  writeFileSync(join(ticketDir(planned.settings, "NBF-1"), "outcome.json"), JSON.stringify({ kind: "draft-pr", prs: [approvedPr] }));
  await pool.tick();
  status.delete(herdrName("NBF-1"));
  await pool.tick();
  assert.equal(entry("NBF-2").phase, "queued", "a draft holds its path until its pull request merges");
  store.set(recordPullStates(store.get(), new Map([["NBF-1", { [approvedPr.url]: "merged" }]])));
  await pool.tick();
  assert.equal(entry("NBF-2").phase, "running", "once it merged, NBF-2 starts");
});

test("A11-82: a finished run's open pull request holds the files the watch read from it: a run that shares one waits until it merges", async () => {
  const gh = ghFor({ 1: feedbackPull({ files: ["src/ticket-mode/server.ts"] }) });
  const { pool, entry, store, status } = setup(1, ["NBF-1", "NBF-2"], { plan: "-plan-[^/]*\\.md$" }, { gh: gh, source: planFiles({
    "NBF-1": ["nbl-ui-netbox:src/a.ts"], "NBF-2": ["nbl-ui-netbox:src/ticket-mode/server.ts"],
  }) });
  await pool.tick();
  assert.equal(entry("NBF-2").phase, "queued", "one slot: NBF-2 waits for it");
  // NBF-1 ends with its draft open, and the watch reads its files before the next start: NBF-2's own plan names none of them.
  status.delete(herdrName("NBF-1"));
  store.set(finish(store.get(), "NBF-1", { kind: "draft-pr", prs: [approvedPr] }, 150));
  pool.watchFeedback();
  await pool.tick();
  assert.equal(entry("NBF-2").phase, "queued", "NBF-1's pull request changes the file NBF-2 changes, so NBF-2 is held");
  assert.equal(waitNote(entry("NBF-2"), store.get().entries), "Waits on NBF-1 #1: both touch src/ticket-mode/server.ts");
  store.set(recordPullStates(store.get(), new Map([["NBF-1", { [approvedPr.url]: "closed" }]])));
  await pool.tick();
  assert.equal(entry("NBF-2").phase, "running", "a pull request closed unmerged frees the path too");
});

// A11-125: a run's pull request files are footprinted the moment its run ends, not at the next watch, so a run sharing one is held from then.
test("A11-125: a run that has just finished with an open pull request holds that pull request's files before any watch, so a run sharing one waits from the moment it ends", async () => {
  const gh = ghFor({ 1: feedbackPull({ files: ["src/ticket-mode/server.ts"] }) });
  const { pool, entry, store, status, settings } = setup(1, ["NBF-1", "NBF-2"], { plan: "-plan-[^/]*\\.md$" }, { gh: gh, source: planFiles({
    "NBF-1": ["nbl-ui-netbox:src/a.ts"], "NBF-2": ["nbl-ui-netbox:src/ticket-mode/server.ts"],
  }) });
  await pool.tick();
  assert.equal(entry("NBF-2").phase, "queued", "one slot: NBF-2 waits for it");
  // NBF-1 ends with its draft open, and the start pass after its end runs with no watch in between: NBF-2's own plan names none of its files.
  status.set(herdrName("NBF-1"), "idle");
  writeFileSync(join(ticketDir(settings, "NBF-1"), "outcome.json"), JSON.stringify({ kind: "draft-pr", prs: [approvedPr] }));
  await pool.tick();
  assert.equal(entry("NBF-1").phase, "finished", "NBF-1 ended");
  assert.deepEqual(entry("NBF-1").pullFiles, { [approvedPr.url]: ["src/ticket-mode/server.ts"] }, "its files are recorded at once");
  assert.equal(entry("NBF-2").phase, "queued", "NBF-2 shares one of them, so it waits from the moment NBF-1 ends");
  assert.equal(waitNote(entry("NBF-2"), store.get().entries), "Waits on NBF-1 #1: both touch src/ticket-mode/server.ts");
});

// A11-125: when a finished run's pull request cannot be read at its end, it holds its repository until a watch reads its files.
test("A11-125: when a run's pull request files cannot be read at its end, the run holds its repository until a watch reads them, and then only what it changes", async () => {
  const pulls: Record<number, unknown> = {};
  const { pool, entry, store, status, settings } = setup(1, ["NBF-1", "NBF-2"], { plan: "-plan-[^/]*\\.md$" }, { gh: ghFor(pulls), source: planFiles({
    "NBF-1": ["nbl-ui-netbox:src/a.ts"], "NBF-2": ["nbl-ui-netbox:docs/guide.md"],
  }) });
  await pool.tick();
  status.set(herdrName("NBF-1"), "idle");
  writeFileSync(join(ticketDir(settings, "NBF-1"), "outcome.json"), JSON.stringify({ kind: "draft-pr", prs: [approvedPr] }));
  await pool.tick();
  assert.equal(entry("NBF-1").pullFiles, undefined, "its files could not be read at its end, so none are recorded");
  assert.equal(entry("NBF-2").phase, "queued", "NBF-2 shares a repository with the unread pull request, so it waits");
  assert.equal(waitNote(entry("NBF-2"), store.get().entries), "Waits on NBF-1 #1: its changed files are not read yet");
  pulls[1] = feedbackPull({ files: ["README.md"] });
  pool.watchFeedback();
  await pool.tick();
  assert.deepEqual(entry("NBF-1").pullFiles, { [approvedPr.url]: ["README.md"] }, "the watch reads and records them");
  assert.equal(entry("NBF-2").phase, "running", "what it changes does not touch docs/guide.md, so NBF-2 starts");
});

test("A11-82: a paused queue reads no plan, and reads each one once it is unpaused", async () => {
  let reads = 0;
  const tracker = planFiles({ "NBF-1": ["nbl-ui-netbox:src/a.ts"] }, () => { reads += 1; });
  const { pool, store, entry } = setup(1, ["NBF-1"], { plan: "-plan-[^/]*\\.md$" }, { source: tracker });
  store.set(pauseQueue(store.get()));
  await pool.tick();
  assert.deepEqual([reads, entry("NBF-1").phase], [0, "queued"], "a paused queue starts nothing, so it downloads nothing either");
  store.set(resumeQueue(store.get()));
  await pool.tick();
  assert.equal(entry("NBF-1").phase, "running");
});

test("A11-82: tickets queued and planned together whose plans share a path, with no order between them, are worked one after the other", async () => {
  const tracker = batchTracker(planFiles({ "NBF-1": ["nbl-ui-netbox:src/a.ts"], "NBF-2": ["nbl-ui-netbox:src/a.ts"] })).tracker;
  let ran: ReturnType<typeof setup> | undefined;
  await captureStderr(async () => {
    ran = setup(2, ["NBF-1", "NBF-2"], BATCH_PLANNER, { source: tracker, planFirst: ["NBF-1", "NBF-2"], batch: true });
    await ran.pool.tick();
    const plan = join(batchDir(ran.settings, BATCH), "plan");
    put(join(plan, "NBF-1", "NBF-1-0001-plan-a.md"), "# A\n");
    put(join(plan, "NBF-2", "NBF-2-0001-plan-b.md"), "# B\n");
    put(join(plan, "order.json"), JSON.stringify({ "NBF-1": { repo: "nbl-ui-netbox", after: [] }, "NBF-2": { repo: "nbl-ui-netbox", after: [] } }));
    await endWith(ran, batchDir(ran.settings, BATCH), herdrName(BATCH), { kind: "planned" });
    await settled();
    await ran.pool.tick();
  });
  const { entry, store } = ran!;
  assert.deepEqual([entry("NBF-1").phase, entry("NBF-2").phase], ["running", "queued"], "two slots free, one shared file: the second waits");
  assert.equal(runStatus(entry("NBF-2"), store.get().entries), "blocked");
  assert.equal(waitNote(entry("NBF-2"), store.get().entries), "Waits on NBF-1: both touch src/a.ts");
});

test("A11-117: a pull request whose file list was cut short holds only the files listed, so a run whose own paths are not among them starts beside it", async () => {
  const listed = feedbackPull({ files: ["src/ticket-mode/server.ts"] });
  for (const [why, pull, phase] of [
    ["every file was listed and none is NBF-2's: it starts", listed, "running"],
    ["the files run past the pages read, and NBF-2's is not among those read: it starts", feedbackPull({ files: ["src/ticket-mode/server.ts"], more: true }), "running"],
    ["the page of files did not come back at all, so none is listed: it starts", { ...listed, files: undefined }, "running"],
    ["the page of files came back in another shape, so none is listed: it starts", { ...listed, files: { nodes: "all of them" } }, "running"],
    ["a file among those read is NBF-2's: it waits on the listed file", feedbackPull({ files: ["docs/unrelated.md"], more: true }), "queued"],
  ] as const) {
    const gh = ghFor({ 1: pull });
    const { pool, entry, store, status } = setup(1, ["NBF-1", "NBF-2"], { plan: "-plan-[^/]*\\.md$" }, { gh: gh, source: planFiles({
      "NBF-1": ["nbl-ui-netbox:src/a.ts"], "NBF-2": ["nbl-ui-netbox:docs/unrelated.md"],
    }) });
    await pool.tick();
    status.delete(herdrName("NBF-1"));
    store.set(finish(store.get(), "NBF-1", { kind: "draft-pr", prs: [approvedPr] }, 150));
    await captureStderr(async () => { pool.watchFeedback(); });
    await pool.tick();
    assert.equal(entry("NBF-2").phase, phase, why);
    if (phase === "queued") assert.equal(waitNote(entry("NBF-2"), store.get().entries), "Waits on NBF-1 #1: both touch docs/unrelated.md");
  }
});

test("A11-117: two queued tickets in one repository whose plans list .acceptance/ and .changeset/ and different source files both start at once, neither waiting", async () => {
  const scaffold = ["nbl-ui-netbox:.acceptance/", "nbl-ui-netbox:.changeset/"];
  const { pool, entry, store } = setup(2, ["NBF-1", "NBF-2"], { plan: "-plan-[^/]*\\.md$" }, { source: planFiles({
    "NBF-1": [...scaffold, "nbl-ui-netbox:src/a.ts"], "NBF-2": [...scaffold, "nbl-ui-netbox:src/b.ts"],
  }) });
  await pool.tick();
  assert.deepEqual([entry("NBF-1").phase, entry("NBF-2").phase], ["running", "running"], "both start at once");
  assert.deepEqual([waitNote(entry("NBF-1"), store.get().entries), waitNote(entry("NBF-2"), store.get().entries)], [null, null], "neither waits");
});

// A11-125: a plan the tracker cannot give holds only its own run, which waits and says why, and the rest start. A run whose plan is unread takes no slot.
test("A11-125: a plan that cannot be downloaded waits and says why, and the rest start, its run taking no slot", async () => {
  const down = new Set(["NBF-1"]);
  const { pool, entry, store } = await queuedWithPlans(2, { "NBF-1": ["nbl-ui-netbox:src/a.ts"], "NBF-2": ["nbl-ui-netbox:src/b.ts"], "NBF-3": ["nbl-ui-netbox:src/c.ts"] }, down);
  assert.deepEqual([entry("NBF-1").phase, entry("NBF-2").phase, entry("NBF-3").phase], ["queued", "running", "running"], "the two slots go to the two whose plans are read");
  assert.equal(entry("NBF-1").pathsFailure, "the attachment link is gone");
  assert.equal(runStatus(entry("NBF-1"), store.get().entries), "blocked", "the run shows Blocked");
  assert.equal(waitNote(entry("NBF-1"), store.get().entries), "Waits: its plan could not be downloaded (the attachment link is gone); the board asks again on every pass");
  down.clear();
  await pool.tick();
  assert.equal(entry("NBF-1").pathsFailure, undefined, "read on the next pass, the failure is cleared");
  assert.equal(entry("NBF-1").phase, "queued", "it still waits for a slot: the other two hold both");
});

// A11-125: while one plan fails, runs that overlap in the same pass still never start together.
test("A11-125: overlapping runs still never start in one pass while another ticket's plan fails", async () => {
  const down = new Set(["NBF-1"]);
  const { pool, entry, store } = await queuedWithPlans(3, { "NBF-1": ["nbl-ui-netbox:src/z.ts"], "NBF-2": ["nbl-ui-netbox:src/a.ts"], "NBF-3": ["nbl-ui-netbox:src/a.ts"] }, down);
  assert.deepEqual([entry("NBF-1").phase, entry("NBF-2").phase, entry("NBF-3").phase], ["queued", "running", "queued"], "NBF-3 shares src/a.ts with NBF-2, and waits for it");
  assert.equal(waitNote(entry("NBF-3"), store.get().entries), "Waits on NBF-2: both touch src/a.ts");
  down.clear();
  await pool.tick();
  assert.equal(entry("NBF-1").phase, "running", "read later, NBF-1 shares no path with NBF-2 and starts beside it");
  assert.equal(entry("NBF-3").phase, "queued", "NBF-3 still waits for NBF-2");
});

const PUBLISH = { publish: { run: "Run the post-pr-to-slack skill on these pull requests, all in one go: {prs}. Then write {dir}/published.json",
  connectors: ["^mcp__plugin_slack_slack__slack_send_message$"] } };

/** NBF-1 Ready to merge on a machine that publishes, Publish pressed for it, and the publish run started. */
async function publishing() {
  const ctx = await readyRun(ghFor({}), PUBLISH);
  const { pool, store, settings } = ctx;
  store.set(pauseQueue(queuePublish(store.get(), ["NBF-1"], 300)));
  ctx.h.calls.length = 0;
  await pool.tick();
  const publish = store.get().publish!;
  return { ...ctx, publish, name: herdrName(`publish-${publish.id}`), pdir: publishDir(settings, publish.id) };
}

test("Publish starts one publish run in a folder of its own, on haiku at low effort, with the hook's mark naming the connectors only it may call", async () => {
  const { h, publish, pdir } = await publishing();
  assert.equal(publish.phase, "running", "it starts though workers are paused");
  const start = h.calls.find((args) => args.includes("start"))!;
  const tail = start.slice(start.indexOf("--") + 1);
  assert.equal(tail[0], `Read ${pdir}/brief.md and follow it.`);
  assert.ok(tail.join(" ").includes("--model haiku --effort low"));
  assert.deepEqual(JSON.parse(readFileSync(join(pdir, "publish-run"), "utf8")), { connectors: PUBLISH.publish.connectors });
  assert.ok(readFileSync(join(pdir, "brief.md"), "utf8").includes(`all in one go: ${approvedPr.url}. Then write ${pdir}/published.json`));
});

test("a started publish run records its workspace and pane, which the board's page links for each run it posts", async () => {
  const { publish } = await publishing();
  assert.deepEqual([publish.workspace, publish.pane], ["w3", "w3:p1"]);
});

test("a publish run that writes published marks each run it posted Published, linking the first message, and closes its workspace", async () => {
  const { pool, status, entry, h, store, name, pdir, publish } = await publishing();
  status.set(name, "working");
  await pool.tick();
  writeFileSync(join(pdir, "published.json"), JSON.stringify({ links: ["https://x.slack.com/archives/C1/p1", "https://x.slack.com/archives/C2/p2"] }));
  writeFileSync(join(pdir, "outcome.json"), JSON.stringify({ kind: "published" }));
  status.set(name, "idle");
  await pool.tick();
  assert.deepEqual(entry("NBF-1").published, { link: "https://x.slack.com/archives/C1/p1", at: 100 });
  assert.equal(runStatus(entry("NBF-1")), "published");
  assert.equal(store.get().publish?.phase, "finished");
  assert.equal(closes(h, publish.workspace!), 1);
});

test("a publish run that fails leaves its runs Ready to merge and says why", async () => {
  for (const [outcome, links, why] of [
    [{ kind: "needs-human", reason: "no channel for nbl-ui-netbox" }, null, "no channel for nbl-ui-netbox"],
    [{ kind: "published" }, null, "does not hold"],
    [{ kind: "published" }, { links: ["not a link"] }, "does not hold"],
  ] as const) {
    const { pool, status, entry, store, name, pdir } = await publishing();
    status.set(name, "working");
    await pool.tick();
    if (links !== null) writeFileSync(join(pdir, "published.json"), JSON.stringify(links));
    writeFileSync(join(pdir, "outcome.json"), JSON.stringify(outcome));
    status.set(name, "idle");
    await pool.tick();
    assert.equal(runStatus(entry("NBF-1")), "ready-to-merge", why);
    assert.match(store.get().publish?.failure ?? "", new RegExp(why));
  }
});

test("a publish run's outcome is read with its links file: needs-human and any other kind are failures, and links must be web addresses", () => {
  const dir = tmpDir("ticket-publish-result-");
  assert.deepEqual(publishResult("{", dir), { failure: "its outcome file could not be read: {" });
  assert.deepEqual(publishResult("null", dir), { failure: "its outcome file could not be read: null" });
  assert.deepEqual(publishResult(JSON.stringify({ kind: "reviewed" }), dir), { failure: 'it wrote the outcome "reviewed", which a publish run cannot end on' });
  writeFileSync(join(dir, "published.json"), JSON.stringify({ links: [] }));
  assert.deepEqual(publishResult(JSON.stringify({ kind: "published" }), dir), { links: [] }, "a channel that gave no link still published");
});

test("a parked run that wrote a new outcome while a dialog waits on a person is left for the person, and settles once its agent is idle", async () => {
  const { pool, entry, dir, status } = await parkedReview();
  writeFileSync(join(dir, "outcome.json"), JSON.stringify({ kind: "reviewed" }));
  await agentIs({ pool, status }, herdrName("NBF-1"), "blocked");
  assert.deepEqual([entry("NBF-1").outcome?.kind, entry("NBF-1").workspace], ["no-outcome", "w2"]);
  status.set(herdrName("NBF-1"), "idle");
  await pool.tick();
  assert.equal(runStatus(entry("NBF-1")), "ready-to-merge");
});

test("Respond to review resumes the worker, told a person asked it to answer the feedback", async () => {
  const { pool, entry, dir, h, store } = await readyRun(ghFor({}));
  store.set(respond(store.get(), "NBF-1", 300));
  h.calls.length = 0;
  await pool.tick();
  const start = h.calls.find((args) => args.includes("start"))!;
  const tail = start.slice(start.indexOf("--") + 1);
  assert.equal(entry("NBF-1").phase, "running");
  assert.equal(tail[0], `A person asked you to answer the feedback on this ticket's pull requests. Read ${dir}/brief.md and follow it.`);
  assert.deepEqual(tail.slice(tail.indexOf("--resume"), tail.indexOf("--resume") + 2), ["--resume", "session-t-nbf-1"]);
  assert.match(readFileSync(join(dir, "brief.md"), "utf8"), /A person asked you to answer the current feedback/);
});

test("a publish run that never ends is failed after 30 minutes, so it does not hold its slot and every later Publish for ever", async () => {
  const { pool, status, entry, store, name, publish } = await publishing();
  status.set(name, "idle");
  await pool.tick();
  assert.equal(store.get().publish?.phase, "running", "idle before it ever worked is not an end");
  store.set({ ...store.get(), publish: { ...store.get().publish!, startedAt: 100 - 30 * 60_000 - 1 } });
  await pool.tick();
  assert.deepEqual([store.get().publish?.phase, store.get().publish?.failure], ["finished", "it did not finish within 30 minutes"]);
  assert.equal(runStatus(entry("NBF-1")), "ready-to-merge");
  assert.ok(publish.workspace);
});

test("a publish run that stops without an outcome, or whose workspace is gone, fails and says so", async () => {
  const stopped = await publishing();
  stopped.status.set(stopped.name, "working");
  await stopped.pool.tick();
  stopped.status.set(stopped.name, "idle");
  await stopped.pool.tick();
  assert.equal(stopped.store.get().publish?.failure, "it stopped without writing an outcome");
  const gone = await publishing();
  gone.status.delete(gone.name);
  await gone.pool.tick();
  await gone.pool.tick();
  assert.equal(gone.store.get().publish?.failure, "its herdr workspace is gone");
});

test("a drafts-off run's ticket dir carries the ready mark and a brief that opens a ready pull request; a drafts-on run carries neither", async () => {
  for (const drafts of [false, true]) {
    const made = setup(1, ["NBF-1"], { drafts });
    await made.pool.tick();
    const dir = ticketDir(made.settings, "NBF-1");
    const brief = readFileSync(join(dir, "brief.md"), "utf8");
    assert.equal(existsSync(join(dir, "ready-run")), !drafts, `the ready mark with drafts ${drafts}`);
    assert.equal(brief.includes("pr:open create --draft"), drafts, `the draft command with drafts ${drafts}`);
    assert.equal(brief.includes("gh pr create"), false, `no brief sends a worker to gh pr create with drafts ${drafts}`);
    assert.equal(brief.includes("open ONE READY pull request"), !drafts, `the ready step with drafts ${drafts}`);
  }
});

test("with no tickets.publish, Publish starts no run and posts nothing: the request fails saying so, and the runs stay Ready to merge", async () => {
  const gh = ghFor({});
  const ctx = await readyRun(gh);
  ctx.store.set(pauseQueue(queuePublish(ctx.store.get(), ["NBF-1"], 300)));
  ctx.h.calls.length = 0;
  gh.calls.length = 0;
  gh.host.calls.length = 0;
  await ctx.pool.tick();
  const publish = ctx.store.get().publish!;
  assert.match(publish.failure ?? "", /tickets\.publish/, "the failure names the setting");
  assert.equal(ctx.h.calls.some((args) => args.includes("start")), false, "no publish agent starts");
  assert.equal(existsSync(join(publishDir(ctx.settings, publish.id), "brief.md")), false, "no publish run folder is written");
  assert.deepEqual([gh.calls, gh.host.reviewRequests, gh.host.armed, gh.host.retargets], [[], [], [], []], "GitHub is not written to: no gh call, no review requested, no merge armed, no base moved");
  assert.equal(runStatus(ctx.entry("NBF-1")), "ready-to-merge", "the run stays Ready to merge, unpublished");
});

/** The tickets with the reviewer on, for a machine that is not drafts. */
const REVIEWING = { reviewer: "atomic", drafts: false };

/** The teardown a fake reviewer port does not exercise: nothing is closed, retired or listed. */
const idleTeardown: Pick<ReviewerPort, "close" | "retire" | "listedPulls"> = { close: () => ({ state: "gone" }), retire: () => ({ retired: true, report: null }), listedPulls: () => [] };

/** The verdict a fake reviewer port does not exercise (A11-83): its reviewer is still working, so nothing is posted, prompted or said. */
const idleVerdict: Pick<ReviewerPort, "settled" | "verdictFileOf" | "repostVerdict" | "reprompt"> = {
  settled: () => "working", verdictFileOf: () => null, repostVerdict: () => ({ posted: true }), reprompt: () => ({ prompted: true }),
};

/** A reviewer port that records each start and reports none live, so only the pool's own once-per-head memory stops a second start. */
function fakeReviewer() {
  const starts: ReviewerRef[] = [];
  const port: ReviewerPort = { start(ref) { starts.push(ref); return { label: "reviewer-7" }; }, live: () => false, ...idleTeardown, ...idleVerdict };
  return { port, starts };
}

/** NBF-1 Ready to merge with `port` as its reviewer and its pull requests read from `pulls`, after one feedback watch. */
async function reviewedRun(port: ReviewerPort, pulls: Record<number, unknown>) {
  const ctx = await readyRun(ghFor(pulls), REVIEWING, port);
  ctx.pool.watchFeedback();
  await roundStarted();
  return ctx;
}

/** NBF-1 Ready to merge, and one watch after it has started its reviewer for h1: `pulls` is read from then on. */
async function startedFor(port: ReviewerPort, pulls: Record<number, unknown>) {
  const ctx = await readyRun(ghFor(pulls), REVIEWING, port);
  await watchRound(ctx.pool);
  return ctx;
}

/** Ends the feedback round a watch started: its worker is idle and writes a reviewed outcome, which settles the run Ready to merge again. */
async function finishRound({ pool, status, dir }: { pool: ReturnType<typeof createPool>; status: Map<string, string>; dir: string }) {
  status.set(herdrName("NBF-1"), "idle");
  writeFileSync(join(dir, "outcome.json"), JSON.stringify({ kind: "reviewed" }));
  await pool.tick();
  status.delete(herdrName("NBF-1"));
}

test("a restarted pool starts no second reviewer on a head it already reviewed", async () => {
  const { port, starts } = fakeReviewer();
  const pulls = { 1: feedbackPull() };
  const gh = ghFor(pulls);
  const ctx = await readyRun(gh, REVIEWING, port);
  ctx.pool.watchFeedback();
  await roundStarted();
  assert.deepEqual(starts.map((ref) => ref.head), ["h1"], "the reviewer starts once for h1");
  ctx.restart().watchFeedback();
  await roundStarted();
  assert.deepEqual(starts.map((ref) => ref.head), ["h1"], "a restarted pool does not start a second reviewer on h1");
  pulls[1] = feedbackPull({ head: "h2" });
  ctx.restart().watchFeedback();
  await roundStarted();
  assert.deepEqual(starts.map((ref) => ref.head), ["h1", "h2"], "a head it has not reviewed is still reviewed after the restart");
});

test("a reviewer is recorded before it starts: an instance stopped while it started one starts no second one after the restart", async () => {
  const starts: ReviewerRef[] = [];
  // The instance stops inside `start`, after the reviewer's workspace is open and before `start` returns.
  const port: ReviewerPort = { start(ref) { starts.push(ref); throw new Error("SIGTERM"); }, live: () => false, ...idleTeardown, ...idleVerdict };
  const ctx = await readyRun(ghFor({ 1: feedbackPull() }), REVIEWING, port);
  assert.throws(() => ctx.pool.watchFeedback(), /SIGTERM/);
  assert.ok(readReviewerMemory(reviewerMemoryPath(ctx.settings.stateDir)).memory.started.has(`${approvedPr.url}@h1`), "on disk before the start");
  ctx.restart().watchFeedback();
  await roundStarted();
  assert.deepEqual(starts.map((ref) => ref.head), ["h1"], "the reviewer for h1 is started once");
});

test("a reviewer herdr still lists for the head is adopted, not started, and stays adopted across a restart", async () => {
  const starts: ReviewerRef[] = [];
  let listed = true;
  const port: ReviewerPort = { start(ref) { starts.push(ref); return { label: "reviewer-7" }; }, live: ({ head }) => listed && head === "h1", ...idleTeardown, ...idleVerdict };
  const ctx = await readyRun(ghFor({ 1: feedbackPull() }), REVIEWING, port);
  ctx.pool.watchFeedback();
  await roundStarted();
  assert.deepEqual(starts, [], "the reviewer already running for h1 is adopted");
  assert.ok(readReviewerMemory(reviewerMemoryPath(ctx.settings.stateDir)).memory.started.has(`${approvedPr.url}@h1`), "and remembered as started");
  listed = false;
  ctx.restart().watchFeedback();
  await roundStarted();
  assert.deepEqual(starts, [], "a restart after it finished starts none for h1");
});

test("a reviewer start the port refuses is not remembered, so the next watch tries again", async () => {
  const starts: ReviewerRef[] = [];
  let refuse = true;
  const port: ReviewerPort = { start(ref) { starts.push(ref); return refuse ? { refusal: "herdr did not list the session" } : { label: "reviewer-7" }; }, live: () => false, ...idleTeardown, ...idleVerdict };
  const ctx = await readyRun(ghFor({ 1: feedbackPull() }), REVIEWING, port);
  await captureStderr(async () => { ctx.pool.watchFeedback(); await roundStarted(); });
  assert.equal(readReviewerMemory(reviewerMemoryPath(ctx.settings.stateDir)).memory.started.size, 0);
  refuse = false;
  ctx.restart().watchFeedback();
  await roundStarted();
  assert.equal(starts.length, 2, "refused once, then started");
});

test("a restarted pool asks for no second round for a verdict it already answered", async () => {
  const { port } = fakeReviewer();
  const gh = ghFor({ 1: feedbackPull({ reviews: [{ state: "CHANGES_REQUESTED", submittedAt: at(200), author: { login: REVIEWER_LOGIN }, commit: { oid: "h1" } }] }) });
  const ctx = await readyRun(gh, REVIEWING, port);
  ctx.pool.watchFeedback();
  await roundStarted();
  assert.deepEqual([ctx.entry("NBF-1").phase, ctx.entry("NBF-1").rounds], ["running", 1], "the reviewer's changes are asked for once");
  await finishRound(ctx);
  assert.equal(runStatus(ctx.entry("NBF-1")), "ready-to-merge", "the round ends Ready to merge again");
  ctx.restart().watchFeedback();
  await roundStarted();
  assert.deepEqual([ctx.entry("NBF-1").phase, ctx.entry("NBF-1").rounds], ["finished", 1], "a restarted pool asks no second round for the verdict it already answered");
});

test("a machine with tickets.drafts true starts no reviewer, and one with tickets.drafts false does", async () => {
  for (const drafts of [true, false]) {
    const { port, starts } = fakeReviewer();
    const gh = ghFor({ 1: feedbackPull() });
    const ctx = await readyRun(gh, { reviewer: "atomic", drafts }, port);
    gh.host.calls.length = 0;
    ctx.pool.watchFeedback();
    await roundStarted();
    assert.equal(starts.length, drafts ? 0 : 1, `drafts ${drafts}: the reviewer starts`);
    assert.equal(gh.host.calls.some((call) => call.startsWith("readReviewState")), !drafts, `drafts ${drafts}: the pull request is read for a reviewer only when drafts is off`);
  }
});

test("the reviewer's own review never moves feedbackAt: its comment after the round ended starts no round, and a person's comment after the round still does", async () => {
  for (const [why, commentAt, rounds] of [["the reviewer's comment alone", 50, undefined], ["a person's comment after the round", 150, 1]] as const) {
    const gh = ghFor({ 1: feedbackPull({
      reviews: [{ state: "COMMENTED", submittedAt: at(300), author: { login: REVIEWER_LOGIN }, commit: { oid: "h1" } }],
      comments: [{ createdAt: at(commentAt), author: { login: "alice" } }],
    }) });
    const ctx = await readyRun(gh, REVIEWING, fakeReviewer().port);
    ctx.pool.watchFeedback();
    await roundStarted();
    assert.equal(ctx.entry("NBF-1").rounds, rounds, why);
  }
});

test("the reviewer's verdict on the head reaches the worker: changes requested starts a round that names the reviewer, and an approval starts none", async () => {
  for (const [state, rounds] of [["CHANGES_REQUESTED", 1], ["APPROVED", undefined]] as const) {
    const ctx = await reviewedRun(fakeReviewer().port, { 1: feedbackPull({ reviews: [{ state, submittedAt: at(200), author: { login: REVIEWER_LOGIN }, commit: { oid: "h1" } }] }) });
    assert.equal(ctx.entry("NBF-1").rounds, rounds, state);
    if (rounds !== undefined) assert.ok(ctx.entry("NBF-1").feedback?.includes(`${REVIEWER_LOGIN} requested changes on ${approvedPr.url} at h1`), state);
  }
});

test("a reviewer memory file that cannot be read is said once in the board's log, nothing is remembered from it, and a valid one is written over it", async () => {
  const { port, starts } = fakeReviewer();
  const ctx = await readyRun(ghFor({ 1: feedbackPull() }), REVIEWING, port);
  ctx.pool.watchFeedback();
  await roundStarted();
  assert.equal(starts.length, 1, "the reviewer starts once");
  writeFileSync(reviewerMemoryPath(ctx.settings.stateDir), "{ not json");
  const logged = await captureStderr(async () => {
    ctx.restart().watchFeedback();
    await roundStarted();
    ctx.restart().watchFeedback();
    await roundStarted();
  });
  assert.equal(starts.length, 2, "nothing is remembered from the unreadable file, so the restarted pool starts once more; the next restart remembers it");
  const said = logged.filter((line) => line.includes("cannot be read"));
  assert.equal(said.length, 1, "said once");
  assert.ok(said[0].includes("reviewers.json"), "the log names the file");
});

test("a checked outcome is read with its reason, ends the run Checked rather than Needs you, and closes its workspace at once", async () => {
  assert.deepEqual(parseOutcome(JSON.stringify({ kind: "checked", reason: "the toast already shows" })), { kind: "checked", reason: "the toast already shows" });
  const { entry, h } = await endedOn({ kind: "checked", reason: "the toast already shows" }, 1, ["NBF-1", "NBF-2"]);
  assert.deepEqual([entry("NBF-1").phase, entry("NBF-1").outcome], ["finished", { kind: "checked", reason: "the toast already shows" }]);
  assert.equal(runStatus(entry("NBF-1")), "checked", "nothing is asked of the person");
  assert.deepEqual([entry("NBF-1").workspace, entry("NBF-1").pane], [undefined, undefined], "not parked: nobody will answer its agent");
  assert.equal(closes(h, "w1"), 1, "its workspace is closed as the outcome is recorded");
  assert.equal(entry("NBF-2").phase, "running", "the slot it freed is filled");
});

test("a parked run whose worker then writes checked or planned has its workspace closed as that outcome is recorded", async () => {
  const { pool, status, entry, settings, h } = await endedOn({ kind: "needs-human", reason: "which colour?" });
  assert.equal(closes(h, "w1"), 0, "POSITIVE CONTROL: a needs-human run stays open for the person's answer");
  status.set(herdrName("NBF-1"), "working");
  await pool.tick();
  writeFileSync(join(ticketDir(settings, "NBF-1"), "outcome.json"), JSON.stringify({ kind: "checked", reason: "the person said it is fixed already" }));
  status.set(herdrName("NBF-1"), "idle");
  await pool.tick();
  assert.deepEqual([entry("NBF-1").outcome?.kind, entry("NBF-1").workspace], ["checked", undefined]);
  assert.equal(closes(h, "w1"), 1);
  // A planning run's `planned` closes its workspace too: "a planning run that writes planned has its plan attached ..." above asserts it.
});

/**
 * A tracker that holds NBF-1 in `In Progress` and completes it, updates its text and reads it back, recording each call. `control` holds, refuses or
 * answers each call: `hold` keeps `complete` open, `refuse` throws from it, and `note` is the tracker's answer when it cannot complete the ticket.
 */
function doneTracker(title = "Old title") {
  const { tracker: base, current } = stateTracker();
  const calls: { op: string; args: unknown[] }[] = [];
  const control = { hold: null as Promise<void> | null, refuse: null as string | null, note: null as string | null, refuseUpdate: false, title };
  const tracker: TicketSource = { ...base,
    read: async (key) => ({ ...ticket(key), title: control.title, description: "Old description" }),
    complete: async (key, comment) => {
      calls.push({ op: "complete", args: [key, comment] });
      if (control.hold !== null) await control.hold;
      if (control.refuse !== null) throw new Error(control.refuse);
      if (control.note !== null) return control.note;
      current.set(key, "Done");
      return null;
    },
    updateTicketText: async (key, text) => {
      calls.push({ op: "updateTicketText", args: [key, text] });
      if (control.refuseUpdate) throw new Error("Linear refused the update");
      control.title = text.title ?? control.title;
    } };
  return { tracker, current, calls, control };
}

/** The run of NBF-1 ended on `outcome`, with its ticket held In Progress as the board holds a worked ticket. */
const doneRun = (outcome: Record<string, unknown>, made: ReturnType<typeof doneTracker>, extra: Record<string, unknown> = {}) =>
  endedOn(outcome, 1, ["NBF-1"], { workingState: "In Progress" }, { source: made.tracker, ...extra });

test("A11-91: a done outcome is read with its reason and evidence, and a bare or evidence-less done is needs-human naming what it lacks", () => {
  const evidence = ["npm test: 12 pass", "the toast shows on refresh (read src/toast.ts:40)"];
  assert.deepEqual(parseOutcome(JSON.stringify({ kind: "done", reason: "every Done-when holds", evidence })), { kind: "done", reason: "every Done-when holds", evidence });
  for (const bad of [{ kind: "done", reason: "verified" }, { kind: "done", reason: "verified", evidence: [] }, { kind: "done", reason: "verified", evidence: ["  "] }]) {
    const read = parseOutcome(JSON.stringify(bad));
    assert.equal(read.kind, "needs-human", JSON.stringify(bad));
    assert.match(read.kind === "needs-human" ? read.reason : "", /^the worker's outcome file is not valid: done (needs evidence|evidence\[0\] needs)/, "the reason names the evidence it lacks");
  }
  const bare = parseOutcome(JSON.stringify({ kind: "done", evidence: ["e"] }));
  assert.match(bare.kind === "needs-human" ? bare.reason : "", /done needs reason: a string, you wrote no reason/);
});

test("A11-91: a done outcome completes its ticket through the tracker, posts the reason and evidence on it, closes the workspace, and the run is Completed", async () => {
  const made = doneTracker();
  const evidence = ["npm test: 12 pass", "the toast shows on refresh (read src/toast.ts:40)"];
  const { entry, h, pool } = await doneRun({ kind: "done", reason: "every Done-when holds", evidence }, made);
  await settled();
  assert.equal(made.calls.length, 1, "the tracker is asked once");
  assert.equal(made.calls[0].op, "complete");
  const [key, comment] = made.calls[0].args as [string, string];
  assert.equal(key, "NBF-1");
  assert.equal(comment, "every Done-when holds\n\nEvidence:\n- npm test: 12 pass\n- the toast shows on refresh (read src/toast.ts:40)\n\nCompleted by the ticket board on the worker's verified outcome.");
  assert.equal(made.current.get("NBF-1"), "Done", "the ticket is in the completed state");
  assert.equal(entry("NBF-1").movedFrom, undefined, "its move is cleared, so nothing puts the ticket back");
  assert.deepEqual([entry("NBF-1").phase, entry("NBF-1").outcome?.kind], ["finished", "done"]);
  assert.equal(runStatus(entry("NBF-1")), "completed");
  assert.equal(closes(h, "w1"), 1, "its workspace is closed as the outcome is recorded");
  assert.equal(made.current.get("NBF-1"), "Done", "and no restore put it back to Todo after the completion");
  void pool;
});

test("A11-91: a checked outcome leaves its ticket open: the tracker is not asked to complete it, and the ticket goes back to where it was", async () => {
  const made = doneTracker();
  const { entry } = await doneRun({ kind: "checked", reason: "nothing to change" }, made);
  await settled();
  assert.deepEqual(made.calls, [], "no completion, no comment");
  assert.equal(made.current.get("NBF-1"), "Todo", "checked is not finished: the ticket is put back where the board found it");
  assert.equal(runStatus(entry("NBF-1")), "checked");
});

/** Give NBF-1 the sub-issues the tracker reports for it while its run is live, as a child opened after the ticket was queued would. */
const withOpenChildren = (made: ReturnType<typeof setup>, children: string[]) => {
  const queue = made.store.get();
  made.store.set({ ...queue, entries: queue.entries.map((e) => (e.ticket.key === "NBF-1" ? { ...e, ticket: { ...e.ticket, children } } : e)) });
};

/** NBF-1 is running, then its worker writes `outcome`, and the run ends. */
async function finishRunning(made: ReturnType<typeof setup>, outcome: Record<string, unknown>) {
  await made.pool.tick();
  made.status.set(herdrName("NBF-1"), "working");
  await made.pool.tick();
  writeFileSync(join(ticketDir(made.settings, "NBF-1"), "outcome.json"), JSON.stringify(outcome));
  made.status.set(herdrName("NBF-1"), "idle");
  await made.pool.tick();
  await settled();
  return made;
}

test("A11-91: a done is refused as needs-human, and the ticket left alone, for a parent with open sub-issues, a planning run, and a review run", async () => {
  const parent = doneTracker();
  const made = setup(1, ["NBF-1"], { workingState: "In Progress" }, { source: parent.tracker });
  await made.pool.tick();
  withOpenChildren(made, ["NBF-2", "NBF-3"]);
  await finishRunning(made, { kind: "done", reason: "all verified", evidence: ["e"] });
  assert.deepEqual(parent.calls, [], "the children complete it, not its own done");
  assert.equal(made.entry("NBF-1").outcome?.kind, "needs-human");
  assert.match((made.entry("NBF-1").outcome as { reason: string }).reason, /NBF-1 has open sub-issues \(NBF-2, NBF-3\), which complete it, not its own done: all verified/);

  const planning = doneTracker();
  const plan = setup(1, ["NBF-1"], PLANNER, { source: planning.tracker, planFirst: ["NBF-1"] });
  await finishRunning(plan, { kind: "done", reason: "verified", evidence: ["e"] });
  assert.deepEqual(planning.calls, [], "a planning run completes no ticket");
  assert.match((plan.entry("NBF-1").outcome as { reason: string }).reason, /planning run, which completes no ticket/);

  const review = doneTracker();
  const reviewing = setup(1, ["NBF-1"], { workingState: "In Progress" }, { source: review.tracker });
  await reviewing.pool.tick();
  const queue = reviewing.store.get();
  reviewing.store.set({ ...queue, entries: queue.entries.map((e) => (e.ticket.key === "NBF-1" ? { ...e, review: [] } : e)) });
  await finishRunning(reviewing, { kind: "done", reason: "verified", evidence: ["e"] });
  assert.deepEqual(review.calls, [], "a review run's ticket completes when its pull requests merge");
  assert.match((reviewing.entry("NBF-1").outcome as { reason: string }).reason, /review run: its ticket completes when its pull requests merge/);
});

test("A11-91: a done that the tracker cannot complete hands the run to a person with the worker's reason and the tracker's, and the ticket is left where it is", async () => {
  const noState = doneTracker();
  noState.control.note = "NBF-1's team has no completed state, so it stays in In Progress";
  const { entry } = await doneRun({ kind: "done", reason: "verified", evidence: ["e"] }, noState);
  await settled();
  assert.equal(entry("NBF-1").outcome?.kind, "needs-human");
  assert.equal(noState.current.get("NBF-1"), "In Progress", "the ticket is untouched");
  assert.match((entry("NBF-1").outcome as { reason: string }).reason, /NBF-1 was not completed \(NBF-1's team has no completed state.*\): verified/);

  const refused = doneTracker();
  refused.control.refuse = "Linear did not move NBF-1 to Done";
  const again = await doneRun({ kind: "done", reason: "verified", evidence: ["e"] }, refused);
  await settled();
  assert.equal(again.entry("NBF-1").outcome?.kind, "needs-human");
  assert.match((again.entry("NBF-1").outcome as { reason: string }).reason, /could not be completed \(Linear did not move NBF-1 to Done\): verified/);
  assert.equal(refused.current.get("NBF-1"), "In Progress");
  assert.equal(runStatus(again.entry("NBF-1")), "needs-you", "a person answers it");
});

test("A11-91: a done that another tick sees while the tracker is still completing it completes once", async () => {
  const made = doneTracker();
  let release = () => {};
  made.control.hold = new Promise<void>((resolve) => { release = resolve; });
  const { pool, entry } = await doneRun({ kind: "done", reason: "verified", evidence: ["e"] }, made);
  await pool.tick();
  await pool.tick();
  assert.equal(made.calls.length, 1, "the second tick does not complete it again");
  release();
  await settled();
  assert.equal(entry("NBF-1").outcome?.kind, "done");
  assert.equal(made.calls.length, 1);
});

test("A11-91: a worker's proposed edit is recorded on its outcome with the ticket's text as the tracker holds it, and the ticket is not changed", async () => {
  const made = doneTracker("Wrong title");
  const edit = { title: "Right title", why: "the ticket names the wrong thing" };
  const { entry } = await doneRun({ kind: "checked", reason: "nothing to change", edit }, made);
  await settled();
  assert.deepEqual(entry("NBF-1").outcome, { kind: "checked", reason: "nothing to change", edit: { ...edit, base: { title: "Wrong title", description: "Old description" } } });
  assert.deepEqual(made.calls, [], "the ticket is not written: only a person's Apply does that");
});

test("A11-91: an edit that is not one the board can apply parks the run as needs-human naming the problem, and proposes nothing", () => {
  const LONGEST_TITLE = 255;
  const LONGEST_DESCRIPTION = 60_000;
  const titled = (title: string) => JSON.stringify({ kind: "checked", reason: "r", edit: { title, why: "w" } });
  const cases: [string, RegExp][] = [
    [JSON.stringify({ kind: "checked", reason: "r", edit: { why: "w" } }), /neither a title nor a description/],
    [JSON.stringify({ kind: "checked", reason: "r", edit: { title: "t" } }), /has no why/],
    [titled("two\nlines"), /not one line of 1 to 255 characters/],
    [titled("x".repeat(LONGEST_TITLE + 1)), /not one line of 1 to 255 characters/],
    [JSON.stringify({ kind: "needs-human", reason: "q", edit: { description: "x".repeat(LONGEST_DESCRIPTION + 1), why: "w" } }), /more than 60,000 characters/],
    [JSON.stringify({ kind: "done", reason: "r", evidence: ["e"], edit: "a sentence" }), /is not an object/],
  ];
  for (const [text, problem] of cases) {
    const read = parseOutcome(text);
    assert.equal(read.kind, "needs-human", text);
    assert.match(read.kind === "needs-human" ? read.reason : "", problem);
    assert.equal("edit" in read, false, "nothing is proposed from it");
  }
  assert.deepEqual(parseOutcome(JSON.stringify({ kind: "needs-human", reason: "q", edit: { description: "", why: "blank it" } })), { kind: "needs-human", reason: "q", edit: { description: "", why: "blank it" } }, "an empty description is a proposal too");
});

test("A11-91: Apply writes the proposed title to the ticket and drops the proposal, and refuses, keeping it, once the ticket has changed since", async () => {
  const made = doneTracker("Wrong title");
  const { pool, entry } = await doneRun({ kind: "checked", reason: "nothing to change", edit: { title: "Right title", why: "w" } }, made);
  await settled();
  made.control.title = "Edited by a person";
  await assert.rejects(pool.applyEdit("NBF-1"), /the ticket changed since the worker proposed this: NBF-1 is not written, and the proposal stays/);
  assert.equal(entry("NBF-1").outcome && "edit" in entry("NBF-1").outcome! ? "kept" : "dropped", "kept");
  assert.deepEqual(made.calls, [], "nothing was written");
  made.control.title = "Wrong title";
  await pool.applyEdit("NBF-1");
  assert.deepEqual(made.calls.at(-1), { op: "updateTicketText", args: ["NBF-1", { title: "Right title" }] }, "only the title the worker proposed");
  assert.equal(made.control.title, "Right title");
  assert.equal(entry("NBF-1").outcome && "edit" in entry("NBF-1").outcome! ? "kept" : "dropped", "dropped");
  assert.equal(entry("NBF-1").outcome?.kind, "checked", "the run's outcome stands");
  await assert.rejects(pool.applyEdit("NBF-1"), /has no proposed edit to apply/);
});

test("A11-91: Discard drops the proposal and writes nothing; a run with no proposal refuses it", async () => {
  const made = doneTracker();
  const { pool, entry } = await doneRun({ kind: "needs-human", reason: "which title?", edit: { title: "New", why: "w" } }, made);
  await settled();
  pool.discardEdit("NBF-1");
  assert.equal(entry("NBF-1").outcome && "edit" in entry("NBF-1").outcome! ? "kept" : "dropped", "dropped");
  assert.equal(entry("NBF-1").outcome?.kind, "needs-human", "the worker's question stands");
  assert.deepEqual(made.calls, []);
  assert.throws(() => pool.discardEdit("NBF-1"), /has no proposed edit to discard/);
});

test("A11-91: a parked run whose worker rewrites the same outcome, with its proposed edit, has written no new outcome, so it is not resumed", async () => {
  const outcome = { kind: "needs-human", reason: "which title?", edit: { title: "Right title", why: "the title is wrong" } };
  const made = await endedOn(outcome, 1, ["NBF-1"], {}, { source: doneTracker().tracker });
  await settled();
  const dir = ticketDir(made.settings, "NBF-1");
  writeFileSync(join(dir, "stop-refusals"), "2");
  writeFileSync(join(dir, "outcome.json"), JSON.stringify(outcome));
  await made.pool.tick();
  await settled();
  assert.equal(made.entry("NBF-1").phase, "finished", "the same outcome is not a new one");
  assert.ok(existsSync(join(dir, "stop-refusals")), "so the stop count is not cleared by a resume");
});

test("A11-91: a proposed edit a planning run cannot take keeps the worker's own reason, and says why it is refused", async () => {
  const made = setup(1, ["NBF-1"], PLANNER, { source: doneTracker().tracker, planFirst: ["NBF-1"] });
  await finishRunning(made, { kind: "checked", reason: "the toast already shows", edit: { title: "t", why: "w" } });
  const read = made.entry("NBF-1").outcome as { kind: string; reason: string };
  assert.equal(read.kind, "needs-human");
  assert.match(read.reason, /^the toast already shows \(the worker proposed an edit to NBF-1's text from a planning run, which the board does not take\)$/);
});

test("Dismiss takes a finished run off the board, closing its workspace when it is still open, and keeps the run's files", async () => {
  const parked = await endedOn({ kind: "needs-human", reason: "which colour?" });
  await parked.pool.dismiss("NBF-1");
  assert.deepEqual(parked.h.calls.at(-1), ["--session", "tickets", "workspace", "close", "w1"], "its open workspace is closed first");
  assert.deepEqual(parked.store.get().entries, [], "and the run is gone from the board");
  const closed = await endedOn({ kind: "checked", reason: "nothing to change" });
  const calls = closed.h.calls.length;
  await closed.pool.dismiss("NBF-1");
  assert.equal(closed.h.calls.length, calls, "a run whose workspace is closed already asks nothing of herdr");
  assert.deepEqual(closed.store.get().entries, []);
  assert.ok(existsSync(join(ticketDir(closed.settings, "NBF-1"), "outcome.json")), "the run's files stay: only the board's record goes");
});

test("Dismiss is refused for a queued or live run, and a refused close leaves a parked run on the board, parked", async () => {
  const { pool, entry, h } = setup(1, ["NBF-1", "NBF-2"]);
  await pool.tick();
  await assert.rejects(pool.dismiss("NBF-1"), /NBF-1 is still running: Stop it first/);
  await assert.rejects(pool.dismiss("NBF-2"), /NBF-2 is queued, not finished: Remove takes it off the queue/);
  assert.deepEqual([entry("NBF-1").phase, entry("NBF-2").phase], ["running", "queued"]);
  assert.equal(closes(h, "w1"), 0, "a live run's workspace is Stop's to close");
  const parked = await endedOn({ kind: "needs-human", reason: "which colour?" });
  parked.h.refused.add("close");
  await assert.rejects(parked.pool.dismiss("NBF-1"), /herdr could not close NBF-1's workspace/);
  assert.deepEqual([parked.entry("NBF-1").phase, parked.entry("NBF-1").workspace], ["finished", "w1"]);
});

test("Dismissing one ticket of a parked batch closes the batch's one workspace, unparks the rest, and takes only that ticket off", async () => {
  const { tracker } = batchTracker();
  const { pool, status, entry, settings, h, store } = setup(1, ["NBF-1", "NBF-2"], BATCH_PLANNER, { source: tracker, planFirst: ["NBF-1", "NBF-2"], batch: true });
  await pool.tick();
  writeFileSync(join(batchDir(settings, BATCH), "outcome.json"), JSON.stringify({ kind: "needs-human", reason: "which design?" }));
  status.set(herdrName(BATCH), "idle");
  await pool.tick();
  await pool.dismiss("NBF-1");
  assert.deepEqual(store.get().entries.map((e) => e.ticket.key), ["NBF-2"]);
  assert.deepEqual([entry("NBF-2").workspace, entry("NBF-2").outcome?.kind], [undefined, "needs-human"]);
  assert.equal(closes(h, "w1"), 1);
});

test("A11-70: a batch ticket placed in a repository that is no clone is given none and handed to a person by name, and the rest of its order stands", async () => {
  const { tracker, attached, relations } = batchTracker();
  const ran = await plannedBatch(tracker, (plan) => {
    put(join(plan, "NBF-1", "NBF-1-0001-plan-a.md"), "# A\n");
    put(join(plan, "NBF-2", "NBF-2-0001-plan-b.md"), "# B\n");
    put(join(plan, "order.json"), JSON.stringify({ "NBF-1": { repo: "nbl-ui-netbox", after: [] }, "NBF-2": { repo: "a11y-witness", after: ["NBF-1"] } }));
  });
  assert.deepEqual([attached, [...relations]], [["NBF-1", "NBF-2"], [["NBF-2", ["NBF-1"]]]], "both plans are attached, and the wait is recorded");
  assert.deepEqual([ran.entry("NBF-1").phase, ran.entry("NBF-1").plannedRepo], ["queued", "nbl-ui-netbox"], "a known repository is kept");
  const refused = ran.entry("NBF-2");
  assert.deepEqual([refused.phase, refused.plannedRepo, refused.planned, refused.plan], ["finished", null, true, undefined], "never stored, and planned");
  const reason = refused.outcome?.kind === "needs-human" ? refused.outcome.reason : "";
  for (const part of ["`a11y-witness`", "not one of this machine's clones (`nbl-ui-netbox`, `nbl-ui-platform-libs`)", "Retry"]) assert.ok(reason.includes(part), reason);
  ran.store.set(retry(ran.store.get(), "NBF-2", 99));
  assert.deepEqual([ran.entry("NBF-2").phase, ran.entry("NBF-2").plan, ran.entry("NBF-2").planned], ["queued", undefined, true], "Retry works it, without planning it again");
});

test("A11-80: a working outcome is read with its reason and does not end the run: it stays In progress, holds its slot and is watched", async () => {
  assert.deepEqual(parseOutcome(JSON.stringify({ kind: "working", reason: "the roll is still running" })), { kind: "working", reason: "the roll is still running" });
  const { pool, status, entry, settings, h } = await endedOn({ kind: "working", reason: "the roll is still running" }, 1, ["NBF-1", "NBF-2"]);
  assert.deepEqual([entry("NBF-1").phase, entry("NBF-1").outcome, entry("NBF-1").working?.reason], ["running", undefined, "the roll is still running"]);
  assert.equal(runStatus(entry("NBF-1")), "working", "In progress, not Needs you");
  assert.deepEqual([entry("NBF-1").workspace, closes(h, "w1")], ["w1", 0], "its workspace stays, as a live run's");
  assert.equal(entry("NBF-2").phase, "queued", "it still holds the one slot");
  await pool.tick();
  assert.equal(entry("NBF-1").phase, "running", "reading the same file again ends nothing");
  await agentIs({ pool, status }, herdrName("NBF-1"), "working");
  assert.equal(entry("NBF-1").phase, "running", "its Monitor woke it");
  const prs = [{ repo: "nbl-ui-netbox", url: "https://github.com/o/nbl-ui-netbox/pull/7" }];
  writeFileSync(join(ticketDir(settings, "NBF-1"), "outcome.json"), JSON.stringify({ kind: "draft-pr", prs }));
  status.set(herdrName("NBF-1"), "idle");
  await pool.tick();
  assert.deepEqual([entry("NBF-1").phase, entry("NBF-1").outcome, entry("NBF-1").working], ["finished", { kind: "draft-pr", prs }, undefined], "the later outcome replaces the note");
  assert.equal(entry("NBF-2").phase, "running", "and the slot it freed is filled");
});

test("A11-80: a working run idle with no newer outcome for tickets.stallMinutes is marked stalled, once, and is neither ended nor prompted", async () => {
  let clock = 100;
  const { pool, status, entry, settings, h, screen } = setup(1, ["NBF-1"], { stallMinutes: 30 }, { now: () => clock });
  screen.text = PANE("1 shell");  // a shell of its own still runs, so the background rule does not stall it first
  await pool.tick();
  status.set(herdrName("NBF-1"), "working");
  await pool.tick();
  await endWith({ pool, status }, ticketDir(settings, "NBF-1"), herdrName("NBF-1"), { kind: "working", reason: "the roll is still running" });
  clock += 30 * 60_000 - 1;
  await pool.tick();
  assert.equal(entry("NBF-1").working?.stalled, undefined, "not before the stall time");
  const calls = h.calls.length;
  clock += 1;
  const logged = await captureStderr(async () => { await pool.tick(); await pool.tick(); });
  assert.deepEqual([entry("NBF-1").phase, entry("NBF-1").working?.stalled, entry("NBF-1").working?.reason], ["running", true, "the roll is still running"]);
  assert.equal(runStatus(entry("NBF-1")), "working", "still In progress");
  assert.equal(logged.filter((line) => line.includes("NBF-1 has been idle for 30 minutes or more since it wrote working")).length, 1, "said once");
  assert.equal(h.calls.slice(calls).some((args) => args.includes("send-keys") || args.includes("close")), false, "no key sent and nothing closed");
  status.set(herdrName("NBF-1"), "working");
  await pool.tick();
  assert.equal(entry("NBF-1").working?.stalled, undefined, "its work woke it: the stall is cleared");
});

/** A pane's bottom lines as Claude Code draws them: its status line counts the background work given (`1 shell, 1 monitor`), or none. */
const PANE = (counts = "") => `❯\n────\n  5h ╸─────── 5%\n  ⏵⏵ bypass permissions on${counts ? ` · ${counts}` : ""}`;
const resumes = (h: { calls: string[][] }) => h.calls.filter((args) => args.includes("prompt")).length;

/** NBF-1 wrote `working`, and went idle with its pane showing `screen`: the clock moves on with `advance`. */
async function idleWithWork(screen: string, { refuseRead = false }: { refuseRead?: boolean } = {}) {
  let clock = 100;
  const made = setup(1, ["NBF-1"], { stallMinutes: 30 }, { now: () => clock });
  await made.pool.tick();
  made.status.set(herdrName("NBF-1"), "working");
  await made.pool.tick();
  writeFileSync(join(ticketDir(made.settings, "NBF-1"), "outcome.json"), JSON.stringify({ kind: "working", reason: "the roll is still running" }));
  made.status.set(herdrName("NBF-1"), "idle");
  made.screen.text = screen;
  if (refuseRead) made.h.refused.add("read");
  await made.pool.tick();
  return { ...made, advance: (ms: number) => { clock += ms; }, pass: async (ms: number) => { clock += ms; await made.pool.tick(); } };
}

test("A11-85: a working run whose pane shows no background work for BACKGROUND_GONE_MS is marked stalled and prompted once, not before", async () => {
  const { pool, entry, h, advance } = await idleWithWork(PANE());
  advance(BACKGROUND_GONE_MS - 1);
  await pool.tick();
  assert.equal(entry("NBF-1").working?.stalled, undefined, "not before the background time");
  const calls = h.calls.length;
  advance(1);
  const logged = await captureStderr(async () => { await pool.tick(); await pool.tick(); });
  assert.deepEqual([entry("NBF-1").phase, entry("NBF-1").working?.stalled, entry("NBF-1").working?.stallReason], ["running", true, "background work gone"]);
  assert.equal(runStatus(entry("NBF-1")), "working", "still In progress, not ended");
  assert.deepEqual(h.calls.slice(calls).filter((args) => args.includes("prompt")),
    [["--session", "tickets", "agent", "prompt", herdrName("NBF-1"), "your background work is gone; check it and carry on"]], "prompted once, with the resume text");
  assert.equal(logged.filter((line) => line.includes("NBF-1 wrote working with no background work running")).length, 1, "said once");
  assert.equal(h.calls.slice(calls).some((args) => args.includes("send-keys") || args.includes("close")), false, "no key sent and nothing closed");
});

test("A11-85: a pane that shows a shell or a Monitor is not stalled however long the worker sits idle with it", async () => {
  const { pool, entry, h, advance } = await idleWithWork(PANE("1 shell, 1 monitor"));
  advance(BACKGROUND_GONE_MS * 2);
  await pool.tick();
  assert.deepEqual([entry("NBF-1").working?.stalled, entry("NBF-1").working?.resumed], [undefined, undefined]);
  assert.equal(resumes(h), 0, "not prompted");
});

test("A11-85: a pane that cannot be read leaves the thirty-minute rule to decide alone: no background stall, no prompt", async () => {
  const { pool, entry, h, advance } = await idleWithWork(PANE(), { refuseRead: true });
  advance(BACKGROUND_GONE_MS * 2);
  await pool.tick();
  assert.equal(entry("NBF-1").working?.stalled, undefined, "not stalled by its background work");
  assert.equal(resumes(h), 0, "not prompted");
  advance(30 * 60_000);
  await pool.tick();
  assert.deepEqual([entry("NBF-1").working?.stalled, entry("NBF-1").working?.stallReason], [true, undefined], "the thirty-minute rule stalls it, by idleness");
});

test("A11-85: background work seen again clears the mark, so a later gone is a new one; a second working with nothing running is not prompted again", async () => {
  const { pool, entry, h, screen, advance, settings, pass } = await idleWithWork(PANE());
  advance(BACKGROUND_GONE_MS);
  await pool.tick();
  assert.equal(resumes(h), 1, "the first gone is prompted");
  screen.text = PANE("1 shell");
  await pool.tick();
  assert.deepEqual([entry("NBF-1").working?.stalled, entry("NBF-1").working?.resumed], [undefined, undefined], "seen again: the mark is cleared");
  const outcome = join(ticketDir(settings, "NBF-1"), "outcome.json");
  writeFileSync(outcome, JSON.stringify({ kind: "working", reason: "the second play is running" }));
  const later = new Date(Date.now() + 60_000);
  utimesSync(outcome, later, later);
  screen.text = PANE();
  await pool.tick();
  advance(BACKGROUND_GONE_MS);
  await pool.tick();
  assert.equal(entry("NBF-1").working?.stalled, true, "a fresh working note with nothing running is stalled again");
  assert.equal(resumes(h), 2, "and prompted: the mark was cleared by real work");
  writeFileSync(outcome, JSON.stringify({ kind: "working", reason: "a third play, still nothing running" }));
  utimesSync(outcome, new Date(later.getTime() + 60_000), new Date(later.getTime() + 60_000));
  await pool.tick();
  await pass(BACKGROUND_GONE_MS);
  assert.equal(entry("NBF-1").working?.stalled, true, "stalled again");
  assert.equal(resumes(h), 2, "not prompted again without real work between");
});

test("A11-80: a parked run whose worker, woken between two looks, writes working is live again with that note, not ended", async () => {
  const { pool, entry, settings } = await endedOn({ kind: "needs-human", reason: "which colour?" });
  writeFileSync(join(ticketDir(settings, "NBF-1"), "outcome.json"), JSON.stringify({ kind: "working", reason: "rebuilding with the colour the person chose" }));
  await pool.tick();
  assert.deepEqual([entry("NBF-1").phase, entry("NBF-1").outcome, entry("NBF-1").working?.reason], ["running", undefined, "rebuilding with the colour the person chose"]);
});

/** A review by `login` on `commit`, `ms` after the epoch, as GitHub answers it: the verdict a reviewer posts is one of these. */
const reviewOn = (login: string, state: string, commit: string) => ({ state, submittedAt: at(200), author: { login }, commit: { oid: commit } });

/**
 * A reviewer port that starts its reviewer (open until it is closed), closes it as `closeAnswers` says in turn (`closed` once it has not been busy),
 * and retires a pull request as `retire` answers. `starts`, `closes` and `retired` record what the pool asked, in order.
 */
function reviewerWith({ closeAnswers = ["closed"], retire = () => ({ retired: true as const, report: null }), listedPulls = () => [] as string[] }: {
  closeAnswers?: ("busy" | "closed")[]; retire?: (pr: string) => { retired: true; report: string | null } | { refusal: string }; listedPulls?: () => string[];
} = {}) {
  const starts: ReviewerRef[] = [];
  const closes: ReviewerRef[] = [];
  const retired: string[] = [];
  const answers = [...closeAnswers];
  let open = false;
  const port: ReviewerPort = {
    start(ref) { starts.push(ref); open = true; return { label: "reviewer-7" }; },
    live: () => open,
    close(ref) {
      closes.push(ref);
      const state = answers.shift() ?? "closed";
      if (state === "closed") open = false;
      return { state };
    },
    retire(pr) { retired.push(pr); return retire(pr); },
    listedPulls,
    ...idleVerdict,
  };
  return { port, starts, closes, retired };
}

test("a reviewer is closed once its verdict on its head is posted, and is not started again for that head", async () => {
  const { port, starts, closes } = reviewerWith();
  const pulls = { 1: feedbackPull() };
  const ctx = await readyRun(ghFor(pulls), REVIEWING, port);
  ctx.pool.watchFeedback();
  await roundStarted();
  assert.deepEqual(starts.map((ref) => ref.head), ["h1"], "the reviewer for h1 is started");
  assert.deepEqual(closes, [], "and not closed before its verdict is posted");
  pulls[1] = feedbackPull({ reviews: [reviewOn(REVIEWER_LOGIN, "APPROVED", "h1")] });
  ctx.restart().watchFeedback();
  await roundStarted();
  assert.deepEqual(closes, [{ pr: approvedPr.url, head: "h1" }], "closed once its approval is posted");
  ctx.restart().watchFeedback();
  await roundStarted();
  assert.equal(closes.length, 1, "a closed reviewer is not closed again");
  assert.deepEqual(starts.map((ref) => ref.head), ["h1"], "and not started again for h1");
});

test("a reviewer still working at its verdict is asked again on each watch until it is closed", async () => {
  const { port, starts, closes } = reviewerWith({ closeAnswers: ["busy", "busy", "closed"] });
  const pulls = { 1: feedbackPull() };
  const ctx = await startedFor(port, pulls);
  pulls[1] = feedbackPull({ reviews: [reviewOn(REVIEWER_LOGIN, "APPROVED", "h1")] });
  const closesAfterEachWatch: number[] = [];
  for (let watch = 0; watch < 4; watch += 1) {
    await watchRound(ctx.pool);
    closesAfterEachWatch.push(closes.length);
  }
  assert.deepEqual(closesAfterEachWatch, [1, 2, 3, 3], "asked again on each watch while it is busy, and not once it is closed");
  assert.deepEqual(starts.map((ref) => ref.head), ["h1"], "nothing is started while it is busy");
});

test("a not-convinced verdict closes its reviewer in the watch that starts the round, and the sweep asks again while it is busy", async () => {
  const { port, closes } = reviewerWith({ closeAnswers: ["busy", "closed"] });
  const pulls = { 1: feedbackPull() };
  const ctx = await startedFor(port, pulls);
  pulls[1] = feedbackPull({ reviews: [reviewOn(REVIEWER_LOGIN, "CHANGES_REQUESTED", "h1")] });
  await watchRound(ctx.pool);
  assert.deepEqual([ctx.entry("NBF-1").phase, ctx.entry("NBF-1").rounds], ["running", 1], "the worker's round is started");
  assert.equal(closes.length, 1, "the close is asked in the watch that started the round, and found it busy");
  ctx.pool.releaseReviewers();
  assert.equal(closes.length, 2, "the sweep asks again, and it is closed");
  ctx.pool.releaseReviewers();
  assert.equal(closes.length, 2, "no further close once it is closed");
});

/** A pool with no run at all, its reviewer on, and `pulls` open on nbl-ui-netbox: what reviews them is the sweep (A11-119). */
async function sweptPool(port: ReviewerPort, pulls: Record<number, unknown>) {
  await loadReviewerGate();
  const made = setup(1, [], REVIEWING, { gh: ghFor(pulls), reviewerPort: port });
  return made;
}

test("A11-119: an open pull request no run lists gets one reviewer, and the sweep starts none for that head twice", async () => {
  const { port, starts } = fakeReviewer();
  const ctx = await sweptPool(port, { 1: feedbackPull() });
  ctx.pool.reviewNewHeads();
  assert.deepEqual(starts, [{ pr: sweptPr, head: "h1" }], "one reviewer, for its head");
  ctx.pool.reviewNewHeads();
  assert.equal(starts.length, 1, "a second sweep starts nothing for h1");
});

test("A11-119: a new head after requested changes gets a reviewer, though its run ended needs-human; the board says so beside the pull request", async () => {
  const { port, starts } = reviewerWith();
  await loadReviewerGate();
  const pulls = { 1: feedbackPull({ head: "h1", reviews: [reviewOn(REVIEWER_LOGIN, "CHANGES_REQUESTED", "h1")] }) };
  const ctx = await endedOn({ kind: "needs-human", reason: "which colour?" }, 1, ["NBF-1"], REVIEWING, { gh: ghFor(pulls), reviewerPort: port, clones: { "nbl-ui-netbox": "/repos/nbl-ui-netbox" } });
  ctx.pool.reviewNewHeads();
  assert.deepEqual(starts.map((ref) => ref.head), [], "h1 has its verdict, so nothing is started for it");
  assert.equal(ctx.pool.pullReviews()[sweptPr], "changes requested at h1");
  pulls[1] = feedbackPull({ head: "h2", reviews: [reviewOn(REVIEWER_LOGIN, "CHANGES_REQUESTED", "h1")] });
  ctx.pool.reviewNewHeads();
  assert.deepEqual(starts.map((ref) => ref.head), ["h2"], "the new head is started");
  assert.equal(ctx.pool.pullReviews()[sweptPr], "reviewing", "and the board shows the reviewer on it");
});

test("A11-119: a head with a posted review, or one ticket:review started, is not started by the sweep; the board says the verdict", async () => {
  const { port, starts } = fakeReviewer();
  const pulls = { 1: feedbackPull({ reviews: [reviewOn(REVIEWER_LOGIN, "APPROVED", "h1")] }) };
  const ctx = await sweptPool(port, pulls);
  ctx.pool.reviewNewHeads();
  assert.deepEqual(starts, [], "a head with an approval is not started");
  assert.equal(ctx.pool.pullReviews()[sweptPr], "approved at h1");
  pulls[1] = feedbackPull({ head: "h2" });
  writeReviewerMemory(reviewerMemoryPath(ctx.settings.stateDir), { heads: new Map(), started: new Set([`${sweptPr}@h2`]), resumed: new Set(), reposts: new Map(), rereviewed: new Set() });
  ctx.pool.reviewNewHeads();
  assert.deepEqual(starts, [], "a head ticket:review started is not started again");
});

test("A11-119: a start ticket:review recorded is kept by the pool's next write, and a pull request the pool forgot is not brought back by the file", async () => {
  const { port, starts } = fakeReviewer();
  const pulls: Record<number, unknown> = { 1: feedbackPull() };
  const ctx = await sweptPool(port, pulls);
  ctx.pool.reviewNewHeads();
  const path = reviewerMemoryPath(ctx.settings.stateDir);
  const handStarted = `${SWEPT_REPO_PULL_2}@h9`;
  // ticket:review starts pull request 2 between the pool's sweeps, and records it in the file the pool shares.
  const recorded = readReviewerMemory(path).memory;
  recorded.started.add(handStarted);
  writeReviewerMemory(path, recorded);
  // Pull request 1 merges: the pool forgets it, and writes its copy, which had not read `handStarted` yet.
  pulls[1] = feedbackPull({ state: "MERGED" });
  ctx.pool.releaseReviewers();
  const onDisk = readReviewerMemory(path).memory.started;
  assert.ok(onDisk.has(handStarted), "the start ticket:review recorded survives the pool's write");
  assert.equal(onDisk.has(`${sweptPr}@h1`), false, "the forgotten start is not brought back");
  // Pull request 2 opens with the head ticket:review started it for: the next sweep reads that start, and starts nothing.
  pulls[2] = feedbackPull({ head: "h9" });
  ctx.pool.reviewNewHeads();
  assert.deepEqual(starts.map((ref) => ref.pr), [sweptPr], "pull request 2 at h9 is not started again");
});

test("A11-119: a refusal to start is said once for a head, and is asked again on the next sweep; a head not settled green starts nothing", async () => {
  const starts: ReviewerRef[] = [];
  const port: ReviewerPort = { ...fakeReviewer().port, start(ref) { starts.push(ref); return { refusal: "no reviewer for it: its author is outside the org" }; } };
  const ctx = await sweptPool(port, { 1: feedbackPull() });
  const logged = await captureStderr(async () => {
    ctx.pool.reviewNewHeads();
    ctx.pool.reviewNewHeads();
  });
  assert.equal(starts.length, 2, "each sweep asks again, since a refusal is not recorded as started");
  assert.equal(logged.filter((line) => line.includes("its author is outside the org")).length, 1, "and said once");
  assert.equal(ctx.pool.pullReviews()[sweptPr], "not reviewed: no reviewer for it: its author is outside the org");
  const unsettled = await sweptPool(fakeReviewer().port, { 1: feedbackPull({ checks: [{ name: "ci", status: "IN_PROGRESS" }] }) });
  unsettled.pool.reviewNewHeads();
  assert.equal(unsettled.pool.pullReviews()[sweptPr], "waiting for checks at h1", "and it is not started");
});

// ---- A11-156: a reply to a block gets one re-review of the same head, and the reviewer is told the ticket's Done-when ----

/** The Done-when a ticket writes in two parts: the reviewer is quoted both. */
const TWO_PART_TICKET = [
  "Fix the migration.", "", "## Acceptance", "", "- it migrates", "", "## Done-when", "", "### Before merge", "", "- the migration test passes", "",
  "### After merge (who runs it)", "", "- the live host runs it. The chairman, after 0.9.0 is installed, with `agent-org migrate` and a `migrated` line.", "", "## Notes", "", "- not part of it",
].join("\n");

/** A review of `commit` by `login`, `minute` minutes into the hour: the reviewer's block and approval, and the order between them. */
const reviewAt = (login: string, state: string, commit: string, minute: number) => ({ state, submittedAt: at(minute * 60_000), author: { login }, commit: { oid: commit } });
/** A conversation comment by `login`, `minute` minutes into the hour: a reply when it follows the block. */
const replyAt = (login: string, minute: number, body = "This is not a defect in this diff: the live migration is run after the release.") =>
  ({ author: { login }, createdAt: at(minute * 60_000), body, url: `${sweptPr}#issuecomment-${minute}` });
const BLOCK = (minute = 10) => reviewAt(REVIEWER_LOGIN, "CHANGES_REQUESTED", "h1", minute);

/**
 * A reviewer port for the re-review tests: it records each start with the brief it was given, and its reviewer stays open and `working` until a test ends its turn (`end`), and closes only
 * once it has (a close of one still working is busy). `refuse` makes the next start refuse.
 */
function rereviewer() {
  const starts: { ref: ReviewerRef; brief: ReviewBrief | undefined }[] = [];
  const closes: ReviewerRef[] = [];
  const reposts: string[] = [];
  const prompts: ReviewerRef[] = [];
  const control = { open: false, turn: "working" as ReviewerSettled, refuse: null as string | null, file: null as string | null };
  const port: ReviewerPort = {
    start(ref, brief) {
      starts.push({ ref, brief });
      if (control.refuse !== null) return { refusal: control.refuse };
      control.open = true;
      control.turn = "working";
      return { label: "reviewer-7" };
    },
    live: () => control.open,
    close(ref) {
      closes.push(ref);
      if (control.turn === "working") return { state: "busy" };
      control.open = false;
      return { state: "closed" };
    },
    retire: () => ({ retired: true, report: null }),
    listedPulls: () => [],
    settled: () => (control.open ? control.turn : "gone"),
    verdictFileOf: () => control.file,
    repostVerdict(ref, file) { reposts.push(file); return { posted: true }; },
    reprompt(ref) { prompts.push(ref); return { prompted: true }; },
  };
  return { port, starts, closes, reposts, prompts, control, end: () => { control.turn = "ended"; } };
}

/** A swept pool whose queue holds NBF-1 with `description` and `sweptPr` as its pull request: the run the reviewer's Done-when is read from. */
async function sweptWithTicket(port: ReviewerPort, pulls: Record<number, unknown>, description = TWO_PART_TICKET) {
  await loadReviewerGate();
  const ctx = setup(1, ["NBF-1"], REVIEWING, { gh: ghFor(pulls), reviewerPort: port });
  const queue = ctx.store.get();
  ctx.store.set({ ...queue, entries: [{ ...queue.entries[0], ticket: { ...queue.entries[0].ticket, description }, outcome: { kind: "ready-pr", prs: [{ repo: "nbl-ui-netbox", url: sweptPr }] } as Outcome }] });
  return ctx;
}

test("A11-156: a reply to the reviewer's block with no new commit starts one re-review of that head, with the reply and the ticket's Done-when in its brief; the board says so, and the approval closes it", async () => {
  const { port, starts, closes, end } = rereviewer();
  const pulls: Record<number, unknown> = { 1: feedbackPull({ reviews: [BLOCK()] }) };
  const ctx = await sweptWithTicket(port, pulls);
  const path = reviewerMemoryPath(ctx.settings.stateDir);
  ctx.pool.reviewNewHeads();
  assert.equal(starts.length, 0, "a block with no reply asks for nothing");
  assert.equal(ctx.pool.pullReviews()[sweptPr], "changes requested at h1");
  pulls[1] = feedbackPull({ reviews: [BLOCK()], comments: [replyAt("worker-bot", 20)] });
  ctx.pool.reviewNewHeads();
  assert.equal(starts.length, 1, "the reply starts a re-review");
  assert.deepEqual(starts[0].ref, { pr: sweptPr, head: "h1" }, "of the same head, which has no new commit");
  assert.deepEqual(starts[0].brief?.rereview?.replies, [{ author: "worker-bot", url: `${sweptPr}#issuecomment-20`, text: "This is not a defect in this diff: the live migration is run after the release." }]);
  const doneWhen = starts[0].brief?.doneWhen ?? "";
  assert.ok(doneWhen.startsWith("## Done-when") && doneWhen.includes("### Before merge") && doneWhen.includes("### After merge (who runs it)") && doneWhen.includes("after 0.9.0 is installed"), "the ticket's Done-when, both parts");
  assert.ok(!doneWhen.includes("## Notes") && !doneWhen.includes("## Acceptance"), "and no other section");
  assert.equal(ctx.pool.pullReviews()[sweptPr], "re-review asked by reply at h1");
  assert.ok(readReviewerMemory(path).memory.rereviewed.has(`${sweptPr}@h1`), "recorded on disk");
  ctx.pool.reviewNewHeads();
  assert.deepEqual([starts.length, closes.length], [1, 0], "the block at its head does not close the re-reviewer, and a second sweep starts nothing");
  assert.equal(ctx.pool.pullReviews()[sweptPr], "re-review asked by reply at h1");
  // The re-reviewer approves, naming the block, and ends its turn.
  pulls[1] = feedbackPull({ reviews: [BLOCK(), reviewAt(REVIEWER_LOGIN, "APPROVED", "h1", 30)], comments: [replyAt("worker-bot", 20)] });
  end();
  ctx.pool.reviewNewHeads();
  assert.deepEqual(closes, [{ pr: sweptPr, head: "h1" }], "the approval closes it");
  assert.equal(ctx.pool.pullReviews()[sweptPr], "approved at h1");
  pulls[1] = feedbackPull({ reviews: [BLOCK(), reviewAt(REVIEWER_LOGIN, "APPROVED", "h1", 30)], comments: [replyAt("worker-bot", 20), replyAt("worker-bot", 40, "one more")] });
  ctx.restart().reviewNewHeads();
  assert.equal(starts.length, 1, "a second reply, after a restart, starts nothing more");
});

test("A11-156: a head is re-reviewed by reply once, whatever is posted after, and the record is kept across a restart", async () => {
  const { port, starts, end, control } = rereviewer();
  const pulls: Record<number, unknown> = { 1: feedbackPull({ reviews: [BLOCK()], comments: [replyAt("worker-bot", 20)] }) };
  const ctx = await sweptWithTicket(port, pulls);
  ctx.pool.reviewNewHeads();
  assert.equal(starts.length, 1);
  // The re-reviewer ends having posted nothing (its not-convinced was refused by the door), and is closed.
  end();
  ctx.pool.reviewNewHeads();
  assert.equal(control.open, false, "closed once its turn ended");
  assert.equal(ctx.pool.pullReviews()[sweptPr], "changes requested at h1", "and the board reads the standing block");
  pulls[1] = feedbackPull({ reviews: [BLOCK()], comments: [replyAt("worker-bot", 20), replyAt("worker-bot", 50, "I disagree, again")] });
  ctx.pool.reviewNewHeads();
  ctx.restart().reviewNewHeads();
  assert.equal(starts.length, 1, "a second reply, before or after a restart, starts no second re-review of h1");
});

test("A11-156: an unconvinced re-review is not read as a lost verdict: no repost, no `verdict not posted` line, no prompt, and the board reads changes requested", async () => {
  const { port, starts, reposts, prompts, end, control } = rereviewer();
  const pulls: Record<number, unknown> = { 1: feedbackPull({ reviews: [BLOCK()], comments: [replyAt("worker-bot", 20)] }) };
  const ctx = await sweptWithTicket(port, pulls);
  // The first reviewer started this head in an earlier sweep, so the pool holds it as started.
  writeReviewerMemory(reviewerMemoryPath(ctx.settings.stateDir), { heads: new Map(), started: new Set([`${sweptPr}@h1`]), resumed: new Set(), reposts: new Map(), rereviewed: new Set() });
  const logged = await captureStderr(async () => {
    ctx.pool.reviewNewHeads();
    end();
    control.file = "/checkout/verdict.md";
    ctx.pool.reviewNewHeads();
    ctx.pool.reviewNewHeads();
  });
  assert.equal(starts.length, 1);
  assert.deepEqual([reposts, prompts], [[], []], "the verdict file the door refused is not posted again, and the reviewer is not prompted");
  assert.deepEqual(logged.filter((line) => line.includes("verdict not posted") || line.includes("is not posted")), []);
  assert.equal(ctx.store.get().entries[0].verdictNotPosted, undefined);
  assert.equal(ctx.pool.pullReviews()[sweptPr], "changes requested at h1");
});

test("A11-156: a reply that is not from the board's account or a declared person, was posted before the block, or comes with an approval already at the head starts nothing; a declared person's does", async () => {
  const scenarios: [string, ReturnType<typeof feedbackPull>, boolean][] = [
    ["an undeclared login", feedbackPull({ reviews: [BLOCK()], comments: [replyAt("a-stranger", 20)] }), false],
    ["the reviewer's own comment", feedbackPull({ reviews: [BLOCK()], comments: [replyAt(REVIEWER_LOGIN, 20)] }), false],
    ["a reply posted before the block", feedbackPull({ reviews: [BLOCK(30)], comments: [replyAt("worker-bot", 20)] }), false],
    ["a reply with no text", feedbackPull({ reviews: [BLOCK()], comments: [replyAt("worker-bot", 20, "")] }), false],
    ["an approval already at the head", feedbackPull({ reviews: [BLOCK(), reviewAt(REVIEWER_LOGIN, "APPROVED", "h1", 15)], comments: [replyAt("worker-bot", 20)] }), false],
    ["a person the org declares", feedbackPull({ reviews: [BLOCK()], comments: [replyAt("DanBeckDev", 20, "The block is wrong: see the ticket's After-merge part.")] }), true],
    ["the board's own account", feedbackPull({ reviews: [BLOCK()], comments: [replyAt("worker-bot", 20)] }), true],
  ];
  for (const [why, pull, starts] of scenarios) {
    const { port, starts: made } = rereviewer();
    const ctx = await sweptWithTicket(port, { 1: pull });
    ctx.pool.reviewNewHeads();
    assert.equal(made.length, starts ? 1 : 0, why);
  }
});

test("A11-156: a head that moved is a first review with no replies in its brief, not a re-review; the memory of the old head does not carry over", async () => {
  const { port, starts, end } = rereviewer();
  const pulls: Record<number, unknown> = { 1: feedbackPull({ reviews: [BLOCK()], comments: [replyAt("worker-bot", 20)] }) };
  const ctx = await sweptWithTicket(port, pulls);
  ctx.pool.reviewNewHeads();
  assert.equal(starts[0].brief?.rereview !== undefined, true, "h1 is re-reviewed by reply");
  end();
  pulls[1] = feedbackPull({ head: "h2", reviews: [BLOCK()], comments: [replyAt("worker-bot", 20)] });
  port.close({ pr: sweptPr, head: "h1" });
  ctx.pool.reviewNewHeads();
  assert.deepEqual(starts.map(({ ref }) => ref.head), ["h1", "h2"]);
  assert.equal(starts[1].brief?.rereview, undefined, "the new head is a first review");
  assert.equal(starts[1].brief?.doneWhen?.startsWith("## Done-when"), true, "and still carries the ticket's Done-when");
});

test("A11-156: a first review of a pull request no run holds says its body is the only copy of the contract: the brief carries no Done-when", async () => {
  const { port, starts } = rereviewer();
  await loadReviewerGate();
  const ctx = setup(1, [], REVIEWING, { gh: ghFor({ 1: feedbackPull() }), reviewerPort: port });
  ctx.pool.reviewNewHeads();
  assert.deepEqual(starts.map(({ brief }) => brief), [{ doneWhen: null }]);
  const other = rereviewer();
  const noSection = await sweptWithTicket(other.port, { 1: feedbackPull() }, "A ticket with no Done-when section.");
  noSection.pool.reviewNewHeads();
  assert.deepEqual(other.starts.map(({ brief }) => brief), [{ doneWhen: null }], "a ticket with no such section has none to quote");
});

test("A11-156: a refused re-review start is not remembered, so the next sweep asks again; an unreadable reply read starts nothing and is asked again", async () => {
  const { port, starts, control } = rereviewer();
  const pulls: Record<number, unknown> = { 1: feedbackPull({ reviews: [BLOCK()], comments: [replyAt("worker-bot", 20)] }) };
  const ctx = await sweptWithTicket(port, pulls);
  const path = reviewerMemoryPath(ctx.settings.stateDir);
  control.refuse = "another instance holds the review";
  const logged = await captureStderr(async () => {
    ctx.pool.reviewNewHeads();
    ctx.pool.reviewNewHeads();
  });
  assert.equal(starts.length, 2, "asked again on the next sweep");
  assert.equal(logged.filter((line) => line.includes("another instance holds the review")).length, 1, "and said once");
  assert.equal(readReviewerMemory(path).memory.rereviewed.size, 0, "a refused start leaves no record");
  control.refuse = null;
  ctx.pool.reviewNewHeads();
  assert.equal(starts.length, 3, "and starts once the refusal is gone");
  assert.equal(readReviewerMemory(path).memory.rereviewed.has(`${sweptPr}@h1`), true);
});

test("A11-156: replies that cannot be read start nothing and are said once; the next sweep reads them", async () => {
  const { port, starts } = rereviewer();
  const pulls: Record<number, unknown> = { 1: feedbackPull({ reviews: [BLOCK()], comments: [replyAt("worker-bot", 20)] }) };
  await loadReviewerGate();
  const gh = ghFor(pulls);
  const readable = gh.codeHost.readReplies;
  let readableNow = false;
  gh.codeHost.readReplies = (url, request) => (readableNow ? readable(url, request) : null);
  const ctx = setup(1, [], REVIEWING, { gh, reviewerPort: port });
  const logged = await captureStderr(async () => {
    ctx.pool.reviewNewHeads();
    ctx.pool.reviewNewHeads();
  });
  assert.equal(starts.length, 0, "null is not 'no reply' and not 'a reply'");
  assert.equal(logged.filter((line) => line.includes("its replies could not be read")).length, 1, "said once across two sweeps");
  readableNow = true;
  ctx.pool.reviewNewHeads();
  assert.equal(starts.length, 1, "and read on the next sweep");
});

test("A11-156: a long thread quotes the newest ten replies; a code host that reads no replies asks for no re-review and is said once", async () => {
  const { port, starts } = rereviewer();
  const thread = Array.from({ length: 14 }, (_, i) => replyAt("worker-bot", 20 + i, `reply ${i}`));
  const ctx = await sweptWithTicket(port, { 1: feedbackPull({ reviews: [BLOCK()], comments: thread }) });
  ctx.pool.reviewNewHeads();
  assert.deepEqual(starts[0].brief?.rereview?.replies.map(({ text }) => text), thread.slice(-10).map(({ body }) => body), "the newest ten, oldest first");
  const old = rereviewer();
  await loadReviewerGate();
  const gh = ghFor({ 1: feedbackPull({ reviews: [BLOCK()], comments: [replyAt("worker-bot", 20)] }) });
  (gh.codeHost as { readReplies?: unknown }).readReplies = undefined;
  const legacy = setup(1, [], REVIEWING, { gh, reviewerPort: old.port });
  const logged = await captureStderr(async () => {
    legacy.pool.reviewNewHeads();
    legacy.pool.reviewNewHeads();
  });
  assert.equal(old.starts.length, 0);
  assert.equal(logged.filter((line) => line.includes("the code host does not read replies")).length, 1);
});

test("A11-156: a reply to a watched run's block starts the re-review from the watch too, and a re-review that stays unconvinced asks the worker for no new round", async () => {
  const { port, starts, end } = rereviewer();
  const pulls: Record<number, unknown> = { 1: feedbackPull({ reviews: [BLOCK()] }) };
  const ctx = await readyRun(ghFor(pulls), REVIEWING, port);
  writeReviewerMemory(reviewerMemoryPath(ctx.settings.stateDir), { heads: new Map(), started: new Set([`${approvedPr.url}@h1`]), resumed: new Set(), reposts: new Map(), rereviewed: new Set() });
  await watchRound(ctx.pool);
  assert.deepEqual([ctx.entry("NBF-1").phase, ctx.entry("NBF-1").rounds], ["running", 1], "the block asks the worker for one round");
  await finishRound(ctx);
  pulls[1] = feedbackPull({ reviews: [BLOCK()], comments: [replyAt("worker-bot", 20)] });
  await watchRound(ctx.pool);
  assert.equal(starts.length, 1, "the worker's reply starts the re-review from the watch");
  end();
  await watchRound(ctx.pool);
  await watchRound(ctx.pool);
  assert.deepEqual([ctx.entry("NBF-1").phase, ctx.entry("NBF-1").rounds], ["finished", 1], "a re-review that stays unconvinced asks for no second round");
});

test("A11-156: the pool forgets a merged pull request's re-review record, and a record the file holds is not brought back", async () => {
  const { port, starts } = rereviewer();
  const pulls: Record<number, unknown> = { 1: feedbackPull({ reviews: [BLOCK()], comments: [replyAt("worker-bot", 20)] }) };
  const ctx = await sweptWithTicket(port, pulls);
  ctx.pool.reviewNewHeads();
  const path = reviewerMemoryPath(ctx.settings.stateDir);
  assert.equal(readReviewerMemory(path).memory.rereviewed.size, 1);
  pulls[1] = feedbackPull({ state: "MERGED", reviews: [BLOCK()], comments: [replyAt("worker-bot", 20)] });
  ctx.pool.releaseReviewers();
  assert.equal(readReviewerMemory(path).memory.rereviewed.size, 0, "dropped from disk with the pull request");
  assert.equal(starts.length, 1);
});

test("a merged pull request's reviewer is retired by the sweep, and what the pool remembers of it is dropped from disk", async () => {
  const { port, starts, retired } = reviewerWith();
  const pulls = { 1: feedbackPull() };
  const ctx = await startedFor(port, pulls);
  assert.deepEqual(starts.map((ref) => ref.head), ["h1"]);
  const memory = () => readReviewerMemory(reviewerMemoryPath(ctx.settings.stateDir)).memory;
  assert.equal(memory().started.size, 1, "remembered before the merge");
  pulls[1] = feedbackPull({ state: "MERGED" });
  ctx.pool.releaseReviewers();
  assert.deepEqual(retired, [approvedPr.url], "retired once");
  assert.deepEqual([...memory().started, ...memory().resumed], [], "forgotten on disk too");
  assert.deepEqual(starts.map((ref) => ref.head), ["h1"], "nothing is started by the sweep");
});

test("a closed pull request is retired the same way as a merged one", async () => {
  const { port, retired } = reviewerWith();
  const pulls = { 1: feedbackPull() };
  const ctx = await reviewedRun(port, pulls);
  pulls[1] = feedbackPull({ state: "CLOSED" });
  ctx.pool.releaseReviewers();
  assert.deepEqual(retired, [approvedPr.url]);
});

test("an open pull request's reviewer is left alone by the sweep, and still remembered", async () => {
  const { port, retired } = reviewerWith();
  const ctx = await reviewedRun(port, { 1: feedbackPull() });
  ctx.pool.releaseReviewers();
  assert.deepEqual(retired, []);
  assert.equal(readReviewerMemory(reviewerMemoryPath(ctx.settings.stateDir)).memory.started.size, 1);
});

test("a pull request whose state cannot be read is kept and logged, and asked again on the next sweep", async () => {
  const { port, retired } = reviewerWith();
  const pulls: Record<number, unknown> = { 1: feedbackPull() };
  const ctx = await reviewedRun(port, pulls);
  delete pulls[1];
  const logged = await captureStderr(async () => { ctx.pool.releaseReviewers(); });
  assert.deepEqual(retired, []);
  assert.ok(logged.some((line) => line.includes(`${approvedPr.url}: its state could not be read`)), "the unread state is logged");
  assert.equal(readReviewerMemory(reviewerMemoryPath(ctx.settings.stateDir)).memory.started.size, 1, "and remembered");
});

test("a retire that is refused keeps what the pool remembers, and the next sweep retries it", async () => {
  let refuse = true;
  const { port, retired } = reviewerWith({ retire: () => (refuse ? { refusal: "no retire for it: reviewer-7 is still working" } : { retired: true, report: null }) });
  const pulls = { 1: feedbackPull() };
  const ctx = await reviewedRun(port, pulls);
  pulls[1] = feedbackPull({ state: "MERGED" });
  const logged = await captureStderr(async () => { ctx.pool.releaseReviewers(); });
  assert.ok(logged.some((line) => line.includes("still working")), "the refusal is logged");
  assert.equal(readReviewerMemory(reviewerMemoryPath(ctx.settings.stateDir)).memory.started.size, 1, "kept on disk");
  refuse = false;
  ctx.pool.releaseReviewers();
  assert.equal(retired.length, 2, "retried on the next sweep");
  assert.equal(readReviewerMemory(reviewerMemoryPath(ctx.settings.stateDir)).memory.started.size, 0, "and forgotten once it has gone");
});

test("a restarted pool retires a merged pull request from the memory read off disk", async () => {
  const pulls = { 1: feedbackPull() };
  const { port, retired } = reviewerWith();
  const ctx = await reviewedRun(port, pulls);
  pulls[1] = feedbackPull({ state: "MERGED" });
  ctx.restart().releaseReviewers();
  assert.deepEqual(retired, [approvedPr.url], "the restarted pool retires it");
});

test("a reviewer the session lists with no memory of it is retired once its pull request has merged", async () => {
  const { port, retired, starts } = reviewerWith({ listedPulls: () => [approvedPr.url] });
  const ctx = await readyRun(ghFor({ 1: feedbackPull({ state: "MERGED" }) }), REVIEWING, port);
  ctx.pool.releaseReviewers();
  assert.deepEqual(retired, [approvedPr.url], "a reviewer a ticket:review start left is retired");
  assert.deepEqual(starts, [], "and nothing is started");
});

test("a reviewer is not started for a pull request that has merged, even one the pool has forgotten and the tracker still shows open", async () => {
  const { port, starts } = reviewerWith();
  const ctx = await readyRun(ghFor({ 1: feedbackPull({ state: "MERGED" }) }), REVIEWING, port);
  ctx.pool.watchFeedback();
  await roundStarted();
  assert.deepEqual(starts, [], "no reviewer is started for a merged pull request");
});

// A11-83: a reviewer that ended without its verdict on its head. The pool posts the verdict file again, prompts a reviewer that wrote none, and says on
// the run what is still not posted, with the attempts bounded and remembered.

/**
 * A reviewer port whose reviewer has ended without a review on its head: `settled` answers `settled`, its verdict file is `file`, and each repost
 * answers the next of `reposts`. `posts` and `prompts` record what the pool asked, in order.
 */
function unpostedReviewer({ file = "/work/verdict-1.md" as string | null, reposts = [] as RepostAnswer[], settled = "ended" as ReviewerSettled } = {}) {
  const starts: ReviewerRef[] = [];
  const posts: { ref: ReviewerRef; file: string }[] = [];
  const prompts: ReviewerRef[] = [];
  const answers = [...reposts];
  const port: ReviewerPort = {
    start(ref) { starts.push(ref); return { label: "reviewer-7" }; },
    live: () => false,
    ...idleTeardown,
    settled: () => settled,
    verdictFileOf: () => file,
    repostVerdict(ref, path) { posts.push({ ref, file: path }); return answers.shift() ?? { refusal: "no answer was set", final: false }; },
    reprompt(ref) { prompts.push(ref); return { prompted: true }; },
  };
  return { port, starts, posts, prompts };
}

/** The pool's view of the verdict NBF-1's pull request is missing, which is what each test below starts from: no review by the reviewer at `h1`. */
const NOT_POSTED = "verdict not posted";

test("a reviewer that ended with its verdict file written and no review at its head has the file posted again, once, and nothing more once it is on the pull request", async () => {
  const reviews: unknown[] = [];
  const made = unpostedReviewer({ reposts: [{ posted: true }] });
  const ctx = await readyRun(ghFor({ 1: feedbackPull({ reviews }) }), REVIEWING, made.port);
  ctx.pool.watchFeedback();
  await roundStarted();
  assert.deepEqual(made.starts.map((ref) => ref.head), ["h1"], "the reviewer for h1 is started");
  assert.deepEqual(made.posts, [], "a reviewer started in this watch is not judged before it has begun");
  ctx.pool.watchFeedback();
  await roundStarted();
  assert.deepEqual(made.posts, [{ ref: { pr: approvedPr.url, head: "h1" }, file: "/work/verdict-1.md" }], "the verdict file is posted again");
  reviews.push(reviewOn(REVIEWER_LOGIN, "APPROVED", "h1"));
  ctx.pool.watchFeedback();
  await roundStarted();
  assert.equal(made.posts.length, 1, "a review at the head is on the pull request: nothing is posted again");
  assert.equal(ctx.entry("NBF-1").verdictNotPosted, undefined, "and nothing is said of the run");
});

test("a repost refused once and posted on the next watch leaves exactly one posting, and the attempts are forgotten once the review is on the pull request", async () => {
  const reviews: unknown[] = [];
  const made = unpostedReviewer({ reposts: [{ refusal: "the reviewer App token could not be minted: no key", final: false }, { posted: true }] });
  const ctx = await readyRun(ghFor({ 1: feedbackPull({ reviews }) }), REVIEWING, made.port);
  for (let watch = 0; watch < 3; watch += 1) {
    ctx.pool.watchFeedback();
    await roundStarted();
  }
  assert.equal(made.posts.length, 2, "one refused and one posted");
  assert.equal(ctx.entry("NBF-1").verdictNotPosted, undefined, "one refusal is not yet something to say on the run");
  assert.equal(readReviewerMemory(reviewerMemoryPath(ctx.settings.stateDir)).memory.reposts.get(`${approvedPr.url}@h1`)?.attempts, 2, "the attempts are remembered on disk");
  reviews.push(reviewOn(REVIEWER_LOGIN, "APPROVED", "h1"));
  ctx.pool.watchFeedback();
  await roundStarted();
  assert.equal(readReviewerMemory(reviewerMemoryPath(ctx.settings.stateDir)).memory.reposts.size, 0, "and forgotten once the review is on the pull request");
});

test("three refusals surface `verdict not posted: <reason>` on the run, and nothing is posted again, even after a restart", async () => {
  const reason = "the reviewer App token could not be minted: no key file at /keys/reviewer.pem (exit 1)";
  const made = unpostedReviewer({ reposts: [1, 2, 3].map(() => ({ refusal: reason, final: false })) });
  const ctx = await readyRun(ghFor({ 1: feedbackPull() }), REVIEWING, made.port);
  for (let watch = 0; watch < 4; watch += 1) {
    ctx.pool.watchFeedback();
    await roundStarted();
  }
  assert.equal(made.posts.length, 3, "three attempts, and no more");
  assert.equal(ctx.entry("NBF-1").verdictNotPosted, `${NOT_POSTED}: ${reason}`, "the third refusal is said on the run");
  ctx.restart().watchFeedback();
  await roundStarted();
  assert.equal(made.posts.length, 3, "a restarted pool does not reset the attempts");
  assert.equal(ctx.entry("NBF-1").verdictNotPosted, `${NOT_POSTED}: ${reason}`, "and the run keeps saying it");
});

test("a verdict the door refuses for good is said at once, and is not posted again", async () => {
  const reason = "#7 already has a review at an equal patch: APPROVED at 2026-10-16T10:00:00Z";
  const made = unpostedReviewer({ reposts: [{ refusal: reason, final: true }] });
  const ctx = await readyRun(ghFor({ 1: feedbackPull() }), REVIEWING, made.port);
  ctx.pool.watchFeedback();
  await roundStarted();
  ctx.pool.watchFeedback();
  await roundStarted();
  assert.equal(ctx.entry("NBF-1").verdictNotPosted, `${NOT_POSTED}: ${reason}`);
  ctx.pool.watchFeedback();
  await roundStarted();
  assert.equal(made.posts.length, 1, "a refusal the door would repeat is not asked again");
});

test("a reviewer that ended with no verdict file is prompted once, and the second look with no file says so on the run", async () => {
  const made = unpostedReviewer({ file: null });
  const ctx = await reviewedRun(made.port, { 1: feedbackPull() });
  ctx.pool.watchFeedback();
  await roundStarted();
  assert.deepEqual(made.prompts,[{ pr: approvedPr.url, head: "h1" }], "prompted once, as a reviewer that has just started is");
  assert.equal(ctx.entry("NBF-1").verdictNotPosted, undefined, "the first look says nothing yet");
  ctx.pool.watchFeedback();
  await roundStarted();
  assert.equal(ctx.entry("NBF-1").verdictNotPosted, `${NOT_POSTED}: the reviewer ended without writing a verdict file`);
  assert.equal(made.prompts.length, 1, "and is not prompted again");
  assert.deepEqual(made.posts, [], "nothing is posted without a file");
});

test("a reviewer still working is left alone: no repost, prompt or line on the run, and a review already at the head triggers nothing", async () => {
  const working = unpostedReviewer({ settled: "working" });
  const ctx = await readyRun(ghFor({ 1: feedbackPull() }), REVIEWING, working.port);
  for (let watch = 0; watch < 3; watch += 1) {
    ctx.pool.watchFeedback();
    await roundStarted();
  }
  assert.deepEqual([working.posts, working.prompts], [[], []], "nothing is posted or prompted while it works");
  assert.equal(ctx.entry("NBF-1").verdictNotPosted, undefined);

  const reviewed = unpostedReviewer();
  const approved = await readyRun(ghFor({ 1: feedbackPull({ reviews: [reviewOn(REVIEWER_LOGIN, "APPROVED", "h1")] }) }), REVIEWING, reviewed.port);
  for (let watch = 0; watch < 2; watch += 1) {
    approved.pool.watchFeedback();
    await roundStarted();
  }
  assert.deepEqual([reviewed.posts, reviewed.prompts], [[], []], "the negative control: a verdict on the head is on the pull request, so nothing is done");
  assert.equal(approved.entry("NBF-1").verdictNotPosted, undefined);
});

test("a head that moved is not unposted: nothing is posted for the head the reviewer was started for", async () => {
  const made = unpostedReviewer({ reposts: [{ posted: true }] });
  const pulls: Record<number, unknown> = { 1: feedbackPull() };
  const ctx = await readyRun(ghFor(pulls), REVIEWING, made.port);
  ctx.pool.watchFeedback();
  await roundStarted();
  pulls[1] = feedbackPull({ head: "h2" });
  ctx.pool.watchFeedback();
  await roundStarted();
  assert.deepEqual(made.posts, [], "the reviewer for h1 is not asked to post at h2");
  assert.equal(ctx.entry("NBF-1").verdictNotPosted, undefined);
});

test("a review the reviewer posted at its head and a person dismissed is posted, so nothing is re-posted over the dismissal", async () => {
  const made = unpostedReviewer({ reposts: [{ posted: true }] });
  const reviews: unknown[] = [];
  const ctx = await readyRun(ghFor({ 1: feedbackPull({ reviews }) }), REVIEWING, made.port);
  ctx.pool.watchFeedback();
  await roundStarted();
  reviews.push(reviewOn(REVIEWER_LOGIN, "DISMISSED", "h1"));
  for (let watch = 0; watch < 2; watch += 1) {
    ctx.pool.watchFeedback();
    await roundStarted();
  }
  assert.deepEqual([made.posts, made.prompts], [[], []], "the reviewer's dismissed review is on the pull request: its verdict is not unposted");
  assert.equal(ctx.entry("NBF-1").verdictNotPosted, undefined);
});

/*
 * New-ticket runs (A11-94, A11-135): a person's request starts one run of the writer, which files its own ticket and attaches its plan. The board
 * shows the tickets the run's outcome names, each checked against what the hook recorded as the run created it.
 */

const WRITER = { writer: { run: "Run the a11ign:create-ticket skill for this request: {request}, in {dir}." } };
const WRITER_REQUEST: { id: string; request: string; mode: "quick" | "grill"; form: { repo?: string }; model?: string; effort?: string; ticket?: string; startedFrom?: string } = { id: "w1", request: "Show the requests a person made", mode: "quick", form: { repo: "nbl-ui-netbox" } };

/** A pool with `request` queued as a new-ticket run, and the queue unpaused: its run's folder and herdr name are the test's to read. */
function writing(request: Partial<typeof WRITER_REQUEST> = {}, tickets: Record<string, unknown> = WRITER, tracker: TicketSource = source, now?: () => number) {
  const ctx = setup(2, [], tickets, { source: tracker, now });
  ctx.store.set(queueWriter(ctx.store.get(), { ...WRITER_REQUEST, ...request }, 0));
  const name = herdrName(`writer-${request.id ?? WRITER_REQUEST.id}`);
  return { ...ctx, name, dir: writerDir(ctx.settings, request.id ?? WRITER_REQUEST.id), run: () => writerOf(ctx.store.get(), request.id ?? WRITER_REQUEST.id)! };
}

/** A new-ticket run started and seen working: its agent is under way, and the test drives what it does next. */
async function workingRun(request: Partial<typeof WRITER_REQUEST> = {}) {
  const fixture = writing(request);
  await fixture.pool.tick();
  await agentIs(fixture, fixture.name, "working");
  return fixture;
}

/** The record the hook keeps for the keys a run's agent files: one key per line, as the PostToolUse hook appends each (A11-135). */
const recordOf = (keys: readonly string[]): string => keys.map((key) => `${JSON.stringify({ identifier: key })}\n`).join("");

/** The record the hook keeps as the run's agent files each ticket, written into the run's folder. */
function recordFiled(dir: string, keys: readonly string[]): void {
  writeFileSync(join(dir, CREATED_FILE), recordOf(keys));
}

/** A run started, whose agent files `record` and writes `outcome` and then goes `end`: the run's outcome is read once it is idle (A11-135). */
async function filesThenEnds(fixture: ReturnType<typeof writing>, record: string, outcome: Record<string, unknown>, end: string): Promise<void> {
  await fixture.pool.tick();
  writeFileSync(join(fixture.dir, CREATED_FILE), record);
  leaveOutcome(fixture.dir, outcome);
  await agentIs(fixture, fixture.name, "working");
  await agentIs(fixture, fixture.name, end);
  await writerSettled();
}

/** The outcome a writer run's agent writes last: `created` with the keys it filed, or `needs-human` with its reason. */
function leaveOutcome(dir: string, outcome: Record<string, unknown>): void {
  writeFileSync(join(dir, "outcome.json"), JSON.stringify(outcome));
}

/** Let the reads a finished writer run makes (each filed ticket read back from the tracker) settle. */
async function writerSettled(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

/** A tracker that holds the given tickets, read back by key. A ticket it does not hold is not in the tracker. */
function trackerOf(tickets: Record<string, Partial<Ticket>> = {}): TicketSource {
  return { ...source, read: async (key) => (tickets[key] === undefined ? null : { ...ticketOf(key), ...tickets[key] }) as Ticket };
}

/** A ticket as the tracker holds it, for the tracker's reads. */
const ticketOf = (key: string): Ticket => ({ key, title: `Title ${key}`, description: "", url: `https://linear.app/x/${key}`, branch: key.toLowerCase(), status: "Backlog",
  statusOrder: 0, team: "NBF", project: null, priority: 0 }) as Ticket;

test("a writer run's filed tickets are shown once its agent is idle with its outcome: each key the record holds is read back and shown, and a key it does not hold fails the run", async () => {
  const tracker = trackerOf({ "NBF-1": { url: "https://linear.app/x/NBF-1" } });
  const { pool, status, name, dir, run, store } = writing({}, WRITER, tracker);
  await pool.tick();
  recordFiled(dir, ["NBF-1"]);
  leaveOutcome(dir, { kind: "created", created: ["NBF-1", "NBF-9"] });
  status.set(name, "working");
  await pool.tick();
  status.set(name, "idle");
  await pool.tick();
  await writerSettled();
  assert.equal(run().phase, "finished");
  assert.deepEqual(run().tickets.map(({ key, url }) => [key, url]), [["NBF-1", "https://linear.app/x/NBF-1"]], "the ticket made is shown as a link");
  assert.equal(run().failure, "it names NBF-9, a ticket it did not create", "a key the record does not hold fails the run, naming it");
  assert.equal(writerStatus(run()), "failed");
  assert.equal(store.get().entries.length, 0, "no ticket is queued by a writer run");
});

test("a run that files its ticket and attaches its plan ends done, with the key shown; a plan the board requires but the ticket lacks fails it, naming the ticket and still showing it", async () => {
  const withPlan = writing({ id: "p1" }, { ...WRITER, plan: "-plan-[^/]*\\.md$" }, trackerOf({ "NBF-1": { uploads: ["NBF-1-0001-plan-show.md"] } }));
  await filesThenEnds(withPlan, recordOf(["NBF-1"]), { kind: "created", created: ["NBF-1"] }, "done");
  assert.deepEqual([withPlan.run().phase, withPlan.run().failure, writerStatus(withPlan.run())], ["finished", undefined, "done"], "POSITIVE CONTROL: a planned ticket ends done");

  const unplanned = writing({ id: "p2" }, { ...WRITER, plan: "-plan-[^/]*\\.md$" }, trackerOf({ "NBF-2": {} }));
  await filesThenEnds(unplanned, recordOf(["NBF-2"]), { kind: "created", created: ["NBF-2"] }, "done");
  assert.equal(unplanned.run().failure, "NBF-2 has no plan attached", "the run fails naming the ticket");
  assert.deepEqual(unplanned.run().tickets.map(({ key }) => key), ["NBF-2"], "and the ticket is still shown");
});

test("a run whose record cannot be read shows no ticket and fails, and a run whose outcome names no ticket fails as it says", async () => {
  const unreadable = writing({ id: "u1" }, WRITER, trackerOf({ "NBF-1": {} }));
  await filesThenEnds(unreadable, "not a record\n", { kind: "created", created: ["NBF-1"] }, "done");
  assert.deepEqual([unreadable.run().tickets, unreadable.run().failure], [[], `${CREATED_FILE} cannot be read, so the tickets it made cannot be checked`]);

  const none = await workingRun({ id: "u2" });
  leaveOutcome(none.dir, { kind: "created", created: [] });
  await agentIs(none, none.name, "idle");
  await writerSettled();
  assert.match(none.run().failure ?? "", /its created outcome names no ticket/);
});

test("a quick run that stops on a needs-human outcome fails with its reason, and keeps the ticket it filed before it stopped", async () => {
  const fixture = writing({ id: "n1" }, WRITER, trackerOf({ "NBF-3": {} }));
  const { run } = fixture;
  await filesThenEnds(fixture, recordOf(["NBF-3"]), { kind: "needs-human", reason: "the attachment was refused", created: ["NBF-3"] }, "idle");
  assert.deepEqual([run().phase, run().failure, run().tickets.map(({ key }) => key)], ["finished", "the attachment was refused", ["NBF-3"]]);
});

test("a grill run idle between its questions stays running and holds its slot; it is not failed for going idle, and its tickets are shown when its outcome is written", async () => {
  const fixture = writing({ mode: "grill" }, WRITER, trackerOf({ "NBF-1": {} }));
  const { pool, dir, run, store } = fixture;
  await pool.tick();
  await agentIs(fixture, fixture.name, "working");
  await agentIs(fixture, fixture.name, "idle");
  await writerSettled();
  assert.deepEqual([run().phase, run().failure], ["running", undefined], "POSITIVE CONTROL: idle with no outcome is a question, not a failure");
  assert.equal(liveRunCount(store.get()), 1, "it holds its slot while the person answers");
  recordFiled(dir, ["NBF-1"]);
  leaveOutcome(dir, { kind: "created", created: ["NBF-1"] });
  await pool.tick();
  await writerSettled();
  assert.deepEqual([run().phase, run().failure, run().tickets.map(({ key }) => key)], ["finished", undefined, ["NBF-1"]]);
});

test("a Grill turn that ends in a question and no outcome file is Waiting: its pane and slot stay, and the answer resumes it, and its ticket is shown when it is filed", async () => {
  const fixture = writing({ mode: "grill" }, WRITER, trackerOf({ "NBF-1": {} }));
  const { pool, name, dir, run, store, h } = fixture;
  await pool.tick();
  await agentIs(fixture, name, "working");
  // The stop hook records the question the agent ended its turn with, beside the outcome file the agent did not write (A11-129).
  writeFileSync(join(dir, "waiting.json"), JSON.stringify({ question: "Q1: editable or read-only?", at: 100 }));
  await agentIs(fixture, name, "done");
  await writerSettled();
  assert.deepEqual([writerStatus(run()), run().waiting?.question, run().phase, run().failure], ["waiting", "Q1: editable or read-only?", "running", undefined],
    "POSITIVE: a turn that ends in a question is Waiting, not failed");
  assert.equal(run().workspace, "w1", "its workspace stays on the record");
  assert.equal(h.calls.some((args) => args.includes("close")), false, "its pane is not closed");
  assert.equal(liveRunCount(store.get()), 1, "it holds its slot while the person answers");
  await agentIs(fixture, name, "idle");
  assert.equal(run().waiting?.question, "Q1: editable or read-only?", "a later idle pass keeps the same question");
  await agentIs(fixture, name, "working");
  assert.deepEqual([writerStatus(run()), run().waiting], ["writing", undefined], "the answer resumes it: the wait is cleared");
  writeFileSync(join(dir, "waiting.json"), JSON.stringify({ question: "Q2: which goal?", at: 200 }));
  await agentIs(fixture, name, "done");
  await writerSettled();
  assert.equal(run().waiting?.question, "Q2: which goal?", "a new question is shown in place of the last");
  await agentIs(fixture, name, "working");
  recordFiled(dir, ["NBF-1"]);
  leaveOutcome(dir, { kind: "created", created: ["NBF-1"] });
  await agentIs(fixture, name, "idle");
  await writerSettled();
  assert.deepEqual([run().phase, run().failure, writerStatus(run())], ["finished", undefined, "done"]);
  assert.deepEqual(run().tickets.map(({ key }) => key), ["NBF-1"], "the ticket is shown when the grill ends");
});

test("a Grill run whose stop hook wrote no question shows the fixed line, and a Grill needs-human outcome is its question, not a failure", async () => {
  const quiet = await workingRun({ mode: "grill" });
  await agentIs(quiet, quiet.name, "done");
  await writerSettled();
  assert.equal(quiet.run().waiting?.question, "Its agent is waiting for you in its terminal.", "no question on file: the fixed line");

  const asks = await workingRun({ id: "w2", mode: "grill" });
  leaveOutcome(asks.dir, { kind: "needs-human", reason: "Which goal does it serve?" });
  await agentIs(asks, asks.name, "idle");
  await writerSettled();
  assert.deepEqual([writerStatus(asks.run()), asks.run().waiting?.question, asks.run().phase, asks.run().failure], ["waiting", "Which goal does it serve?", "running", undefined]);
  assert.equal(existsSync(join(asks.dir, "outcome.json")), false, "the outcome is moved aside, so it is not read again");
  assert.equal(existsSync(join(asks.dir, "asked.json")), true, "and kept beside it");
  assert.equal(readFileSync(join(asks.dir, "waiting.json"), "utf8").includes("Which goal does it serve?"), true, "its question is on file for the board");
  await agentIs(asks, asks.name, "working");
  assert.equal(asks.run().waiting, undefined, "the person answered: the run is no longer waiting");
});

test("a Quick needs-human outcome still ends the run failed, saying why, and a Quick run that goes done with no outcome has stopped", async () => {
  const quick = await workingRun({ id: "w3" });
  leaveOutcome(quick.dir, { kind: "needs-human", reason: "Which goal does it serve?" });
  await agentIs(quick, quick.name, "idle");
  await writerSettled();
  assert.deepEqual([quick.run().phase, quick.run().failure], ["finished", "Which goal does it serve?"]);
  const stopped = await workingRun({ id: "w4" });
  await agentIs(stopped, stopped.name, "done");
  await writerSettled();
  assert.equal(stopped.run().failure, "it stopped without writing an outcome");
});

test("a Grill run that is Waiting fails only when its agent exits, or when nobody answers for 4 hours; a Waiting run is never timed out by its work's limit", async () => {
  const waiting = await workingRun({ id: "w5", mode: "grill" });
  await agentIs(waiting, waiting.name, "done");
  const waitedSince = (since: number) => waiting.store.set({ ...waiting.store.get(), writers: waiting.store.get().writers!.map((r) => (r.id === "w5" ? { ...r, waiting: { ...r.waiting!, since } } : r)) });
  waitedSince(100 - 4 * 60 * 60_000 + 1);
  await waiting.pool.tick();
  assert.equal(waiting.run().phase, "running", "just inside the answer limit it still waits");
  waitedSince(100 - 4 * 60 * 60_000 - 1);
  await waiting.pool.tick();
  assert.deepEqual([waiting.run().phase, waiting.run().failure], ["finished", "nobody answered its question for 4 hours"]);

  const exited = await workingRun({ id: "w6", mode: "grill" });
  await agentIs(exited, exited.name, "done");
  exited.status.delete(exited.name);
  await exited.pool.tick();
  await exited.pool.tick();
  assert.deepEqual([exited.run().phase, exited.run().failure], ["finished", "its agent exited: its herdr workspace is gone"], "an agent that vanishes fails the run, saying so");

  const answered = await workingRun({ id: "w7", mode: "grill" });
  await agentIs(answered, answered.name, "done");
  setStartedAt(answered, 100 - 5 * 60 * 60_000);
  await agentIs(answered, answered.name, "working");
  assert.deepEqual([answered.run().phase, answered.run().startedAt], ["running", 100], "a run its answer resumes has its working clock from the answer, not from its start");
});

/** Move a writer run's start to `startedAt`, as a test of the limit that counts from it. */
function setStartedAt(fixture: ReturnType<typeof writing>, startedAt: number): void {
  fixture.store.set({ ...fixture.store.get(), writers: fixture.store.get().writers!.map((r) => (r.id === fixture.run().id ? { ...r, startedAt } : r)) });
}

test("a ticket is filed in each mode by a stubbed writer whose record and outcome agree: the run ends done with the key, and no ticket is queued", async () => {
  for (const mode of ["quick", "grill"] as const) {
    const { pool, status, name, dir, run, store } = writing({ id: `m-${mode}`, mode }, WRITER, trackerOf({ "NBF-1": {} }));
    await pool.tick();
    status.set(name, "working");
    await pool.tick();
    recordFiled(dir, ["NBF-1"]);
    leaveOutcome(dir, { kind: "created", created: ["NBF-1"] });
    await agentIs({ pool, status }, name, "idle");
    await writerSettled();
    assert.deepEqual([run().phase, run().failure, run().tickets.map(({ key }) => key), writerStatus(run())], ["finished", undefined, ["NBF-1"], "done"], `${mode}: the run ends done with the key`);
    assert.equal(store.get().entries.length, 0, `${mode}: no ticket is queued`);
  }
});

test("a grill run's first prompt asks its first question, and its brief names the board's mode, which is not the instruction's", async () => {
  const { pool, dir, h, name } = writing({ mode: "grill" }, { writer: { run: "Run the a11ign:create-ticket skill for this request: {request}, in {dir}. Mode: {mode}." } });
  await pool.tick();
  const start = h.calls.find((args) => args.includes("start") && args.includes(name))!;
  assert.ok(start.some((arg) => arg.endsWith("Your first message to me is your first question.")), "the first prompt says the first message is a question");
  const brief = readFileSync(join(dir, "brief.md"), "utf8");
  assert.match(brief, /## The mode\n\nThe board chose this run's mode, and it decides how the run works, whatever the instruction under "What to do" says: `grill`\./);
  assert.match(brief, /Mode: grill\./, "the instruction's {mode} is filled with the board's mode");
  assert.doesNotMatch(brief, /Nobody will answer/);
});

test("A11-159: a new-ticket run is granted the tools of the tracker the host names, and its record hook is matched on that tracker's create tool, not on Linear's", async () => {
  const { pool, dir, run, settings } = writing({}, { ...WRITER, providers: { tracker: { provider: "fake-tracker" } } });
  await pool.tick();
  assert.equal(run().phase, "running");
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "writer-run"), "utf8")), { mode: "quick", tools: ["mcp__fake__create_ticket", "mcp__fake__prepare_upload", "mcp__fake__attach_upload"] });
  const brief = readFileSync(join(dir, "brief.md"), "utf8");
  assert.match(brief, /create the ticket with `mcp__fake__create_ticket`, with no `id`\. Attach files with `mcp__fake__prepare_upload` and `mcp__fake__attach_upload`/);
  const sessionSettings = JSON.parse(readFileSync(join(writerFolder(settings, "w1"), ".claude", "settings.local.json"), "utf8")) as { hooks: { PostToolUse: { matcher: string }[] } };
  assert.deepEqual(sessionSettings.hooks.PostToolUse.map(({ matcher }) => matcher), ["mcp__fake__create_ticket"]);
});

test("a new-ticket run that never ends is failed after 30 minutes of running, and a grill run is not timed out before 4 hours", async () => {
  const { pool, status, name, store, run } = writing({ id: "w3" });
  await pool.tick();
  status.set(name, "working");
  await pool.tick();
  store.set({ ...store.get(), writers: store.get().writers!.map((r) => (r.id === "w3" ? { ...r, startedAt: 100 - 30 * 60_000 - 1 } : r)) });
  await pool.tick();
  assert.deepEqual([run().phase, run().failure], ["finished", "it did not finish within 30 minutes"]);
  assert.equal(writerStatus(run()), "failed");

  const grill = writing({ id: "w4", mode: "grill" });
  await grill.pool.tick();
  grill.status.set(grill.name, "working");
  grill.store.set({ ...grill.store.get(), writers: grill.store.get().writers!.map((r) => (r.id === "w4" ? { ...r, startedAt: 100 - 30 * 60_000 - 1 } : r)) });
  await grill.pool.tick();
  assert.equal(grill.run().phase, "running", "a grill run has longer than the quick limit");
  grill.store.set({ ...grill.store.get(), writers: grill.store.get().writers!.map((r) => (r.id === "w4" ? { ...r, startedAt: 100 - 4 * 60 * 60_000 - 1 } : r)) });
  await grill.pool.tick();
  assert.deepEqual([grill.run().phase, grill.run().failure], ["finished", "it did not finish within 240 minutes"]);
});

test("a new-ticket run starts on a free slot, with the writer's model, its brief naming the request, and the mark that lets it file its ticket and read the tracker", async () => {
  const { pool, settings, dir, name, h, run } = writing();
  await pool.tick();
  assert.equal(run().phase, "running", "it starts");
  assert.deepEqual([run().workspace, run().pane], ["w1", "w1:p1"]);
  const brief = readFileSync(join(dir, "brief.md"), "utf8");
  assert.match(brief, /for this request: Show the requests a person made, in \//, "the instruction, with the request and the folder filled in");
  assert.match(brief, /> Show the requests a person made/, "the request, quoted");
  assert.match(brief, /- Repository: `nbl-ui-netbox`/, "the choices the form made are requirements");
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "writer-run"), "utf8")), { mode: "quick", tools: ["mcp__linear__save_issue", "mcp__linear__prepare_attachment_upload", "mcp__linear__create_attachment_from_upload"] },
    "the mark names the run's mode, and the three tools the board grants it, which lets a grill run end its turn");
  const deny = JSON.parse(readFileSync(join(dir, "deny.json"), "utf8")) as { pattern: string }[];
  assert.ok(deny.some(({ pattern }) => pattern.includes("ticket:worktree")), "a writer changes no repository: the planning refusals apply to it");
  const start = h.calls.find((args) => args.includes("start") && args.includes(name))!;
  assert.ok(start.includes("opus") && start.includes("high"), "the writer's default model and effort");
  assert.equal(settings.writer?.model, "opus");
  assert.ok(existsSync(join(settings.stateDir, "tickets", "writer", "w1")));
  const sessionSettings = JSON.parse(readFileSync(join(writerFolder(settings, "w1"), ".claude", "settings.local.json"), "utf8")) as { hooks: Record<string, unknown> };
  assert.ok("PostToolUse" in sessionSettings.hooks, "its settings record each ticket it files, as the creation returns");
});

test("a new-ticket run starts on the model and effort it was queued with, whatever the host file says, and one queued before they were stamped starts on the host file's", async () => {
  const host = { writer: { ...WRITER.writer, model: "haiku", effort: "low" } };
  const stamped = writing({ model: "sonnet", effort: "max" }, host);
  await stamped.pool.tick();
  const start = stamped.h.calls.find((args) => args.includes("start") && args.includes(stamped.name))!;
  assert.ok(start.includes("sonnet") && start.includes("max") && !start.includes("haiku"), "the stamp is in the agent's flags, and the host file's is not");
  const settingsFile = JSON.parse(readFileSync(join(writerFolder(stamped.settings, "w1"), ".claude", "settings.local.json"), "utf8")) as { model: string };
  assert.equal(settingsFile.model, "sonnet", "and in the run's settings file");
  const unstamped = writing({}, host);
  await unstamped.pool.tick();
  const hostStart = unstamped.h.calls.find((args) => args.includes("start") && args.includes(unstamped.name))!;
  assert.ok(hostStart.includes("haiku") && hostStart.includes("low"), "a run with no stamp starts on the host file's");
});

test("a new-ticket run starts though the queue is paused, as a person asked for it, and holds a slot while it runs", async () => {
  const ctx = writing();
  ctx.store.set(pauseQueue(ctx.store.get()));
  await ctx.pool.tick();
  assert.equal(ctx.run().phase, "running", "Pause does not hold a new-ticket run");
});

test("stopping a new-ticket run closes its workspace, and keeps the tickets it had filed; a run that has ended is left alone", async () => {
  const fixture = await workingRun({ id: "w4" });
  const { run, h, store } = fixture;
  recordFiled(fixture.dir, ["NBF-1"]);
  fixture.pool.stopWriterRun("w4");
  assert.equal(closes(h, "w1"), 1, "the workspace is closed");
  assert.equal(run().phase, "finished");
  assert.equal(run().failure, "stopped on the board");
  assert.deepEqual(run().tickets.map(({ key }) => key), ["NBF-1"], "the ticket it filed before the stop stays, and is shown");
  assert.equal(store.get().writers?.length, 1);
  fixture.pool.stopWriterRun("w4");
  assert.equal(closes(h, "w1"), 1, "a second stop closes nothing");
});

test("a stopped run whose record cannot be read says so, and shows no ticket it cannot read (A11-135)", async () => {
  const fixture = await workingRun({ id: "w9" });
  writeFileSync(join(fixture.dir, CREATED_FILE), "not a record\n");
  fixture.pool.stopWriterRun("w9");
  assert.deepEqual([fixture.run().tickets, fixture.run().failure], [[], `stopped on the board; ${CREATED_FILE} cannot be read, so the tickets it filed cannot be shown`]);
});

test("after a restart, a new-ticket run herdr still lists is adopted, and one it does not list fails", async () => {
  const { pool, status, name, run, restart } = writing({ id: "w5" });
  await pool.tick();
  status.set(name, "working");
  restart().reconcile();
  assert.equal(run().phase, "running", "a run herdr lists is adopted, its agent sent no key");
  status.delete(name);
  restart().reconcile();
  assert.deepEqual([run().phase, run().failure], ["finished", "the pool restarted while it was running"]);
});

test("at most one new-ticket run starts at a time on a machine with one slot, and a second waits for the first", async () => {
  const ctx = setup(1, [], WRITER);
  ctx.store.set(queueWriter(queueWriter(ctx.store.get(), WRITER_REQUEST, 0), { ...WRITER_REQUEST, id: "w6" }, 0));
  await ctx.pool.tick();
  assert.deepEqual(ctx.store.get().writers?.map((r) => r.phase), ["running", "queued"]);
});

test("a machine that names no writer starts no new-ticket run, and a run that cannot start says why", async () => {
  const ctx = writing({ id: "w7" }, {});
  await ctx.pool.tick();
  assert.deepEqual([ctx.run().phase, ctx.run().failure], ["finished", "this machine names no tickets.writer"]);
});

test("A11-106: the sweep asks the code host about the open pull requests of a run stacked on its blocker's branch, and records the note it answers for one it cannot move", async () => {
  const world = ghFor({ 1: feedbackPull() });
  const asked: { urls: readonly string[]; stacked: string[] }[] = [];
  const notes: Record<string, string> = {};
  const codeHost: CodeHost = { ...world.codeHost, sweepRetargets: ({ urls, stacked }) => { asked.push({ urls, stacked: [...stacked] }); return { ...notes }; } };
  const ctx = await readyPrRun({ ...world, codeHost });
  withBlockerOn(ctx.store, "NBF-1", "nbf-1-fit");
  ctx.pool.retargetStacked();
  assert.deepEqual(asked, [{ urls: [approvedPr.url], stacked: ["nbf-1-fit"] }], "the run's open pull request is asked, with the branch of its blocker it was stacked on");
  assert.equal(ctx.entry("NBF-1").retargets, undefined, "the host moved it and said nothing, so nothing is recorded on the run");
  const note = `Needs retarget: ${approvedPr.url} still targets nbf-1-fit, whose pull request merged; retarget failed, and agent-org tries again: gh: Resource not accessible by integration (HTTP 403)`;
  notes[approvedPr.url] = note;
  ctx.pool.retargetStacked();
  assert.equal(asked.length, 2, "it is asked again on the next sweep");
  assert.deepEqual(ctx.entry("NBF-1").retargets, { [approvedPr.url]: note }, "the note the code host answered is the run's, and the board shows it");
  delete notes[approvedPr.url];
  ctx.pool.retargetStacked();
  assert.equal(ctx.entry("NBF-1").retargets, undefined, "once the host says nothing, the note is cleared");
});

/** Gives the run `key` a blocker whose pull request is on `branch`, as a run stacked on that blocker keeps (`queue.ts`'s `ended` keeps its blockers). */
function withBlockerOn(store: { get: () => Queue; set: (next: Queue) => void }, key: string, branch: string) {
  const queue = store.get();
  const blocker = { key: "NBF-0", state: "started", status: "In Review", branch, pulls: {} };
  store.set({ ...queue, entries: queue.entries.map((entry) => (entry.ticket.key === key ? { ...entry, blockers: [blocker] } : entry)) });
}

test("A11-106: a run that has not finished is not swept, so its pull requests are not asked and its queue is not written", async () => {
  const world = ghFor({ 1: feedbackPull() });
  const asked: unknown[] = [];
  const ctx = await readyPrRun({ ...world, codeHost: { ...world.codeHost, sweepRetargets: (sweep) => { asked.push(sweep); return {}; } } });
  withBlockerOn(ctx.store, "NBF-1", "nbf-1-fit");
  const finished = ctx.store.get();
  ctx.store.set({ ...finished, entries: finished.entries.map((entry) => ({ ...entry, phase: "running" })) });
  const before = ctx.store.get();
  ctx.pool.retargetStacked();
  assert.deepEqual(asked, [], "no pull request of a run that is not finished is asked about");
  assert.equal(ctx.store.get(), before, "and the queue is not written: the same object comes back");
});

// `tickets.preflight` (a host's own condition for starting work): while a command fails, no ticket run starts, and the board is told why.
const FAILING_LOGIN = { name: "fontawesome login", run: "check-login", timeoutSeconds: 30 };
const answering = (answers: { status: number | null; output: string }[]) => {
  const asked: string[] = [];
  const exec: PreflightExec = async (command) => { asked.push(command); const a = answers[Math.min(asked.length - 1, answers.length - 1)]; return { status: a.status, timedOut: false, output: a.output }; };
  return { exec, asked };
};

test("preflight: a failing command holds every start, the runs stay Queued, and the pool says which command and why", async () => {
  const { exec } = answering([{ status: 1, output: "EXPIRED: run assume repo-resources\nsecond line" }]);
  const { pool, entry, h } = setup(2, ["NBF-1", "NBF-2"], { preflight: [FAILING_LOGIN] }, { preflight: exec });
  await pool.tick();
  assert.deepEqual(["NBF-1", "NBF-2"].map((k) => entry(k).phase), ["queued", "queued"]);
  assert.ok(!h.calls.some((args) => args.includes("start")), "no worker was started");
  assert.deepEqual({ ...pool.held()!, since: 0 }, { name: "fontawesome login", reason: "EXPIRED: run assume repo-resources", since: 0 });
});

test("preflight: a command that passes starts the runs, and a pass stands, so the command is not run at every tick", async () => {
  let clock = 100_000;
  const { exec, asked } = answering([{ status: 0, output: "" }]);
  const { pool, entry } = setup(1, ["NBF-1", "NBF-2"], { preflight: [FAILING_LOGIN] }, { preflight: exec, now: () => clock });
  await pool.tick();
  assert.equal(entry("NBF-1").phase, "running");
  assert.equal(pool.held(), null);
  clock += 10_000;
  await pool.tick();
  assert.equal(asked.length, 1, "within a minute of a pass the command is not asked again");
});

test("preflight: a held queue starts its runs once the command passes, and the reason is gone", async () => {
  let clock = 100_000;
  const { exec, asked } = answering([{ status: 1, output: "expired" }, { status: 0, output: "" }]);
  const { pool, entry } = setup(1, ["NBF-1"], { preflight: [FAILING_LOGIN] }, { preflight: exec, now: () => clock });
  await pool.tick();
  assert.equal(entry("NBF-1").phase, "queued");
  assert.equal(pool.held()?.reason, "expired");
  clock += 30_000;
  await pool.tick();
  assert.equal(asked.length, 1, "a failure is tried again only after a minute");
  clock += 31_000;
  await pool.tick();
  assert.equal(entry("NBF-1").phase, "running");
  assert.equal(pool.held(), null);
});

test("preflight: a host that names none runs no command and holds nothing", async () => {
  const { exec, asked } = answering([{ status: 1, output: "would refuse" }]);
  const { pool, entry } = setup(1, ["NBF-1"], {}, { preflight: exec });
  await pool.tick();
  assert.equal(entry("NBF-1").phase, "running");
  assert.deepEqual([asked.length, pool.held()], [0, null]);
});

test("preflight: nothing is asked while nothing is waiting to start", async () => {
  const { exec, asked } = answering([{ status: 1, output: "would refuse" }]);
  const { pool } = setup(1, [], { preflight: [FAILING_LOGIN] }, { preflight: exec });
  await pool.tick();
  assert.equal(asked.length, 0);
});

const SHELL_TRY_MS = 500;
const SHELL_TRIES = 30;
const BUSY = "agent_pane_busy";

/** A pool starting NBF-1 while herdr refuses its agent starts with `refusals`, in order, and every half-second wait it makes. */
async function startRefused(refusals: string[]) {
  const waits: number[] = [];
  const made = setup(1, ["NBF-1"], {}, { wait: async (ms) => { waits.push(ms); } });
  made.h.refusals.push(...refusals);
  await made.pool.tick();
  const starts = made.h.calls.filter((args) => args.includes("start")).length;
  return { ...made, starts, shellWaits: waits.filter((ms) => ms === SHELL_TRY_MS) };
}

test("a start waits for a new pane's shell, and goes on once herdr accepts it", async () => {
  const { h, entry, starts, shellWaits } = await startRefused([BUSY, BUSY, BUSY]);
  assert.equal(entry("NBF-1").phase, "running");
  assert.equal(shellWaits.length, 3, "one half-second wait for each refusal");
  assert.equal(h.calls.filter((args) => args.includes("create")).length, 1, "the same workspace is started again, not a new one");
  assert.equal(starts, 4);
});

test("a pane whose shell never comes up fails the run after 30 tries, and closes its workspace", async () => {
  const { h, entry, starts, shellWaits } = await startRefused(Array(1000).fill(BUSY));
  const outcome = entry("NBF-1").outcome;
  assert.equal(outcome?.kind, "crashed");
  assert.match(outcome?.kind === "crashed" ? outcome.reason : "", /herdr could not start Claude for NBF-1/);
  assert.equal(starts, SHELL_TRIES);
  assert.equal(shellWaits.length, SHELL_TRIES - 1);
  assert.ok(h.calls.some((args) => args.includes("close")), "the workspace it opened is closed");
});

test("any other refusal fails the start at once, without waiting", async () => {
  const { entry, starts, shellWaits } = await startRefused(["agent_pane_not_found"]);
  assert.equal(entry("NBF-1").outcome?.kind, "crashed");
  assert.equal(shellWaits.length, 0);
  assert.equal(starts, 1);
});

test("a refusal that is not the busy one ends the waiting at once, after some busy ones", async () => {
  const { entry, starts, shellWaits } = await startRefused([BUSY, BUSY, "agent_pane_not_found"]);
  assert.equal(entry("NBF-1").outcome?.kind, "crashed");
  assert.equal(shellWaits.length, 2);
  assert.equal(starts, 3);
});

/** A ticket that still holds an open decision in its Acceptance: the line the start guard names (A11-134). */
const OPEN_DECISION = "## Acceptance\n\n### 4. Decide whether to isolate the failing ticket or keep the stall\n";

/** NBF-1's work run is held for its open decision: it ends needs-human with the line, and no worker was started (A11-134). */
function assertHeldForDecision(made: ReturnType<typeof setup>): void {
  const outcome = made.entry("NBF-1").outcome;
  assert.equal(outcome?.kind, "needs-human");
  assert.match(outcome?.kind === "needs-human" ? outcome.reason : "", /Decide whether to isolate the failing ticket or keep the stall/);
  assert.equal(made.h.calls.some((args) => args.includes("start")), false, "no worker is started");
}

test("A11-134: a work run never starts on a ticket with an open decision: it ends needs-human with the line, and no worker is started", async () => {
  const made = setup(1, ["NBF-1"]);
  const queue = made.store.get();
  made.store.set({ ...queue, entries: queue.entries.map((e) => ({ ...e, ticket: { ...e.ticket, description: OPEN_DECISION } })) });
  await made.pool.tick();
  assertHeldForDecision(made);
});

/** NBF-1 planned by a planning run whose one plan file says `plan`, once the run is read: the plans the tracker took, and the ticket (A11-134). */
async function plannedWith(plan: string) {
  const { tracker, attached } = planTracker();
  const made = setup(1, ["NBF-1"], PLANNER, { source: tracker, planFirst: ["NBF-1"] });
  await made.pool.tick();
  const dir = ticketDir(made.settings, "NBF-1");
  writeFileSync(join(dir, "plan", "NBF-1-0001-plan-fit.md"), plan);
  await endWith({ pool: made.pool, status: made.status }, dir, herdrName("NBF-1"), { kind: "planned" });
  await settled();
  return { attached, entry: made.entry };
}

test("A11-134: a plan that records a product decision as made without asking is refused whole: nothing is attached, and the ticket ends for a person", async () => {
  const { attached, entry } = await plannedWith("# Fit\n\n## Decisions made without a person\n\n- Technical: the phrase list.\n- Product: the empty state says none.\n");
  assert.deepEqual(attached, [], "nothing is attached");
  const outcome = entry("NBF-1").outcome;
  assert.equal(outcome?.kind === "needs-human" ? outcome.reason : "", "the plan records a product decision made without asking: - Product: the empty state says none.");
});

test("A11-134: a plan whose decisions are all Technical is attached as any plan is", async () => {
  const { attached } = await plannedWith("# Fit\n\n## Decisions made without a person\n\n- Technical: the phrase list.\n");
  assert.deepEqual(attached.map(({ key }) => key), ["NBF-1"]);
});

/** A Grill run on NBF-1 whose ticket says `current` now and held `startedFrom` when the Grill started, on a tracker that records each write (A11-134). */
function grilling(current: string, startedFrom: string = current) {
  const written: { key: string; text: { title?: string; description?: string } }[] = [];
  const tracker: TicketSource = { ...trackerOf({ "NBF-1": { description: current } }), updateTicketText: async (key, text) => { written.push({ key, text }); } };
  const fixture = writing({ id: "g1", request: "Grill NBF-1", mode: "grill", form: {}, ticket: "NBF-1", startedFrom }, WRITER, tracker);
  return { ...fixture, written };
}

/** A Grill run's agent works, leaves its answers and its outcome, and goes idle: the run's outcome is read (A11-134). */
async function grillEnds(fixture: ReturnType<typeof grilling>, outcome: Record<string, unknown>, answers?: string): Promise<void> {
  await fixture.pool.tick();
  await agentIs(fixture, fixture.name, "working");
  if (answers !== undefined) writeFileSync(join(fixture.dir, DECISIONS_FILE), answers);
  leaveOutcome(fixture.dir, outcome);
  await agentIs(fixture, fixture.name, "idle");
  await writerSettled();
}

const GRILLED_TEXT = "## Acceptance\n\n- Decide whether the list sorts.\n";

test("A11-134: a Grill run that ends decided writes its answers under the ticket's text, with the marker that settles them, and files no ticket", async () => {
  const fixture = grilling(GRILLED_TEXT);
  await grillEnds(fixture, { kind: "decided", ticket: "NBF-1" }, "## Decisions\n\n**Sort?** Yes.\n");
  assert.deepEqual(fixture.written, [{ key: "NBF-1", text: { description: `${GRILLED_TEXT.trimEnd()}\n\n## Decisions\n\n**Sort?** Yes.\n\n**Decisions:** settled` } }]);
  assert.deepEqual([fixture.run().phase, fixture.run().failure, fixture.run().tickets, writerStatus(fixture.run())], ["finished", undefined, [], "done"]);
  assert.equal(fixture.store.get().entries.length, 0, "no ticket is queued");
});

test("A11-134: a Grill whose ticket changed while it ran writes nothing, and the run fails saying so", async () => {
  const fixture = grilling("## Acceptance\n\n- Decide whether the list sorts, and the rows too.\n", GRILLED_TEXT);
  await grillEnds(fixture, { kind: "decided", ticket: "NBF-1" }, "## Decisions\n\n**Sort?** Yes.\n");
  assert.deepEqual(fixture.written, []);
  assert.equal(writerStatus(fixture.run()), "failed");
  assert.match(fixture.run().failure ?? "", /NBF-1 changed while it was grilled, so nothing was written: Grill it again/);
});

test("A11-134: a Grill that answered no section the ticket still needs ends failed, naming the section", async () => {
  const fixture = grilling(GRILLED_TEXT);
  await grillEnds(fixture, { kind: "decided", ticket: "NBF-1" }, "## Behaviour\n\n**Empty?** Says none.\n");
  assert.deepEqual(fixture.written, []);
  assert.match(fixture.run().failure ?? "", /decisions\.md has no ## Decisions section, which NBF-1 still needs/);
});

test("A11-134: a Grill run's brief grills its ticket, and the run is granted no tool that files a ticket", async () => {
  const fixture = grilling(GRILLED_TEXT);
  await fixture.pool.tick();
  const brief = readFileSync(join(fixture.dir, "brief.md"), "utf8");
  assert.match(brief, /^# Grill NBF-1: Title NBF-1\n/);
  assert.match(brief, /File no ticket, attach nothing, and change nothing in the tracker/);
  assert.deepEqual(JSON.parse(readFileSync(join(fixture.dir, WRITER_FILE), "utf8")).tools, []);
});

test("A11-134: a decision the tracker gains after a ticket is queued holds its work run too: the run ends needs-human with the line, and no worker is started", async () => {
  // Queued clean: the copy the queue holds has no open decision, but the tracker now says the Acceptance leaves one open.
  const made = setup(1, ["NBF-1"], {}, { source: trackerOf({ "NBF-1": { description: OPEN_DECISION } }) });
  await made.pool.tick();
  assertHeldForDecision(made);
});

/** A pool whose one run, NBF-1, ended with a draft pull request, as `approvedRun` has it, before anyone approves it. */
async function draftOfNbf1(options: { transcript?: boolean } = {}) {
  const ctx = setup(1, ["NBF-1"]);
  const { pool, status, settings, root } = ctx;
  await pool.tick();
  status.set(herdrName("NBF-1"), "idle");
  const dir = ticketDir(settings, "NBF-1");
  writeFileSync(join(dir, "outcome.json"), JSON.stringify({ kind: "draft-pr", prs: [approvedPr] }));
  if (options.transcript !== false) {
    mkdirSync(join(root, "transcripts", "-Users-me-work"), { recursive: true });
    writeFileSync(join(root, "transcripts", "-Users-me-work", "session-t-nbf-1.jsonl"), "{}\n");
  }
  await pool.tick();
  status.delete(herdrName("NBF-1"));
  ctx.h.calls.length = 0;
  return { ...ctx, dir };
}

test("a person who talks to a finished draft's run resumes its own session, told a person is here", async () => {
  const { pool, h, entry, dir } = await draftOfNbf1();
  assert.equal(entry("NBF-1").phase, "finished");
  pool.talk("NBF-1");
  assert.equal(entry("NBF-1").talk, true);
  await pool.tick();
  const start = h.calls.find((args) => args.includes("start"))!;
  const tail = start.slice(start.indexOf("--") + 1);
  assert.match(tail[0], /^A person has opened this session to talk to you\./);
  assert.deepEqual(tail.slice(tail.indexOf("--resume"), tail.indexOf("--resume") + 2), ["--resume", "session-t-nbf-1"]);
  assert.equal(entry("NBF-1").phase, "running");
  assert.ok(entry("NBF-1").workspace !== undefined, "its terminal is open");
  assert.equal(existsSync(join(dir, "outcome.json")), true, "the outcome it ended on stays where it is");
  assert.equal(existsSync(join(dir, STALE_OUTCOME_FILE)), true, "and is marked stale, so the stop hook asks for a new one");
  assert.equal(h.calls.filter((args) => args.includes("create")).length, 1);
});

test("a talk session that ends on a new outcome ends the run as any run ends", async () => {
  const { pool, status, entry, dir } = await draftOfNbf1();
  pool.talk("NBF-1");
  await pool.tick();
  await agentIs({ pool, status }, herdrName("NBF-1"), "working");
  await endWith({ pool, status }, dir, herdrName("NBF-1"), { kind: "draft-pr", prs: [approvedPr] });
  assert.equal(entry("NBF-1").phase, "finished");
  assert.equal(entry("NBF-1").outcome?.kind, "draft-pr");
  assert.equal(entry("NBF-1").talk, undefined, "the finished run is no longer a talk session");
  assert.equal(entry("NBF-1").review, undefined, "the pull requests it kept linked meanwhile do not make it a review round");
});

test("a run with no saved session cannot be talked to, and is left as it was", async () => {
  const { pool, entry } = await draftOfNbf1({ transcript: false });
  assert.throws(() => pool.talk("NBF-1"), /no saved session to resume/);
  assert.equal(entry("NBF-1").talk, undefined);
  assert.equal(entry("NBF-1").outcome?.kind, "draft-pr");
});

test("a talk session that cannot start puts the finished run back on the board as it was", async () => {
  const { pool, h, entry } = await draftOfNbf1();
  pool.talk("NBF-1");
  h.refused.add("start");
  await pool.tick();
  assert.equal(entry("NBF-1").phase, "finished");
  assert.equal(entry("NBF-1").outcome?.kind, "draft-pr");
  assert.equal(entry("NBF-1").talk, undefined);
});

test("a run is talked to only once it is finished, and not while its terminal is already open", async () => {
  const { pool, store, entry } = await draftOfNbf1();
  const queued = store.get();
  assert.equal(talk(queued, "NBF-9", 5), queued, "no such run");
  pool.talk("NBF-1");
  const talking = store.get();
  assert.equal(talk(talking, "NBF-1", 6), talking, "a run that is not finished");
  assert.equal(entry("NBF-1").phase, "queued");
});

test("a talk session whose agent waits for the person keeps the draft's pull requests linked, and a second press changes nothing", async () => {
  const { pool, status, entry, dir } = await draftOfNbf1();
  pool.talk("NBF-1");
  pool.talk("NBF-1");
  assert.equal(entry("NBF-1").phase, "queued", "the second press is not an error");
  await pool.tick();
  await endWith({ pool, status }, dir, herdrName("NBF-1"), { kind: "needs-human", reason: "waiting for the person in the terminal" });
  assert.equal(entry("NBF-1").outcome?.kind, "needs-human");
  assert.ok(entry("NBF-1").workspace !== undefined, "parked: its terminal stays open for the person");
  assert.deepEqual(entry("NBF-1").review?.map((pr) => pr.url), [approvedPr.url], "the draft stays linked");
});

test("a queued talk session taken off the board puts the finished run back, and a failed start takes its stale mark off", async () => {
  const { pool, h, entry, dir } = await draftOfNbf1();
  pool.talk("NBF-1");
  await pool.remove("NBF-1");
  assert.equal(entry("NBF-1").phase, "finished");
  assert.equal(entry("NBF-1").outcome?.kind, "draft-pr");
  pool.talk("NBF-1");
  h.refused.add("start");
  await pool.tick();
  assert.equal(existsSync(join(dir, "outcome.json")), true, "the outcome file was never moved");
  assert.equal(existsSync(join(dir, STALE_OUTCOME_FILE)), false, "and the run is back on the board as it was, with no stale mark");
});

test("a worker's brief has it do a design check on a machine with tickets.designTools, and decline it otherwise", async () => {
  const declined = await startedRun();
  assert.match(readFileSync(join(declined.dir, "brief.md"), "utf8"), /decline it with "unattended worker, no design tool access"/);
  const allowed = await startedRun({ designTools: true });
  const brief = readFileSync(join(allowed.dir, "brief.md"), "utf8");
  assert.match(brief, /If a design gate asks for a design check, do it/);
  assert.doesNotMatch(brief, /no design tool access/);
});

/** A tracker whose one pull request of NBF-1 is in `pull.state`, which a test moves as the pull request does; `completed` is each ticket the board completed. */
function movingTracker() {
  const pull = { state: "open" as PullState };
  const completed: [string, string][] = [];
  const tracker: TicketSource = { ...source,
    stateTypes: async (keys) => new Map(keys.map((key) => [key, "started"])),
    pullStates: async () => new Map([["NBF-1", { [approvedPr.url]: pull.state }]]),
    complete: async (key, comment) => { completed.push([key, comment]); return null; } };
  return { tracker, pull, completed };
}

/** The approval a reviewer other than the workers' account left on commit `oid`. */
const approvalAt = (oid: string) => ({ state: "APPROVED", submittedAt: at(5), author: { login: "a11ign-reviewer" }, commit: { oid } });

test("A11-153 done-when: a needs-human run goes from Needs you to Answered to Completed as its pull request is pushed to and merged, with no hand step", async () => {
  const pulls: Record<number, unknown> = { 1: feedbackPull({ head: "h1" }) };
  const { tracker, pull, completed } = movingTracker();
  const { pool, entry } = await parkedOnQuestion(ghFor(pulls), tracker);
  assert.deepEqual(entry("NBF-1").outcomeHeads, { [approvedPr.url]: "h1" }, "the head the pull request was at when the run ended is recorded by the end of the run");
  pool.watchFeedback();
  await pool.refreshTracker();
  assert.deepEqual([runStatus(entry("NBF-1")), reasonOf(entry("NBF-1")).line], ["needs-you", "which colour?"], "nothing has answered it: a watch of an unchanged pull request changes nothing");
  pulls[1] = feedbackPull({ head: "h2" });
  pool.watchFeedback();
  assert.deepEqual(entry("NBF-1").pullHeads, { [approvedPr.url]: { head: "h2", approved: false } });
  assert.deepEqual([runStatus(entry("NBF-1")), reasonOf(entry("NBF-1"))], ["awaiting-review", { line: "Answered: awaiting review", question: "which colour?" }]);
  assert.equal(completed.length, 0, "answered is not merged: the ticket is left open");
  pull.state = "merged";
  await pool.refreshTracker();
  assert.deepEqual([runStatus(entry("NBF-1")), entry("NBF-1").closedByBoard], ["completed", true]);
  assert.deepEqual(completed.map(([key]) => key), ["NBF-1"], "and its ticket was moved to done, once");
});

test("A11-153: a needs-human run whose pull request a reviewer approved at its head reads Approved, and a push after that approval reads Answered", async () => {
  const pulls: Record<number, unknown> = { 1: feedbackPull({ head: "h1" }) };
  const { pool, entry } = await parkedOnQuestion(ghFor(pulls));
  pulls[1] = feedbackPull({ head: "h1", reviews: [approvalAt("h1")] });
  pool.watchFeedback();
  assert.deepEqual([runStatus(entry("NBF-1")), reasonOf(entry("NBF-1")).line], ["awaiting-review", "Approved"]);
  pulls[1] = feedbackPull({ head: "h2", reviews: [approvalAt("h1")] });
  pool.watchFeedback();
  assert.deepEqual([runStatus(entry("NBF-1")), reasonOf(entry("NBF-1")).line], ["awaiting-review", "Answered: awaiting review"], "an approval of an earlier head is no approval of this one");
});

test("A11-153: a run stored before heads were recorded, or whose end could not read its pull request, takes its first watch as the head it ended at", async () => {
  const pulls: Record<number, unknown> = { 1: feedbackPull({ head: "h1" }) };
  const { pool, entry, store } = await parkedOnQuestion(ghFor(pulls));
  store.set({ ...store.get(), entries: store.get().entries.map(({ outcomeHeads: _recorded, ...rest }) => rest) });
  pool.watchFeedback();
  assert.deepEqual(entry("NBF-1").outcomeHeads, { [approvedPr.url]: "h1" });
  pulls[1] = feedbackPull({ head: "h2" });
  pool.watchFeedback();
  assert.deepEqual(entry("NBF-1").outcomeHeads, { [approvedPr.url]: "h1" }, "a later head is not taken for the one it ended at");
  assert.equal(runStatus(entry("NBF-1")), "awaiting-review");
});

test("A11-153: a conflict a stacked run records with its blocker's branch clears once its pull request is mergeable, and not while GitHub is still computing", async () => {
  const stackBase = { key: "NBF-0", repo: approvedPr.repo, branch: "nbf-0", sha: "a".repeat(40), conflict: { head: "b".repeat(40), files: ["src/install/doctor.ts"] } };
  const pulls: Record<number, unknown> = { 1: feedbackPull({ mergeable: "UNKNOWN", mergeStateStatus: "UNKNOWN" }) };
  const { pool, entry, store } = await parkedOnQuestion(ghFor(pulls));
  store.set(recordStackBase(store.get(), "NBF-1", stackBase));
  assert.equal(rebaseNote(entry("NBF-1")), "Resolving a conflict with NBF-0 in doctor.ts");
  pool.watchFeedback();
  assert.equal(rebaseNote(entry("NBF-1")), "Resolving a conflict with NBF-0 in doctor.ts", "UNKNOWN is not mergeable yet: the note stays");
  pulls[1] = feedbackPull({ mergeable: "MERGEABLE", mergeStateStatus: "CLEAN" });
  pool.watchFeedback();
  assert.equal(rebaseNote(entry("NBF-1")), null, "the pull request is mergeable: the conflict is gone");
  assert.deepEqual(entry("NBF-1").stackBase, { key: "NBF-0", repo: approvedPr.repo, branch: "nbf-0", sha: "b".repeat(40) }, "branched from the head that conflicted, so it is not merged again");
});

test("A11-153: a merge agent-org pushes to a finished run's branch moves its outcome head with it, so the push is not read as an answer", async () => {
  const { pool, entry, worktree, setRun, moveBlocker } = stackedRun("ticket-pool-answer-");
  const own = gitIn(worktree, ["rev-parse", "HEAD"]);
  setRun({ ...FINISHED_WATCHED, outcome: { kind: "needs-human", reason: "which colour?" }, review: [PULL], outcomeHeads: { [PULL.url]: own } });
  moveBlocker("blocker.txt", "one\ntwo\n");
  await pool.rebaseStacked();
  const merged = gitIn(worktree, ["rev-parse", "HEAD"]);
  assert.notEqual(merged, own);
  assert.deepEqual(entry("NBF-2").outcomeHeads, { [PULL.url]: merged });
  setRun({ pullHeads: { [PULL.url]: { head: merged, approved: false } } });
  assert.equal(runStatus(entry("NBF-2")), "needs-you", "its pull request is at the merge agent-org made, which answers nothing");
});

test("A11-153: the end of a run reads its pull requests' heads only for a draft or ready pull request and for a run that asks, and a review round that ends reviewed reads none", async () => {
  const gh = ghFor({ 1: feedbackPull({ head: "h1" }) });
  const { entry } = await readyRun(gh);
  const reads = gh.host.calls.filter((call) => call.startsWith("readPullFeedback")).length;
  assert.equal(reads, 1, "the draft's end read it once; the reviewed end of the round after it read nothing");
  assert.equal(entry("NBF-1").outcomeHeads, undefined, "and a reviewed run records no heads");
});

// A11-154: a red check at a pull request's current head starts a fix round by itself, once for each head, with the failing checks and their log lines.
const HEAD_1 = `1a2b3c4d${"0".repeat(32)}`;
const HEAD_2 = `5e6f7a8b${"0".repeat(32)}`;
const jobPage = (id: number) => `https://github.com/x/nbl-ui-netbox/actions/runs/${id * 10}/job/${id}`;
const redCheck = (name: string, id: number, minute = 400) => ({ __typename: "CheckRun", name, conclusion: "FAILURE", completedAt: at(minute), detailsUrl: jobPage(id), isRequired: false });
const stamped = (lines: string[]) => lines.map((line) => `2026-10-20T10:00:00.1234567Z ${line}`).join("\n");
/** The log of a job whose test failed: the runner's noise, the failing test, and the exit code every failed step ends on. */
const TEST_FAILED = stamped(["##[group]Run npm test", "npm warn deprecated left-pad@1.0.0", "not ok 3 - git spawn classification", "AssertionError: expected 1 to equal 2", "##[error]Process completed with exit code 1."]);
const RUNNER_LOST = stamped(["Run npm test", "##[error]The hosted runner lost communication with the server.", "##[error]Process completed with exit code 143."]);
const BAD_GATEWAY = stamped(["Run gh api repos/x/y", "gh: HTTP 502: Server Error", "##[error]Process completed with exit code 1."]);
const NETWORK_DOWN = stamped(["Run npm ci", "npm error code ECONNRESET", "npm error network aborted", "##[error]Process completed with exit code 1."]);

/** A world whose gh answers the log of an Actions job from `logs` (by job id, refused for any other), records each read and each rerun of a workflow run, and leaves every other call to `base`. */
function withCi(base: World, logs: Record<number, string>): World & { reruns: string[][]; logReads: number[] } {
  const reruns: string[][] = [];
  const logReads: number[] = [];
  const run = (args: string[]) => {
    const job = args[0] === "api" ? /\/actions\/jobs\/(\d+)\/logs$/.exec(args[1] ?? "") : null;
    if (job !== null) {
      logReads.push(Number(job[1]));
      if (!(Number(job[1]) in logs)) throw new Error("gh exited 1");
      return logs[Number(job[1])];
    }
    if (args[0] === "run" && args[1] === "rerun") {
      reruns.push(args);
      return "";
    }
    return base.run(args);
  };
  return { ...base, run, reruns, logReads };
}

/** A run made by `make` over a gh that serves one pull request at `head` with `checks` failing and the logs of `logs` by job id; `pulls` is changed to change what it serves later. */
async function redRun(checks: unknown[], logs: Record<number, string>, make: (gh: World) => ReturnType<typeof readyRun> = readyRun) {
  const pulls: Record<number, unknown> = { 1: feedbackPull({ head: HEAD_1, checks }) };
  const ci = withCi(ghFor(pulls), logs);
  return { pulls, ci, ctx: await make(ci) };
}

/** NBF-1 ended needs-human after a round, with its pull request open and its workspace closed: the run of the incident (A11-145). */
async function needsHumanRun(gh: World) {
  const ctx = await parkedOnQuestion(gh);
  ctx.pool.close("NBF-1");
  ctx.status.delete(herdrName("NBF-1"));
  assert.deepEqual([ctx.entry("NBF-1").phase, ctx.entry("NBF-1").outcome?.kind, ctx.entry("NBF-1").workspace], ["finished", "needs-human", undefined]);
  return ctx;
}

test("A11-154: a red check at the current head starts one fix round for a run Ready to merge, one that ended needs-human and one parked, naming the check and its log lines", async () => {
  const kinds = {
    "Ready to merge": (gh: World) => readyRun(gh),
    "needs-human": needsHumanRun,
    "parked on a question": (gh: World) => parkedOnQuestion(gh),
  };
  for (const [kind, make] of Object.entries(kinds)) {
    const pulls: Record<number, unknown> = { 1: feedbackPull({ head: HEAD_1, checks: [redCheck("test", 11)] }) };
    const ci = withCi(ghFor(pulls), { 11: TEST_FAILED });
    const ctx = await make(ci);
    await watchRound(ctx.pool);
    assert.deepEqual([ctx.entry("NBF-1").phase, ctx.entry("NBF-1").rounds, ctx.entry("NBF-1").review], ["running", 1, [approvedPr]], `${kind}: one round`);
    assert.equal(ctx.entry("NBF-1").feedback, [`test failed on the head commit of ${approvedPr.url}:`, "  not ok 3 - git spawn classification", "  AssertionError: expected 1 to equal 2"].join("\n"),
      `${kind}: the check and its error lines, without the runner's noise, its timestamps or its exit-code line`);
    assert.deepEqual(ctx.entry("NBF-1").checkHeads, { [approvedPr.url]: { head: HEAD_1, step: "round" } }, `${kind}: the head is answered`);
    assert.match(readFileSync(join(ctx.dir, "brief.md"), "utf8"), /^>   AssertionError: expected 1 to equal 2$/m, `${kind}: the brief quotes the log lines`);
    assert.deepEqual(ci.logReads, [11], `${kind}: the log is read once`);
  }
});

test("A11-154: a required roll-up that failed is replaced in the round by the jobs behind it and their log lines", async () => {
  const roll = { ...redCheck("gate", 40), isRequired: true };
  const { ctx } = await redRun([roll, redCheck("suite", 41), redCheck("lint", 42)], { 40: stamped(["##[error]Process completed with exit code 1.", "a job reported 'failure', not success"]), 41: TEST_FAILED, 42: BAD_GATEWAY });
  await watchRound(ctx.pool);
  assert.equal(ctx.entry("NBF-1").feedback, [`suite failed on the head commit of ${approvedPr.url}:`, "  not ok 3 - git spawn classification", "  AssertionError: expected 1 to equal 2",
    `lint also failed on the head commit of ${approvedPr.url} for an infrastructure reason (GitHub answered with a server error): that is not a fault in your change, so leave it; the next push runs it again.`].join("\n"),
    "the gate names no cause: the jobs behind it are named, each by what its own log says");
  const infra = await redRun([roll, redCheck("suite", 41)], { 40: stamped(["a job reported 'failure', not success"]), 41: RUNNER_LOST });
  await watchRound(infra.ctx.pool);
  assert.deepEqual([infra.ctx.entry("NBF-1").phase, infra.ci.reruns], ["finished", [["run", "rerun", "410", "--failed", "-R", "x/nbl-ui-netbox"]]], "a roll-up over a lost runner is a rerun of the job, not a round");
  assert.deepEqual(infra.ci.logReads, [41], "and the roll-up's own log, which names no cause, is not read");
});

test("A11-154: a head that stays red after its round starts no second round, a restart starts none, and a new red head starts one more", async () => {
  const { pulls, ci, ctx } = await redRun([redCheck("test", 11)], { 11: TEST_FAILED, 12: TEST_FAILED });
  await watchRound(ctx.pool);
  assert.equal(ctx.entry("NBF-1").rounds, 1);
  await finishRound(ctx);
  await watchRound(ctx.pool);
  await watchRound(ctx.restart());
  assert.deepEqual([ctx.entry("NBF-1").phase, ctx.entry("NBF-1").rounds], ["finished", 1], "the worker pushed nothing and the head is red still: it was answered");
  assert.deepEqual(ci.logReads, [11], "and its log is not read again");
  pulls[1] = feedbackPull({ head: HEAD_2, checks: [redCheck("test", 12)] });
  await watchRound(ctx.pool);
  assert.deepEqual([ctx.entry("NBF-1").phase, ctx.entry("NBF-1").rounds], ["running", 2], "the worker pushed a head that is red: one more round");
  assert.deepEqual(ctx.entry("NBF-1").checkHeads, { [approvedPr.url]: { head: HEAD_2, step: "round" } }, "the record follows the head");
  await finishRound(ctx);
  pulls[1] = feedbackPull({ head: HEAD_2 });
  await watchRound(ctx.pool);
  assert.equal(ctx.entry("NBF-1").rounds, 2, "green: nothing more");
});

test("A11-154: red checks wake no run the board does not resume: a draft awaiting Approve, a run that concluded, a run a person stopped, and one whose pull request merged", async () => {
  const red = () => ghFor({ 1: feedbackPull({ head: HEAD_1, checks: [redCheck("test", 11)] }) });
  const draft = withCi(red(), { 11: TEST_FAILED });
  const drafted = await draftRun(draft);
  await watchRound(drafted.pool);
  assert.deepEqual([drafted.entry("NBF-1").phase, drafted.entry("NBF-1").rounds, drafted.entry("NBF-1").checkHeads], ["finished", undefined, undefined], "a draft waits for Approve");
  assert.deepEqual(draft.logReads, [], "and its log is not read");
  for (const [why, outcome] of [["concluded", { kind: "checked" as const, reason: "nothing to do" }], ["stopped", { kind: "stopped" as const }]] as const) {
    const ci = withCi(red(), { 11: TEST_FAILED });
    const ctx = await needsHumanRun(ci);
    ctx.store.set({ ...ctx.store.get(), entries: ctx.store.get().entries.map((e) => ({ ...e, outcome })) });
    await watchRound(ctx.pool);
    assert.deepEqual([ctx.entry("NBF-1").phase, ctx.entry("NBF-1").rounds], ["finished", undefined], why);
    assert.deepEqual(ci.logReads, [], `${why}: its log is not read`);
  }
  const merged = withCi(ghFor({ 1: feedbackPull({ state: "MERGED", head: HEAD_1, checks: [redCheck("test", 11)] }) }), { 11: TEST_FAILED });
  const done = await needsHumanRun(merged);
  await watchRound(done.pool);
  assert.deepEqual([done.entry("NBF-1").rounds, merged.logReads], [undefined, []], "a merged pull request has no checks to answer");
});

test("A11-154: a check whose log cannot be read is named as such, and a head with several failing checks names each with a share of the log lines", async () => {
  const pulls: Record<number, unknown> = { 1: feedbackPull({ head: HEAD_1, checks: [redCheck("lint", 21), redCheck("typecheck", 22)] }) };
  const ci = withCi(ghFor(pulls), { 22: TEST_FAILED });
  const ctx = await readyRun(ci);
  await captureStderr(async () => { await watchRound(ctx.pool); });
  assert.equal(ctx.entry("NBF-1").feedback, [`lint failed on the head commit of ${approvedPr.url}; its log could not be read.`,
    `typecheck failed on the head commit of ${approvedPr.url}:`, "  not ok 3 - git spawn classification", "  AssertionError: expected 1 to equal 2"].join("\n"));
  const long = stamped(Array.from({ length: 100 }, (_, i) => `Error: failure number ${i}`));
  const many: Record<number, unknown> = { 1: feedbackPull({ head: HEAD_2, checks: [redCheck("a", 31), redCheck("b", 32)] }) };
  const heavy = await readyRun(withCi(ghFor(many), { 31: long, 32: long }));
  await watchRound(heavy.pool);
  const quoted = (heavy.entry("NBF-1").feedback ?? "").split("\n").filter((line) => line.startsWith("  "));
  assert.equal(quoted.length, 40, "forty lines in all, the last of each log");
  assert.equal(quoted.at(-1), "  Error: failure number 99");
});

test("A11-154: at the round cap a red check hands any run to a person, who reads Needs you and answers with Respond", async () => {
  for (const make of [(gh: World) => readyRun(gh), needsHumanRun, (gh: World) => parkedOnQuestion(gh)]) {
    const ci = withCi(ghFor({ 1: feedbackPull({ head: HEAD_1, checks: [redCheck("test", 11)] }) }), { 11: TEST_FAILED });
    const ctx = await make(ci);
    ctx.store.set({ ...ctx.store.get(), entries: ctx.store.get().entries.map((e) => ({ ...e, rounds: 3 })) });
    ctx.h.calls.length = 0;
    await watchRound(ctx.pool);
    const run = ctx.entry("NBF-1");
    assert.deepEqual([run.phase, run.rounds], ["finished", 3], "no round is started");
    assert.match(run.handedBack ?? "", /The pull requests keep getting feedback: the board answered 3 rounds on its own and stopped\. Respond to review starts another\. The latest: test failed on the head commit/);
    assert.equal(runStatus(run), "needs-you");
    assert.deepEqual(ctx.h.calls.filter((args) => args.includes("close") || args.includes("start")), [], "nothing is closed or started");
    const handed = run.handedBack;
    await watchRound(ctx.pool);
    assert.equal(ctx.entry("NBF-1").handedBack, handed, "the head was answered with the hand-back: it is not said again");
    ctx.pool.respond("NBF-1");
    assert.deepEqual([ctx.entry("NBF-1").phase, ctx.entry("NBF-1").asked, ctx.entry("NBF-1").handedBack, ctx.entry("NBF-1").rounds], ["queued", true, undefined, undefined], "Respond starts the count again");
  }
});

test("A11-154: a check that failed for an infrastructure reason is rerun once for its head and named on the card, and no worker is handed it", async () => {
  for (const [log, reason] of [[RUNNER_LOST, "a runner was lost or a rate limit was hit"], [BAD_GATEWAY, "GitHub answered with a server error"], [NETWORK_DOWN, "a network error"]] as const) {
    const { ci, ctx } = await redRun([redCheck("test", 11)], { 11: log }, needsHumanRun);
    await watchRound(ctx.pool);
    assert.deepEqual([ctx.entry("NBF-1").phase, ctx.entry("NBF-1").rounds, ctx.entry("NBF-1").feedback], ["finished", undefined, undefined], `${reason}: no round`);
    assert.deepEqual(ci.reruns, [["run", "rerun", "110", "--failed", "-R", "x/nbl-ui-netbox"]], `${reason}: the failed jobs of its workflow run are rerun`);
    const note = `Reran test on 1a2b3c4d: ${reason}`;
    assert.deepEqual(ctx.entry("NBF-1").checkHeads, { [approvedPr.url]: { head: HEAD_1, step: "rerun", note } }, `${reason}: recorded for the head`);
    assert.equal(checkNote(ctx.entry("NBF-1")), note, `${reason}: said on the run's card`);
    await watchRound(ctx.pool);
    assert.equal(ci.reruns.length, 1, `${reason}: asked again, it is not rerun twice`);
  }
});

test("A11-154: an infrastructure check red again on the same head after its rerun is named for a person, and no round or second rerun follows", async () => {
  const { pulls, ci, ctx } = await redRun([redCheck("test", 11)], { 11: RUNNER_LOST });
  await watchRound(ctx.pool);
  assert.equal(ci.reruns.length, 1);
  pulls[1] = feedbackPull({ head: HEAD_1, checks: [{ ...redCheck("test", 11), conclusion: null, status: "IN_PROGRESS" }] });
  await watchRound(ctx.pool);
  assert.deepEqual([ctx.entry("NBF-1").checkHeads?.[approvedPr.url]?.step, ci.logReads], ["rerun", [11]], "while the rerun is under way there is nothing red, and nothing is read");
  pulls[1] = feedbackPull({ head: HEAD_1, checks: [redCheck("test", 11, 500)] });
  const logged = await captureStderr(async () => { await watchRound(ctx.pool); });
  const note = "test failed again on 1a2b3c4d after a rerun (a runner was lost or a rate limit was hit): a person decides";
  assert.deepEqual(ctx.entry("NBF-1").checkHeads, { [approvedPr.url]: { head: HEAD_1, step: "named", note } });
  assert.deepEqual([ctx.entry("NBF-1").phase, ctx.entry("NBF-1").rounds, ci.reruns.length], ["finished", undefined, 1], "no worker is handed it, and it is not rerun again");
  assert.equal(checkNote(ctx.entry("NBF-1")), note);
  assert.ok(logged.some((line) => line.includes(`NBF-1: ${note}`)), "said in the log");
  await watchRound(ctx.pool);
  assert.deepEqual([ci.reruns.length, ci.logReads.length], [1, 2], "and said once");
});

test("A11-154: a head with a check the code failed and a check the infrastructure failed starts a round for the first, which names the second, and reruns nothing", async () => {
  const { ci, ctx } = await redRun([redCheck("test", 11), redCheck("install", 12)], { 11: TEST_FAILED, 12: NETWORK_DOWN });
  await watchRound(ctx.pool);
  assert.equal(ctx.entry("NBF-1").rounds, 1);
  assert.equal(ctx.entry("NBF-1").feedback, [`test failed on the head commit of ${approvedPr.url}:`, "  not ok 3 - git spawn classification", "  AssertionError: expected 1 to equal 2",
    `install also failed on the head commit of ${approvedPr.url} for an infrastructure reason (a network error): that is not a fault in your change, so leave it; the next push runs it again.`].join("\n"));
  assert.deepEqual(ci.reruns, [], "the push that fixes the first runs the second again");
});

test("A11-154: a rerun GitHub refuses names the check for a person and is not asked again, and a parked run's workspace is not touched by a rerun", async () => {
  const pulls: Record<number, unknown> = { 1: feedbackPull({ head: HEAD_1, checks: [redCheck("test", 11)] }) };
  const ci = withCi(ghFor(pulls), { 11: RUNNER_LOST });
  const gh = { ...ci, run: (args: string[]) => {
    if (args[0] === "run") throw new Error("gh: Resource not accessible by integration (HTTP 403)");
    return ci.run(args);
  } };
  const ctx = await parkedOnQuestion(gh);
  ctx.h.calls.length = 0;
  const logged = await captureStderr(async () => { await watchRound(ctx.pool); });
  const note = "test failed on 1a2b3c4d for an infrastructure reason (a runner was lost or a rate limit was hit) and could not be rerun (gh: Resource not accessible by integration (HTTP 403)): a person decides";
  assert.ok(logged.some((line) => line.includes(`NBF-1: ${note}`)), logged.join("\n"));
  assert.deepEqual(ctx.entry("NBF-1").checkHeads, { [approvedPr.url]: { head: HEAD_1, step: "named", note } }, "named, so no watch reads its log and is refused again");
  assert.deepEqual([ctx.entry("NBF-1").workspace, ctx.entry("NBF-1").phase, ctx.entry("NBF-1").rounds], ["w2", "finished", undefined], "the run stays parked, and no round is started");
  await watchRound(ctx.pool);
  assert.deepEqual(ci.logReads, [11], "and the next watch asks nothing");
  assert.deepEqual(ctx.h.calls.filter((args) => args.includes("close")), []);
});

test("A11-154: a name for a person is dropped once nothing fails on the head any more, and the head stays answered", async () => {
  const pulls: Record<number, unknown> = { 1: feedbackPull({ head: HEAD_1, checks: [redCheck("test", 11)] }) };
  const ci = withCi(ghFor(pulls), { 11: RUNNER_LOST });
  const gh = { ...ci, run: (args: string[]) => (args[0] === "run" ? (() => { throw new Error("gh: HTTP 403"); })() : ci.run(args)) };
  const ctx = await readyRun(gh);
  await captureStderr(async () => { await watchRound(ctx.pool); });
  assert.match(checkNote(ctx.entry("NBF-1")) ?? "", /a person decides$/);
  pulls[1] = feedbackPull({ head: HEAD_1 });
  await watchRound(ctx.pool);
  assert.deepEqual([checkNote(ctx.entry("NBF-1")), ctx.entry("NBF-1").checkHeads?.[approvedPr.url]], [null, { head: HEAD_1, step: "named" }]);
});

test("A11-154: a conflict and a rerun in one watch queue the conflict round and still record the rerun, so it is not made twice", async () => {
  const pulls: Record<number, unknown> = { 1: feedbackPull({ head: HEAD_1, mergeable: "CONFLICTING", mergeStateStatus: "DIRTY", checks: [redCheck("test", 11)] }) };
  const ci = withCi(ghFor(pulls), { 11: RUNNER_LOST });
  const ctx = await needsHumanRun(ci);
  await watchRound(ctx.pool);
  assert.deepEqual([ctx.entry("NBF-1").phase, ctx.entry("NBF-1").feedback, ci.reruns.length], ["running", `${approvedPr.url} conflicts with its base branch main.`, 1]);
  assert.equal(ctx.entry("NBF-1").checkHeads?.[approvedPr.url]?.step, "rerun");
});

test("A11-154: Respond to review on a run that ended needs-human queues a round that resumes its worker, whatever the run ended on", async () => {
  const ctx = await needsHumanRun(ghFor({ 1: feedbackPull({ head: HEAD_1 }) }));
  ctx.pool.respond("NBF-1");
  assert.deepEqual([ctx.entry("NBF-1").phase, ctx.entry("NBF-1").asked, ctx.entry("NBF-1").review, ctx.entry("NBF-1").session], ["queued", true, [approvedPr], "session-t-nbf-1"]);
  await ctx.pool.tick();
  assert.equal(ctx.entry("NBF-1").phase, "running", "and the round starts");
  const start = ctx.h.calls.filter((args) => args.includes("start")).at(-1)!;
  assert.deepEqual(start.slice(start.indexOf("--resume"), start.indexOf("--resume") + 2), ["--resume", "session-t-nbf-1"]);
});

test("A11-154: Respond to review on a parked run closes its workspace first, once, and then queues the round; a workspace herdr will not close leaves it parked and says why", async () => {
  const ctx = await parkedOnQuestion(ghFor({ 1: feedbackPull({ head: HEAD_1 }) }));
  ctx.h.refused.add("close");
  assert.throws(() => ctx.pool.respond("NBF-1"), /herdr could not close NBF-1's workspace/);
  assert.deepEqual([ctx.entry("NBF-1").phase, ctx.entry("NBF-1").workspace], ["finished", "w2"], "still parked, no round");
  ctx.h.refused.clear();
  ctx.h.calls.length = 0;
  ctx.pool.respond("NBF-1");
  assert.equal(closes(ctx.h, "w2"), 1, "the workspace is closed once");
  assert.deepEqual([ctx.entry("NBF-1").phase, ctx.entry("NBF-1").workspace, ctx.entry("NBF-1").asked], ["queued", undefined, true]);
  assert.throws(() => ctx.pool.respond("NBF-1"), /a round is already queued for NBF-1/, "a second press says a round is queued");
  assert.equal(closes(ctx.h, "w2"), 1);
});

test("A11-154: Respond to review that cannot act says why and closes nothing: no pull request open, a settled ticket, a run still running", async () => {
  const merged = await parkedOnQuestion(ghFor({ 1: feedbackPull({ head: HEAD_1 }) }));
  merged.store.set(recordPullStates(merged.store.get(), new Map([["NBF-1", { [approvedPr.url]: "merged" }]])));
  merged.h.calls.length = 0;
  assert.throws(() => merged.pool.respond("NBF-1"), /NBF-1 has no pull request open/);
  assert.deepEqual(merged.h.calls, [], "the parked workspace of a run Respond cannot act on is left open");
  const settled = await needsHumanRun(ghFor({ 1: feedbackPull({ head: HEAD_1 }) }));
  settled.store.set({ ...settled.store.get(), entries: settled.store.get().entries.map((e) => ({ ...e, trackerState: "completed" })) });
  assert.throws(() => settled.pool.respond("NBF-1"), /NBF-1's ticket is completed in the tracker/);
  const running = setup(1, ["NBF-1"]);
  await running.pool.tick();
  assert.throws(() => running.pool.respond("NBF-1"), /NBF-1 is still running/);
  assert.throws(() => running.pool.respond("NBF-9"), /NBF-9 is not on the board/);
});

test("A11-154: Respond to review on a draft acts as Approve", async () => {
  const ctx = await draftRun(ghFor({ 1: feedbackPull() }));
  ctx.pool.respond("NBF-1");
  assert.deepEqual([ctx.entry("NBF-1").phase, ctx.entry("NBF-1").review, ctx.entry("NBF-1").asked, ctx.entry("NBF-1").feedback], ["queued", [approvedPr], undefined, undefined], "the approved round, not an asked one");
});

/** A workspace of the talk session NBF-1 left behind, as herdr lists it: under the run's name and holding its Claude session, doing `status`. */
const talkLeftover = (status: string, fields: Partial<{ workspace_id: string; label: string; name: string | null; session: string | null }> = {}) =>
  ({ workspace_id: "w9", label: "t-nbf-1", name: "t-nbf-1", session: "session-t-nbf-1", status, ...fields });

test("A11-154: a round never starts beside a Talk session that is working: it stays queued, says what it waits for, and starts once the session has ended", async () => {
  const ctx = await needsHumanRun(ghFor({ 1: feedbackPull({ head: HEAD_1 }) }));
  ctx.pool.respond("NBF-1");
  ctx.h.extra.push(talkLeftover("working"));
  ctx.h.calls.length = 0;
  await ctx.pool.tick();
  assert.deepEqual([ctx.entry("NBF-1").phase, ctx.entry("NBF-1").sessionWait], ["queued", "Waits for the Talk session in w9 to end"]);
  assert.equal(waitNote(ctx.entry("NBF-1"), ctx.store.get().entries), "Waits for the Talk session in w9 to end");
  assert.equal(runStatus(ctx.entry("NBF-1"), ctx.store.get().entries), "blocked");
  assert.deepEqual(ctx.h.calls.filter((args) => args.includes("start") || args.includes("create") || args.includes("close")), [], "nothing is started, and the working Talk is not closed");
  await ctx.pool.tick();
  assert.equal(ctx.entry("NBF-1").phase, "queued", "and it waits on the next pass too");
  ctx.h.extra.length = 0;
  await ctx.pool.tick();
  assert.deepEqual([ctx.entry("NBF-1").phase, ctx.entry("NBF-1").sessionWait], ["running", undefined], "the Talk ended: the round starts, holding no wait");
});

test("A11-154: a leftover that is idle, done or has no pane is closed before the round starts, in the log and on the run, and its note goes when the round ends", async () => {
  for (const [why, leftover] of [["idle", talkLeftover("idle")], ["done", talkLeftover("done")], ["no pane, held by the run's name alone", talkLeftover("unknown", { name: null, session: null })],
    ["held by the session alone, under another name", talkLeftover("idle", { label: "claude", name: null })]] as const) {
    const ctx = await needsHumanRun(ghFor({ 1: feedbackPull({ head: HEAD_1 }) }));
    ctx.pool.respond("NBF-1");
    ctx.h.extra.push(leftover);
    ctx.h.calls.length = 0;
    const logged = await captureStderr(async () => { await ctx.pool.tick(); });
    assert.equal(closes(ctx.h, "w9"), 1, `${why}: closed by its id`);
    const closeAt = ctx.h.calls.findIndex((args) => args.includes("close") && args.includes("w9"));
    assert.ok(closeAt < ctx.h.calls.findIndex((args) => args.includes("create")), `${why}: before the round's workspace is opened`);
    assert.deepEqual([ctx.entry("NBF-1").phase, ctx.entry("NBF-1").sessionNote], ["running", "Closed the Talk session in w9 before this round"], why);
    assert.ok(logged.some((line) => line.includes("NBF-1: Closed the Talk session in w9 before this round")), `${why}: said in the log`);
    await finishRound(ctx);
    assert.equal(ctx.entry("NBF-1").sessionNote, undefined, `${why}: the round's note is dropped when it ends`);
  }
});

test("A11-154: what is not the run's own is left alone, and a workspace herdr will not close holds the round back, saying why", async () => {
  const ctx = await needsHumanRun(ghFor({ 1: feedbackPull({ head: HEAD_1 }) }));
  ctx.pool.respond("NBF-1");
  ctx.h.extra.push(talkLeftover("idle", { workspace_id: "w7", label: "t-nbf-2", name: "t-nbf-2", session: "session-t-nbf-2" }));
  ctx.h.calls.length = 0;
  await ctx.pool.tick();
  assert.equal(closes(ctx.h, "w7"), 0, "another run's idle workspace is not this run's leftover");
  assert.equal(ctx.entry("NBF-1").phase, "running");
  const held = await needsHumanRun(ghFor({ 1: feedbackPull({ head: HEAD_1 }) }));
  held.pool.respond("NBF-1");
  held.h.extra.push(talkLeftover("idle"));
  held.h.refused.add("close");
  await held.pool.tick();
  assert.match(held.entry("NBF-1").sessionWait ?? "", /^Waits for the Talk session in w9: herdr would not close it \(/);
  assert.equal(held.entry("NBF-1").phase, "queued");
  held.h.refused.clear();
  await held.pool.tick();
  assert.deepEqual([held.entry("NBF-1").phase, held.entry("NBF-1").sessionWait], ["running", undefined], "and starts once herdr closes it");
});

test("A11-154: a Talk session never starts beside a working agent that holds the run's session, and starts once it is closed", async () => {
  const { pool, h, entry } = await draftOfNbf1();
  pool.talk("NBF-1");
  h.extra.push(talkLeftover("working"));
  await pool.tick();
  assert.deepEqual([entry("NBF-1").phase, entry("NBF-1").sessionWait], ["queued", "Waits for the Talk session in w9 to end"]);
  assert.equal(h.calls.filter((args) => args.includes("start")).length, 0);
  h.extra[0].status = "idle";
  await pool.tick();
  assert.deepEqual([entry("NBF-1").phase, entry("NBF-1").sessionNote], ["running", "Closed the Talk session in w9 before this talk session"]);
});

test("A11-154: a Talk is refused while a round of the run is queued or running, and the refusal names the round", async () => {
  const ctx = await needsHumanRun(ghFor({ 1: feedbackPull({ head: HEAD_1 }) }));
  ctx.pool.respond("NBF-1");
  assert.throws(() => ctx.pool.talk("NBF-1"), /NBF-1 has a review round queued: talk to it once the round has ended, as the round and a talk session would share one session/);
  await ctx.pool.tick();
  assert.throws(() => ctx.pool.talk("NBF-1"), /NBF-1 has a review round running/);
  assert.equal(ctx.entry("NBF-1").talk, undefined, "and nothing changed");
  await finishRound(ctx);
  ctx.pool.talk("NBF-1");
  assert.equal(ctx.entry("NBF-1").talk, true, "once the round has ended it is allowed");
  await ctx.pool.tick();
  assert.equal(ctx.entry("NBF-1").phase, "running");
  const before = ctx.store.get();
  ctx.pool.talk("NBF-1");
  assert.equal(ctx.store.get(), before, "a running Talk is no round, and a second press changes nothing and is not refused (A11-171)");
});

test("A11-154: a parked run whose agent drops out of herdr's listing has its workspace closed by its id as it is unparked, so no leftover keeps its name", async () => {
  const ctx = await parkedOnQuestion(ghFor({ 1: feedbackPull({ head: HEAD_1 }) }));
  ctx.h.calls.length = 0;
  ctx.status.delete(herdrName("NBF-1"));
  await ctx.pool.tick();
  assert.equal(ctx.entry("NBF-1").workspace, "w2", "one look missing it is not gone");
  await ctx.pool.tick();
  assert.deepEqual([ctx.entry("NBF-1").workspace, closes(ctx.h, "w2")], [undefined, 1], "two looks in a row: unparked, and its workspace closed");
  assert.equal(ctx.entry("NBF-1").outcome?.kind, "needs-human", "it keeps its outcome");
  const refused = await parkedOnQuestion(ghFor({ 1: feedbackPull({ head: HEAD_1 }) }));
  refused.h.refused.add("close");
  refused.h.reasons.set("close", "workspace is busy");
  refused.status.delete(herdrName("NBF-1"));
  await refused.pool.tick();
  const logged = await captureStderr(async () => { await refused.pool.tick(); });
  assert.equal(refused.entry("NBF-1").workspace, undefined, "a close herdr refuses still unparks the run, as it did");
  assert.ok(logged.some((line) => line.includes("NBF-1: its workspace w2 could not be closed as the run was unparked (workspace is busy)")), logged.join("\n"));
  const gone = await parkedOnQuestion(ghFor({ 1: feedbackPull({ head: HEAD_1 }) }));
  gone.h.refused.add("close");
  gone.status.delete(herdrName("NBF-1"));
  await gone.pool.tick();
  assert.deepEqual(await captureStderr(async () => { await gone.pool.tick(); }), [], "a workspace that is gone already is no refusal worth saying");
});

test("A11-154 Done-when: a stacked pull request whose checks fail after its base merges is fixed by a round that starts by itself, and the reviewer then reviews the new head", async () => {
  await loadReviewerGate();
  const { port, starts } = fakeReviewer();
  const stacked = { base: "nbf-0-fit", blocker: "OPEN", edits: [] as string[][] };
  const pulls: Record<number, unknown> = { 1: feedbackPull({ head: HEAD_1, base: stacked.base }) };
  const answers = ghFor(pulls);
  // The code host's sweep: once the blocker's pull request merged, a pull request stacked on its branch is moved to the default branch, as the plugin's own is (its tests, not this one's).
  const sweeping: CodeHost = { ...answers.codeHost, sweepRetargets: ({ urls, stacked: bases }) => {
    if (stacked.blocker === "MERGED" && bases.has(stacked.base)) {
      stacked.edits.push([...urls]);
      stacked.base = "main";
    }
    return {};
  } };
  const ci = withCi({ ...answers, codeHost: sweeping }, { 11: TEST_FAILED });
  const ctx = setup(1, ["NBF-1"], REVIEWING, { gh: ci, reviewerPort: port });
  await ctx.pool.tick();
  ctx.status.set(herdrName("NBF-1"), "idle");
  writeFileSync(join(ticketDir(ctx.settings, "NBF-1"), "outcome.json"), JSON.stringify({ kind: "ready-pr", prs: [approvedPr] }));
  await ctx.pool.tick();
  ctx.status.delete(herdrName("NBF-1"));
  withBlockerOn(ctx.store, "NBF-1", "nbf-0-fit");
  const dir = ticketDir(ctx.settings, "NBF-1");

  // 1. Stacked on its blocker's branch, its checks are green: the reviewer reviews its head.
  await watchRound(ctx.pool);
  assert.deepEqual([ctx.entry("NBF-1").phase, starts.map((ref) => ref.head)], ["finished", [HEAD_1]]);

  // 2. The blocker's pull request merges, the sweep moves this pull request to main, and its checks fail there.
  stacked.blocker = "MERGED";
  ctx.pool.retargetStacked();
  assert.deepEqual(stacked.edits, [[approvedPr.url]], "the sweep moves the one pull request of the run");
  pulls[1] = feedbackPull({ head: HEAD_1, base: "main", checks: [redCheck("test", 11)] });

  // 3. Nobody presses anything and nothing is retried by hand: the next watch starts a fix round with the failing check and its log lines.
  await watchRound(ctx.pool);
  assert.deepEqual([ctx.entry("NBF-1").phase, ctx.entry("NBF-1").rounds], ["running", 1]);
  assert.equal(ctx.entry("NBF-1").feedback, [`test failed on the head commit of ${approvedPr.url}:`, "  not ok 3 - git spawn classification", "  AssertionError: expected 1 to equal 2"].join("\n"));
  assert.match(readFileSync(join(dir, "brief.md"), "utf8"), /^>   AssertionError: expected 1 to equal 2$/m);
  assert.equal(ctx.h.calls.filter((args) => args.includes("start")).length, 2, "the first run and the round");

  // 4. The round's worker pushes a fix and ends; the new head's checks settle green; the sweep gives it a reviewer.
  pulls[1] = feedbackPull({ head: HEAD_2, base: "main" });
  await finishRound({ ...ctx, dir });
  assert.equal(runStatus(ctx.entry("NBF-1")), "ready-to-merge", "the round ended reviewed");
  ctx.pool.reviewNewHeads();
  assert.deepEqual(starts.map((ref) => ref.head), [HEAD_1, HEAD_2], "the reviewer reviews the new head");
  assert.deepEqual(ci.reruns, [], "and nothing was rerun by hand");
});

test("a worker's brief has it capture a changed page on a machine with tickets.capture, and says nothing of capture otherwise", async () => {
  const plain = await startedRun();
  assert.doesNotMatch(readFileSync(join(plain.dir, "brief.md"), "utf8"), /ticket:capture/);
  const capturing = await startedRun({ capture: true });
  assert.match(readFileSync(join(capturing.dir, "brief.md"), "utf8"), /run `agent-org ticket:capture <route> --size 1280x800/);
});

// ---- A11-161: the reviewer and the publisher are plugins, and "none" is the absence of an enabled one. What the board does when the reviewer is switched off, and when the publisher is.

const PLUGIN_REVIEWER_OFF = { providers: { reviewer: { provider: "atomic", enabled: false } }, drafts: false };

test("A11-161: with the reviewer switched off the sweep starts no reviewer and says so: each open pull request reads \"waiting on the reviewer (off)\", one no run lists included, and the state is off-required", async () => {
  const fake = createFakeReviewer();
  await loadReviewerGate();
  const world = ghFor({ 1: feedbackPull() });
  const made = setup(1, [], PLUGIN_REVIEWER_OFF, { gh: world, reviewerPort: fake });
  made.pool.reviewNewHeads();
  assert.deepEqual(fake.started, [], "no reviewer starts");
  assert.deepEqual(made.pool.pullReviews(), { [sweptPr]: "waiting on the reviewer (off)" });
  assert.equal(made.pool.reviewerState(), "off-required");
  assert.equal(world.host.calls.some((call) => call.startsWith("readReviewState")), false, "the pull request's review is not read: nothing is reviewed");
});

test("A11-161: switched back on, the reviewer resumes on the next head: one reviewer for each open pull request's current head, once per head, and none for a head the memory holds", async () => {
  const fake = createFakeReviewer();
  const pulls: Record<number, unknown> = { 1: feedbackPull({ head: "h1" }), 2: feedbackPull({ head: "h2" }), 3: feedbackPull({ head: "h3" }) };
  await loadReviewerGate();
  const made = setup(1, [], REVIEWING, { gh: ghFor(pulls), reviewerPort: fake });
  writeReviewerMemory(reviewerMemoryPath(made.settings.stateDir), { heads: new Map(), started: new Set([`${SWEPT_REPO_PULL_3}@h3`]), resumed: new Set(), reposts: new Map(), rereviewed: new Set() });
  const restarted = made.restart();
  restarted.reviewNewHeads();
  assert.deepEqual(fake.started.map(({ pr, head }) => `${pr}@${head}`).sort(), [`${sweptPr}@h1`, `${SWEPT_REPO_PULL_2}@h2`], "one for each head, and none for the head the memory says was started");
  restarted.reviewNewHeads();
  assert.equal(fake.started.length, 2, "a second sweep starts nothing for those heads");
  pulls[1] = feedbackPull({ head: "h1b" });
  restarted.reviewNewHeads();
  assert.deepEqual(fake.started.slice(2).map(({ head }) => head), ["h1b"], "a new head is the next to start");
  assert.equal(restarted.reviewerState(), "on");
  assert.equal(made.settings.reviewerRequired, true, "a block that names a reviewer plugin is required");
});

test("A11-161: with reviews required and no reviewer (the block says none), the same line is shown; with the reviewer's block naming it and `required` false, people review there and nothing extra is said", async () => {
  const required = setup(1, [], { providers: { reviewer: { provider: "none", required: true } }, drafts: false }, { gh: ghFor({ 1: feedbackPull() }) });
  await loadReviewerGate();
  required.pool.reviewNewHeads();
  assert.equal(required.pool.reviewerState(), "off-required");
  assert.deepEqual(required.pool.pullReviews(), { [sweptPr]: "waiting on the reviewer (off)" });
  const notRequired = setup(1, [], { providers: { reviewer: { provider: "atomic", enabled: false, required: false } }, drafts: false }, { gh: ghFor({ 1: feedbackPull() }) });
  notRequired.pool.reviewNewHeads();
  assert.equal(notRequired.pool.reviewerState(), "none");
  assert.deepEqual(notRequired.pool.pullReviews(), {}, "no pull request no run lists is shown: nothing extra is shown anywhere");
});

test("A11-161: a reviewer that refuses to start on this host is off, and required says it: the pool starts none, and the state follows the requirement", async () => {
  await loadReviewerGate();
  for (const [tickets, state] of [[{ ...REVIEWING }, "off-required"], [{ ...REVIEWING, providers: { reviewer: { provider: "atomic", required: false } } }, "none"]] as const) {
    const fake = createFakeReviewer("the gate's modules do not load");
    await fake.load();
    const made = setup(1, [], tickets, { gh: ghFor({ 1: feedbackPull() }), reviewerPort: fake });
    const refusing = createPool(made.store, { settings: made.settings, source, codeHost: createFakeCodeHost(), hook: { node: "/node", bin: "/tool/src/bin.ts" }, herdr: made.h.run, reviewer: fake, hostFile: "/work/.agent-org/host.json", now: () => 100,
      load: () => ({ load: 1, cores: 14 }), transcriptsRoot: join(made.root, "transcripts"), wait: async () => {}, pluginRecord: join(made.root, "no-plugin-record.json") });
    refusing.reviewNewHeads();
    assert.deepEqual(fake.started, [], "nothing starts");
    assert.equal(refusing.reviewerState(), state, JSON.stringify(tickets));
  }
});

test("A11-161: with no reviewer and no requirement, a run's open pull requests read \"awaiting your review\" from the queue, with no read of GitHub, and no Pull requests section is listed", async () => {
  const world = ghFor({ 1: feedbackPull() });
  const ctx = await readyRun(world, { drafts: false });
  assert.equal(ctx.pool.reviewerState(), "none");
  world.host.calls.length = 0;
  ctx.pool.reviewNewHeads();
  assert.deepEqual(ctx.pool.pullReviews(), { [approvedPr.url]: "awaiting your review" }, "the run's own pull request, from the queue");
  assert.deepEqual(world.host.calls, [], "nothing is read from GitHub to say it, and no repository's open pull requests are listed");
});

test("A11-161: with reviews required and the reviewer off, a run's open pull requests read waiting on the reviewer (off) too, listed or not", async () => {
  const ctx = await readyRun(ghFor({ 1: feedbackPull() }), PLUGIN_REVIEWER_OFF);
  assert.equal(ctx.pool.reviewerState(), "off-required");
  assert.equal(ctx.pool.pullReviews()[approvedPr.url], "waiting on the reviewer (off)", "the run's own pull request, before any sweep");
  ctx.pool.reviewNewHeads();
  assert.deepEqual(ctx.pool.pullReviews(), { [approvedPr.url]: "waiting on the reviewer (off)", [sweptPr]: "waiting on the reviewer (off)" });
});

test("A11-161: a reviewer that was running when it was switched off is not stopped: its workspace stays, and the board that has it on again retires it once its pull request closes", async () => {
  const fake = createFakeReviewer();
  await loadReviewerGate();
  const made = setup(1, [], REVIEWING, { gh: ghFor({ 1: feedbackPull({ head: "h1" }) }), reviewerPort: fake });
  made.pool.reviewNewHeads();
  assert.equal(fake.started.length, 1);
  const off = setup(1, [], PLUGIN_REVIEWER_OFF, { gh: ghFor({ 1: feedbackPull({ head: "h1", state: "MERGED" }) }), reviewerPort: fake });
  off.pool.releaseReviewers();
  assert.deepEqual([fake.retired, fake.closed], [[], []], "a board with the reviewer off closes and retires nothing: it only stops new starts");
  const on = setup(1, [], REVIEWING, { gh: ghFor({ 1: feedbackPull({ head: "h1", state: "MERGED" }) }), reviewerPort: fake });
  on.pool.releaseReviewers();
  assert.deepEqual(fake.retired, [sweptPr], "the reviewer, active again, retires it through listedPulls");
});

const PUBLISH_OFF = { providers: { publish: { provider: "slack", enabled: false, run: "post {prs} into {dir}", connectors: ["^mcp__chat__send"] } } };

test("A11-161: a run Ready to merge waits through the publisher being off, and enabling it starts and queues no publish run: nothing is published retroactively", async () => {
  const off = await readyRun(ghFor({}), PUBLISH_OFF);
  assert.equal(off.settings.publish, null, "the publisher is off: the board has none");
  const enabled = parseTicketSettings({ clones: { "nbl-ui-netbox": "/repos/nbl-ui-netbox", "nbl-ui-platform-libs": "/repos/libs" }, stateDir: off.settings.stateDir,
    tickets: { providers: { publish: { provider: "slack", run: "post {prs} into {dir}", connectors: ["^mcp__chat__send"] } } } });
  assert.notEqual(enabled.publish, null);
  off.h.calls.length = 0;
  const board = createPool(off.store, { settings: enabled, source, codeHost: createFakeCodeHost(), hook: { node: "/node", bin: "/tool/src/bin.ts" }, herdr: off.h.run, hostFile: "/work/.agent-org/host.json", now: () => 400,
    load: () => ({ load: 1, cores: 14 }), transcriptsRoot: join(off.root, "transcripts"), wait: async () => {}, pluginRecord: join(off.root, "no-plugin-record.json"),
    publisher: createFakePublisher(["^mcp__chat__send"]) });
  await board.tick();
  assert.equal(off.store.get().publish, undefined, "no publish run is queued by enabling the publisher");
  assert.equal(off.h.calls.some((args) => args.includes("start")), false, "and none is started");
  assert.equal(runStatus(off.entry("NBF-1")), "ready-to-merge", "the run is as it was: a person's Publish is what publishes");
});

/** The tracker of the A11-168 tests: the contract's fake with every read and write a multi-step ticket's sweep and start use, and none of the optional reads that run on in the background. */
function stepsTracker() {
  const tracker = createFakeTracker([ticket("NBF-1")]);
  const { assigned, read, download, keywords, stateTypes, pullStates, claim, claims, complete } = tracker;
  return { tracker, source: { assigned, read, download, keywords, stateTypes, pullStates, claim, claims, complete } as TicketSource };
}
const STEP_1_PR = "https://github.com/netboxlabs/nbl-ui-platform-libs/pull/811";
const STEP_2_PR = "https://github.com/netboxlabs/nbl-ui-platform-libs/pull/812";

/** NBF-1 runs to the end on `outcome`, and its worker writes it. */
const finishedOn = (outcome: Record<string, unknown>, tracker: TicketSource) => endedOn(outcome, 1, ["NBF-1"], {}, { source: tracker });

/** Step 1's pull request merges and the board queues step 2, whose run starts and ends on `outcome` with its own pull request merged: the pool as it is once step 2 is settled. */
async function throughStepTwo(made: Awaited<ReturnType<typeof finishedOn>>, tracker: ReturnType<typeof stepsTracker>["tracker"], outcome: Record<string, unknown>) {
  const { pool, status, settings } = made;
  tracker.linkPull("NBF-1", STEP_1_PR, "merged");
  await pool.refreshTracker();
  await pool.tick();
  status.set(herdrName("NBF-1"), "working");
  await pool.tick();
  writeFileSync(join(ticketDir(settings, "NBF-1"), "outcome.json"), JSON.stringify({ kind: "ready-pr", prs: [{ repo: "nbl-ui-platform-libs", url: STEP_2_PR }], ...outcome }));
  status.set(herdrName("NBF-1"), "idle");
  await pool.tick();
  tracker.linkPull("NBF-1", STEP_2_PR, "merged");
  await pool.refreshTracker();
}

test("A11-168: a two-step ticket whose first pull request merges Partial starts its second step with no person", async () => {
  const { tracker, source: tracked } = stepsTracker();
  const made = await finishedOn({ kind: "ready-pr", prs: [{ repo: "nbl-ui-platform-libs", url: STEP_1_PR }], partial: "step 1 of 2: the second half" }, tracked);
  const { pool, entry, store, settings } = made;
  assert.equal(entry("NBF-1").phase, "finished", "step 1's run ended on its pull request");
  tracker.linkPull("NBF-1", STEP_1_PR, "merged");
  await pool.refreshTracker();
  const queued = entry("NBF-1");
  assert.deepEqual([queued.phase, queued.steps, queued.session, queued.outcome, queued.partial, queued.pullStates], ["queued", [{ step: 1, of: 2, prs: [STEP_1_PR] }], undefined, undefined, undefined, undefined],
    "the finished run is replaced by a queued one that records the step and its pull request");
  assert.equal(reasonOf(queued).line, "step 1 of 2 merged; step 2 queued");
  assert.equal(runStatus(queued), "queued");
  await pool.tick();
  assert.equal(entry("NBF-1").phase, "running", "the next pass starts it with no person");
  const brief = readFileSync(join(ticketDir(settings, "NBF-1"), "brief.md"), "utf8");
  assert.match(brief, /## Steps already merged/);
  assert.ok(brief.includes(`- step 1 of 2: ${STEP_1_PR}`) && brief.includes("This run does step 2 of 2"), "its brief names the step it does and the one merged");
  assert.equal(reasonOf(entry("NBF-1")).line, "step 1 of 2 merged; step 2 running");
  assert.deepEqual(tracker.claimed, [{ key: "NBF-1", claimant: claimantOf(settings) }], "two runs of one ticket claimed it once");
  assert.equal(store.get().entries.length, 1, "one entry for the ticket throughout");
});

test("A11-168: step 2 of 2 merges with Closes and its run reads Completed; nothing is queued and the ticket is completed", async () => {
  const { tracker, source: tracked } = stepsTracker();
  const made = await finishedOn({ kind: "ready-pr", prs: [{ repo: "nbl-ui-platform-libs", url: STEP_1_PR }], partial: "step 1 of 2" }, tracked);
  await throughStepTwo(made, tracker, {});
  const last = made.entry("NBF-1");
  assert.deepEqual([last.phase, runStatus(last), last.steps?.map(({ step }) => step), last.partial], ["finished", "completed", [1], undefined], "the last step's run is finished and completed, with no step queued after it");
  assert.equal(tracker.ticketOf("NBF-1")?.status, "Done", "its pull request ends the ticket");
});

test("A11-168: a partial pull request that merges naming no step, the last step, or a step not past the last merged queues nothing and needs a person, with the reason", async () => {
  const reasons: [string, string][] = [
    ["the settings page", "Partial merged: the settings page. It names no step, so nothing was queued: Dismiss it and queue the ticket"],
    ["step 2 of 2: the docs", "Partial merged: step 2 of 2: the docs. It names step 2 of 2, the last, with Partial: the last step closes the ticket"],
  ];
  for (const [partial, reason] of reasons) {
    const { tracker, source: tracked } = stepsTracker();
    const { pool, entry } = await finishedOn({ kind: "ready-pr", prs: [{ repo: "nbl-ui-platform-libs", url: STEP_1_PR }], partial }, tracked);
    tracker.linkPull("NBF-1", STEP_1_PR, "merged");
    await pool.refreshTracker();
    await pool.refreshTracker();
    const left = entry("NBF-1");
    assert.deepEqual([left.phase, runStatus(left), reasonOf(left).line], ["finished", "needs-you", reason], partial);
    assert.equal(tracker.ticketOf("NBF-1")?.status, "Backlog", "a partial run's ticket is left open");
  }
});

test("A11-168: a step that moves nowhere forward is not queued twice: the next step's run that declares the same step again needs a person", async () => {
  const { tracker, source: tracked } = stepsTracker();
  const made = await finishedOn({ kind: "ready-pr", prs: [{ repo: "nbl-ui-platform-libs", url: STEP_1_PR }], partial: "step 1 of 3" }, tracked);
  await throughStepTwo(made, tracker, { partial: "step 1 of 3 again" });
  const left = made.entry("NBF-1");
  assert.deepEqual([left.phase, runStatus(left)], ["finished", "needs-you"]);
  assert.equal(reasonOf(left).line, "Partial merged: step 1 of 3 again. Step 1 is not after step 1: nothing was queued");
});

test("A11-168: a partial run whose ticket the tracker finished queues no next step, even when the tracker finished it after the board last read it open", async () => {
  const { tracker, source: tracked } = stepsTracker();
  const { pool, entry } = await finishedOn({ kind: "ready-pr", prs: [{ repo: "nbl-ui-platform-libs", url: STEP_1_PR }], partial: "step 1 of 2" }, tracked);
  await pool.refreshTracker();
  assert.equal(entry("NBF-1").trackerState, "unstarted", "the board last read the ticket open, with its pull request open");
  tracker.linkPull("NBF-1", STEP_1_PR, "merged");
  await tracker.complete!("NBF-1", "closed by a person");
  await pool.refreshTracker();
  assert.deepEqual([entry("NBF-1").phase, runStatus(entry("NBF-1")), entry("NBF-1").trackerState], ["finished", "completed", "completed"], "the tracker's word on the ticket wins: step 2 is not queued");
});

test("A11-168: a merged partial run that is not queued keeps asking the tracker, so a ticket a person finishes later reads Completed, not Needs you for ever", async () => {
  const { tracker, source: tracked } = stepsTracker();
  const { pool, entry } = await finishedOn({ kind: "ready-pr", prs: [{ repo: "nbl-ui-platform-libs", url: STEP_1_PR }], partial: "the docs" }, tracked);
  tracker.linkPull("NBF-1", STEP_1_PR, "merged");
  await pool.refreshTracker();
  assert.equal(runStatus(entry("NBF-1")), "needs-you");
  await tracker.complete!("NBF-1", "finished by hand");
  await pool.refreshTracker();
  assert.equal(runStatus(entry("NBF-1")), "completed");
});

test("A11-168: a run claims its ticket in the tracker as it starts, a planning run too and a review round not, and a refused claim goes to the log while the run goes on", async () => {
  const { tracker, source: tracked } = stepsTracker();
  const made = setup(1, ["NBF-1"], {}, { source: tracked });
  await made.pool.tick();
  await settled();
  assert.deepEqual(tracker.claimed, [{ key: "NBF-1", claimant: claimantOf(made.settings) }]);
  const refusing: TicketSource = { ...tracked, claim: async () => { throw new Error("Linear answered 500"); } };
  let refused!: ReturnType<typeof setup>;
  const written = await captureStderr(async () => {
    refused = setup(1, ["NBF-1"], {}, { source: refusing });
    await refused.pool.tick();
    await settled();
  });
  assert.equal(refused.entry("NBF-1").phase, "running", "the claim fails nothing");
  assert.ok(written.includes("ticket:serve: NBF-1 could not be claimed in the tracker: Linear answered 500\n"));
  const planning = stepsTracker();
  const planned = setup(1, ["NBF-1"], PLANNER, { source: planning.source, planFirst: ["NBF-1"] });
  await planned.pool.tick();
  await settled();
  assert.deepEqual(planning.tracker.claimed.map(({ key }) => key), ["NBF-1"], "a planning run claims the ticket too");
  const plain = setup(1, ["NBF-1"]);
  await plain.pool.tick();
  assert.equal(plain.entry("NBF-1").phase, "running", "a source with no claim starts the run as before");
});

// A11-167: plans and workers follow the latest ticket text, and a dependent learns from its blockers' merged pull requests.

/** The time of day the board words, in the viewer's zone, as a run's line says it. */
const clock = (ms: number): string => `${String(new Date(ms).getHours()).padStart(2, "0")}:${String(new Date(ms).getMinutes()).padStart(2, "0")}`;

const FIT = "Fit the view.\n\nDone-when: it fits.";
const FIT_AND_REPLAY = "Fit the view.\n\nDone-when: it fits, and it replays.";
const T09 = "2026-10-21T09:00:00.000Z";
const T11 = "2026-10-21T11:00:00.000Z";
const PLAN_NAME = (key: string) => `${key}-0001-plan-fit.md`;
const PLAN_BODY = "# Fit\n\n## Approach\n\nFit it.\n\n## Paths\n\n- `nbl-ui-netbox:src/a.ts`\n";

/**
 * A tracker that holds each ticket's text, its updatedAt and its attached files as Linear does: `read` gives them, `texts` gives the text of many keys in one call, `attachPlan` and
 * `detachPlan` keep the files, and `download` writes them out. `blocked` gives the blockers of a key. A test changes a ticket with `edit`.
 */
function followed(keys: string[], description = FIT) {
  const text = new Map<string, { description: string; updatedAt: string }>(keys.map((key) => [key, { description, updatedAt: T09 }]));
  const files = new Map<string, Map<string, string>>(keys.map((key) => [key, new Map()]));
  const detached: { key: string; titles: string[] }[] = [];
  const asked: string[][] = [];
  const blocked = new Map<string, Blocker[]>();
  const tracker: TicketSource = { ...source,
    read: async (key) => (text.has(key) ? { ...ticket(key), ...text.get(key)!, uploads: [...files.get(key)!.keys()] } : null),
    texts: async (ks) => { asked.push([...ks]); return new Map(ks.filter((key) => text.has(key)).map((key) => [key, text.get(key)!])); },
    download: async (t, dir) => [...(files.get(t.key) ?? [])].map(([name, body], index) => {
      const path = join(dir, `attachment-${index + 1}-${name}`);
      writeFileSync(path, body);
      return path;
    }),
    attachPlan: async (key, paths) => { for (const path of paths) files.get(key)!.set(basename(path), readFileSync(path, "utf8")); return null; },
    detachPlan: async (key, titles) => { detached.push({ key, titles: [...titles] }); for (const title of titles) files.get(key)!.delete(title); },
    blockers: async (ks) => new Map(ks.map((key) => [key, blocked.get(key) ?? []])),
  };
  return { tracker, files, detached, asked, blocked, text,
    edit(key: string, next: string, updatedAt = T11) { text.set(key, { description: next, updatedAt }); } };
}

/** A queued ticket's plan, attached by the board as a planning run's would be: stamped with `description` as it was when the plan was written. */
function attachStamped(world: ReturnType<typeof followed>, key: string, description: string, extra: Record<string, string> = {}) {
  const adr = `${key}-adr-0001-zoom.md`;
  world.files.get(key)!.set(PLAN_NAME(key), stampedPlan(PLAN_BODY, { updatedAt: T09, hash: descriptionHash(description), files: [PLAN_NAME(key), adr], description }));
  world.files.get(key)!.set(adr, "# ADR\n");
  for (const [name, body] of Object.entries(extra)) world.files.get(key)!.set(name, body);
}

/** NBF-1 holds the one slot; NBF-2, behind it, is queued with `plan` attached, its plan paths and stamp read. */
async function queuedBehind(world: ReturnType<typeof followed>, options: NonNullable<Parameters<typeof setup>[3]> = {}) {
  const made = setup(1, ["NBF-1", "NBF-2"], PLANNER, { source: world.tracker, ...options });
  await made.pool.tick();
  assert.deepEqual([made.entry("NBF-1").phase, made.entry("NBF-2").phase], ["running", "queued"]);
  return made;
}

/** NBF-2 queued behind NBF-1 with a plan stamped for `FIT`, whose ticket is then edited to `FIT_AND_REPLAY`; the tracker is not asked about it yet. */
async function editedBehind() {
  const world = followed(["NBF-1", "NBF-2"]);
  attachStamped(world, "NBF-2", FIT);
  const made = await queuedBehind(world);
  world.edit("NBF-2", FIT_AND_REPLAY);
  return { world, made };
}

/** NBF-1, the run that holds the slot, ends, so the queued run behind it starts on the next tick. */
async function freeTheSlot(made: Awaited<ReturnType<typeof queuedBehind>>) {
  await endWith(made, ticketDir(made.settings, "NBF-1"), herdrName("NBF-1"), { kind: "needs-human", reason: "done with the slot" });
  await made.pool.tick();
  await settled();
}

test("the planning brief carries the ticket as the tracker has it at start, with its updatedAt", async () => {
  const world = followed(["NBF-1"]);
  world.edit("NBF-1", FIT_AND_REPLAY, T11);
  const { dir } = await startedRun(PLANNER, { source: world.tracker, planFirst: ["NBF-1"], now: () => Date.UTC(2026, 9, 21, 12, 0, 0) });
  const brief = readFileSync(join(dir, "brief.md"), "utf8");
  assert.ok(brief.includes(`Read from the tracker at 2026-10-21T12:00:00.000Z; the ticket was last updated ${T11}.\n\n${FIT_AND_REPLAY}`), "the text the tracker has now, not the empty one the ticket was queued with");
});

test("the worker brief carries the ticket text as read at start, with its updatedAt, and the run is recorded as briefed against it", async () => {
  const world = followed(["NBF-1"]);
  world.edit("NBF-1", FIT_AND_REPLAY, T11);
  const { dir, entry } = await startedRun({}, { source: world.tracker, now: () => Date.UTC(2026, 9, 21, 12, 0, 0) });
  const brief = readFileSync(join(dir, "brief.md"), "utf8");
  assert.ok(brief.includes(`Read from the tracker at 2026-10-21T12:00:00.000Z; the ticket was last updated ${T11}.\n\n${FIT_AND_REPLAY}`));
  assert.ok(brief.includes(`Worked against the ticket as updated ${T11}`));
  assert.deepEqual(entry("NBF-1").briefedAgainst, ticketReadOf({ description: FIT_AND_REPLAY, updatedAt: T11 }, Date.UTC(2026, 9, 21, 12, 0, 0)));
});

test("an attached plan is stamped with the updatedAt and description hash its planning run was briefed with, before its Paths, and its other files are attached as they were written", async () => {
  const world = followed(["NBF-1"]);
  const made = setup(1, ["NBF-1"], PLANNER, { source: world.tracker, planFirst: ["NBF-1"] });
  await made.pool.tick();
  made.store.set(pauseQueue(made.store.get()));
  // The ticket changes while the planner works: the stamp holds the text the planner was briefed with.
  world.edit("NBF-1", FIT_AND_REPLAY);
  const dir = ticketDir(made.settings, "NBF-1");
  writeFileSync(join(dir, "plan", PLAN_NAME("NBF-1")), PLAN_BODY);
  writeFileSync(join(dir, "plan", "NBF-1-adr-0001-zoom.md"), "# ADR\n");
  await endWith(made, dir, herdrName("NBF-1"), { kind: "planned" });
  await settled();
  const plan = world.files.get("NBF-1")!.get(PLAN_NAME("NBF-1"))!;
  const stamp = parseStamp(plan)!;
  assert.deepEqual([stamp.updatedAt, stamp.hash, stamp.description, stamp.files], [T09, descriptionHash(FIT), FIT, [PLAN_NAME("NBF-1"), "NBF-1-adr-0001-zoom.md"]]);
  assert.ok(plan.indexOf("## Planned against") > plan.indexOf("## Approach") && plan.indexOf("## Planned against") < plan.indexOf("## Paths"));
  assert.deepEqual(parsePaths(plan), ["nbl-ui-netbox:src/a.ts"], "the stamp changes no path");
  assert.equal(world.files.get("NBF-1")!.get("NBF-1-adr-0001-zoom.md"), "# ADR\n");
  assert.equal(made.entry("NBF-1").plannedAgainst?.hash, descriptionHash(FIT), "the run keeps the stamp it wrote");
  assert.deepEqual(made.entry("NBF-1").plannedWith, { model: "opus", effort: "max" }, "and the choice it was planned with");
});

test("a ticket edited after planning is re-planned before its worker starts, and the run says ticket changed since plan, re-planning first", async () => {
  const world = followed(["NBF-1"]);
  const made = setup(1, ["NBF-1"], PLANNER, { source: world.tracker, planFirst: ["NBF-1"], now: () => Date.UTC(2026, 9, 21, 12, 0, 0) });
  const { pool, store, entry, settings, h } = made;
  await pool.tick();
  store.set(pauseQueue(store.get()));
  const dir = ticketDir(settings, "NBF-1");
  writeFileSync(join(dir, "plan", PLAN_NAME("NBF-1")), PLAN_BODY);
  await endWith(made, dir, herdrName("NBF-1"), { kind: "planned" });
  await settled();
  assert.equal(entry("NBF-1").phase, "queued");
  assert.equal(entry("NBF-1").ticketChange, undefined, "the ticket has not changed since its plan");
  // The description changes, and the board's next look at the tracker marks the plan stale, without starting anything.
  world.edit("NBF-1", FIT_AND_REPLAY);
  await pool.refreshTracker();
  assert.deepEqual(world.asked.at(-1), ["NBF-1"], "the queued ticket's text is asked for in one call");
  assert.deepEqual(entry("NBF-1").ticketChange, { at: Date.UTC(2026, 9, 21, 12, 0, 0), from: FIT, to: FIT_AND_REPLAY });
  assert.equal(reasonOf(entry("NBF-1")).line, "ticket changed since plan, re-planning first");
  assert.equal(entry("NBF-1").phase, "queued");
  assert.deepEqual(world.detached, [], "nothing is detached until the re-plan starts");
  // Started, it plans again first, on the choice it was first planned with, from the new text.
  h.calls.length = 0;
  store.set(resumeQueue(store.get()));
  await pool.tick();
  await settled();
  assert.equal(entry("NBF-1").phase, "running");
  assert.deepEqual(entry("NBF-1").plan, { model: "opus", effort: "max" }, "a planning run, on the model it was first planned with");
  const start = h.calls.find((args) => args.includes("start"))!;
  assert.deepEqual([start[start.indexOf("--model") + 1], start[start.indexOf("--effort") + 1]], ["opus", "max"]);
  assert.equal(reasonOf(entry("NBF-1")).line, "planning (ticket changed)");
  const brief = readFileSync(join(dir, "brief.md"), "utf8");
  assert.match(brief, /^# Plan NBF-1: NBF-1\n/);
  assert.ok(brief.includes("## This is a re-plan") && brief.includes("- Done-when: it fits.\n+ Done-when: it fits, and it replays."), "the planner is shown what changed");
  assert.ok(brief.includes(`the ticket was last updated ${T11}.\n\n${FIT_AND_REPLAY}`), "and the latest text");
  // It writes the new plan: attached with a stamp of the new text, and the ticket is worked from it.
  writeFileSync(join(dir, "plan", PLAN_NAME("NBF-1")), PLAN_BODY);
  await endWith(made, dir, herdrName("NBF-1"), { kind: "planned" });
  await settled();
  const stamp = parseStamp(world.files.get("NBF-1")!.get(PLAN_NAME("NBF-1"))!)!;
  assert.deepEqual([stamp.hash, stamp.updatedAt], [descriptionHash(FIT_AND_REPLAY), T11]);
  assert.deepEqual([entry("NBF-1").phase, entry("NBF-1").plan, entry("NBF-1").ticketChange], ["running", undefined, undefined], "the worker runs on the new plan, the mark gone");
  assert.ok(readFileSync(join(dir, "brief.md"), "utf8").includes(FIT_AND_REPLAY), "and is briefed with the new text");
});

test("a re-plan detaches the stale plan and the files its stamp lists, and no other, and gives the planner a copy and the diff", async () => {
  const world = followed(["NBF-1", "NBF-2"]);
  attachStamped(world, "NBF-2", FIT, { "notes.md": "a person's own file" });
  const made = await queuedBehind(world);
  assert.equal(made.entry("NBF-2").plannedAgainst?.hash, descriptionHash(FIT), "the stamp is read from the plan files with their paths");
  world.edit("NBF-2", FIT_AND_REPLAY);
  await made.pool.refreshTracker();
  assert.equal(reasonOf(made.entry("NBF-2")).line, "ticket changed since plan, re-planning first");
  await freeTheSlot(made);
  assert.deepEqual(world.detached, [{ key: "NBF-2", titles: ["NBF-2-adr-0001-zoom.md", PLAN_NAME("NBF-2")] }], "the two files its stamp lists, the stamped plan last");
  assert.deepEqual([...world.files.get("NBF-2")!.keys()], ["notes.md"], "a person's own attachment is left alone");
  const dir = ticketDir(made.settings, "NBF-2");
  assert.equal(readFileSync(join(dir, "previous-plan", PLAN_NAME("NBF-2")), "utf8"), stampedPlan(PLAN_BODY, { updatedAt: T09, hash: descriptionHash(FIT), files: [PLAN_NAME("NBF-2"), "NBF-2-adr-0001-zoom.md"], description: FIT }), "the planner is given a copy");
  assert.equal(readFileSync(join(dir, "previous-plan", "NBF-2-adr-0001-zoom.md"), "utf8"), "# ADR\n");
  const brief = readFileSync(join(dir, "brief.md"), "utf8");
  assert.ok(brief.includes(`- \`${join(dir, "previous-plan", PLAN_NAME("NBF-2"))}\``) && brief.includes("+ Done-when: it fits, and it replays."));
  assert.equal(made.entry("NBF-2").plan !== undefined && made.entry("NBF-2").phase === "running", true);
});

test("an unstamped plan is never marked stale or re-planned: nothing records the text it was written against", async () => {
  const world = followed(["NBF-1", "NBF-2"]);
  world.files.get("NBF-2")!.set(PLAN_NAME("NBF-2"), PLAN_BODY);
  const made = await queuedBehind(world);
  assert.equal(made.entry("NBF-2").plannedAgainst, undefined);
  world.edit("NBF-2", FIT_AND_REPLAY);
  await made.pool.refreshTracker();
  assert.equal(made.entry("NBF-2").ticketChange, undefined);
  await freeTheSlot(made);
  assert.deepEqual([made.entry("NBF-2").phase, made.entry("NBF-2").plan], ["running", undefined], "worked from the plan it has, on the new text");
  assert.deepEqual(world.detached, []);
  assert.ok(readFileSync(join(ticketDir(made.settings, "NBF-2"), "brief.md"), "utf8").includes(FIT_AND_REPLAY));
});

test("the mark of a stale plan goes when the ticket holds the text the plan was written against again, and a tracker that cannot give texts or detach a plan marks nothing", async () => {
  const { world, made } = await editedBehind();
  await made.pool.refreshTracker();
  assert.notEqual(made.entry("NBF-2").ticketChange, undefined);
  world.edit("NBF-2", `${FIT_AND_REPLAY}\nAnd it is quick.`);
  await made.pool.refreshTracker();
  assert.equal(made.entry("NBF-2").ticketChange?.to, `${FIT_AND_REPLAY}\nAnd it is quick.`, "a second edit moves the mark on, so What changed shows the ticket as it is now");
  assert.equal(made.entry("NBF-2").ticketChange?.from, FIT);
  world.edit("NBF-2", `${FIT}\n\n`, T11);
  await made.pool.refreshTracker();
  assert.equal(made.entry("NBF-2").ticketChange, undefined, "a trailing newline is the same text");
  const plain = followed(["NBF-1", "NBF-2"]);
  attachStamped(plain, "NBF-2", FIT);
  for (const tracker of [{ ...plain.tracker, texts: undefined }, { ...plain.tracker, detachPlan: undefined }] as TicketSource[]) {
    const other = await queuedBehind(plain, { source: tracker });
    plain.edit("NBF-2", FIT_AND_REPLAY);
    await other.pool.refreshTracker();
    assert.equal(other.entry("NBF-2").ticketChange, undefined, "a plan that cannot be written again is kept");
    plain.edit("NBF-2", FIT);
  }
});

test("a description change while a worker runs is prompted to it, and its next round's brief carries the new text", async () => {
  const world = followed(["NBF-1"]);
  const made = setup(1, ["NBF-1"], {}, { source: world.tracker, now: () => Date.UTC(2026, 9, 21, 14, 5, 0) });
  const { pool, h, entry, status, settings, root, store } = made;
  await pool.tick();
  const dir = ticketDir(settings, "NBF-1");
  h.calls.length = 0;
  await pool.refreshTracker();
  assert.equal(h.calls.some((args) => args.includes("prompt")), false, "an unchanged ticket sends nothing");
  world.edit("NBF-1", FIT_AND_REPLAY);
  await pool.refreshTracker();
  const prompts = h.calls.filter((args) => args.includes("prompt"));
  assert.equal(prompts.length, 1);
  assert.deepEqual(prompts[0].slice(0, 5), ["--session", "tickets", "agent", "prompt", herdrName("NBF-1")]);
  assert.ok(prompts[0][5].includes(join(dir, "ticket-changed-1.md")), "the message names the file");
  const file = readFileSync(join(dir, "ticket-changed-1.md"), "utf8");
  assert.ok(file.includes("- Done-when: it fits.\n+ Done-when: it fits, and it replays.") && file.includes(`last updated ${T11}`) && file.includes(`## The description now\n\n${FIT_AND_REPLAY}`));
  assert.deepEqual(entry("NBF-1").ticketChanges, [{ at: Date.UTC(2026, 9, 21, 14, 5, 0), from: FIT, to: FIT_AND_REPLAY }]);
  assert.equal(reasonOf(entry("NBF-1")).line, `ticket changed: sent to the worker at ${clock(Date.UTC(2026, 9, 21, 14, 5, 0))}`);
  await pool.refreshTracker();
  assert.equal(h.calls.filter((args) => args.includes("prompt")).length, 1, "the same change is sent once");
  // The worker's pull request is approved: the review round's brief carries the new text, and says nothing changed since the text the worker was sent.
  status.set(herdrName("NBF-1"), "idle");
  mkdirSync(join(root, "transcripts", "-Users-me-work"), { recursive: true });
  writeFileSync(join(root, "transcripts", "-Users-me-work", "session-t-nbf-1.jsonl"), "{}\n");
  writeFileSync(join(dir, "outcome.json"), JSON.stringify({ kind: "draft-pr", prs: [approvedPr] }));
  await pool.tick();
  status.delete(herdrName("NBF-1"));
  world.edit("NBF-1", `${FIT_AND_REPLAY}\nAnd it is quick.`, "2026-10-21T15:00:00.000Z");
  store.set(approve(store.get(), "NBF-1", 200));
  await pool.tick();
  const round = readFileSync(join(dir, "brief.md"), "utf8");
  assert.ok(round.includes(`the ticket was last updated 2026-10-21T15:00:00.000Z.\n\n> ${FIT_AND_REPLAY.split("\n").join("\n> ").replace(/\n> \n/g, "\n>\n")}\n> And it is quick.`), "the round carries the latest text, with its updatedAt");
  assert.ok(round.includes("### The ticket changed since your last round") && round.includes("+ And it is quick."), "and what changed since the text the last round was sent");
});

test("a change that herdr refuses to deliver is said, not recorded, and sent again on the next look", async () => {
  const world = followed(["NBF-1"]);
  const made = setup(1, ["NBF-1"], {}, { source: world.tracker });
  await made.pool.tick();
  world.edit("NBF-1", FIT_AND_REPLAY);
  made.h.refused.add("prompt");
  const written = await captureStderr(() => made.pool.refreshTracker());
  assert.ok(written.some((line) => line.includes("NBF-1 could not be told its ticket changed")));
  assert.equal(made.entry("NBF-1").ticketChanges, undefined);
  made.h.refused.delete("prompt");
  await made.pool.refreshTracker();
  assert.equal(made.entry("NBF-1").ticketChanges?.length, 1);
});

test("a planning run is not prompted when its ticket changes: its plan is stamped with the text it started on, and the next start plans it again", async () => {
  const world = followed(["NBF-1"]);
  const made = setup(1, ["NBF-1"], PLANNER, { source: world.tracker, planFirst: ["NBF-1"] });
  await made.pool.tick();
  made.h.calls.length = 0;
  world.edit("NBF-1", FIT_AND_REPLAY);
  await made.pool.refreshTracker();
  assert.equal(made.h.calls.some((args) => args.includes("prompt")), false);
  assert.equal(made.entry("NBF-1").ticketChanges, undefined);
});

const ANNOUNCEMENT_PULL = "https://github.com/a11ign/announcement-emulator/pull/3";
const FINDINGS = { title: "feat: scripted replay", number: 3, body: "## What it found\n\nCookie dialogs drop pages.", sections: [{ file: "docs/announcement-emulator-spike.md", heading: "### Scripted replay", text: "Handle the cookie dialog before the replay." }] };

/** The reason a run that needs a person gave, or "" for any other outcome. */
const reasonOfOutcome = (outcome: Outcome | undefined): string => (outcome?.kind === "needs-human" ? outcome.reason : "");

/** The tracker of a ticket whose blocker A11-165 is done, with the pull request it merged, and a code host that holds that pull request's findings. */
function blockedByMerged(keys: string[], blockerPulls: Record<string, "open" | "merged"> = { [ANNOUNCEMENT_PULL]: "merged" }) {
  const world = followed(keys);
  for (const key of keys) world.blocked.set(key, [blocks("A11-165", "completed", "Done", blockerPulls)]);
  const host = createFakeCodeHost();
  host.seedPull("a11ign/announcement-emulator", 3, { state: "merged", findings: FINDINGS });
  return { world, gh: { run: () => "", calls: [], codeHost: host, host } as World };
}

test("a blocker's merged findings appear in the dependent's planning brief, and its queued run says what it learns from", async () => {
  const { world, gh } = blockedByMerged(["NBF-1"]);
  const made = setup(1, ["NBF-1"], PLANNER, { source: world.tracker, planFirst: ["NBF-1"], gh });
  await made.pool.refreshTracker();
  assert.equal(learnsLine(made.entry("NBF-1")), "learns from A11-165 (#3 merged)");
  assert.deepEqual(learnsFrom(made.entry("NBF-1")).map(({ url }) => url), [ANNOUNCEMENT_PULL], "linked to the pull request");
  const file = join(ticketDir(made.settings, "NBF-1"), "blockers", "A11-165-a11ign-announcement-emulator-3.md");
  assert.deepEqual(made.entry("NBF-1").learned, { [ANNOUNCEMENT_PULL]: { key: "A11-165", number: 3, title: "feat: scripted replay", file } });
  await made.pool.refreshTracker();
  assert.equal(gh.host.calls.filter((call) => call === `readMergedFindings ${ANNOUNCEMENT_PULL}`).length, 1, "read once");
  await made.pool.tick();
  const dir = ticketDir(made.settings, "NBF-1");
  const brief = readFileSync(join(dir, "brief.md"), "utf8");
  assert.ok(brief.includes(`## What its blockers found`) && brief.includes(`- \`${file}\`: A11-165, ${ANNOUNCEMENT_PULL} (#3, "feat: scripted replay")`));
  assert.ok(brief.includes("`## What the blockers found` section, before `## Paths`"));
  const saved = readFileSync(file, "utf8");
  for (const part of ["feat: scripted replay (#3)", ANNOUNCEMENT_PULL, "Cookie dialogs drop pages.", "### `docs/announcement-emulator-spike.md`: Scripted replay", "Handle the cookie dialog before the replay."]) {
    assert.ok(saved.includes(part), `the findings file holds ${part}`);
  }
  assert.deepEqual(made.entry("NBF-1").findingsGiven, [ANNOUNCEMENT_PULL]);
});

test("a blocker pull request that is not merged, or that the host cannot read, gives nothing, and is asked again when it merges", async () => {
  const { world, gh } = blockedByMerged(["NBF-1"], { [ANNOUNCEMENT_PULL]: "open", "https://github.com/a11ign/x/pull/9": "merged" });
  const made = setup(1, ["NBF-1"], PLANNER, { source: world.tracker, planFirst: ["NBF-1"], gh });
  await made.pool.refreshTracker();
  assert.equal(made.entry("NBF-1").learned, undefined, "an open pull request is not learned from, and an unreadable merged one is asked again");
  world.blocked.set("NBF-1", [blocks("A11-165", "completed", "Done", { [ANNOUNCEMENT_PULL]: "merged", "https://github.com/a11ign/x/pull/9": "merged" })]);
  await made.pool.refreshTracker();
  assert.deepEqual(Object.keys(made.entry("NBF-1").learned ?? {}), [ANNOUNCEMENT_PULL]);
});

test("a plan given blocker findings without a What the blockers found section naming each is refused, and one that names each is attached", async () => {
  const { world, gh } = blockedByMerged(["NBF-1"]);
  /** A planning run of NBF-1 given the findings, whose plan is `PLAN_BODY` with `section` before its Paths, and the made run once it wrote `planned`. */
  const planWith = async (section: string) => {
    const made = setup(1, ["NBF-1"], PLANNER, { source: world.tracker, planFirst: ["NBF-1"], gh });
    await made.pool.refreshTracker();
    await made.pool.tick();
    made.store.set(pauseQueue(made.store.get()));
    const dir = ticketDir(made.settings, "NBF-1");
    writeFileSync(join(dir, "plan", PLAN_NAME("NBF-1")), PLAN_BODY.replace("## Paths", `${section}## Paths`));
    await endWith(made, dir, herdrName("NBF-1"), { kind: "planned" });
    await settled();
    return made;
  };
  const without = await planWith("");
  assert.equal(without.entry("NBF-1").outcome?.kind, "needs-human");
  assert.match(reasonOfOutcome(without.entry("NBF-1").outcome), /has no "## What the blockers found" section.*pull\/3/);
  assert.equal(world.files.get("NBF-1")!.size, 0, "nothing is attached");
  const other = await planWith("## What the blockers found\n\n- https://github.com/a11ign/announcement-emulator/pull/33: not it.\n\n");
  assert.match(reasonOfOutcome(other.entry("NBF-1").outcome), /does not name https:\/\/github\.com\/a11ign\/announcement-emulator\/pull\/3:/, "pull/33 is not pull/3");
  const named = await planWith(`## What the blockers found\n\n- ${ANNOUNCEMENT_PULL}: cookie dialogs drop pages, so the replay clears them first.\n\n`);
  assert.equal(named.entry("NBF-1").phase, "queued");
  assert.deepEqual(named.entry("NBF-1").plannedAgainst?.named, [ANNOUNCEMENT_PULL], "the stamp records the pull requests the plan names");
});

test("a dependent planned before its blocker merged is re-planned with the findings, and its run says learns from the blocker", async () => {
  const world = followed(["NBF-1"]);
  world.blocked.set("NBF-1", [blocks("A11-165", "completed", "Done", { [ANNOUNCEMENT_PULL]: "open" })]);
  const host = createFakeCodeHost();
  const gh = { run: () => "", calls: [], codeHost: host, host } as World;
  const made = setup(1, ["NBF-1"], PLANNER, { source: world.tracker, planFirst: ["NBF-1"], gh });
  await made.pool.tick();
  made.store.set(pauseQueue(made.store.get()));
  const dir = ticketDir(made.settings, "NBF-1");
  writeFileSync(join(dir, "plan", PLAN_NAME("NBF-1")), PLAN_BODY);
  await endWith(made, dir, herdrName("NBF-1"), { kind: "planned" });
  await settled();
  assert.equal(made.entry("NBF-1").phase, "queued");
  assert.equal(made.entry("NBF-1").learned, undefined);
  // The blocker's pull request merges.
  host.seedPull("a11ign/announcement-emulator", 3, { state: "merged", findings: FINDINGS });
  world.blocked.set("NBF-1", [blocks("A11-165", "completed", "Done", { [ANNOUNCEMENT_PULL]: "merged" })]);
  await made.pool.refreshTracker();
  assert.equal(learnsLine(made.entry("NBF-1")), "learns from A11-165 (#3 merged)");
  assert.equal(made.entry("NBF-1").ticketChange, undefined, "the description did not change");
  made.h.calls.length = 0;
  made.store.set(resumeQueue(made.store.get()));
  await made.pool.tick();
  await settled();
  assert.deepEqual(world.detached.map(({ key }) => key), ["NBF-1"], "the plan written before the merge is detached");
  assert.deepEqual([made.entry("NBF-1").phase, made.entry("NBF-1").plan !== undefined], ["running", true]);
  const brief = readFileSync(join(dir, "brief.md"), "utf8");
  assert.ok(brief.includes("## This is a re-plan") && brief.includes("A pull request of a blocker merged after that plan was written") && brief.includes("## What its blockers found"));
  assert.equal(brief.includes("These lines differ"), false, "no description change is claimed");
});

test("a plan stamped and attached by another instance, that names the pull request a blocker merged, is not re-planned for it, and its worker's brief names the findings file", async () => {
  const { world, gh } = blockedByMerged(["NBF-2"]);
  world.text.set("NBF-1", { description: FIT, updatedAt: T09 });
  world.files.set("NBF-1", new Map());
  const section = `## What the blockers found\n\n- ${ANNOUNCEMENT_PULL}: cookie dialogs drop pages, so the replay clears them first.\n\n`;
  world.files.get("NBF-2")!.set(PLAN_NAME("NBF-2"), stampedPlan(PLAN_BODY.replace("## Paths", `${section}## Paths`), { updatedAt: T09, hash: descriptionHash(FIT), files: [PLAN_NAME("NBF-2")], description: FIT }));
  const made = await queuedBehind(world, { gh });
  assert.deepEqual(made.entry("NBF-2").plannedAgainst?.named, [ANNOUNCEMENT_PULL], "the stamp is read with the pull requests the plan's section names");
  await made.pool.refreshTracker();
  assert.equal(learnsLine(made.entry("NBF-2")), "learns from A11-165 (#3 merged)");
  await freeTheSlot(made);
  assert.deepEqual([made.entry("NBF-2").phase, made.entry("NBF-2").plan], ["running", undefined], "the plan already says how each finding applies");
  assert.deepEqual(world.detached, []);
  const brief = readFileSync(join(ticketDir(made.settings, "NBF-2"), "brief.md"), "utf8");
  assert.ok(brief.includes(`What their merged pull requests found is saved in these files.`) && brief.includes("A11-165-a11ign-announcement-emulator-3.md"));
});

test("a re-plan that cannot detach the stale plan ends the run crashed, saying so, and leaves the plan attached", async () => {
  const world = followed(["NBF-1", "NBF-2"]);
  attachStamped(world, "NBF-2", FIT);
  const failing: TicketSource = { ...world.tracker, detachPlan: async () => { throw new Error("Linear answered 500"); } };
  const made = await queuedBehind(world, { source: failing });
  world.edit("NBF-2", FIT_AND_REPLAY);
  await freeTheSlot(made);
  const outcome = made.entry("NBF-2").outcome;
  assert.deepEqual([made.entry("NBF-2").phase, outcome?.kind], ["finished", "crashed"]);
  assert.equal(outcome?.kind === "crashed" ? outcome.reason : "", "its stale plan could not be written again: Linear answered 500");
  assert.ok(world.files.get("NBF-2")!.has(PLAN_NAME("NBF-2")), "the plan is still attached");
});

test("a run an update stopped while it worked is not planned again for a change its worker was told of, and a live worker that is waiting on a dialog is not prompted", async () => {
  const { made } = await editedBehind();
  made.store.set({ ...made.store.get(), entries: made.store.get().entries.map((e) => (e.ticket.key === "NBF-2" ? { ...e, stoppedForUpdate: { at: 5, target: "v0.280.0" } } : e)) });
  await made.pool.refreshTracker();
  assert.equal(made.entry("NBF-2").ticketChange, undefined, "no stale mark");
  await freeTheSlot(made);
  assert.equal(made.entry("NBF-2").plan, undefined, "it resumes on the plan it has");
  made.store.set({ ...made.store.get(), entries: made.store.get().entries.map((e) => (e.ticket.key === "NBF-2" ? { ...e, waiting: true } : e)) });
  made.h.calls.length = 0;
  await made.pool.refreshTracker();
  assert.equal(made.h.calls.some((args) => args.includes("prompt")), false, "a worker waiting on a dialog is not typed into");
});

test("a re-plan detaches the file that carries the stamp last, so an attempt cut off part way leaves the stamp", async () => {
  const { world, made } = await editedBehind();
  await freeTheSlot(made);
  assert.deepEqual(world.detached[0].titles, ["NBF-2-adr-0001-zoom.md", PLAN_NAME("NBF-2")]);
});

test("what a blocker's pull request found is read once for the dependents that wait on it, and a read that throws is said and does not fail the refresh", async () => {
  const { world, gh } = blockedByMerged(["NBF-1", "NBF-2"]);
  const made = setup(1, ["NBF-1", "NBF-2"], PLANNER, { source: world.tracker, planFirst: ["NBF-1", "NBF-2"], gh });
  await made.pool.refreshTracker();
  assert.equal(gh.host.calls.filter((call) => call === `readMergedFindings ${ANNOUNCEMENT_PULL}`).length, 1, "one read for both");
  assert.deepEqual([made.entry("NBF-1").learned?.[ANNOUNCEMENT_PULL]?.number, made.entry("NBF-2").learned?.[ANNOUNCEMENT_PULL]?.number], [3, 3]);
  const failing = blockedByMerged(["NBF-1"]);
  failing.gh.codeHost.readMergedFindings = () => { throw new Error("gh exploded"); };
  const other = setup(1, ["NBF-1"], PLANNER, { source: failing.world.tracker, planFirst: ["NBF-1"], gh: failing.gh });
  const written = await captureStderr(() => other.pool.refreshTracker());
  assert.ok(written.some((line) => line.includes("what A11-165's pull request found could not be read: gh exploded")));
  assert.equal(other.entry("NBF-1").learned, undefined);
});

test("a plan the stamp would push past the size every reader skips beyond is attached as it is, unstamped, and so is never read as stale", async () => {
  const world = followed(["NBF-1"], "x".repeat(10));
  const made = setup(1, ["NBF-1"], PLANNER, { source: world.tracker, planFirst: ["NBF-1"] });
  await made.pool.tick();
  made.store.set(pauseQueue(made.store.get()));
  const dir = ticketDir(made.settings, "NBF-1");
  const body = `${PLAN_BODY}\n${"y".repeat(999_950 - PLAN_BODY.length)}\n`;
  writeFileSync(join(dir, "plan", PLAN_NAME("NBF-1")), body);
  await endWith(made, dir, herdrName("NBF-1"), { kind: "planned" });
  await settled();
  assert.equal(world.files.get("NBF-1")!.get(PLAN_NAME("NBF-1")), body);
  assert.equal(made.entry("NBF-1").plannedAgainst, undefined);
});

/*
 * A11-171: a run that waits for a person keeps its pane, Talk opens one pane for a run, and a batch's tickets share the one.
 */

/** The terminal template a host names, as the board links a pane with it. */
const TERMINAL_TEMPLATE = "http://127.0.0.1:7318/?ws={workspace}&pane={pane}&view=terminal";
const linkOf = (run: Parameters<typeof terminalLink>[1]) => terminalLink(TERMINAL_TEMPLATE, run);
const BATCH_KEYS = ["NBF-1", "NBF-2", "NBF-3", "NBF-4"];

/**
 * A batch of NBF-1..NBF-4 planned together whose run wrote `planned`: NBF-1 and NBF-2 have plans, and NBF-3 and NBF-4 each a QUESTION.md. The clock is real, so the pool
 * can tell what a person writes after the run parks from what it parked on. Returns the setup, with the tracker's log of what it attached and the order it recorded.
 */
async function batchWithQuestions(max = 1) {
  const tracker = batchTracker();
  const made = setup(max, BATCH_KEYS, BATCH_PLANNER, { source: tracker.tracker, planFirst: BATCH_KEYS, batch: true, now: Date.now });
  await made.pool.tick();
  const dir = batchDir(made.settings, BATCH);
  const plan = join(dir, "plan");
  put(join(plan, "NBF-1", "NBF-1-0001-plan-libs.md"), "# Libs\n");
  put(join(plan, "NBF-2", "NBF-2-0001-plan-netbox.md"), "# Netbox\n");
  put(join(plan, "NBF-3", "QUESTION.md"), "Which layout does the design mean?");
  put(join(plan, "NBF-4", "QUESTION.md"), "Which of the two repositories?");
  put(join(plan, "order.json"), JSON.stringify({ "NBF-1": { repo: "nbl-ui-platform-libs", after: [] }, "NBF-2": { repo: "nbl-ui-netbox", after: ["NBF-1"] }, "NBF-3": { repo: null, after: [] }, "NBF-4": { repo: null, after: [] } }));
  writeFileSync(join(dir, "outcome.json"), JSON.stringify({ kind: "planned" }));
  made.status.set(herdrName(BATCH), "idle");
  await made.pool.tick();
  await settled();
  return { ...made, ...tracker, dir, plan };
}

/** Writes the transcript of the batch's session, where Claude Code files a session that ran in the batch's folder, so a talk session can resume it. */
function saveBatchSession(made: { root: string; settings: ReturnType<typeof setup>["settings"] }, id = "session-batch") {
  const folder = batchFolder(made.settings, BATCH);
  const project = join(made.root, "transcripts", folder.replace(/[^A-Za-z0-9]/g, "-"));
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, `${id}.jsonl`), `{"cwd":${JSON.stringify(folder)}}\n`);
}

test("a single planner that ends needs-human keeps its pane, and its card links to it", async () => {
  const made = await endedOn({ kind: "needs-human", reason: "which colour?" }, 1, ["NBF-1"], BATCH_PLANNER, { planFirst: ["NBF-1"] });
  assert.deepEqual([made.entry("NBF-1").phase, made.entry("NBF-1").workspace, made.entry("NBF-1").pane, isParked(made.entry("NBF-1"))], ["finished", "w1", "w1:p1", true]);
  assert.equal(closes(made.h, "w1"), 0, "its workspace is not closed");
  assert.equal(linkOf(made.entry("NBF-1")), "http://127.0.0.1:7318/?ws=w1&pane=w1%3Ap1&view=terminal", "Open terminal goes to the pane that is still there");
});

test("a batch planner that leaves a QUESTION.md keeps its pane, parked for every ticket it handed back, and the planned tickets leave the batch", async () => {
  const { entry, h, tracker: _tracker, attached } = await batchWithQuestions();
  assert.deepEqual(attached, ["NBF-1", "NBF-2"], "the plans were attached");
  assert.equal(closes(h, "w1"), 0, "the batch's workspace stays open for the person to answer in");
  for (const key of ["NBF-3", "NBF-4"]) {
    assert.deepEqual([entry(key).phase, entry(key).workspace, entry(key).pane, entry(key).batch, isParked(entry(key)), entry(key).outcome?.kind], ["finished", "w1", "w1:p1", BATCH, true, "needs-human"], key);
  }
  assert.equal(linkOf(entry("NBF-3")), linkOf(entry("NBF-4")), "the cards of the tickets handed back link to one pane");
  assert.ok(linkOf(entry("NBF-3")) !== null);
  for (const key of ["NBF-1", "NBF-2"]) assert.deepEqual([entry(key).phase, entry(key).batch, entry(key).workspace, entry(key).planned], ["queued", undefined, undefined, true], `${key} left the batch with its plan`);
});

test("a batch planner that hands nothing back still closes its workspace", async () => {
  const { entry, h } = await plannedBatch(batchTracker().tracker, ORDERED);
  assert.ok(closes(h, "w1") > 0, "every ticket has its plan: nobody is left to answer");
  assert.deepEqual(["NBF-1", "NBF-2"].map((key) => entry(key).workspace), [undefined, undefined]);
});

/**
 * The person answers NBF-3's question in the batch's terminal: its agent works (the tickets it holds resume together, checked by `whileWorking`), then replaces the QUESTION.md with a plan,
 * writes `order` and its outcome again, and goes idle.
 */
async function answerNbf3(made: Awaited<ReturnType<typeof batchWithQuestions>>, order: Record<string, unknown>, whileWorking: () => void = () => {}) {
  const { status, pool, plan, dir } = made;
  status.set(herdrName(BATCH), "working");
  await pool.tick();
  whileWorking();
  rmSync(join(plan, "NBF-3", "QUESTION.md"));
  put(join(plan, "NBF-3", "NBF-3-0001-plan-layout.md"), "# Layout\n");
  put(join(plan, "order.json"), JSON.stringify(order));
  writeFileSync(join(dir, "outcome.json"), JSON.stringify({ kind: "planned" }));
  status.set(herdrName(BATCH), "idle");
  await pool.tick();
  await settled();
}

test("a parked batch answered in its terminal settles its remaining tickets, reading the order against every ticket it planned", async () => {
  const made = await batchWithQuestions();
  const { entry, relations, attached, store } = made;
  assert.deepEqual([...relations], [["NBF-2", ["NBF-1"]]], "the first pass recorded NBF-2 after NBF-1");
  await answerNbf3(made, { "NBF-1": { repo: "nbl-ui-platform-libs", after: [] }, "NBF-2": { repo: "nbl-ui-netbox", after: ["NBF-1"] }, "NBF-3": { repo: "nbl-ui-netbox", after: ["NBF-2"] }, "NBF-4": { repo: null, after: [] } },
    () => assert.deepEqual(["NBF-3", "NBF-4"].map((key) => [entry(key).phase, entry(key).workspace]), [["running", "w1"], ["running", "w1"]], "answering resumes the tickets together"));
  assert.deepEqual(attached, ["NBF-1", "NBF-2", "NBF-3"], "NBF-3's plan is attached, and the plans planned before are not attached again");
  assert.deepEqual([...relations], [["NBF-2", ["NBF-1"]], ["NBF-3", ["NBF-2"]]], "the order was read against every ticket it planned, and recorded only for NBF-3");
  assert.deepEqual([entry("NBF-3").phase, entry("NBF-3").planned, entry("NBF-3").plannedRepo, entry("NBF-3").batch], ["queued", true, "nbl-ui-netbox", undefined]);
  assert.deepEqual([entry("NBF-4").phase, entry("NBF-4").workspace, entry("NBF-4").batch, entry("NBF-4").outcome?.kind], ["finished", "w1", BATCH, "needs-human"], "the ticket still asking stays parked on the pane");
  assert.equal(store.get().entries.find((e) => e.ticket.key === "NBF-4")?.phase, "finished");
});

test("a queued talk session or round never closes a parked run's pane: it waits, saying so", async () => {
  const made = await endedOn({ kind: "needs-human", reason: "which colour?" });
  const { pool, h, entry, store, root } = made;
  store.set(enqueue(store.get(), [ticket("NBF-2")], { model: "sonnet", effort: "high" }, 0, null));
  assert.deepEqual([entry("NBF-1").workspace, entry("NBF-2").phase], ["w1", "queued"], "NBF-1 is parked on w1");
  mkdirSync(join(root, "transcripts", "-Users-me-work"), { recursive: true });
  writeFileSync(join(root, "transcripts", "-Users-me-work", "session-t-nbf-1.jsonl"), "{}\n");
  // NBF-2 is a finished run whose saved session is NBF-1's, and a person asks to talk to it.
  const finishedNbf2 = { ...entry("NBF-2"), phase: "finished" as const, outcome: { kind: "needs-human", reason: "q" } as Outcome, session: "session-t-nbf-1", finishedAt: 5 };
  store.set({ ...store.get(), max: 2, entries: store.get().entries.map((e) => (e.ticket.key === "NBF-2" ? finishedNbf2 : e)) });
  pool.talk("NBF-2");
  h.extra.push(talkLeftover("idle", { workspace_id: "w9", label: "claude", name: null }));
  h.calls.length = 0;
  await pool.tick();
  assert.equal(closes(h, "w9"), 1, "an idle duplicate that is nobody's parked pane is still a leftover, and is closed");
  assert.equal(closes(h, "w1"), 0, "the parked run's pane is not a leftover to close");
  assert.deepEqual([entry("NBF-2").phase, entry("NBF-2").sessionWait], ["queued", "Waits for the person to answer in w1"]);
  assert.deepEqual([entry("NBF-1").phase, entry("NBF-1").workspace], ["finished", "w1"], "and NBF-1 is still parked on it");
});

test("Talk twice opens one pane", async () => {
  const { pool, h, entry, status, dir } = await draftOfNbf1();
  pool.talk("NBF-1");
  await pool.tick();
  assert.equal(h.calls.filter((args) => args.includes("create")).length, 1, "the first press opens a pane");
  pool.talk("NBF-1");
  await pool.tick();
  assert.equal(h.calls.filter((args) => args.includes("create")).length, 1, "a second press while it runs opens none, and is not refused");
  await endWith({ pool, status }, dir, herdrName("NBF-1"), { kind: "needs-human", reason: "waiting for the person in the terminal" });
  assert.equal(isParked(entry("NBF-1")), true, "the agent waits for the person");
  pool.talk("NBF-1");
  await pool.tick();
  assert.equal(h.calls.filter((args) => args.includes("create")).length, 1, "a press while it waits for the person opens none either");
  assert.equal(h.calls.filter((args) => args.includes("start")).length, 1, "and the session was started once");
});

/** A batch with questions, room for every run, its saved session on disk, and its pane closed by the person: tickets NBF-3 and NBF-4 are finished and Talk is offered on them. */
async function batchToTalkTo() {
  const made = await batchWithQuestions(4);
  saveBatchSession(made);
  made.pool.close("NBF-3");
  made.status.delete(herdrName(BATCH));
  return made;
}

test("Talk on two tickets of one batch opens one pane for both", async () => {
  const made = await batchToTalkTo();
  const { pool, h, entry } = made;
  assert.deepEqual(["NBF-3", "NBF-4"].map((key) => [entry(key).phase, entry(key).workspace]), [["finished", undefined], ["finished", undefined]], "the person closed the pane, so both are finished");
  h.calls.length = 0;
  pool.talk("NBF-3");
  assert.deepEqual(["NBF-3", "NBF-4"].map((key) => [entry(key).phase, entry(key).talk]), [["queued", true], ["queued", true]], "Talk on one is Talk on both");
  await pool.tick();
  const batchCalls = (verb: string) => h.calls.filter((args) => args.includes(verb) && args.includes(herdrName(BATCH)));
  assert.equal(batchCalls("create").length, 1, "one pane");
  const starts = batchCalls("start");
  assert.deepEqual([starts.length, starts[0].includes("--resume"), starts[0].includes("session-batch")], [1, true, true], "resuming the batch's saved session");
  assert.deepEqual(["NBF-3", "NBF-4"].map((key) => [entry(key).phase, entry(key).workspace, entry(key).pane]), [["running", "w3", "w3:p1"], ["running", "w3", "w3:p1"]], "both run on the one new pane (NBF-1 and NBF-2 took w1 and w2)");
  pool.talk("NBF-4");
  await pool.tick();
  assert.equal(batchCalls("create").length, 1, "Talk on the other card opens no second pane");
  assert.equal(linkOf(entry("NBF-3")), linkOf(entry("NBF-4")), "both cards link the one pane");
});

/** A planner whose question parked it, its pane then closed by the person, with its saved session on disk: a run Talk can open. */
async function plannerToTalkTo() {
  const made = await endedOn({ kind: "needs-human", reason: "which colour?" }, 1, ["NBF-1"], BATCH_PLANNER, { planFirst: ["NBF-1"] });
  assert.equal(runStatus(made.entry("NBF-1")), "needs-you", "waiting for a person, before Talk");
  made.pool.close("NBF-1");
  made.status.delete(herdrName("NBF-1"));
  mkdirSync(join(made.root, "transcripts", "-Users-me-work"), { recursive: true });
  writeFileSync(join(made.root, "transcripts", "-Users-me-work", "session-t-nbf-1.jsonl"), "{}\n");
  made.store.set({ ...made.store.get(), entries: made.store.get().entries.map((e) => ({ ...e, session: "session-t-nbf-1" })) });
  return made;
}

/** Talk to the planner `plannerToTalkTo` made, run `whileRunning` once its session runs, then have its agent wait for the person in the terminal, as the Talk prompt tells it to. */
async function talkUntilWaiting(made: Awaited<ReturnType<typeof plannerToTalkTo>>, whileRunning: () => void = () => {}) {
  made.pool.talk("NBF-1");
  await made.pool.tick();
  whileRunning();
  await endWith(made, ticketDir(made.settings, "NBF-1"), herdrName("NBF-1"), { kind: "needs-human", reason: "waiting for the person in the terminal" });
}

test("a talk session shows talking, never planning, while it runs and while it waits for the person", async () => {
  const made = await plannerToTalkTo();
  const { entry } = made;
  await talkUntilWaiting(made, () => assert.deepEqual([entry("NBF-1").phase, entry("NBF-1").plan !== undefined, runStatus(entry("NBF-1"))], ["running", true, "talking"], "it carries its planning run's plan, and still says Talking"));
  assert.deepEqual([entry("NBF-1").phase, isParked(entry("NBF-1")), runStatus(entry("NBF-1"))], ["finished", true, "talking"], "waiting for the person in the terminal, it is still Talking");
});

test("closing the pane of a talk session that waits for the person ends the session: the run needs the person again, as before", async () => {
  const made = await plannerToTalkTo();
  const { pool, entry } = made;
  await talkUntilWaiting(made);
  pool.close("NBF-1");
  assert.deepEqual([entry("NBF-1").phase, entry("NBF-1").talk, entry("NBF-1").workspace], ["finished", undefined, undefined], "closing the pane ends the talk session");
  assert.equal(runStatus(entry("NBF-1")), "needs-you");
});

test("a talk session that waited for the person and then ends on a pull request is that run again, not a review round", async () => {
  const { pool, status, entry, dir } = await draftOfNbf1();
  pool.talk("NBF-1");
  await pool.tick();
  await endWith({ pool, status }, dir, herdrName("NBF-1"), { kind: "needs-human", reason: "waiting for the person in the terminal" });
  assert.deepEqual([entry("NBF-1").talk, isParked(entry("NBF-1"))], [true, true], "it waits, still a talk session");
  await agentIs({ pool, status }, herdrName("NBF-1"), "working");
  assert.equal(entry("NBF-1").phase, "running", "the person answered");
  await endWith({ pool, status }, dir, herdrName("NBF-1"), { kind: "draft-pr", prs: [approvedPr] });
  assert.deepEqual([entry("NBF-1").phase, entry("NBF-1").outcome?.kind, entry("NBF-1").talk, entry("NBF-1").review], ["finished", "draft-pr", undefined, undefined]);
});

test("a parked talk session keeps the run it replaced, so ending again on a pull request still tells a borrowed list from a review round's own", () => {
  const first = enqueue(emptyQueue(1), [ticket("NBF-1")], { model: "sonnet", effort: "high" }, 0, null).entries[0];
  const round = { ...first, phase: "finished" as const, review: [approvedPr], outcome: { kind: "reviewed", prs: [approvedPr] } as Outcome };
  const talking = { ...talkRound(round, 5), phase: "running" as const, workspace: "w1", pane: "w1:p1" };
  const waiting = park({ ...emptyQueue(1), entries: [talking] }, "NBF-1", { kind: "needs-human", reason: "waiting for the person in the terminal" }, 9);
  assert.deepEqual([waiting.entries[0].talk, waiting.entries[0].talkFrom?.review], [true, [approvedPr]], "it waits, still a talk session, with the run it replaced");
  const ended = finish(markResumed(waiting, "NBF-1"), "NBF-1", { kind: "ready-pr", prs: [approvedPr] }, 10);
  assert.deepEqual([ended.entries[0].talk, ended.entries[0].review], [undefined, [approvedPr]], "the round's own list is kept");
});

test("Talk on a batch starts every ticket's session in the one pane even when a ticket of it waits on another", async () => {
  const made = await batchToTalkTo();
  const { pool, h, entry, relations } = made;
  relations.set("NBF-4", ["NBF-3"]);
  h.calls.length = 0;
  pool.talk("NBF-3");
  await pool.tick();
  assert.equal(h.calls.filter((args) => args.includes("create") && args.includes(herdrName(BATCH))).length, 1, "one pane");
  assert.deepEqual(["NBF-3", "NBF-4"].map((key) => [entry(key).phase, entry(key).workspace]), [["running", "w3"], ["running", "w3"]], "both on it, though NBF-4 waits on NBF-3");
});

test("a folder in the plan folder that is no ticket of the board is not part of the batch an order may name", async () => {
  const made = await batchWithQuestions();
  const { entry, relations, plan } = made;
  put(join(plan, "notes", "scratch.md"), "# scratch\n");
  await answerNbf3(made, { "NBF-3": { repo: "nbl-ui-netbox", after: ["notes"] }, notes: { repo: null, after: [] } });
  assert.deepEqual([...relations], [["NBF-2", ["NBF-1"]]], "the order named a ticket the board does not have, so none of it was recorded");
  assert.deepEqual([entry("NBF-3").phase, entry("NBF-3").plannedRepo], ["queued", null], "the plan itself still stands");
});
