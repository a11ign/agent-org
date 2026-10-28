// @ts-check
// module: the runs the board starts for its After-merge checks (A11-302) -- the verifier run of an `agent` check, the one-time migration pass, and the follow-up a failed check of the org's is filed with
//
// A VERIFIER RUN IS A WRITER RUN THAT FILES NO TICKET. The board has one kind of short, unattended run of its own (`WriterRun`: a brief, a mark for the hook, an outcome file, a time limit), so the verifier and the migration pass are
// two modes of it (`verify`, `migrate`) rather than a second copy of that machinery. They run on Sonnet with their own time limit (`after-merge/verify.ts`), are not counted as new-ticket requests, and are not listed as such.
//
// THE SWEEP QUEUES THEM, THE RUN CLOSES THE CHECK. `queueCheckRuns` runs at the end of each tracker refresh: it gives an `agent` check whose change is installed to a verifier run, settles a check whose run ended without a result, and gives
// a pass to the checks still on the retired session runner. A finished run closes its check through `POST /api/after-merge/<KEY>/<n>` (`route.ts`), the route a person's close uses, so one set of rules governs every close.
import { afterMergeRoute } from "./after-merge/route.ts";
import { closeCheck, decideFollowUp, followUpText, isUnmigrated, type CheckRecord, type ChecksFile } from "./after-merge/checks.ts";
import { applyMigration, giveToAgent, isCheckRun, MAX_BOARD_CHECK_RUNS, MAX_RUN_TRIES, migrationBriefSections, migrationRequest, MIGRATION_BATCH, unmigratedChecks, verifierBriefSections, verifierRequest, VERIFIER_EFFORT, VERIFIER_MODEL, type MigrationEntry, type VerifyOutcome } from "./after-merge/verify.ts";
import { afterMergeChecksPath, changeChecks, loadChecks } from "./after-merge/store.ts";
import { capabilityRequest, missingCapabilities, parkCheck, recordCapabilityRequest, routeParked } from "./after-merge/capability.ts";
import { awaitsWindow, reopenClosedTooSoon, scheduleWindows } from "./after-merge/window.ts";
import { closedNote } from "../herdr-agents.ts";
import { type PoolContext } from "./pool-context.ts";
import { forgetRun, log, messageOf, update, writerAgentRunning, writerPlace } from "./pool-state.ts";
import { endWriter } from "./pool-board-runs.ts";
import { parseWriterOutcome } from "./writer.ts";
import { dismissWriter, queueWriter, writerEnded } from "./queue.ts";
import { MAX_WRITER_RUNS, type WriterRun } from "./queue/queue-entries-and-outcomes.ts";
import { isTicketWriter } from "./queue/writer-modes.ts";
import { PLACES_KEPT_FOR_PEOPLE } from "./dependency-updates/request.ts";

/** The brief of a check run, read from the checks as they stand when it starts. THROWS when the checks it is for are gone or already settled, which fails the run with that reason. */
export function checkRunBrief(ctx: PoolContext, run: WriterRun, dir: string): string {
  const file = loadChecks(afterMergeChecksPath(ctx.settings.stateDir));
  const ids = run.checks ?? [];
  if (run.mode === "verify") {
    const check = file.checks[ids[0]];
    if (check === undefined || check.state !== "open") throw new Error(`the After-merge check ${ids[0]} is no longer open`);
    return verifierBriefSections(check, dir);
  }
  const waiting = ids.flatMap((id) => (file.checks[id] !== undefined && isUnmigrated(file.checks[id]) ? [file.checks[id]] : []));
  if (waiting.length === 0) throw new Error("none of this pass's After-merge checks waits for the migration any more");
  return migrationBriefSections(waiting, dir, ctx.now());
}

/** Close a check a verifier run decided, through the route a person's close uses. A refusal (the check was closed meanwhile) is logged and changes nothing. A `cannot-run-here` closes nothing: the check is parked on what it needs (A11-361). */
function closeVerified(ctx: PoolContext, id: string, verdict: VerifyOutcome): void {
  if (verdict.kind === "cannot-run-here") {
    changeChecks(afterMergeChecksPath(ctx.settings.stateDir), (file) => parkCheck(file, id, verdict.needs, verdict.evidence));
    return;
  }
  const [status, body] = afterMergeRoute({ stateDir: ctx.settings.stateDir, now: ctx.now }, "POST", `/api/after-merge/${id.replace("#", "/")}`, { result: verdict.kind, evidence: verdict.evidence, by: "agent" }) ?? [500, "no route"];
  if (status !== 200) log(`the verifier run for ${id} could not close it: ${JSON.stringify(body)}`);
}

/** Close a check run's workspace, and forget its run. */
function closeCheckRun(ctx: PoolContext, run: WriterRun): void {
  const { herdr, session } = ctx;
  const { name } = writerPlace(ctx, run);
  if (run.workspace) closedNote((args) => herdr(args), run.workspace, session);
  forgetRun(ctx, name);
}

/**
 * A check run's outcome, read once its agent is idle (A11-302). A verifier run's `passed`, `failed` or `superseded` closes its check, and its `cannot-run-here` parks it (A11-361); a migration pass's answers rewrite the checks it was given (`applyMigration`). An outcome the contract
 * refuses, or a run that could not decide (`needs-human`), ends the run failed with that reason: the sweep then tries the check again, or settles it without the run.
 */
export async function finishCheckRun(ctx: PoolContext, run: WriterRun, text: string): Promise<void> {
  const { finishing, now, settings } = ctx;
  finishing.add(run.id);
  try {
    const outcome = parseWriterOutcome(text, run.mode);
    if (typeof outcome === "string") return endWriter(ctx, run, outcome);
    if (outcome.kind === "needs-human") return endWriter(ctx, run, `it could not decide: ${outcome.reason}`);
    if (!writerAgentRunning(ctx, run.id)) return;
    if (outcome.kind === "verified") {
      const [id] = run.checks ?? [];
      if (id !== undefined) closeVerified(ctx, id, outcome.verdict);
    } else if (outcome.kind === "migrated") {
      changeChecks(afterMergeChecksPath(settings.stateDir), (file) => applyMigration(file, answered(run, outcome.entries), now()));
    } else {
      return endWriter(ctx, run, `it wrote ${outcome.kind}, which a check run cannot end on`);
    }
    closeCheckRun(ctx, run);
    update(ctx, (queue) => writerEnded(queue, run.id, { tickets: [] }, now()));
  } catch (err) {
    endWriter(ctx, run, messageOf(err).split("\n")[0]);
  } finally {
    finishing.delete(run.id);
  }
}

/** The entries of a migration pass that answer a check the pass was given: an entry for any other check is ignored, so a pass cannot rewrite what it was not asked. PURE. */
const answered = (run: WriterRun, entries: readonly MigrationEntry[]): MigrationEntry[] => entries.filter(({ id }) => run.checks?.includes(id) === true);

// --- QUEUEING ---

/** A run id no other run on the board holds: the prefix, the time and the first counter that is free. */
function freshId(ctx: PoolContext, prefix: string): string {
  const taken = new Set((ctx.store.get().writers ?? []).map(({ id }) => id));
  for (let counter = 0; ; counter += 1) {
    const id = `${prefix}${ctx.now().toString(36)}${counter}`;
    if (!taken.has(id)) return id;
  }
}

/** The unfinished check runs of the queue. */
const unfinishedCheckRuns = (ctx: PoolContext): WriterRun[] => (ctx.store.get().writers ?? []).filter((run) => isCheckRun(run.mode) && run.phase !== "finished");

/** Queue one check run, or log why not. Returns whether it was queued. */
function queueRun(ctx: PoolContext, run: Pick<WriterRun, "id" | "request" | "mode" | "checks">): boolean {
  try {
    update(ctx, (queue) => queueWriter(queue, { ...run, placement: "auto", form: {}, model: VERIFIER_MODEL, effort: VERIFIER_EFFORT }, ctx.now()));
    return true;
  } catch (err) {
    log(`the After-merge check run ${run.id} could not be queued: ${messageOf(err)}`);
    return false;
  }
}

/** What a verifier run that ended without closing its check is told as: its failure, or that it was gone. */
function endedWith(ctx: PoolContext, check: CheckRecord): string {
  const run = (ctx.store.get().writers ?? []).find((each) => each.id === check.verifier?.run);
  return run?.failure ?? (run === undefined ? "its run is no longer on the board" : "it wrote no result");
}

/** Whether the verifier run of `check` ended for the board's own reasons, which are no try of the check's: it never got an agent, an update stopped it, or the pool restarted under it. */
function boardEnded(ctx: PoolContext, check: CheckRecord): boolean {
  const run = (ctx.store.get().writers ?? []).find((each) => each.id === check.verifier?.run);
  return run !== undefined && (run.workspace === undefined || /^(stopped for the update|the pool restarted)/.test(run.failure ?? ""));
}

/** The file with the verifier of check `id` recorded as `verifier`: the run queued for it and the tries so far, or no run (`run: null`) once the one it had ended with no result, so another may be given the check. PURE. */
const withVerifier = (file: ChecksFile, id: string, verifier: CheckRecord["verifier"]): ChecksFile =>
  ({ checks: { ...file.checks, [id]: { ...file.checks[id], verifier } } });

/** A verifier run that ended with no result: the check is given to another run, and after {@link MAX_RUN_TRIES} runs it is closed failed, saying how the last ended. */
function settleEndedVerifiers(ctx: PoolContext, path: string): void {
  const live = (id: string): boolean => unfinishedCheckRuns(ctx).some((run) => run.id === id);
  const ended = Object.values(loadChecks(path).checks).filter((check) => check.state === "open" && check.runner === "agent" && check.verifier?.run != null && !live(check.verifier.run));
  for (const check of ended) {
    const tries = (check.verifier?.tries ?? 0) - (boardEnded(ctx, check) ? 1 : 0);
    if (tries < MAX_RUN_TRIES) changeChecks(path, (file) => withVerifier(file, check.id, { run: null, tries }));
    else changeChecks(path, (file) => closeResult({ ...file, checks: { ...file.checks, [check.id]: { ...file.checks[check.id], verifier: { run: check.verifier?.run ?? null, tries } } } }, check, endedWith(ctx, check), ctx.now()));
  }
}

/** The checks still on the retired runner: the migration pass that re-reads them, {@link MIGRATION_BATCH} at a time, or an agent once {@link MAX_RUN_TRIES} passes are spent. */
function queueMigration(ctx: PoolContext, path: string): void {
  const stale = unmigratedChecks(loadChecks(path));
  const inFlight = new Set(unfinishedCheckRuns(ctx).filter((run) => run.mode === "migrate").flatMap((run) => run.checks ?? []));
  const idle = stale.filter((check) => !inFlight.has(check.id));
  const spent = idle.filter((check) => (check.migrating?.tries ?? 0) >= MAX_RUN_TRIES).map(({ id }) => id);
  if (spent.length > 0) changeChecks(path, (file) => giveToAgent(file, spent, ctx.now()));
  const waiting = idle.filter((check) => (check.migrating?.tries ?? 0) < MAX_RUN_TRIES);
  for (let from = 0; from < waiting.length && unfinishedCheckRuns(ctx).length < MAX_BOARD_CHECK_RUNS; from += MIGRATION_BATCH) {
    const batch = waiting.slice(from, from + MIGRATION_BATCH).map(({ id }) => id);
    if (!queueRun(ctx, { id: freshId(ctx, "c"), request: migrationRequest(batch), mode: "migrate", checks: batch })) continue;
    changeChecks(path, (file) => ({ checks: { ...file.checks, ...Object.fromEntries(batch.flatMap((each) => (file.checks[each] === undefined ? [] : [[each, { ...file.checks[each], migrating: { tries: (file.checks[each].migrating?.tries ?? 0) + 1 } }]]))) } }));
  }
}

/** Whether a check is parked on a capability and stays so: no runner has it, or one has it and the check has used all its tries (a run there that cannot run it either must not be queued for ever). */
const waitsOnCapability = (check: CheckRecord): boolean => check.needs !== undefined && (check.needs.routedTo === undefined || (check.verifier?.tries ?? 0) >= MAX_RUN_TRIES);

/** The agent checks whose change is installed, whose window (if it has one) has ended, that wait on no capability no runner has and that no run holds are given to a verifier run each. */
function queueVerifiers(ctx: PoolContext, path: string, installed: (check: CheckRecord) => boolean): void {
  const ready = Object.values(loadChecks(path).checks).filter((check) => check.state === "open" && check.runner === "agent" && !isUnmigrated(check) && !waitsOnCapability(check) && !awaitsWindow(check, ctx.now())
    && (check.verifier?.run ?? null) === null && installed(check));
  for (const check of ready) {
    if (unfinishedCheckRuns(ctx).length >= MAX_BOARD_CHECK_RUNS) return;
    const id = freshId(ctx, "c");
    if (queueRun(ctx, { id, request: verifierRequest(check), mode: "verify", checks: [check.id] })) changeChecks(path, (file) => withVerifier(file, check.id, { run: id, tries: (check.verifier?.tries ?? 0) + 1 }));
  }
}

/** The file with the checks closed failed before their window could end opened again, the checks parked on a capability routed to a runner that has it, and each check with a delay due that long after its change is installed. PURE. */
const scheduled = (file: ChecksFile, installed: (check: CheckRecord) => boolean, now: number): ChecksFile => scheduleWindows(routeParked(reopenClosedTooSoon(file)), installed, now);

/**
 * One pass over the checks the board runs by agents (A11-302). `installed` says whether a check's change is in a release installed on this host: an `agent` check is given to a verifier run only then. A check whose run ended with no result is
 * given to another, and after {@link MAX_RUN_TRIES} runs is closed failed, saying how the last ended, which files a follow-up like any failure. The checks still on the retired session runner are given to a migration pass, and after
 * {@link MAX_RUN_TRIES} passes to an agent. At most {@link MAX_BOARD_CHECK_RUNS} check runs are unfinished at once.
 *
 * A check about a delay after release is scheduled first (A11-361): it is due that long after its change is installed, and is given to no run before (`window.ts`); a check closed failed before its window could end is opened again and
 * scheduled; a check parked on what this host lacks is routed to a runner that has it.
 */
export function queueCheckRuns(ctx: PoolContext, installed: (check: CheckRecord) => boolean): void {
  const path = afterMergeChecksPath(ctx.settings.stateDir);
  changeChecks(path, (file) => scheduled(file, installed, ctx.now()));
  settleEndedVerifiers(ctx, path);
  queueMigration(ctx, path);
  queueVerifiers(ctx, path, installed);
  dismissOldCheckRuns(ctx);
}

/** How long a finished check run stays on the queue before the sweep dismisses it: its result is on its check, and the board keeps no list of them. */
export const CHECK_RUN_KEPT_MS = 24 * 60 * 60_000;

/** Dismiss the finished check runs kept for {@link CHECK_RUN_KEPT_MS} that no open check still reads its ending from. */
function dismissOldCheckRuns(ctx: PoolContext): void {
  const wanted = new Set(Object.values(loadChecks(afterMergeChecksPath(ctx.settings.stateDir)).checks).flatMap((check) => (check.state === "open" && check.verifier?.run != null ? [check.verifier.run] : [])));
  const old = (ctx.store.get().writers ?? []).filter((run) => isCheckRun(run.mode) && run.phase === "finished" && ctx.now() - (run.finishedAt ?? ctx.now()) > CHECK_RUN_KEPT_MS && !wanted.has(run.id));
  for (const run of old) update(ctx, (queue) => dismissWriter(queue, run.id));
}

/** The file with `check` closed failed by the board, with `why` as its evidence. PURE. */
function closeResult(file: ChecksFile, check: CheckRecord, why: string, now: number): ChecksFile {
  const closed = closeCheck(file, check.id, { result: "failed", evidence: `the verifier run ended without a result after ${check.verifier?.tries ?? 0} tries: ${why}`.slice(0, 300), by: "board" }, now);
  return closed.ok ? closed.file : file;
}

/** How many new-ticket requests are unfinished: the places the follow-ups share with the people's requests. */
const unfinishedTicketRequests = (ctx: PoolContext): number => (ctx.store.get().writers ?? []).filter((run) => isTicketWriter(run) && run.phase !== "finished").length;

/**
 * File the follow-up of each failed check of the org's whose follow-up is undecided (A11-302): the board is the runner, so it decides, as a person did on the page. A follow-up is a quick ticket-writer request with the text a person's would have
 * (`followUpText`); the check records the request that was queued. A machine with no `tickets.writer` files none, and says so once; the check stays failed with its follow-up undecided on the ticket's Run detail.
 */
export function fileFollowUps(ctx: PoolContext, said: Set<string>): void {
  const path = afterMergeChecksPath(ctx.settings.stateDir);
  const { settings, now } = ctx;
  const failed = Object.values(loadChecks(path).checks).filter((check) => check.state === "failed" && check.followUp === undefined && (check.closedBy === "board" || check.closedBy === "agent"));
  for (const check of failed) {
    if (unfinishedTicketRequests(ctx) >= MAX_WRITER_RUNS - PLACES_KEPT_FOR_PEOPLE) return;
    if (settings.writer === null) {
      if (!said.has(check.id)) log(`${check.key}: its After-merge check ${check.id} failed, and this machine names no tickets.writer to file its follow-up`);
      said.add(check.id);
      continue;
    }
    const id = freshId(ctx, "f");
    try {
      update(ctx, (queue) => queueWriter(queue, { id, request: followUpText(check), mode: "quick", placement: "auto", form: {}, model: settings.writer!.model, effort: settings.writer!.effort }, now()));
    } catch (err) {
      if (!said.has(`${check.id}:queue`)) log(`${check.key}: the follow-up of ${check.id} could not be queued, and is tried again at the next refresh: ${messageOf(err)}`);
      said.add(`${check.id}:queue`);
      continue;
    }
    changeChecks(path, (file) => {
      const decided = decideFollowUp(file, check.id, id);
      return decided.ok ? decided.file : file;
    });
  }
}

/**
 * File the one ticket of each capability a check could not run for (A11-361): a verifier run ended `cannot-run-here` naming what this host lacks, and no runner has it. The ticket is a quick ticket-writer request, filed once for the capability
 * however many checks need it; every check parked on it records the request, so the next sweep files nothing more. A machine with no `tickets.writer` files none, and says so once; the checks stay parked.
 */
export function fileCapabilityRequests(ctx: PoolContext, said: Set<string>): void {
  const path = afterMergeChecksPath(ctx.settings.stateDir);
  const { settings, now } = ctx;
  for (const [capability, checks] of missingCapabilities(loadChecks(path))) {
    if (unfinishedTicketRequests(ctx) >= MAX_WRITER_RUNS - PLACES_KEPT_FOR_PEOPLE) return;
    if (settings.writer === null) {
      if (!said.has(capability)) log(`${checks.map(({ id }) => id).join(", ")}: cannot run on this host for want of ${capability}, and this machine names no tickets.writer to file the ticket for it`);
      said.add(capability);
      continue;
    }
    const id = freshId(ctx, "f");
    try {
      update(ctx, (queue) => queueWriter(queue, { id, request: capabilityRequest(capability, checks), mode: "quick", placement: "auto", form: {}, model: settings.writer!.model, effort: settings.writer!.effort }, now()));
    } catch (err) {
      if (!said.has(`${capability}:queue`)) log(`the ticket for the missing ${capability} could not be queued, and is tried again at the next refresh: ${messageOf(err)}`);
      said.add(`${capability}:queue`);
      continue;
    }
    changeChecks(path, (file) => recordCapabilityRequest(file, capability, id));
  }
}
