// no-token: none -- herdr is an injected `run` and the roster is a fixture file, so nothing here reaches gh
/**
 * #4740: A PERSISTENT SEAT IS STARTED WITH THE MODEL, EFFORT AND AUTOCOMPACT ITS ROSTER ENTRY DECLARES.
 *
 * The chairman switched the liaison to Haiku 5.5 / high by hand (#4627), and a restart threw that away because a seat's start was the fixed
 * `SEAT_START_FLAGS`. The fields are optional, so the controls here are the two directions of one claim: a seat that declares them is started
 * with exactly those flags, and a seat that declares none is started with the argv the launcher built before this row, byte for byte.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { HAIKU_AUTOCOMPACT_WINDOW_TOKENS, HAIKU_MODEL_ID } from "./worker-profile.ts";
import { SEAT_START_FLAGS, seatFirstPrompt, seatStartFlags, startAbsentSeats } from "./wake.ts";
import { tmpDirForFile } from "./lib/tmp-fixture.ts";

const scratch = tmpDirForFile("seat-4740-");
const BRIEF = ".agent-org/roles/liaison.md";
const CHECKOUT = "/srv/project-checkout";
// `listingIsComplete` wants the standing panes in herdr's answer, or it reads the listing as partial and starts nothing
const STANDING: [string, string][] = [["ceo", "idle"], ["orchestrator", "idle"]];

/** The launcher's argv as it stood before #4740, written out so a change to it cannot also change this. */
const FLAGS_BEFORE = ["--model", "sonnet", "--effort", "medium", "--dangerously-skip-permissions", "--disallowedTools", "AskUserQuestion"];

let rosters = 0;
/** A roster whose one persistent seat, `liaison`, carries `fields`. */
function rosterWith(fields: object): string {
  const path = join(scratch, `sessions-${rosters++}.json`);
  writeFileSync(path, JSON.stringify({ live: [{ name: "ceo", role: "ceo" }, { name: "liaison", role: "liaison", persistent: true, brief: BRIEF, ...fields }] }));
  return path;
}

/** A herdr that remembers what was created, so the start's read-back is a real one. */
function fakeHerdr(labels: [string, string][]) {
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
      live.set(args[4], "idle");
      return "{}";
    }
    throw new Error(`unexpected herdr call ${args.join(" ")}`);
  };
  const starts = () => calls.filter((c) => c[2] === "agent" && c[3] === "start");
  return { run, starts };
}

/** What the start put after the prompt: the flags, the one thing these tests compare. */
function startedFlags(fields: object): { flags: string[]; lines: string[]; starts: number } {
  const herdr = fakeHerdr(STANDING);
  const lines = startAbsentSeats({ run: herdr.run, env: {}, checkout: CHECKOUT, sessionsPath: rosterWith(fields) });
  const [call] = herdr.starts();
  const rest = call?.slice(call.indexOf("--") + 1) ?? [];
  return { flags: rest.slice(1), lines, starts: herdr.starts().length };
}

const HAIKU_FIELDS = { model: HAIKU_MODEL_ID, effort: "high", autocompact: HAIKU_AUTOCOMPACT_WINDOW_TOKENS };

test("a seat with the three fields starts with exactly those flags, and every other flag unchanged", () => {
  const { flags, lines } = startedFlags(HAIKU_FIELDS);
  assert.deepEqual(flags, ["--model", "claude-haiku-5-5", "--effort", "high", "--autocompact", "130000",
    "--dangerously-skip-permissions", "--disallowedTools", "AskUserQuestion"]);
  assert.match(lines.join("\n"), /SEAT STARTED liaison/);
});

test("a seat with none of the fields starts with today's argv, byte for byte", () => {
  assert.deepEqual(startedFlags({}).flags, FLAGS_BEFORE);
  assert.deepEqual([...SEAT_START_FLAGS], FLAGS_BEFORE, "the constant is unchanged");
  assert.deepEqual(seatStartFlags(), FLAGS_BEFORE);
  assert.ok(!startedFlags({}).flags.includes("--autocompact"), "no --autocompact unless the entry declares one");
});

test("a seat declaring only `model` changes only --model", () => {
  const flags = startedFlags({ model: "opus" }).flags;
  assert.deepEqual(flags, FLAGS_BEFORE.map((f) => (f === "sonnet" ? "opus" : f)));
});

test("a seat declaring only `effort` or only `autocompact` changes only that", () => {
  assert.deepEqual(startedFlags({ effort: "xhigh" }).flags, FLAGS_BEFORE.map((f) => (f === "medium" ? "xhigh" : f)));
  assert.deepEqual(startedFlags({ autocompact: 150000 }).flags,
    ["--model", "sonnet", "--effort", "medium", "--autocompact", "150000", "--dangerously-skip-permissions", "--disallowedTools", "AskUserQuestion"]);
});

test("the prompt still goes before the flags, and the list-taking flag stays last", () => {
  const herdr = fakeHerdr(STANDING);
  startAbsentSeats({ run: herdr.run, env: {}, checkout: CHECKOUT, sessionsPath: rosterWith(HAIKU_FIELDS) });
  const [call] = herdr.starts();
  const after = call.slice(call.indexOf("--") + 1);
  assert.equal(after[0], seatFirstPrompt("liaison", BRIEF));
  assert.deepEqual(after.slice(-2), ["--disallowedTools", "AskUserQuestion"]);
});

test("a malformed field is a SEAT NOT STARTED line naming the entry and the field, and starts nothing", () => {
  const cases: [object, RegExp][] = [
    [{ model: "claude haiku" }, /SEAT NOT STARTED liaison: .*`liaison`.*`model`/],
    [{ model: "--dangerously-skip-permissions" }, /`model`/],
    [{ model: 7 }, /`model`/],
    [{ effort: "turbo" }, /SEAT NOT STARTED liaison: .*`effort`.*low, medium, high, xhigh, max/],
    [{ autocompact: 0 }, /SEAT NOT STARTED liaison: .*`autocompact`/],
    [{ autocompact: -5 }, /`autocompact`/],
    [{ autocompact: "130000" }, /`autocompact`/],
    [{ autocompact: 1.5 }, /`autocompact`/],
  ];
  for (const [fields, expected] of cases) {
    const result = startedFlags(fields);
    assert.equal(result.starts, 0, `nothing was started for ${JSON.stringify(fields)}`);
    assert.match(result.lines.join("\n"), expected, JSON.stringify(fields));
  }
});

test("THE CHAIRMAN'S PIN: a restarted liaison, absent from herdr, is started on the declared Haiku 5.5 / high", () => {
  // the liaison is NOT in herdr's listing -- it was restarted -- and the roster declares its model
  const herdr = fakeHerdr(STANDING);
  const lines = startAbsentSeats({ run: herdr.run, env: {}, checkout: CHECKOUT, sessionsPath: rosterWith(HAIKU_FIELDS) });
  assert.equal(herdr.starts().length, 1);
  const flags = herdr.starts()[0];
  assert.equal(flags[flags.indexOf("--model") + 1], "claude-haiku-5-5");
  assert.equal(flags[flags.indexOf("--effort") + 1], "high");
  assert.equal(Number(flags[flags.indexOf("--autocompact") + 1]), HAIKU_AUTOCOMPACT_WINDOW_TOKENS);
  assert.match(lines.join("\n"), /SEAT STARTED liaison/);
});

test("its control: with the entry's fields dropped the same restart is started on sonnet / medium", () => {
  const herdr = fakeHerdr(STANDING);
  startAbsentSeats({ run: herdr.run, env: {}, checkout: CHECKOUT, sessionsPath: rosterWith({}) });
  const flags = herdr.starts()[0];
  assert.equal(flags[flags.indexOf("--model") + 1], "sonnet");
  assert.equal(flags[flags.indexOf("--effort") + 1], "medium");
  assert.ok(!flags.includes("--autocompact"));
});

test("the Haiku window is the constant, not the chairman's 90,000, which would compact below the liaison's current 59k", () => {
  assert.equal(HAIKU_AUTOCOMPACT_WINDOW_TOKENS, 130_000);
  assert.ok(HAIKU_AUTOCOMPACT_WINDOW_TOKENS - 35_000 > 59_000, "the trigger lands above the seat's current context");
  assert.ok(90_000 - 35_000 < 59_000, "a literal 90,000 would trigger at 55,000, under it");
});
