// no-token: gh -- the splice is pure: it edits texts written in the test, and touches no file, no route and no process
import { test } from "node:test";
import assert from "node:assert/strict";
import { spliceJson } from "./json-edit.ts";

/** A file shaped like the real host file: prose keys between keys, two-space indent, and no final newline. */
const HOST = `{
  "_about": "Prose the page never changes.",
  "schema": 1,
  "tickets": {
    "_note": "Kept as written.",
    "port": 4747,
    "drafts": true,
    "_after": "Also kept."
  },
  "clones": { "nbl-ui-netbox": "/r/netbox" }
}`;

test("a value is replaced and every byte outside it is kept: prose, key order, indentation and the missing final newline", () => {
  const next = spliceJson(HOST, [{ path: ["tickets", "port"], value: 4800 }]);
  assert.equal(next, HOST.replace("\"port\": 4747", "\"port\": 4800"));
  assert.equal(next.endsWith("}"), true, "no final newline is added");
});

test("a value written as an object or a list is laid out as its siblings are", () => {
  const next = spliceJson(HOST, [{ path: ["tickets", "deny"], value: [{ pattern: "rm -rf", reason: "no" }] }]);
  assert.match(next, /\n    "deny": \[\n      \{\n        "pattern": "rm -rf",\n        "reason": "no"\n      \}\n    \]\n  \}/);
  assert.equal(next.split("\n").filter((line) => line.includes("\"_note\"")).length, 1, "the prose key is still there, once");
});

test("a key is removed with its separator, the key before it or after it keeping its line", () => {
  assert.equal(spliceJson(HOST, [{ path: ["tickets", "port"], remove: true }]), HOST.replace("    \"port\": 4747,\n", ""));
  assert.equal(spliceJson(HOST, [{ path: ["tickets", "_after"], remove: true }]), HOST.replace(",\n    \"_after\": \"Also kept.\"", ""));
});

test("a removal of a key the file does not hold changes nothing", () => {
  assert.equal(spliceJson(HOST, [{ path: ["tickets", "uiPort"], remove: true }]), HOST);
});

test("a new key is added at the end of its object, indented as its siblings are", () => {
  const next = spliceJson(HOST, [{ path: ["tickets", "stallMinutes"], value: 12 }]);
  assert.equal(next, HOST.replace("\"_after\": \"Also kept.\"\n  }", "\"_after\": \"Also kept.\",\n    \"stallMinutes\": 12\n  }"));
});

test("a key under a key the file does not hold adds the rest of the path, as nested objects", () => {
  const next = spliceJson(HOST, [{ path: ["tickets", "linearKey", "path"], value: "/k/linear" }]);
  assert.deepEqual(JSON.parse(next).tickets.linearKey, { path: "/k/linear" });
  assert.match(next, /"_after": "Also kept\.",\n    "linearKey": \{\n      "path": "\/k\/linear"\n    \}\n  \}/);
});

test("an object written on one line takes its new member on that line", () => {
  const next = spliceJson(HOST, [{ path: ["clones", "my.repo"], value: "/r/my.repo" }]);
  assert.equal(next, HOST.replace("\"/r/netbox\" }", "\"/r/netbox\", \"my.repo\": \"/r/my.repo\" }"));
});

test("an empty object gets its first member one step in, and the file's line ends are kept", () => {
  const crlf = "{\r\n  \"a\": {}\r\n}";
  const next = spliceJson(crlf, [{ path: ["a", "b"], value: 1 }]);
  assert.equal(next, "{\r\n  \"a\": {\r\n    \"b\": 1\r\n  }\r\n}");
});

test("a CRLF file keeps its line ends in what is added, and its last line break", () => {
  const text = "{\r\n  \"_about\": \"x\",\r\n  \"tickets\": {\r\n    \"port\": 4747\r\n  }\r\n}\r\n";
  const next = spliceJson(text, [{ path: ["tickets", "drafts"], value: false }]);
  assert.equal(next, text.replace("\"port\": 4747", "\"port\": 4747,\r\n    \"drafts\": false"));
  assert.equal(next.split("\n").every((line) => line === "" || line.endsWith("\r")), true, "every line ends CRLF");
});

const NEW_PORT = 9000;

test("several edits are made in order, each to the text the one before it made", () => {
  const next = spliceJson(HOST, [{ path: ["tickets", "port"], remove: true }, { path: ["tickets", "port"], value: NEW_PORT }]);
  assert.equal(JSON.parse(next).tickets.port, NEW_PORT);
});

test("a path through a value that is not an object is refused, naming the path", () => {
  assert.throws(() => spliceJson(HOST, [{ path: ["schema", "x"], value: 1 }]), /schema is not an object, so schema\.x cannot be set inside it/);
});

test("a key the object holds twice is refused, naming the path, since a parse keeps only the last of them", () => {
  assert.throws(() => spliceJson("{\"a\": {\"b\": 1, \"b\": 2}}", [{ path: ["a", "b"], value: 3 }]), /the key a\.b appears 2 times in its object/);
});

test("a file whose top level is not an object is refused", () => {
  assert.throws(() => spliceJson("[1, 2]", [{ path: ["a"], value: 1 }]), /top level is not an object/);
});

test("an edit with nothing to change returns the same bytes", () => {
  assert.equal(spliceJson(HOST, [{ path: ["tickets", "drafts"], value: true }]), HOST);
});
