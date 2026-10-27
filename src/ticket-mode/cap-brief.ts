// @ts-check
// module: the planner's brief for the round at the board's round cap (A11-343)
import type { PullRequest } from "./queue/queue-entries-and-outcomes.ts";
import type { Ticket } from "./source.ts";
import type { TicketRead } from "./ticket-read.ts";
import { connectorsText, MISSING_SKILL, quoted, STALLING_COMMANDS } from "./brief-common.ts";
import { PLANNER_TICKET_DECISIONS } from "./brief-decisions.ts";
import { readLine } from "./brief-ticket-text.ts";
import { CAP_DECISION_FILE } from "./cap-files.ts";
import { MAX_CAP_PLANS } from "./queue/queue-cap.ts";
import { ESCALATION_RULE } from "./escalation.ts";
import { outcomeExamples } from "./outcome.ts";
import { OUTCOME_FILE } from "./worker-files.ts";

/** What the planner reads of the run's rounds and its open blockers, as the board holds them. */
export type CapFacts = Readonly<{ rounds: readonly string[]; blockers: readonly string[]; asked: number }>;

/**
 * The planner's round for a run that used up the board's own rounds (A11-343), as markdown. The cap is not on the escalation list, so the run does not go to a person: it comes to the planner, who reads the rounds, the ticket's Decisions and the open blockers
 * and DECIDES. It records a Decision, after which the board starts one more round of the worker with it (`round`); it marks the run as waiting on a named ticket, which reads Waiting on the board and starts a round when that ticket's pull request merges (`waiting`);
 * or it escalates with a `needs-human` outcome, only when the reason is an item of the escalation list. The ticket's own Decisions are a person's: the planner neither amends nor overrides one.
 */
export function capPlanBriefText({ ticket, folder, ticketDir, planDir, pathsDir, planNames, prs, feedback, facts, notes, connectors = [], read }: {
  ticket: Ticket; folder: string; ticketDir: string; planDir: string; pathsDir: string; planNames: readonly string[]; prs: readonly PullRequest[]; feedback: string; facts: CapFacts;
  notes?: string; connectors?: readonly string[]; read?: TicketRead;
}): string {
  const list = prs.map(({ url }) => `- ${url}`).join("\n");
  const plan = planNames.length === 0 ? `The board found no plan file in \`${pathsDir}\`: read the plan on the ticket (${ticket.url}).` : `The plan's files, as the board last downloaded them, are in \`${pathsDir}\`: ${planNames.map((name) => `\`${name}\``).join(", ")}.`;
  const rounds = facts.rounds.length === 0 ? "The board's log holds no earlier round." : facts.rounds.map((line) => `- ${line}`).join("\n");
  const blockers = facts.blockers.length === 0 ? "The ticket has no open blocker on the board." : facts.blockers.map((line) => `- ${line}`).join("\n");
  return `# ${ticket.key}: round-cap round (planner) for ${ticket.title}

The board answered this run's pull requests ${facts.rounds.length === 0 ? "several times" : `${facts.rounds.length} times`} on its own and used up its rounds. A round cap is not on the escalation list, so the run does not go to a person: it comes to you. You are the planner of this ticket. You are unattended: nobody will answer a question, so decide, write your decision, and end by writing the outcome file below. You change no code and open no pull request.

## The ticket

${ticket.url}

${readLine(read)}${quoted(ticket.description)}

## The pull requests

${list}

## The rounds so far

${rounds}

## The feedback that reached the cap

${feedback}

## The open blockers

${blockers}

## The plan

${plan}

## What to do

1. Read the rounds, the feedback above, the ticket's Decisions (before the plan), the open blockers, the plan, the code the pull requests change (it is in the worktrees under \`${folder}\`), and the ADRs. Decide what the next step is. Where you would have recommended an option, take it.
2. **Record a Decision and start one more round** (the board has asked you about this run ${facts.asked} time${facts.asked === 1 ? "" : "s"}; past ${MAX_CAP_PLANS} it refuses this answer, and the run is left to you as a failure) when the worker can answer the feedback, and the rounds so far lacked a decision to answer it by: write the Decision in words, and say why (it may be that the failing check is not this change's, or that the reviewer's request is already met). If the plan has a decision this changes, copy the plan's files from \`${pathsDir}\` into \`${planDir}\`, change the decision's line, and add a bullet under \`## Decisions made without a person\` that starts \`Technical:\` or \`Product:\` and gives its reason; the board attaches the amended plan. Write \`${ticketDir}/${CAP_DECISION_FILE}\`: \`{ "decision": "round", "reason": "<the Decision, in one or two sentences>" }\`. The board starts one more round of the worker, which carries your reason, and it counts toward no cap.
3. **Mark the run as waiting on a ticket** when the feedback cannot be answered until another ticket's pull request merges (a red check that ticket fixes, a change it makes that this one builds on). Name that ticket, and why. Write \`${ticketDir}/${CAP_DECISION_FILE}\`: \`{ "decision": "waiting", "ticket": "<KEY>", "reason": "<what it waits on and why>" }\`. The run reads "Waiting on <KEY>" on the board, not Needs you, and the board starts a round again when that ticket's pull request merges.
4. **Escalate** only when the reason is an item of the escalation list below. Do not write \`${CAP_DECISION_FILE}\`: stop with a \`needs-human\` outcome whose \`escalation\` names the item. A pull request that only keeps getting feedback is not one.
5. A decision under the ticket's own \`## Decisions\` is a person's: you neither amend it nor override it. If the feedback can be met only by contradicting one, that is the \`contradicts\` item.

${ESCALATION_RULE}

${PLANNER_TICKET_DECISIONS}

${MISSING_SKILL}

${STALLING_COMMANDS}
${connectorsText(connectors)}${notes?.trim() ? `\n## On this machine\n\n${notes.trim()}\n` : ""}
## The outcome file

Write \`${ticketDir}/${OUTCOME_FILE}\` as the last thing you do, after \`${CAP_DECISION_FILE}\`, with exactly one of:

\`\`\`json
${outcomeExamples(["reviewed", "needs-human"])}
\`\`\`

Write \`reviewed\` when you have written your decision; the Stop hook refuses it until \`${CAP_DECISION_FILE}\` is there and says round or waiting. A person may answer you here after a \`needs-human\` outcome. If one does, carry on with what they said, and write the outcome file again as the last thing you do.
`;
}
