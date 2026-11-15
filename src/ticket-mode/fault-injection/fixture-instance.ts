// @ts-check
// no-token: none -- the tracker, the code host and herdr are in-memory fakes, the clock is the fixture's, and every file is in a throwaway directory
// module: the fixture instance a fault-injection scenario runs on (A11-439): ticket:capture's throwaway host, a board pool over fakes, and a scripted worker for each run
//
// THE HOST FILE IS TICKET:CAPTURE'S. `captureHost` (`capture.ts`) builds the throwaway host file a capture starts the board from, and the instance reads it back through `readTicketSettings`, the reader the real instance uses,
// so a key renamed in either breaks the fixture and not a scenario. Its state folder, its one clone and its key path are inside a fresh throwaway directory, which `dispose` removes. The pool is the board's own (`createPool`),
// with every seam that would reach the machine given a fake: the tracker contract's in-memory fake behind `faultyTracker`, the code host contract's in-memory fake, the pool tests' herdr behind `faultyHerdr`, an update drain held in memory,
// a herdr service that only records that it was asked to start, and a `deps.git` that refuses. Nothing reaches a real tracker, a real code host, a real account, the machine's services or its herdr. The one process the pool
// still starts is a read-only `git remote get-url origin` in the throwaway clone (`reviewer-port.ts`'s `originOf` runs git itself, not through `deps.git`), which answers that the folder is no repository.
//
// THE CLOCK IS THE FIXTURE'S. `pass(ms)` moves it and runs one pass of the board, then the reads that pass began (`startReadsSettled`), so a scenario reads the board as a person would see it after that pass.
//
// A RUN'S WORKER IS SCRIPTED. `working(key)` shows its agent at work, `finish(key, outcome)` writes its outcome file at the fixture's time and leaves its agent idle, as a worker that ends its turn does. `prompted()` names
// the runs whose pane the board has prompted since herdr last started; the scenarios' crew (`scenarios.ts`) resumes an interrupted worker only then, so a run the board never prompts stays where it is.
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureHost } from "../capture.ts";
import { createCallLedger, type CallLedger } from "../call-outcomes.ts";
import { createPool, herdrName, type PoolDeps, type QueueStore } from "../pool.ts";
import { enqueue, type Queue } from "../queue/queue-entries-and-outcomes.ts";
import { resumeQueue } from "../queue/queue-transitions.ts";
import { emptyQueue } from "../queue.ts";
import { HOST_FILE_ENV, readTicketSettings, type TicketSettings } from "../settings.ts";
import { ticketDir } from "../ticket-paths.ts";
import type { DrainStore } from "../pool-drain.ts";
import { createFakeCodeHost } from "../../plugins/fakes/code-host.ts";
import { createFakeTracker, fakeTicket } from "../../plugins/fakes/tracker.ts";
import { faultyTracker, type FaultSwitch } from "./fault-tracker.ts";
import { faultyHerdr, type FaultyHerdr } from "./fault-herdr.ts";

/** When every scenario's clock starts: a fixed instant, so two runs of a scenario log the same times. */
export const FIXTURE_START = Date.UTC(2026, 10, 1, 9, 0, 0);

/** The ports the throwaway host file names. Nothing listens on them: the fixture starts no server. */
const PORTS = { port: 47_901, uiPort: 47_902 } as const;

/** What a scenario's fixture is made with: the tickets queued, and how many runs may go at once. */
export type FixtureOptions = Readonly<{ keys: readonly string[]; max?: number }>;

/** The update drain, held in memory: no update is draining unless a scenario writes one. */
function memoryDrain(): DrainStore {
  let current: ReturnType<DrainStore["read"]> = { kind: "none" };
  return { read: () => current, write: (record) => { current = { kind: "draining", record }; } };
}

/** The throwaway host file, written into `dir` and read back the way the instance reads its own. */
function throwawaySettings(dir: string): Readonly<{ settings: TicketSettings; hostPath: string }> {
  const stateDir = join(dir, "state");
  const binDir = join(dir, "bin");
  const checkout = join(dir, "clone");
  for (const made of [join(stateDir, "tickets"), binDir, checkout]) mkdirSync(made, { recursive: true });
  const hostPath = join(dir, "host.json");
  writeFileSync(hostPath, `${JSON.stringify(captureHost({ checkout, stateDir, binDir, ...PORTS, keyPath: join(dir, "linear-key") }), null, 2)}\n`, { mode: 0o600 });
  return { settings: readTicketSettings({ [HOST_FILE_ENV]: hostPath }, undefined, dir), hostPath };
}

/** `make()`, with `dir` removed when it throws, so a fixture that could not be built leaves no folder behind. */
function removedOnThrow<T>(dir: string, make: () => T): T {
  try {
    return make();
  } catch (err) {
    rmSync(dir, { recursive: true, force: true });
    throw err;
  }
}

/** The fixture instance: its board, its fakes, its faults, its clock and its scripted workers. */
export function fixtureInstance({ keys, max = keys.length }: FixtureOptions) {
  const dir = mkdtempSync(join(tmpdir(), "agent-org-fault-"));
  const { settings, hostPath } = removedOnThrow(dir, () => throwawaySettings(dir));
  const clock = { now: FIXTURE_START };
  const now = () => clock.now;
  const calls: CallLedger = createCallLedger(now);
  const linearDown: FaultSwitch = { on: false };
  const tracker = createFakeTracker(keys.map((key) => fakeTicket(key)));
  const source = faultyTracker(tracker, linearDown, calls);
  const herdr: FaultyHerdr = faultyHerdr();
  const serviceStarts: number[] = [];
  let queue: Queue = resumeQueue(enqueue(emptyQueue(max), keys.map((key) => fakeTicket(key)), { model: "sonnet", effort: "high" }, clock.now));
  const store: QueueStore = { get: () => queue, set: (next) => { queue = next; } };
  const deps: PoolDeps = {
    settings, source, codeHost: createFakeCodeHost(), hook: { node: "/fixture/node", bin: join(dir, "tool", "src", "bin.ts") }, herdr: herdr.run, hostFile: hostPath, now,
    load: () => ({ load: 1, cores: 8 }), transcriptsRoot: join(dir, "transcripts"), pluginRecord: join(dir, "no-plugin-record.json"), wait: async () => {},
    herdrService: { registered: () => true, start: () => { serviceStarts.push(clock.now); } },
    git: async (_cwd, args) => { throw new Error(`the fixture runs no git (git ${args.join(" ")})`); },
    restartReads: herdr.restartReads, calls, paneEnv: (pane) => herdr.envs.get(pane) ?? null, drain: memoryDrain(), startUpdate: () => {},
  };
  const pool = createPool(store, deps);
  const entry = (key: string) => queue.entries.find((one) => one.ticket.key === key);
  /** Moves the clock by `ms` and runs one pass of the board, then the reads it began. */
  const pass = async (ms = 0): Promise<void> => {
    clock.now += ms;
    await pool.tick();
    await pool.startReadsSettled();
  };
  /** Shows `key`'s agent at work. */
  const working = (key: string): void => { herdr.status.set(herdrName(key), "working"); };
  /** `key`'s worker writes `outcome` at the fixture's time and ends its turn. */
  const finish = (key: string, outcome: Readonly<Record<string, unknown>>): void => {
    const file = join(ticketDir(settings, key), "outcome.json");
    mkdirSync(ticketDir(settings, key), { recursive: true });
    writeFileSync(file, JSON.stringify(outcome));
    utimesSync(file, new Date(clock.now), new Date(clock.now));
    herdr.status.set(herdrName(key), "idle");
  };
  /** The keys whose pane the board has prompted since herdr last started. */
  const prompted = (): string[] => keys.filter((key) => {
    const pane = entry(key)?.pane;
    return pane !== undefined && (herdr.prompts.get(pane) ?? []).length > 0;
  });
  /** The panes of the runs that hold one, by herdr label. */
  const panes = (): Map<string, string> => new Map(keys.flatMap((key) => {
    const pane = entry(key)?.pane;
    return pane === undefined ? [] : [[herdrName(key), pane] as const];
  }));
  /** herdr's server dies: every call fails. */
  const killHerdr = (): void => herdr.kill();
  /** herdr's service starts again: every pane restored, idle, interrupted, its environment gone. The prompts the board sent before are forgotten. */
  const restartHerdr = (): void => {
    herdr.prompts.clear();
    herdr.restart(panes());
  };
  const dispose = (): void => rmSync(dir, { recursive: true, force: true });
  return { dir, settings, store, queue: () => queue, entry, pool, pass, working, finish, prompted, killHerdr, restartHerdr, herdr, linearDown, tracker, calls, serviceStarts, now, dispose };
}

export type FixtureInstance = ReturnType<typeof fixtureInstance>;
