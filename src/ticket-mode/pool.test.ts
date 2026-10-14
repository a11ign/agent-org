// no-token: gh -- herdr, git, Linear and the clock are all injected; nothing is spawned
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "../lib/tmp-fixture.ts";
import { runStatus } from "./board-view.ts";
import { countTokens, createPool, findTranscript, herdrName, isStartDialog, parseOutcome, ticketDir, ticketFolder, worktreesIn } from "./pool.ts";
import { emptyQueue, enqueue, finish, retry, setPaused, type Queue } from "./queue.ts";
import { parseTicketSettings } from "./settings.ts";
import type { Ticket, TicketSource } from "./source.ts";

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
  { source: tracker = source, parents = {}, planFirst = [] }: { source?: TicketSource; parents?: Record<string, string>; planFirst?: string[] } = {}) {
  const root = tmpDir("ticket-pool-");
  const settings = parseTicketSettings({ clones: { "nbl-ui-netbox": "/repos/nbl-ui-netbox", "nbl-ui-platform-libs": "/repos/libs" }, stateDir: join(root, "state"), tickets });
  const queued = keys.map((key) => (key in parents ? { ...ticket(key), parent: parents[key] } : ticket(key)));
  const plan = planFirst.length === 0 ? null : { keys: new Set(planFirst), choice: { model: "opus", effort: "max" } };
  let queue: Queue = setPaused(enqueue(emptyQueue(max), queued, { model: "sonnet", effort: "high" }, 0, plan), false);
  const store = { get: () => queue, set: (next: Queue) => { queue = next; } };
  const status = new Map<string, string>();
  const screen = { text: "" };
  const h = herdr(status, screen);
  const pool = createPool(store, { settings, source: tracker, hook: { node: "/node", bin: "/tool/src/bin.ts" }, herdr: h.run, hostFile: "/work/.agent-org/host.json", now: () => 100, load: () => ({ load: 1, cores: 14 }), transcriptsRoot: join(root, "transcripts"), wait: async () => {} });
  const entry = (key: string) => queue.entries.find((e) => e.ticket.key === key)!;
  return { settings, pool, status, h, entry, store, root, screen };
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
  let queue: Queue = setPaused(enqueue(emptyQueue(1), [ticket("NBF-1")], { model: "sonnet", effort: "high" }, 0), false);
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
  store.set(setPaused(store.get(), true));
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
async function endedOn(outcome: Record<string, unknown> | null, max = 1, keys = ["NBF-1"]) {
  const made = setup(max, keys);
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
  const written: string[] = [];
  const write = process.stderr.write;
  process.stderr.write = ((chunk: string) => { written.push(String(chunk)); return true; }) as typeof process.stderr.write;
  try {
    const made = setup(1, ["NBF-1"], PLANNER, { source: tracker, planFirst: ["NBF-1"] });
    await plannedRun(made);
    await settled();
    assert.deepEqual([made.entry("NBF-1").plan, made.entry("NBF-1").planned], [undefined, true]);
  } finally {
    process.stderr.write = write;
  }
  assert.ok(written.includes("ticket:serve: NBF-1's team has no state named Planned, so it stays in Todo\n"));
});
