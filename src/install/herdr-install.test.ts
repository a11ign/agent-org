// no-token: none -- the manifest, the download, the writes and `herdr --version` are stubs; nothing reaches herdr.dev or GitHub, and no herdr runs
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { handInstallCommand, HERDR_MANIFEST_URL, herdrAsset, herdrInstallDir, HerdrInstallRefusal, installHerdr, TOOL_HERDR_VERSION, type HerdrInstallDeps } from "./herdr-install.ts";

const ROOT = join(import.meta.dirname, "..", "..");
const PINNED_URL = (asset: string) => `https://github.com/herdrdev/herdr/releases/download/v0.9.3/herdr-${asset}`;
const NEWEST_URL = (asset: string) => `https://github.com/herdrdev/herdr/releases/download/v0.9.5/herdr-${asset}`;
const BINARY = Buffer.from("the pinned herdr");
const NEWEST_BINARY = Buffer.from("the newest herdr");
const sha = (data: Buffer) => createHash("sha256").update(data).digest("hex");

/** herdr.dev's manifest as it has been shaped since 0.9.x: the top level is the newest version, and `releases` holds each version's own assets and checksums. */
function manifest(asset: string, over: { pinned?: object | null } = {}): string {
  const pinned = over.pinned === undefined ? { assets: { [asset]: PINNED_URL(asset) }, sha256: { [asset]: sha(BINARY) } } : over.pinned;
  return JSON.stringify({
    version: "0.9.5", assets: { [asset]: NEWEST_URL(asset) }, sha256: { [asset]: sha(NEWEST_BINARY) },
    releases: { "0.9.5": { assets: { [asset]: NEWEST_URL(asset) }, sha256: { [asset]: sha(NEWEST_BINARY) } }, ...(pinned === null ? {} : { "0.9.3": pinned }) },
  });
}

function setup(platform: NodeJS.Platform, arch: string, over: Partial<HerdrInstallDeps> & { manifestText?: string; printed?: string | null } = {}) {
  const asset = herdrAsset(platform, arch);
  const downloaded: string[] = [];
  const written: { path: string; data: Buffer }[] = [];
  const placed: [string, string][] = [];
  const removed: string[] = [];
  const bodies: Record<string, Buffer> = { [HERDR_MANIFEST_URL]: Buffer.from(over.manifestText ?? manifest(asset)), [PINNED_URL(asset)]: BINARY, [NEWEST_URL(asset)]: NEWEST_BINARY };
  const deps: HerdrInstallDeps = {
    home: "/h", env: {}, platform, arch,
    download: async (url) => { downloaded.push(url); const body = bodies[url]; if (body === undefined) throw new Error("answered 404"); return body; },
    writeExecutable: (path, data) => { written.push({ path, data }); },
    place: (from, to) => { placed.push([from, to]); },
    remove: (path) => { removed.push(path); },
    versionOf: () => (over.printed === undefined ? "herdr 0.9.3\n" : over.printed),
    ...over,
  };
  return { deps, downloaded, written, placed, removed };
}

test("A11-223: the pinned herdr is the one install.sh installs with, so one value is the same on every machine", () => {
  assert.equal(/^HERDR_VERSION=([\d.]+)$/m.exec(readFileSync(join(ROOT, "install.sh"), "utf8"))?.[1], TOOL_HERDR_VERSION);
  assert.equal(TOOL_HERDR_VERSION, "0.9.3", "the version the agents host runs (read 2026-10-24)");
});

test("A11-223: each supported machine takes its own herdr build, and any other is refused by name", () => {
  assert.deepEqual([herdrAsset("darwin", "arm64"), herdrAsset("darwin", "x64"), herdrAsset("linux", "x64"), herdrAsset("linux", "arm64")], ["macos-aarch64", "macos-x86_64", "linux-x86_64", "linux-aarch64"]);
  assert.throws(() => herdrAsset("win32", "x64"), (error: Error) => error instanceof HerdrInstallRefusal && /win32 on x64/.test(error.message));
  assert.throws(() => herdrAsset("linux", "ia32"), /linux on ia32/);
});

test("A11-223: herdr goes where herdr's own installer puts it: HERDR_INSTALL_DIR, else ~/.local/bin", () => {
  assert.equal(herdrInstallDir({}, "/h"), "/h/.local/bin");
  assert.equal(herdrInstallDir({ HERDR_INSTALL_DIR: "/opt/herdr" }, "/h"), "/opt/herdr");
});

test("A11-223: the install takes the pinned release's asset and checksum, never the newest at the manifest's top level", async () => {
  for (const [platform, arch, asset] of [["darwin", "arm64", "macos-aarch64"], ["linux", "x64", "linux-x86_64"]] as const) {
    const run = setup(platform, arch);
    assert.deepEqual(await installHerdr(run.deps), { path: "/h/.local/bin/herdr", version: "0.9.3" });
    assert.deepEqual(run.downloaded, [HERDR_MANIFEST_URL, PINNED_URL(asset)]);
    assert.ok(!run.downloaded.includes(NEWEST_URL(asset)), "the newest asset is never downloaded");
  }
});

test("A11-223: the binary is written executable beside herdr, checked to print the pinned version, and only then moved into place", async () => {
  const checked: string[] = [];
  const run = setup("linux", "x64", { versionOf: (path) => { checked.push(path); return "herdr 0.9.3"; } });
  await installHerdr(run.deps);
  assert.deepEqual(run.written, [{ path: "/h/.local/bin/herdr.download", data: BINARY }]);
  assert.deepEqual(checked, ["/h/.local/bin/herdr.download"]);
  assert.deepEqual(run.placed, [["/h/.local/bin/herdr.download", "/h/.local/bin/herdr"]]);
  assert.deepEqual(run.removed, []);
});

test("A11-223: HERDR_INSTALL_DIR moves where the binary is written and placed", async () => {
  const run = setup("linux", "x64", { env: { HERDR_INSTALL_DIR: "/opt/herdr" } });
  assert.equal((await installHerdr(run.deps)).path, "/opt/herdr/herdr");
  assert.deepEqual(run.placed, [["/opt/herdr/herdr.download", "/opt/herdr/herdr"]]);
});

test("A11-223: a checksum that does not match is refused, and nothing is written", async () => {
  const asset = "linux-x86_64";
  const run = setup("linux", "x64", { manifestText: manifest(asset, { pinned: { assets: { [asset]: PINNED_URL(asset) }, sha256: { [asset]: sha(NEWEST_BINARY) } } }) });
  await assert.rejects(installHerdr(run.deps), (error: Error) => error instanceof HerdrInstallRefusal && /does not match its published checksum/.test(error.message));
  assert.deepEqual([run.written, run.placed], [[], []]);
});

test("A11-223: a manifest with no entry for the pin is refused, and the newest version is not a fallback", async () => {
  const run = setup("linux", "x64", { manifestText: manifest("linux-x86_64", { pinned: null }) });
  await assert.rejects(installHerdr(run.deps), (error: Error) => error instanceof HerdrInstallRefusal && error.message.includes("lists no herdr 0.9.3"));
  assert.deepEqual(run.downloaded, [HERDR_MANIFEST_URL], "no binary is downloaded");
  assert.deepEqual([run.written, run.placed], [[], []]);
});

test("A11-223: a pinned release with no build for this machine is refused, naming the build", async () => {
  const run = setup("darwin", "arm64", { manifestText: manifest("macos-aarch64", { pinned: { assets: { "linux-x86_64": PINNED_URL("linux-x86_64") }, sha256: {} } }) });
  await assert.rejects(installHerdr(run.deps), /lists no macos-aarch64 build of herdr 0\.9\.3/);
});

test("A11-223: a manifest that is not JSON is refused", async () => {
  await assert.rejects(installHerdr(setup("linux", "x64", { manifestText: "<html>502</html>" }).deps), /is not JSON/);
});

test("A11-223: a manifest or a download that cannot be reached is refused with the address and why", async () => {
  const down = setup("linux", "x64", { download: async () => { throw new Error("getaddrinfo ENOTFOUND herdr.dev\nmore"); } });
  await assert.rejects(installHerdr(down.deps), (error: Error) => error instanceof HerdrInstallRefusal && error.message === `${HERDR_MANIFEST_URL} could not be read: getaddrinfo ENOTFOUND herdr.dev`);
  const missing = setup("linux", "x64", { manifestText: manifest("linux-x86_64", { pinned: { assets: { "linux-x86_64": "https://example.invalid/gone" }, sha256: { "linux-x86_64": sha(BINARY) } } }) });
  await assert.rejects(installHerdr(missing.deps), /https:\/\/example\.invalid\/gone could not be read: answered 404/);
});

test("A11-223: a binary that prints another version, or cannot run, is removed and never placed", async () => {
  const other = setup("linux", "x64", { printed: "herdr 0.9.5" });
  await assert.rejects(installHerdr(other.deps), (error: Error) => error instanceof HerdrInstallRefusal && error.message === 'the download prints "herdr 0.9.5", not herdr 0.9.3');
  assert.deepEqual([other.removed, other.placed], [["/h/.local/bin/herdr.download"], []]);
  const broken = setup("linux", "x64", { printed: null });
  await assert.rejects(installHerdr(broken.deps), /prints nothing, so it cannot run here/);
  assert.deepEqual([broken.removed, broken.placed], [["/h/.local/bin/herdr.download"], []]);
});

test("A11-223: the hand command downloads the pinned asset to a side file and moves it, for both platforms", () => {
  assert.equal(handInstallCommand("darwin", "arm64", {}),
    "mkdir -p ~/.local/bin && curl -fsSL https://github.com/herdrdev/herdr/releases/download/v0.9.3/herdr-macos-aarch64 -o ~/.local/bin/herdr.download && chmod +x ~/.local/bin/herdr.download && mv ~/.local/bin/herdr.download ~/.local/bin/herdr");
  assert.equal(handInstallCommand("linux", "x64", {}),
    "mkdir -p ~/.local/bin && curl -fsSL https://github.com/herdrdev/herdr/releases/download/v0.9.3/herdr-linux-x86_64 -o ~/.local/bin/herdr.download && chmod +x ~/.local/bin/herdr.download && mv ~/.local/bin/herdr.download ~/.local/bin/herdr");
});

test("A11-223: the hand command follows HERDR_INSTALL_DIR, quoted when it needs it, and on a platform with no build it is herdr's install page", () => {
  assert.match(handInstallCommand("linux", "x64", { HERDR_INSTALL_DIR: "/opt/herdr" }), /^mkdir -p \/opt\/herdr && .* -o \/opt\/herdr\/herdr\.download && .* && mv \/opt\/herdr\/herdr\.download \/opt\/herdr\/herdr$/);
  assert.match(handInstallCommand("linux", "x64", { HERDR_INSTALL_DIR: "/opt/my herdr" }), /mkdir -p '\/opt\/my herdr' && /);
  assert.equal(handInstallCommand("win32", "x64", {}), "see https://herdr.dev/docs/install/");
});
