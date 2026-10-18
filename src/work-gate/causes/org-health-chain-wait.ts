import { subjectRef } from "../../review-attribution.ts";
import { machineryFlagOn, type CanaryState } from "../../org-health/fleet-build-incident.ts";
import { MAX_TICK_GAP_MS, type BlockingOrder } from "../../blocking-impact.ts";
import { brokenChecks } from "../../red-pr.ts";
import { declaredWaitsOf, isItemWait, waitItemOf } from "../../wait-condition.ts";
import { readJsonObject } from "../../claim-stall/claim-stalled.ts";
import { writeJsonObject } from "../../claim-stall.ts";
import { CONFLICT_STATE, conflictStateOf } from "../pr-state.ts";
import { sessionOf } from "../vocabulary.ts";

// =====================================================================================================================
// a11ign#5126: A HOLDER WAITING ON A PULL REQUEST THAT IS ITSELF BLOCKED IS WOKEN WITH THE CHOICE, AND A SECOND PERIOD GOES TO ORCHESTRATOR.
//
// Measured 2026-10-11: #946 (worker-5020) and #1016 (worker-5117) each waited for another pull request to merge ("then rebase once"), and the one they waited on was blocked itself (#1016 sat DIRTY behind
// #1014, which had changes requested and a red `suite`). #5009's detector names a CYCLE; this is a CHAIN, with no cycle in it: each hop is correct, nothing moves, and nothing clears it, because the
// holder is waiting on a change nobody is working.
//
//   THE CHAIN: an open pull request or row whose declared wait (`Waiting-for: merged|closed #n`, the hold marker's else the body's: `declaredWaitsOf`) names an OPEN pull request of the same repository
//   that is BLOCKED -- `reviewDecision` CHANGES_REQUESTED, conflicting with the base, or a check red. A wait on a pull request the gate did not list, or on one that is merely not yet green, is not a chain.
//   THE CLOCK starts on the first tick that reads the chain (the state directory, `chain-waits.json`), and a gap in observation starts it again: minutes nobody observed are not counted.
//   THE MOVES: after `CHAIN_WAIT_MINUTES` the holder is woken ONCE with the choice (rebase now and regenerate what conflicts, or take the blocked pull request's change in); a second period still standing
//   escalates to `orchestrator`, once. A holder no session is known for goes straight to the escalation, because nobody could take the choice. A chain not read on the next tick is forgotten.
//   THE ORDERS reuse `ready-row-unclaimable`, as #5009's do: a new cause is a change to the closed vocabulary.
//   THE FLAG `queue.chainWaitWake` (`machinery-canary.json`, default OFF): off reads and writes nothing and makes no order, which is today's gate.
// =====================================================================================================================

/** The machinery flag that lets the gate wake a holder waiting on a blocked pull request. */
export const CHAIN_WAIT_FLAG = "queue.chainWaitWake";

export const CHAIN_WAIT_FILE = "chain-waits.json";

/** How long a chain stands before its holder is woken, and again before it is escalated: the row's figure. */
export const CHAIN_WAIT_MINUTES = 30;

export const CHAIN_WAIT_ESCALATION_SESSION = "orchestrator";

const CHAIN_WAIT_MS = CHAIN_WAIT_MINUTES * 60 * 1000;

/** One holder waiting on one blocked pull request, as the tick read it. `session` is the holder's `session:` label, `null` when it carries none. `target` is how a person is told (`owner/repo#n`), `targetRef` the ledger spelling (`n`, or `key#n`, {@link subjectRef}). */
export type ChainWait = { key: string; holder: string; holderKind: "pull request" | "row"; session: string | null; target: string; targetRef: string; reason: string };

/** A chain standing across ticks: when it was first read, when its holder was woken (`null` for not yet), and whether it was escalated. */
export type ChainEpisode = { since: number; woke: number | null; escalated: boolean };

export type ChainMove = { kind: "wake-holder"; wait: ChainWait; since: number } | { kind: "escalate"; wait: ChainWait; since: number; woken: boolean };

/** The repository an item is in, as `waitItemOf` reads it: empty for the home tracker's, whose bare `#n` carries none. */
const repoOf = (raw: any): string => (raw?.repoKey && raw?.repo ? String(raw.repo) : "");

const refOf = (raw: any): string => `${repoOf(raw)}#${Number(raw?.number)}`;

/** PURE. Why a pull request is not moving, or `null` when it is not blocked. The three are the states a person must act on; a pull request still waiting for its checks is not one. */
export function blockedReasonOf(pr: any): string | null {
  if (pr?.reviewDecision === "CHANGES_REQUESTED") return "a reviewer requested changes";
  if (conflictStateOf(pr) === CONFLICT_STATE.CONFLICTING) return "it conflicts with its base";
  const red = brokenChecks(pr).map((check) => check.name); // a hold's own two red jobs are the hold speaking, not a pull request nobody is working
  return red.length === 0 ? null : `its checks are red (${red.slice(0, 3).join(", ")})`;
}

/**
 * PURE. Every holder, among the pull requests and rows handed over, waiting on a blocked pull request. One chain per (holder session, target): a pull request and the row it closes that
 * declare the same wait are one chain. A holder waiting on itself is not one.
 */
export function chainWaitsOf({ prs, rows }: { prs: readonly any[]; rows: readonly any[] }): ChainWait[] {
  const blocked = new Map<string, { raw: any; reason: string }>();
  for (const raw of prs) {
    const reason = blockedReasonOf(raw);
    if (reason !== null) blocked.set(refOf(raw), { raw, reason });
  }
  const found = new Map<string, ChainWait>();
  const holders = [...prs.map((raw) => ({ raw, kind: "pr" as const })), ...rows.map((raw) => ({ raw, kind: "row" as const }))];
  for (const { raw, kind } of holders) {
    for (const wait of declaredWaitsOf(waitItemOf(raw, kind)).waits) {
      if (!isItemWait(wait) || (wait.state !== "merged" && wait.state !== "closed")) continue;
      const target = blocked.get(`${wait.repo ?? ""}#${wait.number}`);
      if (target === undefined || target.raw === raw) continue;
      const session = sessionOf(raw);
      const key = `${session ?? `${kind}:${refOf(raw)}`}->${refOf(target.raw)}`;
      if (found.has(key)) continue;
      const display = (item: any) => `${repoOf(item) === "" ? "" : repoOf(item)}#${Number(item.number)}`;
      found.set(key, { key, holder: display(raw), holderKind: kind === "pr" ? "pull request" : "row", session, target: display(target.raw), targetRef: subjectRef(target.raw.repoKey, target.raw.number), reason: target.reason });
    }
  }
  return [...found.values()];
}

/**
 * PURE. The next episodes and what this tick must do about them. A chain first read now starts its clock and does nothing. One that has stood `CHAIN_WAIT_MINUTES` is put to its holder, once
 * (to the escalation at once when no session is known); one that stood a further `CHAIN_WAIT_MINUTES` after that wake is escalated, once. One not read now is dropped and returned as broken.
 * @param previous the last tick's episodes, `{}` for none or after a gap in observation
 */
export function advanceChainWaits(previous: Record<string, ChainEpisode>, seen: readonly ChainWait[], now: number): { episodes: Record<string, ChainEpisode>; moves: ChainMove[]; broken: { key: string; minutes: number }[] } {
  const episodes: Record<string, ChainEpisode> = {};
  const moves: ChainMove[] = [];
  for (const wait of seen) {
    if (Object.hasOwn(episodes, wait.key)) continue;
    const prior = Object.hasOwn(previous, wait.key) ? previous[wait.key] : { since: now, woke: null, escalated: false };
    const move = nextChainMove(prior, wait, now);
    episodes[wait.key] = move === null ? prior : move.episode;
    if (move !== null) moves.push(move.move);
  }
  const broken = Object.entries(previous).filter(([key]) => !Object.hasOwn(episodes, key)).map(([key, { since }]) => ({ key, minutes: Math.max(0, Math.round((now - since) / 60000)) }));
  return { episodes, moves, broken };
}

function nextChainMove(prior: ChainEpisode, wait: ChainWait, now: number): { episode: ChainEpisode; move: ChainMove } | null {
  if (prior.escalated) return null;
  if (prior.woke === null && now - prior.since >= CHAIN_WAIT_MS) {
    if (wait.session === null) return { episode: { ...prior, woke: now, escalated: true }, move: { kind: "escalate", wait, since: prior.since, woken: false } };
    return { episode: { ...prior, woke: now }, move: { kind: "wake-holder", wait, since: prior.since } };
  }
  if (prior.woke !== null && now - prior.woke >= CHAIN_WAIT_MS) return { episode: { ...prior, escalated: true }, move: { kind: "escalate", wait, since: prior.since, woken: true } };
  return null;
}

/** What the holder is woken with, once: the chain in a sentence, and the two ways out, the cheaper first. */
export function chainWaitWakeText({ holder, holderKind, target, reason }: ChainWait, minutes: number): string {
  return `your ${holderKind} ${holder} has waited ${minutes} minutes on ${target}, and ${target} is itself blocked: ${reason}. Nothing in this chain moves by itself, because the change you wait on is not being worked. `
    + `Choose now: (1) rebase ${holder} onto its base, regenerate whatever generated file conflicts, and carry on without ${target}; or (2) take ${target}'s change into ${holder} if it is inside your Region, and say on ${target} that you did. `
    + `If the chain is still standing ${CHAIN_WAIT_MINUTES} minutes after this, the gate puts it to ${CHAIN_WAIT_ESCALATION_SESSION}.`;
}

/** What the escalation is woken with: both items named, why the target is blocked, and whether the holder was woken before it. */
export function chainWaitEscalationText({ holder, holderKind, target, reason, session }: ChainWait, { minutes, woken }: { minutes: number; woken: boolean }): string {
  const before = woken ? `${session} was woken ${CHAIN_WAIT_MINUTES} minutes ago with the choice to rebase or take ${target}'s change in, and the chain is still standing.`
    : "No session is known to hold it, so nobody could be woken with the choice.";
  return `chain wait: ${holderKind} ${holder} has waited ${minutes} minutes on ${target}, which is blocked (${reason}). ${before} `
    + `Decide the direction: have ${holder} rebase and go on without ${target}, take ${target}'s change into ${holder}, or put ${target} to its owner.`;
}

/** The order for one move. The discriminator carries the episode's start, so a chain that stands again later is a new order and one that stands on is the same. */
export function chainWaitOrder(move: ChainMove, now: number): BlockingOrder {
  const { wait, since } = move;
  const minutes = Math.max(0, Math.round((now - since) / 60000));
  const slug = `${wait.key.replace(/[^\w.-]+/g, "-")}-${since}`;
  const subject = `pr-${wait.targetRef}`; // the established spelling (`pr-1014`, `pr-agent-org#1037`), which the ledger's subject parser reads
  if (move.kind === "wake-holder") {
    const session = wait.session as string;
    return { session, cause: "ready-row-unclaimable", subject, discriminator: slug, prompt: chainWaitWakeText(wait, minutes), causeKey: `${session}/chain-wait/${slug}` };
  }
  return { session: CHAIN_WAIT_ESCALATION_SESSION, cause: "ready-row-unclaimable", subject, discriminator: `${slug}-escalated`,
    prompt: chainWaitEscalationText(wait, { minutes, woken: move.woken }), causeKey: `${CHAIN_WAIT_ESCALATION_SESSION}/chain-wait/${slug}-escalated` };
}

/**
 * THE ONE PLACE THE GATE ASKS FOR CHAIN WAITS: the orders this tick owes. FLAG OFF reads nothing, writes nothing and returns none. Never throws. A record that cannot be written returns NO order, because a wake
 * whose memory was lost would be sent again on the next tick, which is the repeat this exists to stop.
 */
export function chainWaitOrders({ prs, rows, stateDir, state, now, log }: { prs: readonly any[]; rows: readonly any[]; stateDir: string; state: CanaryState; now: number; log: (line: string) => void }): BlockingOrder[] {
  if (!machineryFlagOn(state, CHAIN_WAIT_FLAG)) return [];
  const path = `${stateDir}/${CHAIN_WAIT_FILE}`;
  try {
    const recorded = readJsonObject(path);
    const continuous = typeof recorded.at === "number" && now >= recorded.at && now - recorded.at <= MAX_TICK_GAP_MS;
    const { episodes, moves, broken } = advanceChainWaits(continuous ? recorded.episodes ?? {} : {}, chainWaitsOf({ prs, rows }), now);
    writeJsonObject(path, { at: now, episodes });
    for (const { key, minutes } of broken) log(`chain-wait: ${key} is no longer standing after ${minutes} minutes.\n`);
    return moves.map((move) => chainWaitOrder(move, now));
  } catch (error) {
    log(`chain-wait: no order this tick, the record was not kept (${String((error as Error).message).split("\n")[0]}).\n`);
    return [];
  }
}
