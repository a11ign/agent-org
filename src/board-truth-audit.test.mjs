// no-token: gh -- `board-truth-audit.mjs` reaches `gh` and `herdr` only through the readers `readBoardFacts` is given; every one this file calls is an injected fake, and the live read was run by hand and is pasted on the pull request (a11ign/a11ign#4043)
// a11ign/a11ign#4043: the board is read against reality, and every row whose state disagrees is named with the field to fix. Fixtures only: nothing here reaches GitHub or herdr.
//
// POSITIVE AND NEGATIVE CONTROL PER QUESTION: each `disagrees` test has an `agrees` twin that differs by ONE fact, so a question that always fires is red in the twin and one that
// never fires is red in the first. The chairman's two cases are fixtures: #2899 (an epic, 13 of 13 children closed, open) and the #3425 shape (`ready` carrying `no-code-left`).
// `emptiness` is the control for every `[]` here: the same audit finds each of the seven rows in `BOARD` below, so an empty result is a reading and not an unwired reader.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLAIM_FRESH_MS, QUESTIONS, TABLE_ROW, boardTruthAudit, boardTruthTable, closesOf, postDaysTable, readBoardFacts } from "./board-truth-audit.mjs";
import { declaredRowsFromBody } from "./close-rows-for-merged-pr.mjs";
import { boardTruthReading, orgHealthOrders, orgHealthReadings, SIGNALS } from "./org-health.mjs";
import { STALL_UNTOLD_RELEASE_MS } from "./claim-stall.mjs";
import { boardRowsOf, boardTruthFact, boardTruthNow, orgHealthNow } from "./work-gate/org-health.mjs";

const NOW = Date.parse("2026-10-08T12:00:00Z");
const MINUTE = 60_000;
const DAY = "2026-10-08";

/** @param {number} number @param {string[]} labels @param {Record<string, any>} [more] */
const row = (number, labels, more = {}) => ({ number, title: ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta"].map((w) => `${w}${number}`).join(" "), body: "", state: "OPEN", labels, ...more });
/** @param {number} number @param {number} minutesAgo */
const claimRecord = (number, minutesAgo) => ({ body: `<!-- row-claim: claim record -->\n**Claim record** -- claimed by \`worker-${number}\`.`,
  createdAt: new Date(NOW - minutesAgo * MINUTE).toISOString() });

/** @param {Partial<import("./board-truth-audit.mjs").BoardFacts>} over @returns {import("./board-truth-audit.mjs").BoardFacts} */
const facts = (over) => ({ now: NOW, openRows: [], closedRows: [], mergedPrs: [], liveSessions: [], waitFacts: { items: {} }, ...over });
/** @param {Partial<import("./board-truth-audit.mjs").BoardFacts>} over @param {string} question @returns {number[]} the rows found for one question */
const found = (over, question) => boardTruthAudit(facts(over)).findings.filter((f) => f.question === question).map((f) => f.number);

const BOARD = {
  openRows: [
    row(2899, ["epic", "out-of-release", "lane:any"], { subIssuesSummary: { total: 13, completed: 13 } }),
    row(3425, ["ready", "out-of-release", "lane:any", "no-code-left"]),
    row(10, ["ready"], { body: "the work" }),
    row(11, ["in-progress", "session:worker-11"], { comments: [claimRecord(11, 600)] }),
    row(12, ["parked"], { body: "Waiting-for: closed #50" }),
    row(13, []),
    row(14, ["backlog"], { title: "Chairman messaging for agent-org, Telegram first: the design and the sequence" }),
  ],
  closedRows: [row(50, ["ready"], { state: "CLOSED", stateReason: "COMPLETED" }),
    row(51, [], { state: "CLOSED", stateReason: "COMPLETED", title: "Chairman messaging for agent-org, Telegram first: the design and the sequence" })],
  mergedPrs: [{ number: 900, body: "Acceptance: x\nCloses #10" }],
  waitFacts: { items: { "#50": { state: "closed", labels: [], resolvedAt: NOW, changedAt: NOW } } },
};

test("emptiness control: the seeded board is found on all six questions, so the empty results below are readings", () => {
  const audit = boardTruthAudit(facts({ ...BOARD, liveSessions: ["ceo"] }));
  assert.deepEqual([...new Set(audit.findings.map((f) => f.question))].sort(), Object.values(QUESTIONS).sort());
  assert.deepEqual(audit.unread, []);
});

test("(1) an epic whose children are all closed is found (#2899, 13 of 13); one with a child open, one with none, and a non-epic are not", () => {
  assert.deepEqual(found({ openRows: [row(2899, ["epic"], { subIssuesSummary: { total: 13, completed: 13 } })] }, QUESTIONS.EPIC_DONE), [2899]);
  assert.deepEqual(found({ openRows: [row(3409, ["epic"], { subIssuesSummary: { total: 19, completed: 18 } })] }, QUESTIONS.EPIC_DONE), []);
  assert.deepEqual(found({ openRows: [row(1, ["epic"], { subIssuesSummary: { total: 0, completed: 0 } })] }, QUESTIONS.EPIC_DONE), []);
  assert.deepEqual(found({ openRows: [row(2, ["ready"], { subIssuesSummary: { total: 2, completed: 2 } })] }, QUESTIONS.EPIC_DONE), []);
});

test("(2) an open row a merged PR closes is found; one a PR names with `Closes: none`, an unmerged-PR-free row, and a cross-repo reference are not", () => {
  assert.deepEqual(found({ openRows: [row(10, ["ready"])], mergedPrs: [{ number: 900, body: "Closes #10" }] }, QUESTIONS.CLOSER_MERGED), [10]);
  assert.deepEqual(found({ openRows: [row(10, ["ready"])], mergedPrs: [{ number: 900, body: "Closes: none -- a docs change" }] }, QUESTIONS.CLOSER_MERGED), []);
  assert.deepEqual(found({ openRows: [row(10, ["ready"])], mergedPrs: [{ number: 900, body: "Closes #11" }] }, QUESTIONS.CLOSER_MERGED), []);
  assert.deepEqual(found({ openRows: [row(10, ["ready"])], mergedPrs: [{ number: 900, body: "Closes other/repo#10" }] }, QUESTIONS.CLOSER_MERGED), []);
});

test("(2) the copied `Closes` parser reads every body as `declaredRowsFromBody` does", () => {
  const bodies = ["Closes #10", "Closes: #10, #11", "closes #10 and #11", "Closes: none -- a docs change", "Closes other/repo#10", "Closes #10, other/repo#11", "Acceptance: x\nCloses #4\nCloses #5", "", "prose Closes #10 mid-line", null];
  for (const body of bodies) assert.deepEqual(closesOf(body), declaredRowsFromBody(body), JSON.stringify(body));
  assert.deepEqual(closesOf("Closes: #10, #11"), [10, 11], "the pin is not vacuous: it reads two rows");
});

test("(3) a claim nobody holds is found; a live holder and a fresh claim record each keep it", () => {
  const claimed = (/** @type {number} */ age) => row(11, ["in-progress", "session:worker-11"], { comments: [claimRecord(11, age)] });
  assert.deepEqual(found({ openRows: [claimed(600)], liveSessions: ["ceo"] }, QUESTIONS.NO_CLAIMANT), [11]);
  assert.deepEqual(found({ openRows: [claimed(600)], liveSessions: ["ceo", "worker-11"] }, QUESTIONS.NO_CLAIMANT), []);
  assert.deepEqual(found({ openRows: [claimed(10)], liveSessions: ["ceo"] }, QUESTIONS.NO_CLAIMANT), []);
  assert.deepEqual(found({ openRows: [row(11, ["in-progress"])], liveSessions: ["ceo"] }, QUESTIONS.NO_CLAIMANT), [11], "no `session:` label and no record is no claimant");
});

test("(3) the #3425 shape: `ready` carrying `no-code-left` is found, routed to its owner; the same label on an `in-progress` row is not", () => {
  const shaped = boardTruthAudit(facts({ openRows: [row(3425, ["ready", "lane:any", "no-code-left"])] })).findings;
  assert.deepEqual(shaped.map((f) => [f.number, f.question]), [[3425, QUESTIONS.NO_CLAIMANT]]);
  assert.match(shaped[0].field, /no-code-left/);
  assert.deepEqual(found({ openRows: [row(3418, ["in-progress", "session:worker-3418", "no-code-left"])], liveSessions: ["worker-3418"] }, QUESTIONS.NO_CLAIMANT), []);
  assert.deepEqual(found({ openRows: [row(3426, ["ready", "lane:any"])] }, QUESTIONS.NO_CLAIMANT), [], "a plain ready row has nothing left over");
});

test("(3) the freshness bound is the claim-stall's untold-release bound", () => {
  assert.equal(CLAIM_FRESH_MS, STALL_UNTOLD_RELEASE_MS);
});

test("(4) a parked row whose `Waiting-for:` is already true is found; one still waiting, and a `ready` row with the same line, are not", () => {
  const waitFacts = (/** @type {string} */ state) => ({ items: { "#50": { state, labels: [], resolvedAt: NOW, changedAt: NOW } } });
  const parked = row(12, ["parked"], { body: "Waiting-for: closed #50" });
  assert.deepEqual(found({ openRows: [parked], waitFacts: waitFacts("closed") }, QUESTIONS.WAIT_TRUE), [12]);
  assert.deepEqual(found({ openRows: [parked], waitFacts: waitFacts("open") }, QUESTIONS.WAIT_TRUE), []);
  assert.deepEqual(found({ openRows: [row(12, ["ready"], { body: "Waiting-for: closed #50" })], waitFacts: waitFacts("closed") }, QUESTIONS.WAIT_TRUE), []);
});

test("(4) a `Not-before:` that has passed on a backlog row is found; a future one is not", () => {
  assert.deepEqual(found({ openRows: [row(15, ["backlog"], { body: "Not-before: 2026-10-07" })] }, QUESTIONS.WAIT_TRUE), [15]);
  assert.deepEqual(found({ openRows: [row(15, ["backlog"], { body: "Not-before: 2026-10-09" })] }, QUESTIONS.WAIT_TRUE), []);
  assert.deepEqual(found({ openRows: [row(15, ["backlog"], { body: "Not-before: 2026-10-08T13:00:00Z" })] }, QUESTIONS.WAIT_TRUE), []);
  assert.deepEqual(found({ openRows: [row(15, ["backlog"], { body: "Not-before: 2026-10-08T11:00:00Z" })] }, QUESTIONS.WAIT_TRUE), [15]);
});

test("(5) a row with no state label and one with two are found; one with exactly one is not", () => {
  assert.deepEqual(found({ openRows: [row(13, ["lane:any"])] }, QUESTIONS.STATE_LABEL), [13]);
  assert.deepEqual(found({ openRows: [row(16, ["backlog", "parked"])] }, QUESTIONS.STATE_LABEL), [16]);
  assert.deepEqual(found({ openRows: [row(17, ["parked", "lane:any"])] }, QUESTIONS.STATE_LABEL), []);
});

test("(6) a near-duplicate of a closed row, a near-duplicate of an older open row, and `Superseded by` a completed row are found; their negatives are not", () => {
  const title = "org-health reads the board against reality every day and raises every row that disagrees";
  const closed = row(40, [], { state: "CLOSED", stateReason: "COMPLETED", title });
  assert.deepEqual(found({ openRows: [row(41, ["ready"], { title: `${title} again` })], closedRows: [closed] }, QUESTIONS.DUPLICATE), [41]);
  assert.deepEqual(found({ openRows: [row(41, ["ready"], { title: "a wholly different title about fleet provisioning and nothing else" })], closedRows: [closed] }, QUESTIONS.DUPLICATE), []);
  assert.deepEqual(found({ openRows: [row(30, ["ready"], { title }), row(31, ["ready"], { title })] }, QUESTIONS.DUPLICATE), [31], "the later of two open twins, once");
  assert.deepEqual(found({ openRows: [row(42, ["ready"], { title: "short title", body: "x" }), row(43, ["ready"], { title: "short title" })] }, QUESTIONS.DUPLICATE), [], "a short title says too little to match on");
  const superseded = (/** @type {string} */ reason) => ({ openRows: [row(44, ["backlog"], { body: "Superseded by #45" })], closedRows: [row(45, [], { state: "CLOSED", stateReason: reason, title: "x" })] });
  assert.deepEqual(found(superseded("COMPLETED"), QUESTIONS.DUPLICATE), [44]);
  assert.deepEqual(found(superseded("NOT_PLANNED"), QUESTIONS.DUPLICATE), []);
});

test("a fact that could not be read is UNREAD and never counted as agreeing", () => {
  const audit = boardTruthAudit(facts({ closedRows: null, mergedPrs: null, liveSessions: null, waitFacts: null }));
  assert.deepEqual(audit.unread.sort(), [QUESTIONS.CLOSER_MERGED, QUESTIONS.DUPLICATE, QUESTIONS.NO_CLAIMANT, QUESTIONS.WAIT_TRUE].sort());
  assert.deepEqual(boardTruthAudit(facts({ openRows: [row(11, ["in-progress", "session:worker-11"])], liveSessions: null })).findings, [], "no listing is not a dead holder");
});

test("the table puts the count first, names the field and the reader, and an all-agreeing board prints `0 disagree`", () => {
  const table = boardTruthTable(boardTruthAudit(facts({ ...BOARD, liveSessions: ["ceo"] })), DAY);
  const lines = table.split("\n");
  assert.match(lines[0], /2026-10-08/);
  assert.match(lines[2], /^\*\*\d+ disagree\*\*$/);
  assert.match(table, /\| #2899 \| epic-all-closed \| state \(open\) \|.*\| product-manager \|/);
  assert.match(table, /\| #3425 \| no-live-claimant \| label `no-code-left` \|/);
  const agreeing = boardTruthTable(boardTruthAudit(facts({ openRows: [row(10, ["ready"]), row(11, ["parked"])] })), DAY);
  assert.match(agreeing, /\*\*0 disagree\*\*/);
  assert.doesNotMatch(agreeing, /NOT READ/);
  const unread = boardTruthTable(boardTruthAudit(facts({ closedRows: null })), DAY);
  assert.match(unread, /0 disagree\*\* -- NOT READ, so not counted as agreeing: duplicate-or-superseded/);
});

test("org-health: a disagreeing board trips, keyed on its rows; an agreeing one is clear; an unread one is unknown; a refused one is unknown", () => {
  const tripped = boardTruthReading({ audit: boardTruthAudit(facts({ openRows: [row(13, [])] })), day: DAY });
  assert.equal(tripped.status, "tripped");
  assert.match(tripped.discriminator ?? "", /13state-label/);
  assert.match(tripped.detail, /\*\*1 disagree\*\*/);
  assert.equal(boardTruthReading({ audit: boardTruthAudit(facts({ openRows: [row(10, ["ready"])] })) }).status, "clear");
  assert.equal(boardTruthReading({ audit: boardTruthAudit(facts({ closedRows: null })) }).status, "unknown");
  assert.equal(boardTruthReading({ audit: null }).status, "unknown");
});

test("org-health: the reading is in the tick only when asked for, and its order goes to product-manager and ceo", () => {
  const base = { now: NOW, lastMergedAt: NOW, work: null, redPrs: [], refusals: [], drift: null, since: null };
  const without = orgHealthReadings(/** @type {any} */ (base));
  assert.ok(!without.some((r) => r.signal === SIGNALS.BOARD_TRUTH));
  const asked = orgHealthReadings(/** @type {any} */ ({ ...base, boardTruth: boardTruthAudit(facts({ openRows: [row(13, [])] })) }));
  assert.equal(asked.find((r) => r.signal === SIGNALS.BOARD_TRUTH)?.status, "tripped");
  const orders = orgHealthOrders(asked).filter((o) => o.subject === SIGNALS.BOARD_TRUTH);
  assert.deepEqual(orders.map((o) => o.session).sort(), ["ceo", "product-manager"]);
  assert.match(orders[0].prompt, /#13/);
});

test("the reader: a failed closed-row or merged-PR read is UNREAD (null), a partial herdr listing is UNREAD, and the open rows are read with the repo named", () => {
  const calls = [];
  const run = (/** @type {string[]} */ args) => {
    calls.push(args);
    if (args[1] === "list" && args.includes("closed")) throw new Error("HTTP 502");
    return JSON.stringify(args[0] === "pr" ? [{ number: 900, body: "Closes #10" }] : [{ number: 10, labels: [{ name: "ready" }] }]);
  };
  const standing = [{ label: "ceo", status: "idle" }, { label: "orchestrator", status: "idle" }, { label: "worker-11", status: "working" }];
  const read = readBoardFacts("a/b", { run, agents: () => standing, now: NOW });
  assert.equal(read.closedRows, null);
  assert.deepEqual(read.mergedPrs, [{ number: 900, body: "Closes #10" }]);
  assert.deepEqual(read.liveSessions, ["ceo", "orchestrator", "worker-11"]);
  assert.equal(read.waitFacts, null, "the wait facts are the tick's, so they are unread here");
  assert.ok(calls.every((args) => args.slice(-2).join(" ") === "--repo a/b"));
  assert.equal(readBoardFacts("a/b", { run, agents: () => [{ label: "worker-11", status: "working" }], now: NOW }).liveSessions, null, "no standing pane is not a listing of the org");
  assert.equal(readBoardFacts("a/b", { run, agents: () => null, now: NOW }).liveSessions, null);
  assert.throws(() => readBoardFacts("a/b", { run: () => { throw new Error("HTTP 502"); }, agents: () => null }), /502/);
});

// --- #4045: the tick passes `boardTruth`, and one table a day is posted on #928 ---------------------------------------------------

// A RECORDING `gh`, first on PATH and failing every call, so a call the tick makes through ANY seam (`defaultRun` is `execFileSync("gh", ...)`) is counted and the last test asserts none.
const SCRATCH = mkdtempSync(join(tmpdir(), "board-truth-tick-"));
after(() => rmSync(SCRATCH, { recursive: true, force: true }));
const GH_LOG = join(SCRATCH, "gh-calls.log");
writeFileSync(join(SCRATCH, "gh"), `#!/bin/sh\necho "$@" >> "${GH_LOG}"\nexit 1\n`);
chmodSync(join(SCRATCH, "gh"), 0o755);
process.env.PATH = `${SCRATCH}:${process.env.PATH}`;

/** @param {any[] | null} openRowsRead @param {Record<string, any>} [io] the whole tick, every read a seam: nothing here reaches GitHub, herdr or the fleet */
function tick(openRowsRead, io = {}) {
  const decideArgs = { prs: [], required: [], readyRows: [], prFiles: new Map(), rowBranches: [], openRows: openRowsRead ?? [], primaryDrift: null, claimRefusals: [] };
  const waits = { facts: { items: {} }, stale: [], bare: [], manual: [], umbrella: [] };
  return orgHealthNow(/** @type {any} */ ({ prsRead: [], readyRead: [], openRowsRead, decideArgs, decided: [] }), /** @type {any} */ ({ now: NOW, lastMergedAt: () => NOW,
    readCaptures: () => undefined, readLabJobs: () => [], readCopies: () => [], log: () => {}, teamAccess: () => undefined, readWaits: () => waits,
    readHolderAgents: () => null, ...io }));
}
/** @param {any[]} orders */
const boardTruthOrders = (orders) => orders.filter((o) => o.subject === SIGNALS.BOARD_TRUTH);
const wire = (/** @type {any} */ over = {}) => ({ repo: "a/b", run: () => "[]", agents: () => [{ label: "ceo", status: "idle" }, { label: "orchestrator", status: "idle" }, { label: "worker-11", status: "working" }], post: () => "posted", log: () => {}, ...over });
/** The tick's row as `readOpenRows` returns it: labels are objects, and there is no `state` and no `comments`. */
const tickRow = (/** @type {number} */ number, /** @type {string[]} */ labels, /** @type {Record<string, any>} */ more = {}) => ({ number, title: `row ${number}`, body: "", labels: labels.map((name) => ({ name })), ...more });

test("tick: rows that disagree pass a boardTruth that trips, rows that agree pass one that is clear, a refused open-row read passes null (unknown), and a caller that does not ask gets none", () => {
  const real = (/** @type {any} */ over = {}) => ({ readBoardTruth: (/** @type {any} */ input) => boardTruthNow(input, wire(over)) });
  const trips = boardTruthOrders(tick([tickRow(13, ["lane:any"])], real()));
  assert.deepEqual(trips.map((o) => o.session).sort(), ["ceo", "product-manager"]);
  assert.match(trips[0].prompt, /#13/);
  assert.deepEqual(boardTruthOrders(tick([tickRow(10, ["ready"])], real())), [], "an agreeing board raises nothing");
  const readings = (/** @type {any} */ rows, /** @type {any} */ io) => orgHealthReadings(/** @type {any} */ ({ now: NOW, lastMergedAt: NOW, work: null, redPrs: [], refusals: [], drift: null, since: null,
    ...boardTruthFact({ openRowsRead: rows, waitFacts: null, now: NOW }, io) })).find((r) => r.signal === SIGNALS.BOARD_TRUTH);
  const audit = (/** @type {any} */ input) => boardTruthNow(input, wire());
  assert.equal(readings([tickRow(13, ["lane:any"])], audit)?.status, "tripped");
  assert.equal(readings([tickRow(10, ["ready"])], (/** @type {any} */ input) => boardTruthNow({ ...input, waitFacts: { items: {} } }, wire()))?.status, "clear");
  assert.equal(readings(null, () => { throw new Error("a refused read is not read"); })?.status, "unknown");
  assert.equal(readings(undefined, audit), undefined, "OMITTED when the caller does not ask");
  assert.equal(tick([tickRow(13, ["lane:any"])]).some((r) => r.signal === SIGNALS.BOARD_TRUTH), false, "the seam's default asks for nothing");
});

test("tick: the wait facts the gate built are PASSED, so wait-already-true is read and a wait already true is found", () => {
  const parked = tickRow(12, ["parked"], { body: "Waiting-for: closed #50" });
  const viaTick = (/** @type {string} */ state) => boardTruthOrders(tick([parked], { readBoardTruth: (/** @type {any} */ input) => boardTruthNow(input, wire()),
    readWaits: () => ({ facts: { items: { "#50": { state, labels: [] } } }, stale: [], bare: [], manual: [], umbrella: [] }) }));
  assert.match(viaTick("closed")[0].prompt, /#12 \| wait-already-true/, "the facts the tick's own wait pass built reach the audit");
  assert.deepEqual(viaTick("open"), [], "the twin: the wait is still true of the world");
  const passed = (/** @type {any} */ waitFacts) => boardTruthNow({ openRowsRead: [parked], waitFacts, now: NOW }, wire());
  assert.ok(passed(null).unread.includes(QUESTIONS.WAIT_TRUE));
  const closed = passed({ items: { "#50": { state: "closed", labels: [] } } });
  assert.ok(!closed.unread.includes(QUESTIONS.WAIT_TRUE));
  assert.deepEqual(closed.findings.filter((f) => f.question === QUESTIONS.WAIT_TRUE).map((f) => f.number), [12]);
  const open = passed({ items: { "#50": { state: "open", labels: [] } } });
  assert.deepEqual(open.findings.filter((f) => f.question === QUESTIONS.WAIT_TRUE), [], "the twin: the wait is still true of the world");
});

test("tick: the open rows are the tick's own (no second open-list read), and a claimed row is judged only when its comments came with the page", () => {
  const calls = [];
  const run = (/** @type {string[]} */ args) => { calls.push(args); return "[]"; };
  boardTruthNow({ openRowsRead: [tickRow(10, ["ready"])], waitFacts: null, now: NOW }, wire({ run }));
  assert.ok(calls.length > 0 && calls.every((args) => args.includes("--state") && ["closed", "merged"].includes(args[args.indexOf("--state") + 1])), JSON.stringify(calls));
  const closedRead = calls.find((args) => args.includes("closed"));
  assert.ok(closedRead && !/body/.test(closedRead[closedRead.indexOf("--json") + 1]), "the closed rows ask for no body");
  const claimed = tickRow(11, ["in-progress", "session:worker-99"]);
  const judged = (/** @type {any} */ page) => boardTruthNow({ openRowsRead: [claimed], claimedComments: page, waitFacts: null, now: NOW }, wire());
  assert.deepEqual(judged([{ number: 11, comments: [claimRecord(11, 600)] }]).findings.map((f) => f.number), [11], "a stale record and no live holder is found");
  assert.deepEqual(judged([{ number: 11, comments: [claimRecord(11, 5)] }]).findings, [], "the twin: a fresh record keeps the claim");
  assert.deepEqual(judged(null).findings, [], "no comments page is not a dead claim");
  assert.ok(judged(null).unread.includes(QUESTIONS.NO_CLAIMANT), "and it says it did not read");
  assert.equal(boardRowsOf([claimed], [{ number: 11, comments: [claimRecord(11, 5)] }]).commentsComplete, true);
  assert.equal(boardRowsOf([claimed], []).commentsComplete, false);
  assert.equal(boardRowsOf([tickRow(10, ["ready"])], null).commentsComplete, true, "no claimed row needs no page");
});

test("the poster: a table is posted once per edition day -- count first, `0 disagree` stated -- and a second tick, a restart or a second host posts nothing", () => {
  const posted = [];
  let onRecord = "";
  const run = (/** @type {string[]} */ args) => {
    if (args[0] === "api") return onRecord;
    posted.push(args);
    onRecord = "4242\n";
    return "";
  };
  const clear = boardTruthAudit(facts({ openRows: [row(10, ["ready"])] }));
  assert.equal(postDaysTable({ audit: clear, day: DAY, repo: "a/b", run }), "posted");
  assert.equal(posted.length, 1);
  assert.deepEqual(posted[0].slice(0, 4), ["issue", "comment", TABLE_ROW, "--repo"]);
  const body = posted[0][posted[0].indexOf("--body") + 1];
  assert.match(body, /^### Board against reality, 2026-10-08\n\n\*\*0 disagree\*\*/);
  assert.equal(postDaysTable({ audit: clear, day: DAY, repo: "a/b", run }), "already-posted");
  assert.equal(posted.length, 1, "the second tick of the day posts nothing");
  onRecord = "";
  assert.equal(postDaysTable({ audit: clear, day: "2026-10-09", repo: "a/b", run }), "posted");
  assert.equal(posted.length, 2, "the twin: the next edition day is a new table");
});

test("the poster asks the record by the day's own heading, and posts nothing it could not decide on", () => {
  const asked = [];
  const run = (/** @type {string[]} */ args) => { asked.push(args); return ""; };
  postDaysTable({ audit: boardTruthAudit(facts({})), day: DAY, repo: "a/b", run });
  assert.match(asked[0].join(" "), /repos\/a\/b\/issues\/928\/comments\?per_page=100&since=2026-10-07T00:00:00Z/);
  assert.match(asked[0].join(" "), /startswith\("### Board against reality, 2026-10-08"\)/);
  const calls = [];
  const quiet = (/** @type {string[]} */ args) => { calls.push(args); return ""; };
  assert.equal(postDaysTable({ audit: null, day: DAY, repo: "a/b", run: quiet }), "no-audit");
  assert.equal(postDaysTable({ audit: boardTruthAudit(facts({ closedRows: null })), day: DAY, repo: "a/b", run: quiet }), "unread", "a table carrying NOT READ would stand for the day");
  assert.deepEqual(calls, [], "neither asked nor posted");
  const refusedAsk = (/** @type {string[]} */ args) => { calls.push(args); throw new Error("HTTP 403"); };
  assert.throws(() => postDaysTable({ audit: boardTruthAudit(facts({})), day: DAY, repo: "a/b", run: refusedAsk }), /403/);
  assert.equal(calls.length, 1, "a record that could not be asked is not posted to: it might be there already");
});

test("the tick posts through boardTruthNow once, a failed post never stops the tick, and the gate really passes it", () => {
  const posts = [];
  const post = (/** @type {any} */ input) => { posts.push(input.day); return "posted"; };
  const audit = boardTruthNow({ openRowsRead: [tickRow(10, ["ready"])], waitFacts: { items: {} }, now: Date.parse("2026-10-08T23:30:00Z") }, wire({ post }));
  assert.deepEqual(posts, ["2026-10-09"], "the day is London's: 23:30 UTC on 8 October is already the 9th in BST");
  assert.equal(audit.findings.length, 0);
  const said = [];
  const failing = boardTruthNow({ openRowsRead: [tickRow(13, [])], waitFacts: null, now: NOW }, wire({ post: () => { throw new Error("HTTP 502\nbody"); }, log: (/** @type {string} */ l) => said.push(l) }));
  assert.equal(failing.findings.length, 1, "the audit is returned all the same");
  assert.match(said.join(""), /not posted \(HTTP 502\); the next tick asks again/);
  const gate = readFileSync(new URL("./work-gate.mjs", import.meta.url), "utf8");
  assert.match(gate, /orgHealthNow\([^]*readBoardTruth: boardTruthNow/, "a gate that never passed it would leave the signal dead, as #2980's fleet facts did");
});

test("no test above reached a remote: the recording gh was never called", () => {
  assert.equal(existsSync(GH_LOG) ? readFileSync(GH_LOG, "utf8") : "", "");
  assert.throws(() => execFileSync("sh", ["-c", "gh positive-control"], { stdio: "ignore" }), "resolved through PATH by the shell, so the test spawns no `gh` itself");
  assert.match(readFileSync(GH_LOG, "utf8"), /positive-control/, "the control: a call that IS made is logged, so the empty log above was a reading");
});
