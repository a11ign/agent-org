// @ts-check
// module: a claim that is not finishing is a LEDGER INCIDENT, class `row-not-finishable` (a11ign/a11ign#4642, chairman via #4437)
//
// CHAIRMAN, 2026-10-09: READY MEANS FINISHABLE -- a row offered to an engineer runs claim to merged waiting on nothing outside its own CI and review. worker-3870 sat idle
// holding #3870 (a reading due a day later) while the gate deferred other ready rows for lack of an engineer, and #4438 and #4441 were held claimed 10.5 h by a read-back
// an engineer could not do. `idle-claimant.ts` already NUDGES such a holder after 45 minutes (30 since agent-org#860) and `claim-stall.ts` carries the nudge; neither RECORDS anything, so the daily
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
 * 15 minutes above `IDLE_CLAIMANT_MINUTES` when it was 45, 30 above it at the 30 of agent-org#860, so a holder is nudged first and the incident is the nudge having failed to move it.
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

const HOUR_MS = 3_600_000;

/**
 * One claimed row of one declared tracker, as the daily retro reads it (#4957): who holds it, since when, and what the holder has declared. `claimedAt` is the newest claim
 * record's own time; `null` is a record nobody could date, which is CANNOT TELL and not a claim that began today.
 */
export type ClaimedRow = { repo: string, row: number, session: string, claimedAt: number | null };

/** A holder's last `worker:state` declaration (`at` in ms) and when the holder's last turn began, if the wake ledger says (`turnStartedAt`, `lastDeliveredTo`'s). */
export type HolderState = { declaredAt: number | null, turnStartedAt: number | null };

/**
 * WORKER-HOURS IDLE ON A CLAIMED ROW WITH NO DECLARATION, over `[since, now]` (#4957, the chairman's headline metric). For every claimed row of every declared tracker:
 * a holder with an open pull request (`sessionsWithPr`, by its `session:` label) reads 0, and so does one whose declaration is FRESH, made after the claim and after
 * the turn began (the freshness rule of `declarationReading`, without its "does the wait still hold" half: a lapsed wait is the gate's nudge, not this number's). Any other holder
 * was idle from the latest of the window's start, the claim, its last declaration and its last turn's start, until `now`. THE START IS THE LATE SIDE, so the figure is a FLOOR:
 * an idle run that ended before `now` and was followed by work is not counted past that work's start, and a holder whose turn began recently is credited from it.
 * A row whose claim could not be dated is not counted and is named in `undated`, never read as 0 hours or as a claim that began at the window's start.
 * `paused` is the Claude allowance's pause, read by the caller (`pausedIntervals`): time inside it is no holder's idle time, because no seat could have run,
 * so each span is read net of it. It is an input and not a read, so this file stays a leaf.
 */
export function idleClaimedHours({ claims, sessionsWithPr, holders, since, now, paused = [] }: {
  claims: ClaimedRow[], sessionsWithPr: ReadonlySet<string>, holders: ReadonlyMap<string, HolderState>, since: number, now: number,
  paused?: readonly { from: number, to: number }[],
}): { hours: number, claims: number, idleClaims: number, undated: string[] } {
  let ms = 0;
  let idleClaims = 0;
  const undated: string[] = [];
  for (const { repo, row, session, claimedAt } of claims) {
    if (claimedAt === null) { undated.push(`${repo}#${row}`); continue; }
    if (sessionsWithPr.has(session)) continue;
    const { declaredAt = null, turnStartedAt = null } = holders.get(session) ?? {};
    if (declaredAt !== null && declaredAt >= Math.max(claimedAt, turnStartedAt ?? 0)) continue;
    const from = Math.max(since, claimedAt, declaredAt ?? 0, turnStartedAt ?? 0);
    const idle = now - from - pausedWithin(paused, from, now);
    if (idle > 0) { ms += idle; idleClaims++; }
  }
  return { hours: Math.round((ms / HOUR_MS) * 10) / 10, claims: claims.length, idleClaims, undated };
}

/** @returns the milliseconds of `[from, to]` that the pauses cover (they do not overlap one another, as `pausedIntervals` makes them) */
function pausedWithin(paused: readonly { from: number, to: number }[], from: number, to: number): number {
  return paused.reduce((sum, span) => sum + Math.max(0, Math.min(span.to, to) - Math.max(span.from, from)), 0);
}
