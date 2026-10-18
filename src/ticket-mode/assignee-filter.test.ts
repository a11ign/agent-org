// no-token: gh -- pure functions over plain tickets
import { test } from "node:test";
import assert from "node:assert/strict";
import { ANYONE, defaultScope, inScope, NO_VIEWER, ownerName, scopeChips, scopeEmptyText, scopeWord, showsOwner, UNASSIGNED, YOU, type Owned, type Viewer } from "./assignee-filter.ts";

const DAN: Viewer = { id: "dan", name: "Dan Beck" };
const ANA = { id: "ana", name: "Ana Ruiz" };
const BEN = { id: "ben", name: "Ben Park" };
const TICKETS: Owned[] = [
  { key: "A-1", assignee: DAN },
  { key: "A-2", assignee: ANA },
  { key: "A-3", assignee: null },
  { key: "A-4", assignee: DAN },
  { key: "A-5", assignee: ANA },
  { key: "A-6", assignee: BEN },
  { key: "A-7", assignee: null },
  { key: "A-8", assignee: ANA },
];
const inChoice = (scope: string, viewer: Viewer = DAN) => TICKETS.filter((t) => inScope(t, scope, viewer)).map((t) => t.key);

test("A11-108: the list starts on the signed-in person when the setting says so and the person is known, else on Anyone", () => {
  assert.equal(defaultScope("you", DAN), YOU);
  assert.equal(defaultScope("you", null), ANYONE, "a tracker that cannot say who the person is lists everyone");
  assert.equal(defaultScope("anyone", DAN), ANYONE, "a team or a project starts on Anyone");
});

test("A11-108: a scope holds the tickets it names: the person's, every one, the unassigned, or one other person's", () => {
  assert.deepEqual(inChoice(YOU), ["A-1", "A-4"]);
  assert.deepEqual(inChoice(ANYONE), TICKETS.map((t) => t.key));
  assert.deepEqual(inChoice(UNASSIGNED), ["A-3", "A-7"]);
  assert.deepEqual(inChoice("ana"), ["A-2", "A-5", "A-8"]);
  assert.deepEqual(inChoice(YOU, null), [], "the person's scope holds nothing when the person is not known");
});

test("A11-108: the chips are the signed-in person, Anyone and Unassigned, then each other person with an open ticket by count and then name, each with its count", () => {
  const chips = scopeChips(TICKETS, YOU, DAN);
  assert.deepEqual(chips.map((c) => [c.scope, c.text, c.count]), [
    [YOU, "Dan Beck (you)", 2],
    [ANYONE, "Anyone", 8],
    [UNASSIGNED, "Unassigned", 2],
    ["ana", "Ana Ruiz", 3],
    ["ben", "Ben Park", 1],
  ]);
  assert.deepEqual(chips.filter((c) => c.pressed).map((c) => c.scope), [YOU], "only the chosen scope is pressed");
});

test("A11-108: a person with no open ticket has no chip, while the person, Anyone and Unassigned always do, even at zero", () => {
  const chips = scopeChips([{ key: "A-1", assignee: ANA }], YOU, DAN);
  assert.deepEqual(chips.map((c) => [c.scope, c.count]), [[YOU, 0], [ANYONE, 1], [UNASSIGNED, 0], ["ana", 1]]);
  assert.deepEqual(scopeChips([{ key: "A-1", assignee: ANA }], ANYONE, null).map((c) => c.scope), [ANYONE, UNASSIGNED, "ana"],
    "a tracker that cannot say who the person is has no chip for them");
});

test("A11-108: the counter names the chosen scope: the person's own words, unassigned, the other person, or Anyone's open words", () => {
  const chips = scopeChips(TICKETS, YOU, DAN);
  assert.equal(scopeWord(YOU, chips, "open"), "assigned to you", "as the line read before the filter");
  assert.equal(scopeWord(UNASSIGNED, chips, "open"), "unassigned");
  assert.equal(scopeWord("ana", chips, "open"), "assigned to Ana Ruiz");
  assert.equal(scopeWord(ANYONE, chips, "open"), "open");
  assert.equal(scopeWord(ANYONE, chips, "open in team A11"), "open in team A11", "the tickets.pick canary, when the setting names a team");
});

test("A11-108: an empty scope says who it asked for and names the other chips and tickets.pick; Anyone is never empty", () => {
  const you = scopeEmptyText(YOU, DAN);
  assert.ok(you?.startsWith("No open tickets are assigned to Dan Beck, whose Linear key this board reads with."), you ?? "");
  assert.ok(you?.includes("The Assignee row shows Anyone and Unassigned") && you.includes('Set tickets.pick in the host file to { "team": "<key>" }'), you ?? "");
  assert.ok(scopeEmptyText(UNASSIGNED, DAN)?.startsWith("No open ticket is unassigned."));
  assert.equal(scopeEmptyText(ANYONE, DAN), null);
  assert.ok(NO_VIEWER.includes("could not say whose key"));
});

test("A11-108: a row names its owner whenever the list is not the signed-in person's own, and says Unassigned for a ticket nobody has", () => {
  assert.equal(showsOwner(YOU), false);
  assert.equal(showsOwner(ANYONE), true);
  assert.equal(showsOwner(UNASSIGNED), true);
  assert.equal(showsOwner("ana"), true);
  assert.equal(ownerName({ key: "A-3", assignee: null }), "Unassigned");
  assert.equal(ownerName({ key: "A-2", assignee: ANA }), "Ana Ruiz");
});
