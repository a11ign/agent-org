// no-token: none -- the downloads go to a static server on 127.0.0.1 that this file starts (`fixtures/release-server.ts`); nothing reaches GitHub
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "../lib/tmp-fixture.ts";
import { assetName } from "../../scripts/ui-asset.ts";
import { startReleaseServer, publishUiAsset, type ReleaseServer } from "./fixtures/release-server.ts";
import { declaresUiBuild, ensureUiBuild, hasUiBuild, releasesUrl, uiAssetName, type UiSource } from "./ui-asset.ts";

/** A built UI as `astro build` leaves it: a page and a hashed file. `label` makes two builds differ. */
function distOf(root: string, label: string): string {
  const dist = join(root, `dist-${label}`);
  mkdirSync(join(dist, "_astro"), { recursive: true });
  writeFileSync(join(dist, "index.html"), `<title>${label}</title>\n`);
  writeFileSync(join(dist, "_astro", "app.abc123.js"), `console.log("${label}");\n`);
  return dist;
}

/** A version folder as `buildVersion` has it: a `package.json` that declares a UI build or not. */
function versionFolder(root: string, name: string, shipsUiBuild: boolean): string {
  const folder = join(root, "versions", name);
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "package.json"), `${JSON.stringify({ name: "agent-org", ...(shipsUiBuild ? { agentOrg: { shipsUiBuild: true } } : {}) })}\n`);
  return folder;
}

const serve = (root: string): Promise<ReleaseServer> => startReleaseServer(join(root, "releases"));

const from = (server: ReleaseServer): UiSource => ({ releases: () => server.url, exec: execFileSync });

/** A temporary root, the stand-in for GitHub, and a version folder named `name` that does (or not) declare a UI build. */
async function setUp(name: string, shipsUiBuild = true) {
  const root = tmpDir("ui-asset-");
  const server = await serve(root);
  return { root, server, folder: versionFolder(root, name, shipsUiBuild) };
}

test("the asset's name is the one scripts/ui-asset.ts packs and release.yml uploads", () => {
  assert.equal(uiAssetName("v0.12.0"), "agent-org-ui-v0.12.0.tar.gz");
  assert.equal(uiAssetName("v0.12.0"), assetName("v0.12.0"));
});

test("a release declares its UI build with agentOrg.shipsUiBuild, and nothing else says so", () => {
  const root = tmpDir("ui-asset-");
  assert.equal(declaresUiBuild(versionFolder(root, "v0.1.0", true)), true);
  assert.equal(declaresUiBuild(versionFolder(root, "v0.2.0", false)), false, "a release before the marker");
  assert.equal(declaresUiBuild(join(root, "versions", "none")), false, "no package.json");
  const folder = versionFolder(root, "v0.3.0", false);
  mkdirSync(join(folder, "ui"));
  writeFileSync(join(folder, "package.json"), JSON.stringify({ agentOrg: { shipsUiBuild: "yes" } }));
  assert.equal(declaresUiBuild(folder), false, "a release that holds ui/ but does not declare a build (the tags between the UI's scaffold and the marker)");
});

test("the releases URL is the override, else the repository's GitHub releases; any other repository has none", () => {
  const none = {};
  const github = "https://github.com/a11ign/agent-org/releases/download";
  for (const repo of ["https://github.com/a11ign/agent-org.git", "https://github.com/a11ign/agent-org", "https://github.com/a11ign/agent-org/", "git@github.com:a11ign/agent-org.git", "ssh://git@github.com/a11ign/agent-org.git"]) {
    assert.equal(releasesUrl(repo, none), github, repo);
  }
  assert.equal(releasesUrl("/srv/git/agent-org.git", none), null);
  assert.equal(releasesUrl("https://example.com/a11ign/agent-org.git", none), null);
  assert.equal(releasesUrl("https://github.com/a11ign", none), null);
  assert.equal(releasesUrl(null, none), null);
  assert.equal(releasesUrl("/srv/git/agent-org.git", { AGENT_ORG_RELEASES_URL: "http://127.0.0.1:9/dl/" }), "http://127.0.0.1:9/dl");
  assert.equal(releasesUrl("https://github.com/a11ign/agent-org.git", { AGENT_ORG_RELEASES_URL: "http://127.0.0.1:9/dl" }), "http://127.0.0.1:9/dl", "the override wins over a GitHub URL");
  assert.equal(releasesUrl("https://github.com/a11ign/agent-org.git", { AGENT_ORG_RELEASES_URL: "" }), github, "an empty override is no override");
});

test("a declared release with its asset gets ui-build/ unpacked whole, and the download leaves nothing beside it", async () => {
  const { root, server, folder } = await setUp("v0.5.0");
  publishUiAsset(server.root, "v0.5.0", distOf(root, "five"));
  const step = ensureUiBuild({ folder, name: "v0.5.0", source: from(server) });
  assert.deepEqual(step, { state: "ok", said: "fetched the UI build of v0.5.0" });
  assert.equal(readFileSync(join(folder, "ui-build", "index.html"), "utf8"), "<title>five</title>\n");
  assert.equal(readFileSync(join(folder, "ui-build", "_astro", "app.abc123.js"), "utf8"), "console.log(\"five\");\n");
  assert.equal(hasUiBuild(folder), true);
  assert.deepEqual(readdirSync(join(root, "versions")), ["v0.5.0"], "no staging folder is left");
  assert.deepEqual(readdirSync(folder).toSorted(), ["package.json", "ui-build"], "no ui-build.partial is left");
  assert.deepEqual(server.requests(), ["/v0.5.0/agent-org-ui-v0.5.0.tar.gz.sha256", "/v0.5.0/agent-org-ui-v0.5.0.tar.gz"]);
});

test("a release that declares no build asks for nothing: no request, no ui-build", async () => {
  const { root, server, folder } = await setUp("v0.2.0", false);
  assert.deepEqual(ensureUiBuild({ folder, name: "v0.2.0", source: from(server) }), { state: "ok" });
  assert.deepEqual(server.requests(), []);
  assert.equal(existsSync(join(folder, "ui-build")), false);
});

test("a folder that has its build is left alone, with no request", async () => {
  const { root, server, folder } = await setUp("v0.5.0");
  mkdirSync(join(folder, "ui-build"));
  writeFileSync(join(folder, "ui-build", "index.html"), "already here\n");
  assert.deepEqual(ensureUiBuild({ folder, name: "v0.5.0", source: from(server) }), { state: "ok" });
  assert.deepEqual(server.requests(), []);
  assert.equal(readFileSync(join(folder, "ui-build", "index.html"), "utf8"), "already here\n");
});

test("a declared release whose asset is not attached yet fails and says CI attaches it minutes after the release", async () => {
  const { root, server, folder } = await setUp("v0.5.0");
  const step = ensureUiBuild({ folder, name: "v0.5.0", source: from(server) });
  assert.equal(step.state, "failed");
  assert.match(step.state === "failed" ? step.reason : "", /^v0\.5\.0 has not attached its UI build yet \(CI attaches it a few minutes after the release\), so it is not installed; the next update tries again$/);
  assert.equal(existsSync(join(folder, "ui-build")), false);
  assert.deepEqual(readdirSync(join(root, "versions")), ["v0.5.0"], "the failed fetch leaves no staging folder");
});

test("a checksum that does not match the tarball fails, and nothing is unpacked", async () => {
  const { root, server, folder } = await setUp("v0.5.0");
  const { checksum } = publishUiAsset(server.root, "v0.5.0", distOf(root, "five"));
  writeFileSync(checksum, `${"0".repeat(64)}  agent-org-ui-v0.5.0.tar.gz\n`);
  const step = ensureUiBuild({ folder, name: "v0.5.0", source: from(server) });
  assert.deepEqual(step, { state: "failed", reason: "the UI build of v0.5.0 did not match its checksum, so it was not installed" });
  assert.equal(existsSync(join(folder, "ui-build")), false);
  assert.deepEqual(readdirSync(folder), ["package.json"]);
});

test("a checksum file that holds no digest is a mismatch, and so is a tarball changed after it was packed", async () => {
  const { root, server, folder } = await setUp("v0.5.0");
  const { tarball, checksum } = publishUiAsset(server.root, "v0.5.0", distOf(root, "five"));
  writeFileSync(checksum, "<html>not a checksum</html>\n");
  assert.match(String((ensureUiBuild({ folder, name: "v0.5.0", source: from(server) }) as { reason?: string }).reason), /did not match its checksum/);
  publishUiAsset(server.root, "v0.5.0", distOf(root, "five"));
  writeFileSync(tarball, Buffer.concat([readFileSync(tarball), Buffer.from("tampered")]));
  assert.match(String((ensureUiBuild({ folder, name: "v0.5.0", source: from(server) }) as { reason?: string }).reason), /did not match its checksum/);
  assert.equal(existsSync(join(folder, "ui-build")), false);
});

test("a server error, and no server at all, fail naming the status or curl's own words", () => {
  const root = tmpDir("ui-asset-");
  const folder = versionFolder(root, "v0.5.0", true);
  const failing: UiSource = { releases: () => "http://127.0.0.1:1/dl", exec: execFileSync };
  const refused = ensureUiBuild({ folder, name: "v0.5.0", source: failing });
  assert.equal(refused.state, "failed");
  assert.match(refused.state === "failed" ? refused.reason : "", /^the UI build of v0\.5\.0 could not be downloaded from http:\/\/127\.0\.0\.1:1\/dl\/v0\.5\.0\/agent-org-ui-v0\.5\.0\.tar\.gz\.sha256 \(.*[Cc]onnect/);
  const unavailable: UiSource = { releases: () => "http://x", exec: () => "503" };
  assert.deepEqual(ensureUiBuild({ folder, name: "v0.5.0", source: unavailable }), {
    state: "failed", reason: "the UI build of v0.5.0 could not be downloaded from http://x/v0.5.0/agent-org-ui-v0.5.0.tar.gz.sha256 (HTTP 503)",
  });
});

test("a tarball with no index.html is refused even when its checksum is right", async () => {
  const { root, server, folder } = await setUp("v0.5.0");
  const out = join(server.root, "v0.5.0");
  mkdirSync(out, { recursive: true });
  const stray = join(root, "stray");
  mkdirSync(stray);
  writeFileSync(join(stray, "readme.txt"), "not a build\n");
  const tarball = join(out, "agent-org-ui-v0.5.0.tar.gz");
  execFileSync("tar", ["-czf", tarball, "-C", stray, "."]);
  const digest = execFileSync("sha256sum", [tarball], { encoding: "utf8" }).split(" ")[0];
  writeFileSync(`${tarball}.sha256`, `${digest}  agent-org-ui-v0.5.0.tar.gz\n`);
  assert.deepEqual(ensureUiBuild({ folder, name: "v0.5.0", source: from(server) }), { state: "failed", reason: "the UI build of v0.5.0 holds no index.html, so it is not a build of the board UI" });
  assert.equal(existsSync(join(folder, "ui-build")), false);
});

test("a repository that is not on GitHub, with no override, fails and names AGENT_ORG_RELEASES_URL", () => {
  const root = tmpDir("ui-asset-");
  const folder = versionFolder(root, "v0.5.0", true);
  const step = ensureUiBuild({ folder, name: "v0.5.0", source: { releases: () => null, exec: () => { throw new Error("no request is made"); } } });
  assert.equal(step.state, "failed");
  assert.match(step.state === "failed" ? step.reason : "", /AGENT_ORG_RELEASES_URL/);
});

test("the main channel's folder has no Release: it asks for nothing and says so", async () => {
  const { server, folder } = await setUp("main-1a2b3c4d");
  const step = ensureUiBuild({ folder, name: "main-1a2b3c4d", source: from(server) });
  assert.equal(step.state, "ok");
  assert.match(step.state === "ok" ? step.said ?? "" : "", /^main-1a2b3c4d is not a release, so it has no UI build to fetch/);
  assert.deepEqual(server.requests(), []);
});
