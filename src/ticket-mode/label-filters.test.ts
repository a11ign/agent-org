// no-token: gh -- pure functions over plain tickets
import { test } from "node:test";
import assert from "node:assert/strict";
import { clearedRow, groupTags, labelChoice, labelRows, meetsLabels, UNGROUPED, withLabels, type Labelled } from "./label-filters.ts";

const goal = (name: string) => ({ name, group: "Goal" });
const area = (name: string) => ({ name, group: "Area" });
const loose = (name: string) => ({ name, group: null });
type T = Labelled & { key: string };
const TICKETS: T[] = [
  { key: "A-1", labels: [goal("Fleet"), area("Board"), loose("Bug")] },
  { key: "A-2", labels: [goal("Ticket mode"), area("Board")] },
  { key: "A-3", labels: [goal("Fleet"), loose("Chore")] },
  { key: "A-4", labels: [] },
  { key: "A-5" },
];
const keys = (tickets: readonly T[]) => tickets.map((t) => t.key);

test("a row for each label group among the tickets, by name, then one Labels row for the labels in no group; chips by count, then name", () => {
  const rows = labelRows(TICKETS, new Set());
  assert.deepEqual(rows.map((r) => [r.group, r.name]), [["Area", "Area"], ["Goal", "Goal"], [null, UNGROUPED]]);
  const goalRow = rows[1];
  assert.deepEqual(goalRow.chips.map((c) => [c.text, c.count]), [["Fleet", 2], ["Ticket mode", 1], ["(no Goal)", 2]],
    "the tickets with no label of the group have a chip of their own, last");
  assert.deepEqual(rows[2].chips.map((c) => [c.text, c.count]), [["Bug", 1], ["Chore", 1], ["(no label)", 3]]);
  assert.ok(rows.every((r) => r.all && r.chips.every((c) => !c.pressed)), "nothing chosen: every row reads All");
});

test("no labels at all, or none in a group, makes no row: the Labels row shows only when some label is in no group", () => {
  assert.deepEqual(labelRows([{ key: "A-1" }, { key: "A-2", labels: [] }] as T[], new Set()), []);
  assert.deepEqual(labelRows([{ labels: [goal("Fleet")] }], new Set()).map((r) => r.name), ["Goal"]);
  assert.deepEqual(labelRows([{ labels: [goal("Fleet")] }], new Set())[0].chips.map((c) => c.text), ["Fleet"], "no (no Goal) chip when every ticket has one");
});

test("a ticket that lists a label twice counts once for it", () => {
  assert.deepEqual(labelRows([{ labels: [goal("Fleet"), goal("Fleet")] }], new Set())[0].chips.map((c) => c.count), [1]);
});

test("a group's and a label's names cannot be mistaken for each other however they are spelled", () => {
  assert.notEqual(labelChoice("Goal", "Fleet"), labelChoice(null, "Goal Fleet"));
  assert.notEqual(labelChoice("a,b", "c"), labelChoice("a", "b,c"));
  const rows = labelRows([{ labels: [{ name: "Goal", group: null }, goal("Fleet")] }], new Set([labelChoice(null, "Goal")]));
  assert.deepEqual(rows.map((r) => [r.name, r.all]), [["Goal", true], [UNGROUPED, false]], "a loose label named after a group chooses only its own row");
});

test("several chips of a row show a ticket with any of them; rows combine with AND", () => {
  const fleetOrMode = new Set([labelChoice("Goal", "Fleet"), labelChoice("Goal", "Ticket mode")]);
  assert.deepEqual(keys(withLabels(TICKETS, fleetOrMode)), ["A-1", "A-2", "A-3"]);
  assert.deepEqual(keys(withLabels(TICKETS, new Set([...fleetOrMode, labelChoice("Area", "Board")]))), ["A-1", "A-2"], "and in Area Board");
  assert.deepEqual(keys(withLabels(TICKETS, new Set([labelChoice("Goal", "Fleet"), labelChoice(null, "Chore")]))), ["A-3"], "and with the loose label Chore");
  const rows = labelRows(TICKETS, fleetOrMode);
  assert.deepEqual(rows.map((r) => r.all), [true, false, true]);
  assert.deepEqual(rows[1].chips.filter((c) => c.pressed).map((c) => c.text), ["Fleet", "Ticket mode"]);
});

test("(no <group>) shows the tickets with no label of that group, and can be chosen beside a label", () => {
  assert.deepEqual(keys(withLabels(TICKETS, new Set([labelChoice("Goal", null)]))), ["A-4", "A-5"]);
  assert.deepEqual(keys(withLabels(TICKETS, new Set([labelChoice("Goal", null), labelChoice("Goal", "Ticket mode")]))), ["A-2", "A-4", "A-5"]);
});

test("a remembered choice that names no chip filters nothing, so a renamed label never hides the whole list", () => {
  const stale = new Set([labelChoice("Goal", "Renamed"), labelChoice("Gone", "Fleet"), "not a choice"]);
  assert.deepEqual(keys(withLabels(TICKETS, stale)), keys(TICKETS));
  assert.ok(labelRows(TICKETS, stale).every((r) => r.all));
});

test("the rows are made from every listed ticket, so filtering a part of the list keeps the same chips", () => {
  const part = TICKETS.slice(1, 2);
  assert.deepEqual(keys(withLabels(part, new Set([labelChoice("Goal", null)]), TICKETS)), [], "A-2 has a Goal");
  const rows = labelRows(TICKETS, new Set([labelChoice("Goal", "Fleet")]));
  assert.equal(meetsLabels(TICKETS[0], rows), true);
  assert.equal(meetsLabels(TICKETS[1], rows), false);
});

test("All clears one row's choices and keeps the other rows'", () => {
  const chosen = new Set([labelChoice("Goal", "Fleet"), labelChoice("Goal", null), labelChoice("Area", "Board"), labelChoice(null, "Bug")]);
  assert.deepEqual([...clearedRow(chosen, "Goal")], [labelChoice("Area", "Board"), labelChoice(null, "Bug")]);
  assert.deepEqual([...clearedRow(chosen, null)], [labelChoice("Goal", "Fleet"), labelChoice("Goal", null), labelChoice("Area", "Board")]);
});

test("a ticket's tags are its labels in a group, by group then name; a label in no group is not tagged", () => {
  assert.deepEqual(groupTags(TICKETS[0]), [area("Board"), goal("Fleet")]);
  assert.deepEqual(groupTags(TICKETS[4]), []);
});
