// @ts-check
// module: what the Pick view says about the tickets it lists -- whose they are, and why the list is empty when it is
//
// AN EMPTY LIST NAMES ITS CAUSE AND ITS SETTING. The Pick view once read only the tickets assigned to the person whose Linear key the board
// uses, and 61 tickets moved in from GitHub, assigned to nobody, showed as "0 of 0" with no word on why (A11-69). A list that is empty now says
// what it asked for and which setting widens it, `tickets.pick`, so the person is not left to guess that the list is the key's and not the
// team's. PURE: the caller names the key's person.
import type { PickScope } from "./settings.ts";
import { PICK_SETTING } from "./assignee-filter.ts";

/** The team a ticket goes in when the form names no parent: the team `tickets.pick` lists, or null. */
export const pickTeamOf = (pick: PickScope): string | null => (typeof pick === "object" && "team" in pick ? pick.team : null);

/** Whether a created ticket is in the Pick view's list, so the board can say when it is not. The key's own tickets are, since they are assigned to it. */
export function inPickScope(pick: PickScope, ticket: Readonly<{ team: string | null; project: string | null }>): boolean {
  if (pick === "assigned") return true;
  if ("team" in pick) return ticket.team === pick.team;
  return ticket.project === pick.project;
}

/** What the Pick view's count line says the tickets are, after "<n> of <m>": "assigned to you", or which team or project they are open in. */
export function pickLabel(scope: PickScope): string {
  if (scope === "assigned") return "assigned to you";
  return "team" in scope ? `open in team ${scope.team}` : `open in project ${scope.project}`;
}

/**
 * What the Pick view says when the tracker answers no tickets: what was asked, by whom, and the setting that changes it. `user` is the name of
 * the person whose key the board reads with, or null when the source cannot say, which reads as "you".
 */
export function pickEmptyText(scope: PickScope, user: string | null): string {
  if (scope === "assigned") {
    return `No open tickets are assigned to ${user ?? "you"}, whose Linear key this board reads with. ${PICK_SETTING}`;
  }
  if ("team" in scope) {
    return `Team ${scope.team} has no open tickets, or Linear has no team with that key. tickets.pick in the host file names it: a team's key is the start of its tickets' keys, such as A11 in A11-69.`;
  }
  return `Project "${scope.project}" has no open tickets, or Linear has no project of that name. tickets.pick in the host file names it, spelled as Linear spells the project.`;
}
