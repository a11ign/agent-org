// #4630: A HAIKU START THAT IS NOT COPING STOPS BEING A HAIKU START. Routing more rows to Haiku (#4629) is only safe if the one that fails twice does not keep its worker; until now the
// stop rule was a switch `ceo` flips after reading the 72-hour report (`trace/haiku-tier-report.ts`), and decided nothing per row. This module is the per-row half: PURE and DETERMINISTIC,
// no provider and nothing to ask one (`via: none` in the decision log).
//
// THREE CAPS, EACH A NAMED CONSTANT:
//   ci failures  {@link ESCALATE_CI_FAILURES}: MEASURED as the DISTINCT pull request heads the worker was told were red (`pr-checks-failing`'s cause key ends in the head), so a reminder of
//                the same red is not a second failure. Counted from the claim-orders record, which records DELIVERIES (#4070).
//   compactions  {@link ESCALATE_COMPACTIONS}: the stop rule's 10, pinned equal to `MAX_COMPACTIONS` by the test (that file is a report with a CLI and a store reader, and not a thing a pure
//                module imports). The report trips ABOVE 10; this escalates AT 10, the row's words ("has used its compaction cap"), so the decision lands before the report's stop does.
//   turns        {@link ESCALATE_TURNS}: 300. MEASURED 2026-10-09 on the local trace store (1,182 `worker-<n>` sessions, billed turns of a session, subagents apart): median 118, p90 372, p95 512;
//                the 14 Haiku sessions of the #4382 trial peaked at 129 turns and 1 compaction. 300 is 2.3 times the Haiku peak and under the p90 of every worker. A cap is a number to tune from
//                the decision log's `escalate` lines, and no one has tuned it: it is the author's choice, said so.
//
// ABSENCE IS NOT PROOF: a figure that could not be read is `null`, and a `null` never escalates (the others still may). A worker whose model is not in the record (an `arm` line written before
// #4630) is not known to be Haiku, so it stays.
//
// ONCE PER ROW, AND A SONNET START IS NEVER ESCALATED: both are in {@link shouldEscalate} itself, not left to the caller, so the pure function is where the pin lives.
import { claudeTurns } from "./token-audit.ts";

export const ESCALATE_CI_FAILURES = 2;
export const ESCALATE_COMPACTIONS = 10;
export const ESCALATE_TURNS = 300;

/** What the gate calls a settled red on a pull request: the cause {@link claimFacts} counts, spelled out for the reason `claim-stall.ts`'s `CLAIM_STALLED` gives. */
export const CI_FAILING_CAUSE = "pr-checks-failing";
/** The kind of the line this module adds to the claim-orders record: what makes the escalation once per row, and survives a restart that died half way. */
export const ESCALATION_KIND = "escalation";
/** The decision log's `use` for an escalation, with `via: none`. */
export const ESCALATION_USE = "model-escalation";

export type Caps = { ciFailures: number; turns: number; compactions: number };
export const DEFAULT_CAPS: Caps = Object.freeze({ ciFailures: ESCALATE_CI_FAILURES, turns: ESCALATE_TURNS, compactions: ESCALATE_COMPACTIONS });

/** `model` is the id the worker was started with, or `null` when the record does not say; the three counts are `null` when they could not be read. */
export type Facts = { model: string | null; ciFailures: number | null; turns: number | null; compactions: number | null; escalated?: boolean };
export type Verdict = { action: "stay"; why: string } | { action: "escalate"; reason: string };

export const isHaiku = (model: string | null): boolean => model !== null && /haiku/i.test(model);

/** The first cap a count has reached, in the order a reader would want them: a red pull request, then thrash, then length. */
function capReached(facts: Facts, caps: Caps): string | null {
  const reached = (count: number | null, cap: number): count is number => count !== null && count >= cap;
  if (reached(facts.ciFailures, caps.ciFailures)) return `its pull request has failed CI ${facts.ciFailures} times (the cap is ${caps.ciFailures})`;
  if (reached(facts.compactions, caps.compactions)) return `it has compacted ${facts.compactions} times (the cap is ${caps.compactions})`;
  if (reached(facts.turns, caps.turns)) return `it has used ${facts.turns} turns (the cap is ${caps.turns})`;
  return null;
}

/**
 * STAY OR ESCALATE, PURE. A Haiku worker that has not been escalated before and has reached a cap escalates, with the reason in words; everything else stays, with the reason it stays.
 * A model that is not Haiku -- or not known -- never escalates, and neither does a row that already has.
 */
export function shouldEscalate(facts: Facts, caps: Caps = DEFAULT_CAPS): Verdict {
  if (facts.escalated === true) return { action: "stay", why: "this row was already escalated once" };
  if (!isHaiku(facts.model)) return { action: "stay", why: facts.model === null ? "the worker's model is not in the record" : `the worker is on ${facts.model}, not Haiku` };
  const reason = capReached(facts, caps);
  return reason === null ? { action: "stay", why: "no cap is reached" } : { action: "escalate", reason };
}

/**
 * THE LIVE SESSIONS WHOSE NEWEST START IS A HAIKU ONE, and the row each was started on: the candidates a tick reads. NEWEST `arm` LINE PER SESSION, NOT PER ROW -- a roster seat
 * is reused across rows, and a row's old arm line naming a seat that now holds another row would make that row's counts the other row's. `live` is the labels herdr lists.
 */
export function haikuStarts(recordText: string, live: readonly string[]): { session: string; row: number }[] {
  const newest = new Map<string, { row: number; model: string | null }>();
  for (const line of recordText.split("\n").filter(Boolean)) {
    try {
      const entry = JSON.parse(line);
      if (entry.kind === "arm" && typeof entry.session === "string" && Number.isInteger(entry.row)) {
        newest.set(entry.session, { row: entry.row, model: typeof entry.model === "string" ? entry.model : null });
      }
    } catch {
      continue;
    }
  }
  return [...newest].filter(([session, { model }]) => live.includes(session) && isHaiku(model)).map(([session, { row }]) => ({ session, row }));
}

/** What the claim-orders record says about one row's claim. */
export type ClaimRecord = { model: string | null; session: string | null; ciFailures: number; escalated: boolean };

/**
 * ONE ROW'S FACTS FROM THE CLAIM-ORDERS RECORD (`wake.ts`'s `CLAIM_ORDERS_FILE`, one JSON object per line). The NEWEST `arm` line of the row says which model and session started it; the DISTINCT
 * cause keys of its `pr-checks-failing` continuations SINCE THAT LINE are its CI failures; an `escalation` line is the once. A line that is not JSON is skipped: `claimOrdersIn` is the reader that warns about it.
 */
export function claimFacts(recordText: string, row: number): ClaimRecord {
  const failedHeads = new Set<string>();
  const found: ClaimRecord = { model: null, session: null, ciFailures: 0, escalated: false };
  for (const line of recordText.split("\n").filter(Boolean)) {
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.kind === "arm" && entry.row === row) {
      found.model = typeof entry.model === "string" ? entry.model : null;
      found.session = typeof entry.session === "string" ? entry.session : null;
      // A START IS A FRESH COUNT: reds a previous worker was told of are not this one's, and the cap is about THIS worker not coping.
      failedHeads.clear();
    }
    if (entry.kind === "continuation" && entry.claim === `row-${row}` && entry.cause === CI_FAILING_CAUSE && typeof entry.causeKey === "string") failedHeads.add(entry.causeKey);
    if (entry.kind === ESCALATION_KIND && entry.row === row) found.escalated = true;
  }
  return { ...found, ciFailures: failedHeads.size };
}

/**
 * A SESSION'S TURNS AND COMPACTIONS FROM ITS TRANSCRIPT TEXT: `claudeTurns` is the billed responses (deduplicated on the message id, as every other figure here is), and a compaction is a
 * record the harness marks `isCompactSummary`, which is how `wakes-per-row.ts` counts them. A transcript with a line that is not JSON counts nothing (`null`s): half a file is a lower
 * bound, and a lower bound must not look like a count.
 */
export function transcriptCounts(text: string): { turns: number | null; compactions: number | null } {
  let compactions = 0;
  for (const line of text.split("\n").filter((l) => l.trim() !== "")) {
    try {
      if (JSON.parse(line)?.isCompactSummary === true) compactions += 1;
    } catch {
      return { turns: null, compactions: null };
    }
  }
  return { turns: claudeTurns(text).length, compactions };
}

/** The sentence an escalated worker's brief and the row comment carry: who, why, and what is kept. */
export function escalationNote({ session, reason }: { session: string; reason: string }): string {
  return `THIS IS A RESTART ON SONNET (#4630). \`${session}\` started this row on Haiku and ${reason}, so it was ended and you replace it, on Sonnet at high effort. `
    + "Its claim, branch and worktree are unchanged and nothing was released: read the row and its pull request, then `git log origin/main..HEAD` and `git status`, and continue from what is there. "
    + "The row keeps its `tier:haiku` label (the reading of how often the tier fails needs it); you are not escalated again.";
}

/** The decision-log line: the same shape `decide` writes (`use`, `id`, `via`, `fellBack`, `reason`, `at`), with `via: none` because nothing was asked of a provider. */
export function escalationLogLine({ row, reason, at }: { row: number; reason: string; at: number }): Record<string, unknown> {
  return { use: ESCALATION_USE, id: `row-${row}`, via: "none", fellBack: false, outcome: "escalate", reason, at };
}
