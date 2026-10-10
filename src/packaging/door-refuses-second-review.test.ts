/**
 * a11ign#3050 (from #3033): THE DOOR REFUSES A SECOND REVIEW AT AN EQUAL PATCH, AND AN ENVIRONMENT FAILURE OFFERED AS A VERDICT.
 *
 * #3033 took six reviews for ONE authored commit: three APPROVALS at one head, after two refusals at a head that differed from it by a
 * merge of `main`. The door (`pr-review-verdict.sh`) is the one narrow place every review passes, so it is the one place a rule can be a
 * refusal and not a sentence in a brief.
 *
 * NO CAPABILITY DECLARATION: nothing here reaches the network. `gh` is a shell stub first on `PATH`, answering from files in a temporary
 * directory and logging its argv, so the door's own `gh api` / `gh pr review` calls never reach the real client. `git patch-id` is real:
 * the equality under test is git's, so the fixtures below are real unified diffs.
 *
 * THE CONTROLS ARE THE POINT. A door that refuses everything passes every refusal case, and one that refuses nothing passes every posting
 * case, so each refusal has a posting case beside it that differs by exactly one fact (the patch, the state, the word).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { refusalLifted, verdictAmong } from "../review-verdict.ts";

const DOOR = fileURLToPath(new URL("../reviewer/pr-review-verdict.sh", import.meta.url));

const EXIT_MALFORMED = 2;
const EXIT_SECOND_REVIEW = 3;
const EXIT_UNDETERMINED = 4;

/** The #3033 shape: the reviewed commit, then the same change after `main` was merged in, then different work. */
const FIRST = "f3879426aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const AFTER_MERGE_OF_MAIN = "c7764afbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const NEW_WORK = "9d41e0cccccccccccccccccccccccccccccccccc";
/** A third commit whose patch equals FIRST's (another merge of `main`), for a refusal that follows the lifted one. */
const NEW_WORK_EQUAL = "5a5a5adddddddddddddddddddddddddddddddddd";

/** A real diff. `index` and the hunk's line numbers are what a merge of `main` moves; the patch is what it leaves. */
const diffOf = ({ hunkStart, index, added }: { hunkStart: number; index: string; added: string[] }): string =>
  [
    "diff --git a/src/x.mjs b/src/x.mjs",
    `index ${index} 100644`,
    "--- a/src/x.mjs",
    "+++ b/src/x.mjs",
    `@@ -${hunkStart},3 +${hunkStart},${3 + added.length} @@`,
    " one",
    ...added.map((line) => `+${line}`),
    " three",
    " four",
    "",
  ].join("\n");

const DIFFS: Record<string, string> = {
  [FIRST]: diffOf({ hunkStart: 1, index: "1111111..2222222", added: ["two"] }),
  [AFTER_MERGE_OF_MAIN]: diffOf({ hunkStart: 41, index: "aaaaaaa..bbbbbbb", added: ["two"] }),
  [NEW_WORK]: diffOf({ hunkStart: 1, index: "1111111..3333333", added: ["two", "five"] }),
  [NEW_WORK_EQUAL]: diffOf({ hunkStart: 77, index: "ccccccc..ddddddd", added: ["two"] }),
};

/** The verdict line, naming the commit it was written at (a11ign/agent-org#3640: the door compares that sha with the head, so a fixture must name one). */
const openerAt = (commit: string): string => `**Review of #7 at \`${commit.slice(0, 8)}\`, by reviewer-7: convinced (CI run 41)**`;

/** The account every door-posted review comes from, and so the one whose LATEST review GitHub reads for `reviewDecision`. */
const BOT = "a11ign-bot";

/** A code owner's hand-written approval of one path (agent-org#66): a review, but not one that opens as a verdict. */
const SCOPED_APPROVAL = "ceo, as code owner of `.github/`: **approved for the workflow change only**. I did not review `src/`.";

interface Review { when: string; state: string; commit: string; body: string | null; user?: string; id?: number }
/** A review the door could have posted, unless `body` says otherwise: its body opens with the verdict line. */
const reviewAt = (commit: string, state: string, when: string, body: string | null = `${openerAt(commit)}\n\nbody`): Review =>
  ({ commit, state, when, body });

interface Run { status: number | null; calls: string[]; stderr: string }
interface Scenario {
  head: string;
  reviews?: Review[];
  verdict?: "convinced" | "not-convinced";
  opener?: string;
  /** A `gh` read that fails, named by what it was reading. */
  failing?: "reviews" | "compare" | "checks" | "user";
  /** The account the door posts as, which `gh api user` answers (agent-org#514). Default: the one every door-posted review comes from. */
  account?: string;
  /** What follows the verdict line in the verdict file; a superseding verdict names the review it supersedes here (agent-org#514). */
  body?: string;
  /** The check runs that concluded `failure`, by commit (a11ign#3199). A commit absent here has only a passing check run. */
  failedChecks?: Record<string, string[]>;
}

/** The door's `gh` calls that WRITE. Everything else it asks is a read. */
const posted = (calls: string[]): string[] => calls.filter((c) => c.startsWith("pr review"));

function runDoor(scenario: Scenario): Run {
  const dir = mkdtempSync(join(tmpdir(), "door-second-"));
  try {
    const opener = scenario.opener ?? openerAt(scenario.head);
    writeFileSync(join(dir, "verdict.md"), `${opener}\n\n${scenario.body ?? "body"}\n`);
    writeFileSync(join(dir, "pr.json"), JSON.stringify({ head: { sha: scenario.head }, base: { ref: "main" } }));
    writeFileSync(join(dir, "user.json"), JSON.stringify({ login: scenario.account ?? BOT }));
    writeFileSync(join(dir, "reviews.json"), JSON.stringify((scenario.reviews ?? []).map((r, i) => ({
      id: r.id ?? 1000 + i, submitted_at: r.when, state: r.state, commit_id: r.commit, html_url: `https://example/pull/7#review-${r.when}`, body: r.body, user: { login: r.user ?? BOT } }))));
    for (const [sha, diff] of Object.entries(DIFFS)) writeFileSync(join(dir, `diff-${sha}`), diff);
    if (scenario.failing === "reviews") writeFileSync(join(dir, "fail-reviews"), "");
    if (scenario.failing === "compare") writeFileSync(join(dir, "fail-compare"), "");
    if (scenario.failing === "checks") writeFileSync(join(dir, "fail-checks"), "");
    if (scenario.failing === "user") writeFileSync(join(dir, "fail-user"), "");
    // A passing run beside the failing ones, so the door's own `select(.conclusion == "failure")` is what picks them out.
    for (const sha of Object.keys(DIFFS)) {
      const runs = [{ name: "lint", conclusion: "success" }, ...(scenario.failedChecks?.[sha] ?? []).map((name) => ({ name, conclusion: "failure" }))];
      writeFileSync(join(dir, `checks-${sha}`), JSON.stringify({ check_runs: runs }));
    }
    // ONE LOG LINE PER CALL, argv joined. A read answers by running the door's OWN `--jq` over the API-shaped JSON in the directory, as
    // `gh` does, so the door's `select` and `@tsv` are what is under test and not a stub that returns the answer. The read-back is that
    // list plus the review the door just sent, so the attribution is reached and a posted review is a full run.
    writeFileSync(join(dir, "gh"), `#!/usr/bin/env bash
D="${dir}"
a="$*"; printf '%s\\n' "\${a//$'\\n'/ }" >> "$D/log"
jq_arg=""; prev=""
for x in "$@"; do [[ "$prev" == --jq ]] && jq_arg="$x"; prev="$x"; done
case "$a" in
  "pr review"*|*"--method POST"*) exit 0 ;;
  "api user"*) [[ ! -f "$D/fail-user" ]] || exit 1; jq -r "$jq_arg" "$D/user.json" ;;
  *"/check-runs"*) [[ ! -f "$D/fail-checks" ]] || exit 1
    sha="\${a#*commits/}"; sha="\${sha%%/*}"; f=("$D"/checks-"$sha"*); jq -r "$jq_arg" "\${f[0]}" ;;
  *"/compare/"*) [[ ! -f "$D/fail-compare" ]] || exit 1
    sha="\${a##*...}"; sha="\${sha%% *}"; f=("$D"/diff-"$sha"*); cat "\${f[0]}" ;;
  *"/pulls/7/reviews?"*"select("*) [[ ! -f "$D/fail-reviews" ]] || exit 1; jq -r "$jq_arg" "$D/reviews.json" ;;
  *"/pulls/7/reviews?"*) jq --rawfile b "$D/verdict.md" '. + [{html_url: "https://example/review/1", commit_id: "deadbeef", body: ($b | rtrimstr("\\n"))}]' \\
    "$D/reviews.json" | jq -r "$jq_arg" ;;
  *"/pulls/7 "*) jq -r "$jq_arg" "$D/pr.json" ;;
esac
`, { mode: 0o755 });
    const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${dir}:${process.env.PATH}`, A11Y_REVIEWER_SESSION: "reviewer-7" };
    delete env.GH_REPO;
    const run = spawnSync("bash", [DOOR, "7", scenario.verdict ?? "convinced", join(dir, "verdict.md")], { env, encoding: "utf8" });
    const log = join(dir, "log");
    return { status: run.status, calls: existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : [], stderr: run.stderr };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// An abbreviated sha resolves in the stub as it does in `gh`, since the door now reads the commit a body names (a11ign/agent-org#3640).
// --- done-when 1 and 2: a second review at an equal patch -----------------------------------------------------------------------

test("2(a) the #3033 shape: reviews at f3879426 and c7764afb, whose commits differ only by a merge of main, refuse the next review", () => {
  const { status, calls, stderr } = runDoor({
    head: AFTER_MERGE_OF_MAIN,
    reviews: [
      reviewAt(FIRST, "CHANGES_REQUESTED", "2026-10-02T17:48:57Z"),
      reviewAt(FIRST, "CHANGES_REQUESTED", "2026-10-02T17:56:26Z"),
      reviewAt(AFTER_MERGE_OF_MAIN, "APPROVED", "2026-10-02T18:12:56Z"),
    ],
  });
  assert.equal(status, EXIT_SECOND_REVIEW, stderr);
  assert.deepEqual(posted(calls), [], "NOTHING was posted");
  assert.deepEqual(calls.filter((c) => c.includes("/statuses/")), [], "and nothing was attributed");
});

test("1: the refusal names which review stands, its time and its state", () => {
  const { stderr } = runDoor({
    head: AFTER_MERGE_OF_MAIN,
    reviews: [reviewAt(AFTER_MERGE_OF_MAIN, "APPROVED", "2026-10-02T18:12:56Z"), reviewAt(AFTER_MERGE_OF_MAIN, "APPROVED", "2026-10-02T18:22:44Z")],
  });
  assert.match(stderr, /APPROVED at 2026-10-02T18:22:44Z/, "the NEWEST one is named");
  assert.match(stderr, /https:\/\/example\/pull\/7#review-2026-10-02T18:22:44Z/);
  assert.match(stderr, /escalate to product-manager/);
});

test("2(a) alone: an EARLIER commit with an equal patch is enough, with no review at the head's own commit", () => {
  const { status, calls } = runDoor({ head: AFTER_MERGE_OF_MAIN, reviews: [reviewAt(FIRST, "CHANGES_REQUESTED", "2026-10-02T17:48:57Z")] });
  assert.equal(status, EXIT_SECOND_REVIEW);
  assert.equal(calls.filter((c) => c.includes("/compare/")).length, 2, "the head's diff and the review's, both from the compare API");
  assert.deepEqual(posted(calls), []);
});

test("1: a CHANGED verdict is refused as a repeated one is", () => {
  const reviews = [reviewAt(FIRST, "APPROVED", "2026-10-02T18:12:56Z")];
  for (const verdict of ["convinced", "not-convinced"] as const) {
    const { status, calls } = runDoor({ head: AFTER_MERGE_OF_MAIN, reviews, verdict });
    assert.equal(status, EXIT_SECOND_REVIEW, verdict);
    assert.deepEqual(posted(calls), [], verdict);
  }
});

test("1: the code is not `0` and not the `2` of a malformed call", () => {
  assert.notEqual(EXIT_SECOND_REVIEW, 0);
  assert.notEqual(EXIT_SECOND_REVIEW, EXIT_MALFORMED);
  assert.notEqual(EXIT_UNDETERMINED, EXIT_SECOND_REVIEW, "and could-not-tell is its own answer");
});

test("2(b) CONTROL: a review at an older head whose patch DIFFERS from the current head's posts normally", () => {
  const { status, calls, stderr } = runDoor({ head: NEW_WORK, reviews: [reviewAt(FIRST, "CHANGES_REQUESTED", "2026-10-02T17:48:57Z")] });
  assert.equal(status, 0, stderr);
  assert.equal(posted(calls).length, 1, "the author pushed work, so this is a first review of it");
  assert.match(posted(calls)[0], /--approve/);
});

test("2(c) CONTROL: a pull request with no review yet posts normally", () => {
  const { status, calls, stderr } = runDoor({ head: AFTER_MERGE_OF_MAIN });
  assert.equal(status, 0, stderr);
  assert.equal(posted(calls).length, 1);
  assert.equal(calls.filter((c) => c.includes("/compare/")).length, 0, "nothing to compare, so nothing was fetched");
});

test("only the states the door posts stand: a DISMISSED or COMMENTED review at an equal patch does not refuse", () => {
  for (const state of ["DISMISSED", "COMMENTED"]) {
    const { status, calls } = runDoor({ head: AFTER_MERGE_OF_MAIN, reviews: [reviewAt(AFTER_MERGE_OF_MAIN, state, "2026-10-02T18:12:56Z")] });
    // The stub returns every row it was given: the door's own `select` is what has to drop it, so this fails if the select is dropped.
    assert.equal(status, 0, state);
    assert.equal(posted(calls).length, 1, state);
  }
});

test("a read that fails is COULD-NOT-TELL, not `no review`: nothing is posted and the code is its own", () => {
  for (const failing of ["reviews", "compare"] as const) {
    const { status, calls, stderr } = runDoor({
      head: AFTER_MERGE_OF_MAIN,
      reviews: [reviewAt(FIRST, "CHANGES_REQUESTED", "2026-10-02T17:48:57Z")],
      failing,
    });
    assert.equal(status, EXIT_UNDETERMINED, failing);
    assert.deepEqual(posted(calls), [], failing);
    assert.match(stderr, /could not tell whether #7 already has a review/, failing);
  }
});

// --- a11ign#3199: A REFUSAL POSTED FOR A FAILING CHECK DOES NOT BAR A NEWER REVIEW ONCE THE CHECK IS GREEN AT AN EQUAL PATCH --------------
//
// #3154's shape: CHANGES_REQUESTED at FIRST (four check runs failed there, one a defect in `main`), then the same patch at AFTER_MERGE_OF_MAIN
// with nothing failing. Each refusal below differs from this allowed case by exactly ONE fact.

const READ_CHECKS = (calls: string[]) => calls.filter((c) => c.includes("/check-runs"));
const REFUSED_AT_FIRST = [reviewAt(FIRST, "CHANGES_REQUESTED", "2026-10-03T10:02:16Z")];
const RED_AT_FIRST = { [FIRST]: ["ts / run", "gate"] };

test("3199 (1)(a) POSITIVE: a CHANGES_REQUESTED at an older commit, equal patch, a failing check there and none at the head, posts either verdict", () => {
  for (const verdict of ["convinced", "not-convinced"] as const) {
    const { status, calls, stderr } = runDoor({ head: AFTER_MERGE_OF_MAIN, reviews: REFUSED_AT_FIRST, failedChecks: RED_AT_FIRST, verdict });
    assert.equal(status, 0, `${verdict}: ${stderr}`);
    assert.equal(posted(calls).length, 1, verdict);
    assert.match(posted(calls)[0], verdict === "convinced" ? /--approve/ : /--request-changes/);
    assert.equal(calls.filter((c) => c.includes("/compare/")).length, 2, "the case IS in the equal-patch population: both diffs were compared and equal");
  }
});

test("3199 (3) no human dismissal is in the path: the door posts the approval and never calls a `dismissals` endpoint", () => {
  const { status, calls, stderr } = runDoor({ head: AFTER_MERGE_OF_MAIN, reviews: REFUSED_AT_FIRST, failedChecks: RED_AT_FIRST });
  assert.equal(status, 0, stderr);
  assert.match(posted(calls)[0], /--approve/);
  assert.deepEqual(calls.filter((c) => /dismissals/.test(c)), [], "no review was dismissed by anyone");
});

test("3199 (5b) NEGATIVE: the older commit's checks were all green (the #3033 shape) is refused", () => {
  const { status, calls, stderr } = runDoor({ head: AFTER_MERGE_OF_MAIN, reviews: REFUSED_AT_FIRST, failedChecks: {} });
  assert.equal(status, EXIT_SECOND_REVIEW, stderr);
  assert.deepEqual(posted(calls), []);
});

test("3199 (5c) NEGATIVE: the head still fails a check is refused", () => {
  const { status, calls, stderr } = runDoor({ head: AFTER_MERGE_OF_MAIN, reviews: REFUSED_AT_FIRST,
    failedChecks: { ...RED_AT_FIRST, [AFTER_MERGE_OF_MAIN]: ["ts / run"] } });
  assert.equal(status, EXIT_SECOND_REVIEW, stderr);
  assert.deepEqual(posted(calls), []);
});

test("3199 (5d) NEGATIVE: the earlier verdict was APPROVED, however red the older commit, is refused", () => {
  const { status, calls, stderr } = runDoor({ head: AFTER_MERGE_OF_MAIN, reviews: [reviewAt(FIRST, "APPROVED", "2026-10-03T10:02:16Z")], failedChecks: RED_AT_FIRST });
  assert.equal(status, EXIT_SECOND_REVIEW, stderr);
  assert.deepEqual(posted(calls), []);
  assert.deepEqual(READ_CHECKS(calls), [], "an approval is refused without reading a check: nothing could lift it");
});

test("3199 (5e) NEGATIVE: a check-runs read that fails is COULD-NOT-TELL, exit 4, and nothing is posted", () => {
  const { status, calls, stderr } = runDoor({ head: AFTER_MERGE_OF_MAIN, reviews: REFUSED_AT_FIRST, failedChecks: RED_AT_FIRST, failing: "checks" });
  assert.equal(status, EXIT_UNDETERMINED, stderr);
  assert.deepEqual(posted(calls), []);
  assert.match(stderr, /could not tell whether #7 already has a review/);
});

test("3199 (5) a refusal that is lifted does not hide a LATER review at the same patch: a newer CHANGES_REQUESTED at an all-green commit still refuses", () => {
  const { status, calls } = runDoor({
    head: AFTER_MERGE_OF_MAIN,
    reviews: [...REFUSED_AT_FIRST, reviewAt(NEW_WORK_EQUAL, "CHANGES_REQUESTED", "2026-10-03T10:30:00Z")],
    failedChecks: RED_AT_FIRST,
  });
  assert.equal(status, EXIT_SECOND_REVIEW);
  assert.deepEqual(posted(calls), []);
});

test("3199 (4) cost: the common path adds no call, and the equal-patch path reads one run list per commit compared", () => {
  assert.deepEqual(READ_CHECKS(runDoor({ head: AFTER_MERGE_OF_MAIN }).calls), [], "no review at all");
  assert.deepEqual(READ_CHECKS(runDoor({ head: NEW_WORK, reviews: REFUSED_AT_FIRST, failedChecks: RED_AT_FIRST }).calls), [],
    "a review at a DIFFERENT patch: no equal-patch refusal, so no check read");
  assert.deepEqual(READ_CHECKS(runDoor({ head: AFTER_MERGE_OF_MAIN, reviews: [reviewAt(AFTER_MERGE_OF_MAIN, "CHANGES_REQUESTED", "2026-10-03T10:02:16Z")] }).calls), [],
    "a refusal AT the head itself: same commit, same checks, nothing to compare");
  const lifted = READ_CHECKS(runDoor({ head: AFTER_MERGE_OF_MAIN, reviews: REFUSED_AT_FIRST, failedChecks: RED_AT_FIRST }).calls);
  assert.equal(lifted.length, 2, "the refused commit, then the head");
  // The refused commit is read at the sha its body names (8 characters, #3640); the head at the full sha the pull request reports.
  assert.ok(lifted[0].includes(FIRST.slice(0, 8)) && lifted[1].includes(AFTER_MERGE_OF_MAIN), lifted.join("\n"));
  assert.equal(READ_CHECKS(runDoor({ head: AFTER_MERGE_OF_MAIN, reviews: REFUSED_AT_FIRST, failedChecks: {} }).calls).length, 1,
    "an all-green refused commit is the #3033 shape: the head is not read");
  const twice = READ_CHECKS(runDoor({ head: AFTER_MERGE_OF_MAIN, failedChecks: RED_AT_FIRST,
    reviews: [...REFUSED_AT_FIRST, reviewAt(FIRST, "CHANGES_REQUESTED", "2026-10-03T10:10:00Z")] }).calls);
  assert.equal(twice.length, 2, "two refusals at ONE commit are one commit compared");
});

test("3199 the door and the gate share ONE decider: every case of the table gets the same answer from `refusalLifted` and from the door", () => {
  const table: { name: string; state: string; failingThen: string[]; failingNow: string[] }[] = [
    { name: "#3154", state: "CHANGES_REQUESTED", failingThen: ["ts / run", "gate"], failingNow: [] },
    { name: "#3033, all green", state: "CHANGES_REQUESTED", failingThen: [], failingNow: [] },
    { name: "head still failing", state: "CHANGES_REQUESTED", failingThen: ["ts / run"], failingNow: ["ts / run"] },
    { name: "an approval", state: "APPROVED", failingThen: ["ts / run"], failingNow: [] },
  ];
  const outcomes = table.map(({ name, state, failingThen, failingNow }) => {
    const { status } = runDoor({ head: AFTER_MERGE_OF_MAIN, reviews: [reviewAt(FIRST, state, "2026-10-03T10:02:16Z")],
      failedChecks: { [FIRST]: failingThen, [AFTER_MERGE_OF_MAIN]: failingNow } });
    const lifted = refusalLifted({ refused: state === "CHANGES_REQUESTED", failingThen, failingNow });
    assert.equal(status === 0, lifted, `${name}: the door ${status === 0 ? "posts" : "refuses"} and the decider says lifted=${lifted}`);
    return lifted;
  });
  assert.deepEqual(outcomes, [true, false, false, false], "the positive control occurs in its own population, and each negative is its own fact");
  assert.equal(refusalLifted({ refused: true, failingThen: null, failingNow: [] }), false, "an unread refused commit is not a green one");
  assert.equal(refusalLifted({ refused: true, failingThen: ["x"], failingNow: undefined }), false, "an unread head is not a green one");
});

// --- a11ign#3087: a review counts only when it opens as a verdict ---------------------------------------------------------------

test("3087: a code owner's scoped APPROVED at the head, which does not open as a verdict, lets the door post", () => {
  const { status, calls, stderr } = runDoor({
    head: AFTER_MERGE_OF_MAIN,
    reviews: [reviewAt(AFTER_MERGE_OF_MAIN, "APPROVED", "2026-10-02T21:57:19Z", SCOPED_APPROVAL)],
  });
  assert.equal(status, 0, stderr);
  assert.equal(posted(calls).length, 1, "the reviewer's verdict was posted once");
  assert.match(posted(calls)[0], /--approve/);
});

test("3087: the same with CHANGES_REQUESTED, and with an empty or absent body", () => {
  for (const [state, body] of [["CHANGES_REQUESTED", SCOPED_APPROVAL], ["APPROVED", ""], ["APPROVED", null]] as const) {
    const { status, calls, stderr } = runDoor({ head: AFTER_MERGE_OF_MAIN, reviews: [reviewAt(AFTER_MERGE_OF_MAIN, state, "2026-10-02T21:57:19Z", body)] });
    assert.equal(status, 0, `${state} ${JSON.stringify(body)}: ${stderr}`);
    assert.equal(posted(calls).length, 1, state);
  }
});

test("3087 CONTROL: a scoped approval beside a verdict-opening one at the head still refuses, and names the verdict", () => {
  const { status, calls, stderr } = runDoor({
    head: AFTER_MERGE_OF_MAIN,
    reviews: [
      reviewAt(AFTER_MERGE_OF_MAIN, "APPROVED", "2026-10-02T18:00:00Z"),
      reviewAt(AFTER_MERGE_OF_MAIN, "APPROVED", "2026-10-02T21:57:19Z", SCOPED_APPROVAL),
    ],
  });
  assert.equal(status, EXIT_SECOND_REVIEW, stderr);
  assert.match(stderr, /APPROVED at 2026-10-02T18:00:00Z/, "the verdict stands, not the newer scoped approval");
  assert.deepEqual(posted(calls), []);
});

test("3087 CONTROL: an opener naming ANOTHER pull request is not this one's verdict", () => {
  const other = "**Review of #8 at `c7764afb`, by reviewer-8: convinced (CI run 41)**";
  const { status } = runDoor({ head: AFTER_MERGE_OF_MAIN, reviews: [reviewAt(AFTER_MERGE_OF_MAIN, "APPROVED", "2026-10-02T18:00:00Z", other)] });
  assert.equal(status, 0);
});

test("3087 CONTROL: a verdict-opening review at a DIFFERENT commit with an equal patch still refuses, though a scoped approval stands at the head", () => {
  const { status, calls } = runDoor({
    head: AFTER_MERGE_OF_MAIN,
    reviews: [
      reviewAt(FIRST, "CHANGES_REQUESTED", "2026-10-02T17:48:57Z"),
      reviewAt(AFTER_MERGE_OF_MAIN, "APPROVED", "2026-10-02T21:57:19Z", SCOPED_APPROVAL),
    ],
  });
  assert.equal(status, EXIT_SECOND_REVIEW);
  assert.deepEqual(posted(calls), []);
});

test("3087 CONTROL: a failing read is still exit 4 when the only review is a scoped approval", () => {
  const { status } = runDoor({ head: AFTER_MERGE_OF_MAIN, reviews: [reviewAt(FIRST, "APPROVED", "2026-10-02T21:57:19Z", SCOPED_APPROVAL)], failing: "reviews" });
  assert.equal(status, EXIT_UNDETERMINED);
});

// --- done-when 3: an environment failure is not a verdict -----------------------------------------------------------------------

const ENVIRONMENT_REFUSAL = "**Review of #7 at `c7764afb`, by reviewer-7: not convinced (environment)**";

test("3: a not-convinced whose first line names (environment) is refused before ANY gh call, exit 2", () => {
  const { status, calls, stderr } = runDoor({ head: AFTER_MERGE_OF_MAIN, verdict: "not-convinced", opener: ENVIRONMENT_REFUSAL });
  assert.equal(status, EXIT_MALFORMED);
  assert.deepEqual(calls, [], "not one `gh` call, not even a read");
  assert.match(stderr, /an environment failure is not a verdict: hand the row to orchestrator/);
});

test("3 CONTROL: the same text under `convinced` is not refused for the word", () => {
  const opener = "**Review of #7 at `c7764afb`, by reviewer-7: convinced (environment)**";
  const { status, calls, stderr } = runDoor({ head: AFTER_MERGE_OF_MAIN, verdict: "convinced", opener });
  assert.equal(status, 0, stderr);
  assert.equal(posted(calls).length, 1);
});

test("3 CONTROL: `convinced` with (CI run <id>) is unchanged, and a not-convinced that does not say (environment) posts", () => {
  assert.equal(runDoor({ head: AFTER_MERGE_OF_MAIN }).status, 0);
  const real = "**Review of #7 at `c7764afb`, by reviewer-7: not convinced (CI run 41)**";
  const { status, calls } = runDoor({ head: AFTER_MERGE_OF_MAIN, verdict: "not-convinced", opener: real });
  assert.equal(status, 0);
  assert.match(posted(calls)[0], /--request-changes/);
});

test("3: the first line only: (environment) in the BODY is not the opener's", () => {
  // `runDoor` writes `body` after the opener; a verdict that quotes the word further down is still a verdict.
  const { status } = runDoor({ head: AFTER_MERGE_OF_MAIN, verdict: "not-convinced",
    opener: "**Review of #7 at `c7764afb`, by reviewer-7: not convinced (CI run 41)**\n\nThe (environment) was fine." });
  assert.equal(status, 0);
});

// --- a11ign#4029 (from #4017): an APPROVED review the same account's LATER dismissal superseded no longer stands ------------------
// agent-org#358: the door posted APPROVED at head H, the reviewer then ran `gh pr review --approve` by hand (a duplicate) and dismissed it.
// GitHub reads `reviewDecision` from each account's LATEST review, which was now the DISMISSED one: REVIEW_REQUIRED, BLOCKED. The door
// still saw a standing approval at an equal patch and refused the one post that would clear it, so only a push could (which voids the verdict).

const DOOR_APPROVAL_AT_358 = reviewAt(FIRST, "APPROVED", "2026-10-07T19:47:46Z");
/** The by-hand duplicate, after dismissal: not a verdict by its opener, and its state is the account's latest. */
const HAND_DUPLICATE_DISMISSED = reviewAt(FIRST, "DISMISSED", "2026-10-07T19:47:52Z", "");

test("4029 (1) the #358 shape: a door-posted APPROVED at H, then a DISMISSED review by the same account at H, posts exactly ONE approval", () => {
  const { status, calls, stderr } = runDoor({ head: FIRST, reviews: [DOOR_APPROVAL_AT_358, HAND_DUPLICATE_DISMISSED] });
  assert.equal(status, 0, stderr);
  assert.equal(posted(calls).length, 1);
  assert.match(posted(calls)[0], /--approve/);
  assert.deepEqual(calls.filter((c) => /dismissals/.test(c)), [], "no human dismissal is in the path: the door never calls a `dismissals` endpoint");
});

test("4029 (2) CONTROL: the same APPROVED at H with NO later dismissal is still refused (exit 3)", () => {
  const { status, calls, stderr } = runDoor({ head: FIRST, reviews: [DOOR_APPROVAL_AT_358] });
  assert.equal(status, EXIT_SECOND_REVIEW, stderr);
  assert.deepEqual(posted(calls), []);
});

test("4029 (3) CONTROL: a DISMISSED review by ANOTHER account does not lift the refusal", () => {
  const { status, calls } = runDoor({ head: FIRST, reviews: [DOOR_APPROVAL_AT_358, { ...HAND_DUPLICATE_DISMISSED, user: "someone-else" }] });
  assert.equal(status, EXIT_SECOND_REVIEW);
  assert.deepEqual(posted(calls), []);
});

test("4029 (4) CONTROL: a DISMISSED review BEFORE the approval does not lift it (the approval is the account's latest)", () => {
  const dismissedFirst = { ...HAND_DUPLICATE_DISMISSED, when: "2026-10-07T19:40:00Z" };
  const { status, calls } = runDoor({ head: FIRST, reviews: [dismissedFirst, DOOR_APPROVAL_AT_358] });
  assert.equal(status, EXIT_SECOND_REVIEW);
  assert.deepEqual(posted(calls), []);
});

test("4029 (5) the lifted approval lifts only itself: an older APPROVED, a dismissal, then a NEWER door APPROVED is refused again", () => {
  const reposted = reviewAt(FIRST, "APPROVED", "2026-10-07T20:30:00Z");
  const { status, calls } = runDoor({ head: FIRST, reviews: [DOOR_APPROVAL_AT_358, HAND_DUPLICATE_DISMISSED, reposted] });
  assert.equal(status, EXIT_SECOND_REVIEW, "once the one fresh approval is posted the door is back to refusing a second");
  assert.deepEqual(posted(calls), []);
});

test("4029 (6) the same lift at an equal patch ON ANOTHER COMMIT (a merge of main between the approval and the dismissal)", () => {
  const dismissedLater = reviewAt(AFTER_MERGE_OF_MAIN, "DISMISSED", "2026-10-07T19:47:52Z", "");
  const { status, calls, stderr } = runDoor({ head: AFTER_MERGE_OF_MAIN, reviews: [DOOR_APPROVAL_AT_358, dismissedLater] });
  assert.equal(status, 0, stderr);
  assert.equal(posted(calls).length, 1);
});

// --- agent-org#514 (from a11ign#4558): AN APPROVE SUPERSEDES THE SAME ACCOUNT'S STANDING CHANGES_REQUESTED, AND NOTHING ELSE ---------
//
// #4558 at head a913994a: `reviewer` posted CHANGES_REQUESTED after reading the head commit's diff against its parent and not the pull request's
// against `main`; the corrected verdict, at the SAME head, was refused at the door and the block stood until somebody with admin dismissed it.
// ceo's ruling (a), narrowed: at an equal patch the door posts a review that differs in state from the standing one ONLY when the standing one is a
// CHANGES_REQUESTED the same account posted, the new one is an APPROVE, and its body names the review. Each refusal below differs from the case
// that posts by exactly ONE fact: the state, the account, or the audit line.

const BLOCK_ID = 4210512001;
/** The standing block, with an id of the length a real review has, so a number in the body cannot meet it by chance. */
const blockAt = (commit: string, when = "2026-10-09T14:41:48Z"): Review => ({ ...reviewAt(commit, "CHANGES_REQUESTED", when), id: BLOCK_ID });
const NAMES_BY_ID = `Supersedes review ${BLOCK_ID}: it was read against the head commit's parent, not \`main\`.`;
const NAMES_BY_OPENER = (commit: string) => `Supersedes: Review of #7 at \`${commit.slice(0, 8)}\` (CHANGES_REQUESTED), which misread the diff.`;
const READ_ACCOUNT = (calls: string[]) => calls.filter((c) => c.startsWith("api user"));

test("514 (1) CONTROL, same state: a CHANGES_REQUESTED over the account's own CHANGES_REQUESTED at an equal patch still refuses, naming it or not", () => {
  for (const body of [undefined, NAMES_BY_ID, NAMES_BY_OPENER(FIRST)]) {
    const { status, calls, stderr } = runDoor({ head: FIRST, reviews: [blockAt(FIRST)], verdict: "not-convinced", body });
    assert.equal(status, EXIT_SECOND_REVIEW, stderr);
    assert.deepEqual(posted(calls), [], "NOTHING was posted");
    assert.deepEqual(READ_ACCOUNT(calls), [], "a same-state repeat is refused before the account is read");
  }
});

test("514 (2) POSITIVE: an APPROVE over the account's own standing CHANGES_REQUESTED at the SAME head, naming it by id or by opener, posts", () => {
  for (const body of [NAMES_BY_ID, NAMES_BY_OPENER(FIRST), `${NAMES_BY_ID}\n${NAMES_BY_OPENER(FIRST)}`]) {
    const { status, calls, stderr } = runDoor({ head: FIRST, reviews: [blockAt(FIRST)], body });
    assert.equal(status, 0, stderr);
    assert.equal(posted(calls).length, 1, "the correction was posted once");
    assert.match(posted(calls)[0], /--approve/);
    assert.match(stderr, /superseding CHANGES_REQUESTED at 2026-10-09T14:41:48Z/, "and the door says what it superseded");
    assert.ok(calls.some((c) => c.includes("/statuses/")), "and it was attributed, as every posted review is");
    assert.deepEqual(calls.filter((c) => /dismissals/.test(c)), [], "no review was dismissed by anyone");
  }
});

test("514 (2) POSITIVE: the same at an equal patch on ANOTHER commit (a merge of main since the block), all checks green", () => {
  const { status, calls, stderr } = runDoor({ head: AFTER_MERGE_OF_MAIN, reviews: [blockAt(FIRST)], body: NAMES_BY_OPENER(FIRST) });
  assert.equal(status, 0, stderr);
  assert.equal(posted(calls).length, 1);
  assert.equal(calls.filter((c) => c.includes("/compare/")).length, 2, "the case IS in the equal-patch population: both diffs were compared and equal");
});

test("514 (3) NEGATIVE, state: a CHANGES_REQUESTED over a standing APPROVED refuses, even naming it", () => {
  const approved: Review = { ...reviewAt(FIRST, "APPROVED", "2026-10-09T14:41:48Z"), id: BLOCK_ID };
  for (const body of [undefined, NAMES_BY_ID, NAMES_BY_OPENER(FIRST)]) {
    const { status, calls, stderr } = runDoor({ head: FIRST, reviews: [approved], verdict: "not-convinced", body });
    assert.equal(status, EXIT_SECOND_REVIEW, stderr);
    assert.deepEqual(posted(calls), []);
  }
});

test("514 (3b) NEGATIVE, state: an APPROVE over a standing APPROVED refuses, even naming it: only a block is superseded", () => {
  const { status, calls, stderr } = runDoor({ head: FIRST, reviews: [{ ...reviewAt(FIRST, "APPROVED", "2026-10-09T14:41:48Z"), id: BLOCK_ID }], body: NAMES_BY_ID });
  assert.equal(status, EXIT_SECOND_REVIEW, stderr);
  assert.deepEqual(posted(calls), []);
  assert.deepEqual(READ_ACCOUNT(calls), []);
});

test("514 (4) NEGATIVE, audit line: the APPROVE that does not name the block refuses, and the refusal says how to name it", () => {
  // The default verdict file's OPENER already reads `Review of #7 at \`f3879426\``, the standing review's own opener: it must not count.
  const named: [string, string | undefined][] = [
    ["no naming line at all", undefined],
    ["another review's id", "Supersedes review 4210599999."],
    ["a different commit's opener", NAMES_BY_OPENER(NEW_WORK)],
    ["the id as a fragment of a longer number", `Supersedes review 9${BLOCK_ID}1.`],
  ];
  for (const [what, body] of named) {
    const { status, calls, stderr } = runDoor({ head: FIRST, reviews: [blockAt(FIRST)], body });
    assert.equal(status, EXIT_SECOND_REVIEW, `${what}: ${stderr}`);
    assert.deepEqual(posted(calls), [], what);
    assert.match(stderr, new RegExp(`name it on a line AFTER the verdict line: its id \\(${BLOCK_ID}\\)`), what);
    assert.deepEqual(READ_ACCOUNT(calls), [], `${what}: an unnamed block is refused before the account is read`);
  }
});

test("514 (4) the naming must be AFTER the verdict line: the standing opener quoted only in the first line does not count", () => {
  const { status, calls } = runDoor({ head: FIRST, reviews: [blockAt(FIRST)],
    opener: `${openerAt(FIRST)} supersedes Review of #7 at \`${FIRST.slice(0, 8)}\` and review ${BLOCK_ID}` });
  assert.equal(status, EXIT_SECOND_REVIEW);
  assert.deepEqual(posted(calls), []);
});

test("514 (5) NEGATIVE, account: a CHANGES_REQUESTED another account posted is not this account's to supersede", () => {
  const { status, calls, stderr } = runDoor({ head: FIRST, reviews: [{ ...blockAt(FIRST), user: "someone-else" }], body: NAMES_BY_ID });
  assert.equal(status, EXIT_SECOND_REVIEW, stderr);
  assert.deepEqual(posted(calls), []);
  assert.match(stderr, /posted by someone-else, not by this account \(a11ign-bot\)/);
  assert.equal(READ_ACCOUNT(calls).length, 1);
});

test("514 (5) CONTROL: the account is a read, and one that fails is COULD-NOT-TELL (exit 4), never `yours`", () => {
  const { status, calls, stderr } = runDoor({ head: FIRST, reviews: [blockAt(FIRST)], body: NAMES_BY_ID, failing: "user" });
  assert.equal(status, EXIT_UNDETERMINED, stderr);
  assert.deepEqual(posted(calls), []);
  assert.match(stderr, /could not tell whether #7 already has a review/);
});

test("514 (6) a block is superseded ONCE: after the APPROVE posts, a second APPROVE naming either review, or a CHANGES_REQUESTED, refuses", () => {
  const superseding: Review = { ...reviewAt(FIRST, "APPROVED", "2026-10-09T15:10:00Z", `${openerAt(FIRST)}\n\n${NAMES_BY_ID}`), id: 4210512002 };
  for (const [verdict, body] of [
    ["convinced", NAMES_BY_ID],
    ["convinced", "Supersedes review 4210512002."],
    ["not-convinced", NAMES_BY_ID],
  ] as const) {
    const { status, calls, stderr } = runDoor({ head: FIRST, reviews: [blockAt(FIRST), superseding], verdict, body });
    assert.equal(status, EXIT_SECOND_REVIEW, `${verdict} ${body}: ${stderr}`);
    assert.deepEqual(posted(calls), []);
  }
});

test("514 (7) the door and the gate agree: once the APPROVE names the block, the gate reads the pull request as convinced, not as the block", () => {
  const head = FIRST;
  const block = { id: "r1", submittedAt: "2026-10-09T14:41:48Z", state: "CHANGES_REQUESTED", body: `${openerAt(head).replace(": convinced", ": not convinced")}\n\nbody` };
  const correction = { id: "r2", submittedAt: "2026-10-09T15:10:00Z", state: "APPROVED",
    // The naming line says "not-convinced" after the opener's `convinced`: the verdict is the first word read, the opener's.
    body: `${openerAt(head)}\n\nSupersedes my not-convinced review r1 (\`Review of #7 at \\\`${head.slice(0, 8)}\\\`\`).` };
  const before = verdictAmong({ headRefOid: head, author: { login: "worker-9" }, reviews: [block] }, [head]);
  const after = verdictAmong({ headRefOid: head, author: { login: "worker-9" }, reviews: [block, correction] }, [head]);
  assert.equal(before.verdict, "not-convinced", "the block alone stands");
  assert.equal(after.verdict, "convinced", "the correction is the newest verdict at the head");
  assert.equal(after.id, "r2");
});

test("514 cost: the common paths read no account; only a named, same-state-different correction does, once", () => {
  assert.deepEqual(READ_ACCOUNT(runDoor({ head: FIRST }).calls), [], "no review at all");
  assert.deepEqual(READ_ACCOUNT(runDoor({ head: NEW_WORK, reviews: [blockAt(FIRST)], body: NAMES_BY_ID }).calls), [], "a block at a DIFFERENT patch");
  assert.equal(READ_ACCOUNT(runDoor({ head: FIRST, reviews: [blockAt(FIRST)], body: NAMES_BY_ID }).calls).length, 1);
});
