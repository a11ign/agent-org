// no-token: none -- reads this repository's own files, and builds an argv without running it
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pinnedPnpm, TOOL_PNPM_VERSION } from "./pnpm.ts";

const ROOT = join(import.meta.dirname, "..", "..");
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");

test("one pnpm version: the one the releases are built with, which CI repeats and install.sh installs with", () => {
  assert.equal(/pnpm-version:\s*['"]?([\d.]+)/.exec(read(".github/workflows/release.yml"))?.[1], TOOL_PNPM_VERSION, "release.yml");
  assert.equal(/PNPM_VERSION:\s*['"]?([\d.]+)/.exec(read(".github/workflows/ci.yml"))?.[1], TOOL_PNPM_VERSION, "ci.yml");
  assert.equal(/^PNPM_VERSION=([\d.]+)$/m.exec(read("install.sh"))?.[1], TOOL_PNPM_VERSION, "install.sh");
});

test("the pinned pnpm runs by version through the corepack beside node, never the pnpm on PATH", () => {
  assert.deepEqual(pinnedPnpm(["install", "--prod"], "/opt/node/bin/node"), {
    command: "/opt/node/bin/node",
    args: ["/opt/node/lib/node_modules/corepack/dist/corepack.js", `pnpm@${TOOL_PNPM_VERSION}`, "install", "--prod"],
  });
});
