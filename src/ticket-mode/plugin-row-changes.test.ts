// no-token: none -- pure, and a scratch state folder: no plugin runs and nothing is read from GitHub
//
// A11-274: the board says a plugin's failing doctor row once on its log (the `merge flow` row's repositories without the merge flow, to the chairman's session), again when what it says changes, and once when it passes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "../lib/tmp-fixture.ts";
import { changesOf, SAID_FILE, sayRowChanges } from "./plugin-row-changes.ts";

const failing = (detail: string) => ({ name: "merge flow", ok: false, detail, fix: "add the flow" });
const passing = { name: "merge flow", ok: true, detail: "every repository has a merge flow", fix: null };

test("A11-274: a failing row is said once with its fix, again when its detail changes, and once when it passes", () => {
  const first = changesOf({}, { github: [failing("a11ign/.github: no merge queue"), { ...passing, name: "stacked pull requests" }] });
  assert.deepEqual(first.lines, ["plugin github: merge flow fails: a11ign/.github: no merge queue (fix: add the flow)"], "a passing row never said failing says nothing");
  assert.deepEqual(changesOf(first.said, { github: [failing("a11ign/.github: no merge queue")] }).lines, [], "the same detail is not said again");
  const changed = changesOf(first.said, { github: [failing("a11ign/new: auto-merge is not allowed")] });
  assert.deepEqual(changed.lines, ["plugin github: merge flow fails: a11ign/new: auto-merge is not allowed (fix: add the flow)"]);
  const passed = changesOf(changed.said, { github: [passing] });
  assert.deepEqual([passed.lines, passed.said], [["plugin github: merge flow passes now"], {}]);
  assert.deepEqual(changesOf(passed.said, { github: [passing] }).lines, [], "and is not said passing again");
});

test("A11-274: a plugin not checked in a run keeps what was said of it, and a row a checked plugin no longer has is forgotten silently", () => {
  const said = { "github/merge flow": "a11ign/.github: no merge queue", "linear/token": "no token" };
  const { lines, said: next } = changesOf(said, { linear: [] });
  assert.deepEqual([lines, next], [[], { "github/merge flow": "a11ign/.github: no merge queue" }]);
});

test("A11-274: what was said is kept in the state folder, so a board that restarts says nothing it has said; an unreadable record says it again", () => {
  const dir = tmpDir("plugin-row-changes-");
  const said: string[] = [];
  const rows = { github: [failing("a11ign/.github: no merge queue")] };
  sayRowChanges(dir, rows, (line) => { said.push(line); });
  sayRowChanges(dir, rows, (line) => { said.push(line); });
  assert.equal(said.length, 1);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, SAID_FILE), "utf8")), { "github/merge flow": "a11ign/.github: no merge queue" });
  writeFileSync(join(dir, SAID_FILE), "not json");
  sayRowChanges(dir, rows, (line) => { said.push(line); });
  assert.equal(said.length, 2);
  sayRowChanges(join(dir, "absent"), rows, (line) => { said.push(line); });
  assert.equal(said.length, 3, "a record that cannot be written leaves the change to be said again");
});
