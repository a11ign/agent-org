// no-token: none -- the code host is the fake one; nothing here reaches GitHub
//
// a11ign/agent-org#750: A `Closes: none` PULL REQUEST THAT NAMES ITS OWN CLAIMED ROW CLOSES THAT ROW AND FILES THE VERIFY ROW FOR WHAT IT LEFT. The instance is a11ign/agent-org#716 (row #560):
// its body said `Closes: none -- the row's Done-when 2 (tell a11ign#4623 the fix is in force, ...) can only be true after this merges`, GitHub resolved no closing reference, and the row
// stayed open and claimed until it was closed by hand.
//
// NO NETWORK: the code host is the fake one, whose world holds the rows and the merged pull request and records what it was asked to close, and the verify effects count their calls, so "files nothing" is zero creates.
// EVERY NEGATIVE HAS ITS CONTROL, in the same file and the same shape: case 1 is the positive the cases 2-6 are the negatives of (the same PR, the same row, the same claim,
// one thing changed), and case 7 is the idempotence control (the same PR merged twice files ONE row, where a store that forgot would file two).
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { applyClosurePlan, closesNoneOwnRow, closingComment, fileVerifyRowsFor, planClosesNone, type ClosureBasis } from "./close-rows-for-merged-pr.ts";
import { closeOnePr } from "./close-rows-sweep.ts";
import { forgetActivation, substituteCodeHost } from "./plugins/active.ts";
import { createFakeCodeHost } from "./plugins/fakes/code-host.ts";
import { fakeRow } from "./plugins/fakes/code-host-rows.ts";
import { planLeftoverVerifyRow, verifyMarker, type BuildRow, type VerifyEffects, type VerifyPlan } from "./verify-row.ts";

const REPO = "a11ign/agent-org";
const MERGED = "2026-10-10T19:30:00Z";
const BRANCH = "agent/the-hand-fix-ledger-agent-org-560";
/** The body of a11ign/agent-org#716, as it was merged (the line that matters is the `Closes: none` one, em dash and all). */
const BODY_716 = [
  "The hand-fix ledger reads a dependency bot's login (`app/dependabot`, `dependabot[bot]`, Renovate) as automation through the shared `DEPENDENCY_BOT_LOGIN` that #705 moved to a leaf, so a bump is `clean` and `hand-reroute` stops reading repeated on bumps (a11ign/agent-org#560, for a11ign#4623).",
  "",
  "Closes: none — the row's Done-when 2 (tell a11ign#4623 the fix is in force, with the merge commit) can only be true after this merges, so a11ign/agent-org#560 stays open until that comment is posted.",
  "",
  "Acceptance: see `.acceptance/agent~the-hand-fix-ledger-agent-org-560.md` (ADR 0044).",
  "",
].join("\n");
const ROW_560_BODY = "## What it is\n\n**The hand-fix ledger counts every Dependabot pull request as a HAND FIX.**\n\n## Region\n\n```\nagent-org:src/hand-fix-ledger.ts\n```\n\n"
  + "## Done-when\n\n1. The Acceptance passes and the pull request is merged.\n2. `a11ign#4623` is told on its row that the fix is in force, with the merge commit.\n\n## Tier\n\nSonnet.\n";
const ROW_560 = { number: 560, title: "The hand-fix ledger counts Dependabot pull requests as hand fixes", body: ROW_560_BODY, labels: ["in-progress", "lane:any", "out-of-release", "priority"] as string[] };

type RowState = { number: number; state: "OPEN" | "CLOSED"; title: string; body: string; labels: string[] };
const row = (over: Partial<RowState> = {}): RowState => ({ ...ROW_560, state: "OPEN", ...over });

afterEach(() => forgetActivation());

/**
 * The fake code host for one merged PR: the rows are the world's, the pull request is the world's merged one with the rows GitHub resolved as its `closes`, and a close flips the world's row, which is what a
 * second merge of the same PR then reads. `unreadable` rows are refused when the sweep reads them as a declared row.
 */
function fakeWorld(pr: { body: string; headRefName: string; resolved?: number[] }, rows: RowState[], { unreadable = [] as number[] } = {}) {
  const host = createFakeCodeHost();
  const world = host.rowsWorld;
  world.repo = REPO;
  for (const r of rows) world.rows.set(r.number, fakeRow(world, r.number, { title: r.title, body: r.body, labels: [...r.labels], state: r.state, milestone: { number: 1, title: "Out of release", description: null, dueOn: null } }));
  for (const r of rows) world.tail.closing.parents.set(r.number, 500);
  world.pulls.set(716, { number: 716, body: pr.body, headRefName: pr.headRefName, labels: [], isDraft: false, armed: false, merged: true, mergedAt: MERGED, createdAt: MERGED, comments: [],
    closes: (pr.resolved ?? []).filter((n) => rows.some((r) => r.number === n)).map((n) => ({ number: n, labels: [] })) });
  world.tail.closing.mergeShas.set(716, "6d2e9c1");
  // The only declared row any case reads is the one it makes unreadable, so the world refuses the read by its operation's name.
  if (unreadable.length > 0) world.failures.set("declaredBuildRowOf", new Error("HTTP 502"));
  substituteCodeHost(host);
  return world;
}

const closedIn = (world: ReturnType<typeof fakeWorld>): number[] => world.calls.filter((c) => c.startsWith("closeCompletedRow #")).map((c) => Number(c.slice("closeCompletedRow #".length)));

/** Verify effects over a store keyed by the build, so a second filing finds the first: `creates` is what reached the tracker. */
function store() {
  const filed = new Map<number, number>();
  const plans: VerifyPlan[] = [];
  const calls: string[] = [];
  const effects: VerifyEffects = {
    findExisting: (build) => filed.get(build.number) ?? null,
    create: (plan) => { const n = 9000 + plans.length + 1; plans.push(plan); filed.set(Number(/#(\d+)/.exec(plan.body.match(/Verifies: #(\d+)/)?.[0] ?? "")?.[1] ?? plan.blockedBy), n); calls.push(`create ${plan.title}`); return n; },
    blockBy: (child, on) => { calls.push(`blockBy ${child} ${on}`); },
    addSubIssue: (child, parent) => { calls.push(`sub ${child} ${parent}`); },
    board: (child) => { calls.push(`board ${child}`); return null; },
  };
  return { effects, plans, calls };
}

/** One sweep of PR 716 over `world`, with the strip and the settle as fixtures; what it printed comes back with the result, and the rows THIS sweep asked the world to close. */
function sweepIn(world: ReturnType<typeof fakeWorld>, effects: VerifyEffects) {
  const before = closedIn(world).length;
  const said: string[] = [];
  const log = console.log;
  console.log = (...parts: unknown[]) => { said.push(parts.join(" ")); };
  try {
    const result = closeOnePr(716, REPO, { strip: () => {}, settle: () => ({ settled: true, refused: [] }), verify: effects });
    return { result, said, closed: closedIn(world).slice(before), world };
  } finally {
    console.log = log;
  }
}

/** One sweep of PR 716 over a world seeded from `pr` and `rows`. */
const sweepPr = (pr: Parameters<typeof fakeWorld>[0], rows: RowState[], effects: VerifyEffects, opts: Parameters<typeof fakeWorld>[2] = {}) => sweepIn(fakeWorld(pr, rows, opts), effects);

const PR = { body: BODY_716, headRefName: BRANCH };

test("1. POSITIVE (the sweep): the #716 body closes row 560 and files ONE verify row carrying \"tell a11ign#4623 the fix is in force\", blocked by nothing", () => {
  const { effects, plans, calls } = store();
  const rows = [row()];
  const { result, closed, said } = sweepPr(PR, rows, effects);
  assert.deepEqual(closed, [560], "the row closed (the population is not empty)");
  assert.deepEqual(result, { failed: [], unsettled: [], skipped: [] });
  assert.equal(plans.length, 1, "exactly one verify row");
  assert.match(plans[0].body, /tell a11ign#4623 the fix is in force/, "carries what the reason said was left");
  assert.match(plans[0].body, /## Done-when\n\n1\. `a11ign#4623` is told on its row that the fix is in force, with the merge commit\.\n/, "the cited Done-when item, and not item 1 (that is what merged)");
  assert.doesNotMatch(plans[0].body, /Acceptance passes/);
  assert.ok(plans[0].body.includes(verifyMarker(560)), "the marker a second merge finds it by");
  assert.equal(plans[0].blockedBy, null, "blocked by nothing: its build closes with the act that files it");
  assert.equal(plans[0].notBefore, null, "no item names a time, so there is no Not-before");
  assert.doesNotMatch(plans[0].body, /Not-before/);
  assert.deepEqual(calls, ["create Verify The hand-fix ledger counts Dependabot pull requests as hand fixes", "sub 9001 500", "board 9001"], "no blocked-by edge, under its epic, boarded");
  assert.ok(said.some((l) => /^SWEEP: #716 GitHub resolved NO closing reference, but its `Closes: none` reason names #560/.test(l)), "the sweep says why it closed a row GitHub did not");
  assert.ok(said.some((l) => /^SWEEP: VERIFY-ROW: #560 verify row #9001 FILED \(no Not-before\)/.test(l)), "and names the verify row it filed");
});

test("2. CONTROL of 1, the same PR with the `Closes: none` line removed closes nothing (the row and the claim are the same)", () => {
  const { effects, plans, calls } = store();
  const { closed, said } = sweepPr({ ...PR, body: BODY_716.split("\n").filter((l) => !l.startsWith("Closes: none")).join("\n") }, [row()], effects);
  assert.deepEqual(closed, []);
  assert.deepEqual([plans.length, calls.length], [0, 0]);
  assert.ok(said.some((l) => l.includes("declared NO closing references")));
});

test("3. NEGATIVE: `Closes: none -- docs only` closes nothing and files nothing, on the same branch and the same claimed row", () => {
  const { effects, plans, calls } = store();
  const { result, closed, world } = sweepPr({ ...PR, body: "Rewords the README.\n\nCloses: none -- docs only\n" }, [row()], effects);
  assert.deepEqual(closed, []);
  assert.equal(world.rows.get(560)?.state, "OPEN");
  assert.deepEqual([plans.length, calls.length], [0, 0]);
  assert.deepEqual(result, { failed: [], unsettled: [], skipped: [] });
});

test("4. NEGATIVE: a reason that names ANOTHER row than the branch's is not the PR's own row, and a branch with no row number is not one either", () => {
  for (const [body, headRefName] of [
    ["Closes: none -- follows #561, which is the real work\n", BRANCH],
    ["Closes: none -- see a11ign/a11ign#560 for the host's half\n", BRANCH],
    ["Closes: none -- #560 stays open until the comment is posted\n", "agent/the-hand-fix-ledger"],
  ] as const) {
    const { effects, plans } = store();
    const { closed } = sweepPr({ body, headRefName }, [row(), row({ number: 561 })], effects);
    assert.deepEqual(closed, [], `${body.trim()} on ${headRefName}`);
    assert.equal(plans.length, 0);
  }
  // the control: the bare `#560` in the PR's own repository IS the same row, on the same branch
  const control = store();
  assert.deepEqual(sweepPr({ body: "Closes: none -- #560 stays open until the comment is posted\n", headRefName: BRANCH }, [row()], control.effects).closed, [560]);
});

test("5. NEGATIVE: a row nobody holds (open, no claim) is left alone and said so; a row that could not be read is named and fails, never closed", () => {
  const unheld = store();
  const a = sweepPr(PR, [row({ labels: ["lane:any"] })], unheld.effects);
  assert.deepEqual(a.closed, []);
  assert.equal(a.world.rows.get(560)?.state, "OPEN");
  assert.equal(unheld.plans.length, 0);
  assert.ok(a.said.some((l) => /open and not claimed -- nobody holds it, so it is left/.test(l)));
  const unread = store();
  const b = sweepPr(PR, [row()], unread.effects, { unreadable: [560] });
  assert.deepEqual(b.closed, []);
  assert.deepEqual(b.result.failed, [560], "named, so the sweep exits non-zero");
  assert.equal(unread.plans.length, 0);
});

test("6. NEGATIVE: GitHub's own answer outranks it -- a PR that resolved a row closes THAT one, and never the row its reason names", () => {
  const { effects } = store();
  const { closed, world } = sweepPr({ ...PR, resolved: [559] }, [row({ number: 559, title: "The other row" }), row()], effects);
  assert.deepEqual(closed, [559]);
  assert.equal(world.rows.get(560)?.state, "OPEN", "560 was not consulted");
});

test("7. NEGATIVE: the same PR merged twice files ONE verify row, not two (the second pass finds the row closed and the marker filed)", () => {
  const { effects, plans } = store();
  const world = fakeWorld(PR, [row()]);
  const first = sweepIn(world, effects);
  const second = sweepIn(world, effects);
  assert.deepEqual(first.closed, [560]);
  assert.deepEqual(second.closed, [], "the second pass closed nothing: the row was closed");
  assert.equal(plans.length, 1, "one create across both passes");
  assert.ok(second.said.some((l) => /VERIFY-ROW: #560 /.test(l)), "and the second pass SAID it found the row already filed, rather than staying silent");
});

test("8. POSITIVE (the dispatch path): `planClosesNone` plans the close, `applyClosurePlan` closes it with the closes-none sentence, `fileVerifyRowsFor` files the leftover", () => {
  const rows = [row()];
  const plan = planClosesNone({ prMergedAt: MERGED, prBody: BODY_716, headRefName: BRANCH, prRepo: REPO, rowsRepo: REPO },
    (n) => { const r = rows.find((x) => x.number === n); return r ? { number: r.number, state: r.state, labels: r.labels, reopenedAt: null } : null; });
  assert.equal(plan.kind, "plan");
  if (plan.kind !== "plan") return;
  assert.deepEqual(plan.plan.close.map((r) => r.number), [560]);
  assert.equal(plan.leftover.number, 560);
  const sentences: string[] = [];
  const basis: ClosureBasis = "closes-none";
  const log = console.log;
  console.log = () => {};
  try {
    const applied = applyClosurePlan(plan.plan, { prNumber: "716", sha: "6d2e9c1", repo: REPO, basis }, {
      closeOne: (n, ctx) => { sentences.push(closingComment(n, ctx)); return true; }, strip: () => {}, settle: () => ({ settled: true, refused: [] }) });
    assert.deepEqual(applied.failed, []);
    const { effects, plans } = store();
    const build: BuildRow = { number: 560, title: ROW_560.title, body: ROW_560_BODY, labels: ROW_560.labels, milestone: "Out of release", parent: 500 };
    const lost = fileVerifyRowsFor([560], { prNumber: "716", mergedAt: MERGED, leftover: plan.leftover }, { read: () => build, effects, say: () => {} });
    assert.deepEqual(lost, []);
    assert.equal(plans.length, 1);
    assert.match(plans[0].body, /tell a11ign#4623 the fix is in force/);
  } finally {
    console.log = log;
  }
  assert.match(sentences[0], /declared `Closes: none` with a reason that names this row/);
  assert.match(sentences[0], /agent-org#750/);
});

test("9. `Not-before` only when an item names a time: the control is the same row, the same reason, with and without a dated item", () => {
  const dated = { number: 475, title: "Count the worktrees", labels: ["lane:any"], milestone: null, parent: null,
    body: "## Done-when\n\n1. The tests pass.\n2. The worktree count is read on 2026-10-12 and posted on the row.\n" } satisfies BuildRow;
  const undated = { ...dated, body: "## Done-when\n\n1. The tests pass.\n2. The count is posted on the row.\n" };
  const reason = "Done-when 2 can only be true after this merges, so #475 stays open";
  const withTime = planLeftoverVerifyRow(dated, { pr: "#712", mergedAt: MERGED, reason });
  assert.equal(withTime.notBefore, "2026-10-12T00:00:00Z");
  assert.match(withTime.body, /Not-before: 2026-10-12T00:00:00Z/);
  const without = planLeftoverVerifyRow(undated, { pr: "#712", mergedAt: MERGED, reason });
  assert.equal(without.notBefore, null);
  assert.doesNotMatch(without.body, /Not-before/);
  assert.equal(without.blockedBy, null);
  assert.deepEqual(without.labels, ["backlog", "lane:any"]);
});

test("10. `closesNoneOwnRow`: the line, the reason and the branch together, never one of them", () => {
  const own = (body: string, headRefName: string | null = BRANCH) => closesNoneOwnRow({ body, headRefName, prRepo: REPO, rowsRepo: REPO });
  assert.deepEqual(own("Closes: none -- #560 is finished by a comment\n"), { number: 560, reason: "#560 is finished by a comment" });
  assert.deepEqual(own("closes: NONE: a11ign/agent-org#560 waits on a comment\n")?.number, 560, "any case, a colon or a dash between");
  assert.equal(own("Closes: none\n"), null, "no reason");
  assert.equal(own("This PR closes: none -- #560 waits\n"), null, "a prose mention is not a declaration (#549)");
  assert.equal(own("Closes: none -- #560 waits\n", null), null, "no branch");
  assert.equal(own("Closes: none -- a11ign#560 waits\n"), null, "an owner alone is no repository");
  assert.equal(closesNoneOwnRow({ body: "Closes: none -- #560 waits\n", headRefName: BRANCH, prRepo: "a11ign/a11ign", rowsRepo: REPO }), null, "a bare number is the PR's own repository's, not the tracker's");
});
