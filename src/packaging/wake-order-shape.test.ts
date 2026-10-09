// no-token: gh -- every order here is built by a pure function from a fixture; nothing reaches gh or herdr
/**
 * #3444 (half 2 of 2): AN ORDER TO A LIVE INSTANCE CARRIES ONLY WHAT CHANGED, AND A SPAWNED ENGINEER'S FIRST ORDER NO LONGER REPEATS THE BRIEF IT IS
 * TOLD TO READ. Chairman, 2026-10-04, on `worker-3390`'s transcript: a follow-up was the header plus a cause text restating why the cause exists and a
 * dated incident, and the first order was 1,142 of 1,711 bytes of paragraphs `engineer.md` now says once (#3441).
 *
 * THE ORDERS ARE THE REAL ONES, built by the gate's own functions from fixtures, never a copy of their text. `wake-followup-header.test.ts` drives
 * the same header through `deliver` and `clearThenPrompt`; this file is about what the text SAYS.
 *
 * THE BOUNDS ARE STARTING VALUES. The row asks for <= 500 bytes a follow-up; the shortest honest text MEASURED is stated beside each (`MEASURED_*`)
 * so the next person moves the bound to what the text costs and not to what was once typed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { addressed, resumePrompt, ENGINEER_BRIEF } from "../wake.ts";
import { sessionOf } from "../token-audit.ts";
import { CALM_FINISH_PARAGRAPH } from "../worker-profile.ts";
import { idleNudgePrompt, WAIT_FIELDS } from "../idle-claimant.ts";
import { staleWaitOrders } from "../work-gate/org-health.ts";
import { primaryStaleOrders, blockedReferentOrders, answerOrders, blockerClearedOrders, unclaimedBlockerClearedOrders, claimedRowAmendedOrders,
  finishedEpicOrders, rowBranchOrders, incompleteRowOrders, diskHeadroomOrders, decide } from "../work-gate.ts";

const bytes = (text: string) => Buffer.byteLength(text);
const FOLLOW_UP_BOUND = 500;
/** THE NUDGE CANNOT REACH 500 AND STILL SPELL THE FIELDS (row #3444 allows this): the five row spellings plus the header are ~240 bytes before one word of
 * instruction, and the shortest text that keeps them measured 695 (canRelease) / 689. The bound is that measurement, not the row's starting value. */
const NUDGE_BOUND = 700;
const ISO_DATE = /\b20\d\d-\d\d-\d\d\b/;
const THREE_PARAGRAPHS = ["Work autonomously", "ENDING YOUR TURN WITH A QUESTION", "IF IT IS GENUINELY NOT YOURS"];
const TODAY = "2026-10-04";
type Order = { cause?: string; prompt: string };

const heldRow = (n: number, session: string, extra: Record<string, unknown> = {}) => ({
  number: n, labels: [{ name: "in-progress" }, { name: `session:${session}` }], ...extra });
const closed = (...numbers: number[]) => ({ blockedBy: { nodes: numbers.map((number) => ({ number, state: "CLOSED" })) } });
const followUp = (text: string, label = "worker-3390") => addressed({ session: label, prompt: text }, label, { followUp: true });

// --- (1) THE TWO FOLLOW-UPS THE ROW MEASURED, to the instance it measured them on ---------------------------------------------------------------

const BLOCKER_CLEARED = followUp(blockerClearedOrders([heldRow(3390, "worker-3390", closed(3384))], TODAY)[0].prompt);
const NUDGE = followUp(idleNudgePrompt({ row: 3390, branch: "agent/an-order-to-a-3444", idleMinutes: 50, releaseMinutes: 120, canRelease: true }));

/** The two sentences the row quotes as the ones that must be GONE; the dates are in the sentence because the sentence is the incident. */
const QUOTED_INCIDENTS = ["#1908's last blocker closed", "twelve sessions waited correctly"];
const STILL_STAND = "first order and its brief still stand";

test("#3444 (1) the blocker-cleared follow-up is within the bound, names what cleared, and carries no incident", () => {
  assert.ok(BLOCKER_CLEARED.includes("#3384"), "POSITIVE: it names what cleared, so the bounds below are not met by an empty order");
  assert.ok(bytes(BLOCKER_CLEARED) <= FOLLOW_UP_BOUND, `${bytes(BLOCKER_CLEARED)} bytes (was 926)`);
  assert.doesNotMatch(BLOCKER_CLEARED, ISO_DATE);
  for (const gone of [...QUOTED_INCIDENTS, STILL_STAND]) assert.ok(!BLOCKER_CLEARED.includes(gone), gone);
  assert.ok(BLOCKER_CLEARED.startsWith("[session:worker-3390 "), "attribution survives");
});

test("#3444 (1) the claim-stalled nudge is within the bound, still names every field a wait can be put in, and carries no incident", () => {
  const spellings = Object.values(WAIT_FIELDS).filter((f) => f.on === "row").map((f) => f.spelling);
  assert.ok(spellings.length >= 5, "the list is the substance, and it is not empty");
  for (const spelling of spellings) assert.ok(NUDGE.includes(spelling), `the nudge still spells ${spelling}`);
  assert.ok(bytes(NUDGE) <= NUDGE_BOUND, `${bytes(NUDGE)} bytes (was 1,144)`);
  assert.doesNotMatch(NUDGE, ISO_DATE);
  for (const gone of [...QUOTED_INCIDENTS, STILL_STAND]) assert.ok(!NUDGE.includes(gone), gone);
});

test("#3444 (1) CONTROL: the bound and the scan can fail -- the text this row replaced is over the one and inside the other", () => {
  const before = ("#3390 IS YOURS AND IS NO LONGER BLOCKED. That is why this exists: on 2026-09-22 #1908's last blocker closed at 21:26:02Z, the next tick said "
    + "nothing to `worker-capture`, and six rows sat behind it until a label meant for something else was applied by hand. ").repeat(4);
  assert.ok(bytes(followUp(before)) > NUDGE_BOUND, "over even the looser of the two bounds");
  assert.match(before, ISO_DATE);
});

// --- (2) A SPAWNED ENGINEER'S FIRST ORDER --------------------------------------------------------------------------------------------------------

const SPAWNED = { row: 3390, worktree: "/home/agent/repos/wt-3390", branch: "agent/an-order-to-a-3390", launchDir: "/home/agent/repos/wt-3390" };
const spawnedOrder = (label = "worker-3390", extra: object = {}) =>
  addressed({ session: "engineer", title: "An order to a live instance", prompt: "x" }, label, { spawned: SPAWNED, ...extra });
const MEASURED_SPAWNED_BYTES = 700;

test("#3444 (2) a spawned engineer's first order is its identity, row, worktree, branch and the brief -- and none of the three paragraphs", () => {
  const text = spawnedOrder();
  for (const must of ["You are `worker-3390`", "--session=worker-3390", "Row #3390: An order to a live instance", SPAWNED.worktree, SPAWNED.branch, ENGINEER_BRIEF]) {
    assert.ok(text.includes(must), `carries ${must}`);
  }
  for (const paragraph of THREE_PARAGRAPHS) assert.ok(!text.includes(paragraph), `does not repeat: ${paragraph}`);
  // #4070: ROW 3390 IS EVEN, SO THIS IS A CALM-ARM PREAMBLE, which ends with one more paragraph. The bound is on the preamble itself, so the paragraph is
  // taken off before it is read; a preamble that grew elsewhere still breaks it, and the paragraph's own shape is pinned in `wake-calm-arm.test.ts`.
  const calmTail = text.endsWith(CALM_FINISH_PARAGRAPH) ? bytes(`\n\n${CALM_FINISH_PARAGRAPH}`) : 0;
  assert.ok(bytes(text) - calmTail <= MEASURED_SPAWNED_BYTES, `${bytes(text) - calmTail} bytes without the calm paragraph (was 1,714)`);
});

test("#3444 (2) the brief is told to a spawned label the roster does not know, because the paragraphs are no longer there to cover for it", () => {
  const text = spawnedOrder("worker-77", { engineers: [], families: [] });
  assert.ok(text.includes(ENGINEER_BRIEF), "a window that does not hold the brief is told where it is");
  assert.equal(sessionOf(text), "worker-77");
});

test("#3444 (2) CONTROL: a standing seat's first order DOES carry the three paragraphs, so their absence above is the spawn's and not the scan's", () => {
  const text = addressed({ session: "worker-tooling", prompt: "x" }, "worker-tooling");
  for (const paragraph of THREE_PARAGRAPHS) assert.ok(text.includes(paragraph), paragraph);
});

// --- (3) A CLEARED STANDING SEAT AND A REVIEWER'S FIRST ORDER: A GOLDEN CAPTURED BEFORE THE CHANGE --------------------------------------------------

/**
 * CAPTURED at agent-org `2588da2`, BEFORE this change, by calling `addressed` with the order text `ORDER TEXT.`. "Unchanged" is a comparison and not a
 * belief. THE ONE EXCEPTION IS NAMED, not hidden: the row's done-when 2 takes the count of dated incidents in order text to 0, and this wrapper held one
 * (`Measured 2026-09-21: product-manager ended two consecutive turns this way ...`), so the comparison is against the golden WITH THAT SENTENCE CUT and
 * nothing else. The sentence moved into the comment above `autonomyParagraphs`.
 */
const GOLDEN = {
  standing: "You are `worker-tooling`, an org session in this repository. Use that name wherever a command asks which session you are (`--session=worker-tooling`).\n\nORDER TEXT.\n\nWork autonomously to the end: nobody is at this terminal to answer you. If something genuinely blocks you, say so on the row and message `product-manager` -- never stop and wait on a human. If you cannot claim the row (already taken, or the claim refuses), that is an answer: report it and stop, rather than working outside a claim.\n\nENDING YOUR TURN WITH A QUESTION IS THE SAME AS STOPPING. Nobody reads this terminal, so \"want me to file it?\" and not filing it are the same outcome -- except the first also looks like progress. IF THE ACTION IS IN YOUR LANE, TAKE IT AND REPORT WHAT YOU DID. Measured 2026-09-21: `product-manager` ended two consecutive turns this way, the second holding a COMPLETE, EVIDENCED ROW DRAFT (two incidents, commit hashes, timestamps) and asking permission to file it -- when filing is the first line of its own brief. The row did not get filed.\nIF IT IS GENUINELY NOT YOURS, that is not a question either: say what you would do, name who owns it, and route it -- `answer:<session>` on the row for a ruling, or the row itself for work. Then end your turn. The gate will bring you back when something changes; waiting is never your job, and polling a pull request for a verdict that has its own cause is a turn spent on a question the tick already answers.",
  ceo: "You are `ceo`, an org session in this repository. Use that name wherever a command asks which session you are (`--session=ceo`).\n\nORDER TEXT.\n\nWork autonomously to the end: nobody is at this terminal to answer you. If something genuinely blocks you, say so on the row and message `the chairman on the row itself -- no session can message them` -- never stop and wait on a human. If you cannot claim the row (already taken, or the claim refuses), that is an answer: report it and stop, rather than working outside a claim.\n\nENDING YOUR TURN WITH A QUESTION IS THE SAME AS STOPPING. Nobody reads this terminal, so \"want me to file it?\" and not filing it are the same outcome -- except the first also looks like progress. IF THE ACTION IS IN YOUR LANE, TAKE IT AND REPORT WHAT YOU DID. Measured 2026-09-21: `product-manager` ended two consecutive turns this way, the second holding a COMPLETE, EVIDENCED ROW DRAFT (two incidents, commit hashes, timestamps) and asking permission to file it -- when filing is the first line of its own brief. The row did not get filed.\nIF IT IS GENUINELY NOT YOURS, that is not a question either: say what you would do, name who owns it, and route it -- `answer:<session>` on the row for a ruling, or the row itself for work. Then end your turn. The gate will bring you back when something changes; waiting is never your job, and polling a pull request for a verdict that has its own cause is a turn spent on a question the tick already answers.",
  reviewer: "You are `reviewer-9`, an org session in this repository. Use that name wherever a command asks which session you are (`--session=reviewer-9`).\n\nORDER TEXT.\n\nWork autonomously to the end: nobody is at this terminal to answer you. If something genuinely blocks you, say so on the row and message `product-manager` -- never stop and wait on a human. You claim no row, and the author's claim on it is not a blocker: review the pull request.\n\nENDING YOUR TURN WITH A QUESTION IS THE SAME AS STOPPING. Nobody reads this terminal, so \"want me to file it?\" and not filing it are the same outcome -- except the first also looks like progress. IF THE ACTION IS IN YOUR LANE, TAKE IT AND REPORT WHAT YOU DID. Measured 2026-09-21: `product-manager` ended two consecutive turns this way, the second holding a COMPLETE, EVIDENCED ROW DRAFT (two incidents, commit hashes, timestamps) and asking permission to file it -- when filing is the first line of its own brief. The row did not get filed.\nIF IT IS GENUINELY NOT YOURS, that is not a question either: say what you would do, name who owns it, and route it -- `answer:<session>` on the row for a ruling, or the row itself for work. Then end your turn. The gate will bring you back when something changes; waiting is never your job, and polling a pull request for a verdict that has its own cause is a turn spent on a question the tick already answers.",
};
const DATED_INCIDENT = " Measured 2026-09-21: `product-manager` ended two consecutive turns this way, the second holding a COMPLETE, EVIDENCED ROW DRAFT "
  + "(two incidents, commit hashes, timestamps) and asking permission to file it -- when filing is the first line of its own brief. The row did not get filed.";

test("#3444 (3) a cleared standing seat's and a reviewer's first order is byte-for-byte the golden, less the one dated sentence", () => {
  const now = {
    standing: addressed({ session: "x", prompt: "ORDER TEXT." }, "worker-tooling"),
    ceo: addressed({ session: "x", prompt: "ORDER TEXT." }, "ceo"),
    reviewer: addressed({ session: "reviewer-9", cause: "draft-awaiting-verdict", prompt: "ORDER TEXT." }, "reviewer-9"),
  };
  for (const key of Object.keys(GOLDEN) as (keyof typeof GOLDEN)[]) {
    assert.ok(GOLDEN[key].includes(DATED_INCIDENT), `${key}: the sentence being cut is really in what was captured, so the cut is not vacuous`);
    assert.equal(now[key], GOLDEN[key].replace(DATED_INCIDENT, ""), key);
    assert.doesNotMatch(now[key], ISO_DATE, key);
  }
});

// --- (4) ATTRIBUTION -----------------------------------------------------------------------------------------------------------------------------

test("#3444 (4) a transcript that opens on a follow-up is attributed by `sessionOf`, and one that opens on nothing is not", () => {
  assert.equal(sessionOf(BLOCKER_CLEARED), "worker-3390");
  assert.equal(sessionOf(NUDGE), "worker-3390");
  assert.equal(sessionOf("Your blocker #3384 closed; continue #3390."), null, "CONTROL: the shortest honest order, with no name, is NOT attributed");
});

// --- (5) THE POPULATION: EVERY ORDER BUILDER, RENDERED FROM A FIXTURE, SCANNED FOR A DATE IN ITS TEXT --------------------------------------------

const backlogRow = (n: number, extra: Record<string, unknown> = {}) => ({ number: n, title: "a row", labels: [{ name: "backlog" }, { name: "lane:any" }], ...extra });
const comment = (id: string, body: string) => ({ id, body });
const CLAIMED_COMMENTS = [{ number: 2099, comments: [comment("IC_claim", "<!-- row-claim: claim record -->\n**Claim record** -- claimed by `worker-capture`."),
  comment("IC_constraint", "## CONSTRAINT\n\n`ceo`'s ruling: this row may NOT be implemented by granting a token.")] }];
const PRIMARY = { sha: "9c6ab2463000", originSha: "1f4e9c7a3b5d", behind: 2, ahead: 0, dirty: ["a.mjs"] };
const LOW_DISK = [{ mounts: ["/"], resource: "inodes" as const, free: 10, total: 100, fraction: 0.1 }];
const STALE_WAIT = [{ item: { number: 5, title: "t" }, wait: { key: "closed #1", text: "closed #1" }, setter: "worker-1", remove: ["`hold:x`"] }] as unknown as Parameters<typeof staleWaitOrders>[0]; // only the fields the order text reads
const BRANCH = { branch: "agent/worktree-prune-unit-2000", head: "1f4e9c7a3b5d8e2016243c5f7a9b0d1e2f3a4b5c", row: 2000 };
const TOO_MANY_ROWS = Array.from({ length: 52 }, (_, i) => ({ number: 900 + i, labels: [{ name: "backlog" }] }));

/** Every cause whose order text once carried a dated incident (`work-gate.ts` 13, `idle-claimant.ts`, `org-health.ts`, `wake.ts` 2), by builder. */
const RENDERED: Record<string, Order[]> = {
  "primary-stale": primaryStaleOrders(PRIMARY),
  "blocked-unexaminable": blockedReferentOrders([{ number: 1, title: "row 1", labels: [{ name: "backlog" }, { name: "blocked" }] }], [], TODAY),
  "answer-owed": answerOrders([{ number: 914, labels: [{ name: "backlog" }, { name: "answer:product-manager" }] }]),
  "blocker-cleared": blockerClearedOrders([heldRow(3390, "worker-3390", closed(3384))], TODAY),
  "unclaimed-blocker-cleared": unclaimedBlockerClearedOrders([backlogRow(1998, { ...closed(1993), labels: [{ name: "backlog" }, { name: "blocked" }] })], TODAY),
  "claimed-row-amended": claimedRowAmendedOrders([heldRow(2099, "worker-capture")], CLAIMED_COMMENTS),
  "epic-finished": finishedEpicOrders([{ number: 1317, title: "epic", labels: [{ name: "backlog" }, { name: "epic" }], subIssuesSummary: { total: 10, completed: 10 } }]),
  "row-branch-unshipped": rowBranchOrders([{ number: 2000, title: "row", labels: [{ name: "ready" }] }], [BRANCH]),
  "ready-row-incomplete": incompleteRowOrders([{ number: 7, title: "row", labels: [{ name: "ready" }], body: "## Region\n\nx.mjs\n" }]),
  "ready-queue-empty": decide({ prs: [], readyRows: [], promotableRows: TOO_MANY_ROWS }),
  "disk-headroom-low": diskHeadroomOrders(LOW_DISK),
  "org-health": staleWaitOrders(STALE_WAIT),
  "idle-nudge": [{ prompt: idleNudgePrompt({ row: 3390, branch: null, idleMinutes: 50, releaseMinutes: 120, canRelease: true }) },
    { prompt: idleNudgePrompt({ row: 3390, branch: null, idleMinutes: 50, releaseMinutes: 120, canRelease: false }) }],
  "resume": [{ prompt: resumePrompt() }],
  "wrapper": [{ prompt: addressed({ session: "x", prompt: "ORDER TEXT." }, "worker-tooling") }],
};
const datedIn = (orders: Order[]) => orders.filter((o) => ISO_DATE.test(o.prompt));

test("#3444 (5) THE POPULATION: every builder rendered from a fixture produced an order, and not one carries a date literal in its text", () => {
  const empty = Object.entries(RENDERED).filter(([, orders]) => orders.length === 0).map(([name]) => name);
  assert.deepEqual(empty, [], "a builder that rendered nothing was scanned for nothing: its fixture is wrong, not clean");
  assert.ok(Object.keys(RENDERED).length >= 15, "the scan covers each cause that carried a dated incident");
  const dated = Object.entries(RENDERED).map(([name, orders]) => [name, datedIn(orders).length]).filter(([, n]) => n !== 0);
  assert.deepEqual(dated, []);
});

test("#3444 (5) POSITIVE CONTROL: the scan finds a date in an order that has one, through the same entry", () => {
  const fixture: Order[] = [{ prompt: "Measured 2026-09-22 on #2000: its branch sat pushed for 20 minutes." }, { prompt: "No date here." }];
  assert.equal(datedIn(fixture).length, 1);
  assert.equal(datedIn(RENDERED["blocker-cleared"]).length, 0);
});

/** THE ROW'S OWN ENUMERATION, run over the source (done-when 2): a builder the fixtures above cannot reach is still counted here. */
const SITE_FILES = ["../work-gate.ts", "../idle-claimant.ts", "../claim-stall.ts", "../wake.ts", "../work-gate/org-health.ts", "../work-gate/pr-orders.ts",
  "../work-gate/lab-job-orders.ts", "../work-gate/pr-owners.ts"];
const SITE = /^\s*\+ [`"].*20\d\d-\d\d-\d\d|prompt: [`"].*20\d\d-\d\d-\d\d/;
const sitesIn = (text: string) => text.split("\n").filter((line) => SITE.test(line) && !line.includes("YYYY"));
const sourceOf = (file: string) => { try { return readFileSync(fileURLToPath(new URL(file, import.meta.url)), "utf8"); } catch { return null; } };

test("#3444 done-when 2: the enumeration over the order-text sites reads 0, and reads 17 on the text this row started from", () => {
  const read = SITE_FILES.map((file) => [file, sourceOf(file)] as const).filter(([, text]) => text !== null);
  assert.ok(read.length >= 5, "the files were read, so the zero below is a reading");
  for (const [file, text] of read) assert.deepEqual(sitesIn(text as string), [], file);
  const before = ['      + "THE EDITS ARE NOT YOURS TO DISCARD UNREAD: an interactive session left them there (the 2026-09-28 cause), and no hook "',
    '    prompt: `Row is stale since 2026-09-21 and it is bad.`', '      + "terminal is not one: nobody reads it (chairman, 2026-10-02: twelve sessions waited correctly"'];
  assert.equal(sitesIn(before.join("\n")).length, 3, "CONTROL: the same pattern finds the lines the row counted");
});
