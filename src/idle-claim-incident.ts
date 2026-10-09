// @ts-check
// module: a claim that is not finishing is a LEDGER INCIDENT, class `row-not-finishable` (a11ign/a11ign#4642, chairman via #4437)
//
// CHAIRMAN, 2026-10-09: READY MEANS FINISHABLE -- a row offered to an engineer runs claim to merged waiting on nothing outside its own CI and review. worker-3870 sat idle
// holding #3870 (a reading due a day later) while the gate deferred other ready rows for lack of an engineer, and #4438 and #4441 were held claimed 10.5 h by a read-back
// an engineer could not do. `idle-claimant.ts` already NUDGES such a holder after 45 minutes and `claim-stall.ts` carries the nudge; neither RECORDS anything, so the daily
// root-cause pass never saw the class. This leaf is the record.
//
// PURE, AND A LEAF (`idle-claimant.ts`, `failure-ledger.ts` and the vocabulary only): claims, pull requests, the herdr listing and the clock in, events out. THE IDLE DECISION IS
// `idleClaimantReading`'s, not a second copy: a holder with a declared wait (a row field, a pending check, a review asked for, an approval, a hold) reads `waiting` there and
// is no incident here, which is the control every case below carries.
import { type Agent, type IdlePr, idleClaimantReading } from "./idle-claimant.ts";
import type { FailureEvent } from "./failure-ledger.ts";

/** The failure-ledger class key, an event kind like `main-red` (the ledger's keys are event kinds, not `failure-classes.json`'s row-defect ids). */
export const ROW_NOT_FINISHABLE = "row-not-finishable";

const MINUTE_MS = 60_000;

/**
 * M: how long a claim may sit idle with nothing pending before it is an INCIDENT rather than a nudge. THE CHAIRMAN'S FIGURE (2026-10-09, #4642), not a derived one:
 * 15 minutes above `IDLE_CLAIMANT_MINUTES` (45, the nudge) so a holder is nudged first and the incident is the nudge having failed to move it.
 */
export const IDLE_CLAIM_INCIDENT_MINUTES = 60;
export const IDLE_CLAIM_INCIDENT_MS = IDLE_CLAIM_INCIDENT_MINUTES * MINUTE_MS;

/**
 * One claimed row. `idleSince` is the first tick of its holder's unbroken idle run, which the gate keeps (`claim-stalls.json`; `herdr` reports a status and never since
 * when): `null` is a holder whose idle start nobody recorded, and that is CANNOT TELL, never "idle for 0". `waitKinds` are the ROW's declared waits as the gate decides them.
 */
export type IdleClaim = { row: number, session: string, idleSince: number | null, waitKinds?: string[], prs?: IdlePr[] };

/** `no-pr`: idle, nothing open. `pr-idle`: a pull request is open and nothing is pending on it. */
export type IdleClaimIncident = { kind: "no-pr" | "pr-idle", row: number, session: string, pr: number | null, idleMinutes: number, ref: string };

const isoSecond = (ms: number): string => `${new Date(ms).toISOString().slice(0, 19)}Z`;

/**
 * THE REF NAMES THE EPISODE, NOT JUST THE ROW: `recordFailures` skips a (key, ref) already in the log for ever, so a ref of `#4642` would make a second idle run on the same row
 * invisible. The idle run's start is stable across ticks (the gate keeps it) and differs between runs, so one run is one line and a second is another.
 */
function refOf({ pr, row, idleSince }: { pr: number | null, row: number, idleSince: number }): string {
  return `${pr === null ? `#${row}` : `PR#${pr}`}@${isoSecond(idleSince)}`;
}

/** @returns the minutes this claim has been idle with nothing pending against `prs`, or null when it is not (or cannot be said to be) past M */
function idleMinutesPastM({ claim, prs, agents, now }: { claim: IdleClaim, prs: IdlePr[], agents: Agent[] | null, now: number }): number | null {
  if (claim.idleSince === null) return null;
  const reading = idleClaimantReading({ session: claim.session, waitKinds: claim.waitKinds, prs }, { now, agents, idleSince: claim.idleSince });
  // `stall` and `watching` are both "idle, no declared wait" (they differ by the 45-minute nudge clock); `waiting`, `not-idle` and `unknown` are not incidents.
  if (reading.kind !== "stall" && reading.kind !== "watching") return null;
  return reading.idleMs > IDLE_CLAIM_INCIDENT_MS ? Math.floor(reading.idleMs / MINUTE_MS) : null;
}

/**
 * THE INCIDENTS OF ONE READING. A claim with no open pull request that has been idle more than M minutes is one `no-pr` incident (ref: the row). A claim WITH open pull
 * requests is judged PER PULL REQUEST, each alone against the holder's row waits: one with nothing pending (no check running, no reviewer asked, not approved, no evidence
 * label, no hold) is a `pr-idle` incident (ref: the PR), even when the holder's other pull request is waiting on a check.
 * @param {{ claims: IdleClaim[], agents: Agent[] | null, now: number }} reading `agents: null` is a listing nobody could take, which proves nothing
 */
export function idleClaimIncidents({ claims, agents, now }: { claims: IdleClaim[], agents: Agent[] | null, now: number }): IdleClaimIncident[] {
  return claims.flatMap((claim): IdleClaimIncident[] => {
    const { row, session, idleSince } = claim;
    if (idleSince === null) return [];
    const open = claim.prs ?? [];
    if (open.length === 0) {
      const idleMinutes = idleMinutesPastM({ claim, prs: [], agents, now });
      return idleMinutes === null ? [] : [{ kind: "no-pr", row, session, pr: null, idleMinutes, ref: refOf({ pr: null, row, idleSince }) }];
    }
    return open.flatMap((pr): IdleClaimIncident[] => {
      const idleMinutes = idleMinutesPastM({ claim, prs: [pr], agents, now });
      const number = Number(pr.number);
      return idleMinutes === null ? [] : [{ kind: "pr-idle", row, session, pr: number, idleMinutes, ref: refOf({ pr: number, row, idleSince }) }];
    });
  });
}

/** The ledger events: one per incident, dated by the caller's `now` (`recordFailures` skips a (key, ref) already logged, so a standing episode is one line). */
export function incidentEvents(incidents: IdleClaimIncident[]): FailureEvent[] {
  return incidents.map(({ ref }) => ({ classKey: ROW_NOT_FINISHABLE, ref }));
}

const FIRST_REFS = 3;

/** What the daily pass prints: the count and the first three refs (`null` is a read nobody could make, which says `unknown` and never 0). */
export function incidentSummary(incidents: IdleClaimIncident[] | null | undefined): { count: number, first: string[] } | null {
  if (incidents === null || incidents === undefined) return null;
  return { count: incidents.length, first: incidents.slice(0, FIRST_REFS).map(({ ref }) => ref) };
}
