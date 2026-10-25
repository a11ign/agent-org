// no-token: none -- herdr is a recording fake (a `run` seam, or a `herdr` program on a temporary PATH); nothing reaches a real herdr, `gh` or a Claude process
//
// A11-241: EVERY `herdr agent <verb> <name>` CALL ADDRESSES THE AGENT BY `herdrAgentName(label)`, not by its label. Each case below drives one call site through its own seam with a seat whose label is over
// 32 characters (a keyed worker, `worker-announcement-emulator-1000`), and asserts the argument herdr was given is the shortened name. A call that went back to the full label fails its case: herdr would
// answer `invalid_agent_name` to it. (A label herdr already accepts is unchanged by the function, so the suite's other tests could not tell the two apart.)
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ACCOUNT_LIMIT_FLAG } from "./account-limit.ts";
import { restartNotices } from "./claim-stall.ts";
import { type ClaimFacts, type Reading } from "./claim-stall/stall-causes-and-claim-readings.ts";
import { SHADOW_COPY_MARKER, SHADOW_STATE_DIR_ENV } from "./host-config.ts";
import { herdrAgentName, HERDR_AGENT_NAME } from "./herdr-agents.ts";
import { promptWithContext } from "./prompt-session.ts";
import { emptyCanaryState } from "./org-health/fleet-build-readings.ts";
import { withMachineryFlag } from "./org-health.ts";
import { tellBlocked } from "./worker-state.ts";
import { tidyRoster } from "./work-tick.ts";
import { clearContext, promptTarget, readAgent } from "./wake/fyi-queue.ts";
import { assistantTimestamps, performRelease } from "./wake/ci-class-and-spares.ts";
import { substituteCodeHost } from "./plugins/active.ts";
import { createFakeCodeHost } from "./plugins/fakes/code-host.ts";
import { fakeRow } from "./plugins/fakes/code-host-rows.ts";
import { REPO as TRACKER } from "./project-identity.ts";
import { freeLimitMenuSeats, paneReader, sessionAllowance } from "./wake/exit-and-limits.ts";
import { outsidePaneReader } from "./wake/fyi-delivery-and-limits.ts";

const LONG = "worker-announcement-emulator-1000";
const SHORT = herdrAgentName(LONG);

/** A herdr that records each call and answers `answers[verb]` (default `{}`), as the `run` seam of the org's wake. */
function recorder(answers: Record<string, string> = {}) {
  const calls: string[][] = [];
  const run = (args: string[]): string => {
    calls.push(args);
    const verb = args[args.indexOf("agent") + 1];
    return answers[verb] ?? "{}";
  };
  /** The name each call of `verb` addressed, the argument after the verb. */
  const named = (verb: string) => calls.filter((args) => args[args.indexOf("agent") + 1] === verb).map((args) => args[args.indexOf("agent") + 2]);
  return { run, calls, named };
}

const IDLE = JSON.stringify({ result: { agent: { agent_status: "idle", interactive_ready: true } } });

test("the long label is one herdr rejects and the shortened name is one it takes", () => {
  assert.ok(LONG.length > 32);
  assert.match(SHORT, HERDR_AGENT_NAME);
});

test("A11-241: `agent prompt` of a delivered order (prompt-session promptWithContext) is addressed by the short name", () => {
  const herdr = recorder();
  promptWithContext(herdr.run, LONG, "an order", { sleep: () => {} });
  assert.ok(herdr.named("prompt").length > 0);
  assert.deepEqual([...new Set(herdr.named("prompt"))], [SHORT]);
});

test("A11-241: `agent prompt` and `agent wait` of a /clear (clearContext) are addressed by the short name", () => {
  const herdr = recorder();
  assert.equal(clearContext(herdr.run, LONG, () => {}), null);
  assert.deepEqual(herdr.named("prompt"), [SHORT]);
  assert.deepEqual(herdr.named("wait"), [SHORT]);
});

test("A11-241: `agent get` (readAgent) is addressed by the short name", () => {
  const herdr = recorder({ get: IDLE });
  assert.deepEqual(readAgent(herdr.run, LONG), { status: "idle", ready: true });
  assert.deepEqual(herdr.named("get"), [SHORT]);
});

test("A11-241: a started agent's order (promptTarget) is prompted, polled and sent its Enter by the short name", () => {
  const herdr = recorder({ get: IDLE });
  const why = promptTarget({ causeKey: "k", session: LONG, prompt: "p" }, { label: LONG, profile: { kind: "claude" } }, { run: herdr.run, sleep: () => {}, context: "kept" });
  assert.equal(typeof why, "string", "the agent never left idle, so the order is undelivered");
  for (const verb of ["prompt", "get", "send-keys"]) {
    assert.ok(herdr.named(verb).length > 0, `${verb} was called`);
    assert.deepEqual([...new Set(herdr.named(verb))], [SHORT], verb);
  }
});

test("A11-241: `agent get` of an allowance (sessionAllowance) and of a transcript (assistantTimestamps) is addressed by the short name", () => {
  const herdr = recorder();
  sessionAllowance(LONG, { run: herdr.run, home: "/nonexistent-home" });
  assistantTimestamps(LONG, { run: herdr.run, home: "/nonexistent-home" });
  assert.deepEqual(herdr.named("get"), [SHORT, SHORT]);
});

test("A11-241: `agent read` of a pane (paneReader, and the outside reviewer's outsidePaneReader) is addressed by the short name", () => {
  const herdr = recorder();
  paneReader(herdr.run)(LONG);
  outsidePaneReader(herdr.run)(LONG);
  assert.deepEqual(herdr.named("read"), [SHORT, SHORT]);
});

const madeDirs: string[] = [];
after(() => { for (const dir of madeDirs) rmSync(dir, { recursive: true, force: true }); });
function madeDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  madeDirs.push(dir);
  return dir;
}

const MENU = "What do you want to do?\n  1. Stop and wait for limit to reset\n  2. Wait here\n  3. Switch to usage credits";
const SESSION = "11111111-2222-3333-4444-555555555555";
const SAID = "You've hit your session limit · resets 11am (UTC)";
const WRITTEN = Date.parse("2026-10-13T08:00:00Z");
const PAST = Date.parse("2026-10-13T12:00:00Z");

test("A11-241: `agent get`, `agent read` and `agent send-keys` of a seat on the limit menu (freeLimitMenuSeats) are addressed by the short name", () => {
  const home = madeDir("long-name-home-");
  mkdirSync(join(home, ".claude", "projects", "proj"), { recursive: true });
  writeFileSync(join(home, ".claude", "projects", "proj", `${SESSION}.jsonl`),
    `${JSON.stringify({ type: "assistant", timestamp: new Date(WRITTEN).toISOString(), message: { content: SAID } })}\n`);
  const herdr = recorder({ get: JSON.stringify({ result: { agent: { agent: "claude", agent_session: { value: SESSION } } } }), read: MENU });
  const freed = freeLimitMenuSeats([{ label: LONG, status: "blocked" }], { run: herdr.run, home, now: PAST, say: () => {}, state: withMachineryFlag(emptyCanaryState(), { name: ACCOUNT_LIMIT_FLAG, on: true }) });
  assert.deepEqual(freed, [LONG], "the seat is freed, and still reported by its label");
  for (const verb of ["get", "read", "send-keys"]) assert.deepEqual([...new Set(herdr.named(verb))], [SHORT], verb);
});

const MOVING: Reading = { kind: "moving", lastMoveAt: 0 } as Reading;

test("A11-241: a restart notice finds the session herdr lists under the short name (restartNotices)", () => {
  const facts = { row: 4001, session: LONG, branch: "agent/x-4001", title: "row 4001" } as ClaimFacts;
  const listed = new Map([[SHORT, "bbb"]]);
  const noticed = restartNotices({ readings: [{ facts, reading: MOVING }], sessions: listed, acked: { [`${LONG}/4001`]: "aaa" }, delivered: () => false });
  assert.equal(noticed.orders.length, 1, "the new session id is found, so the restarted seat is told");
  const unlisted = restartNotices({ readings: [{ facts, reading: MOVING }], sessions: new Map([[LONG, "bbb"]]), acked: { [`${LONG}/4001`]: "aaa" }, delivered: () => false });
  assert.deepEqual(unlisted.orders, [], "a session listed under the full label is not the agent herdr named");
});

/** A `herdr` program on a temporary PATH that records its arguments, one call a line, and answers `{}` for all of them. */
function fakeHerdrOnPath() {
  const dir = madeDir("long-name-bin-");
  const log = join(dir, "calls.log");
  writeFileSync(join(dir, "herdr"), `#!/bin/sh\necho "$@" >> "${log}"\necho '{}'\n`);
  chmodSync(join(dir, "herdr"), 0o755);
  const before = process.env.PATH;
  process.env.PATH = `${dir}:${before}`;
  const calls = (): string[] => { try { return readFileSync(log, "utf8").trim().split("\n"); } catch { return []; } };
  return { calls, restore: () => { process.env.PATH = before; } };
}

test("A11-241: a blocked seat is told the declare-or-decide instruction, and its pane read, by the short name (work-tick's tidyRoster, worker-state's paneOf)", () => {
  const herdr = fakeHerdrOnPath();
  const state = madeDir("long-name-state-");
  // tidyRoster keeps its told-once memory in the state directory: a shadow copy stands in for it, so no run reads or writes the real one.
  writeFileSync(join(state, SHADOW_COPY_MARKER), "");
  const shadow = process.env[SHADOW_STATE_DIR_ENV];
  process.env[SHADOW_STATE_DIR_ENV] = state;
  try {
    tellBlocked({ roster: [{ label: LONG, status: "blocked" }], path: join(state, "told.json"), send: () => {} });
    assert.ok(herdr.calls().some((line) => line === `--session org agent read ${SHORT} --source recent --lines 40`), herdr.calls().join("\n"));
    assert.ok(herdr.calls().every((line) => !line.includes(` ${LONG} `)), "no call names the long label");
    const before = herdr.calls().length;
    mkdirSync(join(state, "ledger"), { recursive: true });
    const meter = { phase: (_name: string, f: () => unknown) => f() } as never;
    try { tidyRoster([{ label: LONG, status: "blocked" }], join(state, "ledger", "l.jsonl"), meter); } catch { /* the tear-downs after the tell need a project; only the tell is read */ }
    const sent = herdr.calls().slice(before).filter((line) => line.includes("agent prompt"));
    assert.ok(sent.length > 0 && sent.every((line) => line.startsWith(`--session org agent prompt ${SHORT} `)), herdr.calls().slice(before).join("\n"));
  } finally {
    herdr.restore();
    if (shadow === undefined) delete process.env[SHADOW_STATE_DIR_ENV];
    else process.env[SHADOW_STATE_DIR_ENV] = shadow;
  }
});

test("A11-241: the Escape that stops a closed row's instance (performRelease, interruptHolder) is sent by the short name", () => {
  const NOW = Date.parse("2026-10-04T19:33:00Z");
  const repo = "/home/agent/repos/a11y-witness";
  const runs: string[][] = [];
  const host = createFakeCodeHost();
  host.rowsWorld.repo = TRACKER;
  host.rowsWorld.rows.set(3535, fakeRow(host.rowsWorld, 3535, { state: "CLOSED", labels: ["in-progress", "started", `session:${LONG}`] }));
  substituteCodeHost(host);
  const deps = {
    run: (args: string[]) => { runs.push(args); return ""; },
    exec: () => ({ status: 0, output: "DECLINED -- #3535 is unclaimed again (closed: nothing restored)\n" }),
    io: { git: (_d: string, args: string[]) => (args[0] === "rev-list" ? { status: 0, out: "2\n" } : args[0] === "status" ? { status: 0, out: " M a.mjs\n" } : { status: 0, out: "" }),
      exists: () => true, mtime: () => NOW - 60_000, cloneOf: () => ({ clone: repo }) },
    now: NOW, agents: [{ label: LONG, status: "working" }], isSpare: () => true,
    host: { worktreesDir: "/home/agent/repos", primary: repo, exists: () => true }, env: {}, warn: () => {},
    gh: () => { throw new Error("the fake code host acts on its own state: no gh is run"); },
    cycle: () => {}, dropInstance: () => ({ spawnedAt: 1, rows: [3535] }), keepInstance: (_r: string, row: number) => ({ spawnedAt: 1, rows: [row] }), remember: () => {},
  };
  const got = performRelease({ row: 3535, session: LONG, why: "closed", branch: "agent/a-closed-row-ends-3535", worktree: "/home/agent/repos/wt-3535", idleMinutes: null, nudgedAt: null, interrupt: true } as never, deps as never);
  assert.equal(got.released, true, JSON.stringify(got));
  assert.deepEqual(runs.filter((args) => args.includes("send-keys")), [["--session", "org", "agent", "send-keys", SHORT, "esc"]]);
});
