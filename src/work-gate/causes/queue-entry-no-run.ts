import { existsSync, readFileSync } from "node:fs";
import { armMerge as armPullRequest, armedAlready } from "../../arm-pr.ts";
import { machineryFlagOn, orgHealthOrders, type CanaryState } from "../../org-health/fleet-build-readings.ts";
import { queueEntryNoRunReading, queueHeadAgeReading, type QueueNoRunFact } from "../../org-health/claim-refusal.ts";
import { writeJsonObject } from "../../claim-stall.ts";
import { TRACKER, githubTicketAdapter } from "../../ticket-port/github-adapter.ts";
import { dequeuePullRequestOf, mergeGroupRunCountOf, queueEntriesOf, type QueueEntry } from "../../ticket-port/queue-entry-reads.ts";
import { type ArmingPort, MS_PER_MINUTE } from "../vocabulary.ts";

// =====================================================================================================================
// agent-org#1195 (a11ign#928, the chairman, 2026-10-12): A MERGE-QUEUE ENTRY WHOSE GROUP NEVER GOT ITS CHECKS REQUESTED IS RE-QUEUED BY THE GATE, ONCE, AND COUNTED.
//
// Measured 2026-10-12: a11ign#5227 was enqueued at 13:19Z at position 1; its group `gh-readonly-queue/main/pr-5227-...` never got a `merge_group` `checks_requested`, so no `ci` run was created,
// #5233 queued behind it passed at 13:46, and nothing merged for 50 minutes. Every detector that existed starts from a run or from an UNQUEUED pull request, and this entry was neither.
//
//   THE DETECTOR is pure over injected reads: an entry `AWAITING_CHECKS` for MORE than `QUEUE_ENTRY_NO_RUN_MINUTES` with no workflow run of event `merge_group` on its group's head commit. THE RUNS, not the
//   webhook feed, so it holds while `events.source` is `poll`. A READ THAT FAILED OR CAME BACK UNPARSEABLE IS "UNREAD", NEVER "NO RUN": a refused runner names nothing and re-queues nothing.
//   CONFIRMED ON A SECOND TICK (`QUEUE_ENTRY_NO_RUN_CONFIRM_MS`): a group that has only just been built, or a run list that lags its creation by seconds, is "no run" for one tick and would be dequeued,
//   which rebuilds every group behind it. The row asks for MORE THAN ten minutes; this makes it ten and the next tick.
//   THE REMEDY, flag `queue.queueEntryNoRun` (`machinery-canary.json`, default OFF; OFF reads and writes nothing): dequeue the pull request and arm it again, ONCE per pull request, and say so on it
//   (marker `queue-entry-no-run:`). THE ONCE IS WRITTEN BEFORE THE ACT, so a tick killed between the two never re-queues twice, and it is spent by an attempt that failed: the next occurrence is then the
//   repeat, whose reading says what the one re-queue came to.
//   A REPEAT IS AN INCIDENT: an entry with no run AGAIN after its one re-queue is not re-queued again; it is raised as the `queue-entry-no-run` org-health reading, to `product-manager` and `ceo`.
//   COUNTED: each re-queue is one in `days` of `queue-entry-no-run.json`, which is "how often GitHub drops the event". It is not a failure-ledger line: `class-repeat` reads that ledger over all time,
//   and two distinct pull requests would then file a class row for what is the measurement itself.
//   `queue-head-age` is the position-1 entry's age, so a stall of this shape shows at ten minutes and not at fifty.
//
// NO `gh` HERE. The two reads and the dequeue are argument builders in `ticket-port/queue-entry-reads.ts`, run through the gate's `run`; the re-arm is `CodeHostPort.armMerge`'s shape.
// Of the repositories the gate reads, only the home one: the other scopes' queues are not asked.
// =====================================================================================================================

/** The machinery flag that lets the gate name and re-queue an entry whose checks never started. */
export const QUEUE_ENTRY_NO_RUN_FLAG = "queue.queueEntryNoRun";

export const QUEUE_ENTRY_NO_RUN_FILE = "queue-entry-no-run.json";

/** How long an entry may stand `AWAITING_CHECKS` with no run before it is named: the row's figure. It is also the age past which `queue-head-age` trips, so the two agree on "too long". */
export const QUEUE_ENTRY_NO_RUN_MINUTES = 10;

/** How long the same entry must have been seen with no run, across ticks, before it is acted on. */
export const QUEUE_ENTRY_NO_RUN_CONFIRM_MS = 60_000;

/** The kind a pull request's record is posted under; its comment carries the marker `queue-entry-no-run: <sha>`. */
const RECORD_KIND = "queue-entry-no-run-requeued";
const RECORD_MARKER = "queue-entry-no-run:";

const AWAITING_CHECKS = "AWAITING_CHECKS";
const QUEUE_BRANCH = "main";
const DAY_MS = 24 * 60 * MS_PER_MINUTE;
const DAYS_KEPT = 14;

type Run = (args: string[]) => string;

/** One re-queue: the group it was for, when, and what it came to (`requeued`, `attempted` before the act's result is known, or why it failed). */
type Requeue = { sha: string; at: number; outcome: string };

/** What the gate remembers between ticks: when each entry was first seen with no run, each pull request it re-queued, and the re-queues per UTC day. */
export type NoRunMemory = { suspect: Record<string, number>; requeued: Record<string, Requeue>; days: Record<string, number> };

export type NoRunContext = {
  scope: string; run: Run; state: CanaryState; stateDir: string; now: number; log: (line: string) => void;
  portFor?: (scope: string) => ArmingPort; prs?: readonly any[];
};

/** An entry named by the detector, with how long it has stood. */
export type NoRunFinding = { entry: QueueEntry; minutes: number };

const dayOf = (now: number): string => new Date(now).toISOString().slice(0, 10);
const firstLine = (cause: unknown): string => String((cause as Error)?.message ?? cause).split("\n")[0].slice(0, 160);

/** Whole minutes since the entry was enqueued; `null` when GitHub's time does not parse, which names nothing (absence is not proof). */
export function minutesStood(entry: QueueEntry, now: number): number | null {
  const at = Date.parse(entry.enqueuedAt);
  return Number.isFinite(at) ? Math.max(0, Math.floor((now - at) / MS_PER_MINUTE)) : null;
}

/**
 * PURE. The entries that are `AWAITING_CHECKS` for MORE than the limit and for which the runs read says there are none. `runs` maps a group's head sha to its count of `merge_group` runs, or `null` for a
 * read that was not made or failed: such an entry is returned in `unread` and is NOT named, because a refused read is not an empty run list.
 */
export function entriesWithoutRun({ entries, runs, now }: { entries: readonly QueueEntry[]; runs: ReadonlyMap<string, number | null>; now: number; }): { stalled: NoRunFinding[]; unread: QueueEntry[] } {
  const stalled: NoRunFinding[] = [];
  const unread: QueueEntry[] = [];
  for (const entry of entries) {
    const minutes = minutesStood(entry, now);
    const isSkippedEntry = entry.state !== AWAITING_CHECKS || minutes === null || minutes <= QUEUE_ENTRY_NO_RUN_MINUTES;
    if (isSkippedEntry || entry.headSha === null) continue;
    const count = runs.get(entry.headSha);
    if (count === undefined || count === null) unread.push(entry);
    else if (count === 0) stalled.push({ entry, minutes });
  }
  return { stalled, unread };
}

/** The memory's text, or the empty memory when there is no file. A file that is there and does not parse THROWS: a memory read as empty would re-queue a pull request a second time. */
export function readNoRunMemory(path: string): NoRunMemory {
  if (!existsSync(path)) return { suspect: {}, requeued: {}, days: {} };
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  const object = (value: unknown) => (value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : null);
  const [suspect, requeued, days] = [object(parsed?.suspect), object(parsed?.requeued), object(parsed?.days)];
  if (suspect === null || requeued === null || days === null) throw new Error(`${path} is not { suspect, requeued, days }`);
  return { suspect, requeued, days };
}

/** The arming port the gate re-queues through: the ticket adapter's comment, and `armMerge` READ BACK from the pull request, because an exit code is not "armed" (#1022). */
export function queueArmingPort(scope: string, run: Run): ArmingPort {
  const tickets = githubTicketAdapter({ run, scope });
  const ghRun = (_cmd: string, args: string[]) => run(args);
  return {
    postDecision: (ref, decision) => tickets.postDecision(ref, decision),
    armMerge(ref) {
      const [repo, number] = ref.id.split("#");
      armPullRequest({ number, repo }, { run: ghRun, sleep: () => "ok", error: () => {} });
      return armedAlready({ number, repo, run: ghRun, error: () => {} }) !== null;
    },
  };
}

type Reads = { entries: QueueEntry[]; runs: Map<string, number | null> };

/** The queue and the runs of the entries that could be named, and of the head. A run read that fails is `null` for that group, said once. THROWS when the queue itself cannot be read. */
function readQueue(ctx: NoRunContext): Reads {
  const entries = queueEntriesOf({ repo: ctx.scope, branch: QUEUE_BRANCH, run: ctx.run });
  const head = entries.reduce<QueueEntry | null>((first, entry) => (first === null || entry.position < first.position ? entry : first), null);
  const runs = new Map<string, number | null>();
  for (const entry of entries) {
    const minutes = minutesStood(entry, ctx.now);
    const askable = entry === head || entry.state === AWAITING_CHECKS;
    if (entry.headSha === null) continue;
    const isSkippedCandidate = runs.has(entry.headSha) || !askable || minutes === null || minutes <= QUEUE_ENTRY_NO_RUN_MINUTES;
    if (isSkippedCandidate) continue;
    try {
      runs.set(entry.headSha, mergeGroupRunCountOf({ repo: ctx.scope, sha: entry.headSha, run: ctx.run }));
    } catch (error) {
      runs.set(entry.headSha, null);
      ctx.log(`queue-entry-no-run: the runs of #${entry.pull ?? "?"}'s group could not be read (${firstLine(error)}); it is not named this tick.\n`);
    }
  }
  return { entries, runs };
}

/** The record on the pull request, once. A failure to post it is said and does not undo the re-queue. */
function postRecord(finding: NoRunFinding, ctx: NoRunContext, port: ArmingPort): void {
  const { entry, minutes } = finding;
  const pr = ctx.prs?.find((candidate) => Number(candidate?.number) === entry.pull);
  const marker = `${RECORD_MARKER} ${entry.headSha}`;
  if ((pr?.comments ?? []).some((comment: any) => String(comment?.body ?? "").includes(marker))) return;
  try {
    port.postDecision({ tracker: TRACKER, scope: ctx.scope, id: entry.pull as number }, { role: "work-gate", runId: `tick-${ctx.now}`, kind: RECORD_KIND, text:
      `**work-gate, ${RECORD_KIND}:** this pull request's merge-queue entry stood \`AWAITING_CHECKS\` for ${minutes} minutes and no \`merge_group\` run was ever created for its group (\`${entry.headSha}\`). `
      + `The gate took it out of the queue and armed it again (agent-org#1195, flag \`${QUEUE_ENTRY_NO_RUN_FLAG}\`). It is re-queued once: a second entry with no run is an incident for \`product-manager\`.\n\n<!-- ${marker} -->` });
  } catch (error) {
    ctx.log(`queue-entry-no-run: #${entry.pull} was re-queued; the record could not be posted (${firstLine(error)}).\n`);
  }
}

/** The one re-queue. Returns what it came to: `requeued`, or why it did not (the dequeue refused, or the pull request does not read as armed after it). Never throws. */
function requeueEntry(finding: NoRunFinding, ctx: NoRunContext, port: ArmingPort): string {
  const { entry } = finding;
  if (entry.pullId === null || entry.pull === null) return "the entry names no pull request to dequeue";
  try {
    dequeuePullRequestOf({ pullId: entry.pullId, run: ctx.run });
  } catch (error) {
    return `the dequeue failed: ${firstLine(error)}`;
  }
  try {
    if (!port.armMerge({ host: TRACKER, id: `${ctx.scope}#${entry.pull}` })) return "the dequeue went through and the pull request does not read as armed";
  } catch (error) {
    return `the dequeue went through and the re-arm failed: ${firstLine(error)}`;
  }
  postRecord(finding, ctx, port);
  return "requeued";
}

function remember(path: string, memory: NoRunMemory, ctx: NoRunContext): boolean {
  try {
    writeJsonObject(path, memory);
    return true;
  } catch (error) {
    ctx.log(`queue-entry-no-run: the record was not kept (${firstLine(error)}); nothing is re-queued until it can be.\n`);
    return false;
  }
}

/** What one tick read and did, for the two readings. */
export type NoRunOutcome = { fact: QueueNoRunFact; head: { pull: number | null; minutes: number; state: string; runs: number | null } | null; requeued: number[] };

/**
 * ONE TICK OF THE DETECTOR AND ITS REMEDY. Reads the queue, names the entries with no run, re-queues the ones not re-queued before, and reports the rest as a repeat. NEVER THROWS: a refused queue read, a
 * memory that cannot be read or written, and every failed act leave the queue as it was and say so. FLAG OFF returns `null` and reads and writes nothing.
 */
export function inspectQueue(ctx: NoRunContext): NoRunOutcome | null {
  if (!machineryFlagOn(ctx.state, QUEUE_ENTRY_NO_RUN_FLAG)) return null;
  const path = `${ctx.stateDir}/${QUEUE_ENTRY_NO_RUN_FILE}`;
  let reads: Reads;
  let memory: NoRunMemory;
  try {
    memory = readNoRunMemory(path);
    reads = readQueue(ctx);
  } catch (error) {
    ctx.log(`queue-entry-no-run: nothing is named this tick, the queue or the record could not be read (${firstLine(error)}).\n`);
    return null;
  }
  const { stalled } = entriesWithoutRun({ entries: reads.entries, runs: reads.runs, now: ctx.now });
  const day = dayOf(ctx.now);
  const seenNow = Object.fromEntries(stalled.map(({ entry }) => [entry.headSha as string, memory.suspect[entry.headSha as string] ?? ctx.now]));
  const next: NoRunMemory = {
    suspect: seenNow,
    requeued: Object.fromEntries(Object.entries(memory.requeued).filter(([, record]) => ctx.now - record.at < DAY_MS)),
    days: Object.fromEntries(Object.entries(memory.days).sort(([a], [b]) => b.localeCompare(a)).slice(0, DAYS_KEPT)),
  };
  const repeats: QueueNoRunFact["repeats"] = [];
  const requeued: number[] = [];
  const port = (ctx.portFor ?? ((scope: string) => queueArmingPort(scope, ctx.run)))(ctx.scope);
  for (const finding of [...stalled].sort((a, b) => a.entry.position - b.entry.position)) {
    const { entry } = finding;
    if (entry.pull === null) { ctx.log(`queue-entry-no-run: the entry at position ${entry.position} has no run and names no pull request; it is not re-queued.\n`); continue; }
    const before = next.requeued[String(entry.pull)];
    if (before !== undefined) {
      repeats.push({ pull: entry.pull, sha: entry.headSha as string, minutes: finding.minutes,
        why: before.outcome === "requeued" ? `re-queued at ${new Date(before.at).toISOString()}` : `its one re-queue did not complete: ${before.outcome}` });
      continue;
    }
    if (ctx.now - (seenNow[entry.headSha as string]) < QUEUE_ENTRY_NO_RUN_CONFIRM_MS) continue; // first seen this tick: confirmed by the next
    next.requeued[String(entry.pull)] = { sha: entry.headSha as string, at: ctx.now, outcome: "attempted" };
    next.days[day] = (next.days[day] ?? 0) + 1;
    if (!remember(path, next, ctx)) { delete next.requeued[String(entry.pull)]; next.days[day] -= 1; continue; } // the one is written BEFORE the act
    const outcome = requeueEntry(finding, ctx, port);
    next.requeued[String(entry.pull)].outcome = outcome;
    requeued.push(entry.pull);
    ctx.log(`queue-entry-no-run: #${entry.pull} stood AWAITING_CHECKS ${finding.minutes} minutes with no run; ${outcome === "requeued" ? "dequeued and armed again" : `NOT re-queued -- ${outcome}`}.\n`);
  }
  remember(path, next, ctx);
  const head = reads.entries.reduce<QueueEntry | null>((first, entry) => (first === null || entry.position < first.position ? entry : first), null);
  const headMinutes = head === null ? null : minutesStood(head, ctx.now);
  return {
    fact: { today: next.days[day] ?? 0, repeats }, requeued,
    head: head === null || headMinutes === null ? null : { pull: head.pull, minutes: headMinutes, state: head.state, runs: head.headSha === null ? null : reads.runs.get(head.headSha) ?? null },
  };
}

/**
 * THE ONE PLACE THE GATE ASKS FOR IT: the org-health orders this tick owes, from `inspectQueue`'s two readings. FLAG OFF is none, and a tick that could not read the queue owes none.
 * The two signals ride `orgHealthOrders`, so a class that is not in `ORG_HEALTH_CLASSES` fails its test and not the gate.
 */
export function queueEntryNoRunOrders(ctx: NoRunContext) {
  const outcome = inspectQueue(ctx);
  if (outcome === null) return [];
  const day = dayOf(ctx.now);
  return orgHealthOrders([queueEntryNoRunReading({ day, fact: outcome.fact }), queueHeadAgeReading({ day, head: outcome.head, limit: QUEUE_ENTRY_NO_RUN_MINUTES })]);
}
