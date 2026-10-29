// module: the sweep that reads what each ticket's pushes cost in CI, and acts on the budget (A11-261)
//
// EVERY `FEEDBACK_MS` (`watchFeedback` starts it), for every run that is starting, running, or finished with a pull request open, the code host is asked for the workflow runs on the ticket's branch in each repository the run works in
// (`readBranchCi`, contract 1.22). A run reads as soon as its worker pushes, before a pull request exists: that is the point, since the pushes that cost the most are a live worker's. What is read is merged into `Queue.ciSpend` and a completed run is
// never asked for again. The ticket's weighted total then decides a step (`budget.ts`): past the budget the worker is told once in its pane; at twice it, and at each further whole budget, the run is held (`hold.ts`): a live run is stopped and queued
// again, a finished one only has the reason on its next round. A code host without the read, or one that cannot be asked, changes nothing and is said once.
import { sendToAgentAsync } from "../pool-resume.ts";
import { closedOrGone } from "../pool-drain.ts";
import { forgetRun, log, runPlace, update } from "../pool-state.ts";
import { find, isLive, type Entry } from "../queue/queue-entries-and-outcomes.ts";
import { openPulls } from "../board-view/view-types-and-filters.ts";
import type { BranchCiRun } from "../../plugins/contracts/code-host.ts";
import type { PoolContext } from "../pool-context.ts";
import { budgetStep, holdReason, warnPrompt } from "./budget.ts";
import { requeueForCiHold, tellFinishedRun } from "./hold.ts";
import { mergedRuns, recordBudgetStep, recordRuns, runsOf, settledIds } from "./store.ts";
import { totalsOf } from "./weigh.ts";

/** The sweeps under way, so a slow one is not started a second time beside itself. */
const sweeping = new WeakSet<PoolContext>();

/** What a sweep has said already, by pool, so a code host that cannot be asked is said once and not every three minutes. */
const said = new WeakMap<PoolContext, Set<string>>();

/** Say `line` in the log, once for `topic`. */
function sayOnce(ctx: PoolContext, topic: string, line: string): void {
  const topics = said.get(ctx) ?? new Set<string>();
  said.set(ctx, topics);
  if (topics.has(topic)) return;
  topics.add(topic);
  log(line);
}

/** How long a finished run's CI is left unread once all of its workflow runs are settled: its pushes are done, and only a new push or a re-run changes what it cost. */
export const FINISHED_READ_MS = 15 * 60_000;

/** When each ticket's CI was last read IN FULL (every repository answered), by pool: kept in memory, since a restart reading everything once is cheap. A read that failed is not one: the next sweep asks again. */
const lastRead = new WeakMap<PoolContext, Map<string, number>>();

/** When each ticket's CI was last asked for, read or not, by pool: the order the tickets not yet read are tried in, so one that keeps failing does not take the first reads of the others. */
const lastTried = new WeakMap<PoolContext, Map<string, number>>();

/** Record `key` at `now` in the pool's `times`. */
function noteTime(times: WeakMap<PoolContext, Map<string, number>>, ctx: PoolContext, key: string, now: number): void {
  const held = times.get(ctx) ?? new Map<string, number>();
  times.set(ctx, held);
  held.set(key, now);
}

/**
 * Whether the sweep reads this run's CI now. A live run is read every sweep: its pushes are what cost. A finished run is read when it has not been read since the board started, while any of its workflow runs is not completed, and otherwise once every
 * {@link FINISHED_READ_MS}, so the code host is not asked about every quiet pull request every three minutes. It reads the queue and the clock and changes nothing.
 */
function dueToRead(ctx: PoolContext, entry: Entry): boolean {
  if (isLive(entry)) return true;
  const runs = runsOf(ctx.store.get(), entry.ticket.key);
  const read = lastRead.get(ctx)?.get(entry.ticket.key);
  return runs.some((run) => run.status !== "completed") || read === undefined || ctx.now() - read >= FINISHED_READ_MS;
}

/**
 * The most tickets read for the first time in one sweep. Every read is a synchronous `gh` call and a ticket's first holds one for each of its workflow runs, so a board with many tickets would otherwise hold its event loop for all of them at
 * once the first time it sweeps. The tickets over the limit are read by the next sweeps, and a ticket already read since the board started does not count.
 */
export const FIRST_READS_PER_SWEEP = 3;

/** The `owner/name` of each clone the board has resolved, by pool: a clone's remote does not change under a run. */
const resolved = new WeakMap<PoolContext, Map<string, string>>();

/** The repository (`owner/name`) a clone's `origin` names on the code host, or null when it cannot be read or names another host's. */
async function fullNameOf(ctx: PoolContext, repo: string): Promise<string | null> {
  if (repo.includes("/")) return repo;
  const known = resolved.get(ctx) ?? new Map<string, string>();
  resolved.set(ctx, known);
  const held = known.get(repo);
  if (held !== undefined) return held;
  const clone = ctx.settings.clones[repo];
  if (clone === undefined || ctx.codeHost.repositories === undefined) return null;
  try {
    const named = ctx.codeHost.repositories.repositoryOfRemote((await ctx.git(clone, ["remote", "get-url", "origin"])).trim());
    if (named !== null) known.set(repo, named.fullName);
    return named?.fullName ?? null;
  } catch (err) {
    void err; // a clone with no `origin` is not one the code host can be asked about; it is said below
    return null;
  }
}

/** Whether the sweep reads this run's CI: a run of its own (not a batch's planning run) with a branch and a repository, that is live, or finished with a pull request open. */
const readable = (entry: Entry): boolean =>
  entry.batch === undefined && (entry.repos?.length ?? 0) > 0 && (isLive(entry) || (entry.phase === "finished" && openPulls(entry).length > 0));

/** Read the workflow runs of one ticket's branch in each repository its run works in, and record what changed. A repository the code host cannot be asked about is said once, and leaves what is held as it is. */
async function readTicket(ctx: PoolContext, entry: Entry, readBranchCi: NonNullable<PoolContext["codeHost"]["readBranchCi"]>): Promise<void> {
  const { store, now } = ctx;
  const key = entry.ticket.key;
  const read: BranchCiRun[] = [];
  let complete = true;
  noteTime(lastTried, ctx, key, now());
  for (const repo of entry.repos ?? []) {
    const repository = await fullNameOf(ctx, repo);
    if (repository === null) {
      sayOnce(ctx, `${key} ${repo} clone`, `${key}: ${repo} names no repository on the code host, so its CI was not read`);
      complete = false;
      continue;
    }
    const runs = await readBranchCi(repository, entry.ticket.branch, settledIds(store.get(), key));
    if (runs === null) {
      sayOnce(ctx, `${key} ${repository} read`, `${key}: the workflow runs on ${entry.ticket.branch} in ${repository} could not be read, so its CI was not counted; the next sweep asks again`);
      complete = false;
    } else read.push(...runs);
  }
  // Only a read that every repository answered keeps a finished run's CI from being asked again for a while: a failed one is tried by the next sweep, as the log says.
  if (complete) noteTime(lastRead, ctx, key, now());
  const held = store.get().ciSpend?.[key]?.runs ?? {};
  // Written only when a run changed, so a sweep that finds the same runs does not rewrite the queue.
  if (JSON.stringify(mergedRuns(held, read)) !== JSON.stringify(held)) update(ctx, (queue) => recordRuns(queue, key, read, now()));
}

/** The weighted minutes the ticket's pushes have cost, from the runs the board holds. */
const weightedOf = (ctx: PoolContext, key: string): number => totalsOf(runsOf(ctx.store.get(), key)).weighted;

/** Tell a running worker, in its pane, that its ticket is past the budget. True when herdr took the prompt; a refusal is said and the next sweep tells it again. */
async function tellWorker(ctx: PoolContext, entry: Entry, weighted: number): Promise<boolean> {
  const refusal = await sendToAgentAsync(ctx, runPlace(ctx, entry), warnPrompt(weighted, ctx.settings.ciBudgetMinutes));
  if (refusal !== null) log(`${entry.ticket.key} could not be told its ticket is past its CI budget: ${refusal}`);
  return refusal === null;
}

/** Whether the board may act on this run's worker: it is running, on its own, with nobody talking to it. A run still starting is acted on once it runs. */
const actable = (entry: Entry): boolean => entry.phase === "running" && entry.batch === undefined && entry.talk !== true;

/** Whether the run's worker needs no telling or has now been told: a finished run has no pane, and a live one is told only while it is running. A run still starting is told by a later sweep. */
async function workerTold(ctx: PoolContext, entry: Entry, weighted: number): Promise<boolean> {
  if (!isLive(entry)) return true;
  return actable(entry) && await tellWorker(ctx, entry, weighted);
}

/** Warn the worker of a run past the budget, once. A finished run has no pane: its card shows the line in amber, and that is all. */
async function warn(ctx: PoolContext, entry: Entry, weighted: number): Promise<void> {
  const key = entry.ticket.key;
  if (!await workerTold(ctx, entry, weighted)) return;
  update(ctx, (queue) => recordBudgetStep(queue, key, { warned: weighted }));
  log(`${key}: its ticket's CI is ~${weighted} weighted minutes, past the budget of ${ctx.settings.ciBudgetMinutes}${isLive(entry) ? "; its worker was told" : ""}`);
}

/**
 * Hold a run at `multiple` times the budget. A running run is stopped and queued again, as the update drain stops one, with the session its agent had; nothing is queued beside an agent that would not close, and the next sweep tries again. A
 * finished run is not stopped. A run still starting, or one a person is talking to, is left for a later sweep.
 */
async function hold(ctx: PoolContext, entry: Entry, weighted: number, multiple: number): Promise<void> {
  const { claudeSessions, now, settings } = ctx;
  const key = entry.ticket.key;
  const reason = holdReason(weighted, settings.ciBudgetMinutes, multiple);
  const recorded = { warned: weighted, held: multiple };
  if (entry.phase === "finished") {
    update(ctx, (queue) => recordBudgetStep(tellFinishedRun(queue, key, reason), key, recorded));
    return log(`${key}: ${reason}; its next round carries the reason`);
  }
  if (!actable(entry) || !await closedOrGone(ctx, entry, "for its CI spend")) return;
  const session = entry.workspace === undefined ? undefined : claudeSessions.get(entry.workspace);
  forgetRun(ctx, runPlace(ctx, entry).name);
  update(ctx, (queue) => recordBudgetStep(requeueForCiHold(queue, key, reason, now(), session), key, recorded));
  log(`${key}: ${reason}; its run was stopped and queued again, and resumes its session on the board's next round`);
}

/** Act on the budget for one ticket's run, from the runs the board holds now. */
async function act(ctx: PoolContext, key: string): Promise<void> {
  const queue = ctx.store.get();
  const entry = find(queue, key);
  if (entry === undefined || !readable(entry)) return;
  const weighted = weightedOf(ctx, key);
  const step = budgetStep(weighted, ctx.settings.ciBudgetMinutes, queue.ciSpend?.[key]);
  if (step.kind === "warn") await warn(ctx, entry, weighted);
  else if (step.kind === "hold") await hold(ctx, entry, weighted, step.multiple);
}

/** The entries due to be read, with no more than {@link FIRST_READS_PER_SWEEP} of the tickets this board has not read in full since it started, the ones tried longest ago first. */
function firstReadsLimited(ctx: PoolContext, due: readonly Entry[]): Entry[] {
  const unread = (entry: Entry): boolean => lastRead.get(ctx)?.has(entry.ticket.key) !== true;
  const tried = (entry: Entry): number => lastTried.get(ctx)?.get(entry.ticket.key) ?? Number.NEGATIVE_INFINITY;
  const allowed = new Set(due.filter(unread).sort((a, b) => tried(a) - tried(b)).slice(0, FIRST_READS_PER_SWEEP));
  return due.filter((entry) => !unread(entry) || allowed.has(entry));
}

/**
 * One sweep: read the CI of every run that is starting, running, or finished with a pull request open, and act on the budget. Never throws, and never overlaps itself. The caller does not wait on it. A code host without
 * `readBranchCi` changes nothing.
 */
export async function watchCiSpend(ctx: PoolContext): Promise<void> {
  const { codeHost, store } = ctx;
  if (sweeping.has(ctx)) return;
  const { readBranchCi } = codeHost;
  if (readBranchCi === undefined) return sayOnce(ctx, "no-host", "the code host reads no branch's CI (contract 1.22), so what pushes cost is not counted and no budget is kept");
  sweeping.add(ctx);
  try {
    const runs = store.get().entries.filter(readable);
    for (const entry of firstReadsLimited(ctx, runs.filter((each) => dueToRead(ctx, each)))) await readTicket(ctx, entry, readBranchCi.bind(codeHost));
    for (const entry of runs) await act(ctx, entry.ticket.key);
  } catch (err) {
    log(`the CI of the runs could not be counted: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    sweeping.delete(ctx);
  }
}
