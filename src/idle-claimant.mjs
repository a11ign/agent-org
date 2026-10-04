// @ts-check
// AN IDLE CLAIMANT THAT DECLARED NO WAIT IS A STALL -- #2999.
//
// Chairman, 2026-10-02: twelve sessions sat idle for hours and each recap named exactly what it waited on ("`product-manager`
// closes the row", "`ceo` releases the hold after T-end"). The recaps sat in terminals nobody reads and NO FIELD WAS SET, because
// the hold "explained" the wait. `claimReading` (#2470) asks whether THE ROW moved for 120 minutes; it does not ask what an IDLE
// holder is waiting for, and it returns `pr-owned` BEFORE any clock for a holder with an open pull request, so a session that waits
// correctly and one that has simply stopped looked identical to it. The measurement is on #2999 (2026-10-02T12:50Z): the existing
// nudge woke three holders in 07:00Z-10:40Z, while #2968 and #2969 sat behind `pr-owned` for 171 and 233 minutes.
//
// THIS FILE IS THE PURE HALF AND A LEAF (`herdr-agents.mjs` and the vocabulary only), for the reason `claim-stall.mjs` is one:
// `work-gate.mjs` runs before any `pnpm install`. It DECIDES whether an idle holder has a wait the org can READ; `claim-stall.mjs` carries
// the decision as the nudge and, a second reading later, the release it already owned.
//
// A WAIT IS A FIELD, OR IT IS NOT A WAIT (`.claude/rules/waiting-conditions.md`). WAIT_FIELDS below is the whole list, and a kind is
// only in it when something the gate already reads can prove it: the row kinds are `waiting-condition.mjs`'s own (the gate asks it
// through `declaredWait`, never a second copy), the pull-request kinds are facts on the `pr list` payload and the herdr listing.
import { listingIsComplete } from "./herdr-agents.mjs";
import { ANSWER_PREFIX, NEEDS_CHAIRMAN_LABEL } from "./project-vocabulary.mjs";
import { reviewerSeat } from "./review-attribution.mjs";

const MINUTE_MS = 60_000;

/**
 * N: how long a holder may sit `idle` with no wait field before it is a stall.
 *
 * DERIVED, NOT CHOSEN (2026-10-02, `worker-2999`, posted on #2999 before this code; a reading at a moment, so re-derive before quoting).
 *   POPULATION  the eight claims made 2026-10-02 07:00Z-10:40Z that opened a pull request, from `gh issue list` / `gh pr list`: the claim
 *               record and the PR's creation (a worktree mtime is not retained after a merge, so it can only shorten a gap).
 *   THE GAP     claim to first pull request: seven opened one in 27-42 minutes (the longest, 42, #2968); the eighth (#2979) took 134 and was
 *               nudged at 120.
 *   RESULT      a holder that is going to move has moved inside 42 minutes; one tick (about 2 minutes) of margin makes 44, rounded to 45.
 * WHAT THIS DOES NOT PROVE: that 45 is right for a slower regime, and that those holders were `idle` throughout -- `herdr` keeps no status
 * history, so the gap is the proxy and an idle session's real gap is at least as long. The sizing is therefore on the low side of "idle".
 */
export const IDLE_CLAIMANT_MINUTES = 45;
export const IDLE_CLAIMANT_MS = IDLE_CLAIMANT_MINUTES * MINUTE_MS;

/**
 * The `herdr` statuses that mean "nobody is working": `idle`, and `done` (a finished turn the person has not looked at yet). The row said
 * `idle`; the live listing at 2026-10-02T12:50Z was 7 `done`, 4 `idle`, 4 `working`, and a holder is exactly as stopped in either. `working`
 * is not a stall, `blocked` is a session asking a person, and `unknown` is a pane with no agent -- `goneReading`'s case, not this one.
 */
export const IDLE_STATUSES = Object.freeze(["idle", "done"]);

/**
 * `awaiting-evidence` as `work-gate.mjs` declares it (`AWAITING_EVIDENCE_LABEL`). A leaf cannot import its importer, so this is the one
 * restatement; `idle-claimant.test.ts` pins it equal to the gate's own export, so the two cannot drift silently.
 */
export const EVIDENCE_LABEL = "awaiting-evidence";

/**
 * `pr-hold-state.mjs`'s `HOLD_PREFIX`, restated for the reason `EVIDENCE_LABEL` is (a leaf cannot import what imports `wait-condition.mjs`);
 * `idle-claimant.test.ts` pins it equal to the original.
 */
export const HOLD_LABEL_PREFIX = "hold:";

/**
 * EVERY KIND OF WAIT THAT CLEARS A HOLDER, and what the holder writes to declare it. `on: "row"` kinds are decided by the gate through
 * `waiting-condition.mjs` (the one reader of a row's wait) and arrive as `waitKinds`; `on: "pr"` kinds are decided here from the holder's own
 * open pull request. A new kind cannot be added without a case: `idle-claimant.test.ts` derives its table from this object's keys.
 *
 * `blocked` (the label) IS NOT HERE, deliberately: `waiting-condition.mjs` records it as a claim with no referent that nothing can ever check.
 * @type {Readonly<Record<string, { on: "row" | "pr", spelling: string }>>}
 */
export const WAIT_FIELDS = Object.freeze({
  "blocked-by": { on: "row", spelling: "gh issue edit <n> --add-blocked-by <m>" },
  "not-before": { on: "row", spelling: "Not-before: YYYY-MM-DDTHH:MM:SSZ" },
  "answer": { on: "row", spelling: `${ANSWER_PREFIX}<session>` },
  "chairman": { on: "row", spelling: NEEDS_CHAIRMAN_LABEL },
  "fleet-hold": { on: "row", spelling: "Fleet-hold-until: YYYY-MM-DDTHH:MM:SSZ" },
  "review-requested": { on: "pr", spelling: "a reviewer-<pr> session (the gate starts it for a pull request that needs one)" },
  "checks-pending": { on: "pr", spelling: "a check run still in progress on the pull request" },
  "review-approved": { on: "pr", spelling: "an APPROVED pull request, which the merge queue owns" },
  "awaiting-evidence": { on: "pr", spelling: `the \`${EVIDENCE_LABEL}\` label on the pull request` },
  // AN EXTERNAL EVENT (#3569): `pr:hold --until "merged #n"` puts `hold:<session>` on the pull request and records its `Waiting-for:` condition, which the
  // gate re-reads every tick and LIFTS when it is true (#3364, `liftableHolds`). A hold that names no reason is `wait-without-reason`'s, raised after
  // MANUAL_WAIT_HOURS, so counting the label here cannot hide one for long. A background run has no kind: nothing the gate reads can see one (#3569).
  "pr-held": { on: "pr", spelling: `\`pnpm run pr:hold <n> --until "merged #<m>"\` (the \`${HOLD_LABEL_PREFIX}<session>\` label and its \`Waiting-for:\`, which the gate lifts)` },
});

/** @typedef {{ label: string, status: string }} Agent */
/** @typedef {{ number?: number, repoKey?: string, reviewDecision?: string | null, labels?: ({ name?: string } | string)[],
 *   checksPending?: boolean }} IdlePr a `gh pr list --json` object, as `readPrs` returns it, plus `checksPending`, which THE GATE derives: the rollup is
 * read only where `stillRunning` and `newestPerName` live, so this leaf neither re-decides what a running check is nor reads a rollup unnarrowed */

/** @param {IdlePr} pr @returns {string[]} */
const labelNames = (pr) => (pr.labels ?? []).map((l) => String(typeof l === "string" ? l : l?.name));

/** @param {IdlePr} pr @returns {boolean} */
const hasEvidenceLabel = (pr) => labelNames(pr).includes(EVIDENCE_LABEL);

/**
 * The wait kinds ONE open pull request carries. `review-requested` is a live `reviewer-<n>` pane that holds an agent: the gate starts it
 * (#2401) and it is how a review is asked for here -- the reviewers act as the account, so `reviewRequests` on GitHub never names them.
 * GREEN CHECKS ARE NOT A KIND: a green pull request with nobody asked to review it is waiting on nothing anybody can read.
 * @param {IdlePr} pr @param {Agent[]} agents @returns {string[]}
 */
function prWaitKinds(pr, agents) {
  /** @type {string[]} */
  const kinds = [];
  // #3075: `reviewer-7` and `reviewer-agent-org-7` are two seats, so a pull request in another tracked repository is asked for by ITS seat's name.
  if (agents.some((a) => a.label === reviewerSeat({ number: Number(pr.number), repoKey: pr.repoKey }) && a.status !== "unknown")) kinds.push("review-requested");
  if (pr.checksPending === true) kinds.push("checks-pending");
  if (pr.reviewDecision === "APPROVED") kinds.push("review-approved");
  if (hasEvidenceLabel(pr)) kinds.push("awaiting-evidence");
  if (labelNames(pr).some((name) => name.startsWith(HOLD_LABEL_PREFIX))) kinds.push("pr-held");
  return kinds;
}

/**
 * @typedef {{ kind: "unknown", why: string }
 *   | { kind: "not-idle", status: string | null }
 *   | { kind: "waiting", fields: string[] }
 *   | { kind: "watching", since: number, idleMs: number }
 *   | { kind: "stall", since: number, idleMs: number }} IdleReading
 */

/**
 * IS THIS HOLDER AN IDLE CLAIMANT WITH NO DECLARED WAIT?
 *
 * ORDER IS THE DESIGN. A listing that is not the whole org PROVES NOTHING (#2465, `listingIsComplete`), and it is `unknown` even when it
 * names the holder: a partial listing's idea of a status is not one to start a clock on. Then the holder's own status: `working` and
 * `blocked` never trip it. Then the fields -- ANY ONE clears it. Only then the clock: `idleSince` is the first tick of an unbroken run of
 * idle readings (the caller keeps it; `herdr` reports a status and never since when), and a holder idle for less than N is `watching`.
 *
 * @param {{ session: string | null, waitKinds?: string[], prs?: IdlePr[] }} facts `waitKinds` are the ROW's, already decided by the gate
 * @param {{ now: number, agents?: Agent[] | null, idleSince?: number | null }} ctx
 * @returns {IdleReading}
 */
export function idleClaimantReading(facts, ctx) {
  const agents = ctx.agents ?? null;
  if (agents === null) return { kind: "unknown", why: "herdr could not be asked" };
  if (!listingIsComplete(agents)) return { kind: "unknown", why: "the listing lacks a standing pane, so it is not the whole org" };
  const status = agents.find((a) => a.label === facts.session)?.status ?? null;
  if (status === null || !IDLE_STATUSES.includes(status)) return { kind: "not-idle", status };
  const fields = [...(facts.waitKinds ?? []), ...(facts.prs ?? []).flatMap((pr) => prWaitKinds(pr, agents))];
  if (fields.length > 0) return { kind: "waiting", fields: [...new Set(fields)] };
  const since = ctx.idleSince ?? ctx.now;
  const idleMs = ctx.now - since;
  return idleMs >= IDLE_CLAIMANT_MS ? { kind: "stall", since, idleMs } : { kind: "watching", since, idleMs };
}

/**
 * THE NUDGE, to an idle holder. It says the one thing the holder must do, and SPELLS THE FIELDS: "name your wait" must never again mean
 * "write it in the terminal" (the twelve sessions each did, and nothing read it). `idle-claimant.test.ts` pins every spelling in the text.
 *
 * INCIDENT BEHIND THE ORDER'S TEXT (moved out of it, #3444: the agent reading the order cannot use it):
 * chairman, 2026-10-02: twelve sessions waited correctly and set no field, and each looked exactly like a session that had stopped.
 *
 * @param {{ row: number, branch: string | null, idleMinutes: number, releaseMinutes: number, canRelease: boolean }} what
 * @returns {string}
 */
export function idleNudgePrompt({ row, branch, idleMinutes, releaseMinutes, canRelease }) {
  const spellings = Object.values(WAIT_FIELDS).filter((f) => f.on === "row").map((f) => `\`${f.spelling}\``).join(" | ");
  return `#${row} IS YOURS AND IDLE FOR ${idleMinutes} MINUTES WITH NO WAIT THE ORG CAN READ (the terminal is not one).\n`
    + `NAME WHAT YOU WAIT FOR AS A FIELD, OR CONTINUE. Each clears itself: ${spellings} | an open PR awaiting review, checks or the queue | `
    + `\`${EVIDENCE_LABEL}\` | \`pnpm run pr:hold <n> --until "merged #<m>"\` (outside event). To continue: commit, push \`${branch ?? "your branch"}\` or comment.\n`
    + (canRelease
      ? `${releaseMinutes} MINUTES AFTER THIS REACHES YOU with neither, the claim is RELEASED; worktree and unpushed work are KEPT.`
      : "You hold an open pull request, so nothing is released unless the claim changes hands or you go quiet again.");
}
