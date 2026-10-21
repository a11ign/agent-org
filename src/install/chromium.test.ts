// no-token: none -- the probe is injected, and the default probe reads only a temporary folder laid out as Playwright lays its browsers
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "../lib/tmp-fixture.ts";
import { BUILDS, browserRevisions, browsersPath, buildStarts, checkBuilds, chromiumProblems, defaultChromiumProbe, INSTALL_BROWSERS, INSTALL_DEPS, lacksLibraries, missingLibraries, PLAYWRIGHT_CLI, type BuildReport } from "./chromium.ts";

const BROWSERS_JSON = JSON.stringify({ browsers: [
  { name: "chromium", revision: "1243", installByDefault: true },
  { name: "chromium-headless-shell", revision: "1243", installByDefault: true },
  { name: "firefox", revision: "1520" },
] });

const LDD_MISSING = [
  "\tlinux-vdso.so.1 (0x00007ffd)",
  "\tlibatk-1.0.so.0 => not found",
  "\tlibc.so.6 => /lib/x86_64-linux-gnu/libc.so.6 (0x00007f)",
  "\tlibcups.so.2 => not found",
  "",
].join("\n");

const READY: BuildReport[] = [
  { build: "chromium", binary: "/cache/chromium-1243/chrome", missing: [] },
  { build: "chromium-headless-shell", binary: "/cache/shell/chrome-headless-shell", missing: [] },
];

test("the libraries ldd says are missing are named, and the libraries it finds are not", () => {
  assert.deepEqual(missingLibraries(LDD_MISSING), ["libatk-1.0.so.0", "libcups.so.2"]);
  assert.deepEqual(missingLibraries("\tlibc.so.6 => /lib/libc.so.6 (0x1)\n"), []);
});

test("a build starts when its binary is here and it lacks no library", () => {
  assert.equal(buildStarts(READY[0]), true);
  assert.equal(buildStarts({ build: "chromium", binary: null, missing: [] }), false, "no binary");
  assert.equal(buildStarts({ build: "chromium", binary: "/b", missing: ["libcups.so.2"] }), false, "a missing library");
});

test("the machine is short of libraries only when a build names one", () => {
  assert.equal(lacksLibraries({ builds: READY, unchecked: null }), false);
  assert.equal(lacksLibraries({ builds: [READY[0], { build: "chromium-headless-shell", binary: "/s", missing: ["libasound.so.2"] }], unchecked: null }), true);
  assert.equal(lacksLibraries({ builds: [{ build: "chromium", binary: null, missing: [] }], unchecked: null }), false, "a missing binary is not a library");
});

test("the problems name each build, and the command that fixes it: the browser install for a missing binary, the library install for a missing library", () => {
  assert.deepEqual(chromiumProblems({ builds: READY, unchecked: null }), []);
  const missingBinary = chromiumProblems({ builds: [{ build: "chromium", binary: null, missing: [] }, READY[1]], unchecked: null });
  assert.deepEqual(missingBinary, [`chromium is not installed: run \`${INSTALL_BROWSERS}\``]);
  const missingLibrary = chromiumProblems({ builds: [READY[0], { build: "chromium-headless-shell", binary: "/s", missing: ["libatk-1.0.so.0"] }], unchecked: null });
  assert.deepEqual(missingLibrary, [`chromium headless shell lacks libatk-1.0.so.0: run \`${INSTALL_DEPS}\``]);
  assert.match(INSTALL_DEPS, /^sudo node .*install-deps chromium$/, "the library install is the one that needs root, and it is named as such");
  assert.doesNotMatch(INSTALL_BROWSERS, /sudo/);
});

test("a check that cannot run says so, with the fix", () => {
  assert.deepEqual(chromiumProblems({ builds: [], unchecked: "playwright-core is not installed in this checkout" }), [
    "Chromium cannot be checked: playwright-core is not installed in this checkout. Run agent-org update, which installs this checkout's dependencies.",
  ]);
});

test("a library check that cannot run is unchecked, never a pass: ldd missing on Linux, or a damaged browsers file", () => {
  const noLdd = checkBuilds({
    binary: () => "/cache/chromium-1243/chrome",
    ldd: () => { throw new Error("spawnSync ldd ENOENT"); },
    browsersJson: () => BROWSERS_JSON,
  });
  assert.deepEqual(noLdd.builds, []);
  assert.match(noLdd.unchecked ?? "", /the check could not finish: spawnSync ldd ENOENT/);
  assert.equal(lacksLibraries(noLdd), false);
  assert.match(chromiumProblems(noLdd)[0], /cannot be checked/, "doctor fails the check rather than passing it");
  const damaged = checkBuilds({ binary: () => "/b", ldd: () => "", browsersJson: () => "{ not json" });
  assert.match(damaged.unchecked ?? "", /could not finish/);
});

test("browsers.json gives each build's revision, and nothing else", () => {
  assert.deepEqual(browserRevisions(BROWSERS_JSON), { "chromium": "1243", "chromium-headless-shell": "1243" });
});

test("Playwright's browser folder is the one it names, else its default for the platform", () => {
  assert.equal(browsersPath({ PLAYWRIGHT_BROWSERS_PATH: "/opt/pw" }, "/home/me", "linux"), "/opt/pw");
  assert.equal(browsersPath({ PLAYWRIGHT_BROWSERS_PATH: "0" }, "/home/me", "linux"), "/home/me/.cache/ms-playwright", "0 means the default, as Playwright reads it");
  assert.equal(browsersPath({}, "/home/me", "linux"), "/home/me/.cache/ms-playwright");
  assert.equal(browsersPath({}, "/Users/me", "darwin"), "/Users/me/Library/Caches/ms-playwright");
});

test("each build is checked by name, a missing binary is reported, and the libraries come from ldd", () => {
  const probe = {
    binary: (build: string, revision: string) => (build === "chromium" ? `/cache/${build}-${revision}/chrome` : null),
    ldd: (binary: string) => (binary.includes("chromium-1243") ? LDD_MISSING : ""),
    browsersJson: () => BROWSERS_JSON,
  };
  const report = checkBuilds(probe);
  assert.equal(report.unchecked, null);
  assert.deepEqual(report.builds.map((build) => build.build), [...BUILDS]);
  assert.deepEqual(report.builds[0], { build: "chromium", binary: "/cache/chromium-1243/chrome", missing: ["libatk-1.0.so.0", "libcups.so.2"] });
  assert.deepEqual(report.builds[1], { build: "chromium-headless-shell", binary: null, missing: [] });
});

test("without playwright-core in the checkout, nothing is probed and the report says why", () => {
  const report = checkBuilds({ binary: () => "/never", ldd: () => "", browsersJson: () => null });
  assert.deepEqual(report, { builds: [], unchecked: "playwright-core is not installed in this checkout" });
});

test("the default probe finds each build's binary in Playwright's folder for the revision, and none for a revision that is not there", () => {
  const root = tmpDir("chromium-probe-");
  mkdirSync(join(root, "chromium-1243", "chrome-linux64"), { recursive: true });
  writeFileSync(join(root, "chromium-1243", "chrome-linux64", "chrome"), "");
  mkdirSync(join(root, "chromium_headless_shell-1243", "chrome-headless-shell-linux64"), { recursive: true });
  writeFileSync(join(root, "chromium_headless_shell-1243", "chrome-headless-shell-linux64", "chrome-headless-shell"), "");
  const probe = defaultChromiumProbe({ PLAYWRIGHT_BROWSERS_PATH: root }, "/home/me", "linux");
  assert.equal(probe.binary("chromium", "1243"), join(root, "chromium-1243", "chrome-linux64", "chrome"));
  assert.equal(probe.binary("chromium-headless-shell", "1243"), join(root, "chromium_headless_shell-1243", "chrome-headless-shell-linux64", "chrome-headless-shell"));
  assert.equal(probe.binary("chromium", "1000"), null);
});

test("the Playwright CLI the commands run is the one in this checkout's dependencies", () => {
  assert.match(PLAYWRIGHT_CLI, /node_modules\/playwright-core\/cli\.js$/);
});
