import { test } from "node:test";
import assert from "node:assert/strict";
import { closeComment, closeNote, emptyMember, isClosedMemberNote, isCloseNote, isEmptyMemberNote, isRestackedNote, isRestackNote, isRestackProblemNote, looksEmpty, restackedAfter, restackStep, type CloseOutcome, type RestackDone } from "./stack-restack.ts";

const URL = "https://github.com/a11ign/agent-org/pull/2";
const BELOW = { key: "A11-1", url: "https://github.com/a11ign/agent-org/pull/1", state: "MERGED" } as const;
const HEAD = "b".repeat(40);
const RESTACK_HEAD = "a".repeat(40);
const MOVED: RestackDone = { merged: BELOW.url, head: RESTACK_HEAD };
const input = (over: Partial<Parameters<typeof looksEmpty>[0]> = {}) => ({ files: [], filesComplete: true, head: HEAD, done: MOVED, ...over });

test("A11-248: a member with no files, or only scaffolding, is empty; one other file is not", () => {
  assert.equal(looksEmpty(input()), true);
  assert.equal(looksEmpty(input({ files: [".acceptance/admin~a11-2.md", ".changeset/a-change.md"] })), true);
  assert.equal(looksEmpty(input({ files: [".acceptance/admin~a11-2.md", "src/the-member.ts"] })), false);
  assert.equal(looksEmpty(input({ files: ["docs/.acceptance/a.md"] })), false, "scaffolding is the folder at the top of the repository");
});

test("A11-248: a list cut short, or a head the code host does not say, is never read as empty", () => {
  assert.equal(looksEmpty(input({ filesComplete: false })), false);
  assert.equal(looksEmpty(input({ head: null })), false);
  assert.equal(looksEmpty(input({ files: [".acceptance/a.md"], filesComplete: false })), false);
});

test("A11-248: after a restack that moved the branch the head it was made at is not trusted, but the same head after an up-to-date restack is", () => {
  assert.equal(looksEmpty(input({ head: RESTACK_HEAD })), false, "a read right after the merge may still be of the old head");
  assert.equal(looksEmpty(input({ head: RESTACK_HEAD, done: { ...MOVED, upToDate: true } })), true, "nothing moved, so the head is the head");
  assert.equal(looksEmpty(input({ done: { merged: BELOW.url } })), false, "a restack read back off a note has no head to tell a stale read by, so no head is trusted");
});

test("A11-248: a member the board read a file of its own in at this head is not closed", () => {
  assert.equal(looksEmpty(input({ done: { ...MOVED, ownChangesAt: HEAD } })), false);
  assert.equal(looksEmpty(input({ done: { ...MOVED, ownChangesAt: RESTACK_HEAD } })), true, "and one that was read at an older head is read again");
});

test("A11-248: a member is closed only when a second read, at the same head, finds it empty too", () => {
  assert.equal(emptyMember(input()), false, "one read is not enough: a file list can lag a push");
  assert.equal(emptyMember(input({ done: { ...MOVED, emptyAt: RESTACK_HEAD } })), false, "an empty read at another head is not this head's");
  assert.equal(emptyMember(input({ done: { ...MOVED, emptyAt: HEAD } })), true);
  assert.equal(emptyMember(input({ files: ["src/the-member.ts"], done: { ...MOVED, emptyAt: HEAD } })), false, "and a file of its own at the second read settles it");
  assert.equal(emptyMember(input({ filesComplete: false, done: { ...MOVED, emptyAt: HEAD } })), false);
});

test("A11-248: each close note names the pull request and the merged member, and the card's words are recognised as the restack's", () => {
  const notes: Record<CloseOutcome["kind"], string> = {
    closed: closeNote({ url: URL, below: BELOW, outcome: { kind: "closed" } }),
    refused: closeNote({ url: URL, below: BELOW, outcome: { kind: "refused", reason: "Resource not accessible by integration" } }),
    unsupported: closeNote({ url: URL, below: BELOW, outcome: { kind: "unsupported" } }),
  };
  assert.equal(notes.closed, "#2 closed: everything it held merged with #1");
  assert.equal(notes.refused, "#2 has no changes of its own after #1 merged, and closing it failed: Resource not accessible by integration; agent-org tries again");
  assert.equal(notes.unsupported, "#2 has no changes of its own after #1 merged: close it, because this code host cannot");
  for (const note of Object.values(notes)) {
    assert.equal(isRestackNote(note), true, note);
    assert.equal(isCloseNote(note), true, note);
    assert.equal(isRestackedNote(note), false, note);
  }
  assert.deepEqual([notes.closed, notes.refused, notes.unsupported].map(isRestackProblemNote), [false, true, true]);
  assert.deepEqual([notes.closed, notes.refused, notes.unsupported].map(isEmptyMemberNote), [false, true, true]);
  assert.equal(isCloseNote("#2 restacked on main after #1 merged"), false);
  assert.deepEqual([notes.closed, notes.refused, notes.unsupported].map(isClosedMemberNote), [true, false, false]);
});

test("A11-248: an empty member's note names the merged member that a restart reads the restack back from; a closed note and another pull request's do not", () => {
  const empty = closeNote({ url: URL, below: BELOW, outcome: { kind: "unsupported" } });
  assert.equal(restackedAfter(empty, URL), BELOW.url);
  assert.equal(restackedAfter(empty, "https://github.com/a11ign/agent-org/pull/3"), null);
  assert.equal(restackedAfter(closeNote({ url: URL, below: BELOW, outcome: { kind: "closed" } }), URL), null);
});

test("A11-248: no close note says a person resolves anything, and the close notes stay while the head moves", () => {
  const phrase = ["a person", "resolves it"].join(" ");
  for (const outcome of [{ kind: "closed" }, { kind: "refused", reason: "x" }, { kind: "unsupported" }] as const) assert.equal(closeNote({ url: URL, below: BELOW, outcome }).includes(phrase), false);
  const facts = { base: "main", defaultBranch: "main", head: HEAD, settled: null } as const;
  const note = closeNote({ url: URL, below: BELOW, outcome: { kind: "refused", reason: "x" } });
  assert.deepEqual(restackStep({ facts, below: BELOW, done: MOVED, previousNote: note }), { restack: false, note }, "the restack moved the head, which is not a push that answers the note");
});

test("A11-248: the comment on a closed member names it and the member that merged", () => {
  assert.equal(closeComment(URL, BELOW), "Closed by agent-org: everything #2 held merged with #1, so it has no changes of its own left.");
});
