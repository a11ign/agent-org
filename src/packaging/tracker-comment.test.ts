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
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  readComment, editComment, editRefusal, bodyOfCommentResponse, commentPath, digest,
} from "../../../../scripts/tracker-comment.mjs";

const A_COMMENT = JSON.stringify({ id: 42, body: "the original text" });
const A_404 = JSON.stringify({ message: "Not Found",
  documentation_url: "https://docs.github.com/rest" });

/** A `run` that records every call, so a test can assert the PATCH was never reached. */
function recorder(responses: (string | Error)[]) {
  const calls: string[][] = [];
  let i = 0;
  const run = (args: string[]) => {
    calls.push(args);
    const next = responses[Math.min(i++, responses.length - 1)];
    if (next instanceof Error) throw next;
    return next;
  };
  return { run, calls, patched: () => calls.some((c) => c.includes("PATCH")) };
}

// --- the endpoint ---

test("the path is issues/comments/{id} — the one the incident got wrong", () => {
  assert.match(commentPath(546), /issues\/comments\/546$/);
  assert.doesNotMatch(commentPath(546), /issues\/\d+\/comments/,
    "issues/{issue}/comments/{id} is not an endpoint, and asking for it returns a 404 DOCUMENT");
});

// --- the shape check ---

test("a comment response yields its body", () => {
  assert.equal(bodyOfCommentResponse(A_COMMENT, 42), "the original text");
});

test("AN EMPTY body is a real state, not an absent one", () => {
  assert.equal(bodyOfCommentResponse(JSON.stringify({ body: "" }), 42), "",
    "the check is for the KEY, not for truthiness — an emptied comment still exists");
});

test("a 404 document THROWS and quotes what GitHub said", () => {
  assert.throws(() => bodyOfCommentResponse(A_404, 546), /is not a comment/);
  assert.throws(() => bodyOfCommentResponse(A_404, 546), /Not Found/);
});

test("a response that is not JSON at all THROWS rather than becoming a body", () => {
  assert.throws(() => bodyOfCommentResponse("<html>502</html>", 42), /was not JSON/);
});

// --- the read checks BOTH the status and the shape ---

test("a NON-ZERO exit throws, and surfaces the error document without returning it", () => {
  const failed = Object.assign(new Error("exit 1"), { stdout: A_404 });
  assert.throws(() => readComment(546, { run: (() => { throw failed; }) as never }),
    /refusing to treat the failure as a body/);
  assert.throws(() => readComment(546, { run: (() => { throw failed; }) as never }), /Not Found/);
});

test("a ZERO exit carrying an error document ALSO throws — the shape survives a dropped status", () => {
  // The status is the reliable signal and `gh`'s exit contract can change; the shape is what caught this
  // when the original incident dropped the status entirely. Both, never either.
  assert.throws(() => readComment(546, { run: (() => A_404) as never }), /is not a comment/);
});

// --- THE MUTATION: a failed read must abort the write ---

test("THE MUTATION: pointing at a comment that does not exist writes NOTHING", () => {
  const r = recorder([Object.assign(new Error("exit 1"), { stdout: A_404 })]);
  assert.throws(() => editComment(546, { next: "replacement", expect: digest("the original text"),
    run: r.run as never }));
  assert.equal(r.patched(), false,
    "the read failing must abort the write, never fall through to it — this is the incident");
});

test("a zero-exit 404 document also writes nothing", () => {
  const r = recorder([A_404]);
  assert.throws(() => editComment(546, { next: "replacement", expect: "whatever", run: r.run as never }));
  assert.equal(r.patched(), false);
});

// --- compare-and-swap ---

test("an edit with no --expect refuses, and says why a read is not optional", () => {
  const refusal = editRefusal({ current: "a", expect: undefined, next: "b" })!;
  assert.match(refusal, /--expect=<digest> is required/);
  assert.match(refusal, /read left out/);
});

test("an edit whose expected digest does not match refuses and writes nothing", () => {
  const r = recorder([JSON.stringify({ body: "somebody else's correction" })]);
  const result = editComment(546, { next: "mine", expect: digest("what I read"), run: r.run as never });
  assert.equal(result.written, false);
  assert.match((result as { reason: string }).reason, /has changed since you read it/);
  assert.match((result as { reason: string }).reason, /the digest is the check/,
    "a reader must not be told to pass the new digest without re-reading");
  assert.equal(r.patched(), false);
});

test("a matching digest writes, and reports the transition", () => {
  const r = recorder([A_COMMENT, ""]);
  const result = editComment(42, { next: "the corrected text",
    expect: digest("the original text"), run: r.run as never });
  assert.deepEqual(result, { written: true, from: digest("the original text"),
    to: digest("the corrected text") });
  assert.equal(r.patched(), true);
  assert.ok(r.calls.at(-1)!.includes(`body=the corrected text`));
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
