// @ts-check
// module: the runs the board starts for itself -- how a new-ticket run and a publish run finish

import { type PublishRun, type WriterRun, type WriterTicket } from "./queue/declared-remains.ts";
import { type RunPlace } from "./pool-paths.ts";
import { CREATED_FILE, DECISIONS_FILE, parseWriterOutcome, readCreatedKeys } from "./writer.ts";
import { sectionsNeeded, settledDescription } from "./open-decisions.ts";
import { type Ticket } from "./source.ts";
import { inPickScope } from "./pick-scope.ts";
import { joined } from "./queue.ts";
import { forgetRun, messageOf, publishPlace, update, writerPlace, writerAgentRunning } from "./pool-state.ts";
import { writerEnded, writerWaiting } from "./queue.ts";
import { QUESTION_CHARS } from "./pool-outcome.ts";
import { closedNote } from "../herdr-agents.ts";
import { publishDone, publishFailed } from "./queue/approve.ts";
import { type PoolContext } from "./pool-context.ts";
import { hasPlan } from "./board-view/view-types-and-filters.ts";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ASKED_FILE, OUTCOME_FILE, WAITING_FILE } from "./worker-files.ts";

/**
 * The run's outcome, read once its agent is idle (A11-135). The run filed its own tickets, so the outcome names the keys it made: each is checked against
 * the record the hook kept, read back from the tracker, and shown, and the run ends with them. A quick run's `needs-human` ends it failed, with its reason,
 * and keeps the tickets it made. A grill run's `needs-human` is its question, which it waits on (`askPerson`).
 */
export async function finishWriter(ctx: PoolContext, run: WriterRun, place: RunPlace, text: string): Promise<void> {
  const { finishing, now } = ctx;
  finishing.add(run.id);
  try {
    const outcome = parseWriterOutcome(text);
    if (typeof outcome === "string") return endWriter(ctx, run, outcome);
    if (outcome.kind === "decided") return await settleGrill(ctx, run, place, outcome.ticket);
    if (outcome.kind === "needs-human" && run.mode === "grill" && outcome.created.length === 0) return askPerson(ctx, run, place, outcome.reason);
    const made = await ticketsMade(ctx, place, outcome.created);
    const reason = outcome.kind === "needs-human" ? outcome.reason.slice(0, QUESTION_CHARS) : undefined;
    const failure = [reason, ...made.problems].filter((part): part is string => part !== undefined).join("; ");
    if (!writerAgentRunning(ctx, run.id)) return;
    closeWriter(ctx, run);
    update(ctx, (queue) => writerEnded(queue, run.id, { tickets: made.tickets, failure: failure === "" ? undefined : failure }, now()));
  } catch (err) {
    endWriter(ctx, run, messageOf(err).split("\n")[0]);
  } finally {
    finishing.delete(run.id);
  }
}

/**
 * The tickets a new-ticket run made, as the board shows them (A11-135). The run's record names each ticket the hook saw it create, and each is read back
 * from the tracker for its address. When `tickets.plan` is set, each must have a plan attached. A key the outcome names that the record does not hold is
 * a problem, and is not shown: the run named a ticket it did not create. A record that cannot be read shows nothing and is the problem.
 */
async function ticketsMade(ctx: PoolContext, place: RunPlace, named: readonly string[]): Promise<Readonly<{ tickets: WriterTicket[]; problems: string[] }>> {
  const recorded = readCreatedKeys(place.dir);
  if (recorded === null) return { tickets: [], problems: [`${CREATED_FILE} cannot be read, so the tickets it made cannot be checked`] };
  const unrecorded = named.filter((key) => !recorded.includes(key)).map((key) => `it names ${key}, a ticket it did not create`);
  const checked = await Promise.all([...new Set(recorded)].map((key) => madeTicket(ctx, key)));
  return { tickets: checked.map(({ ticket }) => ticket), problems: [...unrecorded, ...checked.flatMap(({ problem }) => (problem === null ? [] : [problem]))] };
}

/** One ticket the run made, read back from the tracker, and the problem with it, if it has one. */
async function madeTicket({ settings, source }: PoolContext, key: string): Promise<Readonly<{ ticket: WriterTicket; problem: string | null }>> {
  const unread: WriterTicket = { key, url: null, inPick: false };
  let found;
  try {
    found = await source.read(key);
  } catch (err) {
    return { ticket: unread, problem: `${key} could not be read from the tracker: ${messageOf(err).split("\n")[0]}` };
  }
  if (found === null) return { ticket: unread, problem: `${key} is not in the tracker` };
  const ticket: WriterTicket = { key, url: found.url, inPick: inPickScope(settings.pick, found) };
  if (settings.plan !== null && !hasPlan(found, new RegExp(settings.plan))) return { ticket, problem: `${key} has no plan attached` };
  return { ticket, problem: null };
}

/**
 * A Grill run's answers, written into the ticket it grilled (A11-134). The ticket is read again, and its description must still be the one the Grill started
 * from: otherwise nothing is written and the run fails with that reason. The answers go under the old text, with the marker of each section they answer, so the
 * ticket can then be queued. The run files no ticket, so it ends with none.
 */
async function settleGrill(ctx: PoolContext, run: WriterRun, place: RunPlace, key: string): Promise<void> {
  const { now, source } = ctx;
  if (run.ticket !== key) return endWriter(ctx, run, `the outcome names ${key}, which is not the ticket this run grills (${run.ticket ?? "none"})`);
  const answersPath = join(place.dir, DECISIONS_FILE);
  const answers = existsSync(answersPath) ? readFileSync(answersPath, "utf8") : "";
  let fresh: Ticket | null;
  try {
    fresh = await source.read(key);
  } catch (err) {
    return endWriter(ctx, run, `${key} could not be read from the tracker: ${messageOf(err).split("\n")[0]}`);
  }
  if (fresh === null) return endWriter(ctx, run, `${key} is not in the tracker`);
  const needed = sectionsNeeded(fresh);
  // Settled already, by an edit made while the Grill ran: nothing is left to write, and the run ends with none.
  if (needed.length === 0) {
    if (!writerAgentRunning(ctx, run.id)) return;
    closeWriter(ctx, run);
    return update(ctx, (queue) => writerEnded(queue, run.id, { tickets: [] }, now()));
  }
  const missing = needed.filter((section) => !new RegExp(`^## ${section}\\s*$`, "m").test(answers));
  if (missing.length > 0) return endWriter(ctx, run, `${DECISIONS_FILE} has no ${missing.map((section) => `## ${section}`).join(" or ")} section, which ${key} still needs`);
  if (run.startedFrom === undefined || fresh.description !== run.startedFrom) return endWriter(ctx, run, `${key} changed while it was grilled, so nothing was written: Grill it again`);
  if (source.updateTicketText === undefined) return endWriter(ctx, run, `this tracker cannot edit ${key}'s text`);
  if (!writerAgentRunning(ctx, run.id)) return;
  await source.updateTicketText(key, { description: settledDescription(fresh.description, answers) });
  closeWriter(ctx, run);
  update(ctx, (queue) => writerEnded(queue, run.id, { tickets: [] }, now()));
}

/**
 * A grill run's `needs-human` is its question, not a failure (A11-129): the run waits for the person to answer in its terminal, with the reason as the
 * question. The question is written beside the outcome and the outcome moved aside, so the answer is not met by the same outcome read again.
 */
function askPerson(ctx: PoolContext, run: WriterRun, place: RunPlace, reason: string): void {
  const { now } = ctx;
  if (!writerAgentRunning(ctx, run.id)) return;
  const question = reason.slice(0, QUESTION_CHARS);
  writeFileSync(join(place.dir, WAITING_FILE), `${JSON.stringify({ question, at: now() })}\n`);
  renameSync(join(place.dir, OUTCOME_FILE), join(place.dir, ASKED_FILE));
  update(ctx, (queue) => writerWaiting(queue, run.id, question, now()));
}

/** Close a new-ticket run's workspace, and forget its run. */
function closeWriter(ctx: PoolContext, run: WriterRun): void {
  const { herdr, session } = ctx;
  const { name } = writerPlace(ctx, run);
  if (run.workspace) closedNote((args) => herdr(args), run.workspace, session);
  forgetRun(ctx, name);
}

/**
 * The tickets a run's record holds, for a run that ends without its outcome read (A11-135): the agent filed them before it ended, so they are shown as
 * made. No tracker call is made on this path, so each is shown by key, without its address, and without a Pick claim (`inPick` is null). A record that
 * cannot be read is named as the problem, since the tickets it made cannot then be shown.
 */
export function filedOf(ctx: PoolContext, run: WriterRun): Readonly<{ tickets: WriterTicket[]; problem: string | null }> {
  const keys = readCreatedKeys(writerPlace(ctx, run).dir);
  if (keys === null) return { tickets: [], problem: `${CREATED_FILE} cannot be read, so the tickets it filed cannot be shown` };
  return { tickets: keys.map((key) => ({ key, url: null, inPick: null })), problem: null };
}

/** Close a new-ticket run's workspace and record why it failed. The tickets it filed before it failed stay, and are shown. */
export function endWriter(ctx: PoolContext, run: WriterRun, failure: string): void {
  const { now } = ctx;
  if (!writerAgentRunning(ctx, run.id)) return;
  const filed = filedOf(ctx, run);
  closeWriter(ctx, run);
  update(ctx, (queue) => writerEnded(queue, run.id, { tickets: filed.tickets, failure: joined(failure, filed.problem) }, now()));
}

/** Close the publish run's workspace and record how it ended: each of its runs Published, or why it failed. */
export function endPublish(ctx: PoolContext, publish: PublishRun, result: Readonly<{ links: readonly string[] } | { failure: string }>): void {
  const { herdr, now, session } = ctx;
  const { name } = publishPlace(ctx, publish);
  if (publish.workspace) closedNote((args) => herdr(args), publish.workspace, session);
  forgetRun(ctx, name);
  update(ctx, (queue) => ("links" in result ? publishDone(queue, result.links, now()) : publishFailed(queue, result.failure, now())));
}
