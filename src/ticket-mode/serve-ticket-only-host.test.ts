// no-token: gh -- every child runs `ticket:serve` against a fake herdr on PATH and a key file; nothing reaches GitHub, Linear or the real herdr
/**
 * (agent-org#1723) A HOST FILE WITH ONLY `clones` AND `tickets` MUST START `ticket:serve`.
 *
 * The first tests run the real entry (`server.ts`) in a child process, so the module graph loads exactly as `agent-org ticket:serve` loads it.
 * Before the fix, `reviewer-port.ts` resolved the org's `primary` project at import, and a host without one crashed with a stack.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpDir } from "../lib/tmp-fixture.ts";
import { HOST_FILE_ENV, readTicketSettings } from "./settings.ts";
import { createBoard } from "./server.ts";
import { herdrName } from "./pool.ts";
import type { Ticket, TicketSource } from "./source.ts";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const SERVER = realpathSync(join(HERE, "server.ts"));
const REVIEWER_PORT = realpathSync(join(HERE, "reviewer-port.ts"));
const PROJECT = join(HERE, "..", "packaging", "fixtures", "row-claim-file-overlap-rule", "project");
const STARTED = "ticket mode instance: 127.0.0.1:";
const WAIT_MS = 30_000;

/** A port nothing listens on now: listen on 0, read it, close. */
async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((done) => probe.listen(0, "127.0.0.1", done));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((done) => probe.close(() => done()));
  return port;
}

/** A herdr that answers every call with an empty session, so nothing real is touched: the real one is at ~/.local/bin/herdr. */
function fakeHerdr(root: string): string {
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "herdr"), "#!/bin/sh\necho '{\"result\":{\"workspaces\":[],\"agents\":[]}}'\n");
  chmodSync(join(bin, "herdr"), 0o755);
  return bin;
}

/** A host file in `root` holding `host` plus what `ticket:serve` must have: a key file, a state dir and free ports. */
async function hostFile(root: string, host: Record<string, unknown>, tickets: Record<string, unknown> = {}): Promise<string> {
  const keyPath = join(root, "linear.key");
  writeFileSync(keyPath, "lin_api_test\n");
  const path = join(root, "host.json");
  writeFileSync(path, JSON.stringify({
    ...host,
    clones: { demo: join(root, "demo") },
    stateDir: join(root, "state"),
    tickets: { port: await freePort(), uiPort: await freePort(), linearKey: { path: keyPath }, ...tickets },
  }));
  return path;
}

/** A host file with `primary` and a project, the positive control: the same entry must start on it too. */
function primaryHost(root: string): Record<string, unknown> {
  const checkout = join(root, "project");
  cpSync(PROJECT, checkout, { recursive: true });
  return { schema: 1, home: root, binDir: join(root, "bin"), primary: "fixture", projects: [{ id: "fixture", checkout }], gh: { workers: join(root, "workers"), leads: join(root, "leads"), leadsHeader: [], leadsWorkspaces: [] } };
}

/** `ticket:serve` on a fresh host file in its own folder, with `tickets` added to the block, and its outcome. */
async function serveFreshHost(prefix: string, tickets?: Record<string, unknown>): Promise<Outcome> {
  const root = tmpDir(prefix);
  const host = await hostFile(root, {}, tickets);
  return runServe(host, root);
}

/** A host file with a primary, and a module run under it with a recorder of the gate's loads: the run's outcome and the recorder. */
async function runWithPrimaryHost(prefix: string, code: string): Promise<{ outcome: Awaited<ReturnType<typeof runModule>>; recorder: ReturnType<typeof loadRecorder> }> {
  const root = tmpDir(prefix);
  const host = await hostFile(root, primaryHost(root));
  const recorder = loadRecorder(root);
  const outcome = await runModule(code, root, host, recorder.preload);
  return { outcome, recorder };
}

/** The gate's modules, by their place under `src/`: the ones `reviewer-port.ts` loads, and nothing else loads them. */
// The gate's modules: `wake.ts` is loaded through the four files of its directory the reviewer loader imports.
const GATE_FILES = ["wake/ensure-reviewer-token.ts", "wake/ci-class-and-spares.ts", "wake/pull-request-spawn-orders.ts", "wake/seat-reset.ts", "review-trust.ts", "project-config.ts", "project-identity.ts", "work-gate/pr-orders.ts"];

/**
 * A module loaded before the entry, which writes each gate module it resolves to `loads.txt` under `root`. The module itself is not changed: the
 * hook only records what the process asks for, so a load the entry never makes leaves nothing there.
 */
function loadRecorder(root: string): { preload: string; loads: string } {
  const preload = join(root, "record-loads.mjs");
  const loads = join(root, "loads.txt");
  writeFileSync(preload, `import { registerHooks } from "node:module";
import { appendFileSync } from "node:fs";
const GATE = ${JSON.stringify(GATE_FILES.map((file) => `/src/${file}`))};
registerHooks({ resolve(specifier, context, nextResolve) {
  const resolved = nextResolve(specifier, context);
  if (GATE.some((suffix) => resolved.url.endsWith(suffix))) appendFileSync(${JSON.stringify(loads)}, resolved.url + "\\n");
  return resolved;
} });
`);
  return { preload, loads };
}

/** The gate's modules a recorded run loaded, by their place under `src/`, each once. None when nothing was loaded. */
function gateLoads(loads: string): string[] {
  if (!existsSync(loads)) return [];
  const urls = new Set(readFileSync(loads, "utf8").split("\n").filter((line) => line !== ""));
  return [...urls].map((url) => url.slice(url.indexOf("/src/") + "/src/".length)).sort();
}

type Outcome = { code: number | null; stdout: string; stderr: string; started: boolean };

/**
 * Runs `ticket:serve` as the CLI does and waits for it to start (then stops it) or to exit. `host` null leaves `AGENT_ORG_HOST` unset. `options.home` is
 * HOME, and `options.preload` a module loaded before the entry. Refuses after a timeout, so a hang fails the test.
 */
function runServe(host: string | null, root: string, options: { home?: string; preload?: string } = {}): Promise<Outcome> {
  const childEnv: Record<string, string | undefined> = { ...process.env, HOME: options.home ?? process.env.HOME ?? root, PATH: `${fakeHerdr(root)}:${process.env.PATH}` };
  if (host === null) delete childEnv[HOST_FILE_ENV];
  else childEnv[HOST_FILE_ENV] = host;
  const args = [...(options.preload === undefined ? [] : ["--import", pathToFileURL(options.preload).href]), SERVER];
  const child: ChildProcess = spawn(process.execPath, args, { env: childEnv, cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk) => { stdout += chunk; });
  child.stderr?.on("data", (chunk) => { stderr += chunk; });
  return new Promise((done, fail) => {
    const timer = setTimeout(() => { child.kill("SIGKILL"); fail(new Error(`ticket:serve neither started nor exited in ${WAIT_MS} ms: ${stderr}`)); }, WAIT_MS);
    const finish = (outcome: Outcome) => { clearTimeout(timer); done(outcome); };
    child.on("exit", (code) => finish({ code, stdout, stderr, started: stdout.includes(STARTED) }));
    const poll = setInterval(() => {
      if (!stdout.includes(STARTED)) return;
      clearInterval(poll);
      child.kill("SIGTERM");
    }, 50);
    child.on("exit", () => clearInterval(poll));
  });
}

/** A stack trace: a frame line `    at ...` in the output. */
const STACK = /\n\s+at /;

test("ticket:serve starts on a host file with only clones and tickets, and no tickets.reviewer", async () => {
  const outcome = await serveFreshHost("serve-ticket-only-");
  assert.equal(outcome.started, true, outcome.stderr);
  assert.doesNotMatch(outcome.stderr, STACK);
  assert.doesNotMatch(outcome.stderr, /ProjectDeclarationRefusal/);
});

test("A11-94: ticket:serve starts on a ticket-only host that names tickets.writer, and no project is needed for the writer", async () => {
  const outcome = await serveFreshHost("serve-ticket-writer-start-", WRITER_HOST);
  assert.equal(outcome.started, true, outcome.stderr);
  assert.doesNotMatch(outcome.stderr, STACK);
  assert.doesNotMatch(outcome.stderr, /ProjectDeclarationRefusal/);
});

test("ticket:serve on the same entry with a host file that has primary also starts (the positive control)", async () => {
  const root = tmpDir("serve-with-primary-");
  const host = await hostFile(root, primaryHost(root));
  const outcome = await runServe(host, root);
  assert.equal(outcome.started, true, outcome.stderr);
  assert.doesNotMatch(outcome.stderr, STACK);
});

test("ticket:serve with tickets.reviewer set on a host file with only clones and tickets either starts or exits 2 naming the missing field, never a stack from import", async () => {
  const root = tmpDir("serve-reviewer-no-primary-");
  const host = await hostFile(root, {}, { reviewer: "atomic", drafts: false });
  const outcome = await runServe(host, root);
  assert.doesNotMatch(outcome.stderr, STACK);
  if (outcome.code === 2) {
    assert.match(outcome.stderr, /primary/);
  } else {
    assert.equal(outcome.started, true, outcome.stderr);
    assert.match(outcome.stderr, /tickets\.reviewer is set, but no reviewer starts: .*primary/);
  }
});

/** Runs `code` as an ES module in a child with `AGENT_ORG_HOST` set to `host`, after `preload` if given. */
function runModule(code: string, root: string, host: string, preload?: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const args = [...(preload === undefined ? [] : ["--import", pathToFileURL(preload).href]), "--input-type=module", "-e", code];
  return new Promise((done) => {
    const child = spawn(process.execPath, args, { env: { ...process.env, AGENT_ORG_HOST: host }, cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("exit", (exitCode) => done({ code: exitCode, stdout, stderr }));
  });
}

const PORT_URL = JSON.stringify(pathToFileURL(REVIEWER_PORT).href);

test("loading the gate on a host with no primary keeps its refusal: reviewerRefusal names primary, and nothing throws", async () => {
  const root = tmpDir("serve-import-no-primary-");
  const host = await hostFile(root, {}, { reviewer: "atomic", drafts: false });
  const outcome = await runModule(`const port = await import(${PORT_URL}); await port.loadReviewerGate(); process.stdout.write("refusal: " + port.reviewerRefusal() + "\\n");`, root, host);
  assert.equal(outcome.code, 0, outcome.stderr);
  assert.match(outcome.stdout, /^refusal: .*primary/m);
  assert.doesNotMatch(outcome.stderr, /ProjectDeclarationRefusal/);
});

test("importing reviewer-port.ts loads none of the gate's modules, even on a host with primary", async () => {
  const { outcome, recorder } = await runWithPrimaryHost("serve-import-loads-", `await import(${PORT_URL});`);
  assert.equal(outcome.code, 0, outcome.stderr);
  assert.deepEqual(gateLoads(recorder.loads), [], "no gate module is loaded at import");
});

test("loading the gate loads all of its modules, which is what a machine that starts reviewers does before its pool is made", async () => {
  const { outcome, recorder } = await runWithPrimaryHost("serve-gate-loads-", `const port = await import(${PORT_URL}); await port.loadReviewerGate();`);
  assert.equal(outcome.code, 0, outcome.stderr);
  assert.deepEqual(gateLoads(recorder.loads), [...GATE_FILES].sort(), "every gate module is loaded once the gate is asked for");
});

test("ticket:serve on a host with primary and no tickets.reviewer loads none of the gate's modules", async () => {
  const root = tmpDir("serve-no-reviewer-loads-");
  const host = await hostFile(root, primaryHost(root));
  const recorder = loadRecorder(root);
  const outcome = await runServe(host, root, { preload: recorder.preload });
  assert.equal(outcome.started, true, outcome.stderr);
  assert.deepEqual(gateLoads(recorder.loads), [], "an instance that starts no reviewer never loads the gate");
});

test("ticket:serve with tickets.reviewer on and drafts off loads the gate's modules before it starts", async () => {
  const root = tmpDir("serve-reviewer-loads-");
  const host = await hostFile(root, primaryHost(root), { reviewer: "atomic", drafts: false });
  const recorder = loadRecorder(root);
  const outcome = await runServe(host, root, { preload: recorder.preload });
  assert.equal(outcome.started, true, outcome.stderr);
  assert.deepEqual(gateLoads(recorder.loads), [...GATE_FILES].sort(), "an instance that starts reviewers loads the gate");
});

test("ticket:serve with AGENT_ORG_HOST unset reads ~/.agent-org/host.json and starts on it", async () => {
  const home = tmpDir("serve-home-");
  const root = tmpDir("serve-home-state-");
  mkdirSync(join(home, ".agent-org"), { recursive: true });
  const host = await hostFile(root, {});
  writeFileSync(join(home, ".agent-org", "host.json"), readFileSync(host, "utf8"));
  const outcome = await runServe(null, root, { home });
  assert.equal(outcome.started, true, outcome.stderr);
  assert.doesNotMatch(outcome.stderr, STACK);
});

/*
 * A NEW TICKET ON A TICKET-ONLY HOST (A11-94). A host file with only `clones` and `tickets`, naming `tickets.writer`, runs the whole path: a request, a
 * writer run that leaves a draft, the person's approval, and the queue. The tracker and herdr are fakes; the board and its pool are the real ones.
 */

const WRITER_HOST = { writer: { run: "Run the a11ign:create-ticket skill, quick, for this request: {request}. Write each draft under {dir}/drafts." } };

/** Resolves once `ready` holds, polling the pool's background work; fails the test when it does not hold in time. */
async function waitFor(ready: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    if (ready()) return;
    await new Promise((done) => setTimeout(done, 10));
  }
  assert.fail("the background work did not finish");
}

/** A herdr that lists each label's workspace with its status, as the pool's tests read it, and opens a workspace for each start. */
function herdrWith(status: Map<string, string>) {
  let next = 0;
  return (args: string[]): string => {
    if (args.includes("create")) {
      next += 1;
      return JSON.stringify({ result: { root_pane: { pane_id: `w${next}:p1` }, workspace: { workspace_id: `w${next}` } } });
    }
    if (args.includes("agent") && args.includes("list")) {
      return JSON.stringify({ result: { agents: [...status].map(([label]) => ({ name: null, workspace_id: `w${label.replace(/\D/g, "")}`, agent_session: { value: `session-${label}` } })) } });
    }
    if (args.includes("list")) return JSON.stringify({ result: { workspaces: [...status].map(([label, s]) => ({ label, agent_status: s })) } });
    return JSON.stringify({ type: "ok" });
  };
}

test("on a ticket-only host, a new-ticket request runs the writer, its draft waits for approval, and approving it creates and queues the ticket", async () => {
  const root = tmpDir("serve-ticket-writer-");
  const keyPath = join(root, "linear.key");
  writeFileSync(keyPath, "lin_api_test\n");
  const hostPath = join(root, "host.json");
  writeFileSync(hostPath, JSON.stringify({ clones: { demo: join(root, "demo") }, stateDir: join(root, "state"),
    tickets: { linearKey: { path: keyPath }, ...WRITER_HOST } }));
  const settings = readTicketSettings({ [HOST_FILE_ENV]: hostPath });
  assert.equal(settings.writer?.model, "opus", "the writer's defaults, on a host that names no more");
  const created: string[] = [];
  const source: TicketSource = {
    assigned: async () => [],
    read: async () => null,
    download: async () => [],
    createTicket: async (input) => {
      created.push(input.title);
      return { ticket: { key: "NBF-101", title: input.title, description: input.description, url: "https://linear.app/x/NBF-101", branch: "nbf-101", status: "Backlog",
        statusOrder: 0, team: "NBF", project: null, priority: input.priority, parent: null } as Ticket, warnings: [] };
    },
  };
  const status = new Map<string, string>();
  const board = createBoard({ settings, source, key: "k".repeat(48), queuePath: join(root, "state", "tickets", "queue.json"), choicePath: join(root, "state", "tickets", "choice.json"),
    poolDeps: { herdr: herdrWith(status), wait: async () => {}, now: () => 100, load: () => ({ load: 1, cores: 14 }), transcriptsRoot: join(root, "transcripts"),
      pluginRecord: join(root, "no-plugin-record.json"), hostFile: hostPath } });
  const [, asked] = await board.api("POST", "/api/writer", { request: "Show the requests a person made" }) as [number, any];
  const id = asked.runs[0].id as string;
  assert.equal(asked.runs[0].status, "queued");
  // The request woke the pool, which starts the run in the background; a tick that finds the pool busy returns at once, so the start is waited for.
  await waitFor(() => board.store.get().writers?.[0].phase === "running");
  const label = herdrName(`writer-${id}`);
  assert.equal(board.store.get().writers?.[0].phase, "running", "the writer started on the ticket-only host");
  const dir = join(root, "state", "tickets", "writer", id);
  assert.match(readFileSync(join(dir, "brief.md"), "utf8"), /for this request: Show the requests a person made\. Write each draft under/);
  mkdirSync(join(dir, "drafts"), { recursive: true });
  writeFileSync(join(dir, "drafts", "01-show.json"), JSON.stringify({ title: "feat: show requests", why: "A person asks", doneWhen: ["It lists them"] }));
  writeFileSync(join(dir, "outcome.json"), JSON.stringify({ kind: "drafted" }));
  status.set(label, "idle");
  await board.pool.tick();
  await waitFor(() => board.store.get().writers?.[0].phase === "finished");
  const [, ready] = await board.api("GET", "/api/writer", {}) as [number, any];
  assert.deepEqual([ready.runs[0].status, ready.runs[0].drafts[0].status], ["to-review", "pending"]);
  assert.equal(created.length, 0, "a draft a person has not approved creates nothing");
  assert.equal(board.store.get().entries.length, 0, "and queues nothing");
  const draftId = ready.runs[0].drafts[0].id as string;
  const [, approved] = await board.api("POST", `/api/writer/${id}/drafts/${draftId}/approve`, { draft: { title: "feat: show requests", why: "A person asks", doneWhen: ["It lists them"] }, queue: true }) as [number, any];
  assert.deepEqual(created, ["feat: show requests"]);
  assert.equal(approved.created.key, "NBF-101");
  assert.deepEqual(board.store.get().entries.map((e) => e.ticket.key), ["NBF-101"], "approved and queued, on the ticket-only host");
});
