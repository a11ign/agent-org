// @ts-check
// module: where the herdr server of the tickets session runs -- in its own service, inside the instance's, or somewhere else (A11-169)
//
// HERDR HOLDS EVERY WORKER'S PANE, so what a restart of the instance reaches depends on where its server sits. In `agent-org-herdr.service` (launchd: `io.github.agent-org.herdr`) a restart of the
// instance, the ui or the terminal never touches it. Inside the instance's cgroup (a server an older instance started itself) it dies with the instance, and so does every pane. In the transient
// scope the older `systemd-run` branch made, it survives a restart but was started BY the instance and carried the instance's working directory. `doctor` and `start herdr` read the place
// from /proc and systemd on Linux and from `ps` and launchd on macOS. Where the answer cannot be read it is `unknown`, and `unknown` is never read as the unit.
import { readdirSync } from "node:fs";
import { basename } from "node:path";
import { readOrNull } from "./paths.ts";
import type { Run, ServiceDeps } from "./service.ts";

/** Where the server of a session runs. `where` names the cgroup or process group, so a failing row can say it. */
export type HerdrPlace =
  | { kind: "none" }
  | { kind: "unit"; where: string }
  | { kind: "instance"; where: string }
  | { kind: "elsewhere"; where: string }
  | { kind: "unknown"; why: string };

/** A process: its id, and its argument vector. */
export type Proc = { pid: number; argv: readonly string[] };

/** The units the place is judged against: their names in the service manager. */
export const HERDR_UNIT = { systemd: "agent-org-herdr.service", launchd: "io.github.agent-org.herdr" } as const;
const INSTANCE_UNIT = { systemd: "agent-org-instance.service", launchd: "io.github.agent-org.instance" } as const;

/** Every read the place check makes, each injected, so a test drives it without a host. */
export type PlaceReads = Readonly<{
  platform: NodeJS.Platform;
  /** The herdr session the workers run in: `tickets.herdrSession`. */
  session: string;
  processes: () => readonly Proc[] | null;
  /** Linux: a process's cgroup path, from the `0::` line of `/proc/<pid>/cgroup`, or null when it cannot be read. */
  cgroupOf: (pid: number) => string | null;
  /** Linux: a unit's control group, `""` when systemd gives it none (not running), or null when systemd cannot say. */
  unitCgroup: (unit: string) => string | null;
  /** macOS: a process's process group, or null when it cannot be read. */
  groupOf: (pid: number) => number | null;
  /** macOS: the pid launchd runs a job as, or null when it runs none. */
  jobPid: (label: string) => number | null;
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

const within = (cgroup: string, unit: string): boolean => unit !== "" && (cgroup === unit || cgroup.startsWith(`${unit}/`));

/** How bad a place is for a restart of the instance: the worst of several servers is the one reported. */
const SEVERITY: Readonly<Record<"unit" | "elsewhere" | "instance", number>> = { unit: 0, elsewhere: 1, instance: 2 };

/**
 * Where the server of `reads.session` runs. No server is `none`. Linux: a server whose cgroup is the herdr unit's, or inside it, is `unit`; the instance unit's, `instance`; any other, `elsewhere`
 * (the old transient scope, or one started by hand). macOS: the pid launchd runs the herdr job as, or a process in its group, is `unit`; a process in the instance job's group, `instance`.
 */
export function herdrPlace(reads: PlaceReads): HerdrPlace {
  if (reads.platform !== "linux" && reads.platform !== "darwin") return { kind: "unknown", why: `${reads.platform} is not a platform the instance runs on` };
  const processes = reads.processes();
  if (processes === null) return { kind: "unknown", why: "the process list cannot be read" };
  const servers = processes.filter((proc) => isHerdrServer(proc.argv, reads.session));
  if (servers.length === 0) return { kind: "none" };
  return reads.platform === "linux" ? inCgroup(servers, reads) : inProcessGroup(servers, reads);
}

function worst(places: readonly { kind: "unit" | "elsewhere" | "instance"; where: string }[]): HerdrPlace {
  return places.reduce((a, b) => (SEVERITY[b.kind] > SEVERITY[a.kind] ? b : a));
}

function inCgroup(servers: readonly Proc[], reads: PlaceReads): HerdrPlace {
  const herdr = reads.unitCgroup(HERDR_UNIT.systemd);
  const instance = reads.unitCgroup(INSTANCE_UNIT.systemd);
  if (herdr === null || instance === null) return { kind: "unknown", why: "systemd does not say the control groups of the herdr and instance units" };
  const places: { kind: "unit" | "elsewhere" | "instance"; where: string }[] = [];
  for (const { pid } of servers) {
    const cgroup = reads.cgroupOf(pid);
    if (cgroup === null) return { kind: "unknown", why: `/proc/${pid}/cgroup cannot be read` };
    if (within(cgroup, herdr)) places.push({ kind: "unit", where: cgroup });
    else if (within(cgroup, instance)) places.push({ kind: "instance", where: cgroup });
    else places.push({ kind: "elsewhere", where: cgroup });
  }
  return worst(places);
}

function inProcessGroup(servers: readonly Proc[], reads: PlaceReads): HerdrPlace {
  const [herdrJob, instanceJob] = [reads.jobPid(HERDR_UNIT.launchd), reads.jobPid(INSTANCE_UNIT.launchd)];
  const groupOfJob = (job: number | null) => (job === null ? null : reads.groupOf(job));
  const [herdrGroup, instanceGroup] = [groupOfJob(herdrJob), groupOfJob(instanceJob)];
  const places: { kind: "unit" | "elsewhere" | "instance"; where: string }[] = [];
  for (const { pid } of servers) {
    const group = reads.groupOf(pid);
    if (group === null) return { kind: "unknown", why: `the process group of pid ${pid} cannot be read` };
    if (pid === herdrJob || (herdrGroup !== null && group === herdrGroup)) places.push({ kind: "unit", where: `process group ${group}` });
    else if (instanceGroup !== null && group === instanceGroup) places.push({ kind: "instance", where: `process group ${group}` });
    else places.push({ kind: "elsewhere", where: `process group ${group}` });
  }
  return worst(places);
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

/** The reads of this host: `/proc` and systemd on Linux, `ps` and launchd on macOS. */
export function hostReads(services: Pick<ServiceDeps, "platform" | "run" | "read" | "uid">, session: string): PlaceReads {
  const { platform, run } = services;
  return {
    platform, session,
    processes: () => (platform === "darwin" ? psProcesses(run) : linuxProcesses()),
    cgroupOf: (pid) => {
      const text = services.read(`/proc/${pid}/cgroup`);
      return text === null ? null : cgroupPath(text);
    },
    unitCgroup: (unit) => {
      const result = run("systemctl", ["--user", "show", "--property=ControlGroup", "--value", unit]);
      return result.status === 0 ? result.stdout.trim() : null;
    },
    groupOf: (pid) => numberOf(run("ps", ["-o", "pgid=", "-p", String(pid)])),
    jobPid: (label) => {
      const result = run("launchctl", ["print", `gui/${services.uid}/${label}`]);
      const match = /^\s*pid = (\d+)\s*$/m.exec(result.stdout);
      return result.status === 0 && match !== null ? Number(match[1]) : null;
    },
  };
}

/** Where the herdr server of `session` runs on this host. */
export const hostHerdrPlace = (services: Pick<ServiceDeps, "platform" | "run" | "read" | "uid">, session: string): HerdrPlace => herdrPlace(hostReads(services, session));
