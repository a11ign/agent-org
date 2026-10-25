// no-token: none -- pure text
import { test } from "node:test";
import assert from "node:assert/strict";
import { WORKER_NOTES } from "../../install/house-notes.ts";
import type { Ticket } from "../source.ts";
import { briefText } from "../worker-files.ts";
import { PUSH_ONCE_RULE } from "./rules.ts";

const ticket = { key: "A11-1", title: "t", description: "d", url: "https://linear.app/x/issue/A11-1", branch: "a11-1-t", status: "Backlog", statusOrder: 0, team: "A11", project: null, priority: 3, parent: null } as Ticket;

test("A11-261: the rule says to test locally, push once per meaningful change, never push to see what CI says, batch fix-ups, and keep heavy jobs off drafts", () => {
  for (const part of ["tests, typecheck and lint locally before you push", "push once per meaningful change", "Never push only to see what CI says", "never push fix-ups one at a time when they can be batched", "heavy jobs off a pull request while it is still a draft"]) {
    assert.ok(PUSH_ONCE_RULE.includes(part), `the rule says ${part}`);
  }
});

test("A11-261: every worker's brief carries the rule, in the step that tells it to commit and push", () => {
  const brief = briefText({ ticket, folder: "/f", ticketDir: "/d", attachments: [], clones: { repo: "/work/repo" }, worktreeCommand: "w", prOpenCommand: "p" });
  assert.ok(brief.includes("3. Work, commit and push only inside those worktrees."));
  assert.ok(brief.includes(PUSH_ONCE_RULE));
  assert.equal(brief.includes("draft pull request"), false, "a drafts-off machine's brief never says draft pull request (worker-files.test.ts holds that)");
  assert.ok(brief.indexOf(PUSH_ONCE_RULE) > brief.indexOf("Work, commit and push only") && brief.indexOf(PUSH_ONCE_RULE) < brief.indexOf("## What to do"));
});

test("A11-261: the shipped worker house notes carry the rule", () => {
  assert.ok(WORKER_NOTES.includes(PUSH_ONCE_RULE));
});
