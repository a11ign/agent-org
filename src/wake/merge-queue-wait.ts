import { readFileSync, writeFileSync, appendFileSync, mkdirSync } from "node:fs";
import { loadavg, availableParallelism } from "node:os";
import { dirname, join } from "node:path";
import { transcriptCounts } from "../engineer-escalation.ts";
import { ANSWER_PREFIX } from "../waiting-condition.ts";
import { subjectMention } from "../review-attribution.ts";
import { homeProjectDeclaration } from "../project-config.ts";
import { REPO } from "../project-identity.ts";
import { rows } from "../plugins/rows.ts";
import { roleBriefPath } from "../project-roles.ts";
import { SESSION_PREFIX, OUT_OF_RELEASE_LABEL } from "../project-vocabulary.ts";
import { PARKED_LABEL } from "../wait-condition.ts";
import { readRowsByLabel, readUnlessRefused } from "../ticket-port/rows-by-label.ts";
import { familyMember } from "../arm-pr.ts";
import { firstLine, herdrReason } from "../herdr-agents.ts";
import { DEFERRAL_LOG_FILE, recordEndedDeferrals } from "../deferral-log.ts";
import { BUSY_SEAT_REFUSAL, CAPACITY_REFUSAL, CAPACITY_WAIT_LIMIT_MS, MERGE_QUEUE_WAIT_PHRASE, NO_CLEAR_FIELD } from "./session-endings.ts";
import { START_BUDGET_DEFERRED } from "./pull-request-spawn-orders.ts";
import { BUSY_SEAT_DEFERRAL_MS, WAKEABLE, codeRepositoryOf, defaultRun, guardedGh, type SpareInstance } from "./exit-and-limits.ts";
import { handoffBacklog, prepareContext, readAgent } from "./fyi-queue.ts";
import { ESCALATED, RESET, SESSIONS_FILE, VOIDED, ledgerKeyOf, undelivered } from "./seat-reset.ts";
import { CONTEXT_ACTION, MAX_DELIVERIES, NO_CLOCK, TRANSCRIPT_READER, newestTranscriptRead, type ClaimOrders, type HostLoad, type OrderClock } from "./fyi-delivery-and-limits.ts";

/**
 * HOW LONG A ROW MAY WAIT FOR A PULL REQUEST IN THE MERGE QUEUE BEFORE IT IS "NOWHERE TO GO" AFTER ALL: AN HOUR. One wait was measured, not a
 * distribution: agent-org#545 was enqueued 20:39:43Z and merged 20:44:45Z on 2026-10-09, five minutes (read off the row's comments, #4524). An hour is
 * twelve times that, so a PR that is still queued after it is stuck and is a fault like any other, not a wait.
 */
export const MERGE_QUEUE_WAIT_LIMIT_MS = 60 * 60 * 1000;

/** `<causeKey>: <whatever routed it>; no spawn: #N waits for <PR>, which is in the merge queue: ...`, as {@link spawnClaimability} words it. No `;` inside the capture. */
const MERGE_QUEUE_WAIT_REFUSAL = new RegExp(String.raw`^(\S+): .*; no spawn: (#\d+ waits for [^;]*${MERGE_QUEUE_WAIT_PHRASE}[^;]*)$`);

/**
 * agent-org#1025: `<causeKey>: <whatever routed it>; deferred: this tick's agent starts have used their start budget (...)`. A WAIT, never a fault: the order was not
 * dropped and nothing was started for it, so the next tick offers it again. It has CAPACITY's half-hour limit, so a start that is slow on every tick for
 * thirty minutes is still reported as "nowhere to go". No `;` inside the capture.
 */
const START_BUDGET_REFUSAL = new RegExp(String.raw`^(\S+): .*; (${START_BUDGET_DEFERRED}[^;]*)$`);

/** How many of a tick's refusals are start-budget deferrals ({@link START_BUDGET_REFUSAL}): the number the tick's log names. */
export function startBudgetDeferrals(refused: readonly string[]): number {
  return refused.filter((line) => START_BUDGET_REFUSAL.test(line)).length;
}

/**
 * Which of a tick's refusals are a seat WAITING ITS TURN and which are an order that has no way to arrive (#3029).
 *
 * ONE SUMMARY LINE FOR BOTH IS WHAT KEPT `N order(s) had nowhere to go` IN THE JOURNAL FOR 30 TICKS: `ceo` was `working` on a 24-minute turn
 * and held two queued orders, so 103 of the window's 188 refusals were that, and the 85 that were faults (a refused start, a handoff for a
 * reviewer whose PR had merged, a B4 offer with no taker) shared its line and could not be told from it.
 *
 * @param refused every `<causeKey>: <reason>` line the tick refused
 * A READY ROW WAITING FOR A FREE SEAT IS THE SAME KIND OF WAIT (#3266): every seat `working` or holding its one row, nobody idle to blame. It is
 * deferred under its own, shorter limit, which is why each entry carries `limitMs` and `limitFor` (the clause that names it when it is overdue).
 *
 * @param refused every `<causeKey>: <reason>` line the tick refused
 */
export function splitRefusals(refused: string[]): { busy: { key: string; reason: string; line: string; limitMs: number; limitFor: string; }[]; faults: string[]; } {
  const busy: { key: string; reason: string; line: string; limitMs: number; limitFor: string; }[] = [];
  const faults: string[] = [];
  for (const line of refused) {
    const seat = BUSY_SEAT_REFUSAL.exec(line);
    const capacity = CAPACITY_REFUSAL.exec(line);
    const queued = MERGE_QUEUE_WAIT_REFUSAL.exec(line);
    const startsSpent = START_BUDGET_REFUSAL.exec(line);
    if (seat) busy.push({ key: seat[1], reason: seat[2], line, limitMs: BUSY_SEAT_DEFERRAL_MS, limitFor: "a seat mid-turn" });
    else if (capacity) busy.push({ key: capacity[1], reason: capacity[2], line, limitMs: CAPACITY_WAIT_LIMIT_MS, limitFor: "a free engineer seat" });
    else if (queued) busy.push({ key: queued[1], reason: queued[2], line, limitMs: MERGE_QUEUE_WAIT_LIMIT_MS, limitFor: "a pull request in the merge queue" });
    else if (startsSpent) busy.push({ key: startsSpent[1], reason: startsSpent[2], line, limitMs: CAPACITY_WAIT_LIMIT_MS, limitFor: "the start budget" });
    else faults.push(line);
  }
  return { busy, faults };
}

/**
 * When each currently-deferred causeKey was FIRST deferred, remembered across ticks in `path` (`key<TAB>ms`, one per line, beside the ledger).
 *
 * A derived order has no queue time to read an age from (the gate re-derives it every tick), so the age of a busy-seat wait is the time since
 * this file first saw it. A key no longer deferred is DROPPED, so an order that was delivered and later deferred again starts a new wait rather
 * than inheriting the old one. A missing file is no history; an unreadable or malformed one is NOT (`endedRuns`' rule): a wrong age would either
 * hide a stuck order or accuse a healthy one.
 *
 *  @param keys the causeKeys deferred THIS tick
 * @param [io] `ledgerPath` is the delivery ledger an ended deferral is checked against (#3510)
 * @returns each of `keys` to how long (ms) it has been deferred, 0 for one first seen now
 */
export function deferralAges(path: string, keys: string[], now: number, { read = readFileSync, write = writeFileSync, ledgerPath = undefined }: { read?: typeof readFileSync; write?: typeof writeFileSync; ledgerPath?: string; } = {}): Map<string, number> {
  const since = readDeferralHistory(path, read);
  const kept = new Map(keys.map((key) => [key, since.get(key) ?? now]));
  mkdirSync(dirname(path), { recursive: true });
  // #3510: a span that ENDED is appended to the durable log first (see `recordEndedDeferrals`); a caller with no ledger has no way to say `delivered`, so it keeps no log.
  if (ledgerPath) recordEndedDeferrals({ logPath: `${dirname(path)}/${DEFERRAL_LOG_FILE}`, previous: since, current: kept, deliveries: () => readLedgerDeliveries(ledgerPath, read), now });
  write(path, [...kept].map(([key, at]) => `${key}\t${at}\n`).join(""));
  return new Map(keys.map((key) => [key, now - (kept.get(key) as number)]));
}

/**
 * The file {@link deferralAges} keeps, read and not written: each causeKey to the epoch ms it was FIRST deferred. A missing file is no history; a malformed
 * one THROWS, for the reason {@link deferralAges} gives.
 */
export function readDeferralHistory(path: string, read: typeof readFileSync = readFileSync): Map<string, number> {
  const since: Map<string, number> = new Map();
  try {
    for (const line of String(read(path, "utf8")).split("\n")) {
      if (line.trim() === "") continue;
      const [key, at] = line.split("\t");
      if (!/^\d+$/.test(at ?? "")) throw new Error(`wake: ${path} has a line that is not "<causeKey>\\t<ms>": ${line.slice(0, 120)}`);
      since.set(key, Number(at));
    }
  } catch (err) {
    if ((err as any)?.code !== "ENOENT") throw err;
  }
  return since;
}

/**
 * #3448: THE ORDERS A TICK HAS WAITING ON A BUSY SESSION, AS THE STALL SIGNAL READS THEM -- the deferred derived orders and the standing seats' queues. PURE.
 *
 * A DEFERRED KEY COUNTS ONLY IF THE GATE EMITTED IT THIS TICK (`emitted`): `wake-deferred` is rewritten by the tick that reaches `finishTick`, and a tick with
 * nothing to deliver exits first and leaves the last file behind, so an order delivered since would otherwise be read as still waiting and its age as a stall.
 * NOT `org-health` ORDERS, whose own deferral would otherwise name the signal in the signal about it and mint a new key (so a new delivery) every tick.
 * NOT `engineers/...`, a ready row waiting for a free seat: it has its own, measured bound ({@link CAPACITY_WAIT_LIMIT_MS}, #3266) and "no engineer is idle" is
 * `ceo`'s question about capacity, not a stall.
 *
 * A QUEUE COUNTS ONLY FOR A STANDING SEAT (`standing`): a spawned instance mid-turn on its row for an hour is working, and its inbox is read when it finishes.
 * A standing seat is never between tasks while it works, which is what makes its oldest queued order a stall and not a wait (#3448: `ceo` held three, oldest 28 min).
 */
export function stalledOrdersOf({ deferredSince, emitted, backlog, standing, now }: { deferredSince: Map<string, number>; emitted: Set<string>; backlog: ReturnType<typeof handoffBacklog>; standing: Set<string>; now: number; }): import("../org-health/overdue-readings.ts").StalledOrder[] {
  const deferred = [...deferredSince]
    .filter(([key]) => emitted.has(key) && !key.includes("/org-health/") && !key.startsWith("engineers/"))
    .map(([key, since]) => ({ kind: ("deferred" as const), name: key, since }));
  const queued = backlog.filter((b) => standing.has(b.session))
    .map((b) => ({ kind: ("queue" as const), name: b.session, since: now - b.oldestMs }));
  return [...deferred, ...queued];
}

/**
 * What a tick says about its refusals, and whether any of them is a fault (#3029).
 *
 * A busy seat's order is `DEFERRED`, with its age, and is NOT counted: it is waiting its turn, which is what the queue is for. Past
 * {@link BUSY_SEAT_DEFERRAL_MS} it is a fault like the rest, because a seat `working` for hours IS "no session is taking this work". A READY ROW
 * WAITING FOR A FREE SEAT is the same, under {@link CAPACITY_WAIT_LIMIT_MS} (#3266). Every other
 * refusal is `UNDELIVERED` and counted, and only those make the tick exit ATTENTION.
 *
 *  @param ageOf each key's wait so far, in ms
 * @returns `summary` is null when nothing was a fault
 */
export function refusalReport(refused: string[], ageOf: (keys: string[]) => Map<string, number>): { deferred: string[]; undelivered: string[]; summary: string | null; } {
  const { busy, faults } = splitRefusals(refused);
  const ages = ageOf(busy.map((b) => b.key));
  const minutes = (key: string) => Math.round((ages.get(key) ?? 0) / 60_000);
  const isOverdue = (b: { key: string; limitMs: number; }) => (ages.get(b.key) ?? 0) > b.limitMs;
  const overdue = busy.filter(isOverdue);
  const waiting = busy.filter((b) => !isOverdue(b));
  const undelivered = [...faults, ...overdue.map((b) => `${b.line} (deferred ${minutes(b.key)} min, over the ${b.limitMs / 60_000}-minute limit for ${b.limitFor})`)];
  return {
    deferred: waiting.map((b) => `${b.key}: ${b.reason} (waiting ${minutes(b.key)} min; retried next tick)`),
    undelivered,
    summary: undelivered.length === 0 ? null : `${undelivered.length} order(s) had nowhere to go. A derived cause is NOT in the `
      + "ledger and an authored one is still in the queue, so both are retried on the next tick; if this "
      + "repeats, no session is taking this work.\n",
  };
}

/**
 * A TRIPPED BREAKER MUST REACH A SESSION, NOT A JOURNAL.
 *
 * `MAX_DELIVERIES` is a circuit breaker and the reasoning behind it is sound -- an unresolvable cause
 * would otherwise burn a `sonnet`/`high` turn every twenty minutes forever. What was missing is the half
 * every real breaker has: TRIPPING RAISES AN ALARM. This one wrote `STUCK <key>` to stderr in a systemd
 * journal and stopped.
 *
 * MEASURED 2026-09-21: `ceo/lane-backlog-unpromoted/row-1234` and `ceo/chairman-blocked/0` both tripped.
 * The tick printed `STUCK` every two minutes for over half an hour. `ceo` had two live questions it
 * could no longer be asked, every session read idle, and THE ONLY THING THAT NOTICED WAS THE CHAIRMAN
 * SAYING "the AI agents have all stopped completely".
 *
 * `answer:ceo` IS THE DESTINATION (#2636), NOT `needs:chairman`. A stuck row is a row the SESSIONS could not clear,
 * which is `ceo`'s to unstick; `needs:chairman` now means only what the chairman alone can do (an account, admin,
 * money, a legal act) or a choice `ceo` cannot make, and a briefing that exists to be short. `answer:<session>` is
 * the org's own "a named session owes an answer here": the `answer-owed` cause delivers it (`answerOrders`), removing
 * the label IS the act of answering, and `ESCALATION_LABEL` is set by nobody but this function.
 *
 * THE READER SEES EVERY PLACE THE LABEL CAN SIT (`rowsOwingAnswers`): open issues, `readPrs`'s open PRs, closed ISSUES still
 * owing (#2202) and pull requests that are no longer open, merged or closed unmerged (#2641, `readClosedAnswerRows`).
 * `gh issue edit` accepts a PR number for labels, so both subjects `stuckRowOf` yields can be labelled, and
 * `trunkRedOrders` names the MERGED pull request as its subject: a red `main` nobody fixes lands its `answer:ceo` on a
 * merged PR, which the reader now asks for by label name. Until #2641 that label was set and read by nothing;
 * `needs:chairman` never reached that case either (`readChairmanBlocked` is `issue list --state open`).
 *
 * SUBJECT-DERIVED, because a causeKey is not a row. `row-1234` and `pr-1837` carry their number; a
 * subject like `chairman` or `ready-queue` names no row and cannot be labelled, so it is reported and
 * skipped rather than guessed at -- labelling the wrong row would be worse than labelling none.
 *
 * A DECLARED CODE REPOSITORY'S RED ESCALATES BY A ROW FILED IN THE PRIMARY'S TRACKER, NOT BY A LABEL (#3086). Its subject
 * carries the repository's key (`pr-agent-org#56`, or `trunk-agent-org-<sha8>` when no merged pull request is known:
 * `trunkRedOrders`, #3079), and the bare number would label the primary's own #56, so {@link stuckRowOf} still answers
 * `null` for it. The place the escalation must land is one `ceo` READS, and the two candidates were measured against
 * the reader: a label on the merged agent-org pull request sits where `readClosedAnswerRows` never looks (it asks the
 * primary's repository only, for a code-only scope as for any other), so it would be set and read by nobody, which is the
 * state #2641 ended for the primary. An OPEN ISSUE carrying `answer:ceo` in the primary's tracker is read by every
 * tick's `answer-owed` cause with no change to the reader. Filing costs one issue per stuck red, once (the ledger, and
 * {@link fileRepositoryRow}'s own look for an open one when the ledger could not be written), and it is the only
 * half that works for the `trunk-<key>-<sha8>` subject, which names no pull request at all.
 *
 *  @returns the row to label, or `null` when the key names none
 */
export function stuckRowOf(causeKey: string): number | null {
  const subject = stuckSubjectOf(causeKey);
  return subject?.repoKey === "" ? subject.number : null;
}

/**
 * `row-<n>`, `pr-<n>` or `pr-<key>#<n>` (a pull request or row), `epic-<n>` or `epic-<key>#<n>` (an epic: `epic-finished` and
 * `epic-unfiled` subject it so, #4044), or `trunk-<key>-<sha8>` (a red with no merged pull request known).
 */
const STUCK_SUBJECT = /\/(?:(?:row|pr|epic)-(?:([a-z][\w-]*)#)?(\d+)|trunk-([a-z][\w-]*)-([0-9a-f]{8}))(?:\/|$)/;

/**
 * What a cause key's subject names: the primary's row (`repoKey` empty), a pull request of a keyed repository, or a keyed
 * repository's red with no pull request. `null` when it names none.
 */
export function stuckSubjectOf(causeKey: string): { repoKey: string; number: number | null; sha8: string | null; } | null {
  const m = STUCK_SUBJECT.exec(String(causeKey ?? ""));
  if (m === null) return null;
  return { repoKey: m[1] ?? m[3] ?? "", number: m[2] === undefined ? null : Number(m[2]), sha8: m[4] ?? null };
}

/**
 * The label a stuck cause's row is escalated with: `ceo` owes an answer there (#2636). Not `CHAIRMAN_LABEL`, which
 * is for a wait only a person can end and is set by nobody automatically.
 */
export const ESCALATION_LABEL = `${ANSWER_PREFIX}ceo`;

/**
 * Label every stuck cause's row `answer:ceo`, ONCE PER RUN, and say which could not be.
 *
 * A key addressed TO `ceo` is escalated to `ceo` all the same: if its `answer-owed` order is itself the stuck one, the
 * row already carries the label, the add is a no-op, and the memory below is what ends it.
 *
 * ONCE PER RUN, BECAUSE REMOVING THE LABEL IS AN ANSWER (#2462). Whoever removes `answer:ceo` has read the
 * escalation; the key is still at the cap and still emitted, so without a memory of having escalated it the next
 * tick labelled the row again 28 s later. `escalated` is that memory (`escalatedKeys`) and `record` writes it. The
 * count question, answered: removal LEAVES THE KEY CAPPED AND SILENT until the causeKey changes or the cause stops
 * being emitted (`RESET`), rather than resetting the count. A reset would offer the same unchanged cause to the
 * sessions that already failed to act on it six times, for two more hours, on the strength of an answer that named
 * no change; the person who wants it offered again ends the run by hand with a `RESET` line.
 *
 * FAILS OPEN AND LOUD: a `gh` refusal is reported, never swallowed, and NOT recorded -- so the next tick tries again.
 * The alternative -- a breaker whose alarm silently fails -- is the exact shape being fixed.
 *
 *
 *
 * NOT WHEN THE SESSION CANNOT ANSWER (#2256). A cause's key opens with the session it was addressed to, and one whose
 * session is out of allowance NOW is not a stuck row: `unavailable` says so, the line goes to the tick log INSTEAD of
 * to the row, and nothing is recorded, so the same key escalates the tick after the session is back if it is still at
 * the cap. `engineers` is a pool, not a session, and is not asked.
 *
 * THE LABEL CARRIES ITS QUESTION (#3874). `answer:ceo` set by the tick's own account with nothing written was read as the worker's question,
 * answered by a guess, and the worker read the guess as an answer to a question it never asked (#3289, 63 minutes). So when `ask` is given the
 * comment that says what is asked is written FIRST and the label second, one call site: a comment that fails is a `COULD NOT ESCALATE` with no
 * label and no record, and the next tick tries again. `ask` is `null` only for a caller that opts out; `escalationMemory` always supplies it.
 *
 * AND A CLEARED CAUSE IS ASKED AGAIN, ONCE ({@link reaskCleared}): an `ALREADY ESCALATED` key whose label was removed an hour ago and is still true.
 * A FILED row has no number here: its answer closes it ({@link closeAnsweredRow}, #622) and the closed row is what {@link reaskFiledRow} reads (#656).
 */
export function escalateStuck(stuck: string[], run: (args: string[]) => string = guardedGh, log: (line: string) => void = (l) => process.stderr.write(l),
  { escalated = new Set(), record = () => {}, unavailable = () => null, repoOf = codeRepositoryOf, ask = null, boardOf = primaryBoard }: {
      escalated?: Set<string>; record?: (key: string) => void; unavailable?: (label: string) => string | null; repoOf?: (repoKey: string) => string | null;
      ask?: Asker | null; boardOf?: () => Board | null;
  } = {}) {
  const labelled = [];
  for (const line of stuck ?? []) {
    const key = String(line).split(":")[0];
    const target = escalationTargetOf(key, { repoOf, boardOf });
    if (target === null) {
      log(`STUCK ${line} -- names no row of a repository this project declares, so it cannot be escalated; read the key\n`);
      continue;
    }
    const ref = target.ref;
    if (escalated.has(key)) {
      log(`ALREADY ESCALATED ${ref} (${key}) -- a removed label is an answer; it stays off until the cause changes\n`);
      if (ask !== null && target.row !== null) reaskCleared({ row: target.row, key }, { run, log, ask });
      if (target.title !== null) {
        closeAnsweredRow({ title: target.title, key }, { run, log });
        if (ask !== null) {
          const again = reaskFiledRow({ title: target.title, key, place: target.place }, { run, log, ask });
          if (again !== null) labelled.push(again);
        }
      }
      continue;
    }
    const outage = outageOf(key, unavailable);
    if (outage !== null) {
      log(`NOT ESCALATED ${ref} (${key}) -- ${outage}; a session that cannot answer is not a stuck row\n`);
      continue;
    }
    try {
      if (ask !== null && target.row !== null) askOnce({ row: target.row, key }, { run, ask });
      const row = target.place(run);
      if (row !== null) labelled.push(row);
      log(`ESCALATED ${ref} -> ${ESCALATION_LABEL} (cause offered ${MAX_DELIVERIES}+ times, still true)\n`);
    } catch (err: any) {
      log(`COULD NOT ESCALATE ${ref}: ${String(err?.message ?? err).split("\n")[0].slice(0, 90)}\n`);
      continue;
    }
    recordEscalation(key, ref, record, log);
  }
  return labelled;
}

/**
 * Where a stuck cause's escalation lands, or `null` when it cannot (#3086): the primary's row is LABELLED, and a declared code
 * repository's red is FILED as a row in the primary's tracker (see {@link stuckRowOf} for why a label cannot reach `ceo` there).
 * A keyed subject the project's declaration does not list is `null`: it is not the primary's and is not known to be anyone's.
 * `place` answers the row number it labelled or filed, or `null` when `gh` did not say.
 *
 * `row` is the primary's row number when the escalation is a LABEL on it, and `null` when it is a filed row (which carries its own body).
 * `title` is a filed row's title, the key {@link fileRepositoryRow} and {@link closeAnsweredRow} both find it by, and `null` for a label.
 */
function escalationTargetOf(key: string, { repoOf, boardOf }: { repoOf: (repoKey: string) => string | null; boardOf: () => Board | null; }): { ref: string; row: number | null; title: string | null; place: (run: (args: string[]) => string) => number | null; } | null {
  const subject = stuckSubjectOf(key);
  if (subject === null) return null;
  if (subject.repoKey === "") {
    const row = (subject.number as number);
    return { ref: `#${row}`, row, title: null, place: (run) => { rows().addLabelToRow({ number: row, label: ESCALATION_LABEL, run }); return row; } };
  }
  // A keyed EPIC is not a red: the row filed below says `main` is red, which it is not, and its label cannot be set from the primary's tracker.
  if (/\/epic-/.test(key)) return null;
  const repo = repoOf(subject.repoKey);
  if (repo === null) return null;
  const ref = subject.number === null ? `${subject.repoKey}@${subject.sha8}` : subjectMention({ repoKey: subject.repoKey, number: subject.number });
  return { ref, row: null, title: stuckRowWording({ ref, repo, key }).title, place: (run) => fileRepositoryRow({ ref, repo, key, board: boardOf() }, run) };
}

/** The cause kind a key carries: `<session>/<cause>/<subject>/...`, the segment `stuckSubjectOf` splits around. */
const causeKindOf = (key: string) => key.split("/")[1] ?? "";

/**
 * The title and body of the row filed for a stuck cause in another repository, worded for WHAT IS STUCK (a11ign/a11ign#4360): only a
 * `trunk-red` cause says `main` is red. A `pr-checks-failing` cause is a pull request that may be waiting on something, so the question
 * it asks is that, not whether trunk is red (`ceo` spent a read proving a lab `main` green for a title that said otherwise); any other
 * kind is worded by its own name. The title is the dedupe key, so each kind keeps its own.
 */
function stuckRowWording({ ref, repo, key }: { ref: string; repo: string; key: string; }): { title: string; body: string; } {
  const kind = causeKindOf(key);
  const offered = `A \`${kind}\` order for \`${repo}\` was offered ${MAX_DELIVERIES} times and is still true (\`${key}\`), so it is `
    + "escalated here, the one place `ceo` reads for a repository whose pull requests are not in this tracker (#3086).\n\n";
  const answer = `Removing \`${ESCALATION_LABEL}\` is the answer.\n`;
  if (kind === "trunk-red") {
    return {
      title: `Stuck trunk-red: ${ref} -- \`main\` of ${repo} is red and nothing has fixed it`,
      body: `${offered}Fix \`main\` of ${repo}, or say why it should stay red. ${answer}`,
    };
  }
  if (kind === "pr-checks-failing") {
    return {
      title: `Stuck pr-checks-failing: ${ref} -- a pull request of ${repo} is red and nothing has fixed it`,
      body: `${offered}The stuck thing is the pull request ${ref}, not \`main\` of ${repo}. The question is whether it is waiting on something `
        + `(another row, a native chain, a review), not whether trunk is red: read the pull request before touching trunk. ${answer}`,
    };
  }
  return {
    title: `Stuck ${kind}: ${ref} -- a \`${kind}\` cause for ${repo} is stuck and nothing has answered it`,
    body: `${offered}Say what the \`${kind}\` cause is waiting on, or clear it. ${answer}`,
  };
}

/** A Project board a row is put on: `gh project item-add <number> --owner <owner>`. */
type Board = { owner: string; number: number; };

/** The board of the tracker `gh issue create` files into (the primary's, #4727), or `null` when the declaration lists none for it. */
const primaryBoard = (): Board | null => homeProjectDeclaration().tracker.find((tracker) => tracker.repo === REPO)?.board ?? null;

/** The Status a filed stuck-cause row sits at: `parked` is decided-not-to-do-now, which the board reads as Backlog (`row-file`'s `boardingFor`). */
const FILED_STATUS = "Backlog";

/**
 * The labels a stuck-cause row is BORN with (#4727), in one `issue create` so no reader sees it between states: the wait (`answer:ceo`, which
 * removing is the answer), the one state label (`parked`: the org counts a row in exactly one state, #3942) and the release declaration
 * (`out-of-release`: the primary has no milestone for a row the tick files, and a row with neither is the state `board-data` forbids).
 */
const FILED_STUCK_ROW_LABELS = [ESCALATION_LABEL, PARKED_LABEL, OUT_OF_RELEASE_LABEL];

/**
 * Put a filed row on the board at {@link FILED_STATUS}: the add, then the Status, the order `row-file`'s `boardAndVerify` keeps (an item with no
 * Status is a card nobody can place). It throws, naming the row FIRST because `escalateStuck` cuts the line it logs at 90 characters, because a row
 * filed and left off the board is the defect this exists to end and the next tick's title dedupe will find it and write nothing: the failure is
 * read once, here, in the tick log.
 */
function boardFiledRow({ url, number }: { url: string; number: number; }, board: Board | null, run: (args: string[]) => string): void {
  if (board === null) throw new Error(`#${number} filed but OFF THE BOARD: no board declared`);
  try {
    rows().addRowToProject({ owner: board.owner, projectNumber: board.number, url, run });
    rows().setProjectStatus({ owner: board.owner, projectNumber: board.number, url, status: FILED_STATUS, run });
  } catch (err: any) {
    throw new Error(`#${number} filed but OFF THE BOARD: ${firstLine(err, 120)}`, { cause: err });
  }
}

/**
 * File the row `ceo` reads for a stuck cause in another repository, once: an OPEN `answer:ceo` issue already titled for `ref` is the
 * row (the ledger could not be written, or another tick got there first), so a second is not filed and nothing is written to it.
 *
 * THE ROW IS BORN IN A STATE (#4727): {@link FILED_STUCK_ROW_LABELS} in the create, and the board add as part of filing rather than a repair
 * after it. Born with only `answer:ceo` it had no state label, no declaration and no board item, so `row-off-board` and
 * `row-without-exactly-one-state` fired on it within 20 minutes (#4716) and cost `product-manager` two wakes.
 *
 * @returns the row's number, or `null` when `gh` printed none (so nothing could be boarded)
 */
function fileRepositoryRow({ ref, repo, key, board }: { ref: string; repo: string; key: string; board: Board | null; }, run: (args: string[]) => string): number | null {
  const { title, body } = stuckRowWording({ ref, repo, key });
  const open = readRowsByLabel({ label: ESCALATION_LABEL, state: "OPEN", select: "number title", run });
  const existing = open.find((row: { title: string; }) => row.title === title);
  if (existing !== undefined) return existing.number;
  const made = rows().fileRowWithLabels({ title, body, labels: FILED_STUCK_ROW_LABELS, run });
  const filed = /(\S+\/issues\/(\d+))\s*$/.exec(made);
  if (filed === null) return null;
  const number = Number(filed[2]);
  boardFiledRow({ url: filed[1], number }, board, run);
  return number;
}

/**
 * Close the row {@link fileRepositoryRow} filed once its `answer:ceo` is gone (#622). Removing the label is the answer, and the row asks
 * nothing after it: left open it is a `parked` row with no wait, which `board-truth-audit` names to `product-manager`. A label row has its
 * re-ask ({@link reaskCleared}); a filed row has no number here, so it is found as {@link fileRepositoryRow} finds it, by title, and
 * its mark is the same one, read the other way: filing looks among the open rows that CARRY the label, this among the `parked` ones that do not.
 *
 * LEFT ALONE: a row that still carries any `answer:` label (an `answer:<session>` swapped in for `answer:ceo` is a ruling re-routed, not
 * given), and a row that is no longer `parked` (someone moved it on, and closing it would discard work). The key stays escalated, so the cause
 * is quiet for {@link REASK_AFTER_MS}; after it {@link reaskFiledRow} reads the closed row and files one more, once (#656).
 *
 * `--limit 100` reads the open `parked` rows of the tracker (5 when this was written); a row past it is not found and stays open, as before.
 * FAILS LOUD and is retried next tick: a `gh` refusal is a `COULD NOT CLOSE` line, never a throw into the tick.
 *
 * @returns the rows it closed
 */
function closeAnsweredRow({ title, key }: { title: string; key: string; }, { run, log }: { run: (args: string[]) => string; log: (line: string) => void; }): number[] {
  const closed: number[] = [];
  try {
    const parked: { number: number; title: string; labels: { name: string; }[]; }[] = readRowsByLabel(
      { label: PARKED_LABEL, state: "OPEN", select: "number title labels(first:50){nodes{name}}", run })
      .map((row) => ({ number: row.number, title: row.title, labels: row.labels.nodes }));
    const filed = parked.filter((row) => row.title === title);
    if (filed.some((row) => row.labels.some((label) => label.name.startsWith(ANSWER_PREFIX)))) return closed;
    for (const row of filed) {
      rows().closeHomeRowWithComment({ number: row.number, comment: answeredComment(key), run });
      closed.push(row.number);
      log(`ANSWERED #${row.number} (${key}) -- ${ESCALATION_LABEL} was removed, so the row is closed\n`);
    }
  } catch (err: any) {
    log(`COULD NOT CLOSE ANSWERED ROW (${key}): ${String(err?.message ?? err).split("\n")[0].slice(0, 90)}\n`);
  }
  return closed;
}

/** #5074: how many of the NEWEST closed parked rows, and newest open rows, {@link rowsTitled} reads (two connection pages each). */
const TITLED_READ_NEWEST = 200;

/**
 * Every row of `title`, open or closed, WITHOUT a search (#5074: `--state all --search` was sent as a GitHub SEARCH, whose allowance the installation spent).
 * A filed stuck-cause row is born {@link PARKED_LABEL} and is closed still carrying it ({@link closeAnsweredRow}), so the closed rows are the newest
 * closed parked ones; an OPEN row of the title is any open parked one, or one of the newest open rows (it may have left `parked`). A title older than
 * both windows is not seen, which for the closed side means "not asked again" and for the open side a duplicate: the price of no search, said here.
 * A read that fails THROWS, so the caller reports it and never takes it for "no row".
 */
function rowsTitled(title: string, run: (args: string[]) => string): { number: number; title: string; state: string; closedAt: string | null; }[] {
  const closed = readRowsByLabel({ label: PARKED_LABEL, state: "CLOSED", select: "number title closedAt", newest: TITLED_READ_NEWEST, run });
  const parked = readRowsByLabel({ label: PARKED_LABEL, state: "OPEN", select: "number title", run });
  const newest: { number: number; title: string; }[] = JSON.parse(readUnlessRefused({ what: `the ${TITLED_READ_NEWEST} newest open rows`, run,
    read: () => JSON.stringify(rows().openRowsOf({ limit: TITLED_READ_NEWEST, fields: "number,title", run })) }));
  const open = new Map([...parked, ...newest].map((row) => [row.number, row]));
  return [...closed.map((row) => ({ ...row, state: "CLOSED" })), ...[...open.values()].map((row) => ({ ...row, state: "OPEN", closedAt: null }))]
    .filter((row) => row.title === title);
}

/**
 * File a filed stuck-cause row once more when the one that asked about the cause was closed an hour ago and the cause is still emitted (#656).
 * A label row is asked again by {@link reaskCleared}; a filed row's key stays in the ledger's `escalated` set, so without this a cause that was
 * still true after the close was silent until its causeKey changed.
 *
 * THE ONCE-RULE'S MEMORY IS THE CLOSED ROWS OF THE TITLE, read back, as the label row reads its marker comment, so the ledger is not touched:
 * exactly one closed row of the title is a cause asked once, two is a cause asked again, and a third is never filed. A row of the title
 * that is OPEN, in any state, is the question already on the board, so nothing is filed. One `--state all` search per tick for a key still
 * emitted; the title is the key, so the hits are filtered to an exact match (a search is a phrase, not an equality).
 *
 * FAILS LOUD and is retried next tick: a `gh` refusal is a `COULD NOT ASK AGAIN` line, never a throw into the tick.
 *
 * @returns the number of the row it filed, or `null` when it filed none
 */
function reaskFiledRow({ title, key, place }: { title: string; key: string; place: (run: (args: string[]) => string) => number | null; },
  { run, log, ask }: { run: (args: string[]) => string; log: (line: string) => void; ask: Asker; }): number | null {
  try {
    const titled = rowsTitled(title, run);
    if (titled.length !== 1 || titled[0].state !== "CLOSED") return null;
    const [closed] = titled;
    const elapsed = ask.now() - Date.parse(String(closed.closedAt));
    if (!(elapsed >= REASK_AFTER_MS)) return null;
    const row = place(run);
    log(`ASKED AGAIN ${row === null ? "(row not numbered)" : `#${row}`} -> ${ESCALATION_LABEL} (${key}: #${closed.number} closed ${Math.round(elapsed / 60_000)} minutes ago, cause still true)\n`);
    if (row !== null) ask.post(row, filedReaskComment({ key, closed: closed.number, elapsedMs: elapsed }));
    return row;
  } catch (err: any) {
    log(`COULD NOT ASK AGAIN (${key}): ${String(err?.message ?? err).split("\n")[0].slice(0, 90)}\n`);
    return null;
  }
}

/** The comment the once-more row carries: which row asked before, and that this is the last time the tick asks about this key. */
const filedReaskComment = ({ key, closed, elapsedMs }: { key: string; closed: number; elapsedMs: number; }) => `${reaskMarker(key)}\n**Asked once more.** `
  + `#${closed} asked about the cause \`${key}\` and was closed ${Math.round(elapsedMs / 60_000)} minutes ago; the cause is still true. `
  + `Removing \`${ESCALATION_LABEL}\` is the answer, and the tick does not file this cause a third time.\n`;

/** The comment a filed stuck-cause row is closed with: which cause it asked about, and what happens if that cause is still true. */
const answeredComment = (key: string) => `**Answered: \`${ESCALATION_LABEL}\` was removed, so the tick closes this row.** It asked about the cause \`${key}\`. `
  + "Removing the label is the answer, and a row that waits on nothing is not left open. If the cause is still true "
  + `${REASK_AFTER_MS / 60_000} minutes after this, the tick files the row once more; after that it stays quiet until its key changes.\n`;

/**
 * What the escalation needs from outside: write a comment, and read the session's state. Injected so a test reaches neither `gh` nor herdr.
 */
export type Asker = { post: (row: number, body: string) => void, stateOf: (session: string) => string, now: () => number };

/** How long a cleared cause that is still true waits before it is asked about once more (#3874). */
export const REASK_AFTER_MS = 60 * 60_000;

/** The session a cause key opens with; `engineers` is the pool and is no session. */
const sessionOfKey = (key: string) => key.split("/")[0];

/** The comment's marker for a cause's re-ask: its presence on the row is how "once" is read back, with no ledger line. */
const reaskMarker = (key: string) => `<!-- stuck-reask: ${key} -->`;

/** The first escalation's marker: with {@link commentAwaitsLabel}, how a retry after a failed label knows the question is already on the row. */
const escalationMarker = (key: string) => `<!-- stuck-escalation: ${key} -->`;

/**
 * The comment an escalation leaves on its row, so that whoever reads `answer:ceo` finds what is asked there (#3874).
 *  @param state the target session's state at this moment
 */
function escalationComment(key: string, state: string) {
  const session = sessionOfKey(key);
  return `${escalationMarker(key)}\n**Stuck: the tick is asking \`ceo\` about this row.** The cause \`${key}\` was delivered ${MAX_DELIVERIES} times and is still true, and `
    + `no session has acted on it. \`${session}\` is ${state} as this is written.\n\n`
    + `\`ceo\` can answer it: say what should happen to this cause, then remove \`${ESCALATION_LABEL}\`. If the cause is still true `
    + `${REASK_AFTER_MS / 60_000} minutes after that, the tick asks once more.\n`;
}

/**
 * The target session's state as herdr reports it, read the way {@link notReadyWhy} reads an agent, or why it could not be read. Never throws: the
 * state is context in a comment and its absence must not stop the escalation.
 */
export function sessionStateOf(session: string, run: (args: string[]) => string = defaultRun) {
  if (session === "engineers") return "a pool, not a session";
  try {
    return readAgent(run, session).status;
  } catch (err: any) {
    return `unreadable (${herdrReason(err)})`;
  }
}

/**
 * Write the escalation's question UNLESS it is already on the row, unanswered by a label (#3874, review of #328). The comment goes first so a label never stands
 * bare, which means a label that then FAILS leaves a comment and no ledger record, and the next tick retries: without this it posted the same question again
 * every tick the label kept failing. The row is the state, so the retry reads it: a marker comment newer than the label's last event is a question
 * that was written and not yet labelled, and only the label is owed.
 */
function askOnce({ row, key }: { row: number; key: string; }, { run, ask }: { run: (args: string[]) => string; ask: Asker; }) {
  const waiting = commentAwaitsLabel(rowComments(row, escalationMarker(key), run), lastLabelEvent(row, run));
  if (!waiting) ask.post(row, escalationComment(key, ask.stateOf(sessionOfKey(key))));
}

/**
 * Is there a marked comment written after the label's last event (or with no label event at all)? That is a question posted whose label never landed.
 */
const commentAwaitsLabel = (comments: { at: number; marked: boolean; }[], last: { at: number; } | null) => comments.some((c) => c.marked && (last === null || c.at > last.at));

/**
 * Ask once more about a cause whose `answer:ceo` was REMOVED and which is still true an hour later (#3874). Removal is an answer, so an
 * unchanged cause stays quiet for that hour; after it, the answer has not changed what the cause measures, and silence for good is the
 * defect (#3289: 30 `STUCK` lines, 31 `ALREADY ESCALATED`, nobody asked). The row is the state, so nothing here touches the ledger: the label's last
 * event says when it came off, and a comment carrying {@link reaskMarker} says it was already re-asked. Two reads, the second only once the
 * first says it is due. FAILS LOUD and is retried next tick. A comment that lands before a label that does not is retried as the LABEL alone
 * ({@link commentAwaitsLabel}: the marker is newer than the removal), never a second comment.
 *
 * @returns whether the cause was asked again
 */
function reaskCleared({ row, key }: { row: number; key: string; }, { run, log, ask }: { run: (args: string[]) => string; log: (line: string) => void; ask: Asker; }): boolean {
  try {
    const removed = labelRemoval(row, run);
    if (removed === null || ask.now() - removed.at < REASK_AFTER_MS) return false;
    const comments = rowComments(row, reaskMarker(key), run);
    const waiting = commentAwaitsLabel(comments, removed);
    if (!waiting && comments.some((c) => c.marked)) return false;
    const answer = comments.filter((c) => c.login === removed.by && c.at <= removed.at).pop();
    if (!waiting) ask.post(row, reaskComment({ key, removed, answer, elapsedMs: ask.now() - removed.at, state: ask.stateOf(sessionOfKey(key)) }));
    rows().addLabelToRow({ number: row, label: ESCALATION_LABEL, run });
    log(`ASKED AGAIN #${row} -> ${ESCALATION_LABEL} (${key}: label removed ${Math.round((ask.now() - removed.at) / 60_000)} minutes ago, cause still true)\n`);
    return true;
  } catch (err: any) {
    log(`COULD NOT ASK AGAIN #${row} (${key}): ${String(err?.message ?? err).split("\n")[0].slice(0, 90)}\n`);
    return false;
  }
}

/**
 * When the escalation label last came off the row and who took it off, or `null` when its last event is not a removal (it is on the row, or never was).
 */
function labelRemoval(row: number, run: (args: string[]) => string): { at: number; by: string; } | null {
  const last = lastLabelEvent(row, run);
  return last === null || last.event !== "unlabeled" ? null : { at: last.at, by: last.by };
}

/**
 * The escalation label's last event on the row, `null` when it never had one.
 */
function lastLabelEvent(row: number, run: (args: string[]) => string): { event: string; at: number; by: string; } | null {
  return rows().lastLabelEventOf({ number: row, label: ESCALATION_LABEL, run });
}

/**
 * Every comment on the row as `{ id, login, at, marked }`, `marked` being "carries `marker`".
 */
export function rowComments(row: number, marker: string, run: (args: string[]) => string): { id: number; login: string; at: number; marked: boolean; }[] {
  return rows().markedCommentsOf({ number: row, marker, run });
}

/**
 * The re-ask: elapsed time, who removed the label and the comment they most likely answered with (their last before the removal), by id.
 */
function reaskComment({ key, removed, answer, elapsedMs, state }: { key: string; removed: { at: number; by: string; }; answer?: { id: number; }; elapsedMs: number; state: string; }) {
  const earlier = answer === undefined ? `no comment of theirs came before it` : `their earlier answer is comment ${answer.id}`;
  return `${reaskMarker(key)}\n**Asked again: the cause is still true.** \`${ESCALATION_LABEL}\` was removed by @${removed.by} `
    + `${Math.round(elapsedMs / 60_000)} minutes ago (${new Date(removed.at).toISOString()}); ${earlier}. `
    + `The cause \`${key}\` was delivered ${MAX_DELIVERIES} times, no session has acted on it, and \`${sessionOfKey(key)}\` is ${state} now.\n\n`
    + "If that answer was meant for this, say what happens next and remove the label again; this is asked once.\n";
}

/**
 * Why the session a cause was addressed to cannot answer now, or `null`. A key opens with that session; `engineers` is
 * the pool and names none.
 */
function outageOf(key: string, unavailable: (label: string) => string | null): string | null {
  const session = key.split("/")[0];
  return session === "engineers" ? null : unavailable(session);
}

/**
 * Write down that `key` was escalated. A ledger that cannot be written (ENOSPC took the host's tools for three hours
 * on 2026-09-25) means the next tick labels again, so that is said rather than swallowed.
 */
function recordEscalation(key: string, ref: string, record: (key: string) => void, log: (line: string) => void) {
  try {
    record(key);
  } catch (err: any) {
    log(`COULD NOT RECORD the escalation of ${ref}, so the next tick labels it again: `
      + `${String(err?.message ?? err).split("\n")[0].slice(0, 90)}\n`);
  }
}

/**
 * #4630: THE SAME NEWEST TRANSCRIPT, READ FOR HOW MANY TURNS AND COMPACTIONS A SESSION HAS HAD ({@link transcriptCounts}); `null` when no transcript names it. A count a
 * transcript could not give is `null` inside the answer, never zero: the escalation treats a figure it could not read as one that has not reached its cap.
 */
export function instanceCounts(label: string, root: string = join(process.env.HOME ?? "", ".claude", "projects"), reader: { readText: (file: string) => string; readHead: (file: string) => string; } = TRANSCRIPT_READER): { turns: number | null; compactions: number | null; } | null {
  return newestTranscriptRead(label, root, reader, transcriptCounts);
}

const lastOrderFile = (dir: string, label: string) => join(dir, `last-order-${label.replaceAll(/[^\w.-]/g, "_")}`);

/**
 * @param dir where the per-seat records live (the ledger's directory)
 *
 * @param [stateDir] where `<label>.md` state files live; beside `dir`, as `state/`, unless a caller says otherwise (#4072)
 */
export function orderClockIn(dir: string, now: () => number = Date.now, stateDir: string = join(dirname(dir), "state")): OrderClock {
  return {
    now,
    stateFile: (label) => join(stateDir, `${label.replaceAll(/[^\w.-]/g, "_")}.md`),
    lastOrderAt(label) {
      try {
        const at = Number(readFileSync(lastOrderFile(dir, label), "utf8").trim());
        return Number.isFinite(at) && at > 0 ? at : null;
      } catch { return null; } // absent or unreadable is "cannot tell", never "long ago" and never "just now"
    },
    recordOrder(label) {
      try {
        mkdirSync(dir, { recursive: true });
        writeFileSync(lastOrderFile(dir, label), `${now()}\n`);
      } catch (err: any) {
        process.stderr.write(`the order to ${label} WAS delivered, but its time could not be recorded in ${dir} `
          + `(${String(err?.message ?? err).split("\n")[0].slice(0, 120)}), so the next order clears. Do not send it again.\n`);
      }
    },
  };
}

/**
 * {@link prepareContext} in the shape #2483 gave its callers, which the tests that pin that behaviour still read: `sent` is "cleared",
 * so a compacted or kept seat reads the same to every caller that only asks whether to send the first-contact preamble.
 */
export function clearBeforeOrder(run: (args: string[]) => string, label: string, sleep?: (ms: number) => void, contextRoot?: string, sessions: string | URL = SESSIONS_FILE, clock: OrderClock = NO_CLOCK): { sent: boolean; refusal: string | null; } {
  const { action, refusal } = prepareContext(run, label, { sleep, contextRoot, sessions, clock });
  return { sent: action === CONTEXT_ACTION.CLEARED, refusal };
}

/**
 * A run may name the 1-minute load instead of reading it, which is what lets a test drive the wake ENTRY (a subprocess) without being
 * refused by the load of the machine it runs on -- the seam `A11Y_MEMINFO_PATH` is for the memory hold. The host never sets it.
 */
export const HOST_LOAD_ENV = "A11Y_HOST_LOAD";

/** @returns what the tick reads of this host: the production seam `deliver` is handed (#3560). */
export function readHostLoad(env: Record<string, string | undefined> = process.env): HostLoad {
  const named = Number(env[HOST_LOAD_ENV]);
  return { load: env[HOST_LOAD_ENV] ? named : loadavg()[0], cores: availableParallelism() };
}

/**
 * Where the arm of each new per-row worker and every continuation are written: a file BESIDE the wake ledger, one JSON object per line. NOT A LINE IN
 * THE LEDGER ITSELF, because every reader of that file splits a line on tabs and reads the first field as a cause key, so a line of another shape would
 * be counted as a cause (`deliveryCounts`) and could be taken for a marker; the ledger's directory is still the one place a report looks.
 */
export const CLAIM_ORDERS_FILE = "claim-orders";

export function claimOrdersPath(ledgerPath: string) {
  return `${dirname(ledgerPath)}/${CLAIM_ORDERS_FILE}`;
}

/**
 * THE CLAIM-ORDERS RECORD, READ: how many gate orders each claim has been sent, and the way to write the next line. A line that does not parse is SKIPPED
 * WITH A WARNING, not dropped silently: a skipped continuation undercounts, which lets a claim take one more order than the cap, and the warning is how
 * that is seen. NUL bytes are PADDING, not content: a power loss or an fs crash can leave a run of them before an entry that was written whole (#1065), so
 * they are stripped before the line is parsed, and a line that is only padding is skipped without a warning. A missing file is an empty record; any other
 * read failure propagates.
 */
export function claimOrdersIn(path: string, { read = readFileSync, append = appendFileSync, warn = (line) => process.stderr.write(line) }: { read?: typeof readFileSync; append?: typeof appendFileSync; warn?: (line: string) => void; } = {}): ClaimOrders {
  const counts: Map<string, number> = new Map();
  let raw = "";
  try {
    raw = String(read(path, "utf8"));
  } catch (err: any) {
    if (err?.code !== "ENOENT") throw new Error(`cannot read ${path}`, { cause: err });
  }
  for (const line of raw.split("\n").filter(Boolean)) {
    const text = line.replaceAll("\0", "");
    if (text.trim() === "") continue;
    try {
      const entry = JSON.parse(text);
      if (entry.kind === "continuation") counts.set(entry.claim, (counts.get(entry.claim) ?? 0) + 1);
    } catch (err: any) {
      warn(`claim-orders: skipped an unreadable line in ${path} (${firstLine(err)}); its claim may be undercounted\n`);
    }
  }
  return { counts, append: (entry) => append(path, `${JSON.stringify(entry)}\n`) };
}

/**
 * The engineer roles `sessions.json` MARKS spare, in file order: the only roles this file ever ends a process
 * for. READ, NOT TYPED, for #2279's reason -- a second copy of the list drifts -- and a ROLE fact rather than
 * an instance one, so `_rolesNotProcesses` stands. THE ADDRESSES IT NAMES ONLY (#2403): a family is not in this
 * list, its members are found among the running processes ({@link spareInstances}).
 *
 * @param [path] the roster file; a parameter so a test can hand it a fixture
 */
export function spareRoles(path: string | URL = roleBriefPath("sessions.json").absolute): string[] {
  return spareEntries(path).addresses;
}

/**
 *
 * @returns the spare roles the file marks:
 *   the addresses it names, and the families it declares
 */
function spareEntries(path: string | URL): { addresses: string[]; families: { prefix: string; from: number; }[]; } {
  const { live } = (JSON.parse(readFileSync(path, "utf8")) as { live: { name: string, role: string, spare?: boolean, family?: { prefix: string, from: number } }[] });
  const spares = live.filter((s) => s.role === "engineer" && s.spare === true);
  return {
    addresses: spares.filter((s) => s.family === undefined).map((s) => s.name),
    families: spares.flatMap((s) => (s.family === undefined ? [] : [s.family])),
  };
}

/**
 * The spare instances that EXIST: the marked addresses that hold a process, and every process whose label is a
 * member of a marked family (#2403). What the teardown ends from -- a family has no list to walk, so the
 * agents are where its members are found.
 *
 *
 * @param [path] the roster file; a parameter so a test can hand it a fixture
 */
export function spareInstances(agents: { label: string; }[], path: string | URL = roleBriefPath("sessions.json").absolute): string[] {
  const { addresses, families } = spareEntries(path);
  const labels = agents.map((a) => a.label);
  return [...new Set([...addresses, ...labels.filter((l) => familyMember(l, families) !== null)])];
}

/**
 * Is this address a SPARE engineer role -- marked `spare` in the roster, by name or as a member of a marked family?
 * The one question the router's pool and `row-claim`'s second-row refusal both ask (#2407), answered from the FILE and
 * not from a process list, so it holds for an address that has no process yet. A standing engineer is not one.
 *
 *
 * @param [path] the roster file; a parameter so a test can hand it a fixture
 */
export function isSpareRole(label: string, path: string | URL = roleBriefPath("sessions.json").absolute): boolean {
  const { addresses, families } = spareEntries(path);
  return addresses.includes(label) || familyMember(label, families) !== null;
}

/**
 * How long a spawned instance may sit idle without ever holding a row before the cycle counts as FAILED.
 * Generous on purpose: the instance's first turn is reading the order, the row and its own worktree, and an
 * idle reading inside it is not yet a defect.
 */
export const SPARE_CLAIM_BOUND_MS = 30 * 60 * 1000;

/**
 * Whether a present spare instance is ended this tick, and if not, why not.
 *
 * `held` IS WHAT IS HELD NOW AND `instance.rows` IS WHAT WAS EVER HELD, and the rule needs both: "holds no open
 * row" is true of an instance that has not claimed yet, which is in its FIRST TURN, so it alone would end
 * every spare the moment it was spawned. The rule is "has held a row, holds none now, and is idle".
 *
 * `idle` OR `done`, the two states `WAKEABLE` already names: herdr says `done` for a finished turn nobody has
 * looked at yet, and a spare parked there would otherwise never end. `working` is mid-turn, `blocked` is stopped
 * on a question whose text is the only record of it (`blockedSessions`), and `unknown` is not known to be
 * anything -- none of the three is ended.
 *
 * `paneless` (agent-org#1413, #1519) is herdr saying the seat's PANE is gone: no turn can be running in it, and its
 * status will read `unknown` for ever, so it is never "between turns". Its rows are the only account left, and it
 * ends exactly as an idle spare does -- holds no open row, has held one, and every row it held is read CLOSED
 * (`rowsClosed`). A row GitHub could not read is not closed, so it keeps the seat listed.
 *
 * AN INSTANCE THAT NEVER CLAIMS IS ENDED TOO, and RECORDED AS A FAILURE rather than silently: it holds a role's
 * address and does nothing with it. The verdict says `failed`; the caller writes the line.
 */
export function spareDecision({ status, instance, held, now, claimBoundMs = SPARE_CLAIM_BOUND_MS, paneless = false, rowsClosed = false }: { status: string; instance: SpareInstance; held: number[]; now: number; claimBoundMs?: number; paneless?: boolean; rowsClosed?: boolean; }): { end: false; why: string; } | { end: true; failed?: string; } {
  if (paneless) {
    if (held.length > 0) return { end: false, why: `holds ${held.map((n) => `#${n}`).join(", ")}` };
    if (instance.rows.length === 0) return { end: false, why: "paneless, and it never held a row" };
    if (!rowsClosed) return { end: false, why: "paneless, and a row it held is not read CLOSED" };
    return { end: true };
  }
  if (!WAKEABLE.includes(status)) return { end: false, why: `${status}: not between turns` };
  if (held.length > 0) return { end: false, why: `holds ${held.map((n) => `#${n}`).join(", ")}` };
  if (instance.rows.length > 0) return { end: true };
  const waited = now - instance.spawnedAt;
  if (waited < claimBoundMs) return { end: false, why: "has not claimed a row yet (first turn)" };
  return { end: true, failed: `never claimed a row in ${Math.round(waited / 60_000)} minutes` };
}

export type SpareWorktree = { path: string, clean: boolean | "unknown", merge: "merged" | "not-merged" | "unknown" };

/**
 * Was this cycle CLEAN -- the one fact #1950's "20 consecutive clean spawn-and-teardown cycles" counts.
 *
 * PURE, and stricter than "it ended": every row the instance held is CLOSED (a row released or abandoned is a
 * cycle that left work behind), no open row still carries its `session:` label, and every worktree it made is
 * clean and merged, i.e. `worktrees:prune` may take it. Anything the reads could not establish is NOT clean --
 * a counter that rounds "could not tell" up to "clean" reaches 20 by not looking.
 *
 * NO WORKTREE FOUND IS CLEAN: nothing was left. It is the caller's job to look under the row's own name.
 */
export function cycleVerdict({ role, rows, held, worktrees }: { role: string; rows: { number: number; state: string; }[]; held: number[]; worktrees: SpareWorktree[]; }): { clean: boolean; why: string; } {
  const problems: string[] = [];
  // #2407: ONE INSTANCE, ONE ROW. An instance that ended holding more than one is a failed cycle, so a leak is a line
  // that resets the run (and lifts the drain) instead of a count that quietly carries on.
  if (rows.length > 1) problems.push(`held ${rows.length} rows (${rows.map((r) => `#${r.number}`).join(", ")}): one instance, one row (#2407)`);
  for (const row of rows) {
    if (row.state !== "CLOSED") problems.push(`#${row.number} is ${row.state.toLowerCase()}, not closed`);
  }
  if (held.length > 0) problems.push(`${SESSION_PREFIX}${role} still labels ${held.map((n) => `#${n}`).join(", ")}`);
  for (const tree of worktrees) {
    if (tree.clean === "unknown" || tree.merge === "unknown") problems.push(`${tree.path} could not be read`);
    else if (tree.clean === false) problems.push(`${tree.path} has uncommitted changes`);
    else if (tree.merge !== "merged") problems.push(`${tree.path} is not merged into origin/main`);
  }
  if (problems.length > 0) return { clean: false, why: problems.join("; ") };
  const rowsSaid = rows.map((r) => `#${r.number}`).join(", ") || "no row";
  return { clean: true,
    why: `${rowsSaid} closed; no open row carries session:${role}; ${worktrees.length > 0
      ? "worktree clean and merged" : "no worktree left"}` };
}

/**
 * Every cause delivery on the ledger, oldest first, as `{ at, key, session }` -- with a VOIDED delivery taken back. The session is the
 * RECORDED RECIPIENT when there is one (a pool order's key names `engineers`), else the key's first segment: the addressee the delivery
 * went to, which is who a restart may have killed it for.
 */
export function readLedgerDeliveries(path: string, read: typeof readFileSync = readFileSync): { at: number; key: string; session: string; }[] {
  const raw = readTextOrNull(path, read);
  if (raw === null) return [];
  const kept: { at: number; key: string; session: string; }[] = [];
  for (const line of raw.split("\n")) {
    const fields = line.trim().split("\t");
    const at = Number(fields[0]);
    const key = fields.length < 2 ? "" : ledgerKeyOf(fields.slice(1).join("\t"));
    if (!Number.isFinite(at) || !key) continue;
    if (key.startsWith(`${VOIDED}\t`)) removeVoided(kept, key.slice(VOIDED.length + 1), Number(fields[3]));
    else if (!key.startsWith(`${RESET}\t`) && !key.startsWith(`${ESCALATED}\t`)) {
      const recipient = fields[2] !== undefined && fields[2] !== "" && fields[2] !== NO_CLEAR_FIELD ? fields[2] : null;
      kept.push({ at, key, session: recipient ?? key.split("/")[0] });
    }
  }
  return kept;
}

/** Take the VOIDED delivery (matched by key and time) out of a delivery list. */
function removeVoided(kept: { at: number; key: string; }[], key: string, at: number) {
  const index = kept.map((d) => d.key === key && d.at === at).lastIndexOf(true);
  if (index !== -1) kept.splice(index, 1);
}

/** A file's text, `null` when it does not exist -- and a THROW for any other failure: an unreadable file is not an empty one. */
export function readTextOrNull(path: string, read: typeof readFileSync) {
  try {
    return String(read(path, "utf8"));
  } catch (err) {
    if ((err as any)?.code === "ENOENT") return null;
    throw err;
  }
}
