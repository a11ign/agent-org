// no-token: gh -- pure functions over a pull request body's text
import { test } from "node:test";
import assert from "node:assert/strict";
import { blockedByIn, ownerOfRed } from "./ticket-references.ts";

test("A11-179: a body's Blocked-by lines name their tickets in the order written, each once, with a list marker, bold or a list around them, and a word that is no ticket's key names none", () => {
  assert.deepEqual(blockedByIn("Refs A11-179\n\nBlocked-by: A11-127"), ["A11-127"]);
  assert.deepEqual(blockedByIn("- **Blocked-by:** A11-127, NBL-9 and the gate\nblocked-by: A11-127\n  Blocked-by: `A11-130`"), ["A11-127", "NBL-9", "A11-130"]);
  assert.deepEqual(blockedByIn("Blocked-by: #12, the old gate, UTF8"), [], "a pull request number and prose are no ticket");
  assert.deepEqual(blockedByIn("This is Blocked-by: A11-127 in the middle of a line.\nBlockedby A11-1\n"), [], "the line starts with the label");
  assert.deepEqual(blockedByIn(""), []);
});

test("A11-179: the owner of a red check is a Blocked-by ticket other than the run's own, else a key of the run's team in the check's lines, else none", () => {
  assert.equal(ownerOfRed("A11-177", "Blocked-by: A11-177, A11-127", ["REFUSED -- A11-130"]), "A11-127", "the body first, and never the run's own key");
  assert.equal(ownerOfRed("A11-177", "", ["not ok - UTF-8", "REFUSED -- a11-127 retires this check"]), "a11-127", "the refusal text, whatever case it writes the key in");
  assert.equal(ownerOfRed("A11-177", "", ["SHA-256 mismatch", "ISO-8601", "A11-177 is the run's own"]), null, "words shaped like keys, and the run's own key, name no owner");
  assert.equal(ownerOfRed("A11-177", "Blocked-by: NBL-9", []), "NBL-9", "a Blocked-by ticket may be of another team: it is named on purpose");
});
