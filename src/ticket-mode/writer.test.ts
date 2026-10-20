// no-token: gh -- the outcomes and tool results are handed in as JSON text and files in a temporary folder; nothing here spawns anything
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "../lib/tmp-fixture.ts";
import { CREATED_FILE, createdKeyOf, createdKeysOf, parseWriterOutcome, readCreatedKeys } from "./writer.ts";
import { inPickScope } from "./pick-scope.ts";

test("A11-135: a created outcome names the keys it made, and a run that made none cannot end created", () => {
  assert.deepEqual(parseWriterOutcome('{ "kind": "created", "created": ["A11-140", "A11-141"] }'), { kind: "created", created: ["A11-140", "A11-141"] });
  assert.match(parseWriterOutcome('{ "kind": "created", "created": [] }') as string, /names no ticket/);
  assert.match(parseWriterOutcome('{ "kind": "created" }') as string, /names no ticket/);
});

test("A11-135: a key that is not a ticket key is refused by name, and an outcome of any other kind is refused", () => {
  assert.match(parseWriterOutcome('{ "kind": "created", "created": ["not a key"] }') as string, /"not a key", which is not a ticket key/);
  assert.match(parseWriterOutcome('{ "kind": "created", "created": "A11-140" }') as string, /is not a list of ticket keys/);
  assert.match(parseWriterOutcome('{ "kind": "drafted" }') as string, /cannot end on/);
  assert.match(parseWriterOutcome("not json") as string, /not valid JSON/);
  assert.match(parseWriterOutcome('{ "reason": "x" }') as string, /names no kind/);
});

test("A11-135: a needs-human outcome gives its reason, and keeps any ticket it made before it stopped", () => {
  assert.deepEqual(parseWriterOutcome('{ "kind": "needs-human", "reason": "no team", "created": ["A11-140"] }'),
    { kind: "needs-human", reason: "no team", created: ["A11-140"] });
  assert.deepEqual(parseWriterOutcome('{ "kind": "needs-human", "reason": "no team" }'), { kind: "needs-human", reason: "no team", created: [] });
  assert.match(parseWriterOutcome('{ "kind": "needs-human", "reason": " " }') as string, /gives no reason/);
});

test("A11-135: a creation's key is read from the result the tracker's tool returned, in any of its shapes", () => {
  assert.equal(createdKeyOf({ identifier: "A11-140", title: "x" }), "A11-140");
  // Linear's own MCP answers with the key as `id`, as its get_issue does.
  assert.equal(createdKeyOf({ id: "A11-135", title: "x", url: "https://linear.app/x" }), "A11-135");
  assert.equal(createdKeyOf([{ type: "text", text: JSON.stringify({ issue: { identifier: "A11-141" } }) }]), "A11-141");
  assert.equal(createdKeyOf({ content: [{ type: "text", text: JSON.stringify({ id: "A11-142" }) }] }), "A11-142");
  assert.equal(createdKeyOf(JSON.stringify({ identifier: "A11-143" })), "A11-143");
});

test("A11-135: a result that names no ticket key gives none, so the hook refuses to record it", () => {
  assert.equal(createdKeyOf({ content: [{ type: "text", text: "Created the issue." }] }), null);
  assert.equal(createdKeyOf({ id: "7d1c5e2a-0000-4000-8000-000000000001" }), null);
  assert.equal(createdKeyOf(undefined), null);
});

test("A11-135: the record reads one key per line, and a line that is not a key makes the whole record unreadable", () => {
  assert.deepEqual(createdKeysOf('{"identifier":"A11-140"}\n{"identifier":"A11-141"}\n'), ["A11-140", "A11-141"]);
  assert.deepEqual(createdKeysOf(""), []);
  assert.equal(createdKeysOf('{"identifier":"A11-140"}\nnot json\n'), null);
  assert.equal(createdKeysOf('{"identifier":"x"}\n'), null);
});

test("A11-135: the record is read from the run's folder: none when there is none, and null when it cannot be read", () => {
  const dir = tmpDir("writer-record");
  assert.deepEqual(readCreatedKeys(dir), [], "no record yet: nothing was created");
  writeFileSync(join(dir, CREATED_FILE), '{"identifier":"A11-150"}\n');
  assert.deepEqual(readCreatedKeys(dir), ["A11-150"]);
  assert.equal(readCreatedKeys(dir, () => { throw new Error("EACCES"); }), null, "a record that cannot be read is not trusted");
});

test("A11-135: Pick lists a created ticket when it is assigned, in the team or project Pick names, and not otherwise", () => {
  const ticket = { team: "NBF", project: "Board" };
  assert.equal(inPickScope("assigned", { team: "OTHER", project: null }), true);
  assert.equal(inPickScope({ team: "NBF" }, ticket), true);
  assert.equal(inPickScope({ team: "A11" }, ticket), false);
  assert.equal(inPickScope({ project: "Board" }, ticket), true);
  assert.equal(inPickScope({ project: "Other" }, ticket), false);
});
