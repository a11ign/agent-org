// no-token: none -- `systemctl`, `launchctl`, `herdr` and the process list are recording stand-ins, and every unit is written into a temporary HOME
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { COMMANDS } from "../commands.ts";
import { createFakeCodeHost } from "../plugins/fakes/code-host.ts";
import { createFakeTracker } from "../plugins/fakes/tracker.ts";
import { tmpDir } from "../lib/tmp-fixture.ts";
import { createPool } from "../ticket-mode/pool.ts";
import { herdrServerCommand, herdrServiceOf } from "../ticket-mode/pool-herdr.ts";
import { emptyQueue } from "../ticket-mode/queue.ts";
import { parseTicketSettings } from "../ticket-mode/settings.ts";
import { cgroupPath, type HerdrPlace, herdrPlace, isHerdrServer, type PlaceReads } from "./herdr-place.ts";
import { startHerdr, type MoveDeps } from "./herdr-move.ts";
import { guardPaths, retireGuards } from "./interim-guards.ts";
import { main, runAutoUpdateNow, SERVICE_NAMES, ServiceRefusal, startService, TOOL_SERVICES, unitFor, type RunResult, type ServiceDeps } from "./service.ts";

const done = (stdout = ""): RunResult => ({ status: 0, stdout, stderr: "" });

function setup(platform: NodeJS.Platform = "linux", host: Record<string, unknown> = { tickets: { herdrSession: "work" } }) {
  const home = tmpDir("svc-");
  const files = new Map<string, string>([[join(home, ".agent-org", "host.json"), JSON.stringify(host)], ["/opt/bin/herdr", ""], ["/opt/bin/bun", ""]]);
  const calls: string[] = [];
  const services: ServiceDeps = {
    platform, env: { PATH: "/opt/bin:/usr/bin", GH_CONFIG_DIR: "/gh" }, home, uid: 501, node: "/opt/node/bin/node", toolRoot: join(home, ".agent-org", "tool", "current"), commands: COMMANDS, user: "alice",
    exists: (path) => files.has(path), read: (path) => files.get(path) ?? null, write: (path, text) => { files.set(path, text); },
    run: (file, args) => { calls.push([file, ...args].join(" ")); return done(); },
  };
  return { services, files, calls, home };
}

/** The unit text with the section `[Unit]` and the `[Service]` lines, as systemd reads them. */
const lines = (text: string) => text.split("\n");

test("the herdr unit runs `herdr --session <s> server` with the instance's environment and the agent-org home as its working directory", () => {
  const { services, home } = setup();
  const herdr = unitFor("herdr", services);
  const instance = unitFor("instance", services);
  assert.equal(herdr.id, "agent-org-herdr.service");
  assert.match(herdr.text, /^ExecStart="\/opt\/bin\/herdr" "--session" "work" "server"$/m, "an absolute path: a unit gets no login shell's PATH");
  assert.match(herdr.text, new RegExp(`^WorkingDirectory=${join(home, ".agent-org").replace(/[.]/g, "\\.")}$`, "m"), "never a tool folder: a version folder can be pruned under it");
  const environment = (text: string) => lines(text).filter((line) => line.startsWith("Environment=")).toSorted();
  assert.deepEqual(environment(herdr.text), environment(instance.text), "every pane's shell inherits the server's environment, which was the instance's");
  assert.match(herdr.text, /^Restart=on-failure$/m);
  assert.doesNotMatch(herdr.text, /^KillMode=/m, "the default KillMode: stopping the unit stops its panes, and nothing else does");
  assert.equal(unitFor("herdr", setup("darwin").services).id, "io.github.agent-org.herdr", "launchd carries the same service");
});

test("the herdr unit is refused, naming the fix, when herdr is not on PATH", () => {
  const { services, files } = setup();
  files.delete("/opt/bin/herdr");
  assert.throws(() => unitFor("herdr", services), (error: Error) => error.message === "the herdr service runs `herdr`, and this machine has none on PATH. Run `agent-org onboard`, which installs herdr 0.9.3, then start the herdr service again.");
});

test("the instance and the terminal Want= and start After= herdr, and no unit names it in Requires=, BindsTo= or PartOf=", () => {
  const { services, files } = setup();
  files.set(join(services.home, ".config", "herdr", "plugins.json"), JSON.stringify([{ plugin_id: "devswha.herdr-web-ui", plugin_root: "/opt/plugin" }]));
  for (const name of ["instance", "terminal"] as const) {
    const text = unitFor(name, services).text;
    assert.match(text, /^Wants=agent-org-herdr\.service$/m, `${name} starts herdr`);
    assert.match(text, /^After=network-online\.target agent-org-herdr\.service$/m, `${name} starts after herdr`);
  }
  for (const name of SERVICE_NAMES) {
    const unit = unitFor(name, services);
    for (const text of [unit.text, unit.companion?.text ?? ""]) {
      assert.doesNotMatch(text, /^(Requires|BindsTo|PartOf|Requisite|Upholds)=.*herdr/m, `${name}: a restart of it must not reach herdr`);
      assert.doesNotMatch(text, /^(Requires|BindsTo|PartOf)=.*agent-org-instance/m, `${name}: nothing hangs on the instance's restart either`);
    }
  }
  assert.doesNotMatch(unitFor("ui", services).text, /agent-org-herdr/, "the ui does not need herdr");
});

test("herdr is not a service an update restarts", () => {
  assert.equal((TOOL_SERVICES as readonly string[]).includes("herdr"), false);
  assert.deepEqual([...TOOL_SERVICES], ["instance", "ui"]);
  assert.ok((SERVICE_NAMES as readonly string[]).includes("herdr"));
});

test("starting herdr STARTS the unit and never restarts it, on systemd and on launchd; restarting the instance never names it", async () => {
  const { services, calls } = setup();
  await startService("herdr", services);
  assert.deepEqual(calls, ["systemctl --user daemon-reload", "systemctl --user enable agent-org-herdr.service", "systemctl --user start agent-org-herdr.service"]);
  calls.length = 0;
  await startService("instance", services);
  assert.equal(calls.some((call) => call.includes("herdr")), false, "starting the instance names no herdr call: the Wants= does it");
  const loaded = setup("darwin");
  loaded.services = { ...loaded.services, run: (file, args) => { loaded.calls.push([file, ...args].join(" ")); return done("state = running\n"); } };
  await startService("herdr", loaded.services);
  assert.equal(loaded.calls.some((call) => call.includes("bootout")), false, "a loaded herdr job is left loaded: booting it out ends every pane");
});

test("ensureSession starts the herdr unit when it is registered, and never spawns a server or calls systemd-run", async () => {
  const root = tmpDir("session-");
  const settings = parseTicketSettings({ clones: { a: "/r/a" }, stateDir: root });
  const { services, files, calls } = setup();
  files.set(unitFor("herdr", services).path, "registered");
  let up = false;
  const fake = createFakeTracker();
  const spawned: string[] = [];
  let queue = emptyQueue(1);
  const pool = createPool({ get: () => queue, set: (next) => { queue = next; } }, {
    settings, source: { assigned: fake.assigned, read: fake.read, download: fake.download, keywords: fake.keywords }, codeHost: createFakeCodeHost(), hook: { node: "n", bin: "b" },
    herdr: () => { if (!up) throw new Error("server_not_running"); return JSON.stringify({ result: { workspaces: [] } }); },
    wait: async () => { up = true; }, herdrService: herdrServiceOf(services), startServer: (session) => spawned.push(session),
  });
  await pool.ensureSession();
  assert.deepEqual(calls.filter((call) => !call.includes("is-active")), ["systemctl --user start agent-org-herdr.service"]);
  assert.deepEqual(spawned, [], "the instance never spawns the server beside the unit");
  assert.equal(calls.some((call) => call.includes("systemd-run")), false);
});

test("a machine with no herdr service spawns the server directly as before, and the command carries no systemd-run", async () => {
  assert.deepEqual(herdrServerCommand("tickets"), { file: "herdr", args: ["--session", "tickets", "server"] });
  const root = tmpDir("session-");
  const settings = parseTicketSettings({ clones: { a: "/r/a" }, stateDir: root });
  const { services, calls } = setup();
  let up = false;
  const spawned: string[] = [];
  const fake = createFakeTracker();
  let queue = emptyQueue(1);
  const pool = createPool({ get: () => queue, set: (next) => { queue = next; } }, {
    settings, source: { assigned: fake.assigned, read: fake.read, download: fake.download, keywords: fake.keywords }, codeHost: createFakeCodeHost(), hook: { node: "n", bin: "b" },
    herdr: () => { if (!up) throw new Error("server_not_running"); return JSON.stringify({ result: { workspaces: [] } }); },
    wait: async () => { up = true; }, herdrService: herdrServiceOf(services), startServer: (session) => spawned.push(session),
  });
  await pool.ensureSession();
  assert.deepEqual(spawned, ["tickets"]);
  assert.deepEqual(calls.filter((call) => call.includes("start")), []);
});

// ---- where the server runs ----

const server = (pid: number, session = "work") => ({ pid, argv: ["/opt/bin/herdr", "--session", session, "server"] });

function reads(cgroups: Record<number, string>, unitCgroups: Record<string, string> = { "agent-org-herdr.service": "/app.slice/agent-org-herdr.service", "agent-org-instance.service": "/app.slice/agent-org-instance.service" },
  procs: readonly { pid: number; argv: readonly string[] }[] = Object.keys(cgroups).map((pid) => server(Number(pid)))): PlaceReads {
  return {
    platform: "linux", session: "work", processes: () => procs, cgroupOf: (pid) => cgroups[pid] ?? null, unitCgroup: (unit) => unitCgroups[unit] ?? "",
    groupOf: () => null, jobPid: () => null,
  };
}

test("a herdr server in agent-org-herdr.service is the unit's, one in the instance's cgroup is the instance's, and any other cgroup is elsewhere", () => {
  assert.deepEqual(herdrPlace(reads({ 10: "/app.slice/agent-org-herdr.service" })), { kind: "unit", where: "/app.slice/agent-org-herdr.service" });
  assert.deepEqual(herdrPlace(reads({ 10: "/app.slice/agent-org-instance.service" })), { kind: "instance", where: "/app.slice/agent-org-instance.service" });
  assert.deepEqual(herdrPlace(reads({ 10: "/app.slice/agent-org-herdr-work.scope" })), { kind: "elsewhere", where: "/app.slice/agent-org-herdr-work.scope" }, "the old transient scope is not the service");
  assert.equal(herdrPlace(reads({ 10: "/app.slice/agent-org-instance.service/herdr" })).kind, "instance", "a cgroup inside the instance's");
  assert.equal(herdrPlace(reads({ 10: "/app.slice/agent-org-instance.service.d" })).kind, "elsewhere", "the sibling .d is not inside it");
  assert.deepEqual(herdrPlace(reads({}, undefined, [])), { kind: "none" });
  assert.deepEqual(herdrPlace(reads({ 10: "/x" }, undefined, [server(10, "other")])), { kind: "none" }, "another session's server is not this one's");
  assert.equal(herdrPlace(reads({ 10: "/app.slice/agent-org-herdr.service", 11: "/app.slice/agent-org-instance.service" })).kind, "instance", "the worst place of several servers is the one reported");
  assert.equal(isHerdrServer(["/usr/bin/herdr", "--session", "work", "server"], "work"), true);
  const unknown = herdrPlace({ ...reads({ 10: "x" }), cgroupOf: () => null });
  assert.equal(unknown.kind, "unknown");
});

test("a cgroup path is the `0::` line of /proc/<pid>/cgroup, a host with only v1 lines has none, and a server is found by its argument vector", () => {
  assert.equal(cgroupPath("0::/user.slice/app.slice/agent-org-herdr.service\n"), "/user.slice/app.slice/agent-org-herdr.service");
  assert.equal(cgroupPath("12:cpu:/user.slice\n11:memory:/user.slice\n"), null);
  assert.equal(isHerdrServer(["herdr", "server", "--session", "org"], "org"), true);
  assert.equal(isHerdrServer(["grep", "herdr", "--session", "tickets", "server"], "tickets"), false, "a program that only names herdr");
  assert.equal(isHerdrServer(["herdr", "--session", "tickets", "agent", "list"], "tickets"), false, "a client, not the server");
});

function darwin(herdrGroup: number | null, pids: { herdrJob: number | null; instanceJob: number | null } = { herdrJob: 70, instanceJob: 77 }): PlaceReads {
  const groups: Record<number, number> = { 70: 41, 77: 40 };
  return {
    platform: "darwin", session: "work", processes: () => [server(3655)], cgroupOf: () => null, unitCgroup: () => null,
    groupOf: (pid) => (pid === 3655 ? herdrGroup : groups[pid] ?? null),
    jobPid: (label) => (label.endsWith("herdr") ? pids.herdrJob : pids.instanceJob),
  };
}

test("on macOS a herdr server in the herdr job's group is the unit's, one in the instance job's group is the instance's, and any other is elsewhere", () => {
  assert.equal(herdrPlace(darwin(41)).kind, "unit");
  assert.equal(herdrPlace(darwin(40)).kind, "instance");
  assert.deepEqual(herdrPlace(darwin(999)), { kind: "elsewhere", where: "process group 999" });
  assert.equal(herdrPlace(darwin(null)).kind, "unknown", "a group that cannot be read is not the unit's");
  assert.equal(herdrPlace({ ...darwin(41), platform: "win32" }).kind, "unknown");
});

// ---- start herdr, and the one move ----

/** Whether the command starts the herdr unit's server, on systemd or on launchd. */
const startsUnit = (file: string, args: string[]): boolean => (file === "systemctl" && args.includes("start")) || (file === "launchctl" && args[0] === "bootstrap");

function mover(place: HerdrPlace, options: { live?: number | null } = {}) {
  const { services, files, calls, home } = setup();
  // Both interim guards stand on disk, and the real retirement runs: the drop-in's proof is that the server now runs in the unit.
  const paths = guardPaths({}, home);
  for (const path of [paths.dropIn, ...paths.watchdog]) files.set(path, "guard");
  const removed: string[] = [];
  let current = place;
  const run: ServiceDeps["run"] = (file, args) => {
    calls.push([file, ...args].join(" "));
    if (file === "herdr" && args.includes("stop")) current = { kind: "none" };
    // The unit's own start puts the server in the unit, as launchd and systemd do: the move's last step waits for that.
    if (startsUnit(file, args)) current = { kind: "unit", where: "/app.slice/agent-org-herdr.service" };
    return done();
  };
  const wired: ServiceDeps = { ...services, run };
  const deps: MoveDeps = {
    services: wired, liveRuns: () => (options.live === undefined ? 2 : options.live), placeOf: () => current, wait: async () => undefined,
    retire: () => retireGuards({ platform: "linux", env: {}, home, exists: wired.exists, remove: (path) => { removed.push(path); files.delete(path); }, run,
      replacements: async () => ({ ghWrapperDeclared: true, herdrInOwnUnit: true }) }),
  };
  return { deps, calls, files, home, removed, paths };
}

test("start herdr refuses while a server runs outside the unit, saying how many runs are live, and starts nothing", async () => {
  const { deps, calls, removed } = mover({ kind: "instance", where: "/app.slice/agent-org-instance.service" }, { live: 2 });
  await assert.rejects(() => startHerdr({ move: false }, deps), (err: Error) => err instanceof ServiceRefusal
    && /runs outside agent-org-herdr\.service \(\/app\.slice\/agent-org-instance\.service\), and moving it ends every pane and agent in it: 2 runs are live/.test(err.message)
    && err.message.includes("agent-org start herdr --move"));
  assert.deepEqual(calls, []);
  assert.deepEqual(removed, [], "refused, so no guard is touched");
  const queueless = mover({ kind: "elsewhere", where: "/x.scope" }, { live: null });
  await assert.rejects(() => startHerdr({ move: false }, queueless.deps), /the queue cannot be read, so how many runs are live is not known/);
});

test("start herdr --move stops the server outside the unit, starts the unit, and retires both guards", async () => {
  const { deps, calls, removed, paths } = mover({ kind: "elsewhere", where: "/app.slice/agent-org-herdr-work.scope" });
  const said: string[] = [];
  await startHerdr({ move: true }, deps, (line) => said.push(line));
  const stop = calls.findIndex((call) => call === "herdr --session work server stop");
  const start = calls.findIndex((call) => call === "systemctl --user start agent-org-herdr.service");
  assert.ok(stop >= 0 && start > stop, "the outside server is stopped first, then the unit is started");
  assert.deepEqual(removed.toSorted(), [paths.dropIn, ...paths.watchdog].toSorted(), "the drop-in and the watchdog's three files are gone");
  assert.ok(said.some((line) => line.includes("stopped the herdr server that ran outside the unit")));
  assert.ok(said.some((line) => line.includes("retired the KillMode drop-in")));
  assert.ok(said.some((line) => line.includes("retired the gh-wrapper watchdog")));
});

test("start herdr with the server already in the unit starts it without stopping anything, and --move on such a host only retires the guards", async () => {
  const plain = mover({ kind: "unit", where: "/app.slice/agent-org-herdr.service" });
  await startHerdr({ move: false }, plain.deps);
  assert.equal(plain.calls.some((call) => call.includes("server stop")), false);
  assert.deepEqual(plain.removed, [], "without --move the guards stand");
  const moved = mover({ kind: "unit", where: "/app.slice/agent-org-herdr.service" });
  await startHerdr({ move: true }, moved.deps);
  assert.equal(moved.calls.some((call) => call.includes("server stop")), false, "nothing outside the unit, so nothing to stop");
  assert.deepEqual(moved.removed.toSorted(), [moved.paths.dropIn, ...moved.paths.watchdog].toSorted());
});

test("start herdr --move stops nothing when herdr will not stop, and starts no unit beside a server it could not stop", async () => {
  const { deps, calls } = mover({ kind: "instance", where: "/i" });
  const refusing: MoveDeps = { ...deps, services: { ...deps.services, run: (file, args) => { calls.push([file, ...args].join(" ")); return file === "herdr" ? { status: 1, stdout: "", stderr: "boom" } : done(); } } };
  await assert.rejects(() => startHerdr({ move: true }, refusing), /herdr would not stop its server for session work: boom\. Nothing was started/);
  assert.equal(calls.some((call) => call.includes("systemctl")), false);
});

test("the start command takes --move for herdr only, and a start of herdr says so", async () => {
  const { deps } = mover({ kind: "none" });
  const out: string[] = [];
  const io = { log: (line: string) => out.push(line), error: (line: string) => out.push(line) };
  assert.equal(await main(["start", "herdr"], deps.services, io, deps), 0);
  assert.ok(out.some((line) => line.startsWith("started the herdr service (systemd agent-org-herdr.service)")));
  assert.equal(await main(["start", "herdr", "--move"], deps.services, io, deps), 0);
  assert.ok(out.at(-1)?.startsWith("moved herdr into its service"), "--move ends on its own result line");
  assert.equal(await main(["start", "ui", "--move"], deps.services, io, deps), 2);
  assert.ok(out.some((line) => line.includes("--move is for `agent-org start herdr`")));
});

test("the guards retire on their proofs: the drop-in once herdr runs in its own unit, and not before", async () => {
  const { services, files, home } = setup();
  const paths = guardPaths({}, home);
  files.set(paths.dropIn, "[Service]\nKillMode=process\n");
  const removed: string[] = [];
  const base = { platform: "linux" as const, env: {}, home, exists: services.exists, remove: (path: string) => { removed.push(path); files.delete(path); }, run: services.run };
  const kept = await retireGuards({ ...base, replacements: async () => ({ ghWrapperDeclared: true, herdrInOwnUnit: false }) });
  assert.match(kept.join("\n"), /kept the KillMode drop-in: the herdr server does not run in agent-org-herdr\.service yet\. Run `agent-org start herdr --move`/);
  assert.deepEqual(removed, []);
  const gone = await retireGuards({ ...base, replacements: async () => ({ ghWrapperDeclared: true, herdrInOwnUnit: true }) });
  assert.match(gone.join("\n"), /retired the KillMode drop-in: herdr has a service of its own/);
  assert.deepEqual(removed, [paths.dropIn]);
});

test("stopping herdr says it ends every pane and agent, and stopping the instance says nothing of the kind", async () => {
  const { services, files, calls } = setup();
  const out: string[] = [];
  const io = { log: (line: string) => out.push(line), error: (line: string) => out.push(line) };
  files.set(unitFor("herdr", services).path, "registered");
  files.set(unitFor("instance", services).path, "registered");
  assert.equal(await main(["stop", "herdr"], services, io), 0);
  assert.ok(calls.some((call) => call.endsWith("disable --now agent-org-herdr.service")));
  assert.match(out.at(-1) ?? "", /^stopped the herdr service; every pane and agent it held ended; it will not start at login until `agent-org start herdr`$/);
  assert.equal(await main(["stop", "instance"], services, io), 0);
  assert.doesNotMatch(out.at(-1) ?? "", /every pane/);
});

test("the drain's forced update is started without waiting for it, since it restarts the instance that asked", () => {
  const { services, calls } = setup();
  runAutoUpdateNow(services);
  assert.deepEqual(calls, ["systemctl --user start --no-block agent-org-auto-update.service"]);
});

test("start herdr --move registers the unit before it stops the server, so an instance that finds none in between starts the unit", async () => {
  const { deps, calls, files } = mover({ kind: "elsewhere", where: "/x.scope" });
  const unitPath = unitFor("herdr", deps.services).path;
  assert.equal(files.has(unitPath), false);
  const wired: MoveDeps = { ...deps, services: { ...deps.services, run: (file, args) => { if (file === "herdr") assert.equal(files.has(unitPath), true, "registered first"); return deps.services.run(file, args); } } };
  await startHerdr({ move: true }, wired);
  assert.ok(calls.some((call) => call === "herdr --session work server stop"));
});

test("on launchd a loaded herdr job that exited is started again by start, and a running one is left alone by a kickstart without -k", async () => {
  const loaded = setup("darwin");
  loaded.services = { ...loaded.services, run: (file, args) => { loaded.calls.push([file, ...args].join(" ")); return done("state = running\n"); } };
  await startService("herdr", loaded.services);
  assert.ok(loaded.calls.some((call) => call.startsWith("launchctl kickstart gui/") && !call.includes(" -k")));
});
