// @ts-check
// module: how Linear's model maps onto GitHub Issues -- keys, states, priorities, label groups and branches, all PURE (A11-447)
//
// GITHUB ISSUES HAS NO WORKFLOW STATES, NO PRIORITY AND NO LABEL GROUPS, so this plugin keeps each of them in labels and in the issue's open or closed state (README.md, "How Linear's model maps"):
// - a STATE is a `state: <name>` label on an open issue, from the fixed workflow below; an open issue with none is in Backlog, and a closed one is Done, Canceled or Duplicate by its `state_reason`;
// - a PRIORITY is a `priority: <urgent|high|medium|low>` label, and none is priority 0;
// - a LABEL GROUP is the part of a label before `: `, so `Bucket: Bug` is the label `Bug` of the group `Bucket`, as a Linear parent label is. The state and priority labels are not shown as labels;
// - a KEY is `<prefix>-<number>`, such as `GH-12`: the shape every tracker key has, so a folder or a branch can be named by it.
import type { TicketLabel } from "../../src/plugins/contracts/tracker.ts";

/** One state of the workflow this plugin keeps: its name, its type as the board reads types (Linear's), and its place in the order. */
export type WorkflowState = Readonly<{ name: string; type: string; position: number }>;

/** The workflow, in order. Backlog is the open issue with no state label; the last three are the closed ones, told apart by GitHub's `state_reason`. */
export const WORKFLOW: readonly WorkflowState[] = Object.freeze([
  { name: "Backlog", type: "backlog", position: 0 },
  { name: "Todo", type: "unstarted", position: 1 },
  { name: "Planned", type: "unstarted", position: 2 },
  { name: "In Progress", type: "started", position: 3 },
  { name: "In Review", type: "started", position: 4 },
  { name: "Done", type: "completed", position: 5 },
  { name: "Canceled", type: "canceled", position: 6 },
  { name: "Duplicate", type: "duplicate", position: 7 },
].map((state) => Object.freeze(state)));

/** The open state an issue with no state label is in. */
export const UNLABELED_STATE = "Backlog";
const STATE_LABEL = /^state:\s*(.+)$/i;
const PRIORITY_LABEL = /^priority:\s*(.+)$/i;
const GROUPED_LABEL = /^([^:]+):\s+(.+)$/;
/** The number of each priority a `priority:` label may name, 1 being the most urgent, as Linear numbers them. */
const PRIORITY_NUMBERS: Readonly<Record<string, number>> = Object.freeze({ urgent: 1, high: 2, medium: 3, low: 4 });
/** The closed state each of GitHub's `state_reason` values means; any other reason, or none, is Done. */
const CLOSED_BY_REASON: Readonly<Record<string, string>> = Object.freeze({ not_planned: "Canceled", duplicate: "Duplicate" });

/** The workflow state named `name`, whatever its case, or undefined for a name the workflow lacks. */
export const stateNamed = (name: string): WorkflowState | undefined => WORKFLOW.find((state) => state.name.toLowerCase() === name.trim().toLowerCase());

/** Whether a state is one an open issue is in: every state before the closed ones. */
export const isOpenState = (state: WorkflowState): boolean => !["completed", "canceled", "duplicate"].includes(state.type);

/** The label that puts an open issue in `state`, or null for Backlog, which is the absence of one. */
export const labelOfState = (state: WorkflowState): string | null => (state.name === UNLABELED_STATE ? null : `state: ${state.name}`);

/** Whether a label is one this plugin keeps a state in. */
export const isStateLabel = (label: string): boolean => STATE_LABEL.test(label);

/**
 * The workflow state of an issue, from GitHub's `state` and `state_reason` and its labels' names. An open issue is in the latest state any of its state labels names, and in Backlog with
 * none it knows; a closed one is Canceled (`not_planned`), Duplicate (`duplicate`) or Done.
 */
export function stateOf(status: Readonly<{ state: string; state_reason: string | null }>, labels: readonly string[]): WorkflowState {
  const reason = status.state_reason;
  if (status.state !== "open") return stateNamed(CLOSED_BY_REASON[reason ?? ""] ?? "Done")!;
  const named = labels.flatMap((label) => {
    const state = stateNamed(STATE_LABEL.exec(label)?.[1] ?? "");
    return state !== undefined && isOpenState(state) ? [state] : [];
  });
  return named.reduce((latest, state) => (state.position > latest.position ? state : latest), stateNamed(UNLABELED_STATE)!);
}

/** The priority an issue's labels give it, the most urgent of its `priority:` labels, or 0 for none. */
export function priorityOf(labels: readonly string[]): number {
  const numbers = labels.flatMap((label) => {
    const number = PRIORITY_NUMBERS[(PRIORITY_LABEL.exec(label)?.[1] ?? "").trim().toLowerCase()];
    return number === undefined ? [] : [number];
  });
  return numbers.length === 0 ? 0 : Math.min(...numbers);
}

/** An issue's labels as the board shows them, each with its group: every label but the state and priority ones, which the plugin reads as the state and the priority. */
export function ticketLabelsOf(labels: readonly string[]): TicketLabel[] {
  return labels.filter((label) => !STATE_LABEL.test(label) && !PRIORITY_LABEL.test(label)).map((label) => {
    const grouped = GROUPED_LABEL.exec(label);
    return Object.freeze(grouped === null ? { name: label, group: null } : { name: grouped[2].trim(), group: grouped[1].trim() });
  });
}

/** The key of an issue: `<prefix>-<number>`. */
export const keyOf = (prefix: string, number: number): string => `${prefix}-${number}`;

/** The issue number a key names, or null for a string that is not `<prefix>-<number>` of this prefix, in any case. */
export function numberOf(prefix: string, key: string): number | null {
  const match = /^([A-Za-z][A-Za-z0-9]*)-(\d+)$/.exec(key.trim());
  return match === null || match[1].toUpperCase() !== prefix.toUpperCase() ? null : Number(match[2]);
}

/** The branch a ticket's pull request is made on: its key in lower case, which a title edit does not change. */
export const branchOf = (prefix: string, number: number): string => `${prefix.toLowerCase()}-${number}`;

/** The issue number at the end of an issue's API address (`.../issues/12`), as GitHub gives a parent's `parent_issue_url`, or null. */
export function numberInUrl(url: string | null | undefined): number | null {
  const match = /\/issues\/(\d+)$/.exec(url ?? "");
  return match === null ? null : Number(match[1]);
}
