// no-token: gh -- boardTruthNow reaches `gh` only through the `run` injected here; every read in this file is a fixture
// a11ign/a11ign#4250 (follow-up of #4232): THE FLAG IN THE DAY'S TABLE MOVES THE AUTHOR NO BETTER THAN THE SENTENCE DID. The chairman's rule was that a handoff written as prose is flagged "to the
// author's own session as an `answer:` order and in the audit's daily list"; #4232 delivered the list. The tick now also puts `answer:<route>` on the row each `handoff-in-prose` and
// `reading-without-defect-row` finding names.
//
// POSITIVE AND NEGATIVE CONTROL: #4090's real comment is the flagged case (the label is added, once); its twins differ by ONE fact each (the day's table already posted, the author's own label
// already there, a row that no finding names). The flagged case is the control for every "nothing" below: the same tick, the same comment, a label when the fact is absent.
// a11ign/a11ign#4679: EVERY LABEL ASKS `answerLabelRefusal` FIRST, so each flagged comment below ENDS IN A QUESTION naming its route and the fake `gh` answers the row's state and newest comment.
// The 2026-10-09T23:00Z replay labelled closed rows and rows nobody had asked anything: `closed` and `report` below are those two, and `org-health.test.ts` pins the rest.
import { test } from "node:test";
import assert from "node:assert/strict";
import { boardTruthNow } from "../work-gate/org-health.ts";

const AT = Date.parse("2026-10-08T10:22:00Z");
const NOW = Date.parse("2026-10-08T12:00:00Z");
const AUTHOR = "a11ign-ai-leads";

/** #4090's 10:22Z comment (the lines that matter): it names `product-manager` and asks for a row, so the handoff is `ceo`'s own and the route is the session its first words name. */
const COMMENT_4090 = [
  "**ceo, reading 2 of 2 on #4090. The ten-page run finished: 10 of 10 pages scanned in 38 min 57 s. Done-when 2 is met.**",
  "",
  "**Asked of `product-manager`:** (1) file the defect: the Action's multi-line `urls` scans one page on Windows. (2) Close #4090 on this reading.",
  "",
  "`ceo`: is this reading the one to close #4090 on?",
].join("\n");
const READING_4100 = "**ceo, reading 1 of 3 on #4100.** The run finished. Does `ceo` close it?";

const posted = (number: number, body: string, login = AUTHOR) => ({ number, author: { login }, body, createdAt: new Date(AT).toISOString(), url: `https://github.com/a11ign/a11ign/issues/${number}#issuecomment-1` });
const ndjson = (items: any[]) => items.map((i) => JSON.stringify(i)).join("\n");

/** One tick of the real `boardTruthNow` over a fake `gh`: `table` is the day's table already on #928 (or not), `events` the labels the author already added, `closed` the rows GitHub reports closed. The newest comment of a row is the last one given for it. */
function tick({ comments, table = "", events = [], refuse = [], closed = [] }: { comments: any[]; table?: string; events?: any[]; refuse?: string[]; closed?: number[] }) {
  const labels: string[] = [];
  const tables: string[] = [];
  const logged: string[] = [];
  const run = (args: string[]) => {
    const path = args[0] === "api" ? (args.find((a) => a.startsWith("repos/")) ?? "") : "";
    if (args[0] === "issue" && args[1] === "comment") { tables.push(args[args.indexOf("--body") + 1]); return ""; }
    if (args[0] === "api" && args.includes("-f")) {
      const label = args[args.indexOf("-f") + 1].replace("labels[]=", "");
      if (refuse.includes(label)) throw new Error("HTTP 403\nforbidden");
      labels.push(`${path.match(/issues\/(\d+)\/labels/)![1]} ${label}`);
      return "";
    }
    if (path.includes("/issues/928/comments")) return table;
    if (path.includes("/issues/comments?")) return ndjson(comments);
    if (path.includes("/events?")) return ndjson(events);
    if (path.includes("/issues?state=all")) return "";
    const issue = path.match(/issues\/(\d+)$/);
    if (issue) return JSON.stringify({ state: closed.includes(Number(issue[1])) ? "closed" : "open", comments: comments.filter((c) => c.number === Number(issue[1])).length });
    const newest = path.match(/issues\/(\d+)\/comments\?per_page=1&page=(\d+)/);
    if (newest) return JSON.stringify(comments.filter((c) => c.number === Number(newest[1]))[Number(newest[2]) - 1]);
    return "[]";
  };
  const agents = () => [{ label: "ceo", status: "idle" }, { label: "orchestrator", status: "idle" }];
  boardTruthNow({ openRowsRead: [], claimedComments: [], waitFacts: { items: {} }, now: NOW }, { repo: "a11ign/a11ign", run, agents, log: (line: string) => logged.push(line) } as any);
  return { labels, tables, logged };
}

test("#4090's handoff in prose adds `answer:ceo` to the row, and the day's table is posted all the same", () => {
  const { labels, tables } = tick({ comments: [posted(4090, COMMENT_4090)] });
  assert.deepEqual(labels, ["4090 answer:ceo"], "the route is the session the comment's first words name");
  assert.equal(tables.length, 1);
  assert.match(tables[0], /handoff-in-prose/);
});

test("a second tick of the same day adds nothing: the table is posted, so no comment is read", () => {
  const { labels, tables } = tick({ comments: [posted(4090, COMMENT_4090)], table: "12345" });
  assert.deepEqual(labels, []);
  assert.deepEqual(tables, []);
});

test("one label per row and route however many findings name it, and a row no finding names gets nothing", () => {
  const twice = `${COMMENT_4090}\n\nThe defect goes to \`product-manager\` as a row.`;
  assert.deepEqual(tick({ comments: [posted(4090, twice)] }).labels, ["4090 answer:ceo"], "two handoffs in one comment");
  const quiet = tick({ comments: [posted(4090, "A plain note."), posted(4091, "Done; nothing to hand off.")] });
  assert.deepEqual(quiet.labels, [], "no finding, no label");
  assert.equal(quiet.tables.length, 1, "the table is still posted");
});

test("a reading with no `Defect-row:` line gets its order too, and a handoff the author already answered with a label does not", () => {
  assert.deepEqual(tick({ comments: [posted(4100, READING_4100)] }).labels, ["4100 answer:ceo"], "the author is the route when the comment names no other session");
  const answered = [{ number: 4090, label: "answer:product-manager", actor: AUTHOR, createdAt: new Date(AT + 5 * 60_000).toISOString() }];
  const { labels } = tick({ comments: [posted(4090, `${COMMENT_4090}\n\nDefect-row: #4221`)], events: answered });
  assert.deepEqual(labels, [], "the author's own label inside 15 minutes is the order already sent");
});

test("the label names the route of the finding, not the author's account: a comment opening `product-manager,` orders product-manager", () => {
  const reading = "**product-manager, reading 1 of 2 on #4100.** The queue was audited. Does `product-manager` agree?";
  assert.deepEqual(tick({ comments: [posted(4100, reading)] }).labels, ["4100 answer:product-manager"]);
});

test("a label GitHub refuses is said on the log and the others still go", () => {
  const { labels, logged } = tick({ comments: [posted(4090, COMMENT_4090), posted(4100, READING_4100)], refuse: ["answer:ceo"] });
  assert.deepEqual(labels, [], "every call was refused");
  assert.equal(logged.filter((l) => /answer:ceo was not added to #4090/.test(l)).length, 1);
  assert.equal(logged.filter((l) => /answer:ceo was not added to #4100/.test(l)).length, 1, "the refusal of the first did not stop the second");
});

test("a closed row, and a row whose newest comment asks nothing, are not labelled, and the log says why (a11ign/a11ign#4679)", () => {
  const closed = tick({ comments: [posted(4090, COMMENT_4090)], closed: [4090] });
  assert.deepEqual(closed.labels, [], "a closed row owes nobody an answer");
  assert.match(closed.logged.join("\n"), /answer:ceo was not added to #4090: the row is CLOSED/);
  const report = tick({ comments: [posted(4090, COMMENT_4090.replace(/`ceo`: is this reading the one to close #4090 on\?/, "Closing on this reading."))] });
  assert.deepEqual(report.labels, [], "a newest comment that asks nothing leaves nothing to answer");
  assert.match(report.logged.join("\n"), /answer:ceo was not added to #4090: the newest comment asks nothing/);
});
