#!/usr/bin/env node
// @ts-check
// command: close the rows every PR merged in the window declared, riding trunk.yml's push and nightly's hourly cron
// #394: A BACKSTOP FOR THE CLOSE-ROWS PATH, WHICH FIRED FOR SOME MERGES AND NOT OTHERS AND NOBODY KNEW WHY.
// #909 (2026-09-12): this is now ALSO the primary path, as trunk.yml's `closeRows` job on every push to main,
// because since #416 merges are PAT merges and fire push; the hourly run in nightly.yml is the backstop.
//
// Measured 2026-09-07: two PRs met every condition `close-rows.yml` needs -- bot merge, base `main`, the
// workflow present in the head, a `Closes #N` GitHub itself resolved, the row open -- and NO run of that
// workflow exists for either. Three mechanisms proposed for the miss were checked and killed by
// measurement, not reasoning (see the issue). `ceo`'s ruling: do not chase the cause, remove the single
// point of failure.
//
// THIS RIDES `trunk.yml`'s EXISTING `push: main` RUN (unit 3), as a second entry into the SAME
// `closurePlan` decision `close-rows-for-merged-pr.mjs` already drives -- imported, never re-derived,
// because a second copy of that decision is the exact "fact stated twice" shape this repo keeps paying
// for. A push to `main` happens on every merge (that IS what triggers `trunk.yml`), which is also
// why this cannot be the ONLY path: the row exists because a trigger cannot be trusted, and `push` is a
// trigger too. Not a schedule, deliberately -- GitHub disables scheduled workflows repository-wide after
// 60 days of inactivity, and a backstop that fails by going quiet has the disease it treats.
//
// IDEMPOTENT BY CONSTRUCTION. The common outcome is `ALREADY CLOSED` -- the immediate `pull_request` path
// already did the work, and this just confirms it -- which is `closurePlan`'s own `already` bucket,
// unchanged from the row it backstops. Running this twice against the same window closes nothing twice.
//
// THE WINDOW IS GENEROUS, NOT TIGHT, and that is deliberate. In the common case the window only needs to
// bridge the gap since the LAST push to `main`, but a push can be swallowed by the identical unexplained
// mechanism this row exists to route around -- so `DEFAULT_WINDOW_MINUTES` is sized to survive a
// TEMPORARY loss of the trigger, not a permanent one: a PR merged during a long quiet gap is caught by
// whenever the next push happens, not by a timer. Measured merge rate the night this was built: 13
// merges in one hour.
//
// SCOPED EXACTLY LIKE close-rows.yml, because it is answering the identical question for a PR the
// immediate path may have missed: `state: merged`, `base: main`, and GitHub's OWN
// `closingIssuesReferences` -- never a regex over a body, never inferred from a commit range. This is
// what keeps the risk `close-merged-rows.mjs`'s own header names ("a tool that closed rows automatically
// would eventually close one whose work did not actually land") from reappearing here: a PR that did not
// merge is not in this list at all, by construction of the `gh pr list --state merged` query below.
//
// REPORTS DISTINCTLY FROM THE IMMEDIATE PATH -- every line here is `SWEEP:`, never `CLOSE-ROWS:`. A row
// closed by the immediate trigger and a row closed by the sweep are different facts about the pipeline's
// health: if the sweep starts doing all the work, that is the signal the `pull_request` trigger has
// degraded, and it must stay visible rather than be absorbed into one undifferentiated log line.
//
// Exit codes are the contract:
//   0  every merged PR in the window is accounted for -- closed here, already closed, or declared nothing --
//      and every closed row's Status settled
//   1  one or more rows could not be closed. NAMED, never counted.
//   2  a lookup failed. INCONCLUSIVE, never "fine".
//   3  every row closed, but one or more Statuses did not move (#1299). NAMED: the board still shows them live,
//      and this is the prescribed repair for tracker-health axis 4, so a 0 here would report it done.
//      EXCEPT when every refusal is `project-unreadable` (the token cannot read the Project, #546): that exits 0
//      with a DEGRADED line naming the rows -- `closeRowsExit`'s bridge, shared with the immediate path.
//
//   node packages/agent-org/src/close-rows-sweep.mjs [--window=<minutes>]
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
// RELATIVE, never the package specifier -- this job runs with `actions/checkout` and nothing else, the
// identical reason close-rows-for-merged-pr.mjs's own header gives (#330/#331).
import { refuseUnknownFlags, flagValue } from "../../worker-fleet/src/cli-flags.mjs";
// #1227: `settleClosedStatus` is imported rather than re-derived, for the reason this file's own header
// gives about `stripClaimLabels`: a second copy of that decision is the "fact stated twice" shape.
import { closurePlan, stripClaimLabels, closeRowsExit, LIVE_SETTLE_DEPS } from "./close-rows-for-merged-pr.mjs";
import { settleClosedStatus } from "./settle-closed-status.mjs";

/** @typedef {import("./settle-closed-status.mjs").Refusal} Refusal */
/** @typedef {import("./settle-closed-status.mjs").SettleOutcome} SettleOutcome */

export const EXIT = { DONE: 0, COULD_NOT_CLOSE: 1, CANNOT_ASK: 2, STATUS_NOT_MOVED: 3 };
export const DEFAULT_WINDOW_MINUTES = 45;

/** @param {string[]} args */
const gh = (args) => execFileSync("gh", args, { encoding: "utf8" }).trim();

/**
 * Every PR merged into `main` within the last `windowMinutes`, via GitHub's own search -- never inferred
 * from a commit range. `gh_` is injectable so this is testable without a live repo.
 * @param {string} repo
 * @param {number} windowMinutes
 * @param {(args: string[]) => string} [gh_]
 * @returns {{ number: number }[]}
 */
export function mergedPrsInWindow(repo, windowMinutes, gh_ = gh) {
  const since = new Date(Date.now() - windowMinutes * 60_000).toISOString();
  const out = gh_(["pr", "list", "--repo", repo, "--state", "merged", "--base", "main", "--limit", "100",
    "--search", `merged:>=${since}`, "--json", "number"]);
  return JSON.parse(out);
}

/**
 * #776/#791: a row GitHub closed natively, before either path ran, still carries its claim and a live Status.
 * Strips the one and settles the other, returning the refusal for each row whose Status did NOT move (#1299).
 * Split out of `closeOnePr` for its complexity budget: the loop is the same act as the just-closed loop below.
 * @param {{ number: number, labels: string[] }[]} already
 * @param {string} repo
 * @param {{ strip: typeof stripClaimLabels, settle: (n: number) => SettleOutcome }} deps
 * @returns {Refusal[]}
 */
function settleAlreadyClosed(already, repo, { strip, settle }) {
  /** @type {Refusal[]} */
  const unsettled = [];
  for (const { number: n, labels } of already) {
    console.log(`SWEEP: #${n} ALREADY CLOSED -- left alone.`);
    strip(n, labels, repo, "SWEEP");
    unsettled.push(...settle(n).refused);
  }
  return unsettled;
}

/**
 * Resolve and act on ONE merged PR's closing plan -- split out of `main` to keep its complexity within this
 * repo's ESLint budget, and EXPORTED with its effects injected so its Status half is driven by a test (#1299).
 * @param {number} number
 * @param {string} repo
 * @param {{ gh_?: (args: string[]) => string, strip?: typeof stripClaimLabels,
 *   settle?: (n: number) => SettleOutcome }} [deps]
 * @returns {{ failed: number[], unsettled: Refusal[] }} rows that could not be closed, and the refusal for each
 *   closed row whose Status did not move -- both empty on success
 */
export function closeOnePr(number, repo, { gh_ = gh, strip = stripClaimLabels,
  settle = (/** @type {number} */ n) => settleClosedStatus(n, LIVE_SETTLE_DEPS) } = {}) {
  const [owner, name] = repo.split("/");
  let issues, sha;
  try {
    // `labels(first:20){nodes{name}}` added for #754, same reason as the immediate path's identical
    // change in close-rows-for-merged-pr.mjs: one lookup carries both what to close and what to strip.
    const query = `{repository(owner:"${owner}",name:"${name}"){pullRequest(number:${number}){`
      + `mergeCommit{oid} closingIssuesReferences(first:20){nodes{number state `
      + `labels(first:20){nodes{name}}}}}}}`;
    const pr = JSON.parse(gh_(["api", "graphql", "-f", `query=${query}`,
      "--jq", ".data.repository.pullRequest"]));
    /** @type {{ number: number, state: string, labels: { nodes: { name: string }[] } }[]} */
    const nodes = pr.closingIssuesReferences.nodes;
    issues = nodes.map((i) => ({
      number: i.number, state: i.state, labels: (i.labels?.nodes ?? []).map((l) => l.name),
    }));
    sha = pr.mergeCommit?.oid ?? "unknown";
  } catch (cause) {
    console.log(`SWEEP: #${number} CANNOT ASK -- ${cause instanceof Error ? cause.message : cause}`);
    return { failed: [number], unsettled: [] };
  }

  const { close, already, none } = closurePlan(issues);
  if (none) {
    console.log(`SWEEP: #${number} declared NO closing references.`);
    return { failed: [], unsettled: [] };
  }
  // #776/#791: the identical fix as close-rows-for-merged-pr.mjs's own already loop -- GitHub can close a
  // row NATIVELY, before either path runs, and its claim is exactly as stale as one this script closes.
  // #1299: SETTLE'S ANSWER IS READ, on both paths. It was a bare statement, so a sweep that moved no Status
  // still reached EXIT.DONE -- the prescribed repair for tracker-health axis 4, reported done while nothing moved.
  const unsettled = settleAlreadyClosed(already, repo, { strip, settle });

  const failed = [];
  for (const { number: n, labels } of close) {
    const sentence = `Closed by the pipeline's sweep: PR #${number} merged as \`${sha}\` and declared `
      + `\`Closes #${n}\`, but the immediate pull_request:closed trigger did not fire for it (#394).\n\n`
      + `If the work did not land, reopen and say so on the row: \`git show ${sha}\` is what actually `
      + "merged.";
    try {
      gh_(["issue", "close", String(n), "--repo", repo, "--comment", sentence, "--reason", "completed"]);
      console.log(`SWEEP: #${n} CLOSED (PR #${number}, merge ${sha}) -- the immediate trigger missed this.`);
    } catch (cause) {
      console.log(`SWEEP: #${n} COULD NOT CLOSE -- ${cause instanceof Error ? cause.message : cause}`);
      failed.push(n);
      continue;
    }
    // #754: the identical decision the immediate path uses, imported rather than re-derived (see this
    // file's own header). "SWEEP" as the log prefix, never "CLOSE-ROWS", for the same reason every other
    // line here is distinguished -- which path did the work is a fact about the pipeline's health.
    strip(n, labels, repo, "SWEEP");
    unsettled.push(...settle(n).refused);
  }
  return { failed, unsettled };
}

/**
 * The sweep's exit: the SAME decision the immediate path takes (`closeRowsExit`), with the sweep's log prefix.
 * Imported rather than restated, for the reason this file's header gives about `closurePlan` (#1299).
 * @param {{ failed: number[], unsettled: Refusal[] }} outcome
 * @returns {{ code: number, lines: string[] }}
 */
export function sweepExit(outcome) {
  return closeRowsExit(outcome, "SWEEP");
}

function main() {
  refuseUnknownFlags(["--window"], { entry: import.meta.url, command: "node packages/agent-org/src/close-rows-sweep.mjs" });

  const repo = process.env.GITHUB_REPOSITORY;
  if (!repo) {
    console.error("CANNOT ASK: GITHUB_REPOSITORY is unset, so there is no repo to sweep.");
    process.exit(EXIT.CANNOT_ASK);
  }
  const windowMinutes = Number(flagValue(process.argv, "window") ?? DEFAULT_WINDOW_MINUTES);

  let prs;
  try {
    prs = mergedPrsInWindow(repo, windowMinutes);
  } catch (cause) {
    console.error(`CANNOT ASK: listing merged PRs failed -- ${cause instanceof Error ? cause.message : cause}`);
    process.exit(EXIT.CANNOT_ASK);
  }

  if (prs.length === 0) {
    console.log(`SWEEP: no PRs merged into main in the last ${windowMinutes}m.`);
    process.exit(EXIT.DONE);
  }
  console.log(`SWEEP: ${prs.length} PR(s) merged into main in the last ${windowMinutes}m: `
    + `${prs.map((p) => p.number).join(" ")}`);

  const outcomes = prs.map(({ number }) => closeOnePr(number, repo));
  const { code, lines } = sweepExit({
    failed: outcomes.flatMap((o) => o.failed), unsettled: outcomes.flatMap((o) => o.unsettled) });
  for (const line of lines) console.error(line);
  process.exit(code);
}

// The entry guard `merge-guard.mjs`/`close-rows-for-merged-pr.mjs` use.
if (import.meta.url === pathToFileURL(process.argv[1] ? realpathSync(process.argv[1]) : "").href) main();
