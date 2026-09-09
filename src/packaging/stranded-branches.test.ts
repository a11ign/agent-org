/**
 * `scripts/stranded-branches.mjs` finds a pushed branch that has NEVER had a PR of any state and still
 * carries commits `origin/main` lacks -- see that file's own header for the incident
 * (`agent/ssh-key-defaults`, a finished security fix, pushed and invisible for eleven hours) and why the
 * obvious `git rev-list --count` check is defeated by squash merges on the wider population.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, execFileSync as rawExecFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, realpathSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import {
  fetchPushedBranches, fetchAllPRHeadRefs, fetchOpenPRs, branchesWithNoPR, aheadCount, strandedCandidates,
  PR_LIST_LIMIT, PR_PAGE_SIZE, MAX_PR_PAGES, decideForPR, staleClosureComment, sweepPullRequests, prForDecision } from "../../../../scripts/stranded-branches.mjs";
import { sandboxGitEnv } from "../../../../scripts/git-env.mjs";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env: sandboxGitEnv(), encoding: "utf8" });

/**
 * A disposable repo with THREE remote-tracking branches: `agent/no-pr-stranded` (genuinely ahead of main,
 * the shape this tool must catch), `agent/no-pr-empty` (no PR either, but ZERO commits ahead -- not a
 * candidate), and `agent/squash-merged` (represents a branch this repo's own `gh pr list` would report a
 * PR for -- the caller supplies that via the mocked `run`, not from this fixture, since PR state lives on
 * GitHub, not in git).
 */
function buildFixtureRepo() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "a11y-stranded-fixture-")));
  git(root, "init", "--quiet", "-b", "main");
  git(root, "config", "user.email", "t@example.invalid");
  git(root, "config", "user.name", "Fixture");
  writeFileSync(join(root, "base.txt"), "base\n");
  git(root, "add", "base.txt");
  git(root, "commit", "-q", "-m", "base");
  const baseSha = git(root, "rev-parse", "HEAD").trim();

  // Simulate a REMOTE by making a bare clone and adding it as `origin` -- `for-each-ref
  // refs/remotes/origin/*` needs a real remote-tracking namespace, which a purely-local repo does not have.
  const bareRoot = realpathSync(mkdtempSync(join(tmpdir(), "a11y-stranded-bare-")));
  git(bareRoot, "init", "--quiet", "--bare", "-b", "main");
  git(root, "remote", "add", "origin", bareRoot);
  git(root, "push", "-q", "origin", "main");

  const strandedBranch = "agent/no-pr-stranded";
  git(root, "checkout", "-q", "-b", strandedBranch, baseSha);
  writeFileSync(join(root, "stranded.txt"), "genuinely stranded work\n");
  git(root, "add", "stranded.txt");
  git(root, "commit", "-q", "-m", "work nobody proposed");
  git(root, "push", "-q", "origin", strandedBranch);

  const emptyBranch = "agent/no-pr-empty";
  git(root, "checkout", "-q", "-b", emptyBranch, baseSha);
  git(root, "push", "-q", "origin", emptyBranch); // pushed, no PR, but tip === main's tip

  const squashBranch = "agent/squash-merged";
  git(root, "checkout", "-q", "-b", squashBranch, baseSha);
  writeFileSync(join(root, "squashed.txt"), "landed via a real PR, squash-merged\n");
  git(root, "add", "squashed.txt");
  git(root, "commit", "-q", "-m", "will get a PR in the mocked run()");
  git(root, "push", "-q", "origin", squashBranch);

  git(root, "checkout", "-q", "main");
  git(root, "fetch", "-q", "origin");
  return { root, bareRoot, strandedBranch, emptyBranch, squashBranch };
}

function cleanup(root: string, bareRoot: string) {
  rmSync(root, { recursive: true, force: true });
  rmSync(bareRoot, { recursive: true, force: true });
}

// --- fetchPushedBranches: real git, real remote-tracking refs ---

test("fetchPushedBranches lists agent/* and lead/* branches, origin/ prefix stripped, main excluded", () => {
  const { root, bareRoot, strandedBranch, emptyBranch, squashBranch } = buildFixtureRepo();
  try {
    const run = (cmd: string, args: string[]) => rawExecFileSync(cmd, args, { cwd: root, env: sandboxGitEnv(), encoding: "utf8" });
    const branches = fetchPushedBranches({ run });
    assert.deepEqual(branches.sort(), [emptyBranch, squashBranch, strandedBranch].sort());
    assert.ok(!branches.includes("main"), "main itself must never be reported as a pushed feature branch");
  } finally { cleanup(root, bareRoot); }
});

test("MUTATION: git itself failing is a thrown error, never an empty (= nothing-pushed-reading) list", () => {
  const run = () => { throw new Error("git: not a repository"); };
  assert.throws(() => fetchPushedBranches({ run }), /could not list pushed branches/);
});

// --- fetchAllPRHeadRefs: the vacuity guard, mirroring fetchLabels/fetchOpenIssues exactly ---

/** A `run` that serves the given pages in order and records the argv it was asked for. */
function pagedRun(pages: Array<Array<{ ref: string }> | string>) {
  const seen: string[][] = [];
  const run = (_cmd: string, args: string[]) => {
    seen.push(args);
    const page = pages[seen.length - 1] ?? [];
    return typeof page === "string" ? page : JSON.stringify(page);
  };
  return { run, seen };
}
function refPage(n: number, offset = 0) {
  return Array.from({ length: n }, (_, i) => ({ ref: `agent/x${offset + i}` }));
}
function jsonRun(response: string) {
  return () => response;
}
function throwingRun(message: string) {
  return () => { throw new Error(message); };
}

test("fetchAllPRHeadRefs parses a well-formed gh response into a Set", () => {
  const { run } = pagedRun([[{ ref: "agent/x" }, { ref: "lead/y" }]]);
  const { refs, calls, prs } = fetchAllPRHeadRefs({ run });
  assert.ok(refs.has("agent/x"));
  assert.ok(refs.has("lead/y"));
  assert.equal(refs.size, 2);
  assert.equal(calls, 1, "the cost is REPORTED, not inferred by the caller from the count");
  assert.equal(prs, 2);
});

/** Measured live at 402 PRs / 399 refs: reporting the Set's size as a PR count is a real number about
 * the quantity NEXT TO the one named. */
test("ROWS AND REFS ARE DIFFERENT NUMBERS -- a branch reused across two PRs is two rows, one ref", () => {
  const { run } = pagedRun([[{ ref: "agent/x" }, { ref: "agent/x" }, { ref: "lead/y" }]]);
  const { refs, prs } = fetchAllPRHeadRefs({ run });
  assert.equal(prs, 3, "PRs counted as rows");
  assert.equal(refs.size, 2, "head refs collapsed");
});

/**
 * THE REASON THIS FILE CHANGED. The 400-PR cap fired for real on 2026-09-09 at 402 PRs and the audit
 * could not run. A bigger number moves the cliff; walking to the end removes it. The assertion that
 * matters is that a page which comes back FULL is followed by another request — the failure this
 * replaces was precisely a full response read as a complete one.
 */
test("PAGINATES TO THE END: a full page is followed by another request, and a short page ends the walk", () => {
  const { run, seen } = pagedRun([refPage(PR_PAGE_SIZE), refPage(PR_PAGE_SIZE, 100), refPage(2, 200)]);
  const { refs, calls } = fetchAllPRHeadRefs({ run });
  assert.equal(refs.size, 202, "402-PR-shaped walk: two full pages and a short one");
  assert.equal(calls, 3);
  assert.deepEqual(seen.map((args) => args[0]), ["api", "api", "api"],
    "REST (core), never `gh pr list` (GraphQL) -- the listing was the heaviest consumer in an 816-call pass");
  assert.ok(seen.every((args) => /sort=created&direction=asc/.test(args[1] ?? "")),
    "ASCENDING: newest-first paging shifts every later page when a PR is opened mid-walk, so an entry is "
    + "silently seen twice or not at all");
  // `[&]page=` and not `page=`: the bare form matched `per_page=100` first and this assertion read
  // ["100","100","100"] -- the page number checked against its own NEIGHBOUR in the query string.
  assert.deepEqual(seen.map((args) => /[&?]page=(\d+)/.exec(args[1] ?? "")?.[1]), ["1", "2", "3"]);
});

test("CONTROL: an exactly-full LAST page costs one more call and terminates, rather than being guessed at", () => {
  const { run, seen } = pagedRun([refPage(PR_PAGE_SIZE), []]);
  const { refs, calls } = fetchAllPRHeadRefs({ run });
  assert.equal(refs.size, PR_PAGE_SIZE);
  assert.equal(calls, 2, "asking again costs one call and answers definitely; guessing costs the audit");
  assert.equal(seen.length, 2);
});

test("MUTATION (#321, moved not deleted): a walk still receiving full pages at the runaway bound REFUSES", () => {
  const { run } = pagedRun(Array.from({ length: MAX_PR_PAGES + 5 }, (_, i) => refPage(PR_PAGE_SIZE, i * 100)));
  assert.throws(() => fetchAllPRHeadRefs({ run }),
    /still receiving full pages after \d+ of \d+ -- refusing to guess/);
});

test("MUTATION: gh itself failing is a thrown error, never an empty Set -- that would OVER-report every pushed branch as stranded", () => {
  const run = throwingRun("gh: authentication required");
  assert.throws(() => fetchAllPRHeadRefs({ run }), /could not list PRs/);
});

test("MUTATION: a page failing PART WAY THROUGH the walk is refused, never the pages already collected", () => {
  let call = 0;
  const run = () => {
    call += 1;
    if (call === 1) return JSON.stringify(refPage(PR_PAGE_SIZE));
    throw new Error("gh: HTTP 403 rate limit exceeded");
  };
  assert.throws(() => fetchAllPRHeadRefs({ run }), /page 2.*refusing to guess/s,
    "a partial walk is CANNOT-ASK; returning page 1's refs would manufacture stranded branches from "
    + "every PR on the pages never read");
});

test("MUTATION: non-JSON output is a thrown error, never a silent empty Set", () => {
  const run = jsonRun("not json at all");
  assert.throws(() => fetchAllPRHeadRefs({ run }), /was not JSON/);
});

test("MUTATION: a non-array response is refused rather than read as zero PRs", () => {
  const run = jsonRun(JSON.stringify({ not: "an array" }));
  assert.throws(() => fetchAllPRHeadRefs({ run }), /was not an array/);
});

/**
 * The request PROJECTS to `{ref: .head.ref}` rather than to a bare line, so that a PR whose head ref is
 * missing arrives as JSON `null` and can be refused. Projected to lines it would arrive as the four
 * characters `null`, indistinguishable from a branch actually named that.
 */
test("MUTATION: a PR entry with no head ref is refused, not read as a branch named 'null'", () => {
  const run = jsonRun(JSON.stringify([{ ref: null }]));
  assert.throws(() => fetchAllPRHeadRefs({ run }), /entry 0 on page 1 has no head ref/);
});

test("CONTROL: genuinely zero PRs anywhere is accepted as a real, empty Set", () => {
  const run = jsonRun(JSON.stringify([]));
  const { refs, calls } = fetchAllPRHeadRefs({ run });
  assert.equal(refs.size, 0);
  assert.equal(calls, 1);
});

/**
 * #321 AT ITS SECOND CALL SITE. The at-the-cap refusal lived in `fetchAllPRHeadRefs`, and `fetchOpenPRs`
 * — which uses the same constant, and has `--close` behind it — never had one. Moving the all-PRs
 * listing to pagination would have taken the guard out of the file entirely.
 */
test("MUTATION (#321): fetchOpenPRs landing EXACTLY at the limit is refused, not read as 'a lot of open PRs'", () => {
  const atCap = Array.from({ length: PR_LIST_LIMIT }, (_, i) => ({ number: i, headRefName: `agent/x${i}` }));
  const run = jsonRun(JSON.stringify(atCap));
  assert.throws(() => fetchOpenPRs({ run }), /exactly \d+ OPEN PRs.*cannot tell whether/s);
});

test("CONTROL: one open PR short of the limit is a real, trustworthy count -- the guard must not fire early", () => {
  const almost = Array.from({ length: PR_LIST_LIMIT - 1 }, (_, i) => ({ number: i, headRefName: `agent/x${i}` }));
  const run = jsonRun(JSON.stringify(almost));
  assert.equal(fetchOpenPRs({ run }).length, PR_LIST_LIMIT - 1);
});

// --- branchesWithNoPR: pure ---

test("branchesWithNoPR keeps only branches absent from the PR head-ref set", () => {
  const pushed = ["agent/a", "agent/b", "lead/c"];
  const prHeadRefs = new Set(["agent/a"]);
  assert.deepEqual(branchesWithNoPR(pushed, prHeadRefs), ["agent/b", "lead/c"]);
});

test("branchesWithNoPR: a branch with ANY PR state (open, closed, merged) is excluded -- the caller decides which states go into the Set, this function only subtracts", () => {
  const pushed = ["agent/squash-merged"];
  const prHeadRefs = new Set(["agent/squash-merged"]); // caller already included closed/merged PRs
  assert.deepEqual(branchesWithNoPR(pushed, prHeadRefs), []);
});

// --- aheadCount: real git, and this is where the squash-merge trap would resurface if misused ---

test("aheadCount reads real commits ahead of main for a genuinely stranded branch", () => {
  const { root, bareRoot, strandedBranch } = buildFixtureRepo();
  try {
    const run = (cmd: string, args: string[]) => rawExecFileSync(cmd, args, { cwd: root, env: sandboxGitEnv(), encoding: "utf8" });
    assert.equal(aheadCount(strandedBranch, { run }), 1);
  } finally { cleanup(root, bareRoot); }
});

test("aheadCount reads ZERO for a pushed branch whose tip already equals main's", () => {
  const { root, bareRoot, emptyBranch } = buildFixtureRepo();
  try {
    const run = (cmd: string, args: string[]) => rawExecFileSync(cmd, args, { cwd: root, env: sandboxGitEnv(), encoding: "utf8" });
    assert.equal(aheadCount(emptyBranch, { run }), 0);
  } finally { cleanup(root, bareRoot); }
});

test("MUTATION: aheadCount throws rather than guessing when git cannot answer", () => {
  const run = () => { throw new Error("git: unknown revision"); };
  assert.throws(() => aheadCount("agent/does-not-exist", { run }), /could not compute how far/);
});

// --- strandedCandidates: pure, stage 2 of the filter ---

test("strandedCandidates keeps only branches with a POSITIVE ahead-count", () => {
  const noPR = ["agent/stranded", "agent/empty"];
  const counts = new Map([["agent/stranded", 3], ["agent/empty", 0]]);
  assert.deepEqual(strandedCandidates(noPR, counts), [{ branch: "agent/stranded", aheadCount: 3 }]);
});

test("strandedCandidates treats a missing map entry as zero, not as a crash", () => {
  const noPR = ["agent/never-looked-up"];
  const counts = new Map();
  assert.deepEqual(strandedCandidates(noPR, counts), []);
});

// --- THE SQUASH-MERGE TRAP, end to end: the exact defeat this file's header describes ---

test("THE TWO-STAGE FILTER: a squash-merged branch is excluded by stage 1, before stage 2's rev-list-count would have wrongly flagged it", () => {
  const { root, bareRoot, strandedBranch, emptyBranch, squashBranch } = buildFixtureRepo();
  try {
    const run = (cmd: string, args: string[]) => rawExecFileSync(cmd, args, { cwd: root, env: sandboxGitEnv(), encoding: "utf8" });
    const pushed = fetchPushedBranches({ run });
    // The squash-merged branch DID have a PR (closed, in this shape) -- supplied here exactly as
    // fetchAllPRHeadRefs would report it from a real `gh pr list --state all`.
    const prHeadRefs = new Set([squashBranch]);
    const noPR = branchesWithNoPR(pushed, prHeadRefs);
    assert.ok(!noPR.includes(squashBranch), "a branch with a PR of ANY state must never reach stage 2");
    assert.ok(noPR.includes(strandedBranch));
    assert.ok(noPR.includes(emptyBranch));

    const counts = new Map(noPR.map((b) => [b, aheadCount(b, { run })]));
    const candidates = strandedCandidates(noPR, counts);
    assert.deepEqual(candidates.map((c) => c.branch), [strandedBranch],
      "the empty-tip branch and the squash-merged branch must both be absent -- only genuinely ahead, PR-less work is a candidate");
  } finally { cleanup(root, bareRoot); }
});

// --- Live, read-only smoke test against the real repo and the real CLI ---

test("the real CLI runs against the real repo and exits with one of its own three documented codes", () => {
  const scriptPath = new URL("../../../../scripts/stranded-branches.mjs", import.meta.url).pathname;
  let exitCode = 0;
  try {
    execFileSync("node", [scriptPath], { encoding: "utf8" });
  } catch (error) {
    exitCode = (error as { status?: number }).status ?? -1;
  }
  assert.ok([0, 1, 2].includes(exitCode),
    `expected exit 0 (OK), 1 (candidates found) or 2 (could not ask); got ${exitCode}`);
});

/**
 * A PULL REQUEST LIVES FOUR HOURS — B1, and what it REFUSES to close is the substance.
 *
 * Closing a PR is the most destructive action in this toolset, so the tests below are weighted the way
 * the risk is: one for the action, four for the refusals. p90 to merge is 2.5 h and the median is 12
 * minutes; the two PRs closed by hand at 02:00Z had been open ~25 hours at 373 and 392 commits behind,
 * and neither was ever going to merge.
 *
 * **`update-branch` changed what "old" means**, and without that the threshold reads as aggressive: PRs no
 * longer drift unattended, so an old PR is one that is genuinely ABANDONED rather than merely stale.
 */
test("THE BOUNDARY: 3h59m is spared and 4h01m is closed — the row's own mutation", () => {
  const spared = decideForPR({ number: 1, ageHours: 3 + 59 / 60 }, { maxAgeHours: 4 });
  const closed = decideForPR({ number: 2, ageHours: 4 + 1 / 60 }, { maxAgeHours: 4 });
  assert.equal(spared.action, "keep");
  assert.equal(closed.action, "close");
  // The rendering matters AT the boundary, which is exactly where somebody checks whether the sweep was
  // right. `toFixed(1)` rendered both as "4.0h", so a spared PR read "4.0h old, under the 4h line" — a
  // number contradicting its own sentence in the one place it would be read closely.
  assert.match(spared.why, /3h59m/);
  assert.match(closed.why, /4h01m/);
});

test("A DRAFT IS NEVER CLOSED BY THE CLOCK — it was never offered for merge", () => {
  const d = decideForPR({ number: 3, ageHours: 30, isDraft: true }, { maxAgeHours: 4 });
  assert.equal(d.action, "keep");
  assert.match(d.why, /draft/);
});

test("`blocked` OUTRANKS THE CLOCK — a person refused it, and a sweep does not overrule a person", () => {
  const d = decideForPR({ number: 4, ageHours: 30, labels: ["blocked"] }, { maxAgeHours: 4 });
  assert.equal(d.action, "keep", "the auto-arm sweep already skips `blocked` for this reason; a sweep "
    + "that closes must honour it at least as strictly as one that merely arms");
});

test("GREEN AND BEHIND IS THE TRAIN'S, waiting its turn — B3's interaction, decided here", () => {
  // #460 asks for this to be settled in the row rather than discovered at 4h01m. While syncing is
  // serialised a PR can legitimately wait hours through no fault of its own, and closing it would punish
  // it for the queue's latency. B3 is temporary; this rule is not.
  const queued = decideForPR({ number: 5, ageHours: 9, checksGreen: true, behind: 12 }, { maxAgeHours: 4 });
  assert.equal(queued.action, "keep");
  assert.match(queued.why, /waiting its turn/);
  // But RED and behind is not waiting on the train — the train skips red PRs, so nothing is coming for it.
  const abandoned = decideForPR({ number: 6, ageHours: 9, checksGreen: false, behind: 12 }, { maxAgeHours: 4 });
  assert.equal(abandoned.action, "close");
});

test("THE CLOSURE COMMENT SAYS STALE, NAMES THE BRANCH, AND SAYS IT IS KEPT", () => {
  // A sweep that closed AND deleted would have destroyed #172's work, which turned out to be sound and
  // was re-derived from the branch in an hour. "Stale" and "rejected" need different words because the
  // recoveries are opposite: rebuild this, versus do not.
  const comment = staleClosureComment({ number: 7, headRefName: "agent/example-row" }, "9h00m old");
  assert.match(comment, /STALE by the lifetime sweep, not rejected/);
  assert.match(comment, /agent\/example-row/, "the comment must name the branch somebody has to rebuild from");
  assert.match(comment, /is kept/);
  assert.doesNotMatch(comment, /reject(ed|ing) (this|the) work/i);
});

test("THE SWEEP IS DRY BY DEFAULT — closing is a thing somebody types", () => {
  // `corpus-prune-orphans.mjs` (#195) set this shape and it matters more here: a scheduled job that
  // forgot a flag must not close pull requests. Without `--close` this names what it WOULD close and
  // touches nothing.
  const calls: string[][] = [];
  const run = (_cmd: string, args: string[]) => {
    calls.push(args);
    return JSON.stringify([{ number: 9, headRefName: "agent/old", createdAt: "2026-09-08T00:00:00Z",
      isDraft: false, labels: [], mergeStateStatus: "DIRTY" }]);
  };
  const closing = sweepPullRequests({ now: new Date("2026-09-08T10:00:00Z"), run });
  assert.equal(closing.length, 1, "a 10h-old PR nothing is waiting on is past the line");
  assert.equal(calls.length, 1, "dry by default: one `gh pr list`, and no close and no comment");
  assert.ok(!calls.some((a) => a.includes("close")), "nothing may be closed without --close");
});

test("WITH --close IT COMMENTS FIRST, CLOSES SECOND, AND NEVER DELETES THE BRANCH", () => {
  const calls: string[][] = [];
  const run = (_cmd: string, args: string[]) => {
    calls.push(args);
    return JSON.stringify([{ number: 9, headRefName: "agent/old", createdAt: "2026-09-08T00:00:00Z",
      isDraft: false, labels: [], mergeStateStatus: "DIRTY" }]);
  };
  sweepPullRequests({ now: new Date("2026-09-08T10:00:00Z"), close: true, run });
  const verbs = calls.map((a) => a[1]);
  assert.deepEqual(verbs, ["list", "comment", "close"],
    "the comment must land BEFORE the close, or a reader finds a closed PR with no explanation");
  // THE SAFETY PROPERTY IS AN ABSENT FLAG, which is invisible in review unless something asserts it.
  // #172's branch was kept and its work re-derived from it; a sweep that deleted would have destroyed it.
  assert.ok(!calls.some((a) => a.includes("--delete-branch")),
    "the branch must survive: `gh pr close` without --delete-branch is the whole safety property");
});

test("checksGreen is NOT read from statusCheckRollup — that field unions superseded runs", () => {
  // Measured tonight: the rollup reported three PRs as failing whose latest run had succeeded, and two
  // sessions read them as red (#450). A sweep that CLOSES on a wrong red is the worst consumer of it.
  const now = new Date("2026-09-08T10:00:00Z");
  const behind = prForDecision({ number: 1, headRefName: "b", createdAt: "2026-09-08T00:00:00Z",
    isDraft: false, labels: [], mergeStateStatus: "BEHIND" }, now);
  assert.equal(behind.checksGreen, true);
  assert.equal(decideForPR(behind, { maxAgeHours: 4 }).action, "keep");
  const dirty = prForDecision({ number: 2, headRefName: "d", createdAt: "2026-09-08T00:00:00Z",
    isDraft: false, labels: [], mergeStateStatus: "DIRTY" }, now);
  assert.equal(dirty.checksGreen, false, "DIRTY is the PR's own problem; the train will not touch it");
});

/**
 * THE FIXTURE ACCEPTANCE — `ceo`'s ruling, 2026-09-08.
 *
 * A row whose evidence is the live queue proves itself twice: its pure decision runs in the acceptance
 * job against **recorded API output committed beside the test**, and the live run is pasted on the row by
 * the owner with a clock, as evidence rather than as the check.
 *
 * **An `Acceptance:` command may never use `gh`** — the acceptance job runs author-written commands under
 * read-only, tracker-less credentials, always, because granting it a token would hand every PR body one.
 *
 * **And a fixture holds the cases that matter, which a live run cannot promise.** Tonight's queue held two
 * PRs, neither four hours old: a live dry-run could not have exercised a single closure, and would have
 * reported `0 past it` as though that proved something. The fixture carries the boundary a minute either
 * side, a draft, a `blocked` PR, the green-and-behind case decided rather than discovered, and #172's
 * actual shape.
 */
test("THE FIXTURE: every decision, against recorded gh output committed beside this test", () => {
  const fixture = JSON.parse(readFileSync(
    fileURLToPath(new URL("./fixtures/open-prs-lifetime.json", import.meta.url)), "utf8"));
  const now = new Date(fixture._now);
  const decided = new Map<number, ReturnType<typeof decideForPR>>(fixture.prs
    .map((pr: { number: number }) => [pr.number, decideForPR(prForDecision(pr, now), { maxAgeHours: 4 })]));

  // Guard the guard: a fixture that failed to load, or a filter that matched nothing, would make every
  // assertion below vacuous -- and this file's own subject is a sweep that must never act on an empty set.
  assert.equal(decided.size, 8, "the fixture must carry all eight rows");

  assert.equal(decided.get(901)?.action, "keep", "3h59m is under the line");
  assert.equal(decided.get(902)?.action, "close", "4h01m is over it");
  assert.equal(decided.get(903)?.action, "keep", "a 30h draft was never offered for merge");
  assert.equal(decided.get(904)?.action, "keep", "a person labelled it `blocked`; a clock does not overrule that");
  assert.equal(decided.get(905)?.action, "keep", "green and behind is the train's, waiting its turn");
  assert.equal(decided.get(906)?.action, "close", "25h and DIRTY -- nothing is coming for it (#172's shape)");
  // The two RECORDED rows were minutes old when captured, so both are kept. That is not a weak assertion:
  // it is the fixture proving the recorded half is real queue data rather than more constructed rows.
  assert.equal(decided.get(486)?.action, "keep");
  assert.equal(decided.get(485)?.action, "keep");
});

test("the fixture says which rows are RECORDED and which are CONSTRUCTED", () => {
  // A fixture that blurs the two invites a reader to believe a hand-written row is evidence of what the
  // queue does. `_source` is required on every row, and at least one must be real recorded output.
  const fixture = JSON.parse(readFileSync(
    fileURLToPath(new URL("./fixtures/open-prs-lifetime.json", import.meta.url)), "utf8"));
  // CLASSIFIED, not measured by length. The first version required `_source.length > 8` and rejected the
  // literal "recorded" -- exactly eight characters -- so the guard refused precisely the rows it most
  // wants to exist. A length heuristic standing in for a decision is the shape this repository names; the
  // question is which of two kinds a row is, and a constructed one owes a reason.
  for (const pr of fixture.prs) {
    const source = String(pr._source ?? "");
    const classified = source === "recorded"
      || (source.startsWith("constructed") && source.length > "constructed — ".length + 10);
    assert.ok(classified,
      `PR ${pr.number}'s _source is ${JSON.stringify(source)} -- it must be exactly "recorded", or `
      + "\"constructed — <why this case is not in the live queue>\"");
  }
  assert.ok(fixture.prs.some((pr: { _source: string }) => pr._source === "recorded"),
    "at least one row must be real recorded output, or this is a hand-written set wearing a fixture's name");
  assert.match(fixture._recordedAt, /^\d{4}-\d{2}-\d{2}T/, "a recording without a date cannot be aged");
});
