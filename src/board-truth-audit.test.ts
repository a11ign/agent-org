// no-token: gh -- `board-truth-audit.ts` reaches `gh` and `herdr` only through the readers `readBoardFacts` is given; every one this file calls is an injected fake, and the live read was run by hand and is pasted on the pull request (a11ign/a11ign#4043)
// a11ign/a11ign#4043: the board is read against reality, and every row whose state disagrees is named with the field to fix. Fixtures only: nothing here reaches GitHub or herdr.
//
// POSITIVE AND NEGATIVE CONTROL PER QUESTION: each `disagrees` test has an `agrees` twin that differs by ONE fact, so a question that always fires is red in the twin and one that
// never fires is red in the first. The chairman's two cases are fixtures: #2899 (an epic, 13 of 13 children closed, open) and the #3425 shape (`ready` carrying `no-code-left`).
// `emptiness` is the control for every `[]` here: the same audit finds each of the eight rows in `BOARD` below, so an empty result is a reading and not an unwired reader.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLAIM_FRESH_MS, QUESTIONS, TABLE_ROW, boardTruthAudit, boardTruthTable, closesOf, postDaysTable, readBoardFacts } from "./board-truth-audit.ts";
import { declaredRowsFromBody } from "./close-rows-for-merged-pr.ts";
import { boardTruthReading, orgHealthOrders, orgHealthReadings, SIGNALS } from "./org-health.ts";
import { STALL_UNTOLD_RELEASE_MS } from "./claim-stall.ts";
import { boardRowsOf, boardTruthFact, boardTruthNow, orgHealthNow } from "./work-gate/org-health.ts";

const NOW = Date.parse("2026-10-08T12:00:00Z");
const MINUTE = 60_000;
const DAY = "2026-10-08";

/** @param {number} number @param {string[]} labels @param {Record<string, any>} [more] */
const row = (number: number, labels: string[], more: Record<string, any> = {}) => ({ number, title: ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta"].map((w) => `${w}${number}`).join(" "), body: "", state: "OPEN", labels, ...more });
/** @param {number} number @param {number} minutesAgo */
const claimRecord = (number: number, minutesAgo: number) => ({ body: `<!-- row-claim: claim record -->\n**Claim record** -- claimed by \`worker-${number}\`.`,
  createdAt: new Date(NOW - minutesAgo * MINUTE).toISOString() });

/** @param {Partial<import("./board-truth-audit.ts").BoardFacts>} over @returns {import("./board-truth-audit.ts").BoardFacts} */
const facts = (over: Partial<import("./board-truth-audit.ts").BoardFacts>): import("./board-truth-audit.ts").BoardFacts => ({ now: NOW, openRows: [], closedRows: [], mergedPrs: [], liveSessions: [], waitFacts: { items: {} }, ...over });
/** @param {Partial<import("./board-truth-audit.ts").BoardFacts>} over @param {string} question @returns {number[]} the rows found for one question */
const found = (over: Partial<import("./board-truth-audit.ts").BoardFacts>, question: string): number[] => boardTruthAudit(facts(over)).findings.filter((f) => f.question === question).map((f) => f.number);

/** #4159's shape exactly: parked behind a DATE, while the `Blocked-on:` line says the wait is the chairman's session. */
const CHAIRMAN_BODY = "## Why\n\nBlocked-on: the chairman's session minting a fine-grained token (this repository alone, `contents: write`)\nNot-before: 2026-10-15T00:00:00Z";

const BOARD = {
  openRows: [
    row(2899, ["epic", "out-of-release", "lane:any"], { subIssuesSummary: { total: 13, completed: 13 } }),
    row(3425, ["ready", "out-of-release", "lane:any", "no-code-left"]),
    row(10, ["ready"], { body: "the work" }),
    row(11, ["in-progress", "session:worker-11"], { comments: [claimRecord(11, 600)] }),
    row(12, ["parked"], { body: "Waiting-for: closed #50" }),
    row(13, []),
    row(15, ["parked"], { body: "lifts when the thing is done", blockedBy: { nodes: [] } }),
    row(4159, ["parked", "lane:any"], { body: CHAIRMAN_BODY }),
    row(14, ["backlog"], { title: "Chairman messaging for agent-org, Telegram first: the design and the sequence" }),
  ],
  closedRows: [row(50, ["ready"], { state: "CLOSED", stateReason: "COMPLETED" }),
    row(51, [], { state: "CLOSED", stateReason: "COMPLETED", title: "Chairman messaging for agent-org, Telegram first: the design and the sequence" })],
  mergedPrs: [{ number: 900, body: "Acceptance: x\nCloses #10" }],
  waitFacts: { items: { "#50": { state: "closed", labels: [], resolvedAt: NOW, changedAt: NOW } } },
};

test("emptiness control: the seeded board is found on all eight questions, so the empty results below are readings", () => {
  const audit = boardTruthAudit(facts(({ ...BOARD, liveSessions: ["ceo"] } as any)));
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
  const claimed = (age: number) => row(11, ["in-progress", "session:worker-11"], { comments: [claimRecord(11, age)] });
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
  const waitFacts = (state: string): any => ({ items: { "#50": { state, labels: [], resolvedAt: NOW, changedAt: NOW } } });
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

test("#4116: an open row whose closing PR merged 1 minute ago is NOT found and is counted `merging`; merged 10 minutes ago it IS found (the control), and an unreadable merge time never hides it", () => {
  const at = (minutesAgo: any) => new Date(NOW - minutesAgo * MINUTE).toISOString();
  const withPr = (pr: Record<string, any>) => boardTruthAudit(facts({ openRows: [row(10, ["ready"])], mergedPrs: [{ number: 900, body: "Closes #10", ...pr }] }));
  const young = withPr({ mergedAt: at(1) });
  assert.deepEqual(young.findings, []);
  assert.equal(young.merging, 1);
  const old = withPr({ mergedAt: at(10) });
  assert.deepEqual(old.findings.map((f) => f.number), [10], "CONTROL: with the grace gone the first case is red");
  assert.equal(old.merging, 0);
  for (const unreadable of [undefined, null, "not a date"]) {
    const audit = withPr({ mergedAt: unreadable });
    assert.deepEqual(audit.findings.map((f) => f.number), [10], `mergedAt ${String(unreadable)} is judged`);
    assert.equal(audit.merging, 0);
  }
  const both = boardTruthAudit(facts({ openRows: [row(10, ["ready"])], mergedPrs: [{ number: 900, body: "Closes #10", mergedAt: at(1) }, { number: 901, body: "Closes #10", mergedAt: at(30) }] }));
  assert.deepEqual(both.findings.map((f) => f.number), [10], "a row an older merge also closes is raised, not withheld");
  assert.equal(both.merging, 0);
});

test("#4116: the grace applies to a keyed tracker's code-repository merges too, and its rows are counted in the same `merging`", () => {
  const mergedAt = new Date(NOW - MINUTE).toISOString();
  const other = { key: "agent-org", repo: "a/org", facts: facts({ openRows: [row(7, ["ready"])], mergedPrs: [{ number: 380, body: "Closes #7", mergedAt }] }) };
  const audit = boardTruthAudit(facts({ others: [other] }));
  assert.deepEqual(audit.findings, []);
  assert.equal(audit.merging, 1);
  const stale = { ...other, facts: facts({ openRows: [row(7, ["ready"])], mergedPrs: [{ number: 380, body: "Closes #7", mergedAt: new Date(NOW - 10 * MINUTE).toISOString() }] }) };
  assert.deepEqual(boardTruthAudit(facts({ others: [stale] })).findings.map((f) => `${f.key}#${f.number}`), ["agent-org#7"]);
});

test("#4116: the table says `N merging, not judged` beside the count only when N is above 0, and with 0 the output is today's", () => {
  const mergedAt = new Date(NOW - MINUTE).toISOString();
  const withMerge = boardTruthTable(boardTruthAudit(facts({ openRows: [row(10, ["ready"])], mergedPrs: [{ number: 900, body: "Closes #10", mergedAt }] })), DAY);
  assert.match(withMerge, /\*\*0 disagree\*\*, 1 merging, not judged$/);
  assert.doesNotMatch(withMerge, /\| #10 \|/, "the withheld row has no line");
  const bothNotes = boardTruthTable(boardTruthAudit(facts({ openRows: [row(10, ["ready"]), row(4047, [], { createdAt: new Date(NOW - 13_000).toISOString() })],
    mergedPrs: [{ number: 900, body: "Closes #10", mergedAt }] })), DAY);
  assert.match(bothNotes, /\*\*0 disagree\*\*, 1 filing, not judged, 1 merging, not judged$/);
  const none = boardTruthTable(boardTruthAudit(facts({ openRows: [row(10, ["ready"])], mergedPrs: [{ number: 900, body: "Closes #10" }] })), DAY);
  assert.doesNotMatch(none, /merging/, "CONTROL: none withheld, nothing said");
  assert.equal(boardTruthTable({ findings: [], unread: [] }, DAY), `### Board against reality, ${DAY}\n\n**0 disagree**`, "an audit without the field prints as it did");
});

test("#4116: every merged-PR read asks for `mergedAt`, the first tracker's and the code repository's", () => {
  const asked: any[] = [];
  const run = (args: string[]) => { if (args[0] === "pr") asked.push(args); return "[]"; };
  const trackers = [{ key: "", repo: "a/b" }, { key: "agent-org", repo: "a/org", codeRepo: "a/org-code" }];
  readBoardFacts("a/b", { run, agents: () => null, now: NOW, trackers });
  assert.deepEqual(asked.map((a) => a.at(-1)), ["a/b", "a/org-code"], "CONTROL: both merged-PR reads were made");
  assert.ok(asked.every((a) => /(^|,)mergedAt(,|$)/.test(a[a.indexOf("--json") + 1])));
});

test("(5) #4048: a row with no state label created 13 s ago is NOT found and is counted as filing; the same row 10 minutes old IS found and is not", () => {
  const at = (secondsAgo: any) => new Date(NOW - secondsAgo * 1000).toISOString();
  const young = boardTruthAudit(facts({ openRows: [row(4047, ["meta"], { createdAt: at(13) })] }));
  assert.deepEqual(young.findings, []);
  assert.equal(young.filing, 1);
  const old = boardTruthAudit(facts({ openRows: [row(4047, ["meta"], { createdAt: at(600) })] }));
  assert.deepEqual(old.findings.map((f) => f.number), [4047]);
  assert.equal(old.filing, 0);
  assert.deepEqual(found({ openRows: [row(9, ["backlog", "parked"], { createdAt: at(13) })] }, QUESTIONS.STATE_LABEL), [9], "two states are found at any age");
  assert.deepEqual(found({ openRows: [row(10, ["meta"])] }, QUESTIONS.STATE_LABEL), [10], "no createdAt is judged");
  assert.deepEqual(found({ openRows: [row(11, ["meta"], { createdAt: "not a date" })] }, QUESTIONS.STATE_LABEL), [11], "an unparseable one is judged");
});

test("#4048: the table says `N filing, not judged` for the excused rows, does not count them as disagreeing, and says `0 disagree` when that is all there is", () => {
  const createdAt = new Date(NOW - 13_000).toISOString();
  const only = boardTruthTable(boardTruthAudit(facts({ openRows: [row(4047, [], { createdAt }), row(4048, ["meta"], { createdAt })] })), DAY);
  assert.match(only, /\*\*0 disagree\*\*, 2 filing, not judged$/);
  const mixed = boardTruthTable(boardTruthAudit(facts({ openRows: [row(4047, [], { createdAt }), row(13, [])] })), DAY);
  assert.match(mixed, /\*\*1 disagree\*\*, 1 filing, not judged/);
  assert.doesNotMatch(mixed, /\| #4047 \|/, "the excused row has no line");
  assert.doesNotMatch(boardTruthTable(boardTruthAudit(facts({ openRows: [row(10, ["ready"], { createdAt })] })), DAY), /filing/, "CONTROL: none excused, nothing said");
  assert.match(boardTruthTable(boardTruthAudit(facts({ openRows: [row(4047, [], { createdAt })], closedRows: null })), DAY), /0 disagree\*\*, 1 filing, not judged -- NOT READ/);
});

test("(6) a near-duplicate of a closed row, a near-duplicate of an older open row, and `Superseded by` a completed row are found; their negatives are not", () => {
  const title = "org-health reads the board against reality every day and raises every row that disagrees";
  const closed = row(40, [], { state: "CLOSED", stateReason: "COMPLETED", title });
  assert.deepEqual(found({ openRows: [row(41, ["ready"], { title: `${title} again` })], closedRows: [closed] }, QUESTIONS.DUPLICATE), [41]);
  assert.deepEqual(found({ openRows: [row(41, ["ready"], { title: "a wholly different title about fleet provisioning and nothing else" })], closedRows: [closed] }, QUESTIONS.DUPLICATE), []);
  assert.deepEqual(found({ openRows: [row(30, ["ready"], { title }), row(31, ["ready"], { title })] }, QUESTIONS.DUPLICATE), [31], "the later of two open twins, once");
  assert.deepEqual(found({ openRows: [row(42, ["ready"], { title: "short title", body: "x" }), row(43, ["ready"], { title: "short title" })] }, QUESTIONS.DUPLICATE), [], "a short title says too little to match on");
  const superseded = (reason: string) => ({ openRows: [row(44, ["backlog"], { body: "Superseded by #45" })], closedRows: [row(45, [], { state: "CLOSED", stateReason: reason, title: "x" })] });
  assert.deepEqual(found(superseded("COMPLETED"), QUESTIONS.DUPLICATE), [44]);
  assert.deepEqual(found(superseded("NOT_PLANNED"), QUESTIONS.DUPLICATE), []);
});

/** The adoption rows of a11ign/a11ign#4127 as filed: one title, six repositories. @param {string} repo */
const adoptionTitle = (repo: string) => `Adopt the shared changeset-required check in a11ign/${repo}: a pull request changing its releasable paths with no changeset and no no-release: line fails its gate (adoption of #4127, class fix for #4084)`;
const ADOPTION_ROWS = [[4129, "agent-org"], [4130, "screenreader-worker"], [4132, "screenreader-fleet"], [4133, "documents"], [4134, "lab"], [4135, "control"]];

test("sibling adoption rows naming different repositories are not near-duplicates (#4137)", () => {
  const siblings = ADOPTION_ROWS.map(([number, repo]) => row((number as any), ["ready"], { title: adoptionTitle((repo as any)) }));
  assert.deepEqual(found({ openRows: siblings }, QUESTIONS.DUPLICATE), [], "the real titles of #4129-#4135 are six rows, not one");
  // POSITIVE CONTROL for the line above: with the repository name taken out of the titles the same six rows ARE read as one, so the empty result is a reading.
  const unnamed = ADOPTION_ROWS.map(([number]) => row((number as any), ["ready"], { title: adoptionTitle("x").replace("a11ign/x", "the repository") }));
  assert.deepEqual(found({ openRows: unnamed }, QUESTIONS.DUPLICATE), [4130, 4132, 4133, 4134, 4135]);
  // a title naming the same repository and one word more is still a real twin
  const twin = row(4136, ["ready"], { title: `${adoptionTitle("screenreader-worker")} again` });
  assert.deepEqual(found({ openRows: [siblings[1], twin] }, QUESTIONS.DUPLICATE), [4136]);
  assert.deepEqual(found({ openRows: [siblings[1], row(4136, ["ready"], { title: adoptionTitle("Screenreader-Worker") })] }, QUESTIONS.DUPLICATE), [4136], "a repository name is compared lower-cased");
  assert.deepEqual(found({ openRows: [siblings[1], row(4136, ["ready"], { title: adoptionTitle("screenreader-worker").replace("a11ign/screenreader-worker:", "a11ign/screenreader-worker,") })] }, QUESTIONS.DUPLICATE), [4136], "a trailing `:` or `,` is not part of the name");
  assert.deepEqual(found({ openRows: [siblings[4], row(4136, ["ready"], { title: adoptionTitle("lab").replace("a11ign/lab:", "a11ign/lab.") })] }, QUESTIONS.DUPLICATE), [4136], "a trailing `.` is not part of the name");
  // a title naming a repository against one naming none is compared as before
  const prose = row(4137, ["ready"], { title: adoptionTitle("x").replace("a11ign/x", "the repository") });
  assert.deepEqual(found({ openRows: [prose, row(4138, ["ready"], { title: adoptionTitle("lab") })] }, QUESTIONS.DUPLICATE), [4138]);
  // against a closed row: the same repository is the question, a different one is not
  const lab = (number: number, repo: string) => row(number, ["ready"], { title: `Repair the ${repo} stability gate reading in a11ign/${repo} so that every corpus run is read once` });
  const closed = { ...lab(50, "lab"), state: "CLOSED", stateReason: "COMPLETED" };
  assert.deepEqual(found({ openRows: [lab(51, "lab")], closedRows: [closed] }, QUESTIONS.DUPLICATE), [51]);
  assert.deepEqual(found({ openRows: [lab(51, "control")], closedRows: [{ ...closed, title: lab(50, "lab").title.replace("lab stability", "control stability") }] }, QUESTIONS.DUPLICATE), [], "a11ign/lab against a11ign/control");
});

test("a fact that could not be read is UNREAD and never counted as agreeing", () => {
  const audit = boardTruthAudit(facts({ closedRows: null, mergedPrs: null, liveSessions: null, waitFacts: null }));
  assert.deepEqual(audit.unread.sort(), [QUESTIONS.CLOSER_MERGED, QUESTIONS.DUPLICATE, QUESTIONS.NO_CLAIMANT, QUESTIONS.WAIT_TRUE].sort());
  assert.deepEqual(boardTruthAudit(facts({ openRows: [row(11, ["in-progress", "session:worker-11"])], liveSessions: null })).findings, [], "no listing is not a dead holder");
});

test("the table puts the count first, names the field and the reader, and an all-agreeing board prints `0 disagree`", () => {
  const table = boardTruthTable(boardTruthAudit(facts(({ ...BOARD, liveSessions: ["ceo"] } as any))), DAY);
  const lines = table.split("\n");
  assert.match(lines[0], /2026-10-08/);
  assert.match(lines[2], /^\*\*\d+ disagree\*\*$/);
  assert.match(table, /\| #2899 \| epic-all-closed \| state \(open\) \|.*\| product-manager \|/);
  assert.match(table, /\| #3425 \| no-live-claimant \| label `no-code-left` \|/);
  const agreeing = boardTruthTable(boardTruthAudit(facts({ openRows: [row(10, ["ready"]), row(11, ["parked"], { body: "Not-before: 2099-01-01", blockedBy: { nodes: [] } })] })), DAY);
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
  const without = orgHealthReadings((base as any));
  assert.ok(!without.some((r) => r.signal === SIGNALS.BOARD_TRUTH));
  const asked = orgHealthReadings(({ ...base, boardTruth: boardTruthAudit(facts({ openRows: [row(13, [])] })) } as any));
  assert.equal(asked.find((r) => r.signal === SIGNALS.BOARD_TRUTH)?.status, "tripped");
  const orders = orgHealthOrders(asked).filter((o) => o.subject === SIGNALS.BOARD_TRUTH);
  assert.deepEqual(orders.map((o) => o.session).sort(), ["ceo", "product-manager"]);
  assert.match(orders[0].prompt, /#13/);
});

test("the reader: a failed closed-row or merged-PR read is UNREAD (null), a partial herdr listing is UNREAD, and the open rows are read with the repo named", () => {
  const calls: any[] = [];
  const run = (args: string[]) => {
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
function tick(openRowsRead: any[] | null, io: Record<string, any> = {}) {
  const decideArgs = { prs: [], required: [], readyRows: [], prFiles: new Map(), rowBranches: [], openRows: openRowsRead ?? [], primaryDrift: null, claimRefusals: [] };
  const waits = { facts: { items: {} }, stale: [], bare: [], manual: [], umbrella: [] };
  return orgHealthNow(({ prsRead: [], readyRead: [], openRowsRead, decideArgs, decided: [] } as any), ({ now: NOW, lastMergedAt: () => NOW,
    readCaptures: () => undefined, readLabJobs: () => [], readCopies: () => [], log: () => {}, teamAccess: () => undefined, readWaits: () => waits,
    readHolderAgents: () => null, ...io } as any));
}
/** @param {any[]} orders */
const boardTruthOrders = (orders: any[]) => orders.filter((o) => o.subject === SIGNALS.BOARD_TRUTH);
const wire = (over: any = {}) => ({ repo: "a/b", run: () => "[]", agents: () => [{ label: "ceo", status: "idle" }, { label: "orchestrator", status: "idle" }, { label: "worker-11", status: "working" }], post: () => "posted", log: () => {}, ...over });
/** The tick's row as `readOpenRows` returns it: labels are objects, and there is no `state` and no `comments`. */
const tickRow = (number: number, labels: string[], more: Record<string, any> = {}) => ({ number, title: `row ${number}`, body: "", labels: labels.map((name) => ({ name })), ...more });

test("tick: rows that disagree pass a boardTruth that trips, rows that agree pass one that is clear, a refused open-row read passes null (unknown), and a caller that does not ask gets none", () => {
  const real = (over: any = {}) => ({ readBoardTruth: (input: any) => boardTruthNow(input, wire(over)) });
  const trips = boardTruthOrders(tick([tickRow(13, ["lane:any"])], real()));
  assert.deepEqual(trips.map((o) => o.session).sort(), ["ceo", "product-manager"]);
  assert.match(trips[0].prompt, /#13/);
  assert.deepEqual(boardTruthOrders(tick([tickRow(10, ["ready"])], real())), [], "an agreeing board raises nothing");
  const readings = (rows: any, io: any) => orgHealthReadings(({ now: NOW, lastMergedAt: NOW, work: null, redPrs: [], refusals: [], drift: null, since: null,
    ...boardTruthFact({ openRowsRead: rows, waitFacts: null, now: NOW }, io) } as any)).find((r) => r.signal === SIGNALS.BOARD_TRUTH);
  const audit = (input: any) => boardTruthNow(input, wire());
  assert.equal(readings([tickRow(13, ["lane:any"])], audit)?.status, "tripped");
  assert.equal(readings([tickRow(10, ["ready"])], (input: any) => boardTruthNow({ ...input, waitFacts: { items: {} } }, wire()))?.status, "clear");
  assert.equal(readings(null, () => { throw new Error("a refused read is not read"); })?.status, "unknown");
  assert.equal(readings(undefined, audit), undefined, "OMITTED when the caller does not ask");
  assert.equal(tick([tickRow(13, ["lane:any"])]).some((r) => r.signal === SIGNALS.BOARD_TRUTH), false, "the seam's default asks for nothing");
});

test("tick: the wait facts the gate built are PASSED, so wait-already-true is read and a wait already true is found", () => {
  const parked = tickRow(12, ["parked"], { body: "Waiting-for: closed #50" });
  const viaTick = (state: string) => boardTruthOrders(tick([parked], { readBoardTruth: (input: any) => boardTruthNow(input, wire()),
    readWaits: () => ({ facts: { items: { "#50": { state, labels: [] } } }, stale: [], bare: [], manual: [], umbrella: [] }) }));
  assert.match(viaTick("closed")[0].prompt, /#12 \| wait-already-true/, "the facts the tick's own wait pass built reach the audit");
  assert.deepEqual(viaTick("open"), [], "the twin: the wait is still true of the world");
  const passed = (waitFacts: any) => boardTruthNow({ openRowsRead: [parked], waitFacts, now: NOW }, wire());
  assert.ok(passed(null).unread.includes(QUESTIONS.WAIT_TRUE));
  const closed = passed({ items: { "#50": { state: "closed", labels: [] } } });
  assert.ok(!closed.unread.includes(QUESTIONS.WAIT_TRUE));
  assert.deepEqual(closed.findings.filter((f) => f.question === QUESTIONS.WAIT_TRUE).map((f) => f.number), [12]);
  const open = passed({ items: { "#50": { state: "open", labels: [] } } });
  assert.deepEqual(open.findings.filter((f) => f.question === QUESTIONS.WAIT_TRUE), [], "the twin: the wait is still true of the world");
});

test("tick: the open rows are the tick's own (no second open-list read), and a claimed row is judged only when its comments came with the page", () => {
  const calls: any[] = [];
  const run = (args: string[]) => { calls.push(args); return "[]"; };
  boardTruthNow({ openRowsRead: [tickRow(10, ["ready"])], waitFacts: null, now: NOW }, wire({ run }));
  assert.ok(calls.length > 0 && calls.every((args) => args.includes("--state") && ["closed", "merged"].includes(args[args.indexOf("--state") + 1])), JSON.stringify(calls));
  const closedRead = calls.find((args) => args.includes("closed"));
  assert.ok(closedRead && !/body/.test(closedRead[closedRead.indexOf("--json") + 1]), "the closed rows ask for no body");
  const claimed = tickRow(11, ["in-progress", "session:worker-99"]);
  const judged = (page: any) => boardTruthNow({ openRowsRead: [claimed], claimedComments: page, waitFacts: null, now: NOW }, wire());
  assert.deepEqual(judged([{ number: 11, comments: [claimRecord(11, 600)] }]).findings.map((f) => f.number), [11], "a stale record and no live holder is found");
  assert.deepEqual(judged([{ number: 11, comments: [claimRecord(11, 5)] }]).findings, [], "the twin: a fresh record keeps the claim");
  assert.deepEqual(judged(null).findings, [], "no comments page is not a dead claim");
  assert.ok(judged(null).unread.includes(QUESTIONS.NO_CLAIMANT), "and it says it did not read");
  assert.equal(boardRowsOf([claimed], [{ number: 11, comments: [claimRecord(11, 5)] }]).commentsComplete, true);
  assert.equal(boardRowsOf([claimed], []).commentsComplete, false);
  assert.equal(boardRowsOf([tickRow(10, ["ready"])], null).commentsComplete, true, "no claimed row needs no page");
});

test("the poster: a table is posted once per edition day -- count first, `0 disagree` stated -- and a second tick, a restart or a second host posts nothing", () => {
  const posted: any[] = [];
  let onRecord = "";
  const run = (args: string[]) => {
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
  const asked: any[] = [];
  const run = (args: string[]) => { asked.push(args); return ""; };
  postDaysTable({ audit: boardTruthAudit(facts({})), day: DAY, repo: "a/b", run });
  assert.match(asked[0].join(" "), /repos\/a\/b\/issues\/928\/comments\?per_page=100&since=2026-10-07T00:00:00Z/);
  assert.match(asked[0].join(" "), /startswith\("### Board against reality, 2026-10-08"\)/);
  const calls: any[] = [];
  const quiet = (args: string[]) => { calls.push(args); return ""; };
  assert.equal(postDaysTable({ audit: null, day: DAY, repo: "a/b", run: quiet }), "no-audit");
  assert.equal(postDaysTable({ audit: boardTruthAudit(facts({ closedRows: null })), day: DAY, repo: "a/b", run: quiet }), "unread", "a table carrying NOT READ would stand for the day");
  assert.deepEqual(calls, [] as any[], "neither asked nor posted");
  const refusedAsk = (args: string[]) => { calls.push(args); throw new Error("HTTP 403"); };
  assert.throws(() => postDaysTable({ audit: boardTruthAudit(facts({})), day: DAY, repo: "a/b", run: refusedAsk }), /403/);
  assert.equal(calls.length, 1, "a record that could not be asked is not posted to: it might be there already");
});

test("the tick posts through boardTruthNow once, a failed post never stops the tick, and the gate really passes it", () => {
  const posts: any[] = [];
  const post = (input: any) => { posts.push(input.day); return "posted"; };
  const audit = boardTruthNow({ openRowsRead: [tickRow(10, ["ready"])], waitFacts: { items: {} }, now: Date.parse("2026-10-08T23:30:00Z") }, wire({ post }));
  assert.deepEqual(posts, ["2026-10-09"], "the day is London's: 23:30 UTC on 8 October is already the 9th in BST");
  assert.equal(audit.findings.length, 0);
  const said: any[] = [];
  const failing = boardTruthNow({ openRowsRead: [tickRow(13, [])], waitFacts: null, now: NOW }, wire({ post: () => { throw new Error("HTTP 502\nbody"); }, log: (l: string) => said.push(l) }));
  assert.equal(failing.findings.length, 1, "the audit is returned all the same");
  assert.match(said.join(""), /not posted \(HTTP 502\); the next tick asks again/);
  const gate = readFileSync(new URL("./work-gate.ts", import.meta.url), "utf8");
  assert.match(gate, /orgHealthNow\([^]*readBoardTruth: boardTruthNow/, "a gate that never passed it would leave the signal dead, as #2980's fleet facts did");
});

test("no test above reached a remote: the recording gh was never called", () => {
  assert.equal(existsSync(GH_LOG) ? readFileSync(GH_LOG, "utf8") : "", "");
  assert.throws(() => execFileSync("sh", ["-c", "gh positive-control"], { stdio: "ignore" }), "resolved through PATH by the shell, so the test spawns no `gh` itself");
  assert.match(readFileSync(GH_LOG, "utf8"), /positive-control/, "the control: a call that IS made is logged, so the empty log above was a reading");
});

// ---- the seventh question: a `parked` row with no condition the gate can read (a11ign/a11ign#4049, chairman rule 1, 2026-10-08) ----
/** @param {number} number @param {string[]} labels @param {Record<string, any>} [more] a row read WITH its `blockedBy` edges, as the tick reads them */
const edged = (number: number, labels: string[], more: Record<string, any> = {}) => row(number, labels, { blockedBy: { nodes: [] }, ...more });
const bare = (over: any) => found({ openRows: [edged(3449, ["parked"], over)] }, QUESTIONS.PARKED_BARE);

test("(1) a parked row with no condition of any kind is a finding owned by product-manager: the positive control for every emptiness below", () => {
  const audit = boardTruthAudit(facts({ openRows: [edged(3449, ["parked", "lane:any"], { body: "lifts once the aged-backlog order is settled" })] }));
  const [one, ...rest] = audit.findings.filter((f) => f.question === QUESTIONS.PARKED_BARE);
  assert.deepEqual(rest, []);
  assert.equal(one.number, 3449);
  assert.equal(one.route, "product-manager");
  assert.match(one.detail, /needs:chairman/, "and the finding says the other way out");
  assert.deepEqual(audit.unread, [], "the edges were read, so the question is a reading");
  assert.match(boardTruthTable(audit, DAY), /\| #3449 \| parked-without-condition \|.*\| product-manager \|/);
});

test("(2) a Not-before line, a Waiting-for line, an open blockedBy edge and an answer:<session> label are each a condition, so none is a finding", () => {
  assert.deepEqual(bare({ body: "Not-before: 2099-01-01" }), []);
  assert.deepEqual(bare({ body: "Not-before: 2099-01-01T09:00:00Z" }), []);
  assert.deepEqual(bare({ body: "Waiting-for: closed #50" }), []);
  assert.deepEqual(bare({ body: "Waiting-for: soon" }), [], "a Waiting-for outside the grammar is wait-without-reason's defect, not this one's");
  assert.deepEqual(bare({ blockedBy: { nodes: [{ number: 50, state: "OPEN" }] } }), []);
  assert.deepEqual(found({ openRows: [edged(3449, ["parked", "answer:product-manager"])] }, QUESTIONS.PARKED_BARE), []);
  assert.deepEqual(bare({ blockedBy: { nodes: [{ number: 50, state: "CLOSED" }] } }), [3449], "a CLOSED blocker is a condition that has cleared, so the row is bare again");
  assert.deepEqual(bare({ body: "see Not-before: later" }), [3449], "prose is not the field");
});

test("(3) a parked row carrying needs:chairman is not a finding; the same row without it is", () => {
  assert.deepEqual(found({ openRows: [edged(3449, ["parked", "needs:chairman"])] }, QUESTIONS.PARKED_BARE), []);
  assert.deepEqual(found({ openRows: [edged(3449, ["parked"])] }, QUESTIONS.PARKED_BARE), [3449]);
});

test("(4) a backlog row, a ready row and a claimed row with no condition are not findings: the rule is about parked", () => {
  for (const state of ["backlog", "ready", "in-progress"]) assert.deepEqual(found({ openRows: [edged(7, [state])] }, QUESTIONS.PARKED_BARE), [], state);
});

test("(5) a parked row read without its blockedBy edges is UNREAD, never agreeing, and the table says so", () => {
  const audit = boardTruthAudit(facts({ openRows: [row(3449, ["parked"])] }));
  assert.deepEqual(audit.findings.filter((f) => f.question === QUESTIONS.PARKED_BARE), [], "it cannot call a row condition-less without its edges");
  assert.deepEqual(audit.unread, [QUESTIONS.PARKED_BARE]);
  const table = boardTruthTable(audit, DAY);
  assert.match(table, /NOT READ, so not counted as agreeing: parked-without-condition/);
  assert.doesNotMatch(table, /0 disagree\*\*$/m, "never the bare count a clean board prints");
  const decided = boardTruthAudit(facts({ openRows: [row(3449, ["parked"], { body: "Waiting-for: closed #50" }), row(7, ["ready"])] }));
  assert.deepEqual(decided.unread, [], "a row whose body already carries a condition needs no edge read, so the question is read");
});

test("the standalone read asks for blockedBy, so the seventh question is read there too", () => {
  const asked: any[] = [];
  readBoardFacts("a/b", { run: (args) => { asked.push(args.join(" ")); return "[]"; }, agents: () => [] });
  assert.ok(asked.some((a) => /issue list --state open .*blockedBy/.test(a)));
});

// --- #4080 (row 2 of #4056): the audit reads EVERY declared tracker --------------------------------------------------------------

const HOME_TRACKER = { key: "", repo: "a/home" };
const ORG_TRACKER = { key: "agent-org", repo: "a/org", codeRepo: "a/org-code" };
/** A `gh` fake answering by the `--repo` it is aimed at: `rowsOf` maps a repository to the open rows it holds, and a repository in `refuse` throws on every read. */
const gh = (rowsOf: Record<string, any[]>, refuse: string[] = []) => (args: string[]) => {
  const repo = args[args.indexOf("--repo") + 1];
  if (refuse.includes(repo)) throw new Error(`HTTP 502 from ${repo}`);
  if (args[0] === "pr") return "[]";
  return JSON.stringify(args.includes("open") ? (rowsOf[repo] ?? []) : []);
};
/** A complete herdr listing (standing panes present), so the live sessions are READ and a test of another question is not muddied by that one being unread. */
const ORG_SEATS = [{ label: "ceo", status: "idle" }, { label: "orchestrator", status: "idle" }, { label: "worker-11", status: "working" }];
const twoTrackers = (rowsOf: Record<string, any[]>, refuse = ([] as string[])) =>
  readBoardFacts("a/home", { run: gh(rowsOf, refuse), agents: () => ORG_SEATS, now: NOW, trackers: [HOME_TRACKER, ORG_TRACKER],
    openRows: rowsOf["a/home"] ?? [], waitFacts: { items: {} } });

test("#4080 CONTROL: with ONE declared tracker the table is the one it always printed (a recorded snapshot), and no other tracker is asked", () => {
  const audit = boardTruthAudit(facts({ openRows: [row(10, ["ready"], { body: "the work" }), row(13, []), row(12, ["parked"], { body: "Waiting-for: closed #50" })],
    closedRows: [row(50, [], { state: "CLOSED", stateReason: "COMPLETED" })], mergedPrs: [{ number: 900, body: "Closes #10" }],
    waitFacts: { items: { "#50": { state: "closed", labels: [], resolvedAt: NOW, changedAt: NOW } } } }));
  assert.equal(boardTruthTable(audit, DAY), "### Board against reality, 2026-10-08\n\n**3 disagree**\n\n| row | question | field to fix | what disagrees | to |\n|---|---|---|---|---|\n"
    + "| #10 | closing-pr-merged | state (open) | merged PR #900 says `Closes #10` | product-manager |\n"
    + "| #12 | wait-already-true | `Waiting-for: closed #50` line | the condition is already true, so the row waits on nothing | product-manager |\n"
    + "| #13 | state-label | labels | carries none of ready, in-progress, backlog, parked, epic, blocked | product-manager |");
  const asked: any[] = [];
  readBoardFacts("a/home", { run: (args) => { asked.push(args[args.indexOf("--repo") + 1]); return "[]"; }, agents: () => [], trackers: [HOME_TRACKER] });
  assert.deepEqual([...new Set(asked)], ["a/home"]);
});

test("#4080: a row that exists ONLY in the second tracker is audited, and the table names it `agent-org#7`", () => {
  const audit = boardTruthAudit(twoTrackers({ "a/home": [row(10, ["ready"])], "a/org": [row(7, [])] }));
  assert.deepEqual(audit.findings.map((f) => [f.key ?? "", f.number, f.question]), [["agent-org", 7, QUESTIONS.STATE_LABEL]]);
  const table = boardTruthTable(audit, DAY);
  assert.match(table, /\*\*1 disagree\*\*/);
  assert.match(table, /^\| agent-org#7 \| state-label \|/m);
});

test("#4080: the same number in both trackers stays TWO rows, `#7` and `agent-org#7`", () => {
  const audit = boardTruthAudit(twoTrackers({ "a/home": [row(7, [])], "a/org": [row(7, [])] }));
  const table = boardTruthTable(audit, DAY);
  assert.match(table, /^\| #7 \| state-label \|/m);
  assert.match(table, /^\| agent-org#7 \| state-label \|/m);
  assert.equal(audit.findings.length, 2);
});

test("#4080: a read that fails on the second tracker NAMES that tracker as unread and the first tracker's rows are still reported", () => {
  const audit = boardTruthAudit(twoTrackers({ "a/home": [row(13, [])], "a/org": [row(7, [])] }, ["a/org"]));
  assert.deepEqual(audit.findings.map((f) => [f.key ?? "", f.number]), [["", 13]]);
  assert.deepEqual(audit.unread, ["agent-org: the open rows (HTTP 502 from a/org)"]);
  assert.match(boardTruthTable(audit, DAY), /NOT READ, so not counted as agreeing: agent-org: the open rows/);
});

test("#4080: the wait facts are the gate's, read for the first tracker only, so the second is NOT ASKED -- said in the table, and it does not stop the day's table being posted", () => {
  const audit = boardTruthAudit(twoTrackers({ "a/home": [], "a/org": [row(7, ["ready"])] }));
  assert.deepEqual(audit.unread, []);
  assert.deepEqual(audit.notAsked, ["agent-org: wait-already-true"]);
  assert.match(boardTruthTable(audit, DAY), /\*\*0 disagree\*\* -- NOT ASKED: agent-org: wait-already-true/);
  const posted = [];
  assert.equal(postDaysTable({ audit, day: DAY, repo: "a/home", run: (args) => { posted.push(args[0]); return ""; } }), "posted");
});

// ---- the eighth question: a `parked` row whose `Blocked-on:` names the chairman, whatever date it carries (a11ign/a11ign#4201) ----
const onChairman = (labels: string[], more: Record<string, any> = {}) =>
  found({ openRows: [edged(4159, labels, { body: CHAIRMAN_BODY, ...more })] }, QUESTIONS.PARKED_ON_CHAIRMAN);

test("#4201 (1) POSITIVE CONTROL: #4159's shape (parked, lane:any, a future Not-before, a Blocked-on naming the chairman) is found, and the table names the rule and product-manager", () => {
  const audit = boardTruthAudit(facts({ openRows: [edged(4159, ["parked", "lane:any"], { body: CHAIRMAN_BODY })] }));
  const mine = audit.findings.filter((f) => f.question === QUESTIONS.PARKED_ON_CHAIRMAN);
  assert.equal(mine.length, 1, "the population is not empty");
  assert.equal(mine[0].route, "product-manager");
  assert.match(mine[0].detail, /needs:chairman/);
  assert.match(boardTruthTable(audit, DAY), /\| #4159 \| parked-on-the-chairman \|.*needs:chairman.*\| product-manager \|/);
  assert.deepEqual(audit.findings.filter((f) => f.question === QUESTIONS.PARKED_BARE), [], "the date IS a condition, which is why the other question could not see it");
});

test("#4201 (2) NEGATIVE CONTROLS: needs:chairman, a Blocked-on naming another session, and `Waiting-for: labelled needs:chairman #3229` are not found", () => {
  assert.deepEqual(onChairman(["parked", "lane:any", "needs:chairman"]), []);
  assert.deepEqual(onChairman(["parked", "lane:any"], { body: "Blocked-on: orchestrator reading the lab\nNot-before: 2099-01-01T00:00:00Z" }), []);
  assert.deepEqual(onChairman(["parked", "lane:any"], { body: "Waiting-for: labelled needs:chairman #3229" }), []);
  assert.deepEqual(onChairman(["parked", "lane:any"]), [4159], "the same labels with the chairman's line ARE found");
});

test("#4201 (3) any wording of the chairman on the Blocked-on line is found, whatever else the row carries; prose elsewhere and other states are not", () => {
  assert.deepEqual(onChairman(["parked"], { body: "blocked-on:   The Chairman" }), [4159], "case-insensitive");
  assert.deepEqual(onChairman(["parked"], { body: "Blocked-on: the chairman\nWaiting-for: closed #50" }), [4159], "whatever other wait it carries");
  assert.deepEqual(onChairman(["parked"], { body: "Blocked-on: the chairman", blockedBy: { nodes: [{ number: 50, state: "OPEN" }] } }), [4159]);
  assert.deepEqual(onChairman(["parked"], { body: "we are waiting on the chairman\nBlocked-on: a merge" }), [], "only the Blocked-on line is read");
  assert.deepEqual(onChairman(["parked"], { body: "Blocked-on: chairmanship of nothing" }), [], "a word, not a substring");
  for (const state of ["backlog", "ready", "in-progress"]) assert.deepEqual(onChairman([state]), [], `${state}: the rule is about parked`);
});

test("#4201 (4) the question needs no fact, so it is never UNREAD", () => {
  const audit = boardTruthAudit(facts({ openRows: [row(4159, ["parked"], { body: CHAIRMAN_BODY })], mergedPrs: null, closedRows: null, liveSessions: null, waitFacts: null }));
  assert.equal(audit.findings.filter((f) => f.question === QUESTIONS.PARKED_ON_CHAIRMAN).length, 1);
  assert.ok(!audit.unread.includes(QUESTIONS.PARKED_ON_CHAIRMAN));
});
