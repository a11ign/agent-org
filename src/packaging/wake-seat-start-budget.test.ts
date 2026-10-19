// no-token: none -- herdr is an injected `run` and the roster is a fixture file, so nothing here reaches gh
/**
 * agent-org#1052: `startAbsentSeats` SHARES THE TICK'S START BUDGET (agent-org#1025), so a herdr restart that leaves N persistent seats absent
 * cannot make the `seats` phase wait N x 30 s before `wake` begins.
 *
 * Driven through `startAbsentSeats`, the production entry, with a herdr whose `agent start` advances an injected clock by what the start "takes".
 * THE CONTROLS ARE THE POINT: a fast start is still started, a PRESENT seat gets no write, and a listing that is not complete starts nothing. A
 * deferred seat is named `SEATS DEFERRED` and is started by the next tick, because the next tick reads it absent again: no queue is kept.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { startAbsentSeats } from "../wake/release-line-and-seats.ts";
import { tmpDirForFile } from "../lib/tmp-fixture.ts";

const scratch = tmpDirForFile("seat-start-budget-1052-");
const BRIEF = ".agent-org/roles/liaison.md";
const CHECKOUT = "/srv/project-checkout";
// `listingIsComplete` wants the standing panes in herdr's answer, or it reads the listing as partial and starts nothing
const STANDING: [string, string][] = [["ceo", "idle"], ["orchestrator", "idle"]];

let rosters = 0;
/** A roster whose persistent seats are `names`, in that order. */
function rosterWith(names: string[]): string {
  const path = join(scratch, `sessions-${rosters++}.json`);
  const live = [{ name: "ceo", role: "ceo" }, ...names.map((name) => ({ name, role: "liaison", persistent: true, brief: BRIEF }))];
  writeFileSync(path, JSON.stringify({ live }));
  return path;
}

/**
 * A herdr that remembers what was created, and whose `agent start` number `n` (from 0) takes `startsTake[n]` ms of the injected clock. `now` is
 * the clock `startAbsentSeats` is handed, so the budget sees the same wait a real timed-out start would cost.
 */
function clockedHerdr(labels: [string, string][], startsTake: number[] = []) {
  let clock = 1_000_000;
  let starts = 0;
  const calls: string[][] = [];
  const live = new Map(labels);
  const run = (args: string[]): string => {
    calls.push(args);
    const [group, verb] = [args[2], args[3]];
    if (group === "workspace" && verb === "list") return JSON.stringify({ result: { workspaces: [...live].map(([label, agent_status]) => ({ label, agent_status })) } });
    if (group === "workspace" && verb === "create") {
      live.set(args[args.indexOf("--label") + 1], "unknown");
      return JSON.stringify({ result: { workspace: { workspace_id: "w100" }, root_pane: { pane_id: "w100:p1" } } });
    }
    if (group === "workspace" && verb === "close") return "{}";
    if (group === "agent" && verb === "start") {
      clock += startsTake[starts] ?? 0;
      starts += 1;
      live.set(args[4], "idle");
      return "{}";
    }
    throw new Error(`unexpected herdr call ${args.join(" ")}`);
  };
  return {
    run, now: () => clock,
    started: () => calls.filter((c) => c[2] === "agent" && c[3] === "start").map((c) => c[4]),
    written: () => calls.filter((c) => c[3] === "create" || c[3] === "start"),
  };
}

test("CONTROL: one fast absent seat is started, and nothing is deferred (the budget does not refuse the ordinary case)", () => {
  const herdr = clockedHerdr(STANDING);
  const lines = startAbsentSeats({ run: herdr.run, now: herdr.now, env: {}, checkout: CHECKOUT, sessionsPath: rosterWith(["liaison-a"]) });

  assert.equal(lines.length, 1);
  assert.match(lines[0], /^SEAT STARTED liaison-a /);
  assert.deepEqual(herdr.started(), ["liaison-a"]);
});

test("DONE-WHEN 1: three absent seats of 30 s each -- two are started, the third is SEATS DEFERRED, and the next tick starts it", () => {
  const herdr = clockedHerdr(STANDING, [30_000, 30_000, 30_000]);
  const roster = rosterWith(["liaison-a", "liaison-b", "liaison-c"]);
  const lines = startAbsentSeats({ run: herdr.run, now: herdr.now, env: {}, checkout: CHECKOUT, sessionsPath: roster });

  assert.deepEqual(herdr.started(), ["liaison-a", "liaison-b"], "POSITIVE: only two `agent start` calls were made");
  assert.equal(lines.length, 3);
  assert.match(lines[0], /^SEAT STARTED liaison-a /);
  assert.match(lines[1], /^SEAT STARTED liaison-b /);
  assert.match(lines[2], /^SEATS DEFERRED: liaison-c waits for the next tick: this tick's agent starts have used their 60 s start budget\.$/);
  assert.equal(herdr.written().filter((c) => c[3] === "create").length, 2, "and the deferred seat opened no workspace to close again");

  // The next tick reads herdr again: a and b are now present, c is the only absent seat, so it is the one started (with a budget of its own).
  const again = startAbsentSeats({ run: herdr.run, now: herdr.now, env: {}, checkout: CHECKOUT, sessionsPath: roster });
  assert.deepEqual(again.map((line) => line.split(" ").slice(0, 3).join(" ")), ["SEAT STARTED liaison-c"]);
  assert.deepEqual(herdr.started(), ["liaison-a", "liaison-b", "liaison-c"]);
});

test("CONTROL: a PRESENT seat gets no write, and the absent one after it is still started", () => {
  const herdr = clockedHerdr([...STANDING, ["liaison-a", "working"]], [200]);
  const lines = startAbsentSeats({ run: herdr.run, now: herdr.now, env: {}, checkout: CHECKOUT, sessionsPath: rosterWith(["liaison-a", "liaison-b"]) });

  assert.deepEqual(herdr.started(), ["liaison-b"], "POSITIVE: the present seat is not started");
  assert.equal(herdr.written().filter((c) => c.includes("liaison-a")).length, 0, "and no create or start names it");
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^SEAT STARTED liaison-b /);
});

test("CONTROL: a listing that is not complete starts nothing, not even a seat that is absent in it", () => {
  const herdr = clockedHerdr([["ceo", "idle"]], [200]);
  const lines = startAbsentSeats({ run: herdr.run, now: herdr.now, env: {}, checkout: CHECKOUT, sessionsPath: rosterWith(["liaison-a"]) });

  assert.deepEqual(herdr.started(), []);
  assert.equal(herdr.written().length, 0);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^SEATS NOT STARTED: liaison-a read absent/);
});
