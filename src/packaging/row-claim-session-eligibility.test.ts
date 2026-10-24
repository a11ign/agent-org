/**
 * B2 (#476) + B4 (#462) + THE ROW'S OWN `blockedBy` EDGE (#1886), COMPOSED, THROUGH
 * `sessionEligibilityReason` AND `claimRow` END TO END.
 *
 * `decideClaim` answers "is this ROW somebody else's"; `sessionEligibilityReason` answers "should THIS
 * SESSION start a NEW row right now" (a session's own PR health, and whether its region overlaps another
 * open PR) and, since #1886, "is THIS row startable at all right now" (does it carry an open `blockedBy`
 * edge) -- independent of who (if anyone) already holds the row being claimed. All three fail OPEN on a
 * lookup failure, the opposite of `decideClaim`'s own "unclaimed must be earned" rule: this protects a
 * session's ability to claim ANYTHING when the network is down, the identical reasoning
 * `merge-guard.ts`'s `racesAnArmedMerge` states for the same choice made the same way.
 */
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { sessionEligibilityReason, claimRow, CLAIM_LABEL } from "../row-claim.ts";
import { trackedTopLevelDirs } from "../region-paths.ts";
import { REPO } from "../project-identity.ts";
import { forgetActivation, substituteCodeHost } from "../plugins/active.ts";
import { createFakeCodeHost } from "../plugins/fakes/code-host.ts";
import { fakeRow } from "../plugins/fakes/code-host-rows.ts";
import { watchedRows } from "../plugins/fakes/watched-rows.test.support.ts";

/** #1603: the packages/ rows read the project's own tracked `packages/` tree (docs/project-tree-dependency.md, row 1603). Skipped only where that tree is absent. */
const SKIP_NO_PACKAGES = trackedTopLevelDirs().includes("packages") ? false
  : "the project checkout has no tracked packages/ tree: this reader is agent-org's own product tree and belongs to row 5 of this series";

// --- the fake code host for the tests that go through `claimRow` (A11-160, step 7) ---------------------------------------------------------------------------------------------

/** `run` for a claim whose `gh` is the code host's: it is for `git` and the board snapshot, which `moveStatus` stands in for. */
const noGh = (cmd: string): string => { throw new Error(`a claim reached \`${cmd}\` through its run: GitHub is the code host's`); };

/** The Region the held rows of these tests declare, so a held row with no pull request is IN BUILD. */
const HELD_BODY = "## Region\n\n```\nscripts/held.mjs\n```\n";

type World = ReturnType<typeof createFakeCodeHost>["rowsWorld"];

/**
 * The fake code host holding `rows` (a claimed row is `{ number, labels }`; `body` absent is a row whose answer carries no `body` key, so the template check is skipped as it was before #989) and the open pull
 * requests `pulls`, each closing the rows it names. The host is watched: `calls` are the operations asked, in order.
 */
function claimWorld({ rows = [], pulls = [], setup }: { rows?: { number: number; labels?: string[]; body?: string; blockedBy?: number[] }[]; pulls?: { number: number; closes?: number[]; body?: string; files?: string[]; headRefName?: string }[]; setup?: (world: World) => void }) {
  const host = createFakeCodeHost();
  const { rowsWorld: world } = host;
  world.repo = REPO;
  for (const row of rows) {
    world.rows.set(row.number, fakeRow(world, row.number, { title: "A row", labels: row.labels ?? [], body: row.body ?? "", blockedBy: row.blockedBy ?? [] }));
    if (row.body === undefined) world.rules.bodyless.add(row.number);
  }
  for (const pull of pulls) {
    world.pulls.set(pull.number, { number: pull.number, body: pull.body ?? "", headRefName: pull.headRefName ?? `agent/x-${pull.number}`, labels: [], isDraft: false, armed: false, merged: false, mergedAt: null,
      createdAt: "2026-10-04T00:00:00Z", comments: [], files: pull.files ?? [], closes: (pull.closes ?? []).map((number) => ({ number, labels: [] })), headRefOid: "abc" });
  }
  setup?.(world);
  const watched = watchedRows(host);
  substituteCodeHost(watched.host);
  const ops = () => watched.calls.map((call) => call.op);
  const writes = () => ops().filter((op) => ["setRowLabels", "editRowLabels", "postRowComment"].includes(op));
  return { world, ops, writes, host: watched.host };
}

afterEach(() => forgetActivation());

/**
 * A scene for `sessionEligibilityReason` (A11-160, step 9; it was one stub `gh` routing five kinds of call by subcommand shape): the fake code host holding the row being claimed (#455, whose body is its Region),
 * the rows `held` by `session` (each declaring a file, so one with no pull request is IN BUILD), the `blockers` of the claimed row with their state, and the open `pulls` with what each closes, changes and is
 * reviewed as. A pull request that is `merged` is no longer open. `calls` are the operations asked, in order.
 */
type Scene = {
  session?: string; claimedBody?: string; held?: number[]; blockers?: { number: number; state: "OPEN" | "CLOSED" }[];
  pulls?: { number: number; closes?: number[]; files?: string[]; merged?: boolean; headRefOid?: string; reviewDecision?: string | null; reviews?: object[] }[];
};

function scene({ session = "worker-judge", claimedBody = "", held = [], blockers = [], pulls = [] }: Scene = {}) {
  const claimed = claimWorld({ rows: [{ number: 455, body: claimedBody, blockedBy: blockers.map((blocker) => blocker.number) },
    ...held.map((number) => ({ number, labels: [CLAIM_LABEL, `session:${session}`], body: HELD_BODY }))],
  pulls: pulls.map(({ number, closes, files }) => ({ number, closes, files })),
  setup: (world) => {
    for (const blocker of blockers) world.rows.set(blocker.number, fakeRow(world, blocker.number, { state: blocker.state, closedAt: blocker.state === "CLOSED" ? "2026-10-04T00:00:00Z" : null }));
    for (const { number, merged, headRefOid, reviewDecision, reviews } of pulls) {
      const pull = world.pulls.get(number)!;
      Object.assign(pull, { merged: merged === true, mergedAt: merged === true ? "2026-10-04T01:00:00Z" : null, ...(headRefOid === undefined ? {} : { headRefOid }), ...(reviewDecision === undefined ? {} : { reviewDecision }) });
      if (reviews !== undefined) world.rules.reviews.set(number, { reviews });
    }
  } });
  /** What `session` is told when it asks to start row #455 now, or `null` when it may. */
  const reason = (deps: { adoptedBranch?: string } = {}) => sessionEligibilityReason(455, session, { ghRun: noGh as never, ...deps });
  return { ...claimed, reason, asked: (...names: string[]) => claimed.ops().filter((op) => names.includes(op)) };
}

/** The lookups B4 makes, and the review-health read of B2: none of them is asked once B2's other clause (a row in build) or the row's own blockedBy edge has decided. */
const PULL_LOOKUPS = ["openPullsWithFilesOf", "openPullReviewsOf"];

test("no other held row, no region overlap: proceeds silently -- the common case", () => {
  assert.equal(scene().reason(), null);
});

test("#989: an OPEN own PR no longer refuses -- red or green, it is not a row in build", () => {
  // #476's own acceptance shape, INVERTED by #989. The PR here is open with a failing required check, and
  // it still does not block: an open PR means the commit is PROPOSED, and an engineer does not wait on
  // review. ceo granted this by hand three times on 2026-09-11 before ruling it the rule.
  assert.equal(scene({ held: [472], pulls: [{ number: 900, closes: [472], headRefOid: "abc" }] }).reason(), null);
});

test("#989: a held row with NO PR, declaring files, refuses -- that is what in build means", () => {
  const reason = scene({ held: [472] }).reason();
  assert.ok(reason, "no PR closes #472 and its Region names a file: somebody owes a commit for it");
  assert.match(reason as string, /#472 is IN BUILD/);
  assert.match(reason as string, /Finish it, or `decline` it/);
});

test("#476's own acceptance shape: the same session with that PR MERGED is allowed", () => {
  assert.equal(scene({ held: [472], pulls: [{ number: 900, closes: [472], merged: true, headRefOid: "abc" }] }).reason(), null);
});

test("#462's own acceptance shape: a CONSTRUCTED region overlap refuses, end to end", { skip: SKIP_NO_PACKAGES }, () => {
  const reason = scene({ claimedBody: "Region: `packages/agent-org/src/merge-guard.ts`.", pulls: [{ number: 406, files: ["packages/agent-org/src/merge-guard.ts"] }] }).reason();
  assert.ok(reason);
  assert.match(reason as string, /#406/);
});

test("#462's own POSITIVE CONTROL: remove the overlap, end to end, and it goes quiet", () => {
  assert.equal(scene({ claimedBody: "Region: `packages/agent-org/src/row-claim.ts`.", pulls: [{ number: 406, files: ["packages/agent-org/src/merge-guard.ts"] }] }).reason(), null);
});

test("B2 is checked BEFORE B4 -- a row IN BUILD is reported without even asking about files", () => {
  const refused = scene({ held: [472] });
  assert.ok(refused.reason());
  assert.deepEqual(refused.asked(...PULL_LOOKUPS), [], "B4's lookup is a separate round trip and should not run once B2 has already decided to refuse");
});

// --- #1886: the ROW BEING CLAIMED may itself carry an open `blockedBy` edge -- see
// `row-claim-blocked-by-edge-rule.test.ts` for the pure-function coverage of `blocked-by-edge-rule.ts`
// itself; these prove the WIRING into `sessionEligibilityReason`, end to end. ---

// #1852 is the real reproduction (see #1886's own Region), but this file's `routedRun` fixture treats
// issue 455/705 as the row being claimed and reads any OTHER issue number in an `issue view` call as a
// HELD row `sessionEligibilityReason` is asking about on B2's behalf -- so these tests use 455, matching
// every other test in this file, rather than the literal #1852.
test("#1886's own acceptance shape: an open blockedBy edge on the row being claimed refuses it, naming "
  + "the blocking issue(s)", () => {
  const reason = scene({ blockers: [{ number: 1878, state: "OPEN" }, { number: 1883, state: "OPEN" }] }).reason();
  assert.ok(reason, "#1852's own reproduction: an open blockedBy edge must refuse, not read as startable");
  for (const pattern of [/#1878/, /#1883/]) assert.match(reason as string, pattern);
});

test("#1886's own POSITIVE CONTROL: a CLOSED blockedBy edge is a wait that has cleared -- goes quiet", () => {
  assert.equal(scene({ blockers: [{ number: 1878, state: "CLOSED" }] }).reason(), null);
});

test("the blockedBy-edge check runs BEFORE B4 -- refused without even asking about files", () => {
  const refused = scene({ blockers: [{ number: 1878, state: "OPEN" }] });
  assert.ok(refused.reason());
  assert.deepEqual(refused.asked(...PULL_LOOKUPS), [], "B4's lookup is a separate round trip and should not run once the row's own blockedBy edge has already decided to refuse");
});

test("MUTATION TARGET: --blocked-by=#N must not silently release a blockedBy-edge refusal -- it is scoped "
  + "to B2 only, a different claim about a different thing", () => {
  const fake = claimWorld({ rows: [{ number: 1852, blockedBy: [1878] }] });
  const result = claimRow(1852, "nobody-holds-this-row", { run: noGh as never, moveStatus: () => ({ moved: true }), blockedBy: "#731" });
  assert.equal(result.claimed, false);
  assert.match((result as { reason: string }).reason, /#1878/,
    "the blockedBy-edge refusal must still be the reason -- --blocked-by has no subject here");
  assert.doesNotMatch((result as { reason: string }).reason, /--blocked-by=#731 did not apply/,
    "that message is B2's own override failure text; this refusal was never B2's to release");
  assert.deepEqual(fake.writes(), []);
});

// --- #710: the overlap check reads the DECLARED Region section, never every path the row's prose
// mentions -- #705-vs-#698 is the real shape this measured against ---

test("#710 REGRESSION FIXTURE: #705's real body cites a fixture file in prose that #698's real PR " +
  "actually changed -- and #705's own Region section never names it. Must NOT refuse", () => {
  const claimedBody = "## The fixture: what it would actually have taken\n\n"
    + "Rescuing `packages/lab/scripts/audit-rule-coverage.ts` from `lead/inventory-bootstrap` "
    + "(2026-09-06):\n\n"
    + "## Region\n\n`scripts/` for the helper, `packages/lab/src/packaging/` for its test, and "
    + "`docs/` wherever the stranded-branch procedure ends up being written down.\n";
  assert.equal(scene({ claimedBody, pulls: [{ number: 698, files: ["packages/lab/scripts/audit-rule-coverage.ts"] }] }).reason(), null,
    "a file cited as a worked example, outside the Region section, must never be read as an overlap");
});

test("a failed lookup anywhere fails OPEN, never blocking a claim on a network error", () => {
  // A HELD ROW IN BUILD, and an open blockedBy edge: the world that would refuse twice over, were any lookup answered.
  const refused = scene({ held: [472], blockers: [{ number: 1878, state: "OPEN" }] });
  for (const operation of Object.keys(refused.host.rows!)) refused.world.failures.set(operation, new Error("gh: rate limited"));
  assert.equal(refused.reason(), null, "the opposite direction from decideClaim's own lookups -- this protects the session's ability "
    + "to claim ANYTHING, not a verdict about evidence");
  assert.notEqual(refused.ops().length, 0, "and the lookups WERE asked and refused (the control that this is not a world nothing was asked of)");
  const answered = scene({ held: [472], blockers: [{ number: 1878, state: "OPEN" }] });
  assert.ok(answered.reason(), "CONTROL: the same world, unrefused, refuses");
});

/**
 * END TO END THROUGH `claimRow` ITSELF -- proves the wiring in `writeRowLabels`, not just the pure
 * composition function above.
 */
test("claimRow refuses a genuinely new claim when the session holds a row IN BUILD", () => {
  // #989 reads the HELD row's body (does its Region name files); the CLAIMED row (#455) is unclaimed and has no `body` key, so #707's template check is skipped, as it was before #989.
  const fake = claimWorld({ rows: [{ number: 455 }, { number: 472, labels: [CLAIM_LABEL, "session:worker-judge"], body: HELD_BODY }] });
  const result = claimRow(455, "worker-judge", { run: noGh as never, moveStatus: () => ({ moved: true }) });
  assert.equal(result.claimed, false);
  assert.match((result as { reason: string }).reason, /#472 is IN BUILD/,
    "the refusal names the ROW that is in build, not a PR -- #989's whole point");
  assert.deepEqual(fake.writes(), [], "must never write a claim it has already decided to refuse");
});

test("claimRow proceeds normally when eligibility is silent -- unchanged from before B2/B4", () => {
  const fake = claimWorld({ rows: [{ number: 461 }] });
  const result = claimRow(461, "worker-judge", { run: noGh as never, moveStatus: () => ({ moved: true }) });
  assert.equal(result.claimed, true);
  assert.ok(fake.writes().includes("setRowLabels"));
  assert.ok(fake.world.rows.get(461)!.labels.includes("session:worker-judge"), "and the row carries the claim");
});

test("RESUMING a row this session already holds skips eligibility entirely -- not a new front", () => {
  const fake = claimWorld({ rows: [{ number: 461, labels: [CLAIM_LABEL, "session:worker-judge"] }] });
  const result = claimRow(461, "worker-judge", { run: noGh as never, moveStatus: () => ({ moved: true }) });
  assert.equal(result.claimed, true);
  const listed = fake.ops().filter((op) => ["readClaimedRows", "readRowsByLabel", "openPullsWithFilesOf", "closingPullsOf", "openPullReviewsOf"].includes(op));
  assert.deepEqual(listed, [], "resuming a row already yours must not spend a round trip re-checking eligibility for a front that was never new");
});

test("RESUMING a row this session already holds still refuses on the row's own open blockedBy edge", () => {
  // PR #1891 NOT CONVINCED (reviewer, 576a678b): the fix that shipped put the row-owned `blockedBy` read
  // inside `sessionEligibilityReason`, called only from the `!alreadyMine` branch -- so this exact
  // resumed-claim path (the one the test just above proves skips B2/B4) never read the edge at all, and
  // `claimRow` returned `claimed: true` against a still-open blocker. This is the same reproduction
  // reviewer gave against #1883, replayed here as a positive assertion rather than a manual repro.
  const fake = claimWorld({ rows: [{ number: 461, labels: [CLAIM_LABEL, "session:worker-judge"], blockedBy: [999] }] });
  const result = claimRow(461, "worker-judge", { run: noGh as never, moveStatus: () => ({ moved: true }) });
  assert.equal(result.claimed, false);
  assert.match((result as { reason: string }).reason, /#999/,
    "the row's own open blockedBy edge must refuse a resumed claim exactly as it refuses a new one -- "
    + "it is a property of the row, not of whether this session already holds it");
  assert.deepEqual(fake.writes(), [], "must never write a claim it has already decided to refuse");
  const listed = fake.ops().filter((op) => ["readClaimedRows", "readRowsByLabel", "openPullsWithFilesOf", "closingPullsOf"].includes(op));
  assert.deepEqual(listed, [], "the row-owned blockedBy check costs no B2 round trip -- B2/B4's own alreadyMine skip is unaffected by this fix");
});

/**
 * #741: `--blocked-by=#N` END TO END THROUGH `claimRow` -- releases B2 only with a measurement comment
 * already on the claimant's own open PR, and only while `#N` is confirmed open. See
 * `row-claim-blocked-by-rule.test.ts` for the pure-function coverage of `blocked-by-rule.ts` itself; this
 * proves the WIRING in `writeRowLabels` (the comment is posted on the RIGHT row, the label write still
 * happens, and a losing race never posts one).
 */
// #989: `QUALIFYING_MEASUREMENT_COMMENT` went with #741's four tests. The fixture was the comment that
// released B2 on a red own PR; B2 no longer refuses for that, so nothing in this file can qualify.
// `row-claim-blocked-by-rule.test.ts` still owns the comment's own grammar, which is unchanged.

/**
 * #741's OVERRIDE HAS NO SUBJECT AFTER #989, and that is a capability question rather than a rename.
 *
 * #741 let a session claim while its own PR was red for a reason outside its diff, by writing a
 * measurement comment ON THAT PR. #989 removes the refusal it was releasing: an open PR no longer blocks
 * anything, so the need is met by default and the flag has nothing left to excuse. **The refusal that
 * remains is a row IN BUILD -- which by definition has no PR for a measurement comment to live on.**
 *
 * Both halves are asserted below rather than left implied. Whether `--blocked-by` retires, or moves its
 * measurement comment onto the ROW, is product-manager's call on its own row; what this file must not do
 * is keep four tests passing about a path nobody can reach.
 */
test("#989: #741's own case needs no flag now -- an open, RED own PR does not refuse at all", () => {
  // The held row #472 has an open pull request that closes it: an open PR means the commit is PROPOSED, so it is not a row in build.
  const fake = claimWorld({ rows: [{ number: 700 }, { number: 472, labels: [CLAIM_LABEL, "session:worker-audit"], body: HELD_BODY }], pulls: [{ number: 900, closes: [472] }] });
  const result = claimRow(700, "worker-audit", { run: noGh as never, moveStatus: () => ({ moved: true }) });
  assert.equal(result.claimed, true, "the session's own PR is OPEN and that is no longer a refusal");
  assert.ok(fake.writes().includes("setRowLabels"));
});

test("#989: --blocked-by cannot excuse a row IN BUILD, and says why rather than being ignored", () => {
  // A row in build has no PR, so there is nowhere for #741's measurement comment to live. The refusal
  // names that instead of silently declining to apply -- a flag that is quietly dropped and a flag that
  // was never given produce the same output, which is the shape this repo has the longest record of.
  claimWorld({ rows: [{ number: 700 }, { number: 472, labels: [CLAIM_LABEL, "session:worker-audit"], body: HELD_BODY }] });
  const result = claimRow(700, "worker-audit", { run: noGh as never, moveStatus: () => ({ moved: true }), blockedBy: "#731" });
  assert.equal(result.claimed, false);
  const reason = (result as { reason: string }).reason;
  assert.match(reason, /#472 is IN BUILD/);
  assert.match(reason, /--blocked-by=#731 did not apply/);
  assert.match(reason, /no PR of this session's own to attach a measurement comment to/);
  assert.match(reason, /`row-claim\.ts decline <n> --session=<name>`/,
    "product-manager's ruling on #1012: naming the missing PR alone is a refusal nobody can follow, because "
    + "an in-build row has no PR and none is coming. It must name the door that exists.");
});

test("MUTATION TARGET: --blocked-by given while the refusal is B4 (file overlap), not B2, must not apply "
  + "-- the override is specific to the claimant's own PR being unhealthy", { skip: SKIP_NO_PACKAGES }, () => {
  const body = "## Region\n\n`packages/agent-org/src/merge-guard.ts`.\n\n## Acceptance\n\nSomething checkable.\n\n"
    + "## Open-check\n\nSomething runnable.\n";
  claimWorld({ rows: [{ number: 700, body }], pulls: [{ number: 406, files: ["packages/agent-org/src/merge-guard.ts"] }] });
  const result = claimRow(700, "worker-judge", { run: noGh as never, moveStatus: () => ({ moved: true }), blockedBy: "#731" });
  assert.equal(result.claimed, false);
  assert.match((result as { reason: string }).reason, /#406/);
  assert.doesNotMatch((result as { reason: string }).reason, /blocked-by/i);
});

// --- #2126: AN UNANSWERED REFUSAL IS WORK NEEDING ACTION, THROUGH `sessionEligibilityReason` -----------

/**
 * B2 caps WORK NEEDING THIS SESSION'S ACTION, and a pull request whose reviewer has asked for changes is
 * exactly that -- it is not waiting on anybody but its author. #989 is untouched and the four cases far
 * above are its positive control: as many pull requests AWAITING REVIEW as it takes, one row in build.
 *
 * `row-claim-own-pr-health-rule.test.ts` owns the pure coverage of the predicate, the dispute reader and
 * the escalation. These prove the WIRING: that `sessionEligibilityReason` actually reaches them, with the
 * one `pr list` call the row asked for and not one per held row.
 */
const REFUSED_HEAD = "6541b1ee3ca8332069db55e3144d93bbef4e6b0f";
const VERDICT_HEAD = "dfe72936b50f0e6cb8a3d5f1a9c0e2b7d4f61a83";

/** The session of every case below, holding row #472 whose commits ARE proposed by an open pull request (#900, which closes it) -- #989 clears it. `decision` and `reviews` are #900's, as the review-health read finds them. */
const tooling = (decision: string | null, reviews: object[] = [], { held = [472] }: { held?: number[] } = {}) =>
  scene({ session: "worker-tooling", held, pulls: [{ number: 900, closes: held, headRefOid: REFUSED_HEAD, reviewDecision: decision, reviews }] });

const verdict = (state: string, oid: string, by: string) => ({ state, commit: { oid },
  body: `**Review of #900 at \`${oid.slice(0, 8)}\`, by ${by}: `
    + `${state === "APPROVED" ? "convinced" : "not convinced"} (provisional).**` });

test("#2126 (1): the session's own open PR reading CHANGES_REQUESTED refuses a fresh claim", () => {
  const reason = tooling("CHANGES_REQUESTED").reason();
  assert.ok(reason, "#2126's own live shape: a refusal nobody has answered, end to end");
  assert.match(reason as string, /#900/, "the refusal names the pull request, where the work is");
  assert.match(reason as string, /#472/, "and the row it belongs to");
});

test("#2126 (2): the same session with that PR reading APPROVED is ALLOWED -- #989 preserved", () => {
  // THE POSITIVE CONTROL FOR THE CASE ABOVE, and the assertion that this row did not quietly restore #476.
  assert.equal(tooling("APPROVED").reason(), null);
});

test("#2126 (2): REVIEW_REQUIRED is a pull request waiting on its REVIEWER, and is ALLOWED", () => {
  assert.equal(tooling("REVIEW_REQUIRED").reason(), null,
    "an engineer does not wait on review -- ceo's ruling of 2026-09-11, unchanged by this clause");
});

test("#2126 (3): four bot merge commits and no author commit do NOT clear the refusal", () => {
  // #2107's real shape: the verdict sits at `dfe72936` and the head is `6541b1ee`, four automated
  // `Merge branch 'main'` commits later, with zero author commits. A guard keyed on head identity would
  // find no verdict at the current head at all; `reviewDecision` still reads CHANGES_REQUESTED because
  // `dismiss_stale_reviews` is false.
  const reason = tooling("CHANGES_REQUESTED", [verdict("CHANGES_REQUESTED", VERDICT_HEAD, "reviewer")]).reason();
  assert.ok(reason, "the refusal outlived four head moves that no author made");
  assert.match(reason as string, /#900/);
  assert.match(reason as string, /BOT MERGE DOES NOT LIFT THIS/,
    "and it says so, so a reader whose head has moved does not read the refusal as stale");
});

/** The writes an escalation to `ceo` makes, as the code host was asked for them: the label created and put on the row, and the comment. */
const ESCALATION_WRITES = ["ensureLabelIn", "addLabelToRowIn", "commentOnIssue"];

test("#2126 (4): contradictory verdicts at the SAME head are not refused -- they escalate to ceo", () => {
  const disputed = tooling("CHANGES_REQUESTED", [verdict("APPROVED", REFUSED_HEAD, "reviewer-2"), verdict("CHANGES_REQUESTED", REFUSED_HEAD, "reviewer")]);
  assert.equal(disputed.reason(), null,
    "#2105's real shape: an APPROVED and a CHANGES_REQUESTED on the identical commit, 57 seconds apart. "
    + "A guard with no exit for a dispute converts a review disagreement into a stalled engineer");

  assert.ok(disputed.asked(...ESCALATION_WRITES).length > 0, `the escape must ESCALATE, not merely stay quiet -- the code host was asked ${disputed.ops().join(", ")}`);
  const row = disputed.world.rows.get(472)!;
  assert.ok(row.labels.includes("answer:ceo"), `the dispute is put on the held row #472 as \`answer:ceo\`: ${row.labels.join(", ")}`);
  assert.match(row.comments.map((comment) => comment.body).join("\n"), /OPPOSITE verdicts on #900/, "with the dispute written where ceo reads it");
});

test("#2126 (4): the escalation is the DISPUTE's doing -- remove one side and the same claim is refused", () => {
  // THE POSITIVE CONTROL FOR THE ESCAPE. Identical fixture with the APPROVED dropped: no dispute, so the
  // refusal stands and nothing is escalated. Without this, the clearance above proves only that some
  // fixture goes quiet.
  const undisputed = tooling("CHANGES_REQUESTED", [verdict("CHANGES_REQUESTED", REFUSED_HEAD, "reviewer")]);
  assert.ok(undisputed.reason());
  assert.deepEqual(undisputed.asked(...ESCALATION_WRITES), [],
    "and a refused claim escalates nothing -- the control for this emptiness is the test directly above");
  const row = undisputed.world.rows.get(472)!;
  assert.deepEqual([row.labels.includes("answer:ceo"), row.comments], [false, []]);
});

test("#2126: the review-health read is ONE `pr list`, whatever the session holds", () => {
  // #989 took two calls per held row OUT of this path; a clause that put one back per row would undo the
  // measurement that justified it. Three held rows, three open pull requests, one review-health call.
  const held = tooling("APPROVED", [], { held: [472, 473, 474] });
  assert.equal(held.reason(), null);
  assert.equal(held.asked("openPullReviewsOf").length, 1, "one call, not one per row");
});

test("#2126: a row IN BUILD is still reported without ANY `pr list` round trip", () => {
  // The existing B2-before-B4 expectation, restated for the new read: this clause's lookup is a `pr list`
  // too, and a row in build has no open pull request for it to ask about. If this goes red the clause has
  // started spending a round trip on rows it can never say anything about.
  const inBuild = scene({ session: "worker-tooling", held: [472] });
  assert.match(String(inBuild.reason()), /#472 is IN BUILD/);
  assert.deepEqual(inBuild.asked(...PULL_LOOKUPS), []);
});

test("#2126: a FAILED review-health read refuses nothing, the way every lookup here fails OPEN", () => {
  const failing = tooling("CHANGES_REQUESTED");
  assert.ok(failing.reason(), "CONTROL: the same world with the read answered refuses");
  const refused = tooling("CHANGES_REQUESTED");
  refused.world.failures.set("openPullReviewsOf", new Error("gh: 502"));
  assert.equal(refused.reason(), null,
    "this clause can only ever CREATE a refusal, so an unanswerable read must not manufacture one");
});

// --- #2769: `--adopt` TELLS B4 WHICH BRANCH IT IS RE-STAMPING, so the row's own `Closes: none` split PR is not a competitor ---

const SPLIT_REGION_FILE = "packages/agent-org/src/row-claim.ts";
const SPLIT_BRANCH = "agent/reachable-region-2760";
/** All three template fields, because `claimRow` refuses a body missing any before it ever reaches B4. */
const splitBody = `## Region\n\n\`\`\`\n${SPLIT_REGION_FILE}\n\`\`\`\n\n## Acceptance\n\n\`\`\`\nnpx tsx --test x.test.ts\n\`\`\`\n\n`
  + "## Open-check\n\n```\ngit worktree list\n```\n";

/** The fake code host holding the row being claimed (its body declares the Region file) and #2766, the open PR on that file from the adopted branch. */
const splitClaimWorld = () => claimWorld({ rows: [{ number: 2760, body: splitBody }], pulls: [{ number: 2766, files: [SPLIT_REGION_FILE], body: "Closes: none -- Done-when 3 on #2760 is still open", headRefName: SPLIT_BRANCH }] });

test("#2769 sessionEligibilityReason: the `Closes: none` PR from the adopted branch is not a collision; without the branch it is", () => {
  splitClaimWorld();
  const reason = (adoptedBranch?: string) => sessionEligibilityReason(2760, "worker-2760", { ghRun: noGh as never, adoptedBranch });
  assert.match(reason() as string, /overlaps #2766/, "CONTROL: a fresh claim still refuses");
  assert.equal(reason(SPLIT_BRANCH), null);
  assert.match(reason("agent/other-1") as string, /overlaps #2766/);
});

test("#2769 claimRow FORWARDS `adoptedBranch` to B4 -- the flag reaches the check that reads it, not only the function that owns it", () => {
  splitClaimWorld();
  const refused = claimRow(2760, "worker-2760", { run: noGh as never, moveStatus: () => ({ moved: true }) });
  assert.equal(refused.claimed, false);
  assert.match((refused as { reason: string }).reason, /overlaps #2766/, "CONTROL: without it the claim is refused by B4");
  splitClaimWorld();
  const adopted = claimRow(2760, "worker-2760", { run: noGh as never, moveStatus: () => ({ moved: true }), adoptedBranch: SPLIT_BRANCH });
  assert.doesNotMatch(String((adopted as { reason?: string }).reason ?? ""), /overlaps|B4/, "B4 no longer refuses the adopted branch's own PR");
});
