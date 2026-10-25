// no-token: none -- the children, the browser, the ports and the pairing are stand-ins; the throwaway directory, host file and output are real, in temporary folders
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "../lib/tmp-fixture.ts";
import { chromiumProblems, type ChromiumReport } from "../install/chromium.ts";
import { boardKey, boardKeyPath } from "./board-key.ts";
import { CaptureRefusal } from "./capture.ts";
import { type CaptureDeps, type CaptureRequest, type Running, type Shot, captureFile, captureRoute } from "./capture-command.ts";

const READY: ChromiumReport = {
  builds: [{ build: "chromium", binary: "/cache/chromium/chrome", missing: [] }, { build: "chromium-headless-shell", binary: "/cache/shell/chrome-headless-shell", missing: [] }],
  unchecked: null,
};

/** A child that runs until it is stopped, and says `stderr`. `exited` makes it report that it has exited already. */
type Child = Running & { stopped: boolean };
function childThat(stderr = "", exited = false): Child {
  let done = exited;
  const running: Child = { stopped: false, exited: () => done, stderr: () => stderr, kill: () => { done = true; }, stop: async () => { running.stopped = true; done = true; } };
  return running;
}

/** The board the throwaway UI is: it answers a pairing code to the key, and a session cookie to the code. */
const board: typeof fetch = (async (url: string | URL | Request) => {
  const path = new URL(String(url)).pathname;
  if (path === "/api/pair-code") return new Response(JSON.stringify({ code: "ABCD-1234", minutes: 10 }), { status: 200 });
  if (path === "/pair") return new Response(JSON.stringify({ paired: true }), { status: 200, headers: { "set-cookie": "ticket_session=session-1; HttpOnly; Path=/" } });
  return new Response("", { status: 404 });
}) as typeof fetch;

type Spawned = { file: string; args: string[]; env: Record<string, string> };
type Harness = Readonly<{ deps: CaptureDeps; dir: string; outDir: string; spawned: Spawned[]; children: Child[]; shots: Shot[]; copies: [string, string][]; hosts: string[]; request: CaptureRequest }>;

/**
 * The capture's dependencies. The throwaway directory is a fresh temporary folder, which the capture removes; the board's key is written where the UI would
 * write it, so the pairing reads it. `start` makes each child, and `over` replaces any dependency.
 */
function harness(over: Partial<CaptureDeps> = {}, start: () => Child = () => childThat()): Harness {
  const dir = tmpDir("capture-tmp-");
  const outDir = tmpDir("capture-out-");
  const spawned: Spawned[] = [];
  const children: Child[] = [];
  const shots: Shot[] = [];
  const copies: [string, string][] = [];
  const hosts: string[] = [];
  let port = 47900;
  let clock = 0;
  const deps: CaptureDeps = {
    checkout: "/work/agent-org",
    env: { HOME: "/home/me", PATH: "/usr/bin:/bin" },
    chromium: () => READY,
    tmp: () => dir,
    freePort: async () => { port += 1; return port; },
    spawn: (file, args, env) => {
      spawned.push({ file, args, env });
      // The host file is removed when the capture ends, so the instance's is kept as it is when the instance starts.
      if (args.includes("ticket:serve")) hosts.push(readFileSync(env.AGENT_ORG_HOST, "utf8"));
      if (args.includes("ticket:ui")) boardKey(boardKeyPath(join(dir, "state")));
      const running = start();
      children.push(running);
      return running;
    },
    listening: async () => true,
    request: board,
    shoot: async (shot) => {
      shots.push(shot);
      writeFileSync(shot.path, "png");
    },
    copyQueue: (from, to) => copies.push([from, to]),
    remove: (path) => rmSync(path, { recursive: true, force: true }),
    now: () => { clock += 1; return clock; },
    sleep: async () => {},
    ...over,
  };
  return { deps, dir, outDir, spawned, children, shots, copies, hosts, request: { route: "/settings", size: { width: 1280, height: 800 }, out: outDir, queue: null } };
}

test("a capture refuses before anything starts when a Chromium build is missing, and names the command", async () => {
  const missing: ChromiumReport = { builds: [{ build: "chromium", binary: null, missing: [] }, READY.builds[1]], unchecked: null };
  const h = harness({ chromium: () => missing });
  await assert.rejects(captureRoute(h.request, h.deps), (err: Error) => err instanceof CaptureRefusal && err.message === chromiumProblems(missing).join("\n"));
  assert.equal(h.spawned.length, 0, "no child starts");
  assert.equal(existsSync(h.dir), true, "nothing was made, so nothing needed removing");
});

test("a capture starts the throwaway instance and board, pairs, shoots the route at the size, and writes the file named for it", async () => {
  const h = harness();
  const written = await captureRoute(h.request, h.deps);
  assert.equal(written, join(h.outDir, "settings-1280x800.png"));
  assert.equal(readFileSync(written, "utf8"), "png");
  assert.deepEqual(h.spawned.map((s) => s.args.slice(1)), [["ticket:serve"], ["ticket:ui", "--no-open"]]);
  for (const s of h.spawned) {
    assert.equal(s.file, process.execPath);
    assert.equal(s.args[0], "/work/agent-org/src/bin.ts", "the checkout the command runs from");
    assert.equal(s.env.XDG_CONFIG_HOME, join(h.dir, "xdg"), "no real connections file is read");
    assert.equal(s.env.AGENT_ORG_HOST, join(h.dir, "host.json"), "the throwaway host file");
    assert.equal(s.env.PATH, `${join(h.dir, "stub")}:/usr/bin:/bin`, "the stub herdr is first, and the rest of PATH is kept");
    assert.equal(s.env.HOME, "/home/me", "the rest of the environment is kept");
  }
  assert.equal(h.shots.length, 1);
  const [shot] = h.shots;
  assert.equal(shot.url, `http://127.0.0.1:${shot.origin.split(":")[2]}/settings`);
  assert.deepEqual(shot.size, { width: 1280, height: 800 });
  assert.deepEqual(shot.cookie, { name: "ticket_session", value: "session-1" }, "the browser carries the session the board gave");
  assert.equal(shot.ready, "main .shell-page h1");
});

test("the UI is on a port the capture chose, distinct from the instance's, and both children and the directory are gone at the end", async () => {
  const h = harness();
  await captureRoute(h.request, h.deps);
  const uiPort = Number(h.shots[0].origin.split(":")[2]);
  const instancePort = Number(JSON.parse(h.hosts[0]).tickets.providers.exposure.port);
  assert.notEqual(uiPort, instancePort, "the instance and the board never share a port");
  assert.equal(h.children.every((running) => (running as Child).stopped), true, "both children are stopped");
  assert.equal(existsSync(h.dir), false, "the throwaway directory is removed");
});

test("the throwaway directory and both children are removed when the browser fails", async () => {
  const h = harness({ shoot: async () => { throw new Error("the browser could not start"); } });
  await assert.rejects(captureRoute(h.request, h.deps), /the browser could not start/);
  assert.equal(h.children.every((running) => running.stopped), true);
  assert.equal(existsSync(h.dir), false);
});

test("a server that stops before it answers is refused with what it printed, and the rest is removed", async () => {
  const h = harness({ listening: async () => false }, () => childThat("ERROR: the state folder is locked", true));
  await assert.rejects(captureRoute(h.request, h.deps), (err: Error) => err instanceof CaptureRefusal && /ticket:serve stopped before it answered .*the state folder is locked/.test(err.message));
  assert.equal(existsSync(h.dir), false);
  assert.equal(h.children.every((running) => running.stopped), true);
});

test("a server that never answers is refused once its start time has passed, and the rest is removed", async () => {
  let tick = 0;
  const h = harness({ listening: async () => false, now: () => { tick += 20_000; return tick; } });
  await assert.rejects(captureRoute(h.request, h.deps), (err: Error) => err instanceof CaptureRefusal && /ticket:serve did not answer on 127\.0\.0\.1:\d+ within 30 seconds/.test(err.message));
  assert.equal(existsSync(h.dir), false);
  assert.equal(h.children.every((running) => running.stopped), true);
});

test("a --queue file is copied into the throwaway state folder, where the board reads it", async () => {
  const h = harness();
  await captureRoute({ ...h.request, queue: "/tmp/queue.json" }, h.deps);
  assert.deepEqual(h.copies, [["/tmp/queue.json", join(h.dir, "state", "tickets", "queue.json")]]);
});

test("a capture writes to the file it is given, making the folders it needs", async () => {
  const h = harness();
  const target = join(h.outDir, "deep", "settings.png");
  const written = await captureRoute({ ...h.request, out: target }, h.deps);
  assert.equal(written, target);
  assert.equal(existsSync(target), true);
});

test("captureFile names a file inside a folder, and keeps a file's own name", () => {
  const isDirectory = (path: string) => path === "/shots";
  assert.equal(captureFile("/shots", "settings-1280x800.png", isDirectory), "/shots/settings-1280x800.png");
  assert.equal(captureFile("/new/", "settings-1280x800.png", () => false), "/new/settings-1280x800.png", "a trailing slash names a folder that is yet to be made");
  assert.equal(captureFile("/shots/a.png", "settings-1280x800.png", isDirectory), "/shots/a.png");
});
