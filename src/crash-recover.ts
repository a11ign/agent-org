// THE AFTER-CRASH UNIT (a11ign#5127): the agents host recovers from a hard crash by itself.
//
// On 2026-10-11 18:05:24Z the host went down with no shutdown lines. Afterwards the primary checkout's `project.json` was 0 bytes (every tick crashed
// `ProjectDeclarationRefusal`), the tool checkout's `.git` had 16 empty files, and every agent pane was dead. The chairman repaired it by hand in about
// 20 minutes; this module is that repair, run by `a11ign-crash-recover.service` before the work-tick timer.
//
// THE ORDER IS THE DESIGN: files first, because everything below reads `project.json`; git second; panes third, because a resumed seat reads the files;
// `reset-failed` fourth, so the tick units failed by the broken files start again; the announcement last, so it lists what was actually repaired.
//
// THIS FILE DOES NOT IMPORT `host-config.ts` OR `project-config.ts` AT THE TOP, and reads `host.json` as plain JSON: a recovery that needs the
// declarations it exists to restore would crash on exactly the boot it was written for. `wake.ts` and `worker-profile.ts` (launch flags) are imported
// by `resumeFlags`' default, which runs only after the files are back.

import { execFileSync } from "node:child_process";
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import { recordFailures } from "./failure-ledger.ts";
import { sandboxGitEnv } from "./lib/git-env.ts";

export const HARD_CRASH_CLASS = "host-hard-crash";
const WEEK_MS = 7 * 24 * 3_600_000;
const UNCLEAN_MARK = "uncleanly shut down";
const DIAGNOSTIC_TAIL_LINES = 20;
const SHA_PATTERN = /^[0-9a-f-]{36}$/;
const SEATS = ["ceo", "product-manager", "orchestrator", "liaison"];

// --- ATOMIC WRITES (row item 2) -------------------------------------------------------------------------------------------------------
/**
 * Write `text` to `path` so a crash leaves the OLD file or the NEW one and never an empty one: temp file in the same directory (a rename never crosses
 * a filesystem), fsync, rename, then fsync the directory so the rename itself survives. The 0-byte `project.json` of 2026-10-11 was a plain
 * `writeFileSync` that the kernel had truncated and not yet filled.
 */
export function writeFileAtomic(path: string, text: string): void {
  const temporary = `${path}.${process.pid}.tmp`;
  const fd = openSync(temporary, "w");
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, path);
  const dir = openSync(dirname(path), "r");
  try {
    fsyncSync(dir);
  } finally {
    closeSync(dir);
  }
}

// --- DETECTION ------------------------------------------------------------------------------------------------------------------------
export type Detection = { unclean: boolean; newPstore: string[]; reasons: string[] };

/**
 * A boot is unclean when journald says so OR a pstore record exists that no earlier boot recorded. Both, because the kernel can die before journald
 * writes anything (the 2026-10-11 journal ended mid-tick) and a clean-looking journal after a power cut is exactly the case pstore catches.
 * @param pstoreIds entries of `/var/lib/systemd/pstore`; `seen` the ones a previous run already handled
 */
export function detectUncleanBoot({ pstoreIds, seen, journalText }: { pstoreIds: string[]; seen: ReadonlySet<string>; journalText: string }): Detection {
  const newPstore = pstoreIds.filter((id) => !seen.has(id)).sort();
  const reasons = [
    ...(journalText.includes(UNCLEAN_MARK) ? ["journald: previous boot was uncleanly shut down"] : []),
    ...newPstore.map((id) => `pstore record ${id}`),
  ];
  return { unclean: reasons.length > 0, newPstore, reasons };
}

// --- (a) TRUNCATED TRACKED FILES ------------------------------------------------------------------------------------------------------
export type Git = (cwd: string, args: string[]) => { ok: boolean; out: string };

/** @returns the tracked paths that are 0 bytes on disk and non-empty at HEAD, which is the signature of a write the crash cut short. */
export function truncatedTracked(checkout: string, git: Git): string[] {
  const listed = git(checkout, ["ls-files", "-z"]);
  if (!listed.ok) return [];
  return listed.out.split("\0").filter(Boolean).filter((path) => isEmptyFile(join(checkout, path)) && headSize(checkout, path, git) > 0);
}

function isEmptyFile(path: string): boolean {
  try {
    const stat = lstatSync(path);
    return stat.isFile() && stat.size === 0;
  } catch {
    return false;
  }
}

function headSize(checkout: string, path: string, git: Git): number {
  const size = git(checkout, ["cat-file", "-s", `HEAD:${path}`]);
  return size.ok ? Number(size.out.trim()) || 0 : 0;
}

/** Restore each truncated file from HEAD. A file that is 0 bytes holds no edit to lose, so `checkout HEAD --` is safe here and only here. */
export function restoreTruncated(checkout: string, git: Git): string[] {
  const restored: string[] = [];
  for (const path of truncatedTracked(checkout, git)) {
    if (git(checkout, ["checkout", "HEAD", "--", path]).ok) restored.push(path);
  }
  return restored;
}

// --- (b) EMPTY GIT FILES --------------------------------------------------------------------------------------------------------------
const OBJECT_DIR = /^[0-9a-f]{2}$/;
const WORKTREE_META = ["HEAD", "gitdir", "commondir"];

function walkEmpty(dir: string, accept: (name: string) => boolean = () => true): string[] {
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return walkEmpty(path, accept);
    return entry.isFile() && accept(entry.name) && isEmptyFile(path) ? [path] : [];
  });
}

/** Empty object files, refs, FETCH_HEAD and linked-worktree metadata under a `.git` directory. `.keep` markers and the rest of `.git` are legitimately empty and left alone. */
export function emptyGitFiles(gitDir: string): string[] {
  const objects = readdirSync(gitDir.concat("/objects")).filter((name) => OBJECT_DIR.test(name) || name === "pack").flatMap((name) => walkEmpty(join(gitDir, "objects", name), (file) => !file.endsWith(".keep")));
  const refs = walkEmpty(join(gitDir, "refs"));
  const fetchHead = isEmptyFile(join(gitDir, "FETCH_HEAD")) ? [join(gitDir, "FETCH_HEAD")] : [];
  const worktrees = existsSync(join(gitDir, "worktrees")) ? walkEmpty(join(gitDir, "worktrees"), (name) => WORKTREE_META.includes(name)) : [];
  return [...objects, ...refs, ...fetchHead, ...worktrees];
}

/** Move (never delete) each empty git file into `aside`, named by its path under `.git` with `/` as `~`, so the chairman can see what the crash took. */
export function moveAside({ gitDir, files, aside }: { gitDir: string; files: string[]; aside: string }): string[] {
  mkdirSync(aside, { recursive: true });
  return files.map((file) => {
    const target = join(aside, file.slice(gitDir.length + 1).replaceAll("/", "~"));
    renameSync(file, target);
    return target;
  });
}

export type GitRepair = { checkout: string; moved: number; fetched: boolean; fsck: "clean" | "failed" | "skipped" };

/** Move the empty files aside, refetch what they held (`--refetch`: a plain fetch negotiates "I have it" for a commit whose blob is gone and transfers nothing), and read the connectivity back. Skips a checkout with no `.git` directory (a linked worktree has a file). */
export function repairGit({ checkout, git, aside }: { checkout: string; git: Git; aside: string }): GitRepair {
  const gitDir = join(checkout, ".git");
  if (!existsSync(gitDir) || !lstatSync(gitDir).isDirectory()) return { checkout, moved: 0, fetched: false, fsck: "skipped" };
  const files = emptyGitFiles(gitDir);
  if (files.length === 0) return { checkout, moved: 0, fetched: false, fsck: "skipped" };
  moveAside({ gitDir, files, aside: join(aside, basename(checkout)) });
  const fetched = git(checkout, ["fetch", "--quiet", "--refetch", "--tags", "--force", "origin"]).ok;
  const fsck = git(checkout, ["fsck", "--connectivity-only", "--no-progress"]).ok ? "clean" : "failed";
  return { checkout, moved: files.length, fetched, fsck };
}

// --- (c) PANES ------------------------------------------------------------------------------------------------------------------------
/** One row of `herdr agent list`: `agent` is truthy while a process lives in the pane. */
export type HerdrAgent = { name: string; pane_id: string; agent?: string | null; agent_session?: { agent?: string; value?: string } | null };
export type LaunchProfile = { model?: string; effort?: string; autocompact?: number };
export type PaneAction =
  | { kind: "resume"; name: string; paneId: string; sessionId: string; role: "seat" | "worker"; profile: LaunchProfile }
  | { kind: "close"; name: string; paneId: string }
  | { kind: "skip"; name: string; why: string };

/**
 * What to do with every pane whose agent is gone. A seat is resumed with its roster entry (`sessions.json`), a worker with the model and effort of its
 * last traced turn, and a reviewer pane is CLOSED, not resumed: the gate respawns `reviewer-<n>` for a PR that still needs one, and a resumed reviewer
 * would hold a verdict slot for a head that may have moved. Anything else, or a pane with no session id, is skipped BY NAME rather than guessed at.
 */
export function planPaneActions({ agents, seatProfiles, traced }: {
  agents: HerdrAgent[]; seatProfiles: ReadonlyMap<string, LaunchProfile>; traced: ReadonlyMap<string, LaunchProfile>;
}): PaneAction[] {
  return agents.filter((a) => !a.agent).map((a): PaneAction => {
    if (a.name.startsWith("reviewer-")) return { kind: "close", name: a.name, paneId: a.pane_id };
    const session = a.agent_session;
    if (session?.agent !== "claude" || !SHA_PATTERN.test(session.value ?? "")) {
      return { kind: "skip", name: a.name, why: `no resumable claude session (${session?.agent ?? "none"} ${session?.value ?? ""})`.trim() };
    }
    const sessionId = session.value as string;
    if (SEATS.includes(a.name)) return { kind: "resume", name: a.name, paneId: a.pane_id, sessionId, role: "seat", profile: seatProfiles.get(a.name) ?? {} };
    if (a.name.startsWith("worker-")) return { kind: "resume", name: a.name, paneId: a.pane_id, sessionId, role: "worker", profile: traced.get(sessionId) ?? {} };
    return { kind: "skip", name: a.name, why: "not a seat, a worker or a reviewer" };
  });
}

/**
 * The shell command typed into the pane: `claude --resume <id>` plus the org's own launch flags for the role. A pane started again after a crash
 * does not hold the variables the spawn gave the first one, so `AGENT_ORG_HOST` goes in front as a shell assignment (#1484); without a `hostPath`
 * the command keeps its old form.
 */
export function resumeCommand(action: Extract<PaneAction, { kind: "resume" }>, flags: string[], hostPath?: string): string {
  const env = hostPath === undefined ? [] : [`AGENT_ORG_HOST=${shellWord(hostPath)}`];
  return [...env, "claude", "--resume", action.sessionId, ...flags].join(" ");
}

/** A word the shell reads as itself: bare when it has no metacharacters, single-quoted otherwise, so a path with a space still reaches the variable whole. */
function shellWord(text: string): string {
  return /^[\w@%+=:,./-]+$/.test(text) ? text : `'${text.replaceAll("'", `'\\''`)}'`;
}

/** The last model/effort per transcript id, from the trace's `turn` events. A line that is not JSON is a torn write from the crash and is skipped. */
export function lastTurnProfiles(ndjson: string): Map<string, LaunchProfile> {
  const last = new Map<string, LaunchProfile>();
  for (const line of ndjson.split("\n")) {
    if (!line.includes('"kind":"turn"')) continue;
    try {
      const turn = JSON.parse(line);
      if (turn.transcript) last.set(turn.transcript, { model: turn.model, effort: turn.effort });
    } catch {
      continue;
    }
  }
  return last;
}

// --- (e) REPEAT CRASHES (row item 3) ---------------------------------------------------------------------------------------------------
/** Two hard crashes inside seven days is a hardware-health question, not two incidents. @param atMs the instants of the recorded crashes */
export function repeatCrash(atMs: number[], now: number): boolean {
  return atMs.filter((at) => at >= now - WEEK_MS && at <= now).length >= 2;
}

/** The incident text: the record's last lines, which are the kernel's own last words. */
export function incidentBody({ id, recordText }: { id: string; recordText: string }): string {
  const tail = recordText.split("\n").filter(Boolean).slice(-DIAGNOSTIC_TAIL_LINES).join("\n");
  return `Hard crash recorded by pstore (${id}). Last lines of the record:\n${tail}`;
}

// --- THE RUN --------------------------------------------------------------------------------------------------------------------------
export type Ports = {
  now: () => number;
  pstoreIds: () => string[];
  readPstore: (id: string) => string;
  journalText: () => string;
  git: Git;
  checkouts: () => string[];
  asideDir: string;
  seenPath: string;
  readSeen: () => { id: string; at: number }[];
  writeSeen: (seen: { id: string; at: number }[]) => void;
  herdrAgents: () => HerdrAgent[];
  herdr: (args: string[]) => void;
  seatProfiles: () => Map<string, LaunchProfile>;
  traced: () => Map<string, LaunchProfile>;
  /** Loads what the launch flags need (`wake.ts` reads the declarations), so it runs AFTER the files are restored and never on a clean boot. */
  prepare: () => Promise<void>;
  flagsFor: (action: Extract<PaneAction, { kind: "resume" }>) => string[];
  /** The host declaration's path, which the resumed command names as `AGENT_ORG_HOST` (#1484). Loaded with the launch flags, for the same reason. */
  hostPath: () => string | undefined;
  resetFailed: () => void;
  announce: (text: string) => void;
  fileIncident: (title: string, body: string) => void;
  wakeCeo: (text: string) => void;
  log: (line: string) => void;
};

export type Report = {
  detection: Detection; restored: string[]; git: GitRepair[]; resumed: string[]; closed: string[]; skipped: string[]; repeat: boolean; resetFailed: boolean;
};

const EMPTY_REPORT = (detection: Detection): Report => ({ detection, restored: [], git: [], resumed: [], closed: [], skipped: [], repeat: false, resetFailed: false });

function resumePanes(ports: Ports, report: Report): void {
  const actions = planPaneActions({ agents: ports.herdrAgents(), seatProfiles: ports.seatProfiles(), traced: ports.traced() });
  for (const action of actions) {
    try {
      if (action.kind === "skip") report.skipped.push(`${action.name}: ${action.why}`);
      else if (action.kind === "close") { ports.herdr(["pane", "close", action.paneId]); report.closed.push(action.name); }
      else { ports.herdr(["pane", "run", action.paneId, resumeCommand(action, ports.flagsFor(action), ports.hostPath())]); report.resumed.push(action.name); }
    } catch (cause) {
      report.skipped.push(`${action.name}: ${String((cause as Error).message).split("\n")[0]}`);
    }
  }
}

function flagCrashes(ports: Ports, report: Report): void {
  const now = ports.now();
  const seen = ports.readSeen();
  const added = report.detection.newPstore.map((id) => ({ id, at: now }));
  ports.writeSeen([...seen, ...added]);
  for (const { id } of added) {
    ports.fileIncident(`Hard crash of the agents host (pstore ${id})`, incidentBody({ id, recordText: ports.readPstore(id) }));
  }
  report.repeat = repeatCrash([...seen, ...added].map(({ at }) => at), now);
  if (report.repeat) {
    ports.wakeCeo("Two hard crashes of the agents host inside seven days. Treat it as a hardware-health question (memory, disk, PSU) and brief the chairman; the pstore records are listed in the incident rows.");
  }
}

/** The boot-time procedure. An error in one step is logged and does not stop the next: a half repair that resumes the seats beats a clean abort. */
export async function recover(ports: Ports): Promise<Report> {
  const seen = new Set(ports.readSeen().map(({ id }) => id));
  const detection = detectUncleanBoot({ pstoreIds: ports.pstoreIds(), seen, journalText: ports.journalText() });
  const report = EMPTY_REPORT(detection);
  if (!detection.unclean) { ports.log("clean boot: nothing to repair"); return report; }
  const step = (name: string, run: () => void) => {
    try { run(); } catch (cause) { ports.log(`${name} failed: ${String((cause as Error).message).split("\n")[0]}`); }
  };
  step("restore", () => { for (const c of ports.checkouts()) report.restored.push(...restoreTruncated(c, ports.git).map((p) => `${basename(c)}:${p}`)); });
  step("git-repair", () => { for (const c of ports.checkouts()) report.git.push(repairGit({ checkout: c, git: ports.git, aside: ports.asideDir })); });
  try { await ports.prepare(); } catch (cause) { ports.log(`prepare failed: ${String((cause as Error).message).split("\n")[0]}`); }
  step("panes", () => resumePanes(ports, report));
  step("reset-failed", () => { ports.resetFailed(); report.resetFailed = true; });
  step("crashes", () => flagCrashes(ports, report));
  step("announce", () => ports.announce(announcement(report)));
  return report;
}

export function announcement(r: Report): string {
  const gitMoved = r.git.reduce((n, g) => n + g.moved, 0);
  return [
    `The agents host restarted after an unclean shutdown (${r.detection.reasons.join("; ")}).`,
    `Restored ${r.restored.length} truncated file(s); moved ${gitMoved} empty git file(s) aside${r.git.some((g) => g.fsck === "failed") ? " (fsck FAILED on some)" : ""}.`,
    `Resumed ${r.resumed.length} pane(s), closed ${r.closed.length} reviewer pane(s), could not resume ${r.skipped.length}.`,
    r.repeat ? "This is the second hard crash in seven days." : "",
  ].filter(Boolean).join("\n");
}

// --- THE REAL PORTS AND THE ENTRY POINT -----------------------------------------------------------------------------------------------
const PSTORE_DIR = "/var/lib/systemd/pstore";

type HostFile = { tool?: string; projects?: { checkout: string }[]; crashRecover?: boolean };

/** `host.crashRecover` is ON when absent: the flag is the off switch, so a host that never wrote it is protected. */
export function crashRecoverEnabled(host: HostFile): boolean {
  return host.crashRecover !== false;
}

function realGit(cwd: string, args: string[]): { ok: boolean; out: string } {
  try {
    return { ok: true, out: execFileSync("git", args, { cwd, encoding: "utf8", timeout: 300_000, env: sandboxGitEnv(), stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 }) };
  } catch (cause) {
    return { ok: false, out: String((cause as Error).message) };
  }
}

function readJson<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

async function realPorts(host: HostFile, home: string): Promise<Ports> {
  const stateDir = join(home, ".cache/a11ign");
  const seenPath = join(stateDir, "crash-recover-seen.json");
  const primary = host.projects?.[0]?.checkout ?? "";
  const tool = host.tool ?? "";
  const herdrRun = (args: string[]) => execFileSync("herdr", ["--session", "org", ...args], { encoding: "utf8", timeout: 320_000 });
  const run = (cmd: string, args: string[]) => { try { return execFileSync(cmd, args, { encoding: "utf8", timeout: 60_000 }); } catch { return ""; } };
  const failureLog = join(stateDir, "failure-ledger");
  const wakeCommand = (verb: string, args: string[]) => execFileSync("node", [join(tool, "src/bin.ts"), verb, ...args], { cwd: primary, timeout: 120_000 });
  return {
    now: () => Date.now(),
    pstoreIds: () => { try { return readdirSync(PSTORE_DIR).filter((n) => /^\d+$/.test(n)); } catch { return []; } },
    readPstore: (id) => { try { return readFileSync(join(PSTORE_DIR, id, "dmesg.txt"), "utf8"); } catch { return ""; } },
    journalText: () => run("journalctl", ["--user", "-b", "-1", "--no-pager", "-n", "200"]) + run("journalctl", ["-b", "0", "--no-pager", "-g", UNCLEAN_MARK]),
    git: realGit,
    checkouts: () => [primary, tool].filter(Boolean),
    asideDir: join(home, `crash-${new Date().toISOString().slice(0, 10)}`),
    seenPath,
    readSeen: () => readJson(seenPath, []),
    writeSeen: (seen) => { mkdirSync(stateDir, { recursive: true }); writeFileAtomic(seenPath, `${JSON.stringify(seen)}\n`); },
    herdrAgents: () => JSON.parse(herdrRun(["agent", "list"])).result.agents,
    herdr: (args) => { herdrRun(args); },
    seatProfiles: () => {
      const roster = readJson<{ live?: ({ name: string } & LaunchProfile)[] }>(join(primary, ".agent-org/roles/sessions.json"), {});
      return new Map((roster.live ?? []).map((s) => [s.name, { model: s.model, effort: s.effort, autocompact: s.autocompact }]));
    },
    traced: () => { try { return lastTurnProfiles(readFileSync(join(stateDir, "trace/events.ndjson"), "utf8")); } catch { return new Map(); } },
    prepare: async () => {},
    flagsFor: () => [],
    hostPath: () => undefined,
    resetFailed: () => { execFileSync("systemctl", ["--user", "reset-failed"], { timeout: 30_000 }); },
    announce: (text) => { wakeCommand("chairman:reply", [text]); },
    fileIncident: (title, body) => {
      mkdirSync(stateDir, { recursive: true });
      writeFileAtomic(join(stateDir, `crash-incident-${Date.now()}.txt`), `${title}\n\n${body}\n`);
      recordFailures({ logPath: failureLog, events: [{ classKey: HARD_CRASH_CLASS, ref: title }], now: Date.now() });
    },
    wakeCeo: (text) => { wakeCommand("prompt:session", ["ceo", text, "--needs-decision"]); },
    log: (line) => process.stderr.write(`crash-recover: ${line}\n`),
  };
}

/** Launch flags need `wake.ts`, which reads the declarations: imported only here, after the files are restored. The host path comes from `host-config.ts`, the resolver `spawnEnvironment` calls, for the same reason. */
export function withLaunchFlags(ports: Ports, tool: string): Ports {
  let wake: any;
  let profile: any;
  let hostConfig: any;
  return {
    ...ports,
    prepare: async () => {
      wake = await import(pathToFileURL(join(tool, "src/wake.ts")).href);
      profile = await import(pathToFileURL(join(tool, "src/worker-profile.ts")).href);
      hostConfig = await import(pathToFileURL(join(tool, "src/host-config.ts")).href);
    },
    hostPath: () => hostConfig.hostConfigPath(),
    flagsFor: (action) => {
      const p = action.profile;
      if (action.role === "seat") return wake.seatStartFlags({ model: p.model, effort: p.effort, autocompact: p.autocompact });
      const model = p.model ?? "sonnet";
      const window = /haiku/.test(model) ? profile.HAIKU_AUTOCOMPACT_WINDOW_TOKENS : profile.AUTOCOMPACT_WINDOW_TOKENS;
      return profile.agentArgs({ kind: "claude", model, effort: p.effort ?? "high", autocompactWindow: window }, {});
    },
  };
}

export async function main(): Promise<number> {
  const home = homedir();
  const host = readJson<HostFile>(process.env.AGENT_ORG_HOST ?? join(home, "repos/a11y-witness/.agent-org/host.json"), {});
  if (!crashRecoverEnabled(host)) { process.stderr.write("crash-recover: host.crashRecover is false; nothing done\n"); return 0; }
  const ports = await realPorts(host, home);
  const report = await recover(withLaunchFlags(ports, host.tool ?? ""));
  process.stderr.write(`crash-recover: ${JSON.stringify({ ...report, detection: report.detection.reasons })}\n`);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().then((code) => process.exit(code), (cause) => { process.stderr.write(`crash-recover: ${String(cause?.stack ?? cause)}\n`); process.exit(70); });
}
