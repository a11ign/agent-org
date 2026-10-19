/**
 * The remembered open-PR list (a11ign/a11ign#5043, design item 3): THE LIST `gh pr list` LAST ANSWERED, KEPT ON DISK SO A TICK CAN PATCH IT FROM
 * THE PULL REQUESTS ITS EVENTS NAMED instead of asking GitHub for all of them. The gate is a fresh process each tick, so the list cannot live in
 * memory (the precedent is `PAGED_FILES_CACHE` in `work-gate.ts`). NOTHING CALLS THIS YET: the wiring is a later row, so this module is pure
 * apart from the one file it is handed and the `view` it is injected with.
 *
 * A PATCH THAT CANNOT BE TRUSTED IS NOT A PATCH. Every way the memory could be wrong returns `whole` with a reason of its own, and the caller reads
 * the whole list: a missing, unreadable or too-old memory, a scope that names no pull request, a `view` that failed. An unreadable file is never an
 * empty list: an empty list would tell the next tick there are no open pull requests.
 *
 * THE CLOCK IS AN ARGUMENT, never read here. A patched list keeps the `readAtMs` of the WHOLE read it came from: it is the age of the last full
 * reconcile, so a run of patches ages out and is read whole, instead of drifting for ever on events that were never delivered.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Scope } from "./event-queue.ts";

/**
 * WHAT `view` MUST ASK FOR is the `--json` list of `openPrsArgs` in `work-gate.ts`, EXACTLY, plus `state`, so a patched entry and a listed one have
 * one shape. The list is not repeated here: the guard of #2956 reads a module that names the check rollup as a reader of red, and a second copy of
 * the list is one more place to forget a field. The wiring row takes it from `openPrsArgs`, which it is editing anyway. `state` is the one addition:
 * `pr list --state open` never needed it, and it is how a view says the pull request left the list. `narrowedPrList` strips it again.
 */

const VERSION = 1;

/** One open pull request as `pr list --json` shaped it. Only `number` is read here; the rest is carried untouched. */
export type PrEntry = { number: number; [field: string]: unknown; };

export type PrListRead =
  | { ok: true; readAtMs: number; prs: PrEntry[]; }
  | { ok: false; reason: "missing" | "unreadable" | "too-old"; detail: string; };

const isEntry = (value: unknown): value is PrEntry => typeof value === "object" && value !== null && !Array.isArray(value) && Number.isInteger((value as PrEntry).number);

/**
 * Stores `prs` as `repo`'s list, read WHOLE at `readAtMs`, and keeps every other repository's. Written whole to a sibling and renamed over, so a
 * reader sees the old file or the new one. A file that cannot be read is started afresh: each repository's list in it is rewritten by its own next
 * whole read. `prs` may be `[]`: a repository with no open pull requests is a list, not a missing one.
 *
 * Throws on an entry with no number and on a disk that refuses the write. It is NOT swallowed, because the file left behind would be the previous
 * list, which reads back as fresh and is missing this tick's patch; the caller decides what a failed remember means.
 */
export function writePrList({ path, repo, prs, readAtMs }: { path: string; repo: string; prs: readonly PrEntry[]; readAtMs: number; }): void {
  const bad = prs.find((pr) => !isEntry(pr));
  if (bad !== undefined) throw new TypeError(`writePrList: not a pull request entry: ${JSON.stringify(bad)}`);
  if (!Number.isFinite(readAtMs)) throw new TypeError(`writePrList: readAtMs ${readAtMs} is not an instant`);
  const repos = readFile(path).repos ?? {};
  repos[repo] = { readAtMs, prs: [...prs] };
  mkdirSync(dirname(path), { recursive: true });
  const partial = `${path}.${process.pid}.tmp`;
  writeFileSync(partial, `${JSON.stringify({ version: VERSION, repos })}\n`);
  renameSync(partial, path);
}

type Stored = Record<string, { readAtMs: number; prs: PrEntry[]; }>;

/** The file's repositories, or why there are none. */
function readFile(path: string): { repos: Stored; error?: undefined; } | { repos?: undefined; error: { reason: "missing" | "unreadable"; detail: string; }; } {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return { error: { reason: code === "ENOENT" ? "missing" : "unreadable", detail: code === "ENOENT" ? "no memory file" : `cannot read: ${(error as Error).message}` } };
  }
  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { error: { reason: "unreadable", detail: `not JSON: ${(error as Error).message}` } };
  }
  const repos = parsed?.repos;
  const isMalformedMemory = parsed?.version !== VERSION || typeof repos !== "object" || repos === null || Array.isArray(repos);
  if (isMalformedMemory) {
    return { error: { reason: "unreadable", detail: `not a version ${VERSION} pr-list memory` } };
  }
  for (const [name, memory] of Object.entries<any>(repos)) {
    if (!Number.isFinite(memory?.readAtMs) || !Array.isArray(memory.prs) || !memory.prs.every(isEntry)) {
      return { error: { reason: "unreadable", detail: `malformed memory for ${name}` } };
    }
  }
  return { repos };
}

/**
 * `repo`'s remembered list and when it was read whole, or the reason there is none: `missing` (no file, or no entry for `repo`), `unreadable`
 * (not JSON, the wrong shape, an instant in the future that says nothing about its age) and `too-old` (read whole more than `maxAgeMs` before
 * `nowMs`; exactly `maxAgeMs` is still young). A damaged file is damaged for every repository in it. Never throws.
 */
export function readPrList({ path, repo, nowMs, maxAgeMs }: { path: string; repo: string; nowMs: number; maxAgeMs: number; }): PrListRead {
  const file = readFile(path);
  if (file.error !== undefined) return { ok: false, ...file.error };
  const memory = Object.hasOwn(file.repos, repo) ? file.repos[repo] : undefined;
  if (memory === undefined) return { ok: false, reason: "missing", detail: `no list remembered for ${repo}` };
  const age = nowMs - memory.readAtMs;
  if (age < 0) return { ok: false, reason: "unreadable", detail: `read at ${memory.readAtMs}, after now (${nowMs}): its age is not known` };
  if (age > maxAgeMs) return { ok: false, reason: "too-old", detail: `read whole ${age} ms ago, more than ${maxAgeMs}` };
  return { ok: true, readAtMs: memory.readAtMs, prs: memory.prs };
}

/** Distinct on purpose: each is a different thing for the wiring to log, and a test pins one case to each. */
export type WholeReason = "missing" | "unreadable" | "too-old" | "unnamed-scope" | "view-failed";

export type NarrowedPrList =
  | {
    mode: "narrowed";
    /** The patched list, newest first, as `pr list` orders it (a pull request's number rises with its creation). */
    prs: PrEntry[];
    /** The whole read's instant: write a patched list back with THIS as `readAtMs`, never the current tick's. */
    readAtMs: number;
    /** The numbers `view` was called for, in call order. */
    viewed: number[];
    /** The numbers carried over from the memory without a call. */
    remembered: number[];
  }
  | { mode: "whole"; reason: WholeReason; detail: string; };

/**
 * `repo`'s open pull requests from the remembered list and the pull requests this tick's events named, or `whole` when the list cannot be patched.
 *
 * WHICH SCOPES NAME A PULL REQUEST, for `repo` only (the scopes of every repository may be handed in):
 * - a `pr` scope, and
 * - an `issue` scope whose number is a remembered pull request: a comment on a pull request arrives as `issue_comment` with the PULL REQUEST'S number
 *   and no mark of what it is, and the entry carries `comments`, so reading it as an issue would leave the comment out of the list;
 * - a `sha` scope equal to a remembered pull request's `headRefOid`.
 * A `sha` scope that matches none, and a `merge-group` scope, name no pull request this list can place, so the answer is `whole`. An `issue` scope
 * that is not a remembered number is an issue and costs nothing.
 *
 * Each named pull request is viewed ONCE: an `OPEN` one replaces its entry (or joins the list), a `MERGED` or `CLOSED` one leaves it. A repository
 * with no such scope returns the memory with ZERO `view` calls. A `view` that throws, or answers something that is not that pull request's state, is
 * `whole`: a patch that failed is not a patch, and the list is not half-applied.
 */
export function narrowedPrList({ repo, memory, scopes, view }: {
  repo: string;
  memory: PrListRead;
  scopes: readonly Scope[];
  view: (number: number) => unknown;
}): NarrowedPrList {
  if (!memory.ok) return { mode: "whole", reason: memory.reason, detail: memory.detail };
  const byNumber = new Map(memory.prs.map((pr) => [pr.number, pr]));
  const named = new Set<number>();
  for (const scope of scopes) {
    if (scope.repo !== repo) continue;
    if ("number" in scope) {
      if (scope.kind === "pr" || byNumber.has(scope.number)) named.add(scope.number);
    } else {
      const head = scope.kind === "sha" ? memory.prs.find((pr) => pr.headRefOid === scope.sha) : undefined;
      if (head === undefined) return { mode: "whole", reason: "unnamed-scope", detail: `${scope.kind} ${scope.sha} names no remembered pull request` };
      named.add(head.number);
    }
  }
  const viewed: number[] = [];
  for (const number of named) {
    viewed.push(number);
    let seen: any;
    try {
      seen = view(number);
    } catch (error) {
      return { mode: "whole", reason: "view-failed", detail: `view #${number} threw: ${(error as Error).message}` };
    }
    if (seen?.number !== number) return { mode: "whole", reason: "view-failed", detail: `view #${number} answered ${JSON.stringify(seen?.number)}` };
    if (seen.state === "MERGED" || seen.state === "CLOSED") byNumber.delete(number);
    else if (seen.state === "OPEN") {
      const { state: _state, ...entry } = seen;
      byNumber.set(number, entry as PrEntry);
    } else return { mode: "whole", reason: "view-failed", detail: `view #${number} has state ${JSON.stringify(seen.state)}` };
  }
  const prs = [...byNumber.values()].sort((a, b) => b.number - a.number);
  return { mode: "narrowed", prs, readAtMs: memory.readAtMs, viewed, remembered: prs.map((pr) => pr.number).filter((number) => !named.has(number)) };
}
