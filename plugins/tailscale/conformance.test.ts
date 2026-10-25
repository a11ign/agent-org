// no-token: none -- `tailscale` is a stand-in that holds a serve config in memory; nothing reaches a daemon or a network
//
// THE EXPOSURE CONTRACT'S SUITE, RUN ON THE TAILSCALE PLUGIN (A11-162, Decision 11 of A11-157): `runExposureConformance` is the only definition of "an exposure", so Tailscale passes the same
// checks the fake does, in a sandbox: the stand-in serves into a map, so the checks that serve, read what is held and remove it all run.
import { test } from "node:test";
import assert from "node:assert/strict";
import { runExposureConformance } from "../../src/plugins/conformance/exposure.ts";
import { ContractError } from "../../src/plugins/conformance/suite.ts";
import { createExposure } from "./exposure.ts";
import { createTailscale, freshState } from "./stub.ts";

const SANDBOXED = ["serve takes a port, portState says it is ours, and unserve frees it", "unserve leaves an entry that is not the caller's (1.2)", 
  "one path of a port is served open to the internet on its own, and unserve removes it",
  "readiness, claim and served answer for the machine the exposure serves in"];

test("the Tailscale exposure passes the exposure contract suite, serving into a sandbox, and every check runs", async () => {
  const state = freshState();
  const { passed, skipped } = await runExposureConformance(createExposure({}, { exec: createTailscale(state), env: { USER: "agent" } }), { sandboxed: true });
  assert.deepEqual(skipped, []);
  assert.equal(passed.length, 9);
  for (const check of SANDBOXED) assert.ok(passed.includes(check), check);
  assert.deepEqual(state.web, {}, "the suite removed what it served");
  assert.deepEqual(state.funnel, {});
  assert.ok(state.calls.some((args) => args[0] === "funnel" && args.includes("--set-path=/hook")), "the path was served through a funnel command");
});

test("outside a sandbox the serving checks are skipped with their reason, and nothing is served", async () => {
  const state = freshState();
  const { skipped } = await runExposureConformance(createExposure({}, { exec: createTailscale(state), env: {} }));
  assert.deepEqual(skipped.map(({ check }) => check), SANDBOXED);
  assert.equal(state.calls.some((args) => args[0] === "serve" || args[0] === "funnel"), false, "no serve or funnel command ran");
});

test("a Tailscale that is stopped has no name, so the suite holds it to the loopback-only kind, which it is not, and fails it by name", async () => {
  const state = freshState({ backend: "Stopped" });
  await assert.rejects(runExposureConformance(createExposure({}, { exec: createTailscale(state), env: {} }), { sandboxed: true }), (error: unknown) => error instanceof ContractError && error.concern === "exposure"
    && error.failures.map(({ check }) => check).join("|") === ["ports names the two ports a named exposure serves on, and none for a loopback-only one", "a loopback-only exposure answers no hosts, origins or terminal", SANDBOXED[3]].join("|"));
});
