// @ts-check
// module: the GitHub Issues plugin's state moves -- a ticket moved through the workflow by its `state:` label and its open or closed state (A11-447)
//
// A MOVE TO AN OPEN STATE takes the issue's other state labels off and puts the new one on (Backlog has none), and reopens a closed issue. A MOVE TO A CLOSED STATE closes the issue with the
// `state_reason` the state means, and leaves its labels, so reopening it later puts it back in the state it was in.
import type { StateMove } from "../../src/plugins/contracts/tracker.ts";
import { callGitHub } from "./client.ts";
import { type IssueJson, type Repository, fetchIssue, labelNames, repoPath } from "./issues.ts";
import { isOpenState, isStateLabel, labelOfState, stateNamed, stateOf, type WorkflowState } from "./mapping.ts";

/** The `state_reason` GitHub closes an issue with for each closed state. */
const CLOSE_REASONS: Readonly<Record<string, string>> = Object.freeze({ completed: "completed", canceled: "not_planned", duplicate: "duplicate" });

/** The state types a plan moves a ticket on from: new work only. */
export const BEFORE_PLANNING: ReadonlySet<string> = new Set(["backlog"]);
/** The state types a worker starting moves a ticket on from: any work not yet started, a planned ticket included. */
export const BEFORE_WORK: ReadonlySet<string> = new Set(["backlog", "unstarted"]);

/** The workflow state an issue is in. */
export const currentState = (issue: IssueJson): WorkflowState => stateOf(issue, labelNames(issue));

/** Puts `issue` in `target`: its labels for an open state, its open or closed state for every one. */
export async function writeState(at: Repository, issue: IssueJson, target: WorkflowState): Promise<void> {
  const path = `${repoPath(at)}/issues/${issue.number}`;
  if (!isOpenState(target)) {
    await callGitHub(at.client, "PATCH", path, { state: "closed", state_reason: CLOSE_REASONS[target.type] });
    return;
  }
  for (const label of labelNames(issue).filter(isStateLabel)) await callGitHub(at.client, "DELETE", `${path}/labels/${encodeURIComponent(label)}`);
  const label = labelOfState(target);
  if (label !== null) await callGitHub(at.client, "POST", `${path}/labels`, { labels: [label] });
  if (issue.state !== "open") await callGitHub(at.client, "PATCH", path, { state: "open" });
}

/** The issue a key names, or a thrown refusal naming the key: a write to a ticket the repository has none of is an error. */
export async function fetchIssueOrThrow(at: Repository, number: number | null, key: string): Promise<IssueJson> {
  const issue = number === null ? null : await fetchIssue(at, number);
  if (issue === null) throw new Error(`GitHub Issues: ${at.owner}/${at.repo} has no issue for ${key}`);
  return issue;
}

/** What a state name the workflow lacks is said as: the ticket keeps its state. */
const unknownState = (name: string): string => `the GitHub Issues workflow has no state named ${JSON.stringify(name)}, so the ticket keeps its state`;

/**
 * Moves the issue to the state named `name` when its state's type is one of `from`, and answers the move made, or null, with a note when the name is not a state of the workflow.
 */
export async function moveIssueFrom(at: Repository, issue: IssueJson, name: string, from: ReadonlySet<string>): Promise<{ moved: StateMove | null; note: string | null }> {
  const target = stateNamed(name);
  if (target === undefined) return { moved: null, note: unknownState(name) };
  const current = currentState(issue);
  if (!from.has(current.type) || current.name === target.name) return { moved: null, note: null };
  await writeState(at, issue, target);
  return { moved: { from: current.name, to: target.name }, note: null };
}

/** Puts the issue back in `move.from` while it is still in `move.to`, and answers a note when the workflow has no state `move.from`. */
export async function restoreIssueState(at: Repository, issue: IssueJson, move: StateMove): Promise<string | null> {
  const back = stateNamed(move.from);
  if (back === undefined) return unknownState(move.from);
  if (currentState(issue).name === move.to) await writeState(at, issue, back);
  return null;
}
