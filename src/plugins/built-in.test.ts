// no-token: none -- pure: the contract versions and the fakes read as data, and the catalog of this checkout
import { test } from "node:test";
import assert from "node:assert/strict";
import * as builtIn from "./built-in.ts";
import { CONTRACT_VERSIONS, FAKES } from "./built-in.ts";
import { blockOf, CONCERNS } from "./concerns.ts";
import { defaultCatalog, pluginNamed } from "./registry.ts";

test("every concern has a contract version and a fake, and the publisher's is 1.1: it gained agent()", () => {
  assert.deepEqual(CONCERNS.map((concern) => CONTRACT_VERSIONS[concern]), ["1.3", "1.4", "1.1", "1.1", "1.1", "1.1"]);
  assert.deepEqual(FAKES.map(({ concern }) => concern), [...CONCERNS]);
});

test("A11-161: no built-in plugin and no pin remains: every concern's plugin is a bundled package the registry finds, and core runs whichever a host enables", () => {
  assert.deepEqual(Object.keys(builtIn).sort(), ["CONTRACT_VERSIONS", "FAKES"], "BUILT_IN and CORE_RUNS are gone: slack and atomic were the last two rows");
  const catalog = defaultCatalog();
  assert.equal("pins" in catalog, false, "a catalog has no pin: nothing keeps a host file off a plugin of the concern");
  for (const name of ["linear", "github", "slack", "atomic", "local", "tailscale", "telegram"]) assert.equal(pluginNamed(catalog, name)?.where, "bundled", `${name} is a bundled package`);
  assert.deepEqual(catalog.plugins.filter(({ where }) => where !== "bundled" && where !== "fake"), []);
});

test("every plugin's settings are described by entries keyed in its concern's block, which is what the Settings page shows", () => {
  for (const plugin of defaultCatalog().plugins) {
    const block = blockOf(plugin.concern);
    for (const [name, entry] of Object.entries(plugin.settings)) assert.equal(entry.key, `${block === null ? "messaging" : `tickets.providers.${block}`}.${name}`, `${plugin.name}.${name}`);
  }
});

test("every fake declares the version its contract has in this release", () => {
  for (const plugin of FAKES) assert.equal(plugin.contract, CONTRACT_VERSIONS[plugin.concern], plugin.name);
});
