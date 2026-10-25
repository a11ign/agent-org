// no-token: gh -- parses JSON handed in, and reads files under a temporary directory; the ssh connection's tunnel is a fake
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "../lib/tmp-fixture.ts";
import { configDir, createConnections, parseConnections, readConnections, via, type Connection } from "./connections.ts";
import type { Remotes } from "./remote.ts";

const KEY = "d".repeat(48);
const ON_THIS_MACHINE: Connection[] = [{ name: "local", kind: "local" }];

test("the connections file is under XDG_CONFIG_HOME when that is an absolute path, and under ~/.config otherwise", () => {
  assert.equal(configDir({ XDG_CONFIG_HOME: "/x/config" }, "/home/me"), "/x/config/agent-org");
  assert.equal(configDir({ XDG_CONFIG_HOME: "relative" }, "/home/me"), "/home/me/.config/agent-org", "the XDG rule ignores a relative path");
  assert.equal(configDir({}, "/home/me"), "/home/me/.config/agent-org");
});

test("a connections file names this machine's instance, others by ssh target and others by https address and key file, in its order", () => {
  assert.deepEqual(parseConnections({
    work: { local: true },
    personal: { ssh: "agents" },
    aws: { ssh: "me@192.0.2.4", agentOrg: "/home/me/repos/agent-org/host/agent-org" },
    lab: { https: "https://agents.example.ts.net:4747", keyFile: "~/.agent-org/keys/lab" },
    tunnel: { https: "http://127.0.0.1:9000/", keyFile: "/keys/tunnel" },
  }, "/home/me"), [
    { name: "work", kind: "local" },
    { name: "personal", kind: "ssh", ssh: "agents", agentOrg: "agent-org" },
    { name: "aws", kind: "ssh", ssh: "me@192.0.2.4", agentOrg: "/home/me/repos/agent-org/host/agent-org" },
    { name: "lab", kind: "https", origin: "https://agents.example.ts.net:4747", keyFile: "/home/me/.agent-org/keys/lab" },
    { name: "tunnel", kind: "https", origin: "http://127.0.0.1:9000", keyFile: "/keys/tunnel" },
  ]);
  assert.deepEqual(parseConnections({ lab: { https: "https://agents.example.ts.net", keyFile: "/k" } }), [{ name: "lab", kind: "https", origin: "https://agents.example.ts.net", keyFile: "/k" }],
    "a machine with no instance of its own can connect to others");
});

test("plain http to a host other than this machine's loopback is refused, so the key never crosses a network in the clear", () => {
  for (const address of ["http://agents.example.ts.net:4747", "http://192.0.2.4:4747", "HTTP://agents.example.ts.net", "http://127.0.0.1.example.com"]) {
    assert.throws(() => parseConnections({ lab: { https: address, keyFile: "/k" } }), /plain http to .* is refused, because it would send the instance's key in the clear: use https/, address);
  }
  for (const address of ["http://127.0.0.1:4747", "http://localhost:4747", "http://[::1]:4747"]) {
    assert.equal((parseConnections({ lab: { https: address, keyFile: "/k" } })[0] as { origin: string }).origin.startsWith("http://"), true, address);
  }
});

test("a connections file is refused by the rule it breaks", () => {
  const refused: [unknown, RegExp][] = [
    [[], /JSON object of connection name/],
    [{}, /names no connection/],
    [{ a: { local: true }, b: { local: true } }, /at most one connection can be \{ "local": true \}.*2 are/],
    [{ "bad name": { local: true } }, /connection name "bad name"/],
    [{ "-x": { local: true } }, /connection name "-x"/],
    [{ p: "agents" }, /connection p must be an object/],
    [{ p: { ssh: "agents", port: 22 } }, /field no connection takes: port/],
    [{ p: {} }, /exactly one of local, ssh or https, and names none/],
    [{ p: { ssh: "agents", https: "https://agents.example.com" } }, /exactly one of local, ssh or https, and names ssh and https/],
    [{ w: { local: false } }, /local must be true, or left out/],
    [{ w: { local: true, agentOrg: "x" } }, /is local, so it takes no agentOrg/],
    [{ p: { ssh: "agents", keyFile: "/k" } }, /reached over ssh, so it takes no keyFile/],
    [{ p: { https: "https://agents.example.com", keyFile: "/k", agentOrg: "x" } }, /reached over https, so it takes no agentOrg/],
    [{ p: { ssh: "-oProxyCommand=touch /tmp/x" } }, /ssh must be an ssh target.*not starting with -/],
    [{ p: { ssh: "-Jjump" } }, /ssh must be an ssh target/],
    [{ p: { ssh: "agents;id" } }, /ssh must be an ssh target/],
    [{ p: { ssh: "$(id)" } }, /ssh must be an ssh target/],
    [{ p: { ssh: "agents", agentOrg: "agent-org;id" } }, /agentOrg must be a plain path/],
    [{ p: { https: "agents.example.com", keyFile: "/k" } }, /https must be the instance's address/],
    [{ p: { https: "ftp://agents.example.com", keyFile: "/k" } }, /https must be the instance's address/],
    [{ p: { https: "https://me:pw@agents.example.com", keyFile: "/k" } }, /address alone, with no user, path, query or fragment/],
    [{ p: { https: "https://agents.example.com/board", keyFile: "/k" } }, /address alone/],
    [{ p: { https: "https://agents.example.com/?k=1", keyFile: "/k" } }, /address alone/],
    [{ p: { https: "https://agents.example.com" } }, /keyFile must be an absolute path, or one starting ~\//],
    [{ p: { https: "https://agents.example.com", keyFile: "keys/lab" } }, /keyFile must be an absolute path/],
  ];
  for (const [value, reason] of refused) assert.throws(() => parseConnections(value), reason, JSON.stringify(value));
});

test("no connections file reads as this machine's instance alone, and no refusal", () => {
  assert.deepEqual(readConnections(tmpDir("connections-none-")), { connections: ON_THIS_MACHINE, refusal: null, migrated: null });
});

test("a connections file that is not JSON, breaks a rule or cannot be read is refused naming why, and leaves this machine's instance alone", () => {
  const dir = tmpDir("connections-bad-");
  const path = join(dir, "connections.json");
  writeFileSync(path, "{ work: ");
  assert.deepEqual(readConnections(dir), { connections: ON_THIS_MACHINE, refusal: `${path} is refused, so only this machine's instance is shown: it is not valid JSON`, migrated: null });
  writeFileSync(path, JSON.stringify({ lab: { https: "http://agents.example.ts.net", keyFile: "/k" } }));
  assert.match(String(readConnections(dir).refusal), /is refused, so only this machine's instance is shown: connection lab: plain http/);
  const unreadable = tmpDir("connections-dir-");
  mkdirSync(join(unreadable, "connections.json"));
  const read = readConnections(unreadable);
  assert.deepEqual(read.connections, ON_THIS_MACHINE);
  assert.match(String(read.refusal), /connections\.json cannot be read/);
});

test("a profiles.json with no connections.json beside it is read as the connections file, and says so; a connections.json wins", () => {
  const dir = tmpDir("connections-migrate-");
  writeFileSync(join(dir, "profiles.json"), JSON.stringify({ work: { local: true }, personal: { ssh: "agents" } }));
  const read = readConnections(dir);
  assert.deepEqual(read.connections, [{ name: "work", kind: "local" }, { name: "personal", kind: "ssh", ssh: "agents", agentOrg: "agent-org" }]);
  assert.equal(read.refusal, null);
  assert.equal(read.migrated, `read ${join(dir, "profiles.json")} as the connections file: rename it to connections.json, as profiles.json is read only until the next major version`);
  writeFileSync(join(dir, "connections.json"), JSON.stringify({ lab: { https: "https://agents.example.ts.net", keyFile: "/k" } }));
  assert.deepEqual(readConnections(dir), { connections: [{ name: "lab", kind: "https", origin: "https://agents.example.ts.net", keyFile: "/k" }], refusal: null, migrated: null });
});

/** A key file holding `KEY` with `mode`, in a directory of its own. */
function keyFile(mode: number): string {
  const path = join(tmpDir("connections-key-"), "lab.key");
  writeFileSync(path, `${KEY}\n`);
  chmodSync(path, mode);
  return path;
}

const NO_REMOTES = { reach: async () => { throw new Error("no ssh here"); }, forget: () => {}, close: () => {} } as unknown as Remotes;

test("this machine's instance is reached on its own port with the key in its state directory, and its terminal is the page's as it is", async () => {
  const connections = createConnections(ON_THIS_MACHINE, { local: { port: 4747, keyPath: keyFile(0o600) }, remotes: NO_REMOTES });
  const target = await connections.reach("local");
  assert.deepEqual({ ...target, terminal: undefined }, { key: KEY, host: "127.0.0.1:4747", address: { origin: "http://127.0.0.1:4747" }, terminal: undefined });
  assert.equal(target.terminal("http://127.0.0.1:7318/?ws={workspace}"), "http://127.0.0.1:7318/?ws={workspace}");
  assert.equal(via({ name: "local", kind: "local" }), "on this machine");
});

test("an https instance is sent its own host and the key in its mode-600 file, and a terminal on its own loopback is dropped, as it cannot be reached", async () => {
  const lab: Connection = { name: "lab", kind: "https", origin: "https://agents.example.ts.net:4747", keyFile: keyFile(0o600) };
  const target = await createConnections([lab], { local: { port: 4747, keyPath: "/none" }, remotes: NO_REMOTES }).reach("lab");
  assert.deepEqual([target.key, target.host, target.address], [KEY, "agents.example.ts.net:4747", { origin: "https://agents.example.ts.net:4747" }]);
  assert.equal(target.terminal("http://127.0.0.1:7318/?ws={workspace}"), null);
  assert.equal(target.terminal("https://term.example.ts.net/?ws={workspace}"), "https://term.example.ts.net/?ws={workspace}");
  assert.equal(via(lab), "at https://agents.example.ts.net:4747");
});

test("a key file other users can read, or that is missing, makes its connection unreachable with what to do, and never the others", async () => {
  const open: Connection = { name: "open", kind: "https", origin: "https://open.example.com", keyFile: keyFile(0o644) };
  const missing: Connection = { name: "missing", kind: "https", origin: "https://missing.example.com", keyFile: "/nonexistent/agent-org/lab.key" };
  const connections = createConnections([open, missing, ...ON_THIS_MACHINE], { local: { port: 4747, keyPath: keyFile(0o600) }, remotes: NO_REMOTES });
  await assert.rejects(connections.reach("open"), /can be read by other users \(mode 644\): run chmod 600 on it/);
  await assert.rejects(connections.reach("missing"), /does not exist: copy that instance's board\.key there, with mode 600/);
  assert.equal((await connections.reach("local")).key, KEY);
});

test("an ssh connection is reached through its tunnel, as its own host on the remote's loopback, and only it is forgotten when its key is refused", async () => {
  const forgot: string[] = [];
  const remotes = {
    reach: async () => ({ port: 4747, key: KEY, terminal: null, socket: "/private/board.sock", terminalLocal: 50001 }),
    forget: (name: string) => { forgot.push(name); },
    close: () => {},
  } as unknown as Remotes;
  const personal: Connection = { name: "personal", kind: "ssh", ssh: "agents", agentOrg: "agent-org" };
  const connections = createConnections([personal, ...ON_THIS_MACHINE], { local: { port: 4747, keyPath: "/none" }, remotes });
  const target = await connections.reach("personal");
  assert.deepEqual([target.host, target.address], ["127.0.0.1:4747", { socket: "/private/board.sock" }]);
  assert.equal(target.terminal("http://127.0.0.1:7318/?ws={workspace}"), "http://127.0.0.1:50001/?ws={workspace}");
  connections.forget("personal");
  connections.forget("local");
  assert.deepEqual(forgot, ["personal"]);
  await assert.rejects(connections.reach("gone"), /no connection gone/);
});

test("A11-270: restart opens only an ssh connection's tunnel again, from the one the request failed on, and reaches any other as it is", async () => {
  const restarted: [string, string][] = [];
  const remotes = {
    reach: async () => ({ port: 4747, key: KEY, terminal: null, socket: "/private/s1/board.sock", terminalLocal: 50001 }),
    restart: async (name: string, socket: string) => { restarted.push([name, socket]); return { port: 4747, key: KEY, terminal: null, socket: "/private/s2/board.sock", terminalLocal: 50009 }; },
    forget: () => {},
    close: () => {},
  } as unknown as Remotes;
  const personal: Connection = { name: "personal", kind: "ssh", ssh: "agents", agentOrg: "agent-org" };
  const connections = createConnections([personal, ...ON_THIS_MACHINE], { local: { port: 4747, keyPath: keyFile(0o600) }, remotes });
  const failed = await connections.reach("personal");
  const reopened = await connections.restart("personal", failed);
  assert.deepEqual(restarted, [["personal", "/private/s1/board.sock"]]);
  assert.deepEqual([reopened.host, reopened.address], ["127.0.0.1:4747", { socket: "/private/s2/board.sock" }]);
  assert.equal(reopened.terminal("http://127.0.0.1:7318/?ws={workspace}"), "http://127.0.0.1:50009/?ws={workspace}", "the terminal through the new tunnel");
  const local = await connections.restart("local", await connections.reach("local"));
  assert.deepEqual(local.address, { origin: "http://127.0.0.1:4747" });
  assert.equal(restarted.length, 1, "this machine's instance has no tunnel to open again");
  await assert.rejects(connections.restart("gone", failed), /no connection gone/);
});
