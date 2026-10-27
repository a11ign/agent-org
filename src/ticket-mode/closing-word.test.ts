// no-token: none -- pure
import { test } from "node:test";
import assert from "node:assert/strict";
import { closingWordOf } from "./closing-word.ts";

const A = "https://github.com/a11ign/a/pull/1";
const B = "https://github.com/a11ign/b/pull/2";

test("A11-274: a pull request of a step that is not the plan's last says Refs, even with every sibling merged", () => {
  assert.deepEqual(closingWordOf({ key: "A11-1", step: { step: 1, of: 2 }, siblings: [] }), { key: "A11-1", word: "refs", open: [], merged: [] });
  assert.equal(closingWordOf({ key: "A11-1", step: { step: 1, of: 2 }, siblings: [{ url: A, state: "merged" }] }).word, "refs");
});

test("A11-274: on the last step, a pull request with a sibling still open says Refs, and names the open one", () => {
  assert.deepEqual(closingWordOf({ key: "A11-1", step: { step: 2, of: 2 }, siblings: [{ url: A, state: "open" }, { url: B, state: "merged" }] }), { key: "A11-1", word: "refs", open: [A], merged: [B] });
});

test("A11-274: on the last step, a pull request whose siblings have all merged says Closes, and names them", () => {
  assert.deepEqual(closingWordOf({ key: "A11-1", step: { step: 2, of: 2 }, siblings: [{ url: A, state: "merged" }, { url: B, state: "merged" }] }), { key: "A11-1", word: "closes", open: [], merged: [A, B] });
});

test("A11-274: a one-step ticket's pull request with no siblings says Closes, and a step that is not named is read as one step", () => {
  assert.deepEqual(closingWordOf({ key: "A11-1", step: null, siblings: [] }), { key: "A11-1", word: "closes", open: [], merged: [] });
  assert.equal(closingWordOf({ key: "A11-1", step: null, siblings: [{ url: A, state: "open" }] }).word, "refs", "a sibling still open keeps it Refs whatever the step");
});

test("A11-274: a sibling closed without merging is neither open nor merged, and decides nothing", () => {
  assert.deepEqual(closingWordOf({ key: "A11-1", step: null, siblings: [{ url: A, state: "closed" }] }), { key: "A11-1", word: "closes", open: [], merged: [] });
});
