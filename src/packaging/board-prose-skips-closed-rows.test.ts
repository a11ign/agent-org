// no-token: gh -- the audit reaches `gh` only through the `run` a caller injects; every read in this file is a fixture
// THE DAY'S BOARD EDITION LABELLED `answer:<route>` ON ROWS ALREADY CLOSED (agent-org#573, 2026-10-09). `commentsToJudge` judged the comments of every row `readProseFacts` returned, and that
// read is `state=all`, so a row closed hours ago was judged like an open one: 23 of 24 flagged rows were CLOSED, 21 went to `product-manager` as `answer-owed` orders at once, and
// `order-deferred-too-long` tripped on the first of them. A closed row's comment is not judged now; an OPEN row's is judged exactly as before.
//
// POSITIVE CONTROL for each skip: the identical comment on an OPEN row raises the finding, so the skip is not the audit being silent. A row with no `state` field is judged as before.
import { test } from "node:test";
import assert from "node:assert/strict";
import { PROSE_QUESTIONS, proseAudit, readProseFacts } from "../board-truth-audit.ts";

const MINUTE = 60_000;
const AT = Date.parse("2026-10-09T10:22:00Z");
const NOW = Date.parse("2026-10-09T23:00:00Z");
const AUTHOR = "a11ign-ai-leads";
const REPO = "a11ign/a11ign";

const HANDOFF = "**ceo, reading 1 of 1 on #4568.** The defect goes to `product-manager` as a row.\n\nDefect-row: none -- the reader files it.";
const NO_FIELD = "**ceo, reading 1 of 1 on #4568.** The page scanned clean.";

/** @param {string} body */
const comment = (body: string) => ({ body, createdAt: new Date(AT).toISOString(), author: { login: AUTHOR }, url: "https://github.com/a11ign/a11ign/issues/4568#issuecomment-1" });
/** @param {{ body: string, state?: string }} input @returns {string[]} the questions `proseAudit` raised for one comment on #4568, whose state is the one given (none when omitted) */
const raised = ({ body, state }: { body: string; state?: string }) => {
  const row = { number: 4568, labels: [], comments: [comment(body)], ...(state === undefined ? {} : { state }) };
  return proseAudit({ now: NOW, openRows: [row], closedRows: null, mergedPrs: null, liveSessions: null, waitFacts: null, proseEvidence: { rows: [], labelEvents: [] } }).findings.map((f) => f.question);
};

test("a handoff sentence under a CLOSED row raises no finding; the identical comment on an OPEN row raises one", () => {
  assert.deepEqual(raised({ body: HANDOFF, state: "OPEN" }), [PROSE_QUESTIONS.HANDOFF], "CONTROL: the open row's handoff is flagged");
  assert.deepEqual(raised({ body: HANDOFF, state: "CLOSED" }), []);
});

test("a reading with no `Defect-row:` line under a CLOSED row raises no finding; the identical comment on an OPEN row raises one", () => {
  assert.deepEqual(raised({ body: NO_FIELD, state: "OPEN" }), [PROSE_QUESTIONS.READING_FIELD], "CONTROL: the open row's reading is flagged");
  assert.deepEqual(raised({ body: NO_FIELD, state: "CLOSED" }), []);
});

test("a row with no `state` field is judged as before, so a caller that does not set it is unchanged", () => {
  assert.deepEqual(raised({ body: HANDOFF }), [PROSE_QUESTIONS.HANDOFF]);
  assert.deepEqual(raised({ body: NO_FIELD }), [PROSE_QUESTIONS.READING_FIELD]);
});

/** The `gh api` surface `readProseFacts` uses: the day's comments, the issues updated in the day (with their state), and each row's `labeled` events; every path is recorded. */
const fakeGh = ({ comments, issues }: { comments: any[]; issues: any[] }) => {
  const calls: string[] = [];
  const ndjson = (items: any[]) => items.map((i) => JSON.stringify(i)).join("\n");
  const run = (args: string[]) => {
    const path = args[2] ?? "";
    calls.push(path);
    if (path.includes("/issues/comments?")) return ndjson(comments);
    if (path.includes("/events?")) return "";
    if (path.includes("/issues?state=all")) return ndjson(issues);
    return "";
  };
  return { run, calls };
};
const posted = (number: number, body: string) => ({ number, author: { login: AUTHOR }, body, createdAt: new Date(AT).toISOString(), url: `https://github.com/a11ign/a11ign/issues/${number}#issuecomment-1` });
const listed = (number: number, state: "open" | "closed") => ({ number, state, author: "a11ign-ai-workers", createdAt: new Date(AT - 60 * MINUTE).toISOString(), text: `row ${number}` });
const readQuestions = (gh: ReturnType<typeof fakeGh>) => proseAudit(readProseFacts({ repo: REPO, run: gh.run, now: NOW })!).findings.map((f) => `${f.number} ${f.question}`);

test("readProseFacts marks the rows the issues list holds as closed, so the day's table judges the open one and not the closed one", () => {
  const comments = [posted(4568, HANDOFF), posted(4570, HANDOFF)];
  const both = fakeGh({ comments, issues: [listed(4568, "open"), listed(4570, "open")] });
  assert.deepEqual(readQuestions(both), [`4568 ${PROSE_QUESTIONS.HANDOFF}`, `4570 ${PROSE_QUESTIONS.HANDOFF}`], "CONTROL: both rows open, both flagged");
  const oneClosed = fakeGh({ comments, issues: [listed(4568, "closed"), listed(4570, "open")] });
  assert.deepEqual(readQuestions(oneClosed), [`4570 ${PROSE_QUESTIONS.HANDOFF}`]);
  assert.equal(oneClosed.calls.filter((path) => path.includes("/events?")).length, 1, "the events are read for the open row only");
  assert.equal(both.calls.filter((path) => path.includes("/events?")).length, 2, "CONTROL: both rows' events are read when both are open");
});

test("a reading with no field, and no handoff, still reads the issues list for its state: a closed one is skipped, an open one flagged", () => {
  const closed = fakeGh({ comments: [posted(4568, NO_FIELD)], issues: [listed(4568, "closed")] });
  assert.deepEqual(readQuestions(closed), []);
  assert.ok(closed.calls.some((path) => path.includes("/issues?state=all")), "the state came from the issues list");
  assert.deepEqual(readQuestions(fakeGh({ comments: [posted(4568, NO_FIELD)], issues: [listed(4568, "open")] })), [`4568 ${PROSE_QUESTIONS.READING_FIELD}`], "CONTROL: the open row is flagged");
});

test("a row the issues list does not hold keeps no state and is judged as before; a comment nothing could flag reads only the comment list", () => {
  assert.deepEqual(readQuestions(fakeGh({ comments: [posted(4568, HANDOFF)], issues: [listed(9999, "closed")] })), [`4568 ${PROSE_QUESTIONS.HANDOFF}`]);
  const quiet = fakeGh({ comments: [posted(4568, "A plain note.")], issues: [listed(4568, "closed")] });
  assert.deepEqual(readQuestions(quiet), []);
  assert.equal(quiet.calls.length, 1, "nothing to judge: only the comment list is read");
});
