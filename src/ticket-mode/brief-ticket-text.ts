// @ts-check
// module: the parts of a brief that say which text of the ticket it carries, what changed in it, and what its blockers' merged pull requests found (A11-167)
//
// PURE TEXT, apart from `worker-files.ts` so that module keeps to the public API a module may have. `worker-files.ts` lays these sections into the briefs; the pool names the folders below.
import { diffLines } from "./board-view/ticket-change.ts";
import { lineForm } from "./blocker-findings-check.ts";
import { FINDINGS_HEADING } from "./plan-stamp.ts";
import type { Blocker, PullState } from "./source.ts";
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

/** What a pull request of a blocker is listed as when the tracker gave no title and the board has not read its findings. */
const NO_TITLE = "title not given by the tracker";

/** One blocker as the planner's section lists it: its pull requests with their state and title, and for each the findings the board read, when it did. */
type Listed = Readonly<{ key: string; status: string; pulls: readonly Readonly<{ url: string; state: PullState; title: string; finding?: Finding }>[] }>;

/**
 * Every blocker in `blockers`, with every pull request of each. A merged pull request the board read the findings of carries them: only those are the check's list (`blocker-findings-check.ts`). A
 * pull request the board read that its blocker no longer links, such as a blocker taken off the ticket since, is listed under its ticket's key so the check's list is whole. PURE.
 */
function listed(blockers: readonly Blocker[], findings: readonly Finding[]): Listed[] {
  const byUrl = new Map(findings.map((finding) => [finding.url, finding]));
  const rows = blockers.map(({ key, status, pulls, titles }): Listed => ({ key, status,
    pulls: Object.entries(pulls).map(([url, state]) => ({ url, state, title: titles?.[url] ?? byUrl.get(url)?.title ?? NO_TITLE, ...(byUrl.has(url) ? { finding: byUrl.get(url)! } : {}) })) }));
  const shown = new Set(rows.flatMap(({ pulls }) => pulls.map(({ url }) => url)));
  const unlinked = findings.filter(({ url }) => !shown.has(url));
  return [...rows, ...unlinked.map((finding): Listed => ({ key: finding.key, status: "no longer linked by the tracker", pulls: [{ url: finding.url, state: "merged", title: finding.title, finding }] }))];
}

/** One pull request line of the planner's section: its state, title and address, and whether the plan needs a line for it. PURE. */
function pullLine({ url, state, title, finding }: Listed["pulls"][number]): string {
  const verdict = finding !== undefined ? `needs a line. What it found is in \`${finding.file}\`.`
    : state === "merged" ? "needs no line: the board has not read what it found yet." : "needs no line.";
  return `  - ${state}, "${title}", ${url}: ${verdict}`;
}

/**
 * The section of a planning brief that lists a ticket's blockers (A11-207, A11-167): every blocker with its status and every pull request of each, with its state, title and address, and for each
 * whether the plan needs a line for it. The ones that need a line are the check's own list, the merged pull requests whose findings the board read (`findings`); the section ends with the exact form
 * the check accepts. Nothing when the ticket has no blockers and no findings. PURE.
 */
export function findingsText(blockers: readonly Blocker[], findings: readonly Finding[]): string {
  const rows = listed(blockers, findings);
  if (rows.length === 0) return "";
  const list = rows.map(({ key, status, pulls }) => (pulls.length === 0 ? `- ${key}, ${status}: no pull request linked: needs no line.` : `- ${key}, ${status}:\n${pulls.map(pullLine).join("\n")}`)).join("\n");
  const rule = findings.length === 0
    ? `No pull request here needs a line, so the plan needs no \`${FINDINGS_HEADING}\` section.`
    : `Each file named above holds the pull request's title and body, and the markdown sections it added to the repository, such as a write-up's new section.

The plan must carry a \`${FINDINGS_HEADING}\` section, before \`## Paths\`, with one bullet for each pull request marked "needs a line". Name each by its address, as written above, and say how each finding applies to this ticket or why it does not. A plan without that section, or one that leaves one of them out, is refused. The board checks your plan against this list before you end, and asks you once to add what it misses, in this session. Write the section in exactly this form:

${lineForm(findings.map(({ url }) => url))}`;
  return `
## Its blockers and what they found

This ticket waits on these tickets. Under each is every pull request it links, with its state, title and address:

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
  const findings = replan.findings ? `\nA pull request of a blocker merged after that plan was written: see "Its blockers and what they found" below.\n` : "";
  return `
## This is a re-plan

An earlier plan for this ticket was attached, and the board has detached it so that you can write a new one.${files}${change}${findings}
Plan from the ticket's text above, which is the latest. Keep what still holds from the earlier plan, change what the new text changes, and say in the plan what you changed and why. The board writes a \`## Planned against\` section into your plan before \`## Paths\`: do not write one.
`;
}
