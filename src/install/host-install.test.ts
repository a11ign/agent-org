// no-token: none -- the program the install runs is a stand-in function; nothing here starts a process or reads the host.
// requires: history
/**
 * A11-354: THE UPDATE RUNS THE HOST INSTALL FROM THE INSTALLED RELEASE.
 *
 *  1. It runs `<tool>/current/src/bin.ts host:install --unattended` with the node that runs the update and the host file the update reads: the release the update has just made current, never a
 *     checkout (host.json's `tool` was at v0.277.0 on 2026-10-27).
 *  2. What the install printed is the update's said lines, and a failure (an exit status, or a program that could not start) is an error with the install's own stderr.
 *  3. A tool with no `current` (an install that has not migrated) runs nothing and says so.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { hostInstallUpkeep } from "./host-install.ts";

const TOOL = "/home/agent/.agent-org/tool";
const BIN = `${TOOL}/current/src/bin.ts`;

type Call = { file: string; args: string[]; env: Record<string, string | undefined> | undefined };

function runner(result: { status: number | null; stdout?: string; stderr?: string }) {
  const calls: Call[] = [];
  const run = (file: string, args: string[], env?: Record<string, string | undefined>) => { calls.push({ file, args, env }); return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" }; };
  return { calls, run };
}

test("A11-354: the install is the installed release's own command, run with the update's node and host file", () => {
  const { calls, run } = runner({ status: 0, stdout: "installed a11ign-tmp-prune.service\n\nrestarted a11ign-tmp-prune.timer if it was running\n" });
  const upkeep = hostInstallUpkeep(TOOL, { run, exists: (path) => path === BIN, node: "/opt/node/bin/node", env: { AGENT_ORG_HOST: "/home/agent/.agent-org/host.json" } });
  assert.deepEqual(calls, [{ file: "/opt/node/bin/node", args: [BIN, "host:install", "--unattended"], env: { AGENT_ORG_HOST: "/home/agent/.agent-org/host.json" } }]);
  assert.deepEqual(upkeep, { said: ["installed a11ign-tmp-prune.service", "restarted a11ign-tmp-prune.timer if it was running"], failed: [] });
  assert.ok(calls.every(({ args }) => args.every((arg) => !arg.includes("/repos/"))), "no checkout is named");
});

test("A11-354: a failed install is an error with the install's own words, whether it exited or could not start", () => {
  const exited = hostInstallUpkeep(TOOL, { run: runner({ status: 1, stdout: "installed a\n", stderr: "COULD NOT INSTALL the units: cannot install x\n" }).run, exists: () => true });
  assert.deepEqual(exited.said, ["installed a"]);
  assert.match(exited.failed[0], /^host install FAILED \(it exited 1\), so the host may still run an earlier copy of what .*\/current\/src\/bin\.ts ships:$/);
  assert.deepEqual(exited.failed.slice(1), ["COULD NOT INSTALL the units: cannot install x"]);
  const unstarted = hostInstallUpkeep(TOOL, { run: runner({ status: null, stderr: "spawnSync node ENOENT" }).run, exists: () => true });
  assert.match(unstarted.failed[0], /\(it could not start\)/);
  assert.deepEqual(unstarted.failed.slice(1), ["spawnSync node ENOENT"]);
});

test("A11-354: a tool with no current release runs nothing and says so", () => {
  const { calls, run } = runner({ status: 0 });
  const upkeep = hostInstallUpkeep(TOOL, { run, exists: () => false });
  assert.deepEqual(calls, []);
  assert.deepEqual(upkeep, { said: [`host install: ${TOOL} has no current release, so nothing was installed`], failed: [] });
});
