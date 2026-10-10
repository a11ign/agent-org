#!/usr/bin/env node
// @ts-check
// command: the one way to move Codex (the CLI and its app-server daemon) and Claude Code together, prove the result with a smoke start, and revert a move that fails
//
// #4437 (class `tool-drift-interactive-prompt`, direction item 1): "a tool changes underneath the org on its own schedule, and the first symptom is an agent stuck on an
// interactive prompt". Three programs updated on three clocks: the Codex daemon's own `pid-update-loop`, the Codex CLI (whatever was installed) and Claude Code. This is the
// only thing that moves a version, and it proves the move before it keeps it.
//
//   agent-org agent-tool:update [--check] [--session=<you>] [--let-finish=<a,b>] [--wait-minutes=<n>] [--claude=<version>] [--ledger=<path>]
//
// THE ORDER, and why each step is where it is:
//   1. READ the three installed versions and one target per tool. A tool that cannot be read or has no target is NAMED and left alone: absence is not "at target".
//   2. REFUSE while a seat is mid-turn (`working` in herdr's listing). Moving the daemon interrupts a reviewer's turn, and a worker's tool is replaced under it. A seat is let
//      finish ONLY when the caller names it in `--let-finish`, and then the move WAITS for it, bounded; one that is mid-turn and not named refuses at once. `--session` is the caller
//      itself, which is always mid-turn and never held on.
//   3. SWITCH OFF the daemon's own update loop (`settings.json`'s `updater.autoUpdateEnabled`), so no second program moves a version. What was measured is in the PR.
//   4. MOVE, tool by tool, then READ BACK: an installer that exits 0 and leaves the old version is a failed move, not a kept one.
//   5. SMOKE START a Codex reviewer and a Claude worker in a scratch pane: each must reach its first prompt with no dialog on the screen, and is stopped.
//   6. A MOVE THAT FAILS THE SMOKE IS REVERTED (every tool this run moved, so the set stays one version-set), the revert is READ BACK, and one `tool-drift-interactive-prompt`
//      incident per failed smoke goes to the failure ledger naming the tool, both versions and the pane text. A revert that did not take is reported BY NAME, never as success.
//
// WHICH RULE GOVERNS A REVERT HERE. The chairman's 2026-09-24 ruling is "fix forward, never revert" for CODE. This direction is newer and is specific to tool installs: a tool
// version is not a commit, the previous release directories are still on disk, and an update that strands a reviewer on a dialog is undone and becomes a ledger incident.
//
// A LEAF AT IMPORT: `node:` imports and two leaves (`failure-ledger.ts`, `herdr-agents.ts`). The seams that need a project (the profile's launch arguments, the wake ledger's
// path, the prompt reader) are imported INSIDE `liveDeps`, so a test that injects them resolves no project, as `codex-drift.ts` does.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { FAILURE_LEDGER_FILE, recordFailures, type FailureEvent, type RecordResult } from "./failure-ledger.ts";
import { readAgents } from "./herdr-agents.ts";
import { flagValue, refuseUnknownFlags } from "./lib/cli-flags.ts";

/** The incident's kind, the epic's class. Not seeded in `FAILURE_KINDS`, which a test pins at the six first-move kinds; `repeatsIn` reads any key. */
export const TOOL_DRIFT_KIND = "tool-drift-interactive-prompt";

export const TOOLS = ["codex-cli", "codex-daemon", "claude-code"] as const;
export type Tool = (typeof TOOLS)[number];
export type Versions = Record<Tool, string>;

export type SmokeKind = "reviewer" | "worker";
/** Which tools each smoke exercises: a reviewer is Codex (the CLI starts it, the daemon serves it), a worker is Claude Code. */
export const SMOKES: readonly { kind: SmokeKind; product: "codex" | "claude"; tools: readonly Tool[] }[] = [
  { kind: "reviewer", product: "codex", tools: ["codex-cli", "codex-daemon"] },
  { kind: "worker", product: "claude", tools: ["claude-code"] },
];

/**
 * What the seam saw. `opened: false` is a scratch pane that could not be made (herdr unreachable), which proves nothing either way. `started: false` is an agent that did not
 * reach readiness inside the bound, with whatever the pane said. `pane: null` is a pane that could not be read after a start that reported ready.
 */
export type SmokeRaw = { opened: false, why: string } | { opened: true, started: boolean, pane: string | null, why?: string };
/**
 * `prompt` reached it with no dialog; `dialog` stands at one; `not-ready` never became ready. `unrun` and `unread` are UNPROVEN, which is neither a pass nor a failure:
 * a revert on a reading nobody made would strand the host's reviewers for a fault in the check.
 */
export type SmokeStatus = "prompt" | "dialog" | "not-ready" | "unrun" | "unread";
export type SmokeResult = { kind: SmokeKind, status: SmokeStatus, pane: string, detail: string };

export type Deps = {
  /** The three installed versions. Throws, naming the tool, when one cannot be read. */
  installed: () => Versions;
  /** One target per tool; a tool absent from the answer has no target and is named. */
  targets: () => Partial<Record<Tool, string>>;
  /** Every seat mid-turn, or `null` when the listing could not be read (which HOLDS the move: unknown is not idle). */
  working: () => string[] | null;
  /** Switch the daemon's own update loop off. Returns what it did, as words. Throws when it cannot. */
  pinDaemon: (apply: boolean) => string;
  move: (tool: Tool, to: string, from: string) => void;
  revert: (tool: Tool, to: string) => void;
  smoke: (kind: SmokeKind) => SmokeRaw;
  /** The dialog a screen shows, or `null`. */
  dialogOf: (screen: string) => string | null;
  record: (events: FailureEvent[]) => RecordResult;
  now: () => number;
  sleep: (ms: number) => void;
};

export type Options = { check?: boolean, session?: string | null, letFinish?: string[], waitMs?: number, pollMs?: number };
export type Outcome = "at-target" | "check" | "kept" | "unproven" | "reverted" | "revert-failed" | "move-failed" | "busy" | "not-read";
export type Result = { outcome: Outcome, line: string, exitCode: number, smokes: SmokeResult[] };

const PREFIX = "agent-tool:update:";
const DEFAULT_WAIT_MS = 30 * 60_000;
const DEFAULT_POLL_MS = 30_000;

/** A plain text check for a screen that stops a session until a person answers: the shapes `PROMPT_SCREENS` (`wake.ts`, #3458) names, plus the ones an update itself raises. */
const PLAIN_DIALOGS: readonly { name: string, any: RegExp[] }[] = [
  { name: "a trust prompt", any: [/do you trust (?:the )?(?:files|contents)/i] },
  { name: "Codex's working-directory picker", any: [/working directory[\s\S]*(?:use|resume)[^\n]*(?:session|current) directory/i] },
  { name: "an update prompt", any: [/update (?:available|now)[\s\S]{0,200}(?:skip|later|enter|\[y\/n\])/i, /press enter to continue/i] },
  { name: "a confirmation prompt", any: [/\[y\/n\]|\(y\/n\)|\byes\b[^\n]*\bno\b[^\n]*\?\s*$/im] },
  { name: "a permission or onboarding dialog", any: [/bypass permissions mode[\s\S]*(?:accept|yes)/i, /choose the text style|select (?:a )?(?:login|theme)|let'?s get started/i] },
];

/** @returns the dialog `screen` shows, or `null`. */
export function plainDialogOnScreen(screen: string): string | null {
  return PLAIN_DIALOGS.find((d) => d.any.some((pattern) => pattern.test(screen)))?.name ?? null;
}

const oneLine = (text: string, max = 200): string => text.split("\n").map((l) => l.trim()).filter((l) => l !== "").slice(-3).join(" | ").replace(/[\t\r]/g, " ").slice(0, max);

/** @returns the smoke's verdict from what the seam saw. A dialog on the screen outranks a start that reported ready. */
export function judgeSmoke(kind: SmokeKind, raw: SmokeRaw, dialogOf: (screen: string) => string | null): SmokeResult {
  if (!raw.opened) return { kind, status: "unrun", pane: "", detail: `no scratch pane could be opened (${oneLine(raw.why, 120)})` };
  const dialog = raw.pane === null ? null : (dialogOf(raw.pane) ?? plainDialogOnScreen(raw.pane));
  const pane = raw.pane === null ? "" : oneLine(raw.pane);
  if (dialog !== null) return { kind, status: "dialog", pane, detail: `a dialog is on the screen: ${dialog}` };
  if (!raw.started) return { kind, status: "not-ready", pane, detail: `it never reached its first prompt${raw.why ? ` (${oneLine(raw.why, 120)})` : ""}` };
  if (raw.pane === null) return { kind, status: "unread", pane, detail: "it reported ready but its screen could not be read, so no dialog is ruled out" };
  return { kind, status: "prompt", pane, detail: "reached its first prompt with no dialog" };
}

const failed = (smoke: SmokeResult): boolean => smoke.status === "dialog" || smoke.status === "not-ready";
const describe = (cause: unknown): string => String((cause as Error)?.message ?? cause).split("\n")[0].slice(0, 160);
const pairs = (tools: readonly Tool[], from: Versions, to: Versions): string => tools.map((t) => `${t} ${from[t]}->${to[t]}`).join(", ");

/**
 * THE RUN. Never throws: every road ends in a {@link Result} whose `line` is what the command prints and whose `exitCode` is what it exits with.
 * @param {Deps} deps @param {Options} [options]
 */
export function updateAgentTools(deps: Deps, options: Options = {}): Result {
  const { check = false, session = null, letFinish = [], waitMs = DEFAULT_WAIT_MS, pollMs = DEFAULT_POLL_MS } = options;
  const out = (outcome: Outcome, line: string, exitCode: number, smokes: SmokeResult[] = []): Result => ({ outcome, line: `${PREFIX} ${line}`, exitCode, smokes });

  let before: Versions;
  try {
    before = deps.installed();
  } catch (cause) {
    return out("not-read", `NOT READ: ${describe(cause)}; nothing was moved.`, 1);
  }
  const wanted = deps.targets();
  const unresolved = TOOLS.filter((t) => wanted[t] === undefined);
  if (unresolved.length > 0) {
    return out("not-read", `NO TARGET for ${unresolved.join(", ")} (installed: ${TOOLS.map((t) => `${t} ${before[t]}`).join(", ")}); nothing was moved.`, 1);
  }
  const target = wanted as Versions;
  const toMove = TOOLS.filter((t) => before[t] !== target[t]);

  if (check) {
    const plan = toMove.length === 0 ? "every tool is at its target" : `would move ${pairs(toMove, before, target)}`;
    let loop: string;
    try { loop = deps.pinDaemon(false); } catch (cause) { loop = `NOT READ (${describe(cause)})`; }
    return out("check", `${plan} (read only; the daemon's own update loop: ${loop}).`, 0);
  }

  // THE DAEMON'S OWN LOOP IS SWITCHED OFF ON EVERY RUN, a move or not: "already at target" with a loop still free to move the daemon is a host that drifts on the next tick.
  let pinned: string;
  try {
    pinned = deps.pinDaemon(true);
  } catch (cause) {
    pinned = `NOT SWITCHED OFF (${describe(cause)}): the daemon can still move itself, so this command can only detect`;
  }
  if (toMove.length === 0) {
    return out("at-target", `already at target, nothing moved: ${TOOLS.map((t) => `${t} ${before[t]}`).join(", ")}. Daemon update loop: ${pinned}.`, pinned.startsWith("NOT SWITCHED OFF") ? 1 : 0);
  }

  // A MID-TURN SEAT HOLDS THE MOVE: unnamed refuses at once, named is waited for (bounded).
  const deadline = deps.now() + waitMs;
  for (;;) {
    const seen = deps.working();
    if (seen === null) return out("busy", "NOT READ: herdr's seat listing, so whether a reviewer or worker is mid-turn is unknown and nothing was moved.", 1);
    const mid = seen.filter((name) => name !== session);
    const unnamed = mid.filter((name) => !letFinish.includes(name));
    if (unnamed.length > 0) {
      return out("busy", `REFUSED: ${unnamed.join(", ")} ${unnamed.length === 1 ? "is" : "are"} mid-turn and ${unnamed.length === 1 ? "was" : "were"} not named in --let-finish; nothing was moved. `
        + "Name a seat to let it finish first, or run again when it is idle.", 1);
    }
    if (mid.length === 0) break;
    if (deps.now() >= deadline) {
      return out("busy", `REFUSED: ${mid.join(", ")} still mid-turn after ${Math.round(waitMs / 60_000)} min of letting ${mid.length === 1 ? "it" : "them"} finish; nothing was moved.`, 1);
    }
    deps.sleep(pollMs);
  }

  // MOVE. The tools that were TOUCHED are the ones a revert undoes, a failed install included: a half-written install is not the version it was.
  const touched: Tool[] = [];
  let moveError: string | null = null;
  for (const tool of toMove) {
    touched.push(tool);
    try {
      deps.move(tool, target[tool], before[tool]);
    } catch (cause) {
      moveError = `${tool} did not install ${target[tool]} (${describe(cause)})`;
      break;
    }
  }
  if (moveError === null) {
    try {
      const now = deps.installed();
      const wrong = toMove.filter((t) => now[t] !== target[t]);
      if (wrong.length > 0) moveError = `${wrong.map((t) => `${t} reads ${now[t]}, not ${target[t]}`).join("; ")} after the installer said it was done`;
    } catch (cause) {
      moveError = `the versions could not be read back (${describe(cause)})`;
    }
  }

  const smokes: SmokeResult[] = [];
  if (moveError === null) {
    for (const { kind } of SMOKES) {
      let raw: SmokeRaw;
      try {
        raw = deps.smoke(kind);
      } catch (cause) {
        raw = { opened: false, why: describe(cause) };
      }
      smokes.push(judgeSmoke(kind, raw, deps.dialogOf));
    }
  }
  const smokeText = smokes.map((s) => `${s.kind} ${s.status === "prompt" ? "ok" : s.status.toUpperCase()}${s.status === "prompt" ? "" : ` (${s.detail}${s.pane ? `: ${s.pane}` : ""})`}`).join(", ");
  const bad = smokes.filter(failed);
  const unproven = smokes.filter((s) => !failed(s) && s.status !== "prompt");

  if (moveError === null && bad.length === 0) {
    const moved = pairs(toMove, before, target);
    if (unproven.length > 0) {
      return out("unproven", `moved ${moved}; smoke start NOT PROVEN, so the move was KEPT but is unverified: ${smokeText}. Daemon update loop: ${pinned}.`, 1, smokes);
    }
    return out("kept", `moved ${moved}; smoke start ok (${smokeText}), kept. Daemon update loop: ${pinned}.`, 0, smokes);
  }

  // REVERT every touched tool, newest first, then READ BACK.
  const refused: string[] = [];
  for (const tool of [...touched].reverse()) {
    try {
      deps.revert(tool, before[tool]);
    } catch (cause) {
      refused.push(`${tool} (${describe(cause)})`);
    }
  }
  let still: string[] = [];
  try {
    const after = deps.installed();
    still = touched.filter((t) => after[t] !== before[t] && !refused.some((r) => r.startsWith(t))).map((t) => `${t} reads ${after[t]}, not ${before[t]}`);
  } catch (cause) {
    still = [`the versions could not be read back after the revert (${describe(cause)})`];
  }

  // THE INCIDENTS: one per failed smoke, naming the tools, both versions and the pane text. A failed install is not a prompt drift and records none.
  const day = new Date(deps.now()).toISOString().slice(0, 10);
  const events: FailureEvent[] = bad.map((s) => {
    const entry = SMOKES.find((x) => x.kind === s.kind)!;
    return { classKey: TOOL_DRIFT_KIND, ref: `${day} ${s.kind} smoke ${s.status}: ${pairs(entry.tools, before, target)} | pane: ${s.pane || s.detail}`.replace(/[\t\r\n]+/g, " ") };
  });
  const recorded = events.length === 0 ? null : deps.record(events);
  const ledger = recorded === null ? "" : recorded.refused === null ? ` ${events.length} ${TOOL_DRIFT_KIND} incident${events.length === 1 ? "" : "s"} recorded.` : ` INCIDENT NOT RECORDED (${recorded.refused}).`;
  const why = moveError !== null ? moveError : `smoke start failed: ${smokeText}`;
  const back = pairs(touched, target, before).split(", ").reverse().join(", ");
  if (refused.length > 0 || still.length > 0) {
    return out("revert-failed", `${why}. REVERT FAILED, host left half-moved: ${[...refused, ...still].join("; ")}. Wanted back: ${back}.${ledger}`, 1, smokes);
  }
  return out(moveError !== null ? "move-failed" : "reverted", `${why}. REVERTED ${back}, read back ok.${ledger}`, 1, smokes);
}

// ===== the live seams =====

const run = (program: string, args: string[], timeout = 60_000): string => execFileSync(program, args, { encoding: "utf8", timeout, stdio: ["ignore", "pipe", "pipe"] });
const causeOf = (cause: unknown): string => {
  const { stderr } = cause as { stderr?: unknown };
  return String(stderr ?? "").trim().split("\n")[0] || describe(cause);
};

/** The newer of two `major.minor.patch` strings by number. */
const newer = (a: string, b: string): string => {
  const [x, y] = [a, b].map((v) => v.split(".").map((n) => Number.parseInt(n, 10) || 0));
  for (let i = 0; i < 3; i += 1) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0) ? a : b;
  return a;
};
const versionOfRelease = (name: string): string => name.replace(/-(?:x86_64|aarch64|arm64)[\w-]*$/, "");

/**
 * The host's real seams, for `home`. Exported with every external call behind an argument so a test can drive each one against a scratch home.
 * @param {{ home?: string, runProgram?: typeof run, herdr?: (args: string[]) => string, env?: NodeJS.ProcessEnv }} [io]
 */
export function hostSeams({ home = homedir(), runProgram = run, herdr = (args) => run("herdr", args, 120_000) }: { home?: string, runProgram?: typeof run, herdr?: (args: string[]) => string } = {}) {
  const codex = (args: string[], timeout?: number) => {
    for (const candidate of ["codex", join(home, ".local", "bin", "codex")]) {
      try {
        return runProgram(candidate, args, timeout);
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
      }
    }
    throw new Error("no `codex` on PATH or in ~/.local/bin");
  };
  const standalone = join(home, ".codex", "packages", "standalone");
  const daemonPackages = join(home, ".codex", "packages", "app-server-daemon");
  const daemonState = join(home, ".codex", "app-server-daemon");
  const claudeLink = join(home, ".local", "bin", "claude");
  const claudeVersions = join(home, ".local", "share", "claude", "versions");

  /** Point `link` at `to`, atomically: a symlink made beside it and renamed over it, so there is never an instant with no link. */
  const flip = (link: string, to: string): void => {
    const next = `${link}.agent-tool-update`;
    try { renameSync(next, `${next}.old`); } catch { /* none left behind */ }
    symlinkSync(to, next);
    renameSync(next, link);
  };
  const releaseDir = (packages: string, version: string): string => {
    const name = readdirSync(join(packages, "releases")).find((entry) => versionOfRelease(entry) === version);
    if (name === undefined) throw new Error(`no release directory for ${version} under ${join(packages, "releases")}`);
    return join(packages, "releases", name);
  };
  const readTarget = (file: string): string | undefined => {
    try { return versionOfRelease(readFileSync(file, "utf8").trim()) || undefined; } catch { return undefined; }
  };

  return {
    installed(): Versions {
      const read = (tool: Tool, fn: () => string): string => {
        try { return fn(); } catch (cause) { throw new Error(`${tool}: ${causeOf(cause)}`); }
      };
      return {
        "codex-cli": read("codex-cli", () => /codex-cli (\S+)/.exec(codex(["--version"]))?.[1] ?? (() => { throw new Error("no version in `codex --version`"); })()),
        "codex-daemon": read("codex-daemon", () => {
          const reported = JSON.parse(codex(["app-server", "daemon", "version"])).appServerVersion;
          if (typeof reported !== "string") throw new Error("`codex app-server daemon version` names no appServerVersion (is the daemon running?)");
          return reported;
        }),
        "claude-code": read("claude-code", () => /^(\S+) \(Claude Code\)/.exec(runProgram("claude", ["--version"]).trim())?.[1] ?? (() => { throw new Error("no version in `claude --version`"); })()),
      };
    },
    /** Codex's latest is what its own updater selected (`auto-update-version`), the newer of the two files; Claude's is the npm registry's, or the flag. */
    targets(claudePin?: string): Partial<Record<Tool, string>> {
      const files = [join(daemonPackages, "auto-update-version"), join(standalone, "auto-update-version")].map(readTarget).filter((v): v is string => v !== undefined);
      const latest = files.length === 0 ? undefined : files.reduce(newer);
      let claude = claudePin;
      if (claude === undefined) {
        try { claude = runProgram("npm", ["view", "@anthropic-ai/claude-code", "version"], 30_000).trim() || undefined; } catch { claude = undefined; }
      }
      return { "codex-cli": latest, "codex-daemon": latest, "claude-code": claude };
    },
    working(): string[] | null {
      return readAgents(herdr)?.filter((a) => a.status === "working").map((a) => a.label) ?? null;
    },
    pinDaemon(apply: boolean): string {
      const file = join(daemonState, "settings.json");
      let settings: Record<string, any> = {};
      if (existsSync(file)) {
        const parsed = JSON.parse(readFileSync(file, "utf8"));
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${file} is not a JSON object`);
        settings = parsed;
      }
      if (settings.updater?.autoUpdateEnabled === false) return `already off (${file})`;
      if (!apply) return `ON (${existsSync(file) ? file : `${file} is missing, which is the default`}); a run switches it off`;
      mkdirSync(daemonState, { recursive: true });
      const tmp = `${file}.agent-tool-update`;
      writeFileSync(tmp, `${JSON.stringify({ ...settings, updater: { ...(settings.updater ?? {}), autoUpdateEnabled: false } }, null, 2)}\n`);
      renameSync(tmp, file);
      return `switched off (${file}, \`updater.autoUpdateEnabled=false\`; the running loop honouring it without a restart is NOT measured)`;
    },
    move(tool: Tool, to: string): void {
      if (tool === "codex-cli") codex(["update"], 300_000);
      else if (tool === "codex-daemon") codex(["app-server", "daemon", "update", "--from-cli", "--yes"], 300_000);
      else runProgram("claude", ["install", to], 300_000);
    },
    revert(tool: Tool, to: string): void {
      if (tool === "codex-cli") flip(join(standalone, "current"), releaseDir(standalone, to));
      else if (tool === "codex-daemon") {
        flip(join(daemonPackages, "current"), releaseDir(daemonPackages, to));
        codex(["app-server", "daemon", "restart"], 120_000);
      } else {
        const dir = join(claudeVersions, to);
        if (existsSync(dir)) flip(claudeLink, dir);
        else runProgram("claude", ["install", to], 300_000);
      }
    },
    /** One scratch workspace in herdr's `org` session, started the way the org starts a seat, read, and CLOSED on every road. */
    smoke(kind: SmokeKind, startArgs: string[]): SmokeRaw {
      const product = SMOKES.find((s) => s.kind === kind)!.product;
      const name = `smoke-${kind}-${Date.now().toString(36)}`;
      let workspace: string | undefined;
      try {
        const created = JSON.parse(herdr(["--session", "org", "workspace", "create", "--label", name, "--no-focus"]));
        workspace = created?.result?.workspace?.workspace_id;
        const pane = created?.result?.root_pane?.pane_id;
        if (typeof workspace !== "string" || typeof pane !== "string") return { opened: false, why: "herdr's workspace answer names no pane" };
        let started = true;
        let why: string | undefined;
        try {
          herdr(["--session", "org", "agent", "start", name, "--kind", product, "--pane", pane, "--timeout", "90000", "--", ...startArgs]);
        } catch (cause) {
          started = false;
          why = causeOf(cause);
        }
        let screen: string | null;
        try { screen = herdr(["--session", "org", "agent", "read", name, "--source", "recent", "--lines", "40"]); } catch { screen = null; }
        return { opened: true, started, pane: screen, ...(why === undefined ? {} : { why }) };
      } catch (cause) {
        return { opened: false, why: causeOf(cause) };
      } finally {
        if (workspace !== undefined) {
          try { herdr(["--session", "org", "workspace", "close", workspace]); } catch { /* reported by the next run's `unknown` seat; nothing to add here */ }
        }
      }
    },
  };
}

/** The real {@link Deps}: the profile's own launch arguments, the wake ledger's directory and the pane-prompt reader come from the modules that own them, loaded here. */
async function liveDeps(argv: string[]): Promise<Deps> {
  const seams = hostSeams();
  const worker = await import("./worker-profile.ts");
  const wake = await import("./wake.ts");
  // THE LAUNCH ARGUMENTS ARE A REAL SEAT'S: the first cause whose profile is this product's, `ready-row-unclaimed` first for the worker (the headless pilot's), so a dialog the
  // posture flags raise is the dialog a spawned seat meets.
  const argsFor = (product: "codex" | "claude"): string[] => {
    const profiles = worker.PROFILES as Record<string, { kind: string }>;
    const cause = (product === "claude" && profiles["ready-row-unclaimed"]?.kind === "claude" ? "ready-row-unclaimed" : undefined)
      ?? Object.keys(profiles).find((name) => profiles[name].kind === product);
    if (cause === undefined) throw new Error(`no cause declares a ${product} profile, so there is no launch to smoke-start`);
    const profile = worker.profileFor(cause);
    if ("refusal" in profile) throw new Error(profile.refusal);
    return worker.agentArgs(profile);
  };
  const ledger = join(dirname(wake.ledgerPathFrom(argv)), FAILURE_LEDGER_FILE);
  return {
    installed: seams.installed,
    targets: () => seams.targets(flagValue(argv, "claude") ?? undefined),
    working: seams.working,
    pinDaemon: seams.pinDaemon,
    move: (tool, to) => seams.move(tool, to),
    revert: seams.revert,
    smoke: (kind) => {
      try { return seams.smoke(kind, argsFor(SMOKES.find((s) => s.kind === kind)!.product)); } catch (cause) { return { opened: false, why: describe(cause) }; }
    },
    dialogOf: wake.promptOnScreen,
    record: (events) => recordFailures({ logPath: ledger, events, now: Date.now() }),
    now: Date.now,
    sleep: (ms) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); },
  };
}

async function main() {
  refuseUnknownFlags(["--check", "--session=", "--let-finish=", "--wait-minutes=", "--claude=", "--ledger="],
    { entry: import.meta.url, command: "agent-org agent-tool:update" });
  const argv = process.argv.slice(2);
  const waitMinutes = Number(flagValue(argv, "wait-minutes") ?? "");
  const result = updateAgentTools(await liveDeps(argv), {
    check: argv.includes("--check"),
    session: flagValue(argv, "session") ?? null,
    letFinish: (flagValue(argv, "let-finish") ?? "").split(",").map((s) => s.trim()).filter((s) => s !== ""),
    ...(Number.isFinite(waitMinutes) && waitMinutes > 0 ? { waitMs: waitMinutes * 60_000 } : {}),
  });
  process.stdout.write(`${result.line}\n`);
  process.exitCode = result.exitCode;
}

if (import.meta.url === pathToFileURL(process.argv[1] ? realpathSync(process.argv[1]) : "").href) await main();
