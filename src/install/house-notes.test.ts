// no-token: none -- the files and the keys are in-memory; nothing is read from or written to disk
import { test } from "node:test";
import assert from "node:assert/strict";
import { escalationList } from "../ticket-mode/escalation.ts";
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

test("A11-257: the shipped notes end a run on checked, or on needs-human only for an item of the escalation list, which they quote, and send every other choice to the pull request body", () => {
  const ending = WORKER_NOTES.slice(WORKER_NOTES.indexOf("## Ending a run"));
  assert.ok(ending.includes("Use `needs-human` only for an item on the escalation list, and name its id in `escalation`."));
  assert.ok(ending.includes(escalationList()), "the list is quoted from its module");
  assert.ok(ending.includes("Everything else you decide yourself, in line with the plan and the ticket's Decisions, and list under \"Decisions made without a person\" in the pull request body."));
  assert.ok(WORKER_NOTES.includes("{ \"kind\": \"needs-human\", \"reason\": \"the one thing only they can do\", \"escalation\": \"<id>\" }"));
});

test("A11-173: the opening-a-pull-request line says a partial is a plan step and never an After-merge line, and pull requests that finish a ticket together each say Refs", () => {
  const line = WORKER_NOTES.split("\n").find((text) => text.startsWith("- **Opening a pull request:**")) ?? "";
  assert.ok(line.includes("`Refs <ticket key>` with a `Partial: <what remains>` line when it does not (a plan step, `step <N> of <M>`, never an After-merge line of the Done-when: a pull request that leaves only those names the ticket `Closes`;"));
  assert.ok(line.includes("pull requests that finish the ticket together each say `Refs`, with the others named in their `Partial:` line and no `partial` in the outcome)"));
});

test("A11-245: the shipped working lines say to declare a wait the board reads and end the turn, to write no wait loop, and keep the line for a worker's own background work", () => {
  const lines = WORKER_NOTES.split("\n");
  const declared = lines.find((line) => line.startsWith("- Waiting on events the board reads for you")) ?? "";
  assert.ok(declared.includes("\"waitingOn\": [ { \"<event>\": \"<id>\" } ], \"until\": \"<ISO time>\" }"), "the declared shape, with its deadline");
  assert.ok(declared.includes("then END YOUR TURN") && declared.includes("the board prompts you when all of them have finished or any has failed"), "end the turn: the board wakes the worker");
  assert.ok(declared.includes("Never write a wait loop, a `sleep` or a `pgrep -f`"), "no wait loops");
  const own = lines.find((line) => line.startsWith("- Still running your own background work")) ?? "";
  assert.ok(own.includes("\"waitingOn\": \"<what>\", \"until\": \"<ISO time>\""), "the string form stays, for a worker's own shell or Monitor");
});
