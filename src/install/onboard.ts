#!/usr/bin/env node
// @ts-check
// command: onboard -- write the host file (the repositories the instance offers, where the tracker key is read from), set up the web terminal, Linear's MCP and auto-update, and start the services
//
// IT ASKS FOR WHAT NO FLAG GAVE, and only at a terminal. `--repo <name>=<path>` (repeated) names the checkouts a worker can choose from, and
// `--linear-keychain <service>` or `--linear-key-file <path>` names where the Linear key is read from. Without a terminal, what no flag gave is
// kept from the existing host file or refused by name. A host file that holds other keys keeps them: onboard writes `clones`, `tickets.linearKey`,
// and `tickets.terminal` and `tickets.connectors` where they are absent, and nothing else.
//
// IT SETS UP WHAT TICKET MODE NEEDS TO WORK OUT OF THE BOX, each of which was done by hand on the agents host on 2026-10-17:
//   - THE WEB TERMINAL (A11-66). The board links a run to its live worker only when `tickets.terminal` is set and herdr web ui serves the tickets
//     session. Onboard installs bun when the machine has none (`bun.ts`: no `unzip`, no `sudo`), installs the plugin with
//     `herdr plugin install devswha/herdr-web-ui --yes`, writes `tickets.terminal` when it is absent, and starts the `terminal` service. A step
//     that fails is said with its reason and leaves `tickets.terminal` unwritten, so the board never links to a terminal nothing serves.
//   - LINEAR FOR THE WORKERS (A11-71). Workers and planners read their ticket, its parent and its blockers through Linear's MCP. With a readable
//     key and no `linear` MCP yet, onboard registers Linear's for Claude Code at user scope, authenticated by that key, and lets the workers call
//     its read and comment tools (`LINEAR_CONNECTORS`). The key goes to `claude` as an argument and is never printed: a message that would carry
//     it carries `<key>` instead.
//   - THE HOST FILE'S PATH, in `<home>/host-file` (A11-68), so a shell with no `AGENT_ORG_HOST`, such as `ssh <machine> agent-org ...`, finds it.
//   - AUTO-UPDATE: the `auto-update` service runs `agent-org update` every hour, which restarts the services only when the checkout moved.
//     `--no-auto-update` leaves it unregistered, and `--update-channel main` makes it follow `main` instead of releases.
//
// IT NEVER ECHOES A KEY. It stores one only when none is readable and a person is at the terminal: into the Keychain by `security`'s own prompt,
// which does not echo, or into a mode-600 file from a prompt that does not echo. It then reads the key back to check it is there, and says WHERE
// it is, never what it is.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { readLinearKey } from "../ticket-mode/linear.ts";
import type { KeySource } from "../ticket-mode/settings.ts";
import { agentOrgHome, hostFilePath, hostPointerPath, readOrNull, type Env } from "./paths.ts";
import { ensureBun } from "./bun.ts";
import { defaultServiceDeps, ServiceRefusal, startService, TailnetRefusal, updateChannelPath, type RunResult, type ServiceName, type Started, type UpdateChannel } from "./service.ts";
import { DEFAULT_TERMINAL_PORT, herdrConfigDir, pluginRoot, TERMINAL_PLUGIN, terminalAddress } from "./terminal.ts";
import { writeAtomic } from "./write-atomic.ts";

export const DEFAULT_KEYCHAIN_SERVICE = "agent-org-linear";
export const LINEAR_MCP_URL = "https://mcp.linear.app/mcp";
/** Linear's MCP tools a worker may call: its reads, and a comment on its own ticket. Never a save of an issue, a state or a relation. */
export const LINEAR_CONNECTORS = Object.freeze(["^mcp__linear__(get|list|search|extract)_", "^mcp__linear__save_comment$"]);

export type OnboardOptions = Readonly<{
  repos: readonly string[];
  keychain: string | undefined;
  keyFile: string | undefined;
  start: boolean;
  /** Set up the web terminal (`--no-terminal` leaves it alone). */
  terminal: boolean;
  /** Register the auto-update service (`--no-auto-update` does not). */
  autoUpdate: boolean;
  /** The channel auto-update follows, written to `<home>/update-channel`; undefined leaves the file as it is. */
  updateChannel: UpdateChannel | undefined;
}>;

export type OnboardDeps = Readonly<{
  env: Env;
  home: string;
  platform: NodeJS.Platform;
  /** A person is at the terminal, so what no flag gave can be asked. */
  interactive: boolean;
  ask: (question: string) => Promise<string>;
  /** Ask without echoing what is typed. */
  askHidden: (question: string) => Promise<string>;
  readKey: (source: KeySource) => string;
  /** Store a key in the Keychain under `service`, by `security`'s own prompt. */
  storeInKeychain: (service: string) => void;
  readFile: (path: string) => string;
  writeFile: (path: string, text: string) => void;
  isDirectory: (path: string) => boolean;
  /** The `bun` this machine has, installed into `~/.bun/bin` when it has none. */
  ensureBun: () => Promise<{ path: string; installed: boolean }>;
  /** The text of herdr's `plugins.json`, or null. */
  herdrPlugins: () => string | null;
  /** Run a program (`herdr`, `claude`) with `env` added to this process's, and say what it returned. */
  run: (file: string, args: string[], env?: Env) => RunResult;
  /** Start the named services, in order. @returns one line per service */
  startServices: (names: readonly ServiceName[]) => string;
  out: Pick<Console, "log">;
}>;

export class OnboardRefusal extends Error {}

const expandHome = (path: string, home: string) => (path === "~" || path.startsWith("~/") ? join(home, path.slice(1)) : path);

/** `name=/path`, or a bare path named after its last directory. REFUSES a relative path and one that is not a directory. */
function parseRepo(text: string, deps: OnboardDeps): [string, string] {
  const at = text.indexOf("=");
  const [name, raw] = at > 0 ? [text.slice(0, at), text.slice(at + 1)] : [basename(text.replace(/\/+$/, "")), text];
  const path = expandHome(raw.trim(), deps.home);
  if (!isAbsolute(path)) throw new OnboardRefusal(`--repo ${text}: the checkout must be an absolute path`);
  if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new OnboardRefusal(`--repo ${text}: a repository name is letters, digits, \`.\`, \`_\` and \`-\``);
  if (!deps.isDirectory(path)) throw new OnboardRefusal(`--repo ${text}: ${path} is not a directory`);
  return [name, resolve(path)];
}

function readHost(path: string, deps: OnboardDeps): Record<string, unknown> {
  let text: string;
  try {
    text = deps.readFile(path);
  } catch {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new OnboardRefusal(`${path} is not valid JSON, so onboard will not write over it. Fix or move it, then run onboard again.`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new OnboardRefusal(`${path} does not hold a JSON object`);
  return parsed as Record<string, unknown>;
}

/** A Keychain service name is printed in a command to paste, so it is held to characters a shell reads as they are. */
function keychainService(name: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new OnboardRefusal(`\`${name}\` is not a Keychain service name: use letters, digits, \`.\`, \`_\` and \`-\``);
  return name;
}

const describe = (source: KeySource) => ("keychain" in source ? `the Keychain service ${source.keychain}` : `the file ${source.path}`);

function keyReadable(source: KeySource, deps: OnboardDeps): boolean {
  try {
    deps.readKey(source);
    return true;
  } catch {
    return false;
  }
}

async function chooseKeySource(options: OnboardOptions, existing: unknown, deps: OnboardDeps): Promise<KeySource> {
  if (options.keychain !== undefined && options.keyFile !== undefined) throw new OnboardRefusal("give --linear-keychain or --linear-key-file, not both");
  if (options.keychain !== undefined) return { keychain: keychainService(options.keychain) };
  if (options.keyFile !== undefined) {
    const path = expandHome(options.keyFile, deps.home);
    if (!isAbsolute(path)) throw new OnboardRefusal("--linear-key-file must be an absolute path");
    return { path };
  }
  if (typeof existing === "object" && existing !== null) return existing as KeySource;
  const fallback: KeySource = deps.platform === "darwin" ? { keychain: DEFAULT_KEYCHAIN_SERVICE } : { path: join(agentOrgHome(deps.env, deps.home), "linear.key") };
  if (!deps.interactive) return fallback;
  const answer = (await deps.ask(`Where is the Linear key read from? A Keychain service name, or an absolute file path [${"keychain" in fallback ? fallback.keychain : fallback.path}]: `)).trim();
  if (answer === "") return fallback;
  const path = expandHome(answer, deps.home);
  return isAbsolute(path) ? { path } : { keychain: keychainService(answer) };
}

/** Store a key where `source` says, by a prompt that does not echo. Only called with a person at the terminal. */
async function storeKey(source: KeySource, deps: OnboardDeps) {
  if ("keychain" in source) {
    deps.out.log(`Paste your Linear personal API key at the Keychain prompt (it is not shown). It is stored under ${source.keychain}.`);
    deps.storeInKeychain(source.keychain);
    return;
  }
  const key = (await deps.askHidden(`Paste your Linear personal API key (it is not shown). It is written to ${source.path}, mode 600: `)).trim();
  if (key === "") return;
  deps.writeFile(source.path, `${key}\n`);
}

/** The services onboard starts: the instance and the ui always, then the terminal when it is set up and auto-update unless opted out. */
export function onboardServices(terminal: boolean, autoUpdate: boolean): ServiceName[] {
  return ["instance", "ui", ...(terminal ? ["terminal" as const] : []), ...(autoUpdate ? ["auto-update" as const] : [])];
}

/** The services onboard REQUIRES: one of these refusing to start fails onboard, and any other is said and passed over. */
const REQUIRED: readonly ServiceName[] = ["instance", "ui"];

/** Start `names`, in order. @returns one line per service */
export function startServices(names: readonly ServiceName[], start: (name: ServiceName) => Started): string {
  return names.map((name) => {
    try {
      const unit = start(name);
      return `started the ${name} service (${unit.manager} ${unit.id})${unit.address === null ? "" : `, on the tailnet at ${unit.address}`}`;
    } catch (err) {
      if (REQUIRED.includes(name) || !(err instanceof ServiceRefusal)) throw err;
      // A service that started on loopback and that the tailnet does not reach is running: its message says so, and is said as it is.
      if (err instanceof TailnetRefusal) return err.message;
      return `did not start the ${name} service: ${err.message}`;
    }
  }).join("\n");
}

/** `text` with every occurrence of `secret` replaced by `<key>`, for a message a program that was handed the key may echo. */
const scrub = (text: string, secret: string) => (secret === "" ? text : text.split(secret).join("<key>"));
const firstLine = (result: RunResult) => (result.stderr || result.stdout).trim().split("\n")[0] || `exit ${result.status}`;

/**
 * Install bun and herdr web ui when they are missing. @returns whether the terminal service can run. A step that fails is said, with why,
 * and answers false: the web terminal is a convenience, and an install without it still runs tickets.
 */
async function setUpTerminal(deps: OnboardDeps): Promise<boolean> {
  try {
    const bun = await deps.ensureBun();
    if (bun.installed) deps.out.log(`installed bun at ${bun.path}, for the web terminal`);
    if (pluginRoot(deps.herdrPlugins()) === null) {
      const bunDir = bun.path.slice(0, bun.path.lastIndexOf("/"));
      // The plugin's build runs `bun install`, so bun's directory leads the PATH it runs with.
      const installed = deps.run("herdr", ["plugin", "install", TERMINAL_PLUGIN, "--yes"], { PATH: `${bunDir}:${deps.env.PATH ?? "/usr/bin:/bin"}` });
      if (installed.status !== 0) throw new OnboardRefusal(`\`herdr plugin install ${TERMINAL_PLUGIN} --yes\` failed: ${firstLine(installed)}`);
      if (pluginRoot(deps.herdrPlugins()) === null) throw new OnboardRefusal(`herdr installed ${TERMINAL_PLUGIN}, but its plugins.json does not list it`);
      deps.out.log(`installed the herdr plugin ${TERMINAL_PLUGIN}, the web terminal`);
    }
    return true;
  } catch (err) {
    deps.out.log(`the web terminal is not set up: ${(err as Error).message}. The board shows no terminal link until it is; fix that, then run \`agent-org onboard\` again.`);
    return false;
  }
}

/** Register Linear's MCP for Claude Code at user scope, unless a `linear` MCP is there already. Says what it did, never the key. */
function registerLinearMcp(source: KeySource, deps: OnboardDeps) {
  if (deps.run("claude", ["mcp", "get", "linear"]).status === 0) {
    deps.out.log("Claude Code has a `linear` MCP already, so onboard left it as it is");
    return;
  }
  const key = deps.readKey(source).trim();
  const added = deps.run("claude", ["mcp", "add", "--scope", "user", "--transport", "http", "linear", LINEAR_MCP_URL, "--header", `Authorization: Bearer ${key}`]);
  deps.out.log(added.status === 0
    ? `registered Linear's MCP for Claude Code (user scope), authenticated by the key in ${describe(source)}`
    : `could not register Linear's MCP for Claude Code: ${scrub(firstLine(added), key)}. Workers cannot read Linear until it is; run \`agent-org onboard\` again, or \`claude mcp add --scope user --transport http linear ${LINEAR_MCP_URL} --header "Authorization: Bearer <key>"\``);
}

/** `tickets.connectors` with Linear's read and comment tools added where absent. A value that is not a list is left for the board to refuse. */
function withLinearConnectors(connectors: unknown): unknown {
  if (connectors === undefined) return [...LINEAR_CONNECTORS];
  if (!Array.isArray(connectors)) return connectors;
  return [...connectors, ...LINEAR_CONNECTORS.filter((pattern) => !connectors.includes(pattern))];
}

/** Write the host file and start the services. @returns the host file's path */
export async function onboard(options: OnboardOptions, deps: OnboardDeps): Promise<string> {
  const hostFile = hostFilePath(deps.env, deps.home, (path) => {
    try {
      return deps.readFile(path);
    } catch {
      return null;
    }
  });
  const host = readHost(hostFile, deps);
  const tickets = (typeof host.tickets === "object" && host.tickets !== null && !Array.isArray(host.tickets) ? host.tickets : {}) as Record<string, unknown>;
  const clones: Record<string, string> = typeof host.clones === "object" && host.clones !== null ? { ...(host.clones as Record<string, string>) } : {};

  const repos = [...options.repos];
  if (repos.length === 0 && deps.interactive) {
    deps.out.log("Name the repositories a worker can choose from: one checkout path per line, or name=path. An empty line finishes.");
    for (let line = (await deps.ask("Repository: ")).trim(); line !== ""; line = (await deps.ask("Repository: ")).trim()) repos.push(line);
  }
  for (const repo of repos) {
    const [name, path] = parseRepo(repo, deps);
    clones[name] = path;
  }
  if (Object.keys(clones).length === 0) throw new OnboardRefusal("no repository to offer: give at least one --repo <name>=<path>");

  const source = await chooseKeySource(options, tickets.linearKey, deps);
  if (!keyReadable(source, deps) && deps.interactive) await storeKey(source, deps);
  const readable = keyReadable(source, deps);

  const terminal = options.terminal && await setUpTerminal(deps);
  const next: Record<string, unknown> = { ...tickets, linearKey: source };
  // An existing address is kept: it may name another port, or a terminal served elsewhere.
  if (terminal && next.terminal === undefined) next.terminal = terminalAddress(DEFAULT_TERMINAL_PORT);
  if (readable) next.connectors = withLinearConnectors(next.connectors);

  deps.writeFile(hostFile, `${JSON.stringify({ ...host, clones, tickets: next }, null, 2)}\n`);
  deps.writeFile(hostPointerPath(deps.env, deps.home), `${hostFile}\n`);
  if (options.updateChannel !== undefined) deps.writeFile(updateChannelPath(deps.env, deps.home), `${options.updateChannel}\n`);
  deps.out.log(`wrote ${hostFile}: ${Object.keys(clones).length} repositories (${Object.keys(clones).sort().join(", ")})`);
  deps.out.log(readable
    ? `the Linear key is readable from ${describe(source)}`
    : `NO LINEAR KEY is readable from ${describe(source)}. ${"keychain" in source
      ? `Store one with: security add-generic-password -a "$USER" -s ${source.keychain} -w`
      : `Write it to ${source.path} with mode 600`}, then run \`agent-org doctor\`.`);
  if (readable) registerLinearMcp(source, deps);
  if (options.start) deps.out.log(deps.startServices(onboardServices(terminal, options.autoUpdate)));
  return hostFile;
}

/** A readline whose output can be muted, so what is typed after the question is not echoed. */
async function askHidden(question: string): Promise<string> {
  let muted = false;
  const output = new Writable({ write(chunk, _encoding, done) { if (!muted) process.stdout.write(chunk); done(); } });
  const lines = createInterface({ input: process.stdin, output, terminal: true });
  try {
    const answer = lines.question(question);
    muted = true;
    return await answer;
  } finally {
    process.stdout.write("\n");
    lines.close();
  }
}

async function ask(question: string): Promise<string> {
  const lines = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await lines.question(question);
  } finally {
    lines.close();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ? realpathSync(process.argv[1]) : "").href) {
  try {
    const { values } = parseArgs({
      args: process.argv.slice(2), strict: true,
      options: {
        repo: { type: "string", multiple: true, default: [] }, "linear-keychain": { type: "string" }, "linear-key-file": { type: "string" },
        "no-start": { type: "boolean", default: false }, "no-terminal": { type: "boolean", default: false },
        "no-auto-update": { type: "boolean", default: false }, "update-channel": { type: "string" },
      },
    });
    const channel = values["update-channel"];
    if (channel !== undefined && channel !== "release" && channel !== "main") throw new OnboardRefusal(`--update-channel ${channel} is not release or main`);
    const services = defaultServiceDeps();
    const home = homedir();
    await onboard({
      repos: values.repo, keychain: values["linear-keychain"], keyFile: values["linear-key-file"], start: !values["no-start"],
      terminal: !values["no-terminal"], autoUpdate: !values["no-auto-update"], updateChannel: channel,
    }, {
      env: process.env, home, platform: process.platform, interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
      ask, askHidden, readKey: (source) => readLinearKey(source),
      storeInKeychain: (service) => {
        // `security` prompts for the password itself when `-w` is last and has no value, and does not echo it.
        const result = spawnSync("security", ["add-generic-password", "-U", "-a", process.env.USER ?? "", "-s", service, "-w"], { stdio: "inherit" });
        if (result.status !== 0) throw new OnboardRefusal(`security add-generic-password exited ${result.status}`);
      },
      readFile: (path) => readFileSync(path, "utf8"), writeFile: (path, text) => writeAtomic(path, text, 0o600),
      isDirectory: (path) => existsSync(path) && statSync(path).isDirectory(),
      ensureBun: () => ensureBun({
        home, env: process.env, platform: process.platform, arch: process.arch, exists: existsSync,
        download: async (url) => {
          const response = await fetch(url);
          if (!response.ok) throw new OnboardRefusal(`${url} answered ${response.status}`);
          return Buffer.from(await response.arrayBuffer());
        },
        writeExecutable: (path, data) => writeAtomic(path, data, 0o755),
      }),
      herdrPlugins: () => readOrNull(join(herdrConfigDir(process.env, home), "plugins.json")),
      run: (file, args, env = {}) => {
        const result = spawnSync(file, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...env }, timeout: 600_000 });
        if (result.error) return { status: null, stdout: "", stderr: result.error.message };
        return { status: result.status, stdout: result.stdout, stderr: result.stderr };
      },
      startServices: (names) => startServices(names, (name) => startService(name, services)),
      out: console,
    });
  } catch (err) {
    console.error(`agent-org onboard: ${(err as Error).message}`);
    process.exitCode = 2;
  }
}
