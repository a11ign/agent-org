import { existsSync, readFileSync, mkdirSync, writeFileSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import { stateEntryPath } from "../../host-config.ts";
import { blockingImpactTick, resolverOf } from "../../blocking-impact.ts";
import { resolverDefectKey, resolverDefectText, RESOLVER_DEFECT_LABEL } from "../pr-owners.ts";
import type { ResolverDefect } from "../pr-owners.ts";
import { defaultRun } from "../reads/exit.ts";
import { comparablePrFiles, labelledRows, sessionOf } from "../vocabulary.ts";

/** Where the pull requests already reported as resolver defects are remembered between ticks: each tick is a fresh process. */
const RESOLVER_DEFECTS_STATE = "resolver-defects.json";

/**
 * #4386: FILE EACH RESOLVER DEFECT, ONCE PER PULL REQUEST, ON ONE ROW. A pull request that reaches `ceo`'s rung while naming a live claimant is the
 * resolver failing, and the order to `ceo` reads as routing, so without this the class ends as a hand route every time (agent-org#436, #437).
 * The CLASS has one open row (`resolver-defect`): the first defect files it, later ones comment on it. A pull request is remembered only after its
 * write LANDED, so a refused `gh` is retried next tick, and one that landed is never written twice. Returns how many were written.
 */
export function fileResolverDefects(defects: ResolverDefect[], { run = defaultRun, statePath = stateEntryPath(RESOLVER_DEFECTS_STATE), log = (line) => process.stderr.write(line) }: { run?: (args: string[]) => string; statePath?: string; log?: (line: string) => void; } = {}): number {
  if (defects.length === 0) return 0;
  const filed = readFiledDefects(statePath, log);
  let written = 0;
  for (const defect of defects) {
    const key = resolverDefectKey(defect);
    if (key in filed || !writeResolverDefect(defect, { run, log })) continue;
    filed[key] = new Date().toISOString();
    written++;
  }
  if (written > 0) writeFiledDefects(statePath, filed, log);
  return written;
}

/** How many reported pull requests are remembered: far more than are ever open at once, so a closed one is forgotten long after it could come back. */
const RESOLVER_DEFECTS_KEPT = 500;

function readFiledDefects(path: string, log: (line: string) => void): Record<string, string> {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch (error) {
    log(`resolver-defect: ${path} is unreadable (${(error as Error).message}); every defect still open is filed again (#4386)\n`);
    return {};
  }
}

function writeFiledDefects(path: string, filed: Record<string, string>, log: (line: string) => void) {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const scratch = `${path}.${process.pid}.tmp`;
    writeFileSync(scratch, JSON.stringify(Object.fromEntries(Object.entries(filed).slice(-RESOLVER_DEFECTS_KEPT))));
    renameSync(scratch, path);
  } catch (error) {
    log(`resolver-defect: could not remember what was filed in ${path} (${(error as Error).message}); the next tick files it again (#4386)\n`);
  }
}

/**
 * #4602: THE ONE PLACE THE GATE CALLS THE SHELVED-ROWS COUNT. A holder is resolved from the `session:` label on the row or pull request the reason names; the row write on a held row goes
 * through `gh issue comment`, the wake through the order returned. Never throws (`blockingImpactTick` reports and returns nothing).
 * A keyed tracker's shelving carries its `repo`, and `trackers` holds each keyed tracker's open rows by repository, so a bare `#N` in its reason is looked for among THAT tracker's rows.
 * @param {{ shelved: { number: number, reason: string, repo?: string }[], openRows: any[], trackers: Record<string, any[]>, prs: any[], stateDir: string }} tick
 */
export function blockingImpactOrders({ shelved, openRows, trackers, prs, stateDir }: { shelved: { number: number; reason: string; repo?: string; }[]; openRows: any[]; trackers: Record<string, any[]>; prs: any[]; stateDir: string; }) {
  const resolve = resolverOf({ rows: openRows, prs, trackers, sessionOf, closesOf: (pr) => comparablePrFiles([pr])[0]?.closes ?? [] });
  return blockingImpactTick({ blocked: shelved, resolve, stateDir, now: Date.now(), comment: (row, body, repo) => { defaultRun(["issue", "comment", String(row), "--body", body], repo); } });
}

/** One defect onto the class row: a comment on the open one, or a new row when there is none. `false` when `gh` refused, and says so. */
function writeResolverDefect(defect: ResolverDefect, { run, log }: { run: (args: string[]) => string; log: (line: string) => void; }): boolean {
  const { title, comment } = resolverDefectText(defect);
  try {
    const open = labelledRows({ label: RESOLVER_DEFECT_LABEL, state: "OPEN", select: "number", newest: 1, run });
    if (open.length > 0) {
      run(["issue", "comment", String(open[0].number), "--body", comment]);
    } else {
      run(["label", "create", RESOLVER_DEFECT_LABEL, "--force", "--description", "A pull request the gate could not own although it names a live claimant"]);
      run(["issue", "create", "--title", title, "--label", RESOLVER_DEFECT_LABEL, "--body", comment]);
    }
    return true;
  } catch (error) {
    log(`resolver-defect: could not file ${resolverDefectKey(defect)} (${String((error as Error).message).split("\n")[0]}); the next tick retries (#4386)\n`);
    return false;
  }
}
