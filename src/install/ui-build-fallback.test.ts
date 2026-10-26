// @ts-check
// The board's UI build survives a version that has none (2026-10-26): the prune keeps the release the board falls back to, doctor --fix fetches a missing build, and the ui server heals itself.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "../lib/tmp-fixture.ts";
import { pruneVersions } from "./tool-install.ts";
import { fixUiBuild } from "./doctor.ts";
import { healBuildOf } from "../ticket-mode/ui-server.ts";

/** A tool directory whose `versions/` holds `names`, each declaring a UI build, those in `built` holding one, with `current` naming `current`. */
function tool(names: readonly string[], built: readonly string[], current: string): string {
  const dir = tmpDir("ui-fallback-");
  for (const name of names) {
    const folder = join(dir, "versions", name);
    mkdirSync(join(folder, "src"), { recursive: true });
    writeFileSync(join(folder, "src", "bin.ts"), "");
    writeFileSync(join(folder, "package.json"), `${JSON.stringify({ name: "agent-org", agentOrg: { shipsUiBuild: true } })}\n`);
    if (built.includes(name)) {
      mkdirSync(join(folder, "ui-build"));
      writeFileSync(join(folder, "ui-build", "index.html"), `<title>${name}</title>\n`);
    }
  }
  symlinkSync(join("versions", current), join(dir, "current"), "dir");
  return dir;
}

test("the prune keeps the newest older release that holds a UI build, which the board serves while current has none", () => {
  const dir = tool(["v0.1.0", "v0.2.0", "v0.3.0"], ["v0.1.0", "v0.2.0"], "v0.3.0");
  const removed = pruneVersions({ tool: dir, inUse: [], self: join(dir, "elsewhere") });
  assert.deepEqual(removed, ["v0.1.0"]);
  assert.deepEqual(readdirSync(join(dir, "versions")).toSorted(), ["v0.2.0", "v0.3.0"]);
});

test("the fallback is the newest older release WITH a build: an older one that has none is no fallback", () => {
  const dir = tool(["v0.1.0", "v0.2.0", "v0.3.0"], ["v0.1.0"], "v0.3.0");
  assert.deepEqual(pruneVersions({ tool: dir, inUse: [], self: join(dir, "elsewhere") }), ["v0.2.0"]);
  assert.deepEqual(readdirSync(join(dir, "versions")).toSorted(), ["v0.1.0", "v0.3.0"]);
});

test("POSITIVE CONTROL: with current holding its own build, an older release is still kept as the fallback only if it is the newest older one with a build", () => {
  const dir = tool(["v0.1.0", "v0.2.0", "v0.3.0"], ["v0.1.0", "v0.2.0", "v0.3.0"], "v0.3.0");
  assert.deepEqual(pruneVersions({ tool: dir, inUse: [], self: join(dir, "elsewhere") }), ["v0.1.0"]);
});

test("doctor --fix: a release whose build is in place says so and fetches nothing; a folder that is not a release has nothing to fetch", () => {
  const dir = tool(["v0.2.0"], ["v0.2.0"], "v0.2.0");
  assert.deepEqual(fixUiBuild(join(dir, "versions", "v0.2.0")), { line: "ui build: the UI build of v0.2.0 is in place", failed: false });
  assert.deepEqual(fixUiBuild(tmpDir("not-a-release-")), { line: "ui build: not a release folder, so there is no build to fetch", failed: false });
});

test("the ui server's heal runs after the request, at most once a minute, and does nothing outside a release folder", () => {
  const dir = tool(["v0.2.0"], [], "v0.2.0");
  let clock = 0;
  const scheduled: (() => void)[] = [];
  const heal = healBuildOf(join(dir, "versions", "v0.2.0"), { now: () => clock, later: (work) => scheduled.push(work), log: () => undefined });
  heal();
  heal();
  assert.equal(scheduled.length, 1, "a second Updating answer within the minute schedules nothing");
  clock = 60_000;
  heal();
  assert.equal(scheduled.length, 2, "a minute later it tries again");
  const none: (() => void)[] = [];
  healBuildOf(tmpDir("not-a-release-"), { later: (work) => none.push(work) })();
  assert.equal(none.length, 0);
});
