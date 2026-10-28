// module: the pull-request orders -- what `work-gate.ts` says to a session about a PR's own state (#2542)
//
// MOVED OUT OF `work-gate.ts`, NOT REWRITTEN (#2542, the first split of #928's lever 2a): `draftOrder`,
// `failingChecksOrder`, `settledVerdictOrder`, `requiredWhenNeeded`, `redOnlyFromAHold` and the order builders
// for `pr-green-unarmed`, `pr-review-blocked`, `pr-merge-conflict` and `awaiting-evidence-stale`, with the
// helpers only they use. Sixty-two of 417 merges edited that one file and B4 serialised them; a fix to one
// of these orders now names THIS file in its Region.
//
// THE BOUNDARY: an ORDER BUILDER lives here, and so does a helper whose only callers are in here. A function
// that reads `gh` (`requiredCheckNames`, `readUnarmed`, `readCommitChain`), a helper a family that stayed behind
// also uses (`labelsOf`, `sessionOf`, `checksSettledGreen`, `awaitingEvidence`), and the registries (`CAUSES`,
// `decide`) stay in `work-gate.ts` and are IMPORTED from it, never copied. That import is a cycle with the
// entry point; it is safe only while NOTHING in this file reads an imported binding at load time, so a
// top-level `const` here must never be computed from one (`AWAITING_EVIDENCE_QUIET_MS` stayed behind for
// exactly that reason: it multiplies `HOUR_MS`).
//
// `work-gate.ts` re-exports every name this file exports that it exported before, so a caller of the gate
// is unchanged. Imports below are relative and leaf-shaped, the property the gate's own header states.
import { newestPerName } from "../newest-check-run.ts";
import { reviewerSeat, subjectMention, subjectRef } from "../review-attribution.ts";
import { armabilityOf } from "../pr-hold-state.ts";
import { sharedFileOrders } from "./shared-file-orders.ts";
import { REPO } from "../project-identity.ts";
import { approvedSince, UNQUEUED_MINUTES } from "../approved-unqueued.ts";
import { equivalentHeads } from "../review-verdict.ts";
import { INSIDE, OUTSIDE, declaredIdentities, outsidePrompt, reviewTrustOf, type DeclaredIdentities, type ReviewTrust } from "../review-trust.ts";
import { SESSION_PREFIX, BLOCKED_LABEL, BACKLOG_LABEL, OUT_OF_RELEASE_LABEL, NEEDS_CHAIRMAN_LABEL } from "../project-vocabulary.ts";
import { PROJECT_NUMBER, PROJECT_OWNER } from "../board-snapshot-scope.ts";
import { createRow } from "../ticket-port/approved-unqueued-reads.ts";
import { readRowsByLabel } from "../ticket-port/rows-by-label.ts";
import { ensureTriageLabel } from "../ticket-port/outside-idle-writes.ts";
import { boardFiledRow } from "../ticket-port/board-filed-row.ts";
import { briefChairmanOnPull } from "../ticket-port/chairman-brief.ts";
import { labelsOf, HOUR_MS } from "./vocabulary.ts";
import { conflictStateOf, CONFLICT_STATE, reviewStateOf, checksSettledGreen, blockingChecks, conclusionOf, REVIEW_STATE } from "./pr-state.ts";
import { reviewableHead, reviewWait, awaitingEvidence, AWAITING_EVIDENCE_LABEL, AWAITING_EVIDENCE_QUIET_HOURS, AWAITING_EVIDENCE_QUIET_MS } from "./causes/pr-reviews.ts";
import { verdictAmong } from "../review-verdict.ts";
import { CAUSE_OF_STALL, DEAD_OWNER_FALLBACK, DEPENDENCY_BOT_WORKER_CAUSES, DEPENDENCY_BOT_WORKER_SESSION, MS_PER_MINUTE, REVIEW_CAUSES, STALL_REASON, UNOWNED_PR_SESSION, approvedAtHead, failingChecksOrder, failingRunStartedAt, hungCheckOf, isChairmanAuthoredPr, ownerOfPr, ownershipOf, reviewGateOf, reviewerRoleFile, settledVerdictOrder, stallReasonOf, type ReviewHeads } from "./pr-orders/pr-gate-readings.ts";

/**
 * agent-org#1325: WITH THE FLAG ON, an OUTSIDE pull request (`reviewTrustOf`) and one the chairman authored keep only the orders that ask a reviewer
 * for a verdict. Its red checks, conflict, not-convinced verdict and changes-requested wake no session: the author of an outside pull request is not
 * ours to wake, and a chairman's pull request is the chairman's to finish. Every pull request order carries the subject `pr-<ref>`, which is what
 * this matches on. PURE.
 *
 * agent-org#1368: a DEPENDENCY BOT'S pull request is OUTSIDE too (no declared author), and `ownerOfPr` names no session for it, so its red checks,
 * conflict and not-convinced verdict are the one follow-up kept. They go to `DEPENDENCY_BOT_WORKER_SESSION`, not `ceo`, and `ceo` is not woken for
 * them. Every other follow-up of its pull request is withheld as before. The reroute happens here, not after the filter, because the filter is what
 * withholds these orders: a reroute after it would never see them.
 * @param orders every order `decide` has made, in the order it made them
 * @param prs the open pull requests, which say who each one's author is
 * @param declared the identities the org declares, the same reading `perPullRequestOrders` takes
 * @param asks the ownerless asks of this tick (`ownerlessAsks`), keyed by subject. An order for an asked pull request is re-addressed to the reader, as
 *   long as it is the cause that ask is for: a red build's `pr-checks-failing`, or an approved pull request's `pr-green-unarmed`
 * @param [wakes] the subjects whose not-convinced verdict still wakes its reader (`sessionPrVerdictWakes`, agent-org#1667); empty with the flag OFF
 */
export function withholdOutsideFollowUps(orders: any[], prs: any[], declared: DeclaredIdentities, asks: Map<string, OwnerlessAsk> = new Map(), wakes: ReadonlySet<string> = new Set()): any[] {
  const withheld = new Set([...reviewOnlyRefs(prs, declared)].map((ref) => `pr-${ref}`));
  const botRefs = new Set(prs.filter((pr) => ownerOfPr(pr).source === "dependency-bot").map((pr) => `pr-${subjectRef(pr.repoKey, pr.number)}`));
  return orders.flatMap((order) => {
    if (botRefs.has(order.subject) && order.session === UNOWNED_PR_SESSION && DEPENDENCY_BOT_WORKER_CAUSES.includes(order.cause)) return [toDependencyBotWorker(order)];
    const ask = asks.get(order.subject);
    if (ask && order.cause === (CAUSE_OF_STALL as Record<string, string>)[ask.reason]) return [toOrchestrator(order, ask)];
    // agent-org#1667: a not-convinced verdict on a same-repository session pull request whose only finding is the missing CI Acceptance run (`wakes`) is kept
    const isOrderable = !withheld.has(order.subject) || REVIEW_CAUSES.includes(order.cause) || (order.cause === "verdict-not-convinced" && wakes.has(order.subject));
    return isOrderable ? [order] : [];
  });
}

/** agent-org#1648: `prs.ownerlessAsk` (`machinery-canary.json`, DEFAULT OFF). With it on, a red pull request the chairman opened with no session on it keeps its red build's order, addressed to `OWNERLESS_ASK_SESSION` instead of being withheld. */
export const OWNERLESS_ASK_FLAG = "prs.ownerlessAsk";
/** The reader an ownerless red pull request is asked of: `orchestrator` can re-lane it to a session that should fix it, or close it. */
export const OWNERLESS_ASK_SESSION = "orchestrator";
/** The stall reasons that are a red build: the PR's own red check, the queue's ejection, and a build that never finished. */
const RED_STALL_REASONS: readonly string[] = Object.freeze([STALL_REASON.RED, STALL_REASON.EJECTED, STALL_REASON.HUNG_CHECK]);
/**
 * agent-org#1671: the owner sources the ask reaches. `ceo` is nobody named and `owner-gone` a dead owner; `chairman-author` is the #1648 case. A dependency
 * bot's pull request keeps its worker (#1368), and an automation writer's keeps its own rung.
 */
const OWNERLESS_ASK_SOURCES: readonly string[] = Object.freeze(["chairman-author", "ceo", "owner-gone"]);

/**
 * agent-org#1648, widened by agent-org#1671: WHY one pull request is asked of `OWNERLESS_ASK_SESSION`, and since when. `reason` is the stall it is asked for,
 * `source` the owner rung it was found under, `minutes` how long that has held (`null` when no time was read), `mention` the pull request's name.
 */
export type OwnerlessAsk = { reason: string; source: string; minutes: number | null; mention: string; number: number; repo: string; };

/**
 * agent-org#1648, widened by agent-org#1671: the ask for ONE pull request, or `null`. The pull request must carry no session (owner source `chairman-author`,
 * `ceo` or `owner-gone`) and be one of: red, ejected or hung (`RED_STALL_REASONS`), or approved and out of the queue for MORE than `UNQUEUED_MINUTES`.
 * An OUTSIDE pull request is never asked under `ceo` or `owner-gone`: its author is not ours to wake, and `reviewOnlyRefs` withholds it. PURE.
 */
export function ownerlessAskOf(pr: any, required: string[] | null, nowMs: number, declared: DeclaredIdentities = declaredIdentities()): OwnerlessAsk | null {
  if (!pr) return null;
  const { source } = ownerOfPr(pr);
  if (!OWNERLESS_ASK_SOURCES.includes(source)) return null;
  if (source !== "chairman-author" && reviewTrustOf(pr, declared) === OUTSIDE) return null;
  const reason = stallReasonOf(pr, required, nowMs);
  const mention = subjectMention(pr);
  if (RED_STALL_REASONS.includes(reason)) {
    const since = stalledSinceMs(pr, reason, required, nowMs);
    return { reason, source, minutes: since === null ? null : minutesBetween(since, nowMs), mention, number: pr.number, repo: pr.repo };
  }
  if (reason !== STALL_REASON.UNARMED) return null;
  const approved = approvedSince(pr.reviews);
  if (approved === null || nowMs - approved <= UNQUEUED_MINUTES * MS_PER_MINUTE) return null;
  return { reason, source, minutes: minutesBetween(approved, nowMs), mention, number: pr.number, repo: pr.repo };
}

/** agent-org#1671: the moment a red, ejected or hung pull request's stall began, in ms, or `null` when no time was read. */
function stalledSinceMs(pr: any, reason: string, required: string[] | null, nowMs: number): number | null {
  const at = reason === STALL_REASON.EJECTED ? pr.ejection?.removedAt
    : reason === STALL_REASON.HUNG_CHECK ? hungCheckOf(pr, required, nowMs)?.startedAt
    : failingRunStartedAt(blockingChecks(newestPerName(pr?.statusCheckRollup ?? []), required));
  const ms = Date.parse(String(at ?? ""));
  return Number.isFinite(ms) ? ms : null;
}

/** agent-org#1671: whole minutes from `sinceMs` to `nowMs`, never negative. */
function minutesBetween(sinceMs: number, nowMs: number): number {
  return Math.max(0, Math.floor((nowMs - sinceMs) / MS_PER_MINUTE));
}

/** agent-org#1648: the open pull requests the ask reaches (`ownerlessAskOf` is not `null`). This is the population `ownerless-pr-unreached` counts. PURE. */
export function ownerlessRedPrs(prs: any[], required: string[] | null = null, nowMs: number = Date.now(), declared: DeclaredIdentities = declaredIdentities()): any[] {
  return (prs ?? []).filter((pr) => ownerlessAskOf(pr, required, nowMs, declared) !== null);
}

/**
 * agent-org#1671: THE ASKS OF ONE TICK, keyed by the subject each order carries (`pr-<ref>`), so `withholdOutsideFollowUps` can re-address the order and
 * say why. PURE.
 */
export function ownerlessAsks(prs: any[], required: string[] | null = null, nowMs: number = Date.now(), declared: DeclaredIdentities = declaredIdentities()): Map<string, OwnerlessAsk> {
  return new Map((prs ?? []).flatMap((pr) => {
    const ask = ownerlessAskOf(pr, required, nowMs, declared);
    return ask ? [[`pr-${subjectRef(pr.repoKey, pr.number)}`, ask] as const] : [];
  }));
}

/**
 * agent-org#1648, #1671: the order re-addressed to the reader of an ownerless pull request. Its causeKey moves with the session, as `toDependencyBotWorker`'s
 * does, from the session the order was made to (`ceo`, or `product-manager` for a dead owner). Its prompt OPENS WITH the ask: the pull request, the owner source
 * it was found under and the minutes it has held, so the reader needs no history to act on it.
 */
function toOrchestrator(order: any, ask: OwnerlessAsk) {
  return { ...order, session: OWNERLESS_ASK_SESSION, prompt: `${askSentence(ask)} ${order.prompt}`, causeKey: order.causeKey.replace(`${order.session}/`, `${OWNERLESS_ASK_SESSION}/`) };
}

/** agent-org#1671: the sentence that opens every ask: the pull request, its owner source and how long it has held. */
function askSentence(ask: OwnerlessAsk): string {
  const held = ask.minutes === null ? "for a time no read gives" : `for ${ask.minutes} min`;
  const state = ask.reason === STALL_REASON.UNARMED ? "approved and out of the merge queue" : "stalled on its own checks";
  return `ASKED OF YOU, the reader, because no live session owns ${ask.mention}: its owner source is \`${ask.source}\`, and it has been ${state} ${held}.`;
}

/**
 * agent-org#1671: THE ORDER FOR AN APPROVED PULL REQUEST OUT OF THE QUEUE, addressed to `OWNERLESS_ASK_SESSION`, one per asked pull request. `decide` makes no
 * per-pull-request order for `pr-green-unarmed`: `greenUnarmedOrders` makes ONE order for the machine, to product-manager, naming every unarmed pull request at once.
 * So an approved pull request nobody owns would otherwise reach no reader it could act for. The aggregate is left as it was. Nothing here is withheld, because the
 * ask IS the order. PURE.
 */
export function ownerlessUnarmedOrders(asks: Map<string, OwnerlessAsk>): { session: string; cause: string; subject: string; discriminator: string; prompt: string; causeKey: string; }[] {
  const cause = (CAUSE_OF_STALL as Record<string, string>)[STALL_REASON.UNARMED];
  return [...asks].filter(([, ask]) => ask.reason === STALL_REASON.UNARMED).map(([subject, ask]) => ({
    session: OWNERLESS_ASK_SESSION,
    cause,
    subject,
    discriminator: STALL_REASON.UNARMED,
    prompt: `${askSentence(ask)} It is green on every required check and not held, and nothing has armed it. Arm it with `
      + `\`node packages/agent-org/src/arm-pr.ts --pr=${ask.number} --repo=${ask.repo}\` if it should merge, or put a \`hold:\` label on it if it should not.`,
    causeKey: `${OWNERLESS_ASK_SESSION}/${cause}/${subject}`,
  }));
}

/**
 * agent-org#1368: THE ORDER ADDRESSED TO THE WORKER POOL. Its `causeKey` moves with the session (#2001), since the key is what the wake ledger
 * dedupes on. The `fallback` a `ceo` failing order carries is `product-manager`'s, for a `ceo` that is absent: a worker is not `ceo`, so the
 * fallback is dropped with the rest of the `ceo` addressing.
 */
function toDependencyBotWorker(order: any) {
  const { fallback, fallbackOnlyIfAbsent, fallbackPrompt, ...rest } = order;
  return { ...rest, session: DEPENDENCY_BOT_WORKER_SESSION, causeKey: order.causeKey.replace(`${UNOWNED_PR_SESSION}/`, `${DEPENDENCY_BOT_WORKER_SESSION}/`) };
}

/**
 * agent-org#1370: WITH THE FLAG ON, A REFUSAL (`pr-review-blocked`) ON A PULL REQUEST WHOSE OWNER IS GONE (`ownerOfPr` reads `owner-gone`) is ordered to
 * `DEPENDENCY_BOT_WORKER_SESSION` (the engineers pool, the same pool as the dependency bot's, #1368), not to the dead session and not to `product-manager`
 * (`DEAD_OWNER_FALLBACK`), where a fresh worker takes the branch and the row over. The refusal's prompt is kept, with the label's ownership sentence taken out
 * (`toFreshWorker`) and the refusing review's words added: the fresh worker must act on those. The reroute is after `withholdOutsideFollowUps`, which never withholds a worker's pull request.
 * PURE. The flag off, nothing is rerouted and every order stays as it was.
 * @param orders every order `decide` has made, in the order it made them
 * @param prs the open pull requests, which say who owns each one
 */
export function routeDeadOwnerRefusals(orders: any[], prs: any[]): any[] {
  const gone = new Map(prs.filter((pr) => ownerOfPr(pr).source === "owner-gone").map((pr) => [`pr-${subjectRef(pr.repoKey, pr.number)}`, pr]));
  return orders.map((order) => (gone.has(order.subject) && order.cause === "pr-review-blocked" ? toFreshWorker(order, gone.get(order.subject)) : order));
}

/**
 * agent-org#1370: the refusal addressed to a fresh worker. Its `causeKey` moves with the session (#2001). Its prompt says why the worker is new, names the
 * branch it takes up, drops the sentence that says the rework is the LABEL's (the label names the ended session), and carries the refusing review's words.
 */
function toFreshWorker(order: any, pr: any) {
  const { session, causeKey, prompt, ...rest } = order;
  const review = [...(pr.reviews ?? [])].reverse().find((r: any) => r?.state === "CHANGES_REQUESTED");
  const findings = typeof review?.body === "string" && review.body.trim() !== ""
    ? `The refusing review's words:\n${review.body.trim()}`
    : "The refusing review carries no body in this read: read it on the pull request before the rework.";
  return {
    ...rest, session: DEPENDENCY_BOT_WORKER_SESSION, causeKey: causeKey.replace(`${session}/`, `${DEPENDENCY_BOT_WORKER_SESSION}/`),
    prompt: `Its session \`${session}\` has ENDED and nobody holds the row this pull request closes, so this rework is a FRESH worker's: take up `
      + `this pull request's branch \`${pr.headRefName}\` and its row, and act on the refusal below as the reviewer wrote it.\n`
      + `${prompt.replace(/It carries your session label, so [^.]*\.\s*/, "")}\n${findings}`,
  };
}

/**
 * agent-org#1325: the pull requests the flag orders for their review only, as `subjectRef`s: an OUTSIDE one (`reviewTrustOf`) and one the chairman
 * authored. `withholdOutsideFollowUps` matches them on an order's subject; `decide` also drops them from `reviewBlocked`'s population BEFORE the
 * `pr-review-blocked` set order is built, because that one order names several pull requests under the subject `pr-review-blocked` and no subject
 * filter can take one pull request out of it (#1378's first review). PURE.
 */
export function reviewOnlyRefs(prs: any[], declared: DeclaredIdentities): Set<string> {
  return new Set(prs.filter((pr) => reviewTrustOf(pr, declared) === OUTSIDE || isChairmanAuthoredPr(pr)).map((pr) => subjectRef(pr.repoKey, pr.number)));
}

/**
 * agent-org#1369: an OUTSIDE pull request idle this long files ONE triage row and wakes no session. #1325 orders such a pull request for its review
 * only, so nothing else would ever move it, and the row is the orchestrator's to triage. Literal milliseconds: this file is leaf-shaped (see the header).
 */
export const OUTSIDE_IDLE_MS = 7 * 24 * 60 * 60 * 1000;
/** The label a triage row carries. A row is found again by the marker in its body, which is what makes the second tick file nothing. */
export const OUTSIDE_IDLE_LABEL = "outside-pr-idle";

type GhRun = (args: string[]) => string;

/** The outside pull requests last updated `OUTSIDE_IDLE_MS` or more before `nowMs`. An `updatedAt` that does not parse is NOT idle: nothing is accused on a read that did not say. */
export function outsideIdlePrs(prs: any[], declared: DeclaredIdentities, nowMs: number): any[] {
  return prs.filter((pr) => {
    if (reviewTrustOf(pr, declared) !== OUTSIDE) return false;
    const touched = Date.parse(String(pr?.updatedAt ?? ""));
    return Number.isFinite(touched) && nowMs - touched >= OUTSIDE_IDLE_MS;
  });
}

/**
 * The row for one idle pull request. The marker keys the EPISODE, the `updatedAt` that made it idle: a second tick reads the same idleness and finds
 * the row, while a touch followed by another idle week is a new episode and a new row.
 */
export function outsideIdleTriage(pr: any): { marker: string; title: string; body: string } {
  const ref = subjectRef(pr.repoKey, pr.number);
  const marker = `<!-- ${OUTSIDE_IDLE_LABEL}:${ref}@${pr.updatedAt} -->`;
  const body = [
    marker,
    `Outside pull request ${ref} (https://github.com/${pr.repo}/pull/${pr.number}) has not been updated since ${pr.updatedAt}.`,
    "",
    "An outside pull request is ordered for its review only (`prs.ownerRouting`), so no session will move it. This row is for the orchestrator to triage: close it, hand it back, or find it a reviewer.",
    "",
    "Filing this row woke no session.",
  ].join("\n");
  return { marker, title: `Outside PR ${ref} idle for 7 days: triage`, body };
}

/** The bodies of the triage rows, open and closed: a closed row still says its episode was filed, so it is not filed again. Throws when `gh` refuses. */
export function readOutsideIdleBodies(run: GhRun): string[] {
  return (["OPEN", "CLOSED"] as const).flatMap((state) =>
    readRowsByLabel({ label: OUTSIDE_IDLE_LABEL, state, select: "number body", run }).map((row) => String(row.body ?? "")));
}

/**
 * Files one triage row for each outside pull request idle at `nowMs` whose episode has no row yet, and returns how many it filed. OFF files nothing and
 * reads nothing. A read that refuses files nothing and is logged, so the next tick retries; a board that refuses is logged, and the row stays filed.
 */
export function fileOutsideIdleTriage(prs: any[], { declared, nowMs, run, log, enabled, readFiled = readOutsideIdleBodies }: {
  declared: DeclaredIdentities; nowMs: number; run: GhRun; log: (line: string) => void; enabled: boolean; readFiled?: (run: GhRun) => string[];
}): number {
  if (!enabled) return 0;
  const idle = outsideIdlePrs(prs, declared, nowMs);
  if (idle.length === 0) return 0;
  let filed: string[];
  try {
    filed = readFiled(run);
  } catch (error) {
    log(`outside-pr-idle: could not read the triage rows (${String((error as Error).message).split("\n")[0]}); the next tick retries\n`);
    return 0;
  }
  let count = 0;
  for (const pr of idle) {
    const row = outsideIdleTriage(pr);
    if (filed.some((body) => body.includes(row.marker))) continue;
    let number: number;
    try {
      ensureTriageLabel({ repo: REPO, label: OUTSIDE_IDLE_LABEL, description: "An outside pull request idle for 7 days", run });
      number = createRow({ repo: REPO, title: row.title, labels: [OUTSIDE_IDLE_LABEL], body: row.body, run });
    } catch (error) {
      log(`outside-pr-idle: could not file the row for ${row.marker} (${String((error as Error).message).split("\n")[0]}); the next tick retries\n`);
      continue;
    }
    count++;
    try {
      boardFiledRow({ repo: REPO, number, owner: PROJECT_OWNER, projectNumber: PROJECT_NUMBER, status: "Backlog", labels: [BACKLOG_LABEL, OUT_OF_RELEASE_LABEL], run });
    } catch (error) {
      log(`outside-pr-idle: filed #${number} but could not board it (${String((error as Error).message).split("\n")[0]})\n`);
    }
  }
  return count;
}

/**
 * a11ign#5528, agent-org#1538: THE BRIEF A HUMAN-GATED RED RAISES. The check names a person's act as its remedy, so no reviewer is ordered (`draftOrder`)
 * and the chairman is asked instead: the brief carries the changed files, the reason, and the marker that makes filing once per head.
 */
export function reviewGatedHumanBrief(pr: any): { marker: string; body: string } {
  const ref = subjectRef(pr.repoKey, pr.number);
  const marker = `<!-- review-gated-human:${ref}@${String(pr.headRefOid ?? "").slice(0, 8)} -->`;
  const names = Object.entries(pr.checkMarkers ?? {}).filter(([, act]) => act === "human").map(([name]) => `\`${name}\``);
  const files = Array.isArray(pr.files) ? pr.files : [];
  const diff = files.length === 0 ? "The changed files could not be read." : files.map((f: any) => `- \`${f.path}\` (+${f.additions ?? 0} -${f.deletions ?? 0})`).join("\n");
  return { marker, body: [
    marker,
    `BRIEF for the chairman: pull request ${ref} (https://github.com/${pr.repo}/pull/${pr.number}) is red, and what clears it is a person's act: ${names.join(", ")} says \`Cleared-by: human\`.`,
    "",
    "The diff:",
    diff,
    "",
    "No reviewer was ordered for it, because a reviewer cannot clear this. Filing this brief woke no session.",
  ].join("\n") };
}

/**
 * Files the chairman's brief for each human-gated red pull request that has none at its head, and returns how many it filed. The label goes
 * on before the comment, so a comment that fails leaves the label to be tried again on the next tick under the same marker.
 */
export function fileReviewGatedHuman(prs: any[], { required, run, log }: {
  required: string[] | null; run: GhRun; log: (line: string) => void;
}): number {
  let count = 0;
  for (const pr of prs) {
    if (reviewGateOf(pr, required) !== "human") continue;
    const brief = reviewGatedHumanBrief(pr);
    if ((pr.comments ?? []).some((c: any) => String(c?.body ?? "").includes(brief.marker))) continue;
    try {
      briefChairmanOnPull({ repo: pr.repo, number: pr.number, label: NEEDS_CHAIRMAN_LABEL, body: brief.body, run });
      count++;
    } catch (error) {
      log(`review-gated-human: could not brief #${pr.number} (${String((error as Error).message).split("\n")[0]}); the next tick retries\n`);
    }
  }
  return count;
}

/**
 * The key a pull request's review orders carry, and the heads a verdict may sit at (#3045). A VERDICT IS VALID FOR A PATCH, NOT A SHA:
 * `key` is the patch id when `withPatchIds` read it and the head otherwise, which is this gate's behaviour before #2176.
 */
export function reviewHeadsOf(pr: any, head: string, wait: "settled" | "running"): ReviewHeads {
  const patch = pr?.patchIds?.[head];
  return { head8: head.slice(0, 8), key: typeof patch === "string" ? patch.slice(0, 8) : head.slice(0, 8), all: equivalentHeads(pr), wait };
}

/** The reviewer role file a pull request's reviewer reads, which the gate's prompt names; ticket mode's re-review brief names the same file (A11-156). */
export { reviewerRoleFile };

/** The fields a reviewer reads a pull request by: its head, its reviews and author, the rollup `settledGreenOf` reads, and the body whose `Partial: step N of M` line names the plan step it finishes (A11-175). */
export const REVIEW_PULL_FIELDS = "headRefOid,reviews,author,isCrossRepository,isDraft,statusCheckRollup,body";

/** The name a rollup entry goes by: a check run's `name`, a commit status's `context`. */
const checkNameOf = (check: any): string => String(check?.name ?? check?.context ?? "");

const isCancelled = (check: any): boolean => conclusionOf(check) === "CANCELLED";

/**
 * The rollup without the cancelled runs a name has another run for (A11-340): a run GitHub cancelled because a later one replaced it is a duplicate, not a failure, and whichever of the two finished last it must not hold a
 * reviewer back from a head whose other run of that name passed. A name whose only run is cancelled keeps it, and so does not settle (a run is known by its `name`, as `newestPerName` knows it); a name's other run still running or failed decides it as before.
 */
function withoutSupersededRuns(rollup: any[]): any[] {
  const answered = new Set(rollup.filter((check) => !isCancelled(check)).map((check) => check?.name));
  return rollup.filter((check) => !isCancelled(check) || typeof check?.name !== "string" || !answered.has(check.name));
}

/** The rollup of a pull request narrowed to the newest run per name, which is the only narrowing a question about its checks may ask of (`checksSettledGreen`), after the cancelled duplicates are set aside ({@link withoutSupersededRuns}). */
const newestChecksOf = (pr: any): any[] => newestPerName(withoutSupersededRuns(Array.isArray(pr?.statusCheckRollup) ? pr.statusCheckRollup : []));

/** The checks `required` names, or every check when it names none: a null list was not read or could not be, and an empty one is a branch that requires nothing, which counts every check as `pull-feedback.ts` does (A11-175). */
const requiredNames = (required: readonly string[] | null): string[] | null => (required === null || required.length === 0 ? null : [...required]);

/**
 * Whether a pull request's checks have settled green, read off its rollup narrowed to the newest run per name (the way `checksSettledGreen` asks). A pending check, or no check at all, is not
 * settled green. With `required`, the names of the checks the branch requires (A11-175), only those count: a required check that has not reported is not settled, and a check outside the list holds
 * nothing, red or running. With no list, or an empty one, every check counts.
 */
export function settledGreenOf(pr: any, required: readonly string[] | null = null): boolean {
  const names = requiredNames(required);
  const rollup = newestChecksOf(pr);
  if (names === null) return checksSettledGreen(rollup) === true;
  const counted = blockingChecks(rollup, names);
  return names.every((name) => counted.some((check) => checkNameOf(check) === name)) && checksSettledGreen(counted) === true;
}

/**
 * The checks that failed and that the branch does not require (A11-175), by name, once each: what a reviewer is told was left red because it held nothing. Empty with no list of required checks,
 * or an empty one, since then every check counts and none is left out. A check still running is not red.
 */
export function unrequiredRedOf(pr: any, required: readonly string[] | null = null): string[] {
  const names = requiredNames(required);
  if (names === null) return [];
  const red = newestChecksOf(pr).filter((check) => !names.includes(checkNameOf(check)) && checksSettledGreen([check]) === false);
  return [...new Set(red.map(checkNameOf))];
}

/**
 * The wording of the re-review order, TRUE OF WHICHEVER STATE THE PULL REQUEST IS IN (#2176). It used to
 * say "Draft" unconditionally, which is a false statement to a reviewer about the ready pull request this
 * cause now reaches.
 */
export function awaitingVerdictPrompt(pr: any, { head8, key, all, wait }: ReviewHeads, { rowReviewSkill = false }: { rowReviewSkill?: boolean; } = {}) {
  const state = pr.isDraft ? "Draft" : "Ready (not a draft)";
  const checks = wait === "settled" ? "has settled green checks and no verdict at that head"
    : "has no verdict at that head, and its checks are re-running on a head that adds no work to the one before it";
  const same = all.length > 1
    ? ` Its patch (\`${key}\`) is the same at ${all.length} heads: a verdict at any of them stands, `
      + "so write yours at the head you actually read and do not re-review work you have already answered."
    : "";
  // agent-org#1268: THE ORDER NO LONGER SAYS "leave one comment", which the role file forbids ("post no comment": the verdict is the review `pr-review-verdict` posts), and that is
  // true whatever the flag says. BEHIND `ROW_REVIEW_SKILL_FLAG` the sentence names the skill, by name, because Codex runs one only when the prompt says so and a
  // `~/.codex/skills/.system/review-agent` also exists. Off, the sentence is the old one with the contradiction removed and nothing else.
  const role = reviewerRoleFile(pr);
  return `${state} ${subjectMention(pr)} at \`${head8}\` ${checks}.${same} `
    + (rowReviewSkill ? `Review it with the \`row-review\` skill, then post the verdict per ${role}.`
      : `Review it per ${role} and post the verdict as it says.`);
}

/**
 * The head of a pull request whose checks are RUNNING when it adds no work to its predecessor, else `null` (#3045). Both patch ids must
 * have been read (`withPatchIds` reads them for a running head only): an unread patch is not an equal one, so a refused read falls back to
 * asking nothing until the checks settle, which is what this gate did before.
 */
function unchangedRunningHead(pr: any, wait: "settled" | "running" | null): string | null {
  return wait === "running" && equivalentHeads(pr).length > 1 ? String(pr.headRefOid) : null;
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
 * KEYED ON THE PATCH, NOT THE HEAD (#3045), because `causeKey` moves with the head and an update-branch, a rebase and an amend are each a
 * new head with no new work: extending the read alone would have turned #2104 into a reviewer order every ten minutes. The heads are
 * the same work when `git patch-id`-equivalent diffs say so (`withPatchIds` reads them, `equivalentHeads` compares them) -- not when a
 * headline says "Merge branch 'main'", which could not see a conflict resolved by hand and could not see a rebase.
 *
 * A HEAD WHOSE CHECKS ARE RE-RUNNING STAYS IN THE QUESTION WHEN IT ADDS NO WORK, and is asked of nobody else: dropping the order for
 * the minutes CI takes is what wrote a `RESET` and re-armed it after each of #3033's four merges. Only `draft-awaiting-verdict` is
 * emitted from that state -- a settled verdict's follow-ups, `draft-convinced-not-ready`'s ready-flip above all, wait for settled checks.
 */
function draftOrder(pr: any, required: string[] | null = null, baseTip: { sha: string; date: string; } | null = null,
  flags: { rowReviewSkill?: boolean; sameHeadRefail?: boolean } = {}, trust: ReviewTrust = INSIDE) {
  // RED FIRST, and before the green check: a red PR is work whether or not it is a draft, and it can
  // never reach the reviewer lane below, which requires green.
  const red = failingChecksOrder(pr, required, baseTip, { sameHeadRefail: flags.sameHeadRefail });
  if (red) return red;
  // a11ign#5528: a check that a PERSON clears is the chairman's, so no reviewer is ordered for it. `fileReviewGatedHuman` files the brief.
  if (reviewGateOf(pr, required) === "human") return null;
  const wait = reviewWait(pr, required);
  const head = wait === "settled" ? reviewableHead(pr, required) : unchangedRunningHead(pr, wait);
  if (!head || !wait) return null;
  const heads = reviewHeadsOf(pr, head, wait);
  const found = verdictAmong(pr, heads.all);
  // A VERDICT THE OPENER DID NOT ATTRIBUTE COUNTS AS SETTLED, and that is the wake side's default rather
  // than a reading of the comment: `verdictAtHead` returns `byIsAuthor: null` for it and refuses to guess
  // (#1244). Waking anyway would re-prompt a reviewer who has already answered; the cost of being wrong
  // the other way is one author-written verdict going unchallenged, which `ceo`'s spot-check of one
  // verdict in five is the control for.
  if (found.verdict !== null) return wait === "settled" ? settledVerdictOrder(pr, found, heads, required, trust) : null;
  // #2416: A PULL REQUEST WAITING FOR AN EXTERNAL RUN IS NOT ASKED FOR A VERDICT, and this is the gate's half of
  // the two routes into a review (the author's is a sentence in `org-routing-and-timers.md`). It sits AFTER
  // the settled-verdict read on purpose: a verdict somebody prompted by hand is still read and acted on, so
  // the label removes the MACHINERY's order and never the reviewer's ability to answer, and it sits after the
  // red-checks order because a red build is the author's work whether or not evidence is pending.
  if (awaitingEvidence(pr)) return null;
  // #3476: A PULL REQUEST THAT CONFLICTS WITH ITS BASE IS NOT ASKED FOR A FIRST LOOK. Its next move is the rebase, which
  // `pr-merge-conflict` orders the owner to make and which changes the head, so a verdict now is paid for and then outlived:
  // #148 was approved 7m42s after #145 made it DIRTY, at a head the rebase replaced. It sits AFTER the settled-verdict read on
  // purpose, as `awaitingEvidence` does: a verdict already given (rework owed, a convinced draft not yet ready) is still acted on,
  // and only the REQUEST is withheld. After the rebase the head is new, `reviewHeadsOf` keys a new discriminator, and the review is
  // asked once, at the head that can merge. `UNREAD` is not `CONFLICTING`: an unknown state is never an accusation.
  if (conflictStateOf(pr) === CONFLICT_STATE.CONFLICTING) return null;
  // #1249: A GREEN PULL REQUEST THE REVIEWER ALREADY APPROVED AT ITS HEAD, THAT GITHUB STILL HOLDS FOR REVIEW, IS NOT ASKED FOR A VERDICT AGAIN.
  // The reviewer has answered; the question is why the approval does not count, and that belongs to `ceo`, not to a second look.
  // A DRAFT IS NOT READY, so GitHub holding it for review is its normal state: its approval is no question, and it keeps the reviewer's order.
  if (wait === "settled" && pr.isDraft !== true && approvalNotCountedOf(pr, heads.all)) return approvalNotCountedOrder(pr, heads.key);

  // PULL REQUEST n IS `reviewer-<n>`'S (#2401; the odd/even split it replaced is retired). The name is
  // herdr's, and `wake.ts` starts the instance when none is live. The arithmetic lives in
  // `review-attribution.ts`, beside the reader that checks whether a posted review obeyed it -- a
  // detector with its own copy would agree with a router that had drifted.
  const session = reviewerSeat(pr);
  return {
    session,
    cause: "draft-awaiting-verdict",
    subject: `pr-${subjectRef(pr.repoKey, pr.number)}`,
    discriminator: heads.key,
    prompt: trust === OUTSIDE ? outsidePrompt(pr, heads.head8, reviewerRoleFile(pr)) : awaitingVerdictPrompt(pr, heads, { rowReviewSkill: flags.rowReviewSkill }),
    causeKey: `${session}/draft-awaiting-verdict/pr-${subjectRef(pr.repoKey, pr.number)}/${heads.key}`,
    // #1311: THE TRUST IS ON THE ORDER, so the spawn that starts its reviewer reads it from the order and never decides it again.
    trust,
  };
}

/**
 * Every order the open pull requests earn: each one's own (`draftOrder`), the checkless ones (#3092), the ones GitHub holds for review that
 * NO order reached (#4002), the later one of each pair that changes one file (#3480), then the set-wide one for labelled pull requests nobody
 * has explained (#2416).
 * @param [now] the clock, omitted is `Date.now()`; or `{ nowMs, recheck, rowReviewSkill, sameHeadRefail }` (agent-org#1187, #1268, #1185), which is how `RECHECK_FLAG`'s, `ROW_REVIEW_SKILL_FLAG`'s and `SAME_HEAD_REFAIL_FLAG`'s readings reach the orders without a 5th
 *   positional parameter (`max-params`). `recheck` omitted is OFF, so a caller that passes a bare clock, as every caller did before, gets the ordering it always got.
 */
export function perPullRequestOrders(prs: any[], required: string[] | null, baseTip?: any, now: number | { nowMs?: number; recheck?: boolean; rowReviewSkill?: boolean; sameHeadRefail?: boolean; identities?: DeclaredIdentities; } = Date.now()) {
  const { nowMs = Date.now(), recheck = false, rowReviewSkill = false, sameHeadRefail = false, identities } = typeof now === "number" ? { nowMs: now } : now;
  // #1311: the declared identities are read ONCE per call, and only when a pull request is asked at all; a test passes its own.
  let declared = identities;
  const asked = prs.map((pr) => {
    declared ??= declaredIdentities();
    return { pr, order: draftOrder(pr, required, baseTip, { rowReviewSkill, sameHeadRefail }, reviewTrustOf(pr, declared)) };
  });
  const unreached = asked.filter(({ pr, order }) => order === null && !isCheckless(pr, nowMs)).map(({ pr }) => pr);
  return [...asked.flatMap(({ order }) => order ?? []), ...checklessPrOrders(prs, nowMs), ...unorderedPrOrders(unreached, required, nowMs),
    ...sharedFileOrders(prs, undefined, { recheck }), ...awaitingEvidenceStaleOrders(prs)];
}

/**
 * #3092: HOW LONG A PULL REQUEST MAY SIT WITH NO CHECKS AT ALL before its owner is told. A real run appears within a minute of a
 * push, so this is not a race with CI; it is long enough that a quiet PR is a PR no workflow is coming for.
 */
export const CHECKLESS_QUIET_MINUTES = 30;

/**
 * PURE. #3092: THE PULL REQUESTS WHOSE ROLLUP IS EMPTY, QUIET FOR `CHECKLESS_QUIET_MINUTES`, AND NOT CONFLICTING -- the ones no other
 * order can ever reach. `reviewableHead` asks for a SETTLED GREEN head and reads an empty rollup as `null` ("not knowable yet"), so
 * `draftOrder` emitted nothing, `failingChecksOrder` needs red, and `stallReasonOf` files it `progressing`: nobody was ever told.
 * Measured on a11ign/agent-org#58 (2026-10-02/03): opened on #56's branch, so `ci.yml` (`pull_request` on `branches: [main]`) never ran;
 * #56 merged, GitHub retargeted it to `main` -- an `edited` event, not a default trigger -- and it sat REVIEW_REQUIRED with 0 checks.
 *
 * A CONFLICTING PULL REQUEST IS LEFT TO `pr-merge-conflict`, whose order says the same thing in better words (a conflicting branch gets no
 * `pull_request` run, so the rebase it asks for is also what starts CI). ABSENT IS NOT EMPTY: an unread rollup, a missing head or an
 * unparseable `updatedAt` is never an accusation. `updatedAt` IS THE AGE, because the list read has no push time and a push, a retarget
 * and a label all move it: the failure it can have is DELAY (a chatty PR is asked only once it falls quiet), never an order sent to an
 * author whose push CI has not picked up yet.
 *
 * FILED UNDER `pr-checks-failing`, no new cause, as `ejected` is (`CAUSE_OF_STALL`): same audience, same remedy-by-the-owner, and a cause is
 * pinned by name in several guards. The key says `checkless`, so it never collides with a red head's.
 */
export function checklessPrOrders(prs: any[], nowMs: number = Date.now()) {
  return (prs ?? [])
    .filter((pr) => pr && Number.isFinite(Number(pr.number)) && isCheckless(pr, nowMs))
    .sort((a, b) => Number(a.number) - Number(b.number))
    .map(checklessOrder);
}

function isCheckless(pr: any, nowMs: number) {
  if (!pr.headRefOid || !Array.isArray(pr.statusCheckRollup) || pr.statusCheckRollup.length > 0) return false;
  if (conflictStateOf(pr) === CONFLICT_STATE.CONFLICTING) return false;
  const quietSince = Date.parse(String(pr.updatedAt ?? ""));
  return !Number.isNaN(quietSince) && nowMs - quietSince >= CHECKLESS_QUIET_MINUTES * MS_PER_MINUTE;
}

function checklessOrder(pr: any) {
  const head8 = String(pr.headRefOid).slice(0, 8);
  const { session, source } = ownerOfPr(pr);
  const ref = `pr-${subjectRef(pr.repoKey, pr.number)}`;
  const repoFlag = pr.repo ? ` --repo ${pr.repo}` : "";
  const remedy = `\`gh pr close ${pr.number}${repoFlag} && gh pr reopen ${pr.number}${repoFlag}\` (\`reopened\` is a trigger \`edited\` is not), or push a commit`;
  const what = `${subjectMention(pr)} at \`${head8}\` has NO CHECKS AT ALL, and has had none for ${CHECKLESS_QUIET_MINUTES} minutes of quiet: no workflow ran for this head, `
    + "so it is neither red nor green and the gate will NEVER offer it to a reviewer, which asks only of a settled green head. THE USUAL CAUSE is a RETARGET: "
    + "a workflow filtered to one base gives a pull request opened on another branch no run, and when that branch merges GitHub retargets it, "
    + "an `edited` event that may not start CI. ";
  return {
    session,
    ...deadOwnerFallback(session, what, remedy),
    cause: "pr-checks-failing",
    subject: ref,
    discriminator: `checkless-${head8}`,
    prompt: `${what}REMEDY, and it fires CI without a code change: ${remedy}. ${ownershipOf(pr, source, "remedy")}`,
    causeKey: `${session}/pr-checks-failing/${ref}/checkless/${head8}`,
  };
}

/**
 * What an order for a CODE-FREE remedy carries beside its owner: where it goes if that session no longer exists, and the words that tell the
 * fallback the remedy is its own to apply. Empty when the owner IS the fallback.
 */
function deadOwnerFallback(session: string, what: string, remedy: string) {
  if (session === DEAD_OWNER_FALLBACK) return {};
  return { fallback: DEAD_OWNER_FALLBACK, fallbackOnlyIfAbsent: true,
    fallbackPrompt: `${what}Its owner, \`${session}\`, NO LONGER EXISTS (no workspace carries that label), so this order reached you. The remedy needs no code, so apply it: ${remedy}.` };
}

/**
 * PURE. #4002: THE PULL REQUESTS GITHUB HOLDS FOR REVIEW THAT NO ORDER REACHED, quiet for `CHECKLESS_QUIET_MINUTES`. `unreached` is the caller's
 * list of pull requests for which `draftOrder` and `checklessPrOrders` both said nothing: this asks only whether one of them is a pull request
 * that SHOULD have been asked, and never repeats a reading those two made.
 *
 * THE DEFECT, a11ign#3997, 2026-10-07: opened READY, armed, `REVIEW_REQUIRED`, 0 reviews, and sat 67 minutes with no reviewer. Its `ci` runs ended
 * `failure` with NO `gate` job, so the rollup held 22 checks and none of them the one required on `main`. `required` was `["gate"]` (#3996 was red),
 * `blockingChecks` was therefore EMPTY, `checksSettledGreen([])` is `null`, and `reviewWait` read the head as `"running"` for ever. Nothing else
 * reaches it: `failingChecksOrder` needs red, `isCheckless` needs an EMPTY rollup, `hungCheckOf` needs a check that exists, and the outcome clock
 * (100 minutes) is an age with no cause.
 *
 * THE CLASS IS WIDER THAN THAT SHAPE, so the population is defined by what it LACKS and not by which check went missing: not a draft, not
 * conflicting (`pr-merge-conflict`'s), not held, not `awaiting-evidence`, GitHub says `REVIEW_REQUIRED`, and no order at all. `REFUSED`
 * is not here (`pr-review-blocked` reports it) and neither is an UNREADABLE decision, which is not a statement about the pull request.
 *
 * QUIET IS THE LATER OF `updatedAt` AND THE NEWEST CHECK TIMESTAMP, because a re-run started from the Actions page moves no `updatedAt`: a
 * run begun a minute ago on a pull request last touched an hour ago is not a pull request nobody is looking at. Like `isCheckless`, the
 * failure it can have is DELAY, and an unparseable time is never an accusation.
 *
 * FILED UNDER `pr-checks-failing`, as the checkless one is, keyed `unordered` so it collides with neither that nor a red head's. AN APPROVED one is
 * `pr-approval-not-counted` instead (#1249): the same reach, a different question, and the approval is not a red build. WHEN `required`
 * WAS READ the order names the required checks absent from the rollup; when it was not, it says so rather than guessing which one went missing.
 * NO OWNER IS `product-manager`, the first reader for the queue, and not the `ceo` rung `ownerOfPr` ends on (the row's own words).
 */
export function unorderedPrOrders(unreached: any[], required: string[] | null, nowMs: number) {
  return (unreached ?? [])
    .filter((pr) => pr && Number.isFinite(Number(pr.number)) && isUnordered(pr, nowMs))
    .sort((a, b) => Number(a.number) - Number(b.number))
    .map((pr) => (approvalNotCountedOf(pr, equivalentHeads(pr)) ? approvalNotCountedOrder(pr, String(pr.headRefOid).slice(0, 8))
      : unorderedOrder(pr, required)));
}

/**
 * PURE. #1249: A PULL REQUEST THE REVIEWER APPROVED AT ITS HEAD, THAT GITHUB STILL HOLDS AS `REVIEW_REQUIRED`. The approval answers the question
 * the review was asked, so the reviewer's order is spent, and no red check is what holds it -- a red head never reaches this, its order comes first.
 * `approvedAtHead` is `null` when the reviews were not read, and a null is never an accusation: only a read approval at one of the head's own
 * equivalent heads counts. Review state is read from `reviewDecision`, not from the approval alone, so an approval GitHub already counts is not this.
 */
function approvalNotCountedOf(pr: any, heads: string[]): boolean {
  return reviewStateOf(pr).code === REVIEW_STATE.AWAITING_REVIEW && approvedAtHead(pr, heads) === true;
}

/**
 * The order for `approvalNotCountedOf` (#1249): ADDRESSED TO `ceo`, the one reader no PR's owner holds, because the question is why GitHub does not
 * count an approval that is in hand, and the owner's branch cannot answer it. `ceo` is `UNOWNED_PR_SESSION`, the same session `ownerOfPr` ends
 * on for a PR nobody could name; the brief says this one is not nameless, only misread by the rules. It is filed under its own cause, never
 * `pr-checks-failing`, because nothing on the head is red and the remedy is not a push.
 */
function approvalNotCountedOrder(pr: any, discriminator: string) {
  const ref = `pr-${subjectRef(pr.repoKey, pr.number)}`;
  const head8 = String(pr.headRefOid ?? "").slice(0, 8);
  const what = `${subjectMention(pr)} at \`${head8}\` is APPROVED by a reviewer, and GitHub still holds it for review (\`REVIEW_REQUIRED\`): the approval is not counted. `
    + "Its checks are not red, so no owner's push fixes this, and the reviewer has already answered. ";
  return {
    session: UNOWNED_PR_SESSION,
    cause: "pr-approval-not-counted",
    subject: ref,
    discriminator,
    prompt: `${what}WORK OUT WHY: read the branch protection on the base and the review list. The reason is one of: a required review from a code owner or a second reviewer is missing; `
      + "an approval was dismissed or went stale; or the rule asks for a review this approval is not. Then route the PR to whoever can fix it (`" + SESSION_PREFIX + "<name>` on the PR), "
      + "or ask the reviewer for the missing approval. Do not merge it yourself.",
    causeKey: `${UNOWNED_PR_SESSION}/pr-approval-not-counted/${ref}/${discriminator}`,
  };
}

function isUnordered(pr: any, nowMs: number) {
  const isUnarmable = !pr.headRefOid || pr.isDraft === true || awaitingEvidence(pr) || !armabilityOf({ labels: labelsOf(pr) }).arm;
  if (isUnarmable) return false;
  if (conflictStateOf(pr) === CONFLICT_STATE.CONFLICTING) return false;
  if (reviewStateOf(pr).code !== REVIEW_STATE.AWAITING_REVIEW) return false;
  const quietSince = lastActivityMs(pr);
  return !Number.isNaN(quietSince) && nowMs - quietSince >= CHECKLESS_QUIET_MINUTES * MS_PER_MINUTE;
}

/** @returns the newest of `updatedAt` and every check's start and completion; NaN when `updatedAt` cannot be read */
function lastActivityMs(pr: any): number {
  const updated = Date.parse(String(pr.updatedAt ?? ""));
  if (Number.isNaN(updated)) return NaN;
  const stamps = (pr.statusCheckRollup ?? []).flatMap((c: any) => [c?.startedAt, c?.completedAt])
    .map((at: unknown) => Date.parse(String(at ?? ""))).filter((ms: number) => Number.isFinite(ms));
  return Math.max(updated, ...stamps);
}

function unorderedOrder(pr: any, required: string[] | null) {
  const head8 = String(pr.headRefOid).slice(0, 8);
  const owner = ownerOfPr(pr);
  const session = owner.source === "ceo" ? DEAD_OWNER_FALLBACK : owner.session;
  const ref = `pr-${subjectRef(pr.repoKey, pr.number)}`;
  const repoFlag = pr.repo ? ` --repo ${pr.repo}` : "";
  const remedy = `\`gh pr close ${pr.number}${repoFlag} && gh pr reopen ${pr.number}${repoFlag}\` (\`reopened\` starts CI, so the required check is produced), or push a commit`;
  const what = `${subjectMention(pr)} at \`${head8}\` is held by GitHub for review (\`REVIEW_REQUIRED\`) and the gate has raised NO order for it for ${CHECKLESS_QUIET_MINUTES} minutes of quiet: `
    + `no reviewer was asked, no failing check was reported, and it is not checkless. ${absentChecksSentence(pr, required)}`
    + "THE CASE THAT FOUND THIS (#3997) was a run that ended without producing `gate`: the one required check never appeared, so the head read as still running for ever. ";
  return {
    session,
    ...deadOwnerFallback(session, what, remedy),
    cause: "pr-checks-failing",
    subject: ref,
    discriminator: `unordered-${head8}`,
    prompt: `${what}REMEDY: ${remedy}. ${ownershipOf(pr, owner.source, "remedy")}`,
    causeKey: `${session}/pr-checks-failing/${ref}/unordered/${head8}`,
  };
}

/** Which required checks the head does not carry, said only as far as the reading allows: a READ list names them, an unread one says so. */
function absentChecksSentence(pr: any, required: string[] | null) {
  if (required === null) return "The required-check list was NOT read this tick, so which check is absent cannot be said. ";
  const present = newestPerName(pr.statusCheckRollup ?? []).map((c: any) => String(c?.name ?? c?.context));
  const absent = required.filter((name) => !present.includes(name));
  if (absent.length === 0) return "Every required check IS in the rollup, so the cause is not an absent one: read the rollup and the reviewer seat. ";
  return `The required check(s) ${absent.map((name) => `\`${name}\``).join(", ")} are ABSENT from its rollup, which carries ${present.length} other check(s). `;
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
 */
export function awaitingEvidenceStaleOrders(prs: any[], now: number = Date.now()) {
  const stale = prs.filter((pr) => awaitingEvidence(pr) && evidenceWaitUnexplained(pr, now))
    .sort((a, b) => Number(a.number) - Number(b.number));
  if (stale.length === 0) return [];
  const key = stale.map((pr) => subjectRef(pr.repoKey, pr.number)).join(".");
  const lines = stale.map((pr) => `  ${subjectMention(pr)}  carried \`${AWAITING_EVIDENCE_LABEL}\` for `
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
      + `It is NOT \`${BLOCKED_LABEL}\`, which has no referent.`,
    causeKey: `product-manager/awaiting-evidence-stale/${key}`,
  }];
}

/** Whether a labelled pull request has been quiet since the label went on for longer than the bound. */
function evidenceWaitUnexplained(pr: any, now: number) {
  const since = Date.parse(String(pr.awaitingSince ?? ""));
  if (Number.isNaN(since) || !Array.isArray(pr.comments)) return false;
  if (now - since <= AWAITING_EVIDENCE_QUIET_MS) return false;
  return !pr.comments.some((c: any) => {
    const at = Date.parse(String(c?.createdAt ?? ""));
    return Number.isNaN(at) || at > since;
  });
}
