// no-token: none -- pure: the tracker states are given here, and nothing is read
import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultTakenStates, takenRefusal, takenState } from "./pick-taken.ts";

const TAKEN_BY_DEFAULT = ["In Progress", "Planned"];

test("a ticket in a state of the started type is taken, whatever the states list names, and the state's name is what the page says", () => {
  assert.equal(takenState({ status: "In Progress", statusType: "started" }, []), "In Progress");
  assert.equal(takenState({ status: "In Review", statusType: "started" }, TAKEN_BY_DEFAULT), "In Review");
});

test("a ticket in a state the list names is taken, and one in no such state is not", () => {
  assert.equal(takenState({ status: "Planned", statusType: "unstarted" }, TAKEN_BY_DEFAULT), "Planned");
  assert.equal(takenState({ status: "Backlog", statusType: "backlog" }, TAKEN_BY_DEFAULT), null);
  assert.equal(takenState({ status: "Backlog" }, []), null, "a ticket with no state type, in a state no list names, is not taken");
});

test("with no takenStates list, the working and planned states the tracker sets are the ones taken", () => {
  assert.deepEqual(defaultTakenStates("In Progress", "Planned"), TAKEN_BY_DEFAULT);
  assert.deepEqual(defaultTakenStates(null, "Planned"), ["Planned"], "a state the tracker does not set is not in the list");
  assert.deepEqual(defaultTakenStates(null, null), []);
  assert.deepEqual(defaultTakenStates(" In Progress ", undefined), ["In Progress"], "a state's name is trimmed");
});

test("the refusal names the ticket, its state and why it is refused here", () => {
  assert.equal(takenRefusal("NBF-7", "In Progress"), "NBF-7 is In Progress in the tracker and this instance has no run for it, so another instance holds it");
});
