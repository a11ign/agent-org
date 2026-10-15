/**
 * (agent-org#1240) PACING THE GATE'S GRAPHQL SPEND, AND READING THE OTHER REPOSITORIES ON A WEBHOOK TICK ONLY WHERE THE EVENTS NAMED THEM.
 *
 * ONE FLAG, DEFAULT OFF: the machinery flag `gate.graphqlPacing` in `machinery-canary.json`, switched by `machinery:flag` (the canary turns it off
 * on a degraded signal). Off IS the current behaviour, and switching it off is the revert (named in the PR). Flag on, the gate reads the GraphQL pool off the probe it already makes, and when fewer than
 * {@link GRAPHQL_RESERVE} points are left it skips `orgHealth` FIRST, because a reviewer order for a settled-green pull request in another repository
 * is the cheapest read it makes and the other repositories are where those orders come from (agent-org#1417). Below {@link GRAPHQL_FLOOR} it skips the
 * other repositories' lanes too. A skipped lane is REPORTED unread, never clean (`unreadLanes`). A pool that cannot be read is NOT below the reserve:
 * the reads then fail on their own and are reported as they are.
 *
 * Flag on AND a webhook tick, the primary's tracker lanes and `orgHealth` are read only when the event queue (`A11Y_TICK_SCOPES_FILE`) names the
 * home repository, or when the home's last whole read is older than {@link GRAPHQL_SWEEP_MINUTES} (`primaryDue`). The other repositories are read
 * only when the event queue names their repository, or when their last whole read is older than {@link GRAPHQL_SWEEP_MINUTES}. A repository an event
 * gate drops is REPORTED unread (`unreadScopes`), never clean. A missing or malformed event file reads them all, as a poll tick does.
 *
 * THE CLOCK IS AN ARGUMENT, never read here, so the rules are pinned without waiting for one.
 */
import { readFileSync, renameSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { GRAPHQL_POOL_PROBE, poolFromHeaders } from "../api-pool.ts";
import { machineryFlagOn, type CanaryState } from "../org-health.ts";
import type { Scope as TickScope } from "../event-queue.ts";
import type { Scope } from "./vocabulary.ts";
import { readReenqueueState } from "./causes/pr-ejected.ts";

export const PACING_FLAG = "gate.graphqlPacing";

/** The points the gate keeps back from the GraphQL pool. Below this, `orgHealth` is skipped (not the primary's reads). */
export const GRAPHQL_RESERVE = 1000;

/**
 * Below this, the other repositories' lanes are skipped too. Between it and the reserve they are still read, so a settled-green pull request in
 * another repository still gets its reviewer order (agent-org#1417). The value is a judgement, not a measurement: half the reserve, so the other
 * repositories' reads cannot take the pool down to the reserve in one tick. Not measured against what one tick's reads cost.
 */
export const GRAPHQL_FLOOR = 500;

/** The longest a repository's lanes may go unread on a webhook tick: the sweep that catches what no event named. */
export const GRAPHQL_SWEEP_MINUTES = 15;

/** Where each other repository's last whole read is remembered, so a webhook tick knows which are due a sweep. */
export const OTHER_SCOPES_MEMORY = "other-scopes-memory.json";

const VERSION = 1;
const SWEEP_MS = GRAPHQL_SWEEP_MINUTES * 60_000;

/**
 * Whether the flag is on, read from the canary state the readers read (`machinery-canary.json`). An unreadable state is OFF, which is the current
 * behaviour. `read` is the state; a test passes one, so the answer does not move with the host's state directory.
 */
export function pacingOn(read: () => CanaryState = () => readReenqueueState()): boolean {
  try {
    return machineryFlagOn(read(), PACING_FLAG);
  } catch {
    return false;
  }
}

/**
 * `paced`: below the reserve, `orgHealth` is skipped. `belowFloor`: below {@link GRAPHQL_FLOOR} as well, the other repositories' lanes are skipped
 * (so `belowFloor` implies `paced`). The two are separate because the chairman's order is `orgHealth` first and the other repositories only later.
 */
export type Pacing = { paced: boolean; belowFloor: boolean; remaining: number | null; };

/**
 * The pool this tick has left, and whether it is below the reserve and below the floor. Flag off: nothing is read and nothing is paced. A probe that
 * cannot be read gives `remaining: null` and is NOT paced, because the reads it would have skipped are then refused on their own and reported.
 */
export function pacingNow(run: (args: string[]) => string, on: boolean = pacingOn()): Pacing {
  if (!on) return { paced: false, belowFloor: false, remaining: null };
  let remaining: number | null = null;
  try {
    remaining = poolFromHeaders([...GRAPHQL_POOL_PROBE], run)?.remaining ?? null;
  } catch {
    remaining = null;
  }
  return { paced: remaining !== null && remaining < GRAPHQL_RESERVE, belowFloor: remaining !== null && remaining < GRAPHQL_FLOOR, remaining };
}

/**
 * The lanes a paced tick did NOT read, named for `unreadLanes`. The other repositories' lanes are named only below the floor, because between the floor
 * and the reserve they are read. `others` says whether the declaration has other repositories at all, so a one-project host is never told it could not
 * read repositories it does not have.
 */
export function pacedUnread(pacing: Pacing, others: boolean): string[] {
  if (!pacing.paced) return [];
  return [...(others && pacing.belowFloor ? ["the other repositories' lanes"] : []), "the org-health reads"];
}

/**
 * The lanes an event-gated tick did NOT read, named for `unreadLanes`: the primary's tracker lanes when `primaryRead` is false, and the org-health
 * reads with them unless the pool already named those (`pacedUnread`). Nothing when the primary was read.
 */
export function primaryUnread(pacing: Pacing, primaryRead: boolean): string[] {
  if (primaryRead) return [];
  return ["the primary's tracker lanes (promotable rows, chairman-blocked rows, open rows)", ...(pacing.paced ? [] : ["the org-health reads"])];
}

/**
 * (agent-org#1401) The primary's tracker lanes that were ASKED and REFUSED this tick, named for `unreadLanes` the way every refused read is. A lane the pacing
 * skipped is `primaryUnread`'s, and a `null` from a skipped primary is not a refusal: nothing was asked, so nothing was refused. Nothing when the primary was not read.
 */
export function primaryRefusedLanes(lanes: { promotableRows: unknown; chairmanBlocked: unknown; openRowsRead: unknown; }, primaryRead: boolean): string[] {
  if (!primaryRead) return [];
  return [...(lanes.promotableRows === null ? ["the promotable rows"] : []), ...(lanes.chairmanBlocked === null ? ["the chairman-blocked rows"] : []),
    ...(lanes.openRowsRead === null ? ["the open rows"] : [])];
}

/** `orgHealth` is skipped below the reserve, and on an event-gated tick whose primary lanes were not read (`primaryDue`). */
export function orgHealthSkipped(pacing: Pacing, primaryRead: boolean): boolean {
  return pacing.paced || !primaryRead;
}

/**
 * The other repositories to read this tick. `named` is what the event queue named: `null` (not known, or the file is unreadable) reads them
 * all, and `[]` names nothing. A repository is read when an event named it, or when it has never been read or was last read a sweep ago.
 */
export function scopesToRead({ scopes, named, lastReadAt, nowMs }: { scopes: readonly Scope[]; named: readonly TickScope[] | null; lastReadAt: Readonly<Record<string, number>>; nowMs: number; }): Scope[] {
  if (named === null) return [...scopes];
  const repos = new Set(named.map((scope) => scope.repo));
  return scopes.filter((scope) => {
    const touched = [scope.code?.repo, scope.tracker?.repo].some((repo) => repo !== undefined && repos.has(repo));
    const last = lastReadAt[scope.key];
    const due = typeof last !== "number" || nowMs - last >= SWEEP_MS;
    return touched || due;
  });
}

/** Each repository's last whole read, by key. A file that cannot be read is `{}`: every repository is then due, which reads whole. */
export function readOtherScopesMemory(path: string): Record<string, number> {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (parsed?.version !== VERSION || typeof parsed.readAtMs !== "object" || parsed.readAtMs === null) return {};
    return Object.fromEntries(Object.entries(parsed.readAtMs as Record<string, unknown>).filter((entry): entry is [string, number] => typeof entry[1] === "number" && Number.isFinite(entry[1])));
  } catch {
    return {};
  }
}

/**
 * Stamps `keys` as read at `nowMs` and keeps every other key's stamp. Written whole to a sibling and renamed over, so a reader sees the old file
 * or the new one. Throws on a disk that refuses the write: the caller says so, and the next webhook tick then finds the repositories due.
 */
export function rememberOtherScopes({ path, keys, nowMs }: { path: string; keys: readonly string[]; nowMs: number; }): void {
  const readAtMs = { ...readOtherScopesMemory(path) };
  for (const key of keys) readAtMs[key] = nowMs;
  mkdirSync(dirname(path), { recursive: true });
  const partial = `${path}.${process.pid}.tmp`;
  writeFileSync(partial, `${JSON.stringify({ version: VERSION, readAtMs })}\n`);
  renameSync(partial, path);
}
