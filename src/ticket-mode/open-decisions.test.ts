// no-token: gh -- pure functions over the text of tickets and plans, handed in as strings; nothing here reads a tracker or spawns anything
import { test } from "node:test";
import assert from "node:assert/strict";
import { behaviourOpen, changesScreen, needsDecision, openDecisionOf, productDecisionIn, sectionsNeeded, settledDescription } from "./open-decisions.ts";

/** A11-125's item 4, as it was queued: a decision left open inside a numbered acceptance item. */
const A11_125 = `## Acceptance

- Items 1 to 3 hold.

### 4. Decide whether to isolate the failing ticket or keep the stall

### 5. Start anyway

Given a stalled queue, the person can start anyway.
`;

test("A11-134: an open decision in an Acceptance item is found, with its section and the line", () => {
  assert.deepEqual(openDecisionOf(A11_125), { section: "acceptance", line: "### 4. Decide whether to isolate the failing ticket or keep the stall" });
});

test("A11-134: the ticket's own Done-when, which quotes the phrase, is not flagged", () => {
  const own = `## Done-when

Queue a ticket whose Done-when says "decide whether X": it cannot be queued; Grill it, answer, and it can; the worker that builds it makes no product decision of its own.
`;
  assert.equal(openDecisionOf(own), null);
});

test("A11-134: each open-line phrase is found, and a backticked mention is not", () => {
  for (const line of ["Choose between the two layouts.", "Pick the label: TBD", "The copy is to be decided by design.", "An open question: who sees it?", "Still to decide: the empty state.", "Decide if the banner shows."]) {
    assert.ok(openDecisionOf(`## Acceptance\n\n- ${line}\n`), line);
  }
  assert.equal(openDecisionOf("## Acceptance\n\n- The message says `decide whether` only in code.\n"), null);
});

test("A11-134: a phrase outside the checked sections is not an open decision, and a section ends at a heading of its own level", () => {
  const description = `## Context

Decide whether we ever ship this. TBD.

## Acceptance

- The button shows.

## Out of scope

- Decide whether to add a menu.
`;
  assert.equal(openDecisionOf(description), null);
});

test("A11-134: Open-check is checked, and so is Done-when at any level", () => {
  assert.deepEqual(openDecisionOf("### Done-when\n\n- The row is shown.\n\n### Open-check\n\nTBD: which colour.\n"), { section: "open-check", line: "TBD: which colour." });
  assert.ok(openDecisionOf("## Acceptance criteria\n\n- Decide whether the list sorts.\n"));
});

test("A11-134: a `**Decisions:** settled` line settles every open line", () => {
  assert.equal(openDecisionOf(`${A11_125}\n**Decisions:** settled\n`), null);
});

test("A11-134: a screen ticket is queueable only after its behaviour grill is recorded", () => {
  const screen = { description: "## Acceptance\n\n- The board shows the pill.\n\n**Screen:** yes\n", labels: [] };
  assert.equal(changesScreen(screen), true);
  assert.equal(behaviourOpen(screen), true);
  assert.equal(needsDecision(screen)?.kind, "behaviour");
  assert.equal(needsDecision({ ...screen, description: `${screen.description}\n**Behaviour:** settled\n` }), null);
  assert.equal(needsDecision({ description: "**Screen:** yes\n", labels: [{ name: "ui", group: null }] })?.kind, "behaviour", "a ui label is a screen too");
  assert.equal(needsDecision({ description: "## Acceptance\n\n- The copy changes.\n", labels: [] }), null, "an ordinary ticket is never held for a behaviour grill");
});

test("A11-134: a screen ticket with its decisions settled still needs its behaviour grilled: each marker is separate", () => {
  const description = `${A11_125}\n**Decisions:** settled\n**Screen:** yes\n`;
  assert.equal(needsDecision({ description, labels: [] })?.kind, "behaviour");
  assert.deepEqual(sectionsNeeded({ description, labels: [] }), ["Behaviour"]);
});

test("A11-134: needsDecision names the open line in its reason, and a decision comes before a screen's behaviour", () => {
  const open = needsDecision({ description: `${A11_125}\n**Screen:** yes\n`, labels: [] });
  assert.equal(open?.kind, "decision");
  assert.equal(open?.line, "### 4. Decide whether to isolate the failing ticket or keep the stall");
  assert.ok(open?.reason.includes(`"${open.line}"`), open?.reason);
  assert.deepEqual(sectionsNeeded({ description: `${A11_125}\n**Screen:** yes\n`, labels: [] }), ["Decisions", "Behaviour"]);
  assert.equal(needsDecision({ description: "## Acceptance\n\n- Ready.\n", labels: [] }), null);
});

test("A11-134: the answers are written under the old text, with the marker of each section they hold", () => {
  const decisions = "## Decisions\n\n**Isolate or stall?** Isolate the failing ticket.\n\n## Behaviour\n\n**Empty state?** Says none.\n";
  const written = settledDescription(`${A11_125}\n`, decisions);
  assert.equal(written, `${A11_125.trimEnd()}\n\n${decisions.trim()}\n\n**Decisions:** settled\n**Behaviour:** settled`);
  assert.equal(openDecisionOf(written), null, "the open line is settled by the marker, and not rewritten");
  assert.equal(needsDecision({ description: written, labels: [{ name: "ui", group: null }] }), null, "a screen whose behaviour is answered is queueable");
});

test("A11-134: a Grill that answered only the decisions leaves a screen's behaviour open", () => {
  const written = settledDescription(`${A11_125}\n`, "## Decisions\n\n**Isolate or stall?** Isolate.\n");
  assert.equal(written.endsWith("**Decisions:** settled"), true);
  assert.equal(needsDecision({ description: written, labels: [{ name: "ui", group: null }] })?.kind, "behaviour");
});

test("A11-134: a plan's product bullet is found, and a technical one is not", () => {
  const plan = `# Plan

## Decisions made without a person

- Technical: the phrase list. Evidence: the ticket.
- Product: the empty state says none. Evidence: none.

## Paths

- \`agent-org:src/a.ts\`
`;
  assert.equal(productDecisionIn(plan), "- Product: the empty state says none. Evidence: none.");
  assert.equal(productDecisionIn(plan.replace("- Product:", "- Technical:")), null);
  assert.equal(productDecisionIn("## Paths\n\n- Product: outside its section.\n"), null);
});
