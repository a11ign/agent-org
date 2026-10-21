// @ts-check
// module: `agent-org start herdr [--move]` -- start herdr's own service, and the one-time move of a server that runs outside it (A11-169)
//
// A SERVER THAT RUNS OUTSIDE THE UNIT is one an older instance started inside its own cgroup, or in the transient scope the `systemd-run` branch made. Moving it ends every pane and agent in it
// (herdr restores the workspaces and resumes each worker with `claude --resume`, but a worker mid-tool-call loses that call), so it is done once, on purpose, at a quiet moment:
// without `--move`, `start herdr` refuses while such a server runs and says how many runs are live; with it, the server is stopped (`herdr --session <s> server stop`), the unit is started,
// and the interim guards are retired on their proof (`interim-guards.ts`): the `keep-herdr.conf` drop-in because herdr now runs in its own unit. A server already in the unit is left running,
// and a start never restarts it.
import { rmSync } from "node:fs";
import { homedir } from "node:os";
import { retireGuards, replacementsNow, type GuardDeps } from "./interim-guards.ts";
import { hostHerdrPlace, type HerdrPlace } from "./herdr-place.ts";
import { defaultServiceDeps, herdrSessionOfHost, ServiceRefusal, startService, unitFor, type Started, type ServiceDeps } from "./service.ts";
import { readLiveRuns } from "./instance-queue.ts";

export type MoveDeps = Readonly<{
  services: ServiceDeps;
  /** The runs the instance has live, or null when its queue cannot be read. */
  liveRuns: () => number | null;
  /** Where the server of `session` runs now. */
  placeOf: (session: string) => HerdrPlace;
  /** Retire the interim guards on their proof. */
  retire: () => Promise<string[]>;
  wait: (ms: number) => Promise<void>;
}>;

const STOP_TRIES = 20;
const STOP_WAIT_MS = 500;

const running = (live: number | null): string => (live === null ? "the queue cannot be read, so how many runs are live is not known" : `${live} ${live === 1 ? "run is" : "runs are"} live`);

function whereOf(place: HerdrPlace): string {
  return place.kind === "instance" || place.kind === "elsewhere" || place.kind === "unit" ? place.where : place.kind;
}

/**
 * Start herdr's service. REFUSES, naming the live runs, while a server runs outside the unit and `move` is not given; with `move`, stops that server first, and afterwards retires the
 * guards. Returns the lines to print (the started unit, and what the guards did).
 */
export async function startHerdr({ move }: { move: boolean }, deps: MoveDeps): Promise<{ started: Started; lines: string[] }> {
  const session = herdrSessionOfHost(deps.services);
  const place = deps.placeOf(session);
  const outside = place.kind === "instance" || place.kind === "elsewhere";
  if (place.kind === "unknown" && !move) {
    throw new ServiceRefusal(`where the herdr server for session ${session} runs cannot be read (${place.why}), so it is not started. Run \`agent-org start herdr --move\` to stop whatever runs and start the unit`);
  }
  if (outside && !move) {
    throw new ServiceRefusal(`the herdr server for session ${session} runs outside agent-org-herdr.service (${whereOf(place)}), and moving it ends every pane and agent in it: ${running(deps.liveRuns())}. `
      + "Run `agent-org start herdr --move` at a quiet moment");
  }
  const lines: string[] = [];
  // Registered before anything is stopped: an instance that finds no server in between starts the unit, and never spawns one beside it.
  if (move) registerUnit(deps.services);
  if (move && (outside || place.kind === "unknown")) {
    const stopped = deps.services.run("herdr", ["--session", session, "server", "stop"]);
    if (stopped.status !== 0) throw new ServiceRefusal(`herdr would not stop its server for session ${session}: ${(stopped.stderr || stopped.stdout).trim() || `exit ${stopped.status}`}. Nothing was started`);
    await goneOrRefuse(session, deps);
    lines.push(`stopped the herdr server that ran outside the unit (${whereOf(place)}); herdr restores its workspaces when the unit's server is up`);
  }
  const started = await startService("herdr", deps.services);
  if (move) lines.push(...await deps.retire());
  return { started, lines };
}

function registerUnit(services: ServiceDeps): void {
  const unit = unitFor("herdr", services);
  if (!services.exists(unit.path)) services.write(unit.path, unit.text);
}

async function goneOrRefuse(session: string, deps: MoveDeps): Promise<void> {
  for (let attempt = 0; attempt < STOP_TRIES; attempt += 1) {
    if (deps.placeOf(session).kind === "none") return;
    await deps.wait(STOP_WAIT_MS);
  }
  throw new ServiceRefusal(`the herdr server for session ${session} still runs after \`server stop\`. Nothing was started`);
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
