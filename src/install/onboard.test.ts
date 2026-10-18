// no-token: none -- the Keychain, the prompts and the service are stand-ins, and the host file is written into a temporary HOME
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "../lib/tmp-fixture.ts";
import type { KeySource } from "../ticket-mode/settings.ts";
import { LINEAR_CONNECTORS, onboard, onboardServices, startServices, type OnboardDeps, type OnboardOptions } from "./onboard.ts";
import { PAIRING_STEPS } from "./terminal.ts";
import { ServiceRefusal, TailnetRefusal, type RunResult } from "./service.ts";

const KEY = "lin_api_SECRETSECRETSECRET";
const options = (over: Partial<OnboardOptions> = {}): OnboardOptions => ({
  repos: [], keychain: undefined, keyFile: undefined, start: true, terminal: true, autoUpdate: true, updateChannel: undefined, ...over,
});
const PLUGINS = JSON.stringify([{ plugin_id: "devswha.herdr-web-ui", plugin_root: "/h/.config/herdr/plugins/github/devswha.herdr-web-ui-1" }]);
const TERMINAL = "http://127.0.0.1:7318/?ws={workspace}&pane={pane}&view=terminal";

function deps(over: Partial<OnboardDeps> = {}, answers: string[] = []) {
  const home = tmpDir("onboard-");
  const repo = join(home, "src", "nbl-ui-netbox");
  mkdirSync(repo, { recursive: true });
  const stored = new Map<string, string>();
  const printed: string[] = [];
  const started: string[] = [];
  const ran: string[] = [];
  /** What each program answers, by its first two words; anything not named answers exit 0. */
  const answers2: Record<string, (args: string[]) => RunResult> = {};
  let plugins: string | null = null;
  const keyAt = (source: KeySource) => ("keychain" in source ? `keychain:${source.keychain}` : `file:${source.path}`);
  const value: OnboardDeps = {
    env: {}, home, platform: "darwin", interactive: false,
    ask: async () => answers.shift() ?? "", askHidden: async () => KEY,
    readKey: (source) => {
      const key = stored.get(keyAt(source));
      if (key === undefined) throw new Error("no key");
      return key;
    },
    storeInKeychain: (service) => { stored.set(`keychain:${service}`, KEY); },
    readFile: (path) => readFileSync(path, "utf8"),
    writeFile: (path, text) => {
      if (path.endsWith(".key")) stored.set(`file:${path}`, text.trim());
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, text);
    },
    isDirectory: (path) => { try { return statSync(path).isDirectory(); } catch { return false; } },
    ensureBun: async () => ({ path: "/h/.bun/bin/bun", installed: false }),
    herdrPlugins: () => plugins,
    run: (file, args) => {
      ran.push([file, ...args].join(" "));
      if (file === "herdr" && args[1] === "install") plugins = PLUGINS;
      return (answers2[`${file} ${args[0]} ${args[1]}`] ?? (() => ({ status: 0, stdout: "", stderr: "" })))(args);
    },
    startServices: (names) => { started.push(...names); return names.map((name) => `started the ${name} service`).join("\n"); },
    out: { log: (line: string) => printed.push(line) },
    ...over,
  };
  return { deps: value, home, repo, stored, printed, started, ran, answers: answers2, setPlugins: (text: string | null) => { plugins = text; } };
}

test("onboard writes clones and the key source from flags, keeps the host file's other keys, and starts the instance service", async () => {
  const { deps: d, home, repo, stored, printed, started } = deps();
  stored.set("keychain:agent-org-linear", KEY);
  const hostFile = join(home, ".agent-org", "host.json");
  mkdirSync(join(home, ".agent-org"));
  writeFileSync(hostFile, JSON.stringify({ stateDir: "/var/agent-org", tickets: { max: 5 } }));
  await onboard(options({ repos: [`netbox=${repo}`], keychain: "agent-org-linear" }), d);
  assert.deepEqual(JSON.parse(readFileSync(hostFile, "utf8")), {
    stateDir: "/var/agent-org", clones: { netbox: repo },
    tickets: { max: 5, linearKey: { keychain: "agent-org-linear" }, terminal: TERMINAL, connectors: [...LINEAR_CONNECTORS] },
  });
  assert.deepEqual(started, ["instance", "ui", "terminal", "auto-update"]);
  assert.ok(printed.some((line) => line === "the Linear key is readable from the Keychain service agent-org-linear"));
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
  assert.deepEqual(onboardServices(true, true), ["instance", "ui", "terminal", "auto-update"]);
  assert.deepEqual(onboardServices(false, false), ["instance", "ui"]);
  const unit = (name: string) => ({ manager: "systemd" as const, id: name, path: name, text: "", log: null, companion: null, interval: false, address: null });
  const lines = startServices(["instance", "terminal"], (name) => {
    if (name === "terminal") throw new ServiceRefusal("no bun");
    return unit(name);
  });
  assert.equal(lines, "started the instance service (systemd instance)\ndid not start the terminal service: no bun");
  assert.throws(() => startServices(["instance"], () => { throw new ServiceRefusal("port in use"); }), /port in use/);
});

// A11-66: the web terminal, set up by onboard.
test("onboard installs herdr web ui when herdr lists it not, with bun's directory first on PATH, and writes tickets.terminal", async () => {
  const { deps: d, home, repo, ran, printed } = deps({ env: { PATH: "/usr/bin" }, ensureBun: async () => ({ path: "/h/.bun/bin/bun", installed: true }) });
  let pathGiven = "";
  const run = d.run;
  await onboard(options({ repos: [repo] }), { ...d, run: (file, args, env) => { if (file === "herdr") pathGiven = env?.PATH ?? ""; return run(file, args, env); } });
  assert.ok(ran.includes("herdr plugin install devswha/herdr-web-ui --yes"));
  assert.equal(pathGiven, "/h/.bun/bin:/usr/bin");
  assert.ok(printed.includes("installed bun at /h/.bun/bin/bun, for the web terminal"));
  assert.equal(JSON.parse(readFileSync(join(home, ".agent-org", "host.json"), "utf8")).tickets.terminal, TERMINAL);
});

test("onboard keeps an existing tickets.terminal and does not reinstall an installed plugin", async () => {
  const { deps: d, home, repo, ran, setPlugins } = deps();
  setPlugins(PLUGINS);
  mkdirSync(join(home, ".agent-org"));
  const mine = "http://127.0.0.1:9000/?ws={workspace}";
  writeFileSync(join(home, ".agent-org", "host.json"), JSON.stringify({ tickets: { terminal: mine } }));
  await onboard(options({ repos: [repo] }), d);
  assert.ok(!ran.some((line) => line.startsWith("herdr plugin install")));
  assert.equal(JSON.parse(readFileSync(join(home, ".agent-org", "host.json"), "utf8")).tickets.terminal, mine);
});

test("a terminal that cannot be set up is said, writes no tickets.terminal and starts no terminal service; --no-terminal does not try", async () => {
  const failing = deps();
  failing.answers["herdr plugin install"] = () => ({ status: 1, stdout: "", stderr: "herdr: no network\nmore" });
  await onboard(options({ repos: [failing.repo] }), { ...failing.deps, run: (file, args) => (file === "herdr" ? { status: 1, stdout: "", stderr: "herdr: no network\nmore" } : { status: 0, stdout: "", stderr: "" }) });
  assert.ok(failing.printed.some((line) => line.startsWith("the web terminal is not set up: `herdr plugin install devswha/herdr-web-ui --yes` failed: herdr: no network.")));
  assert.equal(JSON.parse(readFileSync(join(failing.home, ".agent-org", "host.json"), "utf8")).tickets.terminal, undefined);
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

test("onboard leaves an existing linear MCP alone, scrubs the key from a failed add, and registers none without a readable key", async () => {
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
  assert.equal(JSON.parse(readFileSync(join(keyless.home, ".agent-org", "host.json"), "utf8")).tickets.connectors, undefined);
});

test("onboard adds Linear's read and comment tools to tickets.connectors where absent, and keeps the person's own", async () => {
  const { deps: d, home, repo, stored } = deps();
  stored.set("keychain:agent-org-linear", KEY);
  mkdirSync(join(home, ".agent-org"));
  writeFileSync(join(home, ".agent-org", "host.json"), JSON.stringify({ tickets: { connectors: ["^mcp__slack__read_", "^mcp__linear__save_comment$"] } }));
  await onboard(options({ repos: [repo] }), d);
  assert.deepEqual(JSON.parse(readFileSync(join(home, ".agent-org", "host.json"), "utf8")).tickets.connectors,
    ["^mcp__slack__read_", "^mcp__linear__save_comment$", "^mcp__linear__(get|list|search|extract)_"]);
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
