// no-token: none -- every operation is handed a stub `run` that records the argument list (or an answering one that records its standard input); nothing here spawns `gh` or reaches the network
/**
 * A11-160 (step 9): WHAT THE DAILY CONFIDENCE POST AND THE SAFE TRACKER-COMMENT TOOL SAY TO `gh`, and how a comment is told from a 404, which core's tests of those callers used to assert over a stubbed `gh` and which are
 * the plugin's now (core's tests run on the fake code host's comments). The argument lists are copied from the modules they were moved from.
 *
 * #563: `gh api` PRINTS A WELL-FORMED, PARSEABLE ERROR DOCUMENT TO STDOUT AND EXITS NON-ZERO, so the answer is told to be a comment by its `body`, and an answer that is JSON and has none is NEVER a body.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { AnsweringRun } from "../../../src/plugins/contracts/code-host-rows-facts.ts";
import { commentBodyOf, commentOnCheckoutRowByInput, postMarkedIssueComment } from "./class-comment-ops.ts";
import { recording } from "./recording-run.test.support.ts";

const A_COMMENT = JSON.stringify({ id: 42, body: "the original text" });
const A_404 = JSON.stringify({ message: "Not Found", documentation_url: "https://docs.github.com/rest" });

// --- decision-confidence-post.ts and route-guard.ts -----------------------------------------------------------------------------------------------------------

const MARKER = "<!-- decision-confidence-post: 2026-10-10 -->";

test("a marked comment is looked for among the epic's comments since the day (`--paginate`, projected to the ids of those that open with the marker) and, when none is, posted with the marker on its first line", () => {
  const { run, asked } = recording((args: string[]) => (args[0] === "api" ? "" : "https://github.com/a11ign/a11ign/issues/4627#issuecomment-6100000009\n"));
  assert.deepEqual(postMarkedIssueComment({ repo: "a11ign/a11ign", issue: 4627, marker: MARKER, day: "2026-10-10", text: "the reading", run }), { posted: true, ref: "6100000009" });
  assert.deepEqual(asked, [
    ["api", "--paginate", "repos/a11ign/a11ign/issues/4627/comments?per_page=100&since=2026-10-10T00:00:00Z", "--jq", `.[] | select(.body | startswith("${MARKER}")) | .id`],
    ["issue", "comment", "4627", "--repo", "a11ign/a11ign", "--body", `${MARKER}\nthe reading`],
  ]);
});

test("a day's comment that is already there is not posted twice (even among blank lines); a reference GitHub prints as something else is returned as printed, trimmed; a refused call throws (a post that could not tell must not guess)", () => {
  const present = recording("\n6100000001\n\n6100000002\n");
  assert.deepEqual(postMarkedIssueComment({ repo: "o/r", issue: 4627, marker: MARKER, day: "2026-10-10", text: "t", run: present.run }), { posted: false });
  assert.deepEqual(present.asked.map((args) => args[0]), ["api"], "no comment is made");
  const odd = recording((args: string[]) => (args[0] === "api" ? "\n" : "  posted somewhere \n"));
  assert.deepEqual(postMarkedIssueComment({ repo: "o/r", issue: 4627, marker: MARKER, day: "2026-10-10", text: "t", run: odd.run }), { posted: true, ref: "posted somewhere" });
  assert.throws(() => postMarkedIssueComment({ repo: "o/r", issue: 4627, marker: MARKER, day: "2026-10-10", text: "t", run: () => { throw new Error("HTTP 502"); } }), /HTTP 502/);
  assert.throws(() => postMarkedIssueComment({ repo: "o/r", issue: 4627, marker: MARKER, day: "2026-10-10", text: "t", run: (args) => { if (args[0] === "issue") throw new Error("HTTP 403"); return ""; } }), /HTTP 403/);
});

// --- tracker-comment.ts --------------------------------------------------------------------------------------------------------------------

test("the path is issues/comments/{id} -- the one the incident got wrong -- of the repository asked", () => {
  const seen = recording(A_COMMENT);
  commentBodyOf({ repo: "a11ign/a11ign", id: 546, run: seen.run });
  assert.deepEqual(seen.asked, [["api", "repos/a11ign/a11ign/issues/comments/546"]]);
  assert.match(seen.asked[0][1], /issues\/comments\/546$/);
  assert.doesNotMatch(seen.asked[0][1], /issues\/\d+\/comments/, "issues/{issue}/comments/{id} is not an endpoint, and asking for it returns a 404 DOCUMENT");
});

test("a comment answer yields its body, and an EMPTY body is a real state, not an absent one", () => {
  assert.deepEqual(commentBodyOf({ repo: "o/r", id: 42, run: () => A_COMMENT }), { kind: "body", body: "the original text" });
  assert.deepEqual(commentBodyOf({ repo: "o/r", id: 42, run: () => JSON.stringify({ body: "" }) }), { kind: "body", body: "" },
    "the check is for the KEY, not for truthiness -- an emptied comment still exists");
});

test("a 404 document is not a comment: it says what GitHub said, and is NEVER returned as a body", () => {
  assert.deepEqual(commentBodyOf({ repo: "o/r", id: 546, run: () => A_404 }), { kind: "not-a-comment", said: "Not Found", got: A_404 });
  for (const answer of ['{"body":7}', '{"body":null}', "[]", '["x"]', "null", "3", '{"id":1}']) {
    const read = commentBodyOf({ repo: "o/r", id: 1, run: () => answer });
    assert.equal(read.kind, "not-a-comment", answer);
    assert.equal((read as { said: unknown }).said, null, `${answer}: it carries no message of the code host's`);
  }
  const long = JSON.stringify({ id: 1, text: "x".repeat(500) });
  assert.equal((commentBodyOf({ repo: "o/r", id: 1, run: () => long }) as { got: string }).got.length, 200, "only the first 200 characters of what came back are shown");
});

test("a response that is not JSON at all is not a comment: it shows how it began", () => {
  assert.deepEqual(commentBodyOf({ repo: "o/r", id: 42, run: () => "<html>502</html>" }), { kind: "not-json", head: "<html>502</html>" });
  assert.equal((commentBodyOf({ repo: "o/r", id: 42, run: () => `<html>${"y".repeat(400)}` }) as { head: string }).head.length, 200);
});

test("a read that failed THROWS what the run threw, with the error document it printed to standard output on it, and returns nothing", () => {
  const failed = Object.assign(new Error("exit 1"), { stdout: A_404 });
  assert.throws(() => commentBodyOf({ repo: "o/r", id: 546, run: () => { throw failed; } }), (error: Error & { stdout?: string }) => error === failed && error.stdout === A_404);
});

// --- host-kernel.ts ------------------------------------------------------------------------------------------------------------------------

/** An answering `run` that records each call's arguments and standard input. */
function answering(answer: { status: number | null; stdout?: string; stderr?: string; error?: string }) {
  const called: { args: readonly string[]; input: string | undefined }[] = [];
  const run: AnsweringRun = (args, options) => { called.push({ args, input: options?.input }); return { stdout: "", stderr: "", ...answer }; };
  return { called, run };
}

test("a comment on a row of the checkout's own repository is `issue comment <row> --body-file -` with the body on standard input and no repository named", () => {
  const { called, run } = answering({ status: 0 });
  commentOnCheckoutRowByInput({ number: 4046, body: "Kernel reboot read back\nline two\n", run });
  assert.deepEqual(called, [{ args: ["issue", "comment", "4046", "--body-file", "-"], input: "Kernel reboot read back\nline two\n" }]);
  commentOnCheckoutRowByInput({ number: "7", body: "b", run });
  assert.deepEqual(called[1].args, ["issue", "comment", "7", "--body-file", "-"]);
});

test("a program that fails throws what it printed, or why it could not start", () => {
  assert.throws(() => commentOnCheckoutRowByInput({ number: 1, body: "b", run: answering({ status: 1, stderr: "HTTP 403: Resource not accessible\n" }).run }), /^Error: HTTP 403: Resource not accessible$/);
  assert.throws(() => commentOnCheckoutRowByInput({ number: 1, body: "b", run: answering({ status: 1 }).run }), /^Error: exit 1$/);
  assert.throws(() => commentOnCheckoutRowByInput({ number: 1, body: "b", run: answering({ status: null, error: "spawn gh ETIMEDOUT" }).run }), /ETIMEDOUT/);
});
