// no-token: none -- herdr is the pool tests' in-memory fake, wrapped; nothing is spawned
import { test } from "node:test";
import assert from "node:assert/strict";
import { faultyHerdr, INTERRUPTED_SCREEN, SERVER_GONE } from "./fault-herdr.ts";

const create = (label: string) => ["--session", "tickets", "workspace", "create", "--label", label, "--env", "AGENT_ORG_TICKET=FIX-1"];

test("a killed herdr refuses every call as its CLI does with no server, naming the command, until it is restarted", () => {
  const herdr = faultyHerdr();
  herdr.run(create("t-fix-1"));
  herdr.kill();
  assert.ok(herdr.isDown());
  assert.throws(() => herdr.run(["--session", "tickets", "workspace", "list"]), (err: Error & { stderr?: string }) =>
    err.message.startsWith("Command failed: herdr --session tickets workspace list") && err.stderr === `${SERVER_GONE}\n`);
  herdr.restart(new Map());
  assert.doesNotThrow(() => herdr.run(["--session", "tickets", "workspace", "list"]));
});

test("a restart is read as one, and restores each pane idle, interrupted and without the environment it was started with", () => {
  const herdr = faultyHerdr();
  herdr.run(create("t-fix-1"));
  herdr.status.set("t-fix-1", "working");
  assert.deepEqual(herdr.envs.get("w1:p1"), { AGENT_ORG_TICKET: "FIX-1" });
  const before = herdr.restartReads.herdrStart();
  herdr.kill();
  herdr.restart(new Map([["t-fix-1", "w1:p1"]]));
  assert.notEqual(herdr.restartReads.herdrStart(), before, "the board tells a restart by herdr's start time");
  assert.equal(herdr.status.get("t-fix-1"), "idle");
  assert.equal(herdr.screens.get("w1:p1"), INTERRUPTED_SCREEN);
  assert.deepEqual(herdr.envs.get("w1:p1"), {});
});

test("each prompt the board sends is kept by its pane, and none is kept while herdr is down", () => {
  const herdr = faultyHerdr();
  herdr.run(create("t-fix-1"));
  herdr.run(["--session", "tickets", "agent", "prompt", "w1:p1", "carry on"]);
  herdr.kill();
  assert.throws(() => herdr.run(["--session", "tickets", "agent", "prompt", "w1:p1", "lost"]));
  assert.deepEqual(herdr.prompts.get("w1:p1"), ["carry on"]);
});
