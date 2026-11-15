// @ts-check
// no-token: none -- each scenario runs on a fixture instance of in-memory fakes (`fixture-instance.ts`); nothing is spawned and no account is reached
// module: the fault-injection scenarios (A11-439): each injects one of the board's known faults on a schedule into a fixture instance, lets its workers finish, and reads every run as its card shows it
//
// EVERY SCENARIO ENDS THE SAME WAY. Once its faults are over, the board passes every `PASS_MS` while each run's worker does what a worker does (`Crew`): it starts work when its run starts, ends its turn with a `checked`
// outcome a pass later, and, when herdr brought it back interrupted, carries on only once the board prompts its pane. The passes stop when every run has finished, or after `SETTLE_MS` of the fixture's clock, which is longer than
// every back-off and stall rule of the board (the longest, the third recovery of a crashed run, is two hours). Then every run is read as its card reads (`stuck-runs.ts`).
//
// THE BOARD'S JOURNAL IS KEPT, NOT PRINTED. The pool writes its journal to stderr; while a scenario runs those lines are kept on its result, so the report can quote what the board said of a stuck run and the command's own
// output is the report alone.
import { verdicts, type ScenarioResult } from "./stuck-runs.ts";
import { fixtureInstance, type FixtureInstance } from "./fixture-instance.ts";

/** How often the board passes in a scenario: its own pass is a few seconds, and thirty keeps a scenario short without skipping a rule's window. */
export const PASS_MS = 30_000;

/** The longest a scenario waits, on the fixture's clock, for its runs to finish once its faults are over: past every back-off the board has. */
export const SETTLE_MS = 4 * 3_600_000;

/** The tickets every scenario queues: two, so a fault that reaches one run and not the other shows. */
export const KEYS = ["FIX-1", "FIX-2"] as const;

/** Where a run's scripted worker is: not started yet, at work, interrupted by herdr's restart, done with its turn, or wedged (it never moves again). */
type WorkerState = "fresh" | "working" | "interrupted" | "done" | "wedged";

/** The `checked` outcome each scripted worker ends with: nothing to change, so its run is settled once the board reads it. */
const CHECKED = { kind: "checked", reason: "fault-injection fixture: the scripted worker looked and found nothing to change" } as const;

/** The scripted workers of one fixture, by pane, so a run started again in a new pane gets a fresh worker. */
export type Crew = Readonly<{
  /** Every run's worker takes one step for what the board did in the last pass. */
  step: () => void;
  /** herdr restored every pane: each worker that was at work is interrupted, and carries on only once the board prompts it. */
  interrupt: () => void;
  /** The worker of `key`'s current pane never moves again: its agent stays as herdr last listed it, and it writes nothing. */
  wedge: (key: string) => void;
}>;

/** The crew of `fixture`'s runs. */
function crewOf(fixture: FixtureInstance): Crew {
  const states = new Map<string, WorkerState>();
  const stepOne = (key: string, prompted: ReadonlySet<string>): void => {
    const entry = fixture.entry(key);
    if (entry?.pane === undefined || entry.phase === "finished") return;
    const state = states.get(entry.pane) ?? "fresh";
    if (state === "fresh" || (state === "interrupted" && prompted.has(key))) {
      fixture.working(key);
      states.set(entry.pane, "working");
    } else if (state === "working") {
      fixture.finish(key, CHECKED);
      states.set(entry.pane, "done");
    }
  };
  return {
    step: () => {
      const prompted = new Set(fixture.prompted());
      for (const key of KEYS) stepOne(key, prompted);
    },
    interrupt: () => {
      for (const [pane, state] of states) if (state === "working") states.set(pane, "interrupted");
    },
    wedge: (key) => {
      const pane = fixture.entry(key)?.pane;
      if (pane !== undefined) states.set(pane, "wedged");
    },
  };
}

/** Whether every run of the fixture has finished. */
const allFinished = (fixture: FixtureInstance): boolean => fixture.queue().entries.every((entry) => entry.phase === "finished");

/** Passes, each followed by the workers' step, until every run has finished or `SETTLE_MS` has gone by. */
async function settle(fixture: FixtureInstance, crew: Crew): Promise<void> {
  const until = fixture.now() + SETTLE_MS;
  while (!allFinished(fixture) && fixture.now() < until) {
    await fixture.pass(PASS_MS);
    crew.step();
  }
}

/** Passes for `ms` of the fixture's clock, as the board runs while a fault is on; the workers step after each when `crew` is given, and are gone (herdr's server with them) when it is not. */
async function passFor(fixture: FixtureInstance, ms: number, crew?: Crew): Promise<void> {
  const until = fixture.now() + ms;
  while (fixture.now() < until) {
    await fixture.pass(PASS_MS);
    crew?.step();
  }
}

/** One fault-injection scenario: its name, the faults it injects in words, and what it does to a fixture instance once its runs are queued. */
export type Scenario = Readonly<{ name: string; faults: string; inject: (fixture: FixtureInstance, crew: Crew) => Promise<void> }>;

/** How long Linear answers 5xx in its scenario: through the start of both runs and both of the board's quick retries (30 s, then 2 min). */
const LINEAR_DOWN_MS = 5 * 60_000;

/** How long herdr's server is gone in its scenario before its service brings it back. */
const HERDR_DOWN_MS = 2 * 60_000;

/** The scenarios, in the order the command runs them. */
export const SCENARIOS: readonly Scenario[] = [
  {
    name: "linear-5xx",
    faults: `Linear answers 503 to every call for the first ${LINEAR_DOWN_MS / 60_000} minutes, while both runs start`,
    inject: async (fixture, crew) => {
      fixture.linearDown.on = true;
      await fixture.pass();
      crew.step();
      await passFor(fixture, LINEAR_DOWN_MS, crew);
      fixture.linearDown.on = false;
    },
  },
  {
    name: "herdr-killed",
    faults: `herdr's server is killed while both runs work, and its service brings it back ${HERDR_DOWN_MS / 60_000} minutes later with every pane interrupted`,
    inject: async (fixture, crew) => {
      await fixture.pass();
      crew.step();
      await fixture.pass(PASS_MS);
      fixture.killHerdr();
      await passFor(fixture, HERDR_DOWN_MS);
      fixture.restartHerdr();
      crew.interrupt();
    },
  },
];

/** What the process writes to stderr while `run` runs, kept as lines and not written; stderr is put back however `run` ends. */
async function journalDuring<T>(run: () => Promise<T>): Promise<Readonly<{ value: T; journal: string[] }>> {
  const journal: string[] = [];
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => {
    journal.push(...String(chunk).split("\n").filter((line) => line !== ""));
    return true;
  }) as typeof process.stderr.write;
  try {
    return { value: await run(), journal };
  } finally {
    process.stderr.write = write;
  }
}

/** Runs `scenario` on a fixture instance of its own, which is removed afterwards whatever happens, and reads every run as its card shows it. */
export async function runScenario(scenario: Scenario): Promise<ScenarioResult> {
  const fixture = fixtureInstance({ keys: KEYS });
  try {
    const { value: runs, journal } = await journalDuring(async () => {
      const crew = crewOf(fixture);
      await scenario.inject(fixture, crew);
      await settle(fixture, crew);
      return verdicts(fixture.queue(), fixture.now());
    });
    return { name: scenario.name, faults: scenario.faults, runs, journal };
  } finally {
    fixture.dispose();
  }
}
