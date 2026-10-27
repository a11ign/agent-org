// A11-217: the update-in-progress screens, in a real browser, over a real throwaway install updated by `agent-org update`'s own steps.
//
//   node scripts/board-update-check.ts
//
// WHAT RUNS. A throwaway agent-org home with a bare mirror of a throwaway remote that holds three releases of THIS checkout (v0.273.0, v0.280.0 and a breaking v0.281.0), `versions/<tag>` built by
// `buildVersion`, `current` swapped by `swapCurrent`, and the real `ticket:serve` and `ticket:ui` started through `current`, so each runs on the version's own folder. Its herdr is a stub whose one workspace is
// listed while a real process (the "worker" in its pane) is alive, as herdr, a service of its own that an update never restarts, lists a live run. The browser is a paired headless Chromium on `/runs`.
//
// WHAT IT DOES. (1) A normal update: `update()` under `withUpdateLock`, in a child process so the browser is driven meanwhile; the build takes a while (a stand-in for the dependency install), then `current`
// is swapped and the two services are stopped, held down for 70 s and started on the new folder. The page left open shows Updating (from v0.273 to v0.280, the amber pill, the runs sentence), then Slow, then Back
// ("Updated to v0.280"), then reloads itself; the run is still running on v0.273, its pane's process is untouched, and the instance now says v0.280. (2) A breaking release with the run live: `update()` builds it and
// drains (no swap), the page shows the banner on Runs and the "finishing before the update" line; the worker ends; `update()` again applies it: Updating with the breaking wording, Back, a reload, no banner.
// Nothing here touches a real instance, key, port, systemd unit or herdr: the throwaway folder and every child are removed on every exit. It needs `pnpm ui:build` first (the page is `ui/dist`).
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright-core";
// eslint-disable-next-line clean-code/no-duplication -- import list: the rule matches statement shape, and imports are not duplicated logic
import { sandboxGitEnv } from "../src/lib/git-env.ts";
import { buildVersion, fetchMirror, mirrorGit, seedMirror, swapCurrent, withUpdateLock, type Exec } from "../src/install/tool-install.ts";
import { clearDrain, drainPath, readDrain, writeDrain } from "../src/install/update-drain.ts";
import { toolDir } from "../src/install/tool-versions.ts";
import { update, type UpdateDeps } from "../src/install/update.ts";
import { captureHost } from "../src/ticket-mode/capture.ts";
import { pairingCode } from "../src/ticket-mode/pair-command.ts";
import { HOST_FILE_ENV, readTicketSettings } from "../src/ticket-mode/settings.ts";

const CHECKOUT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BOARD_KEY = "0123456789abcdef".repeat(3);
const SECOND_MS = 1000;
const BUILD_MS = 8 * SECOND_MS;
const SLOW_DOWN_MS = 70 * SECOND_MS;
const QUICK_DOWN_MS = 8 * SECOND_MS;
const WAIT_MS = 30 * SECOND_MS;
const RELOAD_MS = 15 * SECOND_MS;
const DRAIN_WAIT_MS = 150 * SECOND_MS;

/** Where everything of one run lives, from its folder alone, so the child that applies an update finds it again. */
function layoutOf(dir: string) {
  const org = join(dir, "org");
  return {
    dir, org, tool: toolDir({ AGENT_ORG_HOME: org }, join(dir, "home")), remote: join(dir, "remote"), state: join(dir, "state"), stub: join(dir, "stub"), hostPath: join(dir, "host.json"),
    queuePath: join(dir, "state", "tickets", "queue.json"), panePid: join(dir, "pane.pid"), pids: join(dir, "services.json"), ports: join(dir, "ports.json"), log: join(dir, "update.log"),
  };
}
type Layout = ReturnType<typeof layoutOf>;

const sleep = (ms: number): Promise<void> => new Promise((done) => { setTimeout(done, ms); });
const sleepSync = (ms: number): void => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };
const GIT_ENV = sandboxGitEnv({ GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" });
const gitIn = (cwd: string) => (args: string[]): string => String(spawnSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).stdout);

/** A free port on 127.0.0.1, found by binding port 0 and letting it go. */
function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const server = createServer().once("error", fail).listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => (typeof address === "object" && address !== null ? done(address.port) : fail(new Error("no port was bound"))));
    });
  });
}

/** The throwaway remote: this checkout's tracked files, committed and tagged as the first release; `release` cuts the next, whose changelog line starts with `summary` (`Breaking: ` marks a breaking release). */
function makeRemote(layout: Layout): (version: string, summary?: "Breaking: ") => void {
  const git = gitIn(layout.remote);
  mkdirSync(layout.remote, { recursive: true });
  git(["init", "--quiet", "--initial-branch=main"]);
  const files = gitIn(CHECKOUT)(["ls-files", "-z", "--cached", "--others", "--exclude-standard"]).split("\0").filter((file) => file !== "" && !file.startsWith("ui/captures/") && existsSync(join(CHECKOUT, file)));
  for (const file of files) cpSync(join(CHECKOUT, file), join(layout.remote, file), { recursive: true });
  // The UI build is linked in by the install stand-in below, not fetched from a GitHub Release.
  const manifest = join(layout.remote, "package.json");
  const { agentOrg: _ships, ...rest } = JSON.parse(readFileSync(manifest, "utf8")) as Record<string, unknown>;
  writeFileSync(manifest, `${JSON.stringify(rest, null, 2)}\n`);
  const commit = (message: string) => { git(["add", "-A"]); git(["-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", message]); };
  const release = (version: string, summary = "") => {
    const changelog = join(layout.remote, "CHANGELOG.md");
    writeFileSync(changelog, readFileSync(changelog, "utf8").replace("# agent-org\n", `# agent-org\n\n## ${version}\n\n### Minor Changes\n\n- 1a2b3c4: ${summary}release ${version}\n`));
    writeFileSync(join(layout.remote, "RELEASE"), `${version}\n`);
    commit(`v${version}`);
    git(["tag", `v${version}`]);
  };
  release("0.273.0");
  return release;
}

/** The dependency install, as a stand-in: it takes a while (the build holds `update.lock` and `<name>.partial` meanwhile), links this checkout's `node_modules`, and gives the release its UI build. */
const install: Exec = (_file, _args, options) => {
  const folder = (options as { cwd: string }).cwd;
  sleepSync(BUILD_MS);
  symlinkSync(join(CHECKOUT, "node_modules"), join(folder, "node_modules"), "dir");
  cpSync(join(CHECKOUT, "ui", "dist"), join(folder, "ui-build"), { recursive: true });
};

const OFFLINE = { releases: () => null, exec: () => { throw new Error("no network in this check"); } };

/** The herdr the services use: it lists the run's workspace for as long as the worker's process (`pane.pid`) is alive, and starts and stops nothing. */
function writeHerdr(layout: Layout): void {
  mkdirSync(layout.stub, { recursive: true });
  const listing = JSON.stringify({ result: { workspaces: [{ label: "t-t-1", workspace_id: "w1", agent_status: "working" }] } });
  writeFileSync(join(layout.stub, "herdr"), [
    "#!/bin/sh",
    `case "$*" in *"workspace list"*) if kill -0 "$(cat ${layout.panePid} 2>/dev/null)" 2>/dev/null; then echo '${listing}'; else echo '{"result":{"workspaces":[]}}'; fi ;; esac`,
    "exit 0", "",
  ].join("\n"));
  chmodSync(join(layout.stub, "herdr"), 0o755);
}

const servicesEnv = (layout: Layout): NodeJS.ProcessEnv => ({
  ...process.env, AGENT_ORG_HOME: layout.org, [HOST_FILE_ENV]: layout.hostPath, HOME: join(layout.dir, "home"), XDG_CONFIG_HOME: join(layout.dir, "xdg"), PATH: `${layout.stub}${delimiter}${process.env.PATH ?? ""}`,
});

/** Starts `ticket:serve` and `ticket:ui` through `current`, so each runs on the folder `current` names now, and records their pids. */
function startServices(layout: Layout): ChildProcess[] {
  const bin = join(layout.tool, "current", "src", "bin.ts");
  const children = ["ticket:serve", "ticket:ui"].map((command) => spawn(process.execPath, [bin, command, ...(command === "ticket:ui" ? ["--no-open"] : [])], { env: servicesEnv(layout), stdio: "ignore", detached: true }));
  for (const child of children) child.unref();
  writeFileSync(layout.pids, JSON.stringify(children.map((child) => child.pid)));
  return children;
}

function stopServices(layout: Layout): void {
  if (!existsSync(layout.pids)) return;
  for (const pid of JSON.parse(readFileSync(layout.pids, "utf8")) as number[]) {
    try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ }
  }
}

const portsOf = (layout: Layout): { port: number; uiPort: number } => JSON.parse(readFileSync(layout.ports, "utf8")) as { port: number; uiPort: number };

/** The live runs of the throwaway queue, which `update` reads to decide whether a breaking release drains. */
function liveRuns(layout: Layout): number {
  const queue = JSON.parse(readFileSync(layout.queuePath, "utf8")) as { entries: { phase: string }[] };
  return queue.entries.filter((entry) => entry.phase === "running" || entry.phase === "starting").length;
}

/** `update()` as the command runs it: under the update lock, with the real build, swap and drain, and the services restarted by stopping both, holding them down, and starting both on `current`. */
function applyUpdate(layout: Layout, downMs: number): void {
  const env = { AGENT_ORG_HOME: layout.org } as NodeJS.ProcessEnv;
  const git = mirrorGit(layout.tool);
  const drainFile = drainPath(env, join(layout.dir, "home"));
  let restarted = false;
  const said: string[] = [];
  const deps: UpdateDeps = {
    root: join(layout.tool, "versions", "v0.273.0"), git,
    fetch: (channel) => fetchMirror(git, channel),
    build: (name, ref) => buildVersion({ tool: layout.tool, name, ref, exec: install, pnpm: (args) => ({ command: "pnpm", args }), ui: OFFLINE }),
    completeUi: (name) => ({ state: "present", folder: join(layout.tool, "versions", name) }),
    swap: (name) => swapCurrent(layout.tool, name),
    current: () => { try { return readlinkName(join(layout.tool, "current")); } catch { return null; } },
    pinned: () => undefined,
    state: () => "running",
    restart: (name) => {
      said.push(`restart ${name}`);
      if (restarted) return;
      restarted = true;
      stopServices(layout);
      sleepSync(downMs);
      startServices(layout);
    },
    liveRuns: () => liveRuns(layout),
    inUse: () => [join(layout.tool, "versions", "v0.273.0")],
    prune: () => [],
    migrate: () => [],
    drain: { read: () => readDrain(drainFile), write: (record) => writeDrain(drainFile, record), clear: () => clearDrain(drainFile) },
    maxDeferHours: 2, now: () => Date.now(), status: { write: () => undefined }, upkeep: () => [], conventions: () => ({ said: [], failed: [] }), hostInstall: () => ({ said: [], failed: [] }), herdr: () => ({ said: [], failed: [] }),
    out: { log: (line: string) => said.push(line), error: (line: string) => said.push(`error: ${line}`) },
  };
  try {
    const moved = withUpdateLock(layout.tool, () => update({ version: undefined, channel: "release" }, deps));
    said.push(`moved: ${moved}`);
  } finally {
    writeFileSync(layout.log, `${said.join("\n")}\n`, { flag: "a" });
  }
}

const readlinkName = (link: string): string => basename(readlinkSync(link));

/** Runs `applyUpdate` in a child of this script, so the browser is driven while the update builds and the services are down. Resolves with the child's exit code. */
function updateInChild(layout: Layout, downMs: number): Promise<number> {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "--update", layout.dir, String(downMs)], { env: process.env, stdio: "inherit" });
  return new Promise((done) => { child.once("exit", (code) => done(code ?? 1)); });
}

const checks: string[] = [];
function expectThat<T>(label: string, got: T, holds: (value: T) => boolean): void {
  const ok = holds(got);
  checks.push(`${ok ? "PASS" : "FAIL"}: ${label}${ok ? "" : ` (got ${JSON.stringify(got)})`}`);
  process.stdout.write(`${checks.at(-1)}\n`);
  if (!ok) throw new Error(`${label}: got ${JSON.stringify(got)}`);
}

const textOf = (page: Page, selector: string): Promise<string> => page.locator(selector).first().textContent({ timeout: WAIT_MS }).then((text) => text ?? "");
const queueOf = async (layout: Layout): Promise<{ entries: { ticket: { key: string }; phase: string; toolVersion?: string }[]; update: { version: string | null; note: unknown; next: string | null } }> => {
  const { port } = portsOf(layout);
  const answer = await fetch(`http://127.0.0.1:${port}/api/queue`, { headers: { "x-ticket-token": BOARD_KEY } });
  return answer.json() as Promise<Awaited<ReturnType<typeof queueOf>>>;
};
const paneAlive = (layout: Layout): boolean => { try { process.kill(Number(readFileSync(layout.panePid, "utf8")), 0); return true; } catch { return false; } };

/** The services answer, on the version `expected` when given. */
async function waitForInstance(layout: Layout, expected?: string): Promise<void> {
  const until = Date.now() + 90 * SECOND_MS;
  while (Date.now() < until) {
    const read = await queueOf(layout).catch(() => null);
    if (read !== null && (expected === undefined || read.update.version === expected)) return;
    await sleep(500);
  }
  throw new Error(`the instance did not answer${expected === undefined ? "" : ` on ${expected}`}`);
}

/** The first install, as `update` makes one: the mirror, `versions/v0.273.0`, `current`, a herdr stub, the host file, and a queue holding one live run whose worker is a real process. Returns that process. */
function installFirst(layout: Layout, { port, uiPort }: { port: number; uiPort: number }): ChildProcess {
  const git = mirrorGit(layout.tool);
  seedMirror(layout.tool, layout.remote);
  fetchMirror(git, "release");
  const built = buildVersion({ tool: layout.tool, name: "v0.273.0", ref: "refs/tags/v0.273.0", exec: install, pnpm: (args) => ({ command: "pnpm", args }), ui: OFFLINE });
  if (built.state === "failed") throw new Error(built.reason);
  swapCurrent(layout.tool, "v0.273.0");
  writeHerdr(layout);
  mkdirSync(join(layout.state, "tickets"), { recursive: true });
  writeFileSync(join(layout.dir, "linear-key"), "placeholder\n", { mode: 0o600 });
  writeFileSync(join(layout.state, "tickets", "board.key"), `${BOARD_KEY}\n`, { mode: 0o600 });
  writeFileSync(layout.hostPath, JSON.stringify(captureHost({ checkout: join(layout.tool, "current"), stateDir: layout.state, binDir: join(layout.dir, "bin"), port, uiPort, keyPath: join(layout.dir, "linear-key") })), { mode: 0o600 });
  const pane = spawn("sleep", ["3600"], { stdio: "ignore" });
  writeFileSync(layout.panePid, String(pane.pid));
  const run = { ticket: { key: "T-1", title: "A worker at work, held by herdr", url: "" }, repos: [], model: "opus", effort: "high", planned: true, queuedAt: Date.now() - 60_000, phase: "running", startedAt: Date.now() - 30_000, workspace: "w1", pane: "w1:p1", toolVersion: "v0.273.0", toolRoot: join(layout.tool, "versions", "v0.273.0") };
  writeFileSync(layout.queuePath, JSON.stringify({ paused: true, max: 3, entries: [run] }));
  return pane;
}

/** A paired Chromium on the Runs page of the throwaway board, once it shows the run. */
async function openRuns(browser: Browser, layout: Layout, uiPort: number): Promise<Page> {
  const { code } = await pairingCode(readTicketSettings({ [HOST_FILE_ENV]: layout.hostPath }, undefined, dirname(layout.hostPath)));
  const paired = await fetch(`http://127.0.0.1:${uiPort}/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code }) });
  const session = /^(ticket_session)=([^;]+)/.exec(paired.headers.getSetCookie()[0] ?? "");
  if (!paired.ok || session === null) throw new Error(`the throwaway board did not pair (${paired.status})`);
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addCookies([{ name: session[1], value: session[2], url: `http://127.0.0.1:${uiPort}` }]);
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${uiPort}/runs`);
  await page.locator("#run-T-1").waitFor({ timeout: WAIT_MS });
  return page;
}

/** The page reloaded itself onto the new version, and shows the Runs page again. */
async function reloaded(page: Page): Promise<void> {
  await page.waitForEvent("load", { timeout: RELOAD_MS });
  await page.locator("#run-T-1").waitFor({ timeout: WAIT_MS });
}

/** (1) A normal update with the run live: Updating, Slow, Back, a reload; the run and its worker carry on. */
async function normalUpdate(layout: Layout, page: Page, release: (version: string) => void): Promise<void> {
  release("0.280.0");
  const normal = updateInChild(layout, SLOW_DOWN_MS);
  await page.locator(".updating-card").waitFor({ timeout: BUILD_MS + SLOW_DOWN_MS });
  expectThat("a normal update: the page left open shows Updating Atomaut, from v0.273 to v0.280", [await textOf(page, ".updating-title"), await textOf(page, ".updating-sub")], ([title, sub]) => title === "Updating Atomaut" && sub === "Moving this instance from v0.273 to v0.280. This page reconnects by itself.");
  expectThat("and the pill is amber Updating, the sidebar kept, and the runs sentence is the normal one", [await textOf(page, ".pill"), await page.locator(".sidebar").count(), await textOf(page, ".updating-runs")], ([pill, sidebar, runs]) => pill === "Updating" && sidebar === 1 && runs === "Runs already working keep going. Each stays on the version it started on, and new runs start on v0.280.");
  expectThat("the worker's process is alive while the board is down", paneAlive(layout), Boolean);
  await page.getByRole("heading", { name: "Still updating" }).waitFor({ timeout: SLOW_DOWN_MS });
  expectThat("after a minute of failed polls it is Still updating, with the agent-org doctor note", await textOf(page, ".updating-slow"), (note) => note.includes("agent-org doctor"));
  await page.getByRole("heading", { name: "Updated to v0.280" }).waitFor({ timeout: SLOW_DOWN_MS });
  expectThat("when the board answers on v0.280 the page shows Updated to v0.280 with Back to Tickets, and the pill is Connected", [await page.getByRole("link", { name: "Back to Tickets" }).getAttribute("href"), await textOf(page, ".pill")], ([href, pill]) => href === "/tickets" && pill === "Connected");
  await reloaded(page);
  expectThat("five seconds later the page reloads onto the new version, and shows the Runs page again", await page.locator(".updating-card").count(), (cards) => cards === 0);
  expectThat("the update finished (exit 0)", await normal, (status) => status === 0);
  const after = await queueOf(layout);
  const run = after.entries.find((entry) => entry.ticket.key === "T-1");
  expectThat("the run kept going through the normal update: still running, on v0.273, while the instance runs v0.280", [run?.phase, run?.toolVersion, after.update.version], ([phase, tool, version]) => phase === "running" && tool === "v0.273.0" && version === "v0.280.0");
  expectThat("and the worker's process is the same live process", paneAlive(layout), Boolean);
}

/** (2) A breaking release, drained while the run is live: the banner and the run's line; then the worker ends and the update applies: Updating, Back, a reload, no banner. */
async function breakingUpdate(layout: Layout, page: Page, pane: ChildProcess, release: (version: string, summary: "Breaking: ") => void): Promise<void> {
  release("0.281.0", "Breaking: ");
  expectThat("a breaking release with a run live is built and drained, not applied (exit 0)", await updateInChild(layout, QUICK_DOWN_MS), (status) => status === 0);
  await page.locator(".drain-banner").waitFor({ timeout: WAIT_MS });
  expectThat("the Runs page shows the amber banner, from the backend's words", await textOf(page, ".drain-banner"), (text) => /^Updating to v0\.281 \(breaking\): no new runs start; 1 run finishing; forced at \d\d:\d\d$/.test(text));
  expectThat("and the live run's note says finishing before the update", await textOf(page, "#run-T-1 .run-note"), (note) => note.includes("finishing before the update"));
  expectThat("nothing was swapped: the instance still runs v0.280, and the page shows no card", [(await queueOf(layout)).update.version, await page.locator(".updating-card").count()], ([version, cards]) => version === "v0.280.0" && cards === 0);
  pane.kill("SIGTERM");
  const until = Date.now() + DRAIN_WAIT_MS;
  while (Date.now() < until && (await queueOf(layout)).entries.some((entry) => entry.phase === "running")) await sleep(2 * SECOND_MS);
  expectThat("the worker ends, the board records the run as finished", (await queueOf(layout)).entries.every((entry) => entry.phase !== "running"), Boolean);
  const applying = updateInChild(layout, QUICK_DOWN_MS);
  await page.locator(".updating-card").waitFor({ timeout: BUILD_MS + QUICK_DOWN_MS });
  expectThat("applied, the page shows Updating with the breaking release's words", [await textOf(page, ".updating-sub"), await textOf(page, ".updating-runs")], ([sub, runs]) => sub.startsWith("Moving this instance from v0.280 to v0.281.") && runs.startsWith("This is a breaking release, so it waited for live runs to finish and started no new ones."));
  await page.getByRole("heading", { name: "Updated to v0.281" }).waitFor({ timeout: SLOW_DOWN_MS });
  expectThat("and Back, with the breaking release's Back words", await textOf(page, ".updating-runs"), (runs) => runs.startsWith("This was a breaking release, so no new runs started while it waited."));
  await reloaded(page);
  const drain = readDrain(drainPath({ AGENT_ORG_HOME: layout.org } as NodeJS.ProcessEnv, join(layout.dir, "home"))).kind;
  expectThat("the page reloads, with no banner and no card; the drain record is gone", [await page.locator(".drain-banner").count(), await page.locator(".updating-card").count(), drain], ([banner, card, kind]) => banner === 0 && card === 0 && kind === "none");
  expectThat("the breaking update finished (exit 0), and the instance runs v0.281", [await applying, (await queueOf(layout)).update.version], ([status, version]) => status === 0 && version === "v0.281.0");
}

async function main(layout: Layout): Promise<void> {
  const release = makeRemote(layout);
  const ports = { port: await freePort(), uiPort: await freePort() };
  writeFileSync(layout.ports, JSON.stringify(ports));
  const pane = installFirst(layout, ports);
  startServices(layout);
  const browser = await chromium.launch({ headless: true });
  try {
    await waitForInstance(layout, "v0.273.0");
    const page = await openRuns(browser, layout, ports.uiPort);
    expectThat("the Runs page shows the run, no card, and the pill says Connected", [await page.locator(".updating-card").count(), await textOf(page, ".pill")], ([cards, pill]) => cards === 0 && pill === "Connected");
    await normalUpdate(layout, page, release);
    await breakingUpdate(layout, page, pane, release);
  } finally {
    await browser.close();
    pane.kill("SIGTERM");
    stopServices(layout);
  }
}

if (process.argv[2] === "--update") {
  // The child that applies one update.
  applyUpdate(layoutOf(process.argv[3]), Number(process.argv[4]));
} else {
  const dir = mkdtempSync(join(tmpdir(), "agent-org-update-check-"));
  try {
    await main(layoutOf(dir));
  } catch (err) {
    process.stderr.write(`${checks.join("\n")}\nFAIL: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  } finally {
    if (existsSync(join(dir, "update.log"))) process.stdout.write(`the update's own log:\n${readFileSync(join(dir, "update.log"), "utf8")}`);
    rmSync(dir, { recursive: true, force: true });
  }
}
