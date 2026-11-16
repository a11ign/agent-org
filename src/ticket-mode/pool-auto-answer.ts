// @ts-check
// module: a run's question answered automatically before it is parked for a person (A11-438) -- the pool's half of the answerer (`auto-answer.ts`)
//
// THE RUN IS HELD, NOT PARKED, WHILE THE MODEL IS ASKED. A worker that ends `needs-human` on a question the answerer may take ({@link mayAnswer}) stays running, held in `attaching` so a tick that reads the same outcome
// file meanwhile asks nothing twice, and nothing is counted or shown as Needs you. An answer at the threshold is sent to the run's agent, its outcome file is marked stale (the stop hook then asks for a new one), and the
// answer is recorded on the run with its sources, which counts it in the day's tally apart from a person's answers. Anything else (no answer, one under the threshold, a model that fails or a message herdr refuses) parks
// the run for a person exactly as before, and the board's log says why. A run stopped or started again while the model was asked is left as the person left it.
import { statSync } from "node:fs";
import { join } from "node:path";
import { answerPrompt, askClaude, decide, messageOf, sourcesFor, UnreadableSource, type Decided, type Source } from "./auto-answer.ts";
import { HERDR_CALL_MS, herdrRefusal } from "./pool-herdr.ts";
import { type PoolContext } from "./pool-context.ts";
import { markOutcomeStale } from "./pool-outcome.ts";
import { agentTargetAsync } from "./pool-resume.ts";
import { log, messageOf as errorOf, runPlace, sameRun, update } from "./pool-state.ts";
import { type Entry, type Outcome } from "./queue/queue-entries-and-outcomes.ts";
import { recordAutoAnswer } from "./queue/queue-answer.ts";
import type { Ticket } from "./source.ts";
import { OUTCOME_FILE } from "./worker-files.ts";

/** A ticket read fresh from the tracker. Throws {@link UnreadableSource} when the tracker has no such ticket or cannot give it: the answerer never answers from the run's older copy. */
async function readFresh(ctx: PoolContext, key: string, what: string): Promise<Ticket> {
  let read: Ticket | null;
  try {
    read = await ctx.source.read(key);
  } catch (err) {
    throw new UnreadableSource(`${what} ${key} could not be read fresh (${errorOf(err).split("\n")[0]})`);
  }
  if (read === null) throw new UnreadableSource(`the tracker has no ${what} ${key}`);
  return read;
}

/** The run with its ticket read fresh (the text the question is asked against, and its parent's key), and that parent when it names one. Throws {@link UnreadableSource} when either cannot be read. */
async function ticketsOf(ctx: PoolContext, entry: Entry): Promise<Readonly<{ run: Entry; parent: Readonly<{ key: string; description: string; url: string }> | null }>> {
  const fresh = await readFresh(ctx, entry.ticket.key, "the ticket");
  const run = { ...entry, ticket: { ...entry.ticket, description: fresh.description, ...(fresh.parent ? { parent: fresh.parent } : {}) } };
  if (!run.ticket.parent) return { run, parent: null };
  const parent = await readFresh(ctx, run.ticket.parent, "the parent ticket");
  return { run, parent: { key: parent.key, description: parent.description, url: parent.url } };
}

/** The sources for `entry`'s run, or the question parked because one of them could not be read. Any other failure is thrown. */
async function sourcesOf(ctx: PoolContext, entry: Entry): Promise<Readonly<{ sources: readonly Source[] }> | Extract<Decided, { parked: string }>> {
  const { dir, folder } = runPlace(ctx, entry);
  try {
    const { run, parent } = await ticketsOf(ctx, entry);
    return { sources: sourcesFor({ entry: run, parent, ticketDir: dir, folder, others: ctx.store.get().entries }) };
  } catch (err) {
    if (err instanceof UnreadableSource) return { parked: `a source could not be read, so the answer would rest on part of them: ${err.message}` };
    throw err;
  }
}

/**
 * Ask the answerer `question` for `entry`'s run, from the sources it reads, and decide at the machine's threshold. A source that cannot be read, or a model that cannot be asked, parks the question, saying why (A11-438:
 * an answer is never made from a part of the sources, nor from the run's older copy of its ticket).
 */
async function ask(ctx: PoolContext, entry: Entry, question: string): Promise<Decided> {
  const { threshold = 1, model = "haiku" } = ctx.settings.autoAnswer ?? {};
  const read = await sourcesOf(ctx, entry);
  if ("parked" in read) return read;
  const { sources } = read;
  try {
    return decide(await (ctx.deps.answerer ?? askClaude)(answerPrompt(question, sources), model), sources, threshold);
  } catch (err) {
    return { parked: `the answerer could not be asked (${errorOf(err).split("\n")[0]})` };
  }
}

/** When the outcome file in `dir` was written, or `fallback` when it is gone. */
function writtenAt(dir: string, fallback: number): number {
  try {
    return statSync(join(dir, OUTCOME_FILE)).mtimeMs;
  } catch {
    return fallback;
  }
}

/** The run as the queue holds it now, or `entry` when it is gone. */
const latest = (ctx: PoolContext, entry: Entry): Entry => ctx.store.get().entries.find((each) => each.ticket.key === entry.ticket.key) ?? entry;

/**
 * Try to answer `outcome`'s question on `entry`'s run before it is parked for a person. `park` ends the run as the board always has: it is called when the answerer gives no answer at the threshold, or when the answer
 * cannot be sent. Does nothing while the same run is already being answered.
 */
export async function answerBeforeParking(ctx: PoolContext, entry: Entry, outcome: Extract<Outcome, { kind: "needs-human" }>, park: (entry: Entry) => void): Promise<void> {
  const { attaching, herdrCall, now, settings } = ctx;
  const place = runPlace(ctx, entry);
  if (attaching.has(place.name)) return;
  attaching.add(place.name);
  try {
    const question = outcome.reason.trim();
    const decided = await ask(ctx, entry, question);
    // Stopped, retried or started again while the model was asked: the person's last word stands.
    if (!sameRun(ctx, entry)) return;
    if ("parked" in decided) {
      log(`${entry.ticket.key}: not answered automatically, so it waits on a person: ${decided.parked}`);
      return park(latest(ctx, entry));
    }
    try {
      await herdrCall(["--session", settings.herdrSession, "agent", "prompt", await agentTargetAsync(ctx, place), messageOf(question, decided.answered)], HERDR_CALL_MS);
    } catch (err) {
      log(`${entry.ticket.key}: its automatic answer could not be sent (${herdrRefusal(err)}), so it waits on a person`);
      return park(latest(ctx, entry));
    }
    // The file the run asked in is its old outcome now: the stop hook asks for a new one, and the watch does not read this one again.
    markOutcomeStale(place.dir, writtenAt(place.dir, now()));
    update(ctx, (queue) => recordAutoAnswer(queue, entry.ticket.key, { question, ...decided.answered, at: now() }));
  } finally {
    attaching.delete(place.name);
  }
}
