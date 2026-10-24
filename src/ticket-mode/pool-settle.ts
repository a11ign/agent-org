// @ts-check
// module: ending a run -- how it ended and what that does to its ticket, its plan, its proposed edit, and its ticket's state

import { clearMove, type Entry, type Outcome, type ProposedEdit, type WrittenOutcome } from "./queue/queue-entries-and-outcomes.ts";
import { type PlannedAgainst, recordStampedPlan } from "./queue/queue-ticket-text.ts";
import { join } from "node:path";
import { forgetRun, isPlanning, log, messageOf, runMembers, runPlace, sameRun, update, updateEach } from "./pool-state.ts";
import { FINDINGS_RETRIED_FILE, ORDER_FILE, OUTCOME_FILE, PLAN_DIR, QUESTION_FILE } from "./worker-files.ts";
import { existsSync, lstatSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { findingsMiss, findingsRefusal, retriedUrls } from "./blocker-findings-check.ts";
import { CLAIMS_GIVEN_FILE, CLAIMS_RETRIED_FILE, folderClaimMisses, folderClaimRefusal, folderClaimRetriedRefusal, type HeldClaim, parseClaimsGiven, planClaimPaths } from "./path-claims.ts";
import { type PlanStamp, stampedPlan, urlsNamedIn } from "./plan-stamp.ts";
import { type TicketRead } from "./ticket-read.ts";
import { batchPlanDone, finish, noteWorking, park, planDone, recordPullFiles, recordPullStates, unpark } from "./queue/queue-transitions.ts";
import { doneComment, PLAN_FILE_BYTES, QUESTION_CHARS } from "./pool-outcome.ts";
import { recordOutcomeHeads } from "./queue/queue-pull-heads.ts";
import { clearPartial } from "./queue/queue-next-step.ts";
import { type Ticket } from "./source.ts";
import { ticketDir } from "./ticket-paths.ts";
import { productDecisionIn } from "./open-decisions.ts";
import { closedNote } from "../herdr-agents.ts";
import { mergeWaits, type Order, parseOrder, unknownRepos } from "./batch-order.ts";
import { CONCLUDED, HANDED_BACK, RESULT_KINDS, pullsOf, type PullHead } from "./board-view/view-types-and-filters.ts";
import { countTokens, findTranscript } from "./pool-transcripts.ts";
import { isParked } from "./board-view/pull-status-and-notes.ts";
import { settledByPulls } from "./board-view/pull-settled.ts";
import { stepNamed } from "./board-view/plan-steps.ts";
import { herdrRefusal } from "./pool-herdr.ts";
import { type PoolContext } from "./pool-context.ts";
import type { PullFeedback } from "../plugins/contracts/code-host.ts";
import type { PullState } from "./source.ts";

/**
 * A run's agent wrote `working`: its reason becomes the run's latest note, for every ticket in the run, and the run carries on. The file's own
 * time says whether it is newer than the note recorded, so reading the same file on every tick changes nothing.
 */
function noteStillWorking(ctx: PoolContext, entry: Entry, reason: string): void {
  const { now } = ctx;
  const path = join(runPlace(ctx, entry).dir, OUTCOME_FILE);
  const at = existsSync(path) ? statSync(path).mtimeMs : now();
  updateEach(ctx, runMembers(ctx, entry), (queue, member) => noteWorking(queue, member, reason, at, now()));
}

/**
 * A run wrote its outcome: `working` is recorded as its note and the run carries on, a planning run's plan is attached, a `done` completes its ticket,
 * a proposed edit is recorded with the ticket's text, and any other outcome ends the run.
 */
export function settle(ctx: PoolContext, entry: Entry, outcome: WrittenOutcome): void {
  if (outcome.kind === "working") return noteStillWorking(ctx, entry, outcome.reason);
  if (outcome.kind === "reviewed") {
    if (entry.review === undefined) return end(ctx, entry, { kind: "needs-human", reason: "the worker wrote a reviewed outcome, but its run was not a review run" });
    return end(ctx, entry, { kind: "reviewed", prs: entry.review });
  }
  // An edit is recorded with the ticket's text before the run ends, so a proposal without that text is read first; with it, the run settles.
  if ("edit" in outcome && outcome.edit !== undefined && outcome.edit.base === undefined) return void proposeEdit(ctx, entry, outcome, outcome.edit).catch(settleFailed(entry));
  if (outcome.kind === "done") return void completeDone(ctx, entry, outcome).catch(settleFailed(entry));
  if (outcome.kind !== "planned") return end(ctx, entry, outcome);
  if (!isPlanning(ctx, entry)) return end(ctx, entry, { kind: "needs-human", reason: "the worker wrote a planned outcome, but its run was not a planning run" });
  // Nothing waits on the attach, so its own failure is caught here rather than left to stop the board.
  const attach = entry.batch === undefined ? attachPlan(ctx, entry) : attachBatch(ctx, entry);
  attach.catch((err) => log(`${entry.batch ?? entry.ticket.key}'s plan: ${messageOf(err)}`));
}

/**
 * The board's completion of a worker's `done` (A11-91): the ticket moves to its team's completed state and the reason and evidence are posted on it,
 * through the tracker's own `complete`. The ticket's record of its move is cleared once it is complete, so nothing puts it back. A refusal, by the
 * board's rules or by the tracker, ends the run for a person, and the ticket is left where it is. A review round's `done` is judged by its pull requests first (A11-173).
 */
async function completeDone(ctx: PoolContext, entry: Entry, outcome: Extract<Outcome, { kind: "done" }>): Promise<void> {
  const { attaching, source } = ctx;
  const key = entry.ticket.key;
  const { name } = runPlace(ctx, entry);
  const refusal = doneRefusal(ctx, entry);
  if (refusal !== null) return end(ctx, entry, { kind: "needs-human", reason: `${refusal}: ${outcome.reason}` });
  if (attaching.has(name)) return;
  attaching.add(name);
  try {
    const mergedStates = entry.review === undefined ? {} : await settleReviewDone(ctx, entry, outcome);
    if (mergedStates === null) return;
    const complete = source.complete?.bind(source);
    if (complete === undefined) return end(ctx, entry, { kind: "needs-human", reason: `this tracker cannot complete ${key}: ${outcome.reason}` });
    const note = await complete(key, doneComment(outcome));
    // Stopped, or stopped and started again, while the tracker was asked: the person's last word stands, and a newer run is not touched.
    if (!sameRun(ctx, entry)) return;
    if (note !== null) return end(ctx, entry, { kind: "needs-human", reason: `${key} was not completed (${note.trim()}): ${outcome.reason}` });
    update(ctx, (queue) => clearMove(queue, key));
    end(ctx, entry, outcome);
    // Recorded once the run is finished, which is when the card reads them: it says what completed the ticket without waiting for the next refresh.
    if (Object.keys(mergedStates).length > 0) update(ctx, (queue) => recordPullStates(queue, new Map([[key, mergedStates]])));
  } catch (err) {
    if (sameRun(ctx, entry)) end(ctx, entry, { kind: "needs-human", reason: `${key} could not be completed (${messageOf(err)}): ${outcome.reason}` });
  } finally {
    attaching.delete(name);
  }
}

/** What a review round's `done` does with its ticket, judged by the round's pull requests (A11-173): complete it now, leave it to the merge of an open pull request, or ask a person. PURE. */
function reviewDoneVerdict(entry: Entry, states: Readonly<Record<string, PullState>>): "complete" | "wait" | "ask" {
  const settled = settledByPulls({ ...entry, pullStates: states });
  if (settled === "completed") return "complete";
  return settled === "cancelled" ? "ask" : "wait";
}

/**
 * Settle a review round's `done` by its pull requests as the tracker reads them (A11-173). With every one merged or closed and one merged, the ticket is completed now: the pull requests'
 * states are returned, to be recorded once the run ends. With one still open the round ends as its ordinary `reviewed` result and the ticket completes when they merge, and the run's
 * declaration goes, since the worker has said nothing remains to build. With all closed unmerged nothing was built, and a person is asked. Returns null, the run ended, when it does not
 * complete, and also when the run was stopped meanwhile.
 */
async function settleReviewDone(ctx: PoolContext, entry: Entry, outcome: Extract<Outcome, { kind: "done" }>): Promise<Readonly<Record<string, PullState>> | null> {
  const key = entry.ticket.key;
  const states = (await ctx.source.pullStates?.([key]))?.get(key) ?? {};
  if (!sameRun(ctx, entry)) return null;
  const verdict = reviewDoneVerdict(entry, states);
  if (verdict === "complete") return states;
  if (verdict === "ask") end(ctx, entry, { kind: "needs-human", reason: `the worker wrote done in a review round, but its pull requests were closed without merging: ${outcome.reason}` });
  else {
    end(ctx, entry, { kind: "reviewed", prs: entry.review ?? [] });
    update(ctx, (queue) => clearPartial(queue, key));
  }
  return null;
}

/**
 * Record a worker's proposed edit to its ticket's text with the text the tracker holds now, which Apply checks the ticket still holds (A11-91), then
 * record the outcome it came with. The ticket is not changed. A planning or review run proposes none, and one whose ticket cannot be read is handed
 * to a person.
 */
async function proposeEdit(ctx: PoolContext, entry: Entry, outcome: Extract<Outcome, { kind: "checked" | "done" | "needs-human" }>, edit: ProposedEdit): Promise<void> {
  const { attaching, source } = ctx;
  const key = entry.ticket.key;
  const { name } = runPlace(ctx, entry);
  if (isPlanning(ctx, entry) || entry.review !== undefined) {
    return end(ctx, entry, { kind: "needs-human", reason: `${outcome.reason} (the worker proposed an edit to ${key}'s text from a ${isPlanning(ctx, entry) ? "planning" : "review"} run, which the board does not take)` });
  }
  if (attaching.has(name)) return;
  attaching.add(name);
  let base: Ticket | null = null;
  let failure = "";
  try {
    base = await source.read(key);
  } catch (err) {
    failure = messageOf(err);
  } finally {
    attaching.delete(name);
  }
  if (!sameRun(ctx, entry)) return;
  if (base === null) return end(ctx, entry, { kind: "needs-human", reason: `${outcome.reason} (the worker's proposed edit to ${key}'s text could not be recorded: ${failure || `Linear has no ticket ${key}`})` });
  // The guard is released above, and nothing awaits between here and settle's own checks: the completion or end it starts takes `attaching` itself,
  // before its first await, so a tick that sees this outcome again meanwhile finds the run already held.
  settle(ctx, entry, { ...outcome, edit: { ...edit, base: { title: base.title, description: base.description } } });
}

/** Why the board does not complete a ticket on its worker's `done`, or null when it may (A11-91): not a planning run, not a review round of a plan step with steps after it (A11-173), and no open sub-issues. A review round's `done` is judged by its pull requests ({@link settleReviewDone}). */
function doneRefusal(ctx: PoolContext, entry: Entry): string | null {
  if (isPlanning(ctx, entry)) return `the worker wrote done in a planning run, which completes no ticket`;
  const unfinished = entry.review !== undefined && entry.partial !== undefined ? stepNamed(entry.partial) : null;
  if (unfinished !== null && unfinished.step < unfinished.of) return `the worker wrote done in a review round of step ${unfinished.step} of ${unfinished.of}, which leaves the steps after it to do`;
  const children = entry.ticket.children ?? [];
  return children.length === 0 ? null : `${entry.ticket.key} has open sub-issues (${children.join(", ")}), which complete it, not its own done`;
}

/** The handler for a settle step that failed outside its own checks: said on the board's log, and the next pass finds the run as it was. */
const settleFailed = (entry: Entry) => (err: unknown): void => log(`${entry.batch ?? entry.ticket.key}: ${messageOf(err)}`);

/**
 * What a plan is checked against besides its files being plain markdown: the pull requests its brief listed and the addresses the stop hook's one automatic retry named for them (A11-207), and the paths other
 * tickets held when the brief was written and whether the retry for a folder claim was made (A11-212).
 */
type PlanChecks = Readonly<{ given?: readonly string[]; retried?: readonly string[]; claims?: readonly HeldClaim[]; claimsRetried?: boolean }>;

/**
 * The files a planning run left in `planDir` to attach, or why they cannot be. Only plain markdown files are taken: a planning run is
 * unattended, so a link in its folder could point the board at a secret it would then upload. A plan that claims a folder another queued or running ticket writes into is refused, naming the narrower paths (A11-212).
 */
function planFiles(planDir: string, { given = [], retried = [], claims = [], claimsRetried = false }: PlanChecks = {}): { files: string[] } | { refusal: string } {
  const names = existsSync(planDir) ? readdirSync(planDir).sort() : [];
  if (names.length === 0) return { refusal: `the planning run wrote no plan in ${planDir}` };
  const odd = names.find((name) => {
    const info = lstatSync(join(planDir, name));
    return !info.isFile() || !name.endsWith(".md") || info.size > PLAN_FILE_BYTES;
  });
  if (odd !== undefined) return { refusal: `the plan folder ${planDir} holds ${odd}, which is not a markdown file of 1 MB or less, so nothing was attached` };
  // A plan that records a product decision as made without a person is refused whole, and nothing is attached: the question is the person's (A11-134).
  for (const name of names) {
    const bullet = productDecisionIn(readFileSync(join(planDir, name), "utf8"));
    if (bullet !== null) return { refusal: `the plan records a product decision made without asking: ${bullet}` };
  }
  const miss = findingsMiss(names.map((name) => readFileSync(join(planDir, name), "utf8")), given);
  if (miss !== null) return { refusal: findingsRefusal(miss, given, retried) };
  const texts = names.map((name) => readFileSync(join(planDir, name), "utf8"));
  const folders = folderClaimMisses(texts.flatMap(planClaimPaths), claims);
  if (folders.length > 0) return { refusal: claimsRetried ? folderClaimRetriedRefusal(folders) : folderClaimRefusal(folders) };
  return { files: names.map((name) => join(planDir, name)) };
}

/**
 * The addresses the stop hook's one automatic retry named for the ticket `key` (A11-207), from the mark it left beside the run's outcome file in `runDir`. None when it made no retry, or the mark cannot be read:
 * the refusal is then the plain one.
 */
function retriedFor(runDir: string, key: string): readonly string[] {
  const path = join(runDir, FINDINGS_RETRIED_FILE);
  try {
    return existsSync(path) ? retriedUrls(readFileSync(path, "utf8"))[key] ?? [] : [];
  } catch {
    return [];
  }
}

/** The paths other tickets held when the run's brief was written (A11-212), from the list beside its outcome file in `runDir`. None when the file is missing or is not a list: a run briefed before it, or one that was not a planning run, is not checked. */
function claimsFor(runDir: string): readonly HeldClaim[] {
  try {
    const path = join(runDir, CLAIMS_GIVEN_FILE);
    return existsSync(path) ? parseClaimsGiven(readFileSync(path, "utf8")) ?? [] : [];
  } catch {
    return [];
  }
}

/** What the plan of the ticket `key`, written by the run whose files are in `runDir`, is checked against; `given` are the pull requests its entry was briefed with. */
const checksFor = (runDir: string, key: string, given: readonly string[] | undefined): PlanChecks =>
  ({ ...(given === undefined ? {} : { given }), retried: retriedFor(runDir, key), claims: claimsFor(runDir), claimsRetried: existsSync(join(runDir, CLAIMS_RETRIED_FILE)) });

/** The entry of the ticket `key`, as the queue has it now: the planning run's own, which holds the text it was briefed with. */
const entryOf = (ctx: PoolContext, key: string): Entry | undefined => ctx.store.get().entries.find((e) => e.ticket.key === key);

/**
 * Stamp the plan a planning run wrote with the text of the ticket it was briefed with (A11-167, ADR 0005): the file that matches the host file's `tickets.plan` gets a `## Planned against` section before its
 * `## Paths`. The board writes it, so the hash is the planning run's own read and not an agent's copy. Returns the stamp, for the run to keep. A run with no recorded read (one started before this) or a
 * machine with no plan pattern stamps nothing, and such a plan is never read as stale.
 */
function stampPlan(ctx: PoolContext, files: readonly string[], read: TicketRead | undefined): PlannedAgainst | null {
  const { settings } = ctx;
  if (settings.plan === null || read === undefined) return null;
  const pattern = new RegExp(settings.plan);
  const plan = files.find((file) => pattern.test(basename(file)));
  if (plan === undefined) return null;
  const stamp: PlanStamp = { updatedAt: read.updatedAt, hash: read.hash, files: files.map((file) => basename(file)), description: read.description };
  const text = stampedPlan(readFileSync(plan, "utf8"), stamp);
  // A plan the stamp would push past the size every reader skips beyond stays as it is, unstamped: it is never read as stale, rather than unreadable for its paths.
  if (Buffer.byteLength(text) > PLAN_FILE_BYTES) return null;
  writeFileSync(plan, text);
  return { ...stamp, named: urlsNamedIn(text) };
}

/**
 * Attach a planning run's files to its ticket, close its workspace, and queue the ticket again to be worked. A plan that cannot be attached ends
 * the run for a person, with its files kept in the ticket's `plan` folder.
 */
async function attachPlan(ctx: PoolContext, entry: Entry): Promise<void> {
  const { attaching, herdr, session, settings, source } = ctx;
  const key = entry.ticket.key;
  const { name } = runPlace(ctx, entry);
  if (attaching.has(name)) return;
  attaching.add(name);
  const planDir = join(ticketDir(settings, key), PLAN_DIR);
  try {
    // Not through `attachFiles`: its extra step would queue the ticket again only after this pass has filled its slots.
    const found = planFiles(planDir, checksFor(runPlace(ctx, entry).dir, key, entry.findingsGiven));
    if ("refusal" in found) return end(ctx, entry, { kind: "needs-human", reason: found.refusal });
    if (source.attachPlan === undefined) return end(ctx, entry, { kind: "needs-human", reason: `this tracker takes no plans: attach the files in ${planDir} by hand` });
    const stamp = stampPlan(ctx, found.files, entry.briefedAgainst);
    const note = await source.attachPlan(key, found.files, settings.planner?.state ?? null);
    if (note !== null) log(note);
    // Stopped, or stopped and started again, while its plan was attached: the person's last word stands, and a newer run is not touched.
    if (!sameRun(ctx, entry)) return;
    if (entry.workspace) closedNote((args) => herdr(args), entry.workspace, session);
    forgetRun(ctx, name);
    update(ctx, (queue) => planDone(stamp === null ? queue : recordStampedPlan(queue, key, stamp), key));
  } catch (err) {
    if (sameRun(ctx, entry)) end(ctx, entry, { kind: "needs-human", reason: `the plan could not be attached (${messageOf(err)}): its files are in ${planDir}` });
  } finally {
    attaching.delete(name);
  }
}

/** Attach the plan files in `dir` to the ticket `key`. Null once they are attached, or else the outcome that hands the ticket to a person. */
async function attachFiles(ctx: PoolContext, key: string, dir: string): Promise<Outcome | null> {
  const { settings, source } = ctx;
  const member = entryOf(ctx, key);
  const found = planFiles(dir, member === undefined ? {} : checksFor(runPlace(ctx, member).dir, key, member.findingsGiven));
  if ("refusal" in found) return { kind: "needs-human", reason: found.refusal };
  if (source.attachPlan === undefined) return { kind: "needs-human", reason: `this tracker takes no plans: attach the files in ${dir} by hand` };
  try {
    const stamp = stampPlan(ctx, found.files, member?.briefedAgainst);
    const note = await source.attachPlan(key, found.files, settings.planner?.state ?? null);
    if (note !== null) log(note);
    if (stamp !== null) update(ctx, (queue) => recordStampedPlan(queue, key, stamp));
    return null;
  } catch (err) {
    return { kind: "needs-human", reason: `the plan could not be attached (${messageOf(err)}): its files are in ${dir}` };
  }
}

/**
 * Attach each plan a batch's run left to its own ticket, and queue that ticket again to be worked. A ticket the run asked a question about, or
 * wrote nothing for, is handed back to a person and parked (A11-171): the run keeps its workspace and pane, which the person answers it in, and the tickets that were
 * planned leave the batch. The workspace is closed only when no ticket was handed back. The batch's order is recorded in the tracker first, so no ticket of the batch
 * starts before its blockers are there to be read. A person's answer settles the tickets still in the batch the same way, when the run writes `planned` again.
 */
async function attachBatch(ctx: PoolContext, entry: Entry): Promise<void> {
  const { attaching, herdr, now, session, settings } = ctx;
  const { name, dir } = runPlace(ctx, entry);
  if (attaching.has(name)) return;
  attaching.add(name);
  const members = runMembers(ctx, entry);
  const planDir = join(dir, PLAN_DIR);
  try {
    const handedBack = new Map<string, Outcome>();
    for (const { ticket: { key } } of members) {
      const outcome = await planOneOfBatch(ctx, key, join(planDir, key));
      if (outcome !== null) handedBack.set(key, outcome);
    }
    const order = await recordOrder(ctx, planDir, members.map(({ ticket }) => ticket.key));
    // A repository that is no clone of this machine is never stored: the ticket is planned with none and handed to a person, saying why.
    const misplaced = unknownRepos(order, Object.keys(settings.clones));
    // Stopped, or stopped and started again, while its plans were attached: the person's last word stands, and a newer run is not touched.
    const still = members.filter((member) => sameRun(ctx, member));
    if (still.length === 0) return;
    // A run that asked a person something stays open for the answer: its agent was told a person may answer it there.
    const parks = entry.workspace !== undefined && still.some(({ ticket: { key } }) => handedBack.has(key));
    if (entry.workspace && !parks) closedNote((args) => herdr(args), entry.workspace, session);
    forgetRun(ctx, name);
    const id = entry.workspace === undefined ? undefined : ctx.claudeSessions.get(entry.workspace);
    updateEach(ctx, still, (queue, key) => {
      const outcome = handedBack.get(key);
      const refused = misplaced.get(key);
      if (outcome !== undefined) return (parks ? park : finish)(queue, key, outcome, now(), id === undefined ? {} : { session: id });
      if (refused !== undefined) return finish(batchPlanDone(queue, key, null), key, { kind: "needs-human", reason: refused }, now());
      const place = order.get(key);
      return batchPlanDone(queue, key, place?.repo ?? null, mergeWaits(place));
    });
  } catch (err) {
    const [still] = members.filter((member) => sameRun(ctx, member));
    if (still !== undefined) end(ctx, still, { kind: "needs-human", reason: `the plans could not be attached (${messageOf(err)}): their files are in ${planDir}` });
  } finally {
    attaching.delete(name);
  }
}

/**
 * Attach one batch ticket's plan from its folder, `dir`. Null once it is attached, or else the outcome that hands the ticket to a person. The
 * unattended run made the folder and everything in it, so a link is never followed: it could point the board at a secret, which the board
 * would then upload or show.
 */
async function planOneOfBatch(ctx: PoolContext, key: string, dir: string): Promise<Outcome | null> {
  const nothing: Outcome = { kind: "needs-human", reason: `the planning run wrote nothing for ${key}: no plan and no ${QUESTION_FILE} in ${dir}` };
  if (!existsSync(dir)) return nothing;
  if (!lstatSync(dir).isDirectory()) return { kind: "needs-human", reason: `the planner left ${dir}, which is not a plain folder` };
  const question = join(dir, QUESTION_FILE);
  if (existsSync(question)) {
    if (!lstatSync(question).isFile()) return { kind: "needs-human", reason: `the planner left ${question}, which is not a plain file` };
    return { kind: "needs-human", reason: `the planner needs a person: ${readFileSync(question, "utf8").trim().slice(0, QUESTION_CHARS)}` };
  }
  return readdirSync(dir).length === 0 ? nothing : attachFiles(ctx, key, dir);
}

/**
 * The tickets the batch's run has a folder for under `planDir` that are on the board: those it was planned with, including the ones planned and gone from the batch since.
 * A folder that is no ticket of the board's is nothing the order may name.
 */
const plannedTickets = (ctx: PoolContext, planDir: string): string[] => (existsSync(planDir)
  ? readdirSync(planDir, { withFileTypes: true }).filter((item) => item.isDirectory() && entryOf(ctx, item.name) !== undefined).map((item) => item.name) : []);

/**
 * Read a batch's order from its plan folder and record it in the tracker: each of `keys`, the tickets settled now, blocked by the tickets of the batch it waits on. The order
 * names every ticket the batch was planned with, so it is read against those folders as well as `keys`: a run answered by a person settles only the tickets still in
 * the batch, and the tickets planned before it are not given their relations again (A11-171). An order that fails its checks records nothing and is logged, and so is a
 * relation the tracker refuses: the plans stand without them. Returns the order, empty when there is none to use.
 */
async function recordOrder(ctx: PoolContext, planDir: string, keys: readonly string[]): Promise<Order> {
  const { source } = ctx;
  const path = join(planDir, ORDER_FILE);
  if (!existsSync(path) || !lstatSync(path).isFile()) {
    log(`the planning run of ${keys.join(", ")} wrote no ${ORDER_FILE} as a plain file, so their order was not recorded`);
    return new Map();
  }
  const read = parseOrder(readFileSync(path, "utf8"), [...new Set([...keys, ...plannedTickets(ctx, planDir)])]);
  if ("refusal" in read) {
    log(`${path} was not used, so no order was recorded: ${read.refusal}`);
    return new Map();
  }
  const add = source.addBlockers?.bind(source);
  for (const [key, { after }] of read.order) {
    if (add === undefined || after.length === 0 || !keys.includes(key)) continue;
    try {
      await add(key, after);
    } catch (err) {
      log(`${after.join(", ")} could not be recorded as blocking ${key}: ${messageOf(err)}`);
    }
  }
  return read.order;
}

/**
 * Record how a run ended, for every ticket in it. One that hands its tickets back keeps its workspace (parked); any other has its workspace
 * closed, a `checked` or `done` one included ({@link CONCLUDED}): nobody answers a run that found nothing to do, so its finished agent is not left open.
 */
export function end(ctx: PoolContext, entry: Entry, outcome: Outcome): void {
  const { claudeSessions, herdr, now, session, transcripts } = ctx;
  // A concluded run never parks, whatever else a later change hands back: nobody would answer its agent.
  const parks = entry.workspace !== undefined && HANDED_BACK.has(outcome.kind) && !CONCLUDED.has(outcome.kind);
  if (entry.workspace && !parks) closedNote((args) => herdr(args), entry.workspace, session);
  const id = entry.workspace === undefined ? undefined : claudeSessions.get(entry.workspace);
  const tokens = countTokens(id === undefined ? null : findTranscript(transcripts, id));
  const { name } = runPlace(ctx, entry);
  const record = id === undefined ? {} : { session: id };
  // A batch's run spent its tokens once, so they are recorded on the ticket it was watched through, and not counted again on each of the rest.
  updateEach(ctx, runMembers(ctx, entry), (queue, key) => (parks ? park : finish)(queue, key, outcome, now(), key === entry.ticket.key ? { ...record, tokens } : record));
  recordPullsAtEnd(ctx, entry, outcome);
  // A run that is not handed back gives its ticket back now. A parked one keeps it In Progress while a person may answer it.
  if (!HANDED_BACK.has(outcome.kind)) for (const member of runMembers(ctx, entry)) void restoreAndLog(ctx, member.ticket.key);
  forgetRun(ctx, name);
}

/**
 * The files each open pull request changes, by URL, from the reads of them: a list GitHub cut short ends with an empty name, so only the files listed
 * hold (`footprintOf`). The watch and the end of a run both record it this way, so a run holds the same files either way (A11-125).
 */
export function pullFilesOf(open: readonly { url: string; read: PullFeedback }[]): Readonly<Record<string, readonly string[]>> {
  return Object.fromEntries(open.map(({ url, read }) => [url, read.filesComplete ? read.files : [...read.files, ""]]));
}

/**
 * What a read says of a head's review for readiness (A11-179), or undefined when the code host did not say: `approved` when the newest verdict on the head approves it and GitHub's review decision
 * is approved or needs none, `changes-requested` when either asks for changes, and `none` otherwise, which is also a branch whose decision still asks for a review. PURE.
 */
function reviewAtHead(read: PullFeedback): PullHead["review"] {
  if (read.verdictAtHead === undefined || read.reviewDecision === undefined) return undefined;
  if (read.reviewDecision === "changes-requested" || read.verdictAtHead === "changes-requested") return "changes-requested";
  return read.verdictAtHead === "approved" && (read.reviewDecision === "approved" || read.reviewDecision === null) ? "approved" : "none";
}

/**
 * The head of each open pull request that has one, with whether a reviewer approved it there, by URL, from the reads of them (A11-153), and what the read said of its readiness to merge at that head
 * (A11-179: its review, its red required checks and its required checks still running, each left out when the code host did not say). One that GitHub gave no head for is left out: nothing can be
 * compared with it.
 */
export function pullHeadsOf(open: readonly { url: string; read: PullFeedback }[]): Readonly<Record<string, PullHead>> {
  return Object.fromEntries(open.flatMap(({ url, read }) => {
    if (read.head === null) return [];
    const review = reviewAtHead(read);
    return [[url, { head: read.head, approved: read.approvedAtHead, ...(review === undefined ? {} : { review }), red: read.failing,
      ...(read.pendingRequired === undefined ? {} : { pending: read.pendingRequired }) }]];
  }));
}

/** The commit each open pull request is at, by URL, from the reads of them (A11-153): {@link pullHeadsOf} without the approval. */
export function headCommitsOf(open: readonly { url: string; read: PullFeedback }[]): Readonly<Record<string, string>> {
  return Object.fromEntries(Object.entries(pullHeadsOf(open)).map(([url, { head }]) => [url, head]));
}

/**
 * A run that ends with a pull request open is footprinted at once (A11-125): the files of its open pull requests are read as the watch reads them and
 * recorded, so a queued run that shares one with it waits from now, not from the next watch. The read and the record are one synchronous block, so no
 * start pass can fall between the run ending and its files being recorded. When a read fails, nothing is recorded: the run holds its repository until
 * a watch records the files (`overlapWait`). The same read records the head each open pull request is at as the run ends (`outcomeHeads`), which is what a
 * later push answers (A11-153). That is for a draft or ready pull request, and for a run that ends `needs-human`, which has no result: its pull requests are the
 * round's it continued. Only a draft or ready pull request's files are recorded, as before.
 */
function recordPullsAtEnd(ctx: PoolContext, entry: Entry, outcome: Outcome): void {
  const { codeHost, feedbackIgnores, ownLogin } = ctx;
  const key = entry.ticket.key;
  const isDraftOrReady = outcome.kind === "draft-pr" || outcome.kind === "ready-pr";
  // Only a run that is asking (`needs-human`) is answered by a push, so no other kind pays for a read of its pull requests.
  const pulls = isDraftOrReady || outcome.kind === "needs-human" ? pullsOf({ outcome, review: entry.review }) : [];
  if (pulls.length === 0) return;
  ownLogin.value ??= codeHost.readOwnLogin();
  const self = ownLogin.value;
  if (self === null) return;
  const reads = pulls.map(({ url }) => ({ url, read: codeHost.readPullFeedback(url, self, feedbackIgnores) }));
  const readable = reads.filter((pull): pull is { url: string; read: PullFeedback } => pull.read !== null);
  if (readable.length < reads.length) {
    log(`${key}: the files and heads of its pull requests could not be read, so its repository is held until the next watch reads them`);
    return;
  }
  const open = readable.filter(({ read }) => read.state === "open");
  update(ctx, (queue) => recordOutcomeHeads(isDraftOrReady ? recordPullFiles(queue, key, pullFilesOf(open)) : queue, key, headCommitsOf(open)));
}

/**
 * Put a ticket the board moved back in the state it came from, for a run that ended without a pull request. Only while the ticket is still in
 * the state the board moved it to: a person who has moved it since is left to it. Either way the record goes, once the tracker has answered.
 * Waits for the move that recorded it, which may still be on its way to the tracker. Throws, with the tracker's reason, when the tracker refuses,
 * and keeps the record, so the next pass tries again.
 */
export async function restoreWorkingState(ctx: PoolContext, key: string): Promise<void> {
  const { pendingMoves, source, store } = ctx;
  await pendingMoves.get(key);
  const entry = store.get().entries.find((e) => e.ticket.key === key);
  // A run that opened a pull request is never put back: the tracker's own integration takes its ticket from there. Nor is a review round, nor a
  // `done` run, whose ticket the board completed.
  const needsNoRecord = entry?.movedFrom === undefined || entry.review !== undefined || RESULT_KINDS.has(entry.outcome?.kind ?? "") || entry.outcome?.kind === "done";
  if (needsNoRecord) return;
  const restore = source.restoreState?.bind(source);
  if (restore !== undefined) {
    let note: string | null;
    try { note = await restore(key, entry.movedFrom); }
    catch (err) { throw new Error(`${key} could not be put back to ${entry.movedFrom.from}: ${messageOf(err)}`); }
    if (note !== null) log(note);
  }
  update(ctx, (queue) => clearMove(queue, key));
}

/**
 * Put back the tickets of finished runs that ended without a pull request and still hold the record of a move: a restore the tracker refused, or a
 * run a restart crashed. A handed-back run keeps its ticket In Progress while a person may still answer its agent, so it is left alone here, and
 * Dismiss or a later retry settles it.
 */
export async function restoreStranded(ctx: PoolContext): Promise<void> {
  const { store } = ctx;
  const stranded = store.get().entries.filter((e) => e.phase === "finished" && e.movedFrom !== undefined && !isParked(e) && !HANDED_BACK.has(e.outcome?.kind ?? "") && e.outcome?.kind !== "done");
  for (const { ticket } of stranded) await restoreAndLog(ctx, ticket.key);
}

/** {@link restoreWorkingState}, with a refusal written to the board's log: a caller that nothing waits on, and the next pass tries again. */
const restoreAndLog = (ctx: PoolContext, key: string): Promise<void> => restoreWorkingState(ctx, key).catch((err) => log(messageOf(err)));

/** Close a parked run's workspace. Its outcome and its worktrees stay. Throws with herdr's reason when herdr refuses, so the run stays parked. */
export function close(ctx: PoolContext, key: string): void {
  const { herdr, misses, settings, store } = ctx;
  const entry = store.get().entries.find((e) => e.ticket.key === key && isParked(e));
  if (entry?.workspace === undefined) return;
  try {
    herdr(["--session", settings.herdrSession, "workspace", "close", entry.workspace]);
  } catch (err) {
    throw new Error(`herdr could not close ${key}'s workspace (${herdrRefusal(err)})`);
  }
  misses.delete(runPlace(ctx, entry).name);
  updateEach(ctx, runMembers(ctx, entry), unpark);
}
