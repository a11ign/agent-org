#!/usr/bin/env node
// @ts-check
// command: work-gate -- is there work for any session? One cheap read; a wake order per line when yes.
//
// #912's remaining half. `org-watch.mjs:713-717` states it in its own comment: "READS 2-4 ARE NOT WIRED
// INTO THIS PATH YET ... the `gh` readers that feed them are the remaining half of #912". This is that
// half, and `utilisation`/`queueReport` get their first caller here.
//
// WHY THIS FILE EXISTS AT ALL. Six sessions each held a standing cron and woke every 10-30 minutes to ask
// a question `node` answers in one API call: 672 model turns a day, most of them finding nothing. That
// exhausted a weekly allowance in three days, and the two Codex reviewers hit their own quota the same
// way. THE CLOCK WAS NEVER THE DEFECT -- a tick that costs no tokens can run all day. The defect was that
// the tick WAS a model turn. So this script is the tick, and a model is woken only with the answer
// already in its prompt.
//
// IT COSTS TWO `gh` CALLS. `gh pr list --json number,isDraft,headRefOid,statusCheckRollup,author,comments`
// answers the whole reviewer lane in one (comments included -- that is what makes the verdict question
// free), and one `gh issue list --label ready` answers the engineers'. At two calls it can run every two
// minutes all day inside the rate limit, which is the property the whole design rests on.
//
// THIS SCRIPT DECIDES NOTHING ABOUT WHO IS FREE. It answers "is there work", never "who should take it":
// that needs `herdr agent list`'s `agent_status`, and putting it here would make the gate untestable
// without a running org and unrunnable from CI. `wake.mjs` owns that half; `row-claim.mjs` remains the
// authority on whether a row is actually yours.
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { realpathSync } from "node:fs";
// RELATIVE, not the package specifier -- this must run before any `npm ci`/build, the same constraint
// `org-watch.mjs` and `build-packages.mjs` state at their own imports.
import { refuseUnknownFlags } from "../../worker-fleet/src/cli-flags.mjs";
import { READY_LABEL, CLAIM_LABEL } from "./claim-labels.mjs";
import { verdictAtHead } from "./review-verdict.mjs";
import { newestPerName } from "./newest-check-run.mjs";

/**
 * FOUR STATES, AND THE POLARITY IS DELIBERATE.
 *
 * `0` is QUIET, matching `org-watch`, `stranded-branches` and `merge-guard`. The reason is not symmetry.
 * Under this polarity the predictable misuse -- `if work-gate.mjs; then wake; fi` -- wakes EVERY session
 * on EVERY quiet tick, which is impossible to miss for more than one tick. Under the opposite polarity
 * the same mistake sleeps silently through a rate limit and nobody finds out for ten hours, which is the
 * 2026-09-08 outage this whole design exists to prevent. Choose the polarity whose misuse announces itself.
 *
 * `3` PARTIAL exists because this asks about several lanes at once (ADR 0037). One unreadable lane must
 * not void the other's orders and must not be reported as quiet either: the orders on stdout are real and
 * the lane that could not be read is NAMED on stderr.
 */
export const EXIT = { QUIET: 0, WORK: 1, CANNOT_ASK: 2, PARTIAL: 3 };

/** The causes this gate can emit. `wake.mjs` and the matrix validate against this list, never a copy. */
export const CAUSES = ["draft-awaiting-verdict", "ready-row-unclaimed"];

/** @param {string[]} args */
const defaultRun = (args) => execFileSync("gh", args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });

/**
 * Open PRs with everything the draft lane needs, in ONE call.
 *
 * `null` MEANS REFUSED, NEVER EMPTY -- `queueReport`'s rule (#1286), and for its reason: a refused `gh`
 * exits non-zero with empty stdout, so a reader that returns `[]` for it reports "nothing is queued" and
 * the org acts on it. Every caller below must keep the two apart.
 * @param {(args: string[]) => string} run
 * @returns {any[] | null}
 */
export function readPrs(run = defaultRun) {
  try {
    const out = run(["pr", "list", "--state", "open", "--limit", "100", "--json",
      "number,isDraft,headRefOid,statusCheckRollup,author,comments,labels"]);
    const parsed = JSON.parse(out);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Open rows carrying `ready`. FILTERED SERVER-SIDE by the label the API already indexes, so this stays
 * one call and this file never spells the literal -- `claim-labels.mjs` owns it (#804).
 * @param {(args: string[]) => string} run
 * @returns {any[] | null}
 */
export function readReadyRows(run = defaultRun) {
  try {
    const out = run(["issue", "list", "--state", "open", "--label", READY_LABEL, "--limit", "100",
      "--json", "number,title,labels"]);
    const parsed = JSON.parse(out);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** @param {any} x @returns {string[]} */
const labelsOf = (x) => (x?.labels ?? []).map((/** @type {any} */ l) => String(l?.name ?? l));

/**
 * Is this PR's CI green enough to be worth a reviewer's turn?
 *
 * A DRAFT WITH A RED CHECK IS THE AUTHOR'S WORK, NOT THE REVIEWER'S -- `reviewer.md`'s lane is a SETTLED
 * draft, and waking a reviewer for a PR whose own tests are failing spends the org's most expensive turn
 * (worktree, acceptance command, re-derived numbers, mutation) on something the author is still moving.
 *
 * PENDING IS NOT GREEN AND NOT RED. A check still running means the answer is not knowable yet; this
 * returns `null` and the caller emits no order, so the next tick asks again. Reading pending as green
 * would wake the reviewer onto a moving head.
 * CALLERS MUST NARROW FIRST with newestPerName: GitHub unions superseded runs into statusCheckRollup, so a
 * raw read answers about every attempt ever made and one cancelled first try reads as a failure --
 * merge-queue.mjs carried that defect until #634, and local/bounded-window-reads refuses it at the read.
 * @param {any[] | null | undefined} rollup the checks, ALREADY narrowed to the newest run per name
 * @returns {boolean | null}
 */
export function checksSettledGreen(rollup) {
  if (!Array.isArray(rollup) || rollup.length === 0) return null;
  const state = (/** @type {any} */ c) => String(c?.conclusion ?? c?.state ?? "").toUpperCase();
  const status = (/** @type {any} */ c) => String(c?.status ?? "").toUpperCase();
  if (rollup.some((c) => status(c) === "IN_PROGRESS" || status(c) === "QUEUED" || status(c) === "PENDING")) {
    return null;
  }
  const bad = ["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE", "ERROR"];
  return !rollup.some((c) => bad.includes(state(c)));
}

/**
 * PURE. The orders the state implies.
 *
 * Every order carries a `causeKey` derivable from GitHub state alone, so re-running this gate produces a
 * BYTE-IDENTICAL order and the waker's ledger can deduplicate it. That is what lets the gate be stateless
 * and run as often as it likes.
 *
 * THE PROMPT CARRIES THE ANSWER, NOT THE QUESTION. "Draft #N at `abc12345` has green checks and no verdict
 * at that head" rather than "check whether there is work" -- a woken turn that has to survey the queue is
 * a tick with extra steps, which is the cost this file exists to remove.
 *
 * @param {{ prs: any[], readyRows: any[] }} state
 * @returns {{session: string, cause: string, subject: string, discriminator: string,
 *            prompt: string, causeKey: string}[]}
 */
export function decide({ prs, readyRows }) {
  const orders = [];

  for (const pr of prs) {
    if (!pr?.isDraft) continue;
    if (checksSettledGreen(newestPerName(pr.statusCheckRollup)) !== true) continue;
    const head = String(pr.headRefOid ?? "");
    if (!head) continue;
    const found = verdictAtHead({
      comments: (pr.comments ?? []).map((/** @type {any} */ c) => ({ body: c?.body ?? "", id: c?.id })),
      head,
      prAuthor: pr.author?.login ?? null,
    });
    // A VERDICT THE OPENER DID NOT ATTRIBUTE COUNTS AS SETTLED HERE, and that is the wake side's default
    // rather than a reading of the comment: `verdictAtHead` returns `byIsAuthor: null` for it and refuses
    // to guess (#1244). Waking anyway would re-prompt a reviewer who has already answered; the cost of
    // being wrong the other way is one author-written verdict going unchallenged, which `ceo`'s spot-check
    // of one verdict in five is the control for.
    const head8 = head.slice(0, 8);

    // A VERDICT IS NOT THE END OF THE WORK, AND READING IT AS ONE LEFT PULL REQUESTS ABANDONED.
    //
    // This used to be `if (found.verdict !== null) continue;` -- a verdict existed, so the gate moved on
    // without ever asking WHAT IT SAID. Measured 2026-09-17, hours after the tick went live: #1640 and
    // #1634 had been green, reviewed and CONVINCED AT HEAD since 2026-09-14, and were still drafts; the
    // gate reported a quiet org across all of it. `agent-practices.md` says a product PR "is marked ready
    // only when the reviewer writes convinced" -- that condition had been met for three days and nothing
    // in the org asks whether it has been ACTED ON.
    //
    // So a settled verdict is a state with its own next step, and both go to `product-manager`, whose
    // brief names exactly this: first reader for "the queue and process ... promotions, claim reports,
    // merge close-outs". The PR's author field cannot route either one -- every PR here is opened by the
    // shared `a11ign-ai-workers` account, so there is no session in it to wake.
    if (found.verdict === "convinced" && pr.isDraft) {
      orders.push({
        session: "product-manager",
        cause: "draft-convinced-not-ready",
        subject: `pr-${pr.number}`,
        discriminator: head8,
        prompt: `Draft #${pr.number} at \`${head8}\` is green and carries a CONVINCED verdict`
          + `${found.by ? ` from ${found.by}` : ""}, and is still a draft. Per agent-practices a product `
          + "PR is marked ready once the reviewer is convinced. Mark it ready for review, or say on the PR "
          + "why it must stay a draft -- an unexplained convinced draft is work nobody is finishing.",
        causeKey: `product-manager/draft-convinced-not-ready/pr-${pr.number}/${head8}`,
      });
      continue;
    }
    if (found.verdict === "not-convinced") {
      orders.push({
        session: "product-manager",
        cause: "verdict-not-convinced",
        subject: `pr-${pr.number}`,
        discriminator: head8,
        prompt: `#${pr.number} at \`${head8}\` carries a NOT CONVINCED verdict`
          + `${found.by ? ` from ${found.by}` : ""} and nothing has moved since. Read the verdict, decide `
          + "whether it stands, and route the rework to the session holding that row -- or close the PR if "
          + "the row was wrong. A refused verdict nobody answers is a pull request that never lands.",
        causeKey: `product-manager/verdict-not-convinced/pr-${pr.number}/${head8}`,
      });
      continue;
    }
    // Any other settled verdict (`unrecognised`, or one the opener did not attribute) is left alone, for
    // the reason stated above: re-prompting a reviewer who has already answered costs more than waiting.
    if (found.verdict !== null) continue;
    // ODD/EVEN PARITY IS THE ORG'S OWN SPLIT (`.claude/rules/agent-practices.md`): odd PR numbers go to
    // `reviewer`, even to `reviewer-2`. Stated there, applied here, spelled in neither twice.
    const session = Number(pr.number) % 2 === 1 ? "reviewer" : "reviewer-2";
    orders.push({
      session,
      cause: "draft-awaiting-verdict",
      subject: `pr-${pr.number}`,
      discriminator: head8,
      prompt: `Draft #${pr.number} at \`${head8}\` has settled green checks and no verdict at that head. `
        + "Review it per packages/agent-org/docs/roles/reviewer.md and leave one comment carrying your verdict.",
      causeKey: `${session}/draft-awaiting-verdict/pr-${pr.number}/${head8}`,
    });
  }

  // UNCLAIMED IS `ready` WITHOUT `in-progress`. This is a CANDIDATE, not a grant: `row-claim.mjs` is the
  // authority and the woken engineer runs it. A gate that claimed rows would be a second writer of the
  // claim state, which is the race #176 already cost this repo once.
  const unclaimed = readyRows.filter((r) => !labelsOf(r).includes(CLAIM_LABEL));
  if (unclaimed.length > 0) {
    const rows = unclaimed.map((r) => `#${r.number}`).join(", ");
    // NO SESSION NAMED. Which engineer takes it depends on who is idle RIGHT NOW, which only
    // `herdr agent list` knows -- so the order names the lane and `wake.mjs` picks the body.
    orders.push({
      session: "engineers",
      cause: "ready-row-unclaimed",
      subject: `rows-${unclaimed.map((r) => r.number).sort((a, b) => a - b).join("-")}`,
      discriminator: String(unclaimed.length),
      prompt: `${unclaimed.length} Ready row(s) unclaimed: ${rows}. Claim the oldest with `
        + "`node packages/agent-org/src/row-claim.mjs claim <n> --session=<you> --branch=agent/<slug>-<n> --worktree=../wt-<n>` and build it there.\n"
        // BOTH FLAGS OR NEITHER, and the primary refuses the work entirely: `row-claim` creates the
        // worktree from `--branch` AND `--worktree` together and refuses when given only one, and the
        // tooling will not run from the primary checkout at all. The first engineer woken by this
        // system (2026-09-17) stopped and asked a human for both facts, because the order named
        // neither -- so they are named here rather than left to a role brief the session may not have
        // read yet. `../wt-<n>` is the sibling convention every live worktree on the host follows.
        + "The claim creates that worktree for you; run the command from the primary checkout, then do all "
        + "the work inside the new worktree rather than the primary.",
      causeKey: `engineers/ready-row-unclaimed/${unclaimed.map((r) => r.number).sort((a, b) => a - b).join("-")}`,
    });
  }

  return orders;
}

function main() {
  refuseUnknownFlags([], { entry: import.meta.url, command: "node packages/agent-org/src/work-gate.mjs" });
  const prs = readPrs();
  const readyRows = readReadyRows();

  // BOTH LANES REFUSED IS `CANNOT_ASK`; ONE IS `PARTIAL`. Nothing here may report a refused read as quiet.
  if (prs === null && readyRows === null) {
    process.stderr.write("CANNOT ASK: neither the pull-request list nor the Ready rows could be read. "
      + "Nothing was examined -- this is NOT a quiet queue, and no session has been woken.\n");
    process.exit(EXIT.CANNOT_ASK);
  }

  const orders = decide({ prs: prs ?? [], readyRows: readyRows ?? [] });
  for (const order of orders) process.stdout.write(`${JSON.stringify(order)}\n`);

  if (prs === null || readyRows === null) {
    process.stderr.write(`PARTIAL: could not read ${prs === null ? "the pull-request list" : "the Ready rows"}. `
      + `The ${orders.length} order(s) above are real; that lane was NOT examined and may hold work.\n`);
    process.exit(EXIT.PARTIAL);
  }
  process.exit(orders.length > 0 ? EXIT.WORK : EXIT.QUIET);
}

if (import.meta.url === pathToFileURL(process.argv[1] ? realpathSync(process.argv[1]) : "").href) main();
