// no-token: gh -- pure reader
// A11-272, step 3: the tickets a plan's `## Blocked by` section names.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plannedBlockers } from "./plan-blockers.ts";

const plan = (middle: string) => `# Step 2 waits on a ticket\n\n${middle}## Paths\n\n- \`agent-org:src/fit.ts\`\n`;

test("A11-272: a plan's `## Blocked by` section names the tickets its work waits on, other than its own, each once; a `Blocked-by:` line anywhere else is not read", () => {
  assert.deepEqual(plannedBlockers([plan(`## Blocked by\n\nBlocked-by: A11-229\nneeds A11-229's step 3, and A11-300 is no blocker\n\nBlocked-by: A11-229\nBlocked-by: A11-231\nBlocked-by: A11-230, A11-240\n\n`)], "A11-231"), ["A11-229", "A11-230", "A11-240"],
    "the key alone on the line is the blocker; a key in the reason below it is not; the ticket's own key and a repeat are left out");
  assert.deepEqual(plannedBlockers([plan("Blocked-by: A11-229\n\n## Key decisions\n\n* A line `Blocked-by: A11-300` explains the rule.\n\nBlocked-by: A11-301\n\n")], "A11-231"), [], "prose and sections of other names are never read");
  assert.deepEqual(plannedBlockers([plan("## Blocked by\n\n```\nBlocked-by: A11-229\n```\n\n")], "A11-231"), [], "an example in a fence is not a dependency");
  assert.deepEqual(plannedBlockers([plan(""), plan("## blocked by\n\n- Blocked-by: A11-229\n\n")], "A11-231"), ["A11-229"], "any of a ticket's plan files, the heading in any case, a list marker allowed");
});

test("A11-272: a key written in lower case is the tracker's upper-case key, once, and the ticket's own key is left out in any case", () => {
  assert.deepEqual(plannedBlockers([plan("## Blocked by\n\nBlocked-by: a11-5\nBlocked-by: A11-5\nBlocked-by: a11-231\n\n")], "A11-231"), ["A11-5"]);
});
