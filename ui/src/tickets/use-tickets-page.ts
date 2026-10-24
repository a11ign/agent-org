import { useState } from "react";
import { clearedRow } from "../../../src/ticket-mode/label-filters.ts";
import { inProject, planChoiceOf, prioritiesOf, type PlanChoice } from "../../../src/ticket-mode/board-view/view-types-and-filters.ts";
import { showsOwner } from "../../../src/ticket-mode/assignee-filter.ts";
import type { TicketView } from "../api/types.ts";
import { useShell } from "../shell/ShellProvider.tsx";
import type { SegmentSource } from "./tickets-model.ts";
import {
  ALL_ITEM, groupOfMenu, labelMenus, planMenu, planPatternOf, priorityMenu, sectionsOf, shownTickets, type Filters, type Menu, type Section,
} from "./tickets-model.ts";
import { LABELS_MEMORY, PLAN_MEMORY, PRIORITIES_MEMORY, useRemembered } from "./use-remembered.ts";

/** The filters the person has chosen, remembered under `ui.html`'s own names, and the menus that choose them. */
export type FilterState = Readonly<{
  filters: Filters;
  setSearch: (search: string) => void;
  menus: (projectTickets: readonly TicketView[], universe: readonly TicketView[], pattern: RegExp | null) => Menu[];
  choose: (menu: Menu, itemId: string) => void;
}>;

/** The search, and the Priority, Plan and label choices; `goal` is the sidebar's. */
export function useFilters(goal: string): FilterState {
  const [search, setSearch] = useState("");
  const priorities = useRemembered(PRIORITIES_MEMORY);
  const plan = useRemembered(PLAN_MEMORY);
  const labels = useRemembered(LABELS_MEMORY);
  const planChoice: PlanChoice | null = planChoiceOf(plan.values);
  const filters: Filters = { search, priorities: prioritiesOf(priorities.values), plan: planChoice, labels: labels.values, goal };
  const menus = (projectTickets: readonly TicketView[], universe: readonly TicketView[], pattern: RegExp | null): Menu[] => [
    priorityMenu(projectTickets, filters.priorities), planMenu(projectTickets, pattern, planChoice), ...labelMenus(projectTickets, universe, labels.values),
  ].filter((menu): menu is Menu => menu !== null);
  const choose = (menu: Menu, itemId: string) => {
    const group = groupOfMenu(menu.id);
    if (group !== undefined) {
      if (itemId === ALL_ITEM) labels.replace(clearedRow(labels.values, group));
      else labels.toggle(itemId);
    }
    else if (menu.id === "plan") plan.replace(new Set(itemId === ALL_ITEM ? [] : [itemId]));
    else if (itemId === ALL_ITEM) priorities.replace(new Set());
    else priorities.toggle(itemId);
  };
  return { filters, setSearch, menus, choose };
}

/** The list the page draws: the sections the filters leave, and what the Assignee group and the count are made from. */
export type ListView = Readonly<{ sections: readonly Section[]; source: SegmentSource | null; showsOwner: boolean; menus: readonly Menu[] }>;

/** Works the list out from what the shell has read and the filters chosen. */
export function useList(state: FilterState): ListView {
  const shell = useShell();
  const { config, allTickets, projectTickets, scope, project } = shell;
  const inScope = shell.tickets.data ?? [];
  const kept = shownTickets(projectTickets, inScope, state.filters, planPatternOf(config));
  const projectOfAll = project === null ? allTickets : inProject(allTickets, project);
  const source: SegmentSource | null = config === null ? null : { ofProject: projectOfAll, all: allTickets, scope, config, held: shell.held, scopesRead: shell.scopesRead };
  return {
    sections: sectionsOf(projectTickets, kept, shell.contextParents), source,
    showsOwner: config?.viewer !== undefined && showsOwner(scope), menus: state.menus(projectTickets, inScope, planPatternOf(config)),
  };
}
