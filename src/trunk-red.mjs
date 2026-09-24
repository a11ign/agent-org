// @ts-check
// A RED `main` WAKES A FIXER -- it does not open a revert (#2356, the chairman's ruling of 2026-09-24).
//
// THE ORG ALWAYS FIXES FORWARD. Until this row `trunk.yml`'s `decideRevert` job reverted a merge whose own
// gate failed, unattended, and #2341 showed the price: it would have removed a correct doc for a two-entry
// map miss in a test, and the fix (#2346/#2347) was smaller than the re-land. The chairman ruled that
// nothing reverts a merge automatically and that there is no fallback either -- not after 60 minutes
// (#2349), not ever. THE OBJECTION WAS TO THE MECHANISM BEING IN CI at all.
//
// A RULING THAT ONLY DELETES LEAVES `main` RED UNTIL SOMEBODY HAPPENS TO LOOK, so this is the second half:
// what makes a fix-forward FAST. `work-gate.mjs` reads it once a tick, no model, and hands what it finds to
// `wake.mjs` -- the gate, not a cron and not a retry loop.
//
// WHAT THIS FILE KEEPS OF THE OLD DECISION, because it was the good part of it. `trunk-revert.mjs` knew
// two ways a bare "act on red" is worse than nothing, both measured live: an INHERITED failure (13 of 19
// PRs read red on one bad commit and none was at fault) and a STALE parent reading (#616: the parent was
// green when measured and red when asked again). Neither is a reason to stay silent now -- `main` is red
// either way and somebody must fix it -- but both decide WHO IS TOLD AND WHAT THEY ARE TOLD, so the order
// says which of three it is and never blames a merge for a failure it did not cause.
import { execFileSync } from "node:child_process";
import { summarizeTestLog, testIdentity } from "./parent-recheck-summary.mjs";
import { REPO } from "../../../scripts/repo-identity.mjs";

/** The workflow whose newest run on `main` says whether `main` is red. */
export const TRUNK_WORKFLOW = "trunk.yml";

/**
 * The job that re-runs the failing suite AT THE PARENT and records what it found, and the annotation title
 * it records under. THE GATE READS BOTH BY NAME, so `trunk.yml` and this file are one contract: the
 * workflow test pins that the job and the title it writes are these two strings.
 */
export const RECHECK_JOB = "trunkRecheck";
export const RECHECK_ANNOTATION_TITLE = "trunk-recheck";

/** `trunkBuildTest` is a reusable-workflow call, so GitHub names its inner job `<caller> / <callee>`. */
const BUILD_TEST_JOB = "trunkBuildTest / run";

/** The most parent failures the recheck records: an annotation is bounded, and a parent this broken is named by its first few. */
export const MAX_RECORDED_PARENT_FAILURES = 30;

const defaultRun = (/** @type {string[]} */ args) =>
  execFileSync("gh", args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });

/**
 * The newest COMPLETED run that said `success` or `failure` -- or `null` when there is none, and `null`
 * is also what a run that is merely red-then-cancelled returns, deliberately.
 *
 * A CANCELLED OR SKIPPED RUN SAYS NOTHING ABOUT `main`, so it is looked through rather than read as
 * green: someone cancelling a run must not silence a red that is still true, and must not raise one either.
 * A run still in flight is looked through for the same reason. `created_at` is compared as a string
 * because ISO-8601 sorts lexically.
 *
 * @param {{ workflow_runs?: { id: number, head_sha: string, status: string, conclusion: string | null,
 *   html_url: string, created_at: string }[] } | null} payload the `actions/workflows/<f>/runs` body
 * @returns {{ id: number, head_sha: string, conclusion: string, html_url: string } | null}
 */
export function newestVerdictRun(payload) {
  const runs = (payload?.workflow_runs ?? [])
    .filter((r) => r.status === "completed" && (r.conclusion === "success" || r.conclusion === "failure"))
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  return runs.length === 0 ? null : /** @type {any} */ (runs[0]);
}

/**
 * The parent re-check's recorded answer, and the failing test names it saw, from the annotation
 * `trunk.yml`'s `trunkRecheck` job wrote. `unknown` for anything this cannot read: an absent annotation
 * is not a pass, and a pass is the only answer that blames the merge.
 *
 * @param {{ message?: string }[] | null} annotations
 * @returns {{ result: "pass" | "fail" | "unknown", parentFailingTests: string[] | null }}
 */
export function recheckFromAnnotations(annotations) {
  for (const { message } of annotations ?? []) {
    const m = /^RECHECK_RESULT=(pass|fail|unknown)$/m.exec(String(message ?? ""));
    if (!m) continue;
    const named = String(message).split("\n").filter((l) => /^not ok \d+/.test(l)).map(testIdentity);
    return { result: /** @type {"pass" | "fail" | "unknown"} */ (m[1]), parentFailingTests: named.length > 0 ? named : null };
  }
  return { result: "unknown", parentFailingTests: null };
}

/**
 * WHOSE FAILURE IS IT -- three answers, because the third is real and folding it into either of the others
 * is what made the old revert wrong twice.
 *
 * `own`: the parent PASSES the suite now (or only the silent-undo guard failed, a question about THIS
 * merge's own two parents), or it fails something DISJOINT from what this merge failed (#1359).
 * `inherited`: the parent fails the SAME test now, on a tree this merge did not touch -- the world's
 * failure (a wall-clock assertion, an outage, a dependency that moved), or one already on `main`.
 * `unknown`: the re-check could not run, or could not name the tests on one side. The order is still sent.
 *
 * @param {{ recheck: "pass" | "fail" | "unknown", pushFailingTests: string[] | null,
 *   parentFailingTests: string[] | null }} facts
 * @returns {{ kind: "own" | "inherited" | "unknown", shared: string[] }}
 */
export function attributionOf({ recheck, pushFailingTests, parentFailingTests }) {
  if (recheck === "pass") return { kind: "own", shared: [] };
  if (recheck === "unknown" || pushFailingTests === null || parentFailingTests === null) {
    return { kind: "unknown", shared: [] };
  }
  const shared = pushFailingTests.filter((name) => parentFailingTests.includes(name));
  return { kind: shared.length === 0 ? "own" : "inherited", shared };
}

/**
 * The failing test identities for the named job's lines inside a `gh run view --log-failed` dump, which
 * tab-separates every failed step as `job\tstep\tline`. The same TAP parser the parent re-check uses, so
 * "the same test" means the same thing measured the same way on both sides.
 * `null` when the job has no lines here or names no real failing subtest.
 * @param {string} logFailedOutput
 * @param {string} jobName
 * @returns {string[] | null}
 */
export function failingTestsFromJobLog(logFailedOutput, jobName) {
  const prefix = `${jobName}\t`;
  const jobLines = logFailedOutput.split("\n")
    .filter((line) => line.startsWith(prefix))
    // The timestamp has to come off first: `summarizeTestLog`'s `not ok` pattern is anchored to the START
    // of a line, so a timestamp-prefixed one matches nothing, silently -- measured against a real run's log.
    .map((line) => line.split("\t").slice(2).join("\t").replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z /, ""));
  if (jobLines.length === 0) return null;
  const { verdict, notOkLines } = summarizeTestLog(jobLines.join("\n"));
  return verdict === "fail" ? notOkLines.map(testIdentity) : null;
}

/**
 * Everything the order needs, read from GitHub -- or `null` when `main` is not red or the question could
 * not be asked. `null` IS NEVER "GREEN AND NEVER 'RED'": a refused read reports nothing, which is what the
 * gate does for every lane it cannot read (#1286), and the tick's PARTIAL exit is unchanged by it.
 *
 * ONE CALL WHEN `main` IS HEALTHY. The unconditional read is the newest runs of `trunk.yml` on `main`; the
 * four that follow are paid only by a tick that found a red. Each is a single REST call on the core pool,
 * and each may be refused independently -- a refused one degrades that FACT to `null`/`unknown`, and the
 * order is still sent, because a red `main` with an unnamed test is still a red `main`.
 *
 * @param {(args: string[]) => string} [run]
 * @returns {{ runId: number, url: string, sha: string, failedJobs: string[], failingTests: string[] | null,
 *   recheck: "pass" | "fail" | "unknown", parentFailingTests: string[] | null,
 *   originPr: { number: number, title: string, session: string | null } | null } | null}
 */
export function readTrunkRed(run = defaultRun) {
  const runs = tryParse(() => run(["api", "--method", "GET", `repos/${REPO}/actions/workflows/${TRUNK_WORKFLOW}/runs`,
    "-f", "branch=main", "-f", "per_page=10"]));
  const newest = newestVerdictRun(runs);
  if (newest === null || newest.conclusion !== "failure") return null;

  const jobs = tryParse(() => run(["api", `repos/${REPO}/actions/runs/${newest.id}/jobs?per_page=100`]))?.jobs ?? [];
  const failedJobs = jobs.filter((/** @type {any} */ j) => j.conclusion === "failure").map((/** @type {any} */ j) => String(j.name));
  const recheckJob = jobs.find((/** @type {any} */ j) => j.name === RECHECK_JOB);
  const annotations = recheckJob
    ? tryParse(() => run(["api", `repos/${REPO}/check-runs/${recheckJob.id}/annotations`]))
    : null;
  const recheck = recheckFromAnnotations(Array.isArray(annotations) ? annotations : null);
  const failingTests = failedJobs.includes(BUILD_TEST_JOB) ? readFailingTests(run, newest.id) : null;
  return { runId: newest.id, url: newest.html_url, sha: newest.head_sha, failedJobs, failingTests,
    recheck: recheck.result, parentFailingTests: recheck.parentFailingTests,
    originPr: readOriginPr(run, newest.head_sha) };
}

/** @param {() => string} read @returns {any} the parsed body, or `null` when the read or the parse failed */
function tryParse(read) {
  try {
    return JSON.parse(read());
  } catch {
    // A refusal is reported by the caller as a fact it does not have, never as an empty answer.
    return null;
  }
}

/** @param {(args: string[]) => string} run @param {number} runId @returns {string[] | null} */
function readFailingTests(run, runId) {
  try {
    return failingTestsFromJobLog(run(["run", "view", String(runId), "--repo", REPO, "--log-failed"]), BUILD_TEST_JOB);
  } catch {
    return null;
  }
}

/**
 * Which merged PR introduced `sha`, and which session it carried -- resolved by GitHub itself (the commit's
 * associated-PR list), never parsed out of the merge message.
 * @param {(args: string[]) => string} run @param {string} sha
 * @returns {{ number: number, title: string, session: string | null } | null}
 */
function readOriginPr(run, sha) {
  const pulls = tryParse(() => run(["api", `repos/${REPO}/commits/${sha}/pulls`]));
  if (!Array.isArray(pulls) || pulls.length === 0) return null;
  const labels = (pulls[0].labels ?? []).map((/** @type {{ name: string }} */ l) => String(l.name));
  const session = labels.find((/** @type {string} */ n) => n.startsWith("session:"));
  return { number: pulls[0].number, title: String(pulls[0].title ?? ""),
    session: session ? session.slice("session:".length) : null };
}

/**
 * THE POLICY THE ROW ASKED TO BE DECIDED, WRITTEN AS DATA SO A TEST CAN PIN IT (#2356 done-when 3).
 *
 * WHILE A FIX IS IN FLIGHT, OTHER PULL REQUESTS KEEP MERGING. Nothing freezes the queue, for three reasons
 * that each stand alone:
 *   1. A FREEZE NEEDS A MECHANISM THIS ORG DOES NOT HAVE AND COULD NOT SAFELY BUILD HERE. The
 *      `merge-queue-main` ruleset and `branches/main/protection` are admin surfaces, and a session that
 *      edits either to stop merges holds a hole in the requirement (`main-review-requirement.md`).
 *   2. A RED `main` ALREADY STOPS THE MERGES THAT WOULD MAKE IT WORSE. The queue tests each PR's merge
 *      result with the full gate, so a change that touches the broken area reads red on its own and does
 *      not land; what lands is what is independent of the break -- and holding that back is the cost the
 *      chairman's "always fix forward" ruling exists to avoid, because it slows the fix's own reviewers.
 *   3. `trunkGate` KEEPS RUNNING. The one way a merge onto a red `main` does real damage -- silently undoing
 *      work already there (#411) -- is still refused by `trunk-revert-guard.mjs`, red or not.
 *
 * THE FIX GOES FIRST BY THE ORDER, NOT BY THE QUEUE: it is the first order `decide` emits, ahead of every
 * other cause, not withheld by a drain, and re-offered on `wake`'s twenty-minute expiry until `main` is
 * green. JUMPING THE FIX PR PAST THE MERGE QUEUE (`enqueuePullRequest`'s `jump`) IS NOT BUILT HERE -- the
 * mutation exists (schema read 2026-09-24) but arming it is a write that only a live queue can verify,
 * and a queue jump that misfires costs more than the wait it saves. It is its own row, #2391.
 */
export const RED_TRUNK_POLICY = Object.freeze({
  othersKeepMerging: true,
  fixOrderIsFirst: true,
  fixPrJumpsQueue: false,
});

/** @param {ReturnType<typeof attributionOf>} attribution */
function attributionParagraph(attribution) {
  if (attribution.kind === "own") {
    return "THE RE-CHECK SAYS THIS MERGE'S OWN: the parent does not fail this now (or fails only tests this merge "
      + "did not, or only the silent-undo guard failed, which asks about this merge's own two parents) -- so the "
      + "failure arrived with it.";
  }
  if (attribution.kind === "inherited") {
    return "THE RE-CHECK SAYS INHERITED: the parent fails the SAME test now "
      + `(${attribution.shared.map((n) => `\`${n}\``).join("; ")}), on a tree this merge did not touch -- so nothing `
      + "about it is this merge's own. It is the world's or an earlier merge's, and it still has to be fixed.";
  }
  return "THE RE-CHECK COULD NOT SAY whether it is this merge's own (it did not run, or could not name the tests on "
    + "one side). Treat it as this merge's until you have read the run and shown otherwise.";
}

/**
 * The one order a red `main` produces -- or `[]` when it is not red.
 *
 * ADDRESSED BY WHO OWES IT, WITH A WAY OUT WHEN THAT SESSION IS NOT THERE. Own or unknown: the merged
 * PR's session, which holds the context, falling back to `engineers` (any idle engineer) when that
 * session is gone or busy -- `wake.mjs` reads `fallback`. Inherited: `engineers`, because nothing about it
 * is the merged PR's own and waking its author for a failure they did not cause is the misattribution the
 * old revert made. The order is NEVER withheld for being inherited (#2356 done-when 2).
 *
 * THE SUBJECT IS THE MERGED PR WHEN KNOWN (`pr-<n>`), which is what lets `wake`'s STUCK breaker label it
 * `needs:chairman` if six offers do not clear the red -- a fix-forward nobody picks up must reach a person.
 *
 * @param {ReturnType<typeof readTrunkRed> | undefined} red `null` or omitted when `main` is not red
 * @returns {{ session: string, fallback?: string, cause: string, subject: string, discriminator: string,
 *   prompt: string, causeKey: string }[]}
 */
export function trunkRedOrders(red) {
  if (!red) return [];
  const sha8 = red.sha.slice(0, 8);
  const attribution = attributionOf({ recheck: red.recheck, pushFailingTests: red.failingTests,
    parentFailingTests: red.parentFailingTests });
  const owner = red.originPr?.session ?? null;
  const session = attribution.kind === "inherited" || owner === null ? "engineers" : owner;
  const subject = red.originPr ? `pr-${red.originPr.number}` : `trunk-${sha8}`;
  const merged = red.originPr ? `#${red.originPr.number} ("${red.originPr.title}")` : `\`${sha8}\` (no pull request could be identified)`;
  const tests = red.failingTests === null
    ? "no failing test could be named from the log -- read the run"
    : red.failingTests.map((n) => `\`${n}\``).join("; ");
  return [{
    session,
    ...(session === "engineers" ? {} : { fallback: "engineers" }),
    cause: "trunk-red",
    subject,
    discriminator: sha8,
    prompt: `**MAIN IS RED. FIX FORWARD -- DO NOT REVERT.** This is the top of every queue: put down what you are doing.\n`
      + `The merge is ${merged}, at \`${sha8}\`. The failing job(s): ${red.failedJobs.map((j) => `\`${j}\``).join(", ") || "not readable"}.\n`
      + `The failing test(s): ${tests}.\n`
      + `The run: ${red.url}\n`
      + `${attributionParagraph(attribution)}\n`
      + "THE RULING (chairman, 2026-09-24): the org always fixes forward. Nothing reverts a merge, no CI job "
      + "and no session -- not a `revert/` branch, not `git revert`, not \"revert as a fallback after N minutes\". "
      + "#2341 would have removed a correct doc for a two-entry map miss in a test, and the fix was smaller "
      + "than the re-land.\n"
      + "SO: read the failing test, find the smallest change that makes it true, and open THAT as a pull "
      + "request now, naming this merge in it. Other pull requests KEEP MERGING while you do (a red main "
      + "already stops the ones that touch the break, and `trunkGate` still refuses a merge that silently "
      + "undoes work); the fix goes first because this order outranks every other, not because the queue stops.\n"
      + "If you cannot tell what to fix, say so on the merged pull request and route it -- but say it there, "
      + "do not hold this order in silence. It is offered again every twenty minutes until `main` is green.",
    causeKey: `${session}/trunk-red/${subject}/${sha8}`,
  }];
}
