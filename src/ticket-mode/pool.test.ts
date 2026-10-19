// no-token: gh -- herdr, git, Linear and the clock are all injected; nothing is spawned
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "../lib/tmp-fixture.ts";
import { runStatus, waitNote } from "./board-view/settled-by-pulls.ts";
import {
  batchDir, batchFolder, countTokens, createPool, feedbackSince, findFolderSession, findTranscript, herdrName, herdrServerCommand, isStartDialog, parseOutcome, publishDir, publishResult,
  ticketDir, ticketFolder, worktreesIn,
} from "./pool.ts";
import { approve, completableRuns, finish, queuePublish, recordPullStates, respond, pauseQueue, resumeQueue } from "./queue/approve.ts";
import { BACKGROUND_GONE_MS, enqueue, liveRunCount, retry, writerStatus, type Outcome, type Queue } from "./queue/declared-remains.ts";
import { emptyQueue, queueWriter, writerOf } from "./queue.ts";
import { writerDir, writerFolder } from "./ticket-paths.ts";
import { parseTicketSettings } from "./settings.ts";
import { REVIEWER_LOGIN, loadReviewerGate, readReviewerMemory, reviewerMemoryPath, type RepostAnswer, type ReviewerPort, type ReviewerRef, type ReviewerSettled } from "./reviewer-port.ts";
import type { PullState, Ticket, TicketSource } from "./source.ts";

const ticket = (key: string) => ({ key, title: key, description: "", url: `https://linear.app/x/${key}`, branch: key.toLowerCase(), status: "Backlog", statusOrder: 0, team: "NBF", project: null, priority: 0 }) as Ticket;
const source: TicketSource = { assigned: async () => [], read: async () => null, download: async () => [] };

/** A herdr that opens workspaces and starts agents, and reports each label's status from `status`. A verb in `refused` fails as herdr does. */
function herdr(status: Map<string, string>, screen: { text: string } = { text: "" }) {
  const calls: string[][] = [];
  const refused = new Set<string>();
  let next = 0;
  const run = (args: string[]) => {
    calls.push(args);
    if (args.some((arg) => refused.has(arg))) throw Object.assign(new Error("herdr exited 1"), { stdout: JSON.stringify({ error: { message: "workspace_not_found" } }) });
    if (args.includes("read")) return screen.text;
    if (args.includes("create")) {
      next += 1;
      return JSON.stringify({ result: { root_pane: { pane_id: `w${next}:p1` }, workspace: { workspace_id: `w${next}` } } });
    }
    if (args.includes("agent") && args.includes("list")) return JSON.stringify({ result: { agents: [...status].map(([label]) => ({ name: null, workspace_id: `w${label.replace(/\D/g, "")}`, agent_session: { value: `session-${label}` } })) } });
    if (args.includes("list")) return JSON.stringify({ result: { workspaces: [...status].map(([label, s]) => ({ label, agent_status: s })) } });
    return JSON.stringify({ type: "ok" });
  };
  return { run, calls, refused };
}

/** `parents` gives a ticket its parent's key. A ticket without one is shaped as a run queued before tickets carried a parent. */
function setup(max = 2, keys = ["NBF-1", "NBF-2", "NBF-3"], tickets: Record<string, unknown> = {},
  { source: tracker = source, parents = {}, planFirst = [], batch = false, pluginRecord, gh, reviewerPort, now = () => 100 }:
    { source?: TicketSource; parents?: Record<string, string>; planFirst?: string[]; batch?: boolean; pluginRecord?: string; gh?: (args: string[]) => string;
      reviewerPort?: ReviewerPort; now?: () => number } = {}) {
  const root = tmpDir("ticket-pool-");
  const settings = parseTicketSettings({ clones: { "nbl-ui-netbox": "/repos/nbl-ui-netbox", "nbl-ui-platform-libs": "/repos/libs" }, stateDir: join(root, "state"), tickets });
  const queued = keys.map((key) => (key in parents ? { ...ticket(key), parent: parents[key] } : ticket(key)));
  const plan = planFirst.length === 0 ? null : { keys: new Set(planFirst), choice: { model: "opus", effort: "max" }, batch };
  let queue: Queue = resumeQueue(enqueue(emptyQueue(max), queued, { model: "sonnet", effort: "high" }, 0, plan));
  const store = { get: () => queue, set: (next: Queue) => { queue = next; } };
  const status = new Map<string, string>();
  const screen = { text: "" };
  const h = herdr(status, screen);
  const deps = { settings, source: tracker, hook: { node: "/node", bin: "/tool/src/bin.ts" }, herdr: h.run, hostFile: "/work/.agent-org/host.json", now, load: () => ({ load: 1, cores: 14 }), transcriptsRoot: join(root, "transcripts"), wait: async () => {},
    pluginRecord: pluginRecord ?? join(root, "no-plugin-record.json"), ...(gh ? { gh } : {}), ...(reviewerPort ? { reviewerPort } : {}) };
  const pool = createPool(store, deps);
  const entry = (key: string) => queue.entries.find((e) => e.ticket.key === key)!;
  /** A pool started over the same queue and state directory, as the board's pool is after a restart. */
  const restart = () => createPool(store, deps);
  return { settings, pool, restart, status, h, entry, store, root, screen };
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
  const { pool, settings } = setup(1, ["NBF-1"], { connectors });
  await pool.tick();
  const dir = ticketDir(settings, "NBF-1");
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

/** A pool whose one run, NBF-1, ended with a draft pull request in a session herdr called `session-t-nbf-1`, then was approved. */
async function approvedRun(tickets: Record<string, unknown> = {},
  { transcript = true, gh, reviewerPort }: { transcript?: boolean; gh?: (args: string[]) => string; reviewerPort?: ReviewerPort } = {}) {
  const ctx = setup(1, ["NBF-1"], tickets, { gh, reviewerPort });
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
    settings, source, hook: { node: "n", bin: "b" }, herdr: run, wait: async () => { up = true; }, startServer: (s) => started.push(s),
  });
  await pool.ensureSession();
  await pool.ensureSession();
  assert.deepEqual(started, ["tickets"], "started in ticket mode's own session, and only when it did not answer");
});

// A11-78: `systemctl --user restart` of the instance ended every process in its cgroup, the herdr server it had started and every worker in it.
test("under systemd the session's herdr server starts in a scope of its own, outside the instance's service; anywhere else herdr starts directly", () => {
  const systemd = herdrServerCommand("tickets", { INVOCATION_ID: "515de870" }, "linux");
  assert.equal(systemd.file, "systemd-run");
  assert.deepEqual(systemd.args.slice(0, 2), ["--user", "--scope"], "a user scope: the server leaves the instance's cgroup and keeps its environment");
  assert.ok(systemd.args.includes("--unit=agent-org-herdr-tickets"), "named for its session, so `systemctl --user status` finds it");
  assert.deepEqual(systemd.args.slice(-4), ["herdr", "--session", "tickets", "server"]);
  assert.ok(herdrServerCommand("a b/c", { INVOCATION_ID: "x" }, "linux").args.includes("--unit=agent-org-herdr-a-b-c"), "a unit name holds no character systemd refuses");
  assert.deepEqual(herdrServerCommand("tickets", {}, "linux"), { file: "herdr", args: ["--session", "tickets", "server"] }, "started by hand: no unit to leave");
  assert.deepEqual(herdrServerCommand("tickets", { INVOCATION_ID: "x" }, "darwin"), { file: "herdr", args: ["--session", "tickets", "server"] },
    "launchd ends a job's process group, which a detached server has left");
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
  const { pool, status, entry, settings, store } = setup(1, ["NBF-1"]);
  await pool.tick();
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
  let queue: Queue = resumeQueue(enqueue(emptyQueue(1), [ticket("NBF-1")], { model: "sonnet", effort: "high" }, 0));
  const store = { get: () => queue, set: (next: Queue) => { queue = next; } };
  const h = herdr(new Map());
  let pool: ReturnType<typeof createPool>;
  // The person presses Stop while Claude is starting.
  const herdrAsync = async (args: string[]) => { pool.stop("NBF-1"); return h.run(args); };
  pool = createPool(store, { settings, source, hook: { node: "n", bin: "b" }, herdr: h.run, herdrAsync, wait: async () => {}, load: () => ({ load: 0, cores: 1 }) });
  await pool.tick();
  assert.deepEqual(queue.entries[0].outcome, { kind: "stopped" });
  assert.ok(h.calls.some((args) => args.includes("close") && args.includes("w1")), "the raced workspace is closed");
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
  const pool = createPool(store, { settings, source: tracker, hook: { node: "/node", bin: "/b" }, herdr: () => "{}", now: () => 9, load: () => ({ load: 0, cores: 1 }), transcriptsRoot: root, wait: async () => {} });
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
  const pool = createPool(store, { settings, source: tracker, hook: { node: "/node", bin: "/b" }, herdr: () => "{}", now: () => 9, load: () => ({ load: 0, cores: 1 }), transcriptsRoot: root, wait: async () => {} });
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
  const pool = createPool(store, { settings, source: tracker, hook: { node: "/node", bin: "/b" }, herdr: () => "{}", now: () => 9, load: () => ({ load: 0, cores: 1 }), transcriptsRoot: root, wait: async () => {} });
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

test("A11-92: a draft, a checked run and a run with an open pull request leave their tickets open", async () => {
  const draft = completing({ kind: "draft-pr", prs: [{ repo: "r", url: MERGED_PR }] });
  await draft.pool.refreshTracker();
  const checked = completing({ kind: "checked", reason: "nothing to change" });
  await checked.pool.refreshTracker();
  const open = completing({ kind: "ready-pr", prs: [{ repo: "r", url: MERGED_PR }] }, { pull: "open" });
  await open.pool.refreshTracker();
  assert.deepEqual([draft.calls.length, checked.calls.length, open.calls.length], [0, 0, 0]);
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
  const pool = createPool(store, { settings, source, hook: { node: "/node", bin: "/b" }, herdr: () => "{}", now: () => 9, load: () => ({ load: 0, cores: 1 }), transcriptsRoot: root, wait: async () => {} });
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

test("a run that hands its ticket back is parked: its workspace and pane stay, and it holds no slot", async () => {
  for (const outcome of [{ kind: "needs-human", reason: "which colour?" }, { kind: "wrong-repo", where: "netbox" }, null]) {
    const { entry, h } = await endedOn(outcome, 1, ["NBF-1", "NBF-2"]);
    assert.deepEqual([entry("NBF-1").phase, entry("NBF-1").workspace, entry("NBF-1").pane], ["finished", "w1", "w1:p1"], JSON.stringify(outcome));
    assert.equal(closes(h, "w1"), 0, "the person can still answer it");
    assert.equal(entry("NBF-2").phase, "running", "NBF-2 took the one slot as NBF-1 parked");
  }
});

test("a parked run whose agent works again is resumed: its outcome is moved aside, its stop count cleared, and it ends again on a new one", async () => {
  const { pool, status, entry, settings, h } = await endedOn({ kind: "needs-human", reason: "which colour?" });
  const dir = ticketDir(settings, "NBF-1");
  writeFileSync(join(dir, "stop-refusals"), "2");
  await pool.tick();
  assert.equal(entry("NBF-1").phase, "finished", "an idle parked agent stays parked");
  status.set(herdrName("NBF-1"), "working");
  await pool.tick();
  assert.deepEqual([entry("NBF-1").phase, entry("NBF-1").outcome], ["running", undefined]);
  assert.ok(!existsSync(join(dir, "outcome.json")), "the stop hook now asks for a new outcome");
  assert.match(readFileSync(join(dir, "outcome.prev.json"), "utf8"), /which colour/);
  assert.ok(!existsSync(join(dir, "stop-refusals")), "a fresh count, so the hook refuses a stop without an outcome again");
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

test("a ticket queued to be planned first starts a planning run: it plans and changes no code, on the planning model, with the planning refusals added", async () => {
  const { tracker } = planTracker();
  const { pool, h, settings } = setup(1, ["NBF-1"], PLANNER, { source: tracker, planFirst: ["NBF-1"] });
  await pool.tick();
  const dir = ticketDir(settings, "NBF-1");
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
  const { pool, status, entry, settings } = setup(1, ["NBF-1"], PLANNER, { source: tracker, planFirst: ["NBF-1"] });
  await pool.tick();
  writeFileSync(join(ticketDir(settings, "NBF-1"), "plan", "NBF-1-0001-plan-fit.md"), "# Fit\n");
  writeFileSync(join(ticketDir(settings, "NBF-1"), "outcome.json"), JSON.stringify({ kind: "planned" }));
  status.set(herdrName("NBF-1"), "idle");
  await pool.tick();
  await pool.tick();
  release();
  await settled();
  assert.deepEqual(calls, ["NBF-1"]);
  assert.equal(entry("NBF-1").phase, "queued");
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
    writeFileSync(join(dir, "outcome.json"), JSON.stringify({ kind: "planned" }));
    status.set(herdrName("NBF-1"), "idle");
    await pool.tick();
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
  const { pool, status, entry, settings } = setup(1, ["NBF-1"], PLANNER, { source: tracker, planFirst: ["NBF-1"] });
  await pool.tick();
  writeFileSync(join(ticketDir(settings, "NBF-1"), "plan", "NBF-1-0001-plan-fit.md"), "# Fit\n");
  writeFileSync(join(ticketDir(settings, "NBF-1"), "outcome.json"), JSON.stringify({ kind: "planned" }));
  status.set(herdrName("NBF-1"), "idle");
  await pool.tick();
  pool.stop("NBF-1");
  release();
  await settled();
  assert.equal(entry("NBF-1").outcome?.kind, "stopped");
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

test("a run stopped and retried while its plan was attached is a new run, which the old attach leaves alone", async () => {
  const { tracker, held } = heldTracker();
  const made = setup(1, ["NBF-1"], PLANNER, { source: tracker, planFirst: ["NBF-1"] });
  await plannedRun(made);
  made.pool.stop("NBF-1");
  made.store.set(retry(made.store.get(), "NBF-1", 200));
  made.status.delete(herdrName("NBF-1"));
  await made.pool.tick();
  assert.equal(made.entry("NBF-1").workspace, "w2", "the retried planning run has started");
  held.release();
  await settled();
  assert.deepEqual([made.entry("NBF-1").phase, made.entry("NBF-1").workspace, made.entry("NBF-1").plan !== undefined], ["running", "w2", true]);
});

test("a run stopped while its plan was attached stays stopped when the attach then fails", async () => {
  const { tracker, held } = heldTracker();
  const made = setup(1, ["NBF-1"], PLANNER, { source: tracker, planFirst: ["NBF-1"] });
  await plannedRun(made);
  made.pool.stop("NBF-1");
  held.fail(new Error("Linear answered 500"));
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
    writeFileSync(join(ticketDir(settings, "NBF-1"), "outcome.json"), JSON.stringify({ kind: "planned" }));
    status.set(herdrName("NBF-1"), "idle");
    await pool.tick();
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
  const { pool, h, entry } = setup(1, ["NBF-1"], { plugins: ["nbl-ui@applied-ai"] }, { pluginRecord: record });
  await pool.tick();
  const outcome = entry("NBF-1").outcome;
  assert.equal(outcome?.kind, "crashed");
  assert.match(outcome?.kind === "crashed" ? outcome.reason : "", /nbl-ui@applied-ai is installed only for \/work, so a worker in .* runs without it: install it for every folder with `claude plugin install nbl-ui@applied-ai --scope user`/);
  assert.equal(h.calls.some((args) => args.includes("start")), false, "no worker was started");
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
    const written = await captureStderr(async () => {
      const { pool, entry } = setup(1, ["NBF-1"], { workingState: "In Progress" }, { source: tracker });
      await pool.tick();
      await settled();
      assert.equal(entry("NBF-1").phase, "running");
    });
    assert.ok(written.includes(line), line);
  }
});

test("a tracker that throws before it answers the move cannot stop the run, and one that cannot move tickets is not asked", async () => {
  const throwing: TicketSource = { ...source, moveToWorkingState: () => { throw new Error("not ready"); } };
  const written = await captureStderr(async () => {
    const { pool, entry } = setup(1, ["NBF-1"], { workingState: "In Progress" }, { source: throwing });
    await pool.tick();
    await settled();
    assert.equal(entry("NBF-1").phase, "running");
  });
  assert.ok(written.includes("ticket:serve: NBF-1 could not be moved to In Progress: not ready\n"));
  const { pool, entry } = setup(1, ["NBF-1"], { workingState: "In Progress" });
  await pool.tick();
  assert.equal(entry("NBF-1").phase, "running", "a source without the move starts the run as before");
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
  const parked = await endedOn({ kind: "needs-human", reason: "which colour?" }, 1, ["NBF-1"], { workingState: "In Progress" }, { source: tracker });
  parked.pool.close("NBF-1");
  parked.store.set(retry(parked.store.get(), "NBF-1", 200));
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
  const parked = await endedOn({ kind: "needs-human", reason: "which colour?" }, 1, ["NBF-1"], { workingState: "In Progress" }, { source: tracker });
  parked.pool.close("NBF-1");
  parked.store.set(retry(parked.store.get(), "NBF-1", 200));
  control.refuseRestore = "Linear answered 500";
  await assert.rejects(parked.pool.remove("NBF-1"), /NBF-1 could not be put back to Todo: Linear answered 500/);
  assert.equal(parked.entry("NBF-1").phase, "queued");
});

test("no tick starts a queued run while Remove puts its ticket back, so the run Remove takes off is the one that was queued", async () => {
  const { tracker, current, control } = stateTracker();
  const parked = await endedOn({ kind: "needs-human", reason: "which colour?" }, 1, ["NBF-1"], { workingState: "In Progress" }, { source: tracker });
  parked.pool.close("NBF-1");
  parked.store.set(retry(parked.store.get(), "NBF-1", 200));
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
  const parked = await endedOn({ kind: "needs-human", reason: "which colour?" }, 1, ["NBF-1"], { workingState: "In Progress" }, { source: tracker });
  parked.pool.close("NBF-1");
  parked.store.set(retry(parked.store.get(), "NBF-1", 200));
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
  assert.ok(h.calls.some((args) => args.includes("close") && args.includes("w1")), "the run's workspace is closed");
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
  const written = await captureStderr(async () => {
    const { pool, status, entry, settings } = setup(1, ["NBF-1", "NBF-2"], BATCH_PLANNER, { source: tracker, planFirst: ["NBF-1", "NBF-2"], batch: true });
    await pool.tick();
    const plan = join(batchDir(settings, BATCH), "plan");
    put(join(plan, "NBF-1", "NBF-1-0001-plan-a.md"), "# A\n");
    put(join(plan, "NBF-2", "NBF-2-0001-plan-b.md"), "# B\n");
    put(join(plan, "order.json"), JSON.stringify({ "NBF-1": { repo: "a", after: ["NBF-2"] }, "NBF-2": { repo: "b", after: ["NBF-1"] } }));
    writeFileSync(join(batchDir(settings, BATCH), "outcome.json"), JSON.stringify({ kind: "planned" }));
    status.set(herdrName(BATCH), "idle");
    await pool.tick();
    await settled();
    assert.deepEqual(["NBF-1", "NBF-2"].map((key) => [entry(key).planned, entry(key).plannedRepo]), [[true, null], [true, null]]);
  });
  assert.deepEqual([attached, [...relations]], [["NBF-1", "NBF-2"], []]);
  assert.ok(written.some((line) => /order\.json was not used, so no order was recorded: its order goes round in a cycle: NBF-1 -> NBF-2 -> NBF-1/.test(line)), written.join(""));
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
  assert.ok(existsSync(join(dir, "outcome.prev.json")), "the run's own outcome is moved aside");
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
  writeFileSync(join(batchDir(settings, BATCH), "outcome.json"), JSON.stringify({ kind: "planned" }));
  status.set(herdrName(BATCH), "idle");
  await pool.tick();
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
  const plan = join(batchDir(settings, BATCH), "plan");
  put(join(plan, "NBF-1", "NBF-1-0001-plan-a.md"), "# A\n");
  put(join(plan, "NBF-2", "NBF-2-0001-plan-b.md"), "# B\n");
  put(join(plan, "order.json"), JSON.stringify({ "NBF-1": { repo: "nbl-ui-platform-libs", after: [] }, "NBF-2": { repo: "nbl-ui-netbox", after: ["NBF-1"] } }));
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
  writeFileSync(join(batchDir(settings, BATCH), "outcome.json"), JSON.stringify({ kind: "planned" }));
  status.set(herdrName(BATCH), "idle");
  await pool.tick();
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
  let queue: Queue = resumeQueue(enqueue(emptyQueue(1), [ticket("NBF-1"), ticket("NBF-2")], { model: "sonnet", effort: "high" }, 0,
    { keys: new Set(["NBF-1", "NBF-2"]), choice: { model: "opus", effort: "max" }, batch: true }));
  const store = { get: () => queue, set: (next: Queue) => { queue = next; } };
  const h = herdr(new Map());
  let pool: ReturnType<typeof createPool>;
  // The person presses Stop on the second ticket while the batch's Claude is starting.
  const herdrAsync = async (args: string[]) => { pool.stop("NBF-2"); return h.run(args); };
  pool = createPool(store, { settings, source: batchTracker().tracker, hook: { node: "n", bin: "b" }, herdr: h.run, herdrAsync, wait: async () => {}, load: () => ({ load: 0, cores: 1 }),
    pluginRecord: join(root, "none.json") });
  await pool.tick();
  assert.deepEqual(queue.entries.map((e) => e.outcome), [{ kind: "stopped" }, { kind: "stopped" }]);
  assert.ok(h.calls.some((args) => args.includes("close") && args.includes("w1")), "the raced workspace is closed");
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
  const { pool, entry, dir, h } = await parkedReview();
  writeFileSync(join(dir, "outcome.json"), JSON.stringify({ kind: "reviewed" }));
  await pool.tick();
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

/** A gh that acts as `worker-bot` and answers each pull request's feedback read from `pulls`, by number; a number it has no answer for is refused. */
function ghFor(pulls: Record<number, unknown>) {
  const calls: string[][] = [];
  const run = (args: string[]) => {
    calls.push(args);
    if (args[1] === "user") return "worker-bot\n";
    if (args[0] === "pr") {
      const pull = pulls[Number(args[2])] as { state: string; headRefOid: string; reviews: { nodes: unknown[] }; commits: { nodes: { commit: { statusCheckRollup: { contexts: { nodes: unknown[] } } } }[] } } | undefined;
      if (pull === undefined) throw new Error("gh exited 1");
      return JSON.stringify({ state: pull.state, headRefOid: pull.headRefOid, reviews: pull.reviews.nodes, author: { login: "worker-bot" }, isCrossRepository: false, isDraft: false,
        statusCheckRollup: [GATE_GREEN, ...pull.commits.nodes[0].commit.statusCheckRollup.contexts.nodes] });
    }
    const number = Number(args.find((arg) => arg.startsWith("number="))?.slice("number=".length));
    if (!(number in pulls)) throw new Error("gh exited 1");
    return JSON.stringify({ data: { repository: { pullRequest: pulls[number] } } });
  };
  return { run, calls };
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
async function readyRun(gh: (args: string[]) => string, tickets: Record<string, unknown> = {}, reviewerPort?: ReviewerPort) {
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

test("new review feedback on a run Ready to merge starts a feedback round that resumes its worker and names the feedback; its own account's does not", async () => {
  const gh = ghFor({ 1: feedbackPull({
    reviews: [{ state: "COMMENTED", submittedAt: at(300), author: { login: "worker-bot" } }, { state: "CHANGES_REQUESTED", submittedAt: at(200), author: { login: "a11ign-reviewer" } }],
  }) });
  const { pool, entry, dir, h } = await readyRun(gh.run);
  h.calls.length = 0;
  pool.watchFeedback();
  await roundStarted();
  assert.deepEqual([entry("NBF-1").phase, entry("NBF-1").rounds, entry("NBF-1").review], ["running", 1, [approvedPr]]);
  assert.equal(entry("NBF-1").feedback, `New review feedback on ${approvedPr.url}, the newest from a11ign-reviewer.`);
  const start = h.calls.find((args) => args.includes("start"))!;
  const tail = start.slice(start.indexOf("--") + 1);
  assert.equal(tail[0], `New feedback reached this ticket's pull requests. Read ${dir}/brief.md and follow it.`);
  assert.deepEqual(tail.slice(tail.indexOf("--resume"), tail.indexOf("--resume") + 2), ["--resume", "session-t-nbf-1"]);
  assert.match(readFileSync(join(dir, "brief.md"), "utf8"), /feedback round for NBF-1/);
  assert.equal(gh.calls.filter((args) => args[1] === "user").length, 1, "the account is read once");
});

test("feedback from before the run's last round ended, from the workers' own account, or on a pull request that could not be read starts no round", async () => {
  for (const [why, pulls] of [
    ["older than the round", { 1: feedbackPull({ comments: [{ createdAt: at(50), author: { login: "alice" } }] }) }],
    ["the workers' own", { 1: feedbackPull({ comments: [{ createdAt: at(500), author: { login: "worker-bot" } }] }) }],
    ["merged since", { 1: feedbackPull({ state: "MERGED", comments: [{ createdAt: at(500), author: { login: "alice" } }] }) }],
    ["could not ask", {}],
  ] as const) {
    const gh = ghFor(pulls);
    const { pool, entry } = await readyRun(gh.run);
    const logged = await captureStderr(async () => { pool.watchFeedback(); await roundStarted(); });
    assert.deepEqual([entry("NBF-1").phase, entry("NBF-1").rounds], ["finished", undefined], why);
    const said = logged.some((line) => line.includes(`NBF-1: the feedback on ${approvedPr.url} could not be read, so it was not checked`));
    assert.equal(said, why === "could not ask", `${why}: an unread pull request is said in the board's log, and only that`);
  }
});

test("a check that failed on the head commit after the round ended starts a round naming it, and a run the board does not watch is never read", async () => {
  const gh = ghFor({ 1: feedbackPull({ checks: [{ __typename: "CheckRun", name: "typecheck", conclusion: "FAILURE", completedAt: at(400), isRequired: false }] }) });
  const { pool, entry } = await readyRun(gh.run);
  pool.watchFeedback();
  assert.equal(entry("NBF-1").feedback, `typecheck failed on the head commit of ${approvedPr.url}.`);
  const unwatched = ghFor({});
  const { pool: other } = setup(1, ["NBF-1"], {}, { gh: unwatched.run });
  other.watchFeedback();
  assert.deepEqual(unwatched.calls, [], "nothing Ready to merge: GitHub is not asked, not even who the workers are");
});

test("what triggers a round names each pull request's new feedback and failed checks, and nothing older than the round", () => {
  const read = { state: "open" as const, feedbackAt: 200, authors: ["alice", "bob"], failing: ["typecheck", "suite"], failedAt: 300, conflicting: false, base: "main", files: [], filesComplete: true };
  assert.equal(feedbackSince([{ url: "u1", read }], 100), "New review feedback on u1, the newest from alice.\ntypecheck, suite failed on the head commit of u1.");
  assert.equal(feedbackSince([{ url: "u1", read }], 250), "typecheck, suite failed on the head commit of u1.");
  assert.equal(feedbackSince([{ url: "u1", read }], 300), null);
  assert.equal(feedbackSince([{ url: "u1", read: { ...read, state: "closed" } }], 100), null);
});

test("A11-82: a pull request that conflicts with its base names its base on every watch, whatever the round's time, and a closed one is not named", () => {
  const read = { state: "open" as const, feedbackAt: null, authors: [], failing: [], failedAt: null, conflicting: true, base: "main", files: [], filesComplete: true };
  const line = "https://github.com/acme/repo/pull/7 conflicts with its base branch main.";
  assert.equal(feedbackSince([{ url: "https://github.com/acme/repo/pull/7", read }], 900), line, "a conflict is a state, so no time passes it by");
  assert.equal(feedbackSince([{ url: "https://github.com/acme/repo/pull/7", read: { ...read, state: "merged" as const } }], 0), null);
});

/**
 * A tracker whose download writes each ticket's plan file, which declares the paths `paths` gives it as its `## Paths` section. `refuse` runs
 * before each download, so a test can make the tracker refuse one.
 */
function planFiles(paths: Record<string, string[]>, refuse: () => void = () => {}): TicketSource {
  return { ...source, download: async (ticket, dir) => {
    refuse();
    const file = join(dir, `${ticket.key}-plan-x.md`);
    writeFileSync(file, `## Paths\n${(paths[ticket.key] ?? []).map((path) => `- \`${path}\``).join("\n")}\n`);
    return [file];
  } };
}

/** NBF-1 finished with a draft pull request, watched with `gh` and not approved: a draft is read for its footprint, and never woken. */
async function draftRun(gh: (args: string[]) => string) {
  const ctx = setup(1, ["NBF-1"], {}, { gh });
  await ctx.pool.tick();
  ctx.status.set(herdrName("NBF-1"), "idle");
  writeFileSync(join(ticketDir(ctx.settings, "NBF-1"), "outcome.json"), JSON.stringify({ kind: "draft-pr", prs: [approvedPr] }));
  await ctx.pool.tick();
  ctx.status.delete(herdrName("NBF-1"));
  assert.equal(runStatus(ctx.entry("NBF-1")), "awaiting-review");
  return ctx;
}

/** NBF-1 finished with ready pull requests, on a machine that opens them ready, so no Approve comes and the board watches them. */
async function readyPrRun(gh: (args: string[]) => string) {
  const ctx = setup(1, ["NBF-1"], { drafts: false }, { gh });
  await ctx.pool.tick();
  ctx.status.set(herdrName("NBF-1"), "idle");
  writeFileSync(join(ticketDir(ctx.settings, "NBF-1"), "outcome.json"), JSON.stringify({ kind: "ready-pr", prs: [approvedPr] }));
  await ctx.pool.tick();
  ctx.status.delete(herdrName("NBF-1"));
  assert.equal(runStatus(ctx.entry("NBF-1")), "awaiting-review");
  return ctx;
}

test("A11-82: a pull request that conflicts with its base resumes its worker once, the round names the conflict and its base, and the brief has the worker merge the base in", async () => {
  const gh = ghFor({ 1: feedbackPull({ mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" }) });
  const { pool, entry, dir, h } = await readyRun(gh.run);
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
  assert.match(brief, /^1\. The feedback above says a pull request conflicts with its base branch\. Merge the base branch into your branch before anything else: `git fetch`, then `git merge origin\/<base>`/m);
  assert.match(brief, /Never rebase, and never force-push\. Resolve each conflict keeping both changes' intent/, "never a rebase, and both changes kept");
  assert.match(brief, /^3\. Fix each finding that is right/m, "the feedback steps follow, renumbered after the merge");
});

test("A11-82: a conflict on a run awaiting review is a round too, and a draft's read records the files it changes without waking the worker", async () => {
  const gh = ghFor({ 1: feedbackPull({ mergeable: "CONFLICTING", files: ["src/ticket-mode/pool.ts"] }) });
  const ready = await readyPrRun(gh.run);
  ready.pool.watchFeedback();
  assert.deepEqual([ready.entry("NBF-1").phase, ready.entry("NBF-1").rounds], ["queued", 1], "a ready-pr run waiting for review is watched");
  const draft = await draftRun(ghFor({ 1: feedbackPull({ mergeable: "CONFLICTING", files: ["src/ticket-mode/pool.ts"] }) }).run);
  draft.pool.watchFeedback();
  await roundStarted();
  assert.deepEqual([draft.entry("NBF-1").phase, draft.entry("NBF-1").rounds, draft.entry("NBF-1").pullFiles], ["finished", undefined, { [approvedPr.url]: ["src/ticket-mode/pool.ts"] }],
    "a draft is not woken, and its files are kept for the footprint");
});

test("A11-82: a merged pull request that reads conflicting gets no round, and a run at its cap hands a conflict to a person, whose Respond to review starts again", async () => {
  const merged = await readyRun(ghFor({ 1: feedbackPull({ state: "MERGED", mergeable: "CONFLICTING" }) }).run);
  merged.pool.watchFeedback();
  await roundStarted();
  assert.deepEqual([merged.entry("NBF-1").phase, merged.entry("NBF-1").rounds], ["finished", undefined], "merged: nothing to resolve");

  const capped = await readyRun(ghFor({ 1: feedbackPull({ mergeable: "CONFLICTING" }) }).run);
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
async function parkedOnQuestion(gh: (args: string[]) => string) {
  const ctx = await approvedRun({}, { gh });
  ctx.status.set(herdrName("NBF-1"), "working");
  await ctx.pool.tick();
  writeFileSync(join(ctx.dir, "outcome.json"), JSON.stringify({ kind: "needs-human", reason: "which colour?" }));
  ctx.status.set(herdrName("NBF-1"), "idle");
  await ctx.pool.tick();
  assert.deepEqual([ctx.entry("NBF-1").phase, ctx.entry("NBF-1").outcome?.kind, ctx.entry("NBF-1").workspace], ["finished", "needs-human", "w2"], "parked on a question");
  return ctx;
}

test("A11-89: a parked run whose pull request conflicts is resumed: its workspace is closed once, the same worker resumes once with the conflict named, and its brief merges the base in", async () => {
  const gh = ghFor({ 1: feedbackPull({ mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" }) });
  const { pool, entry, dir, h } = await parkedOnQuestion(gh.run);
  h.calls.length = 0;
  pool.watchFeedback();
  pool.watchFeedback();
  await roundStarted();
  assert.deepEqual([entry("NBF-1").phase, entry("NBF-1").rounds, entry("NBF-1").review], ["running", 1, [approvedPr]]);
  assert.equal(entry("NBF-1").feedback, `${approvedPr.url} conflicts with its base branch main.`);
  assert.equal(closes(h, "w2"), 1, "the parked workspace is closed once, before the round starts");
  const starts = h.calls.filter((args) => args.includes("start"));
  assert.equal(starts.length, 1, "the same worker is started once, not once per watch");
  assert.deepEqual(starts[0].slice(starts[0].indexOf("--resume"), starts[0].indexOf("--resume") + 2), ["--resume", "session-t-nbf-1"]);
  const brief = readFileSync(join(dir, "brief.md"), "utf8");
  assert.match(brief, /^1\. The feedback above says a pull request conflicts with its base branch\. Merge the base branch into your branch before anything else/m);
  assert.equal(existsSync(join(dir, "outcome.json")), false, "the needs-human it parked on is cleared, so it does not end this round");
});

test("A11-89: a parked run whose pull request is clear, unknown, or has only new review feedback and a failed check is left alone", async () => {
  const pulls = [
    feedbackPull({ mergeable: "MERGEABLE", mergeStateStatus: "CLEAN" }),
    feedbackPull({ mergeable: "UNKNOWN", mergeStateStatus: "UNKNOWN" }),
    feedbackPull({ reviews: [{ state: "CHANGES_REQUESTED", submittedAt: at(300), author: { login: "a11ign-reviewer" } }],
      checks: [{ __typename: "CheckRun", name: "typecheck", conclusion: "FAILURE", completedAt: at(400), isRequired: false }] }),
  ];
  for (const pull of pulls) {
    const { pool, entry, h } = await parkedOnQuestion(ghFor({ 1: pull }).run);
    h.calls.length = 0;
    pool.watchFeedback();
    await roundStarted();
    assert.deepEqual([entry("NBF-1").phase, entry("NBF-1").rounds, entry("NBF-1").workspace, entry("NBF-1").outcome?.kind], ["finished", undefined, "w2", "needs-human"],
      "a parked run with no conflict is not woken, and keeps its question");
    assert.deepEqual(h.calls, [], "no workspace is closed and no worker is started");
  }
});

test("A11-89: a parked run whose conflicting pull request merged, or whose run was stopped, gets no round", async () => {
  const merged = await parkedOnQuestion(ghFor({ 1: feedbackPull({ state: "MERGED", mergeable: "CONFLICTING" }) }).run);
  merged.pool.watchFeedback();
  await roundStarted();
  assert.deepEqual([merged.entry("NBF-1").phase, merged.entry("NBF-1").rounds], ["finished", undefined], "merged: nothing to resolve");

  const stopped = await parkedOnQuestion(ghFor({ 1: feedbackPull({ mergeable: "CONFLICTING" }) }).run);
  stopped.store.set({ ...stopped.store.get(), entries: stopped.store.get().entries.map((e) => (e.ticket.key === "NBF-1" ? { ...e, outcome: { kind: "stopped" as const } } : e)) });
  stopped.h.calls.length = 0;
  stopped.pool.watchFeedback();
  await roundStarted();
  assert.deepEqual([stopped.entry("NBF-1").phase, stopped.entry("NBF-1").rounds, stopped.entry("NBF-1").workspace], ["finished", undefined, "w2"], "stopped is a person's act");
  assert.deepEqual(stopped.h.calls, [], "nothing is closed or started");
});

test("A11-89: a parked run whose workspace herdr will not close stays parked, names it in the log, and the next watch asks again", async () => {
  const gh = ghFor({ 1: feedbackPull({ mergeable: "CONFLICTING" }) });
  const { pool, entry, h } = await parkedOnQuestion(gh.run);
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
  const capped = await parkedOnQuestion(ghFor({ 1: feedbackPull({ mergeable: "CONFLICTING" }) }).run);
  capped.store.set({ ...capped.store.get(), entries: capped.store.get().entries.map((e) => (e.ticket.key === "NBF-1" ? { ...e, rounds: 3 } : e)) });
  capped.h.calls.length = 0;
  capped.pool.watchFeedback();
  await roundStarted();
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
  const { pool, entry, store, status } = setup(1, ["NBF-1", "NBF-2"], { plan: "-plan-[^/]*\\.md$" }, { gh: gh.run, source: planFiles({
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
    writeFileSync(join(batchDir(ran.settings, BATCH), "outcome.json"), JSON.stringify({ kind: "planned" }));
    ran.status.set(herdrName(BATCH), "idle");
    await ran.pool.tick();
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
    const { pool, entry, store, status } = setup(1, ["NBF-1", "NBF-2"], { plan: "-plan-[^/]*\\.md$" }, { gh: gh.run, source: planFiles({
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

test("A11-82: a plan the tracker cannot give starts nothing, so a run is not started beside a run its plan may overlap before that is known", async () => {
  let down = true;
  const tracker = planFiles({ "NBF-1": ["nbl-ui-netbox:src/a.ts"], "NBF-2": ["nbl-ui-netbox:src/a.ts"] }, () => {
    if (down) throw new Error("the attachment link is gone");
  });
  const { pool, entry } = setup(2, ["NBF-1", "NBF-2"], { plan: "-plan-[^/]*\\.md$" }, { source: tracker });
  await pool.tick();
  assert.deepEqual([entry("NBF-1").phase, entry("NBF-2").phase], ["queued", "queued"], "nothing starts while a plan cannot be read");
  down = false;
  await pool.tick();
  assert.deepEqual([entry("NBF-1").phase, entry("NBF-2").phase], ["running", "queued"], "read, the second waits for the first");
});

const PUBLISH = { publish: { run: "Run the post-pr-to-slack skill on these pull requests, all in one go: {prs}. Then write {dir}/published.json",
  connectors: ["^mcp__plugin_slack_slack__slack_send_message$"] } };

/** NBF-1 Ready to merge on a machine that publishes, Publish pressed for it, and the publish run started. */
async function publishing() {
  const ctx = await readyRun(ghFor({}).run, PUBLISH);
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
  status.set(herdrName("NBF-1"), "blocked");
  await pool.tick();
  assert.deepEqual([entry("NBF-1").outcome?.kind, entry("NBF-1").workspace], ["no-outcome", "w2"]);
  status.set(herdrName("NBF-1"), "idle");
  await pool.tick();
  assert.equal(runStatus(entry("NBF-1")), "ready-to-merge");
});

test("Respond to review resumes the worker, told a person asked it to answer the feedback", async () => {
  const { pool, entry, dir, h, store } = await readyRun(ghFor({}).run);
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
  const ctx = await readyRun(gh.run);
  ctx.store.set(pauseQueue(queuePublish(ctx.store.get(), ["NBF-1"], 300)));
  ctx.h.calls.length = 0;
  gh.calls.length = 0;
  await ctx.pool.tick();
  const publish = ctx.store.get().publish!;
  assert.match(publish.failure ?? "", /tickets\.publish/, "the failure names the setting");
  assert.equal(ctx.h.calls.some((args) => args.includes("start")), false, "no publish agent starts");
  assert.equal(existsSync(join(publishDir(ctx.settings, publish.id), "brief.md")), false, "no publish run folder is written");
  assert.equal(gh.calls.some((args) => args.some((arg) => ["comment", "review", "create", "edit", "merge"].includes(arg))), false, "GitHub is not written to");
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
  const ctx = await readyRun(gh.run, REVIEWING, port);
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
  const ctx = await readyRun(ghFor({ 1: feedbackPull() }).run, REVIEWING, port);
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
  const ctx = await readyRun(ghFor({ 1: feedbackPull() }).run, REVIEWING, port);
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
  const ctx = await readyRun(ghFor({ 1: feedbackPull() }).run, REVIEWING, port);
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
  const ctx = await readyRun(gh.run, REVIEWING, port);
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
    const ctx = await readyRun(gh.run, { reviewer: "atomic", drafts }, port);
    gh.calls.length = 0;
    ctx.pool.watchFeedback();
    await roundStarted();
    assert.equal(starts.length, drafts ? 0 : 1, `drafts ${drafts}: the reviewer starts`);
    assert.equal(gh.calls.some((args) => args[0] === "pr"), !drafts, `drafts ${drafts}: the pull request is read for a reviewer only when drafts is off`);
  }
});

test("the reviewer's own review never moves feedbackAt: its comment after the round ended starts no round, and a person's comment after the round still does", async () => {
  for (const [why, commentAt, rounds] of [["the reviewer's comment alone", 50, undefined], ["a person's comment after the round", 150, 1]] as const) {
    const gh = ghFor({ 1: feedbackPull({
      reviews: [{ state: "COMMENTED", submittedAt: at(300), author: { login: REVIEWER_LOGIN }, commit: { oid: "h1" } }],
      comments: [{ createdAt: at(commentAt), author: { login: "alice" } }],
    }) });
    const ctx = await readyRun(gh.run, REVIEWING, fakeReviewer().port);
    ctx.pool.watchFeedback();
    await roundStarted();
    assert.equal(ctx.entry("NBF-1").rounds, rounds, why);
  }
});

test("the reviewer's verdict on the head reaches the worker: changes requested starts a round that names the reviewer, and an approval starts none", async () => {
  for (const [state, rounds] of [["CHANGES_REQUESTED", 1], ["APPROVED", undefined]] as const) {
    const gh = ghFor({ 1: feedbackPull({ reviews: [{ state, submittedAt: at(200), author: { login: REVIEWER_LOGIN }, commit: { oid: "h1" } }] }) });
    const ctx = await readyRun(gh.run, REVIEWING, fakeReviewer().port);
    ctx.pool.watchFeedback();
    await roundStarted();
    assert.equal(ctx.entry("NBF-1").rounds, rounds, state);
    if (rounds !== undefined) assert.ok(ctx.entry("NBF-1").feedback?.includes(`${REVIEWER_LOGIN} requested changes on ${approvedPr.url} at h1`), state);
  }
});

test("a reviewer memory file that cannot be read is said once in the board's log, nothing is remembered from it, and a valid one is written over it", async () => {
  const { port, starts } = fakeReviewer();
  const ctx = await readyRun(ghFor({ 1: feedbackPull() }).run, REVIEWING, port);
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
    assert.match(read.kind === "needs-human" ? read.reason : "", /without evidence/, "the reason names the evidence it lacks");
  }
  const bare = parseOutcome(JSON.stringify({ kind: "done", evidence: ["e"] }));
  assert.match(bare.kind === "needs-human" ? bare.reason : "", /without a reason/);
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
  status.set(herdrName("NBF-1"), "working");
  await pool.tick();
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
  writeFileSync(join(ticketDir(settings, "NBF-1"), "outcome.json"), JSON.stringify({ kind: "working", reason: "the roll is still running" }));
  status.set(herdrName("NBF-1"), "idle");
  await pool.tick();
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
  return { ...made, advance: (ms: number) => { clock += ms; } };
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
  const { pool, entry, h, screen, advance, settings } = await idleWithWork(PANE());
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
  advance(BACKGROUND_GONE_MS);
  await pool.tick();
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

test("a reviewer is closed once its verdict on its head is posted: started, and closed in the same watch", async () => {
  const { port, starts, closes } = reviewerWith();
  const ctx = await readyRun(ghFor({ 1: feedbackPull({ reviews: [reviewOn(REVIEWER_LOGIN, "APPROVED", "h1")] }) }).run, REVIEWING, port);
  ctx.pool.watchFeedback();
  await roundStarted();
  assert.deepEqual(starts.map((ref) => ref.head), ["h1"], "the reviewer for h1 is started");
  assert.deepEqual(closes, [{ pr: approvedPr.url, head: "h1" }], "and closed once its approval is posted");
  ctx.restart().watchFeedback();
  await roundStarted();
  assert.equal(closes.length, 1, "a closed reviewer is not closed again");
  assert.deepEqual(starts.map((ref) => ref.head), ["h1"], "and not started again for h1");
});

test("a reviewer still working at its verdict is asked again on each watch until it is closed", async () => {
  const { port, starts, closes } = reviewerWith({ closeAnswers: ["busy", "busy", "closed"] });
  const ctx = await readyRun(ghFor({ 1: feedbackPull({ reviews: [reviewOn(REVIEWER_LOGIN, "APPROVED", "h1")] }) }).run, REVIEWING, port);
  for (let watch = 1; watch <= 3; watch += 1) {
    ctx.pool.watchFeedback();
    await roundStarted();
    assert.equal(closes.length, watch, `watch ${watch} asks for the close again`);
  }
  ctx.pool.watchFeedback();
  await roundStarted();
  assert.equal(closes.length, 3, "once closed, no watch asks again");
  assert.deepEqual(starts.map((ref) => ref.head), ["h1"], "nothing is started while it is busy");
});

test("a not-convinced verdict closes its reviewer in the watch that starts the round, and the sweep asks again while it is busy", async () => {
  const { port, closes } = reviewerWith({ closeAnswers: ["busy", "closed"] });
  const ctx = await readyRun(ghFor({ 1: feedbackPull({ reviews: [reviewOn(REVIEWER_LOGIN, "CHANGES_REQUESTED", "h1")] }) }).run, REVIEWING, port);
  ctx.pool.watchFeedback();
  await roundStarted();
  assert.deepEqual([ctx.entry("NBF-1").phase, ctx.entry("NBF-1").rounds], ["running", 1], "the worker's round is started");
  assert.equal(closes.length, 1, "the close is asked in the watch that started the round, and found it busy");
  ctx.pool.releaseReviewers();
  assert.equal(closes.length, 2, "the sweep asks again, and it is closed");
  ctx.pool.releaseReviewers();
  assert.equal(closes.length, 2, "no further close once it is closed");
});

test("a merged pull request's reviewer is retired by the sweep, and what the pool remembers of it is dropped from disk", async () => {
  const { port, starts, retired } = reviewerWith();
  const pulls = { 1: feedbackPull() };
  const ctx = await readyRun(ghFor(pulls).run, REVIEWING, port);
  ctx.pool.watchFeedback();
  await roundStarted();
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
  const ctx = await readyRun(ghFor(pulls).run, REVIEWING, port);
  ctx.pool.watchFeedback();
  await roundStarted();
  pulls[1] = feedbackPull({ state: "CLOSED" });
  ctx.pool.releaseReviewers();
  assert.deepEqual(retired, [approvedPr.url]);
});

test("an open pull request's reviewer is left alone by the sweep, and still remembered", async () => {
  const { port, retired } = reviewerWith();
  const ctx = await readyRun(ghFor({ 1: feedbackPull() }).run, REVIEWING, port);
  ctx.pool.watchFeedback();
  await roundStarted();
  ctx.pool.releaseReviewers();
  assert.deepEqual(retired, []);
  assert.equal(readReviewerMemory(reviewerMemoryPath(ctx.settings.stateDir)).memory.started.size, 1);
});

test("a pull request whose state cannot be read is kept and logged, and asked again on the next sweep", async () => {
  const { port, retired } = reviewerWith();
  const pulls: Record<number, unknown> = { 1: feedbackPull() };
  const ctx = await readyRun(ghFor(pulls).run, REVIEWING, port);
  ctx.pool.watchFeedback();
  await roundStarted();
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
  const ctx = await readyRun(ghFor(pulls).run, REVIEWING, port);
  ctx.pool.watchFeedback();
  await roundStarted();
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
  const { port, retired } = reviewerWith();
  const pulls = { 1: feedbackPull() };
  const ctx = await readyRun(ghFor(pulls).run, REVIEWING, port);
  ctx.pool.watchFeedback();
  await roundStarted();
  pulls[1] = feedbackPull({ state: "MERGED" });
  ctx.restart().releaseReviewers();
  assert.deepEqual(retired, [approvedPr.url], "the restarted pool retires it");
});

test("a reviewer the session lists with no memory of it is retired once its pull request has merged", async () => {
  const { port, retired, starts } = reviewerWith({ listedPulls: () => [approvedPr.url] });
  const ctx = await readyRun(ghFor({ 1: feedbackPull({ state: "MERGED" }) }).run, REVIEWING, port);
  ctx.pool.releaseReviewers();
  assert.deepEqual(retired, [approvedPr.url], "a reviewer a ticket:review start left is retired");
  assert.deepEqual(starts, [], "and nothing is started");
});

test("a reviewer is not started for a pull request that has merged, even one the pool has forgotten and the tracker still shows open", async () => {
  const { port, starts } = reviewerWith();
  const ctx = await readyRun(ghFor({ 1: feedbackPull({ state: "MERGED" }) }).run, REVIEWING, port);
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
  const ctx = await readyRun(ghFor({ 1: feedbackPull({ reviews }) }).run, REVIEWING, made.port);
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
  const ctx = await readyRun(ghFor({ 1: feedbackPull({ reviews }) }).run, REVIEWING, made.port);
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
  const ctx = await readyRun(ghFor({ 1: feedbackPull() }).run, REVIEWING, made.port);
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
  const ctx = await readyRun(ghFor({ 1: feedbackPull() }).run, REVIEWING, made.port);
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
  const ctx = await readyRun(ghFor({ 1: feedbackPull() }).run, REVIEWING, made.port);
  ctx.pool.watchFeedback();
  await roundStarted();
  ctx.pool.watchFeedback();
  await roundStarted();
  assert.deepEqual(made.prompts, [{ pr: approvedPr.url, head: "h1" }], "prompted once, as a reviewer that has just started is");
  assert.equal(ctx.entry("NBF-1").verdictNotPosted, undefined, "the first look says nothing yet");
  ctx.pool.watchFeedback();
  await roundStarted();
  assert.equal(ctx.entry("NBF-1").verdictNotPosted, `${NOT_POSTED}: the reviewer ended without writing a verdict file`);
  assert.equal(made.prompts.length, 1, "and is not prompted again");
  assert.deepEqual(made.posts, [], "nothing is posted without a file");
});

test("a reviewer still working is left alone: no repost, prompt or line on the run, and a review already at the head triggers nothing", async () => {
  const working = unpostedReviewer({ settled: "working" });
  const ctx = await readyRun(ghFor({ 1: feedbackPull() }).run, REVIEWING, working.port);
  for (let watch = 0; watch < 3; watch += 1) {
    ctx.pool.watchFeedback();
    await roundStarted();
  }
  assert.deepEqual([working.posts, working.prompts], [[], []], "nothing is posted or prompted while it works");
  assert.equal(ctx.entry("NBF-1").verdictNotPosted, undefined);

  const reviewed = unpostedReviewer();
  const approved = await readyRun(ghFor({ 1: feedbackPull({ reviews: [reviewOn(REVIEWER_LOGIN, "APPROVED", "h1")] }) }).run, REVIEWING, reviewed.port);
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
  const ctx = await readyRun(ghFor(pulls).run, REVIEWING, made.port);
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
  const ctx = await readyRun(ghFor({ 1: feedbackPull({ reviews }) }).run, REVIEWING, made.port);
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
 * New-ticket runs (A11-94): a person's request starts one run of the writer, which leaves drafts for the board to review. It writes no ticket.
 */

const WRITER = { writer: { run: "Run the a11ign:create-ticket skill, quick, for this request: {request}. Write each draft under {dir}/drafts." } };
const WRITER_REQUEST: { id: string; request: string; mode: "quick" | "grill"; form: { repo?: string } } = { id: "w1", request: "Show the requests a person made", mode: "quick", form: { repo: "nbl-ui-netbox" } };

/** A pool with `request` queued as a new-ticket run, and the queue unpaused: its run's folder and herdr name are the test's to read. */
function writing(request: Partial<typeof WRITER_REQUEST> = {}, tickets: Record<string, unknown> = WRITER, tracker: TicketSource = source) {
  const ctx = setup(2, [], tickets, { source: tracker });
  ctx.store.set(queueWriter(ctx.store.get(), { ...WRITER_REQUEST, ...request }, 0));
  const name = herdrName(`writer-${request.id ?? WRITER_REQUEST.id}`);
  return { ...ctx, name, dir: writerDir(ctx.settings, request.id ?? WRITER_REQUEST.id), run: () => writerOf(ctx.store.get(), request.id ?? WRITER_REQUEST.id)! };
}

/** Let the reads a finished writer run makes (its drafts' duplicates) settle. */
async function writerSettled(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

/** The draft a valid writer run leaves: a title, why and done-when, as the board checks them. */
const goodDraft = { title: "feat: show requests", why: "A person asks for it", doneWhen: ["The board lists them"] };

test("a new-ticket run starts on a free slot, with the writer's model, its brief naming the request, and the mark that lets it read the tracker only", async () => {
  const { pool, settings, dir, name, h, run } = writing();
  await pool.tick();
  assert.equal(run().phase, "running", "it starts");
  assert.deepEqual([run().workspace, run().pane], ["w1", "w1:p1"]);
  const brief = readFileSync(join(dir, "brief.md"), "utf8");
  assert.match(brief, /for this request: Show the requests a person made\. Write each draft under /, "the instruction, with the request and the folder filled in");
  assert.match(brief, /> Show the requests a person made/, "the request, quoted");
  assert.match(brief, /repo`: `nbl-ui-netbox`|\(the draft's `repo`\)/, "the choices the form made are requirements");
  assert.equal(readFileSync(join(dir, "writer-run"), "utf8").trim(), "{}", "the mark the hook reads");
  const deny = JSON.parse(readFileSync(join(dir, "deny.json"), "utf8")) as { pattern: string }[];
  assert.ok(deny.some(({ pattern }) => pattern.includes("ticket:worktree")), "a writer changes no repository: the planning refusals apply to it");
  const start = h.calls.find((args) => args.includes("start") && args.includes(name))!;
  assert.ok(start.includes("opus") && start.includes("high"), "the writer's default model and effort");
  assert.equal(settings.writer?.model, "opus");
  assert.ok(existsSync(join(settings.stateDir, "tickets", "writer", "w1")));
  assert.ok(existsSync(join(writerFolder(settings, "w1"), ".claude", "settings.local.json")), "its settings sit in a folder of its own, so runs never overwrite each other's");
});

test("a new-ticket run starts though the queue is paused, as a person asked for it, and holds a slot while it runs", async () => {
  const ctx = writing();
  ctx.store.set(pauseQueue(ctx.store.get()));
  await ctx.pool.tick();
  assert.equal(ctx.run().phase, "running", "Pause does not hold a new-ticket run");
});

test("a writer run's drafts are read once its agent is idle with its outcome: each valid draft is pending, a bad one is named, and a duplicate is resolved", async () => {
  const tracker = { ...source, read: async (key: string) => (key === "NBF-9" ? { key, title: "Show requests", url: "https://linear.app/x/NBF-9" } as Ticket : null) };
  const { pool, status, name, dir, run, store } = writing({}, WRITER, tracker);
  await pool.tick();
  mkdirSync(join(dir, "drafts"), { recursive: true });
  writeFileSync(join(dir, "drafts", "01-show.json"), JSON.stringify({ ...goodDraft, duplicates: [{ key: "NBF-9", why: "same request" }, { key: "NBF-404", why: "gone" }] }));
  writeFileSync(join(dir, "drafts", "02-bad.json"), JSON.stringify({ ...goodDraft, priority: "hi" }));
  writeFileSync(join(dir, "outcome.json"), JSON.stringify({ kind: "drafted" }));
  status.set(name, "working");
  await pool.tick();
  status.set(name, "idle");
  await pool.tick();
  await writerSettled();
  assert.equal(run().phase, "finished");
  assert.equal(run().drafts.length, 1);
  assert.equal(run().drafts[0].status, "pending");
  assert.equal(run().drafts[0].draft.title, "feat: show requests");
  assert.deepEqual(run().drafts[0].duplicates.map(({ key, title }) => [key, title]), [["NBF-9", "Show requests"], ["NBF-404", null]]);
  assert.match(run().rejected[0].reason, /^02-bad\.json: "priority" must be one of/);
  assert.equal(writerStatus(run()), "to-review", "a draft waits for the person's review");
  assert.equal(store.get().entries.length, 0, "no ticket is queued by a writer run");
});

test("a run whose drafts are all refused fails, naming each file, and a run that wrote no outcome fails as it stopped", async () => {
  const { pool, status, name, dir, run } = writing();
  await pool.tick();
  mkdirSync(join(dir, "drafts"), { recursive: true });
  writeFileSync(join(dir, "drafts", "01-bad.json"), JSON.stringify({ ...goodDraft, why: "" }));
  writeFileSync(join(dir, "outcome.json"), JSON.stringify({ kind: "drafted" }));
  status.set(name, "idle");
  await pool.tick();
  await writerSettled();
  assert.equal(run().failure, 'none of its drafts is valid: 01-bad.json: "why" must be a non-empty string');
  assert.equal(run().phase, "finished");

  const quiet = writing({ id: "w2" });
  await quiet.pool.tick();
  quiet.status.set(quiet.name, "working");
  await quiet.pool.tick();
  quiet.status.set(quiet.name, "done");
  await quiet.pool.tick();
  await writerSettled();
  assert.equal(quiet.run().failure, "it stopped without writing an outcome");
});

test("a grill run asks its question and holds no slot while it waits, and resumes once its agent works again, its question moved aside", async () => {
  const { pool, status, name, dir, run, store } = writing({ mode: "grill" });
  await pool.tick();
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "outcome.json"), JSON.stringify({ kind: "needs-human", reason: "Which goal does it serve?" }));
  status.set(name, "idle");
  await pool.tick();
  await writerSettled();
  assert.equal(run().phase, "waiting");
  assert.equal(run().question, "Which goal does it serve?");
  assert.equal(writerStatus(run()), "needs-you");
  assert.equal(liveRunCount(store.get()), 0, "waiting holds no worker slot");
  status.set(name, "working");
  await pool.tick();
  assert.equal(run().phase, "running");
  assert.equal(run().question, undefined);
  assert.ok(existsSync(join(dir, "outcome.prev.json")), "the question's outcome is moved aside, as a parked ticket run's is");
  assert.equal(existsSync(join(dir, "outcome.json")), false);
});

test("a new-ticket run that never ends is failed after 30 minutes of running, and a grill run waiting is not timed out", async () => {
  const { pool, status, name, store, run } = writing({ id: "w3" });
  await pool.tick();
  status.set(name, "working");
  await pool.tick();
  store.set({ ...store.get(), writers: store.get().writers!.map((r) => (r.id === "w3" ? { ...r, startedAt: 100 - 30 * 60_000 - 1 } : r)) });
  await pool.tick();
  assert.deepEqual([run().phase, run().failure], ["finished", "it did not finish within 30 minutes"]);
  assert.equal(writerStatus(run()), "failed");
});

test("stopping a new-ticket run closes its workspace, and keeps the drafts it had written; a run that has ended is left alone", async () => {
  const { pool, status, name, dir, run, h, store } = writing({ id: "w4" });
  await pool.tick();
  status.set(name, "working");
  await pool.tick();
  mkdirSync(join(dir, "drafts"), { recursive: true });
  writeFileSync(join(dir, "drafts", "01-a.json"), JSON.stringify(goodDraft));
  writeFileSync(join(dir, "outcome.json"), JSON.stringify({ kind: "drafted" }));
  pool.stopWriterRun("w4");
  assert.equal(closes(h, "w1"), 1, "the workspace is closed");
  assert.equal(run().phase, "finished");
  assert.equal(run().failure, "stopped on the board");
  assert.equal(store.get().writers?.length, 1);
  pool.stopWriterRun("w4");
  assert.equal(closes(h, "w1"), 1, "a second stop closes nothing");
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

test("A11-106: the sweep moves a stacked pull request to the default branch once its base merged, and keeps the note of one it cannot move", async () => {
  const stacked = { base: "nbf-1-fit", refuse: false, edits: [] as string[][] };
  const answers = ghFor({ 1: feedbackPull() });
  const gh = (args: string[]) => {
    if (args[0] === "pr" && args[1] === "view") return JSON.stringify({ baseRefName: stacked.base, state: "OPEN" });
    if (args[0] === "repo") return "main\n";
    if (args[0] === "pr" && args[1] === "list") return JSON.stringify([{ state: "MERGED" }]);
    if (args[0] === "pr" && args[1] === "edit") {
      stacked.edits.push(args);
      if (stacked.refuse) throw new Error("gh: Resource not accessible by integration (HTTP 403)");
      stacked.base = "main";
      return "";
    }
    return answers.run(args);
  };
  const ctx = await readyPrRun(gh);
  withBlockerOn(ctx.store, "NBF-1", "nbf-1-fit");
  ctx.pool.retargetStacked();
  assert.deepEqual(stacked.edits, [["pr", "edit", approvedPr.url, "--base", "main"]], "one edit, to the default branch");
  assert.equal(ctx.entry("NBF-1").retargets, undefined, "retargeted, so nothing is recorded on the run");
  ctx.pool.retargetStacked();
  assert.equal(stacked.edits.length, 1, "a pull request on the default branch is not edited again");

  stacked.base = "nbf-1-fit";
  stacked.refuse = true;
  ctx.pool.retargetStacked();
  assert.equal(stacked.edits.length, 2, "the refused edit is tried");
  assert.match(ctx.entry("NBF-1").retargets?.[approvedPr.url] ?? "", /retarget failed, and agent-org tries again: gh: Resource not accessible/);
});

/** Gives the run `key` a blocker whose pull request is on `branch`, as a run stacked on that blocker keeps (`queue.ts`'s `ended` keeps its blockers). */
function withBlockerOn(store: { get: () => Queue; set: (next: Queue) => void }, key: string, branch: string) {
  const queue = store.get();
  const blocker = { key: "NBF-0", state: "started", status: "In Review", branch, pulls: {} };
  store.set({ ...queue, entries: queue.entries.map((entry) => (entry.ticket.key === key ? { ...entry, blockers: [blocker] } : entry)) });
}

test("A11-106: a run that has not finished is not swept, so its pull requests are not asked and its queue is not written", async () => {
  const asked: string[][] = [];
  const answers = ghFor({ 1: feedbackPull() });
  const gh = (args: string[]) => {
    asked.push(args);
    return answers.run(args);
  };
  const ctx = await readyPrRun(gh);
  withBlockerOn(ctx.store, "NBF-1", "nbf-1-fit");
  const finished = ctx.store.get();
  ctx.store.set({ ...finished, entries: finished.entries.map((entry) => ({ ...entry, phase: "running" })) });
  asked.length = 0;
  const before = ctx.store.get();
  ctx.pool.retargetStacked();
  assert.deepEqual(asked, [], "no pull request of a run that is not finished is read");
  assert.equal(ctx.store.get(), before, "and the queue is not written: the same object comes back");
});
