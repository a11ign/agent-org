// no-token: none -- the files and the keys are in-memory; nothing is read from or written to disk
import { test } from "node:test";
import assert from "node:assert/strict";
import { houseNotes, REVIEW_NOTES, WORKER_NOTES } from "./house-notes.ts";

const HOME = "/home/me";
const EXISTS = (...paths: string[]) => (path: string) => paths.includes(path);
const NOTHING = () => {
  throw new Error("must not be read");
};

test("the house notes are written where absent, beside the host file, and named under tickets.brief and tickets.review", () => {
  const notes = houseNotes({ env: {}, home: HOME, keys: {}, exists: EXISTS(), read: NOTHING });
  assert.deepEqual(notes.writes, [
    { path: "/home/me/.agent-org/worker-notes.md", text: WORKER_NOTES },
    { path: "/home/me/.agent-org/review-notes.md", text: REVIEW_NOTES },
  ]);
  assert.deepEqual(notes.keys, { brief: "/home/me/.agent-org/worker-notes.md", review: "/home/me/.agent-org/review-notes.md" });
});

test("a note already named, or a file already there, is kept and not overwritten, and its key is not set", () => {
  const named = houseNotes({ env: {}, home: HOME, keys: { brief: "/elsewhere/brief.md" }, exists: EXISTS(), read: NOTHING });
  assert.deepEqual(named.keys, { review: "/home/me/.agent-org/review-notes.md" }, "the named brief is left alone");
  const present = houseNotes({ env: {}, home: HOME, keys: {}, exists: EXISTS("/home/me/.agent-org/worker-notes.md"), read: NOTHING });
  assert.deepEqual(present.writes.map(({ path }) => path), ["/home/me/.agent-org/review-notes.md"]);
  assert.ok(present.lines.includes("/home/me/.agent-org/worker-notes.md exists, so it is kept and not overwritten, and tickets.brief is not set"));
});

test("an organisation's own notes travel in the profile: the file it names is copied instead of the shipped text", () => {
  const notes = houseNotes({ env: {}, home: HOME, keys: {}, exists: EXISTS(), read: (path) => `copied from ${path}`, profile: { worker: "/profiles/worker.md" } });
  assert.equal(notes.writes[0].text, "copied from /profiles/worker.md");
  assert.equal(notes.writes[1].text, REVIEW_NOTES, "a note the profile does not name ships as it is");
});

test("the shipped text names no organisation, plugin, decision record or account, and states the outcome shapes", () => {
  for (const text of [WORKER_NOTES, REVIEW_NOTES]) {
    assert.ok(!/a11ign|ADR|chairman|fleet|ansible|slack/i.test(text), `names an organisation's own thing: ${text.slice(0, 60)}`);
  }
  assert.ok(WORKER_NOTES.includes("{ \"kind\": \"ready-pr\", \"prs\": [ { \"repo\": \"owner/repo\", \"url\": \"https://github.com/owner/repo/pull/1\" } ]"));
  assert.ok(WORKER_NOTES.includes("## Proof before merge"));
});
