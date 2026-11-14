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
// THE CLOCK IS THE FIXTURE'S. `pass(ms)` moves it and runs one pass of the board, then the reads that pass began (`startReadsSettled`), then the server's sweeps that are due on their own cadence: the tracker's read of each finished
// run's ticket and pull requests every `TRACKER_MS` (`refreshTracker`), and the watch of the finished runs' pull requests every `FEEDBACK_MS` (`watchFeedback`, with the sweep it starts), so a scenario reads the board as a person would see it after that pass. Then GitHub moves the pull requests as it would have meanwhile (`fault-pulls.ts`).
//
// AN UPDATE RESTARTS THE INSTANCE (A11-294). `restartOnStart(key)` arms the restart an update makes: the next time the board opens `key`'s workspace, the instance is gone. From then on that pool's writes to the queue are lost and its
// herdr calls fail, as a process that has exited writes and calls nothing, and `restart()` starts a pool on the new version over the same queue file, herdr and state folder, and reconciles it as the instance does when it starts.
//
// A RUN'S WORKER IS SCRIPTED. `working(key)` shows its agent at work, `finish(key, outcome)` writes its outcome file at the fixture's time and leaves its agent idle, as a worker that ends its turn does. `prompted()` names
// the runs whose pane the board has prompted since herdr last started; the scenarios' crew (`scenarios.ts`) resumes an interrupted worker only then, so a run the board never prompts stays where it is.
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureHost } from "../capture.ts";
import { createCallLedger, type CallLedger } from "../call-outcomes.ts";
import { createPool, herdrName, type Herdr, type PoolDeps, type QueueStore } from "../pool.ts";
import { enqueue, type Queue } from "../queue/queue-entries-and-outcomes.ts";
import { resumeQueue } from "../queue/queue-transitions.ts";
import { FEEDBACK_MS, TRACKER_MS } from "../server.ts";
import { emptyQueue } from "../queue.ts";
import { HOST_FILE_ENV, readTicketSettings, type TicketSettings } from "../settings.ts";
import { ticketDir } from "../ticket-paths.ts";
import type { DrainStore } from "../pool-drain.ts";
import { createFakeCodeHost } from "../../plugins/fakes/code-host.ts";
import { createFakeTracker, fakeTicket } from "../../plugins/fakes/tracker.ts";
import { faultyTracker, type FaultSwitch } from "./fault-tracker.ts";
import { faultyHerdr, type FaultyHerdr } from "./fault-herdr.ts";
import { pullWorld } from "./fault-pulls.ts";

/** When every scenario's clock starts: a fixed instant, so two runs of a scenario log the same times. */
export const FIXTURE_START = Date.UTC(2026, 10, 1, 9, 0, 0);

/** The ports the throwaway host file names. Nothing listens on them: the fixture starts no server. */
const PORTS = { port: 47_901, uiPort: 47_902 } as const;

/** What the herdr calls of an instance that is gone fail with, and what the write that ended it threw. */
const INSTANCE_GONE = "the instance was restarted by an update";

/** One instance of the board: whether its process is still running. A restart leaves the old one's flag false for ever. */
type Life = { alive: boolean };

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

/** The queue file, held in memory: every instance of the fixture reads it, and the running one writes it. */
type QueueHold = { current: Queue };

/** The fixture's clock, which only a pass moves. */
type Clock = { now: number };

/**
 * The board's instances over one queue and one herdr, an update apart. The running one's pool is `pool()`. `restartOnStart(key)` arms the update's restart on the next `workspace create` of `key`'s: that call ends the instance, and from then
 * on its writes to the queue are lost and its herdr calls fail. `restart()` starts the next version's instance and reconciles it.
 */
function instancesOf(hold: QueueHold, deps: PoolDeps, herdr: FaultyHerdr, dir: string) {
  /** The label whose `workspace create` the armed restart lands on, or null for none armed. */
  const restartAt: { label: string | null } = { label: null };
  const storeOf = (life: Life): QueueStore => ({ get: () => hold.current, set: (next) => { if (life.alive) hold.current = next; } });
  const herdrOf = (life: Life): Herdr => (args) => {
    if (restartAt.label !== null && args.includes("create") && args.includes(restartAt.label)) {
      restartAt.label = null;
      life.alive = false;
      // Said in the board's journal, so a line the dead instance's pending work writes after this is not read as the board's word on a run.
      process.stderr.write(`fault-injection: ${INSTANCE_GONE}; what that instance says after this is lost with it\n`);
    }
    if (!life.alive) throw new Error(INSTANCE_GONE);
    return herdr.run(args);
  };
  const poolOf = (life: Life, version: number) => createPool(storeOf(life), { ...deps, herdr: herdrOf(life), hook: { ...deps.hook, bin: join(dir, `tool-${version}`, "src", "bin.ts") } });
  const running = { life: { alive: true } as Life, version: 1 };
  let pool = poolOf(running.life, running.version);
  return {
    pool: () => pool,
    /** The running instance's life, whose `alive` turns false when the restart lands on it. */
    life: () => running.life,
    /** The next time the board opens `key`'s workspace, an update restarts the instance. */
    restartOnStart: (key: string): void => { restartAt.label = herdrName(key); },
    /** The instance starts again on the next version, over the same queue, herdr and state folder, and reconciles what it finds, as it does when it starts. */
    restart: async (): Promise<void> => {
      running.life.alive = false;
      running.life = { alive: true };
      running.version += 1;
      pool = poolOf(running.life, running.version);
      await pool.reconcile();
    },
  };
}

/** The server's sweeps that are due at the clock's time, on the pool `pool()` answers: the tracker's read every `TRACKER_MS`, and the watch of the finished runs' pull requests every `FEEDBACK_MS`, with the sweep it starts. */
function sweepsOf(clock: Clock, pool: () => ReturnType<typeof createPool>): () => Promise<void> {
  const swept = { tracker: clock.now, feedback: clock.now };
  return async () => {
    if (clock.now - swept.tracker >= TRACKER_MS) {
      swept.tracker = clock.now;
      await pool().refreshTracker();
    }
    if (clock.now - swept.feedback >= FEEDBACK_MS) {
      swept.feedback = clock.now;
      await pool().watchFeedback();
      await pool().keptWatchDone();
    }
  };
}

/** What the scripted workers of `keys` do in herdr and in their ticket folders, and herdr's faults: its server killed, and its service starting again. */
function workersOf(keys: readonly string[], settings: TicketSettings, herdr: FaultyHerdr, clock: Clock, hold: QueueHold) {
  const paneOf = (key: string): string | undefined => hold.current.entries.find((one) => one.ticket.key === key)?.pane;
  /** The panes of the runs that hold one, by herdr label. */
  const panes = (): Map<string, string> => new Map(keys.flatMap((key) => {
    const pane = paneOf(key);
    return pane === undefined ? [] : [[herdrName(key), pane] as const];
  }));
  return {
    /** Shows `key`'s agent at work. */
    working: (key: string): void => { herdr.status.set(herdrName(key), "working"); },
    /** `key`'s worker writes `outcome` at the fixture's time and ends its turn. */
    finish: (key: string, outcome: Readonly<Record<string, unknown>>): void => {
      const file = join(ticketDir(settings, key), "outcome.json");
      mkdirSync(ticketDir(settings, key), { recursive: true });
      writeFileSync(file, JSON.stringify(outcome));
      utimesSync(file, new Date(clock.now), new Date(clock.now));
      herdr.status.set(herdrName(key), "idle");
    },
    /** The keys whose pane the board has prompted since herdr last started. */
    prompted: (): string[] => keys.filter((key) => {
      const pane = paneOf(key);
      return pane !== undefined && (herdr.prompts.get(pane) ?? []).length > 0;
    }),
    /** herdr's server dies: every call fails. */
    killHerdr: (): void => herdr.kill(),
    /** herdr's service starts again: every pane restored, idle, interrupted, its environment gone. The prompts the board sent before are forgotten. */
    restartHerdr: (): void => {
      herdr.prompts.clear();
      herdr.restart(panes());
    },
  };
}

/** The fixture instance: its board, its fakes, its faults, its clock and its scripted workers. */
export function fixtureInstance({ keys, max = keys.length }: FixtureOptions) {
  const dir = mkdtempSync(join(tmpdir(), "agent-org-fault-"));
  const { settings, hostPath } = removedOnThrow(dir, () => throwawaySettings(dir));
  const clock: Clock = { now: FIXTURE_START };
  const now = () => clock.now;
  const calls: CallLedger = createCallLedger(now);
  const linearDown: FaultSwitch = { on: false };
  const tracker = createFakeTracker(keys.map((key) => fakeTicket(key)));
  const herdr: FaultyHerdr = faultyHerdr();
  const serviceStarts: number[] = [];
  const codeHost = createFakeCodeHost("fixture-worker");
  const pulls = pullWorld(codeHost, tracker);
  const hold: QueueHold = { current: resumeQueue(enqueue(emptyQueue(max), keys.map((key) => fakeTicket(key)), { model: "sonnet", effort: "high" }, clock.now)) };
  const deps: PoolDeps = {
    settings, source: faultyTracker(tracker, linearDown, calls), codeHost, hook: { node: "/fixture/node", bin: join(dir, "tool", "src", "bin.ts") }, herdr: herdr.run, hostFile: hostPath, now,
    load: () => ({ load: 1, cores: 8 }), transcriptsRoot: join(dir, "transcripts"), pluginRecord: join(dir, "no-plugin-record.json"), wait: async () => {},
    herdrService: { registered: () => true, start: () => { serviceStarts.push(clock.now); } },
    git: async (_cwd, args) => { throw new Error(`the fixture runs no git (git ${args.join(" ")})`); },
    restartReads: herdr.restartReads, calls, paneEnv: (pane) => herdr.envs.get(pane) ?? null, drain: memoryDrain(), startUpdate: () => {},
  };
  const instances = instancesOf(hold, deps, herdr, dir);
  const sweepWhenDue = sweepsOf(clock, instances.pool);
  /** Moves the clock by `ms` and runs one pass of the board, the reads it began, and the sweeps that are due; then GitHub moves the pull requests. A pass the restart lands on ends where the instance did. */
  const pass = async (ms = 0): Promise<void> => {
    clock.now += ms;
    const life = instances.life();
    try {
      await instances.pool().tick();
      await instances.pool().startReadsSettled();
      await sweepWhenDue();
    } catch (err) {
      if (life.alive) throw err;
    }
    pulls.step();
  };
  const entry = (key: string) => hold.current.entries.find((one) => one.ticket.key === key);
  const dispose = (): void => rmSync(dir, { recursive: true, force: true });
  return {
    dir, settings, queue: () => hold.current, entry, pool: instances.pool, pass, restartOnStart: instances.restartOnStart, restart: instances.restart, ...workersOf(keys, settings, herdr, clock, hold),
    herdr, linearDown, tracker, codeHost, pulls, calls, serviceStarts, now, dispose,
  };
}

export type FixtureInstance = ReturnType<typeof fixtureInstance>;
