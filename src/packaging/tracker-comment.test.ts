/**
 * #563: there was no safe way to edit a tracker comment, so every edit was hand-rolled — and one wrote a
 * 404's JSON body over the comment it was fixing.
 *
 * The mechanism, and it is the reason this file exists rather than a convention: **`gh api` prints a
 * well-formed, parseable error document to STDOUT and exits non-zero.** A command substitution takes the
 * stdout and drops the status, so the failure arrives as a *plausible value* — valid JSON, non-empty, and
 * `sed` rewrites it happily. Nothing downstream can tell it from content.
 *
 * THE MUTATION IS `NOTHING IS WRITTEN`. "It refused" and "it wrote the error and then complained" are
 * indistinguishable from an exit code, which is why these assert on the WRITE never being reached rather
 * than on a thrown error alone.
 */
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import {
  readComment, editComment, editRefusal, bodyOfCommentRead, digest,
} from "../tracker-comment.ts";
import { forgetActivation, substituteCodeHost } from "../plugins/active.ts";
import { createFakeCodeHost } from "../plugins/fakes/code-host.ts";
import { fakeRow } from "../plugins/fakes/code-host-rows.ts";
import { watchedRows } from "../plugins/fakes/watched-rows.test.support.ts";

afterEach(() => forgetActivation());

// A11-160, step 9: the comment is the CODE HOST's. The endpoint (`issues/comments/{id}`, the one the incident got wrong) and what GitHub's answer is made of (a body, or an error document) are read by the
// plugin (`plugins/github/rows/class-comment-ops.test.ts`); here the code host answers in the contract's words, and what this tool does with each answer is what is asserted.
const A_404_SAID = { kind: "not-a-comment", said: "Not Found", got: '{"message":"Not Found","documentation_url":"https://docs.github.com/rest"}' } as const;
const A_404_STDOUT = JSON.stringify({ message: "Not Found", documentation_url: "https://docs.github.com/rest" });
const NO_RUN = (): string => { throw new Error("the fake code host runs nothing"); };

/** The fake code host in place with comment `id` on a row of its world, saying `body`; `written()` is every write (`editComment`) the tool made. */
function commentOn(id: number, body: string) {
  const host = createFakeCodeHost();
  const watched = watchedRows(host);
  substituteCodeHost(watched.host);
  const { rowsWorld: world } = host;
  const row = fakeRow(world, 546, { title: "the tracker" });
  row.comments.push({ id, body, createdAt: new Date(world.now()).toISOString() });
  world.rows.set(546, row);
  return { world, comment: row.comments[0]!, written: () => watched.calls.filter(({ op }) => op === "editComment").map(({ request }) => ({ id: request.id, body: request.body })) };
}

// --- the shape check ---

test("a comment answer yields its body", () => {
  assert.equal(bodyOfCommentRead({ kind: "body", body: "the original text" }, 42), "the original text");
});

test("AN EMPTY body is a real state, not an absent one", () => {
  assert.equal(bodyOfCommentRead({ kind: "body", body: "" }, 42), "",
    "the check is for the KEY, not for truthiness — an emptied comment still exists");
});

test("a 404 document THROWS and quotes what GitHub said", () => {
  assert.throws(() => bodyOfCommentRead(A_404_SAID, 546), /is not a comment/);
  assert.throws(() => bodyOfCommentRead(A_404_SAID, 546), /GitHub said: Not Found/);
  assert.throws(() => bodyOfCommentRead({ kind: "not-a-comment", said: null, got: '["x"]' }, 546), /Got: \["x"\]/, "an answer with no message shows what it was");
});

test("a response that is not JSON at all THROWS rather than becoming a body", () => {
  assert.throws(() => bodyOfCommentRead({ kind: "not-json", head: "<html>502</html>" }, 42), /was not JSON.*<html>502<\/html>/);
});

// --- the read checks BOTH the status and the shape ---

test("a comment of the code host is read as its body", () => {
  commentOn(42, "the original text");
  assert.equal(readComment(42, { run: NO_RUN }), "the original text");
});

test("a NON-ZERO exit throws, and surfaces the error document without returning it", () => {
  const { world } = commentOn(546, "the original text");
  world.failures.set("commentBodyOf", Object.assign(new Error("exit 1"), { stdout: A_404_STDOUT }));
  assert.throws(() => readComment(546, { run: NO_RUN }), /refusing to treat the failure as a body/);
  assert.throws(() => readComment(546, { run: NO_RUN }), /Not Found/);
});

test("a ZERO exit carrying an error document ALSO throws — the shape survives a dropped status", () => {
  // The status is the reliable signal and `gh`'s exit contract can change; the shape is what caught this
  // when the original incident dropped the status entirely. Both, never either.
  const { world } = commentOn(546, "the original text");
  world.tail.classes.commentReads.set(546, A_404_SAID);
  assert.throws(() => readComment(546, { run: NO_RUN }), /is not a comment/);
});

// --- THE MUTATION: a failed read must abort the write ---

test("THE MUTATION: pointing at a comment that does not exist writes NOTHING", () => {
  const { world, comment, written } = commentOn(7, "the original text");
  world.failures.set("commentBodyOf", Object.assign(new Error("exit 1"), { stdout: A_404_STDOUT }));
  assert.throws(() => editComment(7, { next: "replacement", expect: digest("the original text"), run: NO_RUN }));
  assert.deepEqual(written(), [],
    "the read failing must abort the write, never fall through to it — this is the incident");
  assert.equal(comment.body, "the original text");
});

test("a zero-exit 404 document also writes nothing", () => {
  const { world, comment, written } = commentOn(546, "the original text");
  world.tail.classes.commentReads.set(546, A_404_SAID);
  assert.throws(() => editComment(546, { next: "replacement", expect: "whatever", run: NO_RUN }));
  assert.deepEqual(written(), []);
  assert.equal(comment.body, "the original text");
});

// --- compare-and-swap ---

test("an edit with no --expect refuses, and says why a read is not optional", () => {
  const refusal = editRefusal({ current: "a", expect: undefined, next: "b" })!;
  assert.match(refusal, /--expect=<digest> is required/);
  assert.match(refusal, /read left out/);
});

test("an edit whose expected digest does not match refuses and writes nothing", () => {
  const { comment, written } = commentOn(546, "somebody else's correction");
  const result = editComment(546, { next: "mine", expect: digest("what I read"), run: NO_RUN });
  assert.equal(result.written, false);
  assert.match((result as { reason: string }).reason, /has changed since you read it/);
  assert.match((result as { reason: string }).reason, /the digest is the check/,
    "a reader must not be told to pass the new digest without re-reading");
  assert.deepEqual(written(), []);
  assert.equal(comment.body, "somebody else's correction");
});

test("a matching digest writes, and reports the transition", () => {
  const { comment, written } = commentOn(42, "the original text");
  const result = editComment(42, { next: "the corrected text",
    expect: digest("the original text"), run: NO_RUN });
  assert.deepEqual(result, { written: true, from: digest("the original text"),
    to: digest("the corrected text") });
  assert.deepEqual(written(), [{ id: 42, body: "the corrected text" }]);
  assert.equal(comment.body, "the corrected text");
});
test("a no-op edit refuses rather than appearing in the timeline as a change", () => {
  assert.match(editRefusal({ current: "same", expect: digest("same"), next: "same" })!, /nothing to do/);
});

test("an EMPTY replacement refuses — it is what a failed transformation looks like", () => {
  assert.match(editRefusal({ current: "text", expect: digest("text"), next: "   " })!,
    /new body is empty/);
});

test("digest is stable and short enough to read back out of a refusal", () => {
  assert.equal(digest("x"), digest("x"));
  assert.notEqual(digest("x"), digest("y"));
  assert.match(digest("x"), /^[0-9a-f]{12}$/);
});
