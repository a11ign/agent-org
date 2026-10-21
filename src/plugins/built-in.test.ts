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
    linear: ["key", "connectors", "workingState", "plannedState", "takenStates"], github: ["identity", "gh", "stack"], slack: ["run", "model", "effort", "connectors"], atomic: [],
    local: ["port", "uiPort", "terminal", "tailnetPorts"], tailscale: ["port", "uiPort", "terminal", "tailnetPorts"], telegram: [],
  });
});

test("every concern has a contract version, a fake and a pin, except messaging, which has no block to pin", () => {
  assert.deepEqual(CONCERNS.map((concern) => CONTRACT_VERSIONS[concern]), ["1.0", "1.0", "1.0", "1.0", "1.0", "1.0"]);
  assert.deepEqual(FAKES.map(({ concern }) => concern), [...CONCERNS]);
  assert.deepEqual(Object.keys(CORE_RUNS), CONCERNS.filter((concern) => blockOf(concern) !== null));
  for (const [concern, pin] of Object.entries(CORE_RUNS)) {
    const names = BUILT_IN.filter((plugin) => plugin.concern === concern).map(({ name }) => name);
    assert.deepEqual(pin?.runs, names, `core runs every built-in of ${concern}, and only those`);
    assert.match(pin?.until ?? "", /^A11-\d+$/);
  }
});

test("every plugin of the catalog's built-ins and fakes declares the version its contract has in this release", () => {
  for (const plugin of [...BUILT_IN, ...FAKES]) assert.equal(plugin.contract, CONTRACT_VERSIONS[plugin.concern], plugin.name);
});
