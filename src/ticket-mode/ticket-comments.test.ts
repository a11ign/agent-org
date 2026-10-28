// no-token: gh -- pure functions over text, and a tracker object built in the test; nothing is read or spawned
//
// A ticket's comments reach its planner and its worker (tracker contract 1.8): every person's comment, oldest first, with its author and date, the rule that a later comment can correct or supersede the
// description, and what the plan or the pull request body must say of them. The board's own bookkeeping comments are left out, a long thread is cut from its oldest end with the cut said, and a tracker
// that cannot give the comments is said too.
import { test } from "node:test";
import assert from "node:assert/strict";
import { commentsText, isBoardComment, MAX_COMMENT_CHARS, MAX_COMMENTS, readTicketComments, type CommentsRead } from "./ticket-comments.ts";
import type { TicketComment, TicketSource } from "./source.ts";
import { doneComment } from "./pool-outcome.ts";
import { afterMergeComment } from "./pool-tracker.ts";
import { commentOf } from "./closed-work.ts";
import { earlyCompletionComment } from "./queue/queue-next-step.ts";
import { cycleSentence } from "./board-view/wait-cycles.ts";
import type { Entry } from "./queue/queue-entries-and-outcomes.ts";

const URL = "https://tracker.example.invalid/ABC-7";
const said = (author: string, createdAt: string, body: string): TicketComment => ({ author, createdAt, body });
const read = (comments: readonly TicketComment[], complete = true): CommentsRead => ({ kind: "read", comments, complete });

test("every comment is given oldest first with its author and date, quoted, and the reader is told a later comment can supersede the description", () => {
  const text = commentsText(read([
    said("Sam Reviewer", "2026-10-20T12:00:00.000Z", "This supersedes the description: the cause is the cache key.\n\nThe fix is one line in `cache.ts`."),
    said("Alex Author", "2026-10-19T09:00:00.000Z", "Could it be the shared database?"),
  ]), { url: URL, audience: "pull request" });
  const first = text.indexOf("**Alex Author, 2026-10-19T09:00:00.000Z:**");
  const second = text.indexOf("**Sam Reviewer, 2026-10-20T12:00:00.000Z:**");
  assert.ok(first > 0 && second > first, "oldest first, whatever order the tracker gave them in");
  assert.ok(text.includes("> This supersedes the description: the cause is the cache key.\n>\n> The fix is one line in `cache.ts`."), "the body is quoted, so its headings cannot read as the brief's");
  assert.match(text, /^\n## The ticket's comments\n/);
  assert.match(text, /A later comment can correct or supersede the description/);
  assert.match(text, /Read every comment before you change anything/);
});

test("the worker is told its pull request body names the comments it acted on, and the planner that its plan does", () => {
  const comments = read([said("Sam Reviewer", "2026-10-20T12:00:00.000Z", "Use the cache key.")]);
  assert.match(commentsText(comments, { url: URL, audience: "pull request" }), /Your pull request body carries a `Comments acted on` section/);
  const plan = commentsText(comments, { url: URL, audience: "plan" });
  assert.match(plan, /Your plan carries a `## Comments acted on` section/);
  assert.match(plan, /Read every comment before you plan/);
});

test("a ticket with no comment a person wrote gets no section", () => {
  assert.equal(commentsText(read([]), { url: URL, audience: "plan" }), "");
  assert.equal(commentsText(read([said("Board", "2026-10-20T12:00:00.000Z", "Wait cycle ABC-1 → ABC-2 → ABC-1: ABC-1 waits on ABC-2.")]), { url: URL, audience: "plan" }), "");
});

test("the board's own bookkeeping comments are left out, and a person's comment that only mentions one is kept", () => {
  const text = commentsText(read([
    said("Pat", "2026-10-20T10:00:00.000Z", "After-merge checks for ABC-7, now that acme/web#3 merged:\n- the dashboard loads (ops)"),
    said("Pat", "2026-10-20T11:00:00.000Z", "Note the after-merge checks for ABC-7 are wrong: the dashboard is retired."),
  ]), { url: URL, audience: "pull request" });
  assert.equal(text.includes("the dashboard loads (ops)"), false);
  assert.ok(text.includes("the dashboard is retired"));
});

/** A run of ABC-7 whose pull request acme/web#3 merged, with one After-merge line, for the producers below. */
const merged = {
  ticket: { key: "ABC-7" }, prs: [{ repo: "acme/web", url: "https://github.com/acme/web/pull/3" }], pullStates: { "https://github.com/acme/web/pull/3": "merged" },
  afterMerge: [{ line: "the dashboard loads", owner: "ops" }], steps: [{ step: 1, of: 2, prs: ["https://github.com/acme/web/pull/3"] }],
} as unknown as Entry;

test("every comment the board posts itself reads as bookkeeping, as each producer words it", () => {
  const posted = {
    done: doneComment({ reason: "Verified.", evidence: ["ran the check: it passed"] }),
    afterMerge: afterMergeComment(merged),
    closedWork: commentOf({ kind: "none", number: 4, url: "https://github.com/acme/web/pull/4", base: "main", branch: "abc-7", head: "f".repeat(40) }),
    closedUnique: commentOf({ kind: "unique", number: 5, url: "https://github.com/acme/web/pull/5", base: "main", branch: "abc-7", head: "e".repeat(40), commits: [{ sha: "d".repeat(40), subject: "wip" }], files: ["a.ts"], filesComplete: true }),
    putBack: earlyCompletionComment(merged),
    waitCycle: cycleSentence({ id: "c1", keys: ["ABC-1", "ABC-2"], loop: ["ABC-1", "ABC-2", "ABC-1"], edges: [{ from: "ABC-1", to: "ABC-2", kind: "blocked-by" }, { from: "ABC-2", to: "ABC-1", kind: "blocked-by" }] } as never),
  };
  for (const [name, body] of Object.entries(posted)) assert.equal(isBoardComment(body), true, `the board's ${name} comment is bookkeeping: ${body.slice(0, 80)}`);
  for (const body of ["Could it be the shared database?", "Completed? Not yet: the cache key is still wrong.", "Closed pull request #4 was the wrong approach, see below.",
    "Not done yet, though the board's note ends: Completed by the ticket board on the worker's verified outcome.", "The note that the tracker's integration moved the ticket to its completed state is wrong."]) {
    assert.equal(isBoardComment(body), false, `a person's comment is kept: ${body}`);
  }
});

test("a long thread keeps its newest comments, and says how many earlier ones it left out and where to read them", () => {
  const many = Array.from({ length: MAX_COMMENTS + 3 }, (_, i) => said(`Person ${i}`, new Date(Date.UTC(2026, 9, 1, i)).toISOString(), `comment number ${i}`));
  const text = commentsText(read(many), { url: URL, audience: "plan" });
  assert.equal(text.includes("comment number 0\n"), false, "the oldest is left out");
  assert.ok(text.includes(`comment number ${MAX_COMMENTS + 2}`), "the newest is kept");
  assert.equal((text.match(/^\*\*Person \d+, /gm) ?? []).length, MAX_COMMENTS);
  assert.match(text, new RegExp(`3 earlier comments, from 2026-10-01T00:00:00.000Z to 2026-10-01T02:00:00.000Z, are left out of this brief to keep it short: read them at ${URL.replace(/[.]/g, "\\.")}`));
});

test("one comment left out is said in the singular", () => {
  const many = Array.from({ length: MAX_COMMENTS + 1 }, (_, i) => said(`Person ${i}`, new Date(Date.UTC(2026, 9, 1, i)).toISOString(), `comment number ${i}`));
  assert.ok(commentsText(read(many), { url: URL, audience: "plan" }).includes(`1 earlier comment, from 2026-10-01T00:00:00.000Z, is left out of this brief to keep it short: read it at ${URL}.`));
});

test("a comment whose time the tracker gave in no readable form sorts first, and the rest stay in order", () => {
  const text = commentsText(read([said("B", "2026-10-02T00:00:00.000Z", "second"), said("X", "yesterday", "undated"), said("A", "2026-10-01T00:00:00.000Z", "first")]), { url: URL, audience: "plan" });
  const order = ["> undated", "> first", "> second"].map((line) => text.indexOf(line));
  assert.deepEqual([...order].sort((a, b) => a - b), order);
});

test("a comment longer than the cap is cut, and the cut says how much is left and where", () => {
  const text = commentsText(read([said("Pat", "2026-10-20T10:00:00.000Z", `${"x".repeat(MAX_COMMENT_CHARS)}TAIL`)]), { url: URL, audience: "plan" });
  assert.equal(text.includes("TAIL"), false);
  assert.ok(text.includes(`(cut: 4 more characters; read the whole comment at ${URL})`));
});

test("a tracker that read only part of the thread, or none of it, is said, never passed over", () => {
  assert.match(commentsText(read([said("Pat", "2026-10-20T10:00:00.000Z", "Hi")], false), { url: URL, audience: "plan" }),
    new RegExp(`The tracker holds more comments than the board read, and the ones it did not read may be the newest: read the rest at ${URL.replace(/[.]/g, "\\.")} before you plan\\.`));
  const unread = commentsText({ kind: "unread", why: "the tracker answered 503" }, { url: URL, audience: "pull request" });
  assert.match(unread, /^\n## The ticket's comments\n\nThe board could not read this ticket's comments \(the tracker answered 503\)\./);
  assert.match(unread, /read them at https:\/\/tracker\.example\.invalid\/ABC-7 before you change anything/);
  assert.match(unread, /Your pull request body carries a `Comments acted on` section/);
});

test("the read asks the tracker once, and a refusal or a tracker without comments reads as unread with the reason", async () => {
  const asked: string[] = [];
  const source: Pick<TicketSource, "readComments"> = { readComments: async (key) => { asked.push(key); return { comments: [said("Pat", "2026-10-20T10:00:00.000Z", "Hi")], complete: true }; } };
  assert.deepEqual(await readTicketComments(source, "ABC-7"), read([said("Pat", "2026-10-20T10:00:00.000Z", "Hi")]));
  assert.deepEqual(asked, ["ABC-7"]);
  assert.deepEqual(await readTicketComments({ readComments: async () => { throw new Error("Linear answered 503"); } }, "ABC-7"), { kind: "unread", why: "Linear answered 503" });
  assert.deepEqual(await readTicketComments({}, "ABC-7"), { kind: "unread", why: "this tracker does not give the board a ticket's comments" });
});
