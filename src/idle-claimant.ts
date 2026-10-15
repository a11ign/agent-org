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
// THIS FILE IS THE PURE HALF AND A LEAF (`herdr-agents.ts` and the vocabulary only), for the reason `claim-stall.ts` is one:
// `work-gate.ts` runs before any `pnpm install`. It DECIDES whether an idle holder has a wait the org can READ; `claim-stall.ts` carries
// the decision as the nudge and, a second reading later, the release it already owned.
//
// A WAIT IS A FIELD, OR IT IS NOT A WAIT (`.claude/rules/waiting-conditions.md`). WAIT_FIELDS below is the whole list, and a kind is
// only in it when something the gate already reads can prove it: the row kinds are `waiting-condition.ts`'s own (the gate asks it
// through `declaredWait`, never a second copy), the pull-request kinds are facts on the `pr list` payload and the herdr listing.
import { listingIsComplete } from "./herdr-agents.ts";
import { CLAIM_LABEL } from "./claim-labels.ts";
import { ANSWER_PREFIX, NEEDS_CHAIRMAN_LABEL } from "./project-vocabulary.ts";
import { reviewerSeat, subjectMention } from "./review-attribution.ts";
import { DEFAULT_ANSWERER } from "./decided-by.ts";
import type { DeclarationReading } from "./worker-state.ts";

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
 *
 * THE FIGURE IS NOW THE CHAIRMAN'S, NOT THE DERIVATION'S (2026-10-11, a11ign#4957 cause 3, agent-org#860): "idle 30 minutes with no PR, no declaration and
 * no wake is nudged". Twelve agent-org holders sat idle on claimed rows for up to 10 hours at 45, and the same figure is the length of the second idle
 * period after which an unanswered nudge is an incident (`claim-stall.ts`'s `idleAgain`), so lowering it moves both.
 */
export const IDLE_CLAIMANT_MINUTES = 30;
export const IDLE_CLAIMANT_MS = IDLE_CLAIMANT_MINUTES * MINUTE_MS;

/**
 * M: how long a holder that has STOPPED may sit `idle` -- a claim that names a branch, no open pull request, no declared wait -- before it is woken
 * with "continue" (#458, class `claimed-worker-stalled`). N above is a figure for a row that has not moved while its holder looks busy; the four
 * workers of #4437 had ended a turn on "Next I'll ..." or lost their background tasks, were 40 to 58 minutes in and none was yet woken.
 *
 * THE CAP BINDS; IT IS NOT DERIVED ABOVE THE LONGEST GAP (measured 2026-10-10, `worker-agent-org-458`, posted on #458 before this code with its script).
 *   POPULATION  912 worker sessions that went on to open a pull request (1,474 transcripts, 2026-09-19 .. 2026-10-10), 355 between-turn gaps before the
 *               first pull request, from the session transcripts: neither the tick journal nor `herdr` keeps a worker's status by time.
 *   RESULT      a healthy wait (the gap ended by the session's own background task finishing, n=146): p50 3.7, p90 11.3, p95 16.5, max 90.5 minutes.
 *               "Above the longest, one tick of margin" is about 93 minutes, which the row's own ceiling (10) refuses, so M is the ceiling: 10 sits at
 *               the 87.7th percentile and 18 of 146 healthy waits in three weeks (under one a day) draw one "continue" turn they did not need.
 * WHAT THIS DOES NOT PROVE: that `herdr` reads `idle` while a live background task runs (inferred from the four in the row, which were `idle`/`done`
 * with LOST tasks, not observed for a live one); and the orders-ended gaps are a mix of stops and answered waits, so they are no stop population.
 */
export const STOPPED_CLAIMANT_MINUTES = 10;
export const STOPPED_CLAIMANT_MS = STOPPED_CLAIMANT_MINUTES * MINUTE_MS;

/**
 * The `herdr` statuses that mean "nobody is working": `idle`, and `done` (a finished turn the person has not looked at yet). The row said
 * `idle`; the live listing at 2026-10-02T12:50Z was 7 `done`, 4 `idle`, 4 `working`, and a holder is exactly as stopped in either. `working`
 * is not a stall, `blocked` is a session asking a person, and `unknown` is a pane with no agent -- `goneReading`'s case, not this one.
 */
export const IDLE_STATUSES = Object.freeze(["idle", "done"]);

/**
 * `awaiting-evidence` as `work-gate.ts` declares it (`AWAITING_EVIDENCE_LABEL`). A leaf cannot import its importer, so this is the one
 * restatement; `idle-claimant.test.ts` pins it equal to the gate's own export, so the two cannot drift silently.
 */
export const EVIDENCE_LABEL = "awaiting-evidence";

/**
 * `pr-hold-state.ts`'s `HOLD_PREFIX`, restated for the reason `EVIDENCE_LABEL` is (a leaf cannot import what imports `wait-condition.ts`);
 * `idle-claimant.test.ts` pins it equal to the original.
 */
export const HOLD_LABEL_PREFIX = "hold:";

/**
 * EVERY KIND OF WAIT THAT CLEARS A HOLDER, and what the holder writes to declare it. `on: "row"` kinds are decided by the gate through
 * `waiting-condition.ts` (the one reader of a row's wait) and arrive as `waitKinds`; `on: "pr"` kinds are decided here from the holder's own
 * open pull request. A new kind cannot be added without a case: `idle-claimant.test.ts` derives its table from this object's keys.
 *
 * `blocked` (the label) IS NOT HERE, deliberately: `waiting-condition.ts` records it as a claim with no referent that nothing can ever check.
 * @type {Readonly<Record<string, { on: "row" | "pr", spelling: string }>>}
 */
export const WAIT_FIELDS: Readonly<Record<string, { on: "row" | "pr"; spelling: string; }>> = Object.freeze({
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

/**
 * (agent-org#743, a11ign#4437) HOW MANY NUDGES A HOLDER WITH A PULL REQUEST OPEN MAY LEAVE UNANSWERED BEFORE ITS CLAIM IS RELEASED. A nudge is unanswered when its
 * holder was idle for a full idle period after it was delivered and the branch gained no commit, no pull request opened and no head moved (`claim-stall.ts`'s
 * `unansweredNudges`). THE THIRD UNANSWERED NUDGE RELEASES; the second is followed by a third. It is the count `MAX_CONTINUATIONS` is not: that one caps gate ORDERS,
 * which reroute to `orchestrator`, and a holder with an open pull request was never released at all.
 */
export const MAX_UNANSWERED_NUDGES = 3;

export type Agent = { label: string, status: string };
/**
 * a `gh pr list --json` object, as `readPrs` returns it, plus `checksPending`, which THE GATE derives: the rollup is read only where `stillRunning` and `newestPerName` live, so this leaf neither re-decides what a running check is nor reads a rollup unnarrowed
 */
export type IdlePr = { number?: number, repoKey?: string, reviewDecision?: string | null, labels?: ({ name?: string } | string)[], checksPending?: boolean, failingChecks?: string[] };

/** @param {IdlePr} pr @returns {string[]} */
const labelNames = (pr: IdlePr): string[] => (pr.labels ?? []).map((l) => String(typeof l === "string" ? l : l?.name));

/** @param {IdlePr} pr @returns {boolean} */
const hasEvidenceLabel = (pr: IdlePr): boolean => labelNames(pr).includes(EVIDENCE_LABEL);

/**
 * The wait kinds ONE open pull request carries. `review-requested` is a live `reviewer-<n>` pane that holds an agent: the gate starts it
 * (#2401) and it is how a review is asked for here -- the reviewers act as the account, so `reviewRequests` on GitHub never names them.
 * GREEN CHECKS ARE NOT A KIND: a green pull request with nobody asked to review it is waiting on nothing anybody can read.
 * @param {IdlePr} pr @param {Agent[]} agents @returns {string[]}
 */
function prWaitKinds(pr: IdlePr, agents: Agent[]): string[] {
  const kinds: string[] = [];
  // #3075: `reviewer-7` and `reviewer-agent-org-7` are two seats, so a pull request in another tracked repository is asked for by ITS seat's name.
  if (agents.some((a) => a.label === reviewerSeat({ number: Number(pr.number), repoKey: pr.repoKey }) && a.status !== "unknown")) kinds.push("review-requested");
  if (pr.checksPending === true) kinds.push("checks-pending");
  if (pr.reviewDecision === "APPROVED") kinds.push("review-approved");
  if (hasEvidenceLabel(pr)) kinds.push("awaiting-evidence");
  if (labelNames(pr).some((name) => name.startsWith(HOLD_LABEL_PREFIX))) kinds.push("pr-held");
  return kinds;
}

export type RedPr = { number?: number, repoKey?: string, checks: string[] };

/**
 * (agent-org#743) THE HOLDER'S OWN PULL REQUESTS THAT ARE RED, with the names of the failing checks, as the caller derived them into `failingChecks`. The decider is
 * `red-pr.ts`'s `brokenChecks` (the one the gate's `pr-checks-failing` order and the retrospective ask, and `org-health.test.ts` pins it as the only one): the NEWEST
 * run of each name decides, and the two jobs a `hold:` label turns red by design are left out. THIS LEAF CANNOT ASK IT: `red-pr.ts` imports `pr-hold-state.ts`, which
 * imports `IDLE_STATUSES` from this file, so an import is a module cycle (`Cannot access 'ANSWER_PREFIX' before initialization`, the review of #1151) and a
 * restated list is a second decider. `claim-stall.ts`'s `withRedChecks` fills `failingChecks`; a caller that does not (`org-health.ts`, `idle-claim-incident.ts`) reads
 * a pull request as not red, as it did before. It does not know which checks are REQUIRED (that is a `gh` read): `gate` is the one required job and `needs` every
 * other, so a red job is a red `gate`.
 * @param {IdlePr[] | undefined} prs @returns {RedPr[]}
 */
export function redOwnPrs(prs: IdlePr[] | undefined): RedPr[] {
  return (prs ?? []).flatMap((pr) => {
    const checks = [...new Set(pr?.failingChecks ?? [])];
    return checks.length === 0 ? [] : [{ number: pr?.number, repoKey: pr?.repoKey, checks }];
  });
}

/**
 * IS THIS HOLDER ONE THE STOPPED CLOCK APPLIES TO: its claim names a git object (`built`: a `Claimed-nothing:` claim is a host act or a reading, which
 * is idle at its prompt by design) and it holds NO open pull request. A holder with a pull request is waiting on the org's review or checks, and
 * those have their own causes and the 45-minute clock above. ONE DEFINITION, because the reading and the order's text both ask it.
 * @param {{ built?: boolean, prs?: IdlePr[] }} holder @returns {boolean}
 */
export function isStoppedHolder({ built, prs }: { built?: boolean; prs?: IdlePr[]; }): boolean {
  return built === true && (prs ?? []).length === 0;
}

export type IdleReading = { kind: "unknown", why: string } | { kind: "not-idle", status: string | null } | { kind: "waiting", fields: string[] } | { kind: "watching", since: number, idleMs: number } | { kind: "stall", since: number, idleMs: number, declared?: DeclarationReading };

/**
 * THE PULL-REQUEST KINDS THAT ARE INFERENCES, which a declared state replaces (#460, class `worker-state-ambiguous`). A pending check, a reviewer pane and
 * an approval are what a worker that `waiting-ci` / `waiting-review` would be looking at, and a worker that stopped mid-task on "Next I'll ..." with its pull
 * request open looks identical to it from them. Under the declaration regime they no longer excuse an idle worker; the declaration does, while the
 * thing it names holds. `awaiting-evidence` and `pr-held` stay: each is a LABEL the worker itself set, which is a declaration already.
 */
export const INFERRED_PR_KINDS = Object.freeze(["review-requested", "checks-pending", "review-approved"]);

/**
 * (agent-org#743) A DECLARATION THAT A RED CHECK VOIDS: `waiting-ci` and `waiting-review` say the holder waits on something that is not its own to move, which is
 * not true of a check that has FAILED -- the failure is the holder's to fix and nothing it waits for will fix it. `done` and `blocked` are other claims: `done`
 * lapses on its own facts (`worker-state.ts`), and `blocked` is also a row field (`answer:`), which is read as one.
 */
const RED_VOIDS = Object.freeze(["waiting-ci", "waiting-review"]);

/**
 * THE IDLE PERIOD THAT APPLIES TO ONE HOLDER, in ms: M for a holder under the declaration regime, one that stopped with no pull request, or one whose own
 * pull request is RED (agent-org#743: a red check is told within M whatever was declared), N otherwise.
 * ONE DEFINITION, because the reading and the "idle again after its nudge" incident (`claim-stall.ts`) both ask how long a period is.
 * @param {{ built?: boolean, prs?: IdlePr[], declared?: DeclarationReading }} facts @returns {number}
 */
export function idleLimitMs(facts: { built?: boolean; prs?: IdlePr[]; declared?: DeclarationReading; }): number {
  const regime = facts.declared !== undefined && facts.built === true;
  const red = facts.built === true && redOwnPrs(facts.prs).length > 0;
  return regime || red || isStoppedHolder({ built: facts.built, prs: facts.prs }) ? STOPPED_CLAIMANT_MS : IDLE_CLAIMANT_MS;
}

/**
 * IS THIS HOLDER AN IDLE CLAIMANT WITH NO DECLARED WAIT?
 *
 * ORDER IS THE DESIGN. A listing that is not the whole org PROVES NOTHING (#2465, `listingIsComplete`), and it is `unknown` even when it
 * names the holder: a partial listing's idea of a status is not one to start a clock on. Then the holder's own status: `working` and
 * `blocked` never trip it. Then the fields -- ANY ONE clears it. Only then the clock: `idleSince` is the first tick of an unbroken run of
 * idle readings (the caller keeps it; `herdr` reports a status and never since when), and a holder idle for less than N is `watching`.
 *
 * THE DECLARATION REGIME (#460) is ON only when the caller passes `declared` (the gate does, for a claim that names a branch; every other caller, and a
 * `Claimed-nothing:` claim, reads as before). Under it an idle holder is excused by an explicit field (a row's `blocked-by`, `answer:` ..., a PR's `hold:` or
 * evidence label) or by a declaration that is FRESH and still true; the inferred PR kinds are not an excuse, and the clock is M whether or not a pull request
 * is open. A holder that stopped with its pull request up is exactly what the old reading could not see.
 *
 * @param {{ session: string | null, waitKinds?: string[], prs?: IdlePr[], built?: boolean, declared?: DeclarationReading }} facts `waitKinds` are the ROW's, already decided by the gate;
 *   `built` turns the stopped clock on ({@link isStoppedHolder}) and is OFF for a caller that does not say, so a reading made without it is N's, as it was
 * @param {{ now: number, agents?: Agent[] | null, idleSince?: number | null }} ctx
 * @returns {IdleReading}
 */
export function idleClaimantReading(facts: { session: string | null; waitKinds?: string[]; prs?: IdlePr[]; built?: boolean; declared?: DeclarationReading; }, ctx: { now: number; agents?: Agent[] | null; idleSince?: number | null; }): IdleReading {
  const agents = ctx.agents ?? null;
  if (agents === null) return { kind: "unknown", why: "herdr could not be asked" };
  if (!listingIsComplete(agents)) return { kind: "unknown", why: "the listing lacks a standing pane, so it is not the whole org" };
  const status = agents.find((a) => a.label === facts.session)?.status ?? null;
  if (status === null || !IDLE_STATUSES.includes(status)) return { kind: "not-idle", status };
  const regime = facts.declared !== undefined && facts.built === true;
  // (agent-org#743) A RED CHECK OF THE HOLDER'S OWN IS NOT EXCUSED BY WHAT IT DECLARED NOR BY A PENDING CHECK, A REVIEWER OR AN APPROVAL: those are inferences about a
  // wait, and the failure is not one. The FIELDS stay: a row's wait (`waitKinds`) and a pull request's own `awaiting-evidence` / `hold:` label are the holder saying so.
  const red = facts.built === true && redOwnPrs(facts.prs).length > 0;
  if (regime && facts.declared?.kind === "excused" && !(red && RED_VOIDS.includes(facts.declared.state))) return { kind: "waiting", fields: [`declared:${facts.declared.state}`] };
  const prKinds = (facts.prs ?? []).flatMap((pr) => prWaitKinds(pr, agents)).filter((kind) => !(regime || red) || !INFERRED_PR_KINDS.includes(kind));
  const fields = [...(facts.waitKinds ?? []), ...prKinds];
  if (fields.length > 0) return { kind: "waiting", fields: [...new Set(fields)] };
  const since = ctx.idleSince ?? ctx.now;
  const idleMs = ctx.now - since;
  // TWO CONSECUTIVE TICKS IS BUILT IN: `idleSince` is the first idle tick, so that tick reads `idleMs` 0 and a stall needs a later one.
  const limit = idleLimitMs(facts);
  if (idleMs < limit) return { kind: "watching", since, idleMs };
  return regime ? { kind: "stall", since, idleMs, declared: facts.declared } : { kind: "stall", since, idleMs };
}

/** @returns {string} every wait a row can carry, spelled as the holder writes it */
const rowSpellings = (): string => Object.values(WAIT_FIELDS).filter((f) => f.on === "row").map((f) => `\`${f.spelling}\``).join(" | ");

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
export function idleNudgePrompt({ row, branch, idleMinutes, releaseMinutes, canRelease }: { row: number; branch: string | null; idleMinutes: number; releaseMinutes: number; canRelease: boolean; }): string {
  const spellings = rowSpellings();
  return `#${row} IS YOURS AND IDLE FOR ${idleMinutes} MINUTES WITH NO WAIT THE ORG CAN READ (the terminal is not one).\n`
    + `NAME WHAT YOU WAIT FOR AS A FIELD, OR CONTINUE. Each clears itself: ${spellings} | an open PR awaiting review, checks or the queue | `
    + `\`${EVIDENCE_LABEL}\` | \`pnpm run pr:hold <n> --until "merged #<m>"\` (outside event). To continue: commit, push \`${branch ?? "your branch"}\` or comment.\n`
    + (canRelease
      ? `${releaseMinutes} MINUTES AFTER THIS REACHES YOU with neither, the claim is RELEASED; worktree and unpushed work are KEPT.`
      : "You hold an open pull request, so nothing is released unless the claim changes hands or you go quiet again.");
}

/**
 * THE ORDER TO A HOLDER THAT STOPPED (#458): "continue", with what happened to the four of #4437 said first -- a turn ended on "Next I'll ...", and
 * background tasks a restart took with them, which never send the notice the holder waits for. A holder that is genuinely waiting on something is told
 * to name it as a field, the one thing the gate can read. `idle-claimant-stopped.test.ts` pins the spellings and the release sentence.
 *
 * @param {{ row: number, branch: string | null, idleMinutes: number, releaseMinutes: number, canRelease: boolean }} what
 * @returns {string}
 */
export function stoppedNudgePrompt({ row, branch, idleMinutes, releaseMinutes, canRelease }: { row: number; branch: string | null; idleMinutes: number; releaseMinutes: number; canRelease: boolean; }): string {
  return `#${row} IS YOURS AND YOUR SESSION HAS BEEN IDLE FOR ${idleMinutes} MINUTES with no open pull request, no check pending and no wait the org can read: `
    + "YOU STOPPED MID-TASK.\n"
    + `CONTINUE NOW. Re-read the row, \`${branch ?? "your branch"}\` and what you last ran, and do the next step you were about to take. A background task you `
    + "started may be LOST (a restarted session loses them and no completion notice will ever come): look, and re-run what is gone.\n"
    + `IF YOU ARE WAITING ON SOMETHING, NAME IT AS A FIELD (the terminal is not one): ${rowSpellings()} | \`pnpm run pr:hold <n> --until "merged #<m>"\` (outside event).\n`
    + (canRelease
      ? `${releaseMinutes} MINUTES AFTER THIS REACHES YOU with nothing moved, the claim is RELEASED; worktree and unpushed work are KEPT.`
      : "You hold an open pull request, so nothing is released unless the claim changes hands or you go quiet again.");
}

/**
 * THE ORDER TO A HOLDER THAT ENDED A TURN WITH NO STATE THE GATE CAN READ (#460). `declared` says which of the three it is -- nothing declared, a
 * declaration from an earlier turn, or one that was true and no longer is -- because "declare your state" means something different to each, and the
 * last is the only one where the worker's own statement is what went out of date. The command is spelled in full: it is the one thing the gate reads.
 * `worker-state.test.ts` pins the command's spelling and the three openings.
 *
 * @param {{ row: number, branch: string | null, idleMinutes: number, releaseMinutes: number, canRelease: boolean, declared?: DeclarationReading }} what
 * @returns {string}
 */
export function declareNudgePrompt({ row, branch, idleMinutes, releaseMinutes, canRelease, declared }: { row: number; branch: string | null; idleMinutes: number; releaseMinutes: number; canRelease: boolean; declared?: DeclarationReading; }): string {
  const said = declared?.kind === "stale"
    ? `YOU DECLARED \`${declared.state}\` BEFORE YOUR LAST TURN BEGAN, so it describes an earlier turn and the gate does not read it.`
    : declared?.kind === "lapsed"
      ? `YOU DECLARED \`${declared.state}\` AND IT IS NO LONGER TRUE: ${declared.why}.`
      : "YOU DECLARED NOTHING.";
  return `#${row} IS YOURS AND YOUR SESSION HAS BEEN IDLE FOR ${idleMinutes} MINUTES. EVERY TURN ENDS WITH A DECLARED STATE, AND ${said}\n`
    + `IF YOU STOPPED MID-TASK, CONTINUE NOW: re-read the row, \`${branch ?? "your branch"}\` and what you last ran, and do the next step. A background task you `
    + "started may be LOST (a restarted session loses them and no completion notice will ever come): look, and re-run what is gone.\n"
    + "IF YOU ARE WAITING, DECLARE WHAT FOR, ONCE, AS YOUR LAST ACT OF THE TURN: `agent-org worker:state waiting-ci <pr>` (checks running) | "
    + "`agent-org worker:state waiting-review <pr>` (review asked) | `agent-org worker:state done` (merged or row closed) | "
    + "`agent-org worker:state blocked <row> <reason>` (it puts the row's answer label on itself). Each excuses you only while it stays true.\n"
    + (canRelease
      ? `${releaseMinutes} MINUTES AFTER THIS REACHES YOU with nothing moved and nothing declared, the claim is RELEASED; worktree and unpushed work are KEPT.`
      : "You hold an open pull request, so nothing is released unless the claim changes hands or you go quiet again.");
}

/** @param {RedPr[]} red @returns {string} `#41 (gate, ts)`, one per pull request, the repository's key in front of a number from another tracked repository */
function redSummary(red: RedPr[]): string {
  return red.map((pr) => `${subjectMention({ repoKey: pr.repoKey, number: Number(pr.number) })} (${pr.checks.map((name) => `\`${name}\``).join(", ")})`).join("; ");
}

/**
 * (agent-org#743) THE NOTE EVERY NUDGE TO A HOLDER WITH A PULL REQUEST OPEN CARRIES: how many it has had and what releases it. The three prompts above are
 * pinned by tests outside this change and say "nothing is released" for such a holder, which was true when nothing counted nudges; this is said beside them.
 * What answers a nudge is a MOVE OF THE BRANCH (a commit, a new pull request, a moved head): a comment or a changed file does not. A wait NAMED AS A FIELD still
 * ends the stall, because the holder is then not idle with no wait the org can read.
 * @param {number} nudge which nudge this is, from 1 @returns {string}
 */
export function unansweredNudgeNote(nudge: number): string {
  return `THIS IS NUDGE ${nudge} OF ${MAX_UNANSWERED_NUDGES}: if ${MAX_UNANSWERED_NUDGES} reach you and the branch gains no commit, no pull request opens and no head moves after any of them, `
    + "the claim is RELEASED and the row offered again. Your pull request is left open as it is; worktree and unpushed work are KEPT. A comment or a changed file is not a move.";
}

/**
 * THE ORDER TO A HOLDER IDLE ON A RED PULL REQUEST OF ITS OWN (agent-org#743, a11ign#4437): it names the failing checks and says to fix and push. It is sent
 * whatever the holder declared with `worker:state`: `waiting-ci` and `waiting-review` excuse a holder only while its pull request's checks are not red, and
 * `idle-claimant.test.ts` pins both halves. Nothing here is a wait to NAME: the one thing that clears it is a push that moves the head.
 *
 * @param {{ row: number, branch: string | null, idleMinutes: number, red: RedPr[], nudge: number }} what
 * @returns {string}
 */
export function redCheckNudgePrompt({ row, branch, idleMinutes, red, nudge }: { row: number; branch: string | null; idleMinutes: number; red: RedPr[]; nudge: number; }): string {
  return `#${row} IS YOURS, YOU HAVE BEEN IDLE FOR ${idleMinutes} MINUTES AND ITS PULL REQUEST IS RED: ${redSummary(red)}.\n`
    + `FIX THE RED CHECK NOW. Read the failing run, fix the cause, commit and push \`${branch ?? "your branch"}\`. Run what CI runs before you push. `
    + "`waiting-ci` and `waiting-review` do NOT excuse you while a check is red: a failed check is yours to fix and nothing you wait for will fix it.\n"
    + unansweredNudgeNote(nudge);
}

// --- A ROW THE CLAIMANT ALREADY READ AS DONE -----------------------------------------------------------------------------
//
// An idle claimant that left its own `VERIFIED` (or "Done-when ... met") note on an `in-progress` row has finished the work and stopped before
// closing it: nobody closes it, and the claim holds the row. After the note has stood VERIFIED_CLOSE_MINUTES, the gate orders the row closed, to
// `product-manager`, which is the reader that closes rows (`engineer.md`). The order names the note, so the close is checkable by whoever reads it.
// PURE, and it reads the claim and the comments the gate already has.

/** How long a VERIFIED note from an idle claimant stands before the gate orders its row closed. */
export const VERIFIED_CLOSE_MINUTES = 15;

/** Who closes a row the claimant read as done: the same reader a worker's `blocked` is routed to (`DEFAULT_ANSWERER`, from the leaf `decided-by.ts`). */
export const VERIFIED_CLOSER = DEFAULT_ANSWERER;

/** A note that says the work is verified: the word VERIFIED, or a Done-when line that says it is met. */
const VERIFIED_NOTE = /\bVERIFIED\b|Done-when[^\n]*\bmet\b/i;

export type VerifiedCloseOrder = { kind: "close"; row: number; claimant: string; to: string; note: string; verifiedAt: number; idleMs: number };

/**
 * PURE. IS THIS ROW ONE THE GATE ORDERS CLOSED. Every condition must hold: the row is `in-progress`; its claimant is idle (`idleSince` is the start of
 * the idle run, `null` when the claimant is not idle); and a comment by the claimant's account, made since the claim, says VERIFIED or that the
 * Done-when items are met, and has stood for at least {@link VERIFIED_CLOSE_MINUTES}. The newest such comment is the one the order names.
 * The claimant's account is the claim's author (`claimRecordOf`), the same attribution the claim itself uses: sessions share an account.
 * @param {{ row: number, labels: string[], claimant: string, claim: { at: number, author: string | null } | null, comments: { url: string, body: string, createdAt: string, author?: { login?: string } | null }[], idleSince: number | null }} facts
 * @param {{ now: number }} ctx
 * @returns {VerifiedCloseOrder | null}
 */
export function verifiedCloseOrder(facts: { row: number; labels: string[]; claimant: string; claim: { at: number; author: string | null } | null; comments: { url?: string; id?: string; body: string; createdAt: string; author?: { login?: string } | null }[]; idleSince: number | null }, ctx: { now: number }): VerifiedCloseOrder | null {
  const { claim, idleSince } = facts;
  if (!facts.labels.includes(CLAIM_LABEL) || claim === null || claim.author === null || idleSince === null) return null;
  const notes = facts.comments.filter((c) => c.author?.login === claim.author && Date.parse(c.createdAt) >= claim.at && VERIFIED_NOTE.test(c.body));
  const newest = notes.at(-1);
  if (newest === undefined) return null;
  const verifiedAt = Date.parse(newest.createdAt);
  if (ctx.now - verifiedAt < VERIFIED_CLOSE_MINUTES * MINUTE_MS) return null;
  return { kind: "close", row: facts.row, claimant: facts.claimant, to: VERIFIED_CLOSER, note: newest.url ?? newest.id ?? "", verifiedAt, idleMs: ctx.now - idleSince };
}
