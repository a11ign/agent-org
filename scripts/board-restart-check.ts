// A11-211: the board's page across an instance restart, in a real browser, against this checkout's own `ticket:ui` (the page is Atomaut's Run detail since A11-202).
//
//   node scripts/board-restart-check.ts
//
// It starts this checkout's board page (`ticket:ui`) on a free port from a throwaway host file and state folder, with a stand-in instance on the port the page proxies to,
// pairs a headless Chromium, and opens the run's page. It then stops the instance for longer than one poll, as an update's restart does, and checks what the tab shows:
// "Reconnecting…" and no red while it is down, and, once the instance is back on a different pane, the tab focused again shows the current queue, no red, and the run's
// Talk to it link on the new pane, with no reload. Nothing here touches a real instance, key or port; the throwaway folder and both children are removed on every exit.
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Page } from "playwright-core";
import { captureHost, HERDR_STUB } from "../src/ticket-mode/capture.ts";
import { pairingCode } from "../src/ticket-mode/pair-command.ts";
import { HOST_FILE_ENV, readTicketSettings } from "../src/ticket-mode/settings.ts";

const CHECKOUT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BOARD_KEY = "0123456789abcdef".repeat(3);
const TERMINAL = "http://127.0.0.1:7318/?ws={workspace}&pane={pane}&view=terminal";
const POLL_WAIT_MS = 6_500;
const BOARD_WAIT_MS = 30_000;

/** A free port on 127.0.0.1, found by binding port 0 and letting it go. */
function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const server = createServer().once("error", fail).listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => (typeof address === "object" && address !== null ? done(address.port) : fail(new Error("no port was bound"))));
    });
  });
}

/** The stand-in instance: the answers the board's page reads, with the one run on the pane `pane()` names now. */
function instanceAnswering(pane: () => string): Server {
  const entry = () => ({ ticket: { key: "T-1", title: "a run", url: "" }, repos: [], model: "opus", effort: "high", queuedAt: 1, phase: "running", startedAt: 3, workspace: pane().split(":")[0], pane: pane() });
  const answers: Record<string, () => unknown> = {
    "/api/config": () => ({ models: ["opus"], efforts: ["high"], max: 3, terminal: TERMINAL, choice: { model: "opus", effort: "high" } }),
    "/api/queue": () => ({ entries: [entry()], max: 3, paused: true, pulls: {} }),
    "/api/tickets": () => [],
    "/api/parents": () => [],
  };
  return createServer((request, response) => {
    const answer = answers[request.url ?? ""];
    response.writeHead(answer === undefined ? 404 : 200, { "Content-Type": "application/json" });
    response.end(JSON.stringify(answer === undefined ? { error: `no route ${request.url}` } : answer()));
  });
}

const listen = (server: Server, port: number): Promise<void> => new Promise((done) => { server.listen(port, "127.0.0.1", done); });
const close = (server: Server): Promise<void> => new Promise((done) => { server.closeAllConnections(); server.close(() => done()); });
const sleep = (ms: number): Promise<void> => new Promise((done) => { setTimeout(done, ms); });

/** The throwaway host file, board key and herdr stub in `dir`, and the board page started from them. */
async function startBoard(dir: string, port: number, uiPort: number): Promise<Readonly<{ ui: ChildProcess; hostPath: string }>> {
  const stateDir = join(dir, "state");
  mkdirSync(join(stateDir, "tickets"), { recursive: true });
  mkdirSync(join(dir, "stub"), { recursive: true });
  const hostPath = join(dir, "host.json");
  writeFileSync(hostPath, JSON.stringify(captureHost({ checkout: CHECKOUT, stateDir, binDir: join(dir, "bin"), port, uiPort, keyPath: join(dir, "linear-key") })), { mode: 0o600 });
  writeFileSync(join(dir, "linear-key"), "placeholder\n", { mode: 0o600 });
  writeFileSync(join(stateDir, "tickets", "board.key"), `${BOARD_KEY}\n`, { mode: 0o600 });
  writeFileSync(join(dir, "stub", "herdr"), HERDR_STUB);
  chmodSync(join(dir, "stub", "herdr"), 0o755);
  const env = { ...process.env, [HOST_FILE_ENV]: hostPath, XDG_CONFIG_HOME: join(dir, "xdg"), PATH: `${join(dir, "stub")}${delimiter}${process.env.PATH ?? ""}` };
  const ui = spawn(process.execPath, [join(CHECKOUT, "src", "bin.ts"), "ticket:ui", "--no-open"], { env, stdio: "ignore" });
  const until = Date.now() + BOARD_WAIT_MS;
  while (Date.now() < until && !(await fetch(`http://127.0.0.1:${uiPort}/`).then(() => true, () => false))) await sleep(100);
  return { ui, hostPath };
}

/** What the tab shows: the Reconnecting line, the red banner's message, and the href of the run's Talk to it link (the header's), decoded, or empty when the page draws none. */
const shown = (page: Page) => page.evaluate(() => {
  const talk = Array.from(document.querySelectorAll("a")).find((link) => link.textContent.trim() === "Talk to it");
  return {
    reconnecting: document.querySelector(".reconnecting-note")?.textContent ?? "",
    error: document.querySelector("[role=alert]")?.textContent ?? "",
    link: decodeURIComponent(talk?.href ?? ""),
  };
});

const checks: string[] = [];
function expectThat<T>(label: string, got: T, holds: (value: T) => boolean): void {
  const ok = holds(got);
  checks.push(`${ok ? "PASS" : "FAIL"}: ${label}${ok ? "" : ` (got ${JSON.stringify(got)})`}`);
  if (!ok) throw new Error(`${label}: got ${JSON.stringify(got)}`);
}

async function main(dir: string): Promise<void> {
  let pane = "w1:p1";
  const [port, uiPort] = [await freePort(), await freePort()];
  const instance = instanceAnswering(() => pane);
  await listen(instance, port);
  const { ui, hostPath } = await startBoard(dir, port, uiPort);
  const browser = await chromium.launch({ headless: true });
  try {
    const { code } = await pairingCode(readTicketSettings({ [HOST_FILE_ENV]: hostPath }, undefined, dirname(hostPath)));
    const paired = await fetch(`http://127.0.0.1:${uiPort}/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code }) });
    const session = /^(ticket_session)=([^;]+)/.exec(paired.headers.getSetCookie()[0] ?? "");
    if (!paired.ok || session === null) throw new Error(`the throwaway board did not pair (${paired.status})`);
    const context = await browser.newContext();
    await context.addCookies([{ name: session[1], value: session[2], url: `http://127.0.0.1:${uiPort}` }]);
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${uiPort}/runs/T-1`);
    await page.getByRole("link", { name: "Talk to it" }).waitFor({ state: "attached" });
    const before = await shown(page);
    expectThat("the run's page draws its Talk to it link on its pane", before.link, (link) => link.includes("pane=w1%3Ap1"));
    expectThat("and shows no red and no Reconnecting line", before, ({ error, reconnecting }) => error === "" && reconnecting === "");

    // The tab goes to the background, the instance restarts for longer than one poll, and comes back with the run on another pane.
    const other = await context.newPage();
    await other.bringToFront();
    await close(instance);
    await sleep(POLL_WAIT_MS);
    const down = await shown(page);
    expectThat("while the instance is down the tab says Reconnecting…", down, ({ reconnecting }) => reconnecting === "Reconnecting…");
    expectThat("and shows no red", down, ({ error }) => error === "");
    pane = "w2:p1";
    const restarted = instanceAnswering(() => pane);
    await listen(restarted, port);

    // Coming back to the tab: the window is focused, with no reload.
    await page.bringToFront();
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await page.waitForFunction(() => {
      const talk = Array.from(document.querySelectorAll("a")).find((link) => link.textContent.trim() === "Talk to it");
      return document.querySelector("[role=alert]") === null && /pane=w2/.test(decodeURIComponent(talk?.href ?? ""));
    }, undefined, { timeout: POLL_WAIT_MS }).catch(() => undefined);
    const after = await shown(page);
    expectThat("back at the tab, Reconnecting is gone and there is no red", after, ({ error, reconnecting }) => error === "" && reconnecting === "");
    expectThat("and the run's Talk to it link points at the pane it has now", after.link, (link) => link.includes("pane=w2%3Ap1"));
    await close(restarted);
  } finally {
    await browser.close();
    ui.kill("SIGTERM");
    await close(instance).catch(() => undefined);
  }
}

const dir = mkdtempSync(join(tmpdir(), "agent-org-restart-check-"));
try {
  await main(dir);
  process.stdout.write(`${checks.join("\n")}\n`);
} catch (err) {
  process.stderr.write(`${checks.join("\n")}\nFAIL: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
} finally {
  rmSync(dir, { recursive: true, force: true });
}
