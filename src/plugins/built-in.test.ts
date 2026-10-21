// no-token: none -- pure: the built-in table read as data
import { test } from "node:test";
import assert from "node:assert/strict";
import { SCHEMA } from "../ticket-mode/config-schema.ts";
import { BUILT_IN, CONTRACT_VERSIONS, CORE_RUNS, FAKES } from "./built-in.ts";
import { blockOf, CONCERNS } from "./concerns.ts";

test("every built-in setting is described by the schema entry of its block, which is what the Settings page shows", () => {
  for (const plugin of BUILT_IN) {
    for (const [name, entry] of Object.entries(plugin.settings)) {
      assert.equal(entry.key, `tickets.providers.${blockOf(plugin.concern)}.${name}`);
      assert.ok(SCHEMA.includes(entry), `${entry.key} is the schema's own entry, not a copy`);
    }
  }
});

test("the settings each built-in declares are exactly what its block took before the registry", () => {
  const declared = Object.fromEntries(BUILT_IN.map(({ name, settings }) => [name, Object.keys(settings)]));
  assert.deepEqual(declared, {
    slack: ["run", "model", "effort", "connectors"], atomic: [],
    local: ["port", "uiPort", "terminal", "tailnetPorts"], tailscale: ["port", "uiPort", "terminal", "tailnetPorts"], telegram: [],
  });
});

test("every concern has a contract version and a fake, and every built-in concern a pin: not messaging, which has no block to pin, and not the tracker or the code host, which A11-159 and A11-160 moved into plugins/linear and plugins/github", () => {
  assert.deepEqual(CONCERNS.map((concern) => CONTRACT_VERSIONS[concern]), ["1.1", "1.1", "1.0", "1.0", "1.0", "1.0"]);
  assert.deepEqual(FAKES.map(({ concern }) => concern), [...CONCERNS]);
  assert.deepEqual(Object.keys(CORE_RUNS), CONCERNS.filter((concern) => blockOf(concern) !== null && BUILT_IN.some((plugin) => plugin.concern === concern)));
  assert.equal(BUILT_IN.some(({ concern }) => concern === "tracker"), false, "the tracker has no built-in row: linear is a bundled package");
  assert.equal(BUILT_IN.some(({ concern }) => concern === "codeHost"), false, "the code host has no built-in row: github is a bundled package");
  for (const [concern, pin] of Object.entries(CORE_RUNS)) {
    const names = BUILT_IN.filter((plugin) => plugin.concern === concern).map(({ name }) => name);
    assert.deepEqual(pin?.runs, names, `core runs every built-in of ${concern}, and only those`);
    assert.match(pin?.until ?? "", /^A11-\d+$/);
  }
});

test("every plugin of the catalog's built-ins and fakes declares the version its contract has in this release", () => {
  for (const plugin of [...BUILT_IN, ...FAKES]) assert.equal(plugin.contract, CONTRACT_VERSIONS[plugin.concern], plugin.name);
});
