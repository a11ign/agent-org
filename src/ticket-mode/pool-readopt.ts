// @ts-check
// module: what a pool does with the runs it finds live when it starts up, and with a run it marked crashed whose worker is still there (A11-240)
//
// HERDR DECIDES WHETHER A RUN IS LOST, WHATEVER PHASE THE QUEUE FILE HOLDS IT IN. A run caught `starting` has no workspace on record (`markRunning` records it only after the agent is open), but its herdr name is fixed before
// it opens anything (`runPlace`), so one listing finds it. A run herdr lists with a pane is ADOPTED: a `running` one carries on as it was, a `starting` one is marked running in the workspace herdr lists, and the ordinary
// watch takes over (its outcome file is read, and a workspace with no agent still ends after two listings). An adopted pane is sent no key and no second start (A11-78): it is never in `startedHere`. Its only prompt is the
// watch's resume of a run left idle at a prompt with no outcome (A11-279, `pool-resume.ts`). A run
// herdr does not list, or lists with its pane gone, is LOST IN A RESTART (unless it was `starting`, or `running` with no workspace yet: its agent never opened, so it is queued again as it was, `requeueOrLose`, A11-294), and goes back on the queue once when the board has no pull request on record for it (`loseInRestart`). `unknown` alone does not lose a run: it cannot tell a seat still
// starting from an ended one (`herdr-agents.ts`), only a pane that is gone can, and the watch ends one that never shows an agent.
//
// A RUN ALREADY MARKED CRASHED WHOSE PANE IS WORKING IS TAKEN BACK on the next watch pass (`readoptCrashed`). Only `working` counts: an idle or done pane beside a crashed run may be a worker that has finished.

import { readAgentsAsync, rootPaneOf, type ListedAgent } from "../herdr-agents.ts";
import { closeWorkspaceLater } from "./pool-close.ts";
import { type PoolContext } from "./pool-context.ts";
import { filedOf } from "./pool-board-runs.ts";
import { log, messageOf, publishPlace, runMembers, runPlace, update, updateEach, writerPlace } from "./pool-state.ts";
import { takeTicket } from "./pool-start.ts";
import { isParked } from "./board-view/pull-status-and-notes.ts";
import { isLive, type Entry } from "./queue/queue-entries-and-outcomes.ts";
import { markPublishRunning, publishFailed, unpark } from "./queue/queue-transitions.ts";
import { adoptCrashed, adoptStarting, loseInRestart, requeueStarting, agentNotOpened } from "./queue/queue-readopt.ts";
import { joined, markWriterRunning, writerEnded } from "./queue.ts";

/** Why a publish run or a new-ticket run herdr no longer has is failed. */
const RESTARTED = "the pool restarted while it was running";

/** The workspace herdr lists for a run and its root pane, or null when herdr lists the run with no workspace id (it always gives one, so this is only a listing that cannot be used). */
function seatOf(agent: ListedAgent): Readonly<{ workspace: string; pane: string }> | null {
  return agent.workspace === undefined ? null : { workspace: agent.workspace, pane: rootPaneOf(agent.workspace) };
}

/** {@link seatOf}, saying in the log what was not adopted when herdr lists the run with no workspace id. */
function seatOrLog(agent: ListedAgent, what: string): Readonly<{ workspace: string; pane: string }> | null {
  const seat = seatOf(agent);
  if (seat === null) log(`herdr lists ${agent.label} with no workspace id, so ${what} caught starting by the restart was not adopted`);
  return seat;
}

/** How long the start's listing waits for herdr, in ms: the cut the synchronous call had. The wait holds no loop. */
const LISTING_MS = 30_000;

/**
 * After a restart: every run the file holds as `starting` or `running` is looked up in herdr's listing by its name. One that herdr lists with a pane is adopted ({@link adoptRun}); one it does not list, or lists with
 * its pane gone, ended lost in a restart and is queued again once if the board has no pull request on record for it ({@link loseInRestart}); its worktree is kept either way. A parked run herdr no longer lists is unparked, keeping its
 * outcome. A publish run or a new-ticket run is adopted the same way when it was starting, and failed when herdr no longer has it. It reads herdr's listing and the queue file and nothing else: a run herdr lists is
 * adopted as it is, its pane sent no key, no prompt and no second start (A11-78).
 */
export async function reconcile(ctx: PoolContext): Promise<void> {
  const { herdrCall, session, store } = ctx;
  // Listed without holding the loop (A11-282): an instance reconciles with herdr at every start, and each unknown agent it lists is a pane read besides.
  const agents = await readAgentsAsync((args) => herdrCall(args, LISTING_MS), session);
  if (agents === null) return;
  const listed = new Map(agents.map((agent) => [agent.label, agent]));
  const withPane = (name: string): ListedAgent | undefined => {
    const agent = listed.get(name);
    return agent === undefined || agent.paneless === true ? undefined : agent;
  };
  const seen = new Set<string>();
  for (const entry of store.get().entries.filter(isLive)) {
    const { name } = runPlace(ctx, entry);
    if (seen.has(name)) continue;
    seen.add(name);
    const members = runMembers(ctx, entry);
    const agent = withPane(name);
    if (agent === undefined) requeueOrLose(ctx, members, listed.get(name));
    else if (entry.phase === "starting") adoptRun(ctx, members, agent);
  }
  for (const entry of store.get().entries.filter(isParked)) {
    if (!listed.has(runPlace(ctx, entry).name)) update(ctx, (queue) => unpark(queue, entry.ticket.key));
  }
  reconcilePublish(ctx, withPane, listed);
  reconcileWriters(ctx, withPane, listed);
}

/** A run herdr lists with a pane, caught `starting`: running in the workspace herdr lists, and then what its start was cut short of is done (the tracker move and claim). */
function adoptRun(ctx: PoolContext, members: readonly Entry[], agent: ListedAgent): void {
  const { now, store } = ctx;
  const seat = seatOrLog(agent, `the run of ${members.map(({ ticket }) => ticket.key).join(", ")}`);
  if (seat === null) return;
  updateEach(ctx, members, (queue, key) => adoptStarting(queue, key, seat.workspace, seat.pane, now()));
  for (const { ticket } of members) {
    const adopted = store.get().entries.find((e) => e.ticket.key === ticket.key);
    if (adopted?.phase === "running") takeBack(ctx, adopted);
  }
}

/** What a start does in the tracker once the agent is open, for a run adopted without having done it. A talk session starts none of it. Nothing waits on it: a failure goes to the log. */
function takeBack(ctx: PoolContext, entry: Entry): void {
  if (entry.talk === true) return;
  void takeTicket(ctx, entry).catch((err) => log(`${entry.ticket.key}: its ticket could not be taken for the run adopted after a restart (${messageOf(err)})`));
}

/** A run herdr does not list (or lists with its pane gone): requeued as it was when none of its tickets had an agent open (A11-294), lost in the restart when one had (every ticket of a batch's run is ended, and each is queued again by its own pull requests). */
function requeueOrLose(ctx: PoolContext, members: readonly Entry[], leftover: ListedAgent | undefined): void {
  closeLeftover(ctx, leftover);
  if (members.every(agentNotOpened)) updateEach(ctx, members, (queue, key) => requeueStarting(queue, key, ctx.now()));
  else updateEach(ctx, members, (queue, key) => loseInRestart(queue, key, ctx.now()));
}

/** A workspace herdr still lists with no pane is closed first, so the run queued again does not open a second under its name. */
function closeLeftover(ctx: PoolContext, leftover: ListedAgent | undefined): void {
  if (leftover?.workspace !== undefined) closeWorkspaceLater(ctx, leftover.workspace);
}

/** A publish run caught `starting` is adopted when herdr lists its pane, and one herdr no longer has fails. */
function reconcilePublish(ctx: PoolContext, withPane: (name: string) => ListedAgent | undefined, listed: ReadonlyMap<string, ListedAgent>): void {
  const { now, store } = ctx;
  const publish = store.get().publish;
  if (publish === undefined) return;
  const name = publishPlace(ctx, publish).name;
  const agent = withPane(name);
  if (publish.phase === "starting" && agent !== undefined) {
    const seat = seatOrLog(agent, "the publish run");
    if (seat === null) return;
    return update(ctx, (queue) => markPublishRunning(queue, seat.workspace, seat.pane));
  }
  if (publish.phase === "starting" || (publish.phase === "running" && !listed.has(name))) update(ctx, (queue) => publishFailed(queue, RESTARTED, now()));
}

/** Each new-ticket run caught `starting` is adopted when herdr lists its pane, and one herdr no longer has fails, with the tickets it filed. */
function reconcileWriters(ctx: PoolContext, withPane: (name: string) => ListedAgent | undefined, listed: ReadonlyMap<string, ListedAgent>): void {
  const { now, store } = ctx;
  for (const run of store.get().writers ?? []) {
    const name = writerPlace(ctx, run).name;
    const agent = withPane(name);
    if (run.phase === "starting" && agent !== undefined) {
      const seat = seatOrLog(agent, "the new-ticket run");
      if (seat !== null) update(ctx, (queue) => markWriterRunning(queue, run.id, seat.workspace, seat.pane));
      continue;
    }
    if (run.phase === "starting" || (run.phase === "running" && !listed.has(name))) {
      const filed = filedOf(ctx, run);
      update(ctx, (queue) => writerEnded(queue, run.id, { tickets: filed.tickets, failure: joined(RESTARTED, filed.problem) }, now()));
    }
  }
}

/** A finished run the board marked crashed that holds no workspace: the kind {@link readoptCrashed} looks for. */
const crashedWithoutPane = (entry: Entry): boolean => entry.phase === "finished" && entry.outcome?.kind === "crashed" && entry.workspace === undefined;

/**
 * Take back each run the board marked crashed whose herdr workspace is listed `working` (A11-240): the worker carried on, so the run is running again in that workspace and pane, with its outcome dropped, and the
 * card says it was marked crashed and found alive. A batch's run is taken back whole, every ticket marked crashed with it. A ticket the board had put back from the working state is moved there and claimed again.
 * `agents` is the listing the pass reads once. Any other status leaves a crashed run crashed.
 */
export function readoptCrashed(ctx: PoolContext, agents: readonly ListedAgent[]): void {
  const { now, store } = ctx;
  const working = new Map(agents.filter((agent) => agent.status === "working").map((agent) => [agent.label, agent]));
  if (working.size === 0) return;
  const taken = new Set<string>();
  for (const entry of store.get().entries.filter(crashedWithoutPane)) {
    const { name } = runPlace(ctx, entry);
    const agent = working.get(name);
    const seat = agent === undefined ? null : seatOf(agent);
    if (taken.has(name) || seat === null) continue;
    taken.add(name);
    const members = store.get().entries.filter((e) => crashedWithoutPane(e) && runPlace(ctx, e).name === name);
    updateEach(ctx, members, (queue, key) => adoptCrashed(queue, key, seat.workspace, seat.pane, now()));
    log(`${members.map(({ ticket }) => ticket.key).join(", ")}: marked crashed, but its worker is working in ${name}, so the run is running again`);
    for (const member of members.filter(({ movedFrom }) => movedFrom === undefined)) takeBack(ctx, store.get().entries.find((e) => e.ticket.key === member.ticket.key) ?? member);
  }
}
