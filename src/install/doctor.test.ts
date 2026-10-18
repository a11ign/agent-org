// no-token: none -- every check's reading is injected: no `node`, PATH, Keychain, service manager or port is asked
import { test } from "node:test";
import assert from "node:assert/strict";
import { diagnose, report, type DoctorDeps } from "./doctor.ts";

const TERMINAL = "http://127.0.0.1:7318/?ws={workspace}&pane={pane}&view=terminal";
const HOST = JSON.stringify({ clones: { netbox: "/src/netbox" }, tickets: { port: 4800, uiPort: 4801, linearKey: { keychain: "agent-org-linear" }, terminal: TERMINAL } });
const MCP_LIST = "Checking MCP server health…\n\nbookctx: http://127.0.0.1:8421/mcp (HTTP) - ✔ Connected\nlinear: https://mcp.linear.app/mcp (HTTP) - ✔ Connected\n";
const KEY = "lin_api_SECRETSECRETSECRET";

function deps(over: Partial<DoctorDeps> = {}): DoctorDeps {
  return {
    env: { AGENT_ORG_HOST: "/home/me/.agent-org/host.json" }, home: "/home/me",
    nodeVersion: () => "v24.7.0", which: (name) => `/home/me/.local/bin/${name}`,
    readFile: () => HOST, readKey: () => KEY, mode: () => 0o600, serviceState: () => "running", answers: async (port) => port === 4800 || port === 4801,
    pnpmVersion: () => "10.34.5",
    healthy: async (port) => port === 7318, unitProblem: () => null, mcpList: () => MCP_LIST,
    tailscale: () => ({ status: 1, stdout: "", stderr: "not used" }), tailnetAnswers: async () => false,
    ...over,
  };
}

const byName = (checks: Awaited<ReturnType<typeof diagnose>>) => Object.fromEntries(checks.map((check) => [check.name, check]));

test("doctor passes every check on a working install, and never prints the key", async () => {
  const checks = await diagnose(deps());
  assert.deepEqual(checks.map(({ name, ok }) => [name, ok]), [
    ["node", true], ["pnpm", true], ["launcher", true], ["host file", true], ["herdr", true], ["tracker key", true], ["linear mcp", true],
    ["instance service", true], ["instance answering", true], ["ui service", true], ["ui answering", true],
    ["terminal address", true], ["terminal service", true], ["terminal answering", true], ["auto-update service", true],
  ]);
  assert.ok(!report(checks).includes(KEY));
  assert.match(report(checks), /ok {4}ui answering: http:\/\/127\.0\.0\.1:4801 answers/);
});

test("doctor reports a missing Node, and one older than 24, as failures with the fix", async () => {
  const missing = byName(await diagnose(deps({ nodeVersion: () => null })));
  assert.equal(missing.node.ok, false);
  assert.match(missing.node.fix ?? "", /install Node 24 or newer/);
  const old = byName(await diagnose(deps({ nodeVersion: () => "v22.11.0" })));
  assert.equal(old.node.ok, false);
  assert.equal(old.node.detail, "v22.11.0 is older than 24");
});

test("doctor names the fix for a missing launcher, herdr, host file, key and service", async () => {
  const checks = byName(await diagnose(deps({
    which: () => null, readFile: () => { throw new Error("ENOENT"); }, serviceState: () => "not-registered",
  })));
  assert.match(checks.launcher.fix ?? "", /export PATH="\$HOME\/\.local\/bin:\$PATH"/);
  assert.equal(checks.herdr.ok, false);
  assert.match(checks["host file"].fix ?? "", /agent-org onboard/);
  assert.equal(checks["tracker key"].ok, false);
  assert.equal(checks["instance service"].fix, "run `agent-org start instance`");
  assert.equal(checks["ui service"].fix, "run `agent-org start ui`");
  assert.equal(checks["instance answering"].ok, false);
});

test("doctor tells a key it cannot read, and a running service that does not answer", async () => {
  const checks = byName(await diagnose(deps({ readKey: () => { throw new Error("no key"); }, answers: async (port) => port !== 4800 })));
  assert.equal(checks["tracker key"].fix, "security add-generic-password -a \"$USER\" -s agent-org-linear -w");
  assert.equal(checks["instance service"].ok, true);
  assert.equal(checks["instance answering"].ok, false);
  assert.equal(checks["ui answering"].ok, true);
  assert.match(report(Object.values(checks)), /FAIL {2}instance answering: nothing answers on http:\/\/127\.0\.0\.1:4800\n {6}fix: read the service's log/);
});

test("doctor fails a key file other users can read, and names the chmod", async () => {
  const host = JSON.stringify({ clones: { netbox: "/src/netbox" }, tickets: { linearKey: { path: "/home/me/.agent-org/linear.key" } } });
  const checks = byName(await diagnose(deps({ readFile: () => host, mode: () => 0o644 })));
  assert.equal(checks["tracker key"].ok, false);
  assert.equal(checks["tracker key"].fix, "chmod 600 /home/me/.agent-org/linear.key");
});

test("doctor asks each service's state by its own name, and a stopped ui does not hide behind a running instance", async () => {
  const asked: string[] = [];
  const checks = byName(await diagnose(deps({
    serviceState: (name) => { asked.push(name); return name === "instance" ? "running" : "not-registered"; },
  })));
  assert.deepEqual(asked, ["instance", "ui", "terminal", "auto-update"]);
  assert.equal(checks["instance service"].ok, true);
  assert.equal(checks["instance answering"].ok, true);
  assert.equal(checks["ui service"].ok, false);
  assert.equal(checks["ui service"].fix, "stop the one started by hand, then run `agent-org start ui`, so it starts at login and restarts after a crash");
  assert.equal(checks["ui answering"].ok, true, "it answers on its port, started by hand, and saying nothing answers would be false");
});

test("the reverse: an unregistered instance does not hide behind a running ui", async () => {
  const checks = byName(await diagnose(deps({ serviceState: (name) => (name === "ui" ? "running" : "not-registered") })));
  assert.equal(checks["instance service"].ok, false);
  assert.equal(checks["ui service"].ok, true);
  assert.equal(checks["ui answering"].ok, true);
});

test("a service neither registered nor answering is told to start, and its port is still asked", async () => {
  const asked: number[] = [];
  const checks = byName(await diagnose(deps({ serviceState: () => "not-registered", answers: async (port) => { asked.push(port); return false; } })));
  assert.deepEqual(asked, [4800, 4801]);
  assert.equal(checks["instance service"].fix, "run `agent-org start instance`");
  assert.equal(checks["instance answering"].ok, false);
  assert.match(checks["instance answering"].detail, /nothing answers on http:\/\/127\.0\.0\.1:4800/);
});

test("doctor checks the pinned pnpm install and update run, and names how to see why it cannot", async () => {
  assert.equal(byName(await diagnose(deps()))["pnpm"].ok, true);
  const broken = byName(await diagnose(deps({ pnpmVersion: () => null })))["pnpm"];
  assert.equal(broken.ok, false);
  assert.match(broken.detail, /pnpm 10\.34\.5 cannot run through the corepack beside node/);
  assert.equal(broken.fix?.startsWith("run `corepack pnpm@10.34.5 --version`"), true);
  assert.equal(byName(await diagnose(deps({ pnpmVersion: () => "12.4.2" })))["pnpm"].ok, false, "another version answering is not the pinned one");
});

// A11-67: a unit systemd refuses is a failure with systemd's reason, not a "stopped" service.
test("doctor reports a unit systemd loads as bad-setting, with the line it refused, and start as the fix", async () => {
  const reason = "systemd reads agent-org-instance.service as bad-setting: agent-org-instance.service:6: WorkingDirectory= path is not absolute";
  const checks = byName(await diagnose(deps({ unitProblem: (name) => (name === "instance" ? reason : null), serviceState: () => "stopped" })));
  assert.equal(checks["instance service"].ok, false);
  assert.equal(checks["instance service"].detail, reason);
  assert.equal(checks["instance service"].fix, "run `agent-org start instance`, which writes the unit again");
  assert.equal(checks["ui service"].ok, true);
});

// A11-66: the web terminal, as the board uses it.
test("doctor fails a missing tickets.terminal, a terminal not registered, and one that does not answer /api/health", async () => {
  const host = JSON.stringify({ clones: { netbox: "/src/netbox" }, tickets: { linearKey: { keychain: "agent-org-linear" } } });
  const checks = byName(await diagnose(deps({
    readFile: () => host, healthy: async () => false, serviceState: (name) => (name === "terminal" ? "not-registered" : "running"),
  })));
  assert.equal(checks["terminal address"].ok, false);
  assert.match(checks["terminal address"].fix ?? "", /agent-org onboard/);
  assert.equal(checks["terminal service"].ok, false);
  assert.match(checks["terminal service"].fix ?? "", /^run `agent-org start terminal`; if it refuses, run `agent-org onboard`/);
  assert.equal(checks["terminal answering"].ok, false);
  assert.match(checks["terminal answering"].detail, /http:\/\/127\.0\.0\.1:7318\/api\/health/);
});

test("doctor asks the health route on the port tickets.terminal names, and leaves a terminal served elsewhere to that machine", async () => {
  const at = (terminal: string) => JSON.stringify({ clones: { netbox: "/src/netbox" }, tickets: { linearKey: { keychain: "agent-org-linear" }, terminal } });
  const asked: number[] = [];
  const own = byName(await diagnose(deps({ readFile: () => at("http://localhost:7400/?pane={pane}"), healthy: async (port) => { asked.push(port); return true; } })));
  assert.deepEqual(asked, [7400]);
  assert.equal(own["terminal answering"].ok, true);
  const elsewhere = await diagnose(deps({ readFile: () => at("https://agents.example.ts.net/?pane={pane}"), healthy: async () => false }));
  const names = elsewhere.map((check) => check.name);
  assert.ok(names.includes("terminal address") && !names.includes("terminal answering"));
  assert.equal(byName(elsewhere)["terminal address"].ok, true);
});

// A11-71: Linear's MCP, read from `claude mcp list`.
test("doctor checks claude mcp list shows linear connected", async () => {
  assert.equal(byName(await diagnose(deps()))["linear mcp"].ok, true);
  const absent = byName(await diagnose(deps({ mcpList: () => "bookctx: http://x - ✔ Connected\n" })))["linear mcp"];
  assert.equal(absent.ok, false);
  assert.match(absent.fix ?? "", /agent-org onboard/);
  const failing = byName(await diagnose(deps({ mcpList: () => "linear: https://mcp.linear.app/mcp (HTTP) - ✘ Failed to connect\n" })))["linear mcp"];
  assert.equal(failing.ok, false);
  assert.equal(byName(await diagnose(deps({ mcpList: () => null })))["linear mcp"].ok, false);
});

test("doctor reports the auto-update service as registered or not", async () => {
  assert.match(byName(await diagnose(deps()))["auto-update service"].detail, /every hour/);
  const off = byName(await diagnose(deps({ serviceState: (name) => (name === "auto-update" ? "not-registered" : "running") })))["auto-update service"];
  assert.equal(off.ok, false);
  assert.equal(off.fix, "run `agent-org start auto-update`");
});

const TAILNET_STATUS = JSON.stringify({ BackendState: "Running", Self: { DNSName: "agents.tail1234.ts.net.", TailscaleIPs: ["100.64.0.7"] } });
const SERVED_HOST = JSON.stringify({ clones: { netbox: "/src/netbox" }, tickets: { port: 4800, uiPort: 4801, linearKey: { keychain: "agent-org-linear" }, terminal: TERMINAL, serve: "tailscale" } });
/** `tailscale serve status --json` with this board's entries on 9443 and 9444, and Funnel off for both. */
const SERVE_HERE = JSON.stringify({ Web: { "agents.tail1234.ts.net:9443": { Handlers: { "/": { Proxy: "http://127.0.0.1:4801" } } }, "agents.tail1234.ts.net:9444": { Handlers: { "/": { Proxy: "http://127.0.0.1:7318" } } } } });

/** This machine served on the tailnet: `tailscale status` says it is Running, and `tailscale serve status` answers `serve`. */
function tailnetDeps(serve: string, over: Partial<DoctorDeps> = {}): DoctorDeps {
  return deps({ readFile: () => SERVED_HOST, tailscale: (args) => ({ status: 0, stdout: args[0] === "status" ? TAILNET_STATUS : serve, stderr: "" }), tailnetAnswers: async () => true, ...over });
}

test("with tickets.serve, doctor checks each served port's entry, that it is not on Funnel, and that it answers under the machine's name", async () => {
  const checks = byName(await diagnose(tailnetDeps(SERVE_HERE)));
  for (const name of ["tailscale", "ui tailnet entry", "ui tailnet only", "ui tailnet answering", "terminal tailnet entry", "terminal tailnet only", "terminal tailnet answering"]) {
    assert.equal(checks[name]?.ok, true, name);
  }
  assert.equal(checks["ui tailnet entry"].detail, "https://agents.tail1234.ts.net:9443/ serves 127.0.0.1:4801");
});

test("a served port with no entry, another entry, or Funnel on it fails with its fix", async () => {
  const none = byName(await diagnose(tailnetDeps("{}")));
  assert.equal(none["ui tailnet entry"].ok, false);
  assert.equal(none["ui tailnet entry"].fix, "run `agent-org start ui`");
  const funnel = byName(await diagnose(tailnetDeps(JSON.stringify({ ...JSON.parse(SERVE_HERE), AllowFunnel: { "agents.tail1234.ts.net:9443": true } }))));
  assert.equal(funnel["ui tailnet only"].ok, false);
  assert.match(funnel["ui tailnet only"].fix ?? "", /tailscale funnel --https=9443 off/);
  assert.equal(funnel["ui tailnet entry"].ok, true, "its entry is still there: only Funnel is wrong");
  const foreign = byName(await diagnose(tailnetDeps(JSON.stringify({ Web: { "agents.tail1234.ts.net:9443": { Handlers: { "/": { Proxy: "http://127.0.0.1:9999" } } } } }))));
  assert.match(foreign["ui tailnet entry"].detail, /serves http:\/\/127\.0\.0\.1:9999 instead/);
  assert.match(foreign["ui tailnet entry"].fix ?? "", /set `tickets\.servePorts\.ui` to a port nothing serves/);
});

test("a node that is not Running, or no tailscale at all, is the one tailscale failure, with its fix", async () => {
  const stopped = byName(await diagnose(tailnetDeps(SERVE_HERE, { tailscale: () => ({ status: 0, stdout: JSON.stringify({ BackendState: "Stopped", Self: { DNSName: "agents.tail1234.ts.net." } }), stderr: "" }) })));
  assert.equal(stopped.tailscale.ok, false);
  assert.equal(stopped.tailscale.detail, "Tailscale is Stopped, not Running");
  assert.equal(stopped.tailscale.fix, "run `sudo tailscale up`, and turn MagicDNS on in the admin console");
  const absent = byName(await diagnose(tailnetDeps(SERVE_HERE, { tailscale: () => ({ status: null, stdout: "", stderr: "ENOENT" }) })));
  assert.equal(absent.tailscale.detail, "tailscale is not on PATH");
});

test("a served port that does not answer under the machine's name fails, and without tickets.serve tailscale is not asked", async () => {
  const silent = byName(await diagnose(tailnetDeps(SERVE_HERE, { tailnetAnswers: async () => false })));
  assert.equal(silent["terminal tailnet answering"].ok, false);
  assert.equal(silent["ui tailnet answering"].detail, "nothing answers https://agents.tail1234.ts.net:9443/");
  const plain = byName(await diagnose(deps({ tailscale: () => { throw new Error("tailscale is asked only with tickets.serve"); } })));
  assert.equal(plain.tailscale, undefined);
});

test("doctor fails the tailnet serve check on a serve config it cannot read, and judges no entry from it", async () => {
  const checks = byName(await diagnose(tailnetDeps(JSON.stringify({ Web: "unreadable" }))));
  assert.equal(checks["tailscale serve"].ok, false);
  assert.match(checks["tailscale serve"].detail, /did not answer/);
  assert.equal(checks["ui tailnet entry"], undefined, "no entry is read from a config that cannot be read");
});
