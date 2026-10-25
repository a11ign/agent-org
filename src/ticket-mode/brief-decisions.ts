// @ts-check
// module: what the briefs say of a ticket's Decisions (A11-250) -- the rules a worker, a talk session and a planner are given, kept in one place so the board's messages quote the same words

/**
 * What a worker does with the decisions a person gave (A11-250). A person's answer reaches a ticket only through the board, which writes it into the ticket's `## Decisions` section, so that section is what a run
 * and a reviewer both read. An answer given any other way (typed in a terminal, said in a comment) is not yet one, and a run that tells a pull request "the chairman decided" without the entry is refused by the reviewer.
 */
export const TICKET_DECISIONS = "Read the ticket's `## Decisions` sections before the plan. A decision there was made by a person, and it overrides the plan, its files and your own preference where they differ. What a person tells you in this run, in your terminal, you may act on in this run, but it binds no reviewer and no later run until the board has written it into the ticket: do not present it to a pull request as decided.";
export const RELAY_DECISION = "When you tell a pull request that a person decided something, link the ticket's Decisions entry that records it (the ticket URL and the entry's heading). Never write that a person decided something without that link: the reviewer refuses such a claim as unsupported.";

/**
 * What a planner does with a ticket that has a `## Decisions` section (A11-250): it reads them before the plan, states for each how the plan follows it in a `## Ticket decisions` section, and the plan check
 * (`plan-ticket-decisions.ts`) refuses a plan that writes a `Conflicts:` bullet or no such section. A re-plan changes every point where the earlier plan differed from a decision.
 */
export const PLANNER_TICKET_DECISIONS = `${TICKET_DECISIONS} A ticket that has a \`## Decisions\` section gets a plan with a \`## Ticket decisions\` section, with one bullet per decision in the ticket. Each bullet starts \`Follows:\` and says where the plan follows the decision. A plan that cannot follow a decision writes a \`Conflicts:\` bullet naming the decision and the plan line, and the board refuses that plan. In a re-plan, change every point where the earlier plan differed from a decision to follow the decision.`;
