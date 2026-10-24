// no-token: none -- a scratch host file and a stand-in for the outgoing plugin: no plugin module is imported and no program runs
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "../lib/tmp-fixture.ts";
import { baseOf } from "../ticket-mode/settings-edit.ts";
import type { PluginCliDeps } from "./cli.ts";
import { actionRequestOf, runAction } from "./page-actions.ts";
import { defaultCatalog } from "./registry.ts";

const BLOCKS = { tracker: { provider: "linear", enabled: true }, codeHost: { provider: "github", enabled: true }, exposure: { provider: "tailscale", port: 5000 } };
const STALE = "the file changed since you looked: read it again";

/** A scratch host file with `blocks`, the deps that act on it, and the `base` the page would send for it now. */
async function opened(providers: Record<string, unknown> = BLOCKS) {
  const dir = tmpDir("page-actions-");
  const hostPath = join(dir, "host.json");
  writeFileSync(hostPath, `${JSON.stringify({ clones: { "nbl-ui-netbox": "/r/netbox" }, stateDir: dir, tickets: { providers } }, null, 2)}\n`);
  const released: string[] = [];
  const deps: PluginCliDeps = { hostPath, catalog: defaultCatalog(), log: () => undefined, error: () => undefined,
    outgoing: async (plugin) => ({ machineName: null, release: () => { released.push(plugin.name); return { ok: true, detail: "" }; } }) };
  return { deps, hostPath, released, base: await baseOf({ hostPath }, "host.json"), providers: () => JSON.parse(readFileSync(hostPath, "utf8")).tickets.providers };
}
const request = (action: "install" | "enable" | "disable" | "uninstall", name: string, base: string, confirmed = false) => actionRequestOf({ action, name, base, confirmed });

test("A11-201: a change answers the file the save kept, which holds the file as it was", async () => {
  const { deps, hostPath, base } = await opened();
  const before = readFileSync(hostPath, "utf8");
  const done = await runAction(request("disable", "tailscale", base), deps);
  assert.equal(done.changed, true);
  assert.equal(done.backup, `${hostPath}.bak`);
  assert.equal(readFileSync(done.backup!, "utf8"), before);
});

test("A11-201: a request that changes nothing answers no backup, and writes nothing", async () => {
  const { deps, hostPath, base } = await opened();
  const done = await runAction(request("enable", "tailscale", base), deps);
  assert.deepEqual([done.changed, done.backup, done.inForce], [false, null, []]);
  assert.equal(existsSync(`${hostPath}.bak`), false);
});

test("A11-201: a base that is not the file's now is refused with the conflict sentence, and nothing is written or released", async () => {
  const { deps, hostPath, base, released } = await opened();
  const before = readFileSync(hostPath, "utf8");
  writeFileSync(hostPath, before.replace("5000", "5001"));
  await assert.rejects(runAction(request("disable", "tailscale", base), deps), { message: STALE });
  assert.equal(readFileSync(hostPath, "utf8"), before.replace("5000", "5001"));
  assert.equal(existsSync(`${hostPath}.bak`), false);
  assert.deepEqual(released, []);
});

test("A11-201: an uninstall that is not confirmed is refused and writes nothing, and confirmed it removes the block", async () => {
  const { deps, providers, base, released } = await opened();
  await assert.rejects(runAction(request("uninstall", "tailscale", base), deps), { message: "uninstall tailscale needs the person's confirmation first: ask again with it" });
  assert.deepEqual(providers().exposure, BLOCKS.exposure);
  assert.deepEqual(released, []);
  const done = await runAction(request("uninstall", "tailscale", base, true), deps);
  assert.equal(done.changed, true);
  assert.equal(providers().exposure, undefined);
});

test("A11-201: an install that replaces another plugin is refused unconfirmed, and confirmed it switches the concern's plugin", async () => {
  const { deps, providers, base } = await opened();
  await assert.rejects(runAction(request("install", "local", base), deps), { message: "install local needs the person's confirmation first: ask again with it" });
  assert.equal(providers().exposure.provider, "tailscale");
  const done = await runAction(request("install", "local", base, true), deps);
  assert.equal(done.changed, true);
  assert.equal(providers().exposure.provider, "local");
});

test("A11-201: an install that replaces nothing, and an enable and a disable, need no confirmation", async () => {
  const { deps, providers, base } = await opened();
  const off = await runAction(request("disable", "tailscale", base), deps);
  assert.equal(off.changed, true);
  assert.equal(providers().exposure.enabled, false);
  const fresh = await opened({ tracker: BLOCKS.tracker, codeHost: BLOCKS.codeHost });
  const done = await runAction(request("install", "tailscale", fresh.base), fresh.deps);
  assert.equal(done.changed, true);
  assert.equal(fresh.providers().exposure.provider, "tailscale");
});
