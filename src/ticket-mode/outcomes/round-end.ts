// @ts-check
// module: what the end of a round records of a run (A11-430) -- the round added to each ticket's run, the tokens its Properties show, and the outcome record to append, or why none is
//
// A ROUND WHOSE TRANSCRIPT CANNOT BE READ WRITES NO RECORD: its tokens are unknown, and a record would say 0. The round is still added to the run, marked `unread`, so the next round counts only
// its own turns and the next record says this round's tokens are missing.

import type { Entry } from "../queue/queue-entries-and-outcomes.ts";
import { pullsOf } from "../board-view/view-types-and-filters.ts";
import { type OutcomeRecord, outcomeRecordOf, type OutcomeRound, type OutcomeRun, type OutcomeSubject } from "./outcome-record.ts";
import { batchShare, inputOutputOf, roundTokens, type TranscriptRead } from "./round-tokens.ts";

/** What the end of a round records for one ticket of the run: its run with the round added, the tokens its Properties show, and its outcome record, or why there is none. */
export type RoundEnd = Readonly<{ outcomeRun: OutcomeRun; tokens?: Readonly<{ input: number; output: number }> } & ({ record: OutcomeRecord } | { unread: string })>;

/** The repositories a run's work is in: those its worker made worktrees in, or else the one it was planned for. PURE. */
function reposOf(entry: Entry): readonly string[] {
  if (entry.repos.length > 0) return entry.repos;
  const planned = entry.plannedRepo ?? entry.projectRepo;
  return typeof planned === "string" ? [planned] : [];
}

/**
 * What `entry`'s run is known by apart from its rounds (A11-430): its ticket, model and effort, repositories, labels and pull requests, those the queue holds and `pulls`, the ones this round's
 * outcome names. PURE.
 */
export function outcomeSubjectOf(entry: Entry, pulls: readonly string[] = []): OutcomeSubject {
  const prs = [...new Set([...pullsOf(entry).map(({ url }) => url), ...pulls])];
  return { ticket: entry.ticket.key, model: entry.model, effort: entry.effort, repos: reposOf(entry), labels: (entry.ticket.labels ?? []).map(({ name }) => name), prs };
}

type RoundEndInput = Readonly<{
  /** The tickets of the run, in the batch's order: one for a run of one ticket. */
  members: readonly Entry[];
  /** The ticket the run is watched through, whose run says where this round's turns begin. */
  watched: Entry;
  /** The run's transcript, read once. */
  read: TranscriptRead;
  /** How the round ended for each ticket, by key: a batch's planner may plan one ticket and ask about another. */
  outcomeOf: (key: string) => string;
  /** The pull requests the round's outcome names, by address: none for a planning run. */
  pulls?: readonly string[];
  session?: string;
  now: number;
}>;

/**
 * What the end of this round records for each of `members`, by key (A11-430). The round's tokens are the turns its transcript holds since the run's previous round ended; a batch's are split
 * across its tickets by {@link batchShare}, so the shares add up to the run's. PURE.
 */
export function roundEndsOf({ members, watched, read, outcomeOf, pulls, session, now }: RoundEndInput): Map<string, RoundEnd> {
  const after = watched.outcomeRun?.rounds.at(-1)?.endedAt;
  const unread = "unreadable" in read ? read.unreadable : null;
  const spent = "turns" in read ? roundTokens(read.turns, after) : null;
  const batch = members.length > 1 ? watched.batch : undefined;
  return new Map(members.map((member, index) => {
    const before = member.outcomeRun;
    const previousEnd = before?.rounds.at(-1)?.endedAt;
    // A round's start is the run's latest start. A parked round a person answered keeps the start of the round before it, so its own start is unknown: it counts no time, rather than the person's wait.
    const startedAt = member.startedAt === undefined || (previousEnd !== undefined && member.startedAt < previousEnd) ? null : member.startedAt;
    const tokens = spent === null || batch === undefined ? spent : batchShare(spent, index, members.length);
    const round: OutcomeRound = { startedAt, endedAt: now, outcome: outcomeOf(member.ticket.key), ...(session === undefined ? {} : { session }), ...(unread === null ? {} : { unread }), ...(tokens === null ? {} : { tokens }) };
    const { batch: _earlier, ...carried } = before ?? {};
    const outcomeRun: OutcomeRun = { ...carried, since: before?.since ?? member.ciSince ?? member.startedAt ?? now, rounds: [...(before?.rounds ?? []), round],
      ...(batch === undefined ? {} : { batch: { id: batch, share: index + 1, of: members.length } }) };
    const record = outcomeRecordOf(outcomeSubjectOf(member, pulls), outcomeRun);
    const shown = outcomeRun.rounds.some((each) => each.tokens !== undefined) ? { tokens: inputOutputOf(record.tokens) } : {};
    const end: RoundEnd = unread === null ? { outcomeRun, ...shown, record } : { outcomeRun, ...shown, unread };
    return [member.ticket.key, end];
  }));
}
