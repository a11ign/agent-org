// no-token: gh -- a pure function of text; nothing is spawned
import { test } from "node:test";
import assert from "node:assert/strict";
import { decisionHeading, withAnswer } from "./answer-decision.ts";
import { decisionsOf } from "./ticket-decisions.ts";

const DECISION = { question: "Which colour?", answer: "Blue.", who: "the chairman", date: "2026-10-25" };
const ENTRY = "## Decisions (the chairman, 2026-10-25)\n\n* **Question:** Which colour?\n* **Answer:** Blue.\n";

test("A11-250: a description with no Decisions gets a new last section, with the question and the answer", () => {
  const written = withAnswer("## Problem\n\nIt is red.\n", DECISION);
  assert.equal(written.added, true);
  assert.equal(written.description, `## Problem\n\nIt is red.\n\n${ENTRY}`);
  assert.equal(written.heading, "## Decisions (the chairman, 2026-10-25)");
  assert.equal(withAnswer("", DECISION).description, ENTRY, "an empty description is just the entry");
});

test("A11-250: the entry is what decisionsOf reads, so a reviewer is briefed with it", () => {
  assert.equal(decisionsOf(withAnswer("## Problem\n\nIt is red.\n", DECISION).description), ENTRY.trim());
});

test("A11-250: when the last section has the same heading the bullets go under it, and a different heading starts a section", () => {
  const same = withAnswer(`Intro.\n\n${ENTRY}`, { ...DECISION, question: "Which size?", answer: "Large." });
  assert.equal(same.description, `Intro.\n\n${ENTRY}\n* **Question:** Which size?\n* **Answer:** Large.\n`);
  assert.equal(same.description.match(/^## Decisions/gm)?.length, 1);
  const other = withAnswer(`Intro.\n\n${ENTRY}`, { ...DECISION, who: "Dana", question: "Which size?", answer: "Large." });
  assert.equal(other.description.match(/^## Decisions/gm)?.length, 2);
  assert.ok(other.description.endsWith("## Decisions (Dana, 2026-10-25)\n\n* **Question:** Which size?\n* **Answer:** Large.\n"));
  const notLast = withAnswer(`${ENTRY}\n## Done-when\n\n* It is blue.\n`, { ...DECISION, question: "Which size?", answer: "Large." });
  assert.equal(notLast.description.match(/^## Decisions/gm)?.length, 2, "a section that is not last is not merged into");
});

test("A11-250: the same question and answer is not written again, even under another day's heading", () => {
  const again = withAnswer(`Intro.\n\n${ENTRY}`, DECISION);
  assert.deepEqual([again.added, again.description], [false, `Intro.\n\n${ENTRY}`]);
  const later = withAnswer(`Intro.\n\n${ENTRY}`, { ...DECISION, date: "2026-10-26" });
  assert.equal(later.added, false);
  assert.equal(later.heading, "## Decisions (the chairman, 2026-10-25)", "the heading it was written under");
});

test("A11-250: a multi-line answer stays inside its bullet, and its lines never read as headings of the ticket", () => {
  const written = withAnswer("Intro.\n", { ...DECISION, answer: "Blue.\n\n## Not a heading\nBecause." });
  assert.ok(written.description.includes("* **Answer:** Blue.\n\n  ## Not a heading\n  Because.\n"));
  assert.equal(decisionsOf(written.description)?.includes("## Not a heading"), true, "the section runs to its end");
  assert.equal(written.description.match(/^## /gm)?.length, 1, "no line of the answer starts a heading");
});

test("A11-250: an unclosed code fence in the question or the answer is closed, so a later entry is still read", () => {
  const first = withAnswer("Intro.\n", { ...DECISION, answer: "Use:\n```\nblue()" }).description;
  assert.equal(first.split("\n").filter((line) => /^\s*```/.test(line)).length % 2, 0);
  const second = withAnswer(first, { ...DECISION, who: "Dana", question: "Which size?", answer: "Large." }).description;
  assert.ok(decisionsOf(second)?.includes("## Decisions (Dana, 2026-10-25)"), "the entry after it is outside the fence");
  assert.equal(decisionHeading(DECISION), "## Decisions (the chairman, 2026-10-25)");
});

test("A11-250: only the latest entry is a repeat: the first answer given again after another is a new entry", () => {
  const first = withAnswer("Intro.\n", DECISION).description;
  const second = withAnswer(first, { ...DECISION, answer: "Red." });
  assert.equal(second.added, true);
  assert.equal(withAnswer(second.description, DECISION).added, true, "Blue again is not the last entry");
  assert.equal(withAnswer(second.description, { ...DECISION, answer: "Red." }).added, false);
});
