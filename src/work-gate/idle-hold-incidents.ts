// A HOLD ON A ROW NOBODY IS WORKING IS RAISED BY THE GATE, NOT ONLY REFUSED AT THE DOOR (agent-org#571, follows a11ign/a11ign#4661; chairman, DanBeckDev on #4437, 2026-10-09; class `hold-on-idle-row`).
//
// `pr-hold.ts` refuses `--until closed #N` when #N is open, unclaimed and has no open pull request. That cannot see a hold taken BEFORE the refusal, a hold written by hand as a
// `Waiting-for:` line, or a target the take could not read (a pull request number, a repository its token cannot see, a failed call): those are taken as asked, with a note on stderr, and
// until this file nothing read them again. `idleHoldIncident` (`pr-hold-state.ts`) is the chairman's rule as a pure function ("any held PR whose hold target has no claim for more than 15
// minutes is an incident"); THIS is its call site, on the facts the tick's wait read already holds.
//
// WHAT IT READS, AND WHAT IT COSTS: the open pull requests (their labels, hold marker and `Closes` lines) and `waitTickFacts`' own facts for the target (state, labels, last change). NO CALL OF ITS
// OWN: a target the open lists did not hold was read once by the wait read, for the hold-lift, and is looked up here and not asked again. A detector costs the tick an API call, not a turn.
//
// WHAT IT NEVER DOES: LIFT THE HOLD. Lifting is a write with its own row; `liftResolvedHolds` lifts a hold whose condition is TRUE, and this is the other case, a condition that cannot come true.
// It orders `ceo`, as every `org-health` signal does, and says the three ways out.
//
// SILENT, NEVER LATE-PROVEN-WRONG: an unknown is not "long enough" (ABSENCE IS NOT PROOF). No incident for a target the facts do not hold, a target that is itself an open pull request (it has no claim
// vocabulary), a hold with no date, or a hold that names more than one condition (which of them ends it is the declarer's, and one being worked may end it).
//
// A LEAF OF THE GATE: it imports no `work-gate.ts` (`org-health.ts` does, and is a cycle), so the first repository's name and the order cap arrive as arguments. It NEVER THROWS: a detector that can
// crash the tick stops every order behind it.
import { holdersOf, holdReasonOf, idleHoldIncident, IDLE_HOLD_CLASS } from "../pr-hold-state.ts";
import type { IdleHoldIncident } from "../pr-hold-state.ts";
import { isItemWait, MANUAL_WAIT_HOURS } from "../wait-condition.ts";
import type { WaitFacts } from "../wait-condition.ts";
import { declaredClosedRows } from "../row-claim/file-overlap-rule.ts";
import { subjectMention, subjectRef } from "../review-attribution.ts";

/** Who hears about it: `ceo`, who takes every `org-health` signal (`org-health.ts`'s `OFFERED_TO`, restated because that file's graph reaches this one's importer). */
const REPORTED_TO = "ceo";

/** An incident, and who holds the pull request (the prompt names them) and which repository's key names it (the order's subject). */
export type HeldIncident = IdleHoldIncident & { holders: string[]; repoKey: string | undefined };

type Raw = { number: number; labels?: unknown[]; body?: unknown; comments?: unknown[]; repo?: string; repoKey?: string; updatedAt?: unknown };

/** The `owner/repo` a pull request is in: only a keyed one carries its own, the rest are the first repository's (`readRefFacts` keys the open lists the same way). */
const repoOf = (pr: Raw, repo: string): string => (pr.repoKey && pr.repo ? pr.repo : repo);

const labelNames = (pr: Raw): string[] => (pr.labels ?? []).map((l) => String((l as { name?: unknown } | null)?.name ?? l));

/**
 * THE INCIDENTS OF ONE TICK, from the pull requests it read and the facts its wait read gathered. `prs` is every open pull request the wait read saw (the first repository's and the keyed
 * ones'), `facts` is `waitTickFacts`'s `facts`, `repo` the first repository's `owner/repo` (a pull request without a `repo` is its own, and a bare `#n` names the held pull request's repository).
 * `null` for either read is a refused list, which is silence and not "no incident".
 *
 * THE PULL REQUESTS THAT CLOSE THE TARGET are the open ones whose body DECLARES `Closes #N` against the target's repository (`declaredClosedRows`, the reader the claim and the milestone
 * clock use): the tick holds their bodies already, where the take-time read asks GitHub for `closedByPullRequestsReferences`.
 */
export function idleHoldIncidents({ prs, facts, now, repo, log = (line) => process.stderr.write(line) }:
  { prs: Raw[] | null; facts: WaitFacts | null; now: number; repo: string; log?: (line: string) => void; }): HeldIncident[] {
  if (prs === null || facts === null) return [];
  try {
    const openItems = new Set(prs.map((pr) => `${repoOf(pr, repo)}#${Number(pr.number)}`));
    return prs.flatMap((pr) => incidentOf(pr, { prs, facts, now, repo, openItems }, log));
  } catch (err) {
    log(`idle-hold: could not run (${String((err as Error)?.message ?? err).split("\n")[0].slice(0, 160)}) -- no incident this tick.\n`);
    return [];
  }
}

function incidentOf(pr: Raw, { prs, facts, now, repo, openItems }: { prs: Raw[]; facts: WaitFacts; now: number; repo: string; openItems: Set<string>; }, log: (line: string) => void): HeldIncident[] {
  const labels = labelNames(pr);
  const holders = holdersOf(labels).map((label) => label.slice(label.indexOf(":") + 1));
  if (holders.length === 0) return [];
  try {
    const { reason, waits, since } = holdReasonOf(pr as Parameters<typeof holdReasonOf>[0]);
    const [wait] = waits;
    if (reason !== "until" || waits.length !== 1 || !isItemWait(wait) || wait.state !== "closed") return [];
    const targetRepo = wait.repo ?? repo;
    if (openItems.has(`${targetRepo}#${wait.number}`)) return [];
    if (!Object.hasOwn(facts.items, wait.key)) return [];
    const openPullRequests = prs
      .filter((other) => declaredClosedRows(String(other.body ?? ""), { prRepo: repoOf(other, repo), trackerRepo: targetRepo }).includes(wait.number))
      .map((other) => ({ number: Number(other.number), repo: repoOf(other, repo) }));
    const incident = idleHoldIncident({ pr: { number: Number(pr.number), repo: repoOf(pr, repo) }, labels, since },
      { wait: { ...wait, repo: targetRepo, key: `${targetRepo}#${wait.number}` }, fact: facts.items[wait.key] }, { now, openPullRequests });
    return incident === null ? [] : [{ ...incident, holders, repoKey: pr.repoKey === undefined || pr.repoKey === "" ? undefined : pr.repoKey }];
  } catch (err) {
    log(`idle-hold: could not read ${subjectMention({ repoKey: pr.repoKey, number: pr.number })} (${String((err as Error)?.message ?? err).split("\n")[0].slice(0, 160)}) -- it is not read as clear.\n`);
    return [];
  }
}

/**
 * ONE ORDER PER HOLD, to `ceo`, oldest first so a cap drops the youngest. `discriminator` is the incident's own `key`, STABLE FOR ONE HOLD (the pull request, the target and the date the hold was
 * taken, never the minutes), so the same hold seen on every tick is one key and the suppression table (`org-health-suppression.ts`) lets it through once a window. The prompt names the numbers and the
 * three ways out, and says the gate does not lift it.
 */
export function idleHoldOrders(incidents: HeldIncident[], { limit }: { limit: number; }): any[] {
  const seen = new Set<string>();
  return [...incidents].sort((a, b) => b.minutes - a.minutes || a.key.localeCompare(b.key)).flatMap((incident) => {
    if (seen.has(incident.key)) return [];
    seen.add(incident.key);
    const mention = subjectMention({ repoKey: incident.repoKey, number: incident.pr.number });
    return [{ session: REPORTED_TO, cause: "org-health", subject: `${IDLE_HOLD_CLASS}-${subjectRef(incident.repoKey, incident.pr.number)}`, discriminator: incident.key,
      prompt: `ORG HEALTH: A HOLD ON A ROW NOBODY IS WORKING (class \`${IDLE_HOLD_CLASS}\`, chairman). ${mention} has been held by ${incident.holders.map((h) => `\`${h}\``).join(", ")} for ${incident.minutes} `
        + `minutes on \`${incident.target}\`: ${incident.reason}. WAYS OUT, in the order to try them: have the row claimed (an unclaimed \`ready\` row is \`product-manager\`'s to offer); merge ${mention} `
        + `first and let the row rebase when it lands (a row that lands after has nothing to wait for); or re-take the hold with \`--until=manual\`, which is counted and expires after ${MANUAL_WAIT_HOURS} hours. `
        + "THE GATE DOES NOT LIFT THIS HOLD: lifting is the holder's, and it stands until one of the three happens. This order stops when the target is claimed, a pull request closes it, or the hold ends.",
      causeKey: `${REPORTED_TO}/org-health/hold-on-idle-row@${incident.key}` }]; // SPELLED OUT: `org-health-suppression.test.ts` discovers classes by this literal
  }).slice(0, limit);
}
