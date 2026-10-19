import { subjectRef } from "../../review-attribution.ts";
import { machineryFlagOn, type CanaryState } from "../../org-health/fleet-build-readings.ts";
import type { BlockingOrder } from "../../blocking-impact.ts";
import { closedRowsOf } from "../../merge-guard.ts";
import { readJsonObject } from "../../claim-stall/claim-stalled.ts";
import { writeJsonObject } from "../../claim-stall.ts";
import { OPEN_ROWS_LIMIT } from "../reads/read-memo-and-exit.ts";

// =====================================================================================================================
// a11ign#5125 (REOPENED 2026-10-11): A ROW CLOSED UNDER AN OPEN HALF OF ITSELF IS SAID TO `product-manager`, ONCE, NAMING THE HALF.
//
// Measured: a11ign#5109 spans two repositories. agent-org#1007 `Closes a11ign/a11ign#5109` and merged at 17:30, GitHub closed the row on the spot, and a11ign#5115 -- the other half, whose body names the same row --
// was still open and lost the session that held it. Nothing said the row was closed under it.
//   WHAT THIS CANNOT DO IS KEEP THE ROW OPEN. The platform closes on merge; `pr-open` refuses the front door (agent-org#923) and cannot reach a pull request opened before it; and a REOPEN is neither one of the ticket
//   port's four operations (ADR 0046) nor a `gh` call site this file may add (`docs/gh-call-baseline.json` only goes down). So the gate does what it can: it reads, from the lists it already holds, an open
//   pull request whose `Closes` names a row that is no longer on its tracker's open list, and tells `product-manager` ONCE to reopen it, naming that pull request. No read is added.
//   ABSENCE IS NOT PROOF: a tracker whose open list was refused or came back at the read's limit says nothing about a row missing from it.
//   ONCE PER (ROW, HALF): the record is a state file, pruned of what is no longer standing, so a row the owner then closes on purpose is not said again for the same half.
//   THE FLAG `rows.closedUnderOpenHalf` (`machinery-canary.json`, default OFF): off reads and writes nothing and makes no order.
// =====================================================================================================================

/** The machinery flag that lets the gate say a row was closed under an open half. */
export const CLOSED_UNDER_HALF_FLAG = "rows.closedUnderOpenHalf";

export const CLOSED_UNDER_HALF_FILE = "closed-under-open-half.json";

export const CLOSED_UNDER_HALF_SESSION = "product-manager";

/**
 * A row (`owner/repo#n`) and the open pull request (`owner/repo#n`) whose `Closes` still names it. `halfKey` is the half's repository KEY (ADR 0040) and is absent for the primary's own: the key is the
 * subject's identity (`agent-org#7`) and is NOT the repository's basename, which a project may spell differently.
 */
export type ClosedUnderHalf = { row: string; half: string; halfKey?: string };

/** One tracker's open rows as the tick read them; `null` when the read was refused. */
export type TrackerRows = { repo: string; rows: readonly any[] | null };

/** PURE. Each open, non-draft pull request's `Closes` row that is absent from a tracker's WHOLE open list. A row is named once, by the first half that names it. */
export function rowsClosedUnderOpenHalf({ prs, trackers, homeRepo }: { prs: readonly any[]; trackers: readonly TrackerRows[]; homeRepo: string }): ClosedUnderHalf[] {
  const found = new Map<string, ClosedUnderHalf>();
  for (const pr of prs) {
    if (pr?.isDraft === true || typeof pr?.body !== "string" || !Number.isFinite(Number(pr.number))) continue;
    const repo = String(pr.repo ?? homeRepo);
    for (const ref of closedRowsOf(pr.body, repo)) {
      const open = trackers.find((tracker) => tracker.repo === ref.repo)?.rows;
      if (open === null || open === undefined || open.length >= OPEN_ROWS_LIMIT) continue; // a list at the read's limit may be cut, and a row missing from a cut list is not a closed one
      const row = `${ref.repo}#${ref.number}`;
      if (!open.some((candidate) => Number(candidate?.number) === ref.number) && !found.has(row)) found.set(row, { row, half: `${repo}#${Number(pr.number)}`, ...halfKeyOf(pr, homeRepo) });
    }
  }
  return [...found.values()];
}

/**
 * The key the tick TAGGED the pull request with (`tagged`), which is the half's identity in a ledger or an order's subject. A foreign pull request nobody tagged -- a fixture; the tick tags every one --
 * falls back to its repository's basename rather than to the primary's bare number, which would name a different pull request.
 */
function halfKeyOf(pr: any, homeRepo: string): { halfKey?: string } {
  const tagged = typeof pr.repoKey === "string" ? pr.repoKey : "";
  const key = tagged !== "" ? tagged : pr.repo === undefined || String(pr.repo) === homeRepo ? "" : String(pr.repo).split("/").pop() ?? "";
  return key === "" ? {} : { halfKey: key };
}

function closedUnderHalfOrder({ row, half, halfKey }: ClosedUnderHalf): BlockingOrder {
  const halfNumber = half.split("#")[1];
  const [rowRepo, rowNumber] = row.split("#");
  const slug = `${row}-${half}`.replace(/[^\w.-]+/g, "-");
  const subject = `pr-${subjectRef(halfKey, halfNumber)}`; // the established spelling (`pr-1014`, `pr-agent-org#1037`), which the KEY spells and the basename may not
  return { session: CLOSED_UNDER_HALF_SESSION, cause: "row-closed-under-open-half", subject, discriminator: slug, causeKey: `${CLOSED_UNDER_HALF_SESSION}/closed-under-half/${slug}`, prompt:
    `Row ${row} is CLOSED, and ${half} -- an open pull request -- still \`Closes\` it (a11ign#5125): another pull request's merge closed the row while this half is unmerged, so ${half}'s merge will close nothing `
    + `and the row reads done with this half's work outstanding. Reopen it: \`gh issue reopen ${rowNumber} --repo ${rowRepo} --comment "closed by another half's merge; ${half} is still open"\`, and if the pull request `
    + `that merged was not meant to finish the row, say so on the row. The gate cannot reopen it (the ticket port has no such operation: ADR 0046). This is told once for this row and this half.` };
}

/**
 * THE ONE PLACE THE GATE ASKS WHETHER A ROW WAS CLOSED UNDER AN OPEN HALF: the orders this tick owes. FLAG OFF reads and writes nothing. Never throws. A record that cannot be written returns NO order, because a
 * line whose memory was lost would be said again on every tick.
 */
export function closedUnderHalfOrders({ prs, trackers, homeRepo, stateDir, state, log }: {
  prs: readonly any[]; trackers: readonly TrackerRows[]; homeRepo: string; stateDir: string; state: CanaryState; log: (line: string) => void;
}): BlockingOrder[] {
  if (!machineryFlagOn(state, CLOSED_UNDER_HALF_FLAG)) return [];
  const path = `${stateDir}/${CLOSED_UNDER_HALF_FILE}`;
  try {
    const told: Record<string, number> = readJsonObject(path).told ?? {};
    const standing = rowsClosedUnderOpenHalf({ prs, trackers, homeRepo });
    const key = ({ row, half }: ClosedUnderHalf) => `${row}|${half}`;
    const fresh = standing.filter((found) => told[key(found)] === undefined);
    writeJsonObject(path, { told: Object.fromEntries(standing.map((found) => [key(found), told[key(found)] ?? Date.now()])) });
    return fresh.map((found) => closedUnderHalfOrder(found));
  } catch (error) {
    log(`closed-under-half: no order this tick, the record was not kept (${String((error as Error).message).split("\n")[0]}).\n`);
    return [];
  }
}
