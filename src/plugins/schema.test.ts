// no-token: none -- pure: the schema is built from a catalog read as data
import { test } from "node:test";
import assert from "node:assert/strict";
import { SCHEMA } from "../ticket-mode/config-schema.ts";
import { defaultSchema, schemaOf } from "./schema.ts";
import { buildCatalog, defaultCatalog, type PackageFiles } from "./registry.ts";

const entry = (key: string) => ({ key, file: "host.json", group: "Tracker", type: "text", absent: "unset", default: null, explanation: "e", breaks: "b", edit: { editable: false, why: "w" } });
const files = (settings: Record<string, unknown>): PackageFiles => ({
  directories: (path) => (path === "/c/plugins" ? ["example"] : []),
  text: (path) => (path === "/c/plugins/example/package.json" ? JSON.stringify({ agentOrg: { concern: "tracker", contract: "1.1", description: "d", entry: "index.ts", settings } }) : null),
  isFile: () => true,
});

test("the tracker's settings come from the Linear plugin, after the tracker's enabled entry, in the order the page drew them", () => {
  const keys = defaultSchema().map(({ key }) => key);
  const from = keys.indexOf("tickets.providers.tracker.enabled");
  assert.deepEqual(keys.slice(from, from + 9), [
    "tickets.providers.tracker.enabled", "tickets.providers.tracker.key", "tickets.providers.tracker.key.path", "tickets.providers.tracker.key.keychain",
    "tickets.providers.tracker.connectors", "tickets.providers.tracker.workingState", "tickets.providers.tracker.plannedState", "tickets.providers.tracker.takenStates",
    "tickets.providers.codeHost",
  ]);
  assert.equal(SCHEMA.some(({ key }) => key === "tickets.providers.tracker.key"), false, "core's own entries no longer hold them");
  assert.equal(defaultSchema(), defaultSchema(), "built once per process");
});

test("every core entry is kept in its place, and a key a plugin declares that the schema already holds is not added twice", () => {
  const withPlugins = schemaOf(defaultCatalog());
  assert.deepEqual(withPlugins.filter(({ key }) => SCHEMA.some((held) => held.key === key)).map(({ key }) => key), SCHEMA.map(({ key }) => key));
  const dupe = buildCatalog({ root: "/c", files: files({ port: entry("tickets.providers.tracker.port"), provider: entry("tickets.providers.tracker.provider") }) });
  const merged = schemaOf(dupe);
  const ids = merged.map(({ file, key }) => `${file} ${key}`);
  assert.equal(ids.length, new Set(ids).size, "no key twice in one file: `schema` is a key of two files, which are two entries");
  assert.equal(merged.length, SCHEMA.length + 1, "core's entries, and the example plugin's one new setting: `provider` is core's, and is not added again");
  assert.ok(ids.includes("host.json tickets.providers.tracker.port"), "a plugin's own setting is added");
});

test("the settings of two plugins of one concern follow the block's enabled entry, in catalog order", () => {
  const catalog = buildCatalog({ root: "/c", files: files({ token: entry("tickets.providers.tracker.token") }) });
  const keys = schemaOf(catalog).map(({ key }) => key);
  const at = keys.indexOf("tickets.providers.tracker.enabled");
  assert.equal(keys[at + 1], "tickets.providers.tracker.token", "the example plugin is first in the catalog, so its settings follow the entry first");
});
