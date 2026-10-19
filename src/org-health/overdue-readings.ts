import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { brokenChecks } from "../red-pr.ts";
import { MANUAL_WAIT_HOURS, STALE_WAIT_GRACE_MINUTES, pastGrace } from "../wait-condition.ts";
import { AUTO_OFF_MIRROR_PATH, AUTO_OFF_MIRROR_STALE_MINUTES, AUTO_OFF_RECORD_STALE_MINUTES, AUTO_OFF_REFUSAL_MINUTES, DEFAULT_ROOT, FLEET_IDLE_HOURS, HOURS_FROM_MINUTES, MAX_NAMED, MAX_QUOTED_CHARS, MAX_REASON_CHARS, MINUTES_PER_TICK, MS_PER_HOUR, MS_PER_MINUTE, ORDER_STALL_MINUTES, OVERDUE_PR_MINUTES, OVERDUE_ROW_MINUTES, PANE_PROMPT_MINUTES, PRIMARY_STALE_MINUTES, RED_PR_MINUTES, REFUSED_TICKS, SIGNALS, ageText, clear, hourOf, hoursOf, isoOf, type Reading, type RedPr, type ReviewGatedPr, unknown } from "./thresholds.ts";

/** agent-org#1538: a review-gated red this long with no reviewer ordered at its head is unasked. The bound is the chairman's (2 hours, a11ign#5528). */
export const REVIEW_GATED_MINUTES = 120;

/**
 * WHEN DID THIS PULL REQUEST'S BREAKAGE BEGIN, or `null` when it has none to date (#2956). RED IS DECIDED ONCE, BY `red-pr.ts`
 * (`isBrokenRed`, #2954), and the question is asked of it here and not re-answered: `pr-checks-failing` excuses a hold only when the
 * hold is its ADDRESSEE's own (#2400), so a PR a worker owns and `ceo` holds is still ordered, and a count built from those orders
 * alone offered `ceo` its own freeze every day of it (#2883). THE HOLD'S OWN TWO JOBS ARE LEFT OUT and every other red is dated by
 * ITSELF: a held PR with a real `ts / run` failure is red since THAT check finished, not since the hold's `gate` did.
 * `options.holdStands` is `red-pr.ts`'s: whether the hold still EXCUSES (#2996), so a hold whose reason is gone dates the red it caused.
 * @returns epoch ms of the earliest broken check, `null` for none or for a broken check GitHub gave no time
 */
export function redSinceOf(pr: { labels?: any[]; statusCheckRollup?: any[]; }, options?: { holdStands?: (pr: any) => boolean; }): number | null {
  const times = brokenChecks(pr, options).map((check) => check.failedAt).filter(Number.isFinite);
  return times.length > 0 ? Math.min(...times) : null;
}

/**
 * Is this red PR UNATTENDED once `RED_PR_MINUTES` have passed?
 *
 * NO PUSH IS ASSUMED BY CONSTRUCTION, and the reason is a fact about this repo: the head is the one that went red, and a push
 * makes a new head with a new run, so a PR still red on its head has had none. THE OWNER'S COMMENT IS WHAT IS LEFT TO ASK. A PR WITH NO OWNER IS ALWAYS UNATTENDED: no
 * account is "its owner's", so a comment on it is not an owner's act and cannot excuse it (the 2026-10-01 case, #2941).
 */
function isUnattended(pr: RedPr, now: number) {
  if (pr.redSince === null || now - pr.redSince < RED_PR_MINUTES * MS_PER_MINUTE) return false;
  if (pr.owner === null) return true;
  const since = pr.redSince;
  return !pr.ownerCommentAts.some((at) => at >= since);
}

/**
 * SIGNAL 2: A RED PR NOBODY IS ON. `failingChecksOrder` woke the owner on the first red, and nothing asks whether that produced
 * a fix. `redPrs` is `null` for a refused PR read; one PR with no time makes the answer unknown unless another PR trips.
 */
export function redPrReading({ now, redPrs }: { now: number; redPrs: RedPr[] | null; }): Reading {
  if (redPrs === null) return unknown(SIGNALS.RED_PR, "the open pull requests could not be read");
  const tripped = redPrs.filter((pr) => isUnattended(pr, now)).sort((a, b) => (a.redSince as number) - (b.redSince as number));
  if (tripped.length === 0) {
    const undated = redPrs.filter((pr) => pr.redSince === null);
    return undated.length === 0 ? clear(SIGNALS.RED_PR)
      : unknown(SIGNALS.RED_PR, `${undated.length} red PR(s) carried no check time, so how long they have been red is not known`);
  }
  const first = (tripped[0].redSince as number) + RED_PR_MINUTES * MS_PER_MINUTE;
  const named = tripped.slice(0, MAX_NAMED).map((pr) => `#${pr.number} (red ${ageText((pr.redSince as number), now)}, `
    + `${pr.owner === null ? "NO OWNER" : `owner ${pr.owner}`})`);
  const more = tripped.length > MAX_NAMED ? `, and ${tripped.length - MAX_NAMED} more` : "";
  return { signal: SIGNALS.RED_PR, status: "tripped", firstTrippedAt: first, discriminator: `${SIGNALS.RED_PR}@${hourOf(first)}`,
    detail: `${tripped.length} PR(s) red over ${RED_PR_MINUTES} min with no comment from their owner since: ${named.join("; ")}${more}` };
}

/**
 * SIGNAL: A REVIEW-GATED RED PR NOBODY WAS ASKED TO CLEAR (agent-org#1538, a11ign#5528). A check that names a review as its remedy is answered by a
 * reviewer, not by its author, so a red with no reviewer ordered at its head is the gate sitting on its own answer. `prs` is `null` for a refused
 * PR read (unknown, never clear); a PR with no check time cannot be dated and makes the answer unknown unless another PR trips.
 */
export function reviewGatedUnaskedReading({ now, prs }: { now: number; prs: ReviewGatedPr[] | null; }): Reading {
  if (prs === null) return unknown(SIGNALS.REVIEW_GATED_UNASKED, "the open pull requests could not be read");
  const unasked = prs.filter((pr) => !pr.reviewerOrdered);
  const tripped = unasked.filter((pr) => pr.redSince !== null && now - pr.redSince >= REVIEW_GATED_MINUTES * MS_PER_MINUTE)
    .sort((a, b) => (a.redSince as number) - (b.redSince as number));
  if (tripped.length === 0) {
    const undated = unasked.filter((pr) => pr.redSince === null);
    return undated.length === 0 ? clear(SIGNALS.REVIEW_GATED_UNASKED)
      : unknown(SIGNALS.REVIEW_GATED_UNASKED, `${undated.length} review-gated red PR(s) carried no check time, so how long they have been red is not known`);
  }
  const first = (tripped[0].redSince as number) + REVIEW_GATED_MINUTES * MS_PER_MINUTE;
  const named = tripped.slice(0, MAX_NAMED).map((pr) => `#${pr.number} (red ${ageText(pr.redSince as number, now)}, no reviewer ordered at its head)`);
  const more = tripped.length > MAX_NAMED ? `, and ${tripped.length - MAX_NAMED} more` : "";
  return { signal: SIGNALS.REVIEW_GATED_UNASKED, status: "tripped", firstTrippedAt: first, discriminator: `${SIGNALS.REVIEW_GATED_UNASKED}@${hourOf(first)}`,
    detail: `${tripped.length} PR(s) red over ${REVIEW_GATED_MINUTES} min whose failing checks name a review as the remedy, with no reviewer ordered: ${named.join("; ")}${more}` };
}

/**
 * SIGNAL 3: A READY ROW THE CLAIM HAS REFUSED `REFUSED_TICKS` TICKS RUNNING. THE COUNTER IS #2845's, READ AND NOT RECOUNTED: it
 * is the streak `claimRefusalStreaksNow` already advanced this tick, and `product-manager` was told at 15 of them.
 *
 * KEYED ON THE ROW REFS, NOT AN HOUR, because the counter carries ticks and no time: an hour derived from `now` minus the ticks
 * drifts by a tick's jitter and would re-ask across an hour boundary. The set of refs changes only when a row enters or leaves.
 */
export function refusedRowReading({ refusals }: { refusals: Record<string, { reason: string; ticks: number; }> | null; }): Reading {
  if (refusals === null) return unknown(SIGNALS.REFUSED_ROW, "the claim-refusal counter was not read");
  const over = Object.entries(refusals).filter(([, seen]) => seen.ticks >= REFUSED_TICKS).sort(([a], [b]) => a.localeCompare(b));
  if (over.length === 0) return clear(SIGNALS.REFUSED_ROW);
  const named = over.slice(0, MAX_NAMED).map(([ref, seen]) => `${ref} (${seen.ticks} ticks, about ${hoursOf(seen.ticks * MINUTES_PER_TICK)} h): `
    + `${seen.reason.replace(/\s+/g, " ").slice(0, MAX_QUOTED_CHARS)}`);
  const more = over.length > MAX_NAMED ? `, and ${over.length - MAX_NAMED} more` : "";
  return { signal: SIGNALS.REFUSED_ROW, status: "tripped", firstTrippedAt: null,
    discriminator: `${SIGNALS.REFUSED_ROW}@${over.map(([ref]) => ref).join(",")}`,
    detail: `${over.length} Ready row(s) refused over ${REFUSED_TICKS} ticks: ${named.join("; ")}${more}` };
}

/**
 * SIGNAL 4: THE PRIMARY CHECKOUT HAS STOOD OFF `origin/main` FOR `PRIMARY_STALE_MINUTES`. `primary-stale` already tells `ceo` on
 * the tick it appears (#2781) and is CONSUMED here, not rebuilt: this adds the AGE, which is what says that the first telling did
 * not produce a fix. `drift` is `null` when the primary could not be asked (a linked worktree, CI, a git refusal), and `since` is
 * `null` when the drift carried nothing to date it by.
 */
export function primaryReading({ now, drift, since }: { now: number; drift: { behind: number; ahead: number; dirty: string[]; } | null; since: number | null; }): Reading {
  if (drift === null) return unknown(SIGNALS.PRIMARY, "the primary checkout could not be asked (a linked worktree, CI, or git refused)");
  if (drift.behind === 0 && drift.ahead === 0 && drift.dirty.length === 0) return clear(SIGNALS.PRIMARY);
  if (since === null) return unknown(SIGNALS.PRIMARY, "the primary is off origin/main but nothing dated how long");
  const tripAt = since + PRIMARY_STALE_MINUTES * MS_PER_MINUTE;
  if (now < tripAt) return clear(SIGNALS.PRIMARY);
  return { signal: SIGNALS.PRIMARY, status: "tripped", firstTrippedAt: tripAt, discriminator: `${SIGNALS.PRIMARY}@${hourOf(tripAt)}`,
    detail: `the primary has been off origin/main for ${ageText(since, now)} (since ${isoOf(since)}): ${drift.behind} commit(s) behind, `
      + `${drift.ahead} ahead, ${drift.dirty.length} dirty tracked path(s)` };
}

/**
 * What the fleet did in the last `FLEET_IDLE_HOURS`: how many captures, and when the last one finished (`null` when none is known).
 */
export type FleetCaptures = { captures24h: number, lastCaptureAt: number | null };
/**
 * What is waiting for the fleet: open `fleet-gated` rows nothing else stops, and lab jobs queued for it.
 */
export type FleetWaiting = { rows: (number | string)[], labJobs: string[] };

/**
 * SIGNAL 5: THE FLEET HAS CAPTURED NOTHING FOR `FLEET_IDLE_HOURS` WHILE SOMETHING IS WAITING FOR IT (#2937).
 *
 * AN IDLE FLEET NOBODY NEEDS IS HEALTHY, so the idleness alone is never a trip: it needs a `fleet-gated` row or a lab job to be
 * waiting. THE IDLENESS IS TESTED FIRST, as `noMergeReading` tests its gap: a capture inside the window is clear whatever the waiting
 * read says. `fleet === null` is a read that was refused or never made, and IT IS NEVER "IDLE": a fleet that could not be asked
 * says nothing about captures. A count of zero beside a last capture INSIDE the window contradicts itself, and is stated as unknown
 * rather than believed either way.
 */
export function fleetIdleReading({ now, fleet, waiting }: { now: number; fleet: FleetCaptures | null; waiting: FleetWaiting | null; }): Reading {
  if (fleet === null) return unknown(SIGNALS.FLEET_IDLE, "the fleet's captures could not be read, so it is not known to be idle");
  if (fleet.captures24h > 0) return clear(SIGNALS.FLEET_IDLE);
  const windowMs = FLEET_IDLE_HOURS * MS_PER_HOUR;
  if (fleet.lastCaptureAt !== null && now - fleet.lastCaptureAt < windowMs) {
    return unknown(SIGNALS.FLEET_IDLE, "the fleet reports zero captures in the window and a last capture inside it");
  }
  if (waiting === null) return unknown(SIGNALS.FLEET_IDLE, "the fleet has captured nothing for over the threshold, but what waits for it was not read");
  const waits = waiting.rows.length + waiting.labJobs.length;
  if (waits === 0) return clear(SIGNALS.FLEET_IDLE);
  const last = fleet.lastCaptureAt;
  const first = last === null ? null : last + windowMs;
  const named = [...waiting.rows.slice(0, MAX_NAMED).map((row) => `#${row}`), ...waiting.labJobs.slice(0, MAX_NAMED)].join(", ");
  const key = last === null ? [...waiting.rows, ...waiting.labJobs].sort().join(",") : hourOf((first as number));
  return { signal: SIGNALS.FLEET_IDLE, status: "tripped", firstTrippedAt: first, discriminator: `${SIGNALS.FLEET_IDLE}@${key}`,
    detail: `${fleet.captures24h} captures in the last ${FLEET_IDLE_HOURS} h; the last was `
      + `${last === null ? "never recorded" : `${isoOf(last)} (${ageText(last, now)} ago)`}; ${waits} thing(s) wait for the fleet: ${named}` };
}

/**
 * One open item the outcome clock runs on. `since` is when it OPENED (epoch ms): a PR's `createdAt`, a row's newest claim record. It is `null` when nothing dates it, which is an unknown and never an age. `reason` is the gate's own label for the state (`stallReasonOf` for a PR) and is DISPLAYED, never a condition; `owner` is `null` when NOBODY could be named. `boundMinutes` is the item's OWN bound, set by the reader that measured one (an idle claimed row's 80 minutes, #3569) and absent for every other item, which keeps its kind's.
 */
export type OverdueCandidate = { kind: "pr" | "row", number: number | string, reason: string, owner: string | null, since: number | null, boundMinutes?: number };

/** @returns how long an item has been open: minutes under two hours, hours to one decimal after */
export const openFor = (minutes: number): string => (minutes >= HOURS_FROM_MINUTES ? `${hoursOf(minutes)} h` : `${minutes} min`);

/** @returns the minutes it may stay open before it is overdue: its own when it carries one, else its kind's */
const boundOf = (item: OverdueCandidate): number => item.boundMinutes ?? (item.kind === "pr" ? OVERDUE_PR_MINUTES : OVERDUE_ROW_MINUTES);

/**
 * SIGNAL 7: THE OUTCOME CLOCK (#3486, replacing #2970's 180-minute "not progressing"). Every open PR and every claimed row has an age since it opened;
 * ONLY A MERGE OR A CLOSE STOPS IT, so a comment, a label, a hold, a draft and a push do not, and NO STATE EXEMPTS an item. `reason` rides on the
 * line as a label for whoever reads it. THE GATE UNDERSTANDING THE STATE IS NEVER A CONDITION FOR RAISING IT: that was the defect of the reasons
 * list this deleted, which is why a hold whose reason had gone (agent-org #149) and an approved draft with no stamp (#3406) were invisible.
 * `items` is `null` for a refused PR read. `unread` names the other reads the clock needed and was refused (the rows): an item with no
 * `since`, or an unread list, makes the answer unknown unless another item trips, and is never read as young.
 *
 * KEYED ON THE SET OF `kind#number:reason`, not an hour: a merge or a close takes an item out of the set, a new overdue item adds to it, and a reason
 * changing re-asks, because who owes the next move has changed.
 */
export function overdueReading({ now, items, unread = [] }: { now: number; items: OverdueCandidate[] | null; unread?: string[]; }): Reading {
  if (items === null) return unknown(SIGNALS.OVERDUE, "the open pull requests could not be read");
  const crossedAt = (item: OverdueCandidate) => (item.since as number) + boundOf(item) * MS_PER_MINUTE;
  const overdue = items.filter((item) => item.since !== null && now >= crossedAt(item)).sort((a, b) => crossedAt(a) - crossedAt(b));
  if (overdue.length === 0) {
    const undated = items.filter((item) => item.since === null).length;
    const doubts = [...(undated > 0 ? [`${undated} open item(s) carried no opening time, so how long they have been open is not known`] : []),
      ...unread.map((what) => `${what} could not be read, so how long those items have been open is not known`)];
    return doubts.length === 0 ? clear(SIGNALS.OVERDUE) : unknown(SIGNALS.OVERDUE, doubts.join("; "));
  }
  const named = overdue.slice(0, MAX_NAMED).map((item) => `#${item.number} (${item.kind === "pr" ? "PR" : "row"}, ${item.reason}, open `
    + `${openFor(Math.round((now - (item.since as number)) / MS_PER_MINUTE))}, ${item.owner === null ? "NO OWNER" : `owner ${item.owner}`}`
    + `${item.boundMinutes === undefined ? "" : `, bound ${item.boundMinutes} min`})`);
  const more = overdue.length > MAX_NAMED ? `, and ${overdue.length - MAX_NAMED} more` : "";
  const key = overdue.map((item) => `${item.kind}#${item.number}:${item.reason}`).sort().join(",");
  return { signal: SIGNALS.OVERDUE, status: "tripped", firstTrippedAt: crossedAt(overdue[0]), discriminator: `${SIGNALS.OVERDUE}@${key}`,
    detail: `${overdue.length} open item(s) not merged or closed within ${OVERDUE_PR_MINUTES} min (a PR) or ${OVERDUE_ROW_MINUTES} min (a claimed row): ${named.join("; ")}${more}` };
}

/**
 * SIGNAL 8: A WAIT STANDS ALTHOUGH THE CONDITION IT NAMES IS TRUE (#2996). The setter was ordered by the gate on the first tick the condition
 * held (`staleWaitOrders`); this is the question of whether that produced a removal, asked `STALE_WAIT_GRACE_MINUTES` later. `stale` is
 * `null` for a refused read of the rows and PRs. A wait whose condition could not be dated makes the answer unknown unless another trips.
 */
export function staleWaitReading({ now, stale }: {
        now: number; stale: {
            item: { kind: string; number: number; repoKey?: string; }; wait: { text: string; key: string; }; setter: string;
            resolvedAt: number | null;
        }[] | null;
    }): Reading {
  if (stale === null) return unknown(SIGNALS.STALE_WAIT, "the rows and pull requests carrying waits could not be read");
  const over = stale.filter((s) => s.resolvedAt !== null && pastGrace(s.resolvedAt, now))
    .sort((a, b) => (a.resolvedAt as number) - (b.resolvedAt as number));
  if (over.length === 0) {
    const undated = stale.filter((s) => s.resolvedAt === null);
    return undated.length === 0 ? clear(SIGNALS.STALE_WAIT)
      : unknown(SIGNALS.STALE_WAIT, `${undated.length} wait(s) have a true condition that nothing dated, so how long they have stood is not known`);
  }
  const first = (over[0].resolvedAt as number) + STALE_WAIT_GRACE_MINUTES * MS_PER_MINUTE;
  const named = over.slice(0, MAX_NAMED).map((s) => `${s.item.repoKey ?? ""}#${s.item.number} (\`Waiting-for: ${s.wait.text}\` true for `
    + `${ageText((s.resolvedAt as number), now)}, setter ${s.setter})`);
  const more = over.length > MAX_NAMED ? `, and ${over.length - MAX_NAMED} more` : "";
  const key = over.map((s) => `${s.item.repoKey ?? ""}#${s.item.number}:${s.wait.key}`).sort().join(",");
  return { signal: SIGNALS.STALE_WAIT, status: "tripped", firstTrippedAt: first, discriminator: `${SIGNALS.STALE_WAIT}@${key}`,
    detail: `${over.length} wait(s) still stand over ${STALE_WAIT_GRACE_MINUTES} min after the condition they name became true: ${named.join("; ")}${more}` };
}

/**
 * SIGNAL 9: A WAIT THAT NAMES NO REASON, QUIET FOR `MANUAL_WAIT_HOURS` (#2996). `hold:*`, `answer:*` and the blocked label do not clear themselves, so with
 * no readable `Waiting-for:` nothing can ever say they are over. THE AGE IS TIME SINCE THE ITEM'S LAST ACTIVITY (this signal's own; the outcome clock runs from the opening): an item somebody
 * is working on is not stalled, and the wait's own start is not on the list read. A wait on `manual` is not here -- it is COUNTED in the detail.
 */
export function waitWithoutReasonReading({ now, bare, manual = 0 }: { now: number; bare: { item: { kind: string; number: number; repoKey?: string; }; fields: string[]; quietSince: number | null; atOnce?: boolean; }[] | null; manual?: number; }): Reading {
  if (bare === null) return unknown(SIGNALS.WAIT_WITHOUT_REASON, "the rows and pull requests carrying waits could not be read");
  const quiet = bare.flatMap((b) => {
    const trippedAt = bareTrippedAt(b, now);
    return trippedAt === null ? [] : [{ ...b, trippedAt }];
  }).sort((a, b) => a.trippedAt - b.trippedAt);
  if (quiet.length === 0) {
    const undated = bare.filter((b) => b.quietSince === null);
    return undated.length === 0 ? clear(SIGNALS.WAIT_WITHOUT_REASON)
      : unknown(SIGNALS.WAIT_WITHOUT_REASON, `${undated.length} wait(s) with no reason carried no activity time, so how long they have stood is not known`);
  }
  const named = quiet.slice(0, MAX_NAMED).map((b) => `${b.item.repoKey ?? ""}#${b.item.number} (${b.fields.join(", ")}, ${b.atOnce ? "no reason given" : "quiet "
    + ageText((b.quietSince as number), now)})`);
  const more = quiet.length > MAX_NAMED ? `, and ${quiet.length - MAX_NAMED} more` : "";
  const key = quiet.map((b) => `${b.item.repoKey ?? ""}#${b.item.number}`).sort().join(",");
  return { signal: SIGNALS.WAIT_WITHOUT_REASON, status: "tripped", firstTrippedAt: quiet[0].trippedAt, discriminator: `${SIGNALS.WAIT_WITHOUT_REASON}@${key}`,
    detail: `${quiet.length} wait(s) name no readable condition and are either parked with no reason or have been quiet over ${MANUAL_WAIT_HOURS} h: ${named.join("; ")}${more}; `
      + `${manual} further wait(s) are \`manual\`, which is allowed and counted` };
}

/**
 * WHEN A BARE WAIT BECAME NAMEABLE, or `null` while it is not. A `parked` row with no reason is nameable at once (#4230): a park with no reason is the defect itself, so it does not wait
 * out the quiet hours a `hold:*` earns, and `now` stands in for an activity time nobody read. Every other bare wait is nameable `MANUAL_WAIT_HOURS` after the item's last activity.
 */
function bareTrippedAt({ quietSince, atOnce }: { quietSince: number | null; atOnce?: boolean; }, now: number): number | null {
  if (atOnce === true) return quietSince ?? now;
  return quietSince !== null && now - quietSince >= MANUAL_WAIT_HOURS * MS_PER_HOUR ? quietSince + MANUAL_WAIT_HOURS * MS_PER_HOUR : null;
}

/**
 * One order that has not reached a seat: `deferred` is a derived order the waker refused because its seat is mid-turn, named by its causeKey and dated by the tick that FIRST deferred it; `queue` is a standing seat's inbox, named by the seat and dated by its OLDEST authored order. `since` is epoch ms.
 */
export type StalledOrder = { kind: "deferred" | "queue", name: string, since: number };

/**
 * SIGNAL 10: AN ORDER HAS WAITED ON A BUSY SESSION FOR OVER `ORDER_STALL_MINUTES` (#3448). A deferral is not a fault -- it is what the queue is for -- and a
 * deferral that outlasts the bound is a stall nobody was told of: #3406 held a green, approved draft for forty minutes while the one session that could act
 * on it was on another row. `stalled` is `null` when the waker's record could not be read, which is a stated unknown and never a clear.
 *
 * STRICTLY OVER, as `refusalReport`'s `isOverdue` is, so the signal and the `UNDELIVERED` line it sits beside agree on the minute. Keyed on the SET of names,
 * not an hour: one order delivered or one more stalled changes it, and an unchanged set holds for the two hours the cause holds for.
 */
export function orderStallReading({ now, stalled }: { now: number; stalled: StalledOrder[] | null; }): Reading {
  if (stalled === null) return unknown(SIGNALS.ORDER_STALLED, "the waker's record of deferred orders and queued orders could not be read");
  const over = stalled.filter((s) => now - s.since > ORDER_STALL_MINUTES * MS_PER_MINUTE).sort((a, b) => a.since - b.since || a.name.localeCompare(b.name));
  if (over.length === 0) return clear(SIGNALS.ORDER_STALLED);
  const named = over.slice(0, MAX_NAMED).map((s) => `${s.kind === "queue" ? `the queue of ${s.name}` : s.name} (${ageText(s.since, now)})`);
  const more = over.length > MAX_NAMED ? `, and ${over.length - MAX_NAMED} more` : "";
  const key = over.map((s) => `${s.kind}:${s.name}`).sort().join(",");
  return { signal: SIGNALS.ORDER_STALLED, status: "tripped", firstTrippedAt: over[0].since + ORDER_STALL_MINUTES * MS_PER_MINUTE,
    discriminator: `${SIGNALS.ORDER_STALLED}@${key}`,
    detail: `${over.length} order(s) or queue(s) have waited over ${ORDER_STALL_MINUTES} min on a session that is busy: ${named.join("; ")}${more}` };
}

/**
 * One pane whose visible screen is an interactive prompt: the session it belongs to, herdr's pane id, WHICH prompt it is, and the tick that FIRST saw it (`since`, epoch ms -- herdr stamps no time on a screen, so the waker keeps the first sighting).
 */
export type PromptPane = { session: string, pane: string, prompt: string, since: number };

/**
 * SIGNAL 12: A PANE HAS STOPPED AT AN INTERACTIVE PROMPT FOR OVER `PANE_PROMPT_MINUTES` (#3458). Codex's working-directory picker and a trust prompt wait for a
 * human at a terminal nobody reads, and the pane reports no failure: it is a session that never started. `panes` is `null` when herdr's panes could not be read,
 * which is a stated unknown and never a clear. A pane that reads as idle WITH NO PROMPT is not in `panes` at all, so it is never raised here.
 *
 * STRICTLY OVER, as {@link orderStallReading} is. Keyed on the set of sessions and panes, so one stuck pane is one signal however many ticks it lasts.
 */
export function panePromptReading({ now, panes }: { now: number; panes: PromptPane[] | null; }): Reading {
  if (panes === null) return unknown(SIGNALS.PANE_AT_PROMPT, "herdr's panes could not be read");
  const over = panes.filter((p) => now - p.since > PANE_PROMPT_MINUTES * MS_PER_MINUTE).sort((a, b) => a.since - b.since || a.session.localeCompare(b.session));
  if (over.length === 0) return clear(SIGNALS.PANE_AT_PROMPT);
  const named = over.slice(0, MAX_NAMED).map((p) => `${p.session} (pane ${p.pane}, ${p.prompt}, ${ageText(p.since, now)})`);
  const more = over.length > MAX_NAMED ? `, and ${over.length - MAX_NAMED} more` : "";
  const key = over.map((p) => `${p.session}:${p.pane}`).sort().join(",");
  return { signal: SIGNALS.PANE_AT_PROMPT, status: "tripped", firstTrippedAt: over[0].since + PANE_PROMPT_MINUTES * MS_PER_MINUTE,
    discriminator: `${SIGNALS.PANE_AT_PROMPT}@${key}`,
    detail: `${over.length} pane(s) have stood at an interactive prompt for over ${PANE_PROMPT_MINUTES} min: ${named.join("; ")}${more}` };
}

/**
 * The refusal `fleet-auto-off.mjs` keeps in its state file. `at` is the LAST tick that refused (rewritten every ten seconds) and `since` is the FIRST tick of the unbroken run, `null` when the record carries none: a tick that proceeds, or has nothing to power off, writes `refusal: null`, which is what ends a run.
 */
export type AutoOffRefusal = { reason: string, detail: string, at: number, since: number | null };
/**
 * What the mirror said, or WHY it could not be read. `readAt` is when `fleet-watch` read the record off the control plane (epoch ms), NOT when this tick ran. `refusal: null` is a mirror that was read and records no refusal, which is not the same as `unreadable`.
 */
export type AutoOffFact = { unreadable: string } | { refusal: AutoOffRefusal | null, readAt: number };

/**
 * SIGNAL 15: `fleet-auto-off` HAS REFUSED TO POWER WORKERS OFF FOR OVER `AUTO_OFF_REFUSAL_MINUTES` (#3853). It is loud by design (it prints `refuse <reason>`, exits 1
 * and records the refusal), and on 2026-10-06 that was 2,569 refusals nobody acted on, because nothing that raises read the record. THE AGE IS `since`, NOT `at`:
 * `at` is the latest tick and is seconds old for as long as the refusal stands, so an age taken from it is never over. A record with no `since` is therefore an
 * UNKNOWN that says so, never a fallback to `at`, which would read every standing refusal as brand new.
 *
 * AN UNKNOWN, NEVER A CLEAR, for a mirror that could not be read, that does not parse, that was read longer ago than `AUTO_OFF_MIRROR_STALE_MINUTES` (a watcher
 * that did not look), whose last tick is older than `AUTO_OFF_RECORD_STALE_MINUTES` before `readAt` (the timer had stopped), or that is inconsistent (`since` after
 * `at`). STRICTLY OVER, as {@link orderStallReading} is. Keyed on `since`, so one unbroken refusal is one signal
 * however long it lasts and however often its reason changes; a tick that proceeds ends the run and the next refusal is a new one.
 */
export function autoOffRefusalReading({ now, autoOff }: { now: number; autoOff: AutoOffFact; }): Reading {
  const signal = SIGNALS.AUTO_OFF_REFUSING;
  if ("unreadable" in autoOff) return unknown(signal, autoOff.unreadable);
  const { refusal, readAt } = autoOff;
  if (now - readAt > AUTO_OFF_MIRROR_STALE_MINUTES * MS_PER_MINUTE) {
    return unknown(signal, `the auto-off mirror was last read off the control plane ${ageText(readAt, now)} ago (limit ${AUTO_OFF_MIRROR_STALE_MINUTES} min), so whether fleet auto-off is refusing is not known`);
  }
  if (refusal === null) return clear(signal);
  if (readAt - refusal.at > AUTO_OFF_RECORD_STALE_MINUTES * MS_PER_MINUTE) {
    return unknown(signal, `the record's last refusal (${refusal.reason}) was written ${ageText(refusal.at, readAt)} before the mirror read it, so the timer had stopped and whether it still refuses is not known`);
  }
  if (refusal.since === null) return unknown(signal, `the record names a refusal (${refusal.reason}) but carries no \`since\`, so how long it has stood is not known`);
  if (refusal.since > refusal.at) return unknown(signal, `the record's refusal began (${isoOf(refusal.since)}) after its last tick (${isoOf(refusal.at)}), so its age is not known`);
  const tripAt = refusal.since + AUTO_OFF_REFUSAL_MINUTES * MS_PER_MINUTE;
  if (now <= tripAt) return clear(signal);
  return { signal, status: "tripped", firstTrippedAt: tripAt, discriminator: `${signal}@${isoOf(refusal.since)}`,
    detail: `fleet auto-off has refused to power workers off for ${ageText(refusal.since, now)} (\`${refusal.reason}\`): ${refusal.detail.slice(0, MAX_QUOTED_CHARS)}` };
}

const isObject = (value: unknown): value is Record<string, any> => value !== null && typeof value === "object" && !Array.isArray(value);
const isTime = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/**
 * THE REFUSAL RECORD, from the mirror file as text: `{ readAt, record }`, `record` being the control plane's state file verbatim (`{}` when it has none). Anything
 * that is not a mirror this reading can believe is `unreadable` with the reason, never a `null` refusal: absent and malformed are different from "refused nothing".
 * @param text `null` for a file that could not be read
 * @param path only for the sentence
 */
export function parseAutoOffMirror(text: string | null, path: string): AutoOffFact {
  if (text === null) return { unreadable: `\`${path}\` could not be read, so whether fleet auto-off is refusing is not known` };
  let mirror;
  try {
    mirror = JSON.parse(text);
  } catch (err) {
    return { unreadable: `\`${path}\` is not JSON (${String((err as any)?.message ?? err).split("\n")[0].slice(0, MAX_REASON_CHARS)})` };
  }
  if (!isObject(mirror) || !isTime(mirror.readAt) || !isObject(mirror.record)) return { unreadable: `\`${path}\` is not \`{ readAt, record }\`` };
  const refusal = mirror.record.refusal ?? null;
  if (refusal === null) return { refusal: null, readAt: mirror.readAt };
  if (typeof refusal.reason !== "string" || typeof refusal.detail !== "string" || !isTime(refusal.at) || !(refusal.since === undefined || isTime(refusal.since))) {
    return { unreadable: `\`${path}\` holds a refusal without a reason, a detail and a time` };
  }
  return { refusal: { reason: refusal.reason, detail: refusal.detail, at: refusal.at, since: refusal.since ?? null }, readAt: mirror.readAt };
}

/**
 * THE FLEET'S REFUSAL RECORD, as `fleet-watch` mirrored it (`AUTO_OFF_MIRROR_PATH`) from the control plane. NEVER THROWS, and never ssh: the file is read off this
 * checkout like any other. A checkout `fleet-watch` does not run in holds no mirror, or one nobody keeps current, and the reading says so: that is the answer, not a
 * defect of the reader.
 */
export function readAutoOffRefusal({ root = DEFAULT_ROOT, read = (path) => readFileSync(path, "utf8") }: { root?: string; read?: (path: string) => string; } = {}): AutoOffFact {
  const path = resolve(root, AUTO_OFF_MIRROR_PATH);
  return parseAutoOffMirror(readOrNull(read, path), path);
}

/**
 * MORE THAN THIS MANY CLAIM REFUSALS IN {@link CLAIM_REFUSAL_STORM_MINUTES} IS A STORM (a11ign/agent-org#885 class 2, agent-org#889, the chairman 2026-10-11): TEN, so eleven trips.
 * The case it is for: the stale-rule guard refused 163 claims between 08:09 and 09:15 on 2026-10-11 because `main` held an unreleased rule file, no worker started, and the
 * worker that would have fixed it was one of the refused. Nothing raised, because each refusal was an answer to one claim and the sum of them was nobody's reading.
 */
export const CLAIM_REFUSAL_STORM_REFUSALS = 10;
/** The window those refusals are counted in. */
export const CLAIM_REFUSAL_STORM_MINUTES = 15;

/** @returns the text, or `null` for a file that cannot be read: absent is not empty */
export function readOrNull(read: (path: string) => string, path: string): string | null {
  try {
    return read(path);
  } catch {
    return null;
  }
}
