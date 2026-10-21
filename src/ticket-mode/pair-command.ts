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
// person types no path. The terminal's code is printed only when the terminal is served for this instance, or when `--terminal` asks for it. Whether it is served, and under what
// name, is the exposure plugin's to say (A11-162).
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
import { activatePlugins, realPluginDeps } from "../plugins/active.ts";
import type { Exposure, ServedPorts } from "../plugins/contracts/exposure.ts";
import { defaultCatalog } from "../plugins/registry.ts";
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

/** What the exposure says of this board: the ports it serves the page and the terminal on (null when it serves nothing), and the name it answers to (null while it has none). */
export type Exposed = Readonly<{ ports: ServedPorts | null; name: string | null; terminal: (port: number) => string | null }>;

/**
 * Why this machine has no terminal on `port` to pair: `tickets.terminal` is not set, is another machine's, or cannot be told apart from this
 * machine's because the exposure cannot name it. Null when there is no terminal to say anything about. PURE.
 */
export function unservedTerminal(settings: TicketSettings, exposed: Exposed): string | null {
  if (settings.terminal === null) return "tickets.terminal is not set, so this machine serves no worker terminal: run `agent-org onboard`";
  if (exposed.ports !== null && exposed.name === null) {
    return `tickets.terminal is ${settings.terminal}, and this machine's name cannot be read from the exposure, so it cannot tell whether that terminal is its own: fix the exposure (\`agent-org doctor\` says what), then run \`agent-org ticket:pair\` again`;
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
  /** What the exposure says of this board. Asked once, and only the name is read from the machine, and only when the exposure serves the terminal. */
  exposed: () => Promise<Exposed>;
  out: (text: string) => void;
  err: (text: string) => void;
}>;

/** The address a person opens to pair the terminal: the exposure's when it serves the terminal under a name, else this machine's loopback address. */
function terminalPage(port: number, exposed: Exposed): string {
  const served = exposed.ports === null || exposed.name === null ? null : exposed.terminal(exposed.ports.terminal);
  return served === null ? `http://127.0.0.1:${port}/` : `${served.split("?")[0]}`;
}

/**
 * Prints the codes `mode` names, and returns the exit status. A board code that cannot be had is said and does not stop the terminal's; a
 * terminal that cannot pair exits 1 with the fix, after the board's code is printed. With no flag, the terminal's code is printed only when
 * the terminal is served for this instance (the exposure serves it, and `tickets.terminal` is on this machine's loopback or its own name).
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
  const exposed = await deps.exposed();
  const port = localTerminalPort(settings.terminal, exposed.name);
  if (port === null) {
    // Only a served board says so, and only when a terminal is set: a plain board has nothing to say about a terminal it does not serve.
    const why = unservedTerminal(settings, exposed);
    if (mode === "terminal") {
      deps.err(`ticket:pair: ${why}\n`);
      return 1;
    }
    if (exposed.ports !== null && why !== null && settings.terminal !== null) deps.out(`${why}\n`);
    return status;
  }
  if (mode === "both" && exposed.ports === null) return status;
  const program = terminalPair(settings, port, deps.terminal());
  if (typeof program === "string") {
    deps.err(`ticket:pair: ${program}\n`);
    return 1;
  }
  if (deps.run(program) !== 0) {
    deps.err("ticket:pair: the worker terminal gave no pairing code: start it with `agent-org start terminal`, then run `agent-org ticket:pair --terminal` again\n");
    return 1;
  }
  deps.out(`  open ${terminalPage(port, exposed)} within ${TERMINAL_MINUTES} minutes, and enter the code there. It works once.\n`);
  return status;
}

/** What the exposure says of this board: it names a machine only when it serves a port, so a loopback-only exposure is never asked. */
export function exposedBy(exposure: Exposure): () => Promise<Exposed> {
  return async () => {
    const ports = exposure.ports();
    const name = ports === null ? null : await exposure.machineName();
    return { ports, name, terminal: (port) => (name === null ? null : exposure.terminal({ name, port })) };
  };
}

/** The real dependencies: this process's environment and home, the plugin run with its output on this terminal, and the exposure's say. */
export function defaultPairDeps(settings: TicketSettings, exposure: Exposure): PairDeps {
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
    exposed: exposedBy(exposure),
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
  // The exposure alone: pairing reads no tracker key.
  (async () => {
    const settings = readTicketSettings();
    const active = await activatePlugins(settings.providers, defaultCatalog(), realPluginDeps({ env: process.env, stateDir: settings.stateDir, pick: settings.pick, clones: settings.clones }), undefined, ["exposure"]);
    return runPair(mode, settings, defaultPairDeps(settings, active.exposure()));
  })().then((status) => process.exit(status), (err) => {
    process.stderr.write(`ticket:pair: ${String((err as Error)?.message ?? err)}\n`);
    process.exit(1);
  });
}
