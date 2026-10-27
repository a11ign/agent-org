// no-token: none -- the Keychain, the prompts, the services, the programs and the plugin's install record are stand-ins; the host file, the profile and the
// notes are written into a temporary HOME, which is the fake home each test checks
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "../lib/tmp-fixture.ts";
import { CONNECTORS as LINEAR_CONNECTORS } from "../../plugins/linear/connectors.ts";
import { runPlugin } from "../plugins/cli.ts";
import { type LoadResult, loadEnabled } from "../plugins/loader.ts";
import type { OnboardStep } from "../plugins/manifest.ts";
import { buildCatalog, defaultCatalog, type PackageFiles, pluginNamed } from "../plugins/registry.ts";
import { gateHelpers } from "../plugins/reviewing-gate.ts";
import { HerdrInstallRefusal } from "./herdr-install.ts";
import { onboard, onboardServices, OnboardRefusal, startServices, type OnboardDeps, type OnboardOptions } from "./onboard.ts";
import { createTailscale, freshState } from "../../plugins/tailscale/stub.ts";
import { ServiceRefusal, TailnetRefusal, type RunResult } from "./service.ts";
import type { ProgramRunner, Program } from "./gh-account.ts";
import { type Check, diagnose, type DoctorDeps } from "./doctor.ts";
import { shimTextFor } from "./launcher.ts";
import { judgeShellCommand, readShellCommand, realShellDeps, shellContext, type ShellReading } from "./shell-command.ts";
import type { CopyComparison } from "./tool-copy.ts";
import type { ProfileRepo } from "./onboard-profile.ts";
import { fakeAgentOrgPlugins } from "../plugins/fakes/doctor-seam.ts";
import type { Replacements } from "./interim-guards.ts";
import { PLAYWRIGHT_CLI, type ChromiumReport } from "./chromium.ts";
import { createFakeCodeHost } from "../plugins/fakes/code-host.ts";
import { PassThrough, Writable } from "node:stream";
import { clackPrompts, PromptCancelled, type Prompts } from "./prompts.ts";
import { Screen } from "./screen-fixture.ts";

const STACK_LISTED = "gh stack  github/gh-stack  v0.2.1\n";
/** The GitHub CLI as the tests see it by default: the stack extension is listed, and nothing else is asked. */
const listedGh = (): ProgramRunner => (args: string[]): Program => ({ status: 0, stdout: args[1] === "list" ? STACK_LISTED : "", stderr: "" });
const OK: RunResult = { status: 0, stdout: "", stderr: "" };
/** The lines onboard printed, without the indent a ✓ or ✗ line puts on its details, so a sentence is compared as it was written. */
const trimmed = (lines: readonly string[]): string[] => lines.map((line) => line.trim());

const KEY = "lin_api_SECRETSECRETSECRET";
const PEM = "-----BEGIN PRIVATE KEY-----\nSECRETPEMSECRET\n-----END PRIVATE KEY-----\n";
const PLUGIN = "example@example-marketplace";
const REPO = "example-org/example-plugin";
const TERMINAL = "http://127.0.0.1:7318/?ws={workspace}&pane={pane}&view=terminal";
const options = (over: Partial<OnboardOptions> = {}): OnboardOptions => ({
  repos: [], keychain: undefined, keyFile: undefined, profile: undefined, start: true, terminal: true, autoUpdate: true, updateChannel: undefined, verbose: false, ...over,
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

/** Linear knows the key: it is the viewer's, and the step says whose (A11-222). */
const linearKnowsTheKey: typeof fetch = async () => new Response(JSON.stringify({ data: { viewer: { id: "u1", name: "Casey Chairman", email: "casey@example.com" } } }), { status: 200 });

/** Prompts nobody answers: a test that reaches one has asked a person something it should not have. */
const NO_PROMPTS: Prompts = {
  pickMany: () => Promise.reject(new Error("a list was shown")), confirm: () => Promise.reject(new Error("a yes or no was asked")), text: () => Promise.reject(new Error("a line was asked")),
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
  const value: OnboardDeps = {
    env: {}, home, platform: "darwin", arch: "arm64", interactive: false,
    ask: async (question) => { asked.push(question); return answers.shift() ?? ""; },
    askHidden: async (question) => { hidden.push(question); return KEY; },
    // The Keychain, as the Linear plugin's steps reach it: `security` finds a key stored under a service, and `security -i` stores the one the person pastes (A11-222), the command on its standard input.
    exec: (file, args, execOptions) => {
      if (file === "security" && args[0] === "find-generic-password") {
        const key = stored.get(`keychain:${args[2]}`);
        return key === undefined ? { status: 44, stdout: "", stderr: "could not be found" } : { status: 0, stdout: `${key}\n`, stderr: "" };
      }
      if (file === "security" && args[0] === "-i") {
        stored.set(`keychain:${/-s "([^"]+)"/.exec(execOptions?.input ?? "")?.[1]}`, KEY);
        return OK;
      }
      // The code host plugin's step runs `gh` through `exec` (A11-160): by default the extension is listed, as these tests have always seen it.
      if (file === "gh") return { status: 0, stdout: args[1] === "list" ? STACK_LISTED : "", stderr: "" };
      // The atomic reviewer's step asks where Codex is (A11-161): by default it is installed, and logged in.
      if (file === "which" && args[0] === "codex") return { status: 0, stdout: "/usr/local/bin/codex\n", stderr: "" };
      return value.run(file, [...args]);
    },
    catalog: defaultCatalog,
    loadPlugins: (providers, pluginDeps) => loadEnabled(providers, defaultCatalog(), pluginDeps),
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
    listDir: (path) => { try { return readdirSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; } },
    // The folder onboard runs in holds nothing, and the code host lists nothing: at a terminal the picker finds nothing to offer and onboard asks for paths, as it always did (A11-186).
    cwd: join(home, "repos"),
    codeHost: () => { const host = createFakeCodeHost(); host.seedOwners(null); return host; },
    prompts: NO_PROMPTS,
    ensureBun: async () => ({ path: "/h/.bun/bin/bun", installed: false }),
    installHerdr: async () => { throw new Error("must not be asked: herdr is on PATH"); }, putOnPath: () => { throw new Error("must not be asked"); },
    herdrPlugins: () => plugins,
    newestPluginTag: () => "v0.4.13",
    run: (file, args) => {
      const override = runOver(file, args);
      if (override !== undefined) return override;
      ran.push([file, ...args].join(" "));
      if (file === "herdr" && args[0] === "plugin" && args[1] === "install") plugins = PLUGINS;
      return (answers2[`${file} ${args[0]} ${args[1]}`] ?? (() => OK))(args);
    },
    which: () => "/usr/local/bin/tool",
    ghAs: () => listedGh(),
    replacements: async () => ({ ghWrapperDeclared: true, herdrInOwnUnit: true }),
    diagnose: async () => [], shell: { env: {}, home, type: () => null, read: () => null, readlink: () => null, which: () => null, compare: () => ({ kind: "no-install" }), hasInstall: () => false },
    chromium: () => BROWSERS_READY, isRoot: () => false,
    startServices: async (names) => { started.push(...names); return names.map((name) => ({ name, ok: true, line: `started the ${name} service`, address: name === "ui" ? "http://127.0.0.1:4748/" : null })); },
    fetch: linearKnowsTheKey, color: false,
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
        tracker: { provider: "linear", enabled: true, key: { keychain: "agent-org-linear" }, connectors: [...LINEAR_CONNECTORS] },
        codeHost: { provider: "github", enabled: true },
        exposure: { provider: "local", enabled: true, terminal: TERMINAL },
      },
    },
  });
  assert.deepEqual(started, ["herdr", "instance", "ui", "terminal", "auto-update", "watchdog"]);
  assert.ok(printed.includes("  ✓ Linear key works: signed in as Casey Chairman"), printed.join("\n"));
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

test("onboard ends with a clear line that this machine is set up and the commands to run next, whether or not services start", async () => {
  for (const start of [true, false]) {
    const { deps: d, repo, stored, printed } = deps();
    stored.set("keychain:agent-org-linear", KEY);
    await onboard(options({ repos: [`netbox=${repo}`], keychain: "agent-org-linear", start }), d);
    const end = printed.slice(printed.indexOf("agent-org is set up on this machine."));
    assert.deepEqual(end, ["agent-org is set up on this machine.", "\nNext:", ...(start ? ["  open the board        http://127.0.0.1:4748/"] : []),
      "  agent-org ticket:pair pair a browser with the board (add --terminal for the worker terminal)", "  agent-org doctor      check everything works"], `start ${start}`);
    assert.ok(!printed.some((line) => line.includes("to pair a new device")), "the old sentence is replaced by the Next: block");
  }
});

test("a doctor check that only warns is drawn as a ! line with its fix, and does not make the machine incomplete", async () => {
  const warned: Check[] = [{ name: "ui build", ok: true, detail: "no build is installed", fix: "run `pnpm ui:build`", warning: true }];
  const { deps: d, repo, stored, printed } = deps({ diagnose: async () => warned });
  stored.set("keychain:agent-org-linear", KEY);
  await onboard(options({ repos: [`netbox=${repo}`], keychain: "agent-org-linear" }), d);
  assert.ok(printed.includes("  ! ui build: no build is installed") && printed.includes("    run `pnpm ui:build`"), printed.join("\n"));
  assert.ok(printed.includes("agent-org is set up on this machine."));
});

test("browsers that start but whose install reported a problem are ready, with the problem drawn as a warning", async () => {
  const { deps: d, repo, stored, printed } = deps({}, [], (file, args) => (file === "node" && args.includes("install") ? { status: 1, stdout: "", stderr: "download interrupted" } : undefined));
  stored.set("keychain:agent-org-linear", KEY);
  await onboard(options({ repos: [`netbox=${repo}`], keychain: "agent-org-linear" }), d);
  assert.ok(printed.includes("  ✓ Browsers for page captures installed"));
  assert.ok(printed.includes("  ! Installing the browsers reported a problem") && printed.includes("    the Chromium browsers did not install: download interrupted"), printed.join("\n"));
  assert.ok(printed.includes("agent-org is set up on this machine."), "a warning does not count");
});

test("an unattended onboard whose profile names a reviewer App with no key says so as a ✗, and does not call the machine set up", async () => {
  const { deps: d, home, repo, stored, printed } = deps({ platform: "linux" });
  stored.set("keychain:agent-org-linear", KEY);
  seedProfile(home, repo);
  await onboard(options({ profile: "example-laptop", keychain: "agent-org-linear", start: false }), d);
  assert.ok(printed.includes("  ✗ Reviewer App key is not set"), printed.join("\n"));
  assert.ok(printed.some((line) => line.includes("NO reviewer App key is set for example-reviewer")));
  assert.ok(printed.includes("agent-org is not fully set up: 1 step above needs fixing.") || printed.some((line) => line.startsWith("agent-org is not fully set up")));
});

test("a doctor check that fails ends onboard with its ✗ line and fix, and says the machine is not fully set up; the full report is for --verbose", async () => {
  const failing: Check[] = [{ name: "instance", ok: true, detail: "running", fix: null }, { name: "board key", ok: false, detail: "no key is set", fix: "run `agent-org ticket:pair`" }];
  for (const verbose of [false, true]) {
    const { deps: d, repo, stored, printed } = deps({ diagnose: async () => failing });
    stored.set("keychain:agent-org-linear", KEY);
    await onboard(options({ repos: [`netbox=${repo}`], keychain: "agent-org-linear", verbose }), d);
    assert.ok(printed.includes("  ✗ board key: no key is set") && printed.includes("    run `agent-org ticket:pair`"), printed.join("\n"));
    assert.ok(printed.includes("agent-org is not fully set up: 1 step above needs fixing."));
    assert.ok(!printed.includes("agent-org is set up on this machine."));
    assert.equal(printed.some((line) => line.includes("instance: running") || line.startsWith("instance")), verbose, "the whole report only with --verbose");
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
  assert.ok(trimmed(printed).some((line) => line.startsWith("NO LINEAR KEY is readable from the Keychain service agent-org-linear. Store one with: security add-generic-password")));
  assert.ok(printed.includes("  ✗ Linear connected as the tracker"), "the plugin's line fails, with the fix beneath");
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

test("onboard's start starts the instance and the ui service, in that order", async () => {
  const started: string[] = [];
  const lines = await startServices(["instance", "ui"], async (name) => {
    started.push(name);
    return { manager: "systemd", id: `agent-org-${name}.service`, path: `/u/agent-org-${name}.service`, text: "", log: null, companion: null, interval: false, address: null };
  });
  assert.deepEqual(started, ["instance", "ui"]);
  assert.equal(lines, "started the instance service (systemd agent-org-instance.service)\nstarted the ui service (systemd agent-org-ui.service)");
});

test("onboard starts the terminal only once it is set up and auto-update unless opted out; a refused optional service is said, a refused instance fails", async () => {
  assert.deepEqual(onboardServices({ terminal: true, autoUpdate: true }), ["herdr", "instance", "ui", "terminal", "auto-update", "watchdog"], "herdr first: the instance and the terminal start after it");
  assert.deepEqual(onboardServices({ terminal: false, autoUpdate: false }), ["herdr", "instance", "ui", "watchdog"]);
  const unit = (name: string) => ({ manager: "systemd" as const, id: name, path: name, text: "", log: null, companion: null, interval: false, address: null });
  const lines = await startServices(["instance", "terminal"], async (name) => {
    if (name === "terminal") throw new ServiceRefusal("no bun");
    return unit(name);
  });
  assert.equal(lines, "started the instance service (systemd instance)\ndid not start the terminal service: no bun");
  await assert.rejects(startServices(["instance"], async () => { throw new ServiceRefusal("port in use"); }), /port in use/);
  const moved = await startServices(["herdr", "instance"], async (name) => {
    if (name === "herdr") throw new ServiceRefusal("the herdr server for session tickets runs outside agent-org-herdr.service. Run `agent-org start herdr --move` at a quiet moment");
    return unit(name);
  });
  assert.equal(moved, "did not start the herdr service: the herdr server for session tickets runs outside agent-org-herdr.service. Run `agent-org start herdr --move` at a quiet moment\nstarted the instance service (systemd instance)",
    "a herdr server outside its unit is said, with the move, and onboard goes on: it never starts a second server beside it");
});

// A11-66: the web terminal, set up by onboard, written into the exposure block (A11-144).
test("onboard installs herdr web ui when herdr lists it not, with bun's directory first on PATH, and writes the exposure block's terminal", async () => {
  const { deps: d, home, repo, ran, printed } = deps({ env: { PATH: "/usr/bin" }, ensureBun: async () => ({ path: "/h/.bun/bin/bun", installed: true }) });
  let pathGiven = "";
  const run = d.run;
  await onboard(options({ repos: [repo], verbose: true }), { ...d, run: (file, args, env) => { if (file === "herdr" && args[0] === "plugin") pathGiven = env?.PATH ?? ""; return run(file, args, env); } });
  assert.ok(ran.includes("herdr plugin install devswha/herdr-web-ui --ref v0.4.13 --yes"), "at the newest release tag, never the default branch");
  assert.ok(!ran.includes("herdr plugin install devswha/herdr-web-ui --yes"));
  assert.equal(pathGiven, "/h/.bun/bin:/usr/bin");
  assert.ok(printed.includes("  ✓ Worker terminal installed"));
  assert.ok(trimmed(printed).includes("installed bun at /h/.bun/bin/bun, for the web terminal"), "the details are for --verbose");
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
  assert.ok(failing.printed.includes("  ✗ Worker terminal not set up"));
  assert.ok(trimmed(failing.printed).some((line) => line.startsWith("`herdr plugin install devswha/herdr-web-ui --ref v0.4.13 --yes` failed: herdr: no network. The board shows no terminal link until it is")));
  assert.equal(hostOf(failing.home).tickets.providers.exposure.terminal, undefined);
  assert.deepEqual(failing.started, ["herdr", "instance", "ui", "auto-update", "watchdog"]);
  const off = deps({ ensureBun: async () => { throw new Error("must not be asked"); } });
  await onboard(options({ repos: [off.repo], terminal: false, autoUpdate: false }), off.deps);
  assert.ok(!off.ran.some((line) => line.startsWith("herdr plugin")));
  assert.deepEqual(off.started, ["herdr", "instance", "ui", "watchdog"]);
});

// A11-71: Linear's MCP for the workers, authenticated by the key, which is never printed.
test("onboard registers Linear's MCP at user scope with the key as a bearer header, and never prints the key", async () => {
  const { deps: d, repo, stored, ran, printed, answers } = deps();
  stored.set("keychain:agent-org-linear", KEY);
  answers["claude mcp get"] = () => ({ status: 1, stdout: "", stderr: "No MCP server named \"linear\"" });
  await onboard(options({ repos: [repo], verbose: true }), d);
  assert.ok(ran.includes(`claude mcp add --scope user --transport http linear https://mcp.linear.app/mcp --header Authorization: Bearer ${KEY}`));
  assert.ok(printed.includes("  ✓ Workers can read Linear"));
  assert.ok(trimmed(printed).includes("registered Linear's MCP for Claude Code (user scope), authenticated by the key in the Keychain service agent-org-linear"));
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
  const said = trimmed(failing.printed).find((line) => line.startsWith("could not register Linear's MCP")) ?? "";
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

test("a service on the tailnet is said with its address when it starts, and a page the exposure refuses fails onboard", async () => {
  const served = (name: string) => ({ manager: "systemd" as const, id: `agent-org-${name}.service`, path: name, text: "", log: null, companion: null, interval: false, address: "https://agents.tail1234.ts.net:9443/" });
  assert.equal(await startServices(["ui"], async (name) => served(name)), "started the ui service (systemd agent-org-ui.service), served at https://agents.tail1234.ts.net:9443/");
  await assert.rejects(startServices(["instance", "ui"], async (name) => {
    if (name === "ui") throw new TailnetRefusal("the ui service started on 127.0.0.1, but the exposure does not reach it: refused");
    return { ...served(name), address: null };
  }), /the exposure does not reach it/);
});

test("a terminal the exposure does not reach is said as running on loopback, not as not started", async () => {
  const lines = await startServices(["instance", "terminal"], async (name) => {
    if (name === "terminal") throw new TailnetRefusal("the terminal service started on 127.0.0.1, but the exposure does not reach it: refused");
    return { manager: "systemd" as const, id: "agent-org-instance.service", path: name, text: "", log: null, companion: null, interval: false, address: null };
  });
  assert.equal(lines, "started the instance service (systemd agent-org-instance.service)\nthe terminal service started on 127.0.0.1, but the exposure does not reach it: refused");
});

/** A machine whose `gh` lists the stacking extension once `install` has run, recording each call's environment and command, and whose host file names the workers' account. */
function stackDeps(install: Program) {
  let listed = false;
  const calls: { command: string; env: unknown }[] = [];
  const base = deps();
  const exec: OnboardDeps["exec"] = (file, args, options) => {
    if (file !== "gh") return base.deps.exec(file, args, options);
    calls.push({ command: args.join(" "), env: options?.env });
    if (args[1] === "install") {
      if (install.status === 0) listed = true;
      return install;
    }
    return { status: 0, stdout: listed ? STACK_LISTED : "", stderr: "" };
  };
  const workers = join(base.home, "workers");
  mkdirSync(join(base.home, ".agent-org"), { recursive: true });
  writeFileSync(join(base.home, ".agent-org", "host.json"), JSON.stringify({ clones: { netbox: base.repo }, tickets: {}, gh: { workers } }));
  return { ...base, deps: { ...base.deps, exec }, calls, workers };
}

test("A11-160: onboard runs the code host plugin's step, which installs the stacking extension for the workers' account when it is missing, and says so", async () => {
  const { deps: d, repo, printed, calls, workers } = stackDeps({ status: 0, stdout: "", stderr: "" });
  await onboard(options({ repos: [`netbox=${repo}`], keychain: "agent-org-linear", start: false, verbose: true }), d);
  assert.ok(calls.some(({ command }) => command === "extension install github/gh-stack"), "the extension is installed");
  assert.ok(calls.every(({ env }) => JSON.stringify(env) === JSON.stringify({ GH_CONFIG_DIR: join(workers, "gh") })), "every call runs as the workers' account");
  assert.ok(printed.includes("  ✓ GitHub stacked pull requests ready"));
  assert.ok(trimmed(printed).includes("installed the github/gh-stack extension (v0.2.1), which a worker links a stacked pull request with"), "the extension's name and version are for --verbose");
});

test("A11-160: onboard does not install the stacking extension again where it is listed", async () => {
  const base = deps();
  const commands: string[] = [];
  const exec: OnboardDeps["exec"] = (file, args, options) => {
    if (file !== "gh") return base.deps.exec(file, args, options);
    commands.push(args.join(" "));
    return { status: 0, stdout: STACK_LISTED, stderr: "" };
  };
  await onboard(options({ repos: [`netbox=${base.repo}`], keychain: "agent-org-linear", start: false, verbose: true }), { ...base.deps, exec });
  assert.deepEqual(commands, ["extension list"], "a listed extension is not installed again");
  assert.ok(trimmed(base.printed).includes("the github/gh-stack extension is installed (v0.2.1), which a worker links a stacked pull request with"));
});

test("A11-160: a stacking extension that fails to install is said with its reason and the command to run, and onboard still completes", async () => {
  const { deps: d, repo, printed, workers } = stackDeps({ status: 1, stdout: "", stderr: "could not reach github.com\nmore" });
  const hostFile = await onboard(options({ repos: [`netbox=${repo}`], keychain: "agent-org-linear", start: false }), d);
  assert.ok(printed.includes("  ✗ GitHub stacked pull requests are not set up"));
  assert.ok(trimmed(printed).includes(`could not install the github/gh-stack extension: could not reach github.com. Run \`GH_CONFIG_DIR=${join(workers, "gh")} gh extension install github/gh-stack\` by hand, then \`agent-org doctor\`.`));
  assert.ok(existsSync(hostFile), "the host file is written all the same");
});

test("A11-145: a host that sets codeHost.stack to false is not asked for the stacking extension", async () => {
  const base = deps();
  const asked: string[] = [];
  const exec: OnboardDeps["exec"] = (file, args, options) => {
    if (file === "gh") asked.push(args.join(" "));
    return base.deps.exec(file, args, options);
  };
  mkdirSync(join(base.home, ".agent-org"), { recursive: true });
  writeFileSync(join(base.home, ".agent-org", "host.json"), JSON.stringify({ tickets: { providers: { codeHost: { provider: "github", stack: false } } } }));
  await onboard(options({ repos: [base.repo], keychain: "agent-org-linear", start: false }), { ...base.deps, exec });
  assert.deepEqual(asked, [], "gh is not asked at all");
  assert.ok(!base.printed.some((line) => line.includes("gh-stack")));
});

// A11-145: the profile path. Onboard asks only for the secrets, and writes what the profile names, with the App's key copied beside the host file.
/** The doctor's readings of the fake home, each green: what `agent-org doctor` asks, answered for a machine with every secret and install in place. */
function greenDoctor(home: string): DoctorDeps {
  return {
    env: { HOME: home }, home, nodeVersion: () => "v24.21.0", which: () => "/usr/local/bin/tool", readFile: (path) => readFileSync(path, "utf8"),
    exec: (file, args) => {
      if (file === "claude") return { status: 0, stdout: "linear: https://mcp.linear.app/mcp (HTTP) - Connected\n", stderr: "" };
      // The code host plugin's checks run `gh`: the stacking extension is listed, and no clone has a GitHub remote to ask about.
      if (file === "gh") return { status: 0, stdout: args[0] === "extension" ? STACK_LISTED : "[]", stderr: "" };
      // The atomic reviewer's checks run `which codex` and `codex login status` (A11-161): Codex is installed and logged in.
      if (file === "which" && args[0] === "codex") return { status: 0, stdout: "/usr/local/bin/codex\n", stderr: "" };
      if (file === "codex") return { status: 0, stdout: "", stderr: "" };
      // The code host plugin's identity rows mint a token for the reviewer's App on this ticket-only host too (A11-160): the minter answers one.
      if (file === "node" && args[0]?.endsWith("plugins/github/app-token.ts")) return { status: 0, stdout: "ghs_minted\n", stderr: "" };
      return { status: null, stdout: "", stderr: "cannot start" };
    },
    mode: () => 0o600, serviceState: () => "running", answers: async () => true, healthy: async () => true, unitProblem: () => null,
    pnpmVersion: () => ({ version: "10.34.5", via: "npm exec" as const }),
    probe: async () => 200,
    hostPlace: async () => ({ kind: "no-project" }), platform: "linux", arch: "x64",
    herdrPlace: () => ({ kind: "unit", where: "/user.slice/agent-org-herdr.service" }), guards: () => ({ watchdog: false, dropIn: false, readCacheDropIn: false }), updateStatus: () => ({ kind: "absent" }),
    herdrIntegrations: () => ({ status: 0, stdout: "claude: current (v10)\ncodex: current (v8)\n", stderr: "" }), herdrVersion: () => "herdr 0.9.3", herdrPlugins: () => null, herdrStatus: () => ({ kind: "absent" }),
    uiBuild: () => ({ found: "/t/ui-build", declared: true, looked: "/t/ui-build", version: "v0.280.0" }),
    drain: () => ({ kind: "none" }), runs: () => [], longWaits: () => [], boardFigures: async () => null, watchdog: () => null, instanceVersion: () => "v0.280.0", pluginCopies: () => [], releaseTags: () => [],
    plugins: (input) => ({ states: { readable: true, plugins: input.wanted.map((plugin) => ({ plugin, installs: [], loads: true, why: null, installPath: null })) }, unreachable: [], rows: [], contracts: [] }),
    reviewing: { ...gateHelpers(), loadGate: async () => undefined, gateRefusal: () => null }, declaredRepositories: async () => [], reviewerRefusals: () => [], flakes: () => ({ limit: 3, days: 7, tests: [] }), chromium: () => BROWSERS_READY, agentOrgPlugins: fakeAgentOrgPlugins(), now: () => Date.now(),
    shellCommand: () => installedShell(home),
  };
}

/** The `agent-org` command a green fake home finds: a file on PATH whose copy is the installed tool (A11-285). */
function installedShell(home: string): ShellReading {
  const command = join(home, "bin", "agent-org");
  return { kind: "file", said: command, launcher: command, copyRoot: join(home, ".agent-org", "tool", "current"), defined: { file: command, line: null }, comparison: { kind: "installed" }, noInstall: false };
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
    tracker: { provider: "linear", enabled: true, workingState: "In Progress", plannedState: "Planned", key: { path: join(home, ".agent-org", "linear.key") }, connectors: [...LINEAR_CONNECTORS] },
    codeHost: { provider: "github", enabled: true, identity: { reviewer: { mode: "github-apps", slug: "example-reviewer", appId: 111, installationId: 222, keyPath: join(home, ".agent-org", "apps", "example-reviewer.pem") } } },
    publish: { provider: "none" }, reviewer: { provider: "atomic", enabled: true }, exposure: { provider: "local", enabled: true, terminal: TERMINAL },
  });
  assert.deepEqual(host.tickets.pick, { team: "ZZ" });
  assert.deepEqual(host.tickets.plugins, [PLUGIN]);
  assert.equal(host.tickets.plan, "-plan-[^/]*\\.md$");
  assert.deepEqual(host.tickets.planner, { run: "Run the example:create-ticket skill with this request: unattended: plan {keys} into {dir}" });
  assert.deepEqual(host.tickets.writer, { run: "Run the example:create-ticket skill for this request: {request}. Write each draft under {dir}/drafts." });
  assert.equal(host.tickets.brief, join(home, ".agent-org", "worker-notes.md"));
  assert.equal(host.tickets.review, join(home, ".agent-org", "review-notes.md"));

  assert.ok(!printed.join("\n").includes(KEY) && !printed.join("\n").includes("SECRETPEMSECRET"), "no secret is printed");
  assert.ok(printed.includes("  ✓ Conventions plugin ready: example@example-marketplace"), "the plugin was installed for every folder");
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
  assert.ok(printed.includes("  ✓ Answers saved to ~/.agent-org/profiles/new-laptop.json: copy it to set up another machine; it holds no secret"), printed.join("\n"));
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
  await onboard(options({ repos: [machine.repo], keychain: "agent-org-linear", start: false, verbose: true }), machine.deps);
  return { guards, printed: machine.printed, ran: machine.ran };
}

test("A11-145: the interim guards are retired on Linux once their replacements are proven, and kept with the fix named when they are not", async () => {
  const proven = await onboardWithGuards({ ghWrapperDeclared: true, herdrInOwnUnit: true });
  assert.ok(proven.guards.every((path) => !existsSync(path)), "every guard file is removed");
  assert.ok(proven.ran.includes("systemctl --user disable --now gh-wrapper-watchdog.timer"));
  assert.ok(proven.printed.includes("  ✓ Old workarounds retired"));
  assert.ok(trimmed(proven.printed).some((line) => line.startsWith("retired the gh-wrapper watchdog")), "what was retired is for --verbose");

  const unproven = await onboardWithGuards({ ghWrapperDeclared: false, herdrInOwnUnit: false });
  assert.ok(unproven.guards.every((path) => existsSync(path)), "no guard is removed without its replacement");
  assert.ok(unproven.printed.includes("  ✗ An old workaround is still in place"));
  assert.ok(unproven.printed.some((line) => line.includes("Run `agent-org start herdr --move`")));
});

test("--no-start: onboard writes the host file and starts no service", async () => {
  const { deps: d, repo, started, stored } = deps();
  stored.set("keychain:agent-org-linear", KEY);
  await onboard(options({ repos: [repo], start: false }), d);
  assert.deepEqual(started, []);
});

// A11-158: a plugin the host file disables is not run, so onboard does not prompt for what it needs.
test("A11-158: a disabled tailscale exposure and a disabled atomic reviewer ask for neither Tailscale nor Codex", async () => {
  const base = deps({ which: (name) => (name === "herdr" ? "/usr/local/bin/herdr" : null) });
  mkdirSync(join(base.home, ".agent-org"), { recursive: true });
  writeFileSync(join(base.home, ".agent-org", "host.json"), JSON.stringify({ tickets: { providers: {
    exposure: { provider: "tailscale", enabled: false }, reviewer: { provider: "atomic", enabled: false } } } }));
  await onboard(options({ repos: [base.repo], keychain: "agent-org-linear", start: false }), base.deps);
  assert.ok(!base.printed.some((line) => line.includes("tailscale is not on PATH")), "a disabled exposure serves nothing on the tailnet");
  assert.ok(!base.printed.some((line) => /codex/i.test(line) && !line.includes("doctor") && !line.includes("herdr") && !line.includes("switched off")), "a disabled reviewer needs no Codex");
  assert.ok(base.printed.includes("Board served on the tailnet: switched off; onboard leaves it off"), "and each is said to be switched off, in setup words");
  assert.ok(base.printed.includes("Codex reviewer ready: switched off; onboard leaves it off"));
});

// ---- A11-162: the Tailscale plugin's onboard steps run when the host will enable it, and the exposure `local` asks nothing of Tailscale

const seedExposure = (home: string, exposure: Record<string, unknown>) => {
  mkdirSync(join(home, ".agent-org"), { recursive: true });
  writeFileSync(join(home, ".agent-org", "host.json"), JSON.stringify({ tickets: { providers: { exposure } } }));
};

test("A11-162: onboarding a tailscale exposure with no Tailscale installed says so in the words it always did, and leaves the block's ports alone", async () => {
  const base = deps({}, [], (file) => (file === "tailscale" ? { status: null, stdout: "", stderr: "ENOENT" } : undefined));
  seedExposure(base.home, { provider: "tailscale" });
  await onboard(options({ repos: [base.repo], keychain: "agent-org-linear", start: false }), base.deps);
  assert.ok(base.printed.includes("  ✗ Tailscale is not installed"));
  assert.ok(trimmed(base.printed).includes("tailscale is not on PATH: the board and the terminal are served on the tailnet once Tailscale is installed and `tailscale up` has run. `agent-org doctor` says what is missing"));
  assert.ok(base.printed.includes("  ✗ Board served on the tailnet"), "the plugin's line fails, and points at the step above rather than saying it twice");
  assert.deepEqual(hostOf(base.home).tickets.providers.exposure, { provider: "tailscale", enabled: true, terminal: "http://127.0.0.1:7318/?ws={workspace}&pane={pane}&view=terminal" },
    "an interactive onboard writes no ports (a profile's get the plugin's defaults, as they always did); the terminal's address is onboard's, as before");
});

test("A11-162: a Tailscale that will not let this user change its serve config says the operator command, and a taken tailnet port is said before the services start", async () => {
  const state = freshState({ operator: false });
  state.web["agents.tail1234.ts.net:9443"] = { Handlers: { "/": { Proxy: "http://127.0.0.1:9999" } } };
  const stub = createTailscale(state);
  const base = deps({ env: { USER: "agent" } }, [], (file, args) => (file === "tailscale" ? (args[0] === "serve" && args[1] === "status" ? { status: 1, stdout: "", stderr: "Access denied: serve config denied" } : stub(file, args)) : undefined));
  seedExposure(base.home, { provider: "tailscale", tailnetPorts: { ui: 9443, terminal: 9444 } });
  await onboard(options({ repos: [base.repo], keychain: "agent-org-linear", start: false }), base.deps);
  assert.ok(base.printed.some((line) => /agent is not the operator of this machine's Tailscale.*run `sudo tailscale set --operator=agent`/.test(line)), base.printed.join("\n"));
});

test("A11-162: onboarding the local exposure asks Tailscale nothing, and writes no tailnet port into the exposure block", async () => {
  const base = deps({}, [], (file) => { if (file === "tailscale") throw new Error("the local exposure must not run tailscale"); return undefined; });
  seedExposure(base.home, { provider: "local" });
  await onboard(options({ repos: [base.repo], keychain: "agent-org-linear", start: false }), base.deps);
  assert.deepEqual(hostOf(base.home).tickets.providers.exposure, { provider: "local", enabled: true, terminal: "http://127.0.0.1:7318/?ws={workspace}&pane={pane}&view=terminal" });
  assert.ok(!base.printed.some((line) => /tailscale/i.test(line) && !line.includes("doctor")));
});

// ---- A11-159: onboard runs the steps of each plugin the host will enable, and writes the settings they choose into the plugin's block
const STEPPED_ROOT = "/checkout";
const STEPPED_FILES: PackageFiles = {
  directories: (path) => (path === `${STEPPED_ROOT}/plugins` ? ["github", "local", "stepped"] : []),
  text: (path) => (path === `${STEPPED_ROOT}/plugins/github/package.json` ? JSON.stringify({ agentOrg: { concern: "codeHost", contract: "1.1", description: "A code host.", entry: "index.ts" } })
    : path === `${STEPPED_ROOT}/plugins/local/package.json` ? JSON.stringify({ agentOrg: { concern: "exposure", contract: "1.1", description: "Loopback.", entry: "index.ts",
    settings: ["port", "uiPort", "terminal"].reduce((all, name) => ({ ...all, [name]: { key: `tickets.providers.exposure.${name}`, file: "host.json", group: "Exposure", type: "text", absent: "unset", default: null, explanation: "e", breaks: "b", edit: { editable: false, why: "w" } } }), {}) } })
    : path === `${STEPPED_ROOT}/plugins/stepped/package.json` ? JSON.stringify({ agentOrg: { concern: "tracker", contract: "1.1", description: "A tracker that steps.", entry: "index.ts",
    settings: ["token", "mode"].reduce((all, name) => ({ ...all, [name]: { key: `tickets.providers.tracker.${name}`, file: "host.json", group: "Tracker", type: "text", absent: "unset", default: null, explanation: "e", breaks: "b", edit: { editable: false, why: "w" } } }), {}) } }) : null),
  isFile: () => true,
};
const steppedCatalog = () => buildCatalog({ root: STEPPED_ROOT, files: STEPPED_FILES });
const plugged = (steps: readonly OnboardStep[], { create = (): unknown => ({}) } = {}) => {
  const plugin = pluginNamed(steppedCatalog(), "stepped")!;
  const module = { create, doctorChecks: () => [], onboardSteps: steps };
  return { plugin, module, load: async (): Promise<LoadResult> => ({ loaded: [{ plugin, implementation: {}, module }], unbuilt: [], refusals: [] }) };
};
const seedHost = (home: string, tracker: Record<string, unknown>) => {
  mkdirSync(join(home, ".agent-org"), { recursive: true });
  writeFileSync(join(home, ".agent-org", "host.json"), JSON.stringify({ tickets: { providers: { tracker: { provider: "stepped", ...tracker } } } }));
};

test("A11-159: onboard runs a plugin's steps in order, each given the settings the one before chose, prints what each says but the empty, and writes what they chose into the plugin's block", async () => {
  const seen: unknown[] = [];
  const steps: OnboardStep[] = [
    { name: "one", explain: "first", run: async (settings, deps) => { seen.push(["one", settings, deps.flags, deps.answered, deps.interactive]); return { ok: true, detail: "step one says this", settings: { token: "t1", mode: undefined } }; } },
    { name: "two", explain: "second", run: async (settings) => { seen.push(["two", settings]); return { ok: false, detail: "" }; } },
    { name: "three", explain: "third", run: async (settings) => ({ ok: true, detail: `step three saw token ${String(settings.token)}`, settings: { mode: "fast" } }) },
  ];
  const { load } = plugged(steps);
  const { deps: d, home, repo, printed } = deps({ catalog: steppedCatalog, loadPlugins: load });
  seedHost(home, { mode: "slow" });
  await onboard(options({ repos: [`netbox=${repo}`], keychain: "flagged", start: false, verbose: true }), d);
  assert.deepEqual(seen, [
    ["one", { mode: "slow" }, { keychain: "flagged", keyFile: undefined }, false, false],
    ["two", { mode: "slow", token: "t1" }],
  ], "the block's own settings first, then the first step's; the tracker plugin is told the key flags; nobody answered the questions for it");
  assert.ok(printed.includes("step one says this") && printed.includes("step three saw token t1"));
  assert.equal(printed.indexOf("step one says this") + 1, printed.indexOf("step three saw token t1"), "the second step's empty detail is not printed between them");
  assert.ok(printed.includes("  ✗ A tracker that steps."), "the plugin that has no setup words is said by its description, and fails because a step did");
  assert.ok(printed.includes("    Run `agent-org doctor` to see what is missing."), "a failing step that said nothing leaves the fix doctor gives");
  assert.deepEqual(hostOf(home).tickets.providers.tracker, { provider: "stepped", enabled: true, mode: "fast", token: "t1" }, "a step replaces the setting it returns, and one it returns undefined for keeps the block's");
});

test("A11-159: a plugin whose create threw (a key not stored yet) still has its steps run, since the step is what stores it; any other refusal refuses onboard by name and writes nothing", async () => {
  const ran: string[] = [];
  const { plugin, module } = plugged([{ name: "store", explain: "e", run: async () => { ran.push("store"); return { ok: true, detail: "stored" }; } }]);
  const unbuilt = deps({ catalog: steppedCatalog, loadPlugins: async () => ({ loaded: [], unbuilt: [{ plugin, module }], refusals: [{ plugin: "stepped", concern: "tracker" as const, why: "no key" }] }) });
  seedHost(unbuilt.home, {});
  await onboard(options({ repos: [`netbox=${unbuilt.repo}`], start: false }), unbuilt.deps);
  assert.deepEqual(ran, ["store"]);
  const refused = deps({ catalog: steppedCatalog, loadPlugins: async () => ({ loaded: [], unbuilt: [], refusals: [{ plugin: "stepped", concern: "tracker" as const, why: "plugin stepped: index.ts must export create, doctorChecks and onboardSteps" }] }) });
  seedHost(refused.home, {});
  const before = readFileSync(join(refused.home, ".agent-org", "host.json"), "utf8");
  await assert.rejects(onboard(options({ repos: [`netbox=${refused.repo}`], start: false }), refused.deps), /the tracker plugin stepped was refused: plugin stepped: index\.ts must export create, doctorChecks and onboardSteps/);
  assert.equal(readFileSync(join(refused.home, ".agent-org", "host.json"), "utf8"), before, "the host file is as it was");
  assert.deepEqual(refused.started, []);
});

test("A11-159: a profile answers onboard's questions, so a plugin's steps are told so; without a profile they are not", async () => {
  const seen: boolean[] = [];
  const probe: OnboardStep = { name: "probe", explain: "e", run: async (_settings, stepDeps) => { seen.push(stepDeps.answered); return { ok: true, detail: "" }; } };
  const linear = pluginNamed(defaultCatalog(), "linear")!;
  const loadPlugins = async (): Promise<LoadResult> => ({ loaded: [{ plugin: linear, implementation: {}, module: { create: () => ({}), doctorChecks: () => [], onboardSteps: [probe] } }], unbuilt: [], refusals: [] });
  const flagged = deps({ loadPlugins });
  await onboard(options({ repos: [`netbox=${flagged.repo}`], keychain: "agent-org-linear", start: false }), flagged.deps);
  let home = "";
  const plugin = pluginWorld(() => home);
  const answers: string[] = [];
  const profiled = deps({ platform: "linux", interactive: true, loadPlugins }, answers, plugin.runOver);
  home = profiled.home;
  const pem = join(home, "example-reviewer.pem");
  writeFileSync(pem, PEM);
  answers.push(pem);
  seedProfile(home, profiled.repo);
  await onboard(options({ profile: "example-laptop", start: false }), profiled.deps);
  assert.deepEqual(seen, [false, true]);
});

// ---- A11-163: onboard installs and enables the plugins it chose, and says so

const PLUGIN_STATE_LINES = /^(?:installed .* as the .*|.* is already the .*)$/;

test("A11-163 done-when: a fresh machine's onboard enables the Linear and GitHub plugins as blocks that `plugin list`, `disable` and `config` read, and says one line each before the plugin's steps", async () => {
  const base = deps({ platform: "linux" });
  const quiet = deps({ platform: "linux" });
  for (const home of [quiet.home, base.home]) {
    mkdirSync(join(home, ".agent-org"), { recursive: true });
    writeFileSync(join(home, ".agent-org", "linear.key"), `${KEY}\n`, { mode: 0o600 });
  }
  await onboard(options({ repos: [`netbox=${quiet.repo}`], keyFile: join(quiet.home, ".agent-org", "linear.key"), start: false }), quiet.deps);
  assert.deepEqual(quiet.printed.filter((line) => /installed .* as the/.test(line)), [], "the internal names are for --verbose");
  assert.deepEqual(quiet.printed.filter((line) => /^ {2}✓ (?:Linear connected|GitHub connected|Board served)/.test(line)),
    ["  ✓ Linear connected as the tracker", "  ✓ GitHub connected as the code host", "  ✓ Board served on this machine"], "each plugin is one line in setup words, after its steps ran");
  await onboard(options({ repos: [`netbox=${base.repo}`], keyFile: join(base.home, ".agent-org", "linear.key"), start: false, verbose: true }), base.deps);
  const providers = hostOf(base.home).tickets.providers;
  assert.deepEqual([providers.tracker.provider, providers.tracker.enabled, providers.codeHost.provider, providers.codeHost.enabled], ["linear", true, "github", true]);
  const lines = base.printed.filter((line) => PLUGIN_STATE_LINES.test(line));
  assert.deepEqual(lines, ["installed linear as the tracker", "installed github as the code host", "installed local as the exposure"]);
  assert.ok(base.printed.indexOf("installed linear as the tracker") < base.printed.indexOf("  ✓ Linear connected as the tracker"), "each comes before its own plugin's line");
  // The CLI reads them as installed and enabled: `list` shows both, and `disable github` is refused as the only code host, not as "not installed".
  const hostPath = join(base.home, ".agent-org", "host.json");
  const said: string[] = [];
  const run = async (...argv: string[]) => ({ status: await runPlugin(argv, { hostPath, catalog: defaultCatalog(), log: (line) => said.push(line), error: (line) => said.push(line) }), said: said.splice(0).join("\n") });
  const list = await run("list");
  assert.match(list.said, /tracker: linear \(from tickets\.providers\.tracker\)\n {2}linear +enabled/);
  assert.match(list.said, /code host: github \(from tickets\.providers\.codeHost\)\n {2}github +enabled/);
  const disable = await run("disable", "github");
  assert.equal(disable.status, 1);
  assert.equal(disable.said, "agent-org plugin: github is the only code host, and exactly one code host must be enabled: it cannot be disabled");
  assert.equal((await run("config", "github")).status, 0, "config reads an installed plugin");
});

test("A11-163: a profile's optional plugins other than none are installed and enabled too, each with its line; none has no line, and a block the host file already holds is said to be", async () => {
  const base = deps({ platform: "linux", interactive: false });
  mkdirSync(join(base.home, ".agent-org", "profiles"), { recursive: true });
  const profile = { ...profileOf({ name: "example-app", path: base.repo }), reviewer: { provider: "atomic" }, exposure: { provider: "tailscale" } };
  writeFileSync(join(base.home, ".agent-org", "profiles", "example-laptop.json"), JSON.stringify(profile));
  writeFileSync(join(base.home, ".agent-org", "host.json"), JSON.stringify({ tickets: { providers: { tracker: { provider: "linear", enabled: true } } } }));
  await onboard(options({ profile: "example-laptop", keyFile: join(base.home, ".agent-org", "linear.key"), start: false, verbose: true }), base.deps);
  assert.deepEqual(base.printed.filter((line) => PLUGIN_STATE_LINES.test(line)), ["linear is already the tracker", "installed github as the code host", "installed atomic as the reviewer", "installed tailscale as the exposure"]);
  const providers = hostOf(base.home).tickets.providers;
  assert.deepEqual([providers.publish, providers.reviewer.enabled, providers.exposure.enabled], [{ provider: "none" }, true, true], "none is left as it is");
});

test("A11-163: a host file that switched a plugin off keeps it off: onboard writes only the keys that are absent", async () => {
  const base = deps({ platform: "linux" });
  seedExposure(base.home, { provider: "tailscale", enabled: false });
  await onboard(options({ repos: [base.repo], keyFile: join(base.home, ".agent-org", "linear.key"), start: false }), base.deps);
  assert.equal(hostOf(base.home).tickets.providers.exposure.enabled, false);
});

// A11-184: herdr's claude and codex integrations are installed by every onboard, and the web UI at its newest release tag.
test("A11-184: onboard installs herdr's claude and codex integrations, one line each, with or without the terminal", async () => {
  const full = deps();
  await onboard(options({ repos: [full.repo], verbose: true }), full.deps);
  assert.deepEqual(full.ran.filter((line) => line.startsWith("herdr integration")), ["herdr integration install claude", "herdr integration install codex"]);
  assert.ok(full.printed.includes("  ✓ herdr knows Claude and Codex"), "one line for both");
  assert.deepEqual(trimmed(full.printed.filter((line) => line.includes("integration"))), ["installed herdr's claude integration", "installed herdr's codex integration"], "and each integration under --verbose");
  const off = deps({ ensureBun: async () => { throw new Error("must not be asked"); } });
  await onboard(options({ repos: [off.repo], terminal: false, verbose: true }), off.deps);
  assert.deepEqual(off.ran.filter((line) => line.startsWith("herdr")), ["herdr integration install claude", "herdr integration install codex"], "--no-terminal does not skip them");
  assert.ok(off.printed.includes("  ✓ herdr knows Claude and Codex"));
});

test("A11-184: an integration that does not install is said with its reason and the command to run, and onboard still finishes", async () => {
  const w = deps({}, [], (file, args) => (file === "herdr" && args.join(" ") === "integration install codex" ? { status: 1, stdout: "", stderr: "herdr: no write access to ~/.codex\nmore" } : undefined));
  const hostFile = await onboard(options({ repos: [w.repo] }), w.deps);
  assert.ok(w.printed.includes("  ✓ herdr knows Claude"));
  assert.ok(w.printed.includes("  ✗ herdr does not know Codex yet"));
  assert.ok(w.printed.includes("    herdr: no write access to ~/.codex. Run `herdr integration install codex`."));
  assert.ok(existsSync(hostFile), "the host file is written");
  assert.ok(w.printed.some((line) => line.startsWith("started")) || w.started.length > 0, "the services still start");
});

test("A11-184: with herdr gone after the first step both integration lines say so, with onboard's command and the same integration commands, and nothing is run", async () => {
  let asked = 0;
  const w = deps({ which: (name) => (name === "herdr" ? (asked++ === 0 ? "/usr/local/bin/herdr" : null) : "/usr/local/bin/tool") });
  await assert.rejects(onboard(options({ repos: [w.repo], terminal: false }), w.deps), OnboardRefusal);
  assert.deepEqual(w.printed.filter((line) => line.includes("integration")), [
    "    herdr is not on PATH. Run `agent-org onboard`, which installs herdr 0.9.3, then run `herdr integration install claude`.",
    "    herdr is not on PATH. Run `agent-org onboard`, which installs herdr 0.9.3, then run `herdr integration install codex`.",
  ]);
  assert.deepEqual(w.printed.filter((line) => line.startsWith("  ✗ herdr does not know")), ["  ✗ herdr does not know Claude yet", "  ✗ herdr does not know Codex yet"]);
  assert.deepEqual(w.ran.filter((line) => line.startsWith("herdr")), []);
});

test("A11-184: a web UI release tag that cannot be read fails the terminal step, installs nothing, and never falls back to the default branch", async () => {
  const w = deps({ newestPluginTag: () => { throw new Error("devswha/herdr-web-ui has no release tag, and agent-org installs a plugin only at a release tag, never a branch"); } });
  await onboard(options({ repos: [w.repo] }), w.deps);
  assert.ok(!w.ran.some((line) => line.startsWith("herdr plugin")), "no install at all, with or without a ref");
  assert.ok(w.printed.includes("  ✗ Worker terminal not set up"));
  assert.ok(trimmed(w.printed).some((line) => line.startsWith("devswha/herdr-web-ui has no release tag")));
  assert.equal(hostOf(w.home).tickets.providers.exposure.terminal, undefined);
  assert.ok(w.ran.includes("herdr integration install claude"), "the integrations are installed all the same");
});

// A11-186: at a terminal, with no --repo, the repositories are picked from the folder onboard runs in and from the code host.

/** Makes a main checkout at `path` whose `origin` is `url`. */
function checkoutAt(path: string, url: string): void {
  mkdirSync(join(path, ".git"), { recursive: true });
  writeFileSync(join(path, ".git", "config"), `[remote "origin"]\n\turl = ${url}\n`);
}

/** Prompts that answer each list with what it starts ticked, every yes or no with No, and every line with what it starts as. */
function pressEnter(): Prompts {
  return { pickMany: async ({ ticked }) => [...ticked], confirm: async () => false, text: async ({ initial }) => initial };
}

/** The folder onboard runs in, with two checkouts the code host knows. */
function laptop(over: Partial<OnboardDeps> = {}, answers: string[] = []) {
  const world = deps({ interactive: true, platform: "linux", prompts: pressEnter(), ...over }, answers);
  checkoutAt(join(world.home, "repos", "agent-org"), "https://github.com/a11ign/agent-org.git");
  checkoutAt(join(world.home, "repos", "docs-site"), "git@github.com:a11ign/documents.git");
  return world;
}

test("A11-186: at a terminal with no --repo onboard picks the repositories in the folder it runs in, writes the code host's names, and prints the summary before it writes the host file", async () => {
  const { deps: d, home, printed } = laptop();
  await onboard(options({ start: false }), d);
  assert.deepEqual(hostOf(home).clones, { "agent-org": join(home, "repos", "agent-org"), documents: join(home, "repos", "docs-site") });
  const summary = printed.findIndex((text) => text.includes("Repositories\n\n"));
  assert.ok(summary >= 0, printed.join("\n"));
  assert.match(printed[summary], /✓ documents +~\/repos\/docs-site +found/);
  assert.ok(printed.findIndex((text) => text.startsWith("  ✓ Settings written to ")) > summary, "the summary comes before the host file is written");
  assert.ok(!printed.some((text) => text.includes("Name the repositories a worker can choose from")), "the typed prompt is not asked");
});

test("A11-186: a held path is written as it was, not normalised, when the picker lists the same repository", async () => {
  const { deps: d, home } = laptop();
  mkdirSync(join(home, ".agent-org"), { recursive: true });
  const trailing = `${join(home, "repos", "agent-org")}/`;
  writeFileSync(join(home, ".agent-org", "host.json"), JSON.stringify({ clones: { "agent-org": trailing } }));
  await onboard(options({ start: false }), d);
  assert.equal(hostOf(home).clones["agent-org"], trailing);
});

test("A11-186: a repository the host file already holds is kept at its path, whatever the picker lists", async () => {
  const { deps: d, home } = laptop();
  mkdirSync(join(home, ".agent-org"), { recursive: true });
  writeFileSync(join(home, ".agent-org", "host.json"), JSON.stringify({ clones: { documents: join(home, "src", "nbl-ui-netbox"), legacy: join(home, "src") } }));
  await onboard(options({ start: false }), d);
  assert.deepEqual(hostOf(home).clones, { documents: join(home, "src", "nbl-ui-netbox"), legacy: join(home, "src"), "agent-org": join(home, "repos", "agent-org") });
});

test("A11-186: an absent profile at a terminal records the picked repositories with their repository and a ~/ path, so a copy clones them on another machine", async () => {
  const answers = ["ZZ", "none", "none", "none", "local"];
  const { deps: d, home } = laptop({}, answers);
  await onboard(options({ profile: "new-laptop", start: false }), d);
  const saved = JSON.parse(readFileSync(join(home, ".agent-org", "profiles", "new-laptop.json"), "utf8"));
  assert.deepEqual(saved.repos, [{ name: "agent-org", remote: "a11ign/agent-org", path: "~/repos/agent-org" }, { name: "documents", remote: "a11ign/documents", path: "~/repos/docs-site" }]);
  assert.deepEqual(hostOf(home).clones, { "agent-org": join(home, "repos", "agent-org"), documents: join(home, "repos", "docs-site") });
});

test("A11-186: a repository picked from the code host and not yet cloned is cloned where the person is, and offered by name", async () => {
  const host = createFakeCodeHost("octo");
  host.seedOwners([{ login: "octo", kind: "account" }]);
  host.seedRepositories("octo", ["octo/dotfiles"]);
  const questions: string[] = [];
  const prompts: Prompts = {
    pickMany: async ({ message, choices, ticked }) => { questions.push(message); return message.startsWith("Organisations") || message.startsWith("Repositories to add") ? choices.map(({ value }) => value) : [...ticked]; },
    confirm: async ({ message }) => { questions.push(message); return true; },
    text: async ({ message, initial }) => { questions.push(message); return initial; },
  };
  const { deps: d, home } = laptop({ codeHost: () => host, prompts });
  await onboard(options({ start: false }), d);
  assert.deepEqual(host.repositoriesWorld.cloned, [{ fullName: "octo/dotfiles", path: join(home, "repos", "dotfiles") }]);
  assert.equal(hostOf(home).clones.dotfiles, join(home, "repos", "dotfiles"));
  assert.deepEqual(questions, ["Found 2 repositories in ~/repos", "Add repositories not cloned here?", "Organisations to add repositories from", "Repositories to add (type to filter)", "Clone into", "Clone 1 repository into ~/repos?"]);
});

// ---- A11-222: the whole flow, as a person sees it: the real prompts driven with the bytes a terminal sends, over a fake code host, with Linear and the programs stubbed

const [DOWN, ENTER, SPACE] = ["\x1b[B", "\r", " "];

test("A11-222: the whole flow reads as a setup wizard: Space ticks in both lists, the Linear key step explains itself and checks the key, each clone is one line, and it ends with the machine set up and the next commands", async () => {
  const host = createFakeCodeHost("octo");
  host.seedOwners([{ login: "octo", kind: "account" }, { login: "a11ign", kind: "organisation" }]);
  host.seedRepositories("a11ign", ["a11ign/agent-org", "a11ign/documents", "a11ign/plugin", "a11ign/toolchain"]);
  const input = new PassThrough();
  const screen = new Screen();
  const output = Object.assign(new Writable({ write(chunk, _encoding, done) { screen.feed(String(chunk)); done(); } }), { columns: 100, rows: 40 });
  const world = laptop({
    codeHost: () => host, prompts: clackPrompts({ input, output }), out: { log: (line: string) => screen.feed(`${line}\n`) },
    askHidden: async (question) => { screen.feed(`${question}\n`); return KEY; },
  });
  const shown = (text: string) => screen.lines().join("\n").includes(text);
  const answerWhenShown = async (text: string, keys: readonly string[]) => {
    for (let waited = 0; !shown(text); waited += 10) {
      if (waited > 5000) throw new Error(`never drawn: ${text}\n${screen.lines().join("\n")}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    for (const key of keys) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      input.write(key);
    }
  };
  const flow = onboard(options({ start: true }), world.deps);
  await answerWhenShown("Found 2 repositories in ~/repos", [DOWN, SPACE, ENTER]);
  await answerWhenShown("Add repositories not cloned here?", ["y"]);
  await answerWhenShown("Organisations to add repositories from", [ENTER]);
  await answerWhenShown("Repositories to add (type to filter)", ["p", "l", "u", "g", SPACE, "\x7f", "\x7f", "\x7f", "\x7f", "t", "o", "o", "l", SPACE, ENTER]);
  await answerWhenShown("Clone into", [ENTER]);
  await answerWhenShown("Clone 2 repositories into ~/repos?", [ENTER]);
  await flow;

  assert.deepEqual(host.repositoriesWorld.cloned.map(({ fullName }) => fullName), ["a11ign/plugin", "a11ign/toolchain"], "space ticked both in the filtered list");
  assert.deepEqual(Object.keys(hostOf(world.home).clones).sort(), ["agent-org", "plugin", "toolchain"], "and space unticked documents in the plain one");
  const transcript = screen.lines();
  const at = (line: string) => transcript.indexOf(line);
  for (const line of ["Connect to Linear", "agent-org keeps your Linear key in a private file, ~/.agent-org/linear.key, readable only by you.",
    "Create a personal API key at Linear → Settings → Security & access → Personal API keys, with Read and Write access.", "Paste your Linear API key (it is not shown):",
    "  ✓ Linear key works: signed in as Casey Chairman", "  ✓ Linear connected as the tracker", "  ✓ GitHub connected as the code host", "  ✓ Board served on this machine", "agent-org is set up on this machine."]) {
    assert.ok(at(line) >= 0, `${line}\n${transcript.join("\n")}`);
  }
  assert.ok(at("  ✓ a11ign/plugin  ~/repos/plugin") >= 0 && at("  ✓ a11ign/toolchain  ~/repos/toolchain") >= 0, "one progress line for each clone");
  assert.equal(transcript.filter((line) => line === "Repositories").length, 1, "and the summary table once, after them");
  assert.ok(at("Repositories") > at("  ✓ a11ign/toolchain  ~/repos/toolchain"));
  assert.ok(at("Connect to Linear") < at("  ✓ Linear key works: signed in as Casey Chairman") && at("  ✓ Linear key works: signed in as Casey Chairman") < at("  ✓ Linear connected as the tracker"));
  assert.ok(at("  ✓ Linear connected as the tracker") < at("agent-org is set up on this machine.") && at("agent-org is set up on this machine.") < at("Next:"));
  assert.ok(!transcript.some((line) => /gh repo clone|installed linear as|Cloning|gh-stack/.test(line)), "none of the internal words");
  assert.ok(!transcript.join("\n").includes(KEY), "and never the key");
  const path = process.env.ONBOARD_FLOW_TRANSCRIPT;
  if (path !== undefined && path !== "") writeFileSync(path, `${transcript.join("\n")}\n`);
});

test("A11-186: stopping a prompt refuses onboard by its sentence and writes nothing", async () => {
  const prompts: Prompts = { ...pressEnter(), pickMany: () => Promise.reject(new PromptCancelled()) };
  const { deps: d, home, written } = laptop({ prompts });
  await assert.rejects(onboard(options({ start: false }), d), (error: unknown) => error instanceof OnboardRefusal && error.message === "onboard was stopped at the repositories, and its other steps did not run");
  assert.deepEqual(written, []);
  assert.ok(!existsSync(join(home, ".agent-org", "host.json")));
});

test("A11-186: a code host without the repositories group is asked for paths, as it always was", async () => {
  const answers: string[] = [];
  const { deps: d, home, repo } = laptop({ codeHost: () => { const { repositories, ...bare } = createFakeCodeHost(); void repositories; return bare as ReturnType<OnboardDeps["codeHost"]>; } }, answers);
  answers.push(repo, "");
  await onboard(options({ start: false }), d);
  assert.deepEqual(hostOf(home).clones, { "nbl-ui-netbox": repo });
});

test("A11-186: without a terminal --repo and a profile behave as they did: no list, no question, and no read of the code host's repositories", async () => {
  const host = createFakeCodeHost("octo");
  const { deps: d, home, repo, printed } = laptop({ interactive: false, codeHost: () => host, prompts: NO_PROMPTS });
  await onboard(options({ repos: [repo], start: false }), d);
  assert.deepEqual(hostOf(home).clones, { "nbl-ui-netbox": repo });
  assert.ok(!printed.some((text) => text.includes("Repositories\n\n")), "no summary without a terminal");
  assert.deepEqual(host.calls.filter((call) => /^(readOwners|readRepositories|cloneRepository)/.test(call)), [], "the code host's repositories are not read");
  await assert.rejects(onboard(options({ profile: "absent", start: false }), d), (error: unknown) => error instanceof OnboardRefusal && /there is no profile at/.test(error.message));
  assert.deepEqual(host.calls.filter((call) => /^(readOwners|readRepositories|cloneRepository)/.test(call)), []);
});

test("A11-186: with --repo at a terminal the picker is not used", async () => {
  const { deps: d, home, repo } = laptop({ prompts: NO_PROMPTS });
  await onboard(options({ repos: [repo], start: false }), d);
  assert.deepEqual(hostOf(home).clones, { "nbl-ui-netbox": repo });
});

test("A11-186: a host file that is not JSON, or cannot be read, refuses an absent profile before anything is asked or written", async () => {
  for (const [text, said] of [["{ not json", /is not valid JSON, so onboard will not write over it/], ["[1]", /does not hold a JSON object/]] as const) {
    const answers = ["ZZ", "none", "none", "none", "local"];
    const { deps: d, home, asked, written } = laptop({}, answers);
    mkdirSync(join(home, ".agent-org"), { recursive: true });
    writeFileSync(join(home, ".agent-org", "host.json"), text);
    await assert.rejects(onboard(options({ profile: "new-laptop", start: false }), d), (error: unknown) => error instanceof OnboardRefusal && said.test(error.message));
    assert.deepEqual(asked, [], "no profile question was asked");
    assert.deepEqual(written, []);
    assert.ok(!existsSync(join(home, ".agent-org", "profiles", "new-laptop.json")));
  }
  const { deps: d, home, written } = laptop({ readFile: (path) => { if (path.endsWith("host.json")) throw new Error("EACCES: permission denied"); return readFileSync(path, "utf8"); } });
  mkdirSync(join(home, ".agent-org"), { recursive: true });
  writeFileSync(join(home, ".agent-org", "host.json"), "{}");
  await assert.rejects(onboard(options({ profile: "new-laptop", start: false }), d), (error: unknown) => error instanceof OnboardRefusal && /cannot be read \(EACCES: permission denied\), so onboard will not write over it/.test(error.message));
  assert.deepEqual(written, []);
});

// ---- A11-223: onboard installs herdr, at the version this release pins, before anything that needs it

/** A machine with no herdr until `installHerdr` has run; then it is found, as a PATH that holds its directory finds it. */
function noHerdr(over: Partial<OnboardDeps> = {}, install: () => Promise<{ path: string; version: string }> = async () => ({ path: "/h/.local/bin/herdr", version: "0.9.3" })) {
  let present = false;
  const calls: string[] = [];
  const w = deps({
    which: (name) => (name === "herdr" ? (present ? "/h/.local/bin/herdr" : null) : "/usr/local/bin/tool"),
    installHerdr: async () => { calls.push("install"); const done = await install(); present = true; return done; },
    putOnPath: (dir) => { calls.push(`path ${dir}`); },
    ...over,
  });
  return { ...w, calls };
}

test("A11-223: with no herdr on PATH, onboard installs the pinned herdr, says one line for it, and then starts the services", async () => {
  const w = noHerdr();
  await onboard(options({ repos: [w.repo] }), w.deps);
  assert.deepEqual(w.calls, ["install", "path /h/.local/bin"]);
  assert.equal(w.printed.filter((line) => line.includes("herdr v")).length, 1);
  assert.ok(w.printed.includes("  ✓ Installed herdr v0.9.3"), w.printed.join("\n"));
  assert.deepEqual(w.started, ["herdr", "instance", "ui", "terminal", "auto-update", "watchdog"], "herdr is the first service, started after it was installed");
  assert.ok(w.printed.indexOf("  ✓ Installed herdr v0.9.3") < w.printed.findIndex((line) => line.includes("Worker terminal")), "before the steps that call herdr");
});

test("A11-223: a herdr directory that is not on PATH is put on it for the run, and the person is told the line that keeps it there", async () => {
  const w = noHerdr();
  await onboard(options({ repos: [w.repo] }), w.deps);
  assert.ok(w.calls.includes("path /h/.local/bin"));
  assert.ok(w.printed.includes('/h/.local/bin is not on your PATH. Add this line to your shell\'s rc file (~/.zshrc or ~/.bashrc), then open a new terminal:\n  export PATH="/h/.local/bin:$PATH"'), w.printed.join("\n"));
  const onPath = noHerdr({ env: { PATH: "/usr/bin:/h/.local/bin" } });
  await onboard(options({ repos: [onPath.repo] }), onPath.deps);
  assert.deepEqual(onPath.calls, ["install"], "a directory already on PATH is left alone");
  assert.ok(!onPath.printed.some((line) => line.includes("is not on your PATH")));
});

test("A11-223: a herdr that is already on PATH is not installed again, at any version, and nothing is said of it", async () => {
  const w = deps();
  await onboard(options({ repos: [w.repo] }), w.deps);
  assert.ok(!w.printed.some((line) => line.includes("Installed herdr")));
  assert.deepEqual(w.started, ["herdr", "instance", "ui", "terminal", "auto-update", "watchdog"]);
});

test("A11-223: a failed install stops onboard at that step with ✗ and the command to run by hand, and writes, runs and starts nothing", async () => {
  const w = noHerdr({}, async () => { throw new HerdrInstallRefusal("https://herdr.dev/latest.json could not be read: getaddrinfo ENOTFOUND herdr.dev"); });
  await assert.rejects(onboard(options({ repos: [w.repo] }), w.deps), (error: unknown) => error instanceof OnboardRefusal && error.message === "stopped at herdr, before anything was written or started");
  assert.deepEqual(w.printed, [
    "  ✗ herdr was not installed: https://herdr.dev/latest.json could not be read: getaddrinfo ENOTFOUND herdr.dev",
    "    Run this, then run `agent-org onboard` again:",
    "    mkdir -p ~/.local/bin && curl -fsSL https://github.com/herdrdev/herdr/releases/download/v0.9.3/herdr-macos-aarch64 -o ~/.local/bin/herdr.download && chmod +x ~/.local/bin/herdr.download && mv ~/.local/bin/herdr.download ~/.local/bin/herdr",
  ]);
  assert.deepEqual(w.started, [], "no service is started: not herdr, the instance, the ui or the terminal");
  assert.deepEqual(w.written, [], "no file is written");
  assert.deepEqual(w.ran, [], "no program is run: no plugin, no integration");
  assert.deepEqual(w.calls, ["install"], "and the PATH is not touched");
  assert.ok(!existsSync(join(w.home, ".agent-org", "host.json")));
});

test("A11-223: an install that is not a refusal (a bug, not a network) is not hidden as one", async () => {
  const w = noHerdr({}, async () => { throw new TypeError("deps.writeExecutable is not a function"); });
  await assert.rejects(onboard(options({ repos: [w.repo] }), w.deps), TypeError);
  assert.deepEqual(w.started, []);
});

test("A11-223: an install that wrote herdr where PATH still cannot find it stops the same way", async () => {
  const w = deps({ which: (name) => (name === "herdr" ? null : "/usr/local/bin/tool"), installHerdr: async () => ({ path: "/h/.local/bin/herdr", version: "0.9.3" }), putOnPath: () => undefined });
  await assert.rejects(onboard(options({ repos: [w.repo] }), w.deps), OnboardRefusal);
  assert.ok(w.printed.includes("  ✗ herdr was not installed: /h/.local/bin/herdr is there, but `herdr` is still not found on PATH"), w.printed.join("\n"));
  assert.deepEqual([w.started, w.written, w.ran], [[], [], []]);
});

test("A11-223: herdr gone by the time the services would start keeps all of them from starting, and says so with the hand command", async () => {
  let asked = 0;
  const w = deps({ which: (name) => (name === "herdr" ? (asked++ < 3 ? "/usr/local/bin/herdr" : null) : "/usr/local/bin/tool") });
  await assert.rejects(onboard(options({ repos: [w.repo], terminal: false }), w.deps), (error: unknown) => error instanceof OnboardRefusal && /^stopped at herdr, after the host file was written/.test(error.message));
  assert.deepEqual(w.started, []);
  assert.ok(w.printed.includes("  ✗ herdr was not installed: `herdr` is no longer on PATH"), w.printed.join("\n"));
  assert.ok(w.printed.some((line) => line.startsWith("    mkdir -p ~/.local/bin && curl -fsSL https://github.com/herdrdev/herdr/releases/download/v0.9.3/")));
});

test("A11-223: with --no-start, nothing is started, so a herdr that is missing at the end is not a stop", async () => {
  let asked = 0;
  const w = deps({ which: (name) => (name === "herdr" ? (asked++ < 3 ? "/usr/local/bin/herdr" : null) : "/usr/local/bin/tool") });
  await onboard(options({ repos: [w.repo], terminal: false, start: false }), w.deps);
  assert.deepEqual(w.started, []);
});

test("A11-223: a herdr in the install dir that PATH does not reach is not replaced: its directory is put on PATH and nothing is downloaded", async () => {
  const w = noHerdr({ exists: (path) => path.endsWith("/.local/bin/herdr") });
  const dir = join(w.home, ".local", "bin");
  let present = false;
  const found = { ...w.deps, which: (name: string) => (name === "herdr" ? (present ? `${dir}/herdr` : null) : "/usr/local/bin/tool"), putOnPath: (added: string) => { w.calls.push(`path ${added}`); present = true; } };
  await onboard(options({ repos: [w.repo], start: false }), found);
  assert.deepEqual(w.calls, [`path ${dir}`], "installHerdr is never called");
  assert.ok(!w.printed.some((line) => line.includes("Installed herdr")));
  assert.ok(w.printed.some((line) => line.includes(`${dir} is not on your PATH`)));
});

test("A11-223: an install that fails to write is a refusal with the hand command, not a bare error", async () => {
  const w = noHerdr({}, async () => { throw new HerdrInstallRefusal("/h/.local/bin/herdr could not be written: EACCES"); });
  await assert.rejects(onboard(options({ repos: [w.repo] }), w.deps), OnboardRefusal);
  assert.ok(w.printed.includes("  ✗ herdr was not installed: /h/.local/bin/herdr could not be written: EACCES"));
});

// A11-285: onboard installs the `agent-org` command as the shim and runs the same check install.sh ends with, before its closing doctor pass.
/** An installed tool at v0.304.1 in the fake home, and a shell that answers `type agent-org` from what the home holds: the alias in `.zshrc` while it is live, else the file in `~/.local/bin`. */
function commandWorld(host: Record<string, unknown> = {}, over: Partial<OnboardDeps> = {}) {
  const base = deps({ platform: "linux", ...over });
  const tool = join(base.home, ".agent-org", "tool");
  mkdirSync(join(tool, "versions", "v0.304.1", "src"), { recursive: true });
  writeFileSync(join(tool, "versions", "v0.304.1", "src", "bin.ts"), "");
  symlinkSync("versions/v0.304.1", join(tool, "current"));
  if (Object.keys(host).length > 0) writeFileSync(join(base.home, ".agent-org", "host.json"), JSON.stringify(host));
  const shim = join(base.home, ".local", "bin", "agent-org");
  const zshrc = join(base.home, ".zshrc");
  const type = (): string | null => {
    const rc = existsSync(zshrc) ? readFileSync(zshrc, "utf8") : "";
    const alias = /^alias agent-org='(.*)'$/m.exec(rc);
    if (alias !== null) return `agent-org is an alias for ${alias[1]}\n`;
    return existsSync(shim) ? `agent-org is ${shim}\n` : "agent-org not found\n";
  };
  const shell = { ...realShellDeps({ SHELL: "/bin/zsh" }, base.home, tool), type, compare: (root: string): CopyComparison => (root === join(tool, "current") ? { kind: "installed" } : { kind: "older", copy: "v0.276.0", installed: "v0.304.1" }) };
  const context = shellContext({}, base.home, null);
  const doctorRow = async () => [judgeShellCommand(readShellCommand(shell), context)];
  base.stored.set("keychain:agent-org-linear", KEY);
  const run = (over: Partial<OnboardDeps>) => onboard(options({ repos: [`netbox=${base.repo}`], keychain: "agent-org-linear", start: false }), { ...base.deps, shell, ...over });
  return { ...base, tool, shim, zshrc, shell, doctorRow, run };
}

const ALIAS = "alias agent-org='node ~/old/agent-org/src/bin.ts'\n";

test("A11-285: on a host that declares no project, onboard writes the shim and runs the check before the doctor pass", async () => {
  const world = commandWorld();
  const seen: string[] = [];
  const diagnoseSeen = async () => { seen.push(existsSync(world.shim) ? "shim there" : "no shim"); return world.doctorRow(); };
  await world.run({ diagnose: diagnoseSeen });
  assert.deepEqual(seen, ["shim there"], "the shim is written before doctor reads");
  assert.equal(readFileSync(world.shim, "utf8"), shimTextFor(world.tool));
  assert.equal(statSync(world.shim).mode & 0o777, 0o755);
  assert.ok(world.printed.some((line) => line.includes("The agent-org command installed")), world.printed.join("\n"));
  assert.ok(world.printed.includes("agent-org is set up on this machine."));
});

test("A11-285: unattended, onboard replaces an alias to an old checkout without asking, says so, and keeps the file", async () => {
  const world = commandWorld();
  writeFileSync(world.zshrc, `export A=1\n${ALIAS}`);
  await world.run({ interactive: false, diagnose: world.doctorRow });
  assert.equal(readFileSync(world.zshrc, "utf8").includes("\n# alias agent-org='node ~/old/agent-org/src/bin.ts'\n"), true);
  assert.equal(readdirSync(world.home).filter((name) => name.startsWith(".zshrc.before-agent-org-")).length, 1);
  assert.ok(world.printed.some((line) => line.includes("agent-org command: commented out ~/.zshrc:2")), world.printed.join("\n"));
  assert.ok(world.printed.includes("agent-org is set up on this machine."), world.printed.join("\n"));
});

test("A11-285: at a terminal onboard asks first; a no leaves the alias, and onboard ends not fully set up", async () => {
  const asked: string[] = [];
  const prompts: Prompts = { ...NO_PROMPTS, confirm: async ({ message }) => { asked.push(message); return false; } };
  const world = commandWorld({}, { interactive: true, prompts });
  writeFileSync(world.zshrc, ALIAS);
  await world.run({ diagnose: world.doctorRow });
  assert.deepEqual(asked, ["Replace it with the installed command? A backup is kept."]);
  assert.equal(readFileSync(world.zshrc, "utf8"), ALIAS);
  assert.ok(world.printed.includes("agent-org is not fully set up: 1 step above needs fixing."), world.printed.join("\n"));
});

test("A11-285: an alias onboard cannot fix ends it not fully set up, with one ✗ for the command and its doctor row pointing at it", async () => {
  const world = commandWorld();
  // The alias is in no start-up file the shell reads, so there is no line to comment out.
  writeFileSync(join(world.home, "elsewhere"), ALIAS);
  const shell = { ...world.shell, type: () => "agent-org is an alias for node ~/old/agent-org/src/bin.ts\n" };
  const printed = world.printed;
  await world.run({ shell, diagnose: async () => [judgeShellCommand(readShellCommand(shell), shellContext({}, world.home, null))] });
  assert.equal(printed.filter((line) => line.startsWith("  ✗ agent-org command:")).length, 2, "the ✗ and the doctor row's pointer to it");
  assert.ok(printed.some((line) => line.includes("I could not find where `agent-org` is defined")), printed.join("\n"));
  assert.ok(printed.includes("agent-org is not fully set up: 1 step above needs fixing."), printed.join("\n"));
  assert.ok(!printed.includes("agent-org is set up on this machine."));
});

test("A11-285: on an org host, whose launcher host:install owns, onboard writes none; and with no installed tool it writes none either", async () => {
  const org = commandWorld({ primary: "p", projects: [] });
  await org.run({ diagnose: async () => [] });
  assert.equal(existsSync(org.shim), false, "an org host's launcher is host:install's");
  const bare = deps({ platform: "linux" });
  bare.stored.set("keychain:agent-org-linear", KEY);
  await onboard(options({ repos: [`netbox=${bare.repo}`], keychain: "agent-org-linear", start: false }), { ...bare.deps, diagnose: async () => [] });
  assert.equal(existsSync(join(bare.home, ".local", "bin", "agent-org")), false, "no current link, so a shim would run nothing");
});
