// no-token: gh -- nothing here calls `gh` or git; every read, every child and the state are injected
//
// agent-org#1576: THE OUTSIDE HOME OF TRUNK, shipped OFF. EVERY CLAIM HAS ITS NEGATIVE CONTROL: the run that does something beside the run that does nothing (off, paced, answered), and
// the second actor beside the first. `closeOnePr` is the REAL one over a fake `gh` that remembers what it closed, so "finds the work done and does nothing" is read from the sweep
// the job also runs, not from a stand-in. Mutations are in the PR's `.acceptance/` file.
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { closeOnePr } from "./close-rows-sweep.ts";
import { COMMANDS } from "./commands.ts";
import { tmpDir } from "./lib/tmp-fixture.ts";
import { recordRouteOutcomesOnHost } from "./work-gate/route-outcome-pass.ts";
import { INTERVAL_MS, MAX_SHAS_PER_RUN, OUTSIDE_TRUNK_SWITCH, STATE_PATH_ENV, commitChecks, exitCodeOf, liveDeps, outsideTrunk, outsideTrunkOn, windowMinutes, type Check, type Outcome, type OutsideTrunkDeps, type OutsideTrunkState } from "./outside-trunk.ts";

const NOW = 10_000_000_000;
const ON = { [OUTSIDE_TRUNK_SWITCH]: true };
const sha = (n: number): string => String(n).padEnd(40, "a");

/** A rig whose children answer by the table (default 0), whose state is a variable and whose commits are the list; everything it was asked is recorded. */
function rig({ answers, commits, ...over }: Partial<Omit<OutsideTrunkDeps, "commits">> & { answers?: Record<string, number | null>; commits?: string[] | null } = {}) {
  const ran: Check[] = [];
  const said: string[] = [];
  const written: OutsideTrunkState[] = [];
  let state: OutsideTrunkState | null = null;
  const deps: OutsideTrunkDeps = {
    switches: ON, now: NOW, say: (line) => said.push(line),
    readState: () => state,
    writeState: (next) => { state = next; written.push(next); },
    commits: () => (commits === undefined ? [sha(1), sha(2)] : commits),
    run: (check): Outcome => {
      ran.push(check);
      const code = answers?.[check.name] === undefined ? 0 : answers[check.name];
      return { name: check.name, code, line: `${check.name}: exit ${code}` };
    },
    ...over,
  };
  return { deps, ran, said, written, setNow: (now: number) => { deps.now = now; }, state: () => state };
}
const names = (checks: Check[]): string[] => checks.map((c) => c.name);

test("1. OFF IS ABSENT: absent, false and a non-boolean all do nothing at all -- no state read, no git, no child, no line", () => {
  for (const switches of [{}, { [OUTSIDE_TRUNK_SWITCH]: false }, { [OUTSIDE_TRUNK_SWITCH]: "true" as unknown as boolean }, { "outside.other": true }]) {
    const tripwire = (what: string) => () => { throw new Error(`${what} was reached with the flag off`); };
    const result = outsideTrunk({ switches, now: NOW, say: tripwire("say"), readState: tripwire("readState"), writeState: tripwire("writeState"), commits: tripwire("commits"), run: tripwire("run") });
    assert.deepEqual(result, { ran: false, why: "off" });
    assert.equal(outsideTrunkOn(switches), false);
  }
  assert.equal(outsideTrunkOn(ON), true, "CONTROL: the same reader says on for the boolean true");
});

test("2. ON runs the sweep, then each commit's revert guard and liveness, then the board check, and marks the commits answered", () => {
  const { deps, ran, written } = rig();
  const result = outsideTrunk(deps);
  assert.equal(result.ran, true);
  assert.deepEqual(names(ran), ["close-rows-sweep", `trunk-revert-guard ${sha(1).slice(0, 10)}`, `workflow:liveness ${sha(1).slice(0, 10)}`, `trunk-revert-guard ${sha(2).slice(0, 10)}`, `workflow:liveness ${sha(2).slice(0, 10)}`, "board:liveness"]);
  assert.deepEqual(ran[0].args, ["--window=60"], "no state: the default window");
  assert.deepEqual(ran[1].args, [`--merge=${sha(1)}`]);
  assert.deepEqual(ran[2].args, [`--sha=${sha(1)}`]);
  assert.deepEqual(ran.at(-1)?.args, ["--post"]);
  assert.deepEqual(written, [{ at: NOW, checked: { [sha(1)]: true, [sha(2)]: true }, owed: [] }]);
});

test("3. THE SECOND ACTOR DOES NOTHING TWICE: the same commits asked again run the sweep and the board check and no commit check", () => {
  const { deps, ran, state } = rig();
  outsideTrunk(deps);
  const first = ran.length;
  assert.equal(first, 6, "CONTROL: the first run asked both commits (the population the second run is the negative of)");
  ran.length = 0;
  const second = outsideTrunk({ ...deps, force: true, now: NOW + 1000 });
  assert.deepEqual(names(ran), ["close-rows-sweep", "board:liveness"]);
  assert.equal(second.ran && second.skipped, 0);
  assert.deepEqual(state()?.checked, { [sha(1)]: true, [sha(2)]: true });
});

test("4. THE SWEEP IS THE REAL ONE: a row it closed is found closed by the next actor, which closes nothing", () => {
  const closes: number[] = [];
  const open = new Set([4630]);
  const gh_ = (args: string[]): string => {
    if (args[0] === "api" && args[1] === "graphql") {
      return JSON.stringify({ mergedAt: "2026-10-10T18:00:00Z", mergeCommit: { oid: "abc1234" }, closingIssuesReferences: { nodes: [{ number: 4630, state: open.has(4630) ? "OPEN" : "CLOSED", title: "Row 4630",
        body: "## Region\n\nsrc/foo.ts\n\n## Done-when\n\n1. The tests pass.\n2. The README names the flag.\n", milestone: { title: "Out of release" }, parent: { number: 3900 },
        labels: { nodes: [{ name: "lane:any" }] }, timelineItems: { nodes: [] } }] } });
    }
    if (args[0] === "issue" && args[1] === "close") { closes.push(Number(args[2])); open.delete(Number(args[2])); return ""; }
    throw new Error(`fake gh was asked something it does not know: ${args.join(" ")}`);
  };
  const verify = { findExisting: () => null, create: () => { throw new Error("a verify row was filed"); }, blockBy: () => {}, addSubIssue: () => {}, board: () => null };
  const actor = () => {
    const log = console.log;
    console.log = () => {};
    try {
      return closeOnePr(900, "o/r", { gh_, strip: () => {}, settle: () => ({ settled: true, refused: [] }), verify });
    } finally {
      console.log = log;
    }
  };
  assert.deepEqual(actor(), { failed: [], unsettled: [], skipped: [] });
  assert.deepEqual(closes, [4630], "CONTROL: the first actor closed the row");
  assert.deepEqual(actor(), { failed: [], unsettled: [], skipped: [] });
  assert.deepEqual(closes, [4630], "the second actor found it closed and closed nothing");
});

test("5. PACING: a second run inside the interval does nothing, one at the interval runs, and --force ignores it", () => {
  const { deps, ran } = rig();
  outsideTrunk(deps);
  ran.length = 0;
  assert.deepEqual(outsideTrunk({ ...deps, now: NOW + INTERVAL_MS - 1 }), { ran: false, why: "paced" });
  assert.deepEqual(ran, []);
  assert.equal(outsideTrunk({ ...deps, now: NOW + INTERVAL_MS }).ran, true, "CONTROL: at the interval it runs");
  ran.length = 0;
  assert.equal(outsideTrunk({ ...deps, now: NOW + INTERVAL_MS + 1, force: true }).ran, true, "forced inside the interval");
});

test("6. A COMMIT IS ANSWERED ONLY BY VERDICTS: a refusal (1) is an answer, a could-not-ask (2), a timeout (null) and a failed start are asked again", () => {
  const refuse = { [`trunk-revert-guard ${sha(1).slice(0, 10)}`]: 1 };
  const cannot = { [`workflow:liveness ${sha(2).slice(0, 10)}`]: 2 };
  const { deps, ran, state } = rig({ answers: { ...refuse, ...cannot } });
  const result = outsideTrunk(deps);
  assert.deepEqual(state()?.checked, { [sha(1)]: true }, "the refused commit is answered; the one whose liveness could not be asked is not");
  assert.equal(exitCodeOf(result), 2);
  ran.length = 0;
  outsideTrunk({ ...deps, force: true, now: NOW + 1 });
  assert.deepEqual(names(ran).filter((n) => n.includes(sha(2).slice(0, 10))), [`trunk-revert-guard ${sha(2).slice(0, 10)}`, `workflow:liveness ${sha(2).slice(0, 10)}`], "only the unanswered commit is asked again");
  const timedOut = rig({ answers: { [`trunk-revert-guard ${sha(1).slice(0, 10)}`]: null } });
  outsideTrunk(timedOut.deps);
  assert.equal(timedOut.state()?.checked[sha(1)], undefined, "a child with no exit code is not an answer");
  assert.deepEqual(timedOut.state()?.owed, [sha(1)], "and it is kept owed by name");
});

test("7. A LONG WINDOW IS TAKEN IN PARTS: only MAX_SHAS_PER_RUN commits are asked and the rest are reported skipped, then asked next run", () => {
  const many = Array.from({ length: MAX_SHAS_PER_RUN + 2 }, (_, i) => sha(i + 1));
  const { deps, ran, state } = rig({ commits: many });
  const first = outsideTrunk(deps);
  assert.equal(first.ran && first.skipped, 2);
  assert.equal(Object.keys(state()?.checked ?? {}).length, MAX_SHAS_PER_RUN);
  ran.length = 0;
  const second = outsideTrunk({ ...deps, force: true, now: NOW + 1 });
  assert.equal(second.ran && second.skipped, 0);
  assert.deepEqual(names(ran).filter((n) => n.startsWith("trunk-revert-guard")), many.slice(MAX_SHAS_PER_RUN).map((s) => `trunk-revert-guard ${s.slice(0, 10)}`));
});

test("7b. AN UNANSWERED COMMIT OUTLIVES THE WINDOW: `at` moves on every run, so the commit is kept owed by name and asked again after a real `git log --since` would no longer reach it", () => {
  const minute = 60_000;
  const committedAt: Record<string, number> = { [sha(1)]: NOW - 20 * minute, [sha(2)]: NOW - 19 * minute };
  // The commits the way the live read gives them: those newer than the window, oldest first.
  const reach = (clock: () => number) => (minutes: number): string[] => Object.keys(committedAt).filter((s) => committedAt[s] >= clock() - minutes * minute);
  const failing = { [`workflow:liveness ${sha(2).slice(0, 10)}`]: 2 } as Record<string, number | null>;
  const { deps, ran, state } = rig({ answers: failing });
  let clock = NOW;
  deps.commits = reach(() => clock);
  outsideTrunk(deps);
  assert.deepEqual(state()?.owed, [sha(2)], "the run that could not ask left the commit owed");
  const later = NOW + 3 * 3_600_000;
  clock = later;
  assert.deepEqual(deps.commits(windowMinutes(NOW, later)), [], "CONTROL: three hours on, the window no longer reaches either commit (what the live read does)");
  ran.length = 0;
  failing[`workflow:liveness ${sha(2).slice(0, 10)}`] = 0;
  outsideTrunk({ ...deps, force: true, now: later });
  assert.deepEqual(names(ran).filter((n) => n.includes(sha(2).slice(0, 10))), [`trunk-revert-guard ${sha(2).slice(0, 10)}`, `workflow:liveness ${sha(2).slice(0, 10)}`], "it is asked again though no window reaches it");
  assert.deepEqual(names(ran).filter((n) => n.includes(sha(1).slice(0, 10))), [], "the answered commit is not");
  assert.deepEqual(state()?.owed, [], "and it is no longer owed");
});

test("7c. NO OWED COMMIT IS DROPPED, AND ONE THAT CANNOT BE ASKED DOES NOT STARVE THE REST: a long backlog is kept whole, and the unanswerable ones go to the back", () => {
  const many = Array.from({ length: 250 }, (_, i) => sha(i + 1));
  const stuck = new Set(many.slice(0, MAX_SHAS_PER_RUN));
  const answers: Record<string, number | null> = {};
  for (const s of stuck) answers[`trunk-revert-guard ${s.slice(0, 10)}`] = 2;
  const { deps, said, state, ran } = rig({ commits: many, answers });
  outsideTrunk(deps);
  assert.equal(state()?.owed.length, 250, "every commit is still owed or answered: 250 asked-or-waiting, none dropped (5 asked and stuck, 245 waiting)");
  assert.deepEqual(said.filter((l) => /dropped/.test(l)), []);
  assert.deepEqual(state()?.owed.slice(-MAX_SHAS_PER_RUN), [...stuck], "the stuck ones went to the back");
  ran.length = 0;
  outsideTrunk({ ...deps, force: true, now: NOW + 1 });
  const asked = names(ran).filter((n) => n.startsWith("trunk-revert-guard"));
  assert.deepEqual(asked, many.slice(MAX_SHAS_PER_RUN, 2 * MAX_SHAS_PER_RUN).map((s) => `trunk-revert-guard ${s.slice(0, 10)}`), "the next run asks the ones behind, not the stuck five again");
});

test("7d. THE STATE FILE: OUTSIDE_TRUNK_STATE names it with no host declaration, it round-trips owed, and an unreadable one is said, not silent", () => {
  const dir = tmpDir("outside-trunk-state-");
  const path = `${dir}/state.json`;
  const saved = process.env[STATE_PATH_ENV];
  process.env[STATE_PATH_ENV] = path;
  try {
    const said: string[] = [];
    const live = liveDeps({ switches: ON, say: (line) => said.push(line) });
    assert.equal(live.readState(), null, "no file is a first run, quietly");
    assert.deepEqual(said, []);
    live.writeState({ at: 5, checked: { [sha(1)]: true }, owed: [sha(2)] });
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { at: 5, checked: { [sha(1)]: true }, owed: [sha(2)] });
    assert.deepEqual(live.readState(), { at: 5, checked: { [sha(1)]: true }, owed: [sha(2)] });
    writeFileSync(path, "{not json");
    assert.equal(live.readState(), null);
    assert.match(said.join("\n"), /state file is not a state/, "CONTROL: a file that is there and unreadable is said");
    writeFileSync(path, JSON.stringify({ at: 5, checked: {} }));
    assert.deepEqual(live.readState(), { at: 5, checked: {}, owed: [] }, "a state from before `owed` reads with none owed");
  } finally {
    if (saved === undefined) delete process.env[STATE_PATH_ENV]; else process.env[STATE_PATH_ENV] = saved;
  }
});

test("8. COMMITS THAT CANNOT BE READ: nothing runs, nothing is written, and the line says so", () => {
  const { deps, ran, said, written } = rig({ commits: null });
  assert.deepEqual(outsideTrunk(deps), { ran: false, why: "commits-unreadable" });
  assert.deepEqual([ran, written], [[], []]);
  assert.match(said.join("\n"), /could not be read, so nothing ran/);
});

test("9. THE WINDOW is since the last run with ten minutes over, bounded to 30 minutes and a day, and 60 with no run", () => {
  assert.equal(windowMinutes(null, NOW), 60);
  assert.equal(windowMinutes(NOW - 10 * 60_000, NOW), 30);
  assert.equal(windowMinutes(NOW - 50 * 60_000, NOW), 60);
  assert.equal(windowMinutes(NOW - 10 * 24 * 3_600_000, NOW), 1440);
  assert.equal(windowMinutes(NOW + 1, NOW), 60, "a state from the future is no state");
});

test("10. THE EXIT: 0 for a clean run and for one that did not happen, 1 for a refusal or a close that failed, 2 when a check could not ask", () => {
  const ranWith = (...codes: (number | null)[]) => ({ ran: true as const, skipped: 0, outcomes: codes.map((code, i) => ({ name: `c${i}`, code, line: "" })) });
  assert.equal(exitCodeOf({ ran: false, why: "off" }), 0);
  assert.equal(exitCodeOf(ranWith(0, 0)), 0);
  assert.equal(exitCodeOf(ranWith(0, 1)), 1);
  assert.equal(exitCodeOf(ranWith(1, 2)), 2);
  assert.equal(exitCodeOf(ranWith(0, null)), 2);
});

test("11. WIRING: every script the checks name exists beside the module and is a registered command, the gate calls the home, and the flag key is spelled once", () => {
  const scripts = [...commitChecks(sha(1)), { script: "close-rows-sweep.ts" }, { script: "board-schedule-liveness.ts" }].map((c) => c.script);
  assert.equal(scripts.length, 4, "CONTROL: the list that is checked is not empty");
  for (const script of scripts) {
    assert.ok(existsSync(new URL(`./${script}`, import.meta.url)), `${script} exists`);
    assert.ok(Object.values(COMMANDS).includes(script), `${script} is a registered command`);
  }
  assert.equal(COMMANDS["outside-trunk"], "outside-trunk.ts");
  assert.equal(OUTSIDE_TRUNK_SWITCH, "outside.trunk");
});

test("12. THE GATE'S CALL IS MADE: the host pass hands the home the switches it read, once per tick, on and off alike, and a listing it did not complete does not stop it", () => {
  for (const switches of [{ [OUTSIDE_TRUNK_SWITCH]: true }, {}]) {
    for (const listed of [true, false]) {
      const handed: unknown[] = [];
      let reads = 0;
      const result = recordRouteOutcomesOnHost({ listed, gh: () => { throw new Error("gh was asked"); }, readSwitchesOf: () => { reads++; return switches; }, outside: (given) => { handed.push(given); } });
      assert.equal(reads, 1, "the switches are read once and shared");
      assert.deepEqual(handed, [switches], "the home got the very switches that were read");
      assert.deepEqual(result, { written: [], owed: 0 });
    }
  }
  const failed = recordRouteOutcomesOnHost({ listed: true, gh: () => "", readSwitchesOf: () => ON, outside: () => { throw new Error("the home blew up"); } });
  assert.deepEqual(failed, { written: [], owed: 0 }, "CONTROL: a home that throws is caught by the pass's own guard and the tick goes on");
});
