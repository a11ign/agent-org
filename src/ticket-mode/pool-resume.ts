// @ts-check
// module: a run's agent reached by its pane, the restart the board reads, and the prompt that resumes a run a restart or an idle spell left at a prompt (A11-279)
//
// HERDR 0.9.3 LISTS CLAUDE AGENTS WITH NO NAME, so `herdr agent prompt t-a11-270` answers `agent_not_found` even for a run herdr lists. On 2026-10-25 the host rebooted, herdr brought every session back
// "Interrupted", and every prompt the board sent after it was refused by name, so the runs sat dead for up to 1h40m while their cards said running. Every `agent prompt | read | send-keys` of ticket mode
// now goes through {@link agentTarget}: the run's pane, or the root pane of the workspace herdr lists under the run's label. Never the name.
//
// A RESTART IS READ, NOT GUESSED. `restarts.json` in the state folder keeps this boot's id and when herdr's service last started. A new boot id, a new herdr start, or this instance's first watch pass is a restart,
// and in that same pass every live run whose agent is idle at a prompt, or whose pane shows it was interrupted, and that has written no outcome since, is sent {@link RESUME_PROMPT} once, and its card says so.
// A run whose workspace is gone is not here: `reconcile` (pool-readopt.ts) queues it again, first, with a line in its brief.
//
// AN IDLE RUN IS NEVER SHOWN AS RUNNING. A running run whose agent has sat idle for {@link IDLE_RESUME_MS} with no outcome but a `working` note is resumed once, and its card says since when. Still idle as long
// again after that, it ends `needs-human` with its pane kept, so the chairman's session can answer it there. A run on a declared wait still inside its `until`, or with background work running, is waiting, not idle; one the board already woke for its wait keeps A11-245's one wake and its stall.
import { readFileSync, statSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { herdrReason, readAgents, rootPaneOf, type ListedAgent } from "../herdr-agents.ts";
import { HERDR_UNIT } from "../install/herdr-place.ts";
import { type PoolContext } from "./pool-context.ts";
import { type RunPlace } from "./pool-paths.ts";
import { log, runMembers, runPlace, updateEach } from "./pool-state.ts";
import { end } from "./pool-settle.ts";
import { outcomeWritten, parseOutcome } from "./pool-outcome.ts";
// eslint-disable-next-line clean-code/no-duplication -- import list: the rule matches statement shape, and imports are not duplicated logic
import { untoldDecline } from "./pool-decline.ts";
import { OUTCOME_FILE } from "./worker-files.ts";
import { replace, type Entry, type Queue, type ResumeNote } from "./queue/queue-entries-and-outcomes.ts";
import { paneBackgroundWork } from "./background-work.ts";
import { deadlineOf } from "./wait-on/wait-note.ts";
import { subjectOf } from "./wait-on/wait-types.ts";
import { escalationReason } from "./escalation.ts";

/** How long a running run's agent may sit idle at a prompt with no outcome before the board resumes it, and as long again after that before it is handed to a person: the ticket's ten minutes. */
export const IDLE_RESUME_MS = 10 * 60_000;

/** The file in the state folder that holds what the board last read of a restart. */
export const RESTARTS_FILE = "restarts.json";

/** The one line the board sends a run a restart or an idle spell left at a prompt. One line, as the board's other prompts are: a new line typed into a pane would submit it early. */
export const RESUME_PROMPT = "The agents host, herdr or the board restarted while you were working, or you have been idle at a prompt, so your last command may have been interrupted. "
  + "Check your worktree (`git status`, `git log -3`) and your background jobs, re-run whatever was interrupted, re-check anything you were waiting on (a fleet job, a CI run, a pull request), "
  + "and carry on with your plan. Write your outcome as usual when you finish.";

/** What the pane of an interrupted Claude Code session shows: `Interrupted · What should Claude do instead?`. */
const INTERRUPTED = "Interrupted";

/** What the board reads a restart from: this boot's id, and when herdr's service last started on it. Either is null where it cannot be read (no `/proc`, launchd, a hand-run herdr). */
export type RestartReads = Readonly<{ bootId: () => string | null; herdrStart: () => string | null }>;

/** What `restarts.json` holds. */
type RestartRecord = Readonly<{ bootId: string | null; herdrStartedAt: string | null }>;

/** Why this pass is a restart: the host booted, herdr's service started again, or this instance started. */
export type Restart = "boot" | "herdr" | "instance";

/** This boot's id, from the kernel; null off Linux. */
function readBootId(): string | null {
  try {
    return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() || null;
  } catch {
    return null;
  }
}

/** When `agent-org-herdr.service` last started, on the monotonic clock of this boot; null when it is not running under systemd, or the service manager cannot be asked. */
function readHerdrStart(): string | null {
  if (process.platform !== "linux") return null;
  try {
    const started = execFileSync("systemctl", ["--user", "show", HERDR_UNIT.systemd, "-p", "ExecMainStartTimestampMonotonic", "--value"], { encoding: "utf8", timeout: 5_000, stdio: ["ignore", "pipe", "ignore"] }).trim();
    return started === "" || started === "0" ? null : started;
  } catch {
    return null;
  }
}

/** The machine's own reads: the kernel's boot id and the service manager's record of herdr's start. Both only read. */
export const LIVE_RESTART_READS: RestartReads = { bootId: readBootId, herdrStart: readHerdrStart };

/** What `restarts.json` held, or nothing when there is no readable record yet. */
function readRestartRecord(path: string): RestartRecord | null {
  try {
    const held = JSON.parse(readFileSync(path, "utf8")) as Partial<RestartRecord>;
    return { bootId: held.bootId ?? null, herdrStartedAt: held.herdrStartedAt ?? null };
  } catch {
    return null;
  }
}

/** Which restart a change in the record says, or null for none: a new boot id first, since a boot starts herdr too. A value that cannot be read now says nothing. PURE. */
function restartBetween(before: RestartRecord | null, now: RestartRecord): Restart | null {
  if (before === null) return null;
  if (now.bootId !== null && now.bootId !== before.bootId) return "boot";
  return now.herdrStartedAt !== null && now.herdrStartedAt !== before.herdrStartedAt ? "herdr" : null;
}

/**
 * Whether this pass comes after a restart, and which: the boot id or herdr's start differs from the record, or this is the instance's first pass. The record is written whenever it changes, so each
 * restart is seen once. A value that cannot be read this pass (the service manager timed out) keeps the one on record, so the next good read is no restart. A record that cannot be written is said, and the
 * next pass reads the restart again.
 */
export function readRestart(ctx: PoolContext): Restart | null {
  const reads = ctx.deps.restartReads ?? LIVE_RESTART_READS;
  const path = join(ctx.settings.stateDir, "tickets", RESTARTS_FILE);
  const before = readRestartRecord(path);
  const now: RestartRecord = { bootId: reads.bootId() ?? before?.bootId ?? null, herdrStartedAt: reads.herdrStart() ?? before?.herdrStartedAt ?? null };
  const first = !ctx.restart.read;
  ctx.restart.read = true;
  const seen = restartBetween(before, now) ?? (first ? "instance" : null);
  if (JSON.stringify(before) !== JSON.stringify(now)) writeRestartRecord(path, now);
  return seen;
}

/** Write `restarts.json`, saying so when it cannot be written. */
function writeRestartRecord(path: string, record: RestartRecord): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(record)}\n`);
  } catch (err) {
    log(`${path} could not be written, so the next pass reads the same restart again (${err instanceof Error ? err.message : String(err)})`);
  }
}

/**
 * The herdr target of a run's agent: its pane, or the root pane of the workspace herdr lists under the run's label. Throws when herdr lists no workspace for it, so a caller's refusal path says why.
 * Never the agent's name: herdr 0.9.3 answers `agent_not_found` to it.
 */
export function agentTarget(ctx: PoolContext, { name, pane }: Pick<RunPlace, "name" | "pane">): string {
  if (pane !== undefined) return pane;
  const workspace = readAgents((args) => ctx.herdr(args), ctx.session)?.find((agent) => agent.label === name)?.workspace;
  if (workspace === undefined) throw new Error(`herdr lists no workspace for ${name}, so its agent has no pane to reach`);
  return rootPaneOf(workspace);
}

/** Send `text` to a run's agent by its pane: null when herdr took it, or why it could not be sent. */
export function sendToAgent(ctx: PoolContext, place: Pick<RunPlace, "name" | "pane">, text: string): string | null {
  try {
    ctx.herdr(["--session", ctx.settings.herdrSession, "agent", "prompt", agentTarget(ctx, place), text]);
    return null;
  } catch (err) {
    return herdrReason(err);
  }
}

/** What a run's agent shows on screen now, or null when herdr cannot read it. */
function readScreen(ctx: PoolContext, place: RunPlace): string | null {
  try {
    return ctx.herdr(["--session", ctx.settings.herdrSession, "agent", "read", agentTarget(ctx, place), "--source", "visible"]);
  } catch {
    return null;
  }
}

/** A time as the board's log and its stored reasons say it: `15:22Z`, UTC. PURE. */
export const utcClock = (at: number): string => `${new Date(at).toISOString().slice(11, 16)}Z`;

/** The resume prompt, with the declared wait a run's `working` note names, so a restart sends it to check that wait again before it declares it again. PURE. */
export function resumePrompt(entry: Entry): string {
  const note = entry.working;
  const waits = note?.waits?.map(subjectOf).join(", ") ?? note?.waitingOn;
  return waits === undefined ? RESUME_PROMPT : `${RESUME_PROMPT} You declared a wait on: ${waits}. Check each again before you declare it again.`;
}

/** Whether a run has written no outcome but a `working` note: no outcome file since it was last marked stale, or one that says `working`. */
function awaitsOutcome(entry: Entry, dir: string): boolean {
  if (!outcomeWritten(dir)) return true;
  try {
    return parseOutcome(readFileSync(join(dir, OUTCOME_FILE), "utf8"), { talk: entry.talk === true }).kind === "working";
  } catch {
    return false;
  }
}

/** When the run's outcome file was last written, or null when it has none. */
function outcomeWrittenAt(dir: string): number | null {
  const path = join(dir, OUTCOME_FILE);
  return existsSync(path) ? statSync(path).mtimeMs : null;
}

/** Record the board's resume of a run on every ticket of it, as `note`, and its idle clock as it was. PURE. */
const recordResume = (queue: Queue, key: string, note: ResumeNote): Queue => replace(queue, key, (entry) => ({ ...entry, resume: note }));

/** A run the board may resume: a live ticket run with no person at its terminal. PURE. */
const resumable = (entry: Entry): boolean => entry.phase === "running" && entry.talk !== true;

/**
 * After a restart, every running run whose agent is idle (or done) at a prompt, or whose pane shows it was interrupted, and that has written no outcome but a `working` note, is sent the resume prompt once, in the same
 * pass. A run working, on a dialog, that wrote its outcome, or that has a declined safety prompt it is about to be told of, is left to the watch. A refusal is on the card and in the log, and the idle watch tries
 * again. Returns the herdr names of the runs it prompted, which the rest of this pass neither ends for having no outcome nor prompts again: the status it read was taken before the prompt. On an instance's own start herdr
 * kept every session, so a run that was not interrupted and is waiting (on a declared wait inside its `until`, on background work, or stalled after the board woke it for its wait) is left as it is.
 */
export function resumeAfterRestart(ctx: PoolContext, status: ReadonlyMap<string, string>): ReadonlySet<string> {
  const restart = readRestart(ctx);
  const prompted = new Set<string>();
  if (restart === null) return prompted;
  for (const entry of ctx.store.get().entries.filter(resumable)) {
    const place = runPlace(ctx, entry);
    if (prompted.has(place.name) || !awaitsOutcome(entry, place.dir) || untoldDecline(ctx, entry)) continue;
    const seen = status.get(place.name);
    const sitting = seen === "idle" || seen === "done";
    // herdr may not read an interrupted session's state: an `unknown` agent is resumed when its pane says it was interrupted. A working one, or one on a dialog, is not.
    if (!sitting && seen !== "unknown") continue;
    const screen = readScreen(ctx, place);
    const interrupted = screen?.includes(INTERRUPTED) === true;
    if (!sitting && !interrupted) continue;
    if (restart === "instance" && !interrupted && keptWaiting(ctx, entry, screen)) continue;
    prompted.add(place.name);
    resumeRun(ctx, entry, place, { at: ctx.now(), after: "restart" });
  }
  return prompted;
}

/** Whether a run an instance's restart did not interrupt is waiting, not stuck: on its wait ({@link onItsWait}), or on background work its pane shows. */
const keptWaiting = (ctx: PoolContext, entry: Entry, screen: string | null): boolean => onItsWait(ctx, entry) || (screen !== null && showsBackground(screen));

/**
 * Whether a run is on its declared wait: still inside its `until`, or stalled after the board woke it for it. That wake is A11-245's one prompt, after which the card says the run is stalled on the wait: a second
 * prompt would undo its "once".
 */
const onItsWait = (ctx: PoolContext, entry: Entry): boolean => waitsInside(ctx, entry) || entry.working?.woke !== undefined;

/** Whether a run's `working` note names a wait still inside its `until`: the run is waiting on it, not idle. */
const waitsInside = (ctx: PoolContext, entry: Entry): boolean => {
  const note = entry.working;
  return note !== undefined && (note.waits !== undefined || note.waitingOn !== undefined) && ctx.now() < deadlineOf(note);
};

/** Whether the idle watch leaves a run alone: it works, it wrote an outcome other than `working`, it is on its wait ({@link onItsWait}), or it has a decline it was not yet told of. */
const notIdle = (ctx: PoolContext, entry: Entry, dir: string, seen: string): boolean =>
  seen === "working" || !awaitsOutcome(entry, dir) || onItsWait(ctx, entry) || untoldDecline(ctx, entry);

/** Send a run the resume prompt and record it on its card: the time, why, and herdr's refusal when it would not take it. */
function resumeRun(ctx: PoolContext, entry: Entry, place: RunPlace, note: ResumeNote): void {
  const who = entry.batch ?? entry.ticket.key;
  const refused = sendToAgent(ctx, place, resumePrompt(entry));
  updateEach(ctx, runMembers(ctx, entry), (queue, key) => recordResume(queue, key, refused === null ? note : { ...note, refused }));
  const what = note.after === "restart" ? `after a restart at ${utcClock(note.at)}` : `idle since ${utcClock(note.idleSince ?? note.at)}, at ${utcClock(note.at)}`;
  log(refused === null ? `${who} was sent the resume prompt ${what}` : `${who} could not be prompted ${what}: ${refused}`);
}

/** How long the board waits before it tries again a resume prompt herdr refused. */
const RETRY_REFUSED_MS = 60_000;

/** Whether herdr refused the board's last resume prompt to a run less than {@link RETRY_REFUSED_MS} ago: it is not tried again yet. PURE. */
const refusedJustNow = (resume: ResumeNote | undefined, now: number): boolean => resume?.refused !== undefined && now - resume.at < RETRY_REFUSED_MS;

/** Whether the board's resume of a run counts as its one resume: there is one, and herdr took it. A refused one does not count. PURE. */
const spentResume = (resume: ResumeNote | undefined): resume is ResumeNote => resume !== undefined && resume.refused === undefined;

/**
 * The idle watch of one running run, on the status this pass read: its idle clock starts when it is first seen idle with no outcome but a `working` note, and stops when it works. Idle for {@link IDLE_RESUME_MS}, it is
 * resumed once; idle as long again after the board's resume, with no outcome written since, it ends `needs-human`, its pane kept. A resume is spent by a newer outcome file, or by the run working on for
 * {@link IDLE_RESUME_MS} after it, so a run that went on is resumed again the next time it sits idle. A resume herdr refused is not one: it is tried again, at most once a minute. A run on a declared wait inside its
 * `until`, or one the board already woke for its wait, with background work running, or with a safety prompt's decline it was not yet told of, is not idle.
 */
export function watchIdle(ctx: PoolContext, entry: Entry, seen: string): void {
  const current = ctx.store.get().entries.find((e) => e.ticket.key === entry.ticket.key);
  if (current === undefined || !resumable(current)) return;
  const place = runPlace(ctx, current);
  const now = ctx.now();
  if (resumeOver(current, place.dir, seen, now)) updateEach(ctx, runMembers(ctx, current), dropResume);
  if (notIdle(ctx, current, place.dir, seen)) return updateEach(ctx, runMembers(ctx, current), idleCleared);
  if (seen !== "idle" && seen !== "done") return;
  const since = current.idleSince ?? now;
  if (current.idleSince === undefined) updateEach(ctx, runMembers(ctx, current), idleFrom(since));
  const resume = ctx.store.get().entries.find((e) => e.ticket.key === current.ticket.key)?.resume;
  const spent = spentResume(resume);
  const from = Math.max(since, spent ? resume.at : 0);
  if (now - from < IDLE_RESUME_MS || refusedJustNow(resume, now) || backgroundRuns(ctx, place)) return;
  if (!spent) return resumeRun(ctx, current, place, { at: now, after: "idle", idleSince: since });
  end(ctx, current, { kind: "needs-human", reason: escalationReason(undefined, `idle at a prompt since ${utcClock(since)}; the board's resume prompt at ${utcClock(resume.at)} did not start it`) });
}

/** Whether a run's resume is over: it wrote an outcome after it, or it is working {@link IDLE_RESUME_MS} or more after it. The prompt's own short turn does not spend it. */
function resumeOver(entry: Entry, dir: string, seen: string, now: number): boolean {
  if (entry.resume === undefined) return false;
  const written = outcomeWrittenAt(dir);
  return (written !== null && written > entry.resume.at) || (seen === "working" && now - entry.resume.at >= IDLE_RESUME_MS);
}

/** Whether a pane's status line counts background work running (a shell or a Monitor): the worker is waiting on it, not idle. PURE. */
function showsBackground(screen: string): boolean {
  const counts = paneBackgroundWork(screen);
  return counts.shells + counts.monitors > 0;
}

/** Whether a run's pane shows background work running. A pane that cannot be read shows none. */
function backgroundRuns(ctx: PoolContext, place: RunPlace): boolean {
  const screen = readScreen(ctx, place);
  return screen !== null && showsBackground(screen);
}

/**
 * A run whose herdr workspace came back under another id (a reboot or a herdr restart that restored it anew) is re-seated: when its own workspace is no longer listed and exactly one workspace is listed under its
 * label, the entry takes that workspace and its root pane, so every prompt, read and key reaches the agent that is there. Live and parked runs both, every ticket of a batch. `agents` is the pass's one listing.
 */
export function reseatMoved(ctx: PoolContext, agents: readonly ListedAgent[]): void {
  const listedIds = new Set(agents.flatMap((agent) => (agent.workspace === undefined ? [] : [agent.workspace])));
  const seen = new Set<string>();
  for (const entry of ctx.store.get().entries.filter((e) => e.workspace !== undefined && (e.phase === "running" || e.phase === "finished"))) {
    const { name } = runPlace(ctx, entry);
    if (seen.has(name) || listedIds.has(entry.workspace ?? "")) continue;
    seen.add(name);
    const under = agents.filter((agent) => agent.label === name && agent.workspace !== undefined && agent.paneless !== true);
    if (under.length !== 1) continue;
    const workspace = under[0].workspace!;
    const pane = rootPaneOf(workspace);
    updateEach(ctx, runMembers(ctx, entry), (queue, key) => replace(queue, key, (held) => ({ ...held, workspace, pane })));
    log(`${entry.batch ?? entry.ticket.key}: its herdr workspace ${entry.workspace} is gone and ${name} is listed in ${workspace}, so the run now reaches its agent at ${pane}`);
  }
}

/** A run first seen idle at a prompt: its idle clock starts at `since`. PURE. */
const idleFrom = (since: number) => (queue: Queue, key: string): Queue => replace(queue, key, (entry) => ({ ...entry, idleSince: since }));

/** A run seen working, or waiting, has no idle clock. Written only when it had one. PURE. */
const idleCleared = (queue: Queue, key: string): Queue => replace(queue, key, (entry) => {
  if (entry.idleSince === undefined) return entry;
  const { idleSince: _cleared, ...rest } = entry;
  return rest;
});

/** A run's resume is over ({@link resumeOver}): it is spent, and its card no longer says it. PURE. */
const dropResume = (queue: Queue, key: string): Queue => replace(queue, key, (entry) => {
  const { resume: _spent, ...rest } = entry;
  return rest;
});
