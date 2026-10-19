import type { NodeStripFact } from "../node-strips-types.ts";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { stateEntryPath } from "../host-config.ts";
import { READY_LABEL, STATE_LABELS } from "../claim-labels.ts";
import { boardTruthTable } from "../board-truth-audit.ts";
import type { FlagLedger } from "../flag-switch-ledger.ts";
import type { TickHealth, TickRecordState } from "../work-tick-health.ts";
import { ANSWER_PREFIX, BACKLOG_LABEL } from "../project-vocabulary.ts";
import { openIncidentsOf } from "../ticket-port/open-incidents.ts";
import { homeProjectDeclaration } from "../project-config.ts";
import { repoVerdict } from "../release-behind-main.ts";
import { CLASS_REPEAT_WINDOW_MS, FAILURE_CLASSES_PATH, CLASS_LABEL_PREFIX, groupByClass, newestOccurrence, occurrencesOf } from "../class-repeat.ts";
import { FIRST_READERS, FLEET_BUILD_INCIDENT_LINE, FLEET_BUILD_MIXED_HOURS, MAX_NAMED, MAX_REASON_CHARS, MILESTONE_CLOCK_MINUTES, MS_PER_HOUR, MS_PER_MINUTE, OFFERED_TO, SIGNALS, ageText, clear, isoOf, noMergeReading, type Reading, type RedPr, type ReviewGatedPr, type ToolAgreement, unknown } from "./thresholds.ts";
import { CLAIM_REFUSAL_STORM_MINUTES, CLAIM_REFUSAL_STORM_REFUSALS, autoOffRefusalReading, fleetIdleReading, overdueReading, primaryReading, readAutoOffRefusal, redPrReading, refusedRowReading, reviewGatedUnaskedReading, staleWaitReading, type AutoOffFact, type FleetCaptures, type FleetWaiting, type OverdueCandidate, waitWithoutReasonReading } from "./overdue-readings.ts";
import { BOARD_TRUTH_PAIRS_FILE, BOARD_TRUTH_PAIR_FLAG, boardTruthPairStep, boardTruthReading, boardTruthReadings, idleWithOpenRowsSignal, nodeCannotStripReading, shelvedCircleReading, stateLabelReading, teamAccessReading, toolVersionReading, type BoardTruthOffer, type BoardTruthPairs, type CopyPair, type ShelvedCircle, type TeamAccessFact } from "./board-truth-readings.ts";
import { copyDriftReading, readDeclaredCopies, releaseFailedReading, releaseFailureReadings, sweepOverdueReading, type ReleaseFailureRead, type ReleaseRuns, type SweepFact } from "./sweep-readings.ts";
import { APPROVED_DIRTY_MINUTES, APPROVED_DIRTY_SIGNAL, CANARY_STATE_FILE, HOLDS_PER_PR, HOLDS_PER_PR_SIGNAL, SAME_WAY_RERUN_SIGNAL, claimRefusalStormReading, flagSwitchReading, manualRerunsReading, readClaimRefusals, requiredRedOn5xxReading, tickRecordReading, tickWallReading, type ClaimRefusal, type PoolReading, type RerunOn5xx, type RerunSeen } from "./claim-refusal.ts";
import { APPROVED_REQUIRED_MINUTES, APPROVED_REQUIRED_SIGNAL, MACHINERY_SIGNALS, approvedDirtyReadings, approvedRequiredReadings, poolLowReading, sessionPrOutsideReadings, type ApprovedDirtyFacts, type ApprovedRequiredFacts, type SessionPrOutsideFact } from "./hold-count.ts";

/** An open build incident, as `readFleetBuildIncidents` keeps it: its body was read for the line and is not kept. `createdAt` is ISO, as the API gives it. */
export type FleetBuildIncident = { number: number; title: string; createdAt: string; };

/**
 * THE FACT FOR `fleetBuildMixedReading` (#4405): ONE REST CALL on the core pool for the OPEN issues labelled `incident` in `repo`, KEPT WHEN THEIR BODY CARRIES
 * {@link FLEET_BUILD_INCIDENT_LINE} on a line of its own. A pull request is not an incident and is dropped. `null` is a refused or unparseable list, a stated unknown and never "no incident".
 */
export function readFleetBuildIncidents(run: (args: string[]) => string, repo: string): FleetBuildIncident[] | null {
  const issues = openIncidentsOf(repo, run);
  if (issues === null) return null;
  return issues.filter((issue) => typeof issue.body === "string" && issue.body.split(/\r?\n/).some((line) => line.trim() === FLEET_BUILD_INCIDENT_LINE))
    .map(({ number, title, createdAt }) => ({ number, title, createdAt }));
}

/** The box count the incident's title names (`Mixed Windows build across the fleet: <n> boxes behind <target>`), as the reading says it. */
const boxesBehindOf = (title: string): string => {
  const count = /(\d+) boxes? behind/.exec(title);
  return count ? `${count[1]} boxes behind` : "box count not in its title";
};

/**
 * SIGNAL 22 (#4405, the chairman's ruling): THE FLEET HAS STAYED ON MIXED WINDOWS BUILDS FOR `FLEET_BUILD_MIXED_HOURS`. An OPEN incident issue IS the stopped line: `fleet-watch` files it on the
 * first mismatch, and it is closed only when the fleet reads one build, so an open one over the bound is a fleet that did not move forward. `incident` is {@link readFleetBuildIncidents}' answer,
 * `null` for a refused read, which is unknown and NEVER clear. An incident with no creation time makes the answer unknown unless another trips, as the sibling readings do.
 */
export function fleetBuildMixedReading({ now, incident }: { now: number; incident: FleetBuildIncident[] | null; }): Reading {
  const signal = SIGNALS.FLEET_BUILD_MIXED;
  if (incident === null) return unknown(signal, "the open incident issues could not be read, so whether the fleet is on one Windows build is not known");
  if (incident.length === 0) return clear(signal);
  const dated = incident.map((issue) => ({ issue, openedAt: Date.parse(issue.createdAt) }));
  const over = dated.filter(({ openedAt }) => Number.isFinite(openedAt) && now - openedAt >= FLEET_BUILD_MIXED_HOURS * MS_PER_HOUR).sort((a, b) => a.openedAt - b.openedAt);
  if (over.length === 0) {
    const undated = dated.filter(({ openedAt }) => !Number.isFinite(openedAt));
    return undated.length === 0 ? clear(signal)
      : unknown(signal, `${undated.length} open incident(s) carry no creation time, so how long the fleet has been mixed is not known`);
  }
  const oldest = over[0];
  const named = over.slice(0, MAX_NAMED).map(({ issue, openedAt }) => `#${issue.number} (${boxesBehindOf(issue.title)}, open ${ageText(openedAt, now)})`);
  const more = over.length > MAX_NAMED ? `, and ${over.length - MAX_NAMED} more` : "";
  return { signal, status: "tripped", firstTrippedAt: oldest.openedAt + FLEET_BUILD_MIXED_HOURS * MS_PER_HOUR,
    discriminator: `${signal}@${oldest.issue.number}`,
    detail: `${over.length} build incident(s) have stood open over ${FLEET_BUILD_MIXED_HOURS} h with the fleet still on mixed Windows builds: ${named.join("; ")}${more}` };
}

/**
 * SIGNAL 21 (#4128, class fix for a11ign/a11ign#4084): A DORA REPOSITORY'S `main` HOLDS A SHIPPED-PATH COMMIT THAT NO RELEASE CARRIES, AND THE OLDEST IS OVER 24 HOURS OLD. Beside
 * `release-run-failed` (signal 18), which sees a release that ran and failed; this sees one that never started. ONE READING PER TRIPPED REPOSITORY, each with its own discriminator
 * (`release-behind-main@<repo>@<oldest sha>`), so a later commit does not re-raise it and one repository's order does not re-key another's. The verdicts are `release-behind-main.ts`'s.
 * A repository whose read was refused is UNKNOWN, never clear, and its being unknown does not hide another's trip: a trip and the unknowns are both returned.
 */
export function releaseBehindReadings({ now, behind }: { now: number; behind: import("../release-behind-main.ts").RepoFact[] | null; }): Reading[] {
  const signal = SIGNALS.RELEASE_BEHIND_MAIN;
  if (behind === null) return [unknown(signal, "the dora repositories could not be listed, so no repository is known to be level with its releases")];
  const verdicts = behind.map((fact) => repoVerdict(fact, now));
  const tripped = verdicts.flatMap((v) => (v.verdict === "tripped"
    ? [{ signal, status: ("tripped" as const), firstTrippedAt: v.firstTrippedAt, discriminator: `${signal}@${v.discriminator}`, detail: v.detail }] : []));
  const unread = verdicts.filter((v) => v.verdict === "unknown");
  const unreadReading = unread.length === 0 ? [] : [unknown(signal, `${unread.map((v) => v.detail).join("; ")}, so those repositories are not known to be level with their releases`)];
  return tripped.length === 0 && unread.length === 0 ? [{ ...clear(signal), detail: verdicts.map((v) => v.detail).join("; ") }] : [...tripped, ...unreadReading];
}

/**
 * SIGNAL 20 (#4126, child B of #4122): A SECOND CLOSED ROW UNDER ONE `class:<id>` LABEL, WHICH MEANS THE CLASS'S GUARD FAILED. One reading PER CLASS, so each class has its own
 * discriminator and a class whose offer lapses cannot re-key another's. THE DISCRIMINATOR IS THE CLASS AND ITS NEWEST ROW (`class-repeat/<id>@<number>`): the same newest row is the
 * same order, and a THIRD row is a new newest row and a new offer. A closed row stays closed, so the condition never clears on its own and an order for it would be re-sent every
 * two hours; it is therefore TRIPPED only while the newest instance closed within `CLASS_REPEAT_WINDOW_MS` (see there), and is `clear` after, which is what makes it one offer.
 *
 * WHAT IT WILL NOT DO. A label naming no class in the index is `unknown class`, reported by name and in no way a class (a typo must not invent a repeat, and must not hide one: the row
 * stays unread until relabelled). A refused read of the labels or the file is `unknown`, never "no repeats". An OPEN row is not an instance (`readClassRepeat` lists closed rows only).
 * The detail ends with the instance counts of every class read, so "which class has the most" is printed beside the offer.
 */
export function classRepeatReadings({ now, classRepeat }: { now: number; classRepeat: import("../class-repeat.ts").ClassRepeatFact | null; }): Reading[] {
  const signal = SIGNALS.CLASS_REPEAT;
  if (classRepeat === null) return [unknown(signal, "the closed rows labelled class:<id> could not be read, so no class is known to be free of a repeat")];
  if ("unreadable" in classRepeat) return [unknown(signal, `${classRepeat.unreadable}, so no class is known to be free of a repeat`)];
  const ledger = classRepeat.ledger;
  const groups = groupByClass(classRepeat.index, classRepeat.rows, Array.isArray(ledger) ? ledger : []);
  const ledgerGap = ledger === undefined || Array.isArray(ledger) ? [] : [unknown(signal, `${ledger.unreadable}, so no event kind is known to be free of a repeat`)];
  const undated = groups.flatMap((g) => g.rows).filter((row) => row.closedAt === null);
  if (undated.length > 0) return [unknown(signal, `closed row(s) ${[...new Set(undated.map((r) => `#${r.number}`))].join(", ")} carry a class label and no close time, so their order cannot be read`), ...ledgerGap];
  const strangers = groups.filter((g) => g.entry === null);
  const fresh = groups.filter((g) => g.entry !== null && occurrencesOf(g) >= 2 && now - (newestOccurrence(g).at as number) <= CLASS_REPEAT_WINDOW_MS);
  const covered = fresh.filter((g) => rowCovering(classRepeat, g) !== null);
  const tripped = fresh.filter((g) => !covered.includes(g));
  const counts = classCountsText(groups);
  const strangerText = strangers.map((g) => `\`${CLASS_LABEL_PREFIX}${g.id}\` on ${rowsText(g.rows)}`).join("; ");
  const unknownClass = `unknown class (in no way a class, tripping nothing): ${strangerText} (not in ${FAILURE_CLASSES_PATH}: fix the label or add the class)`;
  const beside = [counts, ...(strangers.length > 0 ? [unknownClass] : [])].join("; ");
  if (tripped.length > 0) return [...tripped.map((g) => classRepeatTripped(signal, g, beside, classRepeat.filings?.[g.id])), ...ledgerGap];
  if (strangers.length > 0) return [unknown(signal, unknownClass), ...ledgerGap];
  if (covered.length > 0) return [{ ...clear(signal), detail: covered.map((g) => `class \`${g.id}\` repeated and was filed as ${rowCovering(classRepeat, g)}`).join("; ") }, ...ledgerGap];
  return [clear(signal), ...ledgerGap];
}

/** The row a repeating group's class was already filed as, when that row covers the group's NEWEST occurrence (a later occurrence is a new offer, not covered); else `null`. */
function rowCovering(classRepeat: { filings?: Record<string, import("../class-repeat.ts").Filing> }, group: import("../class-repeat.ts").ClassGroup): string | null {
  const filing = classRepeat.filings?.[group.id];
  return filing !== undefined && "filed" in filing && filing.covers === newestOccurrence(group).key ? filing.filed : null;
}

const rowsText = (rows: import("../class-repeat.ts").ClassRow[]): string => rows.map((r) => `#${r.number}`).join(", ");

/** @returns what the group holds: its closed rows, and its failure-ledger refs when it has any */
function occurrencesText(group: import("../class-repeat.ts").ClassGroup): string {
  if (group.events.length === 0) return `${group.rows.length} closed rows, ${rowsText(group.rows)}, newest first`;
  const rows = group.rows.length === 0 ? "" : `${group.rows.length} closed rows ${rowsText(group.rows)}, newest first; `;
  return `${occurrencesOf(group)} occurrences (${rows}${group.events.length} failure-ledger refs: ${group.events.join(", ")})`;
}

/** @returns every class read with its instance count, the most first */
function classCountsText(groups: import("../class-repeat.ts").ClassGroup[]): string {
  const counted = groups.filter((g) => g.entry !== null).sort((a, b) => occurrencesOf(b) - occurrencesOf(a) || a.id.localeCompare(b.id));
  return `instances per class, most first: ${counted.map((g) => `${g.id} ${occurrencesOf(g)}`).join(", ")}`;
}

/** What the class row said about this offer: it was refused (and why, so `ceo` knows nothing was filed), or it exists for an EARLIER occurrence. Empty when nothing was tried. */
function filingText(filing: import("../class-repeat.ts").Filing | undefined): string {
  if (filing === undefined) return "";
  return "refused" in filing
    ? `THE CLASS ROW WAS NOT FILED: \`row-file\` refused (${filing.refused}), so nobody has it. `
    : `A class row, ${filing.filed}, was filed for an earlier occurrence and does not cover this one. `;
}

function classRepeatTripped(signal: string, group: import("../class-repeat.ts").ClassGroup, beside: string, filing?: import("../class-repeat.ts").Filing): Reading {
  const entry = (group.entry as import("../class-repeat.ts").FailureClass);
  const guard = entry.guard ?? `NONE IN FORCE (${entry.guardNote ?? "the index says nothing more"}), so the first thing to fix is that there is no guard`;
  const { at, key } = newestOccurrence(group);
  return { signal, status: "tripped", firstTrippedAt: at, discriminator: `${signal}/${group.id}@${key}`,
    detail: `THE GUARD FAILED: class \`${group.id}\` (${entry.name}) has ${occurrencesText(group)}, and a second occurrence under one class is a repeat. `
      + `Its guard: ${guard}. ${filingText(filing)}${beside}` };
}

/**
 * One OPEN row of the primary milestone. `state` is why nobody is building it (`parked`, `date-held`, `blocked by #7`, `ready, unclaimed` ...) and `owes` who owes its next move.
 */
export type ClockRow = { number: number, createdAt: number | null, claimed: boolean, state: string, owes: string, epic?: boolean };
/**
 * `primaries` are the milestones marked `Primary: yes` that the open rows name, `rows` the open rows of the one primary (empty unless there is exactly one), `prsClose` the row numbers open pull requests declare they close (`null`: the pull requests were not read), and `endedAt` when the last claim or pull request ended (`null`: not read).
 */
export type MilestoneClockFact = { primaries: { number: number, title: string }[], rows: ClockRow[], prsClose: number[] | null, endedAt: number | null };

/**
 * SIGNAL: THE PRIMARY MILESTONE HAS OPEN ROWS AND NOTHING CLAIMED OR IN A PULL REQUEST FOR `MILESTONE_CLOCK_MINUTES` (#4231). The outcome clock runs on open PRs and CLAIMED
 * rows, so a milestone whose rows are all unclaimed, parked or date-held had no clock at all: v3 sat that way for hours on 2026-10-08 and the chairman found it. THIS ONE
 * CLOCKS THE MILESTONE AND NOT AN ITEM, and names the oldest open row with its state and whose move it is: the oldest that is not an `epic`, and the oldest epic only when every open row is one (product-manager's ruling on #4231).
 *
 * THE CLOCK STARTS AT THE LATER OF the last claim or pull request ending (`endedAt`) and the milestone's newest row opening: a row filed ten minutes ago has not been idle.
 * EACH REFUSED READ IS TESTED ONLY WHEN IT COULD MATTER, as `noMergeReading` tests its gap first: a start that has not reached the bound is clear whatever the pull-request
 * read says, so a refusal cannot turn a healthy tick into an unknown. Past it, an unread `endedAt` or an unread pull-request list is UNKNOWN: either could be what restarts it.
 *
 * NO PRIMARY MILESTONE IS CLEAR AND SAYS SO, and so is a primary milestone with no open row (nothing to alarm about). TWO marked primary is UNKNOWN: the rule is one at a time,
 * and a clock that picked one would be answering for `ceo`. THE KEY IS THE MILESTONE AND THE NAMED ROW, so a changed named row re-asks and a later tick naming the same one does not.
 *
 * @param input `fact` is `null` for an open-row list that was not read
 */
export function milestoneClockReading({ now, fact }: { now: number; fact: MilestoneClockFact | null; }): Reading {
  const signal = SIGNALS.MILESTONE_CLOCK;
  if (fact === null) return unknown(signal, "the open rows could not be read, so the primary milestone's rows are not known");
  if (fact.primaries.length > 1) {
    return unknown(signal, `milestones ${fact.primaries.map((m) => m.number).join(" and ")} are all marked \`Primary: yes\`: the rule is one at a time, so the clock does not choose`);
  }
  const [primary] = fact.primaries;
  if (primary === undefined) {
    return { signal, status: "clear", detail: "no open row belongs to a milestone marked `Primary: yes` (none is marked, or the marked one has no open row)" };
  }
  if (fact.rows.length === 0) return { signal, status: "clear", detail: `milestone ${primary.number} has no open row` };
  if (fact.rows.some((r) => r.claimed)) return clear(signal);
  if (fact.rows.some((r) => r.createdAt === null)) return unknown(signal, `a row of milestone ${primary.number} carries no creation time, so when it opened is not known`);
  const rowsOpened = Math.max(...fact.rows.map((r) => (r.createdAt as number)));
  const bound = MILESTONE_CLOCK_MINUTES * MS_PER_MINUTE;
  if (now - rowsOpened < bound) return clear(signal);
  if (fact.endedAt === null) return unknown(signal, `milestone ${primary.number} has been unclaimed since its newest row opened, but when the last claim or pull request ended was not read`);
  const since = Math.max(rowsOpened, fact.endedAt);
  if (now - since < bound) return clear(signal);
  if (fact.prsClose === null) return unknown(signal, `milestone ${primary.number} looks idle, but the open pull requests could not be read`);
  const owned = new Set(fact.rows.map((r) => r.number));
  if (fact.prsClose.some((n) => owned.has(n))) return clear(signal);
  const byAge = [...fact.rows].sort((a, b) => (a.createdAt as number) - (b.createdAt as number) || a.number - b.number);
  const oldest = byAge.find((row) => row.epic !== true) ?? byAge[0]; // an epic is a container, not the next move: named only when every open row is one
  const tripAt = since + bound;
  return { signal, status: "tripped", firstTrippedAt: tripAt, discriminator: `${signal}/${primary.number}@${oldest.number}`,
    detail: `milestone ${primary.number} (${primary.title}) has ${fact.rows.length} open row(s) and none is claimed or in a pull request for ${ageText(since, now)} (since ${isoOf(since)}, bound `
      + `${MILESTONE_CLOCK_MINUTES} min). The oldest open row is #${oldest.number}, ${oldest.state}; the next move is owed by ${oldest.owes}` };
}

/**
 * THE READINGS, in a fixed order: the four of #2936, then the two of #2937 and the outcome clock (#3486, which replaced #2970's) WHEN ITS FACT IS GIVEN. An OMITTED fact (`undefined`) is
 * "this caller does not ask", which is silent; `null` is "asked and refused", which is a stated unknown. The two must not share a
 * value, or a gate that never wired the fleet read would log an unknown every tick for a fault nobody can fix from the log.
 * @param facts `claimRefusals` (agent-org#889) is `readClaimRefusals()`'s answer, which `orgHealthTick` reads itself when the caller gives none; `shelvedCircle` (#4401) is `shelvedCircles`' answer over the shelving list and pull requests the tick already read, `null` for a refused read and OMITTED when the caller does not ask; `milestoneClock` (#4231) is the primary milestone's rows and the pull requests that close them, `null` for a refused open-row read and OMITTED when the caller does not ask; `classRepeat` (#4126) is `readClassRepeat()`'s answer, `null` or `{ unreadable }` for a refused read and OMITTED when the caller does not ask; facts `boardTruth` (#4043) is `boardTruthAudit`'s answer over the rows the tick already read, `null` for a refused read and OMITTED when the caller does not ask; `releaseRuns` (#4001) is `readReleaseRuns()`'s answer, `null` for a refused read and OMITTED when the caller does not ask; `releaseFailures` (agent-org#887) is `readReleaseFailures()`'s answer, one entry per repository the org releases, `null` for a repository list that could not be made and OMITTED when the caller does not ask; WHEN GIVEN IT REPLACES `releaseRuns`' reading; `idle` (#3943) is `idleWithOpenRowsReading`'s answer over the rows the tick already read, OMITTED when the caller does not ask; `stateRows` (#3942) is the open rows the tick already read, `null` for a refused read and OMITTED when the caller does not ask; `autoOff` (#3853) is `readAutoOffRefusal()`'s answer, which `orgHealthTick` reads itself when the caller gives none; `teamAccess` (#3634) is `readTeamAccess()`'s answer, OMITTED when the project declares none; `toolAgreement` (#3533) is `readToolAgreement()`'s answer, OMITTED when the caller does not ask; `pools` (#3448) is the API budgets the tick read, `null` when none was; the order-stall reading is the WAKER's and rides `orderStallOrders`
 */
export function orgHealthReadings(facts: {
        now: number; lastMergedAt: number | null; lastMergedIn?: string | null; work: { greenPrs: number; claimableRows: number; } | null; redPrs: RedPr[] | null;
        /** agent-org#1538: the review-gated red PRs and whether each was asked; OMITTED is "does not ask", `null` a refused read */
        reviewGated?: ReviewGatedPr[] | null;
        refusals: Record<string, { reason: string; ticks: number; }> | null;
        drift: { behind: number; ahead: number; dirty: string[]; } | null; primarySince: number | null;
        fleet?: FleetCaptures | null; waiting?: FleetWaiting | null; copies?: CopyPair[] | null; overdue?: { items: OverdueCandidate[] | null; unread?: string[]; };
        waits?: { stale: Parameters<typeof staleWaitReading>[0]["stale"]; bare: Parameters<typeof waitWithoutReasonReading>[0]["bare"]; manual: number; } | null;
        /** agent-org#1418: each declared repository's last whole read; OMITTED is "does not ask" (a poll host stamps nothing, so the live gate asks only on a webhook host) */
        sweeps?: SweepFact;
        pools?: PoolReading[] | null; toolAgreement?: { result: ToolAgreement; } | null; nodeStrips?: NodeStripFact | null; teamAccess?: TeamAccessFact; autoOff?: AutoOffFact; stateRows?: Parameters<typeof stateLabelReading>[0]["rows"]; idle?: import("../idle-with-open-rows.ts").IdleRows; shelvedCircle?: ShelvedCircle[] | null; releaseRuns?: ReleaseRuns | null; releaseFailures?: ReleaseFailureRead[] | null; fleetBuildIncident?: FleetBuildIncident[] | null; releaseBehind?: import("../release-behind-main.ts").RepoFact[] | null; boardTruth?: Parameters<typeof boardTruthTable>[0] | null; /** agent-org#1670: the pairs offered this tick when `BOARD_TRUTH_PAIR_FLAG` is on (`orgHealthTick` makes them); OMITTED keeps the set-keyed reading. */ boardTruthOffers?: BoardTruthOffer[] | null;
        classRepeat?: import("../class-repeat.ts").ClassRepeatFact | null; milestoneClock?: Omit<MilestoneClockFact, "endedAt"> | null;
        claimRefusals?: ClaimRefusal[] | null;
        /** agent-org#1218: `readRerunsOn5xx()`'s answer, `null` for an unreadable ledger and OMITTED when the caller does not ask (a default read would put a signal into every tick test, #1073). */
        rerunsOn5xx?: RerunOn5xx[] | null;
        /** agent-org#1218: reruns the code host shows (`RerunSeen`), `null` for a refused read and OMITTED when the caller does not ask; read with `rerunsOn5xx`, whose absence makes it unknown. */
        rerunsSeen?: RerunSeen[] | null;
        /**
         * agent-org#1135: `readFlagLedger()`'s answer, `null` for a refused read and OMITTED when the caller does not ask. THE TICK DOES NOT READ IT ITSELF, unlike the copies and the refusal ledger:
         * a default read of the project's declarations put a signal into 25 tests that assert the exact orders of a tick (the shape of agent-org#1073), so the live gate hands it over (`work-gate.ts`).
         */
        flagSwitches?: FlagLedger | null;
        /** agent-org#1208: the tick record's state file as `readTickRecordState` reads it; OMITTED when the caller does not ask, and handed over by the live gate for the reason `flagSwitches` is. */
        tickRecord?: TickRecordState;
        /** agent-org#1208: the tick wall's p50/p95 and the `tick-overran` wakes of the last 24 h (`tickHealthOf`); `null` is a cost file that could not be read, OMITTED is "does not ask". */
        tickHealth?: TickHealth | null;
        /** agent-org#1168: the approved-DIRTY readings. `enabled` is `health.approvedDirty`'s decision; OFF gives no reading, so the caller may always pass it. */
        approvedDirty?: ApprovedDirtyFacts;
        /** agent-org#1248: the approved-REVIEW_REQUIRED reading. `enabled` is `health.approvedRequired`'s decision; OFF gives no reading, so the caller may always pass it. */
        approvedRequired?: ApprovedRequiredFacts;
        /** agent-org#1667: the named classed-OUTSIDE pull requests. `enabled` is `reviews.outsideSessionPr`'s decision; OFF gives no reading, so the caller may always pass it. */
        sessionPrOutside?: SessionPrOutsideFact;
    }): Reading[] {
  const readings = [noMergeReading(facts), redPrReading(facts), refusedRowReading(facts),
    primaryReading({ now: facts.now, drift: facts.drift, since: facts.primarySince })];
  if (facts.fleet !== undefined) readings.push(fleetIdleReading({ now: facts.now, fleet: facts.fleet, waiting: facts.waiting ?? null }));
  if (facts.copies !== undefined) readings.push(copyDriftReading({ pairs: facts.copies }));
  if (facts.overdue !== undefined) readings.push(overdueReading({ now: facts.now, ...facts.overdue }));
  if (facts.reviewGated !== undefined) readings.push(reviewGatedUnaskedReading({ now: facts.now, prs: facts.reviewGated }));
  if (facts.waits !== undefined) {
    readings.push(staleWaitReading({ now: facts.now, stale: facts.waits?.stale ?? null }),
      waitWithoutReasonReading({ now: facts.now, bare: facts.waits?.bare ?? null, manual: facts.waits?.manual }));
  }
  if (facts.pools !== undefined) readings.push(poolLowReading({ pools: facts.pools }));
  if (facts.toolAgreement !== undefined) readings.push(toolVersionReading({ agreement: facts.toolAgreement }));
  if (facts.nodeStrips !== undefined) readings.push(nodeCannotStripReading({ fact: facts.nodeStrips }));
  if (facts.teamAccess !== undefined) readings.push(teamAccessReading({ access: facts.teamAccess }));
  if (facts.sweeps !== undefined) readings.push(sweepOverdueReading({ now: facts.now, sweeps: facts.sweeps }));
  if (facts.autoOff !== undefined) readings.push(autoOffRefusalReading({ now: facts.now, autoOff: facts.autoOff }));
  if (facts.stateRows !== undefined) readings.push(stateLabelReading({ rows: facts.stateRows, now: facts.now }));
  if (facts.boardTruth !== undefined) readings.push(...boardTruthReadings({ audit: facts.boardTruth, day: isoOf(facts.now).slice(0, 10), offers: facts.boardTruthOffers }));
  if (facts.idle !== undefined) readings.push(idleWithOpenRowsSignal({ idle: facts.idle }));
  if (facts.shelvedCircle !== undefined) readings.push(shelvedCircleReading({ circles: facts.shelvedCircle }));
  // agent-org#887: the per-repository reading REPLACES the project-only one when the caller asks for it (the gate does); a caller that gives only `releaseRuns` still gets the old reading
  if (facts.releaseFailures !== undefined) readings.push(...releaseFailureReadings({ failures: facts.releaseFailures }));
  else if (facts.releaseRuns !== undefined) readings.push(releaseFailedReading({ releaseRuns: facts.releaseRuns }));
  if (facts.fleetBuildIncident !== undefined) readings.push(fleetBuildMixedReading({ now: facts.now, incident: facts.fleetBuildIncident }));
  if (facts.releaseBehind !== undefined) readings.push(...releaseBehindReadings({ now: facts.now, behind: facts.releaseBehind }));
  if (facts.classRepeat !== undefined) readings.push(...classRepeatReadings({ now: facts.now, classRepeat: facts.classRepeat }));
  if (facts.milestoneClock !== undefined) readings.push(milestoneClockReading({ now: facts.now, fact: facts.milestoneClock === null ? null : { ...facts.milestoneClock, endedAt: facts.lastMergedAt } }));
  if (facts.claimRefusals !== undefined) readings.push(claimRefusalStormReading({ now: facts.now, refusals: facts.claimRefusals }));
  if (facts.rerunsOn5xx !== undefined) readings.push(requiredRedOn5xxReading({ now: facts.now, reruns: facts.rerunsOn5xx }));
  if (facts.rerunsSeen !== undefined) readings.push(manualRerunsReading({ now: facts.now, seen: facts.rerunsSeen, ledger: facts.rerunsOn5xx ?? null }));
  if (facts.flagSwitches !== undefined) readings.push(flagSwitchReading({ day: isoOf(facts.now).slice(0, 10), ledger: facts.flagSwitches }));
  if (facts.tickRecord !== undefined) readings.push(tickRecordReading({ now: facts.now, state: facts.tickRecord }));
  if (facts.tickHealth !== undefined) readings.push(tickWallReading({ day: isoOf(facts.now).slice(0, 10), health: facts.tickHealth }));
  if (facts.approvedDirty !== undefined) readings.push(...approvedDirtyReadings({ now: facts.now, ...facts.approvedDirty }));
  if (facts.approvedRequired !== undefined) readings.push(...approvedRequiredReadings({ now: facts.now, ...facts.approvedRequired }));
  if (facts.sessionPrOutside !== undefined) readings.push(...sessionPrOutsideReadings({ now: facts.now, ...facts.sessionPrOutside }));
  return readings;
}

/** What a prompt says about each signal, in the chairman's words where they have them. */
const REMEDY = (Object.freeze({
  [SIGNALS.NO_MERGE]: "Nothing is landing while something could. Find which link is stuck (a green PR with no approval, an engineer pool that "
    + "cannot claim, a queue ruleset, a stopped tick), then FIX IT or FILE IT `" + READY_LABEL + "` WITH AN OWNER in this turn.",
  [SIGNALS.RED_PR]: "A red PR was ordered to its owner on its first red and nothing came of it. Read why (`gh pr checks <n>`), then fix it, "
    + "re-lane it by putting the label of a session that can on the PR (`pr-checks-failing` names the label shape), or close it if it is abandoned.",
  [SIGNALS.REFUSED_ROW]: "`product-manager` was told at 15 ticks and the claim is still refused. The refusal text is quoted: read whose tree "
    + "it is (`pnpm run worktree:whose -- <path>`), and free the row or take it off the shelf.",
  [SIGNALS.PRIMARY]: "`primary-stale` told you when this began and the primary is still behind. Every order the gate gives is given from the "
    + "primary's code, so the org has been running stale for this long: follow `primary-stale`'s own steps (save the diff first).",
  [SIGNALS.FLEET_IDLE]: "The fleet has captured nothing for a day and something needs it. Read why before anything else (`pnpm run fleet:status` is "
    + "`orchestrator`'s to run, not yours): a worker that cannot capture, a lab job that never started, or a row nobody dispatched. "
    + "`orchestrator` owns fleet and lab questions, so put the finding on the row and `" + ANSWER_PREFIX + "orchestrator` on it rather than running the fleet yourself.",
  [SIGNALS.COPIES]: "A declared copy no longer matches its original. Neither is known to be the right one: read both (`git log -3 -- <path>` for each), "
    + "then carry the change to the other side and move the commit in the copy's header. `agent-org-outward-edges.test.ts` is the exact check "
    + "and will go red on `main`'s next PR until you do.",
  [SIGNALS.OVERDUE]: "Each item named has been open longer than three times the median it takes to merge (a PR) or close (a claimed row), and nothing has merged "
    + "or closed it: a comment, a hold or a push does not stop this clock. The reason in brackets is a LABEL for who owes the next move, never an excuse: "
    + "`conflicted` and `red` are the owner's to fix, `awaiting-review` needs a verdict (`reviewer-<n>`, or `product-manager` when the PR has none), "
    + "`awaiting-author-draft` is its author's to mark ready, `unarmed` is `product-manager`'s, `held-on-purpose` is a hold or a freeze that may have outlived its "
    + "reason (read its `Waiting-for:`, and lift it if the condition is true). The owner may already have been ordered and nothing came of it: READ WHY "
    + "(`gh pr view <n>`), then unstick it, re-lane it by putting the label of a session that can on it, or close it if it is abandoned.",
  [SIGNALS.REVIEW_GATED_UNASKED]: "A red PR whose failing checks name a review as their remedy has had no reviewer ordered at its head for over two hours. The "
    + "gate has the answer and asked nobody: read why (`gh pr checks <n>`, and the `Cleared-by:` line each named check's summary carries), then order a reviewer "
    + "by hand, or re-lane the PR to a session that can, or make the check name a different remedy if the review is the wrong one.",
  [SIGNALS.STALE_WAIT]: "Each wait named still stands although the condition it declared is true: the reason is gone and the wait is a stall, not "
    + "health. The setter was ordered with the exact field to remove and did not. Remove it yourself (`pnpm run pr:hold -- <n> --session=<s> --release` "
    + "for a hold, `gh issue edit <n> --remove-label <label>` for a label, or the `Waiting-for:` line), or re-lane the item to a session that will.",
  [SIGNALS.ORDER_STALLED]: "Each order named has waited on a session that is busy for longer than the bound, and an order that waits is a stall nobody was told of "
    + "(#3406 held a green, approved draft this way). READ THE ORDER (`causeKey` names its cause and subject), then do what it asks yourself if it is a "
    + "finishing act (a ready-flip, a close-out), re-lane it by putting the label of a free session on the row or PR, or tell the busy session's owner what it "
    + "is not reading. A queue named is a standing seat's inbox whose oldest order is that old: that seat is never between tasks, so reduce what is sent to it.",
  [SIGNALS.POOL_LOW]: "An API pool is nearly spent. Every session on that account is about to sleep on its reset. READ WHICH CALLS SPENT IT before the "
    + "reset (a `gh` read is 1 point or more; `gh project item-*` and the board snapshot read the whole Project), prefer `gh api` REST reads for polling, "
    + "and do NOT switch to another account's `gh` config to get past it: which account a write is attributed to is `ceo`'s, and the pool comes back.",
  [SIGNALS.PANE_AT_PROMPT]: "Each pane named is waiting for a person to answer a prompt (Codex's working-directory picker, or a trust prompt), so the session in it has "
    + "not started and will not: the pane reports no failure. READ THE PANE (`herdr --session org pane read <pane> --source visible`), then answer it "
    + "if the session is still wanted (`herdr --session org pane send-keys <pane> Enter`), or close the workspace if it is not -- a reviewer whose pull "
    + "request is closed or merged is the second (`reviewer teardown` ends those by itself when it can see them). A trust prompt on a clone is the "
    + "reviewer's own codex config to edit, not a tick's.",
  [SIGNALS.TOOL_VERSION]: "Each runner named has run an older `agent-org` than the newest release for longer than one release cycle (the tick's interval, the tag lag and one more tick), so \"the org runs the latest\" "
    + "is not true of it. READ `node src/lib/tool-version-agreement.ts` (or `host:check`) in the tool checkout for the whole list. A `tool` runner is the work-tick's `update-tool`, which should have moved the checkout to "
    + "the newest tag: read the tick's first journal line and why it did not. A `worktree` runner resolves a COPY of the dependency through its `node_modules`: until the removal row (#3534) merges it is the pin, "
    + "and after it a copy that is still there is stale (`pnpm install` in that worktree, or remove it). A `ci` runner names the version the last `ci.yml` run on `main` used: its lockfile's, or the tag its resolver step printed.",
  [SIGNALS.NODE_CANNOT_STRIP]: "Each `node` named cannot strip types (`process.features.typescript` is not `strip` or `transform`, or the binary could not be run), so any unit or script that runs a `.ts` "
    + "file with it dies at start: ADR 0043 Decision 8 chose upstream Node 24 for exactly this. READ `/usr/bin/node -p process.features.typescript` (and the path named), then reinstall upstream Node 24 "
    + "for the agent user (" + homeProjectDeclaration().tracker[0].repo + "#4388) or correct the `ExecStart` that names the wrong binary: a distro `nodejs +dfsg` package is the usual cause and it comes back with an apt upgrade. A host action for `orchestrator`.",
  [SIGNALS.SWEEP_OVERDUE]: "A declared repository has gone unread for longer than the sweep promises, so the pull requests and rows in it wait unseen. Find why its whole read "
    + "is not landing (a refused read or a paced skip in this tick's log, or the webhook queue that should have named it), then FIX IT: the next whole read stamps the repository and clears this.",
  [SIGNALS.TEAM_ACCESS]: "An org team holds a level on a repository that the project's declaration (`teamAccess.declaration` in `.agent-org/project.json`) does not give: `admin` anywhere it reaches, "
    + "or a level other than the declared one on a declared repository. DO NOT CHANGE THE TEAM'S LEVEL YOURSELF: it is an org-admin act, the chairman's. Read the declaration's own prose "
    + "for what the level should be, then put the repositories named on #928 and `" + ANSWER_PREFIX + "ceo` on the row that carries them, or open the pull request that declares the level if the declaration is the one that is wrong.",
  [SIGNALS.AUTO_OFF_REFUSING]: "The fleet's auto-off timer holds every shutdown back because the checkout it runs from is not `main`'s (`stale-checkout`), its `git fetch` failed (`fetch-failed`) or "
    + "the comparison could not be made (`cannot-tell`), so idle workers stay powered ON. It is loud by design and was unread: 2,569 refusals over twelve hours on 2026-10-06. READ THE REASON AND DETAIL "
    + "above, then have `orchestrator` (the first reader for fleet questions) bring the control plane's checkout to `main` or fix the fetch. DO NOT RUN `fleet:*` YOURSELF, and do not clear the record by "
    + "hand: it clears when a tick proceeds. Say on #928 what the refusal was and what ended it.",
  [SIGNALS.BOARD_TRUTH]: "Each row in the table disagrees with what is true of it, and the table names the FIELD that does. `product-manager` reads it first and fixes what a field fixes: CLOSE an epic whose "
    + "children are closed or a row whose closing PR merged, LIFT a wait that is already true, keep the ONE state label that is true. A row marked for its owner needs a judgment (a claim nobody holds, a duplicate): "
    + "release the claim or close the duplicate with the reason on the row. Do not script the repair, and post the day's table on #928 so a count of 0 is a statement and not silence.",
  [SIGNALS.STATE_LABEL]: `A row is in exactly ONE of ${STATE_LABELS.map((l) => `\`${l}\``).join(", ")}, and each row named is in none or in several. A row in none is absent from the `
    + "Ready lane, the claim pool and every label-keyed count, and `ready:audit`'s `labelless rows` could not see it while it held any other label at all. `product-manager` reads it first: PROMOTE a row in none "
    + `(\`${READY_LABEL}\` if it is startable, else \`${BACKLOG_LABEL}\`), and for a row in several keep the ONE that is true (\`epic\` REPLACES \`${BACKLOG_LABEL}\`, and so does \`parked\` ONLY while its wait is real: READ the wait first, and a \`Waiting-for:\` that is true, free text or absent, or a passed \`Not-before:\`, leaves \`parked\` untrue, #4230), by hand with the reason on the row. `
    + "Do not script the repair; read `ready:audit`'s `state labels` line for the count against what GitHub reports.",
  [SIGNALS.IDLE_WITH_OPEN_ROWS]: "Nobody is building and rows are open: each row named is the reason it is not being built, from a closed list. MOST ARE STATES THE ORG CHOSE (`BACKLOG`, `PARKED`, `EPIC`, "
    + "`BLOCKED_BY` an open row, `WAITING_FOR` a declared condition, `ANSWER_OWED`, `LANE`, `B4 overlaps`): read whether the one holding the most is still true, and PROMOTE or UNBLOCK it if it is not. "
    + "`NO_STATE_LABEL` and `TWO_STATE_LABELS` are `row-without-exactly-one-state`'s. **`READY_UNOFFERED` IS A DEFECT, NOT A STATE**: a `" + READY_LABEL + "` row the gate has no reason to withhold while no one works, "
    + "so the offer is wrong or is not being taken; read `work:tick`'s own output for it and FILE what you find `" + READY_LABEL + "` WITH AN OWNER in this turn. Rows waiting on a `Not-before:` date are counted and not named. "
    + "It clears the tick an engineer holds a row.",
  [SIGNALS.SHELVED_CIRCLE]: "A row B4 shelves against a pull request that WAITS ON THAT ROW is a circle: the row cannot be claimed while the PR is open on its file, and the PR cannot merge until the row closes. Each row and PR is named above, with the route from the PR "
    + "back to the row and why the PR is not counted as the row's own work. `product-manager` reads it first and breaks the circle at ONE end: the PR declares `Closes:` for the row it is the vehicle of (in a LAYER repository's PR the row is written QUALIFIED, "
    + "`<tracker owner/repo>#<n>`, because a bare number there is that repository's own issue and the gate drops it), or the row's Region is narrowed to files the PR does not touch. Do not lift the PR's hold to escape it: say on the row which end you broke.",
  [SIGNALS.RELEASE_FAILED]: "The newest `release.yml` run on `main` that concluded failed, and no later run has succeeded, so what merged since is NOT released and the tag the org follows is behind. "
    + "The job (and step) are named above: READ THE RUN'S LOG for that step before choosing. A cause that was TRANSIENT (a runner lost, a registry or network error) is retried from the SAME run: "
    + "`gh run rerun <run id> --failed -R <the repository in the URL above>`. A cause FIXED ON `main` since (the run is at an older sha) needs a NEW run, which a rerun of the old one does not give: "
    + "`gh workflow run release.yml --ref main -R <repository>`. If the cause is not fixed yet, FILE THE FIX `" + READY_LABEL + "` WITH AN OWNER in this turn. "
    + "Do not wait for the next changeset: a run is only ever started by a merge that carries one, so waiting leaves it red for as long as nobody merges one. It clears the tick a later run succeeds.",
  [SIGNALS.FLEET_BUILD_MIXED]: "An OPEN `incident` issue whose body carries `" + FLEET_BUILD_INCIDENT_LINE + "` has stood open for " + FLEET_BUILD_MIXED_HOURS + " hours or more, so the fleet has stayed on MIXED Windows builds that long and did not move forward. "
    + "The incident is named above with its box count and its age. READ THE INCIDENT and the fleet's build status before choosing: `fleet-watch` files it on the first mismatch and closes it only when the fleet reads one build. "
    + "Do not close the incident by hand to clear this; the signal clears when the incident is closed by the fleet, and a close the fleet did not earn only hides the mismatch. Offer the fix that moves the lagging boxes to the target build as a row, `" + READY_LABEL + "`, with an owner. "
    + "It clears the tick no open incident is over the bound.",
  [SIGNALS.RELEASE_BEHIND_MAIN]: "A repository's `main` holds a commit on a releasable path that no release carries, and the oldest is over a day old: a consumer is on the old version. The release, the oldest commit "
    + "and its pull request are named above. FIND WHY IT WAS NOT RELEASED before choosing: the pull request carried no changeset (`changeset-required` is the gate that stops that, and this repository may not have adopted it), "
    + "a release run failed after the merge (`release-run-failed` would be tripped too), or the change should not ship and its pull request lacks a `no-release: <reason>` line. Then ADD THE CHANGESET in a pull request "
    + "(`.changeset/<name>.md`) so the release run takes it, or put `no-release: <reason>` in the pull request's body if the change ships nothing, and FILE what you find `" + READY_LABEL + "` WITH AN OWNER in this turn. "
    + "It clears the tick a release is newer than the commit, and a commit a `no-release:` line declares is not counted.",
  [SIGNALS.CLASS_REPEAT]: "A class of failure in `" + FAILURE_CLASSES_PATH + "` now has a SECOND closed row, and a repeat means THE GUARD THE INDEX NAMES FAILED (or, where the guard is `null`, was never in force). "
    + "Do NOT fix the newest instance and stop: that is what the first one got. READ BOTH ROWS and the guard above, and decide which it is: the guard exists and did not fire (find why and fix it, so the NEXT instance is stopped), "
    + "the guard covers a narrower population than the class (widen it), or the second row is not the class at all (remove its `" + CLASS_LABEL_PREFIX + "<id>` label and say why on the row). "
    + "FILE what you find `" + READY_LABEL + "` WITH AN OWNER in this turn, and say on #928 which class it was. It is offered ONCE for this newest row: a third row under the class is a new offer, "
    + "and it stops being repeated after ninety minutes whether or not anyone acted, so the row you file is the record.",
  [SIGNALS.MILESTONE_CLOCK]: "The primary milestone is the chairman's goal, and for longer than two hours no row of it has been claimed or in a pull request: the outcome clock cannot see that, because it clocks only items that are being worked. "
    + "The oldest open row is named with its state and who owes its next move: THAT SESSION READS THIS ALARM, so route it (`" + ANSWER_PREFIX + "<session>` on the row), and do not act on the row yourself unless it is yours. "
    + "A parked or backlog row needs `product-manager` to PROMOTE it or say why not; a date-held row is correctly waiting, so ask whether another row of the milestone could start now; a blocked row's blocker is the row to read. "
    + "It is keyed on the milestone and the named row, so it is re-asked when the named row changes, and it clears the tick a row is claimed or a pull request opens against one.",
  [SIGNALS.WAIT_WITHOUT_REASON]: "Each item named holds a wait (`hold:*`, `" + ANSWER_PREFIX + "*`, the blocked label or `parked`) that says nothing about what it waits for, and nothing "
    + "has moved on it for hours (a `parked` row with no reason is named at once: the park with no reason is the defect). A wait nobody can check is how the 2026-10-02 freeze stood four hours after it ended. Ask its setter what ends it and write "
    + "`Waiting-for: <closed|merged|labelled <label>|unlabelled <label>> <#n>` on it, or remove the wait.",
  [SIGNALS.CLAIM_REFUSAL_STORM]: "More than " + CLAIM_REFUSAL_STORM_REFUSALS + " claims were refused inside " + CLAIM_REFUSAL_STORM_MINUTES + " minutes, so rows are Ready and no engineer can take them, which includes the one who would fix this. "
    + "The most frequent reason is quoted above: READ IT FIRST. A `COULD NOT DETERMINE` / `BEHIND THE RELEASE` reason is the stale-rule guard (`src/row-claim/stale-rule-guard.ts`) refusing from a checkout that is behind the newest release: "
    + "run `update-tool` in the tool checkout, or find why the release did not cut (`release-run-failed`). Any other reason is the claim's own rule: fix the cause or file it `" + READY_LABEL + "` with an owner in this turn, and "
    + "do not clear the signal by editing the ledger, which only hides the storm.",
  [SIGNALS.FLAG_WITHOUT_SWITCH]: "Each flag named shipped without its switch: the code reads it as OFF when absent, so the change it guards is merged and not running, and nobody decided that. "
    + "The chairman's rule (a11ign#928, 2026-10-12) is that a flagged change ships with its a11ign switch row, filed at the same time. For each key, file that row `" + READY_LABEL + "` WITH AN OWNER in this turn "
    + "(or find the one already filed and say so on it), naming the declaration file that carries the key and the value to set. `false` counts as decided, so a flag the org means to leave off is set to `false`, "
    + "not left absent. A flag switched by `machinery:flag` is not counted (`FLAGS_WITH_ANOTHER_HOME`); one that is, and should not be, is a change to that map and not to a declaration.",
  [SIGNALS.TICK_RECORD_UNWRITTEN]: "The tick could not write its record: a slow tick is recorded on one standing row (a comment the tick edits in place) and wakes nobody, so a write that fails is "
    + "this line and not an order per overrun. The reason is quoted above. A `units.tickRecordIssue` that is not declared is a change to the project declaration (`.agent-org/project.json`, the "
    + "first tracker's row); a refused `gh` write is the token or the row, and the next tick retries by itself. Do NOT clear it by deleting `tick-record.json`, which only hides the outage.",
  [SIGNALS.TICK_WALL_HIGH]: "The tick's wall is past its limit at the 95th percentile over the last 24 h: more than one tick in twenty overran. The figures are above (p50, p95, the slow ticks "
    + "recorded on the standing row, and `tick-overran` wakes per day, where slow reads 0 and killed is the one case that still wakes). This is a trend to read, not a tick to act on: open the "
    + "standing row's table (the longest phase of each slow tick is named there) and file one row for the phase that dominates, or say it is the host and not the code. A single overrun is never an order.",
  [SIGNALS.QUEUE_ENTRY_NO_RUN]: "A merge-queue entry's group never got its checks requested, so no run was ever created and the queue sat behind it (a11ign#5227, 50 minutes, 2026-10-12). The gate dequeues and "
    + "re-queues such an entry ONCE with no model turn (flag `queue.queueEntryNoRun`) and counts each; the count above is how often GitHub drops the event. An INCIDENT line is the same pull request with no run AGAIN "
    + "after that one re-queue, which the gate does not repeat: read why it came to (`why`), look at the pull request's merge-queue timeline and the repository's Actions status, re-queue it by hand "
    + "(`gh pr merge <n> --auto --merge` after the dequeue) if the queue is still stuck, and FILE what you find `" + READY_LABEL + "` WITH AN OWNER in this turn. "
    + "A count with no incident needs no act: it is the measurement, and `queue-entry-no-run.json` in the state directory keeps the day's number.",
  [SIGNALS.QUEUE_HEAD_AGE]: "The merge queue's position-1 entry has stood longer than the detector's limit, so everything behind it waits. The detail says whether any run exists on its group: none is "
    + "`queue-entry-no-run`'s shape (the gate re-queues it once, if its flag is on); a run that is queued or hung is the runner or the workflow, and a run that is red leaves the queue by itself. "
    + "Read the entry's pull request and its newest `merge_group` run before choosing, and FILE what you find `" + READY_LABEL + "` WITH AN OWNER in this turn. It clears the tick the head entry is younger than the limit or gone.",
  [SIGNALS.REQUIRED_RED_ON_5XX]: "The tick reran a required check once because its last error was a GitHub 5xx, not the code (`checks rerun on 5xx` in the ledger beside the delivery ledger). "
    + "A count with no incident needs no act: it is the measurement of how often GitHub breaks a required check, and the run ids are in the detail. A day that climbs is GitHub's and goes on the row that owns the rerun.",
  [SIGNALS.MANUAL_RERUNS]: "A person reran a run whose last error was a GitHub 5xx, so the detector did not answer it first: the switch `ci.rerunOn5xx` was off, the tick was not running, or it read the log differently. "
    + "Read each run's log, and if the tick should have rerun it FILE the miss `" + READY_LABEL + "` WITH AN OWNER in this turn; if the switch is simply off, say so on the switch row.",
  [APPROVED_DIRTY_SIGNAL]: "An approved pull request has been DIRTY (it conflicts with main) for more than " + APPROVED_DIRTY_MINUTES + " minutes and nobody has pushed to its head inside that window, so it cannot land and nothing is rebasing it. "
    + "The named PRs are above. Rebase each one onto main, or if its author is away, say so on the PR and name who takes it; a push to the head clears the finding, and so does a merge. "
    + "Do not clear it by approving again, which changes nothing about the conflict.",
  [HOLDS_PER_PR_SIGNAL]: "A pull request carries " + HOLDS_PER_PR + " or more `hold:` labels at once, so each hold is someone's stop on it and nobody is moving it. "
    + "For each named PR, read the holds, drop the ones that are no longer true, and name in a comment the one that still stops it and who lifts it.",
  [SAME_WAY_RERUN_SIGNAL]: "The last two runs on a pull request's head failed the same jobs, so another rerun repeats the same failure and answers nothing. "
    + "Read the failing job's log and fix the cause on the branch; do not rerun the job again until a push changes the code.",
  [APPROVED_REQUIRED_SIGNAL]: "An approved pull request has been held at REVIEW_REQUIRED for more than " + APPROVED_REQUIRED_MINUTES + " minutes, so it cannot land. The approval on its head does not count toward "
    + "the merge rule: usually a permission or a rule that excludes the approving identity, not a failing check. The named PRs are above. Read which rule or permission excludes the approver, say it on each PR, "
    + "and fix that setting (not the PR). A new head, a merge or a close clears the finding. Do not approve again, which changes nothing about the rule.",
}) as Readonly<Record<string, string>>);

/** @returns who is ordered: the signal's first reader if it has one, then `ceo`, who takes every signal */
const readersOf = (signal: string): string[] => [...(FIRST_READERS[signal] ? [FIRST_READERS[signal]] : []), OFFERED_TO];

/**
 * ONE ORDER PER TRIPPED SIGNAL, to `ceo` (and to the signal's first reader where `FIRST_READERS` names one), the numbers in the prompt. THE PROMPT CARRIES THE OTHER TRIPPED SIGNALS, because a
 * session is delivered one order per tick (`repeating-lines.ts`' reason). An unknown or clear reading emits nothing here.
 */
export function orgHealthOrders(readings: Reading[]): { session: string; cause: string; subject: string; discriminator: string; prompt: string; causeKey: string; }[] {
  const tripped = readings.filter((r) => r.status === "tripped" && r.incidentOnly !== true); // agent-org#887: an incident-only reading is raised as an incident and orders no one
  return tripped.flatMap((r) => readersOf(r.signal).map((session) => {
    const others = tripped.filter((o) => o !== r).map((o) => o.signal);
    const when = r.firstTrippedAt ? ` It first tripped at ${isoOf(r.firstTrippedAt)}.` : "";
    return {
      session,
      cause: "org-health",
      subject: r.signal,
      discriminator: (r.discriminator as string),
      prompt: `ORG HEALTH: \`${r.signal}\` HAS TRIPPED. ${r.detail}.${when}\n${REMEDY[r.signal]}\n`
        + "This is asked because the org fixes what it is told about and does not look (the chairman, 2026-10-01): leave the place "
        + "better than you found it, and say on #928 what you found and did. It holds for two hours unchanged and stops when the "
        + `condition clears.${others.length > 0 ? `\nALSO TRIPPED (${others.length}): ${others.join(", ")}.` : ""}`,
      causeKey: `${session}/org-health/${r.discriminator}`,
    };
  }));
}

/**
 * A tree that holds copy headers but NONE of their originals is an extracted tool, not a product checkout, and there is nothing to
 * compare it against: no reading, which is not "clear" and not "unknown" (a stated unknown here would repeat every tick forever).
 */
function copiesToCompare(pairs: CopyPair[] | null): CopyPair[] | null | undefined {
  if (pairs !== null && pairs.length > 0 && pairs.every((pair) => pair.originalText === null)) return undefined;
  return pairs;
}

/** agent-org#1670: the state the pair offers read and write: the canary's file, which holds the flag, and `BOARD_TRUTH_PAIRS_FILE`, both in the state directory. */
export type BoardTruthPairIo = { readCanary: () => string | null; readPairs: () => string | null; writePairs: (text: string) => void; };

/** @returns the IO of a real tick: an absent file is `null`, and a write goes through a rename so a killed tick leaves the old file whole (`realCanaryIo`'s rule). */
export function realBoardTruthPairIo(): BoardTruthPairIo {
  const read = (path: string) => (existsSync(path) ? readFileSync(path, "utf8") : null);
  const pairsPath = () => stateEntryPath(BOARD_TRUTH_PAIRS_FILE);
  return {
    readCanary: () => read(stateEntryPath(CANARY_STATE_FILE)),
    readPairs: () => read(pairsPath()),
    writePairs: (text) => {
      const path = pairsPath();
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(`${path}.tmp`, text);
      renameSync(`${path}.tmp`, path);
    },
  };
}

/** A pair key is the row number then the question name, as `boardTruthPairOffers` builds it (`5577wait-already-true`). */
const BOARD_TRUTH_PAIR_KEY = /^\d+[a-z][a-z-]*$/;

/**
 * @returns the pairs file as it stands: `{}` when absent. A file that is not an object of pairs, or holds an entry that is not `{offers, lastSeen}` (a whole
 * count of at least 1, a finite clock), THROWS, because a pairs state read wrong would offer every standing pair again, or rewrite a NaN count that offers nothing.
 */
function parseBoardTruthPairs(text: string | null): BoardTruthPairs {
  if (text === null || text.trim() === "") return {};
  const raw = JSON.parse(text) as unknown;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error(`${BOARD_TRUTH_PAIRS_FILE} is not an object of pairs`);
  for (const [pair, seen] of Object.entries(raw)) {
    const { offers, lastSeen } = (typeof seen === "object" && seen !== null ? seen : {}) as { offers?: unknown; lastSeen?: unknown; };
    const wellFormed = BOARD_TRUTH_PAIR_KEY.test(pair) && typeof offers === "number" && Number.isInteger(offers) && offers >= 1
      && typeof lastSeen === "number" && Number.isFinite(lastSeen);
    if (!wellFormed) throw new Error(`${BOARD_TRUTH_PAIRS_FILE} entry "${pair}" is not {offers, lastSeen} for a row and question`);
  }
  return raw as BoardTruthPairs;
}

/**
 * agent-org#1670: THE PAIR OFFERS OF THIS TICK. `undefined` when the flag is OFF (or its state is unreadable, which reads OFF, `machineryFlagOn`'s rule), so the set-keyed
 * reading stands as it always has; otherwise the offers `boardTruthPairStep` makes, with the pairs file written. A pairs file that cannot be read or written makes NO offer this
 * tick, said on stderr, and the next tick offers again: a state read wrong would forget a pair already offered, so a failure never falls back to the set-keyed order.
 */
export function boardTruthPairOffers({ audit, now, io, log = (line) => process.stderr.write(line) }: { audit: Parameters<typeof boardTruthReading>[0]["audit"]; now: number; io: BoardTruthPairIo; log?: (line: string) => void; }): BoardTruthOffer[] | undefined {
  if (audit === null || audit.findings.length === 0) return undefined;
  let on: boolean;
  try {
    on = machineryFlagOn(parseCanaryState(io.readCanary()), BOARD_TRUTH_PAIR_FLAG);
  } catch (error) {
    log(`org-health: ${CANARY_STATE_FILE} is unreadable (${String((error as Error).message).split("\n")[0].slice(0, MAX_REASON_CHARS)}); ${BOARD_TRUTH_PAIR_FLAG} reads OFF.\n`);
    return undefined;
  }
  if (!on) return undefined;
  try {
    const step = boardTruthPairStep({ pairs: parseBoardTruthPairs(io.readPairs()), present: audit.findings.map((f) => `${f.number}${f.question}`), now });
    io.writePairs(`${JSON.stringify(step.pairs, null, 1)}\n`);
    return step.offers;
  } catch (error) {
    log(`org-health: ${BOARD_TRUTH_PAIRS_FILE} could not be read or written (${String((error as Error).message).split("\n")[0].slice(0, MAX_REASON_CHARS)}) -- no board order this tick; the next tick offers again.\n`);
    return [];
  }
}

/**
 * a11ign#5681 (agent-org#1716): THE OFFERS the board truth signal made this tick, for the canary: its tripped readings, one per offer (or one for the set-keyed order).
 * `null` when the signal was not read at all or any of its readings is unknown -- an unread board is never zero offers.
 */
export function boardTruthOfferCount(readings: Reading[]): number | null {
  const truth = readings.filter((r) => r.signal === SIGNALS.BOARD_TRUTH);
  if (truth.length === 0 || truth.some((r) => r.status === "unknown")) return null;
  return truth.filter((r) => r.status === "tripped").length;
}

/**
 * THE WHOLE TICK: say each unknown on stderr, return the orders. NEVER THROWS -- a detector that can crash the gate stops every
 * order behind it (`repeatingLinesTick`'s rule). Only unknowns are written: a tripped signal's report is its order, and a
 * line written every tick for a standing condition would be offered by `repeating-lines.ts` as a fault of its own.
 * THE COPIES ARE READ HERE, from disk, when the caller gives none: they are files of the checkout the tick runs from, so no
 * caller has them already, and a leaf that reads them keeps `work-gate.ts` out of it. In an extracted tree no original is
 * found, so the reading is left out rather than stated unknown every tick (`copiesToCompare`).
 */
export function orgHealthTick(facts: Parameters<typeof orgHealthReadings>[0], { log = (line) => process.stderr.write(line), readCopies = () => readDeclaredCopies(), readAutoOff = () => readAutoOffRefusal(), readRefusals = () => readClaimRefusals(), boardTruthIo = realBoardTruthPairIo(), onBoardTruthOffers }: { log?: (line: string) => void; readCopies?: () => CopyPair[] | null; readAutoOff?: () => AutoOffFact; readRefusals?: () => ClaimRefusal[] | null; boardTruthIo?: BoardTruthPairIo; onBoardTruthOffers?: (count: number | null) => void; } = {}) {
  try {
    const copies = facts.copies !== undefined ? facts.copies : copiesToCompare(readCopies());
    const autoOff = facts.autoOff !== undefined ? facts.autoOff : readAutoOff();
    const claimRefusals = facts.claimRefusals !== undefined ? facts.claimRefusals : readRefusals();
    const boardTruthOffers = facts.boardTruth === undefined ? undefined : boardTruthPairOffers({ audit: facts.boardTruth, now: facts.now, io: boardTruthIo, log }); // agent-org#1670
    const readings = orgHealthReadings({ ...facts, autoOff, claimRefusals, ...(copies === undefined ? {} : { copies }), ...(boardTruthOffers === undefined ? {} : { boardTruthOffers }) });
    for (const r of readings) if (r.status === "unknown") log(`org-health: ${r.signal} UNKNOWN -- ${r.detail}; it is not read as clear.\n`);
    onBoardTruthOffers?.(boardTruthOfferCount(readings)); // a11ign#5681: the canary's count, handed up and not returned, so the orders stay what they were
    return orgHealthOrders(readings);
  } catch (err) {
    log(`org-health: could not run (${String((err as any)?.message ?? err).split("\n")[0].slice(0, MAX_REASON_CHARS)}) -- no order this tick.\n`);
    return [];
  }
}
export const STANDARD_MACHINERY_SIGNALS: readonly string[] = Object.freeze(Object.values(MACHINERY_SIGNALS));
/** The signals no source in this tool reads yet: recorded as `null` every tick, so a change that names one is told it is UNKNOWN and not that it passed. */
export const UNSOURCED_MACHINERY_SIGNALS: readonly string[] = Object.freeze([MACHINERY_SIGNALS.INCIDENTS_NOT_REAL, MACHINERY_SIGNALS.RATE_LIMIT_REFUSALS]);

/**
 * One tick's reading of each signal over the span `from`..`to`; `null` is "not read", never zero. `held` (a11ign#5497) is set when the account pause held Claude work at
 * that tick: a stock read in a held hour is the pause's doing, not the norm, so that hour is no baseline.
 */
export type CanarySample = { from: number, to: number, values: Record<string, number | null>, held?: true };
export type SignalReading = { signal: string, status: "degraded" | "ok" | "unknown", before: number | null, after: number, detail: string };
export type FlagRecord = {
  on: boolean, signals: string[], onAt: number | null, verdict: "watching" | "passed" | "reverted" | null, decidedAt: number | null, readings: SignalReading[], incident: string | null,
};
export type CanaryState = { flags: Record<string, FlagRecord>, samples: CanarySample[], memo: Record<string, number> };

export const emptyCanaryState = (): CanaryState => ({ flags: {}, samples: [], memo: {} });

/** @returns the state of a file's text; an absent file is empty, and one that is not the shape THROWS (a state read wrong would forget a flag that is on). */
export function parseCanaryState(text: string | null): CanaryState {
  if (text === null || text.trim() === "") return emptyCanaryState();
  const raw = JSON.parse(text) as Partial<CanaryState>;
  const isMalformedFlags = typeof raw !== "object" || raw === null || typeof raw.flags !== "object";
  if (isMalformedFlags || !Array.isArray(raw.samples)) throw new Error(`${CANARY_STATE_FILE} is not { flags, samples, memo }`);
  return { flags: raw.flags ?? {}, samples: raw.samples, memo: raw.memo ?? {} };
}

/** @returns whether a flag is ON: a flag nobody turned on, or one the gate turned off, is OFF. Absence of the record is OFF, so a change reads `false` until it is switched on. */
export const machineryFlagOn = (state: CanaryState, name: string): boolean => state.flags[name]?.on === true;
