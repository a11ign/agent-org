// @ts-check
// module: the runs the board starts for itself -- how a new-ticket run and a publish run finish

import { type DraftRecord, type PublishRun, type WriterRun } from "./queue/declared-remains.ts";
import { type RunPlace } from "./pool-paths.ts";
import { newDraftId, parseWriterOutcome, readDrafts, resolveDuplicates } from "./writer.ts";
import { createDrafts } from "./writer-create.ts";
import { forgetRun, messageOf, publishPlace, update, writerPlace, writerAgentRunning } from "./pool-state.ts";
import { writerDrafted, writerFailed, writerOf } from "./queue.ts";
import { QUESTION_CHARS } from "./pool-outcome.ts";
import { closedNote } from "../herdr-agents.ts";
import { publishDone, publishFailed } from "./queue/approve.ts";
import { type PoolContext } from "./pool-context.ts";

/**
 * The run's outcome, read once its agent is idle. `needs-human` ends the run failed, with its reason. `drafted` reads each draft file, resolves its duplicates
 * in the tracker, and makes each draft's ticket (`createDrafts`), then ends the run. Its workspace is closed once its drafts are read.
 */
export async function finishWriter(ctx: PoolContext, run: WriterRun, place: RunPlace, text: string): Promise<void> {
  const { finishing, herdr, now, session, settings, source, store } = ctx;
  finishing.add(run.id);
  try {
    const outcome = parseWriterOutcome(text);
    if (typeof outcome === "string") return endWriter(ctx, run, outcome);
    if (outcome.kind === "needs-human") return endWriter(ctx, run, outcome.reason.slice(0, QUESTION_CHARS));
    const read = readDrafts(place.dir, Object.keys(settings.clones));
    const drafts = await Promise.all(read.drafts.map(async ({ file, draft }): Promise<DraftRecord> => ({
      id: newDraftId(), file, draft, duplicates: await resolveDuplicates(draft.duplicates, (key) => source.read(key)), status: "creating",
    })));
    if (!writerAgentRunning(ctx, run.id)) return;
    if (run.workspace) closedNote((args) => herdr(args), run.workspace, session);
    update(ctx, (queue) => writerDrafted(queue, run.id, { drafts, rejected: read.rejected }, now()));
    if (writerOf(store.get(), run.id)?.phase === "creating") await createDrafts(ctx, run.id);
  } catch (err) {
    endWriter(ctx, run, messageOf(err).split("\n")[0]);
  } finally {
    finishing.delete(run.id);
  }
}

/** Close a new-ticket run's workspace and record why it failed. Nothing it wrote is kept as a draft. */
export function endWriter(ctx: PoolContext, run: WriterRun, failure: string): void {
  const { herdr, now, session } = ctx;
  const { name } = writerPlace(ctx, run);
  if (!writerAgentRunning(ctx, run.id)) return;
  if (run.workspace) closedNote((args) => herdr(args), run.workspace, session);
  forgetRun(ctx, name);
  update(ctx, (queue) => writerFailed(queue, run.id, failure, now()));
}

/** Close the publish run's workspace and record how it ended: each of its runs Published, or why it failed. */
export function endPublish(ctx: PoolContext, publish: PublishRun, result: Readonly<{ links: readonly string[] } | { failure: string }>): void {
  const { herdr, now, session } = ctx;
  const { name } = publishPlace(ctx, publish);
  if (publish.workspace) closedNote((args) => herdr(args), publish.workspace, session);
  forgetRun(ctx, name);
  update(ctx, (queue) => ("links" in result ? publishDone(queue, result.links, now()) : publishFailed(queue, result.failure, now())));
}
