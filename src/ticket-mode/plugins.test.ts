// no-token: gh -- the install record is handed in as text; nothing is read from the machine
import { test } from "node:test";
import assert from "node:assert/strict";
import { pluginProblems, pluginStates, unreachablePlugins } from "./plugins.ts";
import type { HostFacts } from "./plugin-contract.ts";

const FOLDER = "/work/.tickets/NBF-1";
/** The check against a record holding `installs` for nbl-ui, where only the paths in `cached` exist. */
const check = (installs: unknown[] | null, cached: string[] = ["/cache/nbl-ui/0.17.0"], wanted = ["nbl-ui@applied-ai"]) =>
  unreachablePlugins(wanted, FOLDER, {
    read: () => JSON.stringify({ version: 2, plugins: installs === null ? {} : { "nbl-ui@applied-ai": installs } }),
    exists: (path) => cached.includes(path),
  });

test("a plugin installed for the user, or for the worker's own folder, is reachable", () => {
  assert.deepEqual(check([{ scope: "user", installPath: "/cache/nbl-ui/0.17.0" }]), []);
  assert.deepEqual(check([{ scope: "project", projectPath: FOLDER, installPath: "/cache/nbl-ui/0.17.0" }]), []);
});

test("a plugin installed only for another folder is not, and the reason names the command that installs it for every folder", () => {
  assert.deepEqual(check([{ scope: "project", projectPath: "/work", installPath: "/cache/nbl-ui/0.17.0" }]),
    [`nbl-ui@applied-ai is installed only for /work, so a worker in ${FOLDER} runs without it: install it for every folder with \`claude plugin install nbl-ui@applied-ai --scope user\`.`]);
});

test("a plugin not installed at all, or whose files are gone from the cache, is not reachable either", () => {
  assert.match(check(null)[0], /^nbl-ui@applied-ai is not installed: install it for every folder/);
  assert.match(check([{ scope: "user", installPath: "/cache/nbl-ui/0.17.0" }], [])[0], /files are missing from Claude Code's plugin cache: run \/plugin and update it/);
});

test("a record that cannot be read refuses nothing", () => {
  assert.deepEqual(unreachablePlugins(["nbl-ui@applied-ai"], FOLDER, { read: () => { throw new Error("ENOENT"); } }), []);
});

test("a record that is not JSON, or not the shape this knows, refuses nothing", () => {
  for (const text of ["not json", "[1, 2]", JSON.stringify({ plugins: "x" })]) assert.deepEqual(unreachablePlugins(["nbl-ui@applied-ai"], FOLDER, { read: () => text }), [], text);
});

test("an entry for the plugin that is not a list of installs refuses nothing, and does not throw", () => {
  for (const entry of ["x", [null], [1]]) {
    const read = () => JSON.stringify({ plugins: { "nbl-ui@applied-ai": entry } });
    assert.deepEqual(unreachablePlugins(["nbl-ui@applied-ai"], FOLDER, { read }), [], JSON.stringify(entry));
  }
});

test("a machine that names no plugin needs none", () => {
  assert.deepEqual(check([], [], []), []);
});

test("an install for no named folder is reported as for another folder, and each reason is its own sentence", () => {
  const [why] = check([{ scope: "managed", installPath: "/cache/nbl-ui/0.17.0" }]);
  assert.match(why, /^nbl-ui@applied-ai is installed only for another folder, so a worker in .*--scope user`\.$/);
});

test("the page's states: a plugin installed for the user loads, one for another folder does not and says the fix, and one not in the record is not installed", () => {
  const record = JSON.stringify({ version: 2, plugins: {
    "user@m": [{ scope: "user", installPath: "/cache/user/1" }],
    "elsewhere@m": [{ scope: "project", projectPath: "/work/other", installPath: "/cache/e/1" }],
  } });
  const { readable, plugins } = pluginStates(["user@m", "elsewhere@m", "absent@m"], FOLDER, { read: () => record, exists: () => true });
  assert.equal(readable, true);
  assert.deepEqual(plugins.map(({ plugin, loads }) => [plugin, loads]), [["user@m", true], ["elsewhere@m", false], ["absent@m", false]]);
  assert.deepEqual(plugins[0].installs, [{ scope: "user", projectPath: null }]);
  assert.deepEqual(plugins[1].installs, [{ scope: "project", projectPath: "/work/other" }]);
  assert.equal(plugins[1].why, unreachablePlugins(["elsewhere@m"], FOLDER, { read: () => record, exists: () => true })[0]);
  assert.match(plugins[2].why ?? "", /^absent@m is not installed: install it for every folder/);
});

test("an unreadable record is not readable, and each plugin in it is not checked, never loaded", () => {
  for (const text of ["not json", JSON.stringify({ plugins: "x" })]) {
    const { readable, plugins } = pluginStates(["nbl-ui@applied-ai"], FOLDER, { read: () => text });
    assert.equal(readable, false, text);
    assert.deepEqual(plugins, [{ plugin: "nbl-ui@applied-ai", installs: [], loads: null, why: null, installPath: null }]);
  }
  assert.deepEqual(pluginStates(["nbl-ui@applied-ai"], FOLDER, { read: () => { throw new Error("ENOENT"); } }).readable, false);
});

test("an entry of a shape the check does not know is not checked, and no plugin list is readable with nothing wanted", () => {
  const { readable, plugins } = pluginStates(["nbl-ui@applied-ai"], FOLDER, { read: () => JSON.stringify({ plugins: { "nbl-ui@applied-ai": "x" } }) });
  assert.deepEqual([readable, plugins[0].loads, plugins[0].why], [true, null, null]);
  assert.deepEqual(pluginStates([], FOLDER, { read: () => { throw new Error("never read"); } }), { readable: true, plugins: [] });
});

const RECORD = "/record.json";
const CACHE = "/cache/a11ign/1.0.0";
const MANIFEST = `${CACHE}/.claude-plugin/plugin.json`;
const CONTRACT_HOST: HostFacts = { plugins: ["a11ign@m"], connectors: [], plan: null, prReview: null, planner: null, writer: null };
/** A declared contract of `contract`, and nothing else the check looks at: its major is the only thing a test varies. */
const manifestWith = (contract: string) => JSON.stringify({ name: "a11ign", metadata: { agentOrg: { contract, agentOrg: ">=0.0.0 <1.0.0", provides: {}, needs: {} } } });
/** The problems for a session in FOLDER, with the record holding `installs` and the files of `files`, and nothing else on the machine read. */
function problemsFor(installs: unknown[], files: Record<string, string>, host: HostFacts = CONTRACT_HOST) {
  const record = JSON.stringify({ version: 2, plugins: { "a11ign@m": installs } });
  return pluginProblems({ wanted: ["a11ign@m"], folder: FOLDER, host }, {
    record: RECORD,
    read: (path) => {
      if (path === RECORD) return record;
      if (path in files) return files[path];
      throw new Error(`ENOENT: ${path}`);
    },
    exists: (path) => path === CACHE,
  });
}

test("a session that loads a plugin reads its contract and has the rows of it; one that does not reads none and says the fix", () => {
  const loads = problemsFor([{ scope: "user", installPath: CACHE }], { [MANIFEST]: manifestWith("2.0") });
  assert.deepEqual(loads.unreachable, []);
  assert.deepEqual(loads.rows.map(({ plugin, kind }) => [plugin, kind]), [["a11ign@m", "contract-major"]]);

  const elsewhere = problemsFor([{ scope: "project", projectPath: "/work", installPath: CACHE }], { [MANIFEST]: manifestWith("2.0") });
  assert.deepEqual(elsewhere.rows, [], "a plugin the session does not load has no contract rows");
  assert.equal(elsewhere.unreachable.length, 1);
  assert.match(elsewhere.unreachable[0], /^a11ign@m is installed only for \/work, so a worker in .* runs without it/);
});

test("the contract is read from the files of the install a session loads, which the state names", () => {
  const { states } = problemsFor([{ scope: "user", installPath: CACHE }], { [MANIFEST]: manifestWith("1.0") });
  assert.deepEqual(states.plugins.map(({ plugin, loads, installPath }) => [plugin, loads, installPath]), [["a11ign@m", true, CACHE]]);
  assert.deepEqual(problemsFor([{ scope: "user", installPath: CACHE }], { [MANIFEST]: manifestWith("1.0") }).rows, [], "a contract the reader reads, against the host, is no row");
});

test("a contract that is present and cannot be read is one row, which names the field and the file to fix", () => {
  const broken = JSON.stringify({ name: "a11ign", metadata: { agentOrg: { contract: "one", agentOrg: ">=0.0.0 <1.0.0" } } });
  const [row] = problemsFor([{ scope: "user", installPath: CACHE }], { [MANIFEST]: broken }).rows;
  assert.equal(row.kind, "contract-malformed");
  assert.match(row.why, /^a11ign@m's agent-org contract is malformed: metadata\.agentOrg\.contract must be "<major>\.<minor>".*Fix it in the plugin's \.claude-plugin\/plugin\.json\.$/);
});

test("a plugin with no contract, or a record that cannot be read, has no rows", () => {
  assert.deepEqual(problemsFor([{ scope: "user", installPath: CACHE }], {}).rows, [], "no manifest");
  const unreadable = pluginProblems({ wanted: ["a11ign@m"], folder: FOLDER, host: CONTRACT_HOST }, { record: RECORD, read: () => { throw new Error("ENOENT"); } });
  assert.deepEqual([unreadable.states.readable, unreadable.unreachable, unreadable.rows], [false, [], []]);
});

test("A11-139: the contract a session loads is returned with its plugin's name, and no plugin without a readable contract is among them", () => {
  const declared = JSON.stringify({ name: "a11ign", metadata: { agentOrg: { contract: "1.0", agentOrg: ">=0.0.0 <1.0.0", provides: { writer: { skill: "a11ign:create-ticket" } }, needs: {} } } });
  const [found] = problemsFor([{ scope: "user", installPath: CACHE }], { [MANIFEST]: declared }).contracts;
  assert.deepEqual([found.entry, found.name, found.contract.provides.writer?.skill], ["a11ign@m", "a11ign", "a11ign:create-ticket"]);
  assert.deepEqual(problemsFor([{ scope: "user", installPath: CACHE }], {}).contracts, [], "no contract, so none");
  assert.deepEqual(problemsFor([{ scope: "user", installPath: CACHE }], { [MANIFEST]: manifestWith("2.0") }).contracts, [], "a major this agent-org does not read is checked for nothing, so it is not returned");
  assert.deepEqual(problemsFor([{ scope: "user", installPath: CACHE }], { [MANIFEST]: JSON.stringify({ name: "a11ign", metadata: { agentOrg: { contract: "one" } } }) }).contracts, [], "a contract that cannot be read is not returned");
  assert.deepEqual(problemsFor([{ scope: "project", projectPath: "/work", installPath: CACHE }], { [MANIFEST]: declared }).contracts, [], "a plugin the session does not load is not read");
});

test("a host key that names a plugin tickets.plugins does not enable is a row only once a plugin declares a contract", () => {
  const host = { ...CONTRACT_HOST, planner: "Run the other:plan skill with {key} into {dir}" };
  assert.deepEqual(problemsFor([{ scope: "user", installPath: CACHE }], {}, host).rows, [], "no plugin declares a contract: checked as it always was");
  const declared = problemsFor([{ scope: "user", installPath: CACHE }], { [MANIFEST]: manifestWith("1.0") }, host).rows;
  assert.deepEqual(declared.map(({ plugin, kind }) => [plugin, kind]), [["other", "plugin-not-enabled"]]);
});
