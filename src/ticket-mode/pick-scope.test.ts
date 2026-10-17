// no-token: gh -- pure text from a setting
import { test } from "node:test";
import assert from "node:assert/strict";
import { pickEmptyText, pickLabel } from "./pick-scope.ts";

test("A11-69: the Pick view's count says whose tickets it lists", () => {
  assert.equal(pickLabel("assigned"), "assigned to you", "as the line read before the setting");
  assert.equal(pickLabel({ team: "A11" }), "open in team A11");
  assert.equal(pickLabel({ project: "Witness GA" }), "open in project Witness GA");
});

test("A11-69: an empty Pick view says what it asked for, of whom, and names tickets.pick", () => {
  const assigned = pickEmptyText("assigned", "Dan Beck");
  assert.ok(assigned.startsWith("No open tickets are assigned to Dan Beck,"), assigned);
  assert.ok(assigned.includes('Set tickets.pick in the host file to { "team": "<key>" } or { "project": "<name>" }'), assigned);
  assert.ok(pickEmptyText("assigned", null).startsWith("No open tickets are assigned to you,"), "a source that cannot name the person says you");
  const team = pickEmptyText({ team: "A11" }, null);
  assert.ok(team.startsWith("Team A11 has no open tickets, or Linear has no team with that key.") && team.includes("tickets.pick"), team);
  const project = pickEmptyText({ project: "Witness GA" }, null);
  assert.ok(project.startsWith('Project "Witness GA" has no open tickets, or Linear has no project of that name.') && project.includes("tickets.pick"), project);
});
