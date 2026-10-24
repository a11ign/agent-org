// no-token: none -- reads and writes temporary directories; nothing here reaches `gh`, `herdr` or `git`
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "../lib/tmp-fixture.ts";
import { TOOL_ROOT } from "../install/paths.ts";
import { afterNext, buildCandidates, fileHeaders, findBuild, isAssetPath, isNextPath, locate, UI_BUILD_DIR } from "./ui-build.ts";

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

test("only /next and what is under it is the UI's", () => {
  assert.deepEqual(["/next", "/next/", "/next/a/b", "/nextfoo", "/", "/api/next", "/c/work/api/next"].map(isNextPath), [true, true, true, false, false, false, false]);
  assert.deepEqual(["/next", "/next/", "/next/a/b"].map(afterNext), ["", "/", "/a/b"]);
});

test("a path is an asset when it has a file extension or is under _astro/, and a route when not", () => {
  assert.deepEqual(["/_astro/app.js", "/_astro/", "/_astro", "/favicon.svg", "/settings/x.png", "_astro/a"].map(isAssetPath), [true, true, true, true, true, true]);
  assert.deepEqual(["", "/", "/settings/", "/settings/deep/route", "/boards/12"].map(isAssetPath), [false, false, false, false, false]);
});
