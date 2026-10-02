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

const DOOR = fileURLToPath(new URL("../reviewer/pr-review-verdict.sh", import.meta.url));

const EXIT_MALFORMED = 2;
const EXIT_SECOND_REVIEW = 3;
const EXIT_UNDETERMINED = 4;

/** The #3033 shape: the reviewed commit, then the same change after `main` was merged in, then different work. */
const FIRST = "f3879426aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const AFTER_MERGE_OF_MAIN = "c7764afbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const NEW_WORK = "9d41e0cccccccccccccccccccccccccccccccccc";

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
};

interface Review { when: string; state: string; commit: string }
const reviewAt = (commit: string, state: string, when: string): Review => ({ commit, state, when });

const OPENER = "**Review of #7 at `c7764afb`, by reviewer-7: convinced (CI run 41)**";

interface Run { status: number | null; calls: string[]; stderr: string }
interface Scenario {
  head: string;
  reviews?: Review[];
  verdict?: "convinced" | "not-convinced";
  opener?: string;
  /** A `gh` read that fails, named by what it was reading. */
  failing?: "reviews" | "compare";
}

/** The door's `gh` calls that WRITE. Everything else it asks is a read. */
const posted = (calls: string[]): string[] => calls.filter((c) => c.startsWith("pr review"));

function runDoor(scenario: Scenario): Run {
  const dir = mkdtempSync(join(tmpdir(), "door-second-"));
  try {
    const opener = scenario.opener ?? OPENER;
    writeFileSync(join(dir, "verdict.md"), `${opener}\n\nbody\n`);
    writeFileSync(join(dir, "pr.json"), JSON.stringify({ head: { sha: scenario.head }, base: { ref: "main" } }));
    writeFileSync(join(dir, "reviews.json"), JSON.stringify((scenario.reviews ?? []).map((r) => ({
      submitted_at: r.when, state: r.state, commit_id: r.commit, html_url: `https://example/pull/7#review-${r.when}`, body: "earlier" }))));
    for (const [sha, diff] of Object.entries(DIFFS)) writeFileSync(join(dir, `diff-${sha}`), diff);
    if (scenario.failing === "reviews") writeFileSync(join(dir, "fail-reviews"), "");
    if (scenario.failing === "compare") writeFileSync(join(dir, "fail-compare"), "");
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
  *"/compare/"*) [[ ! -f "$D/fail-compare" ]] || exit 1
    sha="\${a##*...}"; sha="\${sha%% *}"; cat "$D/diff-$sha" ;;
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
