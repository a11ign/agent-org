#!/usr/bin/env node
// @ts-check
// module: when the hourly update may restart the instance while a run is live (A11-90), and the status file `update` writes and `doctor` reads
//
// A RESTART OF THE INSTANCE INTERRUPTS A WORKER ONLY IN TWO CASES. The workers run in herdr's server. A server that an older instance started inside
// the instance's own cgroup dies with the instance, and a worker mid-tool-call dies with it. A server in its own scope (`herdrServerCommand`, A11-78)
// survives the restart, and so does an agent sitting at its prompt. So `restartDecision` goes when herdr is OUTSIDE the instance's cgroup, or when no
// agent is mid-tool-call, and otherwise waits, but only up to `tickets.updateMaxDeferHours` from the first deferral for that release.
//
// EVERY READ IS INJECTED: /proc, systemctl, ps, launchctl, herdr's listing and the queue file. The decisions are tested without a host, and
// `hostIsolation` is the one place that asks a real host. Where the answer cannot be read it is `unknown`, and `unknown` is never read as outside.
import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { agentOrgHome, readOrNull, type Env } from "./paths.ts";
import { unitFor, type Run, type ServiceDeps } from "./service.ts";
import { writeAtomic } from "./write-atomic.ts";

export const HOUR_MS = 3600e3;

/**
 * Whether a restart of the instance reaches herdr's server. `outside` names the scope the server is in (null when no server runs), `inside` names the
 * cgroup or process group it shares with the instance, and `unknown` says why the answer could not be read.
 */
export type Isolation =
  | { kind: "outside"; scope: string | null }
  | { kind: "inside"; cgroup: string; unit: string }
  | { kind: "unknown"; why: string };

/** A process: its id, and its argument vector. */
export type Proc = { pid: number; argv: readonly string[] };

/** Every read the isolation check makes, each injected, so a test drives it without a host. */
export type IsolationReads = Readonly<{
  platform: NodeJS.Platform;
  /** The herdr session the workers run in: `tickets.herdrSession`. */
  session: string;
  /** The instance's service id: its systemd unit on Linux, its launchd label on macOS. */
  unit: string;
  /** Every process on the host, or null when they cannot be listed. */
  processes: () => readonly Proc[] | null;
  /** Linux: a process's cgroup path, from the `0::` line of `/proc/<pid>/cgroup`, or null when it cannot be read. */
  cgroupOf: (pid: number) => string | null;
  /** Linux: the instance unit's control group, `""` when systemd gives it none, or null when systemd cannot say. */
  unitCgroup: () => string | null;
  /** macOS: a process's process group, or null when it cannot be read. */
  groupOf: (pid: number) => number | null;
  /** macOS: the pid launchd runs the instance job as, or null when it runs none. */
  jobPid: () => number | null;
}>;

/** Whether `argv` is a herdr server of `session`: `herdr`, `server`, and `--session <session>`, as `herdr --session tickets server` is started. */
export function isHerdrServer(argv: readonly string[], session: string): boolean {
  return basename(argv[0] ?? "") === "herdr" && argv.includes("server") && argv.some((arg, index) => arg === "--session" && argv[index + 1] === session);
}

/** The cgroup path a `/proc/<pid>/cgroup` file names: its unified (`0::`) line, or null on a host that has none. */
export function cgroupPath(text: string): string | null {
  const line = text.split("\n").find((entry) => entry.startsWith("0::"));
  return line === undefined ? null : line.slice("0::".length);
}

/**
 * Whether a restart of the instance would reach herdr's server of `session`. No server means nothing can be interrupted: outside, with no scope.
 * Linux: a server whose cgroup is the instance unit's, or inside it (`<unit>/...`), is inside; the sibling `<unit>.d` is not. macOS: a server in the
 * instance job's process group is inside, since launchd ends the job by its group and a detached herdr is one the job leaves alone.
 */
export function herdrIsolation(reads: IsolationReads): Isolation {
  if (reads.platform !== "linux" && reads.platform !== "darwin") return { kind: "unknown", why: `${reads.platform} is not a platform the instance runs on` };
  const processes = reads.processes();
  if (processes === null) return { kind: "unknown", why: "the process list cannot be read" };
  const servers = processes.filter((proc) => isHerdrServer(proc.argv, reads.session));
  if (servers.length === 0) return { kind: "outside", scope: null };
  return reads.platform === "linux" ? inCgroup(servers, reads) : inProcessGroup(servers, reads);
}

function inCgroup(servers: readonly Proc[], reads: IsolationReads): Isolation {
  const unit = reads.unitCgroup();
  if (unit === null || unit === "") return { kind: "unknown", why: `systemd gives ${reads.unit} no control group` };
  const scopes: string[] = [];
  for (const { pid } of servers) {
    const cgroup = reads.cgroupOf(pid);
    if (cgroup === null) return { kind: "unknown", why: `/proc/${pid}/cgroup cannot be read` };
    if (cgroup === unit || cgroup.startsWith(`${unit}/`)) return { kind: "inside", cgroup, unit: reads.unit };
    scopes.push(cgroup);
  }
  return { kind: "outside", scope: scopes[0] };
}

function inProcessGroup(servers: readonly Proc[], reads: IsolationReads): Isolation {
  const job = reads.jobPid();
  if (job === null) return { kind: "unknown", why: `launchd runs no job for ${reads.unit}` };
  const jobGroup = reads.groupOf(job);
  if (jobGroup === null) return { kind: "unknown", why: `the process group of pid ${job} cannot be read` };
  const groups: number[] = [];
  for (const { pid } of servers) {
    const group = reads.groupOf(pid);
    if (group === null) return { kind: "unknown", why: `the process group of pid ${pid} cannot be read` };
    if (group === jobGroup) return { kind: "inside", cgroup: `process group ${group}`, unit: reads.unit };
    groups.push(group);
  }
  return { kind: "outside", scope: `process group ${groups[0]}` };
}

/** Whether an agent is mid-tool-call, and the one line that says why, for the log. */
export type MidToolCall = { busy: boolean; why: string };

/**
 * Whether any run is mid-tool-call. Busy when an agent in the session is `working`, when a queue entry or the publish run is `starting` (a start in
 * flight has no status yet), or when either listing cannot be read: an unreadable answer is never idle. An agent idle at its prompt, or waiting on a
 * dialog, is not busy: a restart loses nothing of its.
 */
export function midToolCall({ agents, queue }: {
  agents: () => readonly { label: string; status: string }[] | null;
  queue: () => { entries: readonly { phase: string; ticket: { key: string } }[]; publish?: { phase: string } } | null;
}): MidToolCall {
  const listed = agents();
  if (listed === null) return { busy: true, why: "herdr did not list its agents" };
  const working = listed.filter((agent) => agent.status === "working").map((agent) => agent.label);
  if (working.length > 0) return { busy: true, why: `working: ${working.join(", ")}` };
  const read = queue();
  if (read === null) return { busy: true, why: "the queue cannot be read" };
  const starting = read.entries.filter((entry) => entry.phase === "starting").map((entry) => entry.ticket.key);
  if (read.publish?.phase === "starting") starting.push("the publish run");
  if (starting.length > 0) return { busy: true, why: `starting: ${starting.join(", ")}` };
  return { busy: false, why: `${listed.length} ${listed.length === 1 ? "agent" : "agents"}, none working` };
}

/** Whether the move may go ahead now, and if not, when the deferral gives up: the first deferral's time, which the caller keeps across runs. */
export type Restart =
  | { go: true; reason: string }
  | { go: false; reason: string; deferredSince: number; giveUpAt: number };

/**
 * Whether the move goes ahead with a release waiting: when herdr is outside the instance's cgroup, when no agent is mid-tool-call, or when the
 * deferral has run `maxDeferHours` already. `deferredSince` is the first deferral for this release, or undefined when there is none yet.
 */
export function restartDecision({ isolation, busy, deferredSince, now, maxDeferHours }: {
  isolation: Isolation;
  busy: () => MidToolCall;
  deferredSince: number | undefined;
  now: number;
  maxDeferHours: number;
}): Restart {
  if (isolation.kind === "outside") {
    const scope = isolation.scope === null ? "no herdr server runs" : `the herdr server is in ${isolation.scope}`;
    return { go: true, reason: `herdr is outside the instance's cgroup, so a restart interrupts no worker (${scope})` };
  }
  // Read here, not before: an isolation that already decides the move never asks herdr or the queue.
  const state = busy();
  if (!state.busy) return { go: true, reason: `no run is mid-tool-call (${state.why})` };
  const since = deferredSince ?? now;
  const giveUpAt = since + maxDeferHours * HOUR_MS;
  if (now >= giveUpAt) return { go: true, reason: `deferred for ${maxDeferHours} ${maxDeferHours === 1 ? "hour" : "hours"}, updating anyway (${state.why})` };
  const because = [
    isolation.kind === "inside" ? `herdr is inside the instance's cgroup (${isolation.cgroup})` : `herdr's place cannot be checked (${isolation.why})`,
    `an agent is mid-tool-call (${state.why})`,
  ];
  return { go: false, reason: because.join(", and "), deferredSince: since, giveUpAt };
}

/** What `update` last saw, for `doctor` to say how far behind the install is, and since when, without the network. */
export type UpdateStatus = Readonly<{
  checkedAt: string;
  channel: "release" | "main";
  /** The release tag the checkout is at, or its short commit when it is at none. */
  installed: string;
  /** The newest release tag, or `main` on the main channel. */
  latest: string;
  /** When `latest` was cut: its commit's date. */
  latestSince: string;
  /** The first deferral for `latest`, kept across the hourly runs, cleared when the install moves or is current. */
  deferredSince?: string;
  deferredReason?: string;
}>;

export const updateStatusPath = (env: Env, home: string): string => join(agentOrgHome(env, home), "update-status.json");

/**
 * What the status file holds: nothing yet (`absent`), a status, or a file that cannot be read or is not a status (`unreadable`). The last is never
 * read as clean: `doctor` fails on it, and the run that reads it writes the file again.
 */
export type StatusFile = { kind: "absent" } | { kind: "unreadable"; why: string } | { kind: "status"; status: UpdateStatus };

/** The status file's text, or null when there is no file. Any other read failure throws: a file that cannot be read is not an absent one. */
export function readStatusText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export function readUpdateStatus(path: string, read: (path: string) => string | null = readStatusText): StatusFile {
  let text: string | null;
  try {
    text = read(path);
  } catch (err) {
    return { kind: "unreadable", why: (err as Error).message };
  }
  if (text === null) return { kind: "absent" };
  let status: UpdateStatus | null;
  try {
    status = parseStatus(JSON.parse(text));
  } catch {
    return { kind: "unreadable", why: "it is not valid JSON" };
  }
  return status === null ? { kind: "unreadable", why: "it is not an update status" } : { kind: "status", status };
}

function parseStatus(value: unknown): UpdateStatus | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  const text = (key: string): string | undefined => (typeof v[key] === "string" ? v[key] : undefined);
  const checkedAt = text("checkedAt");
  const installed = text("installed");
  const latest = text("latest");
  const latestSince = text("latestSince");
  const isUnknownState = checkedAt === undefined || installed === undefined || latest === undefined || latestSince === undefined;
  if (isUnknownState) return null;
  if (v.channel !== "release" && v.channel !== "main") return null;
  return { checkedAt, channel: v.channel, installed, latest, latestSince, deferredSince: text("deferredSince"), deferredReason: text("deferredReason") };
}

/** Writes the status file whole, through a temporary file, as the other files the install owns are written. */
export function writeUpdateStatus(path: string, status: UpdateStatus): void {
  writeAtomic(path, `${JSON.stringify(status, null, 2)}\n`, 0o644);
}

/**
 * The isolation of the running instance on this host, read from `/proc` and systemd on Linux and from `ps` and launchd on macOS. Unknown when the
 * instance's unit cannot be named on this platform, and when a read fails.
 */
export function hostIsolation(services: ServiceDeps, session: string): Isolation {
  let unit: string;
  try {
    unit = unitFor("instance", services).id;
  } catch (err) {
    return { kind: "unknown", why: (err as Error).message };
  }
  return herdrIsolation(hostReads(services, session, unit));
}

function hostReads(services: ServiceDeps, session: string, unit: string): IsolationReads {
  const { platform, run } = services;
  return {
    platform, session, unit,
    processes: () => (platform === "darwin" ? psProcesses(run) : linuxProcesses()),
    cgroupOf: (pid) => {
      const text = services.read(`/proc/${pid}/cgroup`);
      return text === null ? null : cgroupPath(text);
    },
    unitCgroup: () => {
      const result = run("systemctl", ["--user", "show", "--property=ControlGroup", "--value", unit]);
      return result.status === 0 ? result.stdout.trim() : null;
    },
    groupOf: (pid) => numberOf(run("ps", ["-o", "pgid=", "-p", String(pid)])),
    jobPid: () => {
      const result = run("launchctl", ["print", `gui/${services.uid}/${unit}`]);
      const match = /^\s*pid = (\d+)\s*$/m.exec(result.stdout);
      return result.status === 0 && match !== null ? Number(match[1]) : null;
    },
  };
}

/** Every process in `/proc`, with its command line. A process that exits while it is read is skipped. */
function linuxProcesses(): Proc[] | null {
  let entries: string[];
  try {
    entries = readdirSync("/proc");
  } catch {
    return null;
  }
  return entries.filter((entry) => /^\d+$/.test(entry)).flatMap((entry) => {
    const cmdline = readOrNull(`/proc/${entry}/cmdline`);
    return cmdline === null ? [] : [{ pid: Number(entry), argv: cmdline.split("\0").filter((arg) => arg !== "") }];
  });
}

/** Every process from `ps`, whose arguments are split on spaces: a herdr path with a space in it is not one this reads. */
function psProcesses(run: Run): Proc[] | null {
  const result = run("ps", ["-axww", "-o", "pid=,args="]);
  if (result.status !== 0) return null;
  return result.stdout.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    return match === null ? [] : [{ pid: Number(match[1]), argv: match[2].split(/\s+/) }];
  });
}

function numberOf(result: { status: number | null; stdout: string }): number | null {
  const text = result.stdout.trim();
  return result.status === 0 && /^\d+$/.test(text) ? Number(text) : null;
}
