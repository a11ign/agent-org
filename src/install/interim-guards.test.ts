// no-token: none -- the files, the systemd calls and the replacement checks are stand-ins; nothing is removed from disk
import { test } from "node:test";
import assert from "node:assert/strict";
import { guardPaths, retireGuards, type GuardDeps, type Replacements } from "./interim-guards.ts";
import type { RunResult } from "./service.ts";

const HOME = "/home/me";
const { watchdog, dropIn, readCacheDropIn } = guardPaths({}, HOME);
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

const PROVEN: Replacements = { ghWrapperDeclared: true, herdrInOwnUnit: true };

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
  assert.match(lines[1], /^retired the KillMode drop-in: herdr has a service of its own/);
});

test("a watchdog whose wrapper is not the one host.json declares is kept, and said with what it waits for", async () => {
  const { deps, removed } = machine([...watchdog], { ...PROVEN, ghWrapperDeclared: false });
  const lines = await retireGuards(deps);
  assert.deepEqual(removed, []);
  assert.equal(lines[0], "kept the gh-wrapper watchdog: the installed gh wrapper is not the one host.json declares, so its check is not proven. Run `agent-org host:install`, then run onboard again");
});

test("a drop-in while the herdr server does not run in its own service is kept, and the fix is named", async () => {
  const { deps, removed, ran } = machine([dropIn], { ...PROVEN, herdrInOwnUnit: false });
  const lines = await retireGuards(deps);
  assert.deepEqual(removed, []);
  assert.deepEqual(ran, [], "systemd is not asked, since nothing changed");
  assert.match(lines[0], /^kept the KillMode drop-in: the herdr server does not run in agent-org-herdr.service yet. Run `agent-org start herdr --move`/);
});

test("A11-172: the read-cache drop-in is removed, systemd reloads and the line says why, with no replacement to read: the claim's own read is in the code that runs this", async () => {
  const { deps, removed, ran, asked } = machine([readCacheDropIn], { ghWrapperDeclared: false, herdrInOwnUnit: false });
  const lines = await retireGuards(deps);
  assert.deepEqual(removed, [readCacheDropIn]);
  assert.deepEqual(ran, ["systemctl --user daemon-reload"]);
  assert.equal(asked(), 0, "no proof is read for it, and none of the other guards waits on it");
  assert.deepEqual(lines, ["retired the read-cache drop-in: the review claim reads past the gh read cache (A11-172). The instance picks the change up at its next restart"]);
});

test("A11-172: the read-cache drop-in is retired beside the other guards, each by its own rule, and a host without it changes nothing for them", async () => {
  const both = machine([dropIn, readCacheDropIn], { ghWrapperDeclared: true, herdrInOwnUnit: false });
  const lines = await retireGuards(both.deps);
  assert.deepEqual(both.removed, [readCacheDropIn], "the KillMode drop-in waits for herdr's unit, the read-cache one does not");
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^kept the KillMode drop-in/);
  assert.match(lines[1], /^retired the read-cache drop-in/);
  const without = machine([dropIn, ...watchdog], PROVEN);
  const withoutLines = await retireGuards(without.deps);
  assert.deepEqual(without.removed, [...watchdog, dropIn], "a host without the read-cache drop-in retires the others as it did");
  assert.equal(withoutLines.some((line) => line.includes("read-cache")), false, "and says nothing of it");
});
