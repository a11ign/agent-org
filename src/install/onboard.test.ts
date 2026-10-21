// no-token: none -- the Keychain, the prompts, the services, the programs and the plugin's install record are stand-ins; the host file, the profile and the
// notes are written into a temporary HOME, which is the fake home each test checks
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "../lib/tmp-fixture.ts";
import type { KeySource } from "../ticket-mode/settings.ts";
import { LINEAR_CONNECTORS, onboard, onboardServices, startServices, type OnboardDeps, type OnboardOptions } from "./onboard.ts";
import { PAIRING_STEPS } from "./terminal.ts";
import { ServiceRefusal, TailnetRefusal, type RunResult } from "./service.ts";
import type { Account, Program, ProgramRunner } from "../ticket-port/stack-extension.ts";
import { diagnose, type DoctorDeps } from "./doctor.ts";
import type { ProfileRepo } from "./onboard-profile.ts";
import { fakeAgentOrgPlugins } from "../plugins/fakes/doctor-seam.ts";
import type { Replacements } from "./interim-guards.ts";
import { PLAYWRIGHT_CLI, type ChromiumReport } from "./chromium.ts";

const STACK_LISTED = "gh stack  github/gh-stack  v0.2.1\n";
/** The GitHub CLI as the tests see it by default: the stack extension is listed, and nothing else is asked. */
const listedGh = (): ProgramRunner => (args: string[]): Program => ({ status: 0, stdout: args[1] === "list" ? STACK_LISTED : "", stderr: "" });
const OK: RunResult = { status: 0, stdout: "", stderr: "" };

const KEY = "lin_api_SECRETSECRETSECRET";
const PEM = "-----BEGIN PRIVATE KEY-----\nSECRETPEMSECRET\n-----END PRIVATE KEY-----\n";
const PLUGIN = "example@example-marketplace";
const REPO = "example-org/example-plugin";
const TERMINAL = "http://127.0.0.1:7318/?ws={workspace}&pane={pane}&view=terminal";
const options = (over: Partial<OnboardOptions> = {}): OnboardOptions => ({
  repos: [], keychain: undefined, keyFile: undefined, profile: undefined, start: true, terminal: true, autoUpdate: true, updateChannel: undefined, ...over,
});
const PLUGINS = JSON.stringify([{ plugin_id: "devswha.herdr-web-ui", plugin_root: "/h/.config/herdr/plugins/github/devswha.herdr-web-ui-1" }]);
/** The contract the example plugin declares in its installed manifest (A11-137): a planner and a writer, both the same skill. */
const MANIFEST = {
  name: "example", version: "1.0.0",
  metadata: { agentOrg: { contract: "1.0", agentOrg: ">=0.258.0 <1.0.0", provides: { planner: { skill: "example:create-ticket", planFile: "<issue-id>-0001-plan-<slug>.md" }, writer: { skill: "example:create-ticket" } }, needs: { connectors: [], commands: [] } } },
};
/** A profile with invented names, as the README's example shows one: no secret, and the App's identity, which is not one. */
const profileOf = (repo: ProfileRepo) => ({
  schema: 1,
  tracker: { provider: "linear", pick: { team: "ZZ" }, workingState: "In Progress", plannedState: "Planned" },
  codeHost: { provider: "github", reviewerApp: { slug: "example-reviewer", appId: 111, installationId: 222 } },
  publish: { provider: "none" }, reviewer: { provider: "atomic" }, exposure: { provider: "local" },
  conventions: { plugin: PLUGIN, marketplace: REPO }, repos: [repo],
});

/**
 * A stand-in for `claude` and `gh` for the example plugin: the marketplace and the install record live in the fake home, as Claude Code keeps them. `homeOf`
 * is read when a program runs, since the home is made by `deps` after this is.
 */
function pluginWorld(homeOf: () => string) {
  const calls: string[] = [];
  const marketplaces: { name: string; source: string; repo: string | null }[] = [];
  const runOver = (file: string, args: string[]): RunResult | undefined => {
    const line = [file, ...args].join(" ");
    if (!line.startsWith("gh repo view") && !line.startsWith("claude plugin")) return undefined;
    calls.push(line);
    if (line === "claude plugin marketplace list --json") return { status: 0, stdout: JSON.stringify(marketplaces), stderr: "" };
    if (line === `claude plugin marketplace add ${REPO}`) {
      marketplaces.push({ name: "example-marketplace", source: "github", repo: REPO });
      return OK;
    }
    if (line === `claude plugin install ${PLUGIN} --scope user`) {
      const home = homeOf();
      const installPath = join(home, ".claude", "plugins", "cache", "example", "1.0.0");
      mkdirSync(join(installPath, ".claude-plugin"), { recursive: true });
      writeFileSync(join(installPath, ".claude-plugin", "plugin.json"), JSON.stringify(MANIFEST));
      mkdirSync(join(home, ".claude", "plugins"), { recursive: true });
      writeFileSync(join(home, ".claude", "plugins", "installed_plugins.json"), JSON.stringify({ version: 2, plugins: { [PLUGIN]: [{ scope: "user", installPath }] } }));
    }
    return OK;
  };
  return { calls, runOver };
}

/** Both Chromium builds start, which is what onboard finds on a machine that can capture: the default of these tests. */
const BROWSERS_READY: ChromiumReport = {
  builds: [{ build: "chromium", binary: "/cache/chromium-1243/chrome", missing: [] }, { build: "chromium-headless-shell", binary: "/cache/shell/chrome-headless-shell", missing: [] }],
  unchecked: null,
};

function deps(over: Partial<OnboardDeps> = {}, answers: string[] = [], runOver: (file: string, args: string[]) => RunResult | undefined = () => undefined) {
  const home = tmpDir("onboard-");
  const repo = join(home, "src", "nbl-ui-netbox");
  mkdirSync(repo, { recursive: true });
  const stored = new Map<string, string>();
  const printed: string[] = [];
  const started: string[] = [];
  const ran: string[] = [];
  const asked: string[] = [];
  const hidden: string[] = [];
  const written: string[] = [];
  /** What each program answers, by its first two words; anything not named answers exit 0. */
  const answers2: Record<string, (args: string[]) => RunResult> = {};
  let plugins: string | null = null;
  const keyAt = (source: KeySource) => ("keychain" in source ? `keychain:${source.keychain}` : `file:${source.path}`);
  const value: OnboardDeps = {
    env: {}, home, platform: "darwin", interactive: false,
    ask: async (question) => { asked.push(question); return answers.shift() ?? ""; },
    askHidden: async (question) => { hidden.push(question); return KEY; },
    readKey: (source) => {
      const key = stored.get(keyAt(source));
      if (key === undefined) throw new Error("no key");
      return key;
    },
    storeInKeychain: (service) => { stored.set(`keychain:${service}`, KEY); },
    readFile: (path) => readFileSync(path, "utf8"),
    writeFile: (path, text) => {
      written.push(path);
      if (path.endsWith(".key")) stored.set(`file:${path}`, text.trim());
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, text, { mode: 0o600 });
    },
    exists: (path) => existsSync(path),
    removeFile: (path) => rmSync(path, { force: true }),
    now: () => new Date("2026-10-20T10:00:00.000Z"),
    isDirectory: (path) => { try { return statSync(path).isDirectory(); } catch { return false; } },
    ensureBun: async () => ({ path: "/h/.bun/bin/bun", installed: false }),
    herdrPlugins: () => plugins,
    run: (file, args) => {
      const override = runOver(file, args);
      if (override !== undefined) return override;
      ran.push([file, ...args].join(" "));
      if (file === "herdr" && args[1] === "install") plugins = PLUGINS;
      return (answers2[`${file} ${args[0]} ${args[1]}`] ?? (() => OK))(args);
    },
    which: () => "/usr/local/bin/tool",
    codexStatus: () => 0,
    ghAs: () => listedGh(),
    replacements: async () => ({ ghWrapperDeclared: true, herdrOutsideInstance: true }),
    diagnose: async () => [],
    chromium: () => BROWSERS_READY,
    isRoot: () => false,
    startServices: (names) => { started.push(...names); return names.map((name) => `started the ${name} service`).join("\n"); },
    out: { log: (line: string) => printed.push(line) },
    ...over,
  };
  return { deps: value, home, repo, stored, printed, started, ran, asked, hidden, written, answers: answers2, setPlugins: (text: string | null) => { plugins = text; } };
}

/** The host file as onboard leaves it, parsed. */
const hostOf = (home: string) => JSON.parse(readFileSync(join(home, ".agent-org", "host.json"), "utf8")) as Record<string, any>;

test("onboard writes clones and the key source from flags, keeps the host file's other keys in their blocks, and starts the instance service", async () => {
  const { deps: d, home, repo, stored, printed, started } = deps();
  stored.set("keychain:agent-org-linear", KEY);
  const hostFile = join(home, ".agent-org", "host.json");
  mkdirSync(join(home, ".agent-org"));
  writeFileSync(hostFile, JSON.stringify({ stateDir: "/var/agent-org", tickets: { max: 5 } }));
  await onboard(options({ repos: [`netbox=${repo}`], keychain: "agent-org-linear" }), d);
  assert.deepEqual(JSON.parse(readFileSync(hostFile, "utf8")), {
    stateDir: "/var/agent-org", clones: { netbox: repo },
    tickets: {
      max: 5,
      capture: true,
      providers: {
        tracker: { provider: "linear", key: { keychain: "agent-org-linear" }, connectors: [...LINEAR_CONNECTORS] },
        exposure: { provider: "local", terminal: TERMINAL },
      },
    },
  });
  assert.deepEqual(started, ["instance", "ui", "terminal", "auto-update"]);
  assert.ok(printed.some((line) => line === "the Linear key is readable from the Keychain service agent-org-linear"));
});

const LACKING: ChromiumReport = {
  builds: [BROWSERS_READY.builds[0], { build: "chromium-headless-shell", binary: "/cache/shell", missing: ["libatk-1.0.so.0"] }],
  unchecked: null,
};

test("onboard installs the browsers as the person, and sets tickets.capture where both builds start", async () => {
  const { deps: d, home, repo, stored, ran } = deps();
  stored.set("keychain:agent-org-linear", KEY);
  await onboard(options({ repos: [`netbox=${repo}`], keychain: "agent-org-linear", start: false }), d);
  assert.ok(ran.includes(`node ${PLAYWRIGHT_CLI} install chromium`), "the browsers are installed without root");
  assert.equal(hostOf(home).tickets.capture, true);
});

test("onboard keeps tickets.capture out, and says the command, when a library is missing and sudo needs a password", async () => {
  const { deps: d, home, repo, stored, ran, printed } = deps({ chromium: () => LACKING }, [], (file) => (file === "sudo" ? { status: 1, stdout: "", stderr: "a password is required" } : undefined));
  stored.set("keychain:agent-org-linear", KEY);
  await onboard(options({ repos: [`netbox=${repo}`], keychain: "agent-org-linear", start: false }), d);
  assert.equal(hostOf(home).tickets.capture, undefined);
  assert.equal(ran.some((line) => line.includes("install-deps")), false, "no library install is attempted without root or sudo -n");
  assert.ok(printed.some((line) => line.includes(`install-deps chromium`) && line.includes("libatk-1.0.so.0")), "the command that installs the library is said");
});

test("onboard installs a missing library through sudo -n when sudo needs no password, then checks again", async () => {
  let checks = 0;
  const { deps: d, home, repo, stored, ran } = deps({ chromium: () => (checks++ === 0 ? LACKING : BROWSERS_READY) });
  stored.set("keychain:agent-org-linear", KEY);
  await onboard(options({ repos: [`netbox=${repo}`], keychain: "agent-org-linear", start: false }), d);
  assert.ok(ran.includes(`sudo -n node ${PLAYWRIGHT_CLI} install-deps chromium`));
  assert.equal(hostOf(home).tickets.capture, true, "both builds start after the install, so capture is set");
});

test("onboard installs a missing library without sudo when it runs as root", async () => {
  let checks = 0;
  const { deps: d, repo, stored, ran } = deps({ chromium: () => (checks++ === 0 ? LACKING : BROWSERS_READY), isRoot: () => true });
  stored.set("keychain:agent-org-linear", KEY);
  await onboard(options({ repos: [`netbox=${repo}`], keychain: "agent-org-linear", start: false }), d);
  assert.ok(ran.includes(`node ${PLAYWRIGHT_CLI} install-deps chromium`));
  assert.equal(ran.some((line) => line.startsWith("sudo ")), false);
});

test("a Linear key flag replaces the key the host file holds, as it always has; without a flag the host file's key is kept", async () => {
  const { deps: d, home, repo, stored } = deps();
  stored.set("keychain:new-service", KEY);
  mkdirSync(join(home, ".agent-org"), { recursive: true });
  writeFileSync(join(home, ".agent-org", "host.json"), JSON.stringify({ clones: { netbox: repo }, tickets: { providers: { tracker: { provider: "linear", key: { path: "/old/key" } } } } }));
  await onboard(options({ repos: [repo], keychain: "new-service", start: false }), d);
  assert.deepEqual(hostOf(home).tickets.providers.tracker.key, { keychain: "new-service" });
  await onboard(options({ repos: [repo], start: false }), d);
  assert.deepEqual(hostOf(home).tickets.providers.tracker.key, { keychain: "new-service" }, "a run with no flag keeps the key the last run wrote");
});

test("onboard's last message says how to pair a new device, for the board and the terminal, whether or not services start", async () => {
  for (const start of [true, false]) {
    const { deps: d, repo, stored, printed } = deps();
    stored.set("keychain:agent-org-linear", KEY);
    await onboard(options({ repos: [`netbox=${repo}`], keychain: "agent-org-linear", start }), d);
    assert.equal(printed.at(-1), PAIRING_STEPS, `start ${start}`);
  }
});

test("onboard never prints the key: not when it reads one, and not when it stores one from a hidden prompt", async () => {
  for (const source of [{ keychain: undefined, keyFile: undefined }, { keychain: undefined, keyFile: "~/.agent-org/linear.key" }]) {
    const { deps: d, repo, printed, stored } = deps({ interactive: true });
    await onboard(options({ repos: [repo], ...source }), d);
    assert.equal(stored.size, 1, "a key was stored");
    assert.ok(printed.length > 0);
    for (const line of printed) assert.ok(!line.includes(KEY), `printed the key: ${line}`);
  }
});

test("onboard asks for repositories at a terminal, names a bare path after its directory, and does not start with --no-start", async () => {
  const answers: string[] = [];
  const { deps: d, home, repo, started, stored } = deps({ interactive: true }, answers);
  answers.push(repo, "");
  stored.set("keychain:agent-org-linear", KEY);
  await onboard(options({ start: false }), d);
  assert.deepEqual(JSON.parse(readFileSync(join(home, ".agent-org", "host.json"), "utf8")).clones, { "nbl-ui-netbox": repo });
  assert.deepEqual(started, []);
});

test("onboard refuses no repository, a relative one and a missing one, and says how to store a key it cannot read", async () => {
  const { deps: d, home, repo, printed } = deps();
  await assert.rejects(onboard(options(), d), /give at least one --repo/);
  await assert.rejects(onboard(options({ repos: ["x=relative/path"] }), d), /must be an absolute path/);
  await assert.rejects(onboard(options({ repos: [`x=${join(home, "absent")}`] }), d), /is not a directory/);
  await onboard(options({ repos: [repo], start: false }), d);
  assert.ok(printed.some((line) => line.startsWith("NO LINEAR KEY is readable from the Keychain service agent-org-linear. Store one with: security add-generic-password")));
});

test("onboard refuses to write over a host file that is not JSON", async () => {
  const { deps: d, home, repo } = deps();
  mkdirSync(join(home, ".agent-org"));
  writeFileSync(join(home, ".agent-org", "host.json"), "{ not json");
  await assert.rejects(onboard(options({ repos: [repo] }), d), /is not valid JSON, so onboard will not write over it/);
});

test("onboard refuses a Keychain service name a shell would not read as it is", async () => {
  const { deps: d, repo } = deps();
  await assert.rejects(onboard(options({ repos: [repo], keychain: "x; touch pwned" }), d), /is not a Keychain service name/);
});

test("onboard's start starts the instance and the ui service, in that order", () => {
  const started: string[] = [];
  const lines = startServices(["instance", "ui"], (name) => {
    started.push(name);
    return { manager: "systemd", id: `agent-org-${name}.service`, path: `/u/agent-org-${name}.service`, text: "", log: null, companion: null, interval: false, address: null };
  });
  assert.deepEqual(started, ["instance", "ui"]);
  assert.equal(lines, "started the instance service (systemd agent-org-instance.service)\nstarted the ui service (systemd agent-org-ui.service)");
});

test("onboard starts the terminal only once it is set up and auto-update unless opted out; a refused optional service is said, a refused instance fails", () => {
  assert.deepEqual(onboardServices({ terminal: true, autoUpdate: true }), ["instance", "ui", "terminal", "auto-update"]);
  assert.deepEqual(onboardServices({ terminal: false, autoUpdate: false }), ["instance", "ui"]);
  const unit = (name: string) => ({ manager: "systemd" as const, id: name, path: name, text: "", log: null, companion: null, interval: false, address: null });
  const lines = startServices(["instance", "terminal"], (name) => {
    if (name === "terminal") throw new ServiceRefusal("no bun");
    return unit(name);
  });
  assert.equal(lines, "started the instance service (systemd instance)\ndid not start the terminal service: no bun");
  assert.throws(() => startServices(["instance"], () => { throw new ServiceRefusal("port in use"); }), /port in use/);
});

// A11-66: the web terminal, set up by onboard, written into the exposure block (A11-144).
test("onboard installs herdr web ui when herdr lists it not, with bun's directory first on PATH, and writes the exposure block's terminal", async () => {
  const { deps: d, home, repo, ran, printed } = deps({ env: { PATH: "/usr/bin" }, ensureBun: async () => ({ path: "/h/.bun/bin/bun", installed: true }) });
  let pathGiven = "";
  const run = d.run;
  await onboard(options({ repos: [repo] }), { ...d, run: (file, args, env) => { if (file === "herdr") pathGiven = env?.PATH ?? ""; return run(file, args, env); } });
  assert.ok(ran.includes("herdr plugin install devswha/herdr-web-ui --yes"));
  assert.equal(pathGiven, "/h/.bun/bin:/usr/bin");
  assert.ok(printed.includes("installed bun at /h/.bun/bin/bun, for the web terminal"));
  assert.equal(hostOf(home).tickets.providers.exposure.terminal, TERMINAL);
});

test("onboard keeps an existing terminal address, moving the old key into its block with a backup, and does not reinstall an installed plugin", async () => {
  const { deps: d, home, repo, ran, setPlugins } = deps();
  setPlugins(PLUGINS);
  mkdirSync(join(home, ".agent-org"), { recursive: true });
  const mine = "http://127.0.0.1:9000/?ws={workspace}";
  writeFileSync(join(home, ".agent-org", "host.json"), JSON.stringify({ clones: { netbox: repo }, tickets: { terminal: mine } }));
  await onboard(options({ repos: [repo] }), d);
  assert.ok(!ran.some((line) => line.startsWith("herdr plugin install")));
  assert.equal(hostOf(home).tickets.providers.exposure.terminal, mine);
  assert.equal(hostOf(home).tickets.terminal, undefined, "the old key is moved, not kept beside its block");
  assert.ok(readdirSync(join(home, ".agent-org")).some((name) => name.startsWith("host.json.before-providers-")), "the old file is kept as a backup");
});

test("a terminal that cannot be set up is said, writes no terminal address and starts no terminal service; --no-terminal does not try", async () => {
  const failing = deps({}, [], (file) => (file === "herdr" ? { status: 1, stdout: "", stderr: "herdr: no network\nmore" } : undefined));
  await onboard(options({ repos: [failing.repo] }), failing.deps);
  assert.ok(failing.printed.some((line) => line.startsWith("the web terminal is not set up: `herdr plugin install devswha/herdr-web-ui --yes` failed: herdr: no network.")));
  assert.equal(hostOf(failing.home).tickets.providers.exposure.terminal, undefined);
  assert.deepEqual(failing.started, ["instance", "ui", "auto-update"]);
  const off = deps({ ensureBun: async () => { throw new Error("must not be asked"); } });
  await onboard(options({ repos: [off.repo], terminal: false, autoUpdate: false }), off.deps);
  assert.ok(!off.ran.some((line) => line.startsWith("herdr")));
  assert.deepEqual(off.started, ["instance", "ui"]);
});

// A11-71: Linear's MCP for the workers, authenticated by the key, which is never printed.
test("onboard registers Linear's MCP at user scope with the key as a bearer header, and never prints the key", async () => {
  const { deps: d, repo, stored, ran, printed, answers } = deps();
  stored.set("keychain:agent-org-linear", KEY);
  answers["claude mcp get"] = () => ({ status: 1, stdout: "", stderr: "No MCP server named \"linear\"" });
  await onboard(options({ repos: [repo] }), d);
  assert.ok(ran.includes(`claude mcp add --scope user --transport http linear https://mcp.linear.app/mcp --header Authorization: Bearer ${KEY}`));
  assert.ok(printed.includes("registered Linear's MCP for Claude Code (user scope), authenticated by the key in the Keychain service agent-org-linear"));
  for (const line of printed) assert.ok(!line.includes(KEY), `printed the key: ${line}`);
});

test("onboard leaves an existing linear MCP alone, scrubs the key from a failed add, and writes no connectors without a readable key", async () => {
  const existing = deps();
  existing.stored.set("keychain:agent-org-linear", KEY);
  await onboard(options({ repos: [existing.repo] }), existing.deps);
  assert.ok(!existing.ran.some((line) => line.startsWith("claude mcp add")));
  const failing = deps();
  failing.stored.set("keychain:agent-org-linear", KEY);
  failing.answers["claude mcp get"] = () => ({ status: 1, stdout: "", stderr: "" });
  failing.answers["claude mcp add"] = () => ({ status: 1, stdout: "", stderr: `invalid header Authorization: Bearer ${KEY}` });
  await onboard(options({ repos: [failing.repo] }), failing.deps);
  const said = failing.printed.find((line) => line.startsWith("could not register Linear's MCP")) ?? "";
  assert.ok(said.includes("Bearer <key>") && !said.includes(KEY));
  const keyless = deps();
  await onboard(options({ repos: [keyless.repo] }), keyless.deps);
  assert.ok(!keyless.ran.some((line) => line.startsWith("claude")));
  assert.equal(hostOf(keyless.home).tickets.providers.tracker.connectors, undefined);
});

// A11-145: Linear's reads are the tracker's, so they sit in the tracker block, and the person's own tickets.connectors is kept as it is.
test("onboard adds Linear's read and comment tools to the tracker block, and keeps the person's own tickets.connectors", async () => {
  const { deps: d, home, repo, stored } = deps();
  stored.set("keychain:agent-org-linear", KEY);
  mkdirSync(join(home, ".agent-org"));
  const own = ["^mcp__slack__read_", "^mcp__linear__save_comment$"];
  writeFileSync(join(home, ".agent-org", "host.json"), JSON.stringify({ clones: { netbox: repo }, tickets: { connectors: own } }));
  await onboard(options({ repos: [repo] }), d);
  // The Linear pattern the host held moves to the tracker, which then gains the read tool; the person's own pattern stays where it was.
  assert.deepEqual(hostOf(home).tickets.connectors, ["^mcp__slack__read_"]);
  assert.deepEqual(hostOf(home).tickets.providers.tracker.connectors, ["^mcp__linear__save_comment$", "^mcp__linear__(get|list|search|extract)_"]);
});

// A11-68 and auto-update: what onboard records beside the host file.
test("onboard records the host file's path for shells with no AGENT_ORG_HOST, and the update channel it is given", async () => {
  const { deps: d, home, repo } = deps({ env: { AGENT_ORG_HOST: "/elsewhere/host.json" } });
  const writes = new Map<string, string>();
  const write = d.writeFile;
  await onboard(options({ repos: [repo], updateChannel: "main" }), { ...d, writeFile: (path, text) => { writes.set(path, text); if (!path.startsWith("/elsewhere")) write(path, text); } });
  assert.equal(writes.get(join(home, ".agent-org", "host-file")), "/elsewhere/host.json\n");
  assert.equal(writes.get(join(home, ".agent-org", "update-channel")), "main\n");
  assert.ok(writes.has("/elsewhere/host.json"));
});

test("a service on the tailnet is said with its address when it starts, and a page the tailnet refuses fails onboard", () => {
  const served = (name: string) => ({ manager: "systemd" as const, id: `agent-org-${name}.service`, path: name, text: "", log: null, companion: null, interval: false, address: "https://agents.tail1234.ts.net:9443/" });
  assert.equal(startServices(["ui"], served), "started the ui service (systemd agent-org-ui.service), on the tailnet at https://agents.tail1234.ts.net:9443/");
  assert.throws(() => startServices(["instance", "ui"], (name) => {
    if (name === "ui") throw new TailnetRefusal("the ui service started on 127.0.0.1, but the tailnet does not reach it: refused");
    return { ...served(name), address: null };
  }), /the tailnet does not reach it/);
});

test("a terminal the tailnet does not reach is said as running on loopback, not as not started", () => {
  const lines = startServices(["instance", "terminal"], (name) => {
    if (name === "terminal") throw new TailnetRefusal("the terminal service started on 127.0.0.1, but the tailnet does not reach it: refused");
    return { manager: "systemd" as const, id: "agent-org-instance.service", path: name, text: "", log: null, companion: null, interval: false, address: null };
  });
  assert.equal(lines, "started the instance service (systemd agent-org-instance.service)\nthe terminal service started on 127.0.0.1, but the tailnet does not reach it: refused");
});

/** A GitHub CLI for a test whose extension is listed once `install` has run, recording each call's account and command. */
function stackDeps(install: Program) {
  let listed = false;
  const accounts: Account[] = [];
  const commands: string[] = [];
  const base = deps();
  const ghAs = (account: Account): ProgramRunner => (args) => {
    accounts.push(account);
    commands.push(args.join(" "));
    if (args[1] === "install") {
      if (install.status === 0) listed = true;
      return install;
    }
    return { status: 0, stdout: listed ? STACK_LISTED : "", stderr: "" };
  };
  const workers = join(base.home, "workers");
  mkdirSync(join(base.home, ".agent-org"), { recursive: true });
  writeFileSync(join(base.home, ".agent-org", "host.json"), JSON.stringify({ clones: { netbox: base.repo }, tickets: {}, gh: { workers } }));
  return { ...base, deps: { ...base.deps, ghAs }, accounts, commands, workers };
}

test("A11-106: onboard installs the stack extension for the workers' account when it is missing, and says so", async () => {
  const { deps: d, repo, printed, accounts, commands, workers } = stackDeps({ status: 0, stdout: "", stderr: "" });
  await onboard(options({ repos: [`netbox=${repo}`], keychain: "agent-org-linear", start: false }), d);
  assert.ok(commands.includes("extension install github/gh-stack"), "the extension is installed");
  assert.ok(accounts.every((account) => account.GH_CONFIG_DIR === join(workers, "gh")), "every call runs as the workers' account");
  assert.ok(printed.includes("installed the github/gh-stack extension (v0.2.1), which a worker links a stacked pull request with"));
});

test("A11-106: onboard does not install the stack extension again where it is listed", async () => {
  const base = deps();
  const commands: string[] = [];
  const ghAs = (): ProgramRunner => (args) => {
    commands.push(args.join(" "));
    return { status: 0, stdout: STACK_LISTED, stderr: "" };
  };
  await onboard(options({ repos: [`netbox=${base.repo}`], keychain: "agent-org-linear", start: false }), { ...base.deps, ghAs });
  assert.deepEqual(commands, ["extension list"], "a listed extension is not installed again");
  assert.ok(base.printed.includes("the github/gh-stack extension is installed (v0.2.1), which a worker links a stacked pull request with"));
});

test("A11-106: a stack extension that fails to install is said with its reason and the command to run, and onboard still completes", async () => {
  const { deps: d, repo, printed, workers } = stackDeps({ status: 1, stdout: "", stderr: "could not reach github.com\nmore" });
  await onboard(options({ repos: [`netbox=${repo}`], keychain: "agent-org-linear", start: false }), d);
  assert.ok(printed.includes(`could not install the github/gh-stack extension: could not reach github.com. Run \`GH_CONFIG_DIR=${join(workers, "gh")} gh extension install github/gh-stack\` by hand, then \`agent-org doctor\`.`));
});

test("A11-145: a host that sets codeHost.stack to false is not asked for the stack extension", async () => {
  const base = deps({ ghAs: () => { throw new Error("the stack extension must not be asked"); } });
  mkdirSync(join(base.home, ".agent-org"), { recursive: true });
  writeFileSync(join(base.home, ".agent-org", "host.json"), JSON.stringify({ tickets: { providers: { codeHost: { provider: "github", stack: false } } } }));
  await onboard(options({ repos: [base.repo], keychain: "agent-org-linear", start: false }), base.deps);
  assert.ok(!base.printed.some((line) => line.includes("gh-stack")));
});

// A11-145: the profile path. Onboard asks only for the secrets, and writes what the profile names, with the App's key copied beside the host file.
/** The doctor's readings of the fake home, each green: what `agent-org doctor` asks, answered for a machine with every secret and install in place. */
function greenDoctor(home: string): DoctorDeps {
  return {
    env: {}, home, nodeVersion: () => "v24.21.0", which: () => "/usr/local/bin/tool", readFile: (path) => readFileSync(path, "utf8"), readKey: () => KEY,
    mode: () => 0o600, serviceState: () => "running", answers: async () => true, healthy: async () => true, unitProblem: () => null,
    mcpList: () => "linear: https://mcp.linear.app/mcp (HTTP) - Connected\n", pnpmVersion: () => "10.34.5",
    tailscale: () => ({ status: 1, stdout: "", stderr: "not used" }), tailnetAnswers: async () => false,
    ghWrapper: async () => ({ divergence: null, mints: [] }), ghAs: () => listedGh(), originOf: () => null, platform: "linux",
    isolation: () => ({ kind: "outside", scope: null }), updateStatus: () => ({ kind: "absent" }), pluginRefresh: () => ({ kind: "none" }), releaseTags: () => [],
    plugins: (input) => ({ states: { readable: true, plugins: input.wanted.map((plugin) => ({ plugin, installs: [], loads: true, why: null, installPath: null })) }, unreachable: [], rows: [], contracts: [] }),
    reviewerGate: async () => null, codexStatus: () => 0, chromium: () => BROWSERS_READY, agentOrgPlugins: fakeAgentOrgPlugins(), now: () => Date.now(),
  };
}

/** Every file under `dir`, with its text: what a second run must leave exactly as it was. */
function snapshot(dir: string): Record<string, string> {
  const files: Record<string, string> = {};
  for (const name of readdirSync(dir, { recursive: true, withFileTypes: false }) as string[]) {
    const path = join(dir, name);
    if (statSync(path).isFile()) files[name] = readFileSync(path, "utf8");
  }
  return files;
}

test("A11-145: a complete profile sets everything but the secrets: asks for the App's key file and the Linear key only, writes the exact set of files, and the doctor is green", async () => {
  let home = "";
  const plugin = pluginWorld(() => home);
  const answers: string[] = [];
  const base = deps({ platform: "linux", interactive: true, diagnose: () => diagnose(greenDoctor(base.home)) }, answers, plugin.runOver);
  home = base.home;
  const { deps: d, repo, printed, asked, hidden, written } = base;
  const pem = join(home, "keys", "example-reviewer.pem");
  mkdirSync(join(home, "keys"), { recursive: true });
  writeFileSync(pem, PEM);
  answers.push(pem);
  seedProfile(home, repo);
  await onboard(options({ profile: "example-laptop" }), d);

  assert.deepEqual(asked, ["Path to the downloaded private key (.pem) of the reviewer App example-reviewer, or an empty line to add it later: "]);
  assert.equal(hidden.length, 1, "the Linear key is asked for once, hidden");
  assert.deepEqual(written.map((path) => path.slice(home.length + 1)).sort(), [
    ".agent-org/apps/example-reviewer.pem",
    ".agent-org/host-file",
    ".agent-org/host.json",
    ".agent-org/linear.key",
    ".agent-org/review-notes.md",
    ".agent-org/worker-notes.md",
  ]);
  for (const path of written) assert.equal(statSync(path).mode & 0o777, 0o600, `${path} is mode 600`);

  const host = hostOf(home);
  assert.deepEqual(host.clones, { "example-app": repo });
  assert.deepEqual(host.tickets.providers, {
    tracker: { provider: "linear", workingState: "In Progress", plannedState: "Planned", key: { path: join(home, ".agent-org", "linear.key") }, connectors: [...LINEAR_CONNECTORS] },
    codeHost: { provider: "github", identity: { reviewer: { mode: "github-apps", slug: "example-reviewer", appId: 111, installationId: 222, keyPath: join(home, ".agent-org", "apps", "example-reviewer.pem") } } },
    publish: { provider: "none" }, reviewer: { provider: "atomic" }, exposure: { provider: "local", terminal: TERMINAL },
  });
  assert.deepEqual(host.tickets.pick, { team: "ZZ" });
  assert.deepEqual(host.tickets.plugins, [PLUGIN]);
  assert.equal(host.tickets.plan, "-plan-[^/]*\\.md$");
  assert.deepEqual(host.tickets.planner, { run: "Run the example:create-ticket skill with this request: unattended: plan {keys} into {dir}" });
  assert.deepEqual(host.tickets.writer, { run: "Run the example:create-ticket skill for this request: {request}. Write each draft under {dir}/drafts." });
  assert.equal(host.tickets.brief, join(home, ".agent-org", "worker-notes.md"));
  assert.equal(host.tickets.review, join(home, ".agent-org", "review-notes.md"));

  assert.ok(!printed.join("\n").includes(KEY) && !printed.join("\n").includes("SECRETPEMSECRET"), "no secret is printed");
  assert.ok(printed.some((line) => line.startsWith("installed example@example-marketplace for every folder")), "the plugin was installed for every folder");
  assert.ok(!printed.join("\n").includes("FAIL"), `doctor is green after onboard:\n${printed.join("\n")}`);
});

test("A11-145: a second run on the same home changes no file and runs no marketplace add or plugin install", async () => {
  let home = "";
  const plugin = pluginWorld(() => home);
  const answers: string[] = [];
  const d = deps({ platform: "linux", interactive: true }, answers, plugin.runOver);
  home = d.home;
  const { repo } = d;
  const pem = join(home, "example-reviewer.pem");
  writeFileSync(pem, PEM);
  answers.push(pem);
  seedProfile(home, repo);
  await onboard(options({ profile: "example-laptop", start: false }), d.deps);
  const before = snapshot(join(home, ".agent-org"));
  const callsBefore = plugin.calls.length;
  await onboard(options({ profile: "example-laptop", start: false }), d.deps);
  assert.deepEqual(snapshot(join(home, ".agent-org")), before, "every file is byte-identical");
  const second = plugin.calls.slice(callsBefore);
  assert.ok(!second.some((line) => line.includes("marketplace add") || line.includes("plugin install")), `second run: ${second.join(", ")}`);
});

test("A11-145: a profile that is absent, with no terminal, is refused by name, with the file it would be written to and what it holds", async () => {
  const { deps: d, home, repo } = deps();
  await assert.rejects(onboard(options({ profile: "absent-laptop", repos: [repo] }), d), (err: Error) => {
    assert.ok(err.message.includes(join(home, ".agent-org", "profiles", "absent-laptop.json")), err.message);
    assert.match(err.message, /copy one from another machine/);
    assert.match(err.message, /no secret/);
    return true;
  });
});

test("A11-145: a profile that is absent, at a terminal, is asked for and written, mode 600, and the questions are the profile's", async () => {
  // Five questions: the Pick team, the conventions plugin, the reviewer, the publisher and the exposure. A reviewer of none asks no App.
  const answers = ["ZZ", "none", "none", "none", "local"];
  const { deps: d, home, repo, asked, printed } = deps({ interactive: true, platform: "linux" }, answers);
  await onboard(options({ profile: "new-laptop", repos: [repo], start: false }), d);
  assert.equal(asked.length, 5, `asked: ${asked.join(" | ")}`);
  const profilePath = join(home, ".agent-org", "profiles", "new-laptop.json");
  assert.equal(statSync(profilePath).mode & 0o777, 0o600);
  const saved = JSON.parse(readFileSync(profilePath, "utf8"));
  assert.deepEqual(saved.tracker, { provider: "linear", pick: { team: "ZZ" } });
  assert.deepEqual(saved.repos, [{ name: "nbl-ui-netbox", path: repo }]);
  assert.ok(printed.some((line) => line.startsWith(`wrote the answers to ${profilePath}, mode 600`)));
  assert.ok(!readFileSync(profilePath, "utf8").includes(KEY), "the profile holds no secret");
});

test("A11-145: an old host file is moved to its provider blocks with a backup, as doctor --fix moves it, and its key is read from the moved place", async () => {
  const { deps: d, home, repo, stored } = deps();
  stored.set("keychain:agent-org-linear", KEY);
  mkdirSync(join(home, ".agent-org"), { recursive: true });
  writeFileSync(join(home, ".agent-org", "host.json"), JSON.stringify({ clones: { netbox: repo }, tickets: { linearKey: { keychain: "agent-org-linear" }, terminal: TERMINAL } }));
  await onboard(options({ repos: [repo], start: false }), d);
  const host = hostOf(home);
  assert.deepEqual(host.tickets.providers.tracker.key, { keychain: "agent-org-linear" });
  assert.equal(host.tickets.providers.exposure.terminal, TERMINAL);
  assert.equal(host.tickets.linearKey, undefined);
  const backups = readdirSync(join(home, ".agent-org")).filter((name) => name.startsWith("host.json.before-providers-"));
  assert.equal(backups.length, 1, "the old file is kept once");
});

/** A profile for the example laptop in `home`, naming `repo` as its one checkout. */
function seedProfile(home: string, repo: string): void {
  mkdirSync(join(home, ".agent-org", "profiles"), { recursive: true });
  writeFileSync(join(home, ".agent-org", "profiles", "example-laptop.json"), JSON.stringify(profileOf({ name: "example-app", path: repo })));
}

/** Writes each file, as a placeholder a machine set up by hand left behind. */
function seedFiles(paths: readonly string[]): void {
  for (const path of paths) {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, "guard");
  }
}

/** The interim guards a machine set up by hand has, under `home`: the watchdog's three files, and the instance unit's drop-in. */
function guardsIn(home: string): string[] {
  const units = join(home, ".config", "systemd", "user");
  return [join(units, "gh-wrapper-watchdog.timer"), join(units, "gh-wrapper-watchdog.service"), join(home, ".agent-org", "bin", "gh-wrapper-watchdog"), join(units, "agent-org-instance.service.d", "keep-herdr.conf")];
}

/** Onboard a Linux machine with the interim guards set by hand, with `replacements` answered: the guard files, and what was said and run. */
async function onboardWithGuards(replacements: Replacements) {
  const machine = deps({ platform: "linux", replacements: async () => replacements });
  const guards = guardsIn(machine.home);
  seedFiles(guards);
  machine.stored.set("keychain:agent-org-linear", KEY);
  await onboard(options({ repos: [machine.repo], keychain: "agent-org-linear", start: false }), machine.deps);
  return { guards, printed: machine.printed, ran: machine.ran };
}

test("A11-145: the interim guards are retired on Linux once their replacements are proven, and kept with the fix named when they are not", async () => {
  const proven = await onboardWithGuards({ ghWrapperDeclared: true, herdrOutsideInstance: true });
  assert.ok(proven.guards.every((path) => !existsSync(path)), "every guard file is removed");
  assert.ok(proven.ran.includes("systemctl --user disable --now gh-wrapper-watchdog.timer"));
  assert.ok(proven.printed.some((line) => line.startsWith("retired the gh-wrapper watchdog")));

  const unproven = await onboardWithGuards({ ghWrapperDeclared: false, herdrOutsideInstance: false });
  assert.ok(unproven.guards.every((path) => existsSync(path)), "no guard is removed without its replacement");
  assert.ok(unproven.printed.some((line) => line.includes("Restart herdr when no run is working")));
});

test("--no-start: onboard writes the host file and starts no service", async () => {
  const { deps: d, repo, started, stored } = deps();
  stored.set("keychain:agent-org-linear", KEY);
  await onboard(options({ repos: [repo], start: false }), d);
  assert.deepEqual(started, []);
});

// A11-158: a plugin the host file disables is not run, so onboard does not prompt for what it needs.
test("A11-158: a disabled tailscale exposure and a disabled atomic reviewer ask for neither Tailscale nor Codex", async () => {
  const base = deps({ which: () => null });
  mkdirSync(join(base.home, ".agent-org"), { recursive: true });
  writeFileSync(join(base.home, ".agent-org", "host.json"), JSON.stringify({ tickets: { providers: {
    exposure: { provider: "tailscale", enabled: false }, reviewer: { provider: "atomic", enabled: false } } } }));
  await onboard(options({ repos: [base.repo], keychain: "agent-org-linear", start: false }), base.deps);
  assert.ok(!base.printed.some((line) => line.includes("tailscale is not on PATH")), "a disabled exposure serves nothing on the tailnet");
  assert.ok(!base.printed.some((line) => /codex/i.test(line) && !line.includes("doctor")), "a disabled reviewer needs no Codex");
});
