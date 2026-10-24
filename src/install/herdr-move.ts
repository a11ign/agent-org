// @ts-check
// module: `agent-org start herdr [--move]` -- start herdr's own service, and the one-time move of a server that runs outside it (A11-169)
//
// A SERVER THAT RUNS OUTSIDE THE UNIT is one an older instance started inside its own cgroup, or in the transient scope the `systemd-run` branch made. Moving it ends every pane and agent in it
// (herdr restores the workspaces and resumes each worker with `claude --resume`, but a worker mid-tool-call loses that call), so it is done once, on purpose, at a quiet moment:
// without `--move`, `start herdr` refuses while such a server runs and says how many runs are live; with it, the server is stopped (`herdr --session <s> server stop`), the unit is started,
// and the interim guards are retired on their proof (`interim-guards.ts`): the `keep-herdr.conf` drop-in because herdr now runs in its own unit. A server already in the unit is left running,
// and a start never restarts it.
import { rmSync } from "node:fs";
import { dirname } from "node:path";
import { homedir } from "node:os";
import { retireGuards, replacementsNow, type GuardDeps } from "./interim-guards.ts";
import { hostHerdrPlace, type HerdrPlace } from "./herdr-place.ts";
import { defaultServiceDeps, herdrSessionOfHost, ServiceRefusal, startService, unitFor, type Started, type ServiceDeps } from "./service.ts";
import { readLiveRuns } from "./instance-queue.ts";
import { MS_PER_SECOND, withinTime } from "./time-limit.ts";

export type MoveDeps = Readonly<{
  services: ServiceDeps;
  /** The runs the instance has live, or null when its queue cannot be read. */
  liveRuns: () => number | null;
  /** Where the server of `session` runs now. */
  placeOf: (session: string) => HerdrPlace;
  /** Retire the interim guards on their proof. */
  retire: () => Promise<string[]>;
  wait: (ms: number) => Promise<void>;
  /** How long the unit's start and the guards' retirement may each take, in ms. Default 60 s; a test passes a short one. */
  limitMs?: number;
}>;

const STOP_TRIES = 20;
const STOP_WAIT_MS = 500;
/** How long the unit's start and the guards' retirement may take, each, before the move says which one did not finish (A11-225). */
const DEFAULT_LIMIT_MS = 60_000;
const MOVE_STEPS = 4;
const STEP = { register: 1, stop: 2, start: 3, answer: 4 } as const;

const running = (live: number | null): string => (live === null ? "the queue cannot be read, so how many runs are live is not known" : `${live} ${live === 1 ? "run is" : "runs are"} live`);

function whereOf(place: HerdrPlace): string {
  return place.kind === "instance" || place.kind === "elsewhere" || place.kind === "unit" ? place.where : place.kind;
}

/**
 * Start herdr's service. REFUSES, naming the live runs, while a server runs outside the unit and `move` is not given. With `move` it runs four steps, each said through `say` as it finishes
 * (so a failure or a hang leaves the earlier steps on screen): the unit is registered, the server outside it is stopped, the unit is started, and the server is seen answering in it. Then the guards
 * are retired and a result line ends it. A step that fails refuses with its number, what it was doing and the fix. Every wait is bounded.
 */
export async function startHerdr({ move }: { move: boolean }, deps: MoveDeps, say: (line: string) => void = () => undefined): Promise<Started> {
  const session = herdrSessionOfHost(deps.services);
  const limitMs = deps.limitMs ?? DEFAULT_LIMIT_MS;
  const place = deps.placeOf(session);
  const outside = place.kind === "instance" || place.kind === "elsewhere";
  if (place.kind === "unknown" && !move) {
    throw new ServiceRefusal(`where the herdr server for session ${session} runs cannot be read (${place.why}), so it is not started. Run \`agent-org start herdr --move\` to stop whatever runs and start the unit`);
  }
  if (outside && !move) {
    throw new ServiceRefusal(`the herdr server for session ${session} runs outside agent-org-herdr.service (${whereOf(place)}), and moving it ends every pane and agent in it: ${running(deps.liveRuns())}. `
      + "Run `agent-org start herdr --move` at a quiet moment");
  }
  if (!move) return withinTime(limitMs, "starting the herdr unit", startService("herdr", deps.services));
  return moveHerdr({ session, place, outside }, deps, say);
}

/** The move: the four steps, the guards' retirement and the result line, said through `say` as each finishes. */
async function moveHerdr({ session, place, outside }: { session: string; place: HerdrPlace; outside: boolean }, deps: MoveDeps, say: (line: string) => void): Promise<Started> {
  const limitMs = deps.limitMs ?? DEFAULT_LIMIT_MS;
  const unit = unitFor("herdr", deps.services);
  const logHint = unit.log ?? `\`journalctl --user -u ${unit.id}\``;
  const report = (n: number, text: string): void => say(`step ${n} of ${MOVE_STEPS}: ${text}`);
  // Registered before anything is stopped: an instance that finds no server in between starts the unit, and never spawns one beside it.
  await step(STEP.register, "registering the unit", `Make ${dirname(unit.path)} writable, then run \`agent-org start herdr --move\` again`, () => {
    const registered = deps.services.exists(unit.path);
    if (!registered) deps.services.write(unit.path, unit.text);
    report(STEP.register, `registered the herdr unit (${unit.manager} ${unit.id}, ${registered ? `already registered at ${unit.path}` : unit.path})`);
  });
  const stopByHand = `Run \`herdr --session ${session} server stop\` by hand, then \`agent-org start herdr --move\` again`;
  await step(STEP.stop, "stopping the outside server", stopByHand, async () => {
    if (!(outside || place.kind === "unknown")) {
      report(STEP.stop, "no herdr server ran outside the unit, so none was stopped");
      return;
    }
    const stopped = deps.services.run("herdr", ["--session", session, "server", "stop"]);
    if (stopped.status !== 0) throw new ServiceRefusal(`herdr would not stop its server for session ${session}: ${(stopped.stderr || stopped.stdout).trim() || `exit ${stopped.status}`}. Nothing was started`);
    await goneOrRefuse(session, deps);
    report(STEP.stop, `stopped the herdr server that ran outside the unit (${whereOf(place)}); herdr restores its workspaces when the unit's server is up`);
  });
  const started = await step(STEP.start, "starting the unit", `Run \`agent-org status herdr\` and read ${logHint}`, async () => {
    const result = await withinTime(limitMs, "starting the herdr unit", startService("herdr", deps.services));
    report(STEP.start, `started the herdr unit (${result.manager} ${result.id}), logging to ${logHint}`);
    return result;
  });
  await step(STEP.answer, "waiting for the server in the unit", `Read ${logHint}, then run \`agent-org start herdr\``, async () => {
    report(STEP.answer, `the herdr server for session ${session} answers in the unit (${await answeringInUnit(session, deps)})`);
  });
  for (const line of await withinTime(limitMs, "retiring the interim guards", deps.retire())) say(line);
  say(`moved herdr into its service: the server for session ${session} runs in ${started.id}, and herdr restores its workspaces in it`);
  return started;
}

/** Run one step of the move. A failure is refused as `step <n> of 4 (<doing>) failed: <why>. <fix>`: the person is told which step ended it, and what to do. */
async function step<T>(n: number, doing: string, fix: string, body: () => T | Promise<T>): Promise<T> {
  try {
    return await body();
  } catch (err) {
    throw new ServiceRefusal(`step ${n} of ${MOVE_STEPS} (${doing}) failed: ${(err as Error).message.replace(/\.+$/, "")}. ${fix}`);
  }
}

async function goneOrRefuse(session: string, deps: MoveDeps): Promise<void> {
  for (let attempt = 0; attempt < STOP_TRIES; attempt += 1) {
    if (deps.placeOf(session).kind === "none") return;
    await deps.wait(STOP_WAIT_MS);
  }
  throw new ServiceRefusal(`the herdr server for session ${session} still runs after \`server stop\`. Nothing was started`);
}

/** Where the server runs once it reads as in the unit. agent-org has no call that asks herdr itself, so "answering" is the place check naming the unit's own process group or cgroup. */
async function answeringInUnit(session: string, deps: MoveDeps): Promise<string> {
  for (let attempt = 0; attempt < STOP_TRIES; attempt += 1) {
    const place = deps.placeOf(session);
    if (place.kind === "unit") return place.where;
    await deps.wait(STOP_WAIT_MS);
  }
  throw new ServiceRefusal(`the herdr server for session ${session} is not running in the unit ${STOP_TRIES * STOP_WAIT_MS / MS_PER_SECOND}s after it started`);
}

/** The wiring of this machine: its services, its queue, its processes, and the guards' own reads. */
export function defaultMoveDeps(services: ServiceDeps = defaultServiceDeps()): MoveDeps {
  const guards: GuardDeps = {
    platform: services.platform, env: services.env, home: homedir(), exists: services.exists, remove: (path) => rmSync(path, { force: true }), run: services.run,
    replacements: () => replacementsNow(services.env, services.home, services),
  };
  return {
    services, liveRuns: () => readLiveRuns(), placeOf: (session) => hostHerdrPlace(services, session),
    retire: () => retireGuards(guards),
    wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}
