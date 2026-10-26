// @ts-check
// module: starting a run -- its workspace and agent, the start dialogs it may answer, and the fill of the free slots

import { type Entry, leaveBatch, recordMove, SETTLED } from "./queue/queue-entries-and-outcomes.ts";
import type { TicketWriterMode } from "./queue/writer-modes.ts";
import { type PlannedAgainst, recordPlannedAgainst } from "./queue/queue-ticket-text.ts";
import { earlyCompletionComment, recordCompletedByPerson, recordReopenFailure, recordReopened } from "./queue/queue-next-step.ts";
import { plannedAgainstIn, planFiles, replanStale } from "./pool-ticket-text.ts";
import { runEnvOf } from "./run-env.ts";
import { withRunTmpMade } from "./run-isolation.ts";
import { crashed, isPlanning, log, messageOf, phaseOf, publishPlace, runChoice, runPlace, update, updateEach, writerPlace } from "./pool-state.ts";
import { BRIEF_FILE, firstPrompt, OUTCOME_FILE, PLANNING_DENY, STALE_OUTCOME_FILE, STOP_COUNT_FILE, PUBLISH_FILE, PUBLISHED_FILE, reviewPrompt, talkPrompt, workerFlags, WRITER_FILE, writerBriefText, writerPrompt, writerTools } from "./worker-files.ts";
import { type RunPlace } from "./pool-paths.ts";
import { agentTarget } from "./pool-resume.ts";
import { plannedStepsOf } from "./pool-plan-steps.ts";
import { recordPlannedSteps, type RunWorker } from "./queue/queue-run-detail.ts";
import { hostname } from "node:os";
import { agentStartArgs, closedNote, openPane, readAgents } from "../herdr-agents.ts";
import { defaultStartServer, herdrRefusal, herdrServiceOf } from "./pool-herdr.ts";
import { defaultServiceDeps } from "../install/service.ts";
import { finish, markPublishRunning, markPublishStarting, markRunning, markStarting, pathsUnread, planDone, publishFailed, publishStarts, recordBlockers, recordHeads, recordPaths, recordPathsFailure, recordProjectRepos, recordStackBase, unreadBlockerKeys, unreadPaths } from "./queue/queue-transitions.ts";
import { type Blocker, type Ticket, type TicketSource } from "./source.ts";
import { repoOfProject } from "./project-repo.ts";
import { afterMerge, conflictFeedback, mergeBaseIn, remoteHead, stackBaseIn } from "./stack-rebase.ts";
import { isParked, repoOf } from "./board-view/pull-status-and-notes.ts";
import { worktreePath } from "./worktree.ts";
import { claimantOf, type TicketSettings } from "./settings.ts";
import { basename, join } from "node:path";
import { ticketDir } from "./ticket-paths.ts";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
// eslint-disable-next-line clean-code/no-duplication -- import list: the rule matches statement shape, and imports are not duplicated logic
import { markOutcomeStale, PLAN_FILE_BYTES } from "./pool-outcome.ts";
import { parsePaths } from "./overlap.ts";
import { stepPathsOf } from "./plan-step-sections.ts";
import { availableParallelism, loadavg } from "node:os";
import { talk, talkFailed } from "./queue/talk.ts";
import { markWriterRunning, markWriterStarting, nextStarts, recordWriterPin, writerFailed, writerOf, writerToStart } from "./queue.ts";
import { toolPinOf } from "./pool-pin.ts";
import { recordPublishPin, recordToolPin } from "./queue/queue-pins.ts";
import { isDraining } from "./pool-drain.ts";
// eslint-disable-next-line clean-code/no-duplication -- import list: the rule matches statement shape, and imports are not duplicated logic
import { clearRunDir, current, prepare, prepareBatch, talkSession, writeBoardRunFiles, writeRunFiles } from "./pool-prepare.ts";
import { hasPlan, openPulls } from "./board-view/view-types-and-filters.ts";
import { pickTeamOf } from "./pick-scope.ts";
import { type PoolContext } from "./pool-context.ts";
import { trackerWritingOf } from "../plugins/registry.ts";
import { checkRunBrief } from "./pool-check-runs.ts";
import { isCheckRun, VERIFIER_EFFORT, VERIFIER_MODEL } from "./after-merge/verify.ts";
import { settleSessions } from "./pool-sessions.ts";

/** herdr waits on Claude's start; a slow one has been measured past 30 s (`wake.ts`'s start budget), so a start gets 90. */
const START_TIMEOUT_MS = 90_000;

// A new pane's shell is not at its prompt for a moment, longer on a loaded host, and herdr refuses an agent start until it is (`agent_pane_busy`).
const SHELL_TRY_MS = 500;
const SHELL_TRIES = 30;

/** Did herdr refuse because the pane's shell is not ready yet? PURE. */
export function paneShellNotReady(err: unknown): boolean {
  const stderr = (err as { stderr?: unknown } | null)?.stderr;
  return (typeof stderr === "string" || Buffer.isBuffer(stderr)) && String(stderr).includes('"agent_pane_busy"');
}

/**
 * THE TWO DIALOGS CLAUDE CODE RAISES ON A FOLDER IT HAS NOT SEEN, and the only screens the pool answers. `--dangerously-skip-permissions` does not
 * skip them (measured 2026-10-13): a new git worktree asks whether its folder is trusted, and one under a directory whose `CLAUDE.md` imports a
 * file above it (`@AGENTS.md`) asks whether to allow that import. The pool made the worktree and the person declared where worktrees go, so it
 * answers yes to these two, for its own worktree only, a bounded number of times. Any other screen is left for the person, as waiting, except a Claude Code safety prompt, which the pool answers No (`pool-decline.ts`).
 */
const START_DIALOGS: readonly Readonly<{ heading: string; ownFolder: boolean }>[] = [
  { heading: "Is this a project you created or one you trust?", ownFolder: true },
  { heading: "Allow external CLAUDE.md file imports?", ownFolder: false },
];

const MAX_DIALOG_ANSWERS = 4;

const squash = (text: string): string => text.replace(/\s+/g, "");

/** Is the pane showing one of {@link START_DIALOGS} for `worktree`? A trust dialog must name the worktree, which a pane may wrap across lines. PURE. */
export function isStartDialog(screen: string, worktree: string): boolean {
  return START_DIALOGS.some(({ heading, ownFolder }) => screen.includes(heading) && (!ownFolder || squash(screen).includes(squash(worktree))));
}

/**
 * Open the workspace and start Claude in it. Returns the workspace and its pane, or throws with herdr's reason after closing anything it opened. `first` is the prompt Claude starts with when the run's own first
 * prompt is not the one: the resume prompt of a run started again where it was (A11-279).
 */
export async function start(ctx: PoolContext, entry: Entry, folder: string, dir: string, resume?: string, first?: string): Promise<{ workspace: string; pane: string }> {
  const runId = entry.batch ?? entry.ticket.key;
  // The worker's shell carries its ticket, its branch and the host file, which `ticket:worktree` reads. A batch's run has no one ticket, and makes no worktree.
  const env = withRunTmpMade(ctx, runEnvOf(ctx, entry), runId);
  const { model, effort } = runChoice(ctx, entry);
  const cause = entry.asked ? "asked" : entry.feedback !== undefined ? "feedback" : "approved";
  const prompt = first ?? (entry.talk ? talkPrompt(dir) : entry.review === undefined ? firstPrompt(dir) : reviewPrompt(dir, cause));
  return startAgent(ctx, { ...runPlace(ctx, entry), folder }, env, [prompt, ...workerFlags({ name: runId, model, effort, addDirs: [dir], resume })], runId);
}

/** Run herdr's `agent start` for `args`, trying again while herdr says the pane's shell is not ready, and throw whatever else it refuses with. */
async function startOnceShellReady(ctx: PoolContext, args: string[]): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await ctx.herdrAsync(args, START_TIMEOUT_MS);
      return;
    } catch (err) {
      if (!paneShellNotReady(err) || attempt >= SHELL_TRIES) throw err;
      await ctx.wait(SHELL_TRY_MS);
    }
  }
}

/**
 * Open a workspace named `place.name` in `place.folder`, with `env` in its shell, and start Claude in it with `tail` after the command. Returns
 * the workspace and its pane, or throws with herdr's reason, naming `what`, after closing anything it opened.
 */
async function startAgent(ctx: PoolContext, place: RunPlace, env: Record<string, string>, tail: readonly string[], what: string): Promise<{ workspace: string; pane: string }> {
  const { herdr, herdrAsync, session, startedHere } = ctx;
  const run = (args: string[]) => herdr(args);
  const opened = openPane(run, place.name, env, place.folder, { ...session, tmpBase: ctx.runTmpBase });
  if ("refusal" in opened) throw new Error(opened.refusal);
  try {
    await startOnceShellReady(ctx, agentStartArgs(place.name, "claude", opened.pane, [...tail], session));
  } catch (err) {
    // A start can outlast its timeout and still succeed: ask the listing before calling it a failure.
    const listed = readAgents(run, session)?.find((agent) => agent.label === place.name);
    if (listed === undefined || listed.status === "unknown") {
      throw new Error(`herdr could not start Claude for ${what} (${herdrRefusal(err)})${closedNote(run, opened.workspace, session)}`);
    }
  }
  startedHere.add(place.name);
  ctx.envLost.delete(place.name);
  return { workspace: opened.workspace, pane: opened.pane };
}

/** Answer a start dialog on this run's pane, if one is showing and the run has answers left. True when it answered. The agent is reached by its pane, never its name (A11-279). */
export function answerStartDialog(ctx: PoolContext, place: RunPlace): boolean {
  const { answered, herdr, settings, startedHere } = ctx;
  const { name, folder } = place;
  if (!startedHere.has(name)) return false;
  const count = answered.get(name) ?? 0;
  if (count >= MAX_DIALOG_ANSWERS) return false;
  let screen: string;
  let target: string;
  try {
    target = agentTarget(ctx, place);
    screen = herdr(["--session", settings.herdrSession, "agent", "read", target, "--source", "visible"]);
  } catch {
    return false;
  }
  if (!isStartDialog(screen, folder)) return false;
  herdr(["--session", settings.herdrSession, "agent", "send-keys", target, "down", "enter"]);
  answered.set(name, count + 1);
  return true;
}

/**
 * Just after a start, answer the start dialogs as they appear, rather than one per tick: a few short waits, then the tick takes over. The pane is the one just opened, which herdr lists under the run's label: a pane
 * the entry held before this start is not it.
 */
export async function settleStart(ctx: PoolContext, started: RunPlace): Promise<void> {
  const { herdr, session, startedHere, wait } = ctx;
  const { pane: _before, ...place } = started;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    await wait(1500);
    const status = readAgents((args) => herdr(args), session)?.find((agent) => agent.label === place.name)?.status;
    if (status === "working" || status === "idle" || status === "done") {
      startedHere.delete(place.name);
      return;
    }
    answerStartDialog(ctx, place);
  }
}

/**
 * Ask the tracker which tickets block each of `keys`, and which project each is in, and record both on each queued run: the project's repository is the
 * run's default (`project-repo.ts`), so it is read here too, from the summary the tracker holds now. Then the commit each stacked blocker's branch is at
 * is read (`readHeads`). A source that cannot say records none, so nothing waits; a key the tracker has no ticket for is recorded with none, so it starts
 * and fails on its own. Throws when the tracker cannot be asked.
 */
export async function readBlockers(ctx: PoolContext, keys: readonly string[]): Promise<void> {
  const { source, settings, store } = ctx;
  if (keys.length === 0) return;
  const found = source.blockers === undefined ? new Map() : await source.blockers(keys);
  // Awaited only when the source can say: an extra turn here would delay a start that waits on nothing (see `headsToRead`).
  const summaries = source.projectSummaries === undefined ? undefined : await summariesOf(source, keys);
  const clones = Object.keys(settings.clones);
  update(ctx, (queue) => recordProjectRepos(queue, projectRepos(store.get().entries, keys, summaries, clones)));
  update(ctx, (queue) => recordBlockers(queue, new Map(keys.map((key) => [key, found.get(key) ?? []]))));
}

/**
 * The project summaries the tracker gives for `keys`, or undefined when it cannot say: the repositories then come from the summaries the tickets were queued
 * with, and the failure is logged. A failed summary read never stops a start, as it is not a blocker, so a run is not held back by it (A11-116).
 */
async function summariesOf(source: TicketSource, keys: readonly string[]): Promise<ReadonlyMap<string, string | null> | undefined> {
  if (source.projectSummaries === undefined) return undefined;
  try {
    return await source.projectSummaries(keys);
  } catch (err) {
    log(`the tracker could not say which projects the queued tickets are in: ${messageOf(err)}`);
    return undefined;
  }
}

/** Whether a blocker's branch is to be read: it has one, and the blocker is not done, canceled or a duplicate (`readHeads`). PURE. */
const branchToRead = (blocker: Blocker): blocker is Blocker & Readonly<{ branch: string }> => blocker.branch !== undefined && !SETTLED.has(blocker.state);

/** The summary a run's project names: the tracker's now, or, where the source cannot say, the one the ticket was queued with. A project the tracker gives none has none. PURE. */
const summaryOf = (summaries: ReadonlyMap<string, string | null> | undefined, entry: Entry | undefined, key: string): string | null | undefined =>
  summaries === undefined ? entry?.ticket.projectSummary : summaries.get(key) ?? null;

/** Whether a queued run among `keys` has a blocker whose branch is to be read (`readHeads`). PURE. */
const isReadable = (entry: Entry, keys: readonly string[]): boolean => entry.phase === "queued" && keys.includes(entry.ticket.key) && (entry.blockers ?? []).some(branchToRead);

/** The repository each of `keys`' projects names, among `clones`, by key (`project-repo.ts`), read from the summaries the tracker gave or each ticket's own. PURE. */
function projectRepos(entries: readonly Entry[], keys: readonly string[], summaries: ReadonlyMap<string, string | null> | undefined, clones: readonly string[]): Map<string, string | null> {
  return new Map(keys.map((key) => [key, repoOfProject(summaryOf(summaries, entries.find((e) => e.ticket.key === key), key), clones)]));
}

/** The clone a run's blockers' branches are read in: the one of its planned or project's repository, when this machine has it (`readHeads`). */
function cloneOfRun(settings: TicketSettings, entry: Entry): string | undefined {
  const repo = repoOf(entry);
  const clone = repo === null ? undefined : settings.clones[repo];
  return clone !== undefined && existsSync(clone) ? clone : undefined;
}

/** Whether any run `isReadable` names has a clone to read in, so the heads are read this pass. */
export function headsToRead(ctx: PoolContext, keys: readonly string[]): boolean {
  const { settings, store } = ctx;
  return store.get().entries.some((entry) => isReadable(entry, keys) && cloneOfRun(settings, entry) !== undefined);
}

/**
 * Record the commit each stacked blocker's branch is at on the remote of the repository its blocked run works in, as `head` (A11-116): a branch that is not
 * pushed there has none, and is not stackable. Only the blockers a run could stack on are asked: those with a branch that are not completed, canceled or a
 * duplicate. A failed `ls-remote` leaves that head unset and is logged once per pass, so the pass is never thrown out of.
 */
export async function readHeads(ctx: PoolContext, keys: readonly string[]): Promise<void> {
  const { git, settings, store } = ctx;
  const heads = new Map<string, Map<string, string>>();
  let logged = false;
  for (const entry of store.get().entries) {
    // A repository this machine does not have is no place a branch can be read from, so its blockers carry no head and none of them stacks.
    const clone = cloneOfRun(settings, entry);
    if (!isReadable(entry, keys) || clone === undefined) continue;
    const found = new Map<string, string>();
    for (const blocker of (entry.blockers ?? []).filter(branchToRead)) {
      try {
        const head = await remoteHead(git, clone, blocker.branch);
        if (head !== null) found.set(blocker.key, head);
      } catch (err) {
        if (!logged) log(`${entry.ticket.key}: the remote could not say where ${blocker.branch} is: ${messageOf(err)}`);
        logged = true;
      }
    }
    heads.set(entry.ticket.key, found);
  }
  update(ctx, (queue) => recordHeads(queue, heads));
}

/** A stacked review round's merge before it starts, when there is nothing to merge in, or none could be made (A11-150). */
const NO_MERGE = { held: null, feedback: null } as const;

/**
 * Merge a stacked review round's blocker branch in before it starts, so the round begins on the merged branch (A11-116, A11-150). Returns why the run cannot
 * start on it, and, when the merge conflicted, the feedback the round starts with: the conflict lines, so that the round merges the base in first. A merge that
 * fails for another reason ends the run needing a person's look, with no round started on it.
 */
async function mergeBeforeRound(ctx: PoolContext, entry: Entry): Promise<{ held: string | null; feedback: string | null }> {
  const { git, now, settings, store } = ctx;
  const key = entry.ticket.key;
  const record = entry.stackBase;
  const clone = record === undefined ? undefined : settings.clones[record.repo];
  if (record === undefined || clone === undefined) return NO_MERGE;
  // The lock is taken before the first await, in the same turn as the sweep's check (`rebaseOneStack`), so no merge runs in this worktree beside this one.
  ctx.rebasing.add(key);
  try {
    const head = await remoteHead(git, clone, record.branch);
    if (head === null || head === record.sha) return NO_MERGE;
    const result = await mergeBaseIn({ git, worktree: worktreePath(settings.worktreeRoot, key, record.repo), own: entry.ticket.branch, base: record });
    update(ctx, (queue) => recordStackBase(queue, key, afterMerge(stackBaseIn(queue, key, record), head, result, now())));
    if (result.ok) return NO_MERGE;
    if (result.conflict === undefined) return { held: `Merging ${record.key} into the branch ${result.reason}`, feedback: null };
    const pulls = openPulls(store.get().entries.find((e) => e.ticket.key === key) ?? entry);
    return { held: null, feedback: conflictFeedback(pulls.filter((pr) => pr.repo === record.repo).map((pr) => pr.url), record, result.conflict) };
  } finally {
    ctx.rebasing.delete(key);
  }
}

/**
 * The run as its round starts on it, when its merge of the blocker's branch conflicted (A11-150): an asked round is given the conflict as its feedback, and a
 * round the board started keeps its own feedback, with the conflict line after it. An approval round keeps its brief as it is: `approvedRound` already has the
 * worker merge a conflicting base first, and the feedback it would take here would replace its instruction to mark the draft ready. PURE.
 */
const withConflict = (entry: Entry, feedback: string): Entry => {
  if (entry.asked === true) return { ...entry, feedback };
  if (entry.feedback === undefined) return entry;
  return { ...entry, feedback: `${entry.feedback}\n${feedback}` };
};

/**
 * What a ticket's plan files declare of the files its work touches: the repository-prefixed paths of their `## Paths` sections, each once, and the paths each step section lists, by step number
 * (A11-175, see `plan-step-sections.ts`). A file that is not a plan, or is too large, declares none. The first plan file to list a step's paths gives them.
 */
function pathsIn(files: readonly string[], plan: string | null): { paths: string[]; stepPaths: Record<string, string[]> } {
  const found = { paths: [] as string[], stepPaths: {} as Record<string, string[]> };
  if (plan === null) return found;
  const pattern = new RegExp(plan);
  for (const file of files) {
    if (!pattern.test(basename(file)) || statSync(file).size > PLAN_FILE_BYTES) continue;
    const text = readFileSync(file, "utf8");
    for (const path of parsePaths(text)) {
      if (!found.paths.includes(path)) found.paths.push(path);
    }
    for (const [step, paths] of Object.entries(stepPathsOf(text))) found.stepPaths[step] ??= paths;
  }
  return found;
}

/**
 * Read the paths each queued run's plan declares, and record them on the runs. A plan the tracker refuses to give is recorded as that run's failure,
 * and each other plan is read as it would be: one ticket's plan does not hold the others, since a run whose plan is unread is never started, so a
 * failing one is not started beside a run it may overlap (A11-125). It is asked again on the next pass.
 */
async function readPaths(ctx: PoolContext, entries: readonly Entry[]): Promise<void> {
  if (entries.length === 0) return;
  const found = new Map<string, readonly string[]>();
  const stepFound = new Map<string, Readonly<Record<string, readonly string[]>>>();
  const stamps = new Map<string, PlannedAgainst | null>();
  const failed = new Map<string, string>();
  for (const { ticket } of entries) {
    let files: readonly string[];
    try {
      files = await planFiles(ctx, ticket);
    } catch (err) {
      failed.set(ticket.key, messageOf(err).split("\n")[0]);
      continue;
    }
    const declared = pathsIn(files, ctx.settings.plan);
    found.set(ticket.key, declared.paths);
    stepFound.set(ticket.key, declared.stepPaths);
    // The plan's stamp is read with its paths, from the same download: it says which text of the ticket the plan was written against (A11-167).
    stamps.set(ticket.key, plannedAgainstIn(files, ctx.settings.plan));
  }
  update(ctx, (queue) => recordPlannedAgainst(recordPathsFailure(recordPaths(queue, found, stepFound), failed), stamps));
}

/**
 * Start what there is room for. A run whose blockers have not been read is read first, and none starts while the tracker cannot say, because
 * starting a run before its blockers are known would start work that waits on another. Its plan paths are read the same way, so a run is not
 * started beside a run it overlaps before the overlap is known. Each start is recorded before it begins, so a second tick cannot start it again.
 */
export async function fill(ctx: PoolContext): Promise<void> {
  const { batches, deps, removing, rebasing, store } = ctx;
  try {
    const unread = unreadBlockerKeys(store.get());
    await readBlockers(ctx, unread);
    // Only when a head is to be read: a start decides on its stacked blockers' heads, so a run read now has them before it starts.
    if (headsToRead(ctx, unread)) await readHeads(ctx, unread);
    // A paused queue starts nothing, so it reads no plan either: the plans are read when it is unpaused.
    if (!store.get().paused) await readPaths(ctx, unreadPaths(store.get()));
  } catch {
    return;
  }
  // A round or a talk session never starts beside an agent that holds its Claude session or its name (A11-154): one that works holds it back, a leftover is closed.
  settleSessions(ctx);
  // A batch is planned together only while this machine's planner plans batches: otherwise each of its tickets is planned alone.
  if (!batches) updateEach(ctx, store.get().entries.filter((e) => e.phase === "queued" && e.batch !== undefined && !e.talk), leaveBatch);
  const { load, cores } = (deps.load ?? (() => ({ load: loadavg()[0], cores: availableParallelism() })))();
  // A run queued again while this pass read the blockers or the paths, such as a batch's ticket whose order was just recorded, waits for the next pass's read.
  // A breaking update that is draining (A11-169) starts nothing: no run, no round, no talk session, no publish run and no new-ticket run, until the update has applied and the record is gone.
  if (isDraining(ctx)) return;
  const starts = nextStarts(store.get(), load, cores).filter((entry) => entry.blockers !== undefined && !pathsUnread(entry));
  const begun = new Set<string>();
  // A host's own condition for starting work (`tickets.preflight`): while one fails, no ticket run starts and every queued one stays Queued, with the reason on the board.
  // Publishing and the new-ticket writer need none of it, so they go on.
  const mayStart = starts.length === 0 || ctx.settings.preflight.length === 0 || (await ctx.gate.check()).ok;
  for (const entry of mayStart ? starts : []) {
    // A talk session resumes a finished run's own session where it ran: no brief is written, and no plan or worktree is touched. A batch's tickets share that session: one pane (A11-171).
    if (entry.talk) {
      if (begun.has(entry.ticket.key)) continue;
      // Every queued talk session of the batch starts with the one that is let start: the run is one, in one slot, and a member left behind would open a second pane.
      const together = entry.batch === undefined ? [entry] : store.get().entries.filter((e) => e.batch === entry.batch && e.talk === true && e.phase === "queued");
      for (const member of together) begun.add(member.ticket.key);
      await startTalk(ctx, together);
      continue;
    }
    if (begun.has(entry.ticket.key) || removing.has(entry.ticket.key) || rebasing.has(entry.ticket.key)) continue;
    const batch = entry.batch === undefined ? [entry] : starts.filter((e) => e.batch === entry.batch && !e.talk);
    for (const member of batch) begun.add(member.ticket.key);
    await (batch.length > 1 ? startBatch(ctx, batch) : startOne(ctx, entry));
  }
  if (publishStarts(store.get())) await startPublish(ctx);
  if (writerToStart(store.get()) !== undefined) await startWriter(ctx);
}

/**
 * Whether the run `key` is in was stopped while it was starting. The stop is the person's last word, so the workspace its start raced is closed
 * and the run stays stopped.
 */
function stoppedWhileStarting(ctx: PoolContext, key: string, workspace: string): boolean {
  const { herdr, session } = ctx;
  if (phaseOf(ctx, key) === "starting") return false;
  closedNote((args) => herdr(args), workspace, session);
  return true;
}

/** Where a run starts (A11-219): this instance's name and this machine's host name. Over an SSH connection the page reads the remote instance's own queue, so the instance there is the remote's. */
const workerOf = ({ settings }: PoolContext): RunWorker => ({ instance: settings.instance, host: hostname() });

/** Record the numbered steps of the plan each of `keys` starts with, read from the plan files the run was queued with, before its brief is written (A11-219). A planning run has no plan yet and records none. Throws when a plan file cannot be read, so the run does not start as if it had no plan. */
function recordPlan(ctx: PoolContext, keys: readonly string[]): void {
  for (const key of keys) {
    const steps = plannedStepsOf(ctx, key);
    update(ctx, (queue) => recordPlannedSteps(queue, key, steps));
  }
}

/**
 * Open the run's workspace and start its agent there, and record the run as running: every one of `members`, the tickets that share the one pane (`entry` alone, unless it is
 * a batch's talk session). False when a person stopped it while it started.
 */
async function openRun(ctx: PoolContext, entry: Entry, folder: string, dir: string, resume?: string, members: readonly Entry[] = [entry]): Promise<boolean> {
  const { workspace, pane } = await start(ctx, entry, folder, dir, resume);
  if (stoppedWhileStarting(ctx, entry.ticket.key, workspace)) return false;
  updateEach(ctx, members, (queue, key) => markRunning(queue, key, workspace, pane));
  return true;
}

/**
 * Open a finished run's saved session in a new pane, for a person to talk to its agent. The outcome it ended on is marked stale, as when a person answers a
 * parked run, so the stop hook asks for a new one. A batch's tickets share the one session, so their talk sessions start together, in one pane (A11-171): `members` are
 * them, and the first leads. A session that cannot start puts the finished runs back on the board as they were, and says why in the log.
 */
async function startTalk(ctx: PoolContext, members: readonly Entry[]): Promise<void> {
  const { now } = ctx;
  const [entry] = members;
  const { key } = entry.ticket;
  const keys = members.map(({ ticket }) => ticket.key);
  updateEach(ctx, members, (queue, member) => markStarting(queue, member, now(), workerOf(ctx)));
  try {
    recordPlan(ctx, keys);
    const place = runPlace(ctx, entry);
    const resume = talkSession(ctx, entry);
    if (resume === undefined) throw new Error(`${key} has no saved session to resume`);
    // The session resumes the run's own settings, which name its pinned version folder. A finished run holds no folder (A11-169), so one pruned since has its hooks written again, naming this instance's.
    if (entry.toolRoot !== undefined && !existsSync(entry.toolRoot)) {
      writeRunFiles(ctx, entry, place.folder, place.dir);
      update(ctx, (queue) => recordToolPin(queue, keys, toolPinOf(ctx)));
    }
    const outcome = join(place.dir, OUTCOME_FILE);
    if (existsSync(outcome)) markOutcomeStale(place.dir, statSync(outcome).mtimeMs);
    rmSync(join(place.dir, STOP_COUNT_FILE), { force: true });
    if (await openRun(ctx, entry, place.folder, place.dir, resume, members)) await settleStart(ctx, place);
  } catch (err) {
    // A failure after the pane opened leaves a run that is live: only one still starting goes back, and its outcome mark is taken off with it.
    if (phaseOf(ctx, key) !== "starting") return log(`${key}: the talk session failed after it started (${messageOf(err)})`);
    const { dir } = runPlace(ctx, entry);
    rmSync(join(dir, STALE_OUTCOME_FILE), { force: true });
    log(`${keys.join(", ")}: the talk session could not start (${messageOf(err)}), so the run is back on the board as it was`);
    updateEach(ctx, members.filter(({ ticket }) => phaseOf(ctx, ticket.key) === "starting"), talkFailed);
  }
}

/** Whether a run has a talk session that is queued, starting or running, or parked: waiting for the person in its terminal. */
const hasTalkSession = (entry: Entry): boolean => entry.talk === true && (entry.phase !== "finished" || isParked(entry));

/**
 * A person asks to talk to a run's agent. Nothing changes, and nothing is refused, when the run already has a talk session that is queued, starting, running or parked,
 * or another ticket of its batch has (a batch is one run, with one session and one pane): the second press finds the first (A11-171). Otherwise it is refused, naming why,
 * when there is no session to resume, and while a review round of the run is queued or running, since the round and the talk session would share the run's Claude
 * session (A11-154). Else the session is queued, and starts on the next pass.
 */
export function talkTo(ctx: PoolContext, key: string): void {
  const { now, store } = ctx;
  const entry = store.get().entries.find((e) => e.ticket.key === key);
  const sharing = entry === undefined ? [] : entry.batch === undefined ? [entry] : store.get().entries.filter((e) => e.batch === entry.batch);
  if (sharing.some(hasTalkSession)) return;
  if (entry?.review !== undefined && entry.talk !== true && entry.phase !== "finished") throw new Error(`${key} has a review round ${entry.phase === "queued" ? "queued" : "running"}: talk to it once the round has ended, as the round and a talk session would share one session`);
  if (entry === undefined || entry.phase !== "finished") throw new Error(`${key} has no finished run to talk to`);
  if (talkSession(ctx, entry) === undefined) throw new Error(`${key} has no saved session to resume: its transcript is gone`);
  update(ctx, (queue) => talk(queue, key, now()));
}

/** Start one run for one ticket, the rest of its batch, if it had one, being started already or waiting on a blocker. */
async function startOne(ctx: PoolContext, queued: Entry): Promise<void> {
  const { now } = ctx;
  // The sweep is merging this run's branch in its worktree: the run waits, still queued, for a later tick (A11-150).
  if (ctx.rebasing.has(queued.ticket.key)) return;
  if (queued.batch !== undefined) update(ctx, (queue) => leaveBatch(queue, queued.ticket.key));
  const { batch: _alone, ...entry } = queued;
  // The copy of agent-org this start writes its hooks and commands for is recorded as the start is, before any file names it (A11-169).
  update(ctx, (queue) => recordToolPin(markStarting(queue, entry.ticket.key, now(), workerOf(ctx)), [entry.ticket.key], toolPinOf(ctx)));
  try {
    if (!isPlanning(ctx, entry)) recordPlan(ctx, [entry.ticket.key]);
    if (isPlanning(ctx, entry) && await planReached(ctx, entry.ticket)) {
      // A plan reached the ticket since it was queued, such as one a person attached or an earlier attempt left: it is worked from that.
      update(ctx, (queue) => planDone(queue, entry.ticket.key, { unattended: false, now: now() }));
      return;
    }
    // A work run no longer waits for a person to settle an open decision (A11-257): its planner settled it, and a worker decides the rest. A review round may wait on its stacked base instead. Only a work run
    // reads the tracker here, so a planning run or a review round starts as it did before.
    const isWork = !isPlanning(ctx, entry) && entry.review === undefined;
    const fresh = isWork ? await current(ctx, entry.ticket) : undefined;
    // A work run whose plan was stamped with a description the ticket no longer has, or that a blocker's findings reached after the plan was written, plans again before it starts (A11-167).
    const queuedRun = fresh !== undefined ? await replanStale(ctx, entry, fresh) : entry;
    const merge = queuedRun.review !== undefined && queuedRun.stackBase !== undefined ? await mergeBeforeRound(ctx, queuedRun) : NO_MERGE;
    const blocked = merge.held;
    if (blocked !== null) {
      update(ctx, (queue) => finish(queue, entry.ticket.key, { kind: "needs-human", reason: blocked }, now()));
      return;
    }
    const round = merge.feedback === null ? queuedRun : withConflict(queuedRun, merge.feedback);
    const { folder, dir, resume } = await prepare(ctx, round);
    if (!(await openRun(ctx, round, folder, dir, resume))) return;
    await takeTicket(ctx, queuedRun);
    await settleStart(ctx, runPlace(ctx, queuedRun));
  } catch (err) {
    update(ctx, (queue) => finish(queue, entry.ticket.key, crashed(err), now()));
  }
}

/**
 * What a run does in the tracker once its agent is open: a work run puts the ticket back first when the tracker's integration completed it between plan steps, then moves it to the working state, and a
 * work or planning run claims it for this instance. A review round moves nothing it has not moved and claims nothing, and a talk session does neither. Every step is idempotent, so a run adopted after a
 * restart (A11-240) takes the steps its start was cut short of.
 */
export async function takeTicket(ctx: PoolContext, run: Entry): Promise<void> {
  if (!isPlanning(ctx, run)) {
    // A later step may be queued before the tracker's integration completes the ticket on the merge of the step before it (A11-178): put back first, so the move below finds it started.
    if (run.review === undefined && (run.steps ?? []).length > 0) await undoEarlyCompletion(ctx, run);
    moveTicketToWorkingState(ctx, run.ticket.key);
  }
  if (run.review === undefined && run.talk !== true) claimTicket(ctx, run.ticket.key);
}

/**
 * Start one planning run for the tickets of a batch that are ready, in queue order. A ticket whose plan reached it since it was queued is
 * worked from that plan, and leaves the batch. Fewer than two left are each planned alone. A start that fails, such as a tracker that cannot
 * be read for one ticket, crashes every ticket of the batch, and a retry plans each one alone.
 */
async function startBatch(ctx: PoolContext, batch: readonly Entry[]): Promise<void> {
  const { now } = ctx;
  updateEach(ctx, batch, (queue, key) => recordToolPin(markStarting(queue, key, now(), workerOf(ctx)), [key], toolPinOf(ctx)));
  try {
    const members: Entry[] = [];
    for (const entry of batch) {
      if (await planReached(ctx, entry.ticket)) update(ctx, (queue) => planDone(queue, entry.ticket.key, { unattended: false, now: now() }));
      else members.push(entry);
    }
    if (members.length < 2) {
      for (const member of members) await startOne(ctx, member);
      return;
    }
    const [lead] = members;
    const { folder, dir } = await prepareBatch(ctx, members);
    const { workspace, pane } = await start(ctx, lead, folder, dir);
    // A stop of any ticket while it was starting stopped the whole batch.
    if (stoppedWhileStarting(ctx, lead.ticket.key, workspace)) return;
    updateEach(ctx, members, (queue, key) => markRunning(queue, key, workspace, pane));
    for (const member of members) claimTicket(ctx, member.ticket.key);
    await settleStart(ctx, runPlace(ctx, lead));
  } catch (err) {
    updateEach(ctx, batch.filter(({ ticket }) => phaseOf(ctx, ticket.key) === "starting"), (queue, key) => finish(queue, key, crashed(err), now()));
  }
}

/**
 * Ask the tracker to put back a ticket its own integration completed while the run's work was partial (A11-178), and record what it said. The integration completes a ticket on the merge of a pull request whose
 * body carries a closing word beside the ticket's key, whatever the rest of the body declares. The tracker moves such a ticket back and posts the comment ({@link earlyCompletionComment}) naming the merged pull
 * requests and what remains, and the run reads the tracker's state again on the next sweep, so its next step is queued like that of any partial run. A ticket a person completed is left alone, and the run reads
 * Completed. A refusal, a tracker that cannot undo a completion, and a completion it cannot attribute are recorded on the run, which the card flags, and the next sweep asks again. Never throws.
 * A run that has not finished reads no Completed from the tracker, so for it only the move back is recorded: a person's completion, or a failure, is the sweep's to find when the run finishes.
 */
export async function undoEarlyCompletion(ctx: PoolContext, entry: Entry): Promise<void> {
  const { source } = ctx;
  const key = entry.ticket.key;
  const undo = source.undoAutomaticCompletion?.bind(source);
  if (undo === undefined) {
    if (entry.phase === "finished") update(ctx, (queue) => recordReopenFailure(queue, key, "the tracker cannot put a ticket back"));
    return;
  }
  try {
    const { reopened, by, note } = await undo(key, earlyCompletionComment(entry));
    if (reopened !== null) log(`${key}: the tracker's integration completed it while its work was partial; moved it back to ${reopened.from}`);
    if (reopened !== null || by === "none") update(ctx, (queue) => recordReopened(queue, key));
    else if (entry.phase !== "finished") return;
    else if (by === "person") update(ctx, (queue) => recordCompletedByPerson(queue, key));
    else update(ctx, (queue) => recordReopenFailure(queue, key, note ?? "the tracker did not say why"));
  } catch (err) {
    if (entry.phase === "finished") update(ctx, (queue) => recordReopenFailure(queue, key, messageOf(err)));
    else log(`${key}: the tracker could not be asked whether its integration completed it: ${messageOf(err)}`);
  }
}

/**
 * Tell the tracker a worker has started on the ticket, by moving it to this machine's working state, and keep the state it moved it out of on
 * the run, so the board can put it back. Nothing waits on the move and nothing turns on it, so a failure is written to the board's log rather
 * than stopping the run. The move is kept in `pendingMoves` until it has resolved, so a restore that comes first waits for it.
 */
function moveTicketToWorkingState(ctx: PoolContext, key: string): void {
  const { pendingMoves, settings, source } = ctx;
  const { workingState } = settings;
  const move = source.moveToWorkingState?.bind(source);
  if (workingState === null || move === undefined) return;
  // Started inside a promise, so even a source that throws before it answers cannot reach the run.
  const pending: Promise<void> = Promise.resolve().then(() => move(key, workingState))
    .then(({ moved, note }) => {
      if (moved !== null) update(ctx, (queue) => recordMove(queue, key, moved));
      if (note !== null) log(note);
    }, (err) => log(`${key} could not be moved to ${workingState}: ${messageOf(err)}`));
  pendingMoves.set(key, pending);
  void pending.then(() => { if (pendingMoves.get(key) === pending) pendingMoves.delete(key); });
}

/**
 * Tell the tracker this instance holds the ticket, as a run starts on it to plan or to implement it (A11-168): another instance's queue reads the claim and does not queue the
 * ticket, and this instance's own finished run is not taken for another's. The tracker writes nothing when this instance's claim is already the latest. As with the move to the
 * working state, nothing waits on it and nothing turns on it: a failure goes to the board's log, and the run goes on.
 */
function claimTicket(ctx: PoolContext, key: string): void {
  const { settings, source } = ctx;
  const claim = source.claim?.bind(source);
  if (claim === undefined) return;
  // Started inside a promise, so even a source that throws before it answers cannot reach the run.
  void Promise.resolve().then(() => claim(key, claimantOf(settings)))
    .catch((err) => log(`${key} could not be claimed in the tracker: ${messageOf(err)}`));
}

/** Whether the ticket has a plan of its own in the tracker now. */
async function planReached(ctx: PoolContext, queued: Ticket): Promise<boolean> {
  const { settings, source } = ctx;
  const fresh = await source.read(queued.key);
  return fresh !== null && settings.plan !== null && hasPlan(fresh, new RegExp(settings.plan));
}

/**
 * Start the first queued new-ticket run: its brief (with its mode), its mark, which lets the run read the tracker and file the one ticket it creates (A11-135), and its settings, then its agent,
 * on the model and effort it was queued with (the writer's, when it has none of its own: a run queued before the choice was stamped). A run stopped
 * while it starts is closed, as a ticket run stopped while it starts is. A start that fails ends the run failed, saying why.
 */
async function startWriter(ctx: PoolContext): Promise<void> {
  const { herdr, now, session, settings, source, store } = ctx;
  const queued = writerToStart(store.get());
  const writer = settings.writer;
  if (queued === undefined) return;
  update(ctx, (queue) => recordWriterPin(markWriterStarting(queue, queued.id, now()), queued.id, toolPinOf(ctx)));
  try {
    const checkRun = isCheckRun(queued.mode);
    // A verifier run and a migration pass (A11-302) file no ticket, so they need no `tickets.writer`: they run on the verifier's model and effort, and may read the tracker and nothing else.
    if (writer === null && !checkRun) throw new Error("this machine names no tickets.writer");
    const model = checkRun ? VERIFIER_MODEL : queued.model ?? writer!.model;
    const effort = checkRun ? VERIFIER_EFFORT : queued.effort ?? writer!.effort;
    const place = writerPlace(ctx, queued);
    const writing = checkRun ? null : trackerWritingOf(settings.providers);
    // A Grill run's ticket is read as it is now: its brief is the grill of that text, and the run may file nothing (A11-134).
    const grilled = queued.ticket === undefined ? undefined : await readGrilled(source, queued.ticket);
    clearRunDir(ctx, place.folder, place.dir);
    const brief = checkRun ? checkRunBrief(ctx, queued, place.dir) : writerBriefText({ run: writer!.run, request: queued.request, mode: queued.mode as TicketWriterMode, placement: queued.placement, form: queued.form, clones: settings.clones,
      dir: place.dir, team: queued.team ?? null, pickTeam: pickTeamOf(settings.pick), writing: writing!, ...(grilled === undefined ? {} : { ticket: grilled }) });
    writeFileSync(join(place.dir, BRIEF_FILE), brief);
    writeFileSync(join(place.dir, WRITER_FILE), `${JSON.stringify({ mode: queued.mode, tools: grilled === undefined && writing !== null ? writerTools(writing) : [] })}\n`);
    writeBoardRunFiles(ctx, place, { deny: [...settings.deny, ...PLANNING_DENY], readDirs: Object.values(settings.clones), model, writer: writing });
    const tail = [writerPrompt(place.dir, queued.mode), ...workerFlags({ name: `${checkRun ? queued.mode : "writer"}-${queued.id}`, model, effort, addDirs: [place.dir] })];
    const { workspace, pane } = await startAgent(ctx, place, {}, tail, checkRun ? "the After-merge check run" : "the new-ticket run");
    if (writerOf(store.get(), queued.id)?.phase !== "starting") {
      closedNote((args) => herdr(args), workspace, session);
      return;
    }
    update(ctx, (queue) => markWriterRunning(queue, queued.id, workspace, pane));
    await settleStart(ctx, place);
  } catch (err) {
    update(ctx, (queue) => writerFailed(queue, queued.id, messageOf(err).split("\n")[0], now()));
  }
}

/** The ticket a Grill run grills, as the tracker has it now. Throws when the tracker has no such ticket: the run fails, and says so (A11-134). */
async function readGrilled(source: Pick<TicketSource, "read">, key: string): Promise<Ticket> {
  const found = await source.read(key);
  if (found === null) throw new Error(`${key} is not in the tracker`);
  return found;
}

/**
 * Start the queued publish run: its brief, its mark for the hook naming the connectors only it may call, and its settings file, then its agent, on the publish model and effort. The brief, the
 * connectors and the agent are the enabled publisher plugin's (A11-161); the run's instruction is the host file's, which the reader validated. A start that fails ends it failed, saying why,
 * and its runs stay as they were.
 */
async function startPublish(ctx: PoolContext): Promise<void> {
  const { now, publisher, settings, store } = ctx;
  const queued = store.get().publish;
  if (queued === undefined) return;
  update(ctx, (queue) => recordPublishPin(markPublishStarting(queue, now()), toolPinOf(ctx)));
  try {
    if (publisher === undefined || settings.publish === null) throw new Error("this machine names no tickets.publish");
    const place = publishPlace(ctx, queued);
    const { model, effort } = publisher.agent();
    clearRunDir(ctx, place.folder, place.dir);
    rmSync(join(place.dir, PUBLISHED_FILE), { force: true });
    writeFileSync(join(place.dir, BRIEF_FILE), publisher.briefText({ dir: place.dir, prs: queued.prs, run: settings.publish.run }));
    writeFileSync(join(place.dir, PUBLISH_FILE), `${JSON.stringify({ connectors: publisher.connectors() })}\n`);
    writeBoardRunFiles(ctx, place, { deny: settings.deny, readDirs: [], model });
    const tail = [firstPrompt(place.dir), ...workerFlags({ name: `publish-${queued.id}`, model, effort, addDirs: [place.dir] })];
    const { workspace, pane } = await startAgent(ctx, place, {}, tail, "the publish run");
    update(ctx, (queue) => markPublishRunning(queue, workspace, pane));
    await settleStart(ctx, place);
  } catch (err) {
    update(ctx, (queue) => publishFailed(queue, messageOf(err).split("\n")[0], now()));
  }
}

/**
 * The session's herdr server answers, starting it when it does not. herdr has a service of its own (A11-169), and when it is registered the unit is started, so the server is never the instance's child
 * and survives every restart of it. Only a machine with no herdr service (a hand-run `ticket:serve`) spawns the server itself.
 */
export async function ensureSession(ctx: PoolContext): Promise<void> {
  const { deps, herdr, session, settings, wait } = ctx;
  const run = (args: string[]) => herdr(args);
  if (readAgents(run, session) !== null) return;
  const service = deps.herdrService ?? (deps.startServer === undefined ? herdrServiceOf(defaultServiceDeps()) : undefined);
  if (service?.registered()) service.start();
  else (deps.startServer ?? defaultStartServer)(settings.herdrSession);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await wait(250);
    if (readAgents(run, session) !== null) return;
  }
  throw new Error(`herdr's ${settings.herdrSession} session did not start; start it with: herdr --session ${settings.herdrSession} server`);
}
