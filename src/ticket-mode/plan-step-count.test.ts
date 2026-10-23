import { test } from "node:test";
import assert from "node:assert/strict";
import { planStepCount } from "./plan-step-count.ts";

test("A11-173: a plan's steps are counted from Step headings and from a numbered Steps list or table; a plan with none counts 0", () => {
  const headings = ["# Plan", "", "## Approach", "", "Text.", "", "## Step 1: identity", "", "- a", "", "### Step 2: the board", "", "## Step 3", "", "## Out of scope"].join("\n");
  assert.equal(planStepCount(headings), 3, "A11-84's shape: Step <N> headings");
  const table = ["# Plan", "", "### The steps", "", "| Step | What |", "| --- | --- |", "| 1. | identity |", "| 2. | the board |", "| 9. | docs |", "", "### Proof", "", "| 12 | not a step |"].join("\n");
  assert.equal(planStepCount(table), 9, "A11-160's shape: rows of a table under a heading named The steps; a table past the section is not read");
  const list = ["## Steps", "", "1. one", "2) two", "   3. three, indented", "", "## Notes", "", "7. a numbered note outside the section"].join("\n");
  assert.equal(planStepCount(list), 3, "a numbered list under a heading named Steps");
  assert.equal(planStepCount(["## Steps", "", "### Detail", "", "4. inside the section, under a deeper heading"].join("\n")), 4, "a deeper heading stays inside the section");
  assert.equal(planStepCount(["# Plan", "", "### 1. A done from a review round", "", "1. one", "2. two", "", "## Proof", "", "| 1 | row |"].join("\n")), 0, "numbers outside a Steps section and headings that are not Step headings count none");
  assert.equal(planStepCount(["## Steps", "", "```", "1. in a fence", "```", "", "| 2021 | a year |"].join("\n")), 0, "a fenced line and a number of three digits or more are not steps");
  assert.equal(planStepCount(""), 0);
  assert.equal(planStepCount("## Step 1\n## Step 5\n## Step 2"), 5, "the highest number, in any order");
});
