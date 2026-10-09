// no-token: gh -- the audit reaches `gh` only through the `run` a caller injects; every read in this file is a fixture
// a11ign/a11ign#4232 (chairman, 2026-10-08, root cause 1): A HANDOFF WRITTEN AS A SENTENCE MOVES NOBODY. `ceo`'s 10:22Z comment on #4090 asked `product-manager` to file a defect; no
// order was sent and no row existed for ten hours. The board-truth audit now reads the last day's comments by org accounts and flags (1) a comment that hands off in prose with no
// row filed and no `answer:<session>` label by the same author within 15 minutes, and (2) a reading comment with no `Defect-row:` field.
//
// POSITIVE AND NEGATIVE CONTROL for each: the flagged case is the real comment text; its twin differs by ONE fact (a row filed, a label added, a field line, a fence).
// The flagged cases are the controls for every "not flagged" below: the same audit, the same comment, flagged when the fact is absent.
import { test } from "node:test";
import assert from "node:assert/strict";
import { PROSE_QUESTIONS, boardTruthAudit, postDaysTable, proseAudit, readProseFacts } from "../board-truth-audit.ts";

const MINUTE = 60_000;
const AT = Date.parse("2026-10-08T10:22:00Z");
const NOW = Date.parse("2026-10-08T12:00:00Z");
const AUTHOR = "a11ign-ai-leads";

/** #4090's 10:22Z comment, as posted (the lines that matter): it names `product-manager` and asks for a row; it is "reading 2 of 2" and carries no `Defect-row:` line. */
const COMMENT_4090 = [
  "**ceo, reading 2 of 2 on #4090. The ten-page run finished: 10 of 10 pages scanned in 38 min 57 s. Done-when 2 is met.**",
  "",
  "**Asked of `product-manager`:** (1) file the defect: the Action's multi-line `urls` scans one page on Windows. (2) Close #4090 on this reading.",
].join("\n");

/** @param {string} body @param {string} [login] */
const comment = (body: string, login = AUTHOR) => ({ body, createdAt: new Date(AT).toISOString(), author: { login }, url: "https://github.com/a11ign/a11ign/issues/4090#issuecomment-1" });
/** @param {{ body: string, evidence?: any }} input @returns {typeof PROSE_QUESTIONS[keyof typeof PROSE_QUESTIONS][]} the questions the audit raised for one comment on #4090 */
const raised = ({ body, evidence = { rows: [], labelEvents: [] } }: { body: string; evidence?: any }) =>
  boardTruthAudit({ now: NOW, openRows: [{ number: 4090, labels: ["ready"], comments: [comment(body)] }], closedRows: [], mergedPrs: [], liveSessions: [],
    waitFacts: { items: {} }, proseEvidence: evidence }).findings.filter((f) => (Object.values(PROSE_QUESTIONS) as string[]).includes(f.question)).map((f) => f.question) as any;
const FIELDED = `${COMMENT_4090}\n\nDefect-row: #4221`;
const fileRow = (minutesLater: number, author = AUTHOR, text = "The defect, filed from #4090") => ({ rows: [{ author, createdAt: new Date(AT + minutesLater * MINUTE).toISOString(), text }], labelEvents: [] });
const labelled = (label: string, minutesLater = 5) => ({ rows: [], labelEvents: [{ number: 4090, label, actor: AUTHOR, createdAt: new Date(AT + minutesLater * MINUTE).toISOString() }] });

test("#4090's 10:22Z comment, with no row and no order within 15 minutes, is flagged and the flag names the phrase", () => {
  const audit = boardTruthAudit({ now: NOW, openRows: [{ number: 4090, labels: [], comments: [comment(COMMENT_4090)] }], closedRows: [], mergedPrs: [], liveSessions: [],
    waitFacts: { items: {} }, proseEvidence: { rows: [], labelEvents: [] } });
  const flag = audit.findings.find((f) => f.question === PROSE_QUESTIONS.HANDOFF);
  assert.ok(flag, "the handoff was not flagged");
  assert.equal(flag.number, 4090);
  assert.match(flag.detail, /Asked of `product-manager`/);
  assert.match(flag.detail, new RegExp(AUTHOR));
  assert.equal(flag.route, "ceo", "the flag goes to the author's own session, which the comment names in its first words");
});

test("the same comment is NOT a handoff in prose when the author filed a row 5 minutes later, or added the answer label naming that session", () => {
  assert.deepEqual(raised({ body: FIELDED, evidence: fileRow(5) }), []);
  assert.deepEqual(raised({ body: FIELDED, evidence: labelled("answer:product-manager") }), []);
});

test("the evidence must be the right one: another author's row, a row after 15 minutes, a row BEFORE the comment, or a label naming another session does not count", () => {
  assert.deepEqual(raised({ body: FIELDED, evidence: fileRow(5, "a11ign-ai-workers") }), [PROSE_QUESTIONS.HANDOFF]);
  assert.deepEqual(raised({ body: FIELDED, evidence: fileRow(16) }), [PROSE_QUESTIONS.HANDOFF]);
  assert.deepEqual(raised({ body: FIELDED, evidence: fileRow(-5) }), [PROSE_QUESTIONS.HANDOFF]);
  assert.deepEqual(raised({ body: FIELDED, evidence: fileRow(5, AUTHOR, "An unrelated row by the same shared account (it cites #40900 and #409)") }), [PROSE_QUESTIONS.HANDOFF], "#4110 and #4111 cleared #4090's comment live");
  assert.deepEqual(raised({ body: FIELDED, evidence: labelled("answer:orchestrator") }), [PROSE_QUESTIONS.HANDOFF]);
});

test("each phrase of the set is a handoff; `goes to` something that is not a session is not", () => {
  const phrases = ["The defect goes to `product-manager` as a row.", "product-manager will file it.", "`product-manager` to file it.", "That is for product-manager to rule.",
    "I will ask orchestrator.", "Asked of `product-manager`: file it."];
  for (const phrase of phrases) assert.deepEqual(raised({ body: `${phrase}\nDefect-row: none -- no defect found` }), [PROSE_QUESTIONS.HANDOFF], phrase);
  assert.deepEqual(raised({ body: "The CLI splits on whitespace and goes to `runPages` at more than one URL.\nDefect-row: none -- no defect found" }), []);
});

test("a reading comment: `Defect-row: #4221` and `Defect-row: none -- <reason>` are clear; neither line is flagged", () => {
  const reading = "ceo, reading 1 of 3 on #4090. Nothing was handed off.";
  assert.deepEqual(raised({ body: `${reading}\nDefect-row: #4221` }), []);
  assert.deepEqual(raised({ body: `${reading}\nDefect-row: none -- no defect found` }), []);
  assert.deepEqual(raised({ body: reading }), [PROSE_QUESTIONS.READING_FIELD]);
  assert.deepEqual(raised({ body: "**Ruling.** The row stands." }), [PROSE_QUESTIONS.READING_FIELD]);
  assert.deepEqual(raised({ body: `${reading}\nDefect-row: none` }), [PROSE_QUESTIONS.READING_FIELD], "`none` with no reason is not an answer");
});

test("a comment that merely quotes the phrase inside a fenced block is NOT flagged, and the same text outside the fence is", () => {
  const phrase = "Asked of `product-manager`: file it.";
  assert.deepEqual(raised({ body: `The audit looks for:\n\n\`\`\`\n${phrase}\n\`\`\`` }), []);
  assert.deepEqual(raised({ body: `The audit looks for:\n\n~~~text\n${phrase}\n~~~` }), []);
  assert.deepEqual(raised({ body: `The audit looks for:\n\n${phrase}` }), [PROSE_QUESTIONS.HANDOFF]);
});

test("only org accounts, only the last 24 hours, and not a comment younger than the 15 minutes the author has", () => {
  const audit = (/** @type {any} */ c: any) => boardTruthAudit({ now: NOW, openRows: [{ number: 4090, labels: ["ready"], comments: [c] }], closedRows: [], mergedPrs: [], liveSessions: [],
    waitFacts: { items: {} }, proseEvidence: { rows: [], labelEvents: [] } }).findings.length;
  assert.equal(audit(comment(COMMENT_4090, "DanBeckDev")), 0, "a person's comment is not an org session's");
  assert.equal(audit({ ...comment(COMMENT_4090), createdAt: new Date(NOW - 25 * 60 * MINUTE).toISOString() }), 0, "older than a day");
  assert.equal(audit({ ...comment(COMMENT_4090), createdAt: new Date(NOW - 5 * MINUTE).toISOString() }), 0, "posted 5 minutes ago: the author still has time");
  assert.equal(audit(comment(COMMENT_4090)), 2, "the control: the same comment is read when none of those holds (a handoff and a missing field)");
});

test("absence is not proof: unread evidence lists the handoff question UNREAD and judges no handoff; the reading field needs none; a caller that does not ask is told nothing", () => {
  const base = { now: NOW, openRows: [{ number: 4090, labels: ["ready"], comments: [comment(COMMENT_4090)] }], closedRows: [], mergedPrs: [], liveSessions: [], waitFacts: { items: {} } };
  const unread = boardTruthAudit({ ...base, proseEvidence: null } as any);
  assert.deepEqual(unread.unread, [PROSE_QUESTIONS.HANDOFF]);
  assert.deepEqual(unread.findings.map((f) => f.question), [PROSE_QUESTIONS.READING_FIELD], "the field is judged from the comment alone; the handoff is not judged without its evidence");
  const notAsked = boardTruthAudit(base as any);
  assert.deepEqual([notAsked.unread, notAsked.findings], [[], []], "no `proseEvidence` key: the caller did not ask");
});

/** A fake `gh` for the day's read: the comment list, the issues created, and one row's events. @param {{ comments: any[], created?: any[], events?: any[] }} day */
const fakeGh = ({ comments, created = [], events = [] }: { comments: any[]; created?: any[]; events?: any[] }) => {
  const calls: string[] = [];
  const ndjson = (items: any[]) => items.map((i) => JSON.stringify(i)).join("\n");
  const run = (args: string[]) => {
    const path = args[2] ?? "";
    calls.push(path);
    if (path.includes("/issues/comments?")) return ndjson(comments);
    if (path.includes("/events?")) return ndjson(events);
    if (path.includes("/issues?state=all")) return ndjson(created);
    return "";
  };
  return { run, calls };
};
const posted = (c = comment(COMMENT_4090)) => ({ number: 4090, author: c.author, body: c.body, createdAt: c.createdAt, url: c.url });

test("readProseFacts reads the day's comments once, and the evidence only when a comment could need it", () => {
  const withHandoff = fakeGh({ comments: [posted()], created: [{ author: AUTHOR, createdAt: "2026-10-08T10:27:00Z", text: "Filed from #4090" }] });
  const facts = readProseFacts({ repo: "a11ign/a11ign", run: withHandoff.run, now: NOW })!;
  assert.deepEqual(proseAudit(facts).findings.map((f) => f.question), [PROSE_QUESTIONS.READING_FIELD], "the row filed 5 minutes later answers the handoff; the missing field remains");
  assert.equal(withHandoff.calls.length, 3, "comments, issues created, one row's events");
  const quiet = fakeGh({ comments: [posted(comment("A plain note."))] });
  assert.deepEqual(proseAudit(readProseFacts({ repo: "a11ign/a11ign", run: quiet.run, now: NOW })!), { findings: [], unread: [] });
  assert.equal(quiet.calls.length, 1, "nothing to judge: only the comment list is read");
  const refused = readProseFacts({ repo: "a11ign/a11ign", run: () => { throw new Error("403"); }, now: NOW });
  assert.equal(refused, null);
});

test("the day's table carries both questions; an unreadable comment list posts nothing; an already-posted day reads no comments", () => {
  const bodies: string[] = [];
  const clear = { findings: [], unread: [] };
  const day = (over: any) => {
    const gh = fakeGh({ comments: [posted()] });
    const run = (args: string[]) => (args[0] === "issue" ? (bodies.push(args[args.indexOf("--body") + 1]), "") : (args[2]?.includes("/issues/928/comments") ? (over.already ?? "") : gh.run(args)));
    return { run, gh };
  };
  const { run, gh } = day({});
  assert.equal(postDaysTable({ audit: clear, day: "2026-10-08", repo: "a11ign/a11ign", run, now: NOW }), "posted");
  assert.match(bodies[0], /\*\*2 disagree\*\*/);
  assert.match(bodies[0], /handoff-in-prose/);
  assert.match(bodies[0], /reading-without-defect-row/);
  assert.equal(gh.calls.length > 0, true);
  const before = bodies.length;
  assert.equal(postDaysTable({ audit: clear, day: "2026-10-08", repo: "a11ign/a11ign", run, now: NOW, readProse: () => null }), "unread");
  assert.equal(bodies.length, before, "nothing posted");
  const again = day({ already: "12345" });
  assert.equal(postDaysTable({ audit: clear, day: "2026-10-08", repo: "a11ign/a11ign", run: again.run, now: NOW }), "already-posted");
  assert.equal(again.gh.calls.length, 0, "no comment read once the day is posted");
});
