#!/usr/bin/env node
// @ts-check
// module: the status file `update` writes and `doctor` reads (A11-90, A11-169)
//
// AN UPDATE NO LONGER WAITS FOR A QUIET MOMENT. herdr runs in a service of its own and each run is pinned to the version it started on, so swapping `current` and restarting the instance and ui
// touches no worker (A11-169); a BREAKING release drains instead (`update-drain.ts`). What stays is the record of what the last run saw, so `doctor` can say how far behind the install is,
// and since when, without the network. Where the file cannot be read it is `unreadable`, and `unreadable` is never read as clean.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { agentOrgHome, type Env } from "./paths.ts";
import { writeAtomic } from "./write-atomic.ts";

export const HOUR_MS = 3600e3;

/** What `update` last saw, for `doctor` to say how far behind the install is, and since when, without the network. */
export type UpdateStatus = Readonly<{
  checkedAt: string;
  channel: "release" | "main";
  /** The version `current` names (`v0.273.0`, or `main-<sha>`), or the checkout's release tag or short commit before the install has migrated. */
  installed: string;
  /** The newest release tag, or `main` on the main channel. */
  latest: string;
  /** When `latest` was cut: its commit's date. */
  latestSince: string;
}>;

export const updateStatusPath = (env: Env, home: string): string => join(agentOrgHome(env, home), "update-status.json");

/**
 * What the status file holds: nothing yet (`absent`), a status, or a file that cannot be read or is not a status (`unreadable`). The last is never
 * read as clean: `doctor` fails on it, and the run that reads it writes the file again.
 */
export type StatusFile = { kind: "absent" } | { kind: "unreadable"; why: string } | { kind: "status"; status: UpdateStatus };

/** The status file's text, or null when there is no file. Any other read failure throws: a file that cannot be read is not an absent one. */
export function readStatusText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export function readUpdateStatus(path: string, read: (path: string) => string | null = readStatusText): StatusFile {
  let text: string | null;
  try {
    text = read(path);
  } catch (err) {
    return { kind: "unreadable", why: (err as Error).message };
  }
  if (text === null) return { kind: "absent" };
  let status: UpdateStatus | null;
  try {
    status = parseStatus(JSON.parse(text));
  } catch {
    return { kind: "unreadable", why: "it is not valid JSON" };
  }
  return status === null ? { kind: "unreadable", why: "it is not an update status" } : { kind: "status", status };
}

function parseStatus(value: unknown): UpdateStatus | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  const text = (key: string): string | undefined => (typeof v[key] === "string" ? v[key] : undefined);
  const checkedAt = text("checkedAt");
  const installed = text("installed");
  const latest = text("latest");
  const latestSince = text("latestSince");
  const isUnknownState = checkedAt === undefined || installed === undefined || latest === undefined || latestSince === undefined;
  if (isUnknownState) return null;
  if (v.channel !== "release" && v.channel !== "main") return null;
  return { checkedAt, channel: v.channel, installed, latest, latestSince };
}

/** Writes the status file whole, through a temporary file, as the other files the install owns are written. */
export function writeUpdateStatus(path: string, status: UpdateStatus): void {
  writeAtomic(path, `${JSON.stringify(status, null, 2)}\n`, 0o644);
}
