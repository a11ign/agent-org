// @ts-check
// module: a run's files, written before its agent starts -- its brief, its refusals and connectors, and its settings file

import { openPulls } from "./board-view/view-types-and-filters.ts";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { type Entry } from "./queue/queue-entries-and-outcomes.ts";
import { closedWorkOf } from "./closed-work-account.ts";
import { findingsOf, planFiles } from "./pool-ticket-text.ts";
import { bodyHash } from "./standoff-body-hash.ts";
import { standoffPlanBriefText } from "./standoff-brief.ts";
import { capPlanBriefText } from "./cap-brief.ts";
import { CAP_DECISION_FILE, CAP_PLANNER_FILE } from "./cap-files.ts";
import { isCapPlanner } from "./queue/queue-cap.ts";
import { logOf } from "./queue/run-log.ts";
import { STANDOFF_DECISION_FILE, STANDOFF_PLANNER_FILE, STANDOFF_ROUND_FILE } from "./standoff-files.ts";
import { ticketReadOf, type TicketRead } from "./ticket-read.ts";
import { findFolderSession, findTranscript } from "./pool-transcripts.ts";
import { ticketDir, ticketFolder } from "./ticket-paths.ts";
import { DEFAULT_KEYWORDS, type Ticket, type TrackerWriting } from "./source.ts";
import { batchPlanBriefText, type BatchTicket, BRIEF_FILE, briefText, CONNECTORS_FILE, DENY_FILE, FINDINGS_GIVEN_FILE, FINDINGS_RETRIED_FILE, OUTCOME_FILE, type ParentTicket, PLAN_DIR, planBriefText, PLANNING_DENY, PR_REVIEW_FILE, PR_REVIEW_LOG_FILE, PROTECTED_FILE, protectedPaths, PUBLISH_FILE, READY_FILE, REVIEW_FILE, reviewBriefText, STOP_COUNT_FILE, TALK_FILE, workerSettings, WORKING_STOP_FILE } from "./worker-files.ts";
import { join } from "node:path";
import { unclonedNames } from "./pool-org-repos.ts";
import { isPlanning, runChoice, runPlace, update } from "./pool-state.ts";
import { heldClaims } from "./board-view/overlap-hold.ts";
import { repoOf, stackedOn } from "./board-view/pull-status-and-notes.ts";
import { STACK_BASE_FILE } from "./stack-rebase.ts";
import { pluginProblems } from "./plugins.ts";
import { hostFactsOf } from "./plugin-contract.ts";
import { type RunPlace } from "./pool-paths.ts";
import { type DenyRule } from "./settings.ts";
import { type PoolContext } from "./pool-context.ts";
import { openedPullsOf } from "./opened-pulls.ts";
import { pluginCopiesOf } from "./pool-pin.ts";
import { recordPluginCopy } from "./queue/queue-pins.ts";
import { resumesStoppedSession } from "./queue/queue-blocker-wait.ts";
import { lostBeforeThisStart } from "./queue/queue-readopt.ts";
import { type FindingsGiven } from "./blocker-findings-check.ts";
import { CLAIMS_GIVEN_FILE, CLAIMS_RETRIED_FILE, type HeldClaim } from "./path-claims.ts";
import { SENT_BACK_FILE } from "./pool-plan-send-back.ts";
import { recordBriefed, recordFindingsGiven } from "./queue/queue-ticket-text.ts";
import { DECISIONS_ROUND_FILE } from "./decisions-files.ts";
import { writeDecisionsMark } from "./pool-decisions-change.ts";

const SETTINGS_FILE = ".claude/settings.local.json";

/**
 * A notes file the host file names (`tickets.brief`, `tickets.review`), read for each run so an edit reaches the next worker. Throws naming the
 * setting when it cannot be read.
 */
function notesFile(path: string | null, setting: string): string | undefined {
  if (path === null) return undefined;
  try {
    return readFileSync(path, "utf8");
  } catch {
    throw new Error(`${setting} names ${path}, which cannot be read`);
  }
}

/**
 * The Claude session a review run resumes: the one its last run ended in, while its transcript is still there, or else the newest one Claude
 * Code kept for the ticket's folder. Undefined when there is none, and the review run starts a fresh worker.
 */
export function sessionToResume(ctx: PoolContext, entry: Entry): string | undefined {
  const { settings, transcripts } = ctx;
  if (entry.session !== undefined && findTranscript(transcripts, entry.session) !== null) return entry.session;
  return findFolderSession(transcripts, ticketFolder(settings, entry.ticket.key)) ?? undefined;
}

/**
 * The Claude session a talk session resumes: the one its run ended in, while its transcript is still there, or else the newest one Claude Code kept for the
 * folder the run's agent started in, which for a batch's run is the batch's folder. Undefined when there is none.
 */
export function talkSession(ctx: PoolContext, entry: Entry): string | undefined {
  const { transcripts } = ctx;
  if (entry.session !== undefined && findTranscript(transcripts, entry.session) !== null) return entry.session;
  return findFolderSession(transcripts, runPlace(ctx, entry).folder) ?? undefined;
}

/**
 * The ticket as the tracker has it now, so an edit made after it was queued reaches the worker. Its branch stays the one it was queued with,
 * which a retry's worktree is already on. A ticket the tracker no longer has is briefed as it was queued.
 */
export async function current(ctx: PoolContext, queued: Ticket): Promise<Ticket> {
  const { source } = ctx;
  const fresh = await source.read(queued.key);
  return fresh === null ? queued : { ...fresh, branch: queued.branch };
}

/** The ticket this one is part of, with its files in `<dir>/parent`, or `null`. A child's binding decisions are often in its parent's plan. */
async function parentOf(ctx: PoolContext, ticket: Ticket, dir: string): Promise<ParentTicket | null> {
  const { source } = ctx;
  // A run queued before tickets carried a parent has none recorded.
  if (!ticket.parent) return null;
  const parent = await source.read(ticket.parent);
  if (parent === null) return null;
  const parentDir = join(dir, "parent");
  mkdirSync(parentDir, { recursive: true });
  return { ticket: parent, attachments: await source.download(parent, parentDir) };
}

/**
 * The ticket's folder, its brief, its copy of this machine's refusals and its settings file. The folder sits among the person's repositories
 * (under `worktreeRoot`), so the worker starts with the workspace's own `CLAUDE.md` around it, and it is no repository itself: the worker makes
 * its worktrees inside it with `ticket:worktree` once it has decided where the work lands. Throws, with the reason, when any of it cannot be made, and before making any of it when a plugin the worker needs would not load in that folder.
 */
export async function prepare(ctx: PoolContext, entry: Entry): Promise<{ folder: string; dir: string; resume?: string }> {
  const { hook, settings, source, store } = ctx;
  const ticket = await current(ctx, entry.ticket);
  // The text this brief is written from, and the findings of the blockers' merged pull requests the run has learned from (A11-167).
  const read = ticketReadOf(ticket, ctx.now());
  const findings = findingsOf(entry);
  const dir = ticketDir(settings, ticket.key);
  // The work pull requests of this ticket held when they were closed without merging, which the board listed (A11-249): the plan and the pull request account for it.
  const closed = closedWorkOf(dir);
  const folder = ticketFolder(settings, ticket.key);
  clearRunDir(ctx, folder, dir);
  const attachments = await source.download(ticket, dir);
  const parent = await parentOf(ctx, ticket, dir);
  const notes = notesFile(settings.brief, "tickets.brief");
  const connectors = settings.connectors;
  // A run the board stopped resumes its own Claude session, whatever kind of run it was: on the new version after an update (A11-169), or once the tickets its worker waited on are done (A11-272).
  let resume: string | undefined = resumesStoppedSession(entry) ? sessionToResume(ctx, entry) : undefined;
  if (entry.review !== undefined && isCapPlanner(entry)) {
    // The planner's round for a run at the board's round cap is a planner and not the worker resumed (A11-343).
    resume = undefined;
    await writeCapPlanBrief(ctx, entry, { ticket, folder, dir, read, notes, connectors });
    writeFileSync(join(dir, REVIEW_FILE), `${JSON.stringify(entry.review)}\n`);
  } else if (entry.review !== undefined && isStandoffPlanner(entry)) {
    // The planner's round for a stand-off is a planner and not the worker resumed: it starts a session of its own (A11-290).
    resume = undefined;
    await writeStandoffPlanBrief(ctx, entry, { ticket, folder, dir, read, notes, connectors });
    writeFileSync(join(dir, REVIEW_FILE), `${JSON.stringify(entry.review)}\n`);
  } else if (entry.review !== undefined) {
    resume = sessionToResume(ctx, entry);
    writeFileSync(join(dir, BRIEF_FILE), reviewBriefText({ ticket, folder, ticketDir: dir, prs: openPulls(entry), notes, reviewNotes: notesFile(settings.review, "tickets.review"),
      connectors, resumed: resume !== undefined, feedback: entry.feedback, asked: entry.asked === true, decisions: entry.decisions === true, standoff: entry.standoff?.stage === "worker", conflict: entry.conflict, prReview: settings.prReview, read, previous: entry.briefedAgainst, held: entry.ciHold?.reason ?? entry.ciTold }));
    writeDecisionsMark(ctx, entry, dir, { briefed: entry.briefedAgainst, read });
    writeFileSync(join(dir, REVIEW_FILE), `${JSON.stringify(openPulls(entry))}\n`);
  } else if (isPlanning(ctx, entry) && settings.planner) {
    const planDir = emptyPlanDir(dir);
    const replan = entry.previousPlan === undefined ? undefined : { files: entry.previousPlan, ...(entry.ticketChange ? { change: entry.ticketChange } : {}), findings: findings.length > 0 };
    const claims = heldClaims(store.get().entries, [entry]);
    writeFileSync(join(dir, BRIEF_FILE), planBriefText({ ticket, ticketDir: dir, planDir, attachments, parent, clones: settings.clones, uncloned: unclonedNames(ctx), run: settings.planner.run,
      notes, connectors, read, blockers: entry.blockers, findings, closed, claims, ...(replan ? { replan } : {}) }));
    writeClaimsGiven(dir, claims);
    const urls = findings.map(({ url }) => url);
    writeFindingsGiven(dir, [{ key: ticket.key, planDir, urls }]);
    update(ctx, (queue) => recordFindingsGiven(queue, ticket.key, urls));
  } else {
    const worktreeCommand = `${hook.node} ${hook.bin} ticket:worktree`;
    const prOpenCommand = `${hook.node} ${hook.bin} pr:open`;
    writeFileSync(join(dir, BRIEF_FILE), briefText({ ticket, folder, ticketDir: dir, attachments, parent, blockers: entry.blockers,
      stackedOn: stackedOn(entry, store.get().entries), steps: entry.steps, clones: settings.clones, worktreeCommand, prOpenCommand, repo: repoOf(entry),
      notes, connectors, planned: entry.planned === true, drafts: settings.drafts, designTools: settings.designTools, capture: settings.capture, prReview: settings.prReview, keywords: source.keywords ?? DEFAULT_KEYWORDS,
      read, findings, closed, numberedSteps: startedSteps(store.get().entries, entry), opened: openedPullsOf(ctx, entry), held: entry.ciHold?.reason ?? entry.ciTold, lost: lostBeforeThisStart(entry) }));
  }
  update(ctx, (queue) => recordBriefed(queue, [ticket.key], read));
  writeRunFiles(ctx, entry, folder, dir);
  recordPluginCopies(ctx, [entry.ticket.key], folder);
  return { folder, dir, ...(resume ? { resume } : {}) };
}

/** Whether the run being prepared recorded numbered plan steps as it started (A11-219): the entry the start was given is the queued one, so the queue's is read. PURE. */
const startedSteps = (entries: readonly Entry[], { ticket }: Entry): boolean => (entries.find((e) => e.ticket.key === ticket.key)?.plannedSteps ?? []).length > 0;

/**
 * Make a run's folder ready, with nothing left of an earlier run in it. Throws, before making any of it, when a plugin the worker needs would
 * not load in the folder its agent starts in, or a plugin's declared contract does not match the host's keys.
 */
export function clearRunDir(ctx: PoolContext, folder: string, dir: string): void {
  const { deps, settings } = ctx;
  // A worker without its plugins runs without the skills and guards its brief counts on, so it is not started at all. Nor is one whose plugin
  // declares a contract this machine does not meet: the Settings page reads the same rows.
  const { unreachable, rows } = pluginProblems({ wanted: settings.plugins, folder, host: hostFactsOf(settings) }, { record: deps.pluginRecord });
  const problems = [...unreachable, ...rows.map(({ why }) => why)];
  if (problems.length > 0) throw new Error(problems.join(" "));
  mkdirSync(dir, { recursive: true });
  // An earlier run's outcome and stop count would end this run before it began, and an earlier review or publish run's mark would lift a
  // refusal for it. An earlier run's pre-PR review log would say the skill ran on commits this run has not made (A11-86).
  // A stacked branch an earlier run recorded is not this run's: its worktree records its own, if it is stacked (A11-116).
  // The pull requests a planning brief listed, and the retry the hook made for them, belong to the brief that listed them: a planning brief writes its own list, and any other brief has none (A11-207). So do the paths it listed
  // other tickets as holding, and the retry made for a folder claim (A11-212). So does the count of After-merge refusals sent back to its planner (A11-288).
  for (const file of [OUTCOME_FILE, STOP_COUNT_FILE, WORKING_STOP_FILE, FINDINGS_GIVEN_FILE, FINDINGS_RETRIED_FILE, CLAIMS_GIVEN_FILE, CLAIMS_RETRIED_FILE, SENT_BACK_FILE, REVIEW_FILE, PUBLISH_FILE, TALK_FILE, PR_REVIEW_FILE, PR_REVIEW_LOG_FILE, STACK_BASE_FILE, STANDOFF_PLANNER_FILE, STANDOFF_ROUND_FILE, STANDOFF_DECISION_FILE, CAP_PLANNER_FILE, CAP_DECISION_FILE, DECISIONS_ROUND_FILE]) {
    rmSync(join(dir, file), { force: true });
  }
}

/** The pull requests each ticket of a planning run was told need a line in its plan, written beside the run's outcome file for the stop hook to check the plan against (A11-207). */
function writeFindingsGiven(dir: string, given: FindingsGiven): void {
  writeFileSync(join(dir, FINDINGS_GIVEN_FILE), `${JSON.stringify(given)}\n`);
}

/** The paths other tickets held when a planning brief was written, beside the run's outcome file for the stop hook and the settle step to check the plan's folder claims against (A11-212). */
function writeClaimsGiven(dir: string, claims: readonly HeldClaim[]): void {
  writeFileSync(join(dir, CLAIMS_GIVEN_FILE), `${JSON.stringify(claims)}\n`);
}

/** Whether the run is the planner's round for a stand-off (A11-290): a review round of the ticket's pull requests that starts as the planner, not as the worker. */
export const isStandoffPlanner = (entry: Entry): boolean => entry.standoff?.stage === "planner" && entry.review !== undefined;

/** The plan files the board last downloaded, by name: the plain files that match the machine's plan pattern. None when this machine names no plan or none is there. */
function planNamesIn(ctx: PoolContext, pathsDir: string): string[] {
  const { plan } = ctx.settings;
  if (plan === null || !existsSync(pathsDir)) return [];
  return readdirSync(pathsDir).filter((name) => new RegExp(plan).test(name)).sort();
}

/**
 * The brief of the planner's round for a stand-off (A11-290): the plan's files are downloaded again first, so the planner reads the plan as the tracker holds it, and its own plan folder is made empty for the amended files it may write. A download the tracker refuses is
 * said and the brief goes on with the files it already had.
 */
async function writeStandoffPlanBrief(ctx: PoolContext, entry: Entry, { ticket, folder, dir, read, notes, connectors }: Readonly<{ ticket: Ticket; folder: string; dir: string; read: TicketRead; notes: string | undefined; connectors: readonly string[] }>): Promise<void> {
  await planDownloadedAgain(ctx, ticket, "stand-off");
  const pathsDir = join(dir, "paths");
  writeFileSync(join(dir, BRIEF_FILE), standoffPlanBriefText({ ticket, folder, ticketDir: dir, planDir: emptyPlanDir(dir), pathsDir, planNames: planNamesIn(ctx, pathsDir), prs: entry.review ?? [], feedback: entry.feedback ?? "", notes, connectors, read }));
}

/** The plan's files, downloaded again so a planner's round reads the plan as the tracker holds it. A download the tracker refuses is said and the round goes on with the files it already had. */
async function planDownloadedAgain(ctx: PoolContext, ticket: Ticket, round: string): Promise<void> {
  try {
    await planFiles(ctx, ticket);
  } catch (err) {
    process.stderr.write(`ticket:serve: ${ticket.key}: the plan could not be downloaded again for its ${round} round (${String((err as Error)?.message ?? err).split("\n")[0]}); the planner reads the files it had\n`);
  }
}

/**
 * The brief of the planner's round for a run at the board's round cap (A11-343): the plan is downloaded again first, its own plan folder is made empty for the amended files it may write, and the brief names the run's earlier rounds and its open blockers as the board holds them.
 */
async function writeCapPlanBrief(ctx: PoolContext, entry: Entry, { ticket, folder, dir, read, notes, connectors }: Readonly<{ ticket: Ticket; folder: string; dir: string; read: TicketRead; notes: string | undefined; connectors: readonly string[] }>): Promise<void> {
  await planDownloadedAgain(ctx, ticket, "round-cap");
  const pathsDir = join(dir, "paths");
  const rounds = logOf(ctx.store.get(), ticket.key).flatMap((event) => (event.kind === "round" ? [`${event.cause}${event.reason === null ? "" : `: ${event.reason}`}`] : []));
  const blockers = (entry.blockers ?? []).filter(({ state }) => state !== "completed" && state !== "canceled").map(({ key, state }) => `${key} (${state})`);
  writeFileSync(join(dir, BRIEF_FILE), capPlanBriefText({ ticket, folder, ticketDir: dir, planDir: emptyPlanDir(dir), pathsDir, planNames: planNamesIn(ctx, pathsDir), prs: entry.review ?? [], feedback: entry.capRound?.latest ?? entry.feedback ?? "", facts: { rounds, blockers, asked: entry.capPlans ?? 1 }, notes, connectors, read }));
}

/** The mark the planner's round at the round cap is given beside its outcome file (A11-343), which no worker writes; any other run has none (`clearRunDir` removed the earlier run's). */
function writeCapMark(entry: Entry, dir: string): void {
  rmSync(join(dir, CAP_PLANNER_FILE), { force: true });
  if (isCapPlanner(entry)) writeFileSync(join(dir, CAP_PLANNER_FILE), "\n");
}

/**
 * The marks a stand-off round is given beside its outcome file (A11-290), which no worker writes: the planner's round has `standoff-planner-run`, and the worker's `standoff-round.json`, the head and a hash of the description each of its pull requests has now, by address,
 * which the Stop hook compares with the pull request when the round says `reviewed`. Any other run has neither (`clearRunDir` removed the earlier run's). A pull request the code host cannot read keeps the head the stand-off was about and no description.
 */
function writeStandoffMarks(ctx: PoolContext, entry: Entry, dir: string): void {
  rmSync(join(dir, STANDOFF_PLANNER_FILE), { force: true });
  rmSync(join(dir, STANDOFF_ROUND_FILE), { force: true });
  const { standoff } = entry;
  if (standoff === undefined || entry.review === undefined) return;
  if (standoff.stage === "planner") return void writeFileSync(join(dir, STANDOFF_PLANNER_FILE), "\n");
  if (standoff.stage !== "worker") return;
  const state = entry.review.map(({ url }) => {
    const read = ctx.codeHost.readReviewState(url);
    return [url, { head: read?.head ?? standoff.head, body: typeof read?.view.body === "string" ? bodyHash(read.view.body) : null }] as const;
  });
  writeFileSync(join(dir, STANDOFF_ROUND_FILE), `${JSON.stringify(Object.fromEntries(state))}\n`);
}

/** The run's plan folder, made empty: an earlier attempt's files would be attached as this one's. */
function emptyPlanDir(dir: string): string {
  const planDir = join(dir, PLAN_DIR);
  rmSync(planDir, { recursive: true, force: true });
  mkdirSync(planDir, { recursive: true });
  return planDir;
}

/** The conventions plugins' installs this start's session gets, noted on the run for `doctor` (A11-169). Best effort: the install record is read, and never refuses a start. */
function recordPluginCopies(ctx: PoolContext, keys: readonly string[], folder: string): void {
  const { deps, settings } = ctx;
  update(ctx, (queue) => recordPluginCopy(queue, keys, pluginCopiesOf(settings.plugins, folder, deps.pluginRecord)));
}

/**
 * Beside a run's brief, its copy of this machine's refusals and its connectors, and in the folder its agent starts in, its settings file. Exported for a talk session whose pinned version folder was
 * pruned while the run was finished: its hooks must name a folder that exists (A11-169).
 */
export function writeRunFiles(ctx: PoolContext, entry: Entry, folder: string, dir: string): void {
  const { hook, settings } = ctx;
  writeFileSync(join(dir, DENY_FILE), `${JSON.stringify(isPlanning(ctx, entry) || isStandoffPlanner(entry) || isCapPlanner(entry) ? [...settings.deny, ...PLANNING_DENY] : settings.deny)}\n`);
  writeFileSync(join(dir, CONNECTORS_FILE), `${JSON.stringify(settings.connectors)}\n`);
  writeFileSync(join(dir, PROTECTED_FILE), `${JSON.stringify(protectedPaths(settings.binDir))}\n`);
  // A talk session has a person in its terminal, so its stop is not held to the escalation list (A11-257); no other run is.
  if (entry.talk === true) writeFileSync(join(dir, TALK_FILE), "\n");
  else rmSync(join(dir, TALK_FILE), { force: true });
  writeStandoffMarks(ctx, entry, dir);
  writeCapMark(entry, dir);
  // A fresh ticket run on a machine with `tickets.drafts: false` may open its pull request ready; no other run, and no machine that keeps drafts, may.
  if (!settings.drafts && entry.review === undefined && !isPlanning(ctx, entry)) writeFileSync(join(dir, READY_FILE), "\n");
  else rmSync(join(dir, READY_FILE), { force: true });
  // The pre-PR review skill is the gate's for a worker's pushes and a review run's, which push fixes; a planning run pushes nothing.
  if (settings.prReview !== null && !isPlanning(ctx, entry)) writeFileSync(join(dir, PR_REVIEW_FILE), `${JSON.stringify(settings.prReview)}\n`);
  else rmSync(join(dir, PR_REVIEW_FILE), { force: true });
  mkdirSync(join(folder, ".claude"), { recursive: true });
  writeFileSync(join(folder, SETTINGS_FILE),
    `${JSON.stringify(workerSettings({ model: runChoice(ctx, entry).model, ticketDir: dir, readDirs: Object.values(settings.clones), hook, plugins: settings.plugins }), null, 2)}\n`);
}

/**
 * A batch's run folder, its brief and its files, for the tickets in `members`, the first of which is in the batch. Each ticket's files are
 * downloaded into its own {@link ticketDir}, as a run of its own would have them. Throws, with the reason, when any of it cannot be made.
 */
export async function prepareBatch(ctx: PoolContext, members: readonly Entry[]): Promise<{ folder: string; dir: string }> {
  const { settings, source, store } = ctx;
  const [lead] = members;
  const { dir, folder } = runPlace(ctx, lead);
  if (settings.planner === null) throw new Error("this machine names no planner");
  clearRunDir(ctx, folder, dir);
  const tickets: BatchTicket[] = [];
  for (const member of members) {
    const ticket = await current(ctx, member.ticket);
    const own = ticketDir(settings, ticket.key);
    mkdirSync(own, { recursive: true });
    tickets.push({ ticket, attachments: await source.download(ticket, own), parent: await parentOf(ctx, ticket, own), read: ticketReadOf(ticket, ctx.now()), blockers: member.blockers, findings: findingsOf(member), closed: closedWorkOf(own) });
  }
  const planDir = emptyPlanDir(dir);
  const claims = heldClaims(store.get().entries, members);
  writeFileSync(join(dir, BRIEF_FILE), batchPlanBriefText({ tickets, runDir: dir, planDir, clones: settings.clones, uncloned: unclonedNames(ctx), run: settings.planner.run,
    notes: notesFile(settings.brief, "tickets.brief"), connectors: settings.connectors, claims }));
  writeClaimsGiven(dir, claims);
  writeFindingsGiven(dir, tickets.map(({ ticket, findings = [] }) => ({ key: ticket.key, planDir: join(planDir, ticket.key), urls: findings.map(({ url }) => url) })));
  for (const { ticket, read, findings } of tickets) {
    update(ctx, (queue) => recordFindingsGiven(recordBriefed(queue, [ticket.key], read!), ticket.key, (findings ?? []).map(({ url }) => url)));
  }
  writeRunFiles(ctx, lead, folder, dir);
  recordPluginCopies(ctx, members.map((member) => member.ticket.key), folder);
  return { folder, dir };
}

/**
 * The files a run the board starts for itself (a publish or a new-ticket run) is given beside its brief: its refusals, this machine's connectors, the
 * host's protected programs, and its settings file in the folder its agent starts in. The caller writes its own mark first.
 */
export function writeBoardRunFiles(ctx: PoolContext, place: RunPlace, { deny, readDirs, model, writer = null }: Readonly<{
  deny: readonly DenyRule[]; readDirs: readonly string[]; model: string; writer?: Pick<TrackerWriting, "createTool"> | null;
}>): void {
  const { hook, settings } = ctx;
  writeFileSync(join(place.dir, DENY_FILE), `${JSON.stringify(deny)}\n`);
  writeFileSync(join(place.dir, CONNECTORS_FILE), `${JSON.stringify(settings.connectors)}\n`);
  writeFileSync(join(place.dir, PROTECTED_FILE), `${JSON.stringify(protectedPaths(settings.binDir))}\n`);
  mkdirSync(join(place.folder, ".claude"), { recursive: true });
  writeFileSync(join(place.folder, SETTINGS_FILE),
    `${JSON.stringify(workerSettings({ model, ticketDir: place.dir, readDirs, hook, plugins: settings.plugins, writer }), null, 2)}\n`);
}
