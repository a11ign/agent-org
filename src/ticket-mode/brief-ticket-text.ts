// @ts-check
// module: the parts of a brief that say which text of the ticket it carries, what changed in it, and what its blockers' merged pull requests found (A11-167)
//
// PURE TEXT, apart from `worker-files.ts` so that module keeps to the public API a module may have. `worker-files.ts` lays these sections into the briefs; the pool names the folders below.
import { diffLines } from "./board-view/ticket-change.ts";
import { FINDINGS_HEADING } from "./plan-stamp.ts";
import type { TicketRead } from "./ticket-read.ts";

/** The folder of a ticket's folder that holds the plan a re-plan replaces, as the board copied it before it detached it (A11-167). */
export const PREVIOUS_PLAN_DIR = "previous-plan";
/** The folder of a ticket's folder that holds what its blockers' merged pull requests found (A11-167). */
export const BLOCKERS_DIR = "blockers";

/** One merged pull request of a blocker, and the file that holds what it found (A11-167): the planner of a dependent, and its worker, are told to read it. */
export type Finding = Readonly<{ key: string; number: number; url: string; title: string; file: string }>;

/** Why a planning run plans a ticket again (A11-167): the plan files the board copied, what changed in the description, and whether a blocker's findings reached it after the plan was written. */
export type Replan = Readonly<{ files: readonly string[]; change?: Readonly<{ from: string; to: string }>; findings: boolean }>;

/** The sentence that tells a reader which text of the ticket a brief carries: when the board read it, and when the tracker last changed it (A11-167). */
export function readLine(read: TicketRead | undefined): string {
  if (read === undefined) return "";
  const updated = read.updatedAt === null ? "the tracker does not say when the ticket was last updated" : `the ticket was last updated ${read.updatedAt}`;
  return `Read from the tracker at ${new Date(read.readAt).toISOString()}; ${updated}.\n\n`;
}

/**
 * The lines that differ between two descriptions, as a fenced `diff` block: removed lines with `-`, added with `+`, and two lines of what stays around each change, with `...` where more stays. A
 * change in the ticket is read from it, without comparing two long texts by eye (A11-167). PURE.
 */
export function diffText(from: string, to: string): string {
  const lines = diffLines(from, to);
  const near = (index: number): boolean => lines.slice(Math.max(0, index - 2), index + 3).some(({ kind }) => kind !== "same");
  const shown: string[] = [];
  let gap = false;
  lines.forEach(({ kind, text }, index) => {
    if (kind === "same" && !near(index)) {
      gap = true;
      return;
    }
    if (gap) shown.push("...");
    gap = false;
    shown.push(`${kind === "removed" ? "-" : kind === "added" ? "+" : " "} ${text}`);
  });
  if (gap) shown.push("...");
  return `\`\`\`diff\n${shown.join("\n")}\n\`\`\``;
}

/** The section that names what a ticket's blockers' merged pull requests found, for the brief of a run that is planned or worked (A11-167). Nothing when there are none. */
export function findingsText(findings: readonly Finding[], audience: "planner" | "worker"): string {
  if (findings.length === 0) return "";
  const list = findings.map(({ key, number, url, title, file }) => `- \`${file}\`: ${key}, ${url} (#${number}, "${title}")`).join("\n");
  const rule = audience === "planner"
    ? `The plan must carry a \`${FINDINGS_HEADING}\` section, before \`## Paths\`, with one bullet for each pull request above. Name each by its address, as written above, and say how each finding applies to this ticket or why it does not. A plan without that section, or one that leaves a pull request out, is refused.`
    : "Read each file before you start: what a blocker found may change how this ticket is worked. The plan, when there is one, says how each finding applies.";
  return `
## What its blockers found

A pull request of each of these blockers merged. Each file holds the pull request's title and body, and the markdown sections it added to the repository, such as a write-up's new section:

${list}

${rule}
`;
}

/**
 * The section of a re-plan planning brief: the plan the board detached, copied into files the planner reads, what changed in the ticket's description, and that the new text above is the one to plan
 * from (A11-167). Nothing for a first plan.
 */
export function replanText(replan: Replan | undefined): string {
  if (replan === undefined) return "";
  const files = replan.files.length === 0 ? "" : `\nThe plan it replaces is copied here:\n\n${replan.files.map((path) => `- \`${path}\``).join("\n")}\n`;
  const change = replan.change === undefined ? "" : `\nThe ticket's description changed after that plan was written. These lines differ:\n\n${diffText(replan.change.from, replan.change.to)}\n`;
  const findings = replan.findings ? `\nA pull request of a blocker merged after that plan was written: see "What its blockers found" below.\n` : "";
  return `
## This is a re-plan

An earlier plan for this ticket was attached, and the board has detached it so that you can write a new one.${files}${change}${findings}
Plan from the ticket's text above, which is the latest. Keep what still holds from the earlier plan, change what the new text changes, and say in the plan what you changed and why. The board writes a \`## Planned against\` section into your plan before \`## Paths\`: do not write one.
`;
}
