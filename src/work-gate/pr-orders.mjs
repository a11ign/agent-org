// @ts-check
// module: the pull-request orders -- what `work-gate.mjs` says to a session about a PR's own state (#2542)
//
// MOVED OUT OF `work-gate.mjs`, NOT REWRITTEN (#2542, the first split of #928's lever 2a): `draftOrder`,
// `failingChecksOrder`, `settledVerdictOrder`, `requiredWhenRed`, `redOnlyFromHoldOf` and the order builders
// for `pr-green-unarmed`, `pr-review-blocked`, `pr-merge-conflict` and `awaiting-evidence-stale`, with the
// helpers only they use. Sixty-two of 417 merges edited that one file and B4 serialised them; a fix to one
// of these orders now names THIS file in its Region.
//
// THE BOUNDARY: an ORDER BUILDER lives here, and so does a helper whose only callers are in here. A function
// that reads `gh` (`requiredCheckNames`, `readUnarmed`, `readCommitChain`), a helper a family that stayed behind
// also uses (`labelsOf`, `sessionOf`, `checksSettledGreen`, `awaitingEvidence`), and the registries (`CAUSES`,
// `decide`) stay in `work-gate.mjs` and are IMPORTED from it, never copied. That import is a cycle with the
// entry point; it is safe only while NOTHING in this file reads an imported binding at load time, so a
// top-level `const` here must never be computed from one (`AWAITING_EVIDENCE_QUIET_MS` stayed behind for
// exactly that reason: it multiplies `HOUR_MS`).
//
// `work-gate.mjs` re-exports every name this file exports that it exported before, so a caller of the gate
// is unchanged. Imports below are relative and leaf-shaped, the property the gate's own header states.
import { newestPerName } from "../newest-check-run.mjs";
import { parityOwner } from "../review-attribution.mjs";
import { NO_VERDICT } from "../merge-guard/checks-rule.mjs";
import { armabilityOf, holdersOf, HOLD_PREFIX } from "../pr-hold-state.mjs";
import { REPO } from "../../../../scripts/repo-identity.mjs";
import { labelsOf, sessionOf, checksSettledGreen, conclusionOf, stillRunning, anyChecksRed, requiredCheckNames,
  blockingChecks, reviewableHead, verdictAmong, awaitingEvidence, AWAITING_EVIDENCE_LABEL,
  AWAITING_EVIDENCE_QUIET_HOURS, AWAITING_EVIDENCE_QUIET_MS, HOUR_MS } from "../work-gate.mjs";

/**
 * PURE. Is every red among these blocking checks a CANCELLED one, while something else on the head still runs?
 *
 * #1916, #1007's shape a second time. `checks-rule.mjs` ruled in #1007 that a cancelled run is NO VERDICT -- the
 * replacement is already going -- and this file kept its own copy of the predicate without that ruling. Measured
 * on #1914 at `63b11ecc` and #1924 at `c0864658`, 2026-09-22: two `ci` runs fired on one head a second apart,
 * `cancel-in-progress` killed the first, and the required `gate` existed ONLY in the cancelled run while the live
 * run's `ts / run` was still going. `newestPerName` had nothing newer to choose, so the gate sent
 * `pr-checks-failing` to an author whose PR went `CLEAN` minutes later.
 *
 * ONLY WHILE SOMETHING ELSE STILL RUNS. A cancelled check that is genuinely the last word held #1605 BLOCKED;
 * with nothing in flight on the head it is still settled red and still reaches its author, never silence.
 * `NO_VERDICT` is IMPORTED: the rollup spells it in upper case, the REST read in lower (`update-branch-sweep.mjs`
 * #1100), and the concept is one ruling either way.
 *
 * @param {any[]} blocking the blocking checks, narrowed @param {any[]} head every check on the head, narrowed
 */
export function redOnlyBySupersededRun(blocking, head) {
  const red = blocking.filter((c) => checksSettledGreen([c]) === false);
  return red.length > 0 && red.every((c) => conclusionOf(c) === NO_VERDICT.toUpperCase()) && head.some(stillRunning);
}

/**
 * PAID ONLY BY A RED TICK. A healthy queue never asks what is required, so the UNCONDITIONAL read count
 * is unchanged -- see `GH_READS` for what that count actually is, and for the correction that had to be
 * made to this very comment.
 *
 * (Extracted from `main`, which reached `complexity` 17 with the ternary inline -- the same seam the
 * dead man's switch took, and for the same reason: `main` is about delivering what the gate found.)
 *
 * @param {any[]} prs
 */
export function requiredWhenRed(prs) {
  return anyChecksRed(prs) ? requiredCheckNames() : null;
}

/**
 * #2209: ONE ORDER PER CONFLICTED PULL REQUEST, ADDRESSED TO ITS AUTHOR -- and never to `product-manager`
 * when the pull request names one.
 *
 * THE FIX FOR THIS BLIND SPOT IS NOT AN EXCLUSION. Removing a `DIRTY` pull request from
 * `shouldBeMerging` and reporting it nowhere is strictly worse than the state the row found, where
 * `pr-green-unarmed` at least reached somebody, wrongly. A conflict is CODE WORK -- a rebase, with
 * judgment about which side of each hunk wins -- so it belongs to the session on the PR's `session:`
 * label, exactly as `failingChecksOrder` and `notConvincedOrder` route theirs. With no label it falls back
 * to `product-manager`, the queue's first reader, who can find out whose it is.
 *
 * PER PULL REQUEST AND NOT ONE ORDER FOR THE SET, unlike `greenUnarmedOrders`: a credential outage strands
 * every open PR at once and one order shows the shape, but a conflict is one author's one branch, and a set
 * order would wake somebody about work that is not theirs. The `causeKey` carries the head, so a push that
 * did not clear the conflict is a new question and a push that did leaves the set.
 *
 * `arm-pr.mjs` IS NOT OFFERED and the prompt says so: `auto-arm-sweep.mjs` records that `gh pr merge
 * --auto` "exits non-zero for a merged PR, an unmergeable one and a network fault alike", so the remedy
 * `pr-green-unarmed` hands over cannot succeed on this state.
 *
 * @param {any[]} conflicted from `conflictedPrs`
 * @returns {{session: string, cause: string, subject: string, discriminator: string,
 *            prompt: string, causeKey: string}[]}
 */
export function mergeConflictOrders(conflicted) {
  return conflicted.map((pr) => {
    const owner = sessionOf(pr);
    const session = owner ?? "product-manager";
    const head8 = String(pr.headRefOid ?? "").slice(0, 8) || "no-head";
    return {
      session,
      cause: "pr-merge-conflict",
      subject: `pr-${pr.number}`,
      discriminator: head8,
      prompt: `#${pr.number} at \`${head8}\` is green on every required check and NOT held, and it `
        + "CONFLICTS with `main`: GitHub reports it cannot merge as it stands, whatever its review "
        + "decision or arming.\n"
        + `${owner ? "It carries your session label, so the rebase is yours." : "It names no session, so find whose it is."} `
        + "Merge or rebase `main` into the branch, resolve the conflicts, re-run the gate and push.\n"
        + "DO NOT ARM IT: `gh pr merge --auto` exits non-zero for an unmergeable pull request, so "
        + "`arm-pr.mjs` cannot succeed here. Until this is resolved it is also holding every Ready row "
        + "that shares a file with it (B4) -- #2203 held six.",
      causeKey: `${session}/pr-merge-conflict/pr-${pr.number}/${head8}`,
    };
  });
}

/**
 * ONE ORDER NAMING EVERY GREEN, UNHELD, UNARMED PULL REQUEST -- #1969, and the report that did not exist.
 *
 * WHAT IT IS FOR. `queue-stalled.mjs` names every ARMED, green PR that cannot merge. Nothing named a
 * green, unheld, UNARMED one, and that is the exact state a refused arming credential produces: measured
 * 2026-09-22, #1958 and #1949 were approved, convinced, green on every job and `MERGEABLE` for 28
 * minutes with nothing in the repository able to arm either, because BOTH things that arm -- `arm` and
 * `sweep` -- read the one refused credential. They were found because a session was woken about an
 * unrelated red check and read the log.
 *
 * THE WATCHER MUST NOT SHARE THE CREDENTIAL IT WATCHES, which is `ceo`'s first constraint and the reason
 * this lands here rather than in `auto-arm.yml`. `stalled` is the standing proof of the failure: it ran
 * green throughout the outage, on the same six runs, because it asks a question the dead credential was
 * not needed for. This gate runs on the agent host under the host's own `gh` identity -- measured
 * 2026-09-23 as `a11ign-ai-workers`, while the arming PAT belongs to `DanBeckDev` (user ID 46429371, the
 * account the outage named) -- so a pool that kills arming leaves this reader alive. It never reads
 * `A11IGN_BOT_TOKEN`; that secret exists only inside Actions.
 *
 * DATA AND NOT A RED CHECK, which is `ceo`'s second constraint. A repo-wide fact charged to whichever
 * PR's event fired is #1970's defect one file over; here it is an order with a named audience.
 *
 * ONE ORDER FOR THE SET, NOT ONE PER PULL REQUEST, and this is the case where `rowOrders`'s lesson
 * inverts. A credential outage strands EVERY open PR at once, so per-PR orders would wake every session
 * in the org to hand-arm one pull request each, and none of them would see the shape. The set is also
 * what makes the cause self-clearing: keyed on the SET (`fleetBatchOrders`'s rule), it fires when the
 * membership changes and stays quiet while it does not -- a count would collide two different pairs.
 *
 * `product-manager` BECAUSE THE ROUTING RULE SAYS SO: first reader for "the queue and process ... merge
 * close-outs". Arming by hand under another account's token is `auto-arm.yml`'s own documented exception
 * for a PR auto-arm never armed, and it is a queue act rather than the author's code work.
 *
 * @param {number[] | null} unarmed `null` when the queue read was refused -- no order, never a false all-clear
 * @returns {{session: string, cause: string, subject: string, discriminator: string,
 *            prompt: string, causeKey: string}[]}
 */
export function greenUnarmedOrders(unarmed) {
  if (unarmed === null || unarmed.length === 0) return [];
  const key = unarmed.join(".");
  return [{
    session: "product-manager",
    cause: "pr-green-unarmed",
    subject: "pr-green-unarmed",
    discriminator: key,
    prompt: `${unarmed.length} pull request(s) are green on every required check, NOT held, and NOTHING `
      + `HAS ARMED THEM: ${unarmed.map((n) => `#${n}`).join(", ")}.\n`
      + "This is the state a refused arming credential produces, and it is invisible everywhere else: "
      + "`queue-stalled.mjs` names armed PRs that cannot merge, and a green unarmed one is the mirror "
      + "nothing reported until #1969. It is read here with the HOST's identity, never the arming PAT, "
      + "so this order survives the outage it reports.\n"
      + "FIRST ASK WHETHER THE CREDENTIAL IS REFUSING, because one PR unarmed and all of them unarmed "
      + "want different acts: read the newest `arm` job log in `auto-arm.yml` -- since #1969 it prints a "
      + "`SCOPE` line saying whether the refusal is about that one PR or repository-wide, and names the "
      + "minute the pool returns.\n"
      + "REPOSITORY-WIDE: nothing will arm anything until that minute. Arm these by hand with "
      + "`node packages/agent-org/src/arm-pr.mjs --pr=<n> --repo=" + REPO + "` under an identity whose "
      + "pool is alive -- the workflow's own documented exception for a PR auto-arm never armed -- and "
      + "say on #1969 that it recurred, with the window.\n"
      + "ONE PR ONLY: it is likelier that PR never got an arming event (opened while conflicting, or "
      + "reopened). Arming it is the same command.\n"
      + "IF A PR HERE SHOULD NOT MERGE, the answer is a `hold:` label or a `session:` label on the PR "
      + "itself -- both are read by the same predicate this order used, so it leaves this set at once. A "
      + "PR you merely skip stays in the set and this order returns unchanged.",
    causeKey: `product-manager/pr-green-unarmed/${key}`,
  }];
}

/**
 * #2084: ONE ORDER NAMING EVERY GREEN, UNHELD PULL REQUEST THAT GITHUB'S REVIEW REQUIREMENT IS HOLDING.
 *
 * THE BLIND SPOT, AND IT IS THE LAST ONE IN THIS FAMILY. `pr-checks-failing` names a red PR,
 * `pr-green-unarmed` names a green one nothing armed, and `queue-stalled.mjs` names an armed one that
 * cannot merge -- and NONE of them can see a pull request that is green, unheld, armed, and refused by
 * GitHub's own `reviewDecision`. Measured 2026-09-23: #2049 sat in exactly that state for over seven hours
 * on a stale `CHANGES_REQUESTED` posted at a head the author had already fixed, and every org read
 * returned green-and-armed. Measured again at `468a74f1b` while this was being built: #2198, opened ready
 * at 17:39:37Z with ZERO reviews, `mergeStateStatus: BLOCKED`, `reviewDecision: REVIEW_REQUIRED`, armed --
 * and `decide` returned no order of any kind for it.
 *
 * THAT SECOND READING IS THE MEASUREMENT THE ROW ASKED FOR, AND IT SETTLES A QUESTION IT LEFT OPEN.
 * #2084 says of this done-when that "done-when 1 removes most of the need for it". It does not. #2198 has
 * NO REVIEW TO DISMISS -- it is a docs-and-tests PR, which `agent-practices.md` says opens READY rather
 * than as a draft, so the reviewer lane never sees it: until #2176 `draftOrder` returned `null` on its first
 * line for anything that is not a draft. Dismissing stale reviews cannot reach a pull request that has none. The
 * two halves of this row are therefore NOT the same fact stated twice, and the evidence is one PR that
 * neither half alone would have found.
 *
 * `product-manager`, AND ONE ORDER FOR THE SET -- `greenUnarmedOrders`' shape, for its reasons and one
 * more. The routing rule makes `product-manager` first reader for "the queue and process", and
 * `agent-practices.md` already gives it this exact act: "a draft with no verdict 30 minutes after the
 * author's prompt is reported to `product-manager`, who re-prompts once and then tells `ceo`". So this
 * cause needs no new reviewer-prompting machinery -- it hands an existing owner a state they could not
 * previously see. #2084 warned against building the reviewer half without measuring the remainder, and
 * routing to the reader whose brief already covers re-prompting is how that warning is honoured rather
 * than argued with.
 *
 * KEYED ON THE SET WITH EACH DECISION IN IT, AND DELIBERATELY NOT ON THE HEAD. A head in the key would
 * re-fire on every push, which during a rework is every few minutes; the STATE is what has to change
 * before the question is a new one. This also makes the key the row's own diagnosis in one string: with
 * `dismiss_stale_reviews: false` a push leaves `CHANGES_REQUESTED` standing, so the key does not move and
 * `product-manager` is not re-woken about an unchanged refusal -- and once it is `true`, that same push
 * dismisses the review, the decision becomes `REVIEW_REQUIRED`, the key moves, and the order fires with
 * the state that now needs a reviewer.
 *
 * @param {{number: number, code: string, why: string}[]} blocked
 * @returns {{session: string, cause: string, subject: string, discriminator: string,
 *            prompt: string, causeKey: string}[]}
 */
export function reviewBlockedOrders(blocked) {
  if (blocked.length === 0) return [];
  const key = blocked.map((b) => `${b.number}:${b.code}`).join(".");
  return [{
    session: "product-manager",
    cause: "pr-review-blocked",
    subject: "pr-review-blocked",
    discriminator: key,
    prompt: `${blocked.length} pull request(s) are green on every required check and NOT held, and `
      + "GitHub's own `reviewDecision` is holding them:\n"
      + blocked.map((b) => `  #${b.number}  ${b.code} -- ${b.why}`).join("\n") + "\n"
      + "NO QUEUE READ IN THIS REPOSITORY TOUCHED THIS FIELD BEFORE #2084 -- only `row-claim`'s own "
      + "claim refusal -- which is why a pull request in this state read as healthy everywhere: #2049 "
      + "was green and armed and unmergeable for over seven hours, and no org read could say why.\n"
      + "AWAITING_REVIEW is a PR nobody has reviewed. Since #2176 `draft-awaiting-verdict` covers a READY "
      + "pull request as well as a draft, so its reviewer, `reviewer-<n>` for pull request n, has normally "
      + "been ordered already (and started, if none was live) -- read the wake ledger before prompting: "
      + "`npm run prompt:session -- reviewer-<n> \"#<n> ...\"`. A `QUEUED` exit 2 is delivery; do not "
      + "retry it.\n"
      + "REFUSED is a reviewer's `CHANGES_REQUESTED`, and it does NOT clear by being pushed past. Decide "
      + "whether it stands: rework belongs to the session on the PR's `session:` label, and a newer "
      + "review is the only thing that lifts it.\n"
      + "A REFUSAL AT A HEAD THE AUTHOR HAS ALREADY FIXED IS THE #2084 SHAPE -- compare the review's "
      + "commit against `headRefOid` before routing rework nobody owes.\n"
      + "IF A PR HERE SHOULD NOT MERGE, a `hold:` label removes it from this set at once, read by the "
      + "same predicate this order used. One you merely skip stays in the set.",
    causeKey: `product-manager/pr-review-blocked/${key}`,
  }];
}

/**
 * The two jobs a `hold:` label turns red, and nothing else does: `deliberateRefusals` refuses a held pull
 * request on purpose (`merge-guard.mjs --ci-gate`, "IS HELD by ..."), and `gate` is red only because it
 * `needs` it. Named here rather than read off the job so the gate stays a script that runs before any build.
 */
export const HOLD_RED_JOBS = ["deliberateRefusals", "gate"];

/**
 * PURE. Is this pull request red ONLY because its addressee holds it?
 *
 * A HOLD IS AN ANSWER (#2400), and it was read as an unanswered question. #2376 carried
 * `hold:product-manager` on purpose until a Windows run was recorded; the hold made `deliberateRefusals` red and
 * `gate` with it, and the order that asks `product-manager` to fix the cause was delivered 35 times to the very
 * session that had placed the hold and answered "nothing to fix" each time. `MAX_DELIVERIES` then labelled the PR
 * `needs:chairman`, and clearing the label did not hold: the order was still emitted, so the count stayed at the
 * cap and the breaker re-added it (`escalateStuck` reads only what `deliver` sees, so an order never emitted can
 * never escalate -- which is why the fix is here and not in `wake.mjs`).
 *
 * TWO KEYS, AND BOTH MUST HOLD. (1) Every settled-red job on the head is one of `HOLD_RED_JOBS`. It reads
 * `head`, not the blocking set: with `gate` the only required check the blocking set is `[gate]` whatever else is
 * red, so a real `ts / run` failure would have read as the hold's own. (2) The hold is the ADDRESSEE's own
 * (`hold:<session>`): a hold by somebody else is not an answer from the session being asked, so the order still
 * goes. THE EXEMPTION ENDS WITH EITHER KEY: remove the hold or let a third job go red and the order is emitted
 * again, and the run of deliveries it earned while suppressed starts from nothing (`endedRuns` writes `RESET` for
 * the key that stopped being emitted).
 *
 * WHAT IT CANNOT SEE: `deliberateRefusals` also carries #549's `Closes` comparison, and a rollup names the JOB, not
 * the step. A held PR whose body ALSO declares the wrong `Closes` is red for two reasons and silent about one of
 * them until the hold is released, when the refusal reappears with nothing else red.
 *
 * @param {any} pr @param {any[]} onHead every check on the head, narrowed @param {string} session the addressee
 */
function redOnlyFromHoldOf(pr, onHead, session) {
  if (!holdersOf(labelsOf(pr)).includes(`${HOLD_PREFIX}${session}`)) return false;
  const red = onHead.filter((c) => checksSettledGreen([c]) === false);
  return red.length > 0 && red.every((c) => HOLD_RED_JOBS.includes(String(c?.name ?? c?.context)));
}

/**
 * A pull request whose checks have SETTLED RED, and nobody is fixing it.
 *
 * THE THIRD BLIND SPOT, and the one where work actually dies. Found 2026-09-17 by the chairman looking at
 * a queue the gate called quiet: #1650 sat `mergeStateStatus: BLOCKED` on a failing `changeset` check --
 * a trivial, entirely fixable process failure -- while `worker-capture`, the session named on its own
 * label, sat idle. The gate asked whether a draft needed a verdict and whether a row needed claiming, and
 * both were honestly no. A red build is neither, so nothing asked about it and nothing ever would have.
 *
 * `checksSettledGreen` already answered this: `false` means SETTLED AND RED, distinct from `null` for
 * still-running. Reading only `=== true` and discarding `false` threw the answer away, the same shape as
 * the verdict bug one function below.
 *
 * DRAFTS COUNT TOO. A red draft is not "not ready yet" -- it is a branch whose author stopped, and it
 * will never earn a verdict because the reviewer lane requires green.
 *
 * THE PROMPT CARRIES A FACT AND MAKES NO JUDGMENT (#2117). `baseTip` changes only the words -- never
 * whether the order is sent, to whom, or under which key -- so it can excuse no genuine red. See
 * `failingChecksPrompt`.
 *
 * @param {any} pr @param {string[] | null} [required] @param {{sha: string, date: string} | null} [baseTip]
 */
function failingChecksOrder(pr, required = null, baseTip = null) {
  // ONLY A CHECK THAT CAN HOLD THE PULL REQUEST COUNTS AS RED. A settled-red job outside the required
  // set is a real failure and somebody's problem -- it is not THIS pull request being blocked, and
  // waking its session to "fix the cause on that branch" is a prompt spent on a PR that merges anyway.
  const onHead = newestPerName(pr.statusCheckRollup ?? []);
  const blocking = blockingChecks(onHead, required);
  if (checksSettledGreen(blocking) !== false) return null;
  if (redOnlyBySupersededRun(blocking, onHead)) return null;
  const head = String(pr.headRefOid ?? "");
  if (!head) return null;
  const head8 = head.slice(0, 8);
  // ITS OWN SESSION FIRST. Falling back to `product-manager` rather than dropping the order: an unlabelled
  // red PR is still a stalled PR, and the queue's first reader can find out whose it is.
  const session = sessionOf(pr) ?? "product-manager";
  if (redOnlyFromHoldOf(pr, onHead, session)) return null;
  return {
    session,
    cause: "pr-checks-failing",
    subject: `pr-${pr.number}`,
    discriminator: head8,
    prompt: failingChecksPrompt({ pr, head8, blocking, baseTip }),
    causeKey: `${session}/pr-checks-failing/pr-${pr.number}/${head8}`,
  };
}

/**
 * The words of a `pr-checks-failing` order: when the failing run started, whether `main` has moved since,
 * and the question that decides the fix (#2117).
 *
 * TWO REGIMES WITH OPPOSITE REMEDIES, and this prompt names both and picks neither. A run that tested a
 * `main` since fixed (its merge ref computed against the old one) needs a PUSH or `update-branch` --
 * `gh run rerun` reuses the same merge ref and cannot clear it. A run that could not ASK (the rate-limit
 * `arm` regime) needs `gh run rerun`, and there is nothing to push. Same red; what tells them apart is
 * whether the failing assertion names a defect or a refusal. #2087 (2026-09-23) cost two sessions a cycle
 * each, and they reached opposite readings of one PR.
 *
 * @param {{pr: any, head8: string, blocking: any[], baseTip: {sha: string, date: string} | null}} facts
 */
function failingChecksPrompt({ pr, head8, blocking, baseTip }) {
  return `#${pr.number} at \`${head8}\` has FAILING checks and is blocked. `
    + `${sessionOf(pr) ? "It carries your session label, so it is yours to fix." : "It names no session."} `
    + `${baseMovedSentence(failingRunStartedAt(blocking), baseTip)} `
    + "WHICH FIX is decided by what the failing assertion names, and this order does not choose: "
    + "(a) a real defect on your branch -- fix it and push; "
    + "(b) a run that tested a `main` since fixed (a stale merge ref) -- a PUSH or `update-branch`, because "
    + "`gh run rerun` reuses the same merge ref and cannot clear it; "
    + "(c) a check that could not ASK (a rate-limit or other refusal, no defect at all) -- `gh run rerun`, "
    + "there is nothing to push. Read the failing job to see which.";
}

/**
 * When the newest failing blocking check started, or `null`. THE LATEST, not the earliest: "main moved
 * since" is then true of EVERY red check, so the sentence never overstates. `checksSettledGreen([c])`
 * is `false` for exactly the settled-red ones.
 *
 * @param {any[]} blocking
 * @returns {string | null}
 */
function failingRunStartedAt(blocking) {
  const started = blocking.filter((c) => checksSettledGreen([c]) === false)
    .map((c) => String(c?.startedAt ?? "")).filter((t) => Number.isFinite(Date.parse(t)));
  return started.sort((a, b) => Date.parse(a) - Date.parse(b)).at(-1) ?? null;
}

/**
 * The one sentence of fact. Three unknowns stay UNKNOWN rather than collapsing to "has not moved": absence
 * of a start time or of a tip is not evidence that `main` stood still.
 *
 * @param {string | null} startedAt @param {{sha: string, date: string} | null} baseTip
 */
function baseMovedSentence(startedAt, baseTip) {
  if (startedAt === null) {
    return "The failing check carried no start time, so whether `main` has moved since it ran is UNKNOWN.";
  }
  if (baseTip === null) {
    return `The failing run started at ${startedAt}. Whether \`main\` has moved since was NOT READ this tick, `
      + "so it is UNKNOWN, not \"no\".";
  }
  const tip = `\`main\`'s tip \`${baseTip.sha.slice(0, 8)}\` is dated ${baseTip.date}`;
  return Date.parse(baseTip.date) > Date.parse(startedAt)
    ? `The failing run started at ${startedAt}; \`main\` has MOVED since (${tip}, after that start), so the `
      + "run may have tested a `main` that no longer exists."
    : `The failing run started at ${startedAt}; \`main\` has NOT moved since (${tip}, no later than that start).`;
}

/**
 * The rework a REFUSED verdict deserves, addressed to whoever holds the pull request.
 *
 * THE GATE ALREADY HOLDS THE LABEL IT WAS ASKING SOMEBODY ELSE TO GO AND READ. This order used to name
 * `product-manager` unconditionally and then tell it to "route the rework to the session holding that
 * row" -- a lookup `sessionOf` performs here, for free, at the moment the order is built, with the whole
 * latency of a second session's turn spent on it. `failingChecksOrder` forty lines up has always done it
 * the other way, and for the same reason. Measured 2026-09-22: 108 UNDELIVERED `product-manager` orders
 * in 90 minutes, and the refusal on #1957 named a surviving mutant at a `file:line` -- there was nothing
 * in it to adjudicate (#2001).
 *
 * THE CAUSEKEY MOVES WITH THE SESSION, and that is the half of this worth a test. `causeKey` is the wake
 * ledger's dedupe key; a hard-coded `product-manager/` prefix in front of a session that now varies keys
 * two different sessions' orders to the same string, so the second one is swallowed as a repeat.
 *
 * THE DECISION SEAM IS KEPT RATHER THAN REMOVED, which is why the prompt branches instead of only the
 * address. Asking an author to "decide whether it stands" is asking them to adjudicate a refusal of their
 * own work; so with an owner, REWORK is the default and a DISPUTE is the escalation, and the escalation
 * goes back to `product-manager` exactly as before. With no `session:` label both the lookup and the
 * decision are genuinely `product-manager`'s, and that prompt is unchanged.
 *
 * @param {any} pr @param {{verdict: string | null, by: string | null,
 *        byIsAuthor: boolean | null}} found @param {ReviewHeads} heads
 */
function notConvincedOrder(pr, found, { head8, keyHead8 }) {
  const owner = sessionOf(pr);
  const session = owner ?? "product-manager";
  const from = found.by ? ` from ${found.by}` : "";
  const prompt = owner
    ? `#${pr.number} at \`${head8}\` carries a NOT CONVINCED verdict${from} and it carries your session `
      + "label, so the rework is yours. Read the verdict, fix what it names on that branch and push. If "
      + "you believe the verdict is wrong, that is a DISPUTE rather than rework: say so on the PR and "
      + "product-manager decides."
    : `#${pr.number} at \`${head8}\` carries a NOT CONVINCED verdict${from} and nothing has moved since. `
      + "Read the verdict, decide whether it stands, and route the rework to the session holding that "
      + "row -- or close the PR if the row was wrong.";
  return {
    session,
    cause: "verdict-not-convinced",
    subject: `pr-${pr.number}`,
    discriminator: keyHead8,
    prompt,
    causeKey: `${session}/verdict-not-convinced/pr-${pr.number}/${keyHead8}`,
  };
}

/**
 * Whether a review APPROVED this pull request at the head a verdict may sit at: `true`, `false`, or `null`
 * when the payload never carried `reviews` -- unread, which is NOT "no review" (`readPrs`'s rule, #1286: a
 * missing field never becomes an order). `reviewDecision` IS NOT READ HERE, deliberately (reviewer-2 on #2388):
 * it is PULL-REQUEST-WIDE, and `main` keeps an approval posted at an older head, so it can say APPROVED while
 * nothing approves THIS one -- `reviewStateOf` documents that it is no statement about the head. Reading it
 * as an answer would silence the order for exactly a stale approval, so the answer comes from the reviews'
 * own commit oids. (`pr-review-blocked` keeps reading the field; the two ask different questions.)
 *
 * ANY equivalent head counts, not only the current one: an approval at the authored head is the same work
 * as the merge-from-main after it, exactly as `verdictAmong` treats a verdict.
 * @param {any} pr @param {string[]} heads @returns {boolean | null}
 */
function approvedAtHead(pr, heads) {
  if (!Array.isArray(pr.reviews)) return null;
  return pr.reviews.some((/** @type {any} */ r) =>
    r?.state === "APPROVED" && heads.includes(String(r?.commit?.oid ?? "")));
}

/**
 * #2365: A CONVINCED VERDICT THAT IS ONLY A COMMENT, on a pull request that is not a draft.
 *
 * THE QUESTION `settledVerdictOrder` NEVER ASKED. It answered "is a draft convinced" and returned `null` for
 * a ready pull request, correctly for "flip it ready" -- so a verdict posted as a COMMENT with no review at
 * that head was invisible, and GitHub's `reviewDecision` stayed `REVIEW_REQUIRED` with nothing to say why.
 * Measured 2026-09-24 on #2337: `reviewer-2`'s *convinced (provisional)* at 14:02Z, `/reviews` empty, held
 * until somebody read it by hand. `ceo`'s ruling on #928: the reviewer's typo is not the remedy, the STATE is
 * a gate question. (The comment existed because `pr-review-verdict.sh` refused a malformed first line AFTER
 * `gh pr comment` had posted.)
 *
 * TO THE PARITY REVIEWER, NOT `product-manager`, and that is the difference from `pr-review-blocked`: that
 * order says "nobody has approved" for a SET; this one names a single comment and a remedy that is not a new
 * review round -- re-post it through `pr-review-verdict`.
 *
 * WHICH CAUSE WINS WHEN BOTH APPLY: a DRAFT is `draft-convinced-not-ready`'s, whose next act (flip it ready)
 * comes first, and this function returns `null` for one. Once flipped, the next tick asks this question.
 *
 * NOT HELD, and green (`draftOrder` has already required green): a held pull request is not merging BY
 * DECISION, so an approval nobody wants yet is no defect. Keyed on the AUTHORED head, so update-branch does
 * not re-fire it.
 *
 * @param {any} pr @param {{verdict: string | null, by: string | null, byIsAuthor: boolean | null}} found
 * @param {ReviewHeads} heads
 */
function unreviewedConvincedOrder(pr, found, heads) {
  if (pr.isDraft) return null;
  if (!armabilityOf({ labels: labelsOf(pr) }).arm) return null;
  if (approvedAtHead(pr, heads.all ?? []) !== false) return null;
  const { head8, keyHead8 } = heads;
  const session = parityOwner(pr.number);
  const authored = found.byIsAuthor === true
    ? " That comment is signed by the pull request's own author, so it is not a review of anything: "
      + "review the change first, and post the approval only if it stands."
    : "";
  return {
    session,
    cause: "verdict-comment-unreviewed",
    subject: `pr-${pr.number}`,
    discriminator: keyHead8,
    prompt: `Ready #${pr.number} at \`${head8}\` is green and carries a CONVINCED verdict`
      + `${found.by ? ` from ${found.by}` : ""} as a COMMENT, and no APPROVED review at that head -- `
      + "so GitHub's `reviewDecision` is not APPROVED and it cannot merge. The comment did not become a "
      + "review. Post the approving review with `pr-review-verdict` at the CURRENT head; its first line "
      + `must begin "**Review of #${pr.number} at " or the script refuses (after any comment was posted). `
      + "This is not a new review round: if your verdict stands, re-post it; do not re-read the diff."
      + authored,
    causeKey: `${session}/verdict-comment-unreviewed/pr-${pr.number}/${keyHead8}`,
  };
}

/**
 * The follow-up a SETTLED verdict deserves, or `null` when it deserves none.
 *
 * A VERDICT IS NOT THE END OF THE WORK, AND READING IT AS ONE LEFT PULL REQUESTS ABANDONED. The gate used
 * to say `if (found.verdict !== null) continue;` -- a verdict existed, so it moved on WITHOUT EVER ASKING
 * WHAT IT SAID. Measured 2026-09-17, hours after the tick went live: #1640 and #1634 had been green,
 * reviewed and CONVINCED AT HEAD since 2026-09-14 and were still drafts, and the gate called that a quiet
 * org for three days. `agent-practices.md` says a product PR "is marked ready only when the reviewer
 * writes convinced"; nothing asked whether that had been ACTED ON.
 *
 * `draft-convinced-not-ready` GOES TO `product-manager`, whose brief names exactly this work: first
 * reader for "the queue and process ... promotions, claim reports, merge close-outs". The PR's author
 * cannot be read off the author field -- every PR here is opened by the shared `a11ign-ai-workers`
 * account -- and the gate performs that flip itself anyway, so its order is a fallback and a fallback
 * landing on the queue's first reader is defensible (#2001 deliberately left this one alone).
 * `verdict-not-convinced` no longer does: see `notConvincedOrder`.
 *
 * `draft-convinced-not-ready` IS THE ONE REVIEW CAUSE THAT STAYS DRAFT-ONLY (#2176): it is about flipping a
 * draft ready. A convinced verdict on a pull request that is already ready asks nothing of anybody -- UNLESS
 * it is only a comment (#2365), which `unreviewedConvincedOrder` asks about. `not-convinced` applies to both,
 * because rework is owed whatever state the pull request is in.
 *
 * @param {any} pr @param {{verdict: string | null, by: string | null,
 *        byIsAuthor: boolean | null}} found @param {ReviewHeads} heads
 */
function settledVerdictOrder(pr, found, heads) {
  const { head8, keyHead8 } = heads;
  if (found.verdict === "convinced" && pr.isDraft) {
    return {
      session: "product-manager",
      cause: "draft-convinced-not-ready",
      subject: `pr-${pr.number}`,
      discriminator: keyHead8,
      prompt: `Draft #${pr.number} at \`${head8}\` is green and carries a CONVINCED verdict`
        + `${found.by ? ` from ${found.by}` : ""}, and is still a draft. Per agent-practices a product `
        + "PR is marked ready once the reviewer is convinced. Mark it ready for review, or say on the PR "
        + "why it must stay a draft -- an unexplained convinced draft is work nobody is finishing.",
      causeKey: `product-manager/draft-convinced-not-ready/pr-${pr.number}/${keyHead8}`,
      // THE GATE ALREADY KNOWS THE ANSWER, SO IT DOES THIS ONE ITSELF (see `performActions`). Every
      // condition for a safe ready-flip has been checked by the time we are here: not red, still a
      // draft, checks SETTLED green, and a convinced verdict AT THIS HEAD. The order stays attached as
      // the FALLBACK -- if `gh pr ready` fails, `product-manager` is woken exactly as before.
      //
      // `byIsAuthor === false` AND NOT `!== true`, deliberately. `verdictAtHead` returns `null` when the
      // opener named nobody (#1244) and refuses to guess, and a self-signed or unattributed verdict is
      // the one case where a human should look. Automating the attributed case and waking on the rest
      // keeps `ceo`'s one-in-five spot-check pointed at the verdicts that can actually be wrong.
      ...(found.byIsAuthor === false ? { action: { kind: "ready", pr: Number(pr.number) } } : {}),
    };
  }
  if (found.verdict === "convinced") return unreviewedConvincedOrder(pr, found, heads);
  if (found.verdict === "not-convinced") return notConvincedOrder(pr, found, heads);
  // Any other settled verdict -- `unrecognised`, or one the opener did not attribute -- is left alone:
  // re-prompting a reviewer who has already answered costs more than waiting for a human to look.
  return null;
}

/**
 * @typedef {{head8: string, keyHead8: string, all?: string[]}} ReviewHeads
 * `head8` is the head a reviewer would be reading; `keyHead8` is the head the ORDER is keyed on -- the last
 * one the AUTHOR produced (#2176). They are the same string unless an update-branch has moved the head.
 * `all` is every full head that update-branches made equivalent, newest first (`reviewChainOf`'s `heads`).
 */

/** GitHub's update-branch headline (`Merge branch 'main' into <branch>`) and a session's own merge of it
 * (`Merge remote-tracking branch 'origin/main'`), which are produced by two different actors. Both are
 * a merge FROM `main`, and neither is work to review. */
const MERGE_FROM_MAIN = /^Merge (?:branch|remote-tracking branch) '(?:origin\/)?main'/;

/**
 * Whether a commit is a merge of `main` into the branch. TWO CONDITIONS: the headline names `main`, AND the
 * commit has two parents when that is known -- so a one-parent commit that merely reuses the words is
 * authored work. THE LIMIT, STATED: this cannot see a tree change, so a merge-from-main whose conflicts
 * were resolved by hand still reads as no new work. `gh` offers no diff on the list call, and a headline
 * is what both actors write; `parents` is absent on fixtures and never blocks the headline test alone.
 *
 * @param {{messageHeadline?: string, parents?: number} | null | undefined} commit
 */
function isMergeFromMain(commit) {
  if (typeof commit?.messageHeadline !== "string" || !MERGE_FROM_MAIN.test(commit.messageHeadline)) return false;
  return typeof commit.parents !== "number" || commit.parents >= 2;
}

/**
 * The heads a reviewer's verdict on this pull request may sit at, NEWEST FIRST, and the last one the AUTHOR
 * produced. `commits` is oldest-first, as the REST list returns it; the authored head is the newest commit
 * that is not a merge of `main`, and every merge after it is the same work at a later sha.
 *
 * `null` when the chain was not read, does not end at `headRefOid` (the list and the chain were read a few
 * seconds apart and a push landed between them), or is all merges -- and the caller then treats the current
 * head as the only head, which is what this gate did before #2176.
 *
 * @param {any} pr @returns {{authored: string, heads: string[]} | null}
 */
function reviewChainOf(pr) {
  const commits = Array.isArray(pr?.commits) ? pr.commits : [];
  const oids = commits.map((/** @type {any} */ c) => String(c?.oid ?? ""));
  if (oids.length === 0 || oids[oids.length - 1] !== String(pr.headRefOid ?? "")) return null;
  let i = commits.length - 1;
  while (i >= 0 && isMergeFromMain(commits[i])) i -= 1;
  if (i < 0) return null;
  return { authored: oids[i], heads: oids.slice(i).reverse() };
}

/**
 * The wording of the re-review order, TRUE OF WHICHEVER STATE THE PULL REQUEST IS IN (#2176). It used to
 * say "Draft" unconditionally, which is a false statement to a reviewer about the ready pull request this
 * cause now reaches.
 * @param {any} pr @param {ReviewHeads} heads
 */
function awaitingVerdictPrompt(pr, { head8, keyHead8 }) {
  const state = pr.isDraft ? "Draft" : "Ready (not a draft)";
  const moved = head8 === keyHead8 ? ""
    : ` The last commit its author pushed is \`${keyHead8}\`; every commit after it merges \`main\`, so review the `
      + "author's work and write your verdict at the head you actually read.";
  return `${state} #${pr.number} at \`${head8}\` has settled green checks and no verdict at that head.${moved} `
    + "Review it per packages/agent-org/docs/roles/reviewer.md and leave one comment carrying your verdict.";
}

/**
 * The one order this pull request deserves right now, or `null`.
 *
 * SPLIT OUT OF `decide` when the two stalled-work causes took it past `complexity` 15 and
 * `local/max-physical-lines-per-function` 90 and the pre-push gate refused it. The split is the honest
 * one rather than a line-count trick: this asks "what does THIS pull request need" and `decide` asks
 * "what does the whole queue need". AT MOST ONE order, because a pull request in two states at once
 * would be a contradiction rather than two jobs.
 *
 * THE REVIEW QUESTION IS ASKED OF EVERY GREEN PULL REQUEST, DRAFT OR NOT (#2176). It used to sit below
 * `if (!pr?.isDraft) return null`, so a pull request that opened READY -- which `agent-practices.md` says
 * docs-and-tests PRs do -- was invisible to review routing: #2104 sat `CHANGES_REQUESTED` and green for
 * 5h47m while 171 other pull requests were ordered about. The draft-only test now lives where it belongs,
 * on `draft-convinced-not-ready` in `settledVerdictOrder`.
 *
 * KEYED ON THE LAST AUTHORED HEAD, because `causeKey` moves with the head and an update-branch is a new
 * head with no new work: extending the read alone would have turned #2104 into a reviewer order every
 * ten minutes. See `reviewChainOf` for the test and its limit.
 *
 * @param {any} pr @param {string[] | null} [required] @param {{sha: string, date: string} | null} [baseTip]
 */
function draftOrder(pr, required = null, baseTip = null) {
  // RED FIRST, and before the green check: a red PR is work whether or not it is a draft, and it can
  // never reach the reviewer lane below, which requires green.
  const red = failingChecksOrder(pr, required, baseTip);
  if (red) return red;
  const head = reviewableHead(pr);
  if (!head) return null;
  const chain = reviewChainOf(pr) ?? { authored: head, heads: [head] };
  const heads = { head8: head.slice(0, 8), keyHead8: chain.authored.slice(0, 8), all: chain.heads };
  const found = verdictAmong(pr, chain.heads);
  // A VERDICT THE OPENER DID NOT ATTRIBUTE COUNTS AS SETTLED, and that is the wake side's default rather
  // than a reading of the comment: `verdictAtHead` returns `byIsAuthor: null` for it and refuses to guess
  // (#1244). Waking anyway would re-prompt a reviewer who has already answered; the cost of being wrong
  // the other way is one author-written verdict going unchallenged, which `ceo`'s spot-check of one
  // verdict in five is the control for.
  if (found.verdict !== null) return settledVerdictOrder(pr, found, heads);
  // #2416: A PULL REQUEST WAITING FOR AN EXTERNAL RUN IS NOT ASKED FOR A VERDICT, and this is the gate's half of
  // the two routes into a review (the author's is a sentence in `org-routing-and-timers.md`). It sits AFTER
  // the settled-verdict read on purpose: a verdict somebody prompted by hand is still read and acted on, so
  // the label removes the MACHINERY's order and never the reviewer's ability to answer, and it sits after the
  // red-checks order because a red build is the author's work whether or not evidence is pending.
  if (awaitingEvidence(pr)) return null;

  // PULL REQUEST n IS `reviewer-<n>`'S (#2401; the odd/even split it replaced is retired). The name is
  // herdr's, and `wake.mjs` starts the instance when none is live. The arithmetic lives in
  // `review-attribution.mjs`, beside the reader that checks whether a posted review obeyed it -- a
  // detector with its own copy would agree with a router that had drifted.
  const session = parityOwner(pr.number);
  return {
    session,
    cause: "draft-awaiting-verdict",
    subject: `pr-${pr.number}`,
    discriminator: heads.keyHead8,
    prompt: awaitingVerdictPrompt(pr, heads),
    causeKey: `${session}/draft-awaiting-verdict/pr-${pr.number}/${heads.keyHead8}`,
  };
}

/**
 * Every order the open pull requests earn: each one's own (`draftOrder`), then the set-wide one for labelled
 * pull requests nobody has explained (#2416).
 * @param {any[]} prs @param {string[] | null} required @param {any} [baseTip]
 */
export function perPullRequestOrders(prs, required, baseTip) {
  const own = prs.map((pr) => draftOrder(pr, required, baseTip)).filter((o) => o !== null);
  return [...own, ...awaitingEvidenceStaleOrders(prs)];
}

/**
 * #2416: ONE ORDER FOR THE SET OF LABELLED PULL REQUESTS THAT HAVE SAID NOTHING FOR 48 HOURS, or none.
 *
 * THE LABEL IS VALID ONLY WITH A STATED EVIDENCE SOURCE, and the statement is a COMMENT after the label was
 * applied -- so "no comment after it was applied" is the reading of "nobody said what this waits on". A
 * comment ANYWHERE after the application counts, and that is deliberate: this asks whether the wait was
 * EXPLAINED, and a stale-but-explained wait is `product-manager`'s to audit through the row, not this cause's
 * to re-ask (a judgment cause is keyed on state, so it is not repeated while the set is unchanged).
 *
 * `awaitingSince` UNREAD, `comments` UNREAD, or a comment whose time cannot be parsed is NEVER an order:
 * absence of a reading is not a reading of absence. Keyed on the SET of numbers and not on the ages, which
 * move every tick and would re-ask a question whose answer has not changed. Ordered to `product-manager`,
 * whose brief names holds and waits, in `greenUnarmedOrders`' one-order-for-the-set shape.
 *
 * @param {any[]} prs @param {number} [now]
 */
export function awaitingEvidenceStaleOrders(prs, now = Date.now()) {
  const stale = prs.filter((pr) => awaitingEvidence(pr) && evidenceWaitUnexplained(pr, now))
    .sort((a, b) => Number(a.number) - Number(b.number));
  if (stale.length === 0) return [];
  const key = stale.map((pr) => pr.number).join(".");
  const lines = stale.map((pr) => `  #${pr.number}  carried \`${AWAITING_EVIDENCE_LABEL}\` for `
    + `${Math.floor((now - Date.parse(pr.awaitingSince)) / HOUR_MS)}h with no comment after it was applied`);
  return [{
    session: "product-manager",
    cause: "awaiting-evidence-stale",
    subject: "awaiting-evidence-stale",
    discriminator: key,
    prompt: `${stale.length} pull request(s) carry \`${AWAITING_EVIDENCE_LABEL}\` and nobody has said what they wait `
      + `on for more than ${AWAITING_EVIDENCE_QUIET_HOURS}h:\n${lines.join("\n")}\n`
      + "The label means the done-when needs an external run whose evidence is not posted yet, and it is valid "
      + "only with that source STATED. WHAT WOULD CLEAR IT: the evidence is posted and the label is removed "
      + "(`gh pr edit <n> --remove-label awaiting-evidence`) -- removing it IS posting the evidence -- or the "
      + "author says on the PR what it waits on and who owns that run. If nobody owns it, the label is hiding a "
      + "stalled PR: route it to the row's owner, or to `orchestrator` when the run is a fleet or lab one. "
      + "It is NOT `blocked`, which has no referent.",
    causeKey: `product-manager/awaiting-evidence-stale/${key}`,
  }];
}

/**
 * Whether a labelled pull request has been quiet since the label went on for longer than the bound.
 * @param {any} pr @param {number} now
 */
function evidenceWaitUnexplained(pr, now) {
  const since = Date.parse(String(pr.awaitingSince ?? ""));
  if (Number.isNaN(since) || !Array.isArray(pr.comments)) return false;
  if (now - since <= AWAITING_EVIDENCE_QUIET_MS) return false;
  return !pr.comments.some((/** @type {any} */ c) => {
    const at = Date.parse(String(c?.createdAt ?? ""));
    return Number.isNaN(at) || at > since;
  });
}