// no-token: gh -- the outcomes and tool results are handed in as JSON text and files in a temporary folder; nothing here spawns anything
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "../lib/tmp-fixture.ts";
import { CREATED_FILE, MAX_CREATED, createdKeyOf, createdKeysOf, parseWriterOutcome, readCreatedKeys } from "./writer.ts";
import * as limits from "./writer-limits.ts";
import { inPickScope } from "./pick-scope.ts";

/** How a tracker's creation names the ticket it made: under `issue` when it wraps it, as `identifier` or else `id` (the shape a tracker plugin declares in its manifest). */
const SHAPE = { wrapper: "issue", fields: ["identifier", "id"] };
const keyOf = (response: unknown): string | null => createdKeyOf(response, SHAPE);

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
  assert.equal(keyOf({ identifier: "A11-140", title: "x" }), "A11-140");
  // Linear's own MCP answers with the key as `id`, as its get_issue does.
  assert.equal(keyOf({ id: "A11-135", title: "x", url: "https://linear.app/x" }), "A11-135");
  assert.equal(keyOf([{ type: "text", text: JSON.stringify({ issue: { identifier: "A11-141" } }) }]), "A11-141");
  assert.equal(keyOf({ content: [{ type: "text", text: JSON.stringify({ id: "A11-142" }) }] }), "A11-142");
  assert.equal(keyOf(JSON.stringify({ identifier: "A11-143" })), "A11-143");
  assert.equal(createdKeyOf({ issue: { identifier: "A11-144" } }, { wrapper: null, fields: ["key"] }), null, "a shape with no wrapper reads the answer itself, and only the fields it names");
  assert.equal(createdKeyOf({ ticket: { key: "A11-145" } }, { wrapper: "ticket", fields: ["key"] }), "A11-145", "another tracker's shape is its manifest's");
});

test("A11-135: a result that names no ticket key gives none, so the hook refuses to record it", () => {
  assert.equal(keyOf({ content: [{ type: "text", text: "Created the issue." }] }), null);
  assert.equal(keyOf({ id: "7d1c5e2a-0000-4000-8000-000000000001" }), null);
  assert.equal(keyOf(undefined), null);
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

test("A11-134: a decided outcome names the ticket it answered, and one that names no ticket key is refused", () => {
  assert.deepEqual(parseWriterOutcome('{ "kind": "decided", "ticket": "NBF-7" }'), { kind: "decided", ticket: "NBF-7", created: [] });
  assert.match(parseWriterOutcome('{ "kind": "decided", "ticket": "seven" }') as string, /names no ticket key, such as A11-12/);
});

test("A11-199: the limits are defined once, in a module free of Node, and the writer re-exports the run's", () => {
  assert.deepEqual([limits.WRITER_REQUEST_CHARS, limits.MAX_CREATED], [8000, 10]);
  assert.equal(MAX_CREATED, limits.MAX_CREATED);
});

test("A11-302: a verifier run's and a migration pass's outcomes are read by their mode, and a new-ticket run's kinds are not theirs", () => {
  assert.deepEqual(parseWriterOutcome('{ "kind": "failed", "evidence": "still 0.4.1" }', "verify"), { kind: "verified", verdict: { kind: "failed", evidence: "still 0.4.1" }, created: [] });
  assert.match(parseWriterOutcome('{ "kind": "created", "created": ["A11-1"] }', "verify") as string, /a verifier run ends on/);
  assert.deepEqual(parseWriterOutcome('{ "kind": "needs-human", "reason": "no host" }', "verify"), { kind: "needs-human", reason: "no host", created: [] });
  const migrated = parseWriterOutcome('{ "kind": "migrated", "checks": [{ "id": "A11-1#1", "runner": "agent", "evidence": "x" }] }', "migrate");
  assert.ok(typeof migrated === "object" && migrated.kind === "migrated" && migrated.entries.length === 1);
  assert.match(parseWriterOutcome('{ "kind": "migrated", "checks": [] }', "migrate") as string, /lists its checks/);
  assert.match(parseWriterOutcome('{ "kind": "migrated", "checks": [{ "id": "A11-1#1" }] }', "quick") as string, /which a new-ticket run cannot end on/);
  assert.match(parseWriterOutcome('{ "kind": "passed", "evidence": "x" }') as string, /which a new-ticket run cannot end on/);
});
