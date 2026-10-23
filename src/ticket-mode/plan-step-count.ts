// @ts-check
// module: how many numbered steps a ticket's plan has (A11-173) -- PURE
//
// A plan with steps ships one pull request for each (`board-view/plan-steps.ts`). The board reads the count once, from the plan file, when a partial pull request merged and its
// `Partial:` line did not say `of <M>`. Plans number their steps in the two forms the attached plans use: `## Step <N>` / `### Step <N>: ...` headings, and numbered list items
// or table rows under a heading named `Steps` or `The steps`. A plan that numbers them some other way has none counted, and such a run stops with its reason.

const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const STEP_HEADING = /^step\s+(\d{1,2})\b/i;
const STEPS_SECTION = /^(?:the\s+)?steps\b/i;
const FENCE = /^\s*(```|~~~)/;
const LIST_ITEM = /^\s*(\d{1,2})[.)]\s/;
const TABLE_ROW = /^\s*\|\s*\**(\d{1,2})\**(?:[.)]\s|\s*\|)/;

/** The highest step number a plan numbers, or 0 when it numbers none. Lines inside a code fence are not read. PURE. */
export function planStepCount(markdown: string): number {
  let highest = 0;
  let stepsLevel: number | null = null;
  let fenced = false;
  for (const line of markdown.split("\n")) {
    if (FENCE.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const heading = HEADING.exec(line);
    if (heading !== null) {
      const [level, text] = [heading[1].length, heading[2]];
      // A heading of the section's own level or higher ends it; a deeper one is inside it.
      if (stepsLevel !== null && level <= stepsLevel) stepsLevel = null;
      const numbered = STEP_HEADING.exec(text);
      if (numbered !== null) highest = Math.max(highest, Number(numbered[1]));
      else if (STEPS_SECTION.test(text)) stepsLevel = level;
      continue;
    }
    if (stepsLevel === null) continue;
    const item = LIST_ITEM.exec(line) ?? TABLE_ROW.exec(line);
    if (item !== null) highest = Math.max(highest, Number(item[1]));
  }
  return highest;
}
