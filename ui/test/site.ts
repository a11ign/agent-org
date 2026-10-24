// module: the built site, served for a page check -- `astro preview` over `dist/`, on a free port, and the Chromium that playwright-core pins
//
// A PAGE CHECK READS THE BUILD, NOT THE SOURCE, so it refuses before anything starts when `dist/` is missing, and says which command makes it.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { chromium, type Browser } from "playwright-core";

/** The package's directory, `ui/`. */
export const UI_ROOT = fileURLToPath(new URL("../", import.meta.url));

const STARTUP_MS = 30_000;
const POLL_MS = 100;
const STOP_MS = 5_000;
const MS_PER_SECOND = 1000;

/** REFUSES, naming the command that makes it, when `dist` does not hold a build. */
export function requireBuild(dist: string = `${UI_ROOT}dist`): void {
  if (!existsSync(`${dist}/index.html`)) throw new Error(`${dist} holds no build: run \`pnpm ui:build\` first`);
}

/** A port nothing answers on, found by binding port 0 and letting it go. */
export function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const server = createServer();
    server.once("error", fail);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => (typeof address === "object" && address !== null ? done(address.port) : fail(new Error("no port was bound"))));
    });
  });
}

/** A running site: its origin, and how to stop it. */
export type Site = Readonly<{ origin: string; stop: () => Promise<void> }>;

async function waitUntilAnswering(origin: string, stderr: () => string): Promise<void> {
  const deadline = Date.now() + STARTUP_MS;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${origin}/next/`)).ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((done) => setTimeout(done, POLL_MS));
  }
  throw new Error(`astro preview did not answer at ${origin} within ${STARTUP_MS / MS_PER_SECOND} seconds: ${stderr().trim()}`);
}

/** Serves `dist/` with `astro preview` on a free port. REFUSES, before it starts anything, when there is no build. */
export async function startSite(): Promise<Site> {
  requireBuild();
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [`${UI_ROOT}node_modules/astro/bin/astro.mjs`, "preview", "--ignore-lock", "--host", "127.0.0.1", "--port", String(port)], { cwd: UI_ROOT, stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
  const stop = () => new Promise<void>((done) => {
    if (child.exitCode !== null) return done();
    const timer = setTimeout(() => child.kill("SIGKILL"), STOP_MS);
    child.once("exit", () => { clearTimeout(timer); done(); });
    child.kill("SIGTERM");
  });
  try {
    await waitUntilAnswering(origin, () => stderr);
  } catch (err) {
    await stop();
    throw err;
  }
  return { origin, stop };
}

/** The headless Chromium `playwright-core` is pinned to, the build `onboard` and `doctor` install (A11-151). */
export const launchBrowser = (): Promise<Browser> => chromium.launch({ headless: true });
