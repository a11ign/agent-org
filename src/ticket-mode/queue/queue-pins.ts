// @ts-check
// module: the copy of agent-org a run holds (A11-169) -- what is recorded on an entry when it starts, which version folders the queue keeps, and a run stopped for a breaking update

import { find, isLive, LIVE, writerLive, type Entry, type Queue } from "./queue-entries-and-outcomes.ts";
import { logEvent, type RequeueWhy } from "./run-log.ts";

/**
 * The copy of agent-org a run was prepared with (A11-169): the version folder its hooks and brief commands name (`toolRoot`, the real `<tool>/versions/<tag>` path) and that folder's
 * version (`toolVersion`). Recorded when a run or a round starts, so an update that moves `current` leaves it on the copy it began with, and the folder is kept until no live or parked run names it.
 */
export type ToolPin = Readonly<{ toolVersion?: string; toolRoot: string }>;

/** A conventions plugin's install as a run's session got it (A11-169): its files' folder and the commit it was installed at, so `doctor` can say a refresh rewrote the folder under the run. */
export type PluginCopy = Readonly<{ plugin: string; path: string; commit: string | null }>;

/** Set on a run the board stopped and re-queued for a breaking update (A11-169): when, and the release it waits for. Dropped when its round starts. */
export type StoppedForUpdate = Readonly<{ at: number; target: string }>;

/**
 * The version folders the queue's runs hold (A11-169): those of every entry that is live or still has a workspace (a parked run is answered in its old settings), of the live publish run, and of the live
 * new-ticket runs, each once. `update` keeps a folder in this list. PURE.
 */
export function toolRootsInUse(queue: Queue): string[] {
  const held = queue.entries.filter((entry) => isLive(entry) || entry.workspace !== undefined).map((entry) => entry.toolRoot);
  const publish = queue.publish !== undefined && (LIVE.has(queue.publish.phase) || queue.publish.workspace !== undefined) ? [queue.publish.toolRoot] : [];
  const writers = (queue.writers ?? []).filter((run) => writerLive(run) || run.workspace !== undefined).map((run) => run.toolRoot);
  return [...new Set([...held, ...publish, ...writers].filter((root): root is string => root !== undefined))];
}

/** A run `doctor` lists with the copy of agent-org it was started on. */
export type RunVersion = Readonly<{ key: string; toolVersion: string | null; toolRoot: string | null; pluginCopy: readonly PluginCopy[] }>;

/**
 * Each live or parked run with the version it holds (A11-169): a batch's tickets share one run and are listed once, as the first ticket of the batch. A run recorded before pins existed has no version. PURE.
 */
export function runVersions(queue: Queue): RunVersion[] {
  const seen = new Set<string>();
  return queue.entries.filter((entry) => isLive(entry) || entry.workspace !== undefined).flatMap((entry): RunVersion[] => {
    const run = entry.batch === undefined ? `ticket:${entry.ticket.key}` : `batch:${entry.batch}`;
    if (seen.has(run)) return [];
    seen.add(run);
    return [{ key: entry.ticket.key, toolVersion: entry.toolVersion ?? null, toolRoot: entry.toolRoot ?? null, pluginCopy: entry.pluginCopy ?? [] }];
  });
}

/**
 * The copy of agent-org a run is started with (A11-169): its hooks and commands are written naming `pin.toolRoot`, so that is what the entry records, for each of `keys` (a batch's tickets
 * share one run). It replaces an earlier run's pin, since a new round is a new start. A run that is not starting is left alone, so an answered park or a talk session keeps what it had.
 */
export function recordToolPin(queue: Queue, keys: readonly string[], pin: ToolPin): Queue {
  const { toolVersion, toolRoot } = pin;
  return { ...queue, entries: queue.entries.map((entry) => {
    if (!keys.includes(entry.ticket.key) || entry.phase !== "starting") return entry;
    const { toolVersion: _earlier, ...rest } = entry;
    return { ...rest, toolRoot, ...(toolVersion === undefined ? {} : { toolVersion }) };
  }) };
}

/** The copy of agent-org the publish run is started with (A11-169), recorded as {@link recordToolPin} records a ticket run's. */
export const recordPublishPin = (queue: Queue, pin: ToolPin): Queue =>
  (queue.publish === undefined ? queue : { ...queue, publish: { ...queue.publish, toolRoot: pin.toolRoot, ...(pin.toolVersion === undefined ? {} : { toolVersion: pin.toolVersion }) } });

/** The plugins' installs a starting run's session got, for each of `keys` (A11-169). An empty list records nothing. */
export function recordPluginCopy(queue: Queue, keys: readonly string[], copies: readonly PluginCopy[]): Queue {
  if (copies.length === 0) return queue;
  return { ...queue, entries: queue.entries.map((entry) => (keys.includes(entry.ticket.key) && entry.phase === "starting" ? { ...entry, pluginCopy: copies } : entry)) };
}

/** What a stopped run drops when it is queued again: what its live agent held, its idle clock and the board's resume of it among them (A11-279). */
const runtimeFields = ["workspace", "pane", "startedAt", "finishedAt", "seenWorking", "waiting", "prompt", "declined", "working", "lastTerminal", "sessionWait", "sessionNote", "outcome", "tokens", "idleSince", "resume"] as const;

/**
 * Why the board stopped a live run, and what the entry it queues again records of it: `record` is set on it, each field `drops` names goes with what its live agent held, and `session` is the Claude session its
 * agent had, when the pool learned it.
 */
type Stop = Readonly<{ why: RequeueWhy; record: Partial<Entry>; drops?: readonly (keyof Entry)[]; session?: string }>;

/**
 * A live run the board stopped is queued again where it was (A11-169, A11-272): the same ticket, plan, review round, branch records and worktrees, without what its live agent held, with `session` as the Claude
 * session its next round resumes and `record` saying why. It goes to the end of the queue, as a retry does, and the log says why it was queued again. Only a live entry is changed. PURE.
 */
export function requeueStopped(queue: Queue, key: string, now: number, { why, record, drops = [], session }: Stop): Queue {
  const entry = find(queue, key);
  if (entry === undefined || !isLive(entry)) return queue;
  const kept: Record<string, unknown> = { ...entry };
  for (const field of [...runtimeFields, ...drops]) delete kept[field];
  const requeued = { ...kept, ...(session !== undefined ? { session } : {}), ...record, phase: "queued", queuedAt: now } as Entry;
  return logEvent({ ...queue, entries: queue.entries.map((e) => (e.ticket.key === key ? requeued : e)) }, key, now, { kind: "requeued", why });
}

/** A live run is stopped for a breaking update and queued again (A11-169), with `stoppedForUpdate` saying when and for which release: see {@link requeueStopped}. PURE. */
export const requeueForUpdate = (queue: Queue, key: string, target: string, now: number, session?: string): Queue =>
  requeueStopped(queue, key, now, { why: "update", record: { stoppedForUpdate: { at: now, target } }, session });
