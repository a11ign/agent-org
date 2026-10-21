// no-token: none -- the files, the systemd calls and the replacement checks are stand-ins; nothing is removed from disk
import { test } from "node:test";
import assert from "node:assert/strict";
import { guardPaths, retireGuards, type GuardDeps, type Replacements } from "./interim-guards.ts";
import type { RunResult } from "./service.ts";

const HOME = "/home/me";
const { watchdog, dropIn } = guardPaths({}, HOME);
const OK: RunResult = { status: 0, stdout: "", stderr: "" };

/** A machine whose files are `present`, with each replacement answered by `proof`; every removal and every systemctl call is recorded. */
function machine(present: string[], proof: Replacements, platform: NodeJS.Platform = "linux") {
  const removed: string[] = [];
  const ran: string[] = [];
  let asked = 0;
  const deps: GuardDeps = {
    platform, env: {}, home: HOME,
    exists: (path) => present.includes(path),
    remove: (path) => { removed.push(path); },
    run: (file, args) => { ran.push([file, ...args].join(" ")); return OK; },
    replacements: async () => { asked += 1; return proof; },
  };
  return { deps, removed, ran, asked: () => asked };
}

const PROVEN: Replacements = { ghWrapperDeclared: true, herdrOutsideInstance: true };

test("a host with neither guard, or a platform with no systemd user units, changes nothing and reads no replacement", async () => {
  const none = machine([], PROVEN);
  assert.deepEqual(await retireGuards(none.deps), []);
  assert.equal(none.asked(), 0);
  const mac = machine([...watchdog, dropIn], PROVEN, "darwin");
  assert.deepEqual(await retireGuards(mac.deps), []);
  assert.deepEqual(mac.removed, []);
});

test("with both replacements proven, the watchdog is disabled and its three files removed, and the drop-in is removed; systemd reloads", async () => {
  const { deps, removed, ran } = machine([...watchdog, dropIn], PROVEN);
  const lines = await retireGuards(deps);
  assert.deepEqual(removed, [...watchdog, dropIn]);
  assert.deepEqual(ran, [
    "systemctl --user disable --now gh-wrapper-watchdog.timer",
    "systemctl --user daemon-reload",
    "systemctl --user daemon-reload",
  ]);
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^retired the gh-wrapper watchdog: the start-time wrapper check holds/);
  assert.match(lines[1], /^retired the KillMode drop-in: herdr's own scope holds/);
});

test("a watchdog whose wrapper is not the one host.json declares is kept, and said with what it waits for", async () => {
  const { deps, removed } = machine([...watchdog], { ...PROVEN, ghWrapperDeclared: false });
  const lines = await retireGuards(deps);
  assert.deepEqual(removed, []);
  assert.equal(lines[0], "kept the gh-wrapper watchdog: the installed gh wrapper is not the one host.json declares, so its check is not proven. Run `agent-org host:install`, then run onboard again");
});

test("a drop-in while a herdr server is still inside the instance's cgroup is kept, and the fix is named", async () => {
  const { deps, removed, ran } = machine([dropIn], { ...PROVEN, herdrOutsideInstance: false });
  const lines = await retireGuards(deps);
  assert.deepEqual(removed, []);
  assert.deepEqual(ran, [], "systemd is not asked, since nothing changed");
  assert.match(lines[0], /^kept the KillMode drop-in: a herdr server is still inside the instance's cgroup. Restart herdr when no run is working/);
});
