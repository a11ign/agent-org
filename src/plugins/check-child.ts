// @ts-check
// module: one plugin's doctor checks, run in a process of its own for the board's `GET /api/plugins` (A11-270)
//
// A PROCESS OF ITS OWN. A plugin's checks run programs through `spawnSync` (`security`, `claude mcp list`, `gh`), so in the board's process they hold every other request still while they run,
// and no timer can cut them short. The board starts one of these per plugin, all at once, each in a process group of its own, and kills the group of one that runs past its time limit,
// so a program its checks started is stopped with it. It prints `{ provider, checks }` as JSON on stdout, or `{ error }` with the message of checks that threw.
//
//   node src/plugins/check-child.ts '{"hostPath":"…","plugin":"linear","stateDir":"…","pick":"assigned","clones":{}}'
//
// `plugin` is a plugin's name, or null for the messaging plugin the project names: the child reads which one, and the project's declaration it is read from, so the board's process
// loads neither (the declaration's reader is a gate module, which an instance that starts no reviewer never loads).
import { spawn } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { providersOfText } from "../ticket-mode/providers.ts";
import type { PickScope } from "../ticket-mode/settings.ts";
import { realPluginDeps } from "./active.ts";
import { blockOf } from "./concerns.ts";
import { loadEnabled, settingsOfBlock } from "./loader.ts";
import type { PluginCheck, PluginDeps } from "./manifest.ts";
import { messagingChecksOfFile, messagingStateOfFile } from "./messaging-state.ts";
import { defaultCatalog } from "./registry.ts";

/** What the checks run on: this machine's state folder, Pick scope and clones, as the board started with them. */
export type CheckScope = Readonly<{ stateDir: string; pick: PickScope; clones: Readonly<Record<string, string>> }>;

/** Whose checks to run, and on which host file. */
export type CheckRequest = CheckScope & Readonly<{ hostPath: string; plugin: string | null }>;

/** What a child found: the plugin its checks are of (the messaging plugin's, or null when the project enables none), and the checks. */
export type Found = Readonly<{ provider: string | null; checks: readonly PluginCheck[] }>;

type CheckAnswer = Found | Readonly<{ error: string }>;

const CHECK_PROGRAM = fileURLToPath(import.meta.url);

/**
 * The seams the page's checks run on: this machine's, with no log and nothing placed. The page runs no machine probes of the code host's wrapper (a token mint per App on every load):
 * `agent-org doctor` shows those rows.
 */
export const pageDeps = (scope: CheckScope): PluginDeps => ({ ...realPluginDeps({ env: process.env, ...scope }), log: () => undefined, place: async (): ReturnType<PluginDeps["place"]> => ({ kind: "skipped" }) });

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** The messaging plugin the project enables and its checks, read here: none when it enables none. */
async function messagingOfRequest(request: CheckRequest): Promise<Found> {
  const state = await messagingStateOfFile(request.hostPath);
  if (state.provider === null || !state.enabled) return { provider: null, checks: [] };
  return { provider: state.provider, checks: await messagingChecksOfFile(request.hostPath, { env: process.env, home: homedir() }) };
}

/** What `request` asks for, run here: the messaging plugin's checks, or the named plugin's (none for a plugin the host file does not load). */
export async function foundOf(request: CheckRequest): Promise<Found> {
  return request.plugin === null ? messagingOfRequest(request) : { provider: request.plugin, checks: await checksOfRequest(request.plugin, request) };
}

async function checksOfRequest(plugin: string, request: CheckRequest): Promise<readonly PluginCheck[]> {
  const catalog = defaultCatalog();
  const providers = providersOfText(readText(request.hostPath), catalog);
  const deps = pageDeps(request);
  const load = await loadEnabled(providers, catalog, deps);
  const found = [...load.loaded, ...load.unbuilt].find((candidate) => candidate.plugin.name === plugin);
  const block = found === undefined ? null : blockOf(found.plugin.concern);
  if (found === undefined || block === null) return [];
  return found.module.doctorChecks(settingsOfBlock(providers.blocks[block]), deps);
}

type ChildResult = Readonly<{ status: number | null; stdout: string; stderr: string; stopped: boolean }>;

/** The process groups of the children still running: they end with this process, since a board that stops leaves no checks behind it. */
const running = new Set<number>();

/** Kills the process group `pid` leads, and every program in it. */
function killGroup(pid: number): void {
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // The group has ended already.
  }
}

const killRunning = (): void => { for (const pid of running) killGroup(pid); };

/** Holds `pid`'s group until it ends: this process kills it if it exits first. */
function track(pid: number): void {
  if (running.size === 0) process.once("exit", killRunning);
  running.add(pid);
}

/** Lets go of `pid`'s group, which has ended. */
function untrack(pid: number): void {
  if (running.delete(pid) && running.size === 0) process.removeListener("exit", killRunning);
}

/**
 * Runs node on `args` in a process group of its own, and kills the whole group, with any program it started, when it runs past `timeoutMs`, or when this process exits before it
 * ends.
 */
export function runInGroup(args: readonly string[], timeoutMs: number): Promise<ChildResult> {
  return new Promise((done) => {
    const child = spawn(process.execPath, [...args], { detached: true, stdio: ["ignore", "pipe", "pipe"] });
    // A child that could not start has no pid, and no group to kill: `-0` would be this process's own.
    const pid = child.pid;
    if (pid !== undefined) track(pid);
    let stdout = "";
    let stderr = "";
    let stopped = false;
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    const timer = setTimeout(() => {
      stopped = true;
      if (pid !== undefined) killGroup(pid);
    }, timeoutMs);
    const end = (result: ChildResult): void => {
      clearTimeout(timer);
      if (pid !== undefined) untrack(pid);
      done(result);
    };
    child.on("error", (error) => end({ status: null, stdout, stderr: error.message, stopped }));
    child.on("close", (status) => end({ status, stdout, stderr, stopped }));
  });
}

/** Why a child gave no answer: it was stopped at its limit, or the line of what it printed that names the error. */
function failureOf(result: ChildResult, timeoutMs: number): string {
  if (result.stopped) return `the checks were stopped after ${timeoutMs / 1000} seconds`;
  const lines = result.stderr.trim().split("\n");
  return `the checks exited ${result.status}: ${lines.find((line) => /Error/.test(line)) ?? lines.at(-1) ?? ""}`;
}

/**
 * Runs `request` in a process of its own, `program` (this file, unless a test names another), and answers what it found. THROWS the checks' own message, or why the process failed or
 * was stopped at `timeoutMs`.
 */
export async function foundInChild(request: CheckRequest, timeoutMs: number, program = CHECK_PROGRAM): Promise<Found> {
  const result = await runInGroup([program, JSON.stringify(request)], timeoutMs);
  if (result.status !== 0) throw new Error(failureOf(result, timeoutMs));
  const answer = JSON.parse(result.stdout) as CheckAnswer;
  if ("error" in answer) throw new Error(answer.error);
  return answer;
}

async function main(): Promise<void> {
  let answer: CheckAnswer;
  try {
    answer = await foundOf(JSON.parse(process.argv[2] ?? "") as CheckRequest);
  } catch (error) {
    answer = { error: error instanceof Error ? error.message : String(error) };
  }
  // A plugin may leave a timer or a socket open: the answer is printed, and the process ends.
  process.stdout.write(JSON.stringify(answer), () => process.exit(0));
}

if (import.meta.url === pathToFileURL(process.argv[1] ? realpathSync(process.argv[1]) : "").href) void main();
