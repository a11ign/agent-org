// no-token: none -- every check's reading is injected: no `node`, PATH, Keychain, service manager or port is asked
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runPlugin } from "../plugins/cli.ts";
import { defaultCatalog } from "../plugins/registry.ts";
import { diagnose, report, type Check, type DoctorDeps } from "./doctor.ts";
import type { ChromiumReport } from "./chromium.ts";
import { fakeAgentOrgPlugins } from "../plugins/fakes/doctor-seam.ts";
import type { Catalog, CatalogPlugin, ReviewerHelpers } from "../plugins/manifest.ts";
import { gateHelpers } from "../plugins/reviewing-gate.ts";
import type { ContractRow } from "../ticket-mode/plugin-contract.ts";
import type { PluginContract, PluginState } from "../ticket-mode/plugins.ts";
import type { StatusFile, UpdateStatus } from "./update-safety.ts";
import { createTailscale, freshState, type TailscaleState } from "../../plugins/tailscale/stub.ts";

const NOW = Date.parse("2026-10-18T10:00:00.000Z");
const HOUR = 3600e3;
const TERMINAL = "http://127.0.0.1:7318/?ws={workspace}&pane={pane}&view=terminal";
// The provider blocks (A11-144): the tracker and the exposure named, each with its own settings, so no alias is read.
const HOST = JSON.stringify({ clones: { netbox: "/src/netbox" }, tickets: { providers: { tracker: { provider: "linear", key: { keychain: "agent-org-linear" } },
  exposure: { provider: "local", port: 4800, uiPort: 4801, terminal: TERMINAL } } } });
/** The same host file with a `primary` project, which is the host that installs the `gh` wrapper. */
const HOST_WITH_PROJECT = JSON.stringify({ ...JSON.parse(HOST), primary: "p", projects: [] });
const MCP_LIST = "Checking MCP server health…\n\nbookctx: http://127.0.0.1:8421/mcp (HTTP) - ✔ Connected\nlinear: https://mcp.linear.app/mcp (HTTP) - ✔ Connected\n";
const KEY = "lin_api_SECRETSECRETSECRET";
const GH_LISTING = "gh stack  github/gh-stack  v0.2.1\n";
type Answer = { status: number | null; stdout: string; stderr: string };
/** The GitHub CLI as the doctor tests see it: the extension is `listing`, and a repository's stacks answer `stacks` (a function of the repository). */
const ghFake = (listing = GH_LISTING, stacks: (repo: string) => Answer = () => ({ status: 0, stdout: "[]", stderr: "" })) =>
  (args: readonly string[]): Answer => (args[0] === "extension" ? { status: 0, stdout: listing, stderr: "" } : stacks(args[1].split("/").slice(1, 3).join("/")));

/**
 * The programs the Linear plugin's checks run, as the doctor tests see them (A11-159): `security` prints `key` (or fails, for null), and `claude mcp list` prints `mcp` (or cannot run,
 * for null). Any other program cannot start.
 */
function execOf({ key = KEY, mcp = MCP_LIST, gh = ghFake(), origin = null, codex = "/home/me/.local/bin/codex", codexStatus = 0 }: { key?: string | null; mcp?: string | null; gh?: (args: readonly string[]) => Answer; origin?: string | null;
  /** Where `which codex` finds Codex, or null for none; and the exit status of `codex login status`, or null for a Codex that cannot run it (A11-161: the atomic reviewer's checks run both). */
  codex?: string | null; codexStatus?: number | null } = {}): DoctorDeps["exec"] {
  return (file, args) => {
    if (file === "gh") return gh(args);
    if (file === "which" && args[0] === "codex") return codex === null ? { status: 1, stdout: "", stderr: "" } : { status: 0, stdout: `${codex}\n`, stderr: "" };
    if (file === "codex" && args.join(" ") === "login status") return { status: codexStatus, stdout: "", stderr: "" };
    if (file === "git" && args.includes("get-url")) return origin === null ? { status: 1, stdout: "", stderr: "no origin" } : { status: 0, stdout: `${origin}\n`, stderr: "" };
    if (file === "security" && args[0] === "find-generic-password") return key === null ? { status: 44, stdout: "", stderr: "could not be found" } : { status: 0, stdout: `${key}\n`, stderr: "" };
    if (file === "claude" && args.join(" ") === "mcp list") return mcp === null ? { status: null, stdout: "", stderr: "claude: command not found" } : { status: 0, stdout: mcp, stderr: "" };
    return { status: null, stdout: "", stderr: `${file} cannot start` };
  };
}

/** The reviewer's helpers as a doctor test sees them: the gate loads (or refuses with `refusal`), and no module is read. */
const gateLoads = (refusal: string | null = null): ReviewerHelpers => ({ ...gateHelpers(), loadGate: async () => undefined, gateRefusal: () => refusal });

function deps(over: Partial<DoctorDeps> = {}): DoctorDeps {
  return {
    env: { AGENT_ORG_HOST: "/home/me/.agent-org/host.json" }, home: "/home/me",
    nodeVersion: () => "v24.7.0", which: (name) => `/home/me/.local/bin/${name}`,
    readFile: () => HOST, exec: execOf(), mode: () => 0o600, serviceState: () => "running", answers: async (port) => port === 4800 || port === 4801,
    pnpmVersion: () => "10.34.5",
    healthy: async (port) => port === 7318, unitProblem: () => null,
    probe: async ({ port }) => (port === 4800 || port === 4801 ? 200 : null),
    ghWrapper: async () => ({ divergence: null, mints: [] }),
    platform: "linux", isolation: () => ({ kind: "outside", scope: null }), updateStatus: () => ({ kind: "absent" }), pluginRefresh: () => ({ kind: "none" }), releaseTags: () => [],
    plugins: () => ({ states: { readable: true, plugins: [] }, unreachable: [], rows: [], contracts: [] }), reviewing: gateLoads(),
    chromium: () => BROWSERS_READY, agentOrgPlugins: fakeAgentOrgPlugins(), now: () => NOW,
    ...over,
  };
}

const byName = (checks: Awaited<ReturnType<typeof diagnose>>) => Object.fromEntries(checks.map((check) => [check.name, check]));

/** Both Chromium builds start: the default the doctor tests read. */
const BROWSERS_READY: ChromiumReport = {
  builds: [{ build: "chromium", binary: "/cache/chromium-1243/chrome", missing: [] }, { build: "chromium-headless-shell", binary: "/cache/shell/chrome-headless-shell", missing: [] }],
  unchecked: null,
};

test("doctor checks each Chromium build, and fails the one that lacks libraries with the install command", async () => {
  const lacking: ChromiumReport = { builds: [BROWSERS_READY.builds[0], { build: "chromium-headless-shell", binary: "/cache/shell", missing: ["libatk-1.0.so.0", "libcups.so.2"] }], unchecked: null };
  const checks = byName(await diagnose(deps({ chromium: () => lacking })));
  assert.equal(checks.chromium.ok, true);
  assert.equal(checks["chromium headless shell"].ok, false);
  assert.match(checks["chromium headless shell"].detail, /libatk-1\.0\.so\.0, libcups\.so\.2/);
  assert.match(checks["chromium headless shell"].fix ?? "", /install-deps chromium/, "the fix is the install command, not a bare sentence");
});

test("doctor fails a Chromium build with no binary by the browser install, which the person runs without root", async () => {
  const missing: ChromiumReport = { builds: [{ build: "chromium", binary: null, missing: [] }, BROWSERS_READY.builds[1]], unchecked: null };
  const check = byName(await diagnose(deps({ chromium: () => missing })))["chromium"];
  assert.equal(check.ok, false);
  assert.equal(check.detail, "no browser is installed");
  assert.match(check.fix ?? "", /node .*playwright-core\/cli\.js install chromium/);
  assert.doesNotMatch(check.fix ?? "", /sudo/, "the browser install needs no root");
});

test("doctor passes both Chromium builds when they start", async () => {
  const checks = byName(await diagnose(deps()));
  assert.equal(checks.chromium.ok, true);
  assert.equal(checks["chromium headless shell"].ok, true);
});

/** A host file as an install from before A11-144 wrote it: each concern's loose keys, no provider block. */
const OLD_HOST = JSON.stringify({ clones: { netbox: "/src/netbox" }, tickets: { port: 4800, uiPort: 4801, linearKey: { keychain: "agent-org-linear" }, terminal: TERMINAL } });

test("A11-144: a host file that still reads an old key fails one row per key, each naming its place and `doctor --fix`, and the rest stays as it was", async () => {
  const checks = byName(await diagnose(deps({ readFile: () => OLD_HOST })));
  assert.deepEqual(checks["alias tickets.linearKey"], {
    name: "alias tickets.linearKey", ok: false, detail: "tickets.linearKey is read as an alias; its place is tickets.providers.tracker.key", fix: "agent-org doctor --fix",
  });
  assert.match(checks["alias tickets.port"].detail, /its place is tickets\.providers\.exposure\.port$/);
  assert.match(checks["alias tickets.terminal"].detail, /its place is tickets\.providers\.exposure\.terminal$/);
  assert.equal(checks["tracker (linear)"].ok, true, "the tracker's own checks still pass, so its row does");
  assert.match(checks["tracker (linear)"].detail, /^from aliases \(tickets\.linearKey\)/);
});

test("A11-144: a provider row says where its settings came from, and a block a host file leaves out takes its default, which doctor says", async () => {
  const checks = byName(await diagnose(deps({ readFile: () => JSON.stringify({ clones: { netbox: "/src/netbox" } }) })));
  assert.match(checks["tracker (linear)"].detail, /^no block: the default, linear, with the Keychain service agent-org-linear, applies/);
  assert.match(checks["exposure (local)"].detail, /^no block: the default, local, on loopback with ports 4747 and 4748, applies/);
  assert.match(checks["publisher (none)"].detail, /no block: the default, none, which publishes nothing, applies/);
  assert.deepEqual(Object.keys(checks).filter((name) => name.startsWith("alias ")), [], "no old key is read, so no alias row");
});

// A11-145, A11-161: Codex, which the atomic reviewer runs on, is on the path and logged in. The reviewer plugin's checks run `which codex` and `codex login status` through the exec seam.
test("A11-145: doctor checks Codex under the atomic reviewer: on the path, and logged in; no reviewer checks nothing of it", async () => {
  const atomic = JSON.stringify({ clones: { netbox: "/src/netbox" }, tickets: { providers: { reviewer: { provider: "atomic" } } } });
  const loggedIn = byName(await diagnose(deps({ readFile: () => atomic })));
  assert.deepEqual([loggedIn.codex.ok, loggedIn.codex.detail], [true, "/home/me/.local/bin/codex, logged in"]);
  const missing = byName(await diagnose(deps({ readFile: () => atomic, exec: execOf({ codex: null }) })));
  assert.equal(missing.codex.ok, false);
  assert.equal(missing.codex.detail, "`codex` is not on PATH, so the atomic reviewer cannot run");
  assert.equal(missing["reviewer (atomic)"].ok, false);
  const notIn = byName(await diagnose(deps({ readFile: () => atomic, exec: execOf({ codexStatus: 1 }) })));
  assert.equal(notIn.codex.detail, "Codex is not logged in");
  assert.equal(notIn.codex.fix, "run `codex login`, then `agent-org doctor` again");
  const asked: string[] = [];
  const base = execOf();
  const none = byName(await diagnose(deps({ exec: (file, args, options) => { if (file === "codex" || file === "which") asked.push(file); return base(file, args, options); } })));
  assert.equal(none.codex, undefined);
  assert.deepEqual(asked, [], "no reviewer, so Codex is not asked for");
});

test("A11-144: an atomic reviewer fails when its gate does not load, and the row says so with the gate's check; no reviewer asks the gate nothing", async () => {
  const atomic = JSON.stringify({ clones: { netbox: "/src/netbox" }, tickets: { providers: { reviewer: { provider: "atomic" } } } });
  const refused = byName(await diagnose(deps({ readFile: () => atomic, reviewing: gateLoads("the gate's modules do not load") })));
  assert.equal(refused["reviewer gate"].ok, false);
  assert.equal(refused["reviewer (atomic)"].ok, false);
  assert.equal(refused["reviewer (atomic)"].detail, "from tickets.providers.reviewer: the gate's modules do not load");
  const loads = byName(await diagnose(deps({ readFile: () => atomic })));
  assert.equal(loads["reviewer (atomic)"].ok, true);
  let asked = false;
  const none = byName(await diagnose(deps({ reviewing: { ...gateLoads(), loadGate: async () => { asked = true; } } })));
  assert.equal(none["reviewer (none)"].ok, true);
  assert.equal(asked, false, "no reviewer, so no gate is loaded");
});

test("A11-144: a code host that names stack false is not asked for the gh stack extension", async () => {
  const withoutStack = JSON.stringify({ clones: { netbox: "/src/netbox" }, tickets: { providers: { codeHost: { provider: "github", stack: false } } } });
  const checks = byName(await diagnose(deps({ readFile: () => withoutStack })));
  assert.equal(Object.keys(checks).some((name) => name === "gh stack" || name === "stacked pull requests"), false);
  assert.equal(checks["code host (github)"].ok, true);
});

test("A11-144: a provider row fails when a check it summarises fails, with that check's fix", async () => {
  const terminalDown = byName(await diagnose(deps({ healthy: async () => false })));
  assert.equal(terminalDown["tracker (linear)"].ok, true);
  assert.equal(terminalDown["exposure (local)"].ok, false);
  assert.equal(terminalDown["exposure (local)"].fix, terminalDown["terminal answering"].fix);
});

test("doctor passes every check on a working install, and never prints the key", async () => {
  const checks = await diagnose(deps());
  assert.deepEqual(checks.map(({ name, ok }) => [name, ok]), [
    ["node", true], ["pnpm", true], ["launcher", true], ["host file", true], ["gh wrapper", true], ["herdr", true], ["ticket writer", true], ["instance service", true],
    ["instance answering", true], ["herdr scope", true], ["ui service", true], ["ui answering", true], ["terminal address", true], ["terminal service", true],
    ["terminal answering", true], ["tracker key", true], ["linear mcp", true], ["tracker (linear)", true], ["gh stack", true], ["code host (github)", true],
    ["publisher (none)", true], ["reviewer (none)", true], ["local ports", true], ["local terminal", true], ["exposure (local)", true], ["messaging (none)", true], ["pairing", true],
    ["auto-update service", true], ["update lag", true], ["chromium", true], ["chromium headless shell", true],
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

test("doctor names the fix for a missing launcher, herdr, host file and service", async () => {
  const checks = byName(await diagnose(deps({
    which: () => null, readFile: () => { throw new Error("ENOENT"); }, serviceState: () => "not-registered",
  })));
  assert.match(checks.launcher.fix ?? "", /export PATH="\$HOME\/\.local\/bin:\$PATH"/);
  assert.equal(checks.herdr.ok, false);
  assert.match(checks["host file"].fix ?? "", /agent-org onboard/);
  assert.equal(checks["tracker key"], undefined, "a host file that does not read names no tracker, so no tracker plugin's check runs: the host file's row is the failure");
  assert.equal(checks["instance service"].fix, "run `agent-org start instance`");
  assert.equal(checks["ui service"].fix, "run `agent-org start ui`");
  assert.equal(checks["instance answering"].ok, false);
});

test("doctor tells a key it cannot read, and names the keychain command to store it", async () => {
  const checks = byName(await diagnose(deps({ exec: execOf({ key: null }) })));
  assert.equal(checks["tracker key"].fix, "security add-generic-password -a \"$USER\" -s agent-org-linear -w");
});

test("A11-159: a key the plugin cannot read is one failing row with the key's own fix, the tracker's row says the same, and no second row repeats it as a plugin refusal", async () => {
  const checks = byName(await diagnose(deps({ exec: execOf({ key: null }) })));
  assert.equal(checks["plugin linear"], undefined, "the plugin's own check says why create threw");
  assert.equal(checks["tracker key"].fix, "security add-generic-password -a \"$USER\" -s agent-org-linear -w");
  assert.equal(checks["tracker (linear)"].ok, false);
  assert.equal(checks["tracker (linear)"].fix, checks["tracker key"].fix);
  assert.equal(checks["linear mcp"].ok, true, "the MCP is still checked");
});

test("A11-159: a plugin whose create threw for a reason its own checks do not find is still a failing row, naming it", async () => {
  const catalog = fakeAgentOrgPlugins().catalog();
  const linear = catalog.plugins.find(({ name }) => name === "linear")!;
  const module = { create: () => ({}), doctorChecks: () => [{ name: "tracker key", ok: true, detail: "readable", fix: null }], onboardSteps: [] };
  const plugins = fakeAgentOrgPlugins({ load: async () => ({ loaded: [], unbuilt: [{ plugin: linear, module }], refusals: [{ plugin: "linear", concern: "tracker" as const, why: "create broke" }] }) });
  const checks = byName(await diagnose(deps({ agentOrgPlugins: plugins })));
  assertRow(checks, "plugin linear", { ok: false, detail: "create broke" });
  assert.equal(checks["tracker key"].ok, true);
  assert.equal(checks["tracker (linear)"].ok, false);
});

test("doctor tells a running service that does not answer, and names the log to read", async () => {
  const checks = byName(await diagnose(deps({ answers: async (port) => port !== 4800 })));
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

test("doctor asks each service's state by its own name, and a running instance answers", async () => {
  const asked: string[] = [];
  const checks = byName(await diagnose(deps({
    serviceState: (name) => { asked.push(name); return name === "instance" ? "running" : "not-registered"; },
  })));
  assert.deepEqual(asked, ["instance", "ui", "terminal", "auto-update"]);
  assert.equal(checks["instance service"].ok, true);
  assert.equal(checks["instance answering"].ok, true);
});

test("a stopped ui does not hide behind a running instance, and a ui started by hand still answers", async () => {
  const checks = byName(await diagnose(deps({ serviceState: (name) => (name === "instance" ? "running" : "not-registered") })));
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
  const absent = byName(await diagnose(deps({ exec: execOf({ mcp: "bookctx: http://x - ✔ Connected\n" }) })))["linear mcp"];
  assert.equal(absent.ok, false);
  assert.match(absent.fix ?? "", /agent-org onboard/);
  const failing = byName(await diagnose(deps({ exec: execOf({ mcp: "linear: https://mcp.linear.app/mcp (HTTP) - ✘ Failed to connect\n" }) })))["linear mcp"];
  assert.equal(failing.ok, false);
  assert.equal(byName(await diagnose(deps({ exec: execOf({ mcp: null }) })))["linear mcp"].ok, false);
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
  // A11-145: the drop-in is retired, so the only fix left is to restart herdr when no run is working.
  assert.equal(inside.fix, "restart herdr when no run is working (`herdr --session tickets server stop`; the next instance start launches it in its own scope)");
  assert.ok(!inside.fix.includes("KillMode"), "no KillMode advice remains");
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

const SERVED_HOST = JSON.stringify({ clones: { netbox: "/src/netbox" }, tickets: { port: 4800, uiPort: 4801, linearKey: { keychain: "agent-org-linear" }, terminal: TERMINAL, serve: "tailscale" } });
const NAME = "agents.tail1234.ts.net";

/** A Tailscale that holds this board's entries on 9443 and 9444 (to the page on 4801 and the terminal on 7318), with Funnel off for both. */
const servingHere = (over: Partial<TailscaleState> = {}): TailscaleState => {
  const state = freshState(over);
  state.web[`${NAME}:9443`] = { Handlers: { "/": { Proxy: "http://127.0.0.1:4801" } } };
  state.web[`${NAME}:9444`] = { Handlers: { "/": { Proxy: "http://127.0.0.1:7318" } } };
  return state;
};

/** This machine served on the tailnet (A11-162: by the Tailscale plugin, which runs its `tailscale` through the doctor's `exec`, here a stand-in over `state`), every port answering unless `probe` says otherwise. */
function tailnetDeps(state: TailscaleState, over: Partial<DoctorDeps> = {}): DoctorDeps {
  const programs = execOf();
  const tailscale = createTailscale(state);
  return deps({ readFile: () => SERVED_HOST, exec: (file, args) => (file === "tailscale" ? tailscale(file, args) : programs(file, args)), probe: async () => 200, ...over });
}

test("with the exposure on the tailnet, doctor checks each served port's entry, that it is not on Funnel, and that it answers under the machine's name", async () => {
  const checks = byName(await diagnose(tailnetDeps(servingHere())));
  for (const name of ["tailscale", "ui tailnet entry", "ui tailnet only", "ui tailnet answering", "terminal tailnet entry", "terminal tailnet only", "terminal tailnet answering"]) {
    assert.equal(checks[name]?.ok, true, name);
  }
  assert.equal(checks["ui tailnet entry"].detail, `https://${NAME}:9443/ serves 127.0.0.1:4801`);
  assert.equal(checks["exposure (tailscale)"].ok, true, "the exposure's row summarises them and passes");
  assert.equal(checks["local ports"], undefined, "and the local plugin's rows are not asked of a host that does not enable it");
});

test("a served port with no entry, another entry, or Funnel on it fails with its fix, and the exposure's row fails with the first", async () => {
  const none = byName(await diagnose(tailnetDeps(freshState())));
  assert.equal(none["ui tailnet entry"].ok, false);
  assert.equal(none["ui tailnet entry"].fix, "run `agent-org start ui`");
  assert.equal(none["exposure (tailscale)"].ok, false);
  assert.equal(none["exposure (tailscale)"].fix, "run `agent-org start ui`");
  const open = servingHere();
  open.funnel[`${NAME}:9443`] = true;
  const funnel = byName(await diagnose(tailnetDeps(open)));
  assert.equal(funnel["ui tailnet only"].ok, false);
  assert.match(funnel["ui tailnet only"].fix ?? "", /tailscale funnel --https=9443 off/);
  assert.equal(funnel["ui tailnet entry"].ok, true, "its entry is still there: only Funnel is wrong");
  const taken = freshState();
  taken.web[`${NAME}:9443`] = { Handlers: { "/": { Proxy: "http://127.0.0.1:9999" } } };
  const foreign = byName(await diagnose(tailnetDeps(taken)));
  assert.match(foreign["ui tailnet entry"].detail, /serves http:\/\/127\.0\.0\.1:9999 instead/);
  assert.match(foreign["ui tailnet entry"].fix ?? "", /set `tickets\.providers\.exposure\.tailnetPorts\.ui` to a port nothing serves/);
});

test("a node that is not Running, or no tailscale at all, is the one tailscale failure, with its fix", async () => {
  const stopped = byName(await diagnose(tailnetDeps(servingHere({ backend: "Stopped" }))));
  assert.equal(stopped.tailscale.ok, false);
  assert.equal(stopped.tailscale.detail, "Tailscale is Stopped, not Running");
  assert.equal(stopped.tailscale.fix, "run `sudo tailscale up`, and turn MagicDNS on in the admin console");
  const absent = byName(await diagnose(tailnetDeps(servingHere(), { exec: (file, args) => (file === "tailscale" ? { status: null, stdout: "", stderr: "ENOENT" } : execOf()(file, args)) })));
  assert.equal(absent.tailscale.detail, "tailscale is not on PATH");
});

test("a served port that does not answer under the machine's name fails, and a host on the loopback exposure never asks tailscale", async () => {
  const silent = byName(await diagnose(tailnetDeps(servingHere(), { probe: async () => null })));
  assert.equal(silent["terminal tailnet answering"].ok, false);
  assert.equal(silent["ui tailnet answering"].detail, `nothing answers https://${NAME}:9443/`);
  const plain = byName(await diagnose(deps({ exec: (file, args) => { if (file === "tailscale") throw new Error("tailscale is asked only by the tailscale exposure"); return execOf()(file, args); } })));
  assert.equal(plain.tailscale, undefined);
  assert.equal(plain["local ports"].ok, true, "the local plugin's rows stand in its place");
  assert.equal(plain["local terminal"].ok, true);
  assert.equal(plain["exposure (local)"].ok, true);
});

test("doctor fails the tailnet serve check on a serve config it cannot read, and judges no entry from it", async () => {
  const state = servingHere();
  const stub = createTailscale(state);
  const checks = byName(await diagnose(tailnetDeps(state, { exec: (file, args) => (file === "tailscale" && args[0] === "serve" && args[1] === "status" ? { status: 0, stdout: JSON.stringify({ Web: "unreadable" }), stderr: "" } : file === "tailscale" ? stub(file, args) : execOf()(file, args)) })));
  assert.equal(checks["tailscale serve"].ok, false);
  assert.match(checks["tailscale serve"].detail, /did not answer/);
  assert.equal(checks["ui tailnet entry"], undefined, "no entry is read from a config that cannot be read");
});

test("A11-162: a loopback exposure that does not answer fails its ports row, and the exposure's row says which service to start", async () => {
  const { "local ports": ports, "exposure (local)": exposure } = byName(await diagnose(deps({ probe: async ({ port }) => (port === 4800 ? 200 : null) })));
  assert.deepEqual([ports.ok, ports.detail], [false, "nothing answers on 127.0.0.1 for the ui (port 4801)"]);
  assert.deepEqual([exposure.ok, exposure.fix], [false, "run `agent-org start ui`"]);
});

// A11-84: the installed `gh` wrapper and each declared role's mint are checked, and each failure names its fix.

test("doctor fails a gh wrapper that diverges from host.json, naming the fix, and passes each role that mints", async () => {
  const checks = await diagnose(deps({ readFile: () => HOST_WITH_PROJECT, ghWrapper: async () => ({ divergence: "/home/me/.local/bin/gh names no App role, but host.json declares scheduler",
    mints: [{ role: "scheduler", failure: null }, { role: "workers", failure: null }] }) }));
  const byCheck = byName(checks);
  assert.equal(byCheck["gh wrapper"].ok, false);
  assert.equal(byCheck["gh wrapper"].detail, "/home/me/.local/bin/gh names no App role, but host.json declares scheduler");
  assert.match(byCheck["gh wrapper"].fix ?? "", /agent-org host:install/);
  assert.equal(byCheck["app token scheduler"].ok, true, "a role that mints is a pass, whatever the wrapper says");
});

test("doctor fails a role whose token mint fails, and says the reason the minter printed", async () => {
  const checks = byName(await diagnose(deps({ readFile: () => HOST_WITH_PROJECT, ghWrapper: async () => ({ divergence: null,
    mints: [{ role: "reviewer", failure: "could not read the key /home/me/.config/agent-org/apps/a11ign-reviewer.pem (exit 2)" }] }) })));
  assert.equal(checks["gh wrapper"].ok, true);
  assert.equal(checks["app token reviewer"].ok, false);
  assert.equal(checks["app token reviewer"].detail, "the reviewer App's token mint failed: could not read the key /home/me/.config/agent-org/apps/a11ign-reviewer.pem (exit 2)");
  assert.match(checks["app token reviewer"].fix ?? "", /host:install/);
});

test("doctor passes the gh wrapper check as not applicable on a host that declares no project, and does not ask the wrapper", async () => {
  let asked = false;
  const checks = byName(await diagnose(deps({ ghWrapper: async () => { asked = true; return { unchecked: "field `primary` REFUSED: it is missing" }; } })));
  assert.equal(checks["gh wrapper"].ok, true);
  assert.match(checks["gh wrapper"].detail, /not applicable: host.json declares no project/);
  assert.equal(asked, false);
});

test("doctor does not skip the gh wrapper check on a host file that is not accepted, and says the host file is wrong", async () => {
  for (const unaccepted of ["{}", "not json"]) {
    let asked = false;
    const checks = byName(await diagnose(deps({ readFile: () => unaccepted, ghWrapper: async () => { asked = true; return { unchecked: "x" }; } })));
    assert.equal(checks["host file"].ok, false, unaccepted);
    assert.equal(asked, true, `${unaccepted}: the wrapper is still asked`);
  }
});

test("doctor still checks the gh wrapper on a host that declares a primary project", async () => {
  const checks = byName(await diagnose(deps({ readFile: () => HOST_WITH_PROJECT, ghWrapper: async () => ({ unchecked: "ENOENT: host.json" }) })));
  assert.equal(checks["gh wrapper"].ok, false);
});

test("doctor says a gh wrapper it could not check is not a pass", async () => {
  const checks = byName(await diagnose(deps({ readFile: () => HOST_WITH_PROJECT, ghWrapper: async () => ({ unchecked: "ENOENT: host.json" }) })));
  assert.equal(checks["gh wrapper"].ok, false);
  assert.equal(checks["gh wrapper"].detail, "cannot be checked: ENOENT: host.json");
});


/** A host file whose `tickets` block is `tickets`, over the ports and key every doctor test here uses. */
const hostWith = (tickets: Record<string, unknown>) => JSON.stringify({ clones: { netbox: "/src/netbox" }, tickets: { port: 4800, uiPort: 4801, linearKey: { keychain: "agent-org-linear" }, ...tickets } });

test("A11-94: doctor says whether the ticket writer is configured, and fails one that cannot read a Linear ticket to check for duplicates", async () => {
  const writer = { run: "Run the a11ign:create-ticket skill for this request: {request}, in {dir}." };
  const read = (over: Partial<DoctorDeps>) => diagnose(deps(over)).then((checks) => byName(checks)["ticket writer"]);
  const absent = await read({});
  assert.deepEqual([absent.ok, absent.detail], [true, "no: New ticket is hidden, since tickets.writer is not named"], "informational when not named");
  const reading = await read({ readFile: (path) => (path.endsWith("host.json") ? hostWith({ writer, connectors: ["^mcp__linear__get_issue$"], terminal: TERMINAL }) : HOST) });
  assert.deepEqual([reading.ok, reading.detail], [true, "yes: New ticket is shown, and Grill is on; its skill is not checked against a plugin's contract"]);
  const quick = await read({ readFile: (path) => (path.endsWith("host.json") ? hostWith({ writer, connectors: ["^mcp__claude_ai_Linear__(get|list|search)_"] }) : HOST) });
  assert.deepEqual([quick.ok, quick.detail], [true, "yes: New ticket is shown, and Grill is off until tickets.terminal is named; its skill is not checked against a plugin's contract"]);
  const cannot = await read({ readFile: (path) => (path.endsWith("host.json") ? hostWith({ writer, connectors: ["^mcp__claude_ai_Linear__save_"] }) : HOST) });
  assert.equal(cannot.ok, false, "no connector reads a ticket");
  assert.match(cannot.fix ?? "", /agent-org onboard/);
});

// A11-139: the writer's skill is checked against the contract of the plugin that provides it, never against the words of its instruction.
const WRITER_RUN = (skill: string) => `Run the ${skill} skill for this request: {request}, in {dir}.`;
const writerHost = (run: string) => hostWith({ terminal: TERMINAL, plugins: ["a11ign@m"], connectors: ["^mcp__linear__get_issue$"], writer: { run } });
const providing = (skill: string): PluginContract => ({ entry: "a11ign@m", name: "a11ign", contract: { contract: "1.0", agentOrg: ">=0.258.0 <1.0.0", provides: { writer: { skill } }, needs: { connectors: [], commands: [] } } });
/** The ticket writer's check, for a host whose writer runs `run` and a session that loads `a11ign@m` with `contracts`, and how many times the install record was asked. */
async function ticketWriter(run: string, contracts: PluginContract[]): Promise<{ check: Check; asked: number }> {
  let asked = 0;
  const checks = byName(await diagnose(deps({
    readFile: (path) => (path.endsWith("host.json") ? writerHost(run) : HOST),
    plugins: (input) => { asked += 1; return { ...pluginsAs([loaded("a11ign@m")])(input), contracts }; },
  })));
  return { check: checks["ticket writer"], asked };
}

test("A11-139: the ticket writer passes when the plugin's contract provides the skill it names, says which plugin, and the install record is asked once", async () => {
  const provided = await ticketWriter(WRITER_RUN("a11ign:create-ticket"), [providing("a11ign:create-ticket")]);
  assert.deepEqual([provided.check.ok, provided.check.detail], [true, "yes: New ticket is shown, and Grill is on; its skill is provided by a11ign@m"]);
  assert.equal(provided.asked, 1, "the plugin checks and the writer share one read of the record");
});

test("A11-139: the ticket writer fails when the plugin's contract does not provide the skill it names, with the fix the skill row gives", async () => {
  const other = await ticketWriter(WRITER_RUN("a11ign:other"), [providing("a11ign:create-ticket")]);
  assert.deepEqual([other.check.ok, other.check.detail, other.check.fix], [false,
    "tickets.writer.run names a11ign:other, which a11ign@m does not provide as its writer skill: name a skill it provides, or remove the key.",
    "name a skill it provides, or remove the key."]);
});

test("A11-139: the ticket writer fails when any skill its run names is not provided, not only the first", async () => {
  const both = await ticketWriter("Run the a11ign:create-ticket skill, then a11ign:other, for this request: {request}, in {dir}.", [providing("a11ign:create-ticket")]);
  assert.equal(both.check.ok, false, "POSITIVE CONTROL: the second name is the one the contract does not provide");
  assert.match(both.check.detail, /^tickets\.writer\.run names a11ign:other, which a11ign@m does not provide/);
});

test("A11-139: a writer whose skill no loading plugin's contract covers is not checked, and the detail says so", async () => {
  const none = await ticketWriter(WRITER_RUN("a11ign:create-ticket"), []);
  assert.deepEqual([none.check.ok, none.check.detail], [true, "yes: New ticket is shown, and Grill is on; its skill is not checked against a plugin's contract"]);
});

test("A11-139: the instruction's words do not decide the writer check: a mode word or draft wording is neither said nor a failure", async () => {
  // Built from a template, so no shipped fixture carries the words (A11-124). The positive controls show the run does name them.
  const run = `Run the a11ign:create-ticket skill, ${"quick"}, for this request: {request}. Write each draft under {dir}/drafts.`;
  assert.match(run, /\bquick\b/, "POSITIVE CONTROL: the run names a mode");
  assert.match(run, /\bdrafts?\b/, "POSITIVE CONTROL: the run says draft");
  const { check } = await ticketWriter(run, [providing("a11ign:create-ticket")]);
  assert.deepEqual([check.ok, check.detail], [true, "yes: New ticket is shown, and Grill is on; its skill is provided by a11ign@m"]);
});

const WORKERS_HOST = JSON.stringify({ gh: { workers: "/home/agent/workers" }, clones: { netbox: "/src/netbox" }, tickets: { providers: { tracker: { provider: "linear", key: { keychain: "agent-org-linear" } }, exposure: { provider: "local", port: 4800, uiPort: 4801, terminal: TERMINAL } } } });
const GITHUB_ORIGIN = "git@github.com:a11ign/nbl-ui-netbox.git";

test("A11-160: the code host plugin's rows are in the code host's section, after the machine's wrapper check and before the code host's row that summarises them", async () => {
  const checks = await diagnose(deps({ readFile: () => WORKERS_HOST, exec: execOf({ origin: GITHUB_ORIGIN }) }));
  const names = checks.map(({ name }) => name);
  assert.deepEqual(names.filter((name) => ["gh wrapper", "gh stack", "stacked pull requests", "code host (github)", "herdr"].includes(name)), ["gh wrapper", "herdr", "gh stack", "stacked pull requests", "code host (github)"]);
  const row = byName(checks);
  assert.deepEqual([row["gh stack"].ok, row["gh stack"].detail], [true, "github/gh-stack v0.2.1 (for GH_CONFIG_DIR=/home/agent/workers/gh)"], "the row is the plugin's, with the words it had");
  assert.deepEqual([row["stacked pull requests"].ok, row["stacked pull requests"].detail], [true, "available for a11ign/nbl-ui-netbox"]);
  assert.equal(names.filter((name) => name === "gh stack").length, 1, "once, not again among the plugins' standalone rows");
  assert.equal(row["code host (github)"].ok, true);
  assert.equal(row["code host (github)"].detail, "from aliases (gh), and its checks pass");
});

test("A11-160: a host file the reader refuses still shows the code host's rows, as doctor always did, for the account it names, and builds no other plugin; its own row says why", async () => {
  const refusedText = JSON.stringify({ gh: { workers: "/home/agent/workers" }, tickets: {} });
  const built: string[] = [];
  const spying = fakeAgentOrgPlugins({ load: async (providers, catalog, pluginDeps, blocks) => { built.push(...(blocks ?? ["every block"])); return (await fakeAgentOrgPlugins().load(providers, catalog, pluginDeps, blocks)); } });
  const refused = await diagnose(deps({ readFile: () => refusedText, agentOrgPlugins: spying }));
  const row = byName(refused);
  assert.equal(row["gh stack"].ok, true, "the row is shown though the file is refused");
  assert.match(row["gh stack"].detail, /^github\/gh-stack v0\.2\.1 \(for GH_CONFIG_DIR=/);
  assert.deepEqual(built, ["codeHost"], "only the code host is built: the tracker's key is not read for a file that does not read");
  assert.equal(refused.find(({ name }) => name === "host file")?.ok, false, "the failing row is the host file's, which says why");
  const unknownHost = byName(await diagnose(deps({ readFile: () => JSON.stringify({ gh: { workers: "/home/agent/workers" }, clones: { netbox: "/src/netbox" }, tickets: { providers: { codeHost: { provider: "gitlab" } } } }) })));
  assert.match(unknownHost["gh stack"].detail, /\(for this machine's gh account\)$/, "a file whose providers are refused names no account, as the raw reading never did");
  const unreadable = byName(await diagnose(deps({ readFile: () => { throw new Error("ENOENT"); } })));
  assert.equal(unreadable["gh stack"].ok, true, "and for a host file that is not there");
  assert.equal(unreadable["host file"].ok, false);
});

test("A11-160: a failing plugin row fails the code host's row, which says what the plugin found and its fix", async () => {
  const missing = byName(await diagnose(deps({ readFile: () => WORKERS_HOST, exec: execOf({ gh: ghFake("gh dash  dlvhdr/gh-dash  v4.0.0\n") }) })));
  const host = missing["code host (github)"];
  assert.deepEqual([missing["gh stack"].ok, missing["gh stack"].fix], [false, "GH_CONFIG_DIR=/home/agent/workers/gh gh extension install github/gh-stack, or run `agent-org onboard`"]);
  assert.equal(host.ok, false);
  assert.match(host.detail, /`gh stack` is not installed, so a worker cannot link a stacked pull request/);
  assert.equal(host.fix, missing["gh stack"].fix);
});

test("A11-160: the plugin's rows come from the host's clones and the workers' account: a clone's GitHub remote is asked about stacks, as the workers' gh account", async () => {
  const asked: { args: readonly string[]; env: unknown }[] = [];
  const exec: DoctorDeps["exec"] = (file, args, options) => {
    if (file === "gh") asked.push({ args, env: options?.env });
    return execOf({ origin: GITHUB_ORIGIN })(file, args, options);
  };
  await diagnose(deps({ readFile: () => WORKERS_HOST, exec }));
  assert.deepEqual(asked.map(({ args }) => args.join(" ")), ["extension list", "api repos/a11ign/nbl-ui-netbox/stacks"]);
  assert.ok(asked.every(({ env }) => JSON.stringify(env) === JSON.stringify({ GH_CONFIG_DIR: "/home/agent/workers/gh" })), "every call acts as the workers' account");
});

// `tickets.preflight`: each command is run, as the pool runs it before a start, and a failure says what the command printed.
const hostWithPreflight = (preflight: unknown) => JSON.stringify({ ...JSON.parse(HOST), tickets: { ...JSON.parse(HOST).tickets, preflight } });

test("doctor runs each preflight command and reports a pass and a failure, naming the command and what it printed", async () => {
  const checks = byName(await diagnose(deps({
    readFile: () => hostWithPreflight([{ name: "fontawesome login", run: "login-ok" }, { name: "disk", run: "disk-full" }]),
    preflight: async (command) => (command === "login-ok" ? { status: 0, timedOut: false, output: "" } : { status: 1, timedOut: false, output: "only 2 GB free\nmore" }),
  })));
  assert.equal(checks["preflight fontawesome login"].ok, true);
  const disk = checks["preflight disk"];
  assert.equal(disk.ok, false);
  assert.equal(disk.detail, "only 2 GB free");
  assert.match(disk.fix ?? "", /starts no run while it fails/);
});

test("doctor says nothing of preflight on a host that names none, and runs nothing", async () => {
  let ran = false;
  const checks = await diagnose(deps({ preflight: async () => { ran = true; return { status: 1, timedOut: false, output: "" }; } }));
  assert.equal(checks.some((c) => c.name.startsWith("preflight")), false);
  assert.equal(ran, false);
});

// A11-140: each plugin `tickets.plugins` enables is listed, ok or with the mismatch named; one that does not load fails, named.
const PLUGINS_HOST = JSON.stringify({ ...JSON.parse(HOST), tickets: { ...JSON.parse(HOST).tickets, plugins: ["a@m", "b@m"] } });
const WHY_NOT_INSTALLED = "a@m is not installed: install it for every folder with `claude plugin install a@m --scope user`.";
const CONNECTOR_ROW: ContractRow = { plugin: "a@m", kind: "connector-need", why: "a@m needs the connector tools matched by ^mcp__linear__save_, which tickets.connectors does not allow: add the pattern to tickets.connectors." };
const loaded = (plugin: string): PluginState => ({ plugin, installs: [], loads: true, why: null, installPath: `/cache/${plugin}` });
const notLoaded = (plugin: string, why: string): PluginState => ({ plugin, installs: [], loads: false, why, installPath: null });
const notRead = (plugin: string): PluginState => ({ plugin, installs: [], loads: null, why: null, installPath: null });
/** The plugins check, injected with what the install record says of each plugin, and the contract rows `pluginProblems` returns for them. */
const pluginsAs = (plugins: PluginState[], rows: ContractRow[] = [], readable = true): DoctorDeps["plugins"] => () => ({ states: { readable, plugins }, unreachable: [], rows, contracts: [] });
const checksWithPlugins = async (over: Partial<DoctorDeps>) => byName(await diagnose(deps({ readFile: () => PLUGINS_HOST, ...over })));

test("A11-140: doctor lists each enabled plugin as ok when it loads with no contract mismatch, and asks for the plugins a worker's folder gets", async () => {
  const asked: { wanted: readonly string[]; folder: string }[] = [];
  const checks = await checksWithPlugins({ plugins: (input) => { asked.push(input); return pluginsAs([loaded("a@m"), loaded("b@m")])(input); } });
  assert.deepEqual([checks["plugin a@m"].ok, checks["plugin b@m"].ok], [true, true]);
  assert.equal(checks["plugin a@m"].detail, "loads for a worker's session, and no contract mismatch");
  assert.match(report(Object.values(checks)), /ok {4}plugin a@m: loads for a worker's session, and no contract mismatch\n/);
  assert.equal(asked.length, 1);
  assert.deepEqual(asked[0].wanted, ["a@m", "b@m"]);
  assert.match(asked[0].folder, /\/<ticket>$/, "a worker's session starts in its ticket's folder, as the Settings page asks");
});

test("A11-140: doctor fails an enabled plugin that does not load, naming it with its fix, and the other one stays ok", async () => {
  const checks = await checksWithPlugins({ plugins: pluginsAs([notLoaded("a@m", WHY_NOT_INSTALLED), loaded("b@m")]) });
  const [failing, passing] = [checks["plugin a@m"], checks["plugin b@m"]];
  assert.deepEqual([failing.ok, failing.detail, failing.fix, passing.ok], [false, WHY_NOT_INSTALLED, "install it for every folder with `claude plugin install a@m --scope user`.", true]);
  assert.ok(report(Object.values(checks)).includes(`FAIL  plugin a@m: ${WHY_NOT_INSTALLED}\n      fix: install it for every folder`));
});

test("A11-140: doctor fails a loading plugin whose contract does not match the host's keys, naming the plugin and the key", async () => {
  const checks = await checksWithPlugins({ plugins: pluginsAs([loaded("a@m"), loaded("b@m")], [CONNECTOR_ROW]) });
  assert.equal(checks["plugin a@m"].ok, false);
  assert.equal(checks["plugin a@m"].detail, CONNECTOR_ROW.why);
  assert.match(checks["plugin a@m"].detail, /^a@m .*tickets\.connectors/);
  assert.equal(checks["plugin a@m"].fix, "fix what the row says: the board refuses a run while a mismatch stands");
  assert.equal(checks["plugin b@m"].ok, true);
});

test("A11-140: a contract row about a plugin the host does not enable is listed in plugin contract, failed", async () => {
  const row: ContractRow = { plugin: "nbl-ui", kind: "plugin-not-enabled", why: "skills.prReview names nbl-ui:review, but tickets.plugins does not enable nbl-ui: add that plugin to tickets.plugins." };
  const checks = await checksWithPlugins({ plugins: pluginsAs([loaded("a@m")], [row]) });
  assert.equal(checks["plugin contract"].ok, false);
  assert.equal(checks["plugin contract"].detail, row.why);
  assert.equal("plugin nbl-ui" in checks, false, "no entry owns the row, so no entry check says it");
  assert.equal(checks["plugin a@m"].ok, true);
});

test("A11-140: doctor adds no plugin check on a host that names no plugin, or whose host file did not parse, and asks the record nothing", async () => {
  const neverAsked = (): never => { throw new Error("the install record must not be asked"); };
  const none = await diagnose(deps({ plugins: neverAsked }));
  assert.equal(none.some((check) => check.name.startsWith("plugin")), false);
  const unparsed = await diagnose(deps({ readFile: () => "{", plugins: neverAsked }));
  assert.equal(unparsed.some((check) => check.name.startsWith("plugin")), false);
});

test("A11-140: an unreadable install record is not checked, and fails nothing", async () => {
  const checks = await checksWithPlugins({ plugins: pluginsAs([notRead("a@m"), notRead("b@m")], [], false) });
  assert.deepEqual([checks["plugin a@m"].ok, checks["plugin a@m"].detail, checks["plugin a@m"].fix], [true, "not checked: Claude Code's install record cannot be read for it", null]);
  assert.equal(checks["plugin b@m"].ok, true);
});

test("A11-140: a plugin that does not load, or does not match, makes the run fail, and a plugin that is fine does not", async () => {
  const notLoading = Object.values(await checksWithPlugins({ plugins: pluginsAs([notLoaded("a@m", WHY_NOT_INSTALLED)]) }));
  const mismatched = Object.values(await checksWithPlugins({ plugins: pluginsAs([loaded("a@m")], [CONNECTOR_ROW]) }));
  const fine = Object.values(await checksWithPlugins({ plugins: pluginsAs([loaded("a@m"), loaded("b@m")]) }));
  assert.deepEqual([notLoading.every((check) => check.ok), mismatched.every((check) => check.ok), fine.every((check) => check.ok)], [false, false, true]);
});

// A11-145: a conventions plugin refresh a live run held back is said; a record that cannot be read fails its row, so a corrupt file cannot hide a wait.
test("A11-145: doctor says a conventions plugin refresh that a live run held back, fails a record it cannot read, and shows no row when none waits", async () => {
  const waiting = byName(await diagnose(deps({ pluginRefresh: () => ({ kind: "waiting", since: "2026-10-20T10:00:00.000Z", live: 2 }) })));
  assert.equal(waiting["plugin refresh"].ok, true);
  assert.equal(waiting["plugin refresh"].detail, "the conventions plugin refresh has waited since 2026-10-20T10:00:00.000Z, with 2 runs live, and runs at the next update with no run live");
  const unreadable = byName(await diagnose(deps({ pluginRefresh: () => ({ kind: "unreadable", why: "/home/me/.agent-org/plugins-deferred.json cannot be read: Unexpected token" }) })));
  assert.equal(unreadable["plugin refresh"].ok, false);
  assert.equal(unreadable["plugin refresh"].fix, "run `agent-org update` once no run is live: a refresh that runs removes the record");
  assert.equal(byName(await diagnose(deps()))["plugin refresh"], undefined);
});

// A11-158: agent-org plugins. The doctor names each plugin and whether it is disabled, says what the registry refused and which plugin implements a contract major agent-org does not read,
// runs the doctor checks of an enabled bundled plugin, and says what the project's messaging key holds.
const PUBLISH = { provider: "slack", run: "post {prs} into {dir}", connectors: ["^mcp__chat__send"] };
const hostWithProviders = (providers: Record<string, unknown>): string => JSON.stringify({ clones: { netbox: "/src/netbox" }, tickets: { providers: { ...JSON.parse(HOST).tickets.providers, ...providers } } });

/** The catalog a test reads: this checkout's plugins and the fakes, with `plugins` in place of the one of the same name. */
function catalogWith(plugins: readonly CatalogPlugin[], refusals: Catalog["refusals"] = []): Catalog {
  const base = fakeAgentOrgPlugins().catalog();
  return { plugins: [...base.plugins.filter(({ name }) => !plugins.some((plugin) => plugin.name === name)), ...plugins], refusals };
}
/** A row's verdict, and its detail and fix where the test names them (text must match whole, a pattern must match). */
function assertRow(checks: Record<string, Check>, name: string, expected: Readonly<{ ok: boolean; detail?: string | RegExp; fix?: string | RegExp }>): void {
  const row = checks[name];
  assert.ok(row !== undefined, `there is a row named ${name}`);
  assert.equal(row.ok, expected.ok, `${name} ok`);
  for (const field of ["detail", "fix"] as const) {
    const want = expected[field];
    if (typeof want === "string") assert.equal(row[field], want, `${name} ${field}`);
    else if (want !== undefined) assert.match(row[field] ?? "", want, `${name} ${field}`);
  }
}
const fakeOf = (name: string, over: Partial<CatalogPlugin> = {}): CatalogPlugin => ({ ...(fakeAgentOrgPlugins().catalog().plugins.find((plugin) => plugin.name === name) as CatalogPlugin), ...over });

test("A11-158: a disabled publisher is named as disabled, says what the board does without it, and is not a failure", async () => {
  const disabled = byName(await diagnose(deps({ readFile: () => hostWithProviders({ publish: { ...PUBLISH, enabled: false } }) })));
  assert.equal(disabled["publisher (slack, disabled)"].ok, true);
  assert.equal(disabled["publisher (slack, disabled)"].detail, "disabled: publishes nothing");
  assert.equal(disabled["publisher (slack)"], undefined, "the enabled row is not also there");
  const enabled = byName(await diagnose(deps({ readFile: () => hostWithProviders({ publish: PUBLISH }) })));
  assert.equal(enabled["publisher (slack)"].ok, true);
  assert.equal(enabled["publisher (slack)"].detail, "from tickets.providers.publish, and its checks pass");
});

test("A11-158: a plugin that implements a contract major agent-org does not read fails its own row, naming it and the fix, when no block enables it", async () => {
  // A fake is never listed, so the plugin that implements the unread major is a bundled one of the catalog.
  const unread = fakeOf("fake-tracker", { contract: "2.0", where: "bundled", dir: "/checkout/plugins/far-future" });
  const checks = byName(await diagnose(deps({ agentOrgPlugins: fakeAgentOrgPlugins({ catalog: () => catalogWith([unread]) }) })));
  assertRow(checks, "plugin fake-tracker", { ok: false, detail: "plugin fake-tracker implements tracker contract 2.0; this agent-org reads tracker 1.x: update agent-org, or use a plugin of a major it reads", fix: /update agent-org/ });
  assertRow(checks, "tracker (linear)", { ok: true });
});

test("A11-158: a block that enables a plugin of an unread contract major fails the host file row with the same refusal, so nothing starts", async () => {
  const unread = fakeOf("fake-tracker", { contract: "2.0" });
  const checks = byName(await diagnose(deps({ readFile: () => hostWithProviders({ tracker: { provider: "fake-tracker" } }), agentOrgPlugins: fakeAgentOrgPlugins({ catalog: () => catalogWith([unread]) }) })));
  assert.equal(checks["host file"].ok, false);
  assert.match(checks["host file"].detail, /`tickets\.providers\.tracker\.provider` in the host file is refused: plugin fake-tracker implements tracker contract 2\.0; this agent-org reads tracker 1\.x: update agent-org, or use a plugin of a major it reads/);
  assert.equal(checks["plugin fake-tracker"], undefined, "an enabled plugin's refusal is the host row's, not a second row");
});

test("A11-158: a package the registry refused is a failed row naming it", async () => {
  const refusals = [{ plugin: "linear-tools", why: "plugin linear-tools: package.json declares dependencies (left-pad), which a host's install does not install" }];
  const checks = byName(await diagnose(deps({ agentOrgPlugins: fakeAgentOrgPlugins({ catalog: () => catalogWith([], refusals) }) })));
  assert.equal(checks["plugin linear-tools"].ok, false);
  assert.equal(checks["plugin linear-tools"].detail, refusals[0].why);
});

test("A11-158: the doctor checks of an enabled bundled plugin are rows, and a failing one fails its provider's row with its own fix", async () => {
  const bundled = fakeOf("fake-tracker", { where: "bundled", dir: "/checkout/plugins/fake-tracker", entry: "index.ts" });
  const tracker = (await import("../plugins/fakes/tracker.ts")).createFakeTracker();
  const module = { create: () => tracker, doctorChecks: () => [{ name: "fake tracker key", ok: false, detail: "no key at /k/fake", fix: "write the key to /k/fake" }], onboardSteps: [] };
  const seen: string[] = [];
  const plugins = fakeAgentOrgPlugins({
    catalog: () => catalogWith([bundled]),
    load: async (providers) => { seen.push(providers.blocks.tracker.provider); return { loaded: [{ plugin: bundled, implementation: tracker, module }], unbuilt: [], refusals: [] }; },
  });
  const checks = byName(await diagnose(deps({ readFile: () => hostWithProviders({ tracker: { provider: "fake-tracker" } }), agentOrgPlugins: plugins })));
  assert.deepEqual(seen, ["fake-tracker"]);
  assertRow(checks, "fake tracker key", { ok: false });
  assertRow(checks, "tracker (fake-tracker)", { ok: false, detail: /no key at \/k\/fake/, fix: "write the key to /k/fake" });
});

test("A11-158: a plugin the loader refuses fails its provider's row, naming the plugin", async () => {
  const bundled = fakeOf("fake-tracker", { where: "bundled", dir: "/checkout/plugins/fake-tracker", entry: "index.ts" });
  const plugins = fakeAgentOrgPlugins({ catalog: () => catalogWith([bundled]), load: async () => ({ loaded: [], unbuilt: [], refusals: [{ plugin: "fake-tracker", concern: "tracker" as const, why: "plugin fake-tracker: index.ts must export create, doctorChecks and onboardSteps" }] }) });
  const checks = byName(await diagnose(deps({ readFile: () => hostWithProviders({ tracker: { provider: "fake-tracker" } }), agentOrgPlugins: plugins })));
  assert.equal(checks["plugin fake-tracker"].ok, false);
  assert.equal(checks["tracker (fake-tracker)"].ok, false);
});

test("A11-158: the messaging row says what the project's messaging key holds, and never a secret", async () => {
  const on = byName(await diagnose(deps({ agentOrgPlugins: fakeAgentOrgPlugins({ messaging: async () => ({ provider: "telegram", enabled: true, settings: { tokenFile: "/home/me/.config/agent-org/token" } }) }) })));
  assert.equal(on["messaging (telegram)"].ok, true);
  assert.match(on["messaging (telegram)"].detail, /project\.json's messaging key/);
  assert.doesNotMatch(on["messaging (telegram)"].detail, /token/, "the row names no file the key points at");
  const off = byName(await diagnose(deps({ agentOrgPlugins: fakeAgentOrgPlugins({ messaging: async () => ({ provider: null, why: "project.json has no messaging key, so messaging is off" }) }) })));
  assert.equal(off["messaging (none)"].detail, "project.json has no messaging key, so messaging is off");
});

test("A11-162: the messaging plugin's rows stand beside its row, which passes when they do and fails with the first failing row's fix when one does not", async () => {
  const state = { provider: "telegram", enabled: true, settings: {} } as const;
  const rows = [{ name: "telegram token file", ok: true, detail: "/h/.config/agent-org/token is readable by no one else", fix: null }, { name: "telegram chat", ok: true, detail: "NOT YET PAIRED: run `agent-org messaging:pair`", fix: null }];
  const passing = await diagnose(deps({ agentOrgPlugins: fakeAgentOrgPlugins({ messaging: async () => state, messagingChecks: async () => rows }) }));
  assert.deepEqual(passing.filter(({ name }) => name.startsWith("telegram") || name.startsWith("messaging")).map(({ name, ok }) => [name, ok]), [["telegram token file", true], ["telegram chat", true], ["messaging (telegram)", true]]);
  assert.equal(byName(passing)["messaging (telegram)"].detail, "configured in project.json's messaging key, and its checks pass");
  const failing = byName(await diagnose(deps({ agentOrgPlugins: fakeAgentOrgPlugins({ messaging: async () => state,
    messagingChecks: async () => [{ ...rows[0], ok: false, detail: "/h/.config/agent-org/token has mode 0644, not 0600", fix: "chmod 600 /h/.config/agent-org/token" }, rows[1]] }) })));
  assert.equal(failing["messaging (telegram)"].ok, false);
  assert.equal(failing["messaging (telegram)"].detail, "configured in project.json's messaging key: /h/.config/agent-org/token has mode 0644, not 0600");
  assert.equal(failing["messaging (telegram)"].fix, "chmod 600 /h/.config/agent-org/token");
});

test("A11-162: a messaging key the reader or the loader refuses is one failing row naming it, and a plugin that is switched off asks for no rows", async () => {
  const state = { provider: "telegram", enabled: true, settings: {} } as const;
  const refused = byName(await diagnose(deps({ agentOrgPlugins: fakeAgentOrgPlugins({ messaging: async () => state,
    messagingChecks: async () => { throw new Error("project.json: messaging.tokenFile: `/etc/shadow` is not a file under ~/.config/agent-org/"); } }) })));
  assert.equal(refused["plugin telegram"].ok, false);
  assert.match(refused["plugin telegram"].detail, /messaging\.tokenFile: `\/etc\/shadow` is not a file under/);
  assert.equal(refused["messaging (telegram)"].ok, false);
  const disabled = byName(await diagnose(deps({ agentOrgPlugins: fakeAgentOrgPlugins({ messaging: async () => ({ ...state, enabled: false }),
    messagingChecks: async () => { throw new Error("a disabled plugin is not asked"); } }) })));
  assert.deepEqual([disabled["messaging (telegram, disabled)"].ok, disabled["plugin telegram"]], [true, undefined]);
  assert.match(disabled["messaging (telegram, disabled)"].detail, /disabled: nothing is sent to the chairman and nothing is asked, and its settings are kept for `agent-org plugin enable`/);
});

// ---- A11-162 DONE-WHEN: switching exposure from tailscale to local is `agent-org plugin enable local` plus a restart, with doctor green

test("A11-162 done-when: `agent-org plugin enable local` takes a served board off the tailnet through the real plugin, and doctor is green before and after, asking Tailscale nothing after", async () => {
  const dir = mkdtempSync(join(tmpdir(), "switch-"));
  try {
    // A `tailscale` on PATH that holds its serve config in a file, so the command (a process of its own, for the real loader) and this test see one machine.
    const bin = join(dir, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "tailscale"), `#!/bin/sh\nexec "${process.execPath}" "${fileURLToPath(new URL("../../plugins/tailscale/stub.ts", import.meta.url))}" "$@"\n`, { mode: 0o755 });
    const stateFile = join(dir, "tailscale.json");
    const environment = { PATH: `${bin}:${process.env.PATH ?? ""}`, TAILSCALE_STUB_STATE: stateFile };
    const tailscale = (...args: string[]) => spawnSync("tailscale", args, { env: { ...process.env, ...environment }, encoding: "utf8" });
    const held = () => Object.keys(JSON.parse(readFileSync(stateFile, "utf8")).web as Record<string, unknown>);
    // The host: its exposure block names tailscale, over the ports and terminal the doctor tests use; the board is served as `agent-org start ui` and `start terminal` serve it.
    const hostPath = join(dir, "host.json");
    const served = JSON.parse(HOST);
    served.tickets.providers.exposure = { ...served.tickets.providers.exposure, provider: "tailscale" };
    writeFileSync(hostPath, JSON.stringify(served));
    assert.equal(tailscale("serve", "--bg", "--https=9443", "http://127.0.0.1:4801").status, 0);
    assert.equal(tailscale("serve", "--bg", "--https=9444", "http://127.0.0.1:7318").status, 0);
    const doctorOver = async (hostText: string, state: ReturnType<typeof freshState>, over: Partial<DoctorDeps> = {}) => {
      const programs = execOf();
      const stub = createTailscale(state);
      return diagnose(deps({ readFile: () => hostText, exec: (file, args) => (file === "tailscale" ? stub(file, args) : programs(file, args)), ...over }));
    };
    const before = await doctorOver(readFileSync(hostPath, "utf8"), JSON.parse(readFileSync(stateFile, "utf8")), { probe: async () => 200 });
    assert.deepEqual(before.filter((check) => !check.ok), [], "POSITIVE CONTROL: doctor is green while the board is served on the tailnet, so the green after is not an inert harness");
    assert.equal(byName(before)["exposure (tailscale)"].ok, true);
    assert.deepEqual(held().sort(), ["agents.tail1234.ts.net:9443", "agents.tail1234.ts.net:9444"]);

    const lines: string[] = [];
    const saved = { PATH: process.env.PATH, TAILSCALE_STUB_STATE: process.env.TAILSCALE_STUB_STATE };
    Object.assign(process.env, environment);
    let status: number;
    try {
      status = await runPlugin(["enable", "local"], { hostPath, catalog: defaultCatalog(), log: (line) => lines.push(line), error: (line) => lines.push(line) });
    } finally {
      process.env.PATH = saved.PATH;
      if (saved.TAILSCALE_STUB_STATE === undefined) delete process.env.TAILSCALE_STUB_STATE;
      else process.env.TAILSCALE_STUB_STATE = saved.TAILSCALE_STUB_STATE;
    }
    assert.equal(status, 0, lines.join("\n"));
    assert.match(lines.join("\n"), /took this board's tailscale serve entries off the tailnet: ui \(port 9443\), terminal \(port 9444\)/);
    assert.deepEqual(held(), [], "both of this board's entries are gone from the tailnet");
    assert.equal(JSON.parse(readFileSync(hostPath, "utf8")).tickets.providers.exposure.provider, "local");
    assert.match(lines.join("\n"), /run `agent-org start instance`, `agent-org start ui` and `agent-org start terminal`/, "the restart it names");

    // The restart and the doctor ask Tailscale nothing: it is not the exposure now.
    const after = JSON.parse(readFileSync(stateFile, "utf8"));
    const calls = after.calls.length;
    const green = await doctorOver(readFileSync(hostPath, "utf8"), freshState(after));
    assert.deepEqual(green.filter((check) => !check.ok), [], "doctor is green once the exposure is local");
    assert.equal(byName(green)["exposure (local)"].ok, true);
    assert.equal(byName(green).tailscale, undefined, "and says nothing of the tailnet");
    assert.equal(after.calls.length, calls);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- A11-163: one section per plugin

/** The report's lines. */
const linesOf = (checks: Check[]): string[] => report(checks).split("\n");

test("A11-163: doctor prints a section per agent-org plugin in concern order, each headed by the concern, the plugin, its state and contract and where its code lives, with the plugin's checks beneath", async () => {
  const checks = await diagnose(deps());
  const lines = linesOf(checks);
  const headers = lines.filter((line) => /^[a-z][a-z ]*: /.test(line) && !/^(?:ok|FAIL) /.test(line));
  assert.deepEqual(headers, [
    "tracker: linear (enabled, contract 1.1, plugins/linear)",
    "code host: github (enabled, contract 1.2, plugins/github)",
    "publisher: none",
    "reviewer: none",
    "exposure: local (enabled, contract 1.1, plugins/local)",
    "messaging: none",
  ]);
  const tracker = lines.indexOf("tracker: linear (enabled, contract 1.1, plugins/linear)");
  assert.match(lines[tracker + 1], /^ {2}ok {4}tracker key: /, "the plugin's own checks are indented beneath its header");
  assert.match(lines[tracker + 2], /^ {2}ok {4}linear mcp: /);
  assert.match(lines[tracker + 3], /^ {2}ok {4}tracker \(linear\): /, "and the concern's row that summarises them closes the section");
  assert.match(lines[tracker - 1], /^ok {4}terminal answering: /, "the machine's checks stand outside the sections, before them");
  assert.deepEqual(lines.filter((line) => /^ok {4}(?:tracker key|tracker \(linear\))/.test(line)), [], "no plugin row is left outside its section");
});

test("A11-163: a disabled plugin's section says what the board does without it, and a concern with none says none", async () => {
  const host = hostWithProviders({ publish: { ...PUBLISH, enabled: false } });
  const lines = linesOf(await diagnose(deps({ readFile: () => host })));
  const at = lines.indexOf("publisher: slack (disabled, contract 1.1, plugins/slack)");
  assert.notEqual(at, -1);
  assert.equal(lines[at + 1], "  ok    publisher (slack, disabled): disabled: publishes nothing");
  assert.ok(lines.includes("reviewer: none"));
  assert.ok(lines.includes("  ok    reviewer (none): no block: the default, none, which starts no reviewer, applies"));
});

test("A11-163: a plugin that failed to load is a FAIL row in its own section with the reason and the fix, the other sections are as they were, and the exit status is the same as it was", async () => {
  const bundled = fakeOf("fake-tracker", { where: "bundled", dir: "/checkout/plugins/fake-tracker", entry: "index.ts" });
  const refusal = { plugin: "fake-tracker", concern: "tracker" as const, why: "plugin fake-tracker: index.ts must export create, doctorChecks and onboardSteps" };
  const plugins = fakeAgentOrgPlugins({ catalog: () => catalogWith([bundled]), load: async () => ({ loaded: [], unbuilt: [], refusals: [refusal] }) });
  const checks = await diagnose(deps({ readFile: () => hostWithProviders({ tracker: { provider: "fake-tracker" } }), agentOrgPlugins: plugins }));
  const lines = linesOf(checks);
  const at = lines.indexOf("tracker: fake-tracker (failed, contract 1.1, plugins/fake-tracker)");
  assert.notEqual(at, -1, `the header says failed: ${lines.filter((line) => /^tracker/.test(line)).join(" / ")}`);
  assert.equal(lines[at + 1], `  FAIL  plugin fake-tracker: ${refusal.why}`);
  assert.equal(lines[at + 2], "        fix: update agent-org, or the plugin");
  assert.match(lines[at + 3], /^ {2}FAIL {2}tracker \(fake-tracker\): /, "the concern's row fails with it");
  assert.ok(lines.includes("code host: github (enabled, contract 1.2, plugins/github)"), "the code host's section is untouched");
  assert.equal(checks.every((check) => check.ok), false, "a failing plugin fails the run");
  assert.equal((await diagnose(deps())).every((check) => check.ok), true, "and a working install is still green");
});

test("A11-163: what the registry refused, and a plugin that implements a major this release does not read, are failed sections too", async () => {
  const unread = fakeOf("fake-tracker", { contract: "2.0", where: "bundled", dir: "/checkout/plugins/far-future" });
  const refusals = [{ plugin: "linear-tools", why: "plugin linear-tools: package.json declares dependencies (left-pad), which a host's install does not install" }];
  const lines = linesOf(await diagnose(deps({ agentOrgPlugins: fakeAgentOrgPlugins({ catalog: () => catalogWith([unread], refusals) }) })));
  const unreadAt = lines.indexOf("tracker: fake-tracker (failed, contract 2.0, plugins/far-future)");
  assert.notEqual(unreadAt, -1);
  assert.match(lines[unreadAt + 1], /^ {2}FAIL {2}plugin fake-tracker: plugin fake-tracker implements tracker contract 2\.0/);
  const refusedAt = lines.indexOf("refused by the registry");
  assert.equal(lines[refusedAt + 1], `  FAIL  plugin linear-tools: ${refusals[0].why}`);
  assert.equal(lines[refusedAt + 2], "        fix: fix the plugin's package.json, or remove the plugin");
});

test("A11-163: the messaging section is headed by its plugin, and a project with none says so", async () => {
  const state = { provider: "telegram", enabled: true, settings: {} } as const;
  const rows = [{ name: "telegram token file", ok: true, detail: "readable by no one else", fix: null }];
  const lines = linesOf(await diagnose(deps({ agentOrgPlugins: fakeAgentOrgPlugins({ messaging: async () => state, messagingChecks: async () => rows }) })));
  const at = lines.indexOf("messaging: telegram (enabled, contract 1.1, plugins/telegram)");
  assert.deepEqual(lines.slice(at + 1, at + 3), ["  ok    telegram token file: readable by no one else", "  ok    messaging (telegram): configured in project.json's messaging key, and its checks pass"]);
});

test("A11-163: a messaging key that names a plugin the registry does not hold is a FAIL, in its own section, as it was; it is not read as no messaging", async () => {
  const state = { provider: "nope", enabled: true, settings: {} } as const;
  const checks = await diagnose(deps({ agentOrgPlugins: fakeAgentOrgPlugins({ messaging: async () => state, messagingChecks: async () => { throw new Error("messaging: no provider named nope is installed"); } }) }));
  const row = byName(checks);
  assertRow(row, "plugin nope", { ok: false, detail: "messaging: no provider named nope is installed" });
  assert.equal(row["messaging (nope)"].ok, false);
  assert.equal(checks.every((check) => check.ok), false, "so the run fails, as it did");
  assert.ok(linesOf(checks).includes("messaging: none"));
});

test("A11-163: a concern no plugin runs keeps its row when another plugin of it failed to load", async () => {
  const unread = fakeOf("fake-reviewer", { contract: "2.0", where: "bundled", dir: "/checkout/plugins/far-future" });
  const checks = byName(await diagnose(deps({ agentOrgPlugins: fakeAgentOrgPlugins({ catalog: () => catalogWith([unread]) }) })));
  assertRow(checks, "plugin fake-reviewer", { ok: false });
  assertRow(checks, "reviewer (none)", { ok: true });
});

test("A11-163: a host file the reader refuses still shows the messaging rows, as it always did", async () => {
  const state = { provider: "telegram", enabled: true, settings: {} } as const;
  const refusedText = JSON.stringify({ tickets: { port: "x" } });
  const checks = byName(await diagnose(deps({ readFile: () => refusedText, agentOrgPlugins: fakeAgentOrgPlugins({ messaging: async () => state,
    messagingChecks: async () => [{ name: "telegram token file", ok: false, detail: "mode 0644", fix: "chmod 600 the token" }] }) })));
  assert.equal(checks["host file"].ok, false);
  assertRow(checks, "telegram token file", { ok: false });
  assertRow(checks, "messaging (telegram)", { ok: false, fix: "chmod 600 the token" });
});

// A11-161: reviews required, and no reviewer to do them. The reviewer's section fails, naming the command that puts one back; a machine that does not require one says nothing more.
test("A11-161: with reviews required and the reviewer switched off, the reviewer section fails with `agent-org plugin enable atomic`; with none installed it says `agent-org plugin install atomic`", async () => {
  const disabled = byName(await diagnose(deps({ readFile: () => hostWithProviders({ reviewer: { provider: "atomic", enabled: false } }) })));
  assertRow(disabled, "reviewer (atomic, disabled)", { ok: false, detail: "reviews are required and the reviewer is off: starts no reviewer", fix: "agent-org plugin enable atomic" });
  const none = byName(await diagnose(deps({ readFile: () => hostWithProviders({ reviewer: { provider: "none", required: true } }) })));
  assertRow(none, "reviewer (none)", { ok: false, detail: "reviews are required and the reviewer is off: starts no reviewer", fix: "agent-org plugin install atomic" });
  assert.equal(disabled["host file"].ok, true, "the host file itself reads");
});

test("A11-161: a machine that does not require a reviewer passes with none or with it switched off, and says it starts none", async () => {
  const none = byName(await diagnose(deps()));
  assertRow(none, "reviewer (none)", { ok: true, detail: /starts no reviewer/ });
  const people = byName(await diagnose(deps({ readFile: () => hostWithProviders({ reviewer: { provider: "atomic", enabled: false, required: false } }) })));
  assertRow(people, "reviewer (atomic, disabled)", { ok: true, detail: "disabled: starts no reviewer" });
  const enabled = byName(await diagnose(deps({ readFile: () => hostWithProviders({ reviewer: { provider: "atomic" } }) })));
  assertRow(enabled, "reviewer (atomic)", { ok: true });
});

test("A11-161: reviews required with a reviewer that is on is not the failure: it is the reviewer's own checks that decide (its gate, Codex)", async () => {
  const refusing = byName(await diagnose(deps({ readFile: () => hostWithProviders({ reviewer: { provider: "atomic", required: true } }), reviewing: gateLoads("the gate's modules do not load") })));
  assertRow(refusing, "reviewer (atomic)", { ok: false, detail: /the gate's modules do not load/ });
  assert.equal(refusing["reviewer (atomic)"].fix, "fix what it names: no reviewer starts while the gate does not load", "the fix is the gate's, not the enable command: the reviewer is enabled");
});
