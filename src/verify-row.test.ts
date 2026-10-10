// no-token: gh
//
// #4641 (class `row-not-finishable`; the chairman, 2026-10-09: READY MEANS FINISHABLE): a build row closes on merge and its live reading becomes its own verify row.
//
// NO NETWORK AND NO CORPUS: the rows, the effects and the clock are fixtures; the effects COUNT their calls, so "files nothing" is asserted as zero creates and a stray
// read would throw. POSITIVE CONTROLS, NAMED (an emptiness assertion points at where its population is): `LIVE` is the non-empty population every "files nothing" case
// is the negative of; case 1 is the build with no live reading beside it; cases 7 and 8 break the wiring (`fileVerifyRowsFor`, and `close-rows-for-merged-pr.ts`'s main
// reading) so a deleted call site fails here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileVerifyRow, liveReadingItems, notBeforeFor, planVerifyRow, verifyMarker, type BuildRow, type VerifyEffects } from "./verify-row.ts";
import { fileVerifyRowsFor, verifyOutcomeLine } from "./close-rows-for-merged-pr.ts";

const MERGED = "2026-10-09T21:00:00Z";
const CTX = { pr: "#900", mergedAt: MERGED };
const bodyWith = (doneWhen: string, extra = "") => `## Region\n\nsrc/foo.ts\n\n## Done-when\n\n${doneWhen}\n\n${extra}`;
const build = (over: Partial<BuildRow> = {}): BuildRow => ({ number: 4000, title: "Count the worktrees", labels: ["in-progress", "lane:any", "out-of-release", "priority"],
  milestone: "Out of release", parent: 3900, body: bodyWith("1. The tests pass.\n2. The worktree count is read on 2026-10-11 and posted."), ...over });
const LIVE = build();

function recorder(over: Partial<VerifyEffects> = {}) {
  const calls: string[] = [];
  const effects: VerifyEffects = {
    findExisting: () => null,
    create: (plan) => { calls.push(`create ${plan.title}`); return 5000; },
    blockBy: (child, on) => { calls.push(`blockBy ${child} ${on}`); },
    addSubIssue: (child, parent) => { calls.push(`sub ${child} ${parent}`); },
    board: (child) => { calls.push(`board ${child}`); return null; },
    ...over,
  };
  return { calls, effects };
}

test("1. a build row with NO live reading files nothing (the control for the cases below)", () => {
  const { calls, effects } = recorder();
  assert.deepEqual(fileVerifyRow(build({ body: bodyWith("1. The tests pass.\n2. The README names the flag.") }), CTX, effects), { kind: "none" });
  assert.deepEqual(calls, []);
  assert.ok(liveReadingItems(LIVE.body, new Date(MERGED)).length > 0, "the population the control is the negative of is not empty");
});

test("2. a live reading files ONE verify row: its Done-when, Not-before, blocked by the build, labels and milestone and epic copied", () => {
  const { calls, effects } = recorder();
  const outcome = fileVerifyRow(LIVE, CTX, effects);
  assert.equal(outcome.kind, "filed");
  assert.deepEqual(calls, ["create Verify Count the worktrees", "blockBy 5000 4000", "sub 5000 3900", "board 5000"]);
  if (outcome.kind !== "filed") return;
  const { plan } = outcome;
  assert.deepEqual(outcome.problems, []);
  assert.deepEqual(plan.labels, ["backlog", "lane:any", "out-of-release"], "claim labels and priority are not carried");
  assert.equal(plan.milestone, "Out of release");
  assert.equal(plan.notBefore, "2026-10-11T00:00:00Z");
  assert.match(plan.body, /## Done-when\n\n1\. The worktree count is read on 2026-10-11 and posted\.\n/);
  assert.doesNotMatch(plan.body, /The tests pass/, "only the live item travels");
  assert.match(plan.body, /\nNot-before: 2026-10-11T00:00:00Z\n/);
  assert.ok(plan.body.includes(verifyMarker(4000)));
});

test("3. a second merge of the same row files no second verify row", () => {
  const { calls, effects } = recorder({ findExisting: () => 5000 });
  assert.deepEqual(fileVerifyRow(LIVE, CTX, effects), { kind: "already", number: 5000 });
  assert.deepEqual(calls, []);
});

test("4. a search that cannot be read files nothing and says so (could not look is not none)", () => {
  const { calls, effects } = recorder({ findExisting: () => { throw new Error("HTTP 502"); } });
  const outcome = fileVerifyRow(LIVE, CTX, effects);
  assert.equal(outcome.kind, "failed");
  assert.match(outcome.kind === "failed" ? outcome.reason : "", /HTTP 502/);
  assert.deepEqual(calls, []);
});

test("5. a failed create is `failed`; a failed link is reported BESIDE the filed row, which keeps its number", () => {
  const broken = recorder({ create: () => { throw new Error("422"); } });
  assert.equal(fileVerifyRow(LIVE, CTX, broken.effects).kind, "failed");
  const linked = recorder({ blockBy: () => { throw new Error("no edge"); }, board: () => "REFUSING to board #5000: no Region" });
  const outcome = fileVerifyRow(LIVE, CTX, linked.effects);
  assert.equal(outcome.kind, "filed");
  if (outcome.kind !== "filed") return;
  assert.equal(outcome.number, 5000);
  assert.deepEqual(outcome.problems, ["blocked-by edge: no edge", "board: REFUSING to board #5000: no Region"]);
  assert.match(verifyOutcomeLine(4000, outcome) ?? "", /FILED .* BUT blocked-by edge: no edge; board: REFUSING/);
});

test("6. a build with no epic adds no sub-issue; a `Not-before:` on the BUILD does not hide its reading", () => {
  const orphan = recorder();
  fileVerifyRow(build({ parent: null }), CTX, orphan.effects);
  assert.ok(!orphan.calls.some((call) => call.startsWith("sub ")));
  const gated = recorder();
  const outcome = fileVerifyRow(build({ body: `${LIVE.body}Not-before: 2026-10-01T00:00:00Z\n` }), CTX, gated.effects);
  assert.equal(outcome.kind, "filed", "the build's own Not-before gates its START, not the reading");
});

test("7. only a `future-time` or `live-check` item is a reading: a seat's act and another row's outcome file nothing", () => {
  for (const item of ["1. ceo approves the wording.", "1. Once #4438 merges the flag is removed.", "1. The chairman must confirm the brief."]) {
    assert.deepEqual(liveReadingItems(bodyWith(item), new Date(MERGED)), [], item);
  }
});

test("8. Not-before is PLACED from the item's words, from the merge; an unplaceable phrase falls back to a day after the merge", () => {
  const at = (evidence: string) => notBeforeFor({ text: evidence, kind: "future-time", evidence, rows: [] }, MERGED);
  assert.deepEqual(at("on day 3"), { stamp: "2026-10-12T21:00:00Z", placed: true });
  assert.deepEqual(at("in three days"), { stamp: "2026-10-12T21:00:00Z", placed: true });
  assert.deepEqual(at("two weeks after"), { stamp: "2026-10-23T21:00:00Z", placed: true });
  assert.deepEqual(at("tomorrow"), { stamp: "2026-10-10T21:00:00Z", placed: true });
  assert.deepEqual(at("next monday"), { stamp: "2026-10-12T00:00:00Z", placed: true });
  assert.deepEqual(at("2026-10-11T19:00Z"), { stamp: "2026-10-11T19:00:00Z", placed: true });
  assert.deepEqual(at("sometime"), { stamp: "2026-10-10T21:00:00Z", placed: false });
});

test("9. fileVerifyRowsFor: files per closed row, names a row it could not file, says NOT CHECKED for one it could not read, and prints nothing for a row with no reading", () => {
  const said: string[] = [];
  const { calls, effects } = recorder();
  const rows = new Map<number, BuildRow | null>([[4000, LIVE], [4001, build({ number: 4001, body: bodyWith("1. Tests pass.") })], [4002, null]]);
  const lost = fileVerifyRowsFor([4000, 4001, 4002], { prNumber: "900", mergedAt: MERGED }, { read: (n) => rows.get(n) ?? null, effects, say: (line) => said.push(line) });
  assert.deepEqual(lost, [], "an unreadable row is said, not failed: most rows name no reading");
  assert.equal(calls.filter((call) => call.startsWith("create")).length, 1);
  assert.equal(said.length, 2);
  assert.match(said[0], /#4000 verify row #5000 FILED \(Not-before 2026-10-11T00:00:00Z\)/);
  assert.match(said[1], /#4002 NOT CHECKED/);
  const search = recorder({ findExisting: () => { throw new Error("HTTP 502"); } });
  assert.deepEqual(fileVerifyRowsFor([4000], { prNumber: "900", mergedAt: MERGED }, { read: () => LIVE, effects: search.effects, say: () => {} }), [4000], "a known live reading that could not be filed IS lost");
});

test("10. the main flow calls it: the close path reads fileVerifyRowsFor and a lost verify row cannot exit DONE", () => {
  const source = readFileSync(new URL("./close-rows-for-merged-pr.ts", import.meta.url), "utf8");
  assert.match(source, /fileVerifyRowsFor\(closedHere,/);
  assert.match(source, /code === EXIT\.DONE && lost\.length \? EXIT\.COULD_NOT_CLOSE : code/);
});

// --- a11ign/agent-org#719: a live-check item is a verify item; the close says what it filed, or that it filed none and why ---

const LIVE_CHECK = build({ number: 4630, title: "Use 1 is live", body: bodyWith("1. The tests pass.\n2. One record per use is quoted on #4627.") });

test("11. a LIVE-CHECK item (a quoted record on a row) files a verify row with its own Done-when, a day after the merge, and says the time was not placed", () => {
  const { calls, effects } = recorder();
  const outcome = fileVerifyRow(LIVE_CHECK, CTX, effects);
  assert.equal(outcome.kind, "filed");
  if (outcome.kind !== "filed") return;
  assert.equal(outcome.plan.item.kind, "live-check");
  assert.equal(outcome.plan.notBefore, "2026-10-10T21:00:00Z");
  assert.match(outcome.plan.body, /## Done-when\n\n1\. One record per use is quoted on #4627\.\n/);
  assert.match(outcome.plan.body, /names no time this could place \(`quoted on #4627`\)/);
  assert.ok(outcome.plan.body.includes(verifyMarker(4630)));
  assert.deepEqual(calls, ["create Verify Use 1 is live", "blockBy 5000 4630", "sub 5000 3900", "board 5000"]);
});

test("12. a build with a future-time AND a live-check item files ONE row carrying both, not readable before the later wait", () => {
  const { effects } = recorder();
  const both = build({ body: bodyWith("1. The tests pass.\n2. The count is read on 2026-10-14 and posted.\n3. One record per use is quoted on #4627.") });
  const outcome = fileVerifyRow(both, CTX, effects);
  assert.equal(outcome.kind, "filed");
  if (outcome.kind !== "filed") return;
  assert.equal(outcome.plan.items.length, 2);
  assert.match(outcome.plan.body, /1\. The count is read on 2026-10-14 and posted\.\n2\. One record per use is quoted on #4627\./, "in the order the row wrote them");
  assert.equal(outcome.plan.notBefore, "2026-10-14T00:00:00Z");
  assert.doesNotMatch(outcome.plan.body, /names no time this could place/, "the latest wait WAS placed");
});

test("13. a build whose only reading-shaped item is a seat's act says it filed none, and why; a plain build says nothing", () => {
  const { calls, effects } = recorder();
  const seat = build({ body: bodyWith("1. The tests pass.\n2. ceo approves the wording.") });
  const outcome = fileVerifyRow(seat, CTX, effects);
  assert.equal(outcome.kind, "none");
  assert.deepEqual(calls, []);
  assert.match(verifyOutcomeLine(4000, outcome) ?? "", /^VERIFY-ROW: #4000 NONE FILED -- Not taken: "ceo approves the wording\." \(a seat's act: `ceo approves`\) -- no engineer can finish it/);
  assert.equal(verifyOutcomeLine(4000, fileVerifyRow(build({ body: bodyWith("1. The tests pass.") }), CTX, effects)), null);
});

test("14. a filed row that left a seat's act behind names it beside the filing", () => {
  const { effects } = recorder();
  const mixed = build({ body: bodyWith("1. One record per use is quoted on #4627.\n2. ceo approves the wording.") });
  const line = verifyOutcomeLine(4000, fileVerifyRow(mixed, CTX, effects)) ?? "";
  assert.match(line, /^VERIFY-ROW: #4000 verify row #5000 FILED .* Not taken: "ceo approves the wording\."/);
});

test("15. this row's OWN Done-when, which only DESCRIBES the verify row and quotes a fixture, files nothing", () => {
  const own = build({ number: 719, body: bodyWith("1. The Acceptance passes and the pull request is merged; a test closes a row through the SWEEP whose Done-when 2 reads "
    + "\"one record per user is quoted on #4627\" and asserts a verify row is created with the marker.\n\nThe live reading is its own verify row, filed beside this one and blocked by it.") });
  const { calls, effects } = recorder();
  assert.deepEqual(fileVerifyRow(own, CTX, effects), { kind: "none" });
  assert.deepEqual(calls, []);
});
