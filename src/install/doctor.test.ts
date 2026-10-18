// no-token: none -- every check's reading is injected: no `node`, PATH, Keychain, service manager or port is asked
import { test } from "node:test";
import assert from "node:assert/strict";
import { diagnose, report, type DoctorDeps } from "./doctor.ts";
import type { StatusFile, UpdateStatus } from "./update-safety.ts";

const NOW = Date.parse("2026-10-18T10:00:00.000Z");
const HOUR = 3600e3;
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
    ghWrapper: async () => ({ divergence: null, mints: [] }),
    platform: "linux", isolation: () => ({ kind: "outside", scope: null }), updateStatus: () => ({ kind: "absent" }), releaseTags: () => [], now: () => NOW,
    ...over,
  };
}

const byName = (checks: Awaited<ReturnType<typeof diagnose>>) => Object.fromEntries(checks.map((check) => [check.name, check]));

test("doctor passes every check on a working install, and never prints the key", async () => {
  const checks = await diagnose(deps());
  assert.deepEqual(checks.map(({ name, ok }) => [name, ok]), [
    ["node", true], ["pnpm", true], ["launcher", true], ["host file", true], ["gh wrapper", true], ["herdr", true], ["tracker key", true], ["linear mcp", true],
    ["instance service", true], ["instance answering", true], ["herdr scope", true], ["ui service", true], ["ui answering", true],
    ["terminal address", true], ["terminal service", true], ["terminal answering", true], ["pairing", true], ["auto-update service", true], ["update lag", true],
  ]);
  assert.ok(!report(checks).includes(KEY));
  assert.match(report(checks), /ok {4}ui answering: http:\/\/127\.0\.0\.1:4801 answers/);
});

test("doctor's pairing check says how to pair a new device for the board and for the terminal, and always passes", async () => {
  const pairing = byName(await diagnose(deps({ which: () => null, serviceState: () => "not-registered" }))).pairing;
  assert.equal(pairing.ok, true);
  assert.match(pairing.detail, /agent-org ticket:pair`/);
  assert.match(pairing.detail, /agent-org ticket:pair --terminal`/);
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

// A11-90: how far behind the newest release the install is, and the herdr server's place in the instance's cgroup.
const RELEASES = ["v0.243.0", "v0.244.0", "v0.245.0", "v0.246.0", "v0.247.0", "v0.248.0"];
const status = (over: Partial<UpdateStatus> = {}): UpdateStatus => ({
  checkedAt: "2026-10-18T09:00:00.000Z", channel: "release", installed: "v0.243.0", latest: "v0.248.0", latestSince: "2026-10-17T08:00:00.000Z", ...over,
});
const present = (over: Partial<UpdateStatus> = {}): StatusFile => ({ kind: "status", status: status(over) });
const lagOf = async (over: Partial<DoctorDeps>) => byName(await diagnose(deps({ releaseTags: () => RELEASES, ...over })))["update lag"];

test("A11-90: doctor fails an update status file it cannot read or parse, rather than passing it as no status", async () => {
  const unreadable = await lagOf({ updateStatus: () => ({ kind: "unreadable", why: "EACCES: permission denied" }) });
  assert.equal(unreadable.ok, false);
  assert.equal(unreadable.detail, "the update status file cannot be read: EACCES: permission denied");
  assert.equal(unreadable.fix, "run `agent-org update`, which writes the file again, or check its permissions");
  const corrupt = await lagOf({ updateStatus: () => ({ kind: "unreadable", why: "it is not valid JSON" }) });
  assert.equal(corrupt.ok, false);
  assert.match(corrupt.detail, /it is not valid JSON$/);
});

test("A11-90: doctor says how many releases behind the install is, and since when, and what an update is deferred for", async () => {
  // Two hours after the release was cut: behind, and inside the window the hourly update has to move it in.
  const now = () => Date.parse("2026-10-17T10:00:00.000Z");
  const behind = await lagOf({ updateStatus: () => present(), now });
  assert.equal(behind.ok, true);
  assert.equal(behind.detail, "installed v0.243.0, latest v0.248.0: 5 releases behind, since 2026-10-17T08:00:00.000Z");
  const deferred = await lagOf({ updateStatus: () => present({ deferredSince: "2026-10-18T09:30:00.000Z", deferredReason: "herdr is inside the instance's cgroup" }), now: () => NOW });
  assert.equal(deferred.detail, "installed v0.243.0, latest v0.248.0: 5 releases behind, since 2026-10-17T08:00:00.000Z; update deferred since 2026-10-18T09:30:00.000Z: herdr is inside the instance's cgroup");
});

test("A11-90: doctor fails an install behind for longer than tickets.updateMaxDeferHours and an hour's grace, and passes it inside that", async () => {
  const within = await lagOf({ updateStatus: () => present({ deferredSince: new Date(NOW - 2.5 * HOUR).toISOString(), deferredReason: "x" }) });
  assert.equal(within.ok, true);
  const late = await lagOf({ updateStatus: () => present({ deferredSince: new Date(NOW - 3 * HOUR - 60e3).toISOString(), deferredReason: "x" }) });
  assert.equal(late.ok, false);
  assert.match(late.detail, /; the hourly update should have moved it by now$/);
  assert.equal(late.fix, "run `agent-org update` (with `--force` to restart a live run too), then check `agent-org status auto-update`");
  const neverDeferred = await lagOf({ updateStatus: () => present({ latestSince: new Date(NOW - 4 * HOUR).toISOString() }) });
  assert.equal(neverDeferred.ok, false, "behind for hours with no deferral is a timer that is not moving it");
});

test("A11-90: doctor passes an install at the newest release, one no update has checked, and one that follows main, and fails one not at a release", async () => {
  assert.equal((await lagOf({ updateStatus: () => present({ installed: "v0.248.0" }) })).detail, "installed v0.248.0, which is the latest release");
  assert.equal((await lagOf({})).detail, "no update has checked this install yet, so how far behind the latest release it is not known");
  assert.equal((await lagOf({ updateStatus: () => present({ channel: "main", installed: "3846c6e", latest: "main" }) })).ok, true);
  const detached = await lagOf({ updateStatus: () => present({ installed: "3846c6e" }) });
  assert.equal(detached.ok, false);
  assert.equal(detached.detail, "installed at 3846c6e, which is not a release");
});

test("A11-90: doctor names a herdr server still inside the instance's cgroup, with both fixes; a server in its own scope passes, and one it cannot read passes with a note", async () => {
  const inside = byName(await diagnose(deps({ isolation: () => ({ kind: "inside", cgroup: "/user.slice/agent-org-instance.service", unit: "agent-org-instance.service" }) })))["herdr scope"];
  assert.equal(inside.ok, false);
  assert.equal(inside.detail, "the herdr server for session tickets is in /user.slice/agent-org-instance.service, the same place as the instance (agent-org-instance.service): a restart of the instance interrupts every worker");
  assert.equal(inside.fix, "restart herdr when no run is working (`herdr --session tickets server stop`; the next instance start launches it in its own scope), or add `KillMode=process` under `[Service]` in the instance unit, then `systemctl --user daemon-reload`");
  const scope = byName(await diagnose(deps({ isolation: () => ({ kind: "outside", scope: "/user.slice/agent-org-herdr-tickets.scope" }) })))["herdr scope"];
  assert.equal(scope.ok, true);
  assert.equal(scope.detail, "the herdr server for session tickets is in /user.slice/agent-org-herdr-tickets.scope, outside the instance's cgroup");
  const unknown = byName(await diagnose(deps({ isolation: () => ({ kind: "unknown", why: "/proc/3655416/cgroup cannot be read" }) })))["herdr scope"];
  assert.equal(unknown.ok, true);
  assert.match(unknown.detail, /could not be checked.*\/proc\/3655416\/cgroup cannot be read/);
  const mac = byName(await diagnose(deps({ platform: "darwin", isolation: () => ({ kind: "inside", cgroup: "process group 40", unit: "io.github.agent-org.instance" }) })))["herdr scope"];
  assert.equal(mac.ok, false);
  assert.equal(mac.fix, "restart herdr when no run is working (`herdr --session tickets server stop`; the next instance start launches it in its own scope)", "no KillMode on launchd");
});

test("A11-90: the herdr scope check is asked only when the instance is registered", async () => {
  const unregistered = byName(await diagnose(deps({ serviceState: (name) => (name === "instance" ? "not-registered" : "running"), isolation: () => { throw new Error("not asked"); } })));
  assert.equal(unregistered["herdr scope"], undefined);
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
// A11-84: the installed `gh` wrapper and each declared role's mint are checked, and each failure names its fix.

test("doctor fails a gh wrapper that diverges from host.json, naming the fix, and passes each role that mints", async () => {
  const checks = await diagnose(deps({ ghWrapper: async () => ({ divergence: "/home/me/.local/bin/gh names no App role, but host.json declares scheduler",
    mints: [{ role: "scheduler", failure: null }, { role: "workers", failure: null }] }) }));
  const byCheck = byName(checks);
  assert.equal(byCheck["gh wrapper"].ok, false);
  assert.equal(byCheck["gh wrapper"].detail, "/home/me/.local/bin/gh names no App role, but host.json declares scheduler");
  assert.match(byCheck["gh wrapper"].fix ?? "", /agent-org host:install/);
  assert.equal(byCheck["app token scheduler"].ok, true, "a role that mints is a pass, whatever the wrapper says");
});

test("doctor fails a role whose token mint fails, and says the reason the minter printed", async () => {
  const checks = byName(await diagnose(deps({ ghWrapper: async () => ({ divergence: null,
    mints: [{ role: "reviewer", failure: "could not read the key /home/me/.config/agent-org/apps/a11ign-reviewer.pem (exit 2)" }] }) })));
  assert.equal(checks["gh wrapper"].ok, true);
  assert.equal(checks["app token reviewer"].ok, false);
  assert.equal(checks["app token reviewer"].detail, "the reviewer App's token mint failed: could not read the key /home/me/.config/agent-org/apps/a11ign-reviewer.pem (exit 2)");
  assert.match(checks["app token reviewer"].fix ?? "", /host:install/);
});

test("doctor says a gh wrapper it could not check is not a pass", async () => {
  const checks = byName(await diagnose(deps({ ghWrapper: async () => ({ unchecked: "ENOENT: host.json" }) })));
  assert.equal(checks["gh wrapper"].ok, false);
  assert.equal(checks["gh wrapper"].detail, "cannot be checked: ENOENT: host.json");
});

