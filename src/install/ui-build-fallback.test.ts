// @ts-check
// no-token: none -- the fetches go to a static server on 127.0.0.1 that this file starts (`fixtures/release-server.ts`); nothing reaches GitHub
// The board's UI build survives a version that has none (2026-10-26): the prune keeps the release the board falls back to, doctor --fix fetches a missing build, and the ui server heals itself.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "../lib/tmp-fixture.ts";
import { pruneVersions } from "./tool-install.ts";
import { fixUiBuild } from "./doctor.ts";
import { healBuildOf } from "../ticket-mode/ui-server.ts";
import { publishUiAsset, startReleaseServer } from "./fixtures/release-server.ts";
import type { UiSource } from "./ui-asset.ts";

/** A built UI as `astro build` leaves it, published as `tag`'s release asset on a local server: the stand-in for GitHub. */
async function released(tag: string): Promise<{ ui: UiSource; stop: () => void }> {
  const root = tmpDir("ui-fallback-releases-");
  const server = await startReleaseServer(join(root, "releases"));
  const dist = join(root, "dist");
  mkdirSync(dist);
  writeFileSync(join(dist, "index.html"), `<title>${tag} fetched</title>\n`);
  publishUiAsset(server.root, tag, dist);
  return { ui: { releases: () => server.url, exec: execFileSync }, stop: server.stop };
}

/** A source that has no release at all: every download is refused. */
const nothingReleased = async (): Promise<{ ui: UiSource; stop: () => void }> => {
  const server = await startReleaseServer(join(tmpDir("ui-fallback-empty-"), "releases"));
  return { ui: { releases: () => server.url, exec: execFileSync }, stop: server.stop };
};

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

/** v0.2.0 installed as current with its declared UI build missing, and a release source made by `source`: the test runs `body` against them and stops the server whatever happens. */
async function withMissingBuild(source: () => Promise<{ ui: UiSource; stop: () => void }>, body: (folder: string, ui: UiSource) => void): Promise<void> {
  const folder = join(tool(["v0.2.0"], [], "v0.2.0"), "versions", "v0.2.0");
  const { ui, stop } = await source();
  try {
    body(folder, ui);
  } finally {
    stop();
  }
}

const fetchedPage = (folder: string): string => readFileSync(join(folder, "ui-build", "index.html"), "utf8");

test("doctor --fix FETCHES a release's missing UI build: the build is in place afterwards, and the line says the fetch, not a failure", () => withMissingBuild(() => released("v0.2.0"), (folder, ui) => {
  const fixed = fixUiBuild(folder, ui);
  assert.equal(fixed.failed, false, fixed.line);
  assert.match(fixed.line, /^ui build: /);
  assert.doesNotMatch(fixed.line, /in place$/, "a fetch is said as a fetch");
  assert.equal(fetchedPage(folder), "<title>v0.2.0 fetched</title>\n");
  assert.deepEqual(fixUiBuild(folder, ui), { line: "ui build: the UI build of v0.2.0 is in place", failed: false }, "a second run finds it");
}));

test("doctor --fix: a missing build that cannot be fetched FAILS, says why, and leaves no half build", () => withMissingBuild(nothingReleased, (folder, ui) => {
  const fixed = fixUiBuild(folder, ui);
  assert.equal(fixed.failed, true);
  assert.match(fixed.line, /^ui build: the UI build of v0\.2\.0 could not be fetched: /);
  assert.equal(existsSync(join(folder, "ui-build")), false);
}));

test("the ui server's heal, when it runs, FETCHES the missing build and logs what it did", () => withMissingBuild(() => released("v0.2.0"), (folder, ui) => {
  const scheduled: (() => void)[] = [];
  const lines: string[] = [];
  healBuildOf(folder, { later: (work) => scheduled.push(work), log: (line) => lines.push(line), ui })();
  assert.equal(existsSync(join(folder, "ui-build")), false, "nothing is fetched inside the request");
  scheduled.forEach((work) => work());
  assert.equal(fetchedPage(folder), "<title>v0.2.0 fetched</title>\n");
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^ticket:ui: /);
  assert.doesNotMatch(lines[0], /could not|not fetched/);
}));
