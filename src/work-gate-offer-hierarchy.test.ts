// no-token: gh -- `decide` is pure, and the one reader of the tracker's history (`readChairmanPriority`) is handed a stub in place of `gh`
/**
 * #4524: ONE OFFER HIERARCHY FOR THE GATE -- `priority:chairman`, then `priority`, then the milestone ranking, then age; the product-share floor binds only plain rows.
 *
 * EVERY "NOT OFFERED" ASSERTION HAS A SIBLING FIXTURE THAT DIFFERS IN THE ONE THING THAT OFFERS IT (the control), so a gate that offered everything, or nothing,
 * satisfies half of them and fails the other half. The declaration is the project's, trimmed to what the share reads (`product-share.test.ts`'s).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { decide } from "./work-gate/tick/tick-decisions-and-flags.ts";
import { hierarchyOrders, milestoneRank, readChairmanPriority } from "./work-gate/causes/rows-offer.ts";
import { offerHierarchyNow } from "./work-gate/tick.ts";
import { partitionUnclaimed } from "./work-gate/causes/rows-claims.ts";
import { CHAIRMAN_PRIORITY_LABEL } from "./work-gate/vocabulary.ts";
import { parseProjectDeclaration } from "./project-config.ts";
import { tmpDir } from "./lib/tmp-fixture.ts";
import { chairmanRowAnsweredByCeo } from "./work-gate/causes/rows-offer.ts";
import { stuckSubjectOf } from "./wake/merge-queue-wait.ts";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const DECLARATION = {
  code: [{ key: "", repo: "a11ign/a11ign" }, { key: "agent-org", repo: "a11ign/agent-org" }],
  dora: [{ repo: "a11ign/a11ign", releasablePaths: ["packages/judge/"] }, { repo: "a11ign/agent-org", releasablePaths: ["src/"] }],
};
const CHAIRMAN = "DanBeckDev";
const LABEL = CHAIRMAN_PRIORITY_LABEL;

type Row = { number: number; title: string; labels: { name: string }[]; body: string; milestone?: { number: number; title: string } };

/** A Ready row that carries the sections the claim demands (or `partitionUnclaimed` shelves it as a template defect). */
function ready(number: number, { region = [`packages/guards/src/row-${number}.ts`], labels = [], milestone }: { region?: string[]; labels?: string[]; milestone?: Row["milestone"] } = {}): Row {
  const body = `## Region\n\n\`\`\`\n${region.join("\n")}\n\`\`\`\n\n## Acceptance\n\nA command.\n\n## Open-check\n\nA check.\n`;
  return { number, title: `row ${number}`, labels: ["ready", ...labels].map((name) => ({ name })), body, ...(milestone === undefined ? {} : { milestone }) };
}
/** A row a session already holds, with its Region: what B4 compares a Ready row with. */
const claimed = (number: number, session: string, region: string[]) => ({ ...ready(number, { region }), labels: [{ name: "in-progress" }, { name: `session:${session}` }] });

/** `n` of the last ten engineer starts were product rows. */
const starts = (product: number) => [
  ...Array.from({ length: 10 - product }, (_, i) => ({ at: i, kind: "org" })),
  ...Array.from({ length: product }, (_, i) => ({ at: 10 - product + i, kind: "product" })),
];
const PRODUCT = ready(30, { region: ["packages/judge/src/score.ts"] });

function offered(readyRows: Row[], extra: Partial<Parameters<typeof decide>[0]> = {}) {
  const orders = decide({ prs: [], readyRows, engineerStarts: starts(2), projectDeclaration: DECLARATION, shareLog: () => {}, ...extra });
  const rowOrders = orders.filter((o) => o.cause === "ready-row-unclaimed");
  return { orders, rowOrders, subjects: rowOrders.map((o) => o.subject) };
}
const chairmanOf = (...rows: number[]) => ({ chairmanRows: new Set(rows) });

test("a priority:chairman org row is offered while the product share is 2/10, and the same row without the chairman is not", () => {
  const org = ready(20, { labels: [LABEL] });
  assert.deepEqual(offered([org, PRODUCT], { offerHierarchy: chairmanOf(20) }).subjects, ["row-20", "row-30"], "the chairman's org row, ahead of the product row the floor is waiting for");
  assert.deepEqual(offered([org, PRODUCT], { offerHierarchy: chairmanOf() }).subjects, ["row-30"], "control: the label alone, not added by the chairman, leaves the floor in force");
});

test("with no idle engineer, a fresh one is asked for -- the order says so for the chairman's row and no other", () => {
  const { rowOrders } = offered([ready(20, { labels: [LABEL] }), ready(21, { labels: ["priority"] })], { offerHierarchy: chairmanOf(20) });
  const byRow = Object.fromEntries(rowOrders.map((o) => [o.subject, o]));
  assert.equal((byRow["row-20"] as { startFresh?: boolean }).startFresh, true);
  assert.equal((byRow["row-20"] as { prompt: string }).prompt.startsWith("CHAIRMAN PRIORITY"), true);
  assert.equal("startFresh" in byRow["row-21"], false, "control: a `priority` row starts nobody above the limit");
});

test("the label from a non-chairman actor is ignored, logged, and reported to ceo; the chairman's own is honoured", () => {
  const rows = [ready(20, { labels: [LABEL] }), ready(21, { labels: [LABEL] })];
  const history = (login: string) => (args: string[]) => (args[1].includes("/21/") ? `${CHAIRMAN}\n` : `${login}\n`);
  const lines: string[] = [];
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string) => { lines.push(String(chunk)); return true; }) as typeof process.stderr.write;
  let read: ReturnType<typeof readChairmanPriority>;
  try { read = readChairmanPriority(rows, history("a11ign-bot")); } finally { process.stderr.write = write; }
  assert.deepEqual([...read.chairmanRows], [21], "the chairman's label counts; the bot's does not");
  assert.deepEqual(read.ignored, [{ number: 20, actor: "a11ign-bot" }]);
  assert.match(lines.join(""), /IGNORED the `priority:chairman` on #20: a11ign-bot added it/);
  const told = hierarchyOrders({ chairmanRows: read.chairmanRows, ignored: read.ignored }, { blocked: [], yielding: [], openRows: [], prs: [] });
  assert.deepEqual(told.map((o) => [o.session, o.causeKey]), [["ceo", "ceo/chairman-label-ignored/20-a11ign-bot"]]);
  assert.deepEqual(offered(rows, { offerHierarchy: read }).subjects, ["row-21", "row-20"], "row 21 first, and 20 offered as a plain row");
});

test("a label whose history cannot be read, or shows no labeller, is not the chairman's (it fails closed)", () => {
  const rows = [ready(20, { labels: [LABEL] })];
  const quiet = (fn: () => ReturnType<typeof readChairmanPriority>) => { const w = process.stderr.write; process.stderr.write = (() => true) as typeof w; try { return fn(); } finally { process.stderr.write = w; } };
  assert.deepEqual(quiet(() => readChairmanPriority(rows, () => { throw new Error("rate limited"); })).unread, [20]);
  assert.equal(quiet(() => readChairmanPriority(rows, () => "")).chairmanRows.size, 0, "no labeled event: not the chairman's");
  assert.equal(quiet(() => readChairmanPriority(rows, () => `${CHAIRMAN}\n`)).chairmanRows.size, 1, "control: the same call with the chairman's login");
  assert.equal(quiet(() => readChairmanPriority(rows, () => `${CHAIRMAN}\nsomebody-else\n`)).chairmanRows.size, 0, "the NEWEST labeller decides");
});

test("a B4-shelved chairman row is reported to ceo, not offered; against a plain holder it is offered and the holder is told to rebase", () => {
  const region = ["packages/guards/src/shared.ts"];
  const chairmanRow = ready(20, { region, labels: [LABEL] });
  const rivalChairman = claimed(40, "worker-40", region);
  const plainHolder = claimed(41, "worker-41", region);
  const hierarchy = chairmanOf(20, 40);

  const refused = offered([chairmanRow], { offerHierarchy: hierarchy, openRows: [rivalChairman] });
  assert.deepEqual(refused.subjects, [], "another chairman row holds the file, so B4 binds");
  const report = refused.orders.find((o) => o.causeKey.startsWith("ceo/chairman-row-refused/"));
  assert.match(report?.prompt ?? "", /CHAIRMAN ROW REFUSED: #20/);
  assert.match(report?.prompt ?? "", /#40/, "the reason names the holder");

  const walked = offered([chairmanRow], { offerHierarchy: chairmanOf(20), openRows: [plainHolder] });
  assert.deepEqual(walked.subjects, ["row-20"], "control: a holder that is not a chairman row does not shelve it");
  assert.equal(walked.orders.some((o) => o.causeKey.startsWith("ceo/chairman-row-refused/")), false);
  const rebase = walked.orders.find((o) => o.causeKey === "worker-41/chairman-row-lands-first/20/row-41");
  assert.match(rebase?.prompt ?? "", /rebase onto `main`/);

  const plain = offered([ready(20, { region })], { openRows: [plainHolder] });
  assert.deepEqual(plain.subjects, [], "control: the same row, not the chairman's, is shelved by the same holder");
});

test("#1456: a refused chairman row is told once per reason; a ceo answer since that telling silences it; a changed reason, or a closed blocker, tells again", () => {
  const dir = tmpDir("chairman-refusals-");
  const T0 = Date.parse("2026-10-15T10:00:00Z");
  const MIN = 60_000;
  const refusal = (reason: string, answeredAt: string | null, now: number, openRows: { number: number; }[]) => hierarchyOrders(
    { chairmanRows: new Set([20]), refusals: { stateDir: dir, now, answeredAt: () => answeredAt } },
    { blocked: [{ number: 20, reason }], yielding: [], openRows, prs: [] });
  const told = (orders: { causeKey: string; }[]) => orders.filter((o) => o.causeKey.startsWith("ceo/chairman-row-refused/")).length;
  const reason = "blocked by #5311 -- declared on the row, and it clears itself";
  const open = [{ number: 5311 }];

  assert.equal(told(refusal(reason, null, T0, open)), 1, "the first refusal is told");
  assert.equal(told(refusal(reason, null, T0 + 23 * MIN, open)), 1, "control: no ceo comment, the same reason is told again as it always was");
  assert.equal(told(refusal(reason, String(new Date(T0 + 25 * MIN).toISOString()), T0 + 30 * MIN, open)), 0, "a ceo comment newer than the first telling silences the same reason");
  assert.equal(told(refusal(reason, String(new Date(T0 + 25 * MIN).toISOString()), T0 + 46 * MIN, open)), 0, "and keeps silencing it on the next wake");
  assert.equal(told(refusal("blocked by #5312 -- declared on the row, and it clears itself", String(new Date(T0 + 25 * MIN).toISOString()), T0 + 50 * MIN, [...open, { number: 5312 }])), 1, "a changed reason is a new telling");
  assert.equal(told(refusal("blocked by #5312 -- declared on the row, and it clears itself", String(new Date(T0 + 55 * MIN).toISOString()), T0 + 56 * MIN, open)), 1, "a blocker the reason names that has closed, on a row still refused, is told again");

  const keyed = hierarchyOrders({ chairmanRows: new Set([1456]), refusals: { stateDir: dir, now: T0, answeredAt: () => null } }, { blocked: [{ number: 1456, repoKey: "agent-org", repo: "a11ign/agent-org", reason }], yielding: [], openRows: [], prs: [] });
  const [order] = keyed.filter((o) => o.causeKey.startsWith("ceo/chairman-row-refused/"));
  assert.equal(order?.subject, "row-agent-org#1456", "the subject names the repository");
  assert.match(order?.prompt ?? "", /agent-org#1456/);
  assert.equal(stuckSubjectOf(order?.causeKey ?? "")?.repoKey, "agent-org", "the stuck path reads the repository from the key");
  assert.equal(stuckSubjectOf(order?.causeKey ?? "")?.number, 1456);
});

test("#1456: the ceo answer is read from the repository's comments since the first telling: the newest decided-by ceo comment on THIS issue; a refused read is no answer", () => {
  const since = "2026-10-15T10:00:00.000Z";
  const comment = (number: number, at: string, body: string) => ({ created_at: at, body, issue_url: `https://api.github.com/repos/a11ign/a11ign/issues/${number}` });
  const pages = [[comment(20, "2026-10-15T10:30:00Z", "answered <!-- decided-by: ceo -->"), comment(20, "2026-10-15T10:40:00Z", "<!-- decided-by: worker-3 -->"), comment(21, "2026-10-15T10:50:00Z", "<!-- decided-by: ceo -->")]];
  const asked: string[][] = [];
  const run = (args: string[]) => { asked.push(args); return JSON.stringify(pages); };
  assert.equal(chairmanRowAnsweredByCeo({ number: 20, repo: "a11ign/a11ign" }, since, run), "2026-10-15T10:30:00.000Z", "the newest ceo comment on #20, not #21's and not the worker's");
  assert.match(asked[0]?.join(" ") ?? "", /repos\/a11ign\/a11ign\/issues\/comments\?since=2026-10-15T10:00:00\.000Z/, "one repository-wide list since the first telling");
  assert.equal(chairmanRowAnsweredByCeo({ number: 20, repo: "a11ign/a11ign" }, since, () => "not json"), null, "an unreadable answer is no answer, so the refusal is told again");
});

test("#1456: with CHAIRMAN_REFUSAL_FLAG off there is no ledger and the refusal is the order main gives; the flag reads from the state directory", () => {
  const dir = tmpDir("chairman-refusal-flag-");
  const reason = "blocked by #5311 -- declared on the row, and it clears itself";
  const off = hierarchyOrders({ chairmanRows: new Set([20]) }, { blocked: [{ number: 20, reason }], yielding: [], openRows: [], prs: [] });
  assert.equal(off.length, 1);
  assert.equal(off[0]?.subject, "row-20", "the subject is main's");
  assert.ok(off[0]?.causeKey.startsWith("ceo/chairman-row-refused/20-"), "the key is main's, with no repository segment");
  assert.equal(offerHierarchyNow([], [], { run: () => "", stateDir: dir, now: 0, refusedOnce: false }).refusals, undefined, "off: nothing reads the answer");
  assert.notEqual(offerHierarchyNow([], [], { run: () => "", stateDir: dir, now: 0, refusedOnce: true }).refusals, undefined, "on: the ledger is wired");
});

test("#4405: a tick that did not read the primary's lanes keeps the refusal ledger; only a read tick that does not refuse the row forgets it", () => {
  const T0 = Date.parse("2026-10-15T22:00:00Z");
  const MIN = 60_000;
  const reason = "blocked by #5311 -- declared on the row, and it clears itself";
  const open = [{ number: 5311 }];
  const ceoAt = (minutes: number) => new Date(T0 + minutes * MIN).toISOString();
  // `laneUnread` is the tick saying it did not read the primary's lanes (`decide`'s `primaryUnread`, from a refused Ready-rows read or a paced open-rows read): its `blocked` is not the shelf.
  const tickIn = (stateDir: string, { refused = true, laneUnread = false, why = reason, answeredAt = null, openRows = open, now }: { refused?: boolean; laneUnread?: boolean; why?: string; answeredAt?: string | null; openRows?: { number: number; }[]; now: number; }) => hierarchyOrders(
    { chairmanRows: new Set([20]), refusals: { stateDir, now, answeredAt: () => answeredAt } },
    { blocked: refused ? [{ number: 20, reason: why }] : [], yielding: [], openRows, prs: [], laneUnread });
  const told = (orders: { causeKey: string; }[]) => orders.filter((o) => o.causeKey.startsWith("ceo/chairman-row-refused/")).length;

  // (a) tick 1 refuses row 20; tick 2 did not read the lane, so row 20 is not in `blocked`; tick 3 refuses it again for the same reason, and ceo has answered since tick 1: NO order.
  const dirA = tmpDir("chairman-refusal-unread-");
  assert.equal(told(tickIn(dirA, { now: T0 })), 1, "tick 1: the first refusal is told");
  assert.equal(told(tickIn(dirA, { refused: false, laneUnread: true, now: T0 + 10 * MIN })), 0, "tick 2: the lane was not read, so nothing is told");
  assert.equal(told(tickIn(dirA, { now: T0 + 20 * MIN, answeredAt: ceoAt(5) })), 0, "tick 3: refused again, ceo answered since tick 1 -- no order, because tick 2's silence was not a clearing");

  // (a') an unread tick that still lists row 20 refused, with no open rows read, cannot say the blocker closed: the ceo-answered row is not told on it.
  const dirE = tmpDir("chairman-refusal-blocker-");
  assert.equal(told(tickIn(dirE, { now: T0 })), 1, "tick 1: the first refusal is told");
  assert.equal(told(tickIn(dirE, { laneUnread: true, openRows: [], now: T0 + 10 * MIN, answeredAt: ceoAt(5) })), 0, "tick 2: refused on an unread tick with no open rows read -- the blocker reads closed only because nothing was read, so nothing is told");

  // (b) the same, but tick 2 READ the lane and did not refuse row 20: the entry is forgotten, so tick 3 is a first telling.
  const dirB = tmpDir("chairman-refusal-read-");
  assert.equal(told(tickIn(dirB, { now: T0 })), 1, "tick 1: the first refusal is told");
  assert.equal(told(tickIn(dirB, { refused: false, now: T0 + 10 * MIN })), 0, "tick 2: the lane was read and row 20 is not refused");
  assert.equal(told(tickIn(dirB, { now: T0 + 20 * MIN, answeredAt: ceoAt(5) })), 1, "tick 3: a first telling, as it always was");

  // (c) an unread tick in between does not hide a changed reason: tick 3 is told.
  const dirC = tmpDir("chairman-refusal-digest-");
  assert.equal(told(tickIn(dirC, { now: T0 })), 1, "tick 1: the first refusal is told");
  assert.equal(told(tickIn(dirC, { refused: false, laneUnread: true, now: T0 + 10 * MIN })), 0, "tick 2: the lane was not read");
  assert.equal(told(tickIn(dirC, { why: "blocked by #5312 -- declared on the row, and it clears itself", now: T0 + 20 * MIN, answeredAt: ceoAt(5) })), 1, "tick 3: a changed reason is told");

  // (d) a ledger that cannot be written (its directory is a file) re-tells on every tick, as it always did.
  const dirD = tmpDir("chairman-refusal-unwritable-");
  const notADir = join(dirD, "not-a-dir");
  writeFileSync(notADir, "");
  assert.equal(told(tickIn(notADir, { now: T0 })), 1, "tick 1: told");
  assert.equal(told(tickIn(notADir, { now: T0 + 10 * MIN, answeredAt: ceoAt(5) })), 1, "tick 2: told again, because nothing was remembered");
});

test("a chairman row is offered over an open pull request that closes no chairman row, and not over one that does", () => {
  const region = ["packages/guards/src/shared.ts"];
  const chairmanRow = ready(20, { region, labels: [LABEL] });
  const pr = (closes: number[]) => [{ number: 900, files: region, changedFiles: 1, closes }];
  assert.equal(partitionUnclaimed([chairmanRow], pr([55]), { chairmanRows: new Set([20]) }).offerable.length, 1);
  assert.deepEqual(partitionUnclaimed([chairmanRow], pr([55]), { chairmanRows: new Set([20]) }).yielding, [{ row: 20, holders: [{ kind: "pr", number: 900 }] }]);
  assert.equal(partitionUnclaimed([chairmanRow], pr([55]), { chairmanRows: new Set() }).offerable.length, 0, "control: not the chairman's, the PR shelves it");
  assert.equal(partitionUnclaimed([chairmanRow], pr([20, 55]), { chairmanRows: new Set([20]) }).offerable.length, 1, "its OWN pull request was never a reason");
  assert.equal(partitionUnclaimed([chairmanRow], pr([56]), { chairmanRows: new Set([20, 56]) }).offerable.length, 0, "a chairman row's pull request binds it");
});

test("priority beats the floor, and the floor still holds among plain rows", () => {
  const priority = ready(20, { labels: ["priority"] });
  const plain = ready(21);
  assert.deepEqual(offered([priority, PRODUCT]).subjects, ["row-20", "row-30"], "the priority org row, with the share at 2/10");
  assert.deepEqual(offered([plain, PRODUCT]).subjects, ["row-30"], "control: a plain org row waits for the floor");
  assert.deepEqual(offered([plain, PRODUCT], { engineerStarts: starts(6) }).subjects, ["row-21", "row-30"], "and is offered once the share is met");
  assert.deepEqual(offered([priority, plain, PRODUCT]).subjects, ["row-20", "row-30"], "priority exempts ITSELF: the plain org row beside it is still held to the floor");
});

test("tiers order chairman, then priority, then plain; a primary-milestone row beats a later one of the SAME tier; no milestone goes last; then oldest", () => {
  const m = (number: number, title: string) => ({ number, title });
  const ranking = ["10", "11"];
  const rows = [
    ready(1), // plain, no milestone
    ready(2, { milestone: m(11, "Haiku") }),
    ready(3, { milestone: m(10, "v3") }),
    ready(4, { labels: ["priority"], milestone: m(11, "Haiku") }),
    ready(5, { labels: ["priority"], milestone: m(10, "v3") }),
    ready(6, { labels: [LABEL] }), // chairman, no milestone
    ready(7, { milestone: m(99, "unranked") }),
  ];
  const { subjects } = offered(rows, { engineerStarts: starts(6), offerHierarchy: { ...chairmanOf(6), milestoneRanking: ranking } });
  assert.deepEqual(subjects, ["row-6", "row-5", "row-4", "row-3", "row-2", "row-1", "row-7"]);
  assert.deepEqual(offered(rows, { engineerStarts: starts(6) }).subjects.slice(0, 3), ["row-4", "row-5", "row-1"], "control: with no hierarchy, `priority` first and then the lowest number, as before");
  assert.equal(milestoneRank({ milestone: m(11, "Haiku") }, ["Haiku", "10"]), 0, "a ranking entry may name the title");
  assert.equal(milestoneRank({}, ranking), ranking.length);
});

test("the declaration's offerMilestones is optional and refused when malformed", () => {
  const base = { schema: 1, tracker: [{ key: "", repo: "a/b", board: { owner: "a", number: 1 } }], code: [{ key: "", repo: "a/b" }] };
  assert.deepEqual(parseProjectDeclaration(JSON.stringify(base)).offerMilestones, []);
  assert.deepEqual(parseProjectDeclaration(JSON.stringify({ ...base, offerMilestones: ["10", "11"] })).offerMilestones, ["10", "11"]);
  for (const bad of ["10", [10], [""], ["10", "10"]]) {
    assert.throws(() => parseProjectDeclaration(JSON.stringify({ ...base, offerMilestones: bad })), /offerMilestones/);
  }
});
