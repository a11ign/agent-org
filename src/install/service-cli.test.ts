// no-token: none -- runs `agent-org start herdr` in a child against a HOME and a host file that do not exist, so it refuses before it reaches herdr or a service manager
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpDir } from "../lib/tmp-fixture.ts";

const BIN = new URL("../bin.ts", import.meta.url).pathname;

function agentOrg(args: string[]) {
  const home = tmpDir("service-cli-");
  const missingHost = join(home, "no-such-host.json");
  const result = spawnSync(process.execPath, [BIN, ...args], { encoding: "utf8", env: { PATH: process.env.PATH, HOME: home, AGENT_ORG_HOST: missingHost }, timeout: 60_000 });
  return { ...result, missingHost };
}

test("agent-org start herdr, run through the real bin, refuses by name and does not end on an unsettled await", () => {
  const { status, stderr, missingHost } = agentOrg(["start", "herdr"]);
  assert.doesNotMatch(stderr, /unsettled/);
  assert.equal(status, 2, stderr);
  assert.ok(stderr.includes(missingHost), stderr);
});

test("agent-org start herdr --move reaches the same refusal, because the import of the move no longer waits on its own entry", () => {
  const { status, stderr, missingHost } = agentOrg(["start", "herdr", "--move"]);
  assert.doesNotMatch(stderr, /unsettled/);
  assert.equal(status, 2, stderr);
  assert.ok(stderr.includes(missingHost), stderr);
});

test("stop and status of herdr run through the same entry and refuse or answer, never end silently", () => {
  for (const verb of ["stop", "status"]) {
    const { status, stderr } = agentOrg([verb, "herdr"]);
    assert.doesNotMatch(stderr, /unsettled|ended before it finished/);
    assert.ok(status === 2 || status === 3, `${verb}: exit ${status}: ${stderr}`);
  }
});
