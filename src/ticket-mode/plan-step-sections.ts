// @ts-check
// module: the sections of a plan that are its steps, with the paths each lists (A11-175) -- PURE
//
// A plan with numbered steps ships one pull request for each (`board-view/plan-steps.ts`). Two things read a step of the plan: the overlap guard, which holds the paths of the run's current step and
// not the whole plan's (`board-view/plan-steps.ts` `currentStepOf`), and the reviewer, which is given the section of the step a partial pull request finishes. Plans write a step in two shapes:
//
// - A STEP HEADING, `## Step 3`, `### Step 3 of 9: Reviews, checks and the verdict door`, or `#### Step 3`: a heading of level 2 to 4 whose text begins `Step <N>`. The section runs to the next heading of
//   the same or a higher level, and its paths are the `` - `<repo>:<path>` `` bullets inside it, read as `## Paths` reads them. This is the shape planners are told to write (`worker-files.ts`).
// - A STEP ROW: in a plan with no step heading, a row of a table under a heading that contains "steps" (`### The steps`) whose first cell begins `<N>.` or `Step <N>`. The row, with the table's header,
//   is the step's text. A row declares no paths: the plan's own `## Paths` is the only list a plan with rows has.
//
// A line inside a code fence is nothing: a fenced `# Step 2` is an example, not a heading.
import { bulletPaths } from "./overlap.ts";

/** One step of a plan: its number, the plan's text for it, and the paths its section lists (none for a row). */
export type StepSection = Readonly<{ step: number; text: string; paths: readonly string[] }>;

const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const STEP_HEADING = /^step\s+(\d{1,2})\b/i;
const STEPS_SECTION = /\bsteps\b/i;
const FENCE = /^\s*(```|~~~)/;
const ROW_STEP = /^\**\s*(?:step\s+(\d{1,2})\b|(\d{1,2})\.(?=\s|\*|$))/i;
const SHALLOWEST_STEP_HEADING = 2;
const DEEPEST_STEP_HEADING = 4;

/** A line of the plan that is outside every code fence, with its place in the text. */
type PlanLine = Readonly<{ index: number; line: string }>;

/** The lines of `markdown` that are not in a code fence, and not the fence lines themselves. */
function unfenced(markdown: string): PlanLine[] {
  const lines: PlanLine[] = [];
  let fenced = false;
  markdown.split(/\r?\n/).forEach((line, index) => {
    if (FENCE.test(line)) fenced = !fenced;
    else if (!fenced) lines.push({ index, line });
  });
  return lines;
}

/** The heading a line is, as its level and text, or null for a line that is no heading. */
function headingOf(line: string): { level: number; text: string } | null {
  const found = HEADING.exec(line);
  return found === null ? null : { level: found[1].length, text: found[2] };
}

/** The step a line heads, with the heading's level, or null for a line that is no step heading: its text begins `Step <N>`, and its level is 2 to 4. */
function stepHeadingOf(line: string): { level: number; step: number } | null {
  const heading = headingOf(line);
  const numbered = heading === null ? null : STEP_HEADING.exec(heading.text);
  if (heading === null || numbered === null) return null;
  return heading.level >= SHALLOWEST_STEP_HEADING && heading.level <= DEEPEST_STEP_HEADING ? { level: heading.level, step: Number(numbered[1]) } : null;
}

/** The step sections written as headings: each runs to the next heading of the same or a higher level, with the paths its bullets list. The first section of a number is the step's. */
function headingSections(markdown: string): StepSection[] {
  const all = markdown.split(/\r?\n/);
  const lines = unfenced(markdown);
  const sections = new Map<number, StepSection>();
  lines.forEach(({ index, line }, at) => {
    const heading = stepHeadingOf(line);
    if (heading === null) return;
    const { step } = heading;
    const next = lines.slice(at + 1).find((later) => {
      const after = headingOf(later.line);
      return after !== null && after.level <= heading.level;
    });
    const end = next?.index ?? all.length;
    const listed = lines.filter((inside) => inside.index > index && inside.index < end).map((inside) => inside.line);
    if (!sections.has(step)) sections.set(step, { step, text: all.slice(index, end).join("\n").trimEnd(), paths: bulletPaths(listed) });
  });
  return [...sections.values()];
}

/** The cells of a table row, without the outer bars; a bar inside a cell is written `\|`. */
const cellsOf = (row: string): string[] => row.trim().replace(/^\|/, "").replace(/\|$/, "").split(/(?<!\\)\|/).map((cell) => cell.trim());

/** The step a table row is, from its first cell: `1. The plugin`, `**2.** Identity` or `Step 3 Reviews`; null for a row that is no step. */
function rowStepOf(row: string): number | null {
  const found = ROW_STEP.exec(cellsOf(row)[0] ?? "");
  return found === null ? null : Number(found[1] ?? found[2]);
}

/** The step sections written as rows of a table under a heading that contains "steps": the table's header, its rule line and the row make the step's text. */
function rowSections(markdown: string): StepSection[] {
  const sections = new Map<number, StepSection>();
  let under = false;
  let header: string[] = [];
  for (const { line } of unfenced(markdown)) {
    const heading = headingOf(line);
    if (heading !== null) {
      under = STEPS_SECTION.test(heading.text);
      header = [];
      continue;
    }
    if (!under || !line.trimStart().startsWith("|")) continue;
    const step = rowStepOf(line);
    // The first two table lines are its header and its rule line, and the rows follow.
    if (header.length < 2) header.push(line);
    else if (step !== null && !sections.has(step)) sections.set(step, { step, text: [...header, line].join("\n"), paths: [] });
  }
  return [...sections.values()];
}

/** The step sections of a plan, in step order: its step headings, or, when it has none, the rows of its steps table. A plan that numbers its steps some other way has none. PURE. */
export function stepSectionsOf(markdown: string): StepSection[] {
  const headings = headingSections(markdown);
  return (headings.length > 0 ? headings : rowSections(markdown)).sort((a, b) => a.step - b.step);
}

/**
 * The paths each step section of a plan lists, by step number: only a section that lists any is there. Empty for a plan whose steps list none, or that has none (a row declares no paths). PURE.
 */
export function stepPathsOf(markdown: string): Record<string, string[]> {
  return Object.fromEntries(stepSectionsOf(markdown).filter(({ paths }) => paths.length > 0).map(({ step, paths }) => [String(step), [...paths]]));
}

/** The plan's text for step `step`, or null when the plan has no such step section. PURE. */
export function stepSectionText(markdown: string, step: number): string | null {
  return stepSectionsOf(markdown).find((section) => section.step === step)?.text ?? null;
}
