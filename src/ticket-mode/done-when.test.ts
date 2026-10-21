import { test } from "node:test";
import assert from "node:assert/strict";
import { doneWhenOf } from "./done-when.ts";

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
