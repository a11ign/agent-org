// no-token: none -- every check's reading is injected: no `node`, PATH, Keychain, service manager or port is asked
import { test } from "node:test";
import assert from "node:assert/strict";
import { diagnose, report, type DoctorDeps } from "./doctor.ts";

const HOST = JSON.stringify({ clones: { netbox: "/src/netbox" }, tickets: { port: 4800, uiPort: 4801, linearKey: { keychain: "agent-org-linear" } } });
const KEY = "lin_api_SECRETSECRETSECRET";

function deps(over: Partial<DoctorDeps> = {}): DoctorDeps {
  return {
    env: { AGENT_ORG_HOST: "/home/me/.agent-org/host.json" }, home: "/home/me",
    nodeVersion: () => "v24.7.0", which: (name) => `/home/me/.local/bin/${name}`,
    readFile: () => HOST, readKey: () => KEY, mode: () => 0o600, serviceState: () => "running", answers: async (port) => port === 4800 || port === 4801,
    ...over,
  };
}

const byName = (checks: Awaited<ReturnType<typeof diagnose>>) => Object.fromEntries(checks.map((check) => [check.name, check]));

test("doctor passes every check on a working install, and never prints the key", async () => {
  const checks = await diagnose(deps());
  assert.deepEqual(checks.map(({ name, ok }) => [name, ok]), [
    ["node", true], ["launcher", true], ["host file", true], ["herdr", true], ["tracker key", true],
    ["instance service", true], ["instance answering", true], ["ui service", true], ["ui answering", true],
  ]);
  assert.ok(!report(checks).includes(KEY));
  assert.match(report(checks), /ok {4}ui answering: http:\/\/127\.0\.0\.1:4801 answers/);
});

test("doctor reports a missing Node, and one older than 24, as failures with the fix", async () => {
  const missing = byName(await diagnose(deps({ nodeVersion: () => null })));
  assert.equal(missing.node.ok, false);
  assert.match(missing.node.fix ?? "", /install Node 24 or newer/);
  const old = byName(await diagnose(deps({ nodeVersion: () => "v22.11.0" })));
  assert.equal(old.node.ok, false);
  assert.equal(old.node.detail, "v22.11.0 is older than 24");
});

test("doctor names the fix for a missing launcher, herdr, host file, key and service", async () => {
  const checks = byName(await diagnose(deps({
    which: () => null, readFile: () => { throw new Error("ENOENT"); }, serviceState: () => "not-registered",
  })));
  assert.match(checks.launcher.fix ?? "", /export PATH="\$HOME\/\.local\/bin:\$PATH"/);
  assert.equal(checks.herdr.ok, false);
  assert.match(checks["host file"].fix ?? "", /agent-org onboard/);
  assert.equal(checks["tracker key"].ok, false);
  assert.equal(checks["instance service"].fix, "run `agent-org start instance`");
  assert.equal(checks["ui service"].fix, "run `agent-org start ui`");
  assert.equal(checks["instance answering"].ok, false);
});

test("doctor tells a key it cannot read, and a running service that does not answer", async () => {
  const checks = byName(await diagnose(deps({ readKey: () => { throw new Error("no key"); }, answers: async (port) => port !== 4800 })));
  assert.equal(checks["tracker key"].fix, "security add-generic-password -a \"$USER\" -s agent-org-linear -w");
  assert.equal(checks["instance service"].ok, true);
  assert.equal(checks["instance answering"].ok, false);
  assert.equal(checks["ui answering"].ok, true);
  assert.match(report(Object.values(checks)), /FAIL {2}instance answering: nothing answers on http:\/\/127\.0\.0\.1:4800\n {6}fix: read the service's log/);
});

test("doctor fails a key file other users can read, and names the chmod", async () => {
  const host = JSON.stringify({ clones: { netbox: "/src/netbox" }, tickets: { linearKey: { path: "/home/me/.agent-org/linear.key" } } });
  const checks = byName(await diagnose(deps({ readFile: () => host, mode: () => 0o644 })));
  assert.equal(checks["tracker key"].ok, false);
  assert.equal(checks["tracker key"].fix, "chmod 600 /home/me/.agent-org/linear.key");
});
