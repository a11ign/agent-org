// no-token: MAX_ROW_ORDERS_PER_TICK -- #827. Same seams as work-gate.test.ts: every `gh` read is an injected `run`.
/**
 * #1602: THE WORK-GATE SUBTESTS THAT READ A11IGN'S OWN CHECKOUT, NOT THE FIXTURE PROJECT.
 *
 * `work-gate.test.ts` is pointed at `src/packaging/fixtures/project-tree/` by the row-1602 Acceptance. The tests here
 * read a fact that tree cannot supply -- its git index (`declaredRegionFiles` reads `git ls-files`, and the Acceptance
 * copies the tree without staging it), a11ign's roster (`worker-capture`), its CI job names (`ci.yml`), its shipped units,
 * or the text of a role brief. Each is moved here whole, byte-for-byte, with the reader named in
 * `docs/project-tree-dependency.md`. Nothing is skipped or weakened: they run in the default suite against a11ign's checkout.
 */
/**
 * #912: THE TICK IS A SCRIPT, AND THESE ARE THE ANSWERS IT MUST NOT GET WRONG.
 *
 * Six sessions each held a standing cron and woke every 10-30 minutes to ask a question one API call
 * answers -- 672 model turns a day, most finding nothing, which exhausted a weekly allowance in three
 * days. `work-gate.ts` is that question, asked for free. So the failures that matter here are the ones
 * that would either put the org back to sleep or wake all of it:
 *
 * A REFUSED READ MUST NEVER READ AS QUIET. Both readers return `null` for a refusal and never `[]`
 * (#1286's rule, and its reason: a refused `gh` exits non-zero with EMPTY stdout, so `[]` reports "nothing
 * is queued" and the org acts on it). The positive control is that an empty queue still returns `[]` and
 * still means quiet -- a reader answering `refused` whenever unsure blocks every quiet morning.
 *
 * AND THE POSITIVES ARE NOT OPTIONAL, for `review-verdict.test.ts`'s reason one level up: a `decide` that
 * returned `[]` for everything satisfies every "no order" case perfectly and would wake nobody, ever.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { shippedUnits } from "../host-units.ts";
import { HOME_CHECKOUT } from "../project-config.ts";
import { TOOL_ROOT } from "./copied-tool-fixture.ts";
import { type Declaration } from "../lib/pin-ratchet.ts";
import { deriveClosureRequirements, createClosureMemo } from "../acceptance-commands.ts";
import { decide as decideOnHost, CAUSES, comparablePrFiles, START_CAUSES, blockingChecks, requiredCheckNames, partitionUnclaimed, unclaimedBlockerClearedOrders, answerOrders, withAnswerLabel, withoutEndedAnswerSessions, withPrOwners, ownerOfPr, ANSWER_PREFIX, reviewBlocked, reviewBlockedOrders, HOLD_RED_JOBS }
  from "../work-gate.ts";
import { SESSION_PREFIX } from "../project-vocabulary.ts";
import { forgetRefusedReads } from "../ticket-port/rows-by-label.ts";
// #5050: the gate remembers a rate-limit refusal for the PROCESS, and a test here fakes one (`rate limited`), so without this every later list read answers `null`
// with no call made -- a failure far from its cause.
beforeEach(() => forgetRefusedReads());
// #2182: the SHIPPED reader that decides whether a delivered cause is still live, imported so this file
// can assert what the membership BUYS rather than only that the name is in the list. `wake.ts` runs
// nothing on import (its `main()` is behind an `import.meta.url` guard) and these three are pure, so this
// costs the `no-token` promise at the top of this file nothing.
import { addressed, deliver, escalateStuck, MAX_DELIVERIES } from "../wake.ts";
// #2237: the decider that REFUSES a launch, so the order's named launch directory is checked against it
// rather than read by a reviewer. Pure over an injected filesystem.

// Each check carries a NAME because the caller narrows with newestPerName, which keys on it -- a fixture
// without one is dropped, and the gate would read every PR as having no checks at all.
// #5050: the gate's label lists are GraphQL connections, not `issue list`, so a fake answers them in the connection's shape (`rows-by-label-fixtures.ts`).
const GREEN = [{ name: "ci", status: "COMPLETED", conclusion: "SUCCESS" }];
const HEAD = "abc12345deadbeefcafe000011112222";

/** @param n PR number @param rollup its checks @param comments its comments */
function draft(n: number, rollup: unknown[], comments: { body: string }[] = []) {
  return { number: n, isDraft: true, headRefOid: HEAD, statusCheckRollup: rollup, isCrossRepository: false,
    author: { login: "worker-judge" }, comments, labels: [] };
}









// --- #2296: the `priority` label is READ, and it orders offers without granting a claim ---
const priorityRow = (n: number, ...extra: string[]) =>
  ({ number: n, labels: [{ name: "ready" }, ...extra.map((e) => ({ name: e }))] });
const offered = (rows: unknown[], extra = {}) =>
  decide({ prs: [], readyRows: rows, ...extra })
    .filter((o: { cause: string }) => o.cause === "ready-row-unclaimed")
    .map((o: { subject: string }) => o.subject);




test("#2296: the label reorders offers and does NOT grant a claim -- a shelved `priority` row stays shelved", () => {
  const shelved = { ...regionRow(1452, ".github/workflows/release.yml"),
    labels: [{ name: "ready" }, { name: "priority" }] };
  assert.deepEqual(offered([shelved], { prFiles: [prTouching(1695, ".github/workflows/release.yml")] }), []);
  const held = priorityRow(1453, "priority", "in-progress");
  assert.deepEqual(offered([held]), []);
});

// --- #2293: what the label does NOT override, beyond #2296's shelved and claimed cases ---






// ---------------------------------------------------------------------------------------------------
// #2685: AN OUTAGE THAT FAILS gh/GraphQL CALLS INDEPENDENTLY PER CAUSE MUST NOT DOUBLE-COUNT.
//
// `wake.ts`'s `outageOf` already asks whether a causeKey's own addressed SESSION is unavailable
// (#2256); #2031's pool-exhaustion guard asks about the POOL. Neither asks whether GITHUB ITSELF refused
// THIS TICK's reads -- so, before this row, two causes stuck for the SAME shared connectivity reason each
// reach `escalateStuck` on their own and label two DIFFERENT rows `answer:ceo` for what is really one
// outage. `refusedReadCount`/`sharedReadOutage`/`markOutageReads` are `work-gate.ts`'s half of the fix;
// `deliver`'s `outaged` (wake.ts) is the other.





/**
 * THE FIXTURE ITSELF: two DIFFERENT causes, on two DIFFERENT rows, both at the delivery cap in the SAME
 * run. `escalateStuck` and `stuckRowOf`'s own tests already prove ONE stuck cause labels ONE row; what
 * neither proved is what happens to TWO, when the reason they are both stuck is one shared connectivity
 * failure rather than two genuinely unrelated rows.
 */
const CAPPED_CAUSES = [
  { session: "ceo", causeKey: "ceo/lane-backlog-unpromoted/row-101", prompt: "row #101 is not promoted" },
  { session: "ceo", causeKey: "ceo/org-stalled/row-102", prompt: "row #102 is stalled" },
];
const bothAtCap = () => new Map(CAPPED_CAUSES.map((o) => [o.causeKey, MAX_DELIVERIES]));



// --- #1650: a red pull request is work, and nobody was asking about it (2026-09-17) ---





// --- the shelf itself is work: Ready empty with a backlog behind it (2026-09-17) ---








// --- #1320: a lane is a person, and nothing was asking them (2026-09-18) ---

const laneRow = (n: number, lane: string, extra: string[] = []) =>
  ({ number: n, labels: [{ name: "ready" }, { name: lane }, ...extra.map((e) => ({ name: e }))] });







// --- a shelf full of other people's rows is an empty shelf to the pool (2026-09-18) ---





// --- #63: the escalation path ended at ceo, and ceo's onward route was a sentence (2026-09-18) ---
// The key and the window moved with #2989 and their tests with them: `packages/agent-org/src/work-gate-chairman-blocked.test.ts`.

const blockedRow = (n: number, daysAgo: number) =>
  ({ number: n, title: `row ${n}`, updatedAt: new Date(Date.now() - daysAgo * 86_400_000).toISOString() });
// The order is emitted only in the first two hours of a UTC day (#2989), so these pin a clock inside one.
const IN_WINDOW = Date.parse("2026-10-02T00:30:00Z");




// --- B4 asked EARLY: a row nobody can claim is not a row to offer (2026-09-18) ---

/**
 * THE TURN THIS REMOVES, MEASURED. All three unclaimed Ready rows (#1452, #1397, #1320) declared
 * `.github/workflows/release.yml`, which open draft #1695 already touched, so `row-claim.ts` refused
 * every one of them on B4. The gate offered all three every two minutes anyway. `ceo` was woken for
 * #1452, ran sixteen shell commands, rediscovered the refusal, posted it on the row, messaged
 * `product-manager` and stopped -- re-deriving a hold a PRIOR `ceo` session had already recorded.
 *
 * The refusal was an intersection of two `--json` field lists the gate's own two calls already pay for.
 * So these tests pin BOTH directions, because both hide: a gate that never shelves restores the wasted
 * turn, and a gate that shelves when it cannot actually tell would starve a queue in silence.
 */
const regionRow = (n: number, region: string, extra: string[] = []) =>
  ({ number: n, body: `## Region\n\n- \`${region}\`\n\n## Acceptance\n\nnone\n\n## Open-check\n\nnone\n`,
    labels: [{ name: "ready" }, ...extra.map((e) => ({ name: e }))] });

/**
 * The one file the B4 overlap tests contend over. It must sit under a top-level directory the tree it runs in tracks,
 * and that is TWO trees: this repository (`docs`, `src`, `host`) and a11ign's, where CI copies the tool under
 * `packages/agent-org` (`docs`, `packages`, `.claude`). `docs/` is the one both have. `declaredRegionFiles` derives its
 * recognised prefixes from `git ls-files` (#1158), so a Region naming `.claude/...` or `packages/...` declares NOTHING
 * when run from this repository, and a row declaring nothing overlaps nothing. The "offered" assertions then pass for
 * that reason, and the "shelved" twins fail (#3073).
 */
const SHARED_FILE = "docs/messaging.md";

const prTouching = (n: number, ...files: string[]) => ({ number: n, files, changedFiles: files.length });

test("a row whose Region overlaps an open PR is NOT offered -- B4 would only refuse the claim", () => {
  const orders = decide({ prs: [], readyRows: [regionRow(1452, ".github/workflows/release.yml")],
    prFiles: [prTouching(1695, ".github/workflows/release.yml")] });
  assert.deepEqual(orders.filter((o: { cause: string }) => o.cause === "ready-row-unclaimed"), [],
    "offering it costs a whole session turn to reach the answer this comparison already has");
});

/**
 * THE POSITIVE CONTROL for every assertion above. A `partitionUnclaimed` that shelved everything would
 * satisfy each "not offered" case perfectly and would recruit nobody, ever -- this file's own header
 * names that shape one level up.
 */
test("the SAME row IS offered when no open PR touches its Region", () => {
  const orders = decide({ prs: [], readyRows: [regionRow(1452, ".github/workflows/release.yml")],
    prFiles: [prTouching(1695, "packages/lab/src/packaging/something.test.ts")] });
  assert.deepEqual(orders.map((o: { subject: string }) => o.subject), ["row-1452"]);
});

// --- #2237: the order names a launch directory `launchGate` ACCEPTS ---
//
// `rowOrders` told every woken engineer to run `row-claim` "from the primary checkout" for nine days
// after `launchGate` (#1352) began refusing that launch. Deleting the sentence would re-open the
// 2026-09-17 incident it exists for (an engineer stopped and asked a human where to run it), so the
// assertions come in both directions: it must not name the primary, AND it must name somewhere.
const HOST_REPOS = "/home/agent/repos";
const HOST_PRIMARY = `${HOST_REPOS}/a11y-witness`;

/**
 * The host as `launchGate` reads it: the primary's `.git` is a DIRECTORY, and any other checkout under the
 * repos directory is a linked worktree whose `.git` is a FILE. Every direct child counts as a checkout so a
 * named directory the fixture had never heard of is judged, not waved through as "outside any checkout"
 * (`launchCheckoutOf` returns null there and `primaryLaunchRefusal` then says nothing).
 */
const HOST_FS = {
  exists: (path: string) => /^\/home\/agent\/repos\/[^/]+\/\.git$/.test(path),
  isDirectory: (path: string) => path === `${HOST_PRIMARY}/.git`,
  read: () => "",
};

const claimOrderPrompt = () => {
  const orders = decide({ prs: [], readyRows: [{ number: 9001, title: "t", labels: [] }] }) as
    { cause: string, prompt: string }[];
  return (orders.find((o) => o.cause === "ready-row-unclaimed") as { prompt: string }).prompt;
};

/**
 * THE ORDER AS THE ENGINEER READS IT (#2405): the gate leaves the launch directory to `wake.ts`, which knows who
 * took the order, so the sentence #2237 pins is asserted on what `addressed` delivers to a standing session whose
 * `role-<you>` worktree exists. `work-gate-engineer-order-paths.test.ts` pins the branch where it does not.
 */
const deliveredClaimOrder = () => addressed({ session: "engineers", prompt: claimOrderPrompt() }, "worker-tooling",
  { exists: () => true });

/**
 * THE LAUNCH DIRECTORY THE ORDER NAMES: the first absolute path in it, the order as `addressed` delivers it. "First" is a convention this test imposes -- an order that names the
 * primary at all, even to forbid it, must name its own directory BEFORE it -- and it is what lets a reworded
 * order that instructs the primary go red here without this file pinning a spelling of the wrong sentence.
 */
const namedLaunchDirectory = (prompt: string) =>
  /\/home\/agent\/repos\/[^\s`),;]+/.exec(prompt)?.[0] ?? null;





test("NO REGION is cannot-ask, not no-overlap -- the row is still offered, as row-claim would grant it", () => {
  const row = { number: 77, labels: [{ name: "ready" }], body: "a row with no template fields at all" };
  const orders = decide({ prs: [], readyRows: [row],
    prFiles: [prTouching(1695, ".github/workflows/release.yml")] });
  assert.deepEqual(orders.map((o: { subject: string }) => o.subject), ["row-77"],
    "row-claim skips B4 on a Region-less row rather than refusing it; disagreeing here would shelve "
    + "rows the claim would grant, and nothing would ever say so");
});

/**
 * #1419: `gh pr list --json files` returns each PR's first 100 files and never says so. At claim time a
 * list shorter than its own count is a REFUSAL, which is right when the cost of guessing is two sessions
 * in one file. Here it must FAIL OPEN -- one paginated PR would otherwise shelve the entire queue, and
 * the gate would report a starved queue as a quiet one.
 */
test("a TRUNCATED pull-request file list is dropped from the comparison, never read as an overlap", () => {
  const raw = [{ number: 1695, changedFiles: 113, files: [{ path: ".github/workflows/release.yml" }] }];
  assert.deepEqual(comparablePrFiles(raw), [], "113 changed files, 1 listed -- not comparable");
  const orders = decide({ prs: [], readyRows: [regionRow(1452, ".github/workflows/release.yml")],
    prFiles: comparablePrFiles(raw) });
  assert.deepEqual(orders.map((o: { subject: string }) => o.subject), ["row-1452"],
    "the gate fails open and row-claim still refuses at claim time -- shelving can only ever REMOVE a "
    + "wake that would have ended in a refusal");
});


// --- #2101: THE GATE SHELVED A ROW BEHIND THE PULL REQUEST THAT WAS THAT ROW'S OWN WORK ---
//
// Measured 2026-09-23: #2077 opened 32 seconds after #2076 was filed, one file each side and the same
// file. The gate compared #2076's Region against every open PR, #2077 included, and shelved #2076 --
// while #2084 and #2083 waited behind the same file and three engineers were idle. Nobody could claim
// the row and nobody could finish the PR; `product-manager` closed #2077 by hand after 1h41m.
//
// THE SHELVING SIDE IS PINNED BESIDE THE OFFERING SIDE ON PURPOSE. A gate that stops shelving is this
// row's defect running the other way -- it restores exactly the wasted turn `partitionUnclaimed` exists
// to remove -- so each assertion below that a row IS offered has a twin asserting a row is NOT.

const prClosingRow = (n: number, closes: number[], ...files: string[]) =>
  ({ number: n, files, changedFiles: files.length, closes });

test("#2101 a row is OFFERED although an open PR holds its whole Region, when that PR declares `Closes #<row>`", () => {
  const orders = decide({ prs: [], readyRows: [regionRow(2076, SHARED_FILE)],
    prFiles: [prClosingRow(2077, [2076], SHARED_FILE)] });
  assert.deepEqual(orders.map((o: { subject: string }) => o.subject), ["row-2076"],
    "a row and its own pull request are one piece of work, and one piece of work cannot collide with itself");
});

test("#2101 NEGATIVE: the same row is still SHELVED behind a PR declaring another row, and behind one " +
  "declaring nothing -- B4 stays unconditional about two SESSIONS in one file", () => {
  const row = regionRow(2076, SHARED_FILE);
  const other = decide({ prs: [], readyRows: [row],
    prFiles: [prClosingRow(2077, [2084], SHARED_FILE)] });
  assert.deepEqual(other.filter((o: { cause: string }) => o.cause === "ready-row-unclaimed"), []);
  const undeclared = decide({ prs: [], readyRows: [row],
    prFiles: [prTouching(2077, SHARED_FILE)] });
  assert.deepEqual(undeclared.filter((o: { cause: string }) => o.cause === "ready-row-unclaimed"), []);
});

test("#2101 the shelving REPORT names the same two, and stops naming the row's own PR", () => {
  const row = regionRow(2076, SHARED_FILE);
  assert.deepEqual(partitionUnclaimed([row],
    [prClosingRow(2077, [2076], SHARED_FILE)]).blocked, [],
  "a row withheld with no session able to unblock it is the deadlock itself");
  const [withheld] = partitionUnclaimed([row],
    [prTouching(2077, SHARED_FILE)]).blocked;
  assert.match(withheld.reason, /overlaps #2077/);
});


// --- #3674: THE OPEN LIST COSTS BY THE PAGE IT ASKS FOR, NOT BY THE PULL REQUESTS THAT ANSWER -------------------------------------
//
// The gate asked 100 of each of six repositories every two minutes: 7 GraphQL points apiece against 1 at 20 (measured by replaying the
// query with `rateLimit { cost }`), for lists holding 0 or 1 pull request. The narrow page is the whole list unless it came back FULL.

/** `gh`'s answer for an open list of `n` pull requests; only what `readPrs` looks at (`files` and `changedFiles`) is present. */
const openList = (n: number) => JSON.stringify(Array.from({ length: n }, (_, i) => ({ number: i + 1, files: [], changedFiles: 0 })));
const limitOf = (args: string[]) => Number(args[args.indexOf("--limit") + 1]);






// --- #2493: A HELD PR WAITING ON THE ASKING ROW IS NOT A REASON TO SHELVE IT ------------------------
//
// #2399 was shelved behind #2376, which carried `hold:` on purpose and was WAITING on #2399 -- the wait was a
// comment. `ceo` (#2400 section 2): exclude only when the PR is held AND every row it closes is `blockedBy` the
// asking row. The gate must give the verdicts `fileOverlapReason` gives at claim time, or it shelves what the
// claim would grant. Each "offered" assertion has a "shelved" twin, as in #2101 above.

const HELD_REGION = SHARED_FILE;
const edgeRow = (n: number, ...blockers: number[]) =>
  ({ number: n, labels: [{ name: "in-progress" }], blockedBy: { nodes: blockers.map((number) => ({ number, state: "OPEN" })) } });
/** #2376's shape: a HELD pull request on the region, closing `closes`. */
const heldPrClosing = (closes: number[], held = true) => ({ ...prClosingRow(2376, closes, HELD_REGION), held });
const shelved = (row: unknown, prFiles: { number: number; files: string[]; changedFiles: number }[], openRows: unknown[]) =>
  partitionUnclaimed([row], prFiles, { openRows }).blocked.map((b: { number: number }) => b.number);

test("#2493 THE POSITIVE: a held PR whose every closed row is blockedBy the asking row does not shelve it", () => {
  const row = regionRow(2399, HELD_REGION);
  const openRows = [edgeRow(2359, 2399)];
  assert.deepEqual(shelved(row, [heldPrClosing([2359])], openRows), []);
  const orders = decide({ prs: [], readyRows: [row], prFiles: [heldPrClosing([2359])], openRows });
  assert.deepEqual(orders.filter((o: { cause: string }) => o.cause === "ready-row-unclaimed")
    .map((o: { subject: string }) => o.subject), ["row-2399"], "offered, as `row-claim` would grant it");
});

test("#2493 NEGATIVES, through the gate: no edge, an edge to another row, no hold, and an unread row all SHELVE", () => {
  const row = regionRow(2399, HELD_REGION);
  assert.deepEqual(shelved(row, [heldPrClosing([2359])], [edgeRow(2359)]), [2399], "held, no edge");
  assert.deepEqual(shelved(row, [heldPrClosing([2359])], [edgeRow(2359, 2084)]), [2399], "an edge to ANOTHER row");
  assert.deepEqual(shelved(row, [heldPrClosing([2359], false)], [edgeRow(2359, 2399)]), [2399], "an edge but no `hold:`");
  assert.deepEqual(shelved(row, [heldPrClosing([2359])], []), [2399], "the closed row is not among those read: not excluded");
  assert.deepEqual(partitionUnclaimed([row], [heldPrClosing([2359])]).blocked.map((b: { number: number }) => b.number),
    [2399], "`openRows` absent excludes nothing, so every caller that does not pass it is unchanged");
  assert.match(partitionUnclaimed([row], [heldPrClosing([2359], false)], { openRows: [edgeRow(2359, 2399)] }).blocked[0].reason,
    /overlaps #2376/);
});

test("#2493 a held PR closing NOTHING, or closing TWO rows with one edge missing, still shelves", () => {
  const row = regionRow(2399, HELD_REGION);
  assert.deepEqual(shelved(row, [heldPrClosing([])], [edgeRow(2359, 2399)]), [2399], "`Closes: none` waits on nothing");
  assert.deepEqual(shelved(row, [heldPrClosing([2359, 2360])], [edgeRow(2359, 2399), edgeRow(2360, 2084)]), [2399]);
  assert.deepEqual(shelved(row, [heldPrClosing([2359, 2360])], [edgeRow(2359, 2399), edgeRow(2360, 2399)]), [],
    "the control: with both edges present the same PR is excluded");
});



/** #2493 done-when 5: the ready audit's line lives in the role brief, pinned so deleting it is red. */
test("#2493: product-manager's brief says `SOLE HOLDER IS A HELD PR`, and what to read next, in ONE bullet", () => {
  const brief = readFileSync(join(HOME_CHECKOUT, ".agent-org/roles/product-manager.md"), "utf8");
  // THE BULLET, SLICED: a whole-file `includes` is satisfied by any second copy of the phrase elsewhere.
  const start = brief.indexOf("- **A ready audit that names a B4 holder");
  assert.ok(start >= 0, "the bullet is gone");
  const bullet = brief.slice(start, brief.indexOf("\n- **", start + 1));
  assert.match(bullet, /`SOLE HOLDER IS A HELD PR`/);
  assert.match(bullet, /only holder carries `hold:`/, "the condition that makes the line true");
  assert.match(bullet, /FIRST audit/, "the point of the row: the cycle is named at the first reading, not the fifth");
  assert.match(bullet, /--add-blocked-by/, "and the remedy is the edge, which is data, not a comment");
});


test("prFiles omitted means no overlap is KNOWABLE, so every row is offered exactly as before", () => {
  const orders = decide({ prs: [], readyRows: [regionRow(1452, ".github/workflows/release.yml")] });
  assert.deepEqual(orders.map((o: { subject: string }) => o.subject), ["row-1452"],
    "a caller that cannot read files must never be worse off than one that never asked");
});

test("the empty-shelf order says WHY the pool is empty, and BLOCKED is not the same as LANED", () => {
  const orders = decide({ prs: [], readyRows: [regionRow(1320, ".github/workflows/release.yml")],
    promotableRows: [{ number: 800, labels: [{ name: "backlog" }] }],
    prFiles: [prTouching(1695, ".github/workflows/release.yml")] });
  const [shelf] = orders.filter((o: { cause: string }) => o.cause === "ready-queue-empty");
  assert.match(shelf.prompt, /1 unlaned row\(s\) blocked \(#1320: overlaps #1695/);
  assert.doesNotMatch(shelf.prompt, /belong to a lane/,
    "no row here is laned -- saying so sends product-manager to an owner who has nothing to answer");
  assert.match(shelf.prompt, /NOT rows to promote past/,
    "a blocked row is waiting on a pull request; promoting over the same files just moves the refusal");
});


// --- draining: finish what is in flight, take on nothing new (2026-09-18) ---

/**
 * WHY A WINDOW NEEDS MORE THAN AN OFF SWITCH. `ceo` announced a capture-free window for #63's history
 * purge and told `orchestrator` to hold the fleet; thirty minutes later two fresh agent branches had been
 * pushed, because the fleet has a hold and the work tick does not. Step 2 force-pushes a rewritten
 * history, so any branch created after the rewrite is stranded.
 *
 * And stopping the timer would have stranded them just as surely: the two drafts already open still
 * needed a reviewer verdict and a ready-marking to LAND. So the test that matters here is the pair --
 * what a drain withholds, and what it must keep delivering.
 */
const inFlight = () => [draft(1705, GREEN), { number: 1706, isDraft: true, isCrossRepository: false, headRefOid: HEAD,
  statusCheckRollup: GREEN, author: { login: "worker-tooling" }, labels: [],
  comments: [{ body: `Review of #1706 at \`${HEAD}\`, by reviewer: convinced` }] }];





/**
 * THE PARTITION MUST BE TOTAL, and this is the assertion that makes adding a cause a DECISION. A new
 * cause that nobody classifies defaults to surviving a drain -- so a future `claim-abandoned-row` would
 * quietly start new work inside a transfer window and nothing would say so. Spelling the other half out
 * means this test fails the moment `CAUSES` grows, and the author has to answer which kind it is.
 */
test("every cause is classified as START or FINISH -- a new one cannot default into a window", () => {
  const finish = CAUSES.filter((c: string) => !START_CAUSES.includes(c)).sort();
  assert.deepEqual([...START_CAUSES].sort(),
    ["blocked-unexaminable", "epic-finished", "epic-unfiled", "fleet-batch-due",
      "lane-backlog-unpromoted", "org-stalled", "ready-queue-empty", "ready-row-unclaimed",
      "unclaimed-blocker-cleared"]);
  // #2139: `unclaimed-blocker-cleared` is START, and it is `blocker-cleared`'s own argument read the
  // other way. The partition turns on whether the row is work in flight, and the ONLY difference between
  // the two causes is the claim -- which is exactly where that line falls. Nobody holds this row, so
  // promoting it is the org TAKING ON work, and a window is for landing what is already begun.
  // #1969: `pr-green-unarmed` is FINISH. A drain stops the org TAKING ON work and must not stop it
  // finishing what is in flight -- and a green, unheld, unarmed pull request is the most finished work
  // there is. Withholding it during a window would strand exactly the PRs the window is waiting to land.
  // #2110: `claimed-row-amended` is FINISH, and a drain is where withholding it would cost most -- a
  // window exists to LAND what is in flight, and a constraint that goes unread during one is a build
  // finished against a rule nobody applied.
  // #2031: `row-branch-unshipped` is FINISH, and a drain is where withholding it would cost MOST rather
  // than least. Step 2 of #63's history-purge runbook force-pushes a rewritten history, and every
  // unlanded branch on `origin` at that moment is stranded by it -- a window exists so the org can find
  // out what is still in flight before that happens. It also starts no work: the work already exists.
  // #2174: `host-units-stale` is FINISH, and a drain is the window where withholding it would cost MOST.
  // A drain does not stop the org running -- the work tick that EMITS this cause is itself one of the
  // units that can go stale, and step 2 of #63's history-purge runbook force-pushes a rewritten history
  // to the very checkout a unit's `WorkingDirectory=` names. It also starts no work by the partition's
  // own definition: its subject is a machine that is already wrong, not a row anybody has yet to pick up,
  // and the action is minutes rather than a build.
  // #2356: `trunk-red` is FINISH, and a drain is a window where withholding it costs most. A red `main` is
  // the branch every in-flight pull request lands on, so a window waiting to land them is waiting on the
  // fix; and it takes on nothing new -- the work is repairing what was already merged.
  // #2209: `pr-merge-conflict` is FINISH, for `pr-review-blocked`'s argument: a green, unheld pull request
  // that cannot merge is finished work that cannot land, and a window waits on exactly those.
  // #2365: `verdict-comment-unreviewed` is FINISH: its subject is a green, unheld pull request whose verdict
  // exists and cannot merge, which is finished work a window is waiting to land.
  // #2401: `reviewer-auth-failed` is FINISH: a reviewer that cannot authenticate is the reason in-flight pull
  // requests cannot land, and a window waiting to land them is waiting on the login. It starts no work.
  // #2163: `disk-headroom-low` is FINISH: it starts no work, and a drain is precisely when nobody is looking, so a full
  // disk that a window silenced would be found by the first session to fail with ENOSPC, which is the outage it exists for.
  // #2084: `pr-review-blocked` is FINISH, and it is `pr-green-unarmed`'s own argument one surface over.
  // A pull request that is green, unheld and refused by GitHub's `reviewDecision` is finished work that
  // cannot land -- it is the most in-flight thing there is, and it takes on nothing. Withholding it during
  // a window would strand precisely the pull requests the window is waiting to land, which is the failure
  // `START_CAUSES` was split out to prevent.
  // #2416: `awaiting-evidence-stale` is FINISH: its subject is a pull request already open and waiting on a run,
  // which a window that is landing in-flight work cares about, and it takes on nothing new.
  // #2470: `claim-stalled` is FINISH, and an ACTION cause (in `JUDGMENT_CAUSES` neither): its subject is a row a session already
  // holds, which a drain exists to land, and a release only returns the row to a pool that a drain already withholds.
  // #2075: `row-off-board` is FINISH, and a JUDGMENT cause. Boarding a row takes on no work -- the row is already filed, and
  // what is wrong is that the chairman's view cannot see it -- and rows are still filed during a drain.
  // #1959: `pr-codeowner-review-missing` is FINISH, `pr-review-blocked`'s own argument one surface over: a
  // pull request CODEOWNERS assigns to `ceo` with no approval from `ceo` is finished work that cannot land
  // once #1756's flip turns the gap into a hard merge block, and a drain is the window where leaving it
  // unreviewed would cost most. It starts no work: the pull request already exists.
  // #2691: `row-call-count-signal` is FINISH, and a JUDGMENT cause. Its subject is a row a session already
  // holds -- the plainest case of work in flight there is -- and reading the signal starts no new work:
  // `product-manager` deciding to split, or not, is a judgment over a row that already exists.
  // #2711: `answer-label-unexplained` is FINISH, and an ACTION cause (in `JUDGMENT_CAUSES` neither):
  // `claim-stalled`'s own argument -- its subject is a row a session already holds, which a drain exists to
  // land, and the two remedies (post the question, remove the label) start no new work.
  // #2791: `ready-row-incomplete` is FINISH, and a JUDGMENT cause. It starts no work -- it asks `product-manager` to
  // AMEND a row so a later claim can succeed, which a window has no reason to hold back.
  // #2729: `lab-job-finished` is FINISH, and a JUDGMENT cause. Its subject is a row a session already holds and the
  // result of a job that session already dispatched -- the plainest work in flight there is -- and it starts nothing:
  // it replaces the holder polling `lab:status`. A window that withheld it would leave the holder to poll again.
  // #2781: `primary-stale` is FINISH, and an ACTION cause: it starts no work, it tells `ceo` the gate is running from old code, and
  // a drain is when withholding it would cost most (the drain window ends in a force-push to this very checkout).
  // #2823: `closes-unresolved-repo-wide` is FINISH, and a JUDGMENT cause. Its subject is pull requests already open whose
  // declared rows GitHub will not close, which the post-merge closer covers -- it starts no work, it names a fault to a reader.
  // #2848: `repeating-log-line` and `backlog-aged-unpromoted` are FINISH, and JUDGMENT causes. Neither starts work: one names a fault
  // in the tick's own journal and the other asks `product-manager` to decide about a row already filed, and a drain is when
  // nobody reads the journal.
  // #2938: `org-retrospective` is FINISH too. It starts no work -- it asks `ceo` to LOOK at how the org is doing, and a drain is when
  // that is most worth doing, so a window must not withhold it.
  // #2845: `ready-row-unclaimable` is FINISH too. It starts no work -- it asks `product-manager` to unstick a row the claim keeps
  // refusing -- and a drain is when a stuck row most needs to be seen, since the pool's engineers are withheld anyway.
  // #3567: `tick-overran` is FINISH, and a JUDGMENT cause. It starts no work -- it tells `ceo` that a tick was KILLED (agent-org#1208: a slow one is recorded on a
  // standing row and wakes nobody) -- and a drain is when nobody is looking at the tick, so a window must not withhold the one signal that says the tick is the
  // thing that stopped.
  // #2936: `org-health` is FINISH, and a JUDGMENT cause. It starts no work -- it tells `ceo` that nothing is landing, a red PR is unattended, a row
  // is refused or the primary is stale -- and a drain is exactly when an org that is not landing anything should be told.
  // #636: `ready-rows-untiered` is FINISH too. It starts no work -- it asks `product-manager` to put a tier decision on rows already ready -- and a drain is
  // when a stock of undecided rows should still be swept, since nothing is claiming them anyway.
  // #3632: `answer-given` is FINISH, and a JUDGMENT cause. Its subject is a row the asking session already holds, and it starts no work: it tells the claimant
  // its question was answered, once, which a drain exists to land -- and a drain is when the answerer's reply most needs to reach the asker.
  // #4970: `hold-holder-idle` is FINISH, and an ACTION cause. It starts no work -- it wakes the session that holds an approved pull request, then asks the seat that
  // decides about it -- and a drain is when a held pull request most needs releasing, since nothing else is landing.
  // agent-org#1060: `row-closed-under-open-half` is FINISH, and a JUDGMENT cause. It starts no work -- it asks `product-manager` to reopen a row another half's merge
  // closed while this half is still open -- and it has its own cause so `ready-row-unclaimable` keeps the one meaning, a refused claim.
  assert.deepEqual(finish, ["answer-given", "answer-label-unexplained", "answer-owed", "awaiting-evidence-stale", "backlog-aged-unpromoted", "blocker-cleared", "chairman-answered", "chairman-blocked",
    "claim-stalled", "claimed-row-amended", "closes-unresolved-repo-wide", "disk-headroom-low", "draft-awaiting-verdict", "draft-convinced-not-ready", "hold-holder-idle", "host-units-stale",
    "lab-job-finished", "org-health", "org-retrospective", "pr-approval-not-counted", "pr-checks-failing", "pr-codeowner-review-missing", "pr-green-unarmed", "pr-merge-conflict", "pr-review-blocked", "primary-stale", "ready-row-incomplete", "ready-row-unclaimable", "ready-rows-untiered", "repeating-log-line", "reviewer-auth-failed",
    "row-branch-unshipped", "row-call-count-signal", "row-closed-under-open-half", "row-off-board", "tick-overran", "trunk-red", "verdict-comment-unreviewed", "verdict-not-convinced",
    "verified-close"]);
  for (const cause of START_CAUSES) {
    assert.ok(CAUSES.includes(cause), `${cause} is withheld by a drain but no longer exists`);
  }
});


// --- the dead man's switch: a cause that fires on the ABSENCE of causes (2026-09-19) ---











/**
 * ONLY A CHECK THAT CAN HOLD THE PULL REQUEST COUNTS AS RED.
 *
 * MEASURED 2026-09-19: `main`'s branch protection requires exactly one check, `required_status_checks:
 * ["gate"]`, and `gate` is an aggregator whose `needs` names the nine jobs that matter. `sweep` lives in
 * `auto-arm.yml` and is in nobody's `needs` -- it went red on #1750 at 14:34Z, the gate woke
 * `worker-capture` to "fix the cause on that branch", and #1750 MERGED FOUR MINUTES LATER at 14:38:46Z.
 * The check was genuinely red; the wake could never have been useful.
 */
const rollupOf = (entries: [string, string][]) => entries.map(([name, conclusion]) => ({
  __typename: "CheckRun", name, status: "COMPLETED", conclusion,
}));


test("a red check that CAN block the merge still wakes its session", () => {
  // THE POSITIVE CONTROL. #1650 is why `failingChecksOrder` exists: a `changeset` failure sat unattended
  // while its own session was idle. Narrowing what counts as red must not reopen that.
  const pr = { number: 1650, isDraft: false, isCrossRepository: false, headRefOid: "deadbeefcafe0000", author: { login: "x" },
    labels: [{ name: "session:worker-capture" }], comments: [],
    statusCheckRollup: rollupOf([["gate", "FAILURE"], ["sweep", "SUCCESS"]]) };
  const [order] = decide({ prs: [pr], readyRows: [], required: ["gate"] }) as { cause: string,
    session: string }[];
  assert.equal(order.cause, "pr-checks-failing");
  assert.equal(order.session, "worker-capture", "and it goes to the session named on the PR");
});

test("#2538 the pr-checks-failing order keeps its (a)/(b)/(c) triage and drops the tail the preamble already says", () => {
  const pr = { number: 1650, isDraft: false, isCrossRepository: false, headRefOid: "deadbeefcafe0000", author: { login: "x" },
    labels: [{ name: "session:worker-capture" }], comments: [],
    statusCheckRollup: rollupOf([["gate", "FAILURE"]]) };
  const [order] = decide({ prs: [pr], readyRows: [], required: ["gate"] }) as { prompt: string }[];
  for (const kept of ["(a) a real defect on your branch", "(b) a run that tested a `main` since fixed", "(c) a check that could not ASK"]) {
    assert.ok(order.prompt.includes(kept), `the triage is useful and stays: ${kept}`);
  }
  assert.ok(order.prompt.endsWith("Read the failing job to see which."), "and the order now ends where the triage does");
  assert.doesNotMatch(order.prompt, /nobody answers|not yours to fix/, "the closing 'say so on the PR' repeated the preamble");
});

test("an UNREADABLE required set counts every check, exactly as before it existed", () => {
  // `null` is "could not be read", NOT "nothing is required". Conflating them would make the gate go
  // permanently silent on red PRs the first time an API read failed -- trading a wasted turn for the
  // failure this whole function was written to stop.
  const pr = { number: 1750, isDraft: false, isCrossRepository: false, headRefOid: "7a9d8340aaaaaaaa", author: { login: "x" },
    labels: [{ name: "session:worker-capture" }], comments: [],
    statusCheckRollup: rollupOf([["gate", "SUCCESS"], ["sweep", "FAILURE"]]) };
  const orders = decide({ prs: [pr], readyRows: [], required: null });
  assert.equal(orders.length, 1, "fail OPEN: an unreadable required set must never silence a red PR");
  assert.deepEqual(blockingChecks([{ name: "sweep" }], null), [{ name: "sweep" }],
    "null considers everything");
  assert.deepEqual(blockingChecks([{ name: "sweep" }, { name: "gate" }], ["gate"]), [{ name: "gate" }]);
});


/**
 * #1916: a superseded run's CANCELLED check is NO VERDICT while the replacement still runs (#1007's ruling).
 * The fixture is #1924's head `c0864658`, 2026-09-22: the required `gate` exists ONLY in the cancelled run
 * 35717172571, and the live run 35717174536's `ts / run` is still in progress.
 */
const cancelledGateWhile = (live: Record<string, unknown>) => ({ number: 1924, isDraft: false,
  headRefOid: "c0864658aaaaaaaa", author: { login: "x" }, labels: [{ name: "session:worker-capture" }],
  comments: [], statusCheckRollup: [
    { __typename: "CheckRun", name: "gate", status: "COMPLETED", conclusion: "CANCELLED",
      detailsUrl: "https://github.com/a11ign/a11ign/actions/runs/35717172571/job/1" },
    { __typename: "CheckRun", name: "ts / run", detailsUrl: "https://github.com/a11ign/a11ign/actions/runs/35717174536/job/2",
      ...live },
  ] });


test("a CANCELLED required check with nothing else running is still red and still reaches its author", () => {
  // THE POSITIVE CONTROL, and #1605's caveat: a cancelled `gate` that is genuinely the last word held a PR
  // BLOCKED. Without this, a predicate that ignored CANCELLED altogether would pass the test above.
  const settled = cancelledGateWhile({ status: "COMPLETED", conclusion: "SUCCESS" });
  const [order] = decide({ prs: [settled], readyRows: [], required: ["gate"] }) as { cause: string,
    session: string }[];
  assert.equal(order?.cause, "pr-checks-failing", "nothing is in flight, so nobody else will ever answer it");
  assert.equal(order.session, "worker-capture");
});


/**
 * #2400: A HOLD IS AN ANSWER. #2376 carried `hold:product-manager` on purpose; the hold turned `deliberateRefusals`
 * red and `gate` with it, and the gate ordered `product-manager` to fix a cause it had itself placed -- 35 times,
 * then `needs:chairman`. The fixture is that PR's shape: no `session:` label and nobody else to name, so (#2941) the order would go to `ceo` -- and a hold
 * by ANY session is the answer for a PR nobody owns, which is what keeps #2376 quiet now that `product-manager` is not the addressee.
 */
const HELD_RED = [["deliberateRefusals", "FAILURE"], ["gate", "FAILURE"], ["ts / run", "SUCCESS"]] as [string, string][];
const heldPr = (labels: string[], checks: [string, string][] = HELD_RED) => ({ number: 2376, isDraft: true,
  headRefOid: "b7fd42fe00000000", author: { login: "x" }, labels: labels.map((name) => ({ name })), comments: [],
  statusCheckRollup: rollupOf(checks) });
const failingOrders = (pr: unknown, required: string[] | null) =>
  (decide({ prs: [pr], readyRows: [], required }) as { cause: string, session: string, causeKey: string, prompt: string }[])
    .filter((o) => o.cause === "pr-checks-failing");


test("the same two red jobs WITHOUT the hold still order -- the null is the exemption, not an empty rollup", () => {
  // THE POSITIVE CONTROL (clause 4), and also "the hold is removed": the order comes back on the next tick.
  for (const required of [["gate"], null]) {
    const [order, ...rest] = failingOrders(heldPr([]), required);
    assert.equal(rest.length, 0);
    assert.equal(order?.session, "ceo");
    assert.equal(order?.causeKey, "ceo/pr-checks-failing/pr-2376/b7fd42fe");
  }
});

test("a THIRD red job ends the exemption, so a real failure under a hold still reaches its session", () => {
  const real: [string, string][] = [["deliberateRefusals", "FAILURE"], ["gate", "FAILURE"], ["ts / run", "FAILURE"]];
  for (const required of [["gate"], null]) {
    const [order] = failingOrders(heldPr(["hold:product-manager"], real), required);
    assert.equal(order?.causeKey, "ceo/pr-checks-failing/pr-2376/b7fd42fe",
      `required=${JSON.stringify(required)}: with gate the only REQUIRED check, reading the blocking set alone `
      + "would have called this the hold's doing");
  }
  const noHoldRed: [string, string][] = [["gate", "FAILURE"], ["changeset", "FAILURE"]];
  assert.equal(failingOrders(heldPr(["hold:product-manager"], noHoldRed), ["gate"]).length, 1,
    "a hold does not excuse a red gate whose cause is not the hold (deliberateRefusals is green here)");
});

test("ANY session's hold answers a PR red only from it, the owner's too -- #2993 narrows #2400's clause 1", () => {
  // #2400 clause 1 ("a hold by anyone else is not an answer from the session being asked") was written for a hold the ADDRESSEE placed.
  // For a hold the addressee is the SUBJECT of, the order asks "fix your build" and nothing in the build is broken (#2990, five orders).
  assert.deepEqual(failingOrders(heldPr(["hold:ceo"]), ["gate"]), [], "unowned and held by ceo, who is the last answer");
  assert.deepEqual(failingOrders(heldPr(["hold:worker-9"]), ["gate"]), [], "unowned and held by somebody: that is the answer");
  const labelled = (labels: string[], checks: [string, string][] = HELD_RED) => heldPr(["session:worker-5", ...labels], checks);
  const real: [string, string][] = [["deliberateRefusals", "FAILURE"], ["gate", "FAILURE"], ["ts / run", "FAILURE"]];
  for (const required of [["gate"], null]) {
    const where = `required=${JSON.stringify(required)}`;
    // (1) a foreign hold, owner worker-5: no order
    assert.deepEqual(failingOrders(labelled(["hold:ceo"]), required), [], `(1) worker-5's PR held by ceo ${where}`);
    assert.deepEqual(failingOrders(labelled(["hold:product-manager"]), required), [], `(1) held by product-manager ${where}`);
    assert.deepEqual(failingOrders(labelled(["hold:worker-5"]), required), [], `worker-5 holding its own PR ${where}`);
    assert.deepEqual(failingOrders(labelled(["hold:ceo", "hold:worker-5"]), required), [], `two holders ${where}`);
    // (2) a third red job under the same foreign hold still reaches the owner
    const [order, ...rest] = failingOrders(labelled(["hold:ceo"], real), required);
    assert.equal(rest.length, 0);
    assert.equal(order?.session, "worker-5", `(2) a real ts / run failure under a foreign hold ${where}`);
    // (3) the hold removed, same two red jobs: the null above is the exemption, not an empty rollup
    assert.equal(failingOrders(labelled([]), required)[0]?.session, "worker-5", `(3) no hold ${where}`);
  }
});

/**
 * #2935: A ROW-ROUTED ORDER IS QUIET UNDER A HOLD. #2882 addressed an unlabelled red PR to the session holding its row (`rowOwner`), so
 * the hold of the session it went to before that change stopped matching and #2883 was re-ordered every tick. Since #2993 no hold has to
 * match anybody: the exemption still ends with either key (a third red job, or the hold removed).
 */
test("a rowOwner-routed PR under any hold generates no order; a third red job or no hold brings it back -- #2935/#2993", () => {
  const routed = (labels: string[], checks: [string, string][] = HELD_RED) =>
    ({ ...heldPr(labels, checks), rowOwner: { session: "worker-2879", row: 2879, source: "closes" } });
  for (const required of [["gate"], null]) {
    assert.deepEqual(failingOrders(routed(["hold:product-manager"]), required), [],
      `hold:product-manager, row held by worker-2879 (required=${JSON.stringify(required)})`);
    assert.deepEqual(failingOrders(routed(["hold:worker-2879"]), required), [], "the row holder's own hold");
    assert.deepEqual(failingOrders(routed(["hold:ceo"]), required), [], "somebody else's hold (#2993)");
    const real: [string, string][] = [["deliberateRefusals", "FAILURE"], ["gate", "FAILURE"], ["ts / run", "FAILURE"]];
    assert.equal(failingOrders(routed(["hold:product-manager"], real), required)[0]?.session, "worker-2879", "third job red");
    assert.equal(failingOrders(routed([]), required)[0]?.session, "worker-2879", "hold removed");
  }
  const labelled = { ...heldPr(["session:worker-5", "hold:product-manager"]), rowOwner: { session: "worker-2879", row: 2879, source: "closes" } };
  assert.deepEqual(failingOrders(labelled, ["gate"]), [], "a labelled PR under product-manager's hold: no order either (#2993)");
});

test("HOLD_RED_JOBS names the jobs ci.yml defines, so the exemption cannot go stale on a rename", () => {
  const ci = readFileSync(join(HOME_CHECKOUT, ".github/workflows/ci.yml"), "utf8");
  assert.deepEqual([...HOLD_RED_JOBS], ["deliberateRefusals", "gate"]);
  for (const job of HOLD_RED_JOBS) assert.match(ci, new RegExp(`\\n {2}${job}:\\n`), `${job} is a job in ci.yml`);
});

/**
 * #2709: THE HOLD'S OWN RED MUST NOT BLOCK THE REVIEW QUESTION EITHER. `redOnlyFromHoldOf` (above) already
 * excuses a hold's own manufactured red from `pr-checks-failing`, keyed to ONE session -- the addressee.
 * `reviewableHead` asks a different question ("can anyone be asked for a verdict yet") and has no
 * addressee, so it needs the unkeyed form: ANY `hold:` label, not just a session-matching one. The fixture
 * is PR #2649's live shape: held by `orchestrator`, which is also its own `session:` label (so
 * `failingChecksOrder` reads the hold as its own answer and stays out of the way, the same as #2400's
 * fixture above), `deliberateRefusals` and `gate` red, everything else green.
 */
const holdOwnPr = (checks: [string, string][] = HELD_RED) => ({ number: 2649, isDraft: false,
  headRefOid: "2649cafe00000000", author: { login: "x" },
  labels: [{ name: "session:orchestrator" }, { name: "hold:orchestrator" }], comments: [],
  statusCheckRollup: rollupOf(checks) });



/**
 * Clauses 3 and 5: the escalation is read off what `deliver` is HANDED, so an order never emitted cannot reach the
 * breaker at all. The wake half is driven with the ledger already at the cap, which is #2376's state.
 */
test("a held PR at the cap stops appearing in stuck, and a real failure under the same hold still escalates -- #2400", () => {
  const at = (checkNames: [string, string][], labels = ["hold:product-manager"]) => {
    const orders = failingOrders(heldPr(labels, checkNames), ["gate"]);
    const counts = new Map(orders.map((o) => [o.causeKey, MAX_DELIVERIES]));
    const calls: string[][] = [];
    const { sent, stuck } = deliver(orders, [], [], { counts, run: () => { throw new Error("nothing may be sent"); } });
    const labelled = escalateStuck(stuck, (a: string[]) => { calls.push(a); return ""; }, () => {});
    return { orders, sent, stuck, labelled, calls };
  };
  const held = at(HELD_RED);
  assert.deepEqual([held.orders, held.stuck, held.labelled, held.calls], [[], [], [], []],
    "no order, so no stuck line, so no escalation label");
  const real = at([["deliberateRefusals", "FAILURE"], ["gate", "FAILURE"], ["changeset", "FAILURE"]]);
  assert.equal(real.orders.length, 1, "POSITIVE CONTROL: the order exists");
  assert.equal(real.stuck.length, 1, "and at the cap it is stuck, by the ordinary count");
  assert.deepEqual(real.labelled, [2376]);
  assert.deepEqual(real.calls, [["issue", "edit", "2376", "--add-label", "answer:ceo"]]);
});

test("a PR held by SOMEBODY ELSE at the cap is not stuck and gets no needs:chairman -- #2993", () => {
  const foreign = ["session:worker-5", "hold:ceo"];
  const at = (checkNames: [string, string][]) => {
    const orders = failingOrders(heldPr(foreign, checkNames), ["gate"]);
    const counts = new Map(orders.map((o) => [o.causeKey, MAX_DELIVERIES]));
    const calls: string[][] = [];
    const { stuck } = deliver(orders, [], [], { counts, run: () => { throw new Error("nothing may be sent"); } });
    const labelled = escalateStuck(stuck, (a: string[]) => { calls.push(a); return ""; }, () => {});
    return { orders, stuck, labelled, calls };
  };
  const held = at(HELD_RED);
  assert.deepEqual([held.orders, held.stuck, held.labelled, held.calls], [[], [], [], []], "(4) a foreign hold: nothing to escalate");
  const real = at([["deliberateRefusals", "FAILURE"], ["gate", "FAILURE"], ["ts / run", "FAILURE"]]);
  assert.equal(real.orders[0]?.session, "worker-5", "POSITIVE CONTROL: the owner is still ordered on a real failure");
  assert.equal(real.stuck.length, 1, "and at the cap it is stuck, by the ordinary count");
});


/** `branches/main` as GitHub answers it (the part the gate reads); `contexts: null` is protection with no list. */
const BRANCH_ANSWER = (contexts: string[] | null, isProtected = true) =>
  JSON.stringify({ name: "main", protected: isProtected,
    protection: { enabled: isProtected, required_status_checks: contexts === null ? {} : { contexts } } });

/**
 * #2117: THE `pr-checks-failing` PROMPT CARRIES WHEN THE FAILING RUN STARTED AND WHETHER `main` MOVED
 * SINCE -- A FACT, NEVER A PREDICATE. #2087 (2026-09-23): the gate held `startedAt` and threw it away, and two
 * sessions reached opposite readings of one PR. The fixture is the row's own open-check.
 */
const RED_CI = { name: "ci", status: "COMPLETED", conclusion: "FAILURE", startedAt: "2026-09-23T09:07:00Z" };
const RED_2087 = {
  number: 2087, isDraft: true, isCrossRepository: false, headRefOid: "06a5230817c14f3f6dedf986c7d722201e1333eb",
  statusCheckRollup: [RED_CI],
  author: { login: "worker-judge" }, comments: [], labels: [{ name: "session:worker-judge" }],
};
const TIP_AFTER = { sha: "b08d5486bcafe0000", date: "2026-09-23T09:15:13Z" };
const TIP_BEFORE = { sha: "a1a1a1a1bcafe0000", date: "2026-09-23T09:00:00Z" };
type Order = { cause: string, prompt: string, session: string, subject: string, discriminator: string,
  causeKey: string };
const redOrder = (baseTip?: { sha: string, date: string } | null, pr: object = RED_2087) =>
  (decide({ prs: [pr], readyRows: [], baseTip }) as Order[]).find((o) => o.cause === "pr-checks-failing") as Order;







/**
 * #3005: A RED PULL REQUEST THAT TURNS CONFLICTED AT THE SAME HEAD IS A NEW CAUSE. #2990 sat 63 minutes at one
 * `pr-checks-failing` key (delivered six times, owner idle) because a conflicting branch gets no `pull_request` run, so
 * the head and the red never changed while the work went from "fix the check" to "rebase".
 */
const MERGEABLE_2087 = { ...RED_2087, mergeStateStatus: "BLOCKED", mergeable: "MERGEABLE" };
const CONFLICTING_2087 = { ...RED_2087, mergeStateStatus: "DIRTY", mergeable: "CONFLICTING" };
const MERGEABLE_KEY = "worker-judge/pr-checks-failing/pr-2087/06a52308";








/**
 * #5020: CLASSIC PROTECTION IS GONE ON EVERY REPO AND THE LIST LIVES IN THE RULESETS. `gh` answers `branches/main`
 * with `protection: {enabled: false, required_status_checks: {contexts: []}}`, which read as "nothing is required"
 * for every tick since the chairman's consolidation and failed the gate open on every red PR.
 *
 * The fake routes by ENDPOINT, as GitHub does, so a reader that asks only one of the two is told the other's
 * answer is absent -- a mock returning one body for every call would pass a reader that never looked at the rules.
 */
const rulesAnswer = (...checkRulesets: string[][]) => JSON.stringify([
  { type: "deletion", ruleset_id: 1 },
  { type: "pull_request", parameters: { required_approving_review_count: 1 }, ruleset_id: 1 },
  ...checkRulesets.map((contexts, i) => ({ type: "required_status_checks", ruleset_id: 2 + i,
    parameters: { strict_required_status_checks_policy: false,
      required_status_checks: contexts.map((context) => ({ context, integration_id: 15368 })) } })),
  { type: "merge_queue", ruleset_id: 1 },
]);
const CLASSIC_GONE = BRANCH_ANSWER([]);
const routedGh = (answers: { rules?: string | Error; branch?: string | Error }) => (args: string[]) => {
  const answer = args.some((arg) => arg.endsWith("/rules/branches/main")) ? answers.rules
    : args.some((arg) => arg.endsWith("/branches/main")) ? answers.branch : undefined;
  if (answer === undefined || answer instanceof Error) throw answer ?? new Error(`unexpected gh call: ${args.join(" ")}`);
  return answer;
};





/**
 * FAILING OPEN IN SILENCE IS INDISTINGUISHABLE FROM NEVER HAVING WORKED -- #2106.
 *
 * `requiredCheckNames` returned `null` on EVERY tick from the day #1750 shipped until 2026-09-23, and
 * the only sign was a bare `gh: Not Found (HTTP 404)` on stderr beside an exit 0 -- `defaultRun` inherits
 * stderr, so `gh`'s own message was the whole report. Four days of a dead optimisation. There was never a
 * correctness bug: the fallback counts every check, so no red pull request went unreported. What was lost
 * is the saving, and nothing said so.
 *
 * #2331 REMOVED THE CAUSE, NOT THE REPORT. The gate now reads `branches/main`, which a non-admin
 * credential can read, so the admin-only 404 that produced the four dead days is gone -- and with it the
 * `branches/main.protected` DISCRIMINATOR that existed to explain that 404 (#2022's FORBIDDEN-versus-ABSENT).
 * Nothing reaches a second read any more: the discriminator was the same endpoint as the read it explained.
 * The report itself stays, because `branches/main` can still be refused (network, a renamed trunk) and
 * "fails open" must still announce itself.
 *
 * THE TEST DRIVES THE THROWING CASE AND ASSERTS BOTH HALVES, because `null` alone is what the old code
 * already did. Only the report is new, and a test that checked the `null` would pass against the defect.
 */
const requiredWithLog = (run: (args: string[]) => string) => {
  const lines: string[] = [];
  const calls: string[][] = [];
  const required = requiredCheckNames((args: string[]) => { calls.push(args); return run(args); },
    (line) => { lines.push(line); });
  return { required, lines, calls };
};

/** The gate's credential, as GitHub answers it: the ADMIN endpoint is a 404, `branches/main` answers. */
const nonAdminGh = (branchAnswer: string) => (args: string[]) => {
  if (args.some((arg) => arg.includes("branches/main/protection"))) throw new Error("gh: Not Found (HTTP 404)");
  return branchAnswer;
};




/**
 * `fleet-gated` ROUTES WORK; IT DOES NOT HIDE IT.
 *
 * The label's own definition on GitHub is "Acceptance needs the fleet or the lab; ORCHESTRATOR RUNS IT".
 * `NOT_PICKABLE` was read as a property of the ROW, so the label that says whose work it is also hid the
 * row from that session -- and `laneBacklogOrders` iterated lanes, which routed rows do not have.
 *
 * MEASURED 2026-09-19 with the fleet 10/10 ready, consistent, zero recoveries: `orchestrator` idle,
 * seven `lane:orchestrator` rows open, ZERO visible to the cause. Twelve `fleet-gated` rows in total.
 * And the deadlock that keeps it that way: #914 -- "a nightly fleet capture batch for every fleet-gated
 * row" -- is itself `fleet-gated`.
 */
const gated = (n: number, ...extra: string[]) => ({ number: n,
  labels: [{ name: "backlog" }, { name: "fleet-gated" }, ...extra.map((name) => ({ name }))] });










/**
 * THE BOUNDED-WINDOW INVARIANT, GUARDED -- the hole `reviewer` found in #1769 and could not post.
 *
 * #1769 narrowed "red" to the required checks and called `newestPerName` at the read site to satisfy
 * `local/bounded-window-reads`. `reviewer` then MUTATED that call away -- passing the raw rollup -- and
 * ALL 65 TESTS STAYED GREEN. The lint rule caught it at authoring time; nothing caught it at test time,
 * so a future edit that dropped the narrowing would ship silently.
 *
 * WHAT THE REGRESSION WOULD DO: `statusCheckRollup` UNIONS superseded runs, so a check that failed at
 * 10:00 and succeeded at 11:00 appears TWICE. Read raw, the old FAILURE makes a green pull request look
 * red and the gate wakes its session to "fix the cause on that branch" -- exactly the wasted prompt
 * #1769 exists to stop, arriving through the fix for it. `merge-queue.ts` had this defect until #634.
 *
 * The verdict never reached the PR: #1769 merged while the review was running, and `reviewer` correctly
 * refused to comment on a closed pull request. It was relayed by the chairman instead.
 */
test("a SUPERSEDED red run does not wake anyone -- the newest run per name is what counts", () => {
  const twice = { number: 1, isDraft: false, isCrossRepository: false, headRefOid: "abc12345aaaaaaaa", author: { login: "x" },
    labels: [{ name: "session:worker-capture" }],
    // A verdict at head, so the only order this fixture can produce is the red one (#2176).
    comments: [{ body: "Review of #1 at `abc12345`, by `reviewer`: convinced." }],
    statusCheckRollup: [
      { __typename: "CheckRun", name: "gate", status: "COMPLETED", conclusion: "FAILURE",
        completedAt: "2026-09-19T10:00:00Z" },
      { __typename: "CheckRun", name: "gate", status: "COMPLETED", conclusion: "SUCCESS",
        completedAt: "2026-09-19T11:00:00Z" },
    ] };
  assert.deepEqual(decide({ prs: [twice], readyRows: [], required: ["gate"] }), [],
    "the 11:00 SUCCESS supersedes the 10:00 FAILURE -- reading the union reports a green PR as red");

  // AND THE POSITIVE CONTROL, or the assertion above passes for a version that reports nothing at all:
  // reverse the times and the newest run IS the failure, which must still wake its session.
  const newestIsRed = { ...twice, statusCheckRollup: [
    { __typename: "CheckRun", name: "gate", status: "COMPLETED", conclusion: "SUCCESS",
      completedAt: "2026-09-19T10:00:00Z" },
    { __typename: "CheckRun", name: "gate", status: "COMPLETED", conclusion: "FAILURE",
      completedAt: "2026-09-19T11:00:00Z" },
  ] };
  const [order] = decide({ prs: [newestIsRed], readyRows: [], required: ["gate"] }) as
    { cause: string }[];
  assert.equal(order?.cause, "pr-checks-failing", "a genuinely red newest run must still be reported");
});


/**
 * A DECLARED WAIT DROPS OUT, AND COMES BACK BY ITSELF.
 *
 * THE PROPERTY THAT MATTERS IS NOT THE HIDING -- `blocked` already hides. It is that nobody has to
 * REMEMBER to un-hide. `blocked` is a claim with no referent, so only a human re-reading the row can
 * clear it, which is why 11 rows carried it on 2026-09-19 with several waiting on conditions that had
 * long since become true.
 *
 * AND NO NEW CAUSE IS NEEDED, which is the strongest evidence this is the right seam: when the condition
 * clears, the row re-enters the population, the owner's COUNT changes, the causeKey changes, the wake
 * ledger's dedupe no longer matches, and the EXISTING cause fires. It composes with what is there
 * instead of adding a parallel mechanism beside it.
 */
const waitingRow = (n: number, extra: Record<string, unknown>) => ({ number: n,
  labels: [{ name: "backlog" }, { name: "lane:ceo" }], ...extra });












/**
 * AN EPIC WITH NO CHILDREN IS WORK NOBODY HAS FILED -- the third instance of one defect.
 *
 *   `fleet-gated`  not the pool's | IS orchestrator's         -- fixed, ROUTED_TO
 *   `blocked`      not startable  | a claim with no referent  -- fixed, blockedBy/Not-before
 *   `epic`         not pickable   | NOBODY HAS FILED THIS YET -- this
 *
 * MEASURED 2026-09-20, and it is why the chairman found six engineers idle on a healthy fleet: 40 open
 * rows, 0 ready, 0 open PRs, ONE claimable row -- and that one titled "Human:" because it needs the
 * chairman. Meanwhile 17 open epics, 16 with zero sub-issues, nine also `fleet-gated`. #34 is the
 * plainest: "Sixteen built cases have never been captured." The org had not run out of work; it had run
 * out of FILED work, and no cause could tell the difference.
 */
const epic = (n: number, total = 0) => ({ number: n, title: `epic ${n}`,
  labels: [{ name: "backlog" }, { name: "epic" }], subIssuesSummary: { total, completed: 0 } });



// --- #1799: an unrelated epic being filed must not re-litigate one already judged ---






/**
 * A QUESTION ONE SESSION OWES ANOTHER, SAID IN A FIELD RATHER THAN A SENTENCE.
 *
 * MEASURED OVERNIGHT 2026-09-20: `orchestrator` needed a ruling from `product-manager`, wrote the
 * question as a COMMENT on #914, and nothing in this org reads comments. It asked FIVE TIMES over 6.5
 * hours. `product-manager`'s own reply: "I should have confirmed sooner rather than let five asks go
 * unanswered since 01:55Z." Both behaved correctly; the escalation path simply had no mechanism behind
 * it, so it ran at the speed of someone happening to look.
 *
 * A LABEL AND NOT AN ASSIGNEE, decided by data: `repos/:o/:r/assignees` returns FOUR accounts which the
 * EIGHT sessions share, so an assignee structurally cannot say WHICH session owes the answer.
 */
const owedRow = (n: number, session: string) => ({ number: n,
  labels: [{ name: "backlog" }, { name: `${ANSWER_PREFIX}${session}` }] });








/**
 * #2711: THE NATURAL NEIGHBOUR OF `answerOrders`. That cause wakes the NAMED session to answer; a bare
 * label with nothing posted since gives the addressee no way to tell a real question from a mistake, so
 * this wakes the row's own HOLDER instead, to post the question or remove the label. Live evidence:
 * `worker-2632` added `answer:ceo` to its own PR #2649 twice with no comment either time.
 */
const holderRow = (n: number, holder: string, owed: string) => ({ number: n,
  labels: [{ name: `${SESSION_PREFIX}${holder}` }, { name: `${ANSWER_PREFIX}${owed}` }] });
const timelineOf = (...events: unknown[]) => () => events.map((e) => JSON.stringify(e)).join("\n");









/**
 * `blocked` MUST NAME WHAT IT WAITS ON -- the root cause behind an empty queue, not the pile.
 *
 * THE THREE WHYS, run 2026-09-20 when the chairman asked why nobody was working:
 *   1. the engineer pool had ZERO claimable rows -- 1 of 38 free, and lane-owned
 *   2. the entire remaining supply was ELEVEN rows labelled `blocked`, untouched since 19 Sep
 *   3. nothing re-examines them: `blocked` is filtered out AT READ TIME by `NOT_STARTABLE`, and the
 *      nightly prose check caught 1 of 11 -- TEN WERE INVISIBLE TO EVERY CHECK IN THE SYSTEM
 *
 * The fourth why is where this fix belongs: #1780 added `blockedBy`/`Not-before:` as PREFERRED and left
 * `blocked` legal, unexaminable and unmigrated, so the pile both persisted and regenerated.
 */
const staleBlocked = (n: number, extra: Record<string, unknown> = {}) => ({ number: n, title: `row ${n}`,
  labels: [{ name: "backlog" }, { name: "blocked" }], ...extra });











/**
 * A DECISION NOBODY CAN SEE IS NOT A DECISION -- the fourth instance of one defect.
 *
 *   `fleet-gated`  not the pool's | IS orchestrator's         -- #1770
 *   `blocked`      not startable  | a claim with no referent  -- #1780
 *   `epic`         not pickable   | nobody has FILED it       -- #1784
 *   `decision`     not startable  | SOMEONE OWES A DECISION   -- this
 *
 * MEASURED 2026-09-21: four `decision` rows open, NOT ONE visible to any cause. #1734 ("the gate can
 * only see GitHub objects") had sat unreachable for days while being cited repeatedly as awaiting a
 * ruling. #1817 was filed BY THIS SESSION for `ceo`, carrying `decision` + `lane:ceo` -- a label pair
 * that guaranteed `ceo` would never be told about it.
 */
const decisionRow = (n: number, ...extra: string[]) => ({ number: n, title: `row ${n}`,
  labels: [{ name: "backlog" }, { name: "decision" }, ...extra.map((name) => ({ name }))] });







/**
 * A SESSION GETS ONE ORDER PER TICK, SO EVERY ORDER MUST NAME THE REST OF ITS QUEUE.
 *
 * `wake.ts`'s `deliver` marks a session `working` the moment it is prompted, so a second order in the
 * same tick is refused -- correct, since two prompts cannot be typed into one live terminal. Before
 * 2026-09-20 that cost nothing: this cause emitted ONE order per owner naming up to eight rows, and a
 * session got its whole queue in one prompt.
 *
 * #1799's fix re-keyed per row so a standing judgment stopped being re-litigated when an unrelated row
 * moved. That was right. THE IMPLEMENTATION SERIALISED THE QUEUE: one order per row, one delivered per
 * tick, the rest deduped for two hours each.
 *
 * MEASURED 2026-09-21: `orchestrator` spent the day reasoning correctly about #1768 -- a row that cannot
 * move for TWELVE HOURS -- while #1663, #1042, #914 and #1830 sat with nothing stopping them and ten
 * workers idle. Every answer it gave was sound. It was never told the others existed in the same breath.
 */
const owned = (n: number) => ({ number: n, title: `row ${n}`,
  labels: [{ name: "backlog" }, { name: "lane:ceo" }] });





// --- #1848: an epic whose every child is closed is FINISHED WORK STILL IN THE BACKLOG ------------------
//
// `unfiledEpics` asks `total === 0`. Nothing asked the opposite question, though `subIssuesSummary`
// carries `completed` and the gate has been fetching it since #1784.
//
// MEASURED 2026-09-21, when the chairman asked why nothing was running: 30 open rows, 0 Ready, and
// exactly ONE row an engineer could take. Of 27 backlog rows, 13 were `epic` -- and NINE had every child
// closed (#1317 10/10, #142, #65, #40, #37, #36, #35, #34, #31). #1317 is "Adopt rstest as the test
// runner": ten children, all ten merged. The backlog read 27 deep when it held about four real rows,
// which is how the org ran out of work without anyone noticing.

const doneEpic = (n: number, total = 1) => ({ number: n, title: `epic ${n}`,
  labels: [{ name: "backlog" }, { name: "epic" }], subIssuesSummary: { total, completed: total } });





// --- #4042: a finished epic is raised WHATEVER IS READY ---------------------------------------------------
//
// `finishedEpicOrders` returned [] the moment the Ready shelf held a row, and the epics were not even READ unless it was empty. The board
// showed #2899 at 13 of 13 and still open for three days, and #69 (23 of 23) until the chairman pushed: "the backlog is MISLEADING".
// The summaries below are the REAL shape `gh issue list --json subIssuesSummary` returns for the two (read 2026-10-08).

const REAL_SUMMARY_2899 = { completed: 13, percentCompleted: 100, total: 13 };
const REAL_SUMMARY_69 = { completed: 23, percentCompleted: 100, total: 23 };
const DONE_WHEN_2899 = "## What it is\n\nx\n\n## Done-when\n\n1. The gate raises it.\n2. **A live reading** after it merges.\n\n## Fleet\n\nNo.\n";
const finished2899 = { number: 2899, title: "agent-org moves", labels: [{ name: "epic" }, { name: "out-of-release" }],
  subIssuesSummary: REAL_SUMMARY_2899, body: DONE_WHEN_2899 };
const finished69 = { number: 69, title: "epic 69", labels: [{ name: "epic" }], subIssuesSummary: REAL_SUMMARY_69, body: "no sections here\n" };








// --- #1941: the fleet batch was a state question wearing a clock ------------------------------------
//
// #1830 built a 01:00 UTC timer for the nightly fleet-gated batch. The cadence was inherited, not
// chosen: #914 recorded what a PERSON did late at night, and automating the remembering automated the
// hour with it. Measured 2026-09-22 when the chairman asked why everything waited for 1am -- the firing
// costs 2.2s of CPU and 5s of wall clock, performs no capture, and made the fleet wait up to
// twenty-three hours for a question worth asking the moment a row became gated.
//
// `agent-practices.md` already forbade it: "a cron is right for something that must happen at a
// WALL-CLOCK time regardless of state; it is never right for 'has anything changed yet'."

// The two milestones the batch must read the SAME (#2443): the version-one path, and the one a row filed
// off-path lands on. Literals, because the feeders no longer carry either as a constant.
const ON_PATH = "Road to version one";
const OFF_PATH = "Out of release";

const batchRow = (n: number, milestone: string | null = ON_PATH) => ({
  number: n,
  labels: [{ name: "fleet-gated" }],
  milestone: milestone === null ? null : { title: milestone },
});








test("#1941: the retired timer's units are gone from the shipped host set", () => {
  // The clock is the thing being removed; leaving the unit in `packages/agent-org/host/` would let
  // `host:install` put it straight back, and the org would have both a timer and a gate cause firing the
  // same batch at two different cadences.
  const units = shippedUnits();
  assert.ok(!units.some((u: string) => u.startsWith("a11ign-fleet-gated-nightly")),
    `a11ign-fleet-gated-nightly.* must not ship any more -- found ${units.join(", ")}`);
  assert.ok(units.includes("a11ign-work-tick.timer"), "POSITIVE CONTROL: the tick's own units still ship");
});

// --- #2027: the fleet batch could not see a waiting condition -------------------------------------
//
// The order has told `orchestrator` since #1941 that a row which cannot move yet is an answer -- say so
// with `Fleet-hold-until:`, `--add-blocked-by` or `Not-before:` "and it leaves this set until the
// condition clears". `fleetBatchRows` filtered on the label and the milestone and NOTHING ELSE, so
// writing the condition changed nothing and the only exits were closing the row or removing its label.
//
// MEASURED IN ONE `work:gate` RUN, 2026-09-22T21:57Z: `SHELVED row #1976: blocked by #1918` and a
// fleet-batch order naming #1976, from the same invocation. Eight of that batch's nine rows carried a
// standing, correct condition; exactly one (#1908) was runnable.

const TODAY = "2026-09-23";
const NOW = Date.parse("2026-09-23T12:00:00Z");
const CLOCK = { today: TODAY, nowMs: NOW };

/** A `fleet-gated` row on the milestone, with whatever waiting condition the case is about. */
const gatedRow = (n: number, extra: Record<string, unknown> = {}) => ({
  number: n,
  labels: [{ name: "fleet-gated" }],
  milestone: { title: ON_PATH },
  ...extra,
});

const blockedByOpen = { blockedBy: { nodes: [{ number: 1918, state: "OPEN" }] } };
const blockedByClosed = { blockedBy: { nodes: [{ number: 1918, state: "CLOSED" }] } };











// --- #2027, second half: nothing woke a claim holder when their blocker cleared --------------------
//
// PR #1957 merged 2026-09-22T21:26:01Z and closed #1948 at 21:26:02Z, leaving #1908 -- `in-progress`,
// `session:worker-capture` -- with every blocker closed and six rows queued behind it. The `work:gate`
// run 31 minutes later emitted NO CAUSE FOR `worker-capture` AT ALL: `ready-row-unclaimed` skips a
// claimed row, and no other cause addresses the session that already holds one. `prompt:session` refused
// (`NOT PROMPTED: "worker-capture" is working`) and the refusal was dropped, so the only route that
// worked was `answer:worker-capture` applied by hand -- a label meaning "someone owes you an answer".

const heldRow = (n: number, session: string, extra: Record<string, unknown> = {}) => ({
  number: n,
  labels: [{ name: "in-progress" }, { name: `session:${session}` }],
  ...extra,
});







// --- #2161: the cause must not ask a holder who has already resumed ------------------------------------
//
// #2031 (6m56s past a green draft), #2145 (1m47s) and #2170 (2m24s after APPROVED and in the merge queue)
// were each told to "PICK IT BACK UP" for a row whose holder had built it and opened a pull request. The
// screen asked who HOLDS the row and never whether they had acted, and because this is an ACTION cause the
// twenty-minute expiry re-offers it until `MAX_DELIVERIES` labels a healthy row `needs:chairman`.

/** An open pull request as `readPrs` returns it: only `number` and `body` matter to this screen. */
const openPr = (number: number, body: string) => ({ number, body, isDraft: true, files: [], changedFiles: 0 });


// --- #2493: FILING THE EDGE MUST BE ENOUGH TO WAKE THE OWNER OF A HELD PR ---------------------------------
//
// `ceo`'s ruling (#2400 section 2) rests on `blocker-cleared` addressing the holder of a row whose LAST blocker
// closes. That is pinned above for a holder with no pull request, and the #2161 screen is what stood between it
// and the case that matters here: #2376's owner HAS an open PR (`Closes #2359`), so the screen read them as
// "already resumed" and the wake never came. A HELD pull request is the holder's declaration that they are
// WAITING, so it is not evidence they acted on this clearing.

const heldPrOf = (number: number, body: string, labels: string[]) =>
  ({ ...openPr(number, body), labels: labels.map((name) => ({ name })) });










// --- #2741: `blocker-cleared` backs off THE SAME WAY `unclaimed-blocker-cleared` already does ----------
//
// #1756 is `ceo`'s own claimed, no-PR row: `blockedBy` #1931 and #1959 closed, and the pre-fix causeKey
// (`ceo/blocker-cleared/row-1756/1931.1959`) never changes again once they do. Because this was an ACTION
// cause, `wake`'s twenty-minute expiry re-asked it six times inside `PROMOTION_ASK_WINDOW_MS`'s own first
// two hours and escalated (`answer:ceo`) BEFORE any backoff schedule could ever go quiet. `ceo` answering
// the escalation correctly -- reading the row, confirming nothing changed, removing the label -- is what
// RESET the counter (`fleetWaitingOn` un-shelves on removal) and let the identical cycle restart from
// zero: two full cycles on 2026-09-27 and a third overnight before `ceo` finally silenced #1756 with a
// `Not-before:`, which is an answer this cause never needed reaching for.

const T2741 = Date.parse("2026-09-27T19:00:00Z");
/** #1756's own shape: `ceo` holds it, and both declared blockers closed at `T2741`. */
const row1756 = () => heldRow(1756, "ceo",
  { blockedBy: { nodes: [{ number: 1931, state: "CLOSED" }, { number: 1959, state: "CLOSED" }] } });
const closedAt1756 = new Map([[1931, T2741], [1959, T2741]]);
const FIRST_1756_KEY = "ceo/blocker-cleared/row-1756/1931.1959";







// --- #2780: the CLAIMED-row reader of the `needs:chairman` / `parked` gap ---------------------------
// #2583, #2604 and #2653 taught the three readers that reach an UNCLAIMED row; `blockerClearedOrders` addresses the
// holder of a CLAIMED one and was never taught either. #2623 (`needs:chairman`, still claimed) was asked 19+ times in a day.



// --- #2139, the other half of #2027: nobody was told when an UNCLAIMED row's last blocker closed ----
//
// `blocker-cleared` above is scoped by `labelsOf(row).includes(CLAIM_LABEL)`, and that one condition is
// the gap. A row NOBODY holds reaches no cause at all when its blockers clear: `lane-backlog-unpromoted`
// addresses only a lane OWNER and `ready-queue-empty` fires only when the unlaned Ready pool is EMPTY.
//
// MEASURED 2026-09-23 ON THE LIVE TRACKER. A sweep for open rows whose every declared blocker is CLOSED
// returned SIX -- none claimed, none `ready`, all `lane:any`, every one structurally startable -- and
// they had been stranded 57m, 4h30m, 13h43m, 13h51m, 14h09m and 16h09m with three of five peer sessions
// idle. The Ready queue was NOT empty (four rows), which is exactly why the one cause that would
// eventually have looked stayed silent: a queue with depth and no throughput.

/** An unclaimed backlog row -- the population `blocker-cleared` cannot see, by the one label it lacks. */
const backlogRow = (n: number, extra: Record<string, unknown> = {}) => ({
  number: n,
  title: "a row whose blocker closed",
  labels: [{ name: "backlog" }, { name: "lane:any" }],
  ...extra,
});









// --- #2286: an UNANSWERED promotion order backs off instead of repeating on the two-hour TTL -----------
//
// MEASURED 2026-09-24 (a reading at a moment, from the host wake ledger): 28 of `product-manager`'s 46
// recent deliveries were `unclaimed-blocker-cleared`, and 23 of those were FOUR rows re-asked at an
// unchanged key on `JUDGMENT_TTL_MS`, six times each over ten hours. #2280 found the same thing across
// the whole ledger: 447 of 454 redundant deliveries were this re-ask working as designed.

const HOUR = 60 * 60 * 1000;
const T0 = Date.parse("2026-09-23T22:00:00Z");
/** A backlog row whose blocker #2139 closed at `T0`, and the closing times that say so. */
const clearedRow = (n: number) => backlogRow(n, { blockedBy: { nodes: [{ number: 2139, state: "CLOSED" }] } });
const closedAtT0 = new Map([[2139, T0]]);
const askKeys = (rows: object[], now: number, closings: Map<number, number> | null = closedAtT0) =>
  unclaimedBlockerClearedOrders(rows, TODAY, { closings, now }).map((o) => o.causeKey);
const FIRST_KEY = "product-manager/unclaimed-blocker-cleared/row-2161/2139";










// --- #2110: a row that moved under the session holding it ------------------------------------------
//
// MEASURED TWICE IN ONE MORNING, 2026-09-23. #2099 was claimed by `worker-capture` at 09:54:06Z and
// built by 10:16:50Z; `product-manager` recorded `ceo`'s ruling on it at 10:22:34Z -- 28 minutes after
// the claim, 6 minutes after the work was finished. The gate emitted NO cause for `worker-capture`:
// `ready-row-unclaimed` had stopped matching at the claim, and `blocker-cleared` is the only cause whose
// subject is a row somebody already holds. The same hour, `orchestrator` held #1918 while it acquired an
// open `blockedBy` on #2100 -- the same defect wearing the other marker, and the one a claim-time rule
// (`blocked-by-edge-rule.ts`, #1886) can never reach because the edge arrives AFTER the claim.

const CLAIM_RECORD = { id: "IC_claim", body: "<!-- row-claim: claim record -->\n**Claim record** -- claimed by `worker-capture`." };
const CONSTRAINT = { id: "IC_constraint",
  body: "## CONSTRAINT\n\n`ceo`'s ruling: this row may NOT be implemented by granting a token." };
const BUILD_REPORT = { id: "IC_build", body: "Built as draft #2105. The Acceptance passes at `0da227db0`." };

/** A claimed row, with the comment page `readClaimedRowComments` would have returned for it. */
const withComments = (n: number, comments: { id: string; body: string }[]) => [{ number: n, comments }];




















/**
 * #2003: A DEAD POOL AND A QUIET QUEUE LOOKED IDENTICAL FROM THE JOURNAL.
 *
 * Measured 2026-09-22. `a11ign-ai-workers` reached `used 5000, remaining 0`, and from 20:28:15Z every tick
 * logged the same four lines and woke nobody. The refusal was correct and loud, and still left the only
 * three facts a reader needs unstated: WHICH account, WHICH pool, and WHEN it comes back. `328832207` is a
 * user ID, not a login, and the answer to "for how long" -- 52 minutes -- was in the headers of the call
 * that had just failed.
 *
 * WHY A FIXTURE AND NOT A LIVE CALL: the probe has to be exercised on a DEAD pool, which is the one state
 * a test cannot create. So the fake `run` reproduces what `execFileSync` does when `gh` exits non-zero --
 * it THROWS with the response on `error.stdout` -- because that is the property the whole reading rests on,
 * and a fake that returned the response normally would pass while the real refusal path returned null.
 */
const DEAD_GRAPHQL = [
  "HTTP/2.0 200 OK",
  "X-Ratelimit-Limit: 5000",
  "X-Ratelimit-Remaining: 0",
  "X-Ratelimit-Reset: 1790127611",
  "X-Ratelimit-Resource: graphql",
  "X-Ratelimit-Used: 5000",
  "",
  '{"errors":[{"type":"RATE_LIMITED","message":"API rate limit exceeded for user ID 328832207."}]}',
].join("\r\n");

const LIVE_GRAPHQL = [
  "HTTP/2.0 200 OK",
  "X-Ratelimit-Limit: 5000",
  "X-Ratelimit-Remaining: 3340",
  "X-Ratelimit-Reset: 1790119231",
  "X-Ratelimit-Resource: graphql",
  "X-Ratelimit-Used: 1660",
  "",
  '{"data":{"viewer":{"login":"a11ign-ai-workers"}}}',
].join("\r\n");

/** A `gh` that fails the way `execFileSync` fails: non-zero, with the response still on `stdout`. */
const refusedWith = (stdout: string) => () => {
  throw Object.assign(new Error("gh exited 1"), { status: 1, stdout });
};

/** Records every `gh` invocation, so "how many calls did that cost" is counted rather than reasoned about. */
function recordingRun(reply: (args: string[]) => string) {
  const calls: string[][] = [];
  return {
    calls,
    run: (args: string[]) => { calls.push(args); return reply(args); },
  };
}

// --- #1984: `identity` IS NOW REQUIRED, AND EVERY EXISTING FIXTURE HERE PICKS ONE ON PURPOSE -------------
//
// `cannotAskReport` no longer defaults it (the same reasoning `run` has carried since #1405): a defaulted
// read of `.agent-org/host.json` and a real `hosts.yml` would make these tests depend on whatever THIS
// host happens to have installed. `UNASKED_IDENTITY` is what every test below that is not ABOUT identity
// passes, so `gh-identity-declared.test.ts` -- not this file -- owns proving the real function resolves an
// account on this host.
const UNASKED_IDENTITY = { login: null, source: "test: identity not exercised by this fixture" };

/** A stand-in for what `HERDR_WORKSPACE_ID` routing to the workers config would have declared. */
const DECLARED_WORKERS_IDENTITY = { login: "a11ign-ai-workers", source: "test: declared via HERDR_WORKSPACE_ID" };







// --- #2005: `answer:<session>` HOLDS THE ROW, and does not merely wake the session that owes it ---

/**
 * THE INCIDENT, AT ONE TICK'S OUTPUT, 2026-09-22T20:49:41Z.
 *
 *   20:47Z  `product-manager` puts `answer:ceo` on #2002 (`npm run host:install`) because the ruling it
 *           depends on -- which account the daily board dispatch spends -- was still open.
 *   next    the tick PROMOTES #2002 from `backlog` to `ready` while it carries `answer:ceo`,
 *   tick    then emits `WOKE worker-capture <- engineers/ready-row-unclaimed/2002`.
 *
 * `worker-capture` was one turn from claiming a row whose whole point was that it must not run yet --
 * and running it would have made an unruled decision real on the host.
 *
 * THE GATE ALREADY READ THE LABEL. `GH_READS` names `issue list (all open: answer/blocked labels)` and
 * `answerOrders` was independently waking `ceo` about the same row on the same tick. What no path asked
 * was whether the label STOPS anything -- so `waiting on ceo` and `offer this to anyone` were both true.
 */
const answerRow = (n: number, session: string, extra: string[] = []) =>
  ({ number: n, labels: [{ name: "ready" }, { name: `${ANSWER_PREFIX}${session}` },
    ...extra.map((e) => ({ name: e }))] });








/**
 * #2031: A READY ROW WHOSE WORK IS ALREADY PUSHED WAS STILL OFFERED AS A FRESH START.
 *
 * #2014 bought the interception at CLAIM time, and it says nothing to anyone who never attempts a claim
 * -- the work gate, which is what actually offers rows to the org, was one of those readers. Measured
 * 2026-09-22 on #2000: `agent/worktree-prune-unit-2000` was pushed at 21:02:36Z; the row read `ready`,
 * no `session:`, no `in-progress`, until 21:22Z; `gh pr list --head <branch> --state all` returned `[]`
 * for that whole window. The gate offered #2000 as `ready-row-unclaimed` throughout, because `ready`
 * with no `session:` label was the ENTIRE question it asked, and a second session was routed into the
 * same three Region paths at 21:06Z.
 *
 * THE CAUSE OF THE STALENESS IS WHY THE DETECTION MUST NOT SPEND THE POOL. Opening the pull request is
 * the act that makes a row look claimed, and that act spends GraphQL: #1996's PR was never opened
 * because the shared 5,000-point pool was exhausted until 21:20:11Z. So the board goes stale precisely
 * when the pool is gone, and a detector that spent the pool would be blind in the same outage that
 * produces the defect. `git ls-remote --heads origin` spends none, and the test below pins the BINARY
 * the seam spawns rather than trusting the comment.
 */
const BRANCH_2000 = "agent/worktree-prune-unit-2000";
const SHA_2000 = "1f4e9c7a3b5d8e2016243c5f7a9b0d1e2f3a4b5c";
const LISTING = `${SHA_2000}\trefs/heads/${BRANCH_2000}\n`
  + `9999999999999999999999999999999999999999\trefs/heads/main\n`;
/** A Ready row as `readReadyRows` returns it: `ready`, no `session:`, no `in-progress`. */
const readyRow = (n: number, extra: Record<string, unknown> = {}) =>
  ({ number: n, title: `row ${n}`, labels: [{ name: "ready" }], ...extra });
/** A body stating all three template sections (#2791): a row with a `body` and any of them missing is not stock. */
const COMPLETE_BODY = "## Region\n\nx.mjs\n\n## Acceptance\n\nnpm test\n\n## Open-check\n\nfalse today\n";













/**
 * #2174: THE HOST GOES STALE ON A MERGE AND NOTHING IN THIS ORG FINDS OUT.
 *
 * The shipped units are COPIES, so a merge touching `packages/agent-org/host/` changes the tree and
 * leaves the host as it was. Measured three times in 24 hours; the third had a consequence -- #2144
 * (#1998) merged at 14:04:06Z changing the board unit's `ExecStart`, and eight hours later the service
 * manager still loaded the pre-#1998 program, due to dispatch the 06:10Z board edition from the 31 lines
 * of untracked bash whose whole removal was that PR's deliverable (#2173).
 *
 * THE POSITIVE CONTROL FOR EVERY EMPTINESS ASSERTION BELOW is the first test here -- the same reader over
 * a populated drift list, asserted to produce an order that NAMES the unit. Delete it and the silence
 * tests all pass against a `hostDriftOrders` that returns `[]` for every input, which is the shape this
 * repository keeps re-finding.
 */
const DRIFT_STALE = { unit: "a11ign-board-report.service", problem: "STALE",
  detail: "the installed copy differs from the one in the repository." };
const DRIFT_MISSING = { unit: "a11ign-work-tick.service", problem: "PROGRAM MISSING",
  missingProgram: "/home/agent/repos/a11y-witness/packages/agent-org/src/work-tick.ts",
  detail: "the program it starts is not there." };








/**
 * The test files charged with a `history` requirement, as a RATCHET against the base the change merges into (#3232, `lib/pin-ratchet.ts`). The
 * reason the population is policed stays (a file JOINING it is taxed with `History: full`, #497); what changed is HOW: a file this change ADDS to
 * it is declared below with its reason, so two changes that each add one are each judged against their own base, and a file that leaves passes.
 */
const DECLARED_HISTORY_POPULATION: Declaration[] = [
  { name: "home-checkout-refusal.test.ts", reason: "#3039: imports `host-units.ts` for `hostUnitDrift` and `hostUnitsInstall`, the same edge `host-units.test.ts` has" },
  { name: "host-install-agent-org-launcher.test.ts", reason: "#3532: imports `host-units.ts` for the owned list, the installer and `hostUnitDrift`, the same edge `host-units.test.ts` has; its pull request declares `History: full`" },
  { name: "host-project-paths.test.ts", reason: "#2620: imports `host-units.ts` for the rendered unit texts, the same edge `host-units.test.ts` has; its pull request declares `History: full` (#497)" },
  { name: "host-tool-install.test.ts", reason: "#2793: imports `host-units.ts` for the rendered `work-tick` unit, the same edge; its pull request declares `History: full`" },
  { name: "host-units-event-receiver.test.ts", reason: "#980: imports `host-units.ts` for `shippedUnits` and the installer, the same edge `host-units.test.ts` has; its pull request declares `History: full`" },
  { name: "host-units.test.ts", reason: "tests `host-units.ts`, which calls `git log --all`: the edge every other entry here shares" },
  { name: "persistent-seat-running.test.ts", reason: "#3539: imports `host-units.ts` for `persistentSeatDrift` and the report, the same edge `host-units.test.ts` has; its pull request declares `History: full`" },
  { name: "reviewer-door-install.test.ts", reason: "#3316: imports `host-units.ts` for `hostUnitDrift` and the door install, the same edge `host-units.test.ts` has; its pull request declares `History: full`" },
  { name: "shadow-window-arm.test.ts", reason: "#2867: imports `host-units.ts` for the rendered shadow-window unit texts and the installer, the same edge; declares `History: full`" },
  { name: "work-gate.test.ts", reason: "this very file: it spawns the gate and reads commit history" },
  { name: "work-tick-crash-exit.test.ts", reason: "#3038: imports `host-units.ts` for the rendered `work-tick` unit's ExecStart, the same edge `host-tool-install.test.ts` has" },
];

/**
 * The `*.test.ts` files of `packagingDir` whose import closure derives a `history` requirement.
 * (#3549) ONE MEMO FOR THE SCAN, because every entry walks mostly the same modules: 182 CPU-s for one pass over 190 files was nearly all re-reading
 * and re-parsing text it had already seen, and the test ran two passes. `carried` answers an entry WITHOUT walking it, for the scan of the base.
 */
function historyChargedTests(packagingDir: string, { memo = createClosureMemo(), carried = () => undefined }: {
  memo?: ReturnType<typeof createClosureMemo>, carried?: (file: string) => boolean | undefined } = {}): string[] {
  return readdirSync(packagingDir).filter((f) => f.endsWith(".test.ts"))
    .filter((f) => {
      const known = carried(f);
      if (known !== undefined) return known;
      try {
        return deriveClosureRequirements(join(packagingDir, f), memo)
          .some((r: { requirement: string }) => r.requirement === "history");
      } catch { return false; }
    }).sort();
}

/**
 * The entries of the live tree whose answer the base shares: every file their walk read is outside what this change touched, so the base walk would
 * read the same bytes and say the same thing. `touched` is repository-relative; `null` (a deletion) carries nothing, and the whole base is scanned.
 */
function carriedFromLiveTree({ liveDir, current, memo, touched }: {
  liveDir: string, current: string[], memo: ReturnType<typeof createClosureMemo>, touched: Set<string> | null }): (file: string) => boolean | undefined {
  if (touched === null) return () => undefined;
  const touchedHere = new Set([...touched].map((path) => join(TOOL_ROOT, path)));
  return (file) => {
    const visited = memo.visited.get(join(liveDir, file));
    return visited !== undefined && ![...visited].some((read) => touchedHere.has(read)) ? current.includes(file) : undefined;
  };
}






// --- #2084: GitHub's own review decision, which nothing in this repository read ------------------------

/**
 * #2084: A PULL REQUEST THAT LOOKS EXACTLY LIKE FINISHED WORK, with one field added.
 *
 * `isDraft: false` and green, so it is past `pr-checks-failing`, which needs a red check. It CARRIES A
 * CONVINCED VERDICT AT ITS HEAD (#2176), because since that row a ready pull request with none is a
 * `draft-awaiting-verdict` subject, and these tests are about `reviewDecision`, not about review routing.
 * The `reviewDecision` is the ONLY thing that distinguishes a mergeable pull request from one GitHub is
 * holding, and until #2084 no line of this repository read it.
 */
function ready(n: number, reviewDecision: string | null | undefined, labels: string[] = []) {
  const pr: Record<string, unknown> = { number: n, isDraft: false, isCrossRepository: false, headRefOid: HEAD,
    statusCheckRollup: [{ name: "gate", status: "COMPLETED", conclusion: "SUCCESS" }],
    author: { login: "a11ign-ai-workers" },
    comments: [{ body: `Review of #${n} at \`${HEAD.slice(0, 8)}\`, by \`reviewer\`: convinced.` }],
    labels: labels.map((name) => ({ name })) };
  // `undefined` MEANS THE KEY IS ABSENT, and it has to be absent rather than present-and-undefined:
  // `Object.hasOwn` is what `reviewStateOf` keys on, and a fixture that sets the key to `undefined` would
  // quietly pick a side of the very question under test. `branch-protection.test.ts` makes the same point
  // about `bypass_actors` and parses JSON text to avoid it; here, not writing the key is enough.
  if (reviewDecision !== undefined) pr.reviewDecision = reviewDecision;
  return pr;
}







/**
 * #2283: a labelled pull request in the two states the row routes. `ready()` plus a `session:` label and,
 * for a refusal, the review's own commit -- `reviews[].commit.oid`, the field `readPrs` asks for (#2365).
 */
function labelled(n: number, session: string, decision: string, refusedAt?: string) {
  const pr = ready(n, decision, [`session:${session}`]);
  if (refusedAt !== undefined) pr.reviews = [{ state: "CHANGES_REQUESTED", commit: { oid: refusedAt } }];
  return pr;
}
const blockedOrders = (prs: unknown[]) => reviewBlockedOrders(reviewBlocked(prs, ["gate"]));
const OLD_HEAD = "0ldc0mm1t0000000000000000000000f";











// --- #1959: RETIRED (a11ign#5044 step 2). A pipeline pull request asks ceo for no code-owner review any more --------

const pipelinePr = (n: number, files: string[], extra: Record<string, unknown> = {}) =>
  ({ number: n, files: files.map((path) => ({ path })), changedFiles: files.length,
    author: { login: "a11ign-ai-workers" }, reviews: [], ...extra });







// --- #2209: a pull request that CONFLICTS with `main`, which nothing in this repository could see ---------

/**
 * #2203's own shape: green, unheld, not a draft, approved, armed -- and DIRTY. The two merge fields are the
 * only thing that distinguishes it from a pull request that is merely waiting, and until this row no line
 * of the gate asked for either.
 */
function conflicted(n: number, labels: string[] = ["session:worker-tooling"]) {
  return { ...ready(n, "APPROVED", labels), mergeStateStatus: "DIRTY", mergeable: "CONFLICTING" };
}










// --- #2176: the review question is asked of every green pull request, and keyed on the AUTHORED head ------

const AUTHORED = "a".repeat(40);
const AUTHORED_2 = "d".repeat(40);
const MERGE_UI = "b".repeat(40);
const MERGE_SESSION = "c".repeat(40);
// #3045: a head is the same work as another when its PATCH ID is equal, which `withPatchIds` reads and a fixture states.
const PATCH_A = "1".repeat(64);
const PATCH_B = "2".repeat(64);
const patched = (ids: Record<string, string>) => ({ patchIds: ids });
const verdictAt = (n: number, oid: string, word: string) =>
  ({ body: `Review of #${n} at \`${oid.slice(0, 8)}\`, by \`reviewer\`: ${word}.` });

/** A green, NON-draft pull request -- the shape #2104 had -- with an optional commit chain attached. */
// #1311: a same-repository pull request by a declared worker is INSIDE; the identities are the test's own, not the host's.
const DECLARED = { exact: ["a11ign-ai-workers"], pattern: [] };
// The same identities for every `decide` here, so no test reads the host to learn who the org declares: the logins the drafts below are
// written by. An explicit `identities:` still wins, which is how the #1311 tests pin their own.
const TEST_IDENTITIES = { exact: ["a11ign-ai-workers", "worker-judge", "worker-1", "worker-tooling"], pattern: [] };
const decide = (args: Parameters<typeof decideOnHost>[0]) => decideOnHost({ identities: TEST_IDENTITIES, ...args });
function readyPr(n: number, head: string, extra: Record<string, unknown> = {}) {
  return { number: n, isDraft: false, headRefOid: head, statusCheckRollup: GREEN, isCrossRepository: false,
    author: { login: "a11ign-ai-workers" }, comments: [], labels: [{ name: "session:worker-judge" }], ...extra };
}
const ordersFor = (pr: unknown) => decide({ prs: [pr], readyRows: [], identities: DECLARED }) as
  { cause: string, session: string, causeKey: string, prompt: string }[];











// --- #2365: a convinced verdict that is only a COMMENT ---------------------------------------------------

const approvalAt = (oid: string) => ({ state: "APPROVED", commit: { oid }, author: { login: "a11ign-bot" } });
/** #2337's shape: green, ready, a convinced COMMENT at head, and `reviews` READ and empty. */
const commentOnly = (n = 9999, head = AUTHORED, extra: Record<string, unknown> = {}) =>
  readyPr(n, head, { comments: [verdictAt(n, head, "convinced")], reviews: [], reviewDecision: "REVIEW_REQUIRED", ...extra });
const unreviewed = (pr: unknown) => ordersFor(pr).filter((o) => o.cause === "verdict-comment-unreviewed");









// --- #2202: a merge's close ended the wake on `answer:<session>` and nothing said so ---

const closedOwedRow = (n: number, session: string) => ({ number: n, state: "CLOSED",
  labels: [{ name: `${ANSWER_PREFIX}${session}` }] });






// --- #2609: a closed row's answer:<session> for a session that has ENDED re-queued an order with no addressee every tick ---

const ENDED_AT = Date.parse("2026-09-26T05:00:00Z");
/** Runs `withoutEndedAnswerSessions` over `rows` with `live` workspaces and `ended` evidence; returns the orders and what was said. */
const settleAnswers = (rows: unknown[], live: string[] | null, ended: Record<string, number> | Error) => {
  const said: string[] = [];
  const kept = withoutEndedAnswerSessions(rows, { agents: () => live,
    ended: () => { if (ended instanceof Error) throw ended; return new Map(Object.entries(ended)); },
    say: (line: string) => said.push(line) });
  return { orders: answerOrders(withAnswerLabel(kept)) as { session: string, subject: string }[], said };
};








// --- #3093: ownerOfPr ordered a pull request to the session its LABEL names even when that session had ENDED ---

/** Runs `withPrOwners` over one PR through the same seams `main` wires, with `live` workspaces and `ended` evidence. */
const ownerAfterEndings = (pr: object, live: string[] | null, ended: Record<string, number> | Error, rows: unknown[] = []) => {
  const said: string[] = [];
  const [settled] = withPrOwners([pr], rows, () => null, { agents: () => live,
    ended: () => { if (ended instanceof Error) throw ended; return new Map(Object.entries(ended)); },
    say: (line: string) => said.push(line) });
  return { owner: ownerOfPr(settled), said, settled };
};
const PR_55 = { number: 55, repoKey: "a11ign/agent-org", headRefName: "agent/some-branch", labels: [{ name: "session:worker-3064" }] };








// --- #2492: answer:<session> on a PULL REQUEST woke nobody, because `gh issue list` does not return PRs ---

/** A PR as `readPrs` returns one: `isDraft` and `headRefOid` present, `state` absent (it asks `--state open`). */
const prWithLabels = (n: number, ...names: string[]) => ({ number: n, isDraft: false, isCrossRepository: false, headRefOid: "abc123",
  labels: names.map((name) => ({ name })) });






// --- #2075: `row-off-board` -- an open row with no Project 1 item wakes product-manager ---

const NOW_MS = Date.parse("2026-09-26T12:00:00Z");
const MINUTE_MS = 60_000;

/** One open row's facts as `readRowsOffBoard` reads them; `ageMs` is how long ago it was created. */
function boardFacts(number: number, onBoard: boolean | null, ageMs = 60 * MINUTE_MS) {
  return { number, title: `row ${number}`, createdMs: NOW_MS - ageMs, onBoard };
}

/** One `repository.issues` node as GitHub returns it: the projects an issue is an item of, by number. */
function issueNode(number: number, projects: number[], { createdAt = "2026-09-26T08:00:00Z", totalCount = projects.length } = {}) {
  return { number, title: `row ${number}`, createdAt,
    projectItems: { totalCount, nodes: projects.map((n) => ({ project: { number: n } })) } };
}

/** A `gh` fake serving `pages` in order, recording every argv it was asked. */
function graphqlPages(pages: unknown[]) {
  const calls: string[][] = [];
  const run = (args: string[]) => {
    calls.push(args);
    const page = pages[calls.length - 1];
    if (page === undefined) throw new Error("asked for a page the fake does not have");
    return JSON.stringify(page);
  };
  return { run, calls };
}

const page = (nodes: unknown[], next: string | null = null) => ({ data: { repository: { issues: { nodes,
  pageInfo: { hasNextPage: next !== null, endCursor: next } } } } });










// --- #2791: a Ready row the claim refuses for a template defect is not stock -------------------------------

/**
 * #2729 and #2730 read `ready` for ~38h with no `## Open-check`, and `row-claim` refused both
 * (`NOT CLAIMED: ... is missing Open-check`). The pool counted them, so `ready-queue-empty` never fired and
 * every engineer waited on a queue with nothing takeable. `missingTemplateFields` is the rule the claim
 * applies, imported unchanged -- so the gate and the claim cannot disagree about what is claimable.
 */
const NO_OPEN_CHECK = "## Region\n\nx.mjs\n\n## Acceptance\n\nnpm test\n";
const BACKLOG = [{ number: 800, labels: [{ name: "backlog" }] }];
const shelfCauses = (orders: { cause: string }[]) => orders.map((o) => o.cause).sort();





// ---- #2823: THE REPO-WIDE CLOSES CONDITION IS A GATE CAUSE ----

const CLOSES_NOW = Date.parse("2026-09-30T13:00:00Z");
/** An open PR declaring `Closes #<n+1000>`; `resolved` is what GitHub answered (`null` = the field was not read). */
function closesPr(n: number, resolved: number[] | null, body = `Closes #${n + 1000}`) {
  return { ...draft(n, GREEN), body, createdAt: "2026-09-30T10:00:00Z",
    ...(resolved === null ? {} : { closingIssuesReferences: resolved.map((number) => ({ number })) }) };
}
const FOUR_UNRESOLVED = [closesPr(1, []), closesPr(2, []), closesPr(3, []), closesPr(4, [])];





// THE SWEEP that used to sit here (every refusal that names a session) moved to `refusal-sweep.test.ts` (#2940): this file's
// import closure needs `history`, which the acceptance job lacks, so a test command naming it is refused.

// --- #2781: a primary that is not at origin/main is a signal, not a journal line -----------------------------------------
//
// POSITIVE CONTROL FOR THE EMPTINESS ASSERTIONS BELOW is the first test: the same reader over a dirty, behind primary, asserted
// to name the paths. Without it, every silence test passes against a `primaryStaleOrders` that returns `[]` for everything.
const PRIMARY_DIRTY_BEHIND = { sha: "a5f407d4f0000000", originSha: "9c6ab24630000000", behind: 41, ahead: 0,
  dirty: ["packages/lab/src/capture-screenreader-dataset.mjs", "packages/lab/src/packaging/wake-by-hand.test.ts"] };
const PRIMARY_CURRENT = { sha: "9c6ab24630000000", originSha: "9c6ab24630000000", behind: 0, ahead: 0, dirty: [] };









