import { test } from "node:test";
import assert from "node:assert/strict";
import { afterMergeLines, doneWhenOf } from "./done-when.ts";

const TICKET = [
  "Fix it.", "", "## Acceptance", "", "- one", "", "## Done-when", "", "### Before merge", "", "- the test passes", "",
  "### After merge (who runs it)", "", "- the chairman runs `x`", "", "## Notes", "", "- aside",
].join("\n");

test("A11-156: the Done-when is the section under its heading, both parts, up to the next heading of its own level", () => {
  assert.equal(doneWhenOf(TICKET), ["## Done-when", "", "### Before merge", "", "- the test passes", "", "### After merge (who runs it)", "", "- the chairman runs `x`"].join("\n"));
});

test("A11-156: the last section runs to the end, the heading is read in any case and with a hyphen or a space, and a section of its own level before it does not leak in", () => {
  assert.equal(doneWhenOf("## Out of scope\n\n- a\n\n## Done when\n\n- b\n"), "## Done when\n\n- b");
  assert.equal(doneWhenOf("## DONE-WHEN\n- c"), "## DONE-WHEN\n- c");
});

test("A11-156: a description with no Done-when section, an empty one, and a heading of another level have none to quote", () => {
  assert.equal(doneWhenOf("A ticket.\n\n## Acceptance\n\n- x"), null);
  assert.equal(doneWhenOf(""), null);
  assert.equal(doneWhenOf(undefined), null);
  assert.equal(doneWhenOf("### Done-when\n\n- nested, not a section of its own"), null);
  assert.equal(doneWhenOf("Done-when: it works"), null, "a line that only says the words is no heading");
});

test("A11-173: afterMergeLines reads each After-merge line and who runs it; None. and a missing section give none", () => {
  const ticket = (after: string[]): string => ["Fix it.", "", "## Done-when", "", "### Before merge", "", "- the test passes. CI, before merge, with `pnpm test`.", "",
    "### After merge (who runs it)", "", ...after, "", "## Notes", "", "- aside"].join("\n");
  assert.deepEqual(afterMergeLines(ticket(["- The laptop run shows 3 of 3 captures. The chairman, after merge, with `pnpm run fleet:smoke`.", "- A second check. The release manager, on the next release."])), [
    { line: "The laptop run shows 3 of 3 captures. The chairman, after merge, with `pnpm run fleet:smoke`.", owner: "The chairman" },
    { line: "A second check. The release manager, on the next release.", owner: "The release manager" },
  ], "the owner is the clause after the first sentence, up to its first comma; the Before-merge line is not read");
  assert.deepEqual(afterMergeLines(ticket(["- A check with no owner clause"])), [{ line: "A check with no owner clause", owner: null }]);
  assert.deepEqual(afterMergeLines(ticket(["- run `a.b. c` by hand. The chairman."])), [{ line: "run `a.b. c` by hand. The chairman.", owner: "The chairman" }], "a full stop inside backticks does not end the sentence");
  assert.deepEqual(afterMergeLines(ticket(["- A line that goes on", "  over two lines. Someone, later."])), [{ line: "A line that goes on over two lines. Someone, later.", owner: "Someone" }]);
  assert.deepEqual(afterMergeLines(ticket(["* None."])), [], "None. gives none");
  assert.deepEqual(afterMergeLines(ticket(["- None required, the tests cover it."])), [], "None, with more after it, gives none");
  assert.deepEqual(afterMergeLines(ticket([])), [], "an empty section gives none");
  assert.deepEqual(afterMergeLines("## Done-when\n\n### Before merge\n\n- a test\n"), [], "a missing After-merge section gives none");
  assert.deepEqual(afterMergeLines("## Acceptance\n\n- x"), []);
  assert.deepEqual(afterMergeLines(null), []);
  assert.deepEqual(afterMergeLines("## Done-when\n\n### After merge\n\n- the chairman checks it"), [{ line: "the chairman checks it", owner: null }], "any ### After merge heading is read");
});
