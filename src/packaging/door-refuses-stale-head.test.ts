/**
 * a11ign/agent-org#3640 (found on a11ign#3623): THE DOOR REFUSES A VERDICT HEADED AT ONE COMMIT THAT GITHUB WOULD ATTACH TO ANOTHER, AND READS A
 * REVIEW'S COMMIT FROM ITS BODY.
 *
 * `gh pr review` has no commit option: it attaches to whatever the head is when it runs. #3623's head moved at 07:45:36Z, the approval headed
 * `61389c15` was submitted at 07:46:04Z and GitHub recorded it on `0af5fe4a`, a patch the text did not describe (`git patch-id --stable`:
 * 6394ec2b98ac vs 7317a73c3bfb). The door then refused the right review of the real head as "already has a review at an equal patch", because
 * it compared the review's `commit_id` (the head) and not the commit its body names. Both halves are one hole.
 *
 * NO CAPABILITY DECLARATION: nothing here reaches the network. `gh` is a stub first on `PATH`, answering from files by running the door's OWN `--jq`
 * over API-shaped JSON, and `git patch-id` is real, so the fixtures are real unified diffs. THE CASES ARE FUNCTIONS OF THE DOOR'S PATH, so the same
 * cases run against the door and against each mutant of it: a mutant that breaks only its own case is the proof the case can fail, and a
 * mutation whose marker is not in the door fails here, so a rewording of the door cannot leave a mutant that mutates nothing.
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
/** The new, documented code: the head moved since you reviewed it. Not 0, not any of the codes above. */
const EXIT_HEAD_MOVED = 5;

/** #3623's shape: the head a reviewer read, the head after the author pushed more work, and a head that is the first plus a merge of `main`. */
const REVIEWED = "61389c15aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const MOVED_ON = "0af5fe4abbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const REVIEWED_PLUS_MAIN = "9c2e77d1cccccccccccccccccccccccccccccccc";

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
  [REVIEWED]: diffOf({ hunkStart: 1, index: "1111111..2222222", added: ["two"] }),
  [MOVED_ON]: diffOf({ hunkStart: 1, index: "1111111..3333333", added: ["two", "five"] }),
  [REVIEWED_PLUS_MAIN]: diffOf({ hunkStart: 41, index: "aaaaaaa..bbbbbbb", added: ["two"] }),
};

const short = (sha: string): string => sha.slice(0, 8);
/** The verdict line, naming `named` the way the brief tells a reviewer to. */
const openerNaming = (named: string): string => `**Review of #7 at \`${short(named)}\`, by reviewer-7: convinced (CI run 41)**`;

interface Review { when: string; state: string; commit: string; body: string }
/** A review the door could have posted: `commit` is where GitHub attached it, `named` what its body says it read (default: the same). */
const reviewAt = ({ commit, named = commit, when }: { commit: string; named?: string; when: string }): Review =>
  ({ commit, when, state: "APPROVED", body: `${openerNaming(named)}\n\nbody` });

interface Scenario {
  head: string;
  /** The line the verdict file opens with. */
  opener: string;
  reviews?: Review[];
  /** The compare read fails. */
  compareFails?: boolean;
}
interface Run { status: number | null; calls: string[]; stderr: string }

/** The door's `gh` calls that WRITE. Everything else it asks is a read. */
const posted = (calls: string[]): string[] => calls.filter((c) => c.startsWith("pr review"));
const compares = (calls: string[]): string[] => calls.filter((c) => c.includes("/compare/"));

function runDoor(door: string, scenario: Scenario): Run {
  const dir = mkdtempSync(join(tmpdir(), "door-stale-"));
  try {
    writeFileSync(join(dir, "verdict.md"), `${scenario.opener}\n\nbody\n`);
    writeFileSync(join(dir, "pr.json"), JSON.stringify({ head: { sha: scenario.head }, base: { ref: "main" } }));
    writeFileSync(join(dir, "reviews.json"), JSON.stringify((scenario.reviews ?? []).map((r) => ({
      submitted_at: r.when, state: r.state, commit_id: r.commit, html_url: `https://example/pull/7#review-${r.when}`, body: r.body }))));
    for (const [sha, diff] of Object.entries(DIFFS)) writeFileSync(join(dir, `diff-${sha}`), diff);
    if (scenario.compareFails) writeFileSync(join(dir, "fail-compare"), "");
    // An abbreviated sha resolves in the stub as it does in `gh` (the door reads the commit a body names, which is 8 characters).
    writeFileSync(join(dir, "gh"), `#!/usr/bin/env bash
D="${dir}"
a="$*"; printf '%s\\n' "\${a//$'\\n'/ }" >> "$D/log"
jq_arg=""; prev=""
for x in "$@"; do [[ "$prev" == --jq ]] && jq_arg="$x"; prev="$x"; done
case "$a" in
  "pr review"*|*"--method POST"*) exit 0 ;;
  *"/check-runs"*) echo '{"check_runs":[]}' | jq -r "$jq_arg" ;;
  *"/compare/"*) [[ ! -f "$D/fail-compare" ]] || exit 1
    sha="\${a##*...}"; sha="\${sha%% *}"; f=("$D"/diff-"$sha"*); cat "\${f[0]}" ;;
  *"/pulls/7/reviews?"*"select("*) jq -r "$jq_arg" "$D/reviews.json" ;;
  *"/pulls/7/reviews?"*) jq --rawfile b "$D/verdict.md" '. + [{html_url: "https://example/review/1", commit_id: "deadbeef", body: ($b | rtrimstr("\\n"))}]' \\
    "$D/reviews.json" | jq -r "$jq_arg" ;;
  *"/pulls/7 "*) jq -r "$jq_arg" "$D/pr.json" ;;
esac
`, { mode: 0o755 });
    const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${dir}:${process.env.PATH}`, A11Y_REVIEWER_SESSION: "reviewer-7" };
    delete env.GH_REPO;
    const run = spawnSync("bash", [door, "7", "convinced", join(dir, "verdict.md")], { env, encoding: "utf8" });
    const log = join(dir, "log");
    return { status: run.status, calls: existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : [], stderr: run.stderr };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

type Case = (door: string) => void;

/** (a) CONTROL, FIRST: the verdict names the head, so it posts, and nothing needed comparing. */
const namedIsHead: Case = (door) => {
  for (const named of [MOVED_ON, short(MOVED_ON)]) {
    const { status, calls, stderr } = runDoor(door, { head: MOVED_ON, opener: openerNaming(named) });
    assert.equal(status, 0, `${named}: ${stderr}`);
    assert.equal(posted(calls).length, 1, `${named}: the review posted`);
    assert.deepEqual(compares(calls), [], `${named}: the same commit is not compared with itself`);
  }
};

/** (b) the verdict names an earlier head with a DIFFERENT patch: nothing posts, and the exit says the head moved. */
const namedIsAnEarlierDifferentPatch: Case = (door) => {
  const { status, calls, stderr } = runDoor(door, { head: MOVED_ON, opener: openerNaming(REVIEWED) });
  assert.equal(status, EXIT_HEAD_MOVED, stderr);
  assert.deepEqual(posted(calls), [], "NOTHING was posted");
  assert.deepEqual(calls.filter((c) => c.includes("/statuses/")), [], "and nothing was attributed");
  assert.match(stderr, /head moved since you reviewed it/);
  assert.ok(stderr.includes(`Review \`${MOVED_ON}\``), `it names the FULL head to review: ${stderr}`);
};

/** (b), when the diff of the commit it names will not read: COULD-NOT-TELL, never "unchanged". */
const namedDiffWillNotRead: Case = (door) => {
  const { status, calls } = runDoor(door, { head: MOVED_ON, opener: openerNaming(REVIEWED), compareFails: true });
  assert.equal(status, EXIT_UNDETERMINED);
  assert.deepEqual(posted(calls), []);
};

/** (c) the verdict names an earlier head whose patch EQUALS the head's (a merge of `main`, #3033): the work is the same, so it posts. */
const namedIsAnEarlierEqualPatch: Case = (door) => {
  const { status, calls, stderr } = runDoor(door, { head: REVIEWED_PLUS_MAIN, opener: openerNaming(REVIEWED) });
  assert.equal(status, 0, stderr);
  assert.equal(posted(calls).length, 1);
};

/** (d) a review HEADED at an old commit but attached to the new head does not block a fresh review of the new head, the patches differing. */
const secondReviewReadsTheNamedCommit: Case = (door) => {
  const attachedToTheNewHead = reviewAt({ commit: MOVED_ON, named: REVIEWED, when: "2026-10-05T07:46:04Z" });
  const { status, calls, stderr } = runDoor(door, { head: MOVED_ON, opener: openerNaming(MOVED_ON), reviews: [attachedToTheNewHead] });
  assert.equal(status, 0, stderr);
  assert.equal(posted(calls).length, 1, "the fresh review of the real head posted");
};

/** (d) CONTROL: a review that names the head AND sits on it is the duplicate the refusal exists for. */
const secondReviewAtTheHeadIsRefused: Case = (door) => {
  const { status, calls } = runDoor(door, { head: MOVED_ON, opener: openerNaming(MOVED_ON),
    reviews: [reviewAt({ commit: MOVED_ON, when: "2026-10-05T07:46:04Z" })] });
  assert.equal(status, EXIT_SECOND_REVIEW);
  assert.deepEqual(posted(calls), []);
};

/** (d) CONTROL: a review whose body names an EARLIER commit of an equal patch is a second review at one patch, wherever GitHub attached it. */
const secondReviewAtAnEqualNamedPatchIsRefused: Case = (door) => {
  const { status, calls } = runDoor(door, { head: REVIEWED_PLUS_MAIN, opener: openerNaming(REVIEWED_PLUS_MAIN),
    reviews: [reviewAt({ commit: REVIEWED_PLUS_MAIN, named: REVIEWED, when: "2026-10-05T07:46:04Z" })] });
  assert.equal(status, EXIT_SECOND_REVIEW);
  assert.deepEqual(posted(calls), []);
};

/** (d) FALLBACK: a body that names no commit is read at `commit_id`, so the old refusal still stands for it. */
const bodyNamingNothingFallsBackToCommitId: Case = (door) => {
  const { status, calls } = runDoor(door, { head: MOVED_ON, opener: openerNaming(MOVED_ON),
    reviews: [{ commit: MOVED_ON, state: "APPROVED", when: "2026-10-05T07:46:04Z", body: "**Review of #7 at head: convinced**\n\nbody" }] });
  assert.equal(status, EXIT_SECOND_REVIEW);
  assert.deepEqual(posted(calls), []);
};

/** A verdict that names no commit cannot be shown to be about the head, and the gate would never count it: refused before any `gh` call. */
const namingNothingIsMalformed: Case = (door) => {
  const { status, calls, stderr } = runDoor(door, { head: MOVED_ON, opener: "**Review of #7 at head, by reviewer-7: convinced**" });
  assert.equal(status, EXIT_MALFORMED, stderr);
  assert.deepEqual(calls, [], "nothing was sent to `gh`");
  assert.match(stderr, /names no commit/);
};

const CASES: Record<string, Case> = {
  "(a) the named sha equals the head, so the review posts": namedIsHead,
  "(b) the named sha is an earlier head with a different patch: refused, exit 5, names the head": namedIsAnEarlierDifferentPatch,
  "(b) the named commit's diff will not read: could not tell, exit 4": namedDiffWillNotRead,
  "(c) the named sha is an earlier head with an equal patch id: posts": namedIsAnEarlierEqualPatch,
  "(d) a review headed at an old commit but attached to the new head does not block a fresh review": secondReviewReadsTheNamedCommit,
  "(d) CONTROL: a review that names and sits on the head still refuses a second": secondReviewAtTheHeadIsRefused,
  "(d) CONTROL: a review naming an equal-patch commit refuses a second wherever it was attached": secondReviewAtAnEqualNamedPatchIsRefused,
  "(d) FALLBACK: a body naming no commit is read at commit_id": bodyNamingNothingFallsBackToCommitId,
  "a verdict line naming no commit is malformed and sends nothing": namingNothingIsMalformed,
};

for (const [name, run] of Object.entries(CASES)) test(name, () => run(DOOR));

test("the new code is its own: not 0, and none of the codes the door already had", () => {
  for (const other of [0, EXIT_MALFORMED, EXIT_SECOND_REVIEW, EXIT_UNDETERMINED]) assert.notEqual(EXIT_HEAD_MOVED, other);
  assert.match(readFileSync(DOOR, "utf8"), new RegExp(`EXIT_HEAD_MOVED=${EXIT_HEAD_MOVED}\\b`), "and the door says 5 by the same name");
  assert.match(readFileSync(DOOR, "utf8"), /^#\s+5\s+REFUSED: the head moved since you reviewed it/m, "and documents it in its header");
});

// --- the mutants: each breaks the door in ONE place and must break exactly the cases that guard that place ---------------------------
const AT_DOOR = (name: string): string => Object.keys(CASES).find((k) => k.includes(name)) as string;

interface Mutant { name: string; from: string; to: string; breaks: string[] }
const MUTANTS: Mutant[] = [
  { name: "the stale-head check never runs", from: "\nrefuse_stale_head\n", to: "\n:\n",
    breaks: [AT_DOOR("(b) the named sha is an earlier head"), AT_DOOR("diff will not read")] },
  { name: "any named sha other than the head is refused, whatever its patch", from: '[[ "$named_pid" != "$HEAD_PID" ]] || return 0', to: ":",
    breaks: [AT_DOOR("(c) the named sha")] },
  { name: "the head is refused as moved even when the verdict names it", from: 'same_commit "$named" "$PR_HEAD" && return 0', to: 'same_commit "$named" "$PR_HEAD" && exit 5',
    breaks: Object.keys(CASES).filter((k) => /\(a\)|\(d\) (a review headed|CONTROL|FALLBACK)/.test(k)) },
  { name: "the named commit is compared only when it is spelt exactly as the head", from: 'local a="${1,,}" b="${2,,}"', to: 'local a="$1" b="$2"; [[ "$a" == "$b" ]] && return 0; return 1',
    breaks: [AT_DOOR("(a) the named sha equals the head")] },
  { name: "the second-review refusal reads commit_id, not the body", from: '((.body | split("\\n")[0] | capture("(^|[^A-Za-z0-9_])(at|of)\\\\s+`(?<sha>[0-9a-fA-F]{7,40})`")? | .sha) // .commit_id)', to: ".commit_id",
    breaks: [AT_DOOR("(d) a review headed at an old commit")] },
  { name: "a body that names no commit is read at nothing", from: "// .commit_id", to: '// ""',
    breaks: [AT_DOOR("(d) FALLBACK")] },
  { name: "a verdict line naming no commit is posted unchecked", from: '[[ -n "$named" ]] ||', to: "true ||",
    breaks: [AT_DOOR("naming no commit is malformed")] },
  { name: "a named diff that will not read counts as unchanged", from: '|| undetermined "the diff at ${named:0:8}, the commit the verdict names, would not read"', to: "|| return 0",
    breaks: [AT_DOOR("diff will not read")] },
];

test("every mutant's marker is in the door exactly once, so none mutates nothing", () => {
  const source = readFileSync(DOOR, "utf8");
  for (const { name, from } of MUTANTS) assert.equal(source.split(from).length - 1, 1, `${name}: marker not found exactly once`);
});

test("each mutant breaks exactly the cases that guard its place, and the cases pass on the real door", () => {
  const source = readFileSync(DOOR, "utf8");
  const dir = mkdtempSync(join(tmpdir(), "door-mutant-"));
  try {
    for (const { name, from, to, breaks } of MUTANTS) {
      const mutated = join(dir, "pr-review-verdict.sh");
      writeFileSync(mutated, source.replace(from, () => to));
      const failing = Object.entries(CASES).filter(([, run]) => {
        try { run(mutated); return false; } catch { return true; }
      }).map(([caseName]) => caseName).sort();
      assert.deepEqual(failing, [...new Set(breaks)].sort(), `mutant "${name}"`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
