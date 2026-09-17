#!/usr/bin/env node
// @ts-check
// command: close the issues a merged PR declared, because a bot merge does not close them itself
// CLOSE THE ROWS A MERGED PR DECLARED, BECAUSE GITHUB DOES NOT DO IT FOR A BOT MERGE -- #298, unit 1d.
//
// ## The measurement
//
// `Closes #N` in a PR body is the tracker's whole closing mechanism under the pipeline. GitHub honours it
// AS THE ACTOR THAT MERGED, and under auto-arm that actor is `github-actions[bot]`. Measured 2026-09-07,
// after `issues: write` was added to `auto-arm.yml` at 11:04:36Z:
//
//   target  state   merged by              PR    armed
//   #310    OPEN    github-actions[bot]    #320  10:27Z  (pre-fix)
//   #321    OPEN    github-actions[bot]    #346  11:40Z  (36 MINUTES POST-FIX)
//   #326    CLOSED  DanBeckDev             #334
//   #331    CLOSED  DanBeckDev             #335
//
// **Three of three bot merges failed to close; two of two human merges closed**, with the permission
// present in the file. So `issues: write` was not the lever, and the pipeline must close rows itself.
//
// THE MECHANISM IS A HYPOTHESIS AND IS DELIBERATELY NOT RELIED ON. It may be that a merge performed under
// `GITHUB_TOKEN` cannot close a referenced issue at all, the way GitHub already stops `GITHUB_TOKEN`
// events cascading into new workflow runs. Nobody here has read documentation saying so, and this
// repository's record is full of mechanisms that were reasoned, sounded right, and were wrong. This fix
// works whether or not that explanation is true, which is why it was preferred over arguing the cause.
//
// ## Why it cannot close a row whose work did not land
//
// `close-merged-rows.mjs` -- which is in the tree and which NOTHING INVOKES -- deliberately refuses rather
// than closes, and its reason is right: *"closing needs the sha and a sentence, which is the dispatcher's
// to write, and a tool that closed rows automatically would eventually close one whose work did not
// actually land."* That reasoning assumed a human dispatcher merged. Under the pipeline nobody merges, so
// the premise is gone -- but the RISK it names is real and is answered here rather than dropped:
//
//   - It runs on `pull_request: types: [closed]`, gated on `merged == true` and `base.ref == 'main'`, so
//     a closed-unmerged PR closes nothing.
//   - It closes only the issues GITHUB ITSELF resolved as that PR's `closingIssuesReferences` -- not a
//     regex over the body. That is the exact set GitHub would have closed, so this restores the intended
//     behaviour rather than inventing a broader one. A `#123` mentioned in prose is not a closing
//     reference and is not touched.
//   - Every closure comments the PR number and the MERGE SHA first, so the sentence the header asks for
//     is on the row, and `git` can be asked what actually landed.
//
// ## Reporting
//
// Four outcomes and they must never collapse. `NONE DECLARED` is not a failure -- most PRs close nothing
// -- but it must be distinguishable from `declared and closed`, or a job that resolved no references
// would report success having done nothing, which is this repository's most-recorded defect. An issue
// somebody already closed by hand is reported as `ALREADY CLOSED` rather than silently skipped.
//
// ## #776/#791: "ALREADY CLOSED" IS NOT ONLY "SOMEBODY CLOSED IT BY HAND, UNRELATED TO THIS PR"
//
// GitHub applies a PR body's `Closes #N` NATIVELY -- at merge, before any workflow even starts -- whenever
// the merging actor is a HUMAN. This file's own opening measurement (#298) is precisely the mirror case:
// three of three BOT merges left their rows open, which is why this script exists at all. It never
// followed that the opposite is also true -- a human merge closes the row before this script's own
// `gh issue close` call ever runs, so by the time `closingIssuesReferences` is read, the row already
// reads `state: CLOSED` and lands in `already`, not `close`.
//
// Measured 2026-09-09: #677, #577 and #752, closed one second after their PRs (#769/#766/#783, all merged
// by a human account) merged -- ALL after #776 (this file's own #754 fix) was already on `main`. Each
// row's `closed` timeline event carried `commit_id: null` and the human merger as `actor` -- GitHub's own
// signature for a closing-KEYWORD resolution, distinct from this script's `gh issue close` (which shows
// `github-actions[bot]` and a comment). None of the three had its claim labels stripped, because
// `stripClaimLabels` was called only inside the `close` loop.
//
// So `already`'s rows are stripped too now, exactly like `close`'s -- a row's claim is exactly as stale
// whether GitHub closed it natively one second before this script asked, or this script closed it itself.
//
// Exit codes are the contract:
//   0  every declared row is closed -- by this run or already
//   1  one or more could not be closed. NAMED, never counted.
//   2  a lookup failed. INCONCLUSIVE, never "fine".
//   3  every row closed, but one or more Statuses did not move for a cause OTHER than an unreadable Project
//      (#1299). A run whose every refusal is `project-unreadable` exits 0 with a DEGRADED line: see `closeRowsExit`.
//
//   node packages/agent-org/src/close-rows-for-merged-pr.mjs <pr-number>
import { execFileSync } from "node:child_process";
import { settleClosedStatus, unsettledVerdict } from "./settle-closed-status.mjs";
// The token-carrying half, imported HERE (an entry point) and injected, so the pure module stays pure.
import { moveProjectStatus } from "./row-claim.mjs";
import { scopedStatus } from "./board-snapshot.mjs";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
// RELATIVE, never `@a11y-witness/worker-fleet/cli-flags`: this job runs with `actions/checkout` and
// nothing else -- no `npm ci`, no build -- so the package specifier would resolve to a `dist/` that does
// not exist there. #330 and #331 are what that circular bootstrap costs. `cli-flags.mjs` imports only
// `node:path`, `node:fs` and `node:url`.
import { refuseUnknownFlags } from "../../worker-fleet/src/cli-flags.mjs";
// #804: A LEAF IMPORT, safe under the identical no-`npm ci`/no-build constraint the rest of this header
// names -- `claim-labels.mjs` imports nothing at all, so it cannot be part of a cycle. This replaced two
// rounds of "duplicate the constant locally instead" (#754 for CLAIM_LABEL/STARTED_LABEL, #782 for
// READY_LABEL): each was individually defensible against the immediate risk (row-claim.mjs's heavy import
// graph; a cycle back through ready-label-audit.mjs) but the accumulation was itself the fact-stated-twice
// shape this repo names as its own most expensive recurring defect -- three copies of four literals is
// worse than the cycle either duplicate was solving. See claim-labels.mjs's own header for the full story.
import { READY_LABEL, CLAIM_LABEL, STARTED_LABEL } from "./claim-labels.mjs";

export const EXIT = { DONE: 0, COULD_NOT_CLOSE: 1, CANNOT_ASK: 2, STATUS_NOT_MOVED: 3 };

/**
 * THE EXIT BOTH CLOSE-ROWS PATHS TAKE, PURE (#1299). A row that could not be closed outranks a closed row whose
 * Status did not move, and BOTH are named, never counted. `STATUS_NOT_MOVED` is its own code because "closed,
 * but the board still shows it live" is a different fact from "not closed", with a different repair.
 *
 * ONE DECISION FOR BOTH PATHS, and the dispatch path's `main()` calls it: `worker-capture`'s review of #1357
 * showed the dispatch path's exit 3 lived only in `main()`, where reverting it to `DONE` left the suite green.
 *
 * A BRIDGE UNTIL THE PROJECT IS READABLE (#546): CI's token cannot read the user-owned Project, so every move
 * in CI is refused with the same `NOT_FOUND`, and trunk.yml read FAILURE on every merge while the code was
 * green (run 34769927592, `02ae7420`). When EVERY refusal is `project-unreadable`, the run exits `DONE` with a
 * DEGRADED line naming the rows; ANY other refusal still exits `STATUS_NOT_MOVED`. The cause is classified
 * where the refusal is made (`refusalCause`), never matched in log text here.
 *
 * @param {{ failed: number[], unsettled: import("./settle-closed-status.mjs").Refusal[] }} outcome
 * @param {string} prefix the log prefix -- `CLOSE-ROWS` for the immediate path, `SWEEP` for the backstop
 * @returns {{ code: number, lines: string[] }}
 */
export function closeRowsExit({ failed, unsettled }, prefix) {
  const lines = [];
  if (failed.length) lines.push(`${prefix}: could not close ${failed.length}: ${failed.join(" ")}`);
  const { degraded, other } = unsettledVerdict(unsettled);
  const named = (/** @type {{ row: number }[]} */ refusals) => refusals.map((r) => `#${r.row}`).join(" ");
  if (degraded) {
    lines.push(`${prefix}: DEGRADED -- closed, but Status NOT moved for ${unsettled.length}: ${named(unsettled)} `
      + "-- every refusal was project-unreadable (the token cannot read the Project, #546)");
  } else if (unsettled.length) {
    lines.push(`${prefix}: closed, but Status NOT moved for ${unsettled.length}: ${named(unsettled)} `
      + `-- the board still shows them at a live Status (not project-unreadable: ${named(other)})`);
  }
  if (failed.length) return { code: EXIT.COULD_NOT_CLOSE, lines };
  if (other.length) return { code: EXIT.STATUS_NOT_MOVED, lines };
  return { code: EXIT.DONE, lines };
}

/**
 * WHAT TO DO WITH EACH ROW THE MERGED PR DECLARED -- the whole decision, as one pure function.
 *
 * Separated from the API calls so the four outcomes can be driven directly. A job whose reporting is
 * only exercised through a live merge is one whose reporting is never exercised.
 *
 * #776/#791: `already`'s labels travel too, for the identical reason `close`'s do -- see this file's own
 * header ("GitHub can close a row NATIVELY, before this script ever runs") for why a row here still needs
 * its claim stripped.
 *
 * @param {{ number: number, state: string, labels?: string[] }[]} issues  as GitHub resolved them
 * @returns {{ close: { number: number, labels: string[] }[], already: { number: number, labels: string[] }[], none: boolean }}
 */
export function closurePlan(issues) {
  const close = issues.filter((i) => i.state === "OPEN")
    .map((i) => ({ number: i.number, labels: i.labels ?? [] }));
  const already = issues.filter((i) => i.state !== "OPEN")
    .map((i) => ({ number: i.number, labels: i.labels ?? [] }));
  return { close, already, none: issues.length === 0 };
}

/**
 * #754: which of a row's CURRENT labels a merge-driven close must strip, IN THE SAME ACT as the close --
 * `ready` (it is no longer pickable), `in-progress`/`started` and any `session:*` (the claim is over), so
 * `audit`'s recurring DEBRIS finding -- *"a closed row still carries a pickable/claimed label"* -- stops
 * being PRODUCED by this path rather than being cleared by hand each hour.
 *
 * `was-ready` is DELIBERATELY NEVER in this list. It is a record of what the row WAS, not a claim on it
 * (#703 still carries it correctly, and this must not change that) -- the same distinction
 * `declineRemoveLabels` in `row-claim.mjs` draws for the identical label on a different path.
 *
 * Safe on a row missing any of these: the caller strips only what `currentLabels` actually contains, and
 * `gh issue edit --remove-label` is itself a harmless no-op on a label a row does not carry.
 *
 * @param {string[]} currentLabels
 * @returns {string[]}
 */
export function labelsToStrip(currentLabels) {
  return currentLabels.filter((label) => label === READY_LABEL || label === CLAIM_LABEL
    || label === STARTED_LABEL || label.startsWith("session:"));
}

/** @param {string[]} args */
const gh = (args) => execFileSync("gh", args, { encoding: "utf8" }).trim();

/**
 * Closes one row with the standard sentence. Returns whether it succeeded -- never throws, so the caller
 * can decide what to do next (and, for #754, whether the label strip below should even be attempted).
 * @param {number} n @param {{ prNumber: string, sha: string, repo: string }} ctx
 * @returns {boolean}
 */
function closeOneRow(n, { prNumber, sha, repo }) {
  const sentence = `Closed by the pipeline: PR #${prNumber} merged as \`${sha}\` and declared `
    + `\`Closes #${n}\`.\n\nGitHub does not apply a closing reference when the merge is performed by `
    + `\`github-actions[bot]\` -- measured on #310, #321 and #344 (see #298), where three of three bot `
    + `merges left their rows open while two of two human merges closed theirs. This comment and this `
    + `closure are that step, performed explicitly.\n\nIf the work did not land, reopen and say so on `
    + `the row: \`git show ${sha}\` is what actually merged.`;
  try {
    gh(["issue", "close", String(n), "--repo", repo, "--comment", sentence, "--reason", "completed"]);
    console.log(`CLOSE-ROWS: #${n} CLOSED (PR #${prNumber}, merge ${sha}).`);
    return true;
  } catch (cause) {
    console.log(`CLOSE-ROWS: #${n} COULD NOT CLOSE -- ${cause instanceof Error ? cause.message : cause}`);
    return false;
  }
}

/**
 * #754: strips the row's claim labels IN THE SAME ACT as the close, right after it succeeds -- not a
 * second pass, which is a second thing to remember and the whole reason `audit`'s DEBRIS finding kept
 * coming back. A label-removal failure must NEVER prevent or roll back the close (the close is the point;
 * a row that closed with a stale label is strictly better than one left open because a label edit failed),
 * so this never throws -- it only reports. EXPORTED so `close-rows-sweep.mjs`'s backstop path can call
 * the identical decision rather than re-deriving it -- that file's own header names the rule this follows:
 * "a second copy of that decision is the exact 'fact stated twice' shape this repo keeps paying for."
 * @param {number} n @param {string[]} labels @param {string} repo
 * @param {string} [logPrefix] the immediate path logs `CLOSE-ROWS:`, the sweep logs `SWEEP:` -- callers
 *   must stay distinguishable in the log, the same reason close-rows-sweep.mjs's own header gives for
 *   never reusing `CLOSE-ROWS:` itself: which path did the work is a fact about the pipeline's health.
 */
export function stripClaimLabels(n, labels, repo, logPrefix = "CLOSE-ROWS") {
  const toStrip = labelsToStrip(labels);
  if (toStrip.length === 0) return;
  try {
    gh(["issue", "edit", String(n), "--repo", repo, ...toStrip.flatMap((l) => ["--remove-label", l])]);
    console.log(`${logPrefix}: #${n} stripped ${toStrip.join(", ")}.`);
  } catch (cause) {
    console.log(`${logPrefix}: #${n} closed but COULD NOT STRIP ${toStrip.join(", ")} -- `
      + `${cause instanceof Error ? cause.message : cause}`);
  }
}

/**
 * @typedef {{ closeOne: typeof closeOneRow, strip: typeof stripClaimLabels,
 *   settle: (n: number) => import("./settle-closed-status.mjs").SettleOutcome }} ClosureEffects
 */

/** The effects `applyClosurePlan` performs, each of which reaches GitHub when live. */
const CLOSURE_EFFECTS = /** @type {const} */ (["closeOne", "strip", "settle"]);

/**
 * #1360: THE LIVE SETTLE DEPENDENCIES, DEFINED ONCE. The per-merge path (`liveClosureEffects` below) and the sweep
 * (`close-rows-sweep.mjs`'s `closeOnePr`) both settle with these. Measured before this existed: each built its own
 * inline, and dropping `currentStatus` from the sweep's copy left close-rows-sweep, trunk-sweep and close-rows-on-merge
 * at 49 / 0 -- a caller could lose the whole saving silently. `close-rows-on-merge.test.ts` holds both uses.
 */
export const LIVE_SETTLE_DEPS = Object.freeze({ moveStatus: moveProjectStatus, currentStatus: scopedStatus });

/**
 * THE LIVE EFFECTS, NAMED IN ONE PLACE (#1400). `main()` passes these; a test passes its own. `closeOneRow` is
 * `gh issue close`, `stripClaimLabels` is `gh issue edit`, and `settle` moves a Project 2 Status.
 * @returns {ClosureEffects}
 */
export function liveClosureEffects() {
  return {
    closeOne: closeOneRow, strip: stripClaimLabels,
    settle: (/** @type {number} */ n) => settleClosedStatus(n, LIVE_SETTLE_DEPS),
  };
}

/**
 * Applies a resolved `closurePlan`: strips every already-closed row's claim labels (#776/#791 -- GitHub
 * can close a row NATIVELY, before this script ever runs, so `already` needs the identical strip `close`
 * gets), then closes each still-open row and strips its labels too. Split out of `main` so the WIRING --
 * which rows get closed, which get stripped, and that `already` is never silently skipped -- is
 * unit-testable without a live `gh` call, the same reason `close-rows-sweep.mjs`'s own `closeOnePr` is
 * split out of ITS `main`. The effects are injected so a test can prove call order and arguments.
 *
 * #1400: THE THREE EFFECTS ARE REQUIRED, AND NONE HAS A LIVE DEFAULT. Each used to default to the real one, so a
 * test that injected two reached the third: two tests in `close-rows-on-merge.test.ts` called the LIVE Project 2
 * mover for #677 and #344 on every local run. Measured behind a `gh` shim: 2 board queries and 2 "could not move"
 * lines, with the file still 28 / 0, because `settleClosedStatus` never throws -- so pass/fail could not show it.
 * A missing effect is now refused by name before any effect runs, and `main()` passes `liveClosureEffects()`.
 *
 * @param {{ close: {number:number, labels:string[]}[], already: {number:number, labels:string[]}[] }} plan
 * @param {{ prNumber: string, sha: string, repo: string }} ctx
 * @param {ClosureEffects} effects
 * @returns {{ failed: number[], unsettled: import("./settle-closed-status.mjs").Refusal[] }} rows that could not
 *   be closed, and the refusal for each closed row whose Status did not move (#1299) -- both empty on success
 */
export function applyClosurePlan({ close, already }, ctx, effects) {
  const missing = CLOSURE_EFFECTS.filter((name) => typeof effects?.[name] !== "function");
  if (missing.length > 0) {
    throw new Error(`applyClosurePlan: no ${missing.join(", ")} given -- every effect is required, because a `
      + "defaulted one is a live GitHub call (#1400: tests reached the real Project 2 mover through the one they omitted).");
  }
  const { closeOne, strip, settle } = effects;
  // #1299: the settle answer is READ. A bare `settle(n)` let a run that moved no Status exit DONE.
  /** @type {import("./settle-closed-status.mjs").Refusal[]} */
  const unsettled = [];
  const record = (/** @type {number} */ n) => { unsettled.push(...settle(n).refused); };
  // #776/#791: THE CLOSE is left alone -- re-closing an already-closed row is not this loop's job, and
  // never was. The CLAIM is not: a row that reaches this script already CLOSED is not necessarily one
  // somebody closed by hand days ago -- it may be THIS exact merge, one second earlier (GitHub's own
  // native closing-keyword resolution), and its claim is exactly as stale as a freshly-closed row's.
  for (const { number: n, labels } of already) {
    console.log(`CLOSE-ROWS: #${n} ALREADY CLOSED -- left alone.`);
    strip(n, labels, ctx.repo);
    record(n);
  }

  const failed = [];
  for (const { number: n, labels } of close) {
    const closed = closeOne(n, ctx);
    if (!closed) { failed.push(n); continue; }
    strip(n, labels, ctx.repo);
    record(n);
  }
  return { failed, unsettled };
}

function main() {
  refuseUnknownFlags([], {
    entry: import.meta.url,
    command: "node packages/agent-org/src/close-rows-for-merged-pr.mjs <pr-number>",
  });

  const repo = process.env.GITHUB_REPOSITORY;
  const number = process.argv.slice(2).find((a) => /^\d+$/.test(a));
  if (!repo || !number) {
    console.error("CANNOT ASK: need GITHUB_REPOSITORY and a PR number.\n"
      + "  node packages/agent-org/src/close-rows-for-merged-pr.mjs <pr-number>");
    process.exit(EXIT.CANNOT_ASK);
  }

  const [owner, name] = repo.split("/");
  let issues, sha;
  try {
    // `labels(first:20){nodes{name}}` added for #754 -- the same lookup that already resolves WHICH rows
    // to close also carries WHAT each one is still labelled, so stripping the claim needs no second
    // round trip and reads the row's state at the same instant the close decision was made.
    const query = `{repository(owner:"${owner}",name:"${name}"){pullRequest(number:${number}){`
      + `merged baseRefName mergeCommit{oid} closingIssuesReferences(first:20){nodes{number state `
      + `labels(first:20){nodes{name}}}}}}}`;
    const pr = JSON.parse(gh(["api", "graphql", "-f", `query=${query}`,
      "--jq", ".data.repository.pullRequest"]));
    // Enforced HERE, not only in the workflow's `if:` -- `workflow_dispatch` (#394) takes an arbitrary
    // PR number with no event to gate on, so a manual run against an unmerged PR, or one merged into a
    // branch other than `main`, must refuse the same way the `pull_request` path's own `if:` already
    // does. `close-merged-rows.mjs`'s own header names the risk this closes: "a tool that closed rows
    // automatically would eventually close one whose work did not actually land."
    if (pr.merged !== true) {
      console.error(`CANNOT ASK: #${number} is not merged -- refusing to close rows for a PR whose work `
        + "may not have landed.");
      process.exit(EXIT.CANNOT_ASK);
    }
    if (pr.baseRefName !== "main") {
      console.error(`CANNOT ASK: #${number} merged into \`${pr.baseRefName}\`, not \`main\` -- refusing.`);
      process.exit(EXIT.CANNOT_ASK);
    }
    /** @type {{ number: number, state: string, labels: { nodes: { name: string }[] } }[]} */
    const nodes = pr.closingIssuesReferences.nodes;
    issues = nodes.map((i) => ({
      number: i.number, state: i.state, labels: (i.labels?.nodes ?? []).map((l) => l.name),
    }));
    sha = pr.mergeCommit?.oid ?? "unknown";
  } catch (cause) {
    console.error(`CANNOT ASK: resolving #${number}'s closing references failed -- `
      + `${cause instanceof Error ? cause.message : cause}`);
    process.exit(EXIT.CANNOT_ASK);
  }

  const plan = closurePlan(issues);

  if (plan.none) {
    // NOT a failure, and not silence either. Most PRs declare nothing.
    console.log(`CLOSE-ROWS: #${number} declared NO closing references. Nothing to close.`);
    process.exit(EXIT.DONE);
  }

  const { code, lines } = closeRowsExit(applyClosurePlan(plan, { prNumber: number, sha, repo }, liveClosureEffects()),
    "CLOSE-ROWS");
  for (const line of lines) console.error(line);
  process.exit(code);
}

// The entry guard `merge-guard.mjs` uses: a bare `file://` + argv[1] comparison misreads a path with a
// space in it and a symlinked checkout, and reports the module as imported when it was run.
if (import.meta.url === pathToFileURL(process.argv[1] ? realpathSync(process.argv[1]) : "").href) main();
