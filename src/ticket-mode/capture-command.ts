#!/usr/bin/env node
// @ts-check
// command: ticket:capture -- capture one route of the board at a size, as a PNG: a throwaway instance and board on free ports, paired, captured, and removed
//
// `agent-org ticket:capture /settings --size 1280x800 --out <file-or-dir>` starts this checkout's `ticket:serve` and `ticket:ui` on two free ports, from a
// throwaway host file and state directory, pairs a headless browser with the board's own code (`pairingCode`, then `POST /pair`), opens the route at the
// size, writes the PNG, and stops both and deletes the throwaway directory, on every exit path. Nothing here touches a real instance: its key, state and
// ports are the throwaway ones, and its `XDG_CONFIG_HOME` is the throwaway directory, so no `connections.json` is read.
//
// THE REQUIREMENTS ARE CHECKED FIRST: both Chromium builds must start (`install/chromium.ts`), and a refusal names the command that installs what is
// missing. A capture never installs anything, and never asks for root.
//
// THE HERDR ON PATH IS A STUB. The instance asks its herdr session for its workspaces at start, and a real herdr would start a server that outlives this
// command. The stub answers that one question with none (`HERDR_STUB`), so a machine with herdr and one without get the same capture.
import { spawn } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { constants, tmpdir } from "node:os";
import { createConnection, createServer } from "node:net";
import { delimiter, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { chromium } from "playwright-core";
import { refuseUnknownFlags } from "../lib/cli-flags.ts";
import { chromiumProblems, chromiumReport, type ChromiumReport } from "../install/chromium.ts";
import { TOOL_ROOT } from "../install/paths.ts";
import { pairingCode } from "./pair-command.ts";
import { buildCandidates, findBuild } from "./ui-build.ts";
import { HOST_FILE_ENV, readTicketSettings, type TicketSettings } from "./settings.ts";
import { CaptureRefusal, DEFAULT_SIZE, HERDR_STUB, type Size, captureHost, captureName, parseRoute, parseSize, READY_SELECTOR, routeAddress } from "./capture.ts";

/** How long each child may take to answer on its port before the capture is refused, with what it printed. */
const START_MS = 30_000;
const POLL_MS = 100;
/** How long a child may take to stop after its SIGTERM before it is killed. */
const STOP_MS = 5_000;

/** The Linear key the throwaway tracker reads: a placeholder, never a real key. */
const PLACEHOLDER_KEY = "capture-placeholder\n";

/** One child process the capture started, and what it said. `kill` sends SIGTERM; `stop` does that too, and resolves once the child has exited. */
export type Running = Readonly<{ stderr: () => string; exited: () => boolean; kill: () => void; stop: () => Promise<void> }>;

/** What a browser is asked to show: the page's address, the paired session, the size, the section that marks it drawn, and the file to write. */
export type Shot = Readonly<{ url: string; origin: string; cookie: Readonly<{ name: string; value: string }>; size: Size; ready: string; path: string }>;

/** What a capture runs with: the checkout, the requirements, and the things it starts, asks and writes. Tests inject each. */
export type CaptureDeps = Readonly<{
  checkout: string;
  env: Readonly<Record<string, string | undefined>>;
  chromium: () => ChromiumReport;
  /** Where the board's build is (`ui-build.ts`), or null when there is none: the board is its missing-build page then, which has no page to capture. */
  build: () => string | null;
  /** A new, empty throwaway directory, which the capture removes when it ends. */
  tmp: () => string;
  /** A port nothing is listening on, on 127.0.0.1, free when it is asked. */
  freePort: () => Promise<number>;
  /** Starts `file` with `args` and `env`, its stdout dropped, and returns it. */
  spawn: (file: string, args: string[], env: Record<string, string>) => Running;
  /** Whether something answers on 127.0.0.1:`port`. */
  listening: (port: number) => Promise<boolean>;
  request: typeof fetch;
  /** Opens a headless browser at `shot.url`, with `shot.cookie`, at `shot.size`, waits for `shot.ready`, and writes `shot.path`. */
  shoot: (shot: Shot) => Promise<void>;
  /** Copies the `--queue` file into the throwaway state directory. */
  copyQueue: (from: string, to: string) => void;
  remove: (dir: string) => void;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}>;

/** One capture as asked for: the route, the size, where the PNG goes, and the queue a worker can show, if any. */
export type CaptureRequest = Readonly<{ route: string; size: Size; out: string; queue: string | null }>;

/**
 * The file a capture is written to: `out` itself when it names a file, else a file named `name` inside it. A folder is one that exists or whose name ends
 * in `/`, so a folder that is yet to be made is named with its slash. PURE over `isDirectory`.
 */
export function captureFile(out: string, name: string, isDirectory: (path: string) => boolean): string {
  return out.endsWith("/") || isDirectory(out) ? join(out, name) : out;
}

/** Whether `path` is an existing folder. */
const existsDirectory = (path: string): boolean => existsSync(path) && statSync(path).isDirectory();

/** Two different free ports: the second is asked for again only when it comes back the same as the first. */
async function twoPorts(deps: CaptureDeps): Promise<[number, number]> {
  const first = await deps.freePort();
  let second = await deps.freePort();
  while (second === first) second = await deps.freePort();
  return [first, second];
}

/** Writes the throwaway host file, the placeholder key and the herdr stub into `dir`, and returns the host file's path. */
function writeThrowaway(dir: string, facts: Readonly<{ checkout: string; stateDir: string; binDir: string; port: number; uiPort: number; keyPath: string }>): string {
  const hostPath = join(dir, "host.json");
  writeFileSync(hostPath, `${JSON.stringify(captureHost(facts), null, 2)}\n`, { mode: 0o600 });
  writeFileSync(facts.keyPath, PLACEHOLDER_KEY, { mode: 0o600 });
  mkdirSync(join(dir, "stub"), { recursive: true });
  const herdr = join(dir, "stub", "herdr");
  writeFileSync(herdr, HERDR_STUB);
  chmodSync(herdr, 0o755);
  return hostPath;
}

/** The last lines a child printed, for a refusal to name, or what it printed nothing. */
const lastLines = (child: Running): string => child.stderr().trim().split("\n").slice(-3).join(" | ") || "it printed nothing";

/** Waits until `port` answers, or the child has exited, or `START_MS` has passed; the last two are refusals that name what the child said. */
async function waitForPort(port: number, child: Running, name: string, deps: CaptureDeps): Promise<void> {
  const until = deps.now() + START_MS;
  while (deps.now() < until) {
    if (await deps.listening(port)) return;
    if (child.exited()) throw new CaptureRefusal(`${name} stopped before it answered on 127.0.0.1:${port}: ${lastLines(child)}`);
    await deps.sleep(POLL_MS);
  }
  throw new CaptureRefusal(`${name} did not answer on 127.0.0.1:${port} within ${START_MS / 1000} seconds: ${lastLines(child)}`);
}

/** The `ticket_session` cookie a paired browser carries, got by trading a fresh pairing code at `POST /pair`. REFUSES when the board does not pair. */
async function pairedCookie(settings: TicketSettings, deps: CaptureDeps): Promise<Readonly<{ name: string; value: string }>> {
  const { code } = await pairingCode(settings, deps.request);
  const response = await deps.request(`http://127.0.0.1:${settings.uiPort}/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code }) });
  const match = response.headers.getSetCookie().map((line) => /^(ticket_session)=([^;]+)/.exec(line)).find((found) => found !== null);
  if (!response.ok || match === undefined || match === null) throw new CaptureRefusal(`the throwaway board did not pair (${response.status})`);
  return { name: match[1], value: match[2] };
}

/**
 * Starts the throwaway instance and board on two free ports, and waits until both answer. Each child is pushed to `children` as it starts, so a caller
 * that fails part-way still stops the ones that started. @returns the host file's path and the board's port.
 */
async function startThrowaway(dir: string, children: Running[], request: CaptureRequest, deps: CaptureDeps): Promise<Readonly<{ hostPath: string; uiPort: number }>> {
  const [port, uiPort] = await twoPorts(deps);
  const stateDir = join(dir, "state");
  const binDir = join(dir, "bin");
  mkdirSync(join(stateDir, "tickets"), { recursive: true });
  mkdirSync(binDir, { recursive: true });
  const hostPath = writeThrowaway(dir, { checkout: deps.checkout, stateDir, binDir, port, uiPort, keyPath: join(dir, "linear-key") });
  if (request.queue !== null) deps.copyQueue(request.queue, join(stateDir, "tickets", "queue.json"));
  const env = {
    ...Object.fromEntries(Object.entries(deps.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
    [HOST_FILE_ENV]: hostPath,
    XDG_CONFIG_HOME: join(dir, "xdg"),
    PATH: `${join(dir, "stub")}${delimiter}${deps.env.PATH ?? ""}`,
  };
  const bin = join(deps.checkout, "src", "bin.ts");
  const serve = deps.spawn(process.execPath, [bin, "ticket:serve"], env);
  children.push(serve);
  const ui = deps.spawn(process.execPath, [bin, "ticket:ui", "--no-open"], env);
  children.push(ui);
  await waitForPort(port, serve, "ticket:serve", deps);
  await waitForPort(uiPort, ui, "ticket:ui", deps);
  return { hostPath, uiPort };
}

/** Pairs a browser with the started board, opens the route at the size, and writes the PNG. @returns the file written. */
async function pairAndShoot(hostPath: string, uiPort: number, request: CaptureRequest, deps: CaptureDeps): Promise<string> {
  const settings = readTicketSettings({ [HOST_FILE_ENV]: hostPath }, undefined, dirname(hostPath));
  const cookie = await pairedCookie(settings, deps);
  const path = resolve(captureFile(request.out, captureName(request.route, request.size), existsDirectory));
  mkdirSync(resolve(path, ".."), { recursive: true });
  await deps.shoot({ url: routeAddress(uiPort, request.route), origin: `http://127.0.0.1:${uiPort}`, cookie, size: request.size, ready: READY_SELECTOR, path });
  return path;
}

/**
 * Captures `request`'s route, and returns the file written. Starts the throwaway instance and board, pairs, shoots, and stops both and removes the
 * throwaway directory whether it worked or not. REFUSES, before anything starts, when a Chromium build is missing.
 */
export async function captureRoute(request: CaptureRequest, deps: CaptureDeps): Promise<string> {
  const problems = chromiumProblems(deps.chromium());
  if (problems.length > 0) throw new CaptureRefusal(problems.join("\n"));
  if (deps.build() === null) throw new CaptureRefusal("this checkout has no board UI build to capture (the board answers its missing-build page): `pnpm ui:build` makes it");
  const dir = deps.tmp();
  const children: Running[] = [];
  // A process that exits without running this `finally` (a signal's exit) still ends the children and removes the directory: `exit` runs synchronously.
  const onExit = () => { for (const child of children) child.kill(); deps.remove(dir); };
  process.on("exit", onExit);
  try {
    const { hostPath, uiPort } = await startThrowaway(dir, children, request, deps);
    return await pairAndShoot(hostPath, uiPort, request, deps);
  } finally {
    process.off("exit", onExit);
    await Promise.all(children.map((child) => child.stop()));
    deps.remove(dir);
  }
}

/** A port nothing answers on, found by binding port 0 and letting it go. */
function realFreePort(): Promise<number> {
  return new Promise((done, fail) => {
    const server = createServer();
    server.once("error", fail);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => (typeof address === "object" && address !== null ? done(address.port) : fail(new Error("no port was bound"))));
    });
  });
}

/** Whether something accepts a connection on 127.0.0.1:`port`. */
function realListening(port: number): Promise<boolean> {
  return new Promise((done) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.once("connect", () => { socket.destroy(); done(true); });
    socket.once("error", () => done(false));
  });
}

/** A child process whose stderr is kept. It is stopped with SIGTERM, and with SIGKILL when it has not exited after `STOP_MS`. */
function realSpawn(file: string, args: string[], env: Record<string, string>): Running {
  const child = spawn(file, args, { env, stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
  let exited = false;
  child.once("exit", () => { exited = true; });
  return {
    stderr: () => stderr,
    exited: () => exited,
    kill: () => { if (!exited) child.kill("SIGTERM"); },
    stop: () => new Promise<void>((done) => {
      if (exited) return done();
      child.kill("SIGTERM");
      const timer = setTimeout(() => { child.kill("SIGKILL"); done(); }, STOP_MS);
      child.once("exit", () => { clearTimeout(timer); done(); });
    }),
  };
}

/** Opens `shot` in a headless browser: the paired cookie, the size as the viewport, the section drawn, and the screenshot at that size. */
export async function shootWithPlaywright(shot: Shot): Promise<void> {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: shot.size });
    await context.addCookies([{ name: shot.cookie.name, value: shot.cookie.value, url: shot.origin }]);
    const page = await context.newPage();
    await page.goto(shot.url);
    await page.waitForSelector(shot.ready);
    await page.waitForLoadState("networkidle");
    await page.screenshot({ path: shot.path });
  } finally {
    await browser.close();
  }
}

/** The real dependencies: this checkout, the environment, the machine's Chromium, a throwaway directory, free ports and the real children. */
export function defaultCaptureDeps(): CaptureDeps {
  return {
    checkout: TOOL_ROOT,
    env: process.env,
    chromium: () => chromiumReport(),
    build: () => findBuild(buildCandidates()),
    tmp: () => mkdtempSync(join(tmpdir(), "agent-org-capture-")),
    freePort: realFreePort,
    spawn: realSpawn,
    listening: realListening,
    request: fetch,
    shoot: shootWithPlaywright,
    copyQueue: (from, to) => copyFileSync(from, to),
    remove: (dir) => rmSync(dir, { recursive: true, force: true }),
    now: () => Date.now(),
    sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ? realpathSync(process.argv[1]) : "").href) {
  refuseUnknownFlags(["--size", "--out", "--queue"], { entry: import.meta.url, command: "agent-org ticket:capture" });
  // A signal ends the capture through its `exit` handler, which stops both children and removes the throwaway directory.
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, () => process.exit(128 + constants.signals[signal]));
  const fail = (message: string): never => {
    process.stderr.write(`ticket:capture: ${message}\n`);
    process.exit(1);
  };
  const { values, positionals } = parseArgs({ options: { size: { type: "string" }, out: { type: "string" }, queue: { type: "string" } }, allowPositionals: true });
  if (positionals.length !== 1) fail("name one route, such as /settings: agent-org ticket:capture /settings --size 1280x800 --out <file-or-dir>");
  try {
    const request: CaptureRequest = {
      route: parseRoute(positionals[0]),
      size: parseSize(values.size ?? DEFAULT_SIZE),
      out: values.out ?? ".",
      queue: values.queue === undefined ? null : resolve(values.queue),
    };
    captureRoute(request, defaultCaptureDeps()).then((path) => {
      process.stdout.write(`${path}\n`);
    }, (err) => fail(String((err as Error)?.message ?? err)));
  } catch (err) {
    fail(String((err as Error)?.message ?? err));
  }
}
