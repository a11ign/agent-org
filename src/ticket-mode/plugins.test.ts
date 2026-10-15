// no-token: gh -- the install record is handed in as text; nothing is read from the machine
import { test } from "node:test";
import assert from "node:assert/strict";
import { unreachablePlugins } from "./plugins.ts";

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
