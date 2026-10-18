#!/usr/bin/env node
// @ts-check
// command: ticket:pair -- print the codes that pair a new device: one for the board page (`ticket:ui`), one for the worker terminal (herdr web ui),
// or both (A11-93). `--board` prints the board's only, `--terminal` the terminal's only.
//
// The board key stays in its file. This reads the key, asks the page's service on this machine for a code, and prints the code, which a
// person types into its pairing page. A code works once, within ten minutes.
//
// THE TERMINAL'S CODE IS THE PLUGIN'S OWN. `scripts/plugin.ts pair` runs under the terminal service's environment (`terminalPairProgram`), so
// the plugin reads the directories, token and port the service runs with, and its output (the code, the QR for the tailnet address) is kept. A
// person types no path. The terminal's code is printed only when the terminal is served for this instance, or when `--terminal` asks for it.
import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { refuseUnknownFlags } from "../lib/cli-flags.ts";
import { findBun } from "../install/bun.ts";
import { readOrNull } from "../install/paths.ts";
import { servicePath } from "../install/service.ts";
import { herdrConfigDir, localTerminalPort, pluginRoot, terminalPairProgram, type TerminalProgram } from "../install/terminal.ts";
import { boardKeyPath, readBoardKey } from "./board-key.ts";
import { readTailnetName, runTailscale } from "./tailnet.ts";
import { readTicketSettings, type TicketSettings } from "./settings.ts";

/** How long a terminal pairing code lasts, as herdr web ui's `pair` says: ten minutes, for one device. */
const TERMINAL_MINUTES = 10;

/** What `ticket:pair` prints: the board's code, the terminal's, or both. */
export type PairMode = "board" | "terminal" | "both";

/** A new pairing code from the page's service `settings` names. REFUSES when it is not running, or does not take this machine's key. */
export async function pairingCode(settings: TicketSettings, request: typeof fetch = fetch): Promise<{ code: string; minutes: number }> {
  const key = readBoardKey(boardKeyPath(settings.stateDir));
  const url = `http://127.0.0.1:${settings.uiPort}/api/pair-code`;
  let response: Response;
  try {
    response = await request(url, { method: "POST", headers: { "x-ticket-token": key } });
  } catch {
    throw new Error(`no board page answers on 127.0.0.1:${settings.uiPort}: start it with agent-org ticket:ui`);
  }
  if (!response.ok) throw new Error(`the server on 127.0.0.1:${settings.uiPort} refused (${response.status}): it may be another machine's, or an older agent-org's`);
  return await response.json() as { code: string; minutes: number };
}

/** What `terminalPair` reads from this machine: its environment, home directory, and the files and paths it asks about. */
export type TerminalDeps = Readonly<{
  env: Record<string, string | undefined>;
  home: string;
  read: (path: string) => string | null;
  exists: (path: string) => boolean;
}>;

/**
 * Why this machine has no terminal on `port` to pair: `tickets.terminal` is not set, is another machine's, or cannot be told apart from this
 * machine's because the tailnet name cannot be read. Null when there is no terminal to say anything about. PURE.
 */
export function unservedTerminal(settings: TicketSettings, tailnetName: string | null): string | null {
  if (settings.terminal === null) return "tickets.terminal is not set, so this machine serves no worker terminal: run `agent-org onboard`";
  if (settings.serve !== null && tailnetName === null) {
    return `tickets.terminal is ${settings.terminal}, and this machine's tailnet name cannot be read (\`tailscale status --json\`), so it cannot tell whether that terminal is its own: fix Tailscale, then run \`agent-org ticket:pair\` again`;
  }
  return `tickets.terminal is ${settings.terminal}, which another machine serves: run \`agent-org ticket:pair --terminal\` there`;
}

/** The plugin's `pair` for this machine's terminal on `port`, as the terminal service would run it, or the reason it cannot be run. PURE over `deps`. */
export function terminalPair(settings: TicketSettings, port: number, deps: TerminalDeps): TerminalProgram | string {
  const root = pluginRoot(deps.read(join(herdrConfigDir(deps.env, deps.home), "plugins.json")));
  if (root === null) return "herdr web ui is not installed: run `agent-org onboard`, which installs it";
  const path = servicePath(deps.env.PATH);
  const bun = findBun(deps.home, path, deps.exists);
  if (bun === null) return "bun is not installed: run `agent-org onboard`, which installs it";
  return terminalPairProgram({ env: deps.env, home: deps.home, session: settings.herdrSession, port, root, bun, path });
}

/** What `runPair` writes, and what it runs. The command's own uses are `process` and `spawnSync`; a test passes its own. */
export type PairDeps = Readonly<{
  board: () => Promise<{ code: string; minutes: number }>;
  terminal: () => TerminalDeps;
  /** Runs the plugin's program with its output on this terminal, and answers its exit status. */
  run: (program: TerminalProgram) => number;
  /** This machine's MagicDNS name, or null while it cannot be read. Asked only when the terminal is on the tailnet. */
  tailnetName: () => string | null;
  out: (text: string) => void;
  err: (text: string) => void;
}>;

/** The address a person opens to pair the terminal: the tailnet's when it is served there, else this machine's loopback address. */
function terminalPage(settings: TicketSettings, port: number, name: string | null): string {
  return settings.serve === null || name === null ? `http://127.0.0.1:${port}/` : `https://${name}:${settings.serve.terminal}/`;
}

/**
 * Prints the codes `mode` names, and returns the exit status. A board code that cannot be had is said and does not stop the terminal's; a
 * terminal that cannot pair exits 1 with the fix, after the board's code is printed. With no flag, the terminal's code is printed only when
 * the terminal is served for this instance (`tickets.serve`, and `tickets.terminal` on this machine's loopback).
 */
export async function runPair(mode: PairMode, settings: TicketSettings, deps: PairDeps): Promise<number> {
  let status = 0;
  if (mode !== "terminal") {
    try {
      const { code, minutes } = await deps.board();
      deps.out(`${code}\n  type it into http://127.0.0.1:${settings.uiPort}/ within ${minutes} minutes. It works once.\n`);
    } catch (err) {
      deps.err(`ticket:pair: ${String((err as Error)?.message ?? err)}\n`);
      status = 1;
    }
  }
  if (mode === "board") return status;
  const name = settings.serve === null ? null : deps.tailnetName();
  const port = localTerminalPort(settings.terminal, name);
  if (port === null) {
    // Only a served board says so, and only when a terminal is set: a plain board has nothing to say about a terminal it does not serve.
    const why = unservedTerminal(settings, name);
    if (mode === "terminal") {
      deps.err(`ticket:pair: ${why}\n`);
      return 1;
    }
    if (settings.serve !== null && why !== null && settings.terminal !== null) deps.out(`${why}\n`);
    return status;
  }
  if (mode === "both" && settings.serve === null) return status;
  const program = terminalPair(settings, port, deps.terminal());
  if (typeof program === "string") {
    deps.err(`ticket:pair: ${program}\n`);
    return 1;
  }
  if (deps.run(program) !== 0) {
    deps.err("ticket:pair: the worker terminal gave no pairing code: start it with `agent-org start terminal`, then run `agent-org ticket:pair --terminal` again\n");
    return 1;
  }
  deps.out(`  open ${terminalPage(settings, port, name)} within ${TERMINAL_MINUTES} minutes, and enter the code there. It works once.\n`);
  return status;
}

/** The real dependencies: this process's environment and home, the plugin run with its output on this terminal, and the tailnet's name. */
export function defaultPairDeps(settings: TicketSettings): PairDeps {
  return {
    board: () => pairingCode(settings),
    terminal: () => ({
      env: process.env,
      home: homedir(),
      read: readOrNull,
      exists: existsSync,
    }),
    run: (program) => {
      const [file, ...args] = program.argv;
      const result = spawnSync(file, args, { cwd: program.workingDirectory, env: { ...process.env, ...program.environment }, stdio: "inherit" });
      if (result.error) process.stderr.write(`ticket:pair: ${result.error.message}\n`);
      return result.status ?? 1;
    },
    tailnetName: () => readTailnetName(runTailscale),
    out: (text) => process.stdout.write(text),
    err: (text) => process.stderr.write(text),
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ? realpathSync(process.argv[1]) : "").href) {
  refuseUnknownFlags(["--board", "--terminal"], { entry: import.meta.url, command: "agent-org ticket:pair" });
  if (process.argv.includes("--board") && process.argv.includes("--terminal")) {
    process.stderr.write("ticket:pair: name --board or --terminal, not both: with neither, both codes are printed\n");
    process.exit(1);
  }
  const mode: PairMode = process.argv.includes("--board") ? "board" : process.argv.includes("--terminal") ? "terminal" : "both";
  try {
    const settings = readTicketSettings();
    runPair(mode, settings, defaultPairDeps(settings)).then((status) => process.exit(status), (err) => {
      process.stderr.write(`ticket:pair: ${String((err as Error)?.message ?? err)}\n`);
      process.exit(1);
    });
  } catch (err) {
    process.stderr.write(`ticket:pair: ${String((err as Error)?.message ?? err)}\n`);
    process.exit(1);
  }
}
