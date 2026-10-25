// no-token: none -- reads and writes temporary directories; nothing here reaches `gh`, `herdr` or `git`
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "../lib/tmp-fixture.ts";
import { TOOL_ROOT } from "../install/paths.ts";
import { buildCandidates, fileHeaders, findBuild, isAssetPath, isReleaseFolder, locate, movedFromNext, servedCandidates, UI_BUILD_DIR } from "./ui-build.ts";

/** A file made, with its folders, under `dir`. */
function put(dir: string, relative: string, text = relative): string {
  const file = join(dir, relative);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, text);
  return file;
}

/** A build with a root page, a `settings/` page, a hashed asset and a file copied from `public/`, beside a file that is not the build's. */
function build() {
  const base = tmpDir("ui-build-");
  const root = join(base, "build");
  for (const file of ["index.html", "settings/index.html", "_astro/app.abc123.js", "favicon.svg", "about.html"]) put(root, file);
  put(base, "secret.txt", "not the build's");
  return { base, root };
}

test("the build is looked for in ui-build/ beside the running version, then in the checkout's ui/dist/", () => {
  assert.equal(UI_BUILD_DIR, "ui-build");
  assert.deepEqual(buildCandidates("/v/1"), ["/v/1/ui-build", "/v/1/ui/dist"]);
  assert.deepEqual(buildCandidates(), [join(TOOL_ROOT, "ui-build"), join(TOOL_ROOT, "ui", "dist")], "the default is the running version's own folder");
});

test("A11-284: a release version folder is served from its own build, then each older release's, newest first, and never from ui/dist/", () => {
  const tool = tmpDir("ui-served-");
  for (const name of ["v0.1.0", "v0.2.0", "v0.3.0", "v0.4.0", "v0.10.0", "main-abc", "v0.2.0.partial"]) mkdirSync(join(tool, "versions", name), { recursive: true });
  const at = (name: string) => join(tool, "versions", name);
  assert.deepEqual(servedCandidates(at("v0.3.0")), [join(at("v0.3.0"), "ui-build"), join(at("v0.2.0"), "ui-build"), join(at("v0.1.0"), "ui-build")]);
  assert.deepEqual(servedCandidates(at("v0.10.0")).map((dir) => dir.split("/").at(-2)), ["v0.10.0", "v0.4.0", "v0.3.0", "v0.2.0", "v0.1.0"], "ordered by number, not by text");
  assert.deepEqual(servedCandidates(at("v0.1.0")), [join(at("v0.1.0"), "ui-build")], "the oldest has none to fall back to");
  put(at("v0.2.0"), "ui-build/index.html");
  assert.equal(findBuild(servedCandidates(at("v0.3.0"))), join(at("v0.2.0"), "ui-build"), "v0.3.0 has no build of its own, so v0.2.0's is served");
  put(at("v0.3.0"), "ui-build/index.html");
  assert.equal(findBuild(servedCandidates(at("v0.3.0"))), join(at("v0.3.0"), "ui-build"), "its own build wins once it is there");
});

test("A11-284: a checkout and a main-channel folder keep the list they had, and doctor's list is the running version's own build alone", () => {
  const tool = tmpDir("ui-served-");
  mkdirSync(join(tool, "versions", "v0.1.0"), { recursive: true });
  mkdirSync(join(tool, "versions", "main-abc"), { recursive: true });
  for (const root of ["/checkout", join(tool, "versions", "main-abc")]) assert.deepEqual(servedCandidates(root), buildCandidates(root), root);
  assert.deepEqual(buildCandidates(join(tool, "versions", "v0.2.0")), [join(tool, "versions", "v0.2.0", "ui-build"), join(tool, "versions", "v0.2.0", "ui", "dist")]);
  assert.deepEqual(servedCandidates(join(tool, "versions", "v0.2.0")), [join(tool, "versions", "v0.2.0", "ui-build"), join(tool, "versions", "v0.1.0", "ui-build")], "a folder that does not exist yet still lists its own");
});

test("A11-284: only a folder under versions/ named for a release is a release folder", () => {
  assert.equal(isReleaseFolder("/home/a/.agent-org/tool/versions/v0.3.0"), true);
  assert.equal(isReleaseFolder("/home/a/.agent-org/tool/versions/main-abc12345"), false);
  assert.equal(isReleaseFolder("/home/a/src/agent-org"), false);
});

test("a folder is the build only when it holds index.html: ui-build/ beats ui/dist/, ui/dist/ stands in when it is absent, and an empty folder is skipped", () => {
  const root = tmpDir("ui-build-order-");
  const [beside, dev] = buildCandidates(root);
  assert.equal(findBuild([beside, dev]), null, "neither exists");
  put(root, "ui-build/other.txt");
  assert.equal(findBuild([beside, dev]), null, "a folder with no index.html is not a build");
  put(root, "ui/dist/index.html");
  assert.equal(findBuild([beside, dev]), dev, "ui/dist/ is used while ui-build/ holds no page");
  put(root, "ui-build/index.html");
  assert.equal(findBuild([beside, dev]), beside, "both hold a page: the one beside the version wins");
  const hollow = tmpDir("ui-build-hollow-");
  mkdirSync(join(hollow, "index.html"));
  assert.equal(findBuild([hollow]), null, "a folder named index.html is not a page");
});

test("a path maps to the exact file, then the folder's index.html, then <path>.html", () => {
  const { root } = build();
  const cases: [string, string][] = [
    ["", "index.html"], ["/", "index.html"], ["/index.html", "index.html"], ["/settings/", "settings/index.html"], ["/settings", "settings/index.html"],
    ["/about", "about.html"], ["/_astro/app.abc123.js", "_astro/app.abc123.js"], ["/favicon.svg", "favicon.svg"],
    ["/a/../settings/", "settings/index.html"],
  ];
  assert.deepEqual(cases.map(([path]) => locate(root, path)?.relative), cases.map(([, relative]) => relative));
});

test("a route that is not a file falls back to the nearest page above it, and a missing asset is never answered with a page", () => {
  const { root } = build();
  const cases: [string, string | null][] = [
    ["/settings/deep/route", "settings/index.html"], ["/settings/plugins/x/", "settings/index.html"], ["/boards/12", "index.html"],
    ["/_astro/gone.js", null], ["/_astro/", null], ["/_astro", null], ["/settings/missing.png", null], ["/missing.css", null],
  ];
  assert.deepEqual(cases.map(([path]) => locate(root, path)?.relative ?? null), cases.map(([, relative]) => relative));
});

test("a path out of the build, an encoded one, a NUL, a bad escape and a link out are each not found", () => {
  const { base, root } = build();
  symlinkSync(join(base, "secret.txt"), join(root, "link.txt"));
  symlinkSync(base, join(root, "outside"));
  put(base, "index.html", "a page outside the build");
  for (const path of ["/../secret.txt", "/..%2fsecret.txt", "/%2e%2e/secret.txt", "/settings/../../secret.txt", "/a%00b", "/%E0%A4%A", "/link.txt", "/outside/secret.txt", "/outside/index.html"]) {
    assert.equal(locate(root, path), null, path);
  }
  assert.equal(locate(root, "/outside/")?.file, join(realpathSync(root), "index.html"), "a folder that links out serves nothing from there: its route falls back to the build's own page");
});

test("a page is no-cache, a hashed file is cached for a year, any other file is no-cache, and every file has its type and nosniff", () => {
  const cases: [string, string, string][] = [
    ["index.html", "text/html; charset=utf-8", "no-cache"],
    ["settings/index.html", "text/html; charset=utf-8", "no-cache"],
    ["_astro/app.abc123.js", "text/javascript; charset=utf-8", "public, max-age=31536000, immutable"],
    ["_astro/app.abc123.css", "text/css; charset=utf-8", "public, max-age=31536000, immutable"],
    ["_astro/inter.abc123.woff2", "font/woff2", "public, max-age=31536000, immutable"],
    ["favicon.svg", "image/svg+xml", "no-cache"],
    ["robots.txt", "text/plain; charset=utf-8", "no-cache"],
    ["site.webmanifest", "application/manifest+json", "no-cache"],
    ["data.bin", "application/octet-stream", "no-cache"],
    ["noext", "application/octet-stream", "no-cache"],
  ];
  for (const [file, type, cache] of cases) {
    assert.deepEqual(fileHeaders(file), { "Content-Type": type, "Cache-Control": cache, "X-Content-Type-Options": "nosniff" }, file);
  }
});

test("A11-202: an address under /next goes to the same address without it, with its query, and nothing else moves", () => {
  assert.deepEqual([["/next", ""], ["/next/", "?connection=x"], ["/next/tickets", ""], ["/next/runs/A11-1", "?connection=x"], ["/next/settings/models", "?a=1&b=2"]].map(([path, search]) => movedFromNext(path, search)),
    ["/", "/?connection=x", "/tickets", "/runs/A11-1?connection=x", "/settings/models?a=1&b=2"]);
  assert.deepEqual(["/nextfoo", "/", "/tickets", "/api/next", "/c/work/api/next", "/_astro/next/a.js"].map((path) => movedFromNext(path, "")), [null, null, null, null, null, null]);
});

test("A11-202: a /next address never moves to another origin, whatever slashes follow it", () => {
  assert.deepEqual(["/next//evil.example", "/next///evil.example/x", "/next/\\evil.example", "/next//\\evil.example", "/next/%2F/evil.example"].map((path) => movedFromNext(path, "")),
    ["/evil.example", "/evil.example/x", "/evil.example", "/evil.example", "/%2F/evil.example"]);
});

test("a path is an asset when it has a file extension or is under _astro/, and a route when not", () => {
  assert.deepEqual(["/_astro/app.js", "/_astro/", "/_astro", "/favicon.svg", "/settings/x.png", "_astro/a"].map(isAssetPath), [true, true, true, true, true, true]);
  assert.deepEqual(["", "/", "/settings/", "/settings/deep/route", "/boards/12"].map(isAssetPath), [false, false, false, false, false]);
});
