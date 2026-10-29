// A11-282: how long the instance's reads take while a sweep is running, against this checkout's own `ticket:serve`, and whether the board thread held its loop for any of it. Since A11-356 the GitHub plugin's reads are asynchronous, so a slow `gh` no longer holds the board
// thread, and since A11-282 the pool's herdr calls and the tick's read of herdr's start are asynchronous too, so a slow `herdr` or `systemctl` does not either. The stand-ins are slow on purpose (a `gh` of 2 s, a `herdr` of 150 ms, more than the
// 100 ms `syncHolds` counts a hold at), so a synchronous call anywhere in the board thread's passes would show as a hold: the run FAILS unless `/api/health` counts none.
//
//   node scripts/loop-load.ts [--json]
//
// It starts this checkout's instance on a free port from a throwaway host file and state folder, with stand-ins first on PATH: a `gh` that sleeps 2 s per call and then answers
// an empty list, a `herdr` that sleeps HERDR_MS per call and a `tailscale` that logs its arguments and exits 0, so nothing reaches GitHub, a herdr server or the real tailnet. The instance's `fetch` is the
// suite's offline one, but refusing with an answer and not a dropped connection (`loop-load-fetch.ts`), so the tracker's reads fail at once and nothing reaches Linear. The sweeps run every SWEEP_MS, so one is in progress from the first seconds; the script waits for the first `gh` call, then reads every `GET /api/*` route ROUNDS times (starting none after READS_FOR_MS),
// each round all at once, and prints each route's p50, p99 and max, the instance's own loop reading (`/api/health`) and the five call sites that held it the longest.
// It exits 1 when any route the request thread answers has a p99 of READ_LIMIT_MS or more, when the request thread made a synchronous spawn after it listened, when the board thread held its loop (`syncHolds.lastHour` is not 0), or when the rounds did not
// all fit in READS_FOR_MS. The throwaway folder and the instance are removed on every exit.
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { captureHost, HERDR_STUB } from "../src/ticket-mode/capture.ts";
import type { HealthView, RequestHealthView } from "../src/ticket-mode/health-route.ts";
import type { LoopReading } from "../src/ticket-mode/loop-delay.ts";
import { HOLD_MS } from "../src/ticket-mode/health-figures.ts";
import { HOST_FILE_ENV } from "../src/ticket-mode/settings.ts";

const CHECKOUT = join(dirname(fileURLToPath(import.meta.url)), "..");
/** The suite's offline `fetch` but for how it refuses (`loop-load-fetch.ts`), preloaded into the instance: the tracker's reads are refused at once, and never reach Linear with the placeholder key. */
const OFFLINE = new URL("./loop-load-fetch.ts", import.meta.url).href;
const BOARD_KEY = "0123456789abcdef".repeat(3);
/** How long the stand-in `gh` takes per call, in seconds: the ticket's 2 s. */
const GH_SECONDS = 2;
/** How long the stand-in `herdr` takes per call, in seconds: past the 100 ms a synchronous call is counted as a hold at (`HOLD_MS`), and about what a loaded host takes. */
const HERDR_SECONDS = 0.15;
/** The tick, the tracker refresh and the feedback sweeps, all this often, so background work is always running while the reads are made. */
const SWEEP_MS = 1_000;
const ROUNDS = 20;
const ROUND_GAP_MS = 250;
/** No round starts after this long, so a run against an instance that holds every read still ends within its caller's few minutes: it then fails, with the rounds it made. */
export const READS_FOR_MS = 90_000;
/** A route whose p99 is this or more fails the run: the ticket's bound on a read. */
export const READ_LIMIT_MS = 200;
const START_WAIT_MS = 60_000;
/** A read that takes this long is given up on, and counts as this long with no answer. */
const READ_TIMEOUT_MS = 15_000;
/**
 * Every read route of the instance, and its health: each `GET /api/*` route of `server.ts` and its route modules, and the Assignee scope's page of `/api/tickets`.
 * `loop-load-routes.test.ts` holds this list to the routes the source answers. On this throwaway host `/api/people`, `/api/projects`, `/api/search`, `/api/tickets` and its scope and project pages answer an
 * error, since its tracker is offline, and are timed all the same: a refusal waits behind a held loop as long as any answer.
 */
export const ROUTES = ["/api/config", "/api/settings", "/api/plugins", "/api/pick", "/api/people", "/api/projects", "/api/search?q=queue", "/api/tickets", "/api/tickets?assignee=me", "/api/tickets?project=web", "/api/parents", "/api/queue", "/api/writer",
  "/api/session-asks", "/api/health", "/api/interventions", "/api/flakes"];
/**
 * The GET routes the board thread answers (A11-282): `/api/session-asks` marks each check it lists as sent, a change to the checks file, whose one writer is the board thread. They are
 * timed and shown, and held to no bound: they wait while the board thread is held, as every write does. A session reads them, never a board page.
 */
export const BOARD_THREAD_ROUTES: readonly string[] = ["/api/session-asks"];

/** A free port on 127.0.0.1, found by binding port 0 and letting it go. */
function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const server = createServer().once("error", fail).listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => (typeof address === "object" && address !== null ? done(address.port) : fail(new Error("no port was bound"))));
    });
  });
}

/** The file in the throwaway folder where the held call of the board thread (`loop-load-hold.ts`) says it began. */
export const HOLD_LOG = "board-thread-hold.log";
/** The preload that holds the board thread when the test asks (`loop-load-hold.ts`). */
const HOLD_PRELOAD = new URL("./loop-load-hold.ts", import.meta.url).href;

const sleep = (ms: number): Promise<void> => new Promise((done) => { setTimeout(done, ms); });

/** The longest a gated stand-in `gh` waits for its gate, in 50 ms polls (5 minutes): past any test's own timeout, so it never returns on its own while a test runs, and a test that dies without opening the gate still leaves no `gh` behind for long. */
const GATE_POLLS = 6_000;

/**
 * How the stand-ins hold: `gh` (for GH_SECONDS) and `herdr` (for HERDR_SECONDS, every call) with `"sleep"`, as the script's timed run does, or the gated ones until the file `gate` exists, which is how a test holds a `gh` call and the tick's `herdr agent list`
 * for exactly as long as it reads and so measures nothing with a clock. Both are asynchronous calls of the board thread, so they hold nothing of it.
 */
export type GhHold = Readonly<{ kind: "sleep" }> | Readonly<{ kind: "gate"; gate: string; doneLog: string }>;

/** The shell lines that hold a call as `hold` says: a sleep of GH_SECONDS, or a wait on the gate file, after which the call is logged to `hold.doneLog`. */
function holdLines(hold: GhHold): string {
  return hold.kind === "gate" ? `i=0\nwhile [ ! -e '${hold.gate}' ] && [ "$i" -lt ${GATE_POLLS} ]; do sleep 0.05; i=$((i + 1)); done\necho "$*" >> '${hold.doneLog}'\n` : `sleep ${GH_SECONDS}\n`;
}

/** A stand-in that appends its arguments to `log`, and for `gh` holds as `hold` says and answers `[]`. A gated `gh` also appends its arguments to `hold.doneLog` when it returns. */
function standIn(program: string, log: string, hold: GhHold): string {
  const answer = program === "gh" ? `${holdLines(hold)}echo '[]'\n` : "";
  return `#!/bin/sh\n# loop-load's throwaway ${program}: it logs its arguments and reaches nothing.\necho "$*" >> '${log}'\n${answer}exit 0\n`;
}

/** The throwaway host file, board key and stand-ins in `dir`, and the environment the instance runs in. */
function throwaway(dir: string, port: number, uiPort: number, hold: GhHold, holdsBoardThread: boolean): Readonly<{ env: NodeJS.ProcessEnv; ghLog: string; herdrLog: string }> {
  const stateDir = join(dir, "state");
  const stub = join(dir, "stub");
  mkdirSync(join(stateDir, "tickets"), { recursive: true });
  mkdirSync(stub, { recursive: true });
  const host = captureHost({ checkout: CHECKOUT, stateDir, binDir: join(dir, "bin"), port, uiPort, keyPath: join(dir, "linear-key") });
  const hostPath = join(dir, "host.json");
  writeFileSync(hostPath, JSON.stringify(host), { mode: 0o600 });
  writeFileSync(join(dir, "linear-key"), "placeholder\n", { mode: 0o600 });
  writeFileSync(join(stateDir, "tickets", "board.key"), `${BOARD_KEY}\n`, { mode: 0o600 });
  for (const program of ["gh", "tailscale"]) writeFileSync(join(stub, program), standIn(program, join(dir, `${program}.log`), hold));
  const herdrHold = hold.kind === "gate" ? `case "$*" in *"agent list"*)\n${holdLines(hold)}esac\n` : `sleep ${HERDR_SECONDS}\n`;
  writeFileSync(join(stub, "herdr"), HERDR_STUB.replace("#!/bin/sh\n", `#!/bin/sh\necho "$*" >> '${join(dir, "herdr.log")}'\n${herdrHold}`));
  // The service manager answers at once and reaches nothing: the tick's read of herdr's start is asynchronous, and holds no thread.
  writeFileSync(join(stub, "systemctl"), `#!/bin/sh\n# loop-load's throwaway systemctl: it logs its arguments and reaches no service manager.\necho "$*" >> '${join(dir, "systemctl.log")}'\nexit 0\n`);
  for (const program of ["gh", "tailscale", "herdr", "systemctl"]) chmodSync(join(stub, program), 0o755);
  const env = { ...process.env, [HOST_FILE_ENV]: hostPath, XDG_CONFIG_HOME: join(dir, "xdg"), PATH: `${stub}${delimiter}${process.env.PATH ?? ""}`,
    NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import=${OFFLINE}`, ...(holdsBoardThread ? [`--import=${HOLD_PRELOAD}`] : [])].filter(Boolean).join(" "),
    ...(holdsBoardThread ? { LOOP_LOAD_HOLD_START: join(dir, "board-thread.start"), LOOP_LOAD_HOLD_GATE: join(dir, "gh.gate"), LOOP_LOAD_HOLD_LOG: join(dir, HOLD_LOG) } : {}), AGENT_ORG_TICK_MS: String(SWEEP_MS), AGENT_ORG_TRACKER_MS: String(SWEEP_MS), AGENT_ORG_FEEDBACK_MS: String(SWEEP_MS) };
  return { env, ghLog: join(dir, "gh.log"), herdrLog: join(dir, "herdr.log") };
}

/** One timed read: how long it took in ms, and its status (0 when no answer came). */
export async function timedRead(port: number, path: string): Promise<Readonly<{ ms: number; status: number; body: string }>> {
  const started = performance.now();
  try {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { headers: { "x-ticket-token": BOARD_KEY }, signal: AbortSignal.timeout(READ_TIMEOUT_MS) });
    const body = await response.text();
    return { ms: performance.now() - started, status: response.status, body };
  } catch {
    return { ms: performance.now() - started, status: 0, body: "" };
  }
}

/** The nearest-rank percentile of `values`. PURE. */
export function percentile(values: readonly number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

const round = (ms: number): number => Math.round(ms);

export async function waitFor(what: string, holds: () => boolean | Promise<boolean>): Promise<void> {
  const until = Date.now() + START_WAIT_MS;
  while (Date.now() < until) {
    if (await holds()) return;
    await sleep(100);
  }
  throw new Error(`${what} did not happen within ${START_WAIT_MS / 1000} s`);
}

type RouteTimes = Readonly<{ route: string; p50Ms: number; p99Ms: number; maxMs: number; statuses: readonly number[] }>;
/** What the instance's `/api/health` answers: the request thread's view, or the one thread's of an instance from before it. */
export type Health = RequestHealthView | HealthView;
type Result = Readonly<{ routes: readonly RouteTimes[]; health: Health | null; rounds: number; ghCalls: number; pass: boolean }>;

/**
 * A throwaway instance of this checkout, answering on `port` to `key`: its environment (whose `AGENT_ORG_HOST` names its host file), the stand-in `gh`'s log, the log of the calls
 * that have returned (a gated `gh` only; empty file or none while every call is held), how to open the gate (a no-op for a `gh` that sleeps) and how to stop it.
 */
export type Throwaway = Readonly<{ port: number; key: string; dir: string; env: NodeJS.ProcessEnv; ghLog: string; herdrLog: string; ghDoneLog: string; releaseGh: () => void;
  /** Begins the held call of the board thread (`holdsBoardThread` only): it ends when `releaseGh()` opens the gate, or after a few seconds. */
  holdBoardThread: () => void; stop: () => void }>;

/**
 * Starts this checkout's `ticket:serve` from a throwaway host in `dir`, and resolves once it answers. Throws with its stderr when it exits first. `gated` makes every `gh` call
 * wait until `releaseGh()`, so the sweeps' calls stay held for as long as the caller likes and no clock is involved; stopping the instance opens the gate too. `holdsBoardThread` loads the preload
 * that can hold the board thread with a synchronous call on demand (`holdBoardThread()`, `loop-load-hold.ts`): the board thread makes no such call of its own any more, so a test of what the request thread does while it is held makes it.
 */
export async function startThrowawayInstance(dir: string, { gated = false, holdsBoardThread = false }: Readonly<{ gated?: boolean; holdsBoardThread?: boolean }> = {}): Promise<Throwaway> {
  const [port, uiPort] = [await freePort(), await freePort()];
  const gate = join(dir, "gh.gate");
  const ghDoneLog = join(dir, "gh.done.log");
  const { env, ghLog, herdrLog } = throwaway(dir, port, uiPort, gated ? { kind: "gate", gate, doneLog: ghDoneLog } : { kind: "sleep" }, holdsBoardThread);
  const releaseGh = () => { if (gated || holdsBoardThread) writeFileSync(gate, ""); };
  const holdBoardThread = () => { writeFileSync(join(dir, "board-thread.start"), ""); };
  const instance: ChildProcess = spawn(process.execPath, [join(CHECKOUT, "src", "bin.ts"), "ticket:serve"], { env, stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  instance.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  const stop = () => { releaseGh(); instance.kill("SIGTERM"); };
  try {
    await waitFor("the instance answering", async () => (await timedRead(port, "/api/queue")).status === 200 || instance.exitCode !== null);
  } catch (err) {
    stop();
    throw err;
  }
  if (instance.exitCode !== null) throw new Error(`the instance exited ${instance.exitCode}: ${stderr.trim()}`);
  return { port, key: BOARD_KEY, dir, env, ghLog, herdrLog, ghDoneLog, releaseGh, holdBoardThread, stop };
}

/** How many rounds `readRounds` makes, and for how long it starts them: ROUNDS and READS_FOR_MS unless a test asks for fewer. */
export type RoundLimits = Readonly<{ rounds: number; forMs: number }>;

/**
 * Every read route's times and statuses over up to `rounds` rounds, each round all at once, the last health the instance answered, and how many rounds were made. No round
 * starts after `forMs`.
 */
export async function readRounds(port: number, { rounds, forMs }: RoundLimits = { rounds: ROUNDS, forMs: READS_FOR_MS }): Promise<Readonly<{ routes: readonly RouteTimes[]; health: Health | null; rounds: number }>> {
  const times = new Map<string, { ms: number[]; statuses: number[] }>(ROUTES.map((route) => [route, { ms: [], statuses: [] }]));
  let health: Health | null = null;
  const until = Date.now() + forMs;
  let done = 0;
  for (; done < rounds && Date.now() < until; done += 1) {
    const reads = await Promise.all(ROUTES.map(async (route) => [route, await timedRead(port, route)] as const));
    for (const [route, read] of reads) {
      times.get(route)?.ms.push(read.ms);
      times.get(route)?.statuses.push(read.status);
      if (route === "/api/health" && read.status === 200) health = JSON.parse(read.body) as Health;
    }
    await sleep(ROUND_GAP_MS);
  }
  const routes = ROUTES.map((route) => {
    const { ms, statuses } = times.get(route) ?? { ms: [], statuses: [] };
    return { route, p50Ms: round(percentile(ms, 50)), p99Ms: round(percentile(ms, 99)), maxMs: round(Math.max(...ms)), statuses: [...new Set(statuses)] };
  });
  return { routes, health, rounds: done };
}

/** How many synchronous spawns the request thread made after it listened: 0 for an instance with one thread, which counts none. PURE. */
const syncCallsOf = (health: Health | null): number => (health !== null && "requestThreadSyncCalls" in health ? health.requestThreadSyncCalls : 0);

/** How many synchronous calls held the board thread's loop for `HOLD_MS` or more, as `/api/health` counts them (`syncHolds.lastHour`), or null when the health carries no such figure yet. PURE. */
export function syncHoldsOf(health: Health | null): number | null {
  if (health === null) return null;
  return "figures" in health ? (health.figures?.syncHolds.lastHour ?? null) : health.measured.holds;
}

/**
 * Whether a run passes: every round made, every route the request thread answers under READ_LIMIT_MS at p99, no synchronous spawn on the request thread, and no hold of the board thread's loop: the figure the board watches
 * (`syncHolds.lastHour`, under 10 an hour) is 0 here, since the stand-ins are slower than `HOLD_MS` and any synchronous call the passes make would be counted. PURE.
 */
export function passes(routes: readonly RouteTimes[], health: Health | null, rounds: number): boolean {
  const bounded = routes.filter((route) => !BOARD_THREAD_ROUTES.includes(route.route));
  return rounds === ROUNDS && bounded.every((route) => route.p99Ms < READ_LIMIT_MS) && syncCallsOf(health) === 0 && syncHoldsOf(health) === 0;
}

/** The loop lines of a health answer: the request thread's and the board thread's, or the one thread's. PURE. */
function loopLines(health: Health | null): string[] {
  if (health === null) return ["the instance answered no /api/health"];
  const line = (name: string, loop: LoopReading) => `${name}: p50 ${loop.p50Ms} ms, p99 ${loop.p99Ms} ms, max ${loop.maxMs} ms over ${Math.round(loop.windowMs / 1000)} s`;
  if (!("requests" in health.loop)) return [line("the instance's loop", health.loop.board)];
  const split = health as RequestHealthView;
  return [line("the request thread's loop", split.loop.requests), line("the board thread's loop", split.loop.board),
    `the board snapshot was ${split.boardSnapshotAgeMs} ms old; the request thread made ${split.requestThreadSyncCalls} synchronous spawns after it listened`,
    `the board thread held its loop ${syncHoldsOf(health) ?? "an unread number of"} times for ${HOLD_MS} ms or more (syncHolds.lastHour)`];
}

/** Starts the throwaway instance, waits for a sweep's first `gh` call, and reads every route while the sweeps run. */
async function measure(dir: string): Promise<Result> {
  const { port, ghLog, stop } = await startThrowawayInstance(dir);
  try {
    await waitFor("a sweep's first gh call", () => existsSync(ghLog));
    const { routes, health, rounds } = await readRounds(port);
    const ghCalls = readFileSync(ghLog, "utf8").split("\n").filter(Boolean).length;
    return { routes, health, rounds, ghCalls, pass: passes(routes, health, rounds) };
  } finally {
    stop();
  }
}

/** The result as a person reads it: a line per route, the loop's reading and the worst sites. PURE. */
export function report({ routes, health, rounds, ghCalls, pass }: Result): string {
  const lines = [`${rounds} of ${ROUNDS} rounds of every read in ${READS_FOR_MS / 1000} s, with a ${GH_SECONDS} s gh, a ${HERDR_SECONDS * 1000} ms herdr and the sweeps every ${SWEEP_MS} ms (${ghCalls} gh calls):`, "",
    "route                     p50 ms   p99 ms   max ms   status"];
  for (const { route, p50Ms, p99Ms, maxMs, statuses } of routes) {
    const mark = BOARD_THREAD_ROUTES.includes(route) ? "   board thread, not bounded" : p99Ms >= READ_LIMIT_MS ? "   OVER" : "";
    lines.push(`${route.padEnd(25)} ${String(p50Ms).padStart(6)}   ${String(p99Ms).padStart(6)}   ${String(maxMs).padStart(6)}   ${statuses.join(",")}${mark}`);
  }
  lines.push("", ...loopLines(health));
  lines.push("", "the five sites that held the board loop the longest:");
  for (const site of health?.blocking.slice(0, 5) ?? []) lines.push(`  ${site.site} (${site.program}): ${site.count} calls, ${site.totalMs} ms in all, the longest ${site.maxMs} ms`);
  lines.push("", pass ? `PASS: every read the request thread answers has a p99 under ${READ_LIMIT_MS} ms, it spawned nothing synchronously, and the board thread held its loop ${HOLD_MS} ms or more 0 times`
    : `FAIL: a read's p99 is ${READ_LIMIT_MS} ms or more, the request thread spawned synchronously, the board thread held its loop (syncHolds.lastHour is not 0), or the rounds did not all fit in ${READS_FOR_MS / 1000} s`);
  return `${lines.join("\n")}\n`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = mkdtempSync(join(tmpdir(), "agent-org-loop-load-"));
  try {
    const result = await measure(dir);
    process.stdout.write(process.argv.includes("--json") ? `${JSON.stringify(result, null, 2)}\n` : report(result));
    process.exitCode = result.pass ? 0 : 1;
  } catch (err) {
    process.stderr.write(`loop-load: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 2;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
