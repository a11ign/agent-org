// @ts-check
// module: the instance's queue as the install side reads it -- the host file's ticket settings, the queue file they name, and how many runs are live (A11-90, A11-169)
//
// `update`, `start herdr` and `doctor` read the queue FILE: the instance is its one writer and they only look. A host file or queue that cannot be read is null, never zero: a caller that
// needs to be sure (the drain) treats null as "unknown" and a caller that must not be held back by it (a machine with no host file) treats it as nothing live.
import { join } from "node:path";
import { liveRunCount, type Queue } from "../ticket-mode/queue/queue-entries-and-outcomes.ts";
import { loadQueue } from "../ticket-mode/queue.ts";
import { HOST_FILE_ENV, readTicketSettings, type TicketSettings } from "../ticket-mode/settings.ts";
import { hostFilePath } from "./paths.ts";

/** The host file's ticket settings, or null when they cannot be read. */
export function hostSettings(env: NodeJS.ProcessEnv = process.env): TicketSettings | null {
  try {
    return readTicketSettings({ ...env, [HOST_FILE_ENV]: hostFilePath(env) });
  } catch {
    return null;
  }
}

/** The queue file the settings name. */
export const queueFileOf = (settings: Pick<TicketSettings, "stateDir">): string => join(settings.stateDir, "tickets", "queue.json");

/** The instance's queue, from the state directory the host file names, or null when that cannot be read. */
export function readQueue(env: NodeJS.ProcessEnv = process.env): Queue | null {
  const settings = hostSettings(env);
  if (settings === null) return null;
  try {
    return loadQueue(queueFileOf(settings), settings.max);
  } catch {
    return null;
  }
}

/**
 * The instance's live runs, from its queue file in the state directory the host file names. Null when there is no host file or it holds no
 * ticket settings: that machine's update is not held back by a queue it cannot read.
 */
export function readLiveRuns(env: NodeJS.ProcessEnv = process.env): number | null {
  const queue = readQueue(env);
  return queue === null ? null : liveRunCount(queue);
}
