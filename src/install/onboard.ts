#!/usr/bin/env node
// @ts-check
// command: onboard -- write the host file (the repositories the instance offers, where the tracker key is read from) and start the instance and ui services
//
// IT ASKS FOR WHAT NO FLAG GAVE, and only at a terminal. `--repo <name>=<path>` (repeated) names the checkouts a worker can choose from, and
// `--linear-keychain <service>` or `--linear-key-file <path>` names where the Linear key is read from. Without a terminal, what no flag gave is
// kept from the existing host file or refused by name. A host file that holds other keys keeps them: onboard writes `clones` and `tickets.linearKey`
// and nothing else.
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
import { agentOrgHome, hostFilePath, type Env } from "./paths.ts";
import { defaultServiceDeps, SERVICE_NAMES, startService, type ServiceName, type Unit } from "./service.ts";
import { writeAtomic } from "./write-atomic.ts";

export const DEFAULT_KEYCHAIN_SERVICE = "agent-org-linear";

export type OnboardOptions = Readonly<{
  repos: readonly string[];
  keychain: string | undefined;
  keyFile: string | undefined;
  start: boolean;
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
  startService: () => string;
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

/** Start every service, the instance and the ui, in that order. @returns one line per service started */
export function startServices(start: (name: ServiceName) => Unit): string {
  return SERVICE_NAMES.map((name) => {
    const unit = start(name);
    return `started the ${name} service (${unit.manager} ${unit.id})`;
  }).join("\n");
}

/** Write the host file and start the services. @returns the host file's path */
export async function onboard(options: OnboardOptions, deps: OnboardDeps): Promise<string> {
  const hostFile = hostFilePath(deps.env, deps.home);
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

  deps.writeFile(hostFile, `${JSON.stringify({ ...host, clones, tickets: { ...tickets, linearKey: source } }, null, 2)}\n`);
  deps.out.log(`wrote ${hostFile}: ${Object.keys(clones).length} repositories (${Object.keys(clones).sort().join(", ")})`);
  deps.out.log(readable
    ? `the Linear key is readable from ${describe(source)}`
    : `NO LINEAR KEY is readable from ${describe(source)}. ${"keychain" in source
      ? `Store one with: security add-generic-password -a "$USER" -s ${source.keychain} -w`
      : `Write it to ${source.path} with mode 600`}, then run \`agent-org doctor\`.`);
  if (options.start) deps.out.log(deps.startService());
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
      options: { repo: { type: "string", multiple: true, default: [] }, "linear-keychain": { type: "string" }, "linear-key-file": { type: "string" }, "no-start": { type: "boolean", default: false } },
    });
    const services = defaultServiceDeps();
    await onboard({ repos: values.repo, keychain: values["linear-keychain"], keyFile: values["linear-key-file"], start: !values["no-start"] }, {
      env: process.env, home: homedir(), platform: process.platform, interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
      ask, askHidden, readKey: (source) => readLinearKey(source),
      storeInKeychain: (service) => {
        // `security` prompts for the password itself when `-w` is last and has no value, and does not echo it.
        const result = spawnSync("security", ["add-generic-password", "-U", "-a", process.env.USER ?? "", "-s", service, "-w"], { stdio: "inherit" });
        if (result.status !== 0) throw new OnboardRefusal(`security add-generic-password exited ${result.status}`);
      },
      readFile: (path) => readFileSync(path, "utf8"), writeFile: (path, text) => writeAtomic(path, text, 0o600),
      isDirectory: (path) => existsSync(path) && statSync(path).isDirectory(),
      startService: () => startServices((name) => startService(name, services)),
      out: console,
    });
  } catch (err) {
    console.error(`agent-org onboard: ${(err as Error).message}`);
    process.exitCode = 2;
  }
}
