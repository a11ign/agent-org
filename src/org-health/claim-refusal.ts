import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { CANARY_STATE_NAME, stateEntryPath } from "../host-config.ts";
import { CI_RERUN_LEDGER_FILE, rerunOn5xx } from "../ci-rerun-on-5xx.ts";
import { CLAIM_GUARD_HELD_KIND, CLAIM_REFUSED_KIND, FAILURE_LEDGER_FILE, parseFailureLedger } from "../failure-ledger.ts";
import type { FlagLedger } from "../flag-switch-ledger.ts";
import { tickHealthLine, tickRecordUnwrittenLine, tickWallIsHigh, type TickHealth, type TickRecordState } from "../work-tick-health.ts";
import { MAX_REASON_CHARS, MS_PER_MINUTE, SIGNALS, clear, isoOf, type Reading, unknown } from "./no-merge-hours.ts";
import { CLAIM_REFUSAL_STORM_MINUTES, CLAIM_REFUSAL_STORM_REFUSALS } from "./review-gated-minutes.ts";

/** One refused claim, as the failure ledger holds it: when, and the claim's own words for why (a line, never a path through a stack). */
export type ClaimRefusal = { at: number; reason: string };

const squashed = (text: string): string => text.replace(/\s+/g, " ").trim();

/**
 * SIGNAL 26: CLAIMS ARE BEING REFUSED IN A STORM -- MORE THAN `CLAIM_REFUSAL_STORM_REFUSALS` REFUSALS IN THE LAST `CLAIM_REFUSAL_STORM_MINUTES`. It names the MOST FREQUENT REASON and
 * how many of the window's refusals gave it, because "claims are refused" with no cause is the line the org read for an hour on 2026-10-11 and could not act on. A tie is
 * broken by the reason's own text, so the same ledger names the same reason every tick.
 *
 * COUNTED, NOT DE-DUPLICATED: ten refusals of ten rows and ten refusals of one row are both ten claims the org could not make, which is what blocks work. A refusal exactly
 * `CLAIM_REFUSAL_STORM_MINUTES` old is inside the window, and one dated after `now` (a clock a little ahead) is counted, never dropped.
 *
 * `refusals` is `null` for a ledger that could not be read, a stated unknown and never "no storm". Keyed on the commonest reason, so one storm is one order however many ticks
 * it lasts and a storm that changes its cause is a second.
 */
export function claimRefusalStormReading({ now, refusals }: { now: number; refusals: ClaimRefusal[] | null; }): Reading {
  const signal = SIGNALS.CLAIM_REFUSAL_STORM;
  if (refusals === null) return unknown(signal, "the failure ledger could not be read, so whether claims are being refused in a storm is not known");
  const window = CLAIM_REFUSAL_STORM_MINUTES * MS_PER_MINUTE;
  const recent = refusals.filter((refusal) => now - refusal.at <= window).sort((a, b) => a.at - b.at);
  if (recent.length <= CLAIM_REFUSAL_STORM_REFUSALS) return clear(signal);
  const counts = new Map<string, number>();
  for (const { reason } of recent) counts.set(squashed(reason), (counts.get(squashed(reason)) ?? 0) + 1);
  const [reason, count] = [...counts].sort(([a, x], [b, y]) => y - x || a.localeCompare(b))[0];
  const shown = reason.length > MAX_REASON_CHARS ? `${reason.slice(0, MAX_REASON_CHARS)}...` : reason;
  return { signal, status: "tripped", firstTrippedAt: recent[CLAIM_REFUSAL_STORM_REFUSALS].at,
    discriminator: `${signal}@${createHash("sha256").update(reason).digest("hex").slice(0, 8)}`,
    detail: `${recent.length} claims were refused in the last ${CLAIM_REFUSAL_STORM_MINUTES} min (more than ${CLAIM_REFUSAL_STORM_REFUSALS}); the most frequent reason, ${count} of them: ${JSON.stringify(shown)}` };
}

/**
 * THE FACT FOR `claimRefusalStormReading`: the failure ledger's `claim-refused` lines and its `claim-guard-held` lines (agent-org#1262: the guard working still counts as a refusal here). A ledger that is not there is `[]`, because nothing has written one, which is what a
 * host that has refused no claim holds; one that cannot be read, or holds a line that does not parse (`parseFailureLedger` throws, an event read wrong is a storm drawn
 * wrong), is `null`. NEVER THROWS.
 */
export function readClaimRefusals({ path, read = (file) => readFileSync(file, "utf8") }: { path?: string; read?: (path: string) => string; } = {}): ClaimRefusal[] | null {
  try {
    const file = path ?? stateEntryPath(FAILURE_LEDGER_FILE);
    let text: string;
    try {
      text = read(file);
    } catch (err) {
      if ((err as NodeJS.ErrnoException | null)?.code === "ENOENT") return [];
      throw err;
    }
    return parseFailureLedger(text, file).filter((entry) => entry.classKey === CLAIM_REFUSED_KIND || entry.classKey === CLAIM_GUARD_HELD_KIND).map(({ at, ref }) => ({ at, reason: ref }));
  } catch {
    return null;
  }
}

/**
 * One API budget as a real call's answer gave it (`poolFromHeaders`, or a `rateLimit` field in a query the gate was sending anyway), NEVER `/rate_limit`, which has reported a full pool during a total outage (#1967). `account` is the login the call ran as, `null` when the answer did not name one.
 */
export type PoolReading = { account: string | null, resource: string, remaining: number, limit: number, resetAt: string | null };

/**
 * SIGNAL: A FLAG THE CODE SHIPS OFF AND NOBODY SET (agent-org#1135). `ledger` is `readFlagLedger`'s answer: `null` is a refused read and `{ unknown }` a read that named why it could not be
 * made, both unknown and never clear (a declaration that did not parse is not a declaration that holds nothing). A flag decided as `false` is not counted, and an absent one is.
 * It trips THE TICK ONE IS UNSET, with no grace: the violation is that the switch row was not filed with the change, and a grace period is the delay the rule exists to end.
 * KEYED ON THE DAY AND THE SET, so each unset flag is named once a day (a standing set is one order a day, and a newly shipped flag is a new order the day it ships) and a day's
 * order is not re-opened by a tick. The detail IS the list: key, the constant that holds it, the merge that added it, and the pull request, so no one searches for which change.
 */
export function flagSwitchReading({ day, ledger }: { day: string; ledger: FlagLedger | null; }): Reading {
  const signal = SIGNALS.FLAG_WITHOUT_SWITCH;
  if (ledger === null) return unknown(signal, "the flags the code ships could not be read against the declarations");
  if ("unknown" in ledger) return unknown(signal, ledger.unknown);
  const absent = ledger.canaryAbsent ?? [];
  if (ledger.unset.length === 0 && absent.length === 0) return clear(signal);
  const line = (flag: { key: string; name: string; file: string; mergedAt: string | null; pr: number | null; }) => `- \`${flag.key}\` (${flag.name} in ${flag.file}), merged ${flag.mergedAt === null ? "on a date git did not give" : flag.mergedAt.slice(0, 10)}${flag.pr === null ? "" : ` in #${flag.pr}`}`;
  const parts: string[] = [];
  if (ledger.unset.length > 0) parts.push(`${ledger.unset.length} of ${ledger.shipped} flags the code ships ${ledger.unset.length === 1 ? "is" : "are"} OFF because no declaration sets ${ledger.unset.length === 1 ? "it" : "them"}:\n${ledger.unset.map(line).join("\n")}`);
  // agent-org#1324: a flag whose home is the canary state and that the state does not carry two hours after its merge, with no owed row naming it
  if (absent.length > 0) parts.push(`${absent.length} ${absent.length === 1 ? "flag is" : "flags are"} merged and ABSENT from ${CANARY_STATE_FILE} for over two hours, with no open \`ready\` or \`in-progress\` row naming ${absent.length === 1 ? "it" : "them"}:\n${absent.map(line).join("\n")}`);
  return { signal, status: "tripped", firstTrippedAt: null,
    discriminator: `${signal}@${day}:${[...ledger.unset, ...absent].map((flag) => flag.key).sort().join(",")}`,
    detail: parts.join("\n") };
}

/**
 * SIGNAL: THE TICK RECORD IS UNWRITTEN (agent-org#1208). A slow tick wakes nobody and is recorded on one standing row; this is the line that says when it could not be
 * (a refused write, or no row declared), so a record that stopped is seen and the fallback is never a wake per overrun. `state` is the tick's own record state file, read by the
 * gate; an unreadable file is already `unwritten` there, so there is no unknown of this reading's own. Keyed on the day the write first failed, so one outage is one line.
 */
export function tickRecordReading({ now, state }: { now: number; state: TickRecordState; }): Reading {
  const signal = SIGNALS.TICK_RECORD_UNWRITTEN;
  const line = tickRecordUnwrittenLine(state, now);
  if (line === null || state.unwritten === null) return clear(signal);
  return { signal, status: "tripped", firstTrippedAt: state.unwritten.since, discriminator: `${signal}@${isoOf(state.unwritten.since).slice(0, 10)}`, detail: line };
}

/**
 * SIGNAL: THE TICK WALL'S p95 IS PAST THE LIMIT (agent-org#1208, done-when 5). The chairman's two health signals, tick wall p50/p95 and `tick-overran` wakes per day, are read from the
 * record's own cost file (`tickHealthOf`) and printed on this reading's `detail` whether it trips or not; it TRIPS when the p95 is over the limit, i.e. more than one tick in twenty
 * overran. A window with no tick is clear (the cost file's own failure is said by the tick). Keyed on the day, so it is one line a day and never an order per overrun.
 */
export function tickWallReading({ day, health }: { day: string; health: TickHealth | null; }): Reading {
  const signal = SIGNALS.TICK_WALL_HIGH;
  if (health === null || health.ticks === 0) return clear(signal);
  const detail = tickHealthLine(health);
  if (!tickWallIsHigh(health)) return { signal, status: "clear", detail };
  return { signal, status: "tripped", firstTrippedAt: null, discriminator: `${signal}@${day}`, detail };
}

/** What the merge-queue detector counted: the day's re-queues, and each entry that stood with no run AGAIN after its one re-queue (`why` says what that re-queue came to). */
export type QueueNoRunFact = { today: number; repeats: { pull: number; sha: string; minutes: number; why: string }[] };

/**
 * SIGNAL: A MERGE-QUEUE ENTRY WHOSE CHECKS NEVER STARTED (agent-org#1195). It COUNTS the day's re-queues, which is the chairman's "so we know how often GitHub drops the event", and it names an INCIDENT
 * for a repeat: an entry with no run AGAIN after its one re-queue, which the gate does not re-queue a second time. Keyed on the day, the count and the repeats, so a new occurrence is a new order
 * and a standing one is not. It is a DIGEST class: `product-manager` reads it first and at once, `ceo` in the digest, and a queue that stays stuck also trips `no-merge-while-work-exists`.
 */
export function queueEntryNoRunReading({ day, fact }: { day: string; fact: QueueNoRunFact; }): Reading {
  const signal = SIGNALS.QUEUE_ENTRY_NO_RUN;
  if (fact.today === 0 && fact.repeats.length === 0) return clear(signal);
  const lines = fact.repeats.map((repeat) => `INCIDENT: #${repeat.pull} has stood AWAITING_CHECKS ${repeat.minutes} minutes with no run on ${repeat.sha.slice(0, 12)} AGAIN after its one re-queue (${repeat.why}); the gate does not re-queue it a second time`);
  return { signal, status: "tripped", firstTrippedAt: null,
    discriminator: `${signal}@${day}:${fact.today}:${fact.repeats.map((repeat) => repeat.pull).sort((a, b) => a - b).join(",")}`,
    detail: [`${fact.today} merge-queue entr${fact.today === 1 ? "y was" : "ies were"} re-queued today because no run of its group ever started`, ...lines].join("\n") };
}

/** One line of the `checks rerun on 5xx` ledger the tick writes (agent-org#1217): when, which run, and the repository it was in. */
export type RerunOn5xx = { at: number; runId: number; repo: string };

const RERUN_LEDGER_LINE = /^(\d+)\tchecks rerun on 5xx: (\S+) run (\d+) head \S+: /;

/**
 * THE FACT FOR `requiredRedOn5xxReading`: the tick's `checks rerun on 5xx` ledger, beside the delivery ledger. A ledger that is not there is `[]` (the tick has rerun nothing, which is the
 * ordinary case while `ci.rerunOn5xx` is off); one that cannot be read, or holds a line that is not `<epochMs>\tchecks rerun on 5xx: <repo> run <id> head <sha>: <why>`, is `null`: a line read
 * wrong is a count drawn wrong, and a stated unknown is never zero. NEVER THROWS.
 */
export function readRerunsOn5xx({ path, read = (file) => readFileSync(file, "utf8") }: { path?: string; read?: (path: string) => string; } = {}): RerunOn5xx[] | null {
  try {
    const file = path ?? stateEntryPath(CI_RERUN_LEDGER_FILE);
    let text: string;
    try {
      text = read(file);
    } catch (err) {
      if ((err as NodeJS.ErrnoException | null)?.code === "ENOENT") return [];
      throw err;
    }
    const entries: RerunOn5xx[] = [];
    for (const line of text.split("\n")) {
      if (line.trim() === "") continue;
      const match = RERUN_LEDGER_LINE.exec(line);
      if (match === null) return null;
      entries.push({ at: Number(match[1]), repo: match[2], runId: Number(match[3]) });
    }
    return entries;
  } catch {
    return null;
  }
}

/** The run ids of the ledger's reruns, per UTC day (`YYYY-MM-DD`), oldest id first. A day with none is not a key: ask {@link requiredRedOn5xxReading} for today's zero. */
export function rerunsPerDay(reruns: RerunOn5xx[]): Map<string, number[]> {
  const days = new Map<string, number[]>();
  for (const { at, runId } of reruns) {
    const day = isoOf(at).slice(0, 10);
    days.set(day, [...(days.get(day) ?? []), runId].sort((a, b) => a - b));
  }
  return days;
}

/**
 * SIGNAL: REQUIRED CHECKS RERUN ON A GITHUB 5xx (agent-org#1218, chairman a11ign#928): HOW OFTEN GITHUB BROKE A REQUIRED CHECK AND THE TICK ANSWERED IT WITH A RERUN, so the cost of the
 * rerun is measured. Counted from the ledger line the tick writes, per UTC day, with the run ids. A day with no rerun is a COUNT OF ZERO printed in the detail and `clear`, never an absent
 * reading; the count trips as a digest (`product-manager` first), keyed on the day and the ids, so a new rerun is a new order and a standing day is not. `reruns` is `null` for a ledger
 * that could not be read: unknown, never zero.
 */
export function requiredRedOn5xxReading({ now, reruns }: { now: number; reruns: RerunOn5xx[] | null; }): Reading {
  const signal = SIGNALS.REQUIRED_RED_ON_5XX;
  if (reruns === null) return unknown(signal, "the `checks rerun on 5xx` ledger could not be read, so how often a required check was rerun on a 5xx is not known");
  const day = isoOf(now).slice(0, 10);
  const ids = rerunsPerDay(reruns).get(day) ?? [];
  const detail = `${ids.length} required check${ids.length === 1 ? " was" : "s were"} rerun on a GitHub 5xx on ${day}${ids.length === 0 ? "" : `: run ${ids.join(", run ")}`}`;
  if (ids.length === 0) return { signal, status: "clear", detail };
  return { signal, status: "tripped", firstTrippedAt: null, discriminator: `${signal}@${day}:${ids.join(",")}`, detail };
}

/**
 * One rerun made at attempt 2 or later, as a reader of the code host saw it: the run, when, the log's own text (`lastErrorLine` reads it), and whether a person asked for it. `byPerson`
 * is the caller's to decide from the run's triggering actor, because this file holds no tracker call (the call baseline).
 */
export type RerunSeen = { runId: number; at: number; log: string; byPerson: boolean };

/**
 * SIGNAL: A PERSON RERAN A RUN WHOSE LAST ERROR WAS A GITHUB 5xx (agent-org#1218): THE DETECTOR'S MISSES MADE VISIBLE. The decider (`rerunOn5xx`) answers `rerun` for such a log with no prior
 * rerun on the head, so a person doing it by hand is a case the tick did not answer (the switch was off, the tick was down, or the detector read the log differently). The decider is
 * ASKED, not re-implemented, so the two agree on what a 5xx is. A run in the tick's own ledger is not a miss, whoever the code host says triggered it. Per UTC day, with the run ids, a day with none
 * `clear` with a zero. `seen` is `null` for a read that was refused, and `ledger` `null` for an unreadable ledger: each unknown, because a ledger that cannot be read cannot excuse a rerun.
 */
export function manualRerunsReading({ now, seen, ledger }: { now: number; seen: RerunSeen[] | null; ledger: RerunOn5xx[] | null; }): Reading {
  const signal = SIGNALS.MANUAL_RERUNS;
  if (seen === null) return unknown(signal, "the reruns on the code host could not be read, so how often a person reran a 5xx by hand is not known");
  if (ledger === null) return unknown(signal, "the `checks rerun on 5xx` ledger could not be read, so a person's rerun cannot be told from the tick's");
  const day = isoOf(now).slice(0, 10);
  const tick = new Set(ledger.map((entry) => entry.runId));
  const ids = seen
    .filter((rerun) => rerun.byPerson && isoOf(rerun.at).slice(0, 10) === day && !tick.has(rerun.runId))
    .filter((rerun) => rerunOn5xx({ log: rerun.log, conclusion: "failure", rerunsOnThisHead: false }).action === "rerun")
    .map((rerun) => rerun.runId).sort((a, b) => a - b);
  const detail = `${ids.length} run${ids.length === 1 ? "" : "s"} whose last error was a GitHub 5xx ${ids.length === 1 ? "was" : "were"} rerun by a person on ${day}${ids.length === 0 ? "" : `: run ${ids.join(", run ")}`}`;
  if (ids.length === 0) return { signal, status: "clear", detail };
  return { signal, status: "tripped", firstTrippedAt: null, discriminator: `${signal}@${day}:${ids.join(",")}`, detail };
}

/**
 * SIGNAL: THE POSITION-1 ENTRY HAS STOOD IN THE MERGE QUEUE TOO LONG (agent-org#1195). `head` is `null` for an empty queue, which is clear; `runs` is the count of `merge_group` runs on its head commit,
 * `null` when that was not read, and is said in the detail so the reader sees at once whether the checks started. Keyed on the day and the pull request, so a stall is ONE order, not one per tick.
 * @param limit the age past which it trips: the detector's own, so the two agree on what "too long" is
 */
export function queueHeadAgeReading({ day, head, limit }: { day: string; head: { pull: number | null; minutes: number; state: string; runs: number | null } | null; limit: number; }): Reading {
  const signal = SIGNALS.QUEUE_HEAD_AGE;
  if (head === null || head.minutes <= limit) return clear(signal);
  const runs = head.runs === null ? "its runs were not read" : head.runs === 0 ? "no run exists on its group" : `${head.runs} run${head.runs === 1 ? "" : "s"} on its group`;
  return { signal, status: "tripped", firstTrippedAt: null, discriminator: `${signal}@${day}:#${head.pull ?? "unknown"}`,
    detail: `the merge queue's position-1 entry (${head.pull === null ? "no pull request named" : `#${head.pull}`}) has stood ${head.minutes} minutes, past ${limit}, in ${head.state}; ${runs}` };
}

/**
 * agent-org#1168 (a11ign#928, "fix the class, not the three PRs"): THE THREE READINGS BEHIND `health.approvedDirty`, SHIPPED OFF. Each is a pure function of facts the caller read once, and
 * `orgHealthReadings` asks for them only when the switch is decided on, so OFF is NO reading and not a clear one.
 *
 * THE CLASSES ARE NOT IN `SIGNALS`: `work-gate/org-health-suppression.ts` declares every class an order can carry and its test pins `SIGNALS` to that table, a file outside this row's Region.
 * They are registered there in their own row before the switch is set. Until then an order of these classes falls to that table's default, which pages.
 */
export const APPROVED_DIRTY_FLAG = "health.approvedDirty";
/** How long an approved pull request may stay DIRTY with no push to its head before it is a finding (the row's figure). */
export const APPROVED_DIRTY_MINUTES = 30;
/** How many `hold:` labels one pull request may carry at once before the reading names it (a judgment; the chairman's figure is not in the row). */
export const HOLDS_PER_PR = 3;
export const APPROVED_DIRTY_SIGNAL = "approved-pr-dirty";
export const HOLDS_PER_PR_SIGNAL = "holds-per-pr";
export const SAME_WAY_RERUN_SIGNAL = "rerun-failed-the-same-way";

/**
 * One open pull request as the approved-DIRTY reading needs it. `dirtySince` is when the caller FIRST SAW it DIRTY, kept across ticks by the caller, because GitHub gives no time for a merge state;
 * `null` when no tick has seen it DIRTY. `headPushedAt` is the push time of its head commit, `null` when that is not known.
 */
export type DirtyPr = { number: number | string, approved: boolean, mergeStateStatus: string, dirtySince: number | null, headPushedAt: number | null };

export const CANARY_STATE_FILE = CANARY_STATE_NAME;
