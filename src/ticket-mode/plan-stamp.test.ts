// no-token: gh -- pure functions over text; nothing is read or spawned
import { test } from "node:test";
import assert from "node:assert/strict";
import { findingsSection, parseStamp, stampedPlan, unnamedIn, urlsNamedIn, type PlanStamp } from "./plan-stamp.ts";
import { parsePaths } from "./overlap.ts";
import { planDecisionsOf } from "./plan-decisions.ts";
import { descriptionHash } from "./ticket-read.ts";

const DESCRIPTION = "# The ticket\n\n## Paths\n\n- `agent-org:not/a/plan.ts`\n\n> a quoted line\n\n```sh\nnpm test\n```\n\nTrailing  ";
const stamp = (over: Partial<PlanStamp> = {}): PlanStamp => ({ updatedAt: "2026-10-21T09:30:00.000Z", hash: descriptionHash(DESCRIPTION), files: ["A-1-0001-plan-x.md", "A-1-adr-0001-y.md"], description: DESCRIPTION, ...over });
const PLAN = "# Plan\n\n## Approach\n\nDo it.\n\n## Decisions made without a person\n\n- Technical: **a.** Evidence: b.\n\n## Paths\n\n- `agent-org:src/a.ts`\n";

test("a stamp is written just before the plan's Paths section, which stays last, and leaves the planner's own sections as they are", () => {
  const stamped = stampedPlan(PLAN, stamp());
  const headings = stamped.split("\n").filter((line) => /^## /.test(line));
  assert.deepEqual(headings, ["## Approach", "## Decisions made without a person", "## Planned against", "## Paths"]);
  assert.ok(stamped.includes("- Ticket updated: 2026-10-21T09:30:00.000Z"));
  assert.ok(stamped.includes(`- Description sha256: ${descriptionHash(DESCRIPTION)}`));
  assert.ok(stamped.startsWith("# Plan\n\n## Approach\n\nDo it."), "the planner's text is untouched");
});

test("a plan with no Paths section is stamped at its end", () => {
  const stamped = stampedPlan("# Plan\n\nDo it.\n", stamp());
  assert.deepEqual(stamped.split("\n").filter((line) => /^## /.test(line)), ["## Planned against"]);
  assert.ok(stamped.endsWith("</details>\n"));
});

test("a stamp round-trips: the updatedAt, the hash, the files and the description as planned, with its headings, fences and quotes intact", () => {
  assert.deepEqual(parseStamp(stampedPlan(PLAN, stamp())), stamp());
  assert.equal(parseStamp(stampedPlan(PLAN, stamp({ updatedAt: null })))?.updatedAt, null);
  const empty = stamp({ description: "", hash: descriptionHash("") });
  assert.deepEqual(parseStamp(stampedPlan(PLAN, empty)), empty);
});

test("the description quoted in a stamp does not change what other readers of the plan see: its Paths heading is not the plan's, and its bullets are not decisions", () => {
  const stamped = stampedPlan(PLAN, stamp({ description: "## Paths\n\n- `agent-org:not/a/plan.ts`\n\n## Decisions made without a person\n\n- Product: x", hash: descriptionHash("## Paths\n\n- `agent-org:not/a/plan.ts`\n\n## Decisions made without a person\n\n- Product: x") }));
  assert.deepEqual(parsePaths(stamped), ["agent-org:src/a.ts"]);
  assert.equal(planDecisionsOf(stamped), "## Decisions made without a person\n\n- Technical: **a.** Evidence: b.", "only the plan's own decisions are read, not the ones the quoted description holds");
});

test("stamping twice leaves one stamp, the newer", () => {
  const twice = stampedPlan(stampedPlan(PLAN, stamp({ updatedAt: "2026-10-20T00:00:00.000Z" })), stamp());
  assert.equal(twice.match(/## Planned against/g)?.length, 1);
  assert.equal(parseStamp(twice)?.updatedAt, "2026-10-21T09:30:00.000Z");
  assert.deepEqual(parsePaths(twice), ["agent-org:src/a.ts"]);
});

test("a plan with no stamp, or a stamp whose description does not hash to its hash, reads as no stamp, so it is never stale", () => {
  assert.equal(parseStamp(PLAN), null);
  const tampered = stampedPlan(PLAN, stamp()).replace("> # The ticket", "> # Another ticket");
  assert.equal(parseStamp(tampered), null);
  assert.equal(parseStamp(stampedPlan(PLAN, stamp()).replace(/- Description sha256: \w+/, "- Description sha256: nonsense")), null);
});

const WITH_FINDINGS = "# Plan\n\n## What the blockers found\n\n- https://github.com/a11ign/announcement-emulator/pull/3: cookie dialogs drop pages, so the replay clears them first.\n- see (https://github.com/a11ign/x/pull/12).\n\n## Paths\n\n- `agent-org:src/a.ts`\n";

test("a plan's What the blockers found section names pull requests by their addresses, without the punctuation of the sentence around them", () => {
  assert.equal(findingsSection(PLAN), null);
  assert.deepEqual(urlsNamedIn(WITH_FINDINGS), ["https://github.com/a11ign/announcement-emulator/pull/3", "https://github.com/a11ign/x/pull/12"]);
  assert.deepEqual(unnamedIn(WITH_FINDINGS, ["https://github.com/a11ign/announcement-emulator/pull/3", "https://github.com/a11ign/x/pull/1"]), ["https://github.com/a11ign/x/pull/1"],
    "pull/1 is not named because pull/12 is, and an address outside the section does not count");
  assert.deepEqual(unnamedIn(PLAN, ["https://github.com/a11ign/x/pull/1"]), ["https://github.com/a11ign/x/pull/1"], "a plan with no section names none");
});
