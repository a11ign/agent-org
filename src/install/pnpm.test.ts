// no-token: none -- reads this repository's own files, and builds an argv without running it
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { npmCliScriptCandidates } from "../lib/npm-cli-executable.ts";
import { COREPACK_FIXES, pinnedPnpm, TOOL_PNPM_VERSION } from "./pnpm.ts";

const ROOT = join(import.meta.dirname, "..", "..");
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");

const NODE = "/opt/node/bin/node";
const BESIDE = "/opt/node/lib/node_modules/corepack/dist/corepack.js";
const NPM_CLI = npmCliScriptCandidates("npm")[0];
const PINNED = `pnpm@${TOOL_PNPM_VERSION}`;
const search = (present: string[], path = "/usr/local/bin:/opt/homebrew/bin") => ({ node: NODE, path, exists: (file: string) => present.includes(file) });

test("one pnpm version: the one the releases are built with, which CI repeats and install.sh installs with", () => {
  assert.equal(/pnpm-version:\s*['"]?([\d.]+)/.exec(read(".github/workflows/release.yml"))?.[1], TOOL_PNPM_VERSION, "release.yml");
  assert.equal(/PNPM_VERSION:\s*['"]?([\d.]+)/.exec(read(".github/workflows/ci.yml"))?.[1], TOOL_PNPM_VERSION, "ci.yml");
  assert.equal(/^PNPM_VERSION=([\d.]+)$/m.exec(read("install.sh"))?.[1], TOOL_PNPM_VERSION, "install.sh");
});

test("the pinned pnpm runs by version through the corepack beside node first, never the pnpm on PATH", () => {
  assert.deepEqual(pinnedPnpm(["install", "--prod"], search([BESIDE, "/opt/homebrew/bin/corepack", NPM_CLI])), {
    command: NODE,
    args: [BESIDE, PINNED, "install", "--prod"],
    via: "corepack beside node",
  });
});

test("with no corepack beside node, a corepack on PATH runs it, before npm exec", () => {
  assert.deepEqual(pinnedPnpm(["--version"], search(["/opt/homebrew/bin/corepack", NPM_CLI])), {
    command: "/opt/homebrew/bin/corepack",
    args: [PINNED, "--version"],
    via: "corepack on PATH",
  });
});

test("with no corepack anywhere, npm exec runs the pinned pnpm with npm's own CLI script", () => {
  assert.deepEqual(pinnedPnpm(["install", "--prod"], search([NPM_CLI])), {
    command: NODE,
    args: [NPM_CLI, "exec", "--yes", PINNED, "--", "install", "--prod"],
    via: "npm exec",
  });
});

test("with no runner at all it throws, naming both commands that give one and never saying to reinstall Node", () => {
  assert.throws(() => pinnedPnpm(["--version"], search([])), (error: Error) => {
    for (const fix of COREPACK_FIXES) assert.ok(error.message.includes(fix), `names ${fix}`);
    assert.deepEqual(COREPACK_FIXES, ["brew install corepack", "npm install -g corepack"]);
    assert.doesNotMatch(error.message, /[Rr]einstall/);
    return true;
  });
});
