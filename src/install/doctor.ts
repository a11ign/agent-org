#!/usr/bin/env node
// @ts-check
// command: doctor -- check an install: Node, the launcher on PATH, the host file, herdr, the tracker key and the instance service, each with its fix
//
// EACH CHECK SAYS WHAT IT FOUND AND, WHEN IT FAILED, THE ONE THING TO DO. `node` is the one on PATH, because that is the one the launcher runs, and
// not the one running this. The tracker key is read to prove it is there, and never printed. The service is asked twice: whether it is registered,
// and whether its port answers, because a registered service can still be a crashed one.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { request } from "node:http";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { readLinearKey } from "../ticket-mode/linear.ts";
import { parseTicketSettings, type KeySource, type TicketSettings } from "../ticket-mode/settings.ts";
import { hostFilePath, type Env } from "./paths.ts";
import { defaultServiceDeps, SERVICE_NAMES, serviceState, type ServiceName, type ServiceState } from "./service.ts";

export const MIN_NODE_MAJOR = 24;

export type Check = Readonly<{ name: string; ok: boolean; detail: string; fix: string | null }>;

export type DoctorDeps = Readonly<{
  env: Env;
  home: string;
  /** `node --version` of the `node` on PATH, or null when there is none. */
  nodeVersion: () => string | null;
  /** The first executable called `name` on PATH, or null. */
  which: (name: string) => string | null;
  readFile: (path: string) => string;
  readKey: (source: KeySource) => string;
  /** A file's permission bits, or null when it cannot be read. */
  mode: (path: string) => number | null;
  serviceState: (name: ServiceName) => ServiceState;
  /** Whether something answers HTTP on 127.0.0.1:`port`. */
  answers: (port: number) => Promise<boolean>;
}>;

const ok = (name: string, detail: string): Check => ({ name, ok: true, detail, fix: null });
const failed = (name: string, detail: string, fix: string): Check => ({ name, ok: false, detail, fix });

function nodeCheck(deps: DoctorDeps): Check {
  const version = deps.nodeVersion();
  const install = `install Node ${MIN_NODE_MAJOR} or newer from https://nodejs.org, or with your version manager (\`fnm install ${MIN_NODE_MAJOR}\`, \`nvm install ${MIN_NODE_MAJOR}\`)`;
  if (version === null) return failed("node", "no `node` on PATH", install);
  const major = Number(/^v?(\d+)\./.exec(version)?.[1]);
  return major >= MIN_NODE_MAJOR ? ok("node", version) : failed("node", `${version} is older than ${MIN_NODE_MAJOR}`, install);
}

function hostCheck(deps: DoctorDeps): { check: Check; settings: TicketSettings | null } {
  const path = hostFilePath(deps.env, deps.home);
  let text: string;
  try {
    text = deps.readFile(path);
  } catch {
    return { check: failed("host file", `${path} cannot be read`, "run `agent-org onboard`"), settings: null };
  }
  try {
    const settings = parseTicketSettings(JSON.parse(text), deps.home);
    return { check: ok("host file", `${path}: ${Object.keys(settings.clones).length} repositories`), settings };
  } catch (err) {
    return { check: failed("host file", `${path}: ${(err as Error).message}`, `fix the field it names, or run \`agent-org onboard\``), settings: null };
  }
}

function keyCheck(settings: TicketSettings | null, deps: DoctorDeps): Check {
  if (settings === null) return failed("tracker key", "not checked: the host file did not parse", "fix the host file first");
  const source = settings.linearKey;
  const where = "keychain" in source ? `Keychain service ${source.keychain}` : source.path;
  try {
    deps.readKey(source);
    const file = "keychain" in source ? null : source.path;
    const mode = file === null ? null : deps.mode(file);
    if (mode !== null && (mode & 0o077) !== 0) {
      return failed("tracker key", `${file} can be read by other users (mode ${(mode & 0o777).toString(8)})`, `chmod 600 ${file}`);
    }
    return ok("tracker key", `readable from ${where}`);
  } catch {
    return failed("tracker key", `nothing readable at ${where}`, "keychain" in source
      ? `security add-generic-password -a "$USER" -s ${source.keychain} -w`
      : `write your Linear personal API key to ${source.path} with mode 600, or run \`agent-org onboard\``);
  }
}

/** Every check, in the order a person fixes them. */
export async function diagnose(deps: DoctorDeps): Promise<Check[]> {
  const { check: host, settings } = hostCheck(deps);
  const launcher = deps.which("agent-org");
  const herdr = deps.which("herdr");
  const ports: Record<ServiceName, number> = { instance: settings?.port ?? 4747, ui: settings?.uiPort ?? 4748 };
  const services = await Promise.all(SERVICE_NAMES.map((name) => serviceChecks(name, ports[name], deps)));
  return [
    nodeCheck(deps),
    launcher === null
      ? failed("launcher", "`agent-org` is not on PATH", `add its directory to PATH: export PATH="$HOME/.local/bin:$PATH" in your shell's rc file`)
      : ok("launcher", launcher),
    host,
    herdr === null ? failed("herdr", "`herdr` is not on PATH", "install herdr, which runs the workers' terminals, and put it on PATH") : ok("herdr", herdr),
    keyCheck(settings, deps),
    ...services.flat(),
  ];
}

/** Whether `name` is registered, and whether its port answers. */
async function serviceChecks(name: ServiceName, port: number, deps: DoctorDeps): Promise<Check[]> {
  const state = deps.serviceState(name);
  const answering = state === "running" && await deps.answers(port);
  const start = `run \`agent-org start ${name}\``;
  return [
    state === "not-registered"
      ? failed(`${name} service`, `the ${name} service is not registered`, start)
      : ok(`${name} service`, `the ${name} service is registered and ${state}`),
    answering
      ? ok(`${name} answering`, `http://127.0.0.1:${port} answers`)
      : failed(`${name} answering`, `nothing answers on http://127.0.0.1:${port}`, state === "running" ? `read the service's log, then ${start} to restart it` : start),
  ];
}

export function report(checks: readonly Check[]): string {
  return checks.map(({ name, ok: passed, detail, fix }) => (passed ? `ok    ${name}: ${detail}` : `FAIL  ${name}: ${detail}\n      fix: ${fix}`)).join("\n");
}

function which(name: string, env: Env = process.env): string | null {
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (dir !== "" && existsSync(join(dir, name))) return join(dir, name);
  }
  return null;
}

const ANSWER_TIMEOUT_MS = 2000;

function answers(port: number): Promise<boolean> {
  return new Promise((done) => {
    const call = request({ host: "127.0.0.1", port, path: "/", method: "GET", timeout: ANSWER_TIMEOUT_MS }, (response) => {
      response.resume();
      done(true);
    });
    call.on("timeout", () => call.destroy());
    call.on("error", () => done(false));
    call.end();
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ? realpathSync(process.argv[1]) : "").href) {
  parseArgs({ args: process.argv.slice(2), strict: true });
  const services = defaultServiceDeps();
  const checks = await diagnose({
    env: process.env, home: homedir(),
    nodeVersion: () => {
      const result = spawnSync("node", ["--version"], { encoding: "utf8" });
      return result.status === 0 ? result.stdout.trim() : null;
    },
    which: (name) => which(name), readFile: (path) => readFileSync(path, "utf8"), readKey: (source) => readLinearKey(source),
    mode: (path) => { try { return statSync(path).mode & 0o777; } catch { return null; } },
    serviceState: (name) => serviceState(name, services), answers,
  });
  console.log(report(checks));
  process.exitCode = checks.every((check) => check.ok) ? 0 : 1;
}
