// no-token: none -- a scratch host file and an injected seam: no plugin is imported, no program runs, and Claude Code's install record is a string
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "../lib/tmp-fixture.ts";
import type { PluginModule } from "../plugins/manifest.ts";
import { defaultCatalog } from "../plugins/registry.ts";
import { claudePluginsOf, FRESH_MS, pluginsApi, type PluginsSeam } from "./plugins-api.ts";
import { parseTicketSettings } from "./settings.ts";

const RECORD = "/record.json";
const CACHE = "/cache/a11ign/1.0.0";
const MANIFEST = `${CACHE}/.claude-plugin/plugin.json`;
const BLOCKS = { tracker: { provider: "linear", enabled: true }, codeHost: { provider: "github", enabled: true }, exposure: { provider: "tailscale", port: 5000 } };
const declared = (needs: object = {}) => JSON.stringify({ name: "a11ign", metadata: { agentOrg: { contract: "1.0", agentOrg: ">=0.0.0 <1.0.0", provides: { writer: { skill: "a11ign:create-ticket" } }, needs } } });

/**
 * The page's API over a scratch host file that lists `plugins`, with Claude Code's install record holding `record` and the plugin's manifest `manifest`. An action that releases a plugin's
 * serve (disabling the exposure) is released by a stand-in, which notes it in `released`: no test reaches the machine's own `tailscale` (A11-270).
 */
function apiOver(host: Record<string, unknown>, claude: Readonly<{ record?: unknown; manifest?: string; onPath?: boolean }> = {}, seam: PluginsSeam = {}, options: Readonly<{ warm?: boolean }> = {}) {
  const dir = tmpDir("plugins-api-");
  const hostPath = join(dir, "host.json");
  const write = (over: Record<string, unknown>) => writeFileSync(hostPath, JSON.stringify({ clones: { "nbl-ui-netbox": "/r/netbox" }, stateDir: dir, tickets: { providers: BLOCKS, ...over } }));
  write(host);
  const files: Record<string, string> = { [RECORD]: JSON.stringify(claude.record ?? { version: 2, plugins: {} }), ...(claude.manifest === undefined ? {} : { [MANIFEST]: claude.manifest }) };
  const settings = parseTicketSettings({ clones: { "nbl-ui-netbox": "/r/netbox" }, stateDir: dir, tickets: { providers: BLOCKS } });
  const released: string[] = [];
  const api = pluginsApi({ hostPath, settings, warm: options.warm, seam: {
    outgoing: async (plugin) => ({ machineName: null, release: () => { released.push(plugin.name); return { ok: true, detail: "" }; } }),
    load: async () => ({ loaded: [], unbuilt: [], refusals: [] }),
    messaging: { state: async () => ({ provider: null, why: "off" }) as const, checks: async () => [] },
    version: "v1.2.3",
    claude: { record: RECORD, read: (path) => { if (path in files) return files[path]; throw new Error(`ENOENT: ${path}`); }, exists: (path) => path === CACHE, onPath: () => claude.onPath ?? true, agentOrgVersion: () => "0.300.0" },
    ...seam,
  } });
  return { api, write, hostPath, files, released };
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
  await api.check();
  const answer = await api.read();
  assert.deepEqual([answer.concerns.flatMap(({ plugins }) => plugins).filter(({ checks }) => checks.some(({ ok }) => !ok)).map(({ name }) => name), answer.attention], [["linear"], 2]);
});

test("A11-201: claudePluginsOf keeps a plugin without a readable contract, named by its entry", () => {
  const states = { readable: true, plugins: [{ plugin: "nbl-ui@applied-ai", installs: [], loads: false, why: "x", installPath: null }] };
  assert.deepEqual(claudePluginsOf({ states, unreachable: ["x"], rows: [], contracts: [] }), { readable: true, plugins: [{ entry: "nbl-ui@applied-ai", name: "nbl-ui", loads: false, why: "x", installs: [], contract: null, rows: [] }] });
});

// ---- A11-270: the checks are answered from memory, and run again behind the page

const LINEAR = defaultCatalog().plugins.find(({ name }) => name === "linear")!;
type Gate = { runs: number; release: () => void };

/** A seam whose linear plugin's checks wait until the test releases them, counting each run, on a clock the test moves. */
function gatedSeam(clock: { at: number }): { seam: PluginsSeam; gate: Gate } {
  const gate: Gate = { runs: 0, release: () => undefined };
  const doctorChecks = () => {
    gate.runs += 1;
    return new Promise((done) => { gate.release = () => done([{ name: "token", ok: false, detail: "no token", fix: "set one" }]); });
  };
  const module = { doctorChecks } as unknown as PluginModule;
  return { gate, seam: { load: async () => ({ loaded: [], unbuilt: [{ plugin: LINEAR, module }], refusals: [] }), now: () => clock.at } };
}
const linearChecks = (answer: Awaited<ReturnType<ReturnType<typeof pluginsApi>["read"]>>) => answer.concerns.flatMap(({ plugins }) => plugins).find(({ name }) => name === "linear")!.checks;
/** Lets the checks started reach the plugin, or the checks released be kept. */
const settle = () => new Promise((done) => { setTimeout(done, 10); });
/** Lets the running checks finish and be kept. */
async function finish(gate: Gate): Promise<void> {
  await settle();
  gate.release();
  await settle();
}
/** Checks that one run of the checks started, for `why`, lets it finish, and answers the read after it. */
async function readAfterTheFirstRun(api: ReturnType<typeof pluginsApi>, gate: Gate, why: string) {
  await settle();
  assert.equal(gate.runs, 1, why);
  await finish(gate);
  return api.read();
}

test("A11-270: a read never waits on the checks: a cold read answers at once with checkedAt null, no check rows and checking true", async () => {
  const clock = { at: Date.parse("2026-10-25T14:00:00Z") };
  const { seam, gate } = gatedSeam(clock);
  const { api } = apiOver({}, { record: USER_INSTALL, manifest: declared() }, seam);
  const started = Date.now();
  const cold = await api.read();
  assert.ok(Date.now() - started < 300, `answered in ${Date.now() - started} ms while the checks run`);
  assert.deepEqual([cold.checkedAt, cold.checking, linearChecks(cold)], [null, true, []]);
  const warm = await readAfterTheFirstRun(api, gate, "the read started the checks");
  assert.deepEqual([warm.checkedAt, warm.checking, linearChecks(warm).map(({ name }) => name), warm.attention], ["2026-10-25T14:00:00.000Z", false, ["token"], 1]);
  assert.equal(gate.runs, 1, "fresh checks are answered from memory, not run again");
});

test("A11-270: an API made warm, as the board makes it at its start, starts the checks before any read, so the first read finds them", async () => {
  const { seam, gate } = gatedSeam({ at: Date.parse("2026-10-25T14:00:00Z") });
  const { api } = apiOver({}, {}, seam, { warm: true });
  const first = await readAfterTheFirstRun(api, gate, "started with no read");
  assert.deepEqual([first.checkedAt, first.checking, linearChecks(first).map(({ name }) => name)], ["2026-10-25T14:00:00.000Z", false, ["token"]]);
  assert.equal(gate.runs, 1, "the first read answers the checks already run");
});

test("A11-270: only one run of the checks at a time: reads while they run share it", async () => {
  const { seam, gate } = gatedSeam({ at: 0 });
  const { api } = apiOver({}, {}, seam);
  await Promise.all([api.read(), api.read(), api.read()]);
  await settle();
  assert.equal(gate.runs, 1);
  await finish(gate);
});

test("A11-270: the checks run again behind the page when they are older than FRESH_MS, and the read meanwhile answers the last ones with their age", async () => {
  const clock = { at: Date.parse("2026-10-25T14:00:00Z") };
  const { seam, gate } = gatedSeam(clock);
  const { api } = apiOver({}, {}, seam);
  await api.read();
  await finish(gate);
  clock.at += FRESH_MS - 1;
  assert.equal((await api.read()).checking, false);
  clock.at += 1;
  const stale = await api.read();
  await settle();
  assert.deepEqual([gate.runs, stale.checking, stale.checkedAt, linearChecks(stale).length], [2, true, "2026-10-25T14:00:00.000Z", 1], "the last checks are answered while the new ones run");
  await finish(gate);
  assert.equal((await api.read()).checkedAt, "2026-10-25T14:01:00.000Z");
});

test("A11-270: a change to the host file runs the checks again, and the plugins themselves are read from the file as it is now", async () => {
  const { seam, gate } = gatedSeam({ at: 0 });
  const { api, write } = apiOver({}, { record: USER_INSTALL, manifest: declared() }, seam);
  await api.read();
  await finish(gate);
  write({ plugins: ["a11ign@m"] });
  const changed = await api.read();
  await settle();
  assert.deepEqual([gate.runs, changed.checking, changed.claude.plugins.map(({ entry }) => entry)], [2, true, ["a11ign@m"]]);
  await finish(gate);
});

test("A11-270: an action runs the checks again once it is done, and its answer is unchanged", async () => {
  const { seam, gate } = gatedSeam({ at: 0 });
  const { api, hostPath, released } = apiOver({}, {}, seam);
  const before = await api.read();
  await finish(gate);
  const done = await api.act({ action: "disable", name: "tailscale", base: before.bases["host.json"] });
  assert.match(done.said, /^disabled tailscale/);
  assert.deepEqual(released, ["tailscale"], "the stand-in, not the machine, was asked to release the serve");
  await settle();
  assert.equal(gate.runs, 2, "the action started the checks");
  const after = await api.read();
  assert.equal(after.checking, true);
  assert.equal(after.concerns.find(({ concern }) => concern === "exposure")?.plugins.find(({ name }) => name === "tailscale")?.state, "disabled", "the plugins are loaded from the file the action wrote");
  assert.match(readFileSync(hostPath, "utf8"), /"enabled": false/);
  await finish(gate);
});

test("A11-270: a read that asks for fresh checks runs them again though the last are fresh, and again after a run that started before it asked", async () => {
  const { seam, gate } = gatedSeam({ at: 0 });
  const { api } = apiOver({}, {}, seam);
  await api.read();
  await finish(gate);
  assert.equal((await api.read()).checking, false, "fresh checks are answered from memory");
  const asked = await api.read({ check: true });
  await settle();
  assert.deepEqual([asked.checking, gate.runs], [true, 2]);
  await api.read({ check: true });
  await finish(gate);
  await settle();
  assert.equal(gate.runs, 3, "the run under way started before the second ask, so the checks run once more after it");
  await finish(gate);
  assert.equal((await api.read()).checking, false);
});

test("A11-270: checks that never finish are one failing row after the time limit, and the read answers at once all the while", async () => {
  const module = { doctorChecks: () => new Promise(() => undefined) } as unknown as PluginModule;
  const { api } = apiOver({}, {}, { load: async () => ({ loaded: [], unbuilt: [{ plugin: LINEAR, module }], refusals: [] }), limitMs: 100 });
  assert.equal((await api.read()).checkedAt, null);
  await api.check();
  const answer = await api.read();
  assert.deepEqual(linearChecks(answer), [{ name: "plugin linear", ok: false, detail: "its checks did not finish within 0.1 seconds", fix: "run agent-org doctor to see them" }]);
  assert.notEqual(answer.checkedAt, null);
});
