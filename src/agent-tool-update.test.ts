// no-token: none -- the install, the version reads, the herdr calls and the clock are injected; nothing reaches the network, `gh`, herdr or the host's real tools.
//
// agent-org#462 (epic #4437, class `tool-drift-interactive-prompt`): ONE OWNED UPDATER. Run from this checkout:
// `npx rstest run --config scripts/rstest/rstest.config.* src/agent-tool-update.test.ts`.
//
// The cases that carry the row's Acceptance are 1-5; each states its control beside it so a mutant that keeps everything, reverts everything or touches everything is killed
// by a case that expects the opposite. The live seams (`hostSeams`) are driven against a scratch home and a fake herdr: a fake answers any argv, so each case reads the calls.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexClientDaemonDrift } from "./codex-drift.ts";
import { COMMANDS } from "./commands.ts";
import { parseFailureLedger, recordFailures, type FailureEvent } from "./failure-ledger.ts";
import { TOOL_DRIFT_KIND, hostSeams, judgeSmoke, plainDialogOnScreen, productOfSeat, toolsHeldBy, updateAgentTools, type Deps, type Options, type SmokeKind, type SmokeRaw, type Tool, type Versions } from "./agent-tool-update.ts";

const OLD: Versions = { "codex-cli": "0.157.0", "codex-daemon": "0.162.1", "claude-code": "2.1.296" };
const NEW = { "codex-cli": "0.162.1", "codex-daemon": "0.162.1", "claude-code": "2.1.296" } as const;
const PROMPT = "OpenAI Codex\n\n› Ask Codex to do anything\n\n  ? for shortcuts";
const TRUST = "Do you trust the files in this folder?\n\n  1. Yes, proceed\n  2. No, exit";

type Log = { moves: string[], reverts: string[], smokes: SmokeKind[], recorded: FailureEvent[][], sleeps: number[] };

/**
 * A host in which `installed` is a mutable record the fake installer and the fake revert write, so a read-back reads what the calls did. `behaviour` overrides each road.
 * `working` is a list per call (the last one repeats), so a seat can finish between two polls.
 */
function host({ start = OLD, target = NEW, working = [[]], screens = {}, moveBehaviour = {}, revertBehaviour = {}, ledger = undefined, clock = 0 }: {
  start?: Versions, target?: Partial<Record<Tool, string>>, working?: (string[] | null)[], screens?: Partial<Record<SmokeKind, SmokeRaw>>,
  moveBehaviour?: Partial<Record<Tool, "throws" | "no-effect">>, revertBehaviour?: Partial<Record<Tool, "throws" | "no-effect">>,
  ledger?: string, clock?: number,
} = {}) {
  const versions: Versions = { ...start };
  const log: Log = { moves: [], reverts: [], smokes: [], recorded: [], sleeps: [] };
  let polls = 0;
  let now = clock;
  const deps: Deps = {
    installed: () => ({ ...versions }),
    targets: () => ({ ...target }),
    working: () => working[Math.min(polls++, working.length - 1)],
    pinDaemon: (apply) => (apply ? "switched off" : "ON"),
    move: (tool, to) => {
      log.moves.push(`${tool}->${to}`);
      if (moveBehaviour[tool] === "throws") throw new Error(`${tool} installer exited 1`);
      if (moveBehaviour[tool] !== "no-effect") versions[tool] = to;
    },
    revert: (tool, to) => {
      log.reverts.push(`${tool}->${to}`);
      if (revertBehaviour[tool] === "throws") throw new Error(`no release directory for ${to}`);
      if (revertBehaviour[tool] !== "no-effect") versions[tool] = to;
    },
    smoke: (kind) => {
      log.smokes.push(kind);
      return screens[kind] ?? { opened: true, started: true, pane: PROMPT };
    },
    dialogOf: () => null,
    record: (events) => {
      log.recorded.push(events);
      return ledger === undefined
        ? { appended: events.length, skipped: 0, refused: null }
        : recordFailures({ logPath: ledger, events, now: 1_791_700_000_000, report: () => {} });
    },
    now: () => now,
    sleep: (ms) => { log.sleeps.push(ms); now += ms; },
  };
  return { deps, versions, log };
}
const run = (h: ReturnType<typeof host>, options: Options = {}) => updateAgentTools(h.deps, options);

// (1) A MOVE WHOSE SMOKE START REACHES THE PROMPT IS KEPT. Control: the same move with a dialog is case (2).
test("a move whose smoke start reaches the prompt is kept: nothing reverted, nothing recorded, exit 0", () => {
  const h = host();
  const result = run(h);
  assert.equal(result.outcome, "kept");
  assert.equal(result.exitCode, 0);
  assert.deepEqual(h.log.moves, ["codex-cli->0.162.1"], "only the tool that was behind is moved");
  assert.deepEqual(h.log.smokes, ["reviewer", "worker"], "both products are smoke-started after the move");
  assert.deepEqual(h.log.reverts, []);
  assert.deepEqual(h.log.recorded, []);
  assert.equal(h.versions["codex-cli"], "0.162.1");
  assert.match(result.line, /moved codex-cli 0\.157\.0->0\.162\.1; smoke start ok \(reviewer ok, worker ok\), kept/);
  assert.doesNotMatch(result.line, /\n/, "one line");
});

// (2) A MOVE WHOSE SMOKE START SHOWS A DIALOG IS REVERTED AND ONE INCIDENT IS RECORDED NAMING BOTH VERSIONS. The negative control is (1): the same host with a clean screen.
test("NEGATIVE CONTROL: a move whose smoke start shows a dialog is reverted and records ONE tool-drift-interactive-prompt incident naming both versions and the pane", () => {
  const h = host({ screens: { reviewer: { opened: true, started: true, pane: TRUST } } });
  const result = updateAgentTools({ ...h.deps, dialogOf: plainDialogOnScreen }, {});
  assert.equal(result.outcome, "reverted");
  assert.equal(result.exitCode, 1);
  assert.deepEqual(h.log.reverts, ["codex-cli->0.157.0"], "what was moved is put back, and only that");
  assert.equal(h.versions["codex-cli"], "0.157.0", "the revert took");
  assert.equal(h.log.recorded.length, 1);
  assert.equal(h.log.recorded[0].length, 1, "ONE incident for the one smoke that failed (the worker's passed)");
  const [event] = h.log.recorded[0];
  assert.equal(event.classKey, TOOL_DRIFT_KIND);
  assert.match(event.ref, /codex-cli 0\.157\.0->0\.162\.1/);
  assert.match(event.ref, /codex-daemon 0\.162\.1->0\.162\.1/);
  assert.match(event.ref, /Do you trust the files in this folder/, "the pane text is in the incident");
  assert.doesNotMatch(event.ref, /[\t\n]/, "a ref the ledger will accept");
  assert.match(result.line, /REVERTED codex-cli 0\.162\.1->0\.157\.0, read back ok/);
  assert.match(result.line, /1 tool-drift-interactive-prompt incident recorded/);
});

test("the incident is a real ledger line: written, parseable, and not written a second time for the same episode", () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-tool-update-"));
  try {
    const ledger = join(dir, "failure-ledger");
    const bad = { reviewer: { opened: true, started: true, pane: TRUST } } as const;
    const first = updateAgentTools({ ...host({ screens: bad, ledger }).deps, dialogOf: plainDialogOnScreen });
    assert.match(first.line, /1 tool-drift-interactive-prompt incident recorded/);
    const entries = parseFailureLedger(readFileSync(ledger, "utf8"));
    assert.equal(entries.length, 1);
    assert.equal(entries[0].classKey, TOOL_DRIFT_KIND);
    // the same episode again (same day, same versions, same screen) is one standing event
    updateAgentTools({ ...host({ screens: bad, ledger }).deps, dialogOf: plainDialogOnScreen });
    assert.equal(parseFailureLedger(readFileSync(ledger, "utf8")).length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a worker's dialog reverts the Claude tool and names Claude's versions, not Codex's", () => {
  const h = host({ start: { ...OLD, "claude-code": "2.1.296" }, target: { ...NEW, "claude-code": "2.1.297" },
    screens: { worker: { opened: true, started: true, pane: "Bypass permissions mode\n  1. No, exit\n  2. Yes, I accept" } } });
  const result = updateAgentTools({ ...h.deps, dialogOf: plainDialogOnScreen });
  assert.equal(result.outcome, "reverted");
  assert.deepEqual(h.log.reverts, ["claude-code->2.1.296", "codex-cli->0.157.0"], "every tool the run moved is put back, newest first, so the set stays one version-set");
  assert.equal(h.log.recorded[0].length, 1);
  assert.match(h.log.recorded[0][0].ref, /claude-code 2\.1\.296->2\.1\.297/);
  assert.doesNotMatch(h.log.recorded[0][0].ref, /codex-cli/);
});

// (3) A TOOL ALREADY AT ITS TARGET IS NOT TOUCHED.
test("a tool already at its target is not touched; with every tool at target nothing is moved, smoked or recorded", () => {
  const h = host({ start: { ...NEW } });
  const result = run(h);
  assert.equal(result.outcome, "at-target");
  assert.equal(result.exitCode, 0);
  assert.deepEqual([h.log.moves, h.log.reverts, h.log.smokes, h.log.recorded], [[], [], [], []]);
  assert.match(result.line, /already at target, nothing moved: codex-cli 0\.162\.1, codex-daemon 0\.162\.1, claude-code 2\.1\.296/);
  // the control: ONE tool behind moves ONE tool, so "at target" is read per tool and not for the whole set
  const partial = host({ start: { ...NEW, "claude-code": "2.1.290" }, target: { ...NEW, "claude-code": "2.1.296" } });
  run(partial);
  assert.deepEqual(partial.log.moves, ["claude-code->2.1.296"]);
});

// (4) A FAILURE TO REVERT IS REPORTED BY NAME, NOT AS SUCCESS.
test("a revert that throws is reported by tool name and is not success; the incident is still recorded", () => {
  const h = host({ screens: { reviewer: { opened: true, started: true, pane: TRUST } }, revertBehaviour: { "codex-cli": "throws" } });
  const result = updateAgentTools({ ...h.deps, dialogOf: plainDialogOnScreen });
  assert.equal(result.outcome, "revert-failed");
  assert.equal(result.exitCode, 1);
  assert.match(result.line, /REVERT FAILED, host left half-moved: codex-cli \(no release directory for 0\.157\.0\)/);
  assert.doesNotMatch(result.line, /read back ok/);
  assert.equal(h.versions["codex-cli"], "0.162.1", "the host really is half-moved, and the line says so");
  assert.equal(h.log.recorded[0].length, 1);
});

test("a revert that reports success but leaves the new version is caught by the read-back and named", () => {
  const h = host({ screens: { reviewer: { opened: true, started: true, pane: TRUST } }, revertBehaviour: { "codex-cli": "no-effect" } });
  const result = updateAgentTools({ ...h.deps, dialogOf: plainDialogOnScreen });
  assert.equal(result.outcome, "revert-failed");
  assert.match(result.line, /codex-cli reads 0\.162\.1, not 0\.157\.0/);
});

// (5) THE COMMAND REFUSES TO RUN WHILE A SEAT THAT RUNS A TOOL TO BE MOVED IS MID-TURN UNLESS TOLD WHICH SESSIONS TO LET FINISH (#665: a seat of the other product is not held).
test("a seat mid-turn that runs the tool being moved refuses at once, names it and the tools it holds for, and moves nothing", () => {
  const h = host({ working: [["reviewer-agent-org-601"]] });
  const result = run(h);
  assert.equal(result.outcome, "busy");
  assert.equal(result.exitCode, 1);
  assert.match(result.line, /REFUSED: reviewer-agent-org-601 \(runs codex, held for codex-cli\) is mid-turn and was not named in --let-finish; nothing was moved/);
  assert.deepEqual([h.log.moves, h.log.smokes, h.log.sleeps], [[], [], []]);
});

test("a seat named in --let-finish is WAITED FOR, then the move proceeds; the control is the same seat unnamed (above)", () => {
  const h = host({ working: [["reviewer-4799"], ["reviewer-4799"], []] });
  const result = run(h, { letFinish: ["reviewer-4799"], waitMs: 10 * 60_000, pollMs: 30_000 });
  assert.equal(result.outcome, "kept");
  assert.deepEqual(h.log.sleeps, [30_000, 30_000], "it polled until the seat finished");
  assert.deepEqual(h.log.moves, ["codex-cli->0.162.1"]);
});

test("a named seat that never finishes refuses after the bound, and a second, unnamed seat refuses at once", () => {
  const stuck = host({ working: [["reviewer-4799"]] });
  const result = run(stuck, { letFinish: ["reviewer-4799"], waitMs: 2 * 60_000, pollMs: 30_000 });
  assert.equal(result.outcome, "busy");
  assert.match(result.line, /reviewer-4799 still mid-turn after 2 min/);
  assert.deepEqual(stuck.log.moves, []);
  const two = host({ working: [["reviewer-4799", "reviewer-9"]] });
  const second = run(two, { letFinish: ["reviewer-4799"] });
  assert.match(second.line, /REFUSED: reviewer-9 \(runs codex, held for codex-cli\) is mid-turn/);
  assert.doesNotMatch(second.line, /reviewer-4799/, "only the unnamed seat is the refusal");
  assert.deepEqual(two.log.sleeps, [], "an unnamed seat is not waited for");
});

test("the caller's own session is not held on, and an unreadable listing HOLDS the move (unknown is not idle)", () => {
  const own = host({ working: [["reviewer-462"]] });
  assert.equal(run(own, { session: "reviewer-462" }).outcome, "kept");
  assert.equal(run(host({ working: [["reviewer-462"]] })).outcome, "busy", "control: the same seat is held when it is not the caller");
  const unread = host({ working: [null] });
  const result = run(unread);
  assert.equal(result.outcome, "busy");
  assert.match(result.line, /NOT READ: herdr's seat listing/);
  assert.deepEqual(unread.log.moves, []);
});

// #665: THE HOLD IS THE SEATS THAT RUN A TOOL THIS RUN MOVES. Each case states its control, so a mutant that holds everything or nothing is killed by the other.
const CODEX_ONLY = { start: OLD, target: NEW } as const;
const CLAUDE_ONLY = { start: OLD, target: { ...OLD, "claude-code": "2.1.297" } } as const;
const BOTH = { start: OLD, target: { ...NEW, "claude-code": "2.1.297" } } as const;

test("#665: only codex-cli to move and Claude seats mid-turn gives NO refusal, no wait, and the seat is not named", () => {
  for (const seat of ["worker-agent-org-665", "worker-1", "ceo", "orchestrator", "product-manager"]) {
    const h = host({ ...CODEX_ONLY, working: [[seat]] });
    const result = run(h);
    assert.equal(result.outcome, "kept", seat);
    assert.deepEqual(h.log.moves, ["codex-cli->0.162.1"], seat);
    assert.deepEqual(h.log.sleeps, [], `${seat} is not waited for`);
    assert.doesNotMatch(result.line, new RegExp(seat));
  }
  const control = run(host({ ...CODEX_ONLY, working: [["reviewer-1"]] }));
  assert.equal(control.outcome, "busy", "control: the same move is held by a reviewer");
});

test("#665: only claude-code to move and a reviewer mid-turn gives no refusal; the control is a worker, which is held", () => {
  for (const seat of ["reviewer-1", "reviewer-agent-org-601", "reviewer"]) {
    const h = host({ ...CLAUDE_ONLY, working: [[seat]] });
    const result = run(h);
    assert.equal(result.outcome, "kept", seat);
    assert.deepEqual(h.log.moves, ["claude-code->2.1.297"], seat);
    assert.deepEqual(h.log.sleeps, []);
  }
  const control = run(host({ ...CLAUDE_ONLY, working: [["worker-agent-org-665"]] }));
  assert.equal(control.outcome, "busy");
  assert.match(control.line, /REFUSED: worker-agent-org-665 \(runs claude, held for claude-code\) is mid-turn/);
});

test("#665: both products moving, either seat mid-turn refuses naming that seat, and both seats refuse naming both", () => {
  const reviewer = run(host({ ...BOTH, working: [["reviewer-2"]] }));
  assert.equal(reviewer.outcome, "busy");
  assert.match(reviewer.line, /REFUSED: reviewer-2 \(runs codex, held for codex-cli\) is mid-turn/);
  const worker = run(host({ ...BOTH, working: [["worker-3"]] }));
  assert.equal(worker.outcome, "busy");
  assert.match(worker.line, /REFUSED: worker-3 \(runs claude, held for claude-code\) is mid-turn/);
  const both = host({ ...BOTH, working: [["worker-3", "reviewer-2"]] });
  const refusal = run(both);
  assert.match(refusal.line, /worker-3 \(runs claude/);
  assert.match(refusal.line, /reviewer-2 \(runs codex/);
  assert.deepEqual(both.log.moves, []);
});

test("#665: a seat whose label matches neither rule is held for every tool being moved, whichever product moves, and says so", () => {
  for (const [name, move, tools] of [["codex", CODEX_ONLY, "codex-cli"], ["claude", CLAUDE_ONLY, "claude-code"], ["both", BOTH, "codex-cli, claude-code"]] as const) {
    for (const seat of ["mystery-seat", "smoke-reviewer-m1abc", "reviewerx"]) {
      const h = host({ ...move, working: [[seat]] });
      const result = run(h);
      assert.equal(result.outcome, "busy", `${name}: ${seat}`);
      assert.match(result.line, new RegExp(`REFUSED: ${seat} \\(product unknown, so held for ${tools}\\) is mid-turn`));
      assert.deepEqual(h.log.moves, []);
    }
  }
});

test("#665: a seat outside the hold set is not waited for while a named seat inside it is", () => {
  const h = host({ ...CODEX_ONLY, working: [["reviewer-1", "worker-1"], ["worker-1"]] });
  const result = run(h, { letFinish: ["reviewer-1"], waitMs: 10 * 60_000, pollMs: 30_000 });
  assert.equal(result.outcome, "kept");
  assert.deepEqual(h.log.sleeps, [30_000], "one poll, for the reviewer; the worker never kept it waiting");
  const still = host({ ...CODEX_ONLY, working: [["reviewer-1", "worker-1"]] });
  const bounded = run(still, { letFinish: ["reviewer-1"], waitMs: 60_000, pollMs: 30_000 });
  assert.equal(bounded.outcome, "busy");
  assert.match(bounded.line, /REFUSED: reviewer-1 still mid-turn/);
  assert.doesNotMatch(bounded.line, /worker-1/);
});

test("#665: productOfSeat is the one label-to-product rule, and a label matching neither rule has no product", () => {
  assert.equal(productOfSeat("reviewer-1"), "codex");
  assert.equal(productOfSeat("reviewer"), "codex");
  assert.equal(productOfSeat("worker-agent-org-665"), "claude");
  assert.equal(productOfSeat("ceo"), "claude");
  assert.equal(productOfSeat("smoke-reviewer-m1abc"), null);
  assert.equal(productOfSeat("reviewerx"), null);
  assert.equal(productOfSeat(""), null);
  assert.deepEqual(toolsHeldBy("reviewer-1", ["codex-cli", "codex-daemon", "claude-code"]), ["codex-cli", "codex-daemon"]);
  assert.deepEqual(toolsHeldBy("worker-1", ["codex-cli", "codex-daemon", "claude-code"]), ["claude-code"]);
  assert.deepEqual(toolsHeldBy("who", ["codex-daemon"]), ["codex-daemon"]);
});

// The roads the row does not name but a wrong revert would strand reviewers on.
test("an installer that exits 0 and leaves the old version is a failed move: reverted, no smoke, and no prompt-drift incident", () => {
  const h = host({ moveBehaviour: { "codex-cli": "no-effect" } });
  const result = run(h);
  assert.equal(result.outcome, "move-failed");
  assert.match(result.line, /codex-cli reads 0\.157\.0, not 0\.162\.1 after the installer said it was done/);
  assert.deepEqual(h.log.smokes, []);
  assert.deepEqual(h.log.recorded, [], "an install that did not take is not an interactive-prompt drift");
});

test("an installer that throws stops the run, reverts what was touched (the failing tool included) and names it", () => {
  const h = host({ start: { ...OLD, "claude-code": "2.1.290" }, target: { ...NEW, "claude-code": "2.1.296" }, moveBehaviour: { "codex-daemon": "throws" }, revertBehaviour: {} });
  h.versions["codex-daemon"] = "0.161.0";
  const result = updateAgentTools({ ...h.deps, targets: () => ({ ...NEW, "claude-code": "2.1.296" }) });
  assert.equal(result.outcome, "move-failed");
  assert.deepEqual(h.log.moves, ["codex-cli->0.162.1", "codex-daemon->0.162.1"], "claude-code was never reached");
  assert.deepEqual(h.log.reverts, ["codex-daemon->0.161.0", "codex-cli->0.157.0"]);
  assert.match(result.line, /codex-daemon did not install 0\.162\.1 \(codex-daemon installer exited 1\)/);
});

test("a smoke that could not be RUN is UNPROVEN: kept, exit non-zero, never reverted on a reading nobody made", () => {
  const h = host({ screens: { reviewer: { opened: false, why: "herdr is not running" } } });
  const result = run(h);
  assert.equal(result.outcome, "unproven");
  assert.equal(result.exitCode, 1);
  assert.deepEqual(h.log.reverts, []);
  assert.deepEqual(h.log.recorded, []);
  assert.match(result.line, /smoke start NOT PROVEN/);
  assert.match(result.line, /no scratch pane could be opened \(herdr is not running\)/);
  const throws = host();
  throws.deps.smoke = () => { throw new Error("herdr died"); };
  assert.equal(run(throws).outcome, "unproven", "a smoke seam that throws is unrun, not a failure of the tool");
});

test("a target that cannot be read, or a tool that cannot be read, is named and nothing moves", () => {
  const noTarget = host({ target: { "codex-cli": "0.162.1", "codex-daemon": "0.162.1" } });
  const a = run(noTarget);
  assert.equal(a.outcome, "not-read");
  assert.match(a.line, /NO TARGET for claude-code/);
  assert.deepEqual(noTarget.log.moves, []);
  const unreadable = host();
  unreadable.deps.installed = () => { throw new Error("codex-daemon: daemon is not running"); };
  const b = run(unreadable);
  assert.match(b.line, /NOT READ: codex-daemon: daemon is not running; nothing was moved/);
});

test("--check reads and plans and moves nothing, and does not switch the daemon's loop off", () => {
  const h = host();
  let applied: boolean | null = null;
  h.deps.pinDaemon = (apply) => { applied = apply; return "ON"; };
  const result = run(h, { check: true });
  assert.equal(result.outcome, "check");
  assert.equal(result.exitCode, 0);
  assert.equal(applied, false);
  assert.match(result.line, /would move codex-cli 0\.157\.0->0\.162\.1/);
  assert.deepEqual([h.log.moves, h.log.smokes, h.log.sleeps], [[], [], []]);
});

test("a loop that cannot be switched off is said on the line and is not 'at target' success", () => {
  const h = host({ start: { ...NEW } });
  h.deps.pinDaemon = () => { throw new Error("EACCES: settings.json"); };
  const result = run(h);
  assert.equal(result.outcome, "at-target");
  assert.equal(result.exitCode, 1);
  assert.match(result.line, /NOT SWITCHED OFF \(EACCES: settings\.json\): the daemon can still move itself/);
});

// The dialog reader.
test("the screen check: a dialog outranks a start that reported ready, and an ordinary screen is not one", () => {
  assert.equal(judgeSmoke("reviewer", { opened: true, started: true, pane: TRUST }, plainDialogOnScreen).status, "dialog");
  assert.equal(judgeSmoke("reviewer", { opened: true, started: true, pane: PROMPT }, plainDialogOnScreen).status, "prompt");
  assert.equal(judgeSmoke("reviewer", { opened: true, started: false, pane: "starting...", why: "timed out" }, plainDialogOnScreen).status, "not-ready");
  assert.equal(judgeSmoke("reviewer", { opened: true, started: true, pane: null }, plainDialogOnScreen).status, "unread");
  // `git status` in a healthy pane prints "working directory clean", which is not a picker
  assert.equal(plainDialogOnScreen("On branch main\nnothing to commit, working directory clean\n› "), null);
  assert.equal(plainDialogOnScreen("Update available! 0.162.1 -> 0.163.0\n  1. Update now\n  2. Skip\nPress enter to continue"), "an update prompt");
  assert.equal(plainDialogOnScreen("Overwrite file? [y/n]"), "a confirmation prompt");
});

// The live seams, against a scratch home.
function scratchHome() {
  const home = mkdtempSync(join(tmpdir(), "agent-tool-update-home-"));
  return { home, done: () => rmSync(home, { recursive: true, force: true }) };
}

test("hostSeams.pinDaemon writes updater.autoUpdateEnabled=false, keeps every other key, and is idempotent; --check writes nothing", () => {
  const { home, done } = scratchHome();
  try {
    const file = join(home, ".codex", "app-server-daemon", "settings.json");
    const seams = hostSeams({ home });
    assert.match(seams.pinDaemon(false), /^ON \(.*settings\.json is missing, which is the default\)/);
    assert.equal(existsSync(file), false, "a read does not write");
    mkdirSync(join(home, ".codex", "app-server-daemon"), { recursive: true });
    writeFileSync(file, JSON.stringify({ remoteControlEnabled: true, updater: { updateIntervalMinutes: 60 } }));
    assert.match(seams.pinDaemon(true), /^switched off/);
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { remoteControlEnabled: true, updater: { updateIntervalMinutes: 60, autoUpdateEnabled: false } });
    assert.match(seams.pinDaemon(true), /^already off/);
    writeFileSync(file, "[1]");
    assert.throws(() => seams.pinDaemon(true), /is not a JSON object/);
  } finally {
    done();
  }
});

test("hostSeams.revert repoints each `current` at the release directory for the version, and refuses a version with none", () => {
  const { home, done } = scratchHome();
  try {
    const standalone = join(home, ".codex", "packages", "standalone");
    mkdirSync(join(standalone, "releases", "0.157.0-x86_64-unknown-linux-musl"), { recursive: true });
    mkdirSync(join(standalone, "releases", "0.162.1-x86_64-unknown-linux-musl"), { recursive: true });
    symlinkSync(join(standalone, "releases", "0.162.1-x86_64-unknown-linux-musl"), join(standalone, "current"));
    const versions = join(home, ".local", "share", "claude", "versions");
    mkdirSync(join(versions, "2.1.295"), { recursive: true });
    mkdirSync(join(home, ".local", "bin"), { recursive: true });
    symlinkSync(join(versions, "2.1.296"), join(home, ".local", "bin", "claude"));
    const seams = hostSeams({ home, runProgram: () => { throw new Error("no program may run for a symlink revert"); } });
    seams.revert("codex-cli", "0.157.0");
    assert.equal(readlinkSync(join(standalone, "current")), join(standalone, "releases", "0.157.0-x86_64-unknown-linux-musl"));
    assert.equal(lstatSync(join(standalone, "current")).isSymbolicLink(), true);
    assert.throws(() => seams.revert("codex-cli", "0.150.0"), /no release directory for 0\.150\.0/);
    seams.revert("claude-code", "2.1.295");
    assert.equal(readlinkSync(join(home, ".local", "bin", "claude")), join(versions, "2.1.295"));
  } finally {
    done();
  }
});

test("hostSeams.targets: Codex's is the newer of the two updater files with the platform stripped; Claude's is the flag, else the registry", () => {
  const { home, done } = scratchHome();
  try {
    for (const [dir, text] of [["standalone", "0.157.0-x86_64-unknown-linux-musl"], ["app-server-daemon", "0.162.1-x86_64-unknown-linux-musl\n"]]) {
      mkdirSync(join(home, ".codex", "packages", dir), { recursive: true });
      writeFileSync(join(home, ".codex", "packages", dir, "auto-update-version"), text);
    }
    const asked: string[] = [];
    const seams = hostSeams({ home, runProgram: (program, args) => { asked.push(`${program} ${args.join(" ")}`); return JSON.stringify({ name: "@anthropic-ai/claude-code", version: "2.1.297" }); } });
    assert.deepEqual(seams.targets("2.1.300"), { "codex-cli": "0.162.1", "codex-daemon": "0.162.1", "claude-code": "2.1.300" });
    assert.deepEqual(asked, [], "a pinned Claude asks nobody");
    assert.equal(seams.targets()["claude-code"], "2.1.297");
    assert.deepEqual(asked, ["curl -fsS --max-time 20 https://registry.npmjs.org/@anthropic-ai/claude-code/latest"], "asked over curl, never npm");
    // an answer with no version is NO target too
    const blank = hostSeams({ home, runProgram: () => "{}" });
    assert.equal(blank.targets()["claude-code"], undefined);
    // a registry that cannot be asked is NO target, never a guess
    const offline = hostSeams({ home, runProgram: () => { throw new Error("ENOTFOUND"); } });
    assert.equal(offline.targets()["claude-code"], undefined);
  } finally {
    done();
  }
});

test("hostSeams.smoke closes the scratch workspace on every road, and reports a start that never became ready with the screen", () => {
  const calls: string[][] = [];
  const answers = (startFails: boolean, readFails = false) => (args: string[]): string => {
    calls.push(args);
    const verb = args.slice(2, 4).join(" ");
    if (verb === "workspace create") return JSON.stringify({ result: { workspace: { workspace_id: "w9" }, root_pane: { pane_id: "p9" } } });
    if (verb.startsWith("agent start")) { if (startFails) throw Object.assign(new Error("timed out"), { stderr: "agent not ready after 90000 ms" }); return "{}"; }
    if (verb.startsWith("agent read")) { if (readFails) throw new Error("gone"); return TRUST; }
    return "{}";
  };
  for (const [startFails, readFails] of [[false, false], [true, false], [false, true]] as const) {
    calls.length = 0;
    const raw = hostSeams({ home: "/nonexistent", herdr: answers(startFails, readFails) }).smoke("worker", ["--model", "x"]);
    assert.ok(raw.opened);
    assert.equal(raw.opened && raw.started, !startFails);
    assert.equal(raw.opened && raw.pane, readFails ? null : TRUST);
    assert.deepEqual(calls.at(-1)!.slice(0, 5), ["--session", "org", "workspace", "close", "w9"], "the scratch workspace is closed");
    const start = calls.find((c) => c[2] === "agent" && c[3] === "start")!;
    assert.equal(start[start.indexOf("--kind") + 1], "claude");
    assert.deepEqual(start.slice(start.indexOf("--") + 1), ["--model", "x"], "the seat's own launch arguments follow herdr's `--`");
  }
  const none = hostSeams({ home: "/nonexistent", herdr: () => { throw new Error("herdr: no server"); } }).smoke("reviewer", []);
  assert.equal(none.opened, false);
});

test("the command is registered under its name and runs the program", () => {
  assert.equal(COMMANDS["agent-tool:update"], "agent-tool-update.ts");
  assert.equal(existsSync(new URL("./agent-tool-update.ts", import.meta.url)), true);
});

// `host:check` NAMES THE OWNER (row item 4): the finding that already exists says which command moves a version; this row does not add a second finding.
test("host:check's CODEX CLIENT AND DAEMON DISAGREE finding names agent-tool:update as the owner of the move", () => {
  const version = JSON.stringify({ status: "running", managedCodexPath: "/h/d/codex", cliVersion: "0.157.0", appServerVersion: "0.162.1" });
  const findings = codexClientDaemonDrift({ home: "/h", readCodexConfig: () => "[features]\n",
    run: (_program, args) => (args.join(" ") === "app-server daemon version" ? version : "shell_tool  stable  true\n") });
  const finding = findings.find((f) => f.problem === "CODEX CLIENT AND DAEMON DISAGREE");
  assert.ok(finding, "the existing finding still fires");
  assert.match(finding.detail, /`agent-org agent-tool:update` is the one owner of a version move/);
  assert.equal(findings.filter((f) => f.problem === "CODEX CLIENT AND DAEMON DISAGREE").length, 1, "one finding, not a second one from this row");
});
