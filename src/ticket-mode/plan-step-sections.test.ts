// no-token: none -- pure: the plan texts are given here, and nothing is read
import { test } from "node:test";
import assert from "node:assert/strict";
import { planStepList, stepPathsOf, stepSectionsOf, stepSectionText } from "./plan-step-sections.ts";

// A11-175: a plan's steps, as the overlap guard and the reviewer read them.
const HEADINGS = [
  "# The plan", "", "Intro.", "",
  "## Approach", "", "### Step 1 of 3: The plugin", "", "Create it.", "", "- `agent-org:plugins/github/`", "- `agent-org:plugins/github/index.ts` the entry", "- not a path bullet", "",
  "### Step 2 of 3: Identity", "", "Move the wrapper.", "", "#### Detail", "", "- `agent-org:host/gh`", "",
  "### Step 3 of 3: The docs", "", "No paths in this one.", "",
  "## Paths", "", "- `agent-org:plugins/github/`", "- `agent-org:host/gh`", "",
].join("\n");

const ROWS = [
  "## Approach", "", "### The steps", "", "Each step is one pull request:", "", "- **It merges on its own.** Each one passes.", "",
  "| Step | Moves | Leaves true |", "| --- | --- | --- |",
  "| 1. The plugin and ticket mode | `plugins/github` created. Ticket mode's six operations moved in | The board runs through the plugin |",
  "| 2. Identity | `host/gh` moved | Doctor's rows come from the plugin |",
  "| **3.** Reviews, checks and the verdict door | The reviewer's calls | The atomic reviewer still starts |", "",
  "### Key decisions", "", "| 4. Not a step | it is under another heading | x |", "",
  "## Paths", "", "- `agent-org:src/`", "",
].join("\n");

test("A11-175: a step heading starts a step section that runs to the next heading of its level or higher, and lists the path bullets inside it", () => {
  const sections = stepSectionsOf(HEADINGS);
  assert.deepEqual(sections.map(({ step }) => step), [1, 2, 3]);
  assert.deepEqual(sections[0].paths, ["agent-org:plugins/github/", "agent-org:plugins/github/index.ts"], "a bullet is `repo:path` with anything after it; other bullets are no path");
  assert.deepEqual(sections[1].paths, ["agent-org:host/gh"], "a deeper heading is inside the section");
  assert.deepEqual(sections[2].paths, [], "a section that lists none lists none: it does not take the plan's ## Paths");
  assert.ok(sections[0].text.startsWith("### Step 1 of 3: The plugin") && sections[0].text.includes("Create it.") && !sections[0].text.includes("Step 2"), "the text is the section");
  assert.ok(sections[1].text.includes("#### Detail") && !sections[1].text.includes("Step 3"));
  assert.ok(!sections[2].text.includes("## Paths") && !sections[2].text.includes("`agent-org:host/gh`"), "the plan's own Paths section is not a step's");
});

test("A11-175: stepPathsOf gives the paths of each step section that lists any, by step number, and nothing for a plan without them", () => {
  assert.deepEqual(stepPathsOf(HEADINGS), { "1": ["agent-org:plugins/github/", "agent-org:plugins/github/index.ts"], "2": ["agent-org:host/gh"] });
  assert.deepEqual(stepPathsOf(ROWS), {}, "a row declares no paths");
  assert.deepEqual(stepPathsOf("## Paths\n\n- `agent-org:src/`\n"), {}, "a plan with no steps has no step paths");
  assert.deepEqual(stepPathsOf(""), {});
});

test("A11-175: a step row of A11-160's table is that step's text, with the table's header, and only under a heading that names steps", () => {
  const sections = stepSectionsOf(ROWS);
  assert.deepEqual(sections.map(({ step }) => step), [1, 2, 3], "`1.`, `2.` and `**3.**` are steps; the table under another heading is not");
  assert.equal(sections[0].text, "| Step | Moves | Leaves true |\n| --- | --- | --- |\n| 1. The plugin and ticket mode | `plugins/github` created. Ticket mode's six operations moved in | The board runs through the plugin |");
  assert.ok(sections[2].text.endsWith("| **3.** Reviews, checks and the verdict door | The reviewer's calls | The atomic reviewer still starts |"));
  assert.ok(sections.every(({ paths }) => paths.length === 0));
  assert.equal(stepSectionText(ROWS, 2), "| Step | Moves | Leaves true |\n| --- | --- | --- |\n| 2. Identity | `host/gh` moved | Doctor's rows come from the plugin |");
});

test("A11-175: step headings win over rows, a heading outside levels 2 to 4 is no step, and a fenced heading is an example", () => {
  assert.deepEqual(stepSectionsOf(`${HEADINGS}\n### The steps\n\n| Step | x |\n| - | - |\n| 7. A row | y |\n`).map(({ step }) => step), [1, 2, 3], "a plan with step headings reads no rows");
  assert.deepEqual(stepSectionsOf("# Step 1\n\ntext\n\n##### Step 2\n\ntext\n"), [], "level 1 and level 5 are no step headings");
  assert.deepEqual(stepSectionsOf("## Step 1\n\n```md\n## Step 2\n- `a:b`\n```\n\n- `agent-org:src/a.ts`\n").map(({ step, paths }) => [step, paths]), [[1, ["agent-org:src/a.ts"]]], "a fenced heading ends nothing and starts nothing");
  assert.deepEqual(stepSectionsOf("### Step 2 first\n\n- `a:x`\n\n### Step 2 again\n\n- `a:y`\n").map(({ paths }) => paths), [["a:x"]], "the first section of a number is the step's");
  assert.equal(stepSectionText(HEADINGS, 4), null, "a step the plan does not have has no text");
  assert.equal(stepSectionText("", 1), null);
});

test("A11-175: a plan the board numbers some other way has no step sections", () => {
  assert.deepEqual(stepSectionsOf("## Plan\n\n1. First\n2. Second\n\n## Paths\n\n- `a:b`\n"), []);
});

test("A11-175: a table under a heading that only mentions steps is not the plan's steps, as the step count reads them", () => {
  const next = "## Next steps\n\n| Step | What |\n| - | - |\n| 1. Tell the team | later |\n";
  assert.deepEqual(stepSectionsOf(next), []);
  assert.deepEqual(stepSectionsOf(next.replace("## Next steps", "## Steps")).map(({ step }) => step), [1]);
});

// A11-219: the numbered steps of a plan, with their titles, for the board's run detail.
test("A11-219: planStepList gives each step heading's number and title, and not a fenced heading", () => {
  const plan = ["## Approach", "", "### Step 1 of 3: Read the queue", "", "text", "", "### Step 2 of 3 — Record it", "", "```md", "### Step 9 of 9: an example", "```", "",
    "### Step 3 of 3 - The **docs**", "", "#### Step 4", ""].join("\n");
  assert.deepEqual(planStepList(plan), [{ n: 1, title: "Read the queue" }, { n: 2, title: "Record it" }, { n: 3, title: "The docs" }, { n: 4, title: "Step 4" }]);
});

test("A11-219: planStepList gives each row of a Steps table its number and title, from the first cell or else the second", () => {
  assert.deepEqual(planStepList(ROWS), [{ n: 1, title: "The plugin and ticket mode" }, { n: 2, title: "Identity" }, { n: 3, title: "Reviews, checks and the verdict door" }]);
  const bare = "## Steps\n\n| Step | What |\n| - | - |\n| 1 | Read the queue |\n| Step 2 | Record it |\n";
  assert.deepEqual(planStepList(bare), [{ n: 1, title: "Read the queue" }, { n: 2, title: "Record it" }]);
});

test("A11-219: planStepList is empty for a plan with no numbered steps", () => {
  assert.deepEqual(planStepList("## Approach\n\nDo it.\n\n## Paths\n\n- `agent-org:src/`\n"), []);
  assert.deepEqual(planStepList(""), []);
});
