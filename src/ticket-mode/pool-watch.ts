// @ts-check
// module: watching the runs -- each run's status from herdr, what its outcome settles, and the tick that drives a pass

import { herdrReason, readAgents } from "../herdr-agents.ts";
import { log, missedAgain, publishPlace, runMembers, runPlace, sameRun, update, updateEach, writerPlace } from "./pool-state.ts";
import { close, end, settle } from "./pool-settle.ts";
import { type RunPlace, worktreesIn } from "./pool-paths.ts";
import { conflictRound, feedbackRound, finish, markResumed, observe, observePublish, publishFailed, recordPullFiles, recordRepos, roundsLeft, unpark, watchWorking } from "./queue/approve.ts";
import { answerStartDialog, fill } from "./pool-start.ts";
import { join } from "node:path";
import { OUTCOME_FILE, PREVIOUS_OUTCOME_FILE, STOP_COUNT_FILE } from "./worker-files.ts";
import { existsSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { conflictLines, feedbackSince, parseOutcome, publishResult } from "./pool-outcome.ts";
import { isParked, isWatched, resumesOnConflict } from "./board-view/settled-by-pulls.ts";
import { type Background, BACKGROUND_GONE, BACKGROUND_GONE_MS, type Entry, isLive, proposedEdit, type WriterRun, type WrittenOutcome } from "./queue/declared-remains.ts";
import { paneBackgroundWork } from "./background-work.ts";
import { endPublish, endWriter, finishWriter } from "./pool-board-runs.ts";
import { observeWriter, writerFailed, writerResumed } from "./queue.ts";
import { openPulls } from "./board-view/view-ticket.ts";
import { type PullFeedback, readOwnLogin, readPullFeedback } from "../ticket-port/pull-feedback.ts";
import { reviewerLines } from "./pool-reviewers.ts";
import { type PoolContext } from "./pool-context.ts";

/** The longest a publish run may take. Posting a few messages takes a minute or two. */
const PUBLISH_LIMIT_MS = 30 * 60_000;

/** The longest a new-ticket run may spend writing its drafts, not counting the time a grill run waits on the person. */
const WRITER_LIMIT_MS = 30 * 60_000;

/** What the board tells a worker whose run is idle with no background work to wake it, once (A11-85). */
const BACKGROUND_GONE_PROMPT = "your background work is gone; check it and carry on";

/**
 * Claude session ids by workspace id. Keyed by WORKSPACE, not by agent name as `readAgentSessions` is: herdr names an agent only when its
 * `agent start` completes, and a start that a dialog held up past its wait never does (measured 2026-10-13, `name: null` on a running worker).
 */
function readSessionIds(ctx: PoolContext): Map<string, string> {
  const { herdr, settings } = ctx;
  try {
    const agents = JSON.parse(herdr(["--session", settings.herdrSession, "agent", "list"]))?.result?.agents;
    if (!Array.isArray(agents)) return new Map();
    return new Map(agents.filter((a) => a?.workspace_id && a?.agent_session?.value).map((a) => [String(a.workspace_id), String(a.agent_session.value)]));
  } catch {
    return new Map();
  }
}

/** Read each live and parked run's status once: record any live run that has ended, and resume any parked one a person has answered. */
function watch(ctx: PoolContext): void {
  const { claudeSessions, herdr, session } = ctx;
  const agents = readAgents((args) => herdr(args), session);
  if (agents === null) return;
  const status = new Map(agents.map((agent) => [agent.label, agent.status]));
  for (const [workspace, id] of readSessionIds(ctx)) claudeSessions.set(workspace, id);
  watchRunning(ctx, status);
  watchParked(ctx, status);
  watchPublish(ctx, status);
  watchWriters(ctx, status);
}

/**
 * Each running run's status, from one listing (label -> status): record its repositories, answer a start dialog, or end it. A batch's run is
 * watched once, through its first ticket: the others have no agent of their own.
 */
function watchRunning(ctx: PoolContext, status: ReadonlyMap<string, string>): void {
  const { misses, startedHere, store } = ctx;
  const watched = new Set<string>();
  for (const entry of store.get().entries.filter((e) => e.phase === "running")) {
    const key = entry.ticket.key;
    const { name, dir, folder } = runPlace(ctx, entry);
    if (watched.has(name)) continue;
    watched.add(name);
    const seen = status.get(name);
    if (seen === undefined || seen === "unknown") {
      if (missedAgain(ctx, name)) end(ctx, entry, { kind: "crashed", reason: seen === undefined ? "its herdr workspace is gone" : "herdr finds no agent in its workspace" });
      continue;
    }
    misses.delete(name);
    if (["working", "idle", "done"].includes(seen)) startedHere.delete(name);
    const repos = worktreesIn(folder);
    if (repos.join("\n") !== entry.repos.join("\n")) update(ctx, (queue) => recordRepos(queue, key, repos));
    if (!["working", "idle", "done"].includes(seen) && answerStartDialog(ctx, runPlace(ctx, entry))) continue;
    updateEach(ctx, runMembers(ctx, entry), (queue, member) => observe(queue, member, seen));
    const current = store.get().entries.find((e) => e.ticket.key === key) ?? entry;
    const outcomePath = join(dir, OUTCOME_FILE);
    if ((seen === "idle" || seen === "done") && existsSync(outcomePath)) {
      settle(ctx, current, parseOutcome(readFileSync(outcomePath, "utf8")));
      // A run still running after its outcome was read wrote `working`: its idle clock runs, and may mark it stalled.
      if (sameRun(ctx, current)) watchStall(ctx, current, seen);
    } else if (seen === "working") watchStall(ctx, current, seen);
    else if (seen === "done" || (seen === "idle" && current.seenWorking === true)) end(ctx, current, { kind: "no-outcome" });
  }
}

/**
 * Each parked run's status, from the same listing: one whose agent works again resumes, one that wrote a new outcome has ended again, and one
 * whose workspace is gone is unparked.
 */
function watchParked(ctx: PoolContext, status: ReadonlyMap<string, string>): void {
  const { misses, store } = ctx;
  const watched = new Set<string>();
  for (const entry of store.get().entries.filter(isParked)) {
    const { name } = runPlace(ctx, entry);
    if (watched.has(name)) continue;
    watched.add(name);
    const seen = status.get(name);
    if (seen === undefined) {
      if (missedAgain(ctx, name)) {
        misses.delete(name);
        updateEach(ctx, runMembers(ctx, entry), unpark);
      }
      continue;
    }
    misses.delete(name);
    const fresh = newOutcome(ctx, entry);
    if (seen === "working") {
      if (fresh === null) resume(ctx, entry);
      else markLive(ctx, entry);
    }
    else if (fresh !== null && (seen === "idle" || seen === "done")) {
      markLive(ctx, entry);
      settle(ctx, store.get().entries.find((e) => e.ticket.key === entry.ticket.key) ?? entry, fresh);
    }
  }
}

/**
 * The outcome a parked run's worker wrote after the run parked, or null. A file written before then, or one that says what the run parked on,
 * is the old outcome: the run parked on it.
 */
function newOutcome(ctx: PoolContext, entry: Entry): WrittenOutcome | null {
  const path = join(runPlace(ctx, entry).dir, OUTCOME_FILE);
  if (!existsSync(path) || statSync(path).mtimeMs <= (entry.finishedAt ?? 0)) return null;
  const outcome = parseOutcome(readFileSync(path, "utf8"));
  // A proposed edit is stored with the ticket's text the board read: the file never holds that, so it is set aside for the comparison (A11-91).
  const edit = proposedEdit(entry);
  const stored = edit === undefined ? entry.outcome : { ...entry.outcome, edit: { ...edit, base: undefined } };
  return JSON.stringify(outcome) === JSON.stringify(stored) ? null : outcome;
}

/** A person answered a parked run: move its outcome aside, so the stop hook asks for a new one, and mark it live. */
function resume(ctx: PoolContext, entry: Entry): void {
  const { dir } = runPlace(ctx, entry);
  if (existsSync(join(dir, OUTCOME_FILE))) renameSync(join(dir, OUTCOME_FILE), join(dir, PREVIOUS_OUTCOME_FILE));
  markLive(ctx, entry);
}

/** Mark a parked run live again with a fresh stop count. An outcome file written since it parked stays: it is the run's new outcome. */
function markLive(ctx: PoolContext, entry: Entry): void {
  rmSync(join(runPlace(ctx, entry).dir, STOP_COUNT_FILE), { force: true });
  updateEach(ctx, runMembers(ctx, entry), markResumed);
}

/** Move a working run's idle clock on `seen`, and log once when the run is first marked stalled. Nothing is ended and no key is sent. */
function watchStall(ctx: PoolContext, entry: Entry, seen: string): void {
  const { now, settings, stallMs, store } = ctx;
  const before = store.get().entries.find((e) => e.ticket.key === entry.ticket.key)?.working;
  const wasResumed = before?.resumed === true;
  const background = seen === "working" ? null : paneBackground(ctx, entry);
  updateEach(ctx, runMembers(ctx, entry), (queue, member) => watchWorking(queue, member, seen, now(), stallMs, background));
  const note = store.get().entries.find((e) => e.ticket.key === entry.ticket.key)?.working;
  if (before?.stalled !== true && note?.stalled === true) {
    const who = entry.batch ?? entry.ticket.key;
    log(note.stallReason === BACKGROUND_GONE
      ? `${who} wrote working with no background work running for ${BACKGROUND_GONE_MS / 60_000} minutes, so nothing will wake it: marked stalled, and told once to check its background work: ${note.reason}`
      : `${who} has been idle for ${settings.stallMinutes} minutes or more since it wrote working, with no newer outcome: ${note.reason}`);
  }
  if (!wasResumed && note?.resumed === true) promptBackgroundGone(ctx, entry);
}

/**
 * The background work a run's pane shows, as the board's {@link Background}: `live` when its status line counts a shell or a Monitor, `none` when
 * it counts neither, and null when herdr cannot read the pane, so the thirty-minute rule decides alone.
 */
function paneBackground(ctx: PoolContext, entry: Entry): Background {
  const { herdr, settings } = ctx;
  if (entry.pane === undefined) return null;
  try {
    const counts = paneBackgroundWork(herdr(["--session", settings.herdrSession, "pane", "read", entry.pane, "--source", "visible", "--lines", "6"]));
    return counts.shells + counts.monitors > 0 ? "live" : "none";
  } catch {
    return null;
  }
}

/** Tell a run's worker, once, that its background work is gone: it checks it and carries on. A refusal is said, and nothing else is sent. */
function promptBackgroundGone(ctx: PoolContext, entry: Entry): void {
  const { herdr, settings } = ctx;
  try {
    herdr(["--session", settings.herdrSession, "agent", "prompt", runPlace(ctx, entry).name, BACKGROUND_GONE_PROMPT]);
  } catch (err) {
    log(`${entry.batch ?? entry.ticket.key} could not be told its background work is gone: ${herdrReason(err)}`);
  }
}

/**
 * Each new-ticket run's status, from the same listing as the ticket runs'. A running one ends once its outcome file is there and its agent is idle or
 * done, when its drafts are read (`finishWriter`), and fails when its agent stops without one. A grill run waiting on a question is resumed once its
 * agent works again, and its earlier outcome is moved aside, as a parked ticket run's is.
 */
function watchWriters(ctx: PoolContext, status: ReadonlyMap<string, string>): void {
  const { finishing, misses, now, startedHere, store } = ctx;
  for (const run of store.get().writers ?? []) {
    if (run.phase !== "running" && run.phase !== "waiting") continue;
    const place = writerPlace(ctx, run);
    if (run.phase === "running" && now() - (run.startedAt ?? now()) > WRITER_LIMIT_MS) {
      endWriter(ctx, run, `it did not finish within ${WRITER_LIMIT_MS / 60_000} minutes`);
      continue;
    }
    const seen = status.get(place.name);
    if (seen === undefined || seen === "unknown") {
      if (missedAgain(ctx, place.name)) endWriter(ctx, run, seen === undefined ? "its herdr workspace is gone" : "herdr finds no agent in its workspace");
      continue;
    }
    misses.delete(place.name);
    if (["working", "idle", "done"].includes(seen)) startedHere.delete(place.name);
    if (!["working", "idle", "done"].includes(seen) && answerStartDialog(ctx, place)) continue;
    if (seen === "working") {
      if (run.phase === "waiting") resumeWriter(ctx, run, place);
      else update(ctx, (queue) => observeWriter(queue, run.id));
      continue;
    }
    if (run.phase === "waiting") continue;
    const outcomePath = join(place.dir, OUTCOME_FILE);
    if ((seen === "idle" || seen === "done") && existsSync(outcomePath)) {
      if (!finishing.has(run.id)) void finishWriter(ctx, run, place, readFileSync(outcomePath, "utf8"));
    } else if (seen === "done" || (seen === "idle" && run.seenWorking === true)) endWriter(ctx, run, "it stopped without writing an outcome");
  }
}

/** A waiting grill run's agent works again: its outcome, the question it asked, is moved aside, and the run is running. */
function resumeWriter(ctx: PoolContext, run: WriterRun, place: RunPlace): void {
  const { now } = ctx;
  if (existsSync(join(place.dir, OUTCOME_FILE))) renameSync(join(place.dir, OUTCOME_FILE), join(place.dir, PREVIOUS_OUTCOME_FILE));
  update(ctx, (queue) => writerResumed(queue, run.id, now()));
}

/** The publish run's status, from the same listing as the ticket runs': it ends once its outcome file is there and its agent is idle or done. */
function watchPublish(ctx: PoolContext, status: ReadonlyMap<string, string>): void {
  const { misses, now, startedHere, store } = ctx;
  const publish = store.get().publish;
  if (publish?.phase !== "running") return;
  const place = publishPlace(ctx, publish);
  // A publish run holds a slot, and no other can start while it is under way, so one that never ends must not hold them for ever.
  if (now() - (publish.startedAt ?? now()) > PUBLISH_LIMIT_MS) return endPublish(ctx, publish, { failure: `it did not finish within ${PUBLISH_LIMIT_MS / 60_000} minutes` });
  const seen = status.get(place.name);
  if (seen === undefined || seen === "unknown") {
    if (missedAgain(ctx, place.name)) endPublish(ctx, publish, { failure: seen === undefined ? "its herdr workspace is gone" : "herdr finds no agent in its workspace" });
    return;
  }
  misses.delete(place.name);
  if (["working", "idle", "done"].includes(seen)) startedHere.delete(place.name);
  if (!["working", "idle", "done"].includes(seen) && answerStartDialog(ctx, place)) return;
  update(ctx, (queue) => observePublish(queue, seen));
  const outcomePath = join(place.dir, OUTCOME_FILE);
  if ((seen === "idle" || seen === "done") && existsSync(outcomePath)) endPublish(ctx, publish, publishResult(readFileSync(outcomePath, "utf8"), place.dir));
  else if (seen === "done" || (seen === "idle" && store.get().publish?.seenWorking === true)) endPublish(ctx, publish, { failure: "it stopped without writing an outcome" });
}

/**
 * After a restart: a run the file says is live but herdr does not list is recorded as crashed; one still listed carries on. A run caught
 * between `starting` and `running` has no workspace on record, so it is crashed too: its worktree is kept and it can be retried. A parked run
 * herdr no longer lists is unparked, keeping its outcome. It reads herdr's listing and the queue file and nothing else: a run herdr lists is
 * adopted as it is, its pane sent no key, no prompt and no second start (A11-78).
 */
export function reconcile(ctx: PoolContext): void {
  const { herdr, now, session, store } = ctx;
  const agents = readAgents((args) => herdr(args), session);
  if (agents === null) return;
  const listed = new Set(agents.map((agent) => agent.label));
  for (const entry of store.get().entries.filter(isLive)) {
    if (entry.phase === "starting" || !listed.has(runPlace(ctx, entry).name)) {
      update(ctx, (queue) => finish(queue, entry.ticket.key, { kind: "crashed", reason: "the pool restarted while it was running" }, now()));
    }
  }
  for (const entry of store.get().entries.filter(isParked)) {
    if (!listed.has(runPlace(ctx, entry).name)) update(ctx, (queue) => unpark(queue, entry.ticket.key));
  }
  const publish = store.get().publish;
  const isUnlistedPublish = publish !== undefined && (publish.phase === "starting" || (publish.phase === "running" && !listed.has(publishPlace(ctx, publish).name)));
  if (isUnlistedPublish) {
    update(ctx, (queue) => publishFailed(queue, "the pool restarted while it was running", now()));
  }
  for (const run of store.get().writers ?? []) {
    const lost = run.phase === "starting" || ((run.phase === "running" || run.phase === "waiting") && !listed.has(writerPlace(ctx, run).name));
    if (lost) update(ctx, (queue) => writerFailed(queue, run.id, "the pool restarted while it was running", now()));
  }
}

/** One pass: watch the live runs, then fill free slots. Passes never overlap; a call during a pass runs one more pass after it. */
export async function tick(ctx: PoolContext): Promise<void> {
  const pass = ctx.tickState;
  if (pass.busy) {
    pass.again = true;
    return;
  }
  pass.busy = true;
  try {
    do {
      pass.again = false;
      watch(ctx);
      await fill(ctx);
    } while (pass.again);
  } finally {
    pass.busy = false;
  }
}

/**
 * Read the open pull requests of each finished run, and queue a review round for each run whose pull requests got new feedback since its last
 * round ended: a review, a comment or an inline comment by anyone but the workers' account, or a check that failed since then, or a pull request
 * that conflicts with its base. A watched run gets all of that. A parked run the board does not watch gets its conflict alone (A11-89,
 * {@link resumesOnConflict}): its workspace is closed, then a round is queued, so a question it parked on is not answered by a new comment.
 * Every finished run's read records the files its open pull requests change, which is its footprint while it is held (a draft too). A run whose
 * pull request could not be read is asked again next time, and one merged or closed since is left alone.
 */
export function watchFeedback(ctx: PoolContext): void {
  const { feedbackGh, gh, now, store } = ctx;
  const finished = store.get().entries.filter((entry) => entry.phase === "finished" && openPulls(entry).length > 0);
  if (finished.length === 0) return;
  ctx.ownLogin.value ??= readOwnLogin(gh);
  const self = ctx.ownLogin.value;
  if (self === null) return log("the GitHub account the workers use could not be read, so no pull request's feedback was read");
  let queued = false;
  for (const entry of finished) {
    const reads = openPulls(entry).map((pr) => ({ url: pr.url, read: readPullFeedback(pr.url, self, feedbackGh) }));
    const unread = reads.filter(({ read }) => read === null).map(({ url }) => url);
    if (unread.length > 0) {
      log(`${entry.ticket.key}: the feedback on ${unread.join(", ")} could not be read, so it was not checked; the next watch asks again`);
      continue;
    }
    const readable = reads.filter((pull): pull is { url: string; read: PullFeedback } => pull.read !== null);
    const open = readable.filter(({ read }) => read.state === "open");
    const partial = open.filter(({ read }) => !read.filesComplete).map(({ url }) => url);
    if (partial.length > 0) log(`${entry.ticket.key}: ${partial.join(", ")} changes more than the 100 files read, so the files past those read are unknown and hold nothing`);
    // The files GitHub did not give are unknown, not untouched: the empty name marks the list as cut short, and only the files listed hold (`footprintOf`).
    const files = Object.fromEntries(open.map(({ url, read }) => [url, read.filesComplete ? read.files : [...read.files, ""]]));
    // Written only when a file changed, so a watch that finds the same files does not rewrite the queue.
    if (JSON.stringify(files) !== JSON.stringify(entry.pullFiles ?? {})) update(ctx, (queue) => recordPullFiles(queue, entry.ticket.key, files));
    if (!resumesOnConflict(entry)) continue;
    if (isWatched(entry)) {
      // A reviewer's verdict is read by `reviewerLines`, which asks for a round only on requested changes; its reviews are not feedback here.
      const lines = [feedbackSince(readable, entry.finishedAt ?? 0), ...reviewerLines(ctx, entry, openPulls(entry).map((pr) => pr.url))]
        .filter((line): line is string => line !== null);
      if (lines.length === 0) continue;
      update(ctx, (queue) => feedbackRound(queue, entry.ticket.key, lines.join("\n"), now()));
      queued = true;
      continue;
    }
    if (resumeParked(ctx, entry, readable)) queued = true;
  }
  if (queued) void tick(ctx);
}

/**
 * Resume a parked run, one `watchFeedback` found a conflict on (A11-89): only a conflict wakes it, and only while the cap leaves a round. Its
 * workspace is closed first, because a second workspace would take the same herdr name (`queue.ts` `retry`). Refused, the run stays parked and
 * the next watch asks again. Returns whether a round was queued.
 */
function resumeParked(ctx: PoolContext, entry: Entry, readable: readonly { url: string; read: PullFeedback }[]): boolean {
  const { now } = ctx;
  const conflicts = conflictLines(readable);
  if (conflicts === null || !roundsLeft(entry)) return false;
  try {
    close(ctx, entry.ticket.key);
  } catch (err) {
    log(`${entry.ticket.key}: its workspace could not be closed, so the conflict round was not started (${err instanceof Error ? err.message : String(err)})`);
    return false;
  }
  update(ctx, (queue) => conflictRound(queue, entry.ticket.key, conflicts, now()));
  return true;
}
