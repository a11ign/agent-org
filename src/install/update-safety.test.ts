// no-token: none -- every host read is injected: no /proc, systemd, launchd, ps or herdr is asked, and the status file is a temporary one
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpDir } from "../lib/tmp-fixture.ts";
import type { ServiceDeps } from "./service.ts";
import { cgroupPath, hostIsolation, herdrIsolation, isHerdrServer, midToolCall, readUpdateStatus, restartDecision, writeUpdateStatus, type IsolationReads, type Proc, type UpdateStatus } from "./update-safety.ts";

const SESSION = "tickets";
const UNIT = "agent-org-instance.service";
const UNIT_CGROUP = `/user.slice/user-1000.slice/user@1000.service/app.slice/${UNIT}`;
const HERDR: Proc = { pid: 3655416, argv: ["herdr", "--session", SESSION, "server"] };
const WEB_UI: Proc = { pid: 3655500, argv: ["bun", "herdr-web-ui", "--session", SESSION] };

/** A Linux host's reads, with the herdr server at `cgroup` and the instance unit at UNIT_CGROUP, each overridable. */
function linux(over: Partial<IsolationReads> = {}, cgroup: string | null = UNIT_CGROUP): IsolationReads {
  return {
    platform: "linux", session: SESSION, unit: UNIT,
    processes: () => [WEB_UI, HERDR],
    cgroupOf: (pid) => (pid === HERDR.pid ? cgroup : "/user.slice/user-1000.slice/session-3.scope"),
    unitCgroup: () => UNIT_CGROUP,
    groupOf: () => null, jobPid: () => null,
    ...over,
  };
}

/** A macOS host's reads: the instance job's pid, and the process groups of the job and of herdr. */
function darwin(herdrGroup: number | null, jobGroup: number | null = 40): IsolationReads {
  return {
    platform: "darwin", session: SESSION, unit: "io.github.agent-org.instance",
    processes: () => [HERDR],
    cgroupOf: () => null, unitCgroup: () => null,
    groupOf: (pid) => (pid === HERDR.pid ? herdrGroup : jobGroup),
    jobPid: () => 77,
  };
}

test("A11-90: a herdr server in the instance's own cgroup is inside it, and a child of that cgroup is too", () => {
  assert.deepEqual(herdrIsolation(linux()), { kind: "inside", cgroup: UNIT_CGROUP, unit: UNIT });
  assert.deepEqual(herdrIsolation(linux({}, `${UNIT_CGROUP}/herdr-child`)), { kind: "inside", cgroup: `${UNIT_CGROUP}/herdr-child`, unit: UNIT });
});

test("A11-90: a server in its own scope is outside, and names the scope; a sibling whose name starts with the unit's is not inside", () => {
  const scope = "/user.slice/user-1000.slice/user@1000.service/app.slice/agent-org-herdr-tickets.scope";
  assert.deepEqual(herdrIsolation(linux({}, scope)), { kind: "outside", scope });
  assert.deepEqual(herdrIsolation(linux({}, `${UNIT_CGROUP}.d`)), { kind: "outside", scope: `${UNIT_CGROUP}.d` }, "agent-org-instance.service.d is not the unit's cgroup");
});

test("A11-90: a host with no herdr server for the session has nothing a restart can interrupt, so it is outside with no scope", () => {
  assert.deepEqual(herdrIsolation(linux({ processes: () => [WEB_UI, { pid: 9, argv: ["herdr", "--session", "org", "server"] }] })), { kind: "outside", scope: null });
});

test("A11-90: a server is found by its argument vector, `server` and `--session <session>` with herdr first, in either order", () => {
  assert.equal(isHerdrServer(["herdr", "--session", "tickets", "server"], "tickets"), true);
  assert.equal(isHerdrServer(["herdr", "server", "--session", "org"], "org"), true);
  assert.equal(isHerdrServer(["herdr", "--session", "org", "server"], "tickets"), false, "another session's server");
  assert.equal(isHerdrServer(["grep", "herdr", "--session", "tickets", "server"], "tickets"), false, "a program that only names herdr");
  assert.equal(isHerdrServer(["herdr", "--session", "tickets", "agent", "list"], "tickets"), false, "a client, not the server");
});

test("A11-90: a cgroup the check cannot read, or a unit with no control group, is unknown and never read as outside", () => {
  assert.equal(herdrIsolation(linux({}, null)).kind, "unknown");
  assert.equal(herdrIsolation(linux({ unitCgroup: () => "" })).kind, "unknown");
  assert.equal(herdrIsolation(linux({ unitCgroup: () => null })).kind, "unknown");
  assert.equal(herdrIsolation(linux({ processes: () => null })).kind, "unknown");
  assert.equal(herdrIsolation({ ...linux(), platform: "win32" }).kind, "unknown");
});

test("A11-90: on macOS a herdr server in the instance job's process group is inside it, and one in another group is outside", () => {
  assert.deepEqual(herdrIsolation(darwin(40, 40)), { kind: "inside", cgroup: "process group 40", unit: "io.github.agent-org.instance" });
  assert.deepEqual(herdrIsolation(darwin(3655, 40)), { kind: "outside", scope: "process group 3655" });
  assert.equal(herdrIsolation(darwin(null)).kind, "unknown", "a group that cannot be read is not outside");
  assert.equal(herdrIsolation({ ...darwin(40), jobPid: () => null }).kind, "unknown", "a job with no pid is not read as outside");
});

test("A11-90: a cgroup path is the `0::` line of /proc/<pid>/cgroup, and a host with only v1 lines has none", () => {
  assert.equal(cgroupPath("0::/user.slice/app.slice/agent-org-instance.service\n"), "/user.slice/app.slice/agent-org-instance.service");
  assert.equal(cgroupPath("12:cpu:/user.slice\n11:memory:/user.slice\n"), null);
});

test("A11-90: the instance's own host is read through the service deps, and a platform the instance does not run on is unknown", () => {
  assert.equal(hostIsolation({ platform: "win32" } as unknown as ServiceDeps, SESSION).kind, "unknown");
});

test("A11-90: a mid-tool-call run is one whose agent is working, whose start is in flight, or whose listing cannot be read; an idle agent is not", () => {
  const idle = [{ label: "worker-1", status: "idle" }, { label: "reviewer", status: "done" }, { label: "dialog", status: "blocked" }];
  assert.deepEqual(midToolCall({ agents: () => idle, queue: () => ({ entries: [] }) }), { busy: false, why: "3 agents, none working" });
  assert.deepEqual(midToolCall({ agents: () => [...idle, { label: "worker-2", status: "working" }], queue: () => ({ entries: [] }) }), { busy: true, why: "working: worker-2" });
  assert.deepEqual(midToolCall({ agents: () => idle, queue: () => ({ entries: [{ phase: "starting", ticket: { key: "A11-1" } }] }) }), { busy: true, why: "starting: A11-1" });
  assert.deepEqual(midToolCall({ agents: () => idle, queue: () => ({ entries: [], publish: { phase: "starting" } }) }), { busy: true, why: "starting: the publish run" });
  assert.deepEqual(midToolCall({ agents: () => idle, queue: () => ({ entries: [{ phase: "running", ticket: { key: "A11-2" } }] }) }), { busy: false, why: "3 agents, none working" }, "a running run is between its prompts, not mid-call");
  assert.deepEqual(midToolCall({ agents: () => null, queue: () => ({ entries: [] }) }), { busy: true, why: "herdr did not list its agents" });
  assert.deepEqual(midToolCall({ agents: () => idle, queue: () => null }), { busy: true, why: "the queue cannot be read" });
});

const HOUR = 3600e3;
const NOW = Date.parse("2026-10-18T10:00:00.000Z");
const WORKING = { busy: true, why: "working: worker-1" };
const INSIDE = { kind: "inside" as const, cgroup: UNIT_CGROUP, unit: UNIT };

test("A11-90: a restart goes when herdr is outside the instance's cgroup, whatever is working, and when no agent is mid-tool-call", () => {
  const outside = restartDecision({ isolation: { kind: "outside", scope: "/x.scope" }, busy: () => WORKING, deferredSince: undefined, now: NOW, maxDeferHours: 2 });
  assert.deepEqual(outside, { go: true, reason: "herdr is outside the instance's cgroup, so a restart interrupts no worker (the herdr server is in /x.scope)" });
  const idle = restartDecision({ isolation: INSIDE, busy: () => ({ busy: false, why: "2 agents, none working" }), deferredSince: undefined, now: NOW, maxDeferHours: 2 });
  assert.deepEqual(idle, { go: true, reason: "no run is mid-tool-call (2 agents, none working)" });
});

test("A11-90: an isolation outside the cgroup decides the restart without asking herdr or the queue", () => {
  const unasked = () => { throw new Error("herdr is not asked when herdr is outside"); };
  assert.equal(restartDecision({ isolation: { kind: "outside", scope: null }, busy: unasked, deferredSince: undefined, now: NOW, maxDeferHours: 2 }).go, true);
});

test("A11-90: a first deferral waits, starts the clock at now, and says when it gives up", () => {
  const first = restartDecision({ isolation: INSIDE, busy: () => WORKING, deferredSince: undefined, now: NOW, maxDeferHours: 2 });
  assert.equal(first.go, false);
  assert.ok(!first.go);
  assert.equal(first.deferredSince, NOW);
  assert.equal(first.giveUpAt, NOW + 2 * HOUR);
  assert.equal(first.reason, "herdr is inside the instance's cgroup (/user.slice/user-1000.slice/user@1000.service/app.slice/agent-org-instance.service), and an agent is mid-tool-call (working: worker-1)");
});

test("A11-90: a deferral goes ahead once tickets.updateMaxDeferHours have run, and one second short of that still waits", () => {
  const due = restartDecision({ isolation: INSIDE, busy: () => WORKING, deferredSince: NOW - 2 * HOUR, now: NOW, maxDeferHours: 2 });
  assert.deepEqual(due, { go: true, reason: "deferred for 2 hours, updating anyway (working: worker-1)" });
  const short = restartDecision({ isolation: INSIDE, busy: () => WORKING, deferredSince: NOW - 2 * HOUR + 1000, now: NOW, maxDeferHours: 2 });
  assert.equal(short.go, false);
  const oneHour = restartDecision({ isolation: INSIDE, busy: () => WORKING, deferredSince: NOW - HOUR, now: NOW, maxDeferHours: 1 });
  assert.deepEqual(oneHour, { go: true, reason: "deferred for 1 hour, updating anyway (working: worker-1)" });
});

test("A11-90: an isolation that cannot be read waits for a working agent as an inside one does, and does not stop a restart when every agent is idle", () => {
  const blind = { kind: "unknown" as const, why: "/proc/3655416/cgroup cannot be read" };
  const waits = restartDecision({ isolation: blind, busy: () => WORKING, deferredSince: undefined, now: NOW, maxDeferHours: 2 });
  assert.equal(waits.go, false);
  assert.ok(!waits.go && waits.reason.includes("herdr's place cannot be checked (/proc/3655416/cgroup cannot be read)"));
  assert.deepEqual(restartDecision({ isolation: blind, busy: () => ({ busy: false, why: "1 agent, none working" }), deferredSince: undefined, now: NOW, maxDeferHours: 2 }),
    { go: true, reason: "no run is mid-tool-call (1 agent, none working)" });
});

test("A11-90: the status file is written whole and read back; an absent one is no status, and an unreadable or corrupt one is never read as clean", () => {
  const path = join(tmpDir("update-status-"), "update-status.json");
  const status: UpdateStatus = { checkedAt: "2026-10-18T10:00:00.000Z", channel: "release", installed: "v0.243.0", latest: "v0.248.0", latestSince: "2026-10-17T08:00:00.000Z", deferredSince: "2026-10-18T09:00:00.000Z", deferredReason: "herdr is inside" };
  writeUpdateStatus(path, status);
  assert.deepEqual(readUpdateStatus(path), { kind: "status", status });
  assert.deepEqual(readUpdateStatus(join(tmpDir("update-status-"), "none.json")), { kind: "absent" }, "a file that is not there is no status yet");
  assert.deepEqual(readUpdateStatus("unused", () => null), { kind: "absent" });
  const denied = readUpdateStatus("unused", () => { throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" }); });
  assert.deepEqual(denied, { kind: "unreadable", why: "EACCES: permission denied" }, "a file that cannot be read is not an absent one");
  assert.equal(readUpdateStatus("unused", () => "{ not json").kind, "unreadable");
  assert.deepEqual(readUpdateStatus("unused", () => JSON.stringify({ ...status, channel: "nightly" })), { kind: "unreadable", why: "it is not an update status" });
});
