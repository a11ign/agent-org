// @ts-check
// module: a run's files, written before its agent starts -- its brief, its refusals and connectors, and its settings file

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { type Entry } from "./queue/queue-entries-and-outcomes.ts";
import { findFolderSession, findTranscript } from "./pool-transcripts.ts";
import { ticketDir, ticketFolder } from "./ticket-paths.ts";
import { DEFAULT_KEYWORDS, type Ticket } from "./source.ts";
import { batchPlanBriefText, type BatchTicket, BRIEF_FILE, briefText, CONNECTORS_FILE, DENY_FILE, OUTCOME_FILE, type ParentTicket, PLAN_DIR, planBriefText, PLANNING_DENY, PR_REVIEW_FILE, PR_REVIEW_LOG_FILE, PROTECTED_FILE, protectedPaths, PUBLISH_FILE, READY_FILE, REVIEW_FILE, reviewBriefText, STOP_COUNT_FILE, workerSettings, WORKING_STOP_FILE } from "./worker-files.ts";
import { join } from "node:path";
import { isPlanning, runChoice, runPlace } from "./pool-state.ts";
import { repoOf, stackedOn } from "./board-view/pull-status-and-notes.ts";
import { STACK_BASE_FILE } from "./stack-rebase.ts";
import { pluginProblems } from "./plugins.ts";
import { hostFactsOf } from "./plugin-contract.ts";
import { type RunPlace } from "./pool-paths.ts";
import { type DenyRule } from "./settings.ts";
import { type PoolContext } from "./pool-context.ts";

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
function sessionToResume(ctx: PoolContext, entry: Entry): string | undefined {
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
  const dir = ticketDir(settings, ticket.key);
  const folder = ticketFolder(settings, ticket.key);
  clearRunDir(ctx, folder, dir);
  const attachments = await source.download(ticket, dir);
  const parent = await parentOf(ctx, ticket, dir);
  const notes = notesFile(settings.brief, "tickets.brief");
  const connectors = settings.connectors;
  let resume: string | undefined;
  if (entry.review !== undefined) {
    resume = sessionToResume(ctx, entry);
    writeFileSync(join(dir, BRIEF_FILE), reviewBriefText({ ticket, folder, ticketDir: dir, prs: entry.review, notes, reviewNotes: notesFile(settings.review, "tickets.review"),
      connectors, resumed: resume !== undefined, feedback: entry.feedback, asked: entry.asked === true, conflict: entry.conflict, prReview: settings.prReview }));
    writeFileSync(join(dir, REVIEW_FILE), `${JSON.stringify(entry.review)}\n`);
  } else if (isPlanning(ctx, entry) && settings.planner) {
    writeFileSync(join(dir, BRIEF_FILE), planBriefText({ ticket, ticketDir: dir, planDir: emptyPlanDir(dir), attachments, parent, clones: settings.clones, run: settings.planner.run,
      notes, connectors }));
  } else {
    const worktreeCommand = `${hook.node} ${hook.bin} ticket:worktree`;
    const prOpenCommand = `${hook.node} ${hook.bin} pr:open`;
    writeFileSync(join(dir, BRIEF_FILE), briefText({ ticket, folder, ticketDir: dir, attachments, parent, blockers: entry.blockers,
      stackedOn: stackedOn(entry, store.get().entries), clones: settings.clones, worktreeCommand, prOpenCommand, repo: repoOf(entry),
      notes, connectors, planned: entry.planned === true, drafts: settings.drafts, designTools: settings.designTools, prReview: settings.prReview, keywords: source.keywords ?? DEFAULT_KEYWORDS }));
  }
  writeRunFiles(ctx, entry, folder, dir);
  return { folder, dir, ...(resume ? { resume } : {}) };
}

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
  for (const file of [OUTCOME_FILE, STOP_COUNT_FILE, WORKING_STOP_FILE, REVIEW_FILE, PUBLISH_FILE, PR_REVIEW_FILE, PR_REVIEW_LOG_FILE, STACK_BASE_FILE]) {
    rmSync(join(dir, file), { force: true });
  }
}

/** The run's plan folder, made empty: an earlier attempt's files would be attached as this one's. */
function emptyPlanDir(dir: string): string {
  const planDir = join(dir, PLAN_DIR);
  rmSync(planDir, { recursive: true, force: true });
  mkdirSync(planDir, { recursive: true });
  return planDir;
}

/** Beside a run's brief, its copy of this machine's refusals and its connectors, and in the folder its agent starts in, its settings file. */
function writeRunFiles(ctx: PoolContext, entry: Entry, folder: string, dir: string): void {
  const { hook, settings } = ctx;
  writeFileSync(join(dir, DENY_FILE), `${JSON.stringify(isPlanning(ctx, entry) ? [...settings.deny, ...PLANNING_DENY] : settings.deny)}\n`);
  writeFileSync(join(dir, CONNECTORS_FILE), `${JSON.stringify(settings.connectors)}\n`);
  writeFileSync(join(dir, PROTECTED_FILE), `${JSON.stringify(protectedPaths(settings.binDir))}\n`);
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
  const { settings, source } = ctx;
  const [lead] = members;
  const { dir, folder } = runPlace(ctx, lead);
  if (settings.planner === null) throw new Error("this machine names no planner");
  clearRunDir(ctx, folder, dir);
  const tickets: BatchTicket[] = [];
  for (const member of members) {
    const ticket = await current(ctx, member.ticket);
    const own = ticketDir(settings, ticket.key);
    mkdirSync(own, { recursive: true });
    tickets.push({ ticket, attachments: await source.download(ticket, own), parent: await parentOf(ctx, ticket, own) });
  }
  writeFileSync(join(dir, BRIEF_FILE), batchPlanBriefText({ tickets, runDir: dir, planDir: emptyPlanDir(dir), clones: settings.clones, run: settings.planner.run,
    notes: notesFile(settings.brief, "tickets.brief"), connectors: settings.connectors }));
  writeRunFiles(ctx, lead, folder, dir);
  return { folder, dir };
}

/**
 * The files a run the board starts for itself (a publish or a new-ticket run) is given beside its brief: its refusals, this machine's connectors, the
 * host's protected programs, and its settings file in the folder its agent starts in. The caller writes its own mark first.
 */
export function writeBoardRunFiles(ctx: PoolContext, place: RunPlace, { deny, readDirs, model, writer = false }: Readonly<{
  deny: readonly DenyRule[]; readDirs: readonly string[]; model: string; writer?: boolean;
}>): void {
  const { hook, settings } = ctx;
  writeFileSync(join(place.dir, DENY_FILE), `${JSON.stringify(deny)}\n`);
  writeFileSync(join(place.dir, CONNECTORS_FILE), `${JSON.stringify(settings.connectors)}\n`);
  writeFileSync(join(place.dir, PROTECTED_FILE), `${JSON.stringify(protectedPaths(settings.binDir))}\n`);
  mkdirSync(join(place.folder, ".claude"), { recursive: true });
  writeFileSync(join(place.folder, SETTINGS_FILE),
    `${JSON.stringify(workerSettings({ model, ticketDir: place.dir, readDirs, hook, plugins: settings.plugins, writer }), null, 2)}\n`);
}
