// no-token: none -- the plugin is handed fake deps: no Keychain, program, file or network is touched
//
// THE PLUGIN AS CORE USES IT (A11-159): its manifest is read by the registry without importing it, its `create` builds the source from the key the block names, and its doctor checks
// are the rows doctor had before the code moved.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fakePluginDeps } from "../../src/plugins/fakes/deps.ts";
import { loadEnabled } from "../../src/plugins/loader.ts";
import { defaultCatalog, pluginNamed } from "../../src/plugins/registry.ts";
import { resolveProviders } from "../../src/ticket-mode/providers.ts";
import { create, doctorChecks, onboardSteps } from "./index.ts";

const KEY = "lin_api_SECRETSECRETSECRET";
const MCP = "Checking MCP server health…\n\nlinear: https://mcp.linear.app/mcp (HTTP) - ✔ Connected\n";

/** Fake deps whose `security` prints the key (or fails) and whose `claude mcp list` prints `mcp` (or cannot run). */
const depsWith = ({ key = KEY as string | null, mcp = MCP as string | null, files = {} as Record<string, string>, modes = {} as Record<string, number> } = {}) => fakePluginDeps({
  exec: (file, args) => {
    if (file === "security") return key === null ? { status: 44, stdout: "", stderr: "could not be found" } : { status: 0, stdout: `${key}\n`, stderr: "" };
    if (file === "claude" && args.join(" ") === "mcp list") return mcp === null ? { status: null, stdout: "", stderr: "not found" } : { status: 0, stdout: mcp, stderr: "" };
    return { status: null, stdout: "", stderr: "cannot start" };
  },
  readFile: (path) => files[path] ?? (() => { throw new Error("ENOENT"); })(),
  mode: (path) => modes[path] ?? null,
});

test("the registry finds the plugin as the bundled tracker linear, from its manifest alone, and the manifest brings its settings, tooling and writer", () => {
  const plugin = pluginNamed(defaultCatalog(), "linear");
  assert.ok(plugin !== undefined);
  assert.deepEqual([plugin.concern, plugin.where, plugin.contract, plugin.entry], ["tracker", "bundled", "1.7", "index.ts"]);
  assert.deepEqual(Object.keys(plugin.settings), ["key", "key.path", "key.keychain", "connectors", "workingState", "plannedState", "takenStates"],
    "the entries the Settings page drew for the tracker, in the order it drew them");
  for (const [name, entry] of Object.entries(plugin.settings)) assert.equal(entry.key, `tickets.providers.tracker.${name}`);
  assert.deepEqual(plugin.tooling.connectors, ["^mcp__linear__(get|list|search|extract)_", "^mcp__linear__save_comment$"], "the read-only connectors, and a comment on a ticket: never a save of an issue");
  assert.deepEqual(plugin.tooling.mcpServers, ["linear"]);
  assert.deepEqual(plugin.tooling.writer?.createTool, "mcp__linear__save_issue");
  assert.deepEqual(plugin.tooling.writer?.attachTools, ["mcp__linear__prepare_attachment_upload", "mcp__linear__create_attachment_from_upload"]);
  assert.deepEqual(plugin.tooling.writer?.priorities, { urgent: 1, high: 2, medium: 3, low: 4, none: 0 });
  for (const connector of plugin.tooling.connectors) assert.equal(connector.startsWith("^mcp__linear__"), true);
  for (const pattern of plugin.tooling.connectors) assert.equal(new RegExp(pattern).test(plugin.tooling.writer!.createTool), false, `${pattern} lets a worker call the create tool`);
});

test("the plugin has no dependencies and its entry exports what the loader needs", () => {
  assert.equal(typeof create, "function");
  assert.equal(typeof doctorChecks, "function");
  assert.deepEqual(onboardSteps.map(({ name }) => name), ["key location", "key storage", "mcp registration", "read connectors"]);
  for (const step of onboardSteps) assert.ok(step.explain.length > 0, step.name);
});

test("the loader loads the plugin for the default host, builds its source from the Keychain, and never prints the key", async () => {
  const providers = resolveProviders({ tickets: {} });
  const log: string[] = [];
  const result = await loadEnabled(providers, defaultCatalog(), { ...depsWith(), log: (line) => log.push(line) });
  assert.deepEqual(result.refusals, []);
  assert.deepEqual(result.loaded.map(({ plugin }) => plugin.name), ["linear", "github", "local"], "the default host enables the bundled code host beside the tracker (A11-160), and the bundled exposure (A11-162)");
  assert.equal(typeof (result.loaded[0].implementation as { assigned: unknown }).assigned, "function");
  assert.equal(log.join("\n").includes(KEY), false);
});

test("create reads the key where the block says, sends it only to Linear, and refuses a key it cannot read or a shape it does not know, naming the Keychain command", async () => {
  const sent: { url: string; authorization: string }[] = [];
  const fetch = (async (url: string, init: RequestInit = {}) => {
    sent.push({ url, authorization: (init.headers as Record<string, string>).Authorization });
    return new Response(JSON.stringify({ data: { viewer: { id: "u-1", name: "Dan Beck", email: null } } }), { status: 200 });
  }) as typeof globalThis.fetch;
  const source = create({}, { ...depsWith(), fetch });
  assert.equal(await source.viewer!(), "Dan Beck");
  assert.deepEqual(sent, [{ url: "https://api.linear.app/graphql", authorization: KEY }]);
  const onFile = create({ key: { path: "/k/linear.key" } }, { ...depsWith({ files: { "/k/linear.key": `${KEY}\n` } }), fetch });
  assert.equal(await onFile.viewer!(), "Dan Beck");
  assert.throws(() => create({}, depsWith({ key: null })), /no Linear key in the Keychain under agent-org-linear\. Store one with: security add-generic-password -a "\$USER" -s agent-org-linear -w/);
  assert.throws(() => create({ key: { path: "relative" } }, depsWith()), /tickets\.providers\.tracker\.key\.path must be an absolute path/);
  assert.throws(() => create({ key: "file" }, depsWith()), /tickets\.providers\.tracker\.key must be \{ "keychain"/);
});

test("the plugin's rows are the ones doctor had: the key is readable, and Linear's MCP is connected, each with its own fix", () => {
  const rows = (deps: ReturnType<typeof depsWith>, settings = {}) => Object.fromEntries(doctorChecks(settings, deps).map((row) => [row.name, row]));
  const working = rows(depsWith());
  assert.deepEqual(Object.keys(working), ["tracker key", "linear mcp"]);
  assert.deepEqual([working["tracker key"].ok, working["tracker key"].detail], [true, "readable from Keychain service agent-org-linear"]);
  assert.deepEqual([working["linear mcp"].ok, working["linear mcp"].detail], [true, "linear: https://mcp.linear.app/mcp (HTTP) - ✔ Connected"]);
  assert.equal(JSON.stringify(working).includes(KEY), false, "the key is never in a row");
  const noKey = rows(depsWith({ key: null }));
  assert.equal(noKey["tracker key"].fix, "security add-generic-password -a \"$USER\" -s agent-org-linear -w");
  const noFile = rows(depsWith({}), { key: { path: "/k/linear.key" } });
  assert.equal(noFile["tracker key"].fix, "write your Linear personal API key to /k/linear.key with mode 600, or run `agent-org onboard`");
  const open = rows(depsWith({ files: { "/k/linear.key": KEY }, modes: { "/k/linear.key": 0o644 } }), { key: { path: "/k/linear.key" } });
  assert.deepEqual([open["tracker key"].ok, open["tracker key"].detail, open["tracker key"].fix], [false, "/k/linear.key can be read by other users (mode 644)", "chmod 600 /k/linear.key"]);
  const private600 = rows(depsWith({ files: { "/k/linear.key": KEY }, modes: { "/k/linear.key": 0o600 } }), { key: { path: "/k/linear.key" } });
  assert.equal(private600["tracker key"].ok, true);
  assert.equal(rows(depsWith(), { key: { path: "relative" } })["tracker key"].ok, false, "a key of the wrong shape fails its row, with the refusal's words");
  assert.match(rows(depsWith(), { key: { path: "relative" } })["tracker key"].detail, /must be an absolute path/);
});

test("Linear's MCP row says whether Claude Code has it, whether it connects, and whether `claude` can run", () => {
  const mcp = (output: string | null) => doctorChecks({}, depsWith({ mcp: output }))[1];
  const absent = mcp("bookctx: http://x - ✔ Connected\n");
  assert.deepEqual([absent.ok, absent.detail], [false, "Claude Code has no `linear` MCP, so workers cannot read their tickets"]);
  assert.match(absent.fix ?? "", /agent-org onboard/);
  const failing = mcp("linear: https://mcp.linear.app/mcp (HTTP) - ✘ Failed to connect\n");
  assert.equal(failing.ok, false);
  assert.match(failing.fix ?? "", /claude mcp remove linear --scope user/);
  const none = mcp(null);
  assert.deepEqual([none.ok, none.detail], [false, "`claude mcp list` could not run"]);
});
