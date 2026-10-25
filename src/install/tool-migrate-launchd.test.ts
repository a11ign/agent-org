// no-token: none -- `launchctl` is a stand-in that models which labels are loaded, and every plist is a string in a map; no file of the machine is read or written
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { COMMANDS } from "../commands.ts";
import { tmpDir } from "../lib/tmp-fixture.ts";
import { unitFor, type RunResult, type ServiceDeps, type ServiceName } from "./service.ts";
import { migrateInstall } from "./tool-migrate.ts";

// A11-266: a launchd job keeps the plist it was loaded with, so a plist the migration rewrites reaches the job only when the job is loaded again.
const done = (stdout = ""): RunResult => ({ status: 0, stdout, stderr: "" });
const absent: RunResult = { status: 113, stdout: "", stderr: "Could not find service" };
const OLD_CHECKOUT = "/old/checkout";
const label = (name: ServiceName) => `io.github.agent-org.${name}`;

/** A Mac whose plists name an old checkout, with `loaded` of them in the `gui/501` domain. `migrate` runs the migration to `<tool>/current` as the job `runningAs` (XPC_SERVICE_NAME), if any. */
function oldMac(loaded: readonly ServiceName[], names: readonly ServiceName[] = ["instance", "ui", "auto-update"], { exited = [], refuses = [] }: { exited?: readonly ServiceName[]; refuses?: readonly ServiceName[] } = {}) {
  const home = tmpDir("tool-migrate-launchd-");
  const tool = join(home, ".agent-org", "tool");
  const files = new Map<string, string>([["/opt/bin/herdr", ""], [join(home, ".agent-org", "host.json"), "{}"]]);
  const calls: string[] = [];
  const inDomain = new Set(loaded.map(label));
  const launchctl = (args: string[]): RunResult => {
    const id = args[1]?.split("/")[2] ?? "";
    switch (args[0]) {
      case "print": return inDomain.has(id) ? done(exited.some((name) => label(name) === id) ? "state = not running\n" : "state = running\n") : absent;
      case "bootout": return inDomain.delete(id) ? done() : absent;
      case "bootstrap": {
        if (refuses.some((name) => args[2]?.endsWith(`${label(name)}.plist`))) return { status: 5, stdout: "", stderr: "Bootstrap failed: 5: Input/output error\n" };
        const loadedLabel = [...files].find(([path]) => path === args[2])?.[0] ?? "";
        inDomain.add(/(io\.github\.agent-org\.[a-z-]+)\.plist$/.exec(loadedLabel)?.[1] ?? "");
        return done();
      }
      default: return done();
    }
  };
  const services: ServiceDeps = {
    platform: "darwin", env: { PATH: "/opt/bin:/usr/bin" }, home, uid: 501, node: "/opt/node/bin/node", toolRoot: OLD_CHECKOUT, commands: COMMANDS, user: "alice",
    exists: (path) => files.has(path), read: (path) => files.get(path) ?? null, write: (path, text) => { files.set(path, text); },
    run: (file, args) => { calls.push([file, ...args].join(" ")); return file === "launchctl" ? launchctl(args) : done(); },
    pause: () => undefined,
  };
  for (const name of names) {
    const unit = unitFor(name, services);
    files.set(unit.path, unit.text);
  }
  const warnings: string[] = [];
  const migrate = (runningAs?: ServiceName) => migrateInstall({
    oldRoot: OLD_CHECKOUT, tool, home, env: runningAs === undefined ? {} : { XPC_SERVICE_NAME: label(runningAs) }, services,
    hostPath: join(home, ".agent-org", "host.json"), binDir: join(home, ".local", "bin"), warn: (line) => { warnings.push(line); },
  });
  const plistOf = (name: ServiceName) => files.get(unitFor(name, services).path) ?? "";
  const pathOf = (name: ServiceName) => unitFor(name, services).path;
  return { migrate, calls, warnings, inDomain, plistOf, pathOf, tool };
}

const launchctlCalls = (calls: readonly string[]) => calls.filter((call) => call.startsWith("launchctl") && !call.startsWith("launchctl print"));

test("A11-266: a loaded job whose plist the migration rewrites is booted out and bootstrapped, so it runs through current", () => {
  const mac = oldMac(["instance", "ui", "auto-update"]);
  const lines = mac.migrate();
  assert.match(mac.plistOf("auto-update"), new RegExp(`${mac.tool}/current`), "the plist on disk names current");
  assert.deepEqual(launchctlCalls(mac.calls).filter((call) => call.includes("auto-update")), [
    `launchctl bootout gui/501/${label("auto-update")}`,
    `launchctl bootstrap gui/501 ${mac.pathOf("auto-update")}`,
  ]);
  assert.deepEqual([...mac.inDomain].toSorted(), [label("auto-update"), label("instance"), label("ui")], "all three are loaded again");
  assert.deepEqual(lines.filter((line) => line.startsWith("loaded")), ["instance", "ui", "auto-update"].map((name) => `loaded ${label(name as ServiceName)} again from its new plist`));
  assert.deepEqual(mac.warnings, []);
});

test("A11-266: the auto-update job that is running this update is not booted out, and the update says so on stderr", () => {
  const mac = oldMac(["instance", "ui", "auto-update"]);
  mac.migrate("auto-update");
  assert.equal(launchctlCalls(mac.calls).some((call) => call.includes(label("auto-update"))), false, "no launchctl command names the job running the update");
  assert.equal(mac.inDomain.has(label("auto-update")), true, "and it is still loaded");
  assert.equal(mac.warnings.length, 1);
  assert.match(mac.warnings[0] ?? "", /^agent-org update: io\.github\.agent-org\.auto-update is the job running this update, so it was not loaded again and still runs the code it was loaded with\. Run `agent-org start auto-update`/);
  assert.ok(launchctlCalls(mac.calls).some((call) => call === `launchctl bootout gui/501/${label("instance")}`), "the other jobs are still loaded again");
});

test("A11-266: a job that is not loaded is left for `agent-org start`, and herdr is never booted out", () => {
  const mac = oldMac(["instance"], ["instance", "ui", "herdr"]);
  mac.calls.length = 0;
  mac.migrate();
  assert.deepEqual(launchctlCalls(mac.calls).map((call) => call.split(" ").slice(0, 3).join(" ")), [`launchctl bootout gui/501/${label("instance")}`, "launchctl bootstrap gui/501"]);
  assert.equal(mac.inDomain.has(label("ui")), false, "ui was not loaded and is not now");
  const herdr = oldMac(["herdr"], ["herdr"]);
  herdr.migrate();
  assert.deepEqual(launchctlCalls(herdr.calls), [], "a loaded herdr keeps its panes");
});

test("A11-266: a second migration finds every plist current and loads nothing again", () => {
  const mac = oldMac(["instance", "ui", "auto-update"]);
  mac.migrate();
  mac.calls.length = 0;
  assert.deepEqual(mac.migrate(), []);
  assert.deepEqual(mac.calls, []);
});

test("A11-266: a job launchd will not load again is said and the others still are, so the update is not left half done", () => {
  const mac = oldMac(["instance", "ui", "auto-update"], undefined, { refuses: ["instance"] });
  const lines = mac.migrate();
  assert.equal(mac.warnings.length, 1);
  assert.match(mac.warnings[0] ?? "", /^agent-org update: io\.github\.agent-org\.instance was not loaded again: the instance service \(io\.github\.agent-org\.instance\) did not load: launchctl bootstrap gui\/501 .* failed: Bootstrap failed: 5: Input\/output error\. To fix it by hand, run: launchctl bootout gui\/501\/io\.github\.agent-org\.instance; launchctl bootstrap/);
  assert.deepEqual(lines.filter((line) => line.startsWith("loaded")), [`loaded ${label("ui")} again from its new plist`, `loaded ${label("auto-update")} again from its new plist`]);
});

test("A11-266: a daemon that is loaded but has exited is not started by the migration", () => {
  const mac = oldMac(["ui"], undefined, { exited: ["ui"] });
  mac.calls.length = 0;
  mac.migrate();
  assert.deepEqual(launchctlCalls(mac.calls), []);
});
