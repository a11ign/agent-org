// no-token: none -- a scratch HOME with stub `security`, `claude`, `gh` and `node` (the browser install) on PATH; no network, no real account, no service started
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpDir } from "../lib/tmp-fixture.ts";
import { parseTicketSettings } from "../ticket-mode/settings.ts";
import { createBoard, type BoardDeps } from "../ticket-mode/server.ts";
import { createFakeCodeHost } from "../plugins/fakes/code-host.ts";
import { createFakeTracker } from "../plugins/fakes/tracker.ts";
import type { PluginsAnswer } from "../ticket-mode/plugins-api.ts";

// NOTHING HERE MAY TOUCH THE MACHINE IT RUNS ON. `tailscale serve`, `systemctl --user`, `launchctl` and `herdr` act on the whole machine, whatever `HOME` is: a throwaway HOME isolates files and no more
// (the agents host once lost its two tailnet serve entries while a demo ran). So each is a SPY on the scratch PATH, ahead of the real one: it records its arguments and changes nothing, and the
// tests assert what was called. The machine-wide programs a scratch run may ask are only the ones that read.
// A11-163 DONE-WHEN: "A fresh machine's onboard enables the Linear and GitHub plugins and the page shows them, ready for the laptop demo." This is the machine, scratch: a HOME with nothing
// in it, a profile that names the plugins, onboard run as its own process, `agent-org plugin list` run as its own process, and the board's `GET /api/plugins` over a socket on a free port.
const BIN = fileURLToPath(new URL("../bin.ts", import.meta.url));
const KEY = "lin_api_DEMOKEYDEMOKEYDEMO";
const TOKEN = "d".repeat(48);

/** The programs onboard and the plugins' checks run, as stubs: the Linear MCP is connected, the gh-stack extension is listed, and the browser install is a no-op. */
const STUBS: Readonly<Record<string, string>> = {
  security: '#!/bin/sh\nexit 44\n',
  claude: '#!/bin/sh\nif [ "$1 $2" = "mcp list" ]; then echo "linear: https://mcp.linear.app/mcp (HTTP) - ✔ Connected"; fi\nexit 0\n',
  gh: '#!/bin/sh\nif [ "$1" = "extension" ]; then echo "gh stack  github/gh-stack  v0.2.1"; else echo "[]"; fi\nexit 0\n',
  // The browser install is the one step of onboard that downloads: its stub answers success for it and runs the real node for anything else.
  node: `#!/bin/sh\ncase "$1" in *playwright-core/cli.js) exit 0;; esac\nexec "${process.execPath}" "$@"\n`,
};

/** The machine-wide programs, as spies: each appends its name and arguments to the log and exits 1, as a program that is not running does. */
const MACHINE_WIDE = ["tailscale", "systemctl", "launchctl", "herdr"] as const;
const spy = (name: string, log: string): string => `#!/bin/sh\necho "${name} $*" >> "${log}"\nexit 1\n`;

function scratchMachine() {
  const home = tmpDir("onboard-demo-");
  const bin = join(home, "stubs");
  mkdirSync(bin, { recursive: true });
  const log = join(home, "machine-wide-calls.log");
  writeFileSync(log, "");
  const programs = { ...STUBS, ...Object.fromEntries(MACHINE_WIDE.map((name) => [name, spy(name, log)])) };
  for (const [name, text] of Object.entries(programs)) {
    writeFileSync(join(bin, name), text);
    chmodSync(join(bin, name), 0o755);
  }
  const state = join(home, ".agent-org");
  mkdirSync(join(state, "profiles"), { recursive: true });
  const repo = join(home, "repos", "demo-app");
  mkdirSync(repo, { recursive: true });
  const keyFile = join(state, "linear.key");
  writeFileSync(keyFile, `${KEY}\n`, { mode: 0o600 });
  // A profile is a saved answer file with no secret in it: it names the plugins, and onboard installs and enables them.
  writeFileSync(join(state, "profiles", "laptop.json"), JSON.stringify({
    schema: 1, tracker: { provider: "linear" }, codeHost: { provider: "github" }, publish: { provider: "none" }, reviewer: { provider: "none" }, exposure: { provider: "local" },
    repos: [{ name: "demo-app", path: repo }],
  }));
  const env = { HOME: home, AGENT_ORG_HOME: state, AGENT_ORG_HOST: join(state, "host.json"), PATH: `${bin}:${process.env.PATH ?? ""}`, USER: "demo", LANG: "C" };
  const run = (...args: string[]) => spawnSync(process.execPath, [BIN, ...args], { env, encoding: "utf8", timeout: 120_000, stdio: ["ignore", "pipe", "pipe"] });
  /** The machine-wide calls the scratch run made, one per line. */
  const calls = () => readFileSync(log, "utf8").split("\n").filter((line) => line !== "");
  return { home, state, keyFile, env, run, calls };
}

/** A board over the scratch host file on a free port, asked for its plugins over the socket as the page asks. */
async function askPlugins(machine: ReturnType<typeof scratchMachine>): Promise<PluginsAnswer> {
  const probe = createServer();
  await new Promise<void>((done) => probe.listen(0, "127.0.0.1", done));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((done) => probe.close(() => done()));
  const settings = parseTicketSettings({ clones: { "demo-app": join(machine.home, "repos", "demo-app") }, stateDir: join(machine.home, "state"), tickets: { port } });
  const deps: BoardDeps = { settings, source: createFakeTracker([]), codeHost: createFakeCodeHost(), key: TOKEN, hostPath: machine.env.AGENT_ORG_HOST,
    queuePath: join(machine.home, "queue.json"), choicePath: join(machine.home, "choice.json"), plugins: { version: "v-demo" } };
  const board = createBoard(deps);
  const server = createServer((request, response) => { void board.handle(request, response); });
  await new Promise<void>((done) => server.listen(port, "127.0.0.1", done));
  const saved = { PATH: process.env.PATH, HOME: process.env.HOME };
  Object.assign(process.env, { PATH: machine.env.PATH, HOME: machine.home, AGENT_ORG_HOME: machine.state, AGENT_ORG_HOST: machine.env.AGENT_ORG_HOST });
  try {
    const answer = await fetch(`http://127.0.0.1:${port}/api/plugins`, { headers: { "x-ticket-token": TOKEN } });
    assert.equal(answer.status, 200);
    return await answer.json() as PluginsAnswer;
  } finally {
    Object.assign(process.env, saved);
    await new Promise<void>((done) => server.close(() => done()));
  }
}

test("A11-163 done-when: a fresh machine's onboard enables the Linear and GitHub plugins, `plugin list` reads both from their blocks, and the board's /api/plugins shows them under Tracker and Code host", async () => {
  const machine = scratchMachine();
  const onboard = machine.run("onboard", "--profile", "laptop", "--linear-key-file", machine.keyFile, "--no-start", "--no-terminal", "--no-auto-update");
  assert.equal(onboard.status, 0, `${onboard.stdout}\n${onboard.stderr}`);
  assert.match(onboard.stdout, /^installed linear as the tracker$/m);
  assert.match(onboard.stdout, /^installed github as the code host$/m);
  assert.match(onboard.stdout, /^tracker: linear \(enabled, contract 1\.4, plugins\/linear\)$/m, "and it ends with the doctor's report, a section per plugin");
  assert.match(onboard.stdout, /^code host: github \(enabled, contract 1\.9, plugins\/github\)$/m);
  assert.doesNotMatch(onboard.stdout + onboard.stderr, new RegExp(KEY), "the key is never printed");

  const list = machine.run("plugin", "list");
  assert.equal(list.status, 0, list.stderr);
  assert.match(list.stdout, /^tracker: linear \(from tickets\.providers\.tracker\)\n {2}linear +enabled +contract 1\.4 +plugins\/linear$/m, "both are read from their blocks, as installed and enabled");
  assert.match(list.stdout, /^code host: github \(from tickets\.providers\.codeHost\)\n {2}github +enabled +contract 1\.9 +plugins\/github$/m);

  const answer = await askPlugins(machine);
  const entry = (concern: string, name: string) => answer.concerns.find((candidate) => candidate.concern === concern)?.plugins.find((plugin) => plugin.name === name);
  assert.deepEqual([entry("tracker", "linear")?.state, entry("tracker", "linear")?.installed, entry("codeHost", "github")?.state, entry("codeHost", "github")?.installed], ["enabled", true, "enabled", true]);
  assert.equal(answer.concerns.find(({ concern }) => concern === "tracker")?.enabled, "linear");
  assert.equal(answer.concerns.find(({ concern }) => concern === "codeHost")?.enabled, "github");
  assert.equal(answer.concerns.find(({ concern }) => concern === "tracker")?.empty, null, "no empty state: the board can run");
  assert.deepEqual(entry("tracker", "linear")?.controls.refused.disable, "linear is the only tracker, and exactly one tracker must be enabled: it cannot be disabled");
  assert.doesNotMatch(JSON.stringify(answer), new RegExp(KEY), "no secret is in the page's answer");
  assertNothingMachineWide(machine.calls());
});

/** What a scratch run may ask of the machine: nothing, but a service's state read (`systemctl --user is-active|show|cat`). Any other call, and any call at all to the rest, is a change or a reach beyond HOME. */
function assertNothingMachineWide(calls: readonly string[]): void {
  const reach = calls.filter((call) => !/^systemctl --user (?:is-active|show|cat) /.test(call));
  assert.deepEqual(reach, [], "a throwaway HOME is not a throwaway machine: onboard called a machine-wide program");
}

test("A11-163: onboard in a throwaway HOME never calls a machine-wide program that changes anything: no `tailscale serve`, `systemctl`, `launchctl` or `herdr` call that is not a read", async () => {
  const local = scratchMachine();
  const onboard = local.run("onboard", "--profile", "laptop", "--linear-key-file", local.keyFile, "--no-start", "--no-terminal", "--no-auto-update");
  assert.equal(onboard.status, 0, `${onboard.stdout}\n${onboard.stderr}`);
  assertNothingMachineWide(local.calls());
  // The Tailscale exposure is the one that asks the machine: its steps read `tailscale` (is it there, is the operator right, is a port taken), and a read is all they may do.
  const tailnet = scratchMachine();
  const profile = JSON.parse(readFileSync(join(tailnet.state, "profiles", "laptop.json"), "utf8"));
  writeFileSync(join(tailnet.state, "profiles", "laptop.json"), JSON.stringify({ ...profile, exposure: { provider: "tailscale" } }));
  const served = tailnet.run("onboard", "--profile", "laptop", "--linear-key-file", tailnet.keyFile, "--no-start", "--no-terminal", "--no-auto-update");
  assert.equal(served.status, 0, `${served.stdout}\n${served.stderr}`);
  const tailscale = tailnet.calls().filter((call) => call.startsWith("tailscale"));
  assert.ok(tailscale.length > 0, "POSITIVE CONTROL: the tailnet onboard does ask Tailscale, so the spy is on the path it takes");
  const changes = tailscale.filter((call) => !/^tailscale (?:status|version|serve status)\b/.test(call));
  assert.deepEqual(changes, [], "and it only reads: no serve, no off, no reset");
  assert.deepEqual(tailnet.calls().filter((call) => !call.startsWith("tailscale")).filter((call) => !/^systemctl --user (?:is-active|show|cat) /.test(call)), []);
});
