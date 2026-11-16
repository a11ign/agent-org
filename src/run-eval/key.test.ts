// no-token: gh -- pure functions over a host file's text and the schema
/** A11-431, step 2 of 2: one switch of the host file turned on or off for an eval run, in the eval's own read of the file, never a name the worker is not handed. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseKey, switchesOf, withKey } from "./key.ts";
import { SCHEMA } from "../ticket-mode/config-schema.ts";

test("the switches a run may set are the host file's switches the eval hands its worker, and no other key", () => {
  assert.deepEqual(switchesOf(SCHEMA), ["tickets.drafts"], "tickets.capture is a switch, but the eval's brief offers no screenshot whatever it says");
  assert.deepEqual(switchesOf(SCHEMA, ["tickets.drafts", "tickets.max", "tickets.lessons"]), ["tickets.drafts"], "a handed key the schema has no switch for is none");
});

test("--key reads <switch>=on or <switch>=off, and refuses another shape or a key that is not a switch the worker is handed, naming it", () => {
  assert.deepEqual(parseKey("tickets.drafts=on", SCHEMA), { name: "tickets.drafts", on: true });
  assert.deepEqual(parseKey("tickets.drafts=off", SCHEMA), { name: "tickets.drafts", on: false });
  assert.throws(() => parseKey("tickets.drafts=yes", SCHEMA), /--key tickets\.drafts=yes is not <key>=on or <key>=off/);
  assert.throws(() => parseKey("tickets.draft=on", SCHEMA), /--key tickets\.draft is not a switch the eval hands its worker; the switches it hands on are tickets\.drafts/);
  assert.throws(() => parseKey("tickets.capture=on", SCHEMA), /--key tickets\.capture is not a switch the eval hands its worker/, "a switch the eval does not hand on would change nothing");
});

test("the host file's text is given the switch, the objects on its path made where missing, and every other key kept", () => {
  const host = JSON.stringify({ clones: { a: "/a" }, tickets: { max: 3, capture: false } });
  assert.deepEqual(JSON.parse(withKey(host, { name: "tickets.capture", on: true })), { clones: { a: "/a" }, tickets: { max: 3, capture: true } });
  assert.deepEqual(JSON.parse(withKey(JSON.stringify({ clones: {} }), { name: "workers.haikuBrief", on: false })), { clones: {}, workers: { haikuBrief: false } });
  assert.throws(() => withKey(JSON.stringify({ tickets: [] }), { name: "tickets.capture", on: true }), /tickets in the host file is not an object, so tickets\.capture cannot be set/);
  assert.throws(() => withKey("[]", { name: "tickets.capture", on: true }), /the host file is not a JSON object/);
});
