// @ts-check
// module: the planner's brief for a stand-off round (A11-290)
import type { PullRequest } from "./queue/queue-entries-and-outcomes.ts";
import type { Ticket } from "./source.ts";
import type { TicketRead } from "./ticket-read.ts";
import { connectorsText, MISSING_SKILL, quoted, STALLING_COMMANDS } from "./brief-common.ts";
import { PLANNER_TICKET_DECISIONS } from "./brief-decisions.ts";
import { readLine } from "./brief-ticket-text.ts";
import { ESCALATION_RULE } from "./escalation.ts";
import { outcomeExamples } from "./outcome.ts";
import { STANDOFF_DECISION_FILE } from "./standoff-files.ts";
import { OUTCOME_FILE } from "./worker-files.ts";

/**
 * The planner's round for a STAND-OFF (A11-290), as markdown. A re-review stayed not convinced at an unchanged head, and the worker's reply disputes a decision of the plan or the ticket (or says the plan cannot be met). Only the planner can
 * change a decision of the plan, so the round starts as the planner, with the review, the reply and the re-review (`feedback`), and DECIDES: it amends the decision in the plan and records it under "Decisions made without a person", after which the reviewer
 * re-reviews bound by the amendment, or it upholds the decision, after which the worker acts on the reviewer's reasons. The ticket's own Decisions are a person's: the planner neither amends nor overrides one, and a decision of the ticket that cannot be met is the `contradicts` item.
 */
export function standoffPlanBriefText({ ticket, folder, ticketDir, planDir, pathsDir, planNames, prs, feedback, notes, connectors = [], read }: {
  ticket: Ticket; folder: string; ticketDir: string; planDir: string; pathsDir: string; planNames: readonly string[]; prs: readonly PullRequest[]; feedback: string;
  notes?: string; connectors?: readonly string[]; read?: TicketRead;
}): string {
  const list = prs.map(({ url }) => `- ${url}`).join("\n");
  const plan = planNames.length === 0 ? `The board found no plan file in \`${pathsDir}\`: read the plan on the ticket (${ticket.url}).` : `The plan's files, as the board last downloaded them, are in \`${pathsDir}\`: ${planNames.map((name) => `\`${name}\``).join(", ")}.`;
  return `# ${ticket.key}: stand-off round (planner) for ${ticket.title}

A reviewer and a worker still disagree after one exchange, and the worker's reply disputes a decision. You are the planner of this ticket: only you can change a decision of the plan. You are unattended: nobody will answer a question, so decide, write your decision, and end by writing the outcome file below. You change no code and open no pull request.

## The ticket

${ticket.url}

${readLine(read)}${quoted(ticket.description)}

## The pull requests

${list}

## The stand-off

${feedback}

## The plan

${plan}

## What to do

1. Read the review, the reply and the re-review above, the plan, the ticket's Decisions, the code the pull requests change (it is in the worktrees under \`${folder}\`), and the ADRs. Decide whether the decision the reply disputes should stand. Where you would have recommended an option, take it.
2. **Uphold** the decision when the reviewer is right that it stands, or the worker's evidence does not show it cannot be met. Change no plan file. The worker will act on the reviewer's reasons.
3. **Amend** the decision when it cannot be met or the worker's evidence shows it is wrong. Copy the plan's files from \`${pathsDir}\` into \`${planDir}\`, change the decision's own line, and add a bullet for the change under \`## Decisions made without a person\` that starts \`Technical:\` or \`Product:\` and gives its reason. Change nothing else in the plan. The board attaches the amended plan to the ticket, and the reviewer re-reviews the pull request bound by it.
4. A decision under the ticket's own \`## Decisions\` is a person's: you neither amend it nor override it. If the worker is right that such a decision cannot be met, stop with a \`needs-human\` outcome that names the \`contradicts\` item.
5. Write \`${ticketDir}/${STANDOFF_DECISION_FILE}\`: \`{ "decision": "amended" | "upheld", "reason": "<one or two sentences>" }\`. The reason is shown to the worker and to the person if the stand-off reaches one.

${ESCALATION_RULE}

${PLANNER_TICKET_DECISIONS}

${MISSING_SKILL}

${STALLING_COMMANDS}
${connectorsText(connectors)}${notes?.trim() ? `\n## On this machine\n\n${notes.trim()}\n` : ""}
## The outcome file

Write \`${ticketDir}/${OUTCOME_FILE}\` as the last thing you do, after \`${STANDOFF_DECISION_FILE}\`, with exactly one of:

\`\`\`json
${outcomeExamples(["reviewed", "needs-human"])}
\`\`\`

Write \`reviewed\` when you have written your decision; the Stop hook refuses it until \`${STANDOFF_DECISION_FILE}\` is there and says amended or upheld. A person may answer you here after a \`needs-human\` outcome. If one does, carry on with what they said, and write the outcome file again as the last thing you do.
`;
}
