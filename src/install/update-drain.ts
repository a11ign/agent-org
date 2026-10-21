// @ts-check
// module: the record of a BREAKING update that is draining (A11-169) -- written by `update`, acted on by the instance, deleted by `update` once it has applied
//
// A breaking release (its changeset's first line starts `Breaking:`) does not swap while runs are live. `update` builds the version folder and writes this file; the instance, which owns its
// queue, starts no run and no round while it exists, stops and re-queues the live runs once `deadline` has passed, and starts the auto-update service so the swap follows at once. `update`
// swaps, restarts and deletes the file when the queue holds no live run. The board reads the file for its banner.
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { agentOrgHome, type Env } from "./paths.ts";
import { writeAtomic } from "./write-atomic.ts";

export type DrainRecord = Readonly<{
  /** The release being waited for, `v0.280.0`. */
  target: string;
  /** When the drain began, ISO. */
  since: string;
  /** `since` + `tickets.updateMaxDeferHours`, ISO: the live runs are stopped and re-queued once it has passed. */
  deadline: string;
  /** Set by the instance when it stopped and re-queued the live runs at the deadline, ISO. */
  forcedAt?: string;
  /** The keys of the runs it stopped, set with `forcedAt`. */
  stopped: readonly string[];
}>;

export const drainPath = (env: Env, home: string): string => join(agentOrgHome(env, home), "update-drain.json");

/** What the file holds: no drain, a drain, or a file that cannot be read (never taken for no drain: a corrupt file must not let runs start during an update). */
export type Drain = Readonly<{ kind: "none" }> | Readonly<{ kind: "draining"; record: DrainRecord }> | Readonly<{ kind: "unreadable"; why: string }>;

const isText = (value: unknown): value is string => typeof value === "string" && !Number.isNaN(Date.parse(value));

/** The record a parsed value holds, or null when it is not one. */
function recordOf(value: unknown): DrainRecord | null {
  if (typeof value !== "object" || value === null) return null;
  const { target, since, deadline, forcedAt, stopped } = value as Record<string, unknown>;
  const keys = Array.isArray(stopped) && stopped.every((key) => typeof key === "string") ? stopped as string[] : null;
  const readable = typeof target === "string" && isText(since) && isText(deadline) && keys !== null;
  if (!readable || (forcedAt !== undefined && !isText(forcedAt))) return null;
  return { target, since, deadline, stopped: keys, ...(forcedAt === undefined ? {} : { forcedAt }) };
}

export function readDrain(path: string): Drain {
  if (!existsSync(path)) return { kind: "none" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    return { kind: "unreadable", why: `${path} cannot be read: ${(err as Error).message}` };
  }
  const record = recordOf(parsed);
  return record === null ? { kind: "unreadable", why: `${path} does not hold a target, a start, a deadline and the runs stopped` } : { kind: "draining", record };
}

export const writeDrain = (path: string, record: DrainRecord): void => writeAtomic(path, `${JSON.stringify(record, null, 2)}\n`, 0o644);

export const clearDrain = (path: string): void => rmSync(path, { force: true });
