// @ts-check
// module: starting a run -- its workspace and agent, the start dialogs it may answer, and the fill of the free slots

import { type Entry, leaveBatch, recordMove, SETTLED } from "./queue/declared-remains.ts";
import { TICKET_ENV } from "./worktree-command.ts";
import { crashed, isPlanning, log, messageOf, phaseOf, publishPlace, runChoice, runPlace, update, updateEach, writerPlace } from "./pool-state.ts";
import { BRIEF_FILE, firstPrompt, PLANNING_DENY, PUBLISH_FILE, publishBriefText, PUBLISHED_FILE, reviewPrompt, workerFlags, WRITER_CREATE_TOOLS, WRITER_FILE, writerBriefText, writerPrompt } from "./worker-files.ts";
import { type RunPlace } from "./pool-paths.ts";
import { agentStartArgs, closedNote, openPane, readAgents } from "../herdr-agents.ts";
import { defaultStartServer, herdrRefusal } from "./pool-herdr.ts";
import { finish, markPublishRunning, markPublishStarting, markRunning, markStarting, pathsUnread, planDone, publishFailed, publishStarts, recordBlockers, recordHeads, recordPaths, recordPathsFailure, recordProjectRepos, recordStackBase, unreadBlockerKeys, unreadPaths } from "./queue/approve.ts";
import { type Blocker, type Ticket, type TicketSource } from "./source.ts";
import { repoOfProject } from "./project-repo.ts";
import { remoteHead, rebaseDue, rebaseOnto, afterRebase, roundHeldBy, stackBaseIn } from "./stack-rebase.ts";
import { repoOf } from "./board-view/settled-by-pulls.ts";
import { worktreePath } from "./worktree.ts";
import { type TicketSettings } from "./settings.ts";
import { basename, join } from "node:path";
// eslint-disable-next-line clean-code/no-duplication -- import list: the rule matches statement shape, and imports are not duplicated logic
import { ticketDir } from "./ticket-paths.ts";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { PLAN_FILE_BYTES } from "./pool-outcome.ts";
import { parsePaths } from "./overlap.ts";
import { availableParallelism, loadavg } from "node:os";
import { markWriterRunning, markWriterStarting, nextStarts, writerFailed, writerOf, writerToStart } from "./queue.ts";
import { clearRunDir, prepare, prepareBatch, writeBoardRunFiles } from "./pool-prepare.ts";
import { hasPlan } from "./board-view/view-ticket.ts";
import { pickTeamOf } from "./pick-scope.ts";
import { type PoolContext } from "./pool-context.ts";

/** herdr waits on Claude's start; a slow one has been measured past 30 s (`wake.ts`'s start budget), so a start gets 90. */
const START_TIMEOUT_MS = 90_000;

// A new pane's shell is not at its prompt for a moment, longer on a loaded host, and herdr refuses an agent start until it is (`agent_pane_busy`).
const SHELL_POLL_MS = 500;
const SHELL_POLLS = 30;

/** Did herdr refuse because the pane's shell is not ready yet? PURE. */
export function paneShellNotReady(err: unknown): boolean {
  const stderr = (err as { stderr?: unknown } | null)?.stderr;
  return (typeof stderr === "string" || Buffer.isBuffer(stderr)) && String(stderr).includes('"agent_pane_busy"');
}

/**
 * THE TWO DIALOGS CLAUDE CODE RAISES ON A FOLDER IT HAS NOT SEEN, and the only screens the pool answers. `--dangerously-skip-permissions` does not
 * skip them (measured 2026-10-13): a new git worktree asks whether its folder is trusted, and one under a directory whose `CLAUDE.md` imports a
 * file above it (`@AGENTS.md`) asks whether to allow that import. The pool made the worktree and the person declared where worktrees go, so it
 * answers yes to these two, for its own worktree only, a bounded number of times. Any other screen is left for the person, as waiting.
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

/** Open the workspace and start Claude in it. Returns the workspace and its pane, or throws with herdr's reason after closing anything it opened. */
async function start(ctx: PoolContext, entry: Entry, folder: string, dir: string, resume?: string): Promise<{ workspace: string; pane: string }> {
  const { hostFile } = ctx;
  const runId = entry.batch ?? entry.ticket.key;
  // The worker's shell carries its ticket, its branch and the host file, which `ticket:worktree` reads. A batch's run has no one ticket, and
  // makes no worktree.
  const env = { ...(entry.batch === undefined ? { [TICKET_ENV.key]: runId, [TICKET_ENV.branch]: entry.ticket.branch } : {}), ...(hostFile ? { [TICKET_ENV.host]: hostFile } : {}) };
  const { model, effort } = runChoice(ctx, entry);
  const cause = entry.asked ? "asked" : entry.feedback !== undefined ? "feedback" : "approved";
  const prompt = entry.review === undefined ? firstPrompt(dir) : reviewPrompt(dir, cause);
  return startAgent(ctx, { ...runPlace(ctx, entry), folder }, env, [prompt, ...workerFlags({ name: runId, model, effort, addDirs: [dir], resume })], runId);
}

/**
 * Open a workspace named `place.name` in `place.folder`, with `env` in its shell, and start Claude in it with `tail` after the command. Returns
 * the workspace and its pane, or throws with herdr's reason, naming `what`, after closing anything it opened.
 */
async function startAgent(ctx: PoolContext, place: RunPlace, env: Record<string, string>, tail: readonly string[], what: string): Promise<{ workspace: string; pane: string }> {
  const { herdr, herdrAsync, session, startedHere } = ctx;
  const run = (args: string[]) => herdr(args);
  const opened = openPane(run, place.name, env, place.folder, session);
  if ("refusal" in opened) throw new Error(opened.refusal);
  try {
    for (let poll = 1; ; poll++) {
      try {
        await herdrAsync(agentStartArgs(place.name, "claude", opened.pane, [...tail], session), START_TIMEOUT_MS);
        break;
      } catch (err) {
        if (!paneShellNotReady(err) || poll >= SHELL_POLLS) throw err;
        await ctx.wait(SHELL_POLL_MS);
      }
    }
  } catch (err) {
    // A start can outlast its timeout and still succeed: ask the listing before calling it a failure.
    const listed = readAgents(run, session)?.find((agent) => agent.label === place.name);
    if (listed === undefined || listed.status === "unknown") {
      throw new Error(`herdr could not start Claude for ${what} (${herdrRefusal(err)})${closedNote(run, opened.workspace, session)}`);
    }
  }
  startedHere.add(place.name);
  return { workspace: opened.workspace, pane: opened.pane };
}

/** Answer a start dialog on this run's pane, if one is showing and the run has answers left. True when it answered. */
export function answerStartDialog(ctx: PoolContext, { name, folder }: RunPlace): boolean {
  const { answered, herdr, settings, startedHere } = ctx;
  if (!startedHere.has(name)) return false;
  const count = answered.get(name) ?? 0;
  if (count >= MAX_DIALOG_ANSWERS) return false;
  let screen: string;
  try {
    screen = herdr(["--session", settings.herdrSession, "agent", "read", name, "--source", "visible"]);
  } catch {
    return false;
  }
  if (!isStartDialog(screen, folder)) return false;
  herdr(["--session", settings.herdrSession, "agent", "send-keys", name, "down", "enter"]);
  answered.set(name, count + 1);
  return true;
}

/** Just after a start, answer the start dialogs as they appear, rather than one per tick: a few short waits, then the tick takes over. */
async function settleStart(ctx: PoolContext, place: RunPlace): Promise<void> {
  const { herdr, session, startedHere, wait } = ctx;
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

/**
 * Rebase a stacked review round onto its blocker's branch before it starts, so the round begins on the rebased branch (A11-116). Returns why the run cannot
 * start on it, or null when it can. A rebase that conflicts is a person's to resolve, so it ends the run needing one, and no round is started on it.
 */
async function rebaseBeforeRound(ctx: PoolContext, entry: Entry): Promise<string | null> {
  const { git, now, settings } = ctx;
  const record = entry.stackBase;
  const clone = record === undefined ? undefined : settings.clones[record.repo];
  if (record === undefined || clone === undefined) return null;
  const head = await remoteHead(git, clone, record.branch);
  if (!rebaseDue(record, head)) return roundHeldBy(record, head);
  const result = await rebaseOnto({ git, clone, worktree: worktreePath(settings.worktreeRoot, entry.ticket.key, record.repo), own: entry.ticket.branch, base: record });
  update(ctx, (queue) => recordStackBase(queue, entry.ticket.key, afterRebase(stackBaseIn(queue, entry.ticket.key, record), head, result, now())));
  return result.ok ? null : `Rebase onto ${record.key} ${result.reason}: a person resolves it`;
}

/**
 * The plan files the tracker holds for a ticket, downloaded to a folder of their own so a plan's name never reaches the ticket's brief. None when this
 * machine names no plan. Throws when the tracker refuses the download, which is the failure a run's plan reports as its own (A11-125).
 */
async function planFiles(ctx: PoolContext, ticket: Ticket): Promise<readonly string[]> {
  const { settings, source } = ctx;
  if (settings.plan === null) return [];
  const dir = join(ticketDir(settings, ticket.key), "paths");
  mkdirSync(dir, { recursive: true });
  return source.download(ticket, dir);
}

/** The repository-prefixed paths a ticket's plan files declare in their `## Paths` sections, each once. A file that is not a plan, or is too large, declares none. */
function pathsIn(files: readonly string[], plan: string | null): string[] {
  if (plan === null) return [];
  const pattern = new RegExp(plan);
  const paths: string[] = [];
  for (const file of files) {
    if (!pattern.test(basename(file)) || statSync(file).size > PLAN_FILE_BYTES) continue;
    for (const path of parsePaths(readFileSync(file, "utf8"))) {
      if (!paths.includes(path)) paths.push(path);
    }
  }
  return paths;
}

/**
 * Read the paths each queued run's plan declares, and record them on the runs. A plan the tracker refuses to give is recorded as that run's failure,
 * and each other plan is read as it would be: one ticket's plan does not hold the others, since a run whose plan is unread is never started, so a
 * failing one is not started beside a run it may overlap (A11-125). It is asked again on the next pass.
 */
async function readPaths(ctx: PoolContext, entries: readonly Entry[]): Promise<void> {
  if (entries.length === 0) return;
  const found = new Map<string, readonly string[]>();
  const failed = new Map<string, string>();
  for (const { ticket } of entries) {
    let files: readonly string[];
    try {
      files = await planFiles(ctx, ticket);
    } catch (err) {
      failed.set(ticket.key, messageOf(err).split("\n")[0]);
      continue;
    }
    found.set(ticket.key, pathsIn(files, ctx.settings.plan));
  }
  update(ctx, (queue) => recordPathsFailure(recordPaths(queue, found), failed));
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
  // A batch is planned together only while this machine's planner plans batches: otherwise each of its tickets is planned alone.
  if (!batches) updateEach(ctx, store.get().entries.filter((e) => e.phase === "queued" && e.batch !== undefined), leaveBatch);
  const { load, cores } = (deps.load ?? (() => ({ load: loadavg()[0], cores: availableParallelism() })))();
  // A run queued again while this pass read the blockers or the paths, such as a batch's ticket whose order was just recorded, waits for the next pass's read.
  const starts = nextStarts(store.get(), load, cores).filter((entry) => entry.blockers !== undefined && !pathsUnread(entry));
  const begun = new Set<string>();
  // A host's own condition for starting work (`tickets.preflight`): while one fails, no ticket run starts and every queued one stays Queued, with the reason on the board.
  // Publishing and the new-ticket writer need none of it, so they go on.
  const mayStart = starts.length === 0 || ctx.settings.preflight.length === 0 || (await ctx.gate.check()).ok;
  for (const entry of mayStart ? starts : []) {
    if (begun.has(entry.ticket.key) || removing.has(entry.ticket.key) || rebasing.has(entry.ticket.key)) continue;
    const batch = entry.batch === undefined ? [entry] : starts.filter((e) => e.batch === entry.batch);
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

/** Start one run for one ticket, the rest of its batch, if it had one, being started already or waiting on a blocker. */
async function startOne(ctx: PoolContext, queued: Entry): Promise<void> {
  const { now } = ctx;
  if (queued.batch !== undefined) update(ctx, (queue) => leaveBatch(queue, queued.ticket.key));
  const { batch: _alone, ...entry } = queued;
  update(ctx, (queue) => markStarting(queue, entry.ticket.key, now()));
  try {
    if (isPlanning(ctx, entry) && await planReached(ctx, entry.ticket)) {
      // A plan reached the ticket since it was queued, such as one a person attached or an earlier attempt left: it is worked from that.
      update(ctx, (queue) => planDone(queue, entry.ticket.key, { unattended: false }));
      return;
    }
    const blocked = entry.review !== undefined && entry.stackBase !== undefined ? await rebaseBeforeRound(ctx, entry) : null;
    if (blocked !== null) {
      update(ctx, (queue) => finish(queue, entry.ticket.key, { kind: "needs-human", reason: blocked }, now()));
      return;
    }
    const { folder, dir, resume } = await prepare(ctx, entry);
    const { workspace, pane } = await start(ctx, entry, folder, dir, resume);
    if (stoppedWhileStarting(ctx, entry.ticket.key, workspace)) return;
    update(ctx, (queue) => markRunning(queue, entry.ticket.key, workspace, pane));
    if (!isPlanning(ctx, entry)) moveTicketToWorkingState(ctx, entry.ticket.key);
    await settleStart(ctx, runPlace(ctx, entry));
  } catch (err) {
    update(ctx, (queue) => finish(queue, entry.ticket.key, crashed(err), now()));
  }
}

/**
 * Start one planning run for the tickets of a batch that are ready, in queue order. A ticket whose plan reached it since it was queued is
 * worked from that plan, and leaves the batch. Fewer than two left are each planned alone. A start that fails, such as a tracker that cannot
 * be read for one ticket, crashes every ticket of the batch, and a retry plans each one alone.
 */
async function startBatch(ctx: PoolContext, batch: readonly Entry[]): Promise<void> {
  const { now } = ctx;
  updateEach(ctx, batch, (queue, key) => markStarting(queue, key, now()));
  try {
    const members: Entry[] = [];
    for (const entry of batch) {
      if (await planReached(ctx, entry.ticket)) update(ctx, (queue) => planDone(queue, entry.ticket.key, { unattended: false }));
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
    await settleStart(ctx, runPlace(ctx, lead));
  } catch (err) {
    updateEach(ctx, batch.filter(({ ticket }) => phaseOf(ctx, ticket.key) === "starting"), (queue, key) => finish(queue, key, crashed(err), now()));
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
  const { herdr, now, session, settings, store } = ctx;
  const queued = writerToStart(store.get());
  const writer = settings.writer;
  if (queued === undefined) return;
  update(ctx, (queue) => markWriterStarting(queue, queued.id, now()));
  try {
    if (writer === null) throw new Error("this machine names no tickets.writer");
    const model = queued.model ?? writer.model;
    const effort = queued.effort ?? writer.effort;
    const place = writerPlace(ctx, queued);
    clearRunDir(ctx, place.folder, place.dir);
    writeFileSync(join(place.dir, BRIEF_FILE), writerBriefText({ run: writer.run, request: queued.request, mode: queued.mode, form: queued.form, clones: settings.clones,
      dir: place.dir, pickTeam: pickTeamOf(settings.pick) }));
    writeFileSync(join(place.dir, WRITER_FILE), `${JSON.stringify({ mode: queued.mode, tools: WRITER_CREATE_TOOLS })}\n`);
    writeBoardRunFiles(ctx, place, { deny: [...settings.deny, ...PLANNING_DENY], readDirs: Object.values(settings.clones), model, writer: true });
    const tail = [writerPrompt(place.dir, queued.mode), ...workerFlags({ name: `writer-${queued.id}`, model, effort, addDirs: [place.dir] })];
    const { workspace, pane } = await startAgent(ctx, place, {}, tail, "the new-ticket run");
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

/**
 * Start the queued publish run: its brief, its mark for the hook naming the connectors only it may call, and its settings file, then its
 * agent, on the publish model and effort. A start that fails ends it failed, saying why, and its runs stay as they were.
 */
async function startPublish(ctx: PoolContext): Promise<void> {
  const { now, settings, store } = ctx;
  const queued = store.get().publish;
  const publisher = settings.publish;
  if (queued === undefined) return;
  update(ctx, (queue) => markPublishStarting(queue, now()));
  try {
    if (publisher === null) throw new Error("this machine names no tickets.publish");
    const place = publishPlace(ctx, queued);
    clearRunDir(ctx, place.folder, place.dir);
    rmSync(join(place.dir, PUBLISHED_FILE), { force: true });
    writeFileSync(join(place.dir, BRIEF_FILE), publishBriefText({ dir: place.dir, prs: queued.prs, run: publisher.run }));
    writeFileSync(join(place.dir, PUBLISH_FILE), `${JSON.stringify({ connectors: publisher.connectors })}\n`);
    writeBoardRunFiles(ctx, place, { deny: settings.deny, readDirs: [], model: publisher.model });
    const tail = [firstPrompt(place.dir), ...workerFlags({ name: `publish-${queued.id}`, model: publisher.model, effort: publisher.effort, addDirs: [place.dir] })];
    const { workspace, pane } = await startAgent(ctx, place, {}, tail, "the publish run");
    update(ctx, (queue) => markPublishRunning(queue, workspace, pane));
    await settleStart(ctx, place);
  } catch (err) {
    update(ctx, (queue) => publishFailed(queue, messageOf(err).split("\n")[0], now()));
  }
}

/**
 * The session's herdr server answers, starting it when it does not. Ticket mode's session is its own, so no unit keeps it running the way the
 * org's is kept: the first pool to need it starts it, and it outlives the pool, so workers survive a restart of the board.
 */
export async function ensureSession(ctx: PoolContext): Promise<void> {
  const { deps, herdr, session, settings, wait } = ctx;
  const run = (args: string[]) => herdr(args);
  if (readAgents(run, session) !== null) return;
  (deps.startServer ?? defaultStartServer)(settings.herdrSession);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await wait(250);
    if (readAgents(run, session) !== null) return;
  }
  throw new Error(`herdr's ${settings.herdrSession} session did not start; start it with: herdr --session ${settings.herdrSession} server`);
}
