// @ts-check
// agent-org#982, a11ign/a11ign#5043 design item 5: A REPOSITORY THAT CHANGED WITH NO EVENT BEHIND IT IS REPORTED, ONCE.
//
// In `webhook` mode a lost delivery is silent: the reconcile re-reads the repository, the generation moves, and nobody learns the receiver is dropping events. At the reconcile
// `refreshTickSnapshot` runs the repository's probe pair ONCE (the poll path's own `probeOnce`); this file decides whether what they said is DRIFT and files it.
//
// THE WINDOW. The window is the interval since `factsReadAt`, the moment the content the held tags were compared with was read (agent-org#1431). An event that names the repository
// after that moment explains a move in its content, so it is not drift: `bumpedAt` moves on every such event, and `namedSince` is the question "has it moved past the read?". While the
// receiver is healthy, a repository that is not due keeps its baseline, so the reconcile that is due is the one that reads the content again and sees the event's change as explained.
//
// THE CONTENT, NOT THE TAG (agent-org#1207, a11ign/a11ign#928). A probe's tag moving is NOT drift on its own. Measured 2026-10-12: the same issues list read anonymously and
// authenticated carries the same items and a DIFFERENT tag, and a tag held from one read context answers 200 (not 304) when it is sent in the other. So a probe is drift only when
// the content it read moved too: the newest `updated_at` of its items or the number of them (`contentMoved`). A tag that moved over the same content is counted (`countSuppressed`),
// not filed, so the health signal stays visible without a row per repository per window.
//
// TWO FALSE-DRIFT SOURCES, named because they cannot be guessed away and the incident text says them to the person who reads it:
//   - A CHANGE GITHUB SENDS NO EVENT FOR IN THE SUBSCRIBED SET: a Project board edit moves no `issues` event and may still move a probe. The incident is the cue to look, not a verdict.
//   - AN EVENT THAT ARRIVED AFTER THE PROBE WITHIN THE SAME TICK: the queue is read before the probes, so a delivery landing between the two is in the NEXT tick's queue.
// A probe with no tag held (the first reading of a repository, or a path that did not exist) has nothing to compare against: it is a baseline, never drift. So is a probe whose tag
// is held without the content it was read with (a file written before this check), and a probe whose body could not be read: nothing confirms a move there.
//
// ONE INCIDENT PER PASS (agent-org#1207): a reconcile pass that finds several repositories drifted files ONE incident naming every one of them, not one per repository.
//
// REVERT: `"source": "poll"` in host.json. Without `events` (poll) or with an unhealthy receiver nothing here runs.
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readRows, recordIncident, type Run, type SharedGroup, standingOf } from "./ci-failure-class.ts";

const MS = 1000;
const KEEP_DAYS = 14;

/** What a probe's body said besides its tag: the newest `updated_at` of the items it read (`null` when there were none) and how many there were. */
export type Facts = { newest: string | null, count: number };

/**
 * A probe that moved, as `refreshTickSnapshot` read it. `held` is the tag it was compared with (`undefined`: none held, so a baseline); `heldFacts` is the content held with that tag
 * (`undefined`: none, so a baseline); `facts` is the content this read saw (`undefined`: the body was not readable).
 */
export type MovedProbe = { path: string; changed: boolean; held: string | undefined; heldFacts?: Facts; facts?: Facts };

/** A repository that drifted in a pass: the probe that moved and the window it moved in. */
export type Drift = { repo: string; probe: string; windowStartS: number; nowS: number };

/** The name the incident gives a probe path: the two endpoints `probePaths` asks. */
export const probeName = (path: string): string => (path.includes("/actions/runs") ? "actions/runs" : "issues list");

/** Did the content a probe read move since the tag was held? Only readable content on both sides that differs is a move. */
export const contentMoved = (p: MovedProbe): boolean =>
  p.heldFacts !== undefined && p.facts !== undefined && (p.facts.newest !== p.heldFacts.newest || p.facts.count !== p.heldFacts.count);

/** The tag moved and the content, read on both sides, did not: the change the tag alone used to file, now counted and not filed. */
export const noContentChange = (p: MovedProbe): boolean => p.changed && p.held !== undefined && p.heldFacts !== undefined && p.facts !== undefined && !contentMoved(p);

/**
 * DRIFT, or `null`. A probe whose tag moved AND whose content moved, against a tag and content that were held, for a repository no event named since they were read, is a delivery the receiver did not get.
 * An event that named the repository since then (`namedSince`, this tick or after the read) explains the move; a probe whose content did not move says nothing moved.
 */
export function driftOf({ repo, probes, namedSince, windowStartS, nowS }: { repo: string; probes: readonly MovedProbe[]; namedSince: boolean; windowStartS: number; nowS: number }): Drift | null {
  if (namedSince) return null;
  const moved = probes.find((p) => p.changed && p.held !== undefined && contentMoved(p));
  return moved === undefined ? null : { repo, probe: probeName(moved.path), windowStartS, nowS };
}

const iso = (seconds: number): string => new Date(seconds * MS).toISOString().replace(/\.\d+Z$/, "Z");

/**
 * The group `recordIncident` files for one pass. Its key is the SET of drifted repositories, with no window (agent-org#1330): a repository set that drifts again joins its
 * OPEN row, and {@link fileDrift} folds it into a row that CLOSED recently. The window the row first named stays in its `Step:`, because a join never rewrites the body of a group with no PRs.
 */
export function groupOf(drifts: readonly Drift[]): SharedGroup {
  const windowStartS = Math.min(...drifts.map((d) => d.windowStartS));
  const nowS = Math.max(...drifts.map((d) => d.nowS));
  const window = `${iso(windowStartS)} to ${iso(nowS)}`;
  const moved = drifts.map((d) => `${d.repo}: ${d.probe}`).join("; ");
  return {
    key: `event-drift:${drifts.map((d) => d.repo).sort().join(",")}`,
    signature: {
      check: `missed delivery: ${moved} moved`,
      step: `reconcile window ${window}`,
      line: `The probes that moved in ${window} with no event queued for their repositories were: ${moved}. `
        + "Each moved the probe's tag AND the content it read (the newest updated_at or the item count). The event is INFERRED from the probe, not seen. "
        + "Not drift when the change is one GitHub sends no event for in the subscribed set (a Project board edit), or an event that arrived after this probe within the same tick. "
        + "Filed by the webhook reconcile (agent-org#982, content check agent-org#1207); `\"source\": \"poll\"` in host.json is the revert.",
      file: null,
    },
    prs: [],
    noted: [],
  };
}

/** One pass's drifts, filed as one incident. `true` when a row exists, `false` when the filing was refused. */
export type FileDrift = (drifts: readonly Drift[]) => boolean;

/**
 * File one incident for the pass's `drifts` through `recordIncident` (its label, dedupe and refusal handling are reused, not copied). `run` is handed in: this file spawns nothing (`gh-call-ratchet.test.ts`), the caller's one `gh` spawn serves. Returns `true` when a row exists, `false` when `gh` refused:
 * the caller then leaves the windows open, so each probe says CHANGED again next tick and the filing is retried instead of lost.
 * agent-org#1330: a repository set whose row CLOSED within `QUIET_AFTER_CLOSE_MS` files nothing. `standingOf` reads that, the pass logs that it was folded in, and the row exists, so `true`.
 * The rows are read here, not left to `recordIncident`, because that one joins an open row and would file a second row once the first has closed.
 */
export function fileDrift(drifts: readonly Drift[], { run, log = (line: string) => process.stderr.write(line), record = recordIncident }: { run: Run; log?: (line: string) => void; record?: typeof recordIncident }): boolean {
  const group = groupOf(drifts);
  const nowMs = Math.max(...drifts.map((d) => d.nowS)) * MS;
  let said;
  try {
    said = standingOf(group, { open: readRows(run, "open"), closed: readRows(run, "closed"), nowMs });
  } catch (error) {
    log(`event-drift: could not read the incident rows (${String((error as Error).message).split("\n")[0]}); the next tick retries\n`);
    return false;
  }
  if (!said.hold && said.why === "closed") {
    log(`event-drift: ${drifts.map((d) => d.repo).join(", ")} moved again within the quiet window after incident #${said.row} closed; folded into it, no row filed\n`);
    return true;
  }
  return record(group, { run, log }) !== null;
}

/** Where the per-day count of reconciles whose tag moved over the same content is kept, under the read cache (`read-cache/`). */
export const suppressedPath = (root: string): string => join(root, "event-drift-suppressed.json");

/** The count per UTC day, newest first in the file. A file that cannot be read counts as empty: the count is a signal, never a gate. */
export function readSuppressed(path: string): Record<string, number> {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}

/** Add `n` to today's count and keep the last `KEEP_DAYS` days. Written through a rename, as the generations are. */
export function countSuppressed(path: string, nowMs: number, n: number): void {
  const day = new Date(nowMs).toISOString().slice(0, 10);
  const tally = readSuppressed(path);
  tally[day] = (tally[day] ?? 0) + n;
  const kept = Object.fromEntries(Object.entries(tally).sort(([a], [b]) => (a < b ? 1 : -1)).slice(0, KEEP_DAYS));
  const tmp = `${path}.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(kept));
  renameSync(tmp, path);
}
