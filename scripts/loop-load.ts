// A11-282: how long the instance's reads take while a sweep holds it, against this checkout's own `ticket:serve`.
//
//   node scripts/loop-load.ts [--json]
//
// It starts this checkout's instance on a free port from a throwaway host file and state folder, with stand-ins first on PATH: a `gh` that sleeps 2 s per call and then answers
// an empty list, and a `herdr` and a `tailscale` that log their arguments and exit 0, so nothing reaches GitHub, a herdr server or the real tailnet. The instance's `fetch` is the
// suite's offline one, so the tracker's reads fail at once and nothing reaches Linear. The sweeps run every SWEEP_MS, so one is in progress from the first seconds; the script waits for the first `gh` call, then reads every `GET /api/*` route ROUNDS times,
// each round all at once, and prints each route's p50, p99 and max, the instance's own loop reading (`/api/health`) and the five call sites that held it the longest.
// It exits 1 when any route's p99 is READ_LIMIT_MS or more. The throwaway folder and the instance are removed on every exit.
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { captureHost, HERDR_STUB } from "../src/ticket-mode/capture.ts";
import type { HealthView } from "../src/ticket-mode/health-route.ts";
import { HOST_FILE_ENV } from "../src/ticket-mode/settings.ts";

const CHECKOUT = join(dirname(fileURLToPath(import.meta.url)), "..");
/** The suite's offline `fetch`, preloaded into the instance: the tracker's reads fail at once, as a dropped network does, and never reach Linear with the placeholder key. */
const OFFLINE = new URL("../src/offline-fetch-preload.ts", import.meta.url).href;
const BOARD_KEY = "0123456789abcdef".repeat(3);
/** How long the stand-in `gh` takes per call, in seconds: the ticket's 2 s. */
const GH_SECONDS = 2;
/** The tick, the tracker refresh and the feedback sweeps, all this often, so background work is always running while the reads are made. */
const SWEEP_MS = 1_000;
const ROUNDS = 20;
const ROUND_GAP_MS = 250;
/** A route whose p99 is this or more fails the run: the ticket's bound on a read. */
export const READ_LIMIT_MS = 200;
const START_WAIT_MS = 60_000;
const READ_TIMEOUT_MS = 90_000;
/** Every read route of the instance, and its health. */
const ROUTES = ["/api/config", "/api/settings", "/api/plugins", "/api/pick", "/api/tickets", "/api/parents", "/api/queue", "/api/writer", "/api/health"];

/** A free port on 127.0.0.1, found by binding port 0 and letting it go. */
function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const server = createServer().once("error", fail).listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => (typeof address === "object" && address !== null ? done(address.port) : fail(new Error("no port was bound"))));
    });
  });
}

const sleep = (ms: number): Promise<void> => new Promise((done) => { setTimeout(done, ms); });

/** A stand-in that appends its arguments to `log`, and for `gh` sleeps first and answers `[]`. */
function standIn(program: string, log: string): string {
  const answer = program === "gh" ? `sleep ${GH_SECONDS}\necho '[]'\n` : "";
  return `#!/bin/sh\n# loop-load's throwaway ${program}: it logs its arguments and reaches nothing.\necho "$*" >> '${log}'\n${answer}exit 0\n`;
}

/** The throwaway host file, board key and stand-ins in `dir`, and the environment the instance runs in. */
function throwaway(dir: string, port: number, uiPort: number): Readonly<{ env: NodeJS.ProcessEnv; ghLog: string }> {
  const stateDir = join(dir, "state");
  const stub = join(dir, "stub");
  mkdirSync(join(stateDir, "tickets"), { recursive: true });
  mkdirSync(stub, { recursive: true });
  const host = captureHost({ checkout: CHECKOUT, stateDir, binDir: join(dir, "bin"), port, uiPort, keyPath: join(dir, "linear-key") });
  const hostPath = join(dir, "host.json");
  writeFileSync(hostPath, JSON.stringify(host), { mode: 0o600 });
  writeFileSync(join(dir, "linear-key"), "placeholder\n", { mode: 0o600 });
  writeFileSync(join(stateDir, "tickets", "board.key"), `${BOARD_KEY}\n`, { mode: 0o600 });
  for (const program of ["gh", "tailscale"]) writeFileSync(join(stub, program), standIn(program, join(dir, `${program}.log`)));
  writeFileSync(join(stub, "herdr"), HERDR_STUB.replace("#!/bin/sh\n", `#!/bin/sh\necho "$*" >> '${join(dir, "herdr.log")}'\n`));
  for (const program of ["gh", "tailscale", "herdr"]) chmodSync(join(stub, program), 0o755);
  const env = { ...process.env, [HOST_FILE_ENV]: hostPath, XDG_CONFIG_HOME: join(dir, "xdg"), PATH: `${stub}${delimiter}${process.env.PATH ?? ""}`,
    NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import=${OFFLINE}`].filter(Boolean).join(" "), AGENT_ORG_TICK_MS: String(SWEEP_MS), AGENT_ORG_TRACKER_MS: String(SWEEP_MS), AGENT_ORG_FEEDBACK_MS: String(SWEEP_MS) };
  return { env, ghLog: join(dir, "gh.log") };
}

/** One timed read: how long it took in ms, and its status (0 when no answer came). */
async function timedRead(port: number, path: string): Promise<Readonly<{ ms: number; status: number; body: string }>> {
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

async function waitFor(what: string, holds: () => boolean | Promise<boolean>): Promise<void> {
  const until = Date.now() + START_WAIT_MS;
  while (Date.now() < until) {
    if (await holds()) return;
    await sleep(100);
  }
  throw new Error(`${what} did not happen within ${START_WAIT_MS / 1000} s`);
}

type RouteTimes = Readonly<{ route: string; p50Ms: number; p99Ms: number; maxMs: number; statuses: readonly number[] }>;
type Result = Readonly<{ routes: readonly RouteTimes[]; health: HealthView | null; ghCalls: number; pass: boolean }>;

/** A throwaway instance of this checkout, answering on `port`: its environment (whose `AGENT_ORG_HOST` names its host file), the stand-in `gh`'s log, and how to stop it. */
export type Throwaway = Readonly<{ port: number; env: NodeJS.ProcessEnv; ghLog: string; stop: () => void }>;

/** Starts this checkout's `ticket:serve` from a throwaway host in `dir`, and resolves once it answers. Throws with its stderr when it exits first. */
export async function startThrowawayInstance(dir: string): Promise<Throwaway> {
  const [port, uiPort] = [await freePort(), await freePort()];
  const { env, ghLog } = throwaway(dir, port, uiPort);
  const instance: ChildProcess = spawn(process.execPath, [join(CHECKOUT, "src", "bin.ts"), "ticket:serve"], { env, stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  instance.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  const stop = () => { instance.kill("SIGTERM"); };
  try {
    await waitFor("the instance answering", async () => (await timedRead(port, "/api/queue")).status === 200 || instance.exitCode !== null);
  } catch (err) {
    stop();
    throw err;
  }
  if (instance.exitCode !== null) throw new Error(`the instance exited ${instance.exitCode}: ${stderr.trim()}`);
  return { port, env, ghLog, stop };
}

/** Every read route's times and statuses over ROUNDS rounds, each round all at once, and the last health the instance answered. */
async function readRounds(port: number): Promise<Readonly<{ routes: readonly RouteTimes[]; health: HealthView | null }>> {
  const times = new Map<string, { ms: number[]; statuses: number[] }>(ROUTES.map((route) => [route, { ms: [], statuses: [] }]));
  let health: HealthView | null = null;
  for (let done = 0; done < ROUNDS; done += 1) {
    const reads = await Promise.all(ROUTES.map(async (route) => [route, await timedRead(port, route)] as const));
    for (const [route, read] of reads) {
      times.get(route)?.ms.push(read.ms);
      times.get(route)?.statuses.push(read.status);
      if (route === "/api/health" && read.status === 200) health = JSON.parse(read.body) as HealthView;
    }
    await sleep(ROUND_GAP_MS);
  }
  const routes = ROUTES.map((route) => {
    const { ms, statuses } = times.get(route) ?? { ms: [], statuses: [] };
    return { route, p50Ms: round(percentile(ms, 50)), p99Ms: round(percentile(ms, 99)), maxMs: round(Math.max(...ms)), statuses: [...new Set(statuses)] };
  });
  return { routes, health };
}

/** Starts the throwaway instance, waits for a sweep's first `gh` call, and reads every route while the sweeps run. */
async function measure(dir: string): Promise<Result> {
  const { port, ghLog, stop } = await startThrowawayInstance(dir);
  try {
    await waitFor("a sweep's first gh call", () => existsSync(ghLog));
    const { routes, health } = await readRounds(port);
    const ghCalls = readFileSync(ghLog, "utf8").split("\n").filter(Boolean).length;
    return { routes, health, ghCalls, pass: routes.every((route) => route.p99Ms < READ_LIMIT_MS) };
  } finally {
    stop();
  }
}

/** The result as a person reads it: a line per route, the loop's reading and the worst sites. PURE. */
export function report({ routes, health, ghCalls, pass }: Result): string {
  const lines = [`${ROUNDS} rounds of every read, with a ${GH_SECONDS} s gh and the sweeps every ${SWEEP_MS} ms (${ghCalls} gh calls):`, "", "route              p50 ms   p99 ms   max ms   status"];
  for (const { route, p50Ms, p99Ms, maxMs, statuses } of routes) {
    lines.push(`${route.padEnd(18)} ${String(p50Ms).padStart(6)}   ${String(p99Ms).padStart(6)}   ${String(maxMs).padStart(6)}   ${statuses.join(",")}${p99Ms >= READ_LIMIT_MS ? "   OVER" : ""}`);
  }
  const loop = health?.loop.board;
  lines.push("", loop === undefined ? "the instance answered no /api/health" : `the instance's loop: p50 ${loop.p50Ms} ms, p99 ${loop.p99Ms} ms, max ${loop.maxMs} ms over ${Math.round(loop.windowMs / 1000)} s`);
  lines.push("", "the five sites that held the loop the longest:");
  for (const site of health?.blocking.slice(0, 5) ?? []) lines.push(`  ${site.site} (${site.program}): ${site.count} calls, ${site.totalMs} ms in all, the longest ${site.maxMs} ms`);
  lines.push("", pass ? `PASS: every read's p99 is under ${READ_LIMIT_MS} ms` : `FAIL: a read's p99 is ${READ_LIMIT_MS} ms or more`);
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
