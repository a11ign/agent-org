// @ts-check
// module: a run's files, written before its agent starts -- its brief, its refusals and connectors, and its settings file

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { type Entry } from "./queue/queue-entries-and-outcomes.ts";
import { findingsOf } from "./pool-ticket-text.ts";
import { ticketReadOf } from "./ticket-read.ts";
import { findFolderSession, findTranscript } from "./pool-transcripts.ts";
import { ticketDir, ticketFolder } from "./ticket-paths.ts";
import { DEFAULT_KEYWORDS, type Ticket, type TrackerWriting } from "./source.ts";
import { batchPlanBriefText, type BatchTicket, BRIEF_FILE, briefText, CONNECTORS_FILE, DENY_FILE, FINDINGS_GIVEN_FILE, FINDINGS_RETRIED_FILE, OUTCOME_FILE, type ParentTicket, PLAN_DIR, planBriefText, PLANNING_DENY, PR_REVIEW_FILE, PR_REVIEW_LOG_FILE, PROTECTED_FILE, protectedPaths, PUBLISH_FILE, READY_FILE, REVIEW_FILE, reviewBriefText, STOP_COUNT_FILE, TALK_FILE, workerSettings, WORKING_STOP_FILE } from "./worker-files.ts";
import { join } from "node:path";
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
import { type FindingsGiven } from "./blocker-findings-check.ts";
import { CLAIMS_GIVEN_FILE, CLAIMS_RETRIED_FILE, type HeldClaim } from "./path-claims.ts";
import { recordBriefed, recordFindingsGiven } from "./queue/queue-ticket-text.ts";

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
  const folder = ticketFolder(settings, ticket.key);
  clearRunDir(ctx, folder, dir);
  const attachments = await source.download(ticket, dir);
  const parent = await parentOf(ctx, ticket, dir);
  const notes = notesFile(settings.brief, "tickets.brief");
  const connectors = settings.connectors;
  // A run the board stopped for an update resumes its own Claude session on the new version (A11-169), whatever kind of run it was.
  let resume: string | undefined = entry.stoppedForUpdate === undefined ? undefined : sessionToResume(ctx, entry);
  if (entry.review !== undefined) {
    resume = sessionToResume(ctx, entry);
    writeFileSync(join(dir, BRIEF_FILE), reviewBriefText({ ticket, folder, ticketDir: dir, prs: entry.review, notes, reviewNotes: notesFile(settings.review, "tickets.review"),
      connectors, resumed: resume !== undefined, feedback: entry.feedback, asked: entry.asked === true, conflict: entry.conflict, prReview: settings.prReview, read, previous: entry.briefedAgainst }));
    writeFileSync(join(dir, REVIEW_FILE), `${JSON.stringify(entry.review)}\n`);
  } else if (isPlanning(ctx, entry) && settings.planner) {
    const planDir = emptyPlanDir(dir);
    const replan = entry.previousPlan === undefined ? undefined : { files: entry.previousPlan, ...(entry.ticketChange ? { change: entry.ticketChange } : {}), findings: findings.length > 0 };
    const claims = heldClaims(store.get().entries, [entry]);
    writeFileSync(join(dir, BRIEF_FILE), planBriefText({ ticket, ticketDir: dir, planDir, attachments, parent, clones: settings.clones, run: settings.planner.run,
      notes, connectors, read, blockers: entry.blockers, findings, claims, ...(replan ? { replan } : {}) }));
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
      read, findings, numberedSteps: startedSteps(store.get().entries, entry), opened: openedPullsOf(ctx, entry) }));
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
  // other tickets as holding, and the retry made for a folder claim (A11-212).
  for (const file of [OUTCOME_FILE, STOP_COUNT_FILE, WORKING_STOP_FILE, FINDINGS_GIVEN_FILE, FINDINGS_RETRIED_FILE, CLAIMS_GIVEN_FILE, CLAIMS_RETRIED_FILE, REVIEW_FILE, PUBLISH_FILE, TALK_FILE, PR_REVIEW_FILE, PR_REVIEW_LOG_FILE, STACK_BASE_FILE]) {
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
  writeFileSync(join(dir, DENY_FILE), `${JSON.stringify(isPlanning(ctx, entry) ? [...settings.deny, ...PLANNING_DENY] : settings.deny)}\n`);
  writeFileSync(join(dir, CONNECTORS_FILE), `${JSON.stringify(settings.connectors)}\n`);
  writeFileSync(join(dir, PROTECTED_FILE), `${JSON.stringify(protectedPaths(settings.binDir))}\n`);
  // A talk session has a person in its terminal, so its stop is not held to the escalation list (A11-257); no other run is.
  if (entry.talk === true) writeFileSync(join(dir, TALK_FILE), "\n");
  else rmSync(join(dir, TALK_FILE), { force: true });
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
    tickets.push({ ticket, attachments: await source.download(ticket, own), parent: await parentOf(ctx, ticket, own), read: ticketReadOf(ticket, ctx.now()), blockers: member.blockers, findings: findingsOf(member) });
  }
  const planDir = emptyPlanDir(dir);
  const claims = heldClaims(store.get().entries, members);
  writeFileSync(join(dir, BRIEF_FILE), batchPlanBriefText({ tickets, runDir: dir, planDir, clones: settings.clones, run: settings.planner.run,
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
