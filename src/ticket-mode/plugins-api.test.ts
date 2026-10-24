// no-token: none -- a scratch host file and an injected seam: no plugin is imported, no program runs, and Claude Code's install record is a string
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "../lib/tmp-fixture.ts";
import type { PluginModule } from "../plugins/manifest.ts";
import { defaultCatalog } from "../plugins/registry.ts";
import { claudePluginsOf, pluginsApi, type PluginsSeam } from "./plugins-api.ts";
import { parseTicketSettings } from "./settings.ts";

const RECORD = "/record.json";
const CACHE = "/cache/a11ign/1.0.0";
const MANIFEST = `${CACHE}/.claude-plugin/plugin.json`;
const BLOCKS = { tracker: { provider: "linear", enabled: true }, codeHost: { provider: "github", enabled: true }, exposure: { provider: "tailscale", port: 5000 } };
const declared = (needs: object = {}) => JSON.stringify({ name: "a11ign", metadata: { agentOrg: { contract: "1.0", agentOrg: ">=0.0.0 <1.0.0", provides: { writer: { skill: "a11ign:create-ticket" } }, needs } } });

/** The page's API over a scratch host file that lists `plugins`, with Claude Code's install record holding `record` and the plugin's manifest `manifest`. */
function apiOver(host: Record<string, unknown>, claude: Readonly<{ record?: unknown; manifest?: string; onPath?: boolean }> = {}, seam: PluginsSeam = {}) {
  const dir = tmpDir("plugins-api-");
  const hostPath = join(dir, "host.json");
  const write = (over: Record<string, unknown>) => writeFileSync(hostPath, JSON.stringify({ clones: { "nbl-ui-netbox": "/r/netbox" }, stateDir: dir, tickets: { providers: BLOCKS, ...over } }));
  write(host);
  const files: Record<string, string> = { [RECORD]: JSON.stringify(claude.record ?? { version: 2, plugins: {} }), ...(claude.manifest === undefined ? {} : { [MANIFEST]: claude.manifest }) };
  const settings = parseTicketSettings({ clones: { "nbl-ui-netbox": "/r/netbox" }, stateDir: dir, tickets: { providers: BLOCKS } });
  const api = pluginsApi({ hostPath, settings, seam: {
    load: async () => ({ loaded: [], unbuilt: [], refusals: [] }),
    messaging: { state: async () => ({ provider: null, why: "off" }) as const, checks: async () => [] },
    version: "v1.2.3",
    claude: { record: RECORD, read: (path) => { if (path in files) return files[path]; throw new Error(`ENOENT: ${path}`); }, exists: (path) => path === CACHE, onPath: () => claude.onPath ?? true, agentOrgVersion: () => "0.300.0" },
    ...seam,
  } });
  return { api, write, hostPath, files };
}
const USER_INSTALL = { version: 2, plugins: { "a11ign@m": [{ scope: "user", installPath: CACHE }] } };

test("A11-201: the answer carries the Claude plugins the host file lists, each with its install, its contract and its fix", async () => {
  const { api, write } = apiOver({}, { record: USER_INSTALL, manifest: declared() });
  assert.deepEqual((await api.read()).claude, { readable: true, plugins: [] }, "a host file that lists none has none");
  write({ plugins: ["a11ign@m", "absent@m"] });
  const { claude } = await api.read();
  assert.equal(claude.readable, true);
  assert.deepEqual(claude.plugins.map(({ entry, name, loads }) => [entry, name, loads]), [["a11ign@m", "a11ign", true], ["absent@m", "absent", false]]);
  assert.deepEqual(claude.plugins[0].installs, [{ scope: "user", projectPath: null }]);
  assert.equal(claude.plugins[0].contract?.provides.writer?.skill, "a11ign:create-ticket");
  assert.match(claude.plugins[1].why ?? "", /^absent@m is not installed: install it for every folder with `claude plugin install absent@m --scope user`\.$/);
  assert.equal(claude.plugins[1].contract, null);
});

test("A11-201: the Claude plugins are read from the host file as it is now, not as the board started", async () => {
  const { api, write } = apiOver({}, { record: USER_INSTALL, manifest: declared() });
  assert.equal((await api.read()).claude.plugins.length, 0);
  write({ plugins: ["a11ign@m"] });
  assert.deepEqual((await api.read()).claude.plugins.map(({ entry }) => entry), ["a11ign@m"]);
});

test("A11-201: a contract row of a Claude plugin is in the answer with the plugin it is about", async () => {
  const { api, write } = apiOver({}, { record: USER_INSTALL, manifest: declared({ commands: ["gh"] }), onPath: false });
  write({ plugins: ["a11ign@m"] });
  const { claude } = await api.read();
  assert.deepEqual(claude.plugins[0].rows.map(({ plugin, kind }) => [plugin, kind]), [["a11ign@m", "command-need"]]);
});

test("A11-201: attention is 0 when every plugin is whole, and counts a Claude plugin that is not installed, one whose health is unknown, and one with a contract row", async () => {
  const whole = apiOver({}, { record: USER_INSTALL, manifest: declared() });
  whole.write({ plugins: ["a11ign@m"] });
  assert.equal((await whole.api.read()).attention, 0);

  const missing = apiOver({}, { record: USER_INSTALL, manifest: declared() });
  missing.write({ plugins: ["a11ign@m", "absent@m"] });
  assert.equal((await missing.api.read()).attention, 1, "absent@m is not installed");

  const unreadable = apiOver({}, {});
  unreadable.files[RECORD] = "not json";
  unreadable.write({ plugins: ["a11ign@m", "other@m"] });
  const unknown = await unreadable.api.read();
  assert.deepEqual([unknown.claude.readable, unknown.claude.plugins.map(({ loads }) => loads), unknown.attention], [false, [null, null], 2], "health unknown counts, one each");

  const mismatch = apiOver({}, { record: USER_INSTALL, manifest: declared({ commands: ["gh"] }), onPath: false });
  mismatch.write({ plugins: ["a11ign@m"] });
  assert.equal((await mismatch.api.read()).attention, 1);
});

test("A11-201: attention counts an agent-org plugin whose doctor check fails together with the Claude plugins, from the one read", async () => {
  const linear = defaultCatalog().plugins.find(({ name }) => name === "linear")!;
  const failing = { plugin: linear, module: { doctorChecks: () => [{ name: "token", ok: false, detail: "no token", fix: "set one" }] } as unknown as PluginModule };
  const { api, write } = apiOver({}, { record: USER_INSTALL, manifest: declared() }, { load: async () => ({ loaded: [], unbuilt: [failing], refusals: [] }) });
  write({ plugins: ["a11ign@m", "absent@m"] });
  const answer = await api.read();
  assert.deepEqual([answer.concerns.flatMap(({ plugins }) => plugins).filter(({ checks }) => checks.some(({ ok }) => !ok)).map(({ name }) => name), answer.attention], [["linear"], 2]);
});

test("A11-201: claudePluginsOf keeps a plugin without a readable contract, named by its entry", () => {
  const states = { readable: true, plugins: [{ plugin: "nbl-ui@applied-ai", installs: [], loads: false, why: "x", installPath: null }] };
  assert.deepEqual(claudePluginsOf({ states, unreachable: ["x"], rows: [], contracts: [] }), { readable: true, plugins: [{ entry: "nbl-ui@applied-ai", name: "nbl-ui", loads: false, why: "x", installs: [], contract: null, rows: [] }] });
});
