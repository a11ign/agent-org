// no-token: none -- pure: the tracker states are given here, and nothing is read
import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultTakenStates, takenRefusal, takenState } from "./pick-taken.ts";

const TAKEN_BY_DEFAULT = ["In Progress", "Planned"];
const SELF = "laptop.ab12cd34";
const OTHER = "desk.99999999";

test("A11-168: a ticket in a taken state is taken only when its latest claim names another claimant (no claim, own claim, another's claim)", () => {
  const working = { status: "In Progress", statusType: "started" };
  assert.equal(takenState(working, TAKEN_BY_DEFAULT, undefined, SELF), null, "no claim: moved by hand, or by an instance older than the claim, so nobody holds it");
  assert.equal(takenState(working, TAKEN_BY_DEFAULT, SELF, SELF), null, "this instance's own claim: its own finished run left it In Progress");
  assert.equal(takenState(working, TAKEN_BY_DEFAULT, OTHER, SELF), "In Progress", "another instance's claim");
});

test("a ticket in a state of the started type is taken by another's claim whatever the states list names, and the state's name is what the page says", () => {
  assert.equal(takenState({ status: "In Progress", statusType: "started" }, [], OTHER, SELF), "In Progress");
  assert.equal(takenState({ status: "In Review", statusType: "started" }, TAKEN_BY_DEFAULT, OTHER, SELF), "In Review");
});

test("a ticket in a state the list names is taken by another's claim, and one in no such state is not, whatever its claim says", () => {
  assert.equal(takenState({ status: "Planned", statusType: "unstarted" }, TAKEN_BY_DEFAULT, OTHER, SELF), "Planned");
  assert.equal(takenState({ status: "Backlog", statusType: "backlog" }, TAKEN_BY_DEFAULT, OTHER, SELF), null, "put back in Todo or the Backlog, a claim holds nothing");
  assert.equal(takenState({ status: "Backlog" }, [], OTHER, SELF), null, "a ticket with no state type, in a state no list names, is not taken");
});

test("with no takenStates list, the working and planned states the tracker sets are the ones taken", () => {
  assert.deepEqual(defaultTakenStates("In Progress", "Planned"), TAKEN_BY_DEFAULT);
  assert.deepEqual(defaultTakenStates(null, "Planned"), ["Planned"], "a state the tracker does not set is not in the list");
  assert.deepEqual(defaultTakenStates(null, null), []);
  assert.deepEqual(defaultTakenStates(" In Progress ", undefined), ["In Progress"], "a state's name is trimmed");
});

test("the refusal names the ticket, its state and the claimant that holds it", () => {
  assert.equal(takenRefusal("NBF-7", "In Progress", OTHER), "NBF-7 is In Progress in the tracker and desk.99999999 claimed it, so another instance holds it");
});
