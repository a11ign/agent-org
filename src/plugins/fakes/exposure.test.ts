// no-token: none -- the fake exposure serves into a map, and runs no tailscale
import { test } from "node:test";
import assert from "node:assert/strict";
import { runExposureConformance } from "../conformance/exposure.ts";
import { ContractError } from "../conformance/suite.ts";
import type { Exposure } from "../contracts/exposure.ts";
import { createFakeExposure } from "./exposure.ts";

test("the loopback-only fake passes the exposure contract suite, and refuses to serve a port", async () => {
  const { passed, skipped } = await runExposureConformance(createFakeExposure(), { sandboxed: true });
  assert.deepEqual(passed, ["shape", "machineName is the same name each time it is asked", "a loopback-only exposure answers no hosts, origins or terminal",
    "a named exposure answers hosts, https origins and a terminal address", "serve takes a port, portState says it is ours, and unserve frees it"]);
  assert.deepEqual(skipped, []);
});

test("the named fake passes the suite, serves a port, and frees it", async () => {
  const fake = createFakeExposure("board.example.ts.net");
  const { passed } = await runExposureConformance(fake, { sandboxed: true });
  assert.equal(passed.length, 5);
  assert.equal(fake.served.size, 0, "the suite removed what it served");
  assert.deepEqual(fake.calls.filter((call) => call.startsWith("serve") || call.startsWith("unserve")), ["serve 9443", "unserve 9443"]);
});

test("serving is skipped with its reason unless the implementation has a sandbox", async () => {
  const fake = createFakeExposure("board.example.ts.net");
  const { skipped } = await runExposureConformance(fake);
  assert.deepEqual(skipped.map(({ check }) => check), ["serve takes a port, portState says it is ours, and unserve frees it"]);
  assert.match(skipped[0].reason, /sandbox/);
  assert.deepEqual(fake.calls.filter((call) => call.startsWith("serve")), [], "nothing was served");
});

test("an exposure with no name that still answers origins fails by name", async () => {
  const fake = createFakeExposure();
  const leaking: Exposure = { ...fake, origins: () => ["https://elsewhere.example"] };
  await assert.rejects(runExposureConformance(leaking), (error: unknown) => error instanceof ContractError && error.concern === "exposure"
    && error.failures.map(({ check }) => check).join() === "a loopback-only exposure answers no hosts, origins or terminal");
});

test("an exposure whose origins are not https fails by name", async () => {
  const fake = createFakeExposure("board.example.ts.net");
  const plain: Exposure = { ...fake, origins: ({ name }) => [`http://${name}`] };
  await assert.rejects(runExposureConformance(plain), (error: unknown) => error instanceof ContractError
    && error.failures.map(({ check }) => check).join() === "a named exposure answers hosts, https origins and a terminal address");
});
