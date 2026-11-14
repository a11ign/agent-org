// no-token: none -- runs this checkout's fault-injection script, whose scenarios are in-memory fakes; nothing reaches the network
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("../../../scripts/fault-injection.ts", import.meta.url));
const run = (...args: string[]) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", timeout: 60_000 });

test("node scripts/fault-injection.ts prints the report on stdout alone and exits 0 when no run is stuck", () => {
  const { status, stdout, stderr } = run();
  assert.equal(status, 0, stderr);
  assert.match(stdout, /^No run was left stuck with no reason shown\.$/m);
  assert.equal(stderr, "", "the board's journal is kept for the report, not printed");
});

test("node scripts/fault-injection.ts --scenario <unknown> exits 2 and names the scenarios", () => {
  const { status, stderr } = run("--scenario", "nope");
  assert.equal(status, 2);
  assert.match(stderr, /no scenario named nope; the scenarios are linear-5xx, herdr-killed/);
});
