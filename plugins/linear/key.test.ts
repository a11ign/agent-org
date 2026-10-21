// no-token: none -- the key is read through injected seams; no Keychain or file is touched
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_KEYCHAIN_SERVICE, describeSource, keySource, placeOf, readLinearKey } from "./key.ts";

test("an absent key setting is the Keychain's default service, and a service or an absolute path is read as it is", () => {
  assert.deepEqual(keySource(undefined), { keychain: DEFAULT_KEYCHAIN_SERVICE });
  assert.equal(DEFAULT_KEYCHAIN_SERVICE, "agent-org-linear");
  assert.deepEqual(keySource({ keychain: "other-service" }), { keychain: "other-service" });
  assert.deepEqual(keySource({ path: "/home/me/.config/linear.key" }), { path: "/home/me/.config/linear.key" });
});

test("a key setting of any other shape is refused by name, at start: both a service and a path, no service, a relative path, a bare string", () => {
  assert.throws(() => keySource({ keychain: "x", path: "/y" }), /^Error: tickets\.providers\.tracker\.key must be \{ "keychain": "<service>" \} or \{ "path": "\/abs\/file" \}$/);
  assert.throws(() => keySource({ keychain: "" }), /tickets\.providers\.tracker\.key must be \{ "keychain": "<service>" \} or \{ "path": "\/abs\/file" \}/);
  assert.throws(() => keySource("file"), /tickets\.providers\.tracker\.key must be \{ "keychain"/);
  assert.throws(() => keySource({ path: "rel" }), /tickets\.providers\.tracker\.key\.path must be an absolute path, such as "\/home\/me\/\.config\/linear\.key", not "rel"/);
  assert.throws(() => keySource({}), /tickets\.providers\.tracker\.key\.path must be an absolute path/, "an object naming neither is read as a file with no path");
  assert.throws(() => keySource({ path: "rel" }, "tickets.linearKey"), /tickets\.linearKey\.path must be an absolute path/, "the refusal names the key it was read from");
});

test("the key comes from the Keychain service or the file the host file names, and an empty one is refused", () => {
  const calls: string[][] = [];
  assert.equal(readLinearKey({ keychain: "agent-org-linear" }, (args) => { calls.push(args); return "lin_api_x\n"; }), "lin_api_x");
  assert.deepEqual(calls, [["find-generic-password", "-s", "agent-org-linear", "-w"]]);
  assert.equal(readLinearKey({ path: "/k" }, () => { throw new Error("not used"); }, () => " lin_api_y \n"), "lin_api_y");
  assert.throws(() => readLinearKey({ keychain: "s" }, () => "\n"), /is empty/);
  assert.throws(() => readLinearKey({ keychain: "agent-org-linear" }, () => { throw new Error("SecKeychainSearchCopyNext"); }),
    /no Linear key in the Keychain under agent-org-linear\. Store one with: security add-generic-password/);
  assert.throws(() => readLinearKey({ path: "/nope" }, () => "", () => { throw new Error("ENOENT"); }), /cannot be read/);
});

test("a source is described in the words of a row (doctor) and of a sentence (onboard)", () => {
  assert.equal(describeSource({ keychain: "agent-org-linear" }), "Keychain service agent-org-linear");
  assert.equal(describeSource({ path: "/k/linear.key" }), "/k/linear.key");
  assert.equal(placeOf({ keychain: "agent-org-linear" }), "the Keychain service agent-org-linear");
  assert.equal(placeOf({ path: "/k/linear.key" }), "the file /k/linear.key");
});
