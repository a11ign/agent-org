// @ts-check
// module: how many rows each holder shelves, and for how long (a11ign/a11ign#4602, fix 3 of 4 for the lock-gridlock class, epic #4437)
//
// B4 shelves a ready row behind a claim: `partitionUnclaimed(...).blocked` carries `{ number, reason }`, and a B4 reason names the row or pull request it overlaps. The tick computed
// that every two minutes and summed none of it, so one holder could shelve 28 rows for hours and nobody was told. This leaf sums it per HOLDER (the session on the held row or
// pull request) and over time: `BLOCKING_MIN_ROWS` rows shelved for `BLOCKING_MIN_MINUTES` minutes is an incident, raised ONCE per holder per episode.
//
// THE CORE IS PURE (`holdingsOf`, `advance`, `topBlocker`): the blocked list and the previous record in, the next record and the incidents out. `blockingImpactTick` is the only
// part that touches a file, and every effect in it (record file, ledger, row comment) goes through a seam, so a test reaches no network and no host state.
//
// A CIRCULAR WAIT IS PUT TO SOMEONE, ONCE (agent-org#5009). `b4-cycle.ts` finds a row shelved by a pull request that closes a row waiting on it, and the tick used to PRINT that every tick and nothing more
// (agent-org#878 stood red for 1h45m that way). The first tick that reads a cycle wakes the pull request's holder with the two ways out (narrow the pull request, or take the shelved row's change in);
// the next tick that still reads it files the ledger incident, writes both rows and wakes `orchestrator`; a tick that no longer reads it counts it as broken, with how long it stood, for the daily pass
// (`deadlockSummary`). The wait that makes the cycle is the rows' native `blockedBy` edge, which a worker's declared block writes once agent-org#921 ships.
//
// AN EPISODE IS A CONTINUOUS RUN OF TICKS in which the holder shelves at least `BLOCKING_MIN_ROWS`. It ends when the count drops below that, and it is also ended by a gap between ticks of
// more than `MAX_TICK_GAP_MS` (a restart, an outage): minutes nobody observed are not counted as shelved, so an incident never rests on a guess.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { advanceDeadlocks, deadlockKey, deadlockLine, deadlocksOf, pathText, type BrokenDeadlock, type Deadlock, type DeadlockEpisode, type DeadlockMove, type Shelving, type Sighting } from "./b4-cycle.ts";
import { FAILURE_LEDGER_FILE, recordFailure } from "./failure-ledger.ts";

export const BLOCKING_MIN_ROWS = 5;
export const BLOCKING_MIN_MINUTES = 30;
/** The failure-ledger class key (`FAILURE_KINDS` is the closed list of the first move; this is the third fix's own key, read by `class-repeat` as any ledger key is). */
export const LOCK_GRIDLOCK_KIND = "lock-gridlock";
/** The ledger class key of a cycle the gate escalated (agent-org#5009): a pull request waiting on a row B4 shelves because of that pull request. Not seeded in `FAILURE_KINDS`, for `LOCK_GRIDLOCK_KIND`'s reason. */
export const B4_DEADLOCK_KIND = "b4-deadlock";
/** Who a cycle goes to when its holder's wake did not break it, or when nobody is known to hold the pull request. */
export const DEADLOCK_ESCALATION_SESSION = "orchestrator";
/** How long a fired episode may stand before the escalation goes: the 30 that fired it plus 30 for the holder to act on the wake (agent-org#1426). */
export const BLOCKING_ESCALATE_MINUTES = 60;
/** Who a standing gridlock goes to once the holder's wake has not cleared it (agent-org#1426): the queue's owner, who can narrow or re-sequence the shelved rows, which the holder cannot. */
export const BLOCKING_ESCALATION_SESSION = "product-manager";
/** The record's file name in the state directory. */
export const BLOCKING_FILE = "blocking-impact.json";
/** The tick runs every two minutes; a gap beyond this is a break in observation, not a long shelving. */
export const MAX_TICK_GAP_MS = 10 * 60 * 1000;
const MS_PER_MINUTE = 60 * 1000;
const DAY_MS = 24 * 60 * MS_PER_MINUTE;
const NAMED_ROWS = 12;

/** What a held row or pull request resolves to: the session holding it, and the row it stands for (a pull request's `Closes`), or `null` when none is known. `repo` is the keyed tracker that row is in (absent for the home tracker's). */
export type Held = { holder: string; row: number | null; repo?: string };
/** `repo` is `#N in <repo>`, a pull request of that repository. `tracker` is the repository whose tracker a BARE row number belongs to (absent for the home tracker), which `refOfShelving` sets. */
export type Ref = { number: number; repo?: string; tracker?: string };
/**
 * What a deadlock needs and a holder does not: the open pull request a ref names (its display name and the rows it declares it closes), and the open rows a row waits on (`b4-cycle.ts`; the home
 * tracker's unless `tracker` names another's). `closingPrOf` is the holder's open pull request that closes `row`, with its review decision: `null` when the holder has none the gate can read (agent-org#1426).
 */
export type Waits = { prOf: (ref: Ref) => { pr: string; closes: number[] } | null; blockersOf: (row: number, tracker?: string) => number[]; closingPrOf: (row: number, holder: string, tracker?: string) => PullRequestState | null };
/** `waits` is absent on a resolver written without the edges (a test's table), which finds no deadlock. */
export type Resolver = ((ref: Ref) => Held | null) & { waits?: Waits };
/** `repo` is the repository whose tracker the row is in: absent for the home tracker's rows, and set for a keyed tracker's, whose reasons number ITS rows. */
export type Shelved = { number: number; reason: string; repo?: string };
/**
 * One holder's shelving at one tick: the shelved rows, and the held rows that shelve them. `heldIn` is the keyed tracker the held rows are in (absent for the home tracker's), which is where a row
 * write goes; `null` when one holder's held rows are in two trackers, whose bare numbers a row write cannot tell apart, so none is made.
 */
export type Holding = { rows: number[]; heldRows: number[]; heldIn?: string | null };
/** `escalated` is the episode's product-manager order (agent-org#1426), absent in a record written before it, which reads as `false`. */
export type Episode = { since: number; rows: number[]; heldRows: number[]; fired: boolean; escalated?: boolean; heldIn?: string | null };
/** `minutes` is the time since the previous tick that this sample stands for, so a sample's row-minutes are `rows * minutes`. */
export type Sample = { at: number; holder: string; row: number | null; rows: number; minutes: number };
/**
 * `holdings` is the LAST tick's count for every holder, below the incident threshold too, so a wake can say what a claim blocks (#4605); absent in a record written before that.
 * `deadlocks` are the cycles the last tick read, and `brokenDeadlocks` the ones it stopped reading in the last 24 hours (agent-org#5009); both absent when there are none.
 */
export type BlockingRecord = {
  at: number; episodes: Record<string, Episode>; samples: Sample[]; holdings?: Record<string, Holding>;
  deadlocks?: Record<string, DeadlockEpisode>; brokenDeadlocks?: (BrokenDeadlock & { at: number })[];
};
export type Incident = { holder: string; since: number; minutes: number; rows: number[]; heldRows: number[]; heldIn?: string | null };
export type TopBlocker = { holder: string; row: number | null; rows: number; minutes: number; rowMinutes: number };

/**
 * The row or pull request a B4 reason names, or `null` for any other shelving (a template gap, a branch on `origin`, a declared wait). The two B4 texts are
 * `overlaps the Region of #N, a row already claimed ...` and `overlaps #N[ in repo], which already touches ...` (`file-overlap-rule.ts`).
 * @param {string} reason
 */
export function heldRefOf(reason: string): Ref | null {
  const found = /^overlaps (?:the Region of )?#(\d+)(?: in (\S+?),)?/.exec(reason);
  return found ? { number: Number(found[1]), ...(found[2] === undefined ? {} : { repo: found[2] }) } : null;
}

/**
 * WHO HOLDS THE THING A REASON NAMES. A bare `#N` is a claimed ROW first (its own `session:` label, and it stands for itself), then an open pull request of the home repository (its label, and the row
 * its body `Closes`); `#N in <repo>` is a pull request of that repository only. `null` is a thing nobody is known to hold, which `holdingsOf` counts as unattributed.
 * A ref with a `tracker` is a keyed tracker's bare row number: the row is looked for in THAT tracker's open rows (`trackers`, keyed by repository) and never the home tracker's, then in that repository's pull requests.
 * The resolver also carries `waits` (the pull request's whole `Closes` and the rows' `blockedBy` edges, held or not), which is what `deadlocksOf` reads.
 * @param {{ rows: { number: number, blockedBy?: unknown }[], prs: { number: number, repo?: string }[], trackers?: Record<string, { number: number, blockedBy?: unknown }[]>, sessionOf: (item: any) => string | null, closesOf: (pr: any) => number[] }} open
 */
export function resolverOf({ rows, prs, trackers = {}, sessionOf, closesOf }: { rows: { number: number; blockedBy?: unknown }[]; prs: { number: number; repo?: string; reviewDecision?: string | null }[]; trackers?: Record<string, { number: number; blockedBy?: unknown }[]>; sessionOf: (item: any) => string | null; closesOf: (pr: any) => number[] }): Resolver {
  const rowsOf = (tracker?: string) => (tracker === undefined ? rows : Object.hasOwn(trackers, tracker) ? trackers[tracker] : []);
  const prNamed = ({ number, repo, tracker }: Ref) => prs.find((p) => Number(p.number) === number && p.repo === (repo ?? tracker));
  const resolve = ({ number, repo, tracker }: Ref): Held | null => {
    const row = repo === undefined ? rowsOf(tracker).find((r) => Number(r.number) === number) : undefined;
    const rowHolder = row === undefined ? null : sessionOf(row);
    const keyed = tracker === undefined ? {} : { repo: tracker };
    if (rowHolder !== null) return { holder: rowHolder, row: number, ...keyed };
    const pr = prNamed({ number, repo, tracker });
    const prHolder = pr === undefined ? null : sessionOf(pr);
    return pr === undefined || prHolder === null ? null : { holder: prHolder, row: closesOf(pr)[0] ?? null, ...keyed };
  };
  const prOf = (ref: Ref) => {
    const pr = prNamed(ref);
    const repo = ref.repo ?? ref.tracker;
    return pr === undefined ? null : { pr: repo === undefined ? `#${ref.number}` : `${repo.split("/").pop()}#${ref.number}`, closes: closesOf(pr) };
  };
  // The pull request a holder's row is closed by: the open one of that repository whose `Closes` names the row and whose label is the holder's (agent-org#1426).
  const closingPrOf = (row: number, holder: string, tracker?: string): PullRequestState | null => {
    const pr = prs.find((p) => p.repo === tracker && closesOf(p).includes(row) && sessionOf(p) === holder);
    if (pr === undefined) return null;
    return { pr: pr.repo === undefined ? `#${pr.number}` : `${pr.repo.split("/").pop()}#${pr.number}`, review: pr.reviewDecision ?? null };
  };
  return Object.assign(resolve, { waits: { prOf, closingPrOf, blockersOf: (row: number, tracker?: string) => openBlockersOf(rowsOf(tracker).find((r) => Number(r.number) === row)) } });
}

/** The OPEN rows a row's `blockedBy` edge names. `nodes` keeps closed blockers, which are waits that have cleared; a node with no `state` is read as open (`arm-pr.ts`'s `openBlockersOf`, which drags in the arming path and is not imported here). */
function openBlockersOf(row: any): number[] {
  const nodes: any[] = Array.isArray(row?.blockedBy?.nodes) ? row.blockedBy.nodes : [];
  return nodes.filter((node) => String(node?.state ?? "OPEN").toUpperCase() === "OPEN").map((node) => Number(node?.number));
}

/** The Region text of a B4 reason: its bare `#N` is a row of the tracker the shelved row is in. The pull-request text's is not (`refOfShelving`). */
const REGION_REASON = /^overlaps the Region of #/;

/**
 * THE REF A SHELVING NAMES. A keyed tracker's shelving (`repo` set) names ITS rows by bare number in the Region text (`overlaps the Region of #469`), so that ref carries the repository and resolves
 * against that tracker's rows. The pull-request text (`overlaps #12, which already touches`) is left bare: a keyed repository's own pull requests are named `#12 in <repo>`
 * (`file-overlap-rule.ts`'s `prName`), so a bare number there is the home repository's pull request, as it always was.
 */
function refOfShelving({ reason, repo }: Shelved): Ref | null {
  const ref = heldRefOf(reason);
  return ref === null || repo === undefined || ref.repo !== undefined || !REGION_REASON.test(reason) ? ref : { ...ref, tracker: repo };
}

/** A row's identity across trackers, which `holdingsOf`'s `named` is a set of: the bare number for the home tracker's, `<repo>#<number>` for a keyed tracker's. */
const rowKey = (number: number, repo?: string): number | string => (repo === undefined ? number : `${repo}#${number}`);

/**
 * THE DEADLOCKS AMONG THIS TICK'S SHELVINGS (#4625): a row shelved by a pull request that closes a row waiting on it. A shelving whose reason names no open pull request the resolver can read (a
 * claimed row, a template gap, a pull request outside the open list) is not one, because no path was read. Each tracker's shelvings are walked over THAT tracker's `blockedBy` edges, so two
 * trackers' row numbers never meet; a keyed one's deadlock carries its `repo`.
 * @param {Shelved[]} blocked @param {Resolver} resolve
 */
export function deadlocksAmong(blocked: Shelved[], resolve: Resolver): (Deadlock & { repo?: string })[] {
  const waits = resolve.waits;
  if (waits === undefined) return [];
  const byTracker = new Map<string | undefined, Shelving[]>();
  for (const shelving of blocked) {
    const ref = refOfShelving(shelving);
    const named = ref === null ? null : waits.prOf(ref);
    if (named !== null) byTracker.set(shelving.repo, [...(byTracker.get(shelving.repo) ?? []), { shelved: shelving.number, ...named }]);
  }
  return [...byTracker].flatMap(([repo, shelvings]) => deadlocksOf(shelvings, (row) => waits.blockersOf(row, repo))
    .map((deadlock) => (repo === undefined ? deadlock : { ...deadlock, repo })));
}

/** The overlap B4 named in a pull-request reason: `overlaps #878 in a11ign/agent-org, which already touches: .github/workflows/ci.yml, package.json. B4: ...` gives `.github/workflows/ci.yml, package.json`. */
const TOUCHED_FILES = /which already touches: (.+?)\. B4:/;

/**
 * THE CYCLES THIS TICK, EACH WITH WHO TO PUT IT TO: `deadlocksAmong`'s, plus the session holding the pull request that shelves (`null` when the resolver knows none) and the overlap B4 named, which is
 * what the holder is told to narrow away.
 * @param {Shelved[]} blocked @param {Resolver} resolve
 */
export function sightingsAmong(blocked: Shelved[], resolve: Resolver): Sighting[] {
  return deadlocksAmong(blocked, resolve).map((deadlock) => {
    const shelving = blocked.find((b) => b.number === deadlock.shelved && b.repo === deadlock.repo);
    const ref = shelving === undefined ? null : refOfShelving(shelving);
    const files = shelving === undefined ? undefined : TOUCHED_FILES.exec(shelving.reason)?.[1];
    return { ...deadlock, holder: ref === null ? null : (resolve(ref)?.holder ?? null), ...(files === undefined ? {} : { files }) };
  });
}

/**
 * Per holder, the rows the gate shelves behind it THIS tick. A shelving whose reason names no held thing, or names one nobody is known to hold, belongs to no holder and is
 * COUNTED in `unattributed` rather than dropped, so a resolver that cannot place anything shows as a number and not as an empty gridlock. `named` is the shelved rows another line already
 * names (a DEADLOCK, #4625, as `rowKey` strings), which are not counted again as unattributed.
 * A shelving of a keyed tracker's row (`repo`) is a row of that tracker: the holdings are per holder across trackers, and `rows` are the shelved rows' numbers in their own trackers.
 * @param {Shelved[]} blocked @param {(ref: Ref) => Held | null} resolve
 */
export function holdingsOf(blocked: Shelved[], resolve: (ref: Ref) => Held | null, named: ReadonlySet<number | string> = new Set()): { holdings: Map<string, Holding>; unattributed: number } {
  const holdings = new Map<string, Holding>();
  let unattributed = 0;
  for (const shelving of blocked) {
    const { number } = shelving;
    const ref = refOfShelving(shelving);
    const held = ref === null ? null : resolve(ref);
    if (held === null) { if (ref !== null && !named.has(rowKey(number, shelving.repo))) unattributed += 1; continue; }
    const prior = holdings.get(held.holder);
    const heldIn = prior === undefined || prior.heldIn === held.repo ? held.repo : null;
    const heldRows = prior?.heldRows ?? [];
    holdings.set(held.holder, {
      rows: [...(prior?.rows ?? []), number].sort((a, b) => a - b),
      heldRows: held.row === null || heldRows.includes(held.row) ? heldRows : [...heldRows, held.row].sort((a, b) => a - b),
      ...(heldIn === undefined ? {} : { heldIn }),
    });
  }
  return { holdings, unattributed };
}

/** The episodes that carry on from the previous tick, and the new ones. Fired episodes stay fired for as long as they last. */
function nextEpisodes(previous: BlockingRecord | null, { now, holdings, continuous }: { now: number; holdings: Map<string, Holding>; continuous: boolean }): Record<string, Episode> {
  const episodes: Record<string, Episode> = {};
  for (const [holder, holding] of holdings) {
    if (holding.rows.length < BLOCKING_MIN_ROWS) continue;
    const prior = continuous ? previous?.episodes[holder] : undefined;
    episodes[holder] = { since: prior?.since ?? now, rows: holding.rows, heldRows: holding.heldRows, fired: prior?.fired ?? false, escalated: prior?.escalated ?? false, ...(holding.heldIn === undefined ? {} : { heldIn: holding.heldIn }) };
  }
  return episodes;
}

/**
 * ONE TICK: the next record, the incidents newly due, and the escalations newly due. An incident is due the first tick an episode has lasted `BLOCKING_MIN_MINUTES`, and not again until the episode has
 * ended and a new one has lasted as long. An escalation (agent-org#1426) is due the first tick a FIRED episode has lasted `BLOCKING_ESCALATE_MINUTES`, once per episode: the holder was woken and the
 * shelving still stands. `samples` accrue for EVERY holder shelving anything, below the incident threshold too, so the daily top blocker is not limited to
 * holders that were ever an incident; they are kept for 24 hours.
 * @param {BlockingRecord | null} previous `null` for a record nobody could read, which starts every episode afresh
 * @param {{ now: number, holdings: Map<string, Holding> }} tick
 */
export function advance(previous: BlockingRecord | null, { now, holdings }: { now: number; holdings: Map<string, Holding> }): { record: BlockingRecord; incidents: Incident[]; escalations: Incident[] } {
  const continuous = previous !== null && now >= previous.at && now - previous.at <= MAX_TICK_GAP_MS;
  const episodes = nextEpisodes(previous, { now, holdings, continuous });
  const incidents: Incident[] = [];
  const escalations: Incident[] = [];
  for (const [holder, episode] of Object.entries(episodes)) {
    const lasted = now - episode.since;
    const incident: Incident = { holder, since: episode.since, minutes: Math.floor(lasted / MS_PER_MINUTE), rows: episode.rows, heldRows: episode.heldRows, ...(episode.heldIn === undefined ? {} : { heldIn: episode.heldIn }) };
    if (!episode.fired && lasted >= BLOCKING_MIN_MINUTES * MS_PER_MINUTE) {
      episode.fired = true;
      incidents.push(incident);
    } else if (episode.fired && !episode.escalated && lasted >= BLOCKING_ESCALATE_MINUTES * MS_PER_MINUTE) {
      episode.escalated = true;
      escalations.push(incident);
    }
  }
  const minutes = previous !== null && continuous ? (now - previous.at) / MS_PER_MINUTE : 0;
  const fresh: Sample[] = minutes === 0 ? [] : [...holdings].map(([holder, holding]) => ({ at: now, holder, row: holding.heldRows[0] ?? null, rows: holding.rows.length, minutes }));
  const kept = (previous?.samples ?? []).filter((sample) => sample.at > now - DAY_MS);
  return { record: { at: now, episodes, samples: [...kept, ...fresh], holdings: Object.fromEntries(holdings) }, incidents, escalations };
}

/**
 * THE DAILY PASS'S LINE: the holder with the most ROW-MINUTES (rows shelved times minutes shelved) in the 24 hours to `now`, with the row it holds, the most rows it shelved at a
 * tick and the minutes it shelved anything. `null` when nothing was shelved behind anyone in the window (which is a reading, and the caller says so).
 * @param {BlockingRecord} record @param {number} now
 */
export function topBlocker(record: BlockingRecord, now: number): TopBlocker | null {
  const byHolder = new Map<string, TopBlocker>();
  for (const sample of record.samples.filter((s) => s.at > now - DAY_MS && s.at <= now).sort((a, b) => a.at - b.at)) {
    const prior = byHolder.get(sample.holder);
    byHolder.set(sample.holder, {
      holder: sample.holder, row: sample.row ?? prior?.row ?? null, rows: Math.max(prior?.rows ?? 0, sample.rows),
      minutes: (prior?.minutes ?? 0) + sample.minutes, rowMinutes: (prior?.rowMinutes ?? 0) + sample.rows * sample.minutes,
    });
  }
  const ranked = [...byHolder.values()].sort((a, b) => b.rowMinutes - a.rowMinutes || a.holder.localeCompare(b.holder));
  return ranked[0] ?? null;
}

/** @param {number[]} numbers `#1 #2 ...`, cut after `NAMED_ROWS` with the count of the rest */
function rowList(numbers: number[]): string {
  const named = numbers.slice(0, NAMED_ROWS).map((n) => `#${n}`).join(" ");
  return numbers.length > NAMED_ROWS ? `${named} +${numbers.length - NAMED_ROWS} more` : named;
}

/** What the holder is woken with: the count, the minutes and the rows, and the three ways out. */
export function wakeText(incident: Incident): string {
  const held = incident.heldRows.length > 0 ? ` behind ${rowList(incident.heldRows)}` : "";
  return `you are blocking ${incident.rows.length} rows; land, split or release. These ready rows have been shelved${held} for ${incident.minutes} minutes `
    + `(B4: no two rows are worked on the same file at once): ${rowList(incident.rows)}. Land the work, split the Region so the rows stop overlapping it, or release the claim.`;
}

/** The row write on a held row: the same fact for the seat that owns it, with no turn spent (a report that needs no decision is a row write). */
export function rowComment(incident: Incident): string {
  return `<!-- lock-gridlock: ${incident.holder} since ${new Date(incident.since).toISOString()} -->\n`
    + `**This row shelves ${incident.rows.length} ready rows** (${rowList(incident.rows)}) and has for ${incident.minutes} minutes: the gate cannot offer them while \`${incident.holder}\` holds this Region. `
    + "Land, split or release.";
}

/** The ledger ref of an episode: the holder and when it began, so a second episode is a second event and `repeatsIn` can see the class repeat. */
export function episodeRef(incident: Pick<Incident, "holder" | "since">): string {
  return `${incident.holder}@${new Date(incident.since).toISOString()}`;
}

export type BlockingOrder = { session: string; cause: string; subject: string; discriminator: string; prompt: string; causeKey: string };

/** The wake order. `ready-row-unclaimable` is the existing judgment cause for "whose tree is it, and should it be released"; a new cause would be a change to the closed vocabulary. */
export function wakeOrder(incident: Incident): BlockingOrder {
  const discriminator = `${incident.holder}-${incident.since}`;
  return { session: incident.holder, cause: "ready-row-unclaimable", subject: incident.heldRows[0] === undefined ? `holder-${incident.holder}` : `row-${incident.heldRows[0]}`,
    discriminator, prompt: wakeText(incident), causeKey: `${incident.holder}/lock-gridlock/${discriminator}` };
}

/** A holder's pull request among the shelvings: its name, and its `reviewDecision` (`null` when none is recorded). */
export type PullRequestState = { pr: string; review: string | null };

/** What product-manager is told when the holder's wake has not cleared a standing shelving (agent-org#1426): the holder, its row, the shelved rows, the minutes, and the three ways out, in order. */
export function escalationText(incident: Incident, pullRequest: PullRequestState | undefined): string {
  const { holder, rows, heldRows, minutes } = incident;
  const held = heldRows.length === 0 ? "no row the gate can name" : `row ${rowList(heldRows)}`;
  const state = pullRequest === undefined ? `${holder} has no open pull request the gate could read` : `${holder}'s pull request ${pullRequest.pr} has review decision ${pullRequest.review ?? "none"}`;
  return `escalation of the wake already sent to ${holder}: ${holder} holds ${held} and has shelved ${rows.length} ready rows behind it for ${minutes} minutes (${rowList(rows)}), `
    + `and it has not landed, split or released. Three ways out, in this order: (1) ${holder} lands its change on ${held} (${state}); `
    + `(2) ${holder}'s Region splits or narrows, a row amendment for you to make; (3) the shelved rows are re-sequenced behind ${held} by blocked-by. This order releases no claim.`;
}

/** The row write on each held row of an escalated episode. The marker keeps a later tick from reading it as new. */
export function escalationRowComment(incident: Incident): string {
  return `<!-- lock-gridlock-escalated: ${incident.holder} since ${new Date(incident.since).toISOString()} -->\n`
    + `**Escalated to ${BLOCKING_ESCALATION_SESSION}:** \`${incident.holder}\` was woken at ${BLOCKING_MIN_MINUTES} minutes and this row still holds ${incident.rows.length} shelved rows at ${incident.minutes} minutes. `
    + "The queue is theirs to decide: narrow, split or re-sequence.";
}

/** The escalation order (agent-org#1426). It reuses `ready-row-unclaimable`, as the wake does, and no ledger line is written for it: an escalation is not a new failure. */
export function escalationOrder(incident: Incident, pullRequest: PullRequestState | undefined): BlockingOrder {
  const discriminator = `${incident.holder}-${incident.since}-escalated`;
  return { session: BLOCKING_ESCALATION_SESSION, cause: "ready-row-unclaimable", subject: incident.heldRows[0] === undefined ? `holder-${incident.holder}` : `row-${incident.heldRows[0]}`,
    discriminator, prompt: escalationText(incident, pullRequest), causeKey: `${BLOCKING_ESCALATION_SESSION}/lock-gridlock/${discriminator}` };
}

/** What the holder of a cycle's pull request is woken with, once: the cycle in one sentence and the two ways out, the cheaper first by the chairman's word (agent-org#5009). */
export function deadlockWakeText({ pr, shelved, path, files }: Sighting): string {
  const overlap = files === undefined ? "" : ` (the overlap B4 read: ${files})`;
  return `your pull request ${pr} is in a circular wait no tick will clear: it closes ${pathText(path)}, and B4 shelves #${shelved} behind ${pr} because ${pr} touches its files${overlap}, `
    + `so ${pr} cannot merge before #${shelved} is done and #${shelved} cannot be offered before ${pr} is gone. Break it now, in whichever direction is cheaper: `
    + `(1) narrow ${pr} to drop the overlapping file, so B4 stops shelving #${shelved}; or (2) if #${shelved}'s change is small and inside your Region, take it into ${pr} and close it there. `
    + `If the cycle is still standing on the next tick, the gate files an incident naming #${shelved} and ${pr} and wakes ${DEADLOCK_ESCALATION_SESSION}.`;
}

/** What the escalation is woken with, and what the two rows are told: both rows named, the cycle, and whom it was put to before. */
export function deadlockEscalationText({ pr, shelved, path }: Sighting, { woke, minutes }: { woke: string | null; minutes: number }): string {
  const before = woke === null
    ? `No session is known to hold ${pr}, so nobody was woken before this.`
    : `${woke} was woken once with the instruction to narrow ${pr} or take #${shelved}'s change in, and the cycle was still standing on the next tick.`;
  return `circular wait: ${pr} closes ${pathText(path)}, and B4 shelves #${shelved} behind ${pr}: neither can move, and it has stood for ${minutes} minutes (first read to now). ${before} `
    + `Decide the direction: narrow ${pr} off the overlapping file, take #${shelved}'s change into ${pr}, or release one of the two claims.`;
}

/** The row write on each of the two rows an escalated cycle names. The marker keeps a second tick from reading it as new. */
export function deadlockRowComment(deadlock: Sighting, { woke, minutes, since }: { woke: string | null; minutes: number; since: number }): string {
  return `<!-- b4-deadlock: ${deadlockKey(deadlock)} since ${new Date(since).toISOString()} -->\n**${deadlockEscalationText(deadlock, { woke, minutes })}**`;
}

const minutesSince = (since: number, now: number): number => Math.max(0, Math.round((now - since) / MS_PER_MINUTE));

/** Strip what a discriminator or cause key should not carry: a pull request's `#` and a repository's `/`. */
const slug = (text: string): string => text.replace(/[^\w.-]+/g, "-");

/** The order for one move: the holder's wake, or the escalation. Both reuse `ready-row-unclaimable`, as the gridlock wake does: a new cause is a change to the closed vocabulary. */
export function deadlockOrder(move: DeadlockMove, now: number): BlockingOrder {
  const { deadlock, since } = move;
  const discriminator = `${slug(deadlockKey(deadlock))}-${since}`;
  const subject = `row-${deadlock.shelved}`;
  if (move.kind === "wake-holder") {
    return { session: move.holder, cause: "ready-row-unclaimable", subject, discriminator, prompt: deadlockWakeText(deadlock), causeKey: `${move.holder}/b4-deadlock/${discriminator}` };
  }
  const minutes = minutesSince(since, now);
  return { session: DEADLOCK_ESCALATION_SESSION, cause: "ready-row-unclaimable", subject, discriminator: `${discriminator}-escalated`,
    prompt: deadlockEscalationText(deadlock, { woke: move.woke, minutes }), causeKey: `${DEADLOCK_ESCALATION_SESSION}/b4-deadlock/${discriminator}-escalated` };
}

/** What the daily pass counts: the cycles read in the window, and how long each stood. `minutes` of a standing one is its age at `now`. */
export type DeadlockSummary = { found: number; standing: { key: string; minutes: number }[]; broken: { key: string; minutes: number; escalated: boolean }[] };

/** THE DAILY PASS'S COUNT (agent-org#5009): cycles broken in the 24 hours to `now` with how long each stood, and the ones still standing. A record with neither is `found: 0`, which is a reading. */
export function deadlockSummary(record: BlockingRecord, now: number): DeadlockSummary {
  const standing = Object.entries(record.deadlocks ?? {}).map(([key, e]) => ({ key, minutes: minutesSince(e.since, now) }));
  const broken = (record.brokenDeadlocks ?? []).filter((b) => b.at > now - DAY_MS && b.at <= now).map(({ key, minutes, escalated }) => ({ key, minutes, escalated }));
  return { found: standing.length + broken.length, standing, broken };
}

/** @returns the record; throws for text that is not one (the caller tells an absent file, ENOENT, from a corrupt one) */
export function parseRecord(text: string): BlockingRecord {
  const parsed = JSON.parse(text);
  if (typeof parsed?.at !== "number" || typeof parsed.episodes !== "object" || parsed.episodes === null || !Array.isArray(parsed.samples)) {
    throw new Error(`${BLOCKING_FILE} is not a blocking record: ${text.slice(0, 120)}`);
  }
  return parsed as BlockingRecord;
}

/** The one line per holder a tick logs, so `work:tick` prints each holder's shelved count (the row's Done-when 2). */
export function holdingLines(holdings: Map<string, Holding>, { episodes, unattributed }: { episodes: Record<string, Episode>; unattributed: number }): string[] {
  const lines = [...holdings].map(([holder, h]) => `blocking-impact: ${holder} shelves ${h.rows.length} rows${h.heldRows.length > 0 ? ` behind ${rowList(h.heldRows)}` : ""}: ${rowList(h.rows)}${episodes[holder] ? " (episode open)" : ""}`);
  return unattributed > 0 ? [...lines, `blocking-impact: ${unattributed} B4 shelvings name a row or pull request nobody is known to hold`] : lines;
}

export type BlockingIo = {
  read?: (path: string) => string; write?: (path: string, text: string) => void;
  /** `repo` is the keyed tracker the row is in; absent for the home tracker's. */
  comment?: (row: number, body: string, repo?: string) => void; record?: typeof recordFailure; log?: (line: string) => void;
};

const readText = (path: string) => readFileSync(path, "utf8");
function writeAtomic(path: string, text: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.tmp`, text);
  renameSync(`${path}.tmp`, path);
}
const logToStderr = (line: string) => process.stderr.write(`${line}\n`);
const firstLine = (cause: unknown): string => String((cause as Error)?.message ?? cause).split("\n")[0].slice(0, 160);

/** @returns the previous record, or `null` for none or one that cannot be read; an unreadable one is REPORTED, so a corrupt file is not mistaken for a first tick */
function previousRecord(path: string, { read, log }: Required<Pick<BlockingIo, "read" | "log">>): BlockingRecord | null {
  try {
    return parseRecord(read(path));
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException)?.code !== "ENOENT") log(`blocking-impact: ${path} could not be read (${firstLine(cause)}); every episode starts afresh`);
    return null;
  }
}

/** The row write on each held row of an incident or an escalation, in the tracker the held rows are in. A refusal is reported and stops nothing. */
function writeHeldRows(incident: Incident, body: string, io: Required<BlockingIo>) {
  const { heldIn } = incident;
  for (const row of heldIn === null ? [] : incident.heldRows) {
    try {
      io.comment(row, body, heldIn ?? undefined);
    } catch (cause) {
      io.log(`blocking-impact: the row write on #${row} was refused (${firstLine(cause)})`);
    }
  }
}

/** Raise an incident: the ledger event, the row writes, and the wake order. Each effect reports its own refusal and none stops the others. */
function raise(incident: Incident, { logPath, now, io }: { logPath: string; now: number; io: Required<BlockingIo> }): BlockingOrder {
  io.record({ logPath, classKey: LOCK_GRIDLOCK_KIND, ref: episodeRef(incident), now, report: io.log });
  writeHeldRows(incident, rowComment(incident), io);
  return wakeOrder(incident);
}

/** Raise an escalation (agent-org#1426): the row writes and the product-manager order. No ledger event, which would count as another occurrence of the class. */
function raiseEscalation(incident: Incident, { io, pullRequest }: { io: Required<BlockingIo>; pullRequest: PullRequestState | undefined }): BlockingOrder {
  writeHeldRows(incident, escalationRowComment(incident), io);
  return escalationOrder(incident, pullRequest);
}

/** The pull request each holder shelves behind, read from its shelvings (`prOf`), with its review decision. The first shelving of a holder that names one is the one kept. */
function pullRequestsOf(blocked: Shelved[], resolve: Resolver): Map<string, PullRequestState> {
  const found = new Map<string, PullRequestState>();
  const { waits } = resolve;
  if (waits === undefined) return found;
  for (const shelving of blocked) {
    const ref = refOfShelving(shelving);
    const held = ref === null ? null : resolve(ref);
    if (held === null || held.row === null || found.has(held.holder)) continue;
    const pullRequest = waits.closingPrOf(held.row, held.holder, held.repo);
    if (pullRequest !== null) found.set(held.holder, pullRequest);
  }
  return found;
}

/**
 * THE ONE CALL THE GATE MAKES. Sums this tick's `blocked` per holder, advances the record in `stateDir`, and for each incident newly due records it, writes the held rows and
 * returns the holder's wake order. Never throws. A record that could not be WRITTEN raises the incident's ledger event and order (the wake and the ledger de-duplicate by key) but
 * writes no row comment, which would otherwise be repeated every tick. A circular wait (agent-org#5009) is the other way: with no record there is no "second tick", so it makes no order at all and says so.
 * @param {{ blocked: Shelved[], resolve: (ref: Ref) => Held | null, stateDir: string, now: number } & BlockingIo} tick
 */
export function blockingImpactTick({ blocked, resolve, stateDir, now, ...seams }: { blocked: Shelved[]; resolve: Resolver; stateDir: string; now: number } & BlockingIo): BlockingOrder[] {
  const io: Required<BlockingIo> = { read: readText, write: writeAtomic, comment: () => {}, record: recordFailure, log: logToStderr, ...seams };
  const path = `${stateDir}/${BLOCKING_FILE}`;
  try {
    const sightings = sightingsAmong(blocked, resolve);
    const { holdings, unattributed } = holdingsOf(blocked, resolve, new Set(sightings.map((d) => rowKey(d.shelved, d.repo))));
    const previous = previousRecord(path, io);
    const { record, incidents, escalations } = advance(previous, { now, holdings });
    const cycles = advanceDeadlocks(previousDeadlocks(previous, now), sightings, now);
    for (const deadlock of sightings) io.log(deadlockLine(deadlock));
    for (const line of holdingLines(holdings, { episodes: record.episodes, unattributed })) io.log(line);
    const kept = persisted(path, withDeadlocks(record, cycles, { previous, now }), io);
    const logPath = `${stateDir}/${FAILURE_LEDGER_FILE}`;
    const orders = incidents.map((incident) => raise(incident, { logPath, now, io: kept ? io : { ...io, comment: () => {} } }));
    // An escalation is made only when the record that says it was made is kept: otherwise the next tick would make it again.
    if (kept) {
      const pullRequests = pullRequestsOf(blocked, resolve);
      return [...orders, ...escalations.map((incident) => raiseEscalation(incident, { io, pullRequest: pullRequests.get(incident.holder) })), ...cycles.moves.map((move) => raiseDeadlock(move, { logPath, now, io }))];
    }
    if (cycles.moves.length > 0) io.log("blocking-impact: no circular-wait order was made this tick: the record was not kept, so the same cycle would be put to its holder afresh on every tick");
    return orders;
  } catch (cause) {
    io.log(`blocking-impact: this tick's count was not made (${firstLine(cause)})`);
    return [];
  }
}

/** The cycles the last tick read, or none when the tick before this one is older than a gap in observation: minutes nobody observed are not counted as a cycle standing. */
function previousDeadlocks(previous: BlockingRecord | null, now: number): Record<string, DeadlockEpisode> {
  const continuous = previous !== null && now >= previous.at && now - previous.at <= MAX_TICK_GAP_MS;
  return continuous ? previous.deadlocks ?? {} : {};
}

/** The record with this tick's cycles and the broken ones of the last 24 hours added; each key is absent when there is nothing under it, so a record with no cycle is the record it always was. */
function withDeadlocks(record: BlockingRecord, cycles: { episodes: Record<string, DeadlockEpisode>; broken: BrokenDeadlock[] }, { previous, now }: { previous: BlockingRecord | null; now: number }): BlockingRecord {
  const broken = [...(previous?.brokenDeadlocks ?? []).filter((b) => b.at > now - DAY_MS), ...cycles.broken.map((b) => ({ ...b, at: now }))];
  return { ...record, ...(Object.keys(cycles.episodes).length === 0 ? {} : { deadlocks: cycles.episodes }), ...(broken.length === 0 ? {} : { brokenDeadlocks: broken }) };
}

/**
 * Act on one cycle's move and return its order. A wake is only the order; an escalation is the ledger event, the row write on each of the two rows it names (the closed row and the shelved one,
 * in the tracker the shelved row is in), and the order. Each effect reports its own refusal and none stops the others.
 */
function raiseDeadlock(move: DeadlockMove, { logPath, now, io }: { logPath: string; now: number; io: Required<BlockingIo> }): BlockingOrder {
  if (move.kind === "escalate") {
    const { deadlock, since, woke } = move;
    io.record({ logPath, classKey: B4_DEADLOCK_KIND, ref: `${deadlockKey(deadlock)}@${new Date(since).toISOString()}`, now, report: io.log });
    const body = deadlockRowComment(deadlock, { woke, since, minutes: minutesSince(since, now) });
    for (const row of [deadlock.path[0], deadlock.shelved]) {
      try {
        io.comment(row, body, deadlock.repo);
      } catch (cause) {
        io.log(`blocking-impact: the row write on #${row} was refused (${firstLine(cause)})`);
      }
    }
  }
  return deadlockOrder(move, now);
}

/** @returns whether the record was kept; a refusal is reported */
function persisted(path: string, record: BlockingRecord, io: Required<BlockingIo>): boolean {
  try {
    io.write(path, JSON.stringify(record));
    return true;
  } catch (cause) {
    io.log(`blocking-impact: ${path} was not written (${firstLine(cause)}); an open episode will be counted again next tick`);
    return false;
  }
}
