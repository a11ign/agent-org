import { test } from "node:test";
import assert from "node:assert/strict";
import { afterMergeLines, doneWhenOf, ownerOf } from "./done-when.ts";
import { BOARD_LINES_2026_10_25 } from "./after-merge/board-lines-fixture.ts";

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

/** Each form a line names its owner in, with what is read from it and why. */
const OWNED: readonly (readonly [line: string, owner: string, why: string])[] = [
  ["Chairman session: on the next board release, a run no longer reads Ready to merge.", "Chairman session", "a prefix before the line's first colon"],
  ["The chairman: the release note reads well.", "The chairman", "a prefix naming the person"],
  ["On the agents host: the next auto-update shows Updating, then Back.", "On the agents host", "a leading On is kept as part of the owner"],
  ["The release manager: the next release carries the note.", "The release manager", "a prefix naming a role"],
  ["The chairman's session moves herdr into its own unit, and shows both runs kept going.", "The chairman's session", "the subject form, a session before its owner"],
  ["The chairman chooses the name and licence, and sends the NV Access message. Those decisions are recorded in this file by a follow-up.", "The chairman", "the subject form wins over a second sentence"],
  ["The release manager's session runs the release play.", "The release manager's session", "a role's session"],
  ["The laptop run shows 3 of 3 captures. The chairman, after merge, with `pnpm run fleet:smoke`.", "The chairman", "the trailing form, A11-173's"],
];

/** Lines whose clauses are not shaped like an owner, and why. */
const UNOWNED: readonly (readonly [line: string, why: string])[] = [
  ["A check. The chairman of the board and the whole team, later.", "a 7-word trailing clause is no owner"],
  ["A check with no owner clause", "a line with none"],
  ["Run `pnpm x`: it prints ok.", "a prefix with a backtick is no owner"],
  ["The next release that lands while a run is starting leaves that run tracked, as the logs say at: 10:02.", "a long text before the first colon is no prefix"],
  ["Read the person's session log for the run.", "a session named inside the line is no subject"],
  ["the chairman checks it", "the subject form opens the line with The"],
];

test("A11-277: ownerOf reads the prefix form, then the subject form, then the trailing form", () => {
  for (const [line, owner, why] of OWNED) assert.equal(ownerOf(line), owner, why);
});

test("A11-277: ownerOf reads no owner from a clause that is not shaped like one", () => {
  for (const [line, why] of UNOWNED) assert.equal(ownerOf(line), null, why);
});

test("A11-277: every line on the board on 2026-10-25 reads an owner, and A11-184 and A11-233 read the right one", () => {
  const owners = new Map(BOARD_LINES_2026_10_25.map(([key, line]) => [key, ownerOf(line)]));
  assert.equal(owners.size, 33);
  assert.deepEqual([...owners].filter(([, owner]) => owner === null), [], "none is owner not named");
  assert.equal(owners.get("A11-184"), "Chairman session", "the prefix, not the On clause inside the line");
  assert.equal(owners.get("A11-233"), "The chairman");
  assert.equal(owners.get("A11-169"), "The chairman's session");
  assert.equal([...owners.values()].filter((owner) => owner === "Chairman session").length, 31);
});
