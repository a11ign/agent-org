// no-token: gh -- one file in a temporary directory, on a clock the test moves
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpDir } from "../lib/tmp-fixture.ts";
import { browserSessions, browserSessionsPath, SESSION_SECONDS } from "./browser-sessions.ts";

test("a session the board opened is held across a restart, in a file only its owner can read, which keeps no session itself", () => {
  const path = browserSessionsPath(tmpDir("browser-sessions-"));
  const session = browserSessions(path).open();
  assert.match(session, /^[0-9a-f]{48}$/);
  assert.equal(browserSessions(path).holds(session), true, "a restarted board reads the file again");
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(readFileSync(path, "utf8").includes(session), false, "the file holds hashes, so reading it pairs nothing");
  assert.equal(browserSessions(path).holds("f".repeat(48)), false);
});

test("a session expires after a year, and an expired one is dropped from the file when the next opens", () => {
  const path = browserSessionsPath(tmpDir("browser-sessions-expiry-"));
  let at = 1_000;
  const sessions = browserSessions(path, () => at);
  const old = sessions.open();
  at += SESSION_SECONDS * 1000 - 1;
  assert.equal(sessions.holds(old), true);
  at += 1;
  assert.equal(sessions.holds(old), false);
  sessions.open();
  assert.equal(Object.keys(JSON.parse(readFileSync(path, "utf8"))).length, 1);
});

test("a sessions file that does not hold sessions is refused, with how to fix it, rather than unpairing every browser without a word", () => {
  const path = browserSessionsPath(tmpDir("browser-sessions-junk-"));
  browserSessions(path).open();
  for (const junk of ["not json", "null", "[]", JSON.stringify({ "not-a-hash": 1 }), JSON.stringify({ ["a".repeat(64)]: "soon" })]) {
    writeFileSync(path, junk);
    assert.throws(() => browserSessions(path), /does not hold the board's browser sessions: delete it, which unpairs every browser/, junk);
  }
});
