// @ts-check
// module: a finished run follows its ticket's Decisions (A11-305) -- a decision a person adds while its pull requests are open starts a round that answers it

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { openPulls } from "./board-view/view-types-and-filters.ts";
import { asksForWork, decisionsChange } from "./decisions-change.ts";
import { DECISIONS_ROUND_FILE } from "./decisions-files.ts";
import { type PoolContext } from "./pool-context.ts";
import { update } from "./pool-state.ts";
import { clearDecisionsPending, decisionsRound } from "./queue/queue-decisions.ts";
import { SETTLED, type Entry } from "./queue/queue-entries-and-outcomes.ts";
import { type TicketRead } from "./ticket-read.ts";

/**
 * Whether the board follows the Decisions of a finished run: a pull request of its ticket is open, the tracker has not settled the ticket, it is no talk session, and the text it was briefed with is known, which is what a change is told from. A run that
 * ended before the board kept that text has nothing to compare, and the tracker is not asked about it. PURE.
 */
export const followsDecisions = (entry: Entry): boolean =>
  entry.phase === "finished" && entry.talk !== true && entry.briefedAgainst !== undefined && openPulls(entry).length > 0 && !SETTLED.has(entry.trackerState ?? "");

/**
 * Start the round a change of the Decisions asks for (A11-305). The run was briefed with a text of its ticket (`briefedAgainst`); when the ticket's Decisions now hold lines that text did not, the board queues a review round that answers them, with no one pressing
 * Respond. A run with no record of what it was briefed with has nothing to compare, and is left alone, and its rounds' briefs name no change either. A ticket whose Decisions read as the run was briefed with again loses the
 * mark of an unanswered change.
 */
export function followDecisionsOf(ctx: PoolContext, entry: Entry, read: TicketRead): void {
  if (entry.briefedAgainst === undefined || !followsDecisions(entry)) return;
  const change = decisionsChange(entry.briefedAgainst.description, read.description);
  if (asksForWork(change)) update(ctx, (queue) => decisionsRound(queue, entry.ticket.key, change.added, ctx.now()));
  else if (entry.decisionsPending !== undefined) update(ctx, (queue) => clearDecisionsPending(queue, entry.ticket.key));
}

/**
 * Leave beside a review round's outcome file the lines of the Decisions its brief opens with and the head each pull request has now, for the Stop hook to judge a `reviewed` by (A11-305, `decisions-files.ts`). A round whose brief names no change leaves
 * none (`clearRunDir` removed the last run's), and so does a change that only takes lines out. A pull request the code host cannot read is recorded with no head, and the hook then allows the stop out loud.
 */
export async function writeDecisionsMark(ctx: PoolContext, entry: Entry, dir: string, text: Readonly<{ briefed: TicketRead | undefined; read: TicketRead }>): Promise<void> {
  const { briefed, read } = text;
  const change = briefed === undefined ? null : decisionsChange(briefed.description, read.description);
  if (!asksForWork(change)) return;
  // The heads are compared with the pull requests later by the Stop hook: they are read afresh, not as the sweep read them (A11-365).
  const heads = Object.fromEntries(await Promise.all(openPulls(entry).map(async ({ url }) => [url, (await ctx.codeHost.readReviewState(url, { fresh: true }))?.head ?? null] as const)));
  writeFileSync(join(dir, DECISIONS_ROUND_FILE), `${JSON.stringify({ added: change.added, heads })}\n`);
}
