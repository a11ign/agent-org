// no-token: gh -- the audit reaches `gh` only through the code host's rows; every read in this file is the fake code host
// THE DAY'S BOARD EDITION LABELLED `answer:<route>` ON ROWS ALREADY CLOSED (agent-org#573, 2026-10-09). `commentsToJudge` judged the comments of every row `readProseFacts` returned, and that
// read is `state=all`, so a row closed hours ago was judged like an open one: 23 of 24 flagged rows were CLOSED, 21 went to `product-manager` as `answer-owed` orders at once, and
// `order-deferred-too-long` tripped on the first of them. A closed row's comment is not judged now; an OPEN row's is judged exactly as before.
//
// POSITIVE CONTROL for each skip: the identical comment on an OPEN row raises the finding, so the skip is not the audit being silent. A row with no `state` field is judged as before.
//
// A11-160, STEP 8: THE DAY'S READ IS THE CODE HOST'S ROWS (`orgCommentsSinceOf`, `issuesSinceOf`, `labeledEventsOfRow`), so the cases that read it seed the fake code host's world: a row with the comment an org account posted, and
// the state the issues read gives it. The REST paths and `--jq` filters those reads send are the plugin's (`plugins/github/rows/board-rows.test.ts`).
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { PROSE_QUESTIONS, proseAudit, readProseFacts } from "../board-truth-audit.ts";
import { forgetActivation, substituteCodeHost } from "../plugins/active.ts";
import { createFakeCodeHost } from "../plugins/fakes/code-host.ts";
import { fakeRow } from "../plugins/fakes/code-host-rows.ts";
import { watchedRows } from "../plugins/fakes/watched-rows.test.support.ts";

afterEach(() => forgetActivation());

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

/**
 * The fake code host holding what `readProseFacts` reads: a comment an org account posted on each row of `comments`, and the issues of the day `issues` lists (each with the state it has). A row with a comment that `issues`
 * does not list was last updated before the day, so the issues read does not hold it. `calls` is every operation of the rows that was called, with the request.
 */
const day = ({ comments, issues }: { comments: { number: number; body: string }[]; issues: { number: number; state: "open" | "closed" }[] }) => {
  const host = createFakeCodeHost();
  host.rowsWorld.repo = REPO;
  const listedNumbers = issues.map((issue) => issue.number);
  for (const { number, state } of issues) {
    host.rowsWorld.rows.set(number, fakeRow(host.rowsWorld, number, { title: `row ${number}`, state: state === "closed" ? "CLOSED" : "OPEN", closedAt: state === "closed" ? new Date(AT).toISOString() : null,
      createdAt: new Date(AT - 60 * MINUTE).toISOString(), openedBy: "a11ign-ai-workers" }));
  }
  for (const { number, body } of comments) {
    const held = host.rowsWorld.rows.get(number) ?? fakeRow(host.rowsWorld, number, { createdAt: new Date(AT - 60 * MINUTE).toISOString(), updatedAt: listedNumbers.includes(number) ? undefined : new Date(NOW - 3 * 24 * 60 * MINUTE).toISOString() });
    host.rowsWorld.rows.set(number, held);
    held.comments.push({ id: number * 10 + held.comments.length, body, createdAt: new Date(AT).toISOString(), author: AUTHOR });
  }
  const watched = watchedRows(host);
  substituteCodeHost(watched.host);
  return { world: host.rowsWorld, calls: watched.calls, count: (op: string) => watched.calls.filter((call) => call.op === op).length };
};
const posted = (number: number, body: string) => ({ number, body });
const listed = (number: number, state: "open" | "closed") => ({ number, state });
const readQuestions = () => proseAudit(readProseFacts({ repo: REPO, run: () => assert.fail("the code host's rows are asked, not a runner"), now: NOW })!).findings.map((f) => `${f.number} ${f.question}`);

test("readProseFacts marks the rows the issues list holds as closed, so the day's table judges the open one and not the closed one", () => {
  const comments = [posted(4568, HANDOFF), posted(4570, HANDOFF)];
  const both = day({ comments, issues: [listed(4568, "open"), listed(4570, "open")] });
  assert.deepEqual(readQuestions(), [`4568 ${PROSE_QUESTIONS.HANDOFF}`, `4570 ${PROSE_QUESTIONS.HANDOFF}`], "CONTROL: both rows open, both flagged");
  const oneClosed = day({ comments, issues: [listed(4568, "closed"), listed(4570, "open")] });
  assert.deepEqual(readQuestions(), [`4570 ${PROSE_QUESTIONS.HANDOFF}`]);
  assert.deepEqual(oneClosed.calls.filter((call) => call.op === "labeledEventsOfRow").map((call) => call.request.number), [4570], "the events are read for the open row only");
  assert.equal(both.count("labeledEventsOfRow"), 2, "CONTROL: both rows' events are read when both are open");
});

test("a reading with no field, and no handoff, still reads the issues list for its state: a closed one is skipped, an open one flagged", () => {
  const closed = day({ comments: [posted(4568, NO_FIELD)], issues: [listed(4568, "closed")] });
  assert.deepEqual(readQuestions(), []);
  assert.equal(closed.count("issuesSinceOf"), 1, "the state came from the issues list");
  day({ comments: [posted(4568, NO_FIELD)], issues: [listed(4568, "open")] });
  assert.deepEqual(readQuestions(), [`4568 ${PROSE_QUESTIONS.READING_FIELD}`], "CONTROL: the open row is flagged");
});

test("a row the issues list does not hold keeps no state and is judged as before; a comment nothing could flag reads only the comment list", () => {
  day({ comments: [posted(4568, HANDOFF)], issues: [listed(9999, "closed")] });
  assert.deepEqual(readQuestions(), [`4568 ${PROSE_QUESTIONS.HANDOFF}`]);
  const quiet = day({ comments: [posted(4568, "A plain note.")], issues: [listed(4568, "closed")] });
  assert.deepEqual(readQuestions(), []);
  assert.deepEqual(quiet.calls.map((call) => call.op), ["orgCommentsSinceOf"], "nothing to judge: only the comment list is read");
});
