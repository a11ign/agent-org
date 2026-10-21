// @ts-check
// module: a stand-in for the `tailscale` command that holds a serve config in memory or in a file (A11-162) -- for the Tailscale plugin's tests, core's, and the acceptance block
//
// IT ANSWERS THE FOUR CALLS THE PLUGIN MAKES, in the shapes Tailscale prints them: `status --json`, `serve status --json`, `serve --bg --https=<port> [--set-path=<path>] <target>` and its
// `off`, and the same two as `funnel` (which also opens the port to the internet). It can be told to refuse the way Tailscale does for a user who is not its operator, to be stopped, or to have
// no name. A test uses `createTailscale(state)`, a function with `exec`'s shape. The acceptance block runs this file as the `tailscale` on PATH (`node tailscale-stub.ts <args>`), with its state in
// the JSON file `TAILSCALE_STUB_STATE` names, so a second process sees what the first served. No network, no daemon, and nothing of the machine is read.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import type { ExecResult } from "../../src/plugins/manifest.ts";

/** What the stub holds: the machine it pretends to be, whether it may change the serve config, and the serve config itself. */
export type TailscaleState = {
  name: string | null;
  ip: string;
  /** Tailscale's BackendState: `Running` serves, anything else does not. */
  backend: string;
  /** Whether the user is the operator: when false, a change is refused with Tailscale's "Access denied". */
  operator: boolean;
  web: Record<string, { Handlers: Record<string, { Proxy: string }> }>;
  funnel: Record<string, boolean>;
  /** Every command it was given, in order, so a test says what was run and what was not. */
  calls: string[][];
};

export const freshState = (over: Partial<TailscaleState> = {}): TailscaleState => ({ name: "agents.tail1234.ts.net", ip: "100.64.0.7", backend: "Running", operator: true, web: {}, funnel: {}, calls: [], ...over });

const ok = (stdout = ""): ExecResult => ({ status: 0, stdout, stderr: "" });
const denied: ExecResult = { status: 1, stdout: "", stderr: "Access denied: serve config denied\nuse 'sudo tailscale set --operator=$USER' to change" };

/** The value of `--flag=value` among `args`, or undefined. */
const flagOf = (args: readonly string[], flag: string): string | undefined => args.find((arg) => arg.startsWith(`--${flag}=`))?.slice(flag.length + 3);

/** Runs one `tailscale` command against `state`, changing it as Tailscale would. */
export function runTailscale(state: TailscaleState, args: readonly string[]): ExecResult {
  state.calls.push([...args]);
  const [command, ...rest] = args;
  if (command === "status") {
    return ok(JSON.stringify({ BackendState: state.backend, Self: state.name === null ? {} : { DNSName: `${state.name}.`, TailscaleIPs: [state.ip] } }));
  }
  if (command === "version") return ok("1.80.0\n");
  if (command !== "serve" && command !== "funnel") return { status: 1, stdout: "", stderr: `tailscale: unknown command ${command}` };
  if (rest[0] === "status") return ok(Object.keys(state.web).length === 0 ? "" : JSON.stringify({ TCP: {}, Web: state.web, AllowFunnel: state.funnel }));
  if (state.backend !== "Running" || state.name === null) return { status: 1, stdout: "", stderr: "Tailscale is stopped." };
  if (!state.operator) return denied;
  const port = flagOf(rest, "https");
  if (port === undefined) return { status: 1, stdout: "", stderr: "serve: --https is required here" };
  const key = `${state.name}:${port}`;
  const path = flagOf(rest, "set-path") ?? "/";
  if (rest.includes("off")) {
    const entry = state.web[key];
    if (entry !== undefined) {
      delete entry.Handlers[path];
      if (Object.keys(entry.Handlers).length === 0) {
        delete state.web[key];
        delete state.funnel[key];
      }
    }
    return ok();
  }
  const target = rest[rest.length - 1];
  const entry = (state.web[key] ??= { Handlers: {} });
  entry.Handlers[path] = { Proxy: target };
  if (command === "funnel") state.funnel[key] = true;
  return ok();
}

/** A `tailscale` that is `exec`'s shape: `createTailscale(state)("tailscale", args)`. A program that is not `tailscale` cannot start. */
export function createTailscale(state: TailscaleState): (file: string, args: readonly string[]) => ExecResult {
  return (file, args) => (file === "tailscale" ? runTailscale(state, args) : { status: null, stdout: "", stderr: `${file}: not found` });
}

/** The stub as a command: its state is the JSON file `TAILSCALE_STUB_STATE` names (created fresh when absent), saved after every call. */
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const file = process.env.TAILSCALE_STUB_STATE;
  if (file === undefined) {
    process.stderr.write("tailscale-stub: TAILSCALE_STUB_STATE names the file its state is kept in\n");
    process.exit(2);
  }
  const state: TailscaleState = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : freshState();
  const result = runTailscale(state, process.argv.slice(2));
  writeFileSync(file, JSON.stringify(state, null, 2));
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exitCode = result.status ?? 1;
}
