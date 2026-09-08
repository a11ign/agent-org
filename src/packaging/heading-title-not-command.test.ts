/**
 * #506: A MARKDOWN HEADING BEGINNING WITH "Acceptance" HAD THE REST OF ITS OWN LINE TAKEN AS A COMMAND.
 *
 * `sectionHeaderPattern` used one regex with one shared capture group for two different shapes: `##
 * Acceptance: npm test` (a real inline command) and `## Acceptance — old read vs new, on the live queue`
 * (a prose title). `extractSection` could not tell them apart and ran the second as a command -- caught
 * live on PR #500, `08:11:31Z`: `ACCEPTANCE: "— old read vs new, on the live queue" is not a command (no
 * executable "—")`.
 *
 * Before #446 this would have been silently EXECUTED, not refused: a heading beginning with a real
 * command word (`## Acceptance: test the new selector`) hands `test the new selector` to bash, where
 * `test` is a real builtin exiting 0 on a non-empty string -- a green acceptance that ran nothing, #446's
 * own defect arriving through a heading instead of a body line.
 *
 * The fix: a markdown heading's trailing text is a TITLE unless a COLON follows the field name -- the one
 * shape the inline-command form actually means everywhere else in this parser. `Refutation` shares the
 * identical parser by design (#438), so every fixture here is run against both field names.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { extractAcceptanceSection, extractRefutationSection } from "../../../../scripts/acceptance-commands.mjs";

/** Runs one fixture against both `Acceptance:` and `Refutation:`, since #438's rule is one shared parser. */
const bothFields = [
  { name: "Acceptance", extract: extractAcceptanceSection },
  { name: "Refutation", extract: extractRefutationSection },
];

for (const { name, extract } of bothFields) {
  test(`extractSection(${name}): THE #500 REAL FIXTURE -- a heading title with no colon is NEVER a command`, () => {
    const body = [
      `## ${name} — old read vs new, on the live queue`,
      "",
      "```",
      "node scripts/merge-guard.mjs --armed-check=<a green-and-behind branch>",
      "```",
    ].join("\n");
    assert.deepEqual(extract(body),
      { kind: "commands", commands: ["node scripts/merge-guard.mjs --armed-check=<a green-and-behind branch>"] });
  });

  test(`extractSection(${name}): THE MEASUREMENT -- a title-only heading with NOTHING below is MISSING, never the title`, () => {
    // Documents the exact pre-#506 shape: without this fix, this body's "command" would have been the
    // dash-led prose itself.
    const body = `## ${name} — old read vs new, on the live queue`;
    assert.deepEqual(extract(body), { kind: "missing" });
  });

  test(`extractSection(${name}): the COLON form still works -- "## ${name}: npm test" -> commands ["npm test"]`, () => {
    assert.deepEqual(extract(`## ${name}: npm test`), { kind: "commands", commands: ["npm test"] });
  });

  test(`extractSection(${name}): a bare heading with no title at all is unchanged (#419)`, () => {
    const body = `## ${name}\n\nnpm test\n`;
    assert.deepEqual(extract(body), { kind: "commands", commands: ["npm test"] });
  });

  test(`extractSection(${name}): a title with NO dash at all is still a title, not "and how I checked it"`, () => {
    // The issue's own explicit non-fix: stripping punctuation or refusing dashes leaves ordinary prose
    // headings (no dash, still not a command) executing their own trailing words.
    const body = [`## ${name} and how I checked it`, "", "npm test", ""].join("\n");
    assert.deepEqual(extract(body), { kind: "commands", commands: ["npm test"] });
  });

  test(`extractSection(${name}): a colon-form "none" opt-out is unaffected by the heading fix`, () => {
    assert.deepEqual(extract(`## ${name}: none — nothing to run`), { kind: "none", reason: "nothing to run" });
  });

  test(`extractSection(${name}): "none" on a LINE BELOW a title heading is a command line, never the opt-out`, () => {
    // A title heading has no inline slot at all -- "none" only ever means the opt-out when it is itself
    // the inline text after a COLON. On its own line below a title it is just another command line (#419's
    // own shape), and this parser does not classify command TEXT here -- only `classifyCommand` (#446)
    // would later refuse "none — nothing to run" as prose, which is a separate check.
    const body = [`## ${name} — a title`, "", "none — nothing to run", ""].join("\n");
    assert.deepEqual(extract(body), { kind: "commands", commands: ["none — nothing to run"] });
  });
}

// --- MUTATION TARGET: the exact #500 shape, standalone ---

test("MUTATION TARGET: the #500 heading, without the fix, would read its own title as the command", () => {
  // Pre-#506 shape: one shared capture group could not distinguish a heading's title from a colon's
  // inline command, so this body's Section would have been { kind: "commands", commands: ["— old read
  // vs new, on the live queue"] } -- the exact live failure on PR #500.
  const preFixSingleGroupCapture = /^\s*(?:#{1,6}\s+Acceptance:?|(?:\*\*|__)?Acceptance:(?:\*\*|__)?)\s*(.*)$/;
  const line = "## Acceptance — old read vs new, on the live queue";
  const match = preFixSingleGroupCapture.exec(line);
  assert.equal(match?.[1], "— old read vs new, on the live queue",
    "documents the exact pre-fix capture that #446's classifier then refused as \"no executable \\u2014\"");
});
