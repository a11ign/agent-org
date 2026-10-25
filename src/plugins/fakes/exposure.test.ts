// no-token: none -- the fake exposure serves into a map, and runs no tailscale
import { test } from "node:test";
import assert from "node:assert/strict";
import { runExposureConformance } from "../conformance/exposure.ts";
import { ContractError } from "../conformance/suite.ts";
import type { Exposure } from "../contracts/exposure.ts";
import { createFakeExposure } from "./exposure.ts";

const SANDBOXED_CHECKS = ["serve takes a port, portState says it is ours, and unserve frees it", "unserve leaves an entry that is not the caller's (1.2)", 
  "one path of a port is served open to the internet on its own, and unserve removes it",
  "readiness, claim and served answer for the machine the exposure serves in"];

test("the loopback-only fake passes the exposure contract suite, and refuses to serve a port", async () => {
  const { passed, skipped } = await runExposureConformance(createFakeExposure(), { sandboxed: true });
  assert.deepEqual(passed, ["shape", "machineName is the same name each time it is asked", "ports names the two ports a named exposure serves on, and none for a loopback-only one",
    "a loopback-only exposure answers no hosts, origins or terminal", "a named exposure answers hosts, https origins and a terminal address", ...SANDBOXED_CHECKS]);
  assert.deepEqual(skipped, []);
});

test("the named fake passes the suite, serves a port and a path, and frees both", async () => {
  const fake = createFakeExposure("board.example.ts.net");
  const { passed } = await runExposureConformance(fake, { sandboxed: true });
  assert.equal(passed.length, 9);
  assert.equal(fake.entries.size, 0, "the suite removed what it served");
  assert.deepEqual(fake.calls.filter((call) => call.startsWith("serve") || call.startsWith("unserve")),
    ["serve 9443", "unserve 9443", "serve 9443", "unserve 9443", "unserve 9443", "unserve 9443", "serve 9443/hook funnel", "unserve 9443/hook", "serve 9443", "unserve 9443"]);
});

test("serving is skipped with its reason unless the implementation has a sandbox", async () => {
  const fake = createFakeExposure("board.example.ts.net");
  const { skipped } = await runExposureConformance(fake);
  assert.deepEqual(skipped.map(({ check }) => check), SANDBOXED_CHECKS);
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

test("an exposure that names no ports, or the same port twice, fails the ports check by name", async () => {
  const fake = createFakeExposure("board.example.ts.net");
  for (const ports of [() => null, () => ({ ui: 9443, terminal: 9443 }), () => ({ ui: 0, terminal: 9444 })]) {
    await assert.rejects(runExposureConformance({ ...fake, ports }), (error: unknown) => error instanceof ContractError
      && error.failures.map(({ check }) => check).join() === "ports names the two ports a named exposure serves on, and none for a loopback-only one");
  }
  await assert.rejects(runExposureConformance({ ...createFakeExposure(), ports: () => ({ ui: 1, terminal: 2 }) }), ContractError, "a loopback-only exposure names no ports");
});

test("an exposure that does not serve a path open to the internet fails the path check by name", async () => {
  const fake = createFakeExposure("board.example.ts.net");
  const quiet: Exposure = { ...fake, serve: (port, local, options) => fake.serve(port, local, { ...options, funnel: false }) };
  await assert.rejects(runExposureConformance(quiet, { sandboxed: true }), (error: unknown) => error instanceof ContractError
    && error.failures.map(({ check }) => check).join() === "one path of a port is served open to the internet on its own, and unserve removes it");
});

test("a claim that refuses a port nothing holds fails by name", async () => {
  const fake = createFakeExposure("board.example.ts.net");
  const timid: Exposure = { ...fake, claim: () => "no" };
  await assert.rejects(runExposureConformance(timid, { sandboxed: true }), (error: unknown) => error instanceof ContractError
    && error.failures.map(({ check }) => check).join() === "readiness, claim and served answer for the machine the exposure serves in");
});

test("the fake's claim refuses a port open to the internet and a port another entry holds, and frees one the board holds", () => {
  const fake = createFakeExposure("board.example.ts.net");
  fake.serve(9443, 4748);
  assert.equal(fake.claim(9443, 4748, "ui"), null, "the board's own proxy is claimable");
  assert.match(String(fake.claim(9443, 4747, "ui")), /already serves http:\/\/127\.0\.0\.1:4748/);
  fake.serve(9444, 7318, { funnel: true, path: "/x" });
  assert.match(String(fake.claim(9444, 7318, "terminal")), /open to the internet/);
  assert.deepEqual(fake.served(), ["board.example.ts.net:9443", "board.example.ts.net:9444"]);
});
