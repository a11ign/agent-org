// @ts-check
// module: a run follows the latest text of its ticket -- the stale plan, the change sent to a live worker, and what a blocker's merged pull request found (A11-167, ADR 0005)
//
// A TICKET'S DESCRIPTION CAN CHANGE AFTER IT IS QUEUED OR PLANNED. The board tells a change by the hash of the description (`ticket-read.ts`), never by `updatedAt`, which the tracker moves on every state move and
// attachment the board makes itself. Three things follow from it:
//   - a queued run whose plan was stamped with another hash is marked stale, and re-planned before its worker starts (`replanStale`): the stale plan and the files its stamp lists are copied for the planner and
//     detached from the ticket, because the planning skill refuses a ticket that already has a plan and two attached plans would give the worker two approaches;
//   - a run that is live is sent the change as a message through herdr (`tellLiveRuns`), and its next round's brief carries the new text anyway;
//   - a queued run whose blocker's pull request has merged is given what that pull request found (`learnFromBlockers`), and a plan written before the merge is written again with it. The same read records what the pull request declared of its blocker's ticket (A11-206).
// A plan with no stamp, such as one a person attached, is never read as stale: nothing records the text it was written against.
import { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { type Entry } from "./queue/queue-entries-and-outcomes.ts";
import { ticketTextRead } from "./queue/queue-held-text.ts";
import { openPulls } from "./board-view/view-types-and-filters.ts";
import { type Learned, markTicketChanged, type PlannedAgainst, recordBlockerDeclared, recordLearned, recordTicketChange, replan, type TicketChange } from "./queue/queue-ticket-text.ts";
import { declaredByBlockerPull } from "./queue/queue-declarations.ts";
import { isPlanning, log, messageOf, runPlace, update } from "./pool-state.ts";
import { agentTarget } from "./pool-resume.ts";
import { herdrRefusal } from "./pool-herdr.ts";
import { PLAN_FILE_BYTES } from "./pool-outcome.ts";
import { parseStamp, urlsNamedIn } from "./plan-stamp.ts";
import { planDecisionsOf } from "./plan-decisions.ts";
import { stepSectionText } from "./plan-step-sections.ts";
import { descriptionHash, ticketReadOf, type TicketRead } from "./ticket-read.ts";
import { BLOCKERS_DIR, diffText, type Finding, PREVIOUS_PLAN_DIR } from "./brief-ticket-text.ts";
import { ticketDir } from "./ticket-paths.ts";
import { DEFAULT_KEYWORDS, type Ticket } from "./source.ts";
import { type PoolContext } from "./pool-context.ts";
import type { MergedFindings } from "../plugins/contracts/code-host.ts";
import { resumesStoppedSession } from "./queue/queue-blocker-wait.ts";

/** The most a findings file holds, as a plan file's: a pull request body past it is cut, and the file says so. */
const FINDINGS_FILE_BYTES = PLAN_FILE_BYTES;

/**
 * The plan files the tracker holds for a ticket, downloaded to a folder of their own so a plan's name never reaches the ticket's brief. None when this
 * machine names no plan. Throws when the tracker refuses the download, which is the failure a run's plan reports as its own (A11-125).
 */
export async function planFiles(ctx: PoolContext, ticket: Ticket): Promise<readonly string[]> {
  const { settings, source } = ctx;
  if (settings.plan === null) return [];
  const dir = join(ticketDir(settings, ticket.key), "paths");
  mkdirSync(dir, { recursive: true });
  return source.download(ticket, dir);
}

/**
 * The plan's text for step `step` of ticket `key`, read from the plan files `planFiles` downloaded for it, or null when this machine names no plan, no plan file is there, or none has a section for
 * that step (A11-175). Reads the folder and downloads nothing: a reviewer is briefed without a round trip to the tracker, and a plan the run was queued with is there.
 */
export function planStepSection(ctx: PoolContext, key: string, step: number): string | null {
  try {
    for (const text of planTexts(ctx, key)) {
      const section = stepSectionText(text, step);
      if (section !== null) return section;
    }
  } catch {
    // A plan file that cannot be read has no plan to quote: the reviewer is told so.
  }
  return null;
}

/** How the words for a plan the board could not read begin: `isPlanUnreadable` tells them from a plan's decisions (A11-290). */
const PLAN_UNREADABLE_START = "The board could not read this ticket's plan";

/** Whether `text` is the reviewer's words for a plan the board could not read, and not a plan's decisions. */
export const isPlanUnreadable = (text: string): boolean => text.startsWith(PLAN_UNREADABLE_START);

/**
 * What the reviewer is told when the board could not read a ticket's plan (A11-257). A plan it cannot read may hold decisions that bind the reviewer, and silence would read as a plan with none, so the reviewer is told, and does not
 * request changes on a point the plan may have decided.
 */
export const planUnreadableWords = (why: string): string =>
  `${PLAN_UNREADABLE_START} (${why}), so the plan's decisions are not given to you here. A point the plan may have decided is not yours to request changes on: write a "Note (not a finding)" about it and approve on that point.`;

/**
 * The decisions the plan files of ticket `key` record (A11-257), quoted as the plan words them, or null when this machine names no plan, no plan file is there, or none records a decision. Reads the folder and downloads nothing, as
 * {@link planStepSection} does. A plan file that cannot be read is not a plan with no decisions: the answer is {@link planUnreadableWords}, which the reviewer is given in their place, and the failure is logged.
 */
export function planDecisions(ctx: PoolContext, key: string): string | null {
  try {
    const found = [...planTexts(ctx, key)].map(planDecisionsOf).filter((text): text is string => text !== null);
    return found.length === 0 ? null : found.join("\n\n");
  } catch (err) {
    log(`${key}: ${messageOf(err)}, so its reviewer is told the plan's decisions are unknown`);
    return planUnreadableWords(messageOf(err));
  }
}

/**
 * The text of each plan file `planFiles` downloaded for ticket `key`, by file name: none when this machine names no plan, no plan folder is there, or a file is over {@link PLAN_FILE_BYTES}. Reads the folder
 * and downloads nothing. THROWS, naming the file, when a plan file or the folder cannot be read: a plan the board cannot read is not a ticket with no plan, and a caller that must not mistake the two lets it through.
 */
export function* planTexts(ctx: PoolContext, key: string): Generator<string> {
  const { settings } = ctx;
  if (settings.plan === null) return;
  const pattern = new RegExp(settings.plan);
  const dir = join(ticketDir(settings, key), "paths");
  let names: string[];
  try {
    names = readdirSync(dir).sort();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new Error(`its plan folder could not be read (${messageOf(err)})`);
  }
  for (const name of names.filter((each) => pattern.test(each))) {
    const text = readPlanFile(join(dir, name));
    if (text !== null) yield text;
  }
}

/** A plan file's text, or null for one over {@link PLAN_FILE_BYTES}. Throws, naming the file, for one that cannot be read. */
function readPlanFile(path: string): string | null {
  try {
    return statSync(path).size > PLAN_FILE_BYTES ? null : readFileSync(path, "utf8");
  } catch (err) {
    throw new Error(`its plan file ${basename(path)} could not be read (${messageOf(err)})`);
  }
}

/** The title a downloaded file was attached under: the tracker may put a counter in front of it (`attachment-3-<title>`). PURE. */
const titleOfDownload = (path: string): string => basename(path).replace(/^attachment-\d+-/, "");

/** The plan stamp among a ticket's downloaded plan files, with the pull requests its `## What the blockers found` section names, or null when no plan file holds a stamp. */
export function plannedAgainstIn(files: readonly string[], plan: string | null): PlannedAgainst | null {
  if (plan === null) return null;
  const pattern = new RegExp(plan);
  for (const file of files) {
    if (!pattern.test(basename(file)) || statSync(file).size > PLAN_FILE_BYTES) continue;
    const text = readFileSync(file, "utf8");
    const stamp = parseStamp(text);
    if (stamp !== null) return { ...stamp, named: urlsNamedIn(text) };
  }
  return null;
}

/** What a queued run's planner is given of its blockers' merged pull requests, as the brief names it. PURE. */
export const findingsOf = (entry: Pick<Entry, "learned">): Finding[] =>
  Object.entries(entry.learned ?? {}).map(([url, { key, number, title, file }]): Finding => ({ key, number, url, title, file }));

/** The pull requests the run has learned from that its stamped plan does not name: a plan written before the merge cannot say how each finding applies. PURE. */
export const unnamedFindings = (entry: Pick<Entry, "learned" | "plannedAgainst">): string[] =>
  entry.plannedAgainst === undefined ? [] : Object.keys(entry.learned ?? {}).filter((url) => !entry.plannedAgainst!.named.includes(url));

/** The merged pull requests of a run's blockers that it has not learned from yet, each with its address and its blocker's key. PURE. */
function unlearned(entry: Entry): { url: string; blocker: string }[] {
  const merged = (entry.blockers ?? []).flatMap(({ key, pulls }) => Object.entries(pulls).filter(([, state]) => state === "merged").map(([url]) => ({ url, blocker: key })));
  return merged.filter(({ url }) => entry.learned?.[url] === undefined);
}

/** `owner/repo` of a pull request's address, or the address when it is not one. PURE. */
const repoOfPull = (url: string): string => /github\.com\/([^/]+\/[^/]+)\/pull\//.exec(url)?.[1] ?? url;

/** The findings file's text: the pull request's title and address, its body, and each section it added. PURE. */
function findingsMarkdown(blocker: string, url: string, found: MergedFindings): string {
  const sections = found.sections.map(({ file, heading, text }) => `### \`${file}\`: ${heading.replace(/^#+\s*/, "")}\n\n${text}`).join("\n\n");
  return `# What ${blocker}'s pull request found

${found.title} (#${found.number})

${url}

## The pull request's body

${found.body.trim() || "(no body)"}

## The sections it added

${sections || "(it added no markdown section)"}
`;
}

/** Save what a pull request found under the ticket's folder, capped at 1 MB with the cap said in the file. Returns the path. */
function saveFindings(ctx: PoolContext, key: string, blocker: string, url: string, found: MergedFindings): string {
  const dir = join(ticketDir(ctx.settings, key), BLOCKERS_DIR);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${blocker}-${repoOfPull(url).replace("/", "-")}-${found.number}.md`);
  const text = findingsMarkdown(blocker, url, found);
  const note = "\n(cut: the rest of this pull request's findings do not fit in 1 MB)\n";
  writeFileSync(path, Buffer.byteLength(text) > FINDINGS_FILE_BYTES ? `${Buffer.from(text).subarray(0, FINDINGS_FILE_BYTES - note.length).toString("utf8")}${note}` : text);
  return path;
}

/** Reads a merged pull request, at most once in a pass: the answer is kept, a `null` among them, and so is a refusal, which is thrown again to whoever asks next in the pass. */
type PassReader = (url: string) => MergedFindings | null;

/** A reader of merged pull requests for one pass, or null when the code host reads none. */
function passReaderOf({ codeHost }: PoolContext): PassReader | null {
  if (codeHost.readMergedFindings === undefined) return null;
  const read = new Map<string, () => MergedFindings | null>();
  return (url) => {
    if (!read.has(url)) read.set(url, answerOf(() => codeHost.readMergedFindings!(url)));
    return read.get(url)!();
  };
}

/** The answer of `ask`, asked once: what it returned, or what it threw, again on each call. */
function answerOf<T>(ask: () => T): () => T {
  let answer: { found: T } | { refusal: unknown };
  try {
    answer = { found: ask() };
  } catch (refusal) {
    answer = { refusal };
  }
  return () => {
    if ("refusal" in answer) throw answer.refusal;
    return answer.found;
  };
}

/**
 * Give each queued run the findings of its blockers' merged pull requests (A11-167): for each merged pull request a run has not learned from, the code host is asked what it found, the answer is saved
 * under the run's folder, and the run records it. A pull request the host cannot read is asked again on the next refresh, and a host that does not read findings gives none. A review round or a talk
 * session continues work that is done, and learns nothing. Every queued run, a round or a session too, also has what each merged pull request declared of its blocker's ticket recorded (A11-206), from
 * the same read, which {@link recordDeclarations} says.
 */
export function learnFromBlockers(ctx: PoolContext): void {
  const read = passReaderOf(ctx);
  for (const entry of ctx.store.get().entries) {
    if (entry.phase !== "queued") continue;
    recordDeclarations(ctx, entry, read);
    if (read !== null && entry.review === undefined && entry.talk !== true) learnFindings(ctx, entry, read);
  }
}

/** Record the findings of the merged pull requests of a queued work run's blockers that it has not learned from yet. A read or a save that fails is said, and asked again on the next refresh. */
function learnFindings(ctx: PoolContext, entry: Entry, read: PassReader): void {
  for (const { url, blocker } of unlearned(entry)) {
    try {
      const found = read(url);
      if (found === null) continue;
      const learned: Learned = { key: blocker, number: found.number, title: found.title, file: saveFindings(ctx, entry.ticket.key, blocker, url, found) };
      update(ctx, (queue) => recordLearned(queue, entry.ticket.key, url, learned));
      log(`${entry.ticket.key}: learns from ${blocker} (#${found.number} merged)`);
    } catch (err) {
      // The findings could not be read or saved: the next refresh asks again, and the refresh goes on.
      log(`${entry.ticket.key}: what ${blocker}'s pull request found could not be read: ${messageOf(err)}`);
    }
  }
}

/** The merged pull requests of a run's blockers whose declaration it has not recorded yet, each with its address, its blocker's key and how many pull requests that blocker links. PURE. */
function undeclared(entry: Entry): { url: string; blocker: string; pullCount: number }[] {
  const merged = (entry.blockers ?? []).flatMap(({ key, pulls }) => Object.entries(pulls).filter(([, state]) => state === "merged").map(([url]) => ({ url, blocker: key, pullCount: Object.keys(pulls).length })));
  return merged.filter(({ url }) => entry.blockersDeclared?.[url] === undefined);
}

/**
 * Record what each merged pull request of a queued run's blockers declared of its blocker's ticket (A11-206), once for each: a blocker whose pull request said `Partial:` has more to come, so the run waits for it
 * (`board-view/pull-status-and-notes.ts`). A pull request the code host cannot read (`null`, or a refusal) records nothing, so the run keeps waiting and the next refresh asks again. A code host that reads no bodies
 * (`read` is null) cannot say, so every merged pull request records `none`, and the run follows A11-154's rule on the pull requests' states alone.
 */
function recordDeclarations(ctx: PoolContext, entry: Entry, read: PassReader | null): void {
  const due = undeclared(entry);
  if (read === null) recordUnreadable(ctx, entry, due);
  else for (const pull of due) recordDeclaration(ctx, entry, pull, read);
}

/** A merged pull request of a blocker whose declaration a run has not recorded: its address, its blocker's key and how many pull requests that blocker links. */
type DueDeclaration = ReturnType<typeof undeclared>[number];

/** Record `none` for each of `due`, and say once that this code host reads no body, which is why. */
function recordUnreadable(ctx: PoolContext, entry: Entry, due: readonly DueDeclaration[]): void {
  if (due.length === 0) return;
  log(`${entry.ticket.key}: this code host cannot read a pull request's body, so ${[...new Set(due.map(({ blocker }) => blocker))].join(", ")}'s merged pull requests count as complete`);
  for (const { url } of due) update(ctx, (queue) => recordBlockerDeclared(queue, entry.ticket.key, url, { kind: "none" }));
}

/** Record what one merged pull request of a blocker declared, read through `read`. A refusal is said, and asked again on the next refresh. */
function recordDeclaration(ctx: PoolContext, entry: Entry, { url, blocker, pullCount }: DueDeclaration, read: PassReader): void {
  try {
    const found = read(url);
    if (found === null) return;
    const declared = declaredByBlockerPull(found.body, blocker, pullCount, ctx.source.keywords ?? DEFAULT_KEYWORDS);
    update(ctx, (queue) => recordBlockerDeclared(queue, entry.ticket.key, url, declared));
  } catch (err) {
    log(`${entry.ticket.key}: what ${blocker}'s pull request declared could not be read, and is asked again at the next refresh: ${messageOf(err)}`);
  }
}

/** The change from the text `from` to the text `to`, noticed now. */
const changeOf = (ctx: PoolContext, from: string, to: string): TicketChange => ({ at: ctx.now(), from, to });

/** Whether this machine can write a stale plan again: it has a planner, and the tracker detaches a plan. */
const canReplan = (ctx: PoolContext): boolean => ctx.settings.planner !== null && ctx.source.detachPlan !== undefined;

/** Whether a finished run holds an open pull request whose head the reviewer has blocked (A11-250): a change to its ticket's Decisions may answer that block, so the run's copy of the text is kept current. */
const holdsBlockedPull = (ctx: PoolContext, entry: Entry): boolean =>
  entry.phase === "finished" && openPulls(entry).some(({ url }) => ctx.pullReads.get(url)?.verdict === "changes requested");

/**
 * The runs whose tickets are asked about: queued work runs with a stamped plan, live runs whose text is known and whose agent is not planning (A11-167), and finished runs that hold a blocked pull request, whose
 * Decisions the reviewer re-reads (A11-250).
 */
function watchedKeys(ctx: PoolContext): string[] {
  const { store } = ctx;
  const watched = store.get().entries.filter((entry) => {
    if (entry.review !== undefined && entry.phase === "queued") return false;
    if (entry.talk === true) return false;
    if (holdsBlockedPull(ctx, entry)) return true;
    if (entry.phase === "queued") return entry.plan === undefined && entry.plannedAgainst !== undefined && !resumesStoppedSession(entry) && canReplan(ctx);
    return entry.phase === "running" && entry.briefedAgainst !== undefined && !isPlanning(ctx, entry);
  });
  return [...new Set(watched.map(({ ticket }) => ticket.key))];
}

/**
 * Check the description of every queued and live run's ticket in one request, and act on a change (A11-167): a queued run whose plan was stamped with another hash is marked stale (and the mark goes when the
 * ticket holds the planned text again), and a live run is sent the change. A source that cannot give texts changes nothing. Throws when the tracker cannot be asked; the next refresh asks again.
 */
export async function followTicketTexts(ctx: PoolContext): Promise<void> {
  const { source, store } = ctx;
  if (source.texts === undefined) return;
  const keys = watchedKeys(ctx);
  if (keys.length === 0) return;
  const texts = await source.texts(keys);
  // Read again now the await is over: a run may have started, been stopped or been planned again meanwhile.
  for (const entry of store.get().entries.filter((e) => keys.includes(e.ticket.key))) {
    const text = texts.get(entry.ticket.key);
    if (text === undefined) continue;
    const read = ticketReadOf({ description: text.description, updatedAt: text.updatedAt }, ctx.now());
    if (entry.phase === "queued") markStale(ctx, entry, read);
    else if (entry.phase === "finished") readHeldText(ctx, entry, read);
    else tellLiveRun(ctx, entry, read);
  }
}

/** Move a finished run's copy of its ticket's description on to what the ticket says now (A11-250), for the reviewer's next brief. Nothing is written when the text is the one it holds. */
function readHeldText(ctx: PoolContext, entry: Entry, read: TicketRead): void {
  if (entry.ticket.description !== read.description) update(ctx, (queue) => ticketTextRead(queue, entry.ticket.key, read.description));
}

/** Mark a queued run's plan stale when the ticket no longer has the description it was stamped with, and clear the mark when it has it again. */
function markStale(ctx: PoolContext, entry: Entry, read: TicketRead): void {
  const stamp = entry.plannedAgainst;
  if (stamp === undefined || entry.plan !== undefined) return;
  const stale = stamp.hash !== read.hash;
  // The mark shows the ticket as it is now: a second edit moves it on, and the text the plan was written against comes back, it goes.
  const shown = entry.ticketChange;
  if (stale ? shown !== undefined && descriptionHash(shown.to) === read.hash : shown === undefined) return;
  update(ctx, (queue) => markTicketChanged(queue, entry.ticket.key, stale ? changeOf(ctx, stamp.description, read.description) : undefined));
}

/** Whether a worker is at work: its run is running, and its agent waits on no dialog. PURE. */
const atWork = (entry: Entry): boolean => entry.phase === "running" && entry.waiting !== true;

/** Whether a live run is told now: its worker is at work, and a change is not already on its way to it. */
const isToldNow = (ctx: PoolContext, entry: Entry): boolean => atWork(entry) && !ctx.telling.has(entry.ticket.key);

/** The message a live worker is sent when its ticket changed: short, naming the file that holds the new text and the lines that differ. */
function changeMessage(path: string): string {
  return `the ticket's description changed while you work; read ${path}, carry on against the new text, and say in your next outcome what the change meant for your work`;
}

/** The file a live run is told of a change in: the new description, when it was last updated, and the lines that differ. PURE. */
function changeFile(from: TicketRead, to: TicketRead): string {
  const updated = to.updatedAt === null ? "" : `The ticket was last updated ${to.updatedAt}.\n\n`;
  return `# The ticket changed

${updated}These lines of the description differ from the text you were briefed with:

${diffText(from.description, to.description)}

## The description now

${to.description.trim() || "(no description)"}
`;
}

/**
 * Send a change in a live run's ticket to its worker (A11-167): the new text and the lines that differ are written to a file beside its brief, and the agent is prompted through herdr to read it. The change is
 * recorded once the prompt has gone, and the run is then briefed against the new text; a prompt herdr refuses is said, and tried again on the next refresh.
 */
function tellLiveRun(ctx: PoolContext, entry: Entry, read: TicketRead): void {
  const { herdr, settings, telling } = ctx;
  const before = entry.briefedAgainst;
  if (before === undefined || before.hash === read.hash || !isToldNow(ctx, entry)) return;
  telling.add(entry.ticket.key);
  try {
    const place = runPlace(ctx, entry);
    const path = join(place.dir, `ticket-changed-${(entry.ticketChanges?.length ?? 0) + 1}.md`);
    writeFileSync(path, changeFile(before, read));
    herdr(["--session", settings.herdrSession, "agent", "prompt", agentTarget(ctx, place), changeMessage(path)]);
    update(ctx, (queue) => recordTicketChange(queue, entry.ticket.key, changeOf(ctx, before.description, read.description), read));
  } catch (err) {
    log(`${entry.ticket.key} could not be told its ticket changed: ${herdrRefusal(err)}`);
  } finally {
    telling.delete(entry.ticket.key);
  }
}

/** The plan files of `ticket` the stale stamp lists, copied into the run's `previous-plan` folder under the names they were attached as. Returns the copies. */
async function copyPreviousPlan(ctx: PoolContext, ticket: Ticket, titles: readonly string[]): Promise<string[]> {
  const downloaded = await planFiles(ctx, ticket);
  const dir = join(ticketDir(ctx.settings, ticket.key), PREVIOUS_PLAN_DIR);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  return downloaded.filter((path) => titles.includes(titleOfDownload(path))).map((path) => {
    const copy = join(dir, titleOfDownload(path));
    copyFileSync(path, copy);
    return copy;
  });
}

/** Why a queued run's stamped plan must be written again against `fresh`, or null when it holds: the description changed, or a blocker's findings reached the run after the plan was written. PURE. */
function staleReason(entry: Entry, fresh: Ticket): "description" | "findings" | null {
  // A run the board stopped while it worked resumes its own session; its worker was told of a change as it happened (A11-169), and reads its blockers' work in its brief (A11-272).
  if (entry.plannedAgainst === undefined || resumesStoppedSession(entry)) return null;
  if (entry.plannedAgainst.hash !== descriptionHash(fresh.description)) return "description";
  return unnamedFindings(entry).length > 0 ? "findings" : null;
}

/**
 * Re-plan a queued work run before it starts, when its plan was stamped with a description the ticket no longer has, or a blocker's findings reached it after the plan was written (A11-167). The stale plan and
 * the files its stamp lists are copied for the planner and detached from the ticket, and the run becomes a planning run on the model and effort it was first planned with. Returns the run as it is now, or the same
 * entry when its plan stands (no stamp, no planner or no way to detach a plan). A run with no recorded choice is planned on its own model and effort. Throws when the plan cannot be copied or detached: the
 * start fails, and a retry asks again.
 */
export async function replanStale(ctx: PoolContext, entry: Entry, fresh: Ticket): Promise<Entry> {
  const { settings, source, store } = ctx;
  const stamp = entry.plannedAgainst;
  const why = canReplan(ctx) ? staleReason(entry, fresh) : null;
  if (stamp === undefined || why === null) return entry;
  let copies: string[];
  try {
    copies = await copyPreviousPlan(ctx, entry.ticket, stamp.files);
    // The file that carries the stamp goes last, so an attempt cut off part way leaves the stamp and the next start plans again.
    const isPlan = (title: string): boolean => settings.plan !== null && new RegExp(settings.plan).test(title);
    await source.detachPlan!(entry.ticket.key, [...stamp.files.filter((title) => !isPlan(title)), ...stamp.files.filter(isPlan)]);
  } catch (err) {
    throw new Error(`its stale plan could not be written again: ${messageOf(err)}`);
  }
  const change = why === "description" ? changeOf(ctx, stamp.description, fresh.description) : undefined;
  update(ctx, (queue) => replan(queue, entry.ticket.key, entry.plannedWith ?? { model: entry.model, effort: entry.effort }, copies, change, ctx.now()));
  log(`${entry.ticket.key}: its plan is stale (${why === "description" ? "the ticket changed since it was written" : "a blocker's findings reached it after it was written"}), so it is planned again before it starts`);
  return store.get().entries.find((e) => e.ticket.key === entry.ticket.key) ?? entry;
}
