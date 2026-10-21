import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { isAppLogin, spenderPhraseFor } from "../gh-ledger.ts";
import { GITHUB_ROLES, homeHostConfig, roleIdentity, type HostConfig } from "../host-config.ts";
import { APPROVED_DIRTY_MINUTES, APPROVED_DIRTY_SIGNAL, HOLDS_PER_PR, HOLDS_PER_PR_SIGNAL, SAME_WAY_RERUN_SIGNAL, type DirtyPr, type PoolReading } from "./claim-and-tick-readings.ts";
import { MAX_NAMED, MS_PER_MINUTE, POOL_LOW_FRACTION, SIGNALS, ageText, clear, hourOf, type Reading, unknown } from "./thresholds.ts";

/** `holds` is the count of `hold:` labels on one open pull request now. */
export type HoldCount = { number: number | string, holds: number };
/** `attempts` is the failing job names of each run on one head, oldest first; an empty list is a run that passed. */
export type RerunPr = { number: number | string, attempts: string[][] };
/** What `orgHealthReadings` is given for the three readings: `enabled` is the switch's decision, and each list is `null` for a refused read. */
export type ApprovedDirtyFacts = { enabled: boolean, prs: DirtyPr[] | null, holds: HoldCount[] | null, reruns: RerunPr[] | null };

const DIRTY_WINDOW_MS = APPROVED_DIRTY_MINUTES * MS_PER_MINUTE;

/**
 * An approved pull request that has been DIRTY for MORE than the window, with no push to its head inside that window: a push inside it is a rebase in progress, and the reading waits for it.
 */
function isApprovedDirty(pr: DirtyPr): boolean {
  return pr.approved && pr.mergeStateStatus === "DIRTY";
}
/** Past the window, but whether its head was pushed inside it is not known: an unread push time is not a push-free head, so it is unknown and never a finding. */
function pushUnknown(pr: DirtyPr, now: number): boolean {
  return isApprovedDirty(pr) && pr.dirtySince !== null && now - pr.dirtySince > DIRTY_WINDOW_MS && pr.headPushedAt === null;
}
function dirtyFinding(pr: DirtyPr, now: number): boolean {
  if (!isApprovedDirty(pr) || pr.dirtySince === null || now - pr.dirtySince <= DIRTY_WINDOW_MS) return false;
  return pr.headPushedAt !== null && pr.headPushedAt <= now - DIRTY_WINDOW_MS;
}

/** SIGNAL A: AN APPROVED PULL REQUEST IS DIRTY AND NOBODY IS REBASING IT. `org-health` never read the merge state, so #1130 and #1131 sat approved and DIRTY behind a red PR and no signal named them. */
export function approvedDirtyReading({ now, prs }: { now: number; prs: DirtyPr[] | null; }): Reading {
  const signal = APPROVED_DIRTY_SIGNAL;
  if (prs === null) return unknown(signal, "the open pull requests could not be read");
  const tripped = prs.filter((pr) => dirtyFinding(pr, now)).sort((a, b) => (a.dirtySince as number) - (b.dirtySince as number));
  if (tripped.length === 0) {
    const undated = prs.filter((pr) => isApprovedDirty(pr) && pr.dirtySince === null);
    if (undated.length > 0) return unknown(signal, `${undated.length} approved PR(s) are DIRTY and no tick has seen when they went DIRTY, so how long they have been DIRTY is not known`);
    const unpushed = prs.filter((pr) => pushUnknown(pr, now));
    return unpushed.length === 0 ? clear(signal) : unknown(signal, `${unpushed.length} approved PR(s) have been DIRTY over ${APPROVED_DIRTY_MINUTES} min and their head push time is not known, so whether they were pushed inside the window is not known`);
  }
  const first = (tripped[0].dirtySince as number) + DIRTY_WINDOW_MS;
  const named = tripped.slice(0, MAX_NAMED).map((pr) => `#${pr.number} (DIRTY ${ageText(pr.dirtySince as number, now)})`);
  const more = tripped.length > MAX_NAMED ? `, and ${tripped.length - MAX_NAMED} more` : "";
  return { signal, status: "tripped", firstTrippedAt: first, discriminator: `${signal}@${hourOf(first)}`,
    detail: `${tripped.length} approved PR(s) DIRTY over ${APPROVED_DIRTY_MINUTES} min with no push to their head since: ${named.join("; ")}${more}` };
}

/** SIGNAL B: A PULL REQUEST CARRYING `HOLDS_PER_PR` OR MORE HOLDS AT ONCE. Each hold is someone's stop on it, and a pile of them is a PR nobody is moving. */
export function holdsPerPrReading({ holds }: { holds: HoldCount[] | null; }): Reading {
  const signal = HOLDS_PER_PR_SIGNAL;
  if (holds === null) return unknown(signal, "the pull requests' hold labels could not be read");
  const tripped = holds.filter((pr) => pr.holds >= HOLDS_PER_PR);
  if (tripped.length === 0) return clear(signal);
  const named = tripped.slice(0, MAX_NAMED).map((pr) => `#${pr.number} (${pr.holds} holds)`);
  const more = tripped.length > MAX_NAMED ? `, and ${tripped.length - MAX_NAMED} more` : "";
  return { signal, status: "tripped", firstTrippedAt: null, discriminator: `${signal}:${tripped.map((pr) => pr.number).sort().join(",")}`,
    detail: `${tripped.length} PR(s) carry ${HOLDS_PER_PR} or more holds at once: ${named.join("; ")}${more}` };
}

/** SIGNAL C: THE LAST TWO RUNS ON A HEAD FAILED THE SAME JOBS. A rerun that fails the way the last one did is the code's failure, not a flake, so another rerun answers nothing. */
export function sameWayRerunReading({ reruns }: { reruns: RerunPr[] | null; }): Reading {
  const signal = SAME_WAY_RERUN_SIGNAL;
  if (reruns === null) return unknown(signal, "the runs on the pull requests' heads could not be read");
  const jobsKey = (jobs: string[]) => [...jobs].sort().join("\n");
  const tripped = reruns.flatMap((pr) => {
    const last = pr.attempts.slice(-2);
    return last.length === 2 && last[0].length > 0 && jobsKey(last[0]) === jobsKey(last[1]) ? [{ pr, jobs: [...last[1]].sort() }] : [];
  });
  if (tripped.length === 0) return clear(signal);
  const named = tripped.slice(0, MAX_NAMED).map(({ pr, jobs }) => `#${pr.number} (${jobs.join(", ")})`);
  const more = tripped.length > MAX_NAMED ? `, and ${tripped.length - MAX_NAMED} more` : "";
  return { signal, status: "tripped", firstTrippedAt: null, discriminator: `${signal}:${tripped.map(({ pr }) => pr.number).sort().join(",")}`,
    detail: `${tripped.length} PR(s) whose last two runs on the head failed the same jobs: ${named.join("; ")}${more}` };
}

/** The three readings when the switch is decided on; NONE when it is OFF or undecided here, which is what makes the shipped-OFF change a no-op. */
export function approvedDirtyReadings({ now, enabled, prs, holds, reruns }: ApprovedDirtyFacts & { now: number; }): Reading[] {
  if (!enabled) return [];
  return [approvedDirtyReading({ now, prs }), holdsPerPrReading({ holds }), sameWayRerunReading({ reruns })];
}

/**
 * agent-org#1248 (a11ign#928, the chairman's direction of 2026-10-12): AN APPROVED PULL REQUEST HELD AT `REVIEW_REQUIRED` IS A HEALTH FINDING. The reviewer switchover left approvals that did
 * not count toward `main`'s merge rule (a11ign#5303, #5302, agent-org#1241 and control#75 sat approved for 90 minutes), and no reading named them. SHIPPED OFF, like the approved-DIRTY readings:
 * OFF is NO reading, and the live gate does not pass the flag yet.
 *
 * THE CLASS IS NOT IN `SIGNALS`, for the reason `APPROVED_DIRTY_FLAG` gives: an order of an unregistered class falls to the suppression table's default, which pages.
 */
export const APPROVED_REQUIRED_FLAG = "health.approvedRequired";
/** How long an approved pull request may stay held at `REVIEW_REQUIRED` before it is a finding (the row's figure). */
export const APPROVED_REQUIRED_MINUTES = 10;
export const APPROVED_REQUIRED_SIGNAL = "approved-pr-review-required";

/**
 * One open pull request as the approved-REVIEW_REQUIRED reading needs it. `approvers` are the identities whose APPROVED review is on `head`, and `reviewDecision` is GitHub's, as read.
 * `heldSince` is when a tick FIRST SAW it approved and `REVIEW_REQUIRED`, kept across ticks by the caller, and `heldHead` is the head that stamp was taken on. A stamp taken on an older head
 * is not this head's age: a new head restarts the clock, so it clears the finding and is not a finding until it has been held on that head. `null` is a stamp no tick has taken.
 */
export type ApprovedRequiredPr = { number: number | string, open: boolean, reviewDecision: string | null, head: string, approvers: string[], heldHead: string | null, heldSince: number | null };
/** What `orgHealthReadings` is given for the reading: `enabled` is `health.approvedRequired`'s decision, and `prs` is `null` for a refused read. */
export type ApprovedRequiredFacts = { enabled: boolean, prs: ApprovedRequiredPr[] | null };

const APPROVED_REQUIRED_WINDOW_MS = APPROVED_REQUIRED_MINUTES * MS_PER_MINUTE;

/** Approved on its head and held at `REVIEW_REQUIRED`: the state that is a finding once it has stood past the window. A closed or merged pull request is not held. */
function isApprovedRequired(pr: ApprovedRequiredPr): boolean {
  return pr.open && pr.reviewDecision === "REVIEW_REQUIRED" && pr.approvers.length > 0;
}
function heldFinding(pr: ApprovedRequiredPr, now: number): boolean {
  return isApprovedRequired(pr) && pr.heldSince !== null && pr.heldHead === pr.head && now - pr.heldSince > APPROVED_REQUIRED_WINDOW_MS;
}

/** SIGNAL D: AN APPROVED PULL REQUEST IS HELD AT `REVIEW_REQUIRED` PAST THE WINDOW. The approval is on the head and is not counting, which is a permission or a rule excluding the approver, not a red check. */
export function approvedRequiredReading({ now, prs }: { now: number; prs: ApprovedRequiredPr[] | null; }): Reading {
  const signal = APPROVED_REQUIRED_SIGNAL;
  if (prs === null) return unknown(signal, "the open pull requests' review decisions could not be read");
  const tripped = prs.filter((pr) => heldFinding(pr, now)).sort((a, b) => (a.heldSince as number) - (b.heldSince as number));
  if (tripped.length === 0) {
    const undated = prs.filter((pr) => isApprovedRequired(pr) && pr.heldSince === null);
    return undated.length === 0 ? clear(signal) : unknown(signal, `${undated.length} approved PR(s) are held at REVIEW_REQUIRED and no tick has seen when they started to be held, so how long they have been held is not known`);
  }
  const first = (tripped[0].heldSince as number) + APPROVED_REQUIRED_WINDOW_MS;
  const named = tripped.slice(0, MAX_NAMED).map((pr) => `#${pr.number} (approved by ${pr.approvers.join(", ")}, held ${ageText(pr.heldSince as number, now)})`);
  const more = tripped.length > MAX_NAMED ? `, and ${tripped.length - MAX_NAMED} more` : "";
  return { signal, status: "tripped", firstTrippedAt: first, discriminator: `${signal}@${hourOf(first)}`,
    detail: `${tripped.length} approved PR(s) held at REVIEW_REQUIRED over ${APPROVED_REQUIRED_MINUTES} min with an approval on their head that does not count toward the merge rule: ${named.join("; ")}${more}` };
}

/** The reading when the switch is decided on; NONE when it is OFF, which is what makes the shipped-OFF change a no-op. */
export function approvedRequiredReadings({ now, enabled, prs }: ApprovedRequiredFacts & { now: number; }): Reading[] {
  if (!enabled) return [];
  return [approvedRequiredReading({ now, prs })];
}

/** agent-org#1667: `enabled` is `reviews.outsideSessionPr`'s decision; `prs` names each same-repository pull request with a `session:` label that is classed OUTSIDE, and `since` is when the canary first saw it so (`now` while the canary keeps no clock yet). `null` is a refused read. */
export type SessionPrOutsideFact = { enabled: boolean, prs: { number: number; author: string; session: string; since: number; }[] | null };

/** agent-org#1667, THE NAMED READING OF `session-pr-classed-outside`: a pull request classed OUTSIDE for `SESSION_PR_OUTSIDE_MINUTES` trips, named by author and session, so `ceo` reads whose it is. */
export function sessionPrOutsideReading({ now, prs }: { now: number; prs: SessionPrOutsideFact["prs"]; }): Reading {
  const signal = MACHINERY_SIGNALS.SESSION_PR_CLASSED_OUTSIDE;
  if (prs === null) return unknown(signal, "the open pull requests could not be read, so the ones classed OUTSIDE are not known");
  const window = SESSION_PR_OUTSIDE_MINUTES * MS_PER_MINUTE;
  const tripped = prs.filter((pr) => now - pr.since >= window).sort((a, b) => a.since - b.since);
  if (tripped.length === 0) return clear(signal);
  const first = tripped[0].since + window;
  const named = tripped.slice(0, MAX_NAMED).map((pr) => `#${pr.number} by ${pr.author} as ${pr.session}, ${Math.floor((now - pr.since) / MS_PER_MINUTE)} min`);
  const more = tripped.length > MAX_NAMED ? `, and ${tripped.length - MAX_NAMED} more` : "";
  return { signal, status: "tripped", firstTrippedAt: first, discriminator: `${signal}@${hourOf(first)}`,
    detail: `${tripped.length} same-repository PR(s) with a session: label classed OUTSIDE for ${SESSION_PR_OUTSIDE_MINUTES} min or more: ${named.join("; ")}${more}` };
}

/** The reading when `reviews.outsideSessionPr` is ON; NONE when it is OFF, so the shipped-OFF change adds no order to any tick. */
export function sessionPrOutsideReadings({ now, enabled, prs }: SessionPrOutsideFact & { now: number; }): Reading[] {
  if (!enabled) return [];
  return [sessionPrOutsideReading({ now, prs })];
}

/**
 * SIGNAL 11: A POOL IS BELOW `POOL_LOW_FRACTION` OF ITS LIMIT (#3448). A session that meets an exhausted pool sleeps on the reset, and three standing seats did at
 * once on 2026-10-04 with nothing in the org knowing why its inbox was three orders deep. The reading names the account, the pool and the reset, because "low"
 * with no window is not a measurement. `pools` is `null` when no pool was read this tick.
 *
 * A POOL AT EXACTLY THE FRACTION IS NOT RAISED (at or above clears), and a limit of 0 is unread and never a divide. Keyed on the account, the pool and the
 * reset time, so one spent window is one signal however many ticks it lasts and the next window starts a new one.
 *
 * (#4148) A LOW POOL NAMES ITS SPENDER: for a GRAPHQL pool the detail adds who spent that account's last hour, off the `plugins/github/wrapper/gh` ledger beside the config this tick ran under
 * (`spenderOf`; the default reads it). "Low" with no name is a signal nobody can act on, and the first reading of the burner took a hand-run awk. Only the DETAIL carries it:
 * the discriminator is unchanged, so one spent window is still one signal. A ledger that cannot be read leaves the detail as it was and says so, never a guess.
 *
 * (agent-org#1420) THE SENTENCE STATES THE POOL'S OWN USED POINTS (`limit - remaining`) beside the ledger's total and the share of them the ledger accounts for, and says so when
 * that is under 90%. `poolLowReading` hands `spenderOf` the used points; the sentence is built where the ledger's total is (`gh-ledger.ts` `spenderPhraseFor`).
 */
export function poolLowReading({ pools, spenderOf = (account, used) => ledgerSpender(account, undefined, used) }: { pools: PoolReading[] | null; spenderOf?: (account: string, used?: number) => string | null; }): Reading {
  if (pools === null) return unknown(SIGNALS.POOL_LOW, "no API pool was read this tick");
  const low = pools.filter((p) => p.limit > 0 && p.remaining / p.limit < POOL_LOW_FRACTION).sort((a, b) => `${a.account}/${a.resource}`.localeCompare(`${b.account}/${b.resource}`));
  if (low.length === 0) return clear(SIGNALS.POOL_LOW);
  const named = low.slice(0, MAX_NAMED).map((p) => `${p.account ?? "an unnamed account"}'s ${p.resource} pool has ${p.remaining} of ${p.limit} left`
    + ` (${Math.round((p.remaining / p.limit) * 100)}%), resetting ${p.resetAt ?? "at a time the answer did not give"}`);
  const key = low.map((p) => `${p.account}/${p.resource}/${p.resetAt}`).join(",");
  return { signal: SIGNALS.POOL_LOW, status: "tripped", firstTrippedAt: null, discriminator: `${SIGNALS.POOL_LOW}@${key}`,
    detail: `${low.length} API pool(s) are below ${Math.round(POOL_LOW_FRACTION * 100)}% of their limit: ${named.join("; ")}${spendersOf(low, spenderOf)}` };
}

/** The config directory `plugins/github/wrapper/gh` writes this process's ledger under: the one `gh` itself reads, else the default. */
const ledgerDir = () => process.env.GH_CONFIG_DIR ?? join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "gh");

/** @param {HostConfig} host @returns {string} the reviewer's `gh` config directory, `<home>/reviewer/gh` */
export const reviewerGhDir = (host: HostConfig): string => join(host.home, "reviewer", "gh");

/**
 * (#4916) EVERY LEDGER A DECLARED ROLE'S CALLS ARE WRITTEN TO: this process's own config directory and the workers', leads' and reviewer's (`plugins/github/wrapper/gh` routes a role to
 * whichever of them its session runs under, and `app:<role>` lines are in each). A directory that does not exist is not a ledger of this host and is left out; this
 * process's own stays, so a ledger it cannot read is still said. The reviewer's is `wake.ts`'s `REVIEWER_GH_CONFIG_DIR`, derived from `home` because `wake.ts` imports
 * this file; `org-health-app-spender.test.ts` pins the two together.
 * @param {{host: HostConfig, ownDir: string}} where @returns {string[]} the `gh-calls.tsv` paths, each once
 */
export function ledgerPathsOf({ host, ownDir }: { host: HostConfig; ownDir: string; }): string[] {
  const dirs = [ownDir, join(host.gh.workers, "gh"), join(host.gh.leads, "gh"), reviewerGhDir(host)].map((dir) => resolve(dir));
  return [...new Set(dirs)].filter((dir) => dir === resolve(ownDir) || existsSync(dir)).map((dir) => join(dir, "gh-calls.tsv"));
}

/** A config directory that exists and holds no `gh-calls.tsv` has had no call written to it, which is a ledger with nothing in it; a directory that is not there is unread. */
const readLedgerFile = (path: string): string => (existsSync(dirname(path)) && !existsSync(path) ? "" : readFileSync(path, "utf8"));

/** @param {HostConfig} host @returns {string[]} the roles `host.json` declares as `github-apps` */
const declaredAppRoles = (host: HostConfig): string[] => GITHUB_ROLES.filter((role) => roleIdentity(host, role).mode === "github-apps");

/**
 * The spender sentence for ONE pool's login: an account is read from its own ledger line name, an App (`<slug>[bot]`) from the `app:<role>` lines of the role that
 * owns it, and both from every ledger `ledgerPathsOf` names. `read` is the seam a test uses.
 * @param {{account: string, host: HostConfig, ownDir: string, now?: number, read?: (path: string) => string}} where
 */
export function spenderOfAccount({ account, host, ownDir, now, read = readLedgerFile, used }: { account: string; host: HostConfig; ownDir: string; now?: number; read?: (path: string) => string; used?: number; }): string | null {
  return spenderPhraseFor({ ledgers: ledgerPathsOf({ host, ownDir }), login: account, appRoles: declaredAppRoles(host), now, read, used });
}

export function ledgerSpender(account: string, hostOf: () => HostConfig = homeHostConfig, used?: number): string | null {
  const ownDir = ledgerDir();
  let host: HostConfig;
  try {
    host = hostOf();
  } catch (cause) {
    // The declaration could not be read: an ordinary account still has this process's own ledger, but an App's role cannot be named from nothing.
    if (isAppLogin(account)) return `${account} is an App and the host declaration that names its role could not be read (${(cause as Error).message}), so its spender is UNREADABLE`;
    return spenderPhraseFor({ ledgers: [join(ownDir, "gh-calls.tsv")], login: account, read: readLedgerFile, used });
  }
  return spenderOfAccount({ account, host, ownDir, used });
}

/**
 * `. Spender: ...` for each low GRAPHQL pool whose account is named, else "". An account the ledger cannot say anything of reads `UNREADABLE`, because the omission would look
 * like a clean answer.
 */
function spendersOf(low: PoolReading[], spenderOf: (account: string, used?: number) => string | null) {
  const graphql = low.filter((p) => p.resource === "graphql" && p.account !== null);
  const accounts = [...new Set(graphql.map((p) => (p.account as string)))];
  if (accounts.length === 0) return "";
  // an account's used points are its first low graphql pool's: one account has one graphql pool per reset window and this reading keys on the window
  const usedOf = (a: string) => { const p = graphql.find((q) => q.account === a) as PoolReading; return p.limit - p.remaining; };
  return `. Spender: ${accounts.map((a) => spenderOf(a, usedOf(a)) ?? `${a}'s call ledger could not be read, so the spender is UNREADABLE`).join("; ")}`;
}

// =====================================================================================================================
// MACHINERY CANARY (a11ign#5100): A CHANGE TO THE ORG'S OWN MACHINERY SHIPS BEHIND A FLAG, AND THE GATE WATCHES THE HOUR AFTER IT TURNS ON.
//
// Four regressions on 2026-10-11 were fixes, each green in its tests and broken live, and each found by the chairman: the verify row ran 24 hours after the merge and nothing watched the first hour.
//
//   THE FLAG: a named record in `machinery-canary.json` (the state directory), DEFAULT OFF. A change that touches the gate, claims, the tick, waking, arming, releases or identities reads `machineryFlagOn`
//   and keeps its old behaviour while it is off (`pr-open.ts` refuses such a pull request without a `Flag:`, `Health-signals:` and `Revert:` line). It is state beside the tick's other state rather than a key of a
//   tracked file because THE GATE TURNS IT OFF, and a write to a file of the primary checkout would trip `primary-not-at-main` and could not land past the merge queue.
//   THE SIGNALS: each tick appends ONE SAMPLE of the standard signals (`MACHINERY_SIGNALS`); a signal the tick could not read is `null`, which is not zero and is never counted as clean.
//   THE CANARY: the tick a flag is read `on` with no `onAt` starts it. The hour BEFORE is read from the samples already recorded; the hour AFTER is read as it fills. A signal whose after-count reaches
//   `degradeFactor` times its before-rate, or the day's hourly mean if that is higher (a11ign#5444), and `minRise` more, turns the flag OFF, files an incident carrying both readings, and orders `ceo`. Counts only grow, so a degraded reading half way through the hour is
//   degraded at its end, and the revert need not wait for the hour.
//   THE EXPIRY (`expireSuppressions`): a suppression that keeps an order from its holder for `suppressionMinutes` with no claimed row working its reason hands the holder the reason and the original order.
// =====================================================================================================================

/** The signals every machinery change may name (the row's table). `Health-signals:` is checked against this list, so a signal the gate does not record cannot be promised. */
export const MACHINERY_SIGNALS = Object.freeze({
  CLAIMS_REFUSED: "claims-refused",
  BLIND_TICKS: "blind-ticks",
  WAKES_HELD: "wakes-held",
  APPROVED_UNQUEUED: "approved-unqueued",
  INCIDENTS_NOT_REAL: "incidents-not-real",
  RATE_LIMIT_REFUSALS: "rate-limit-refusals",
  RELEASE_FAILURES: "release-failures",
  OWNERLESS_PR_UNREACHED: "ownerless-pr-unreached", // agent-org#1648: a red pull request the chairman opened with no session on it, that no order reaches for UNQUEUED_MINUTES
  EJECTED_NETWORK_NOT_REQUEUED: "ejected-network-not-requeued", // agent-org#1647: a queue ejection that stayed the owner's although its install failed on the network (`pr-ejected.ts`)
  GH_AUTHOR_FALLBACK: "gh-author-fallback", // agent-org#1666: an account-attributed pr create/merge/review in the ledgers, at most ten minutes old (`gh-author-fallback.ts`)
  VERDICT_WRITTEN_UNDELIVERED: "verdict-written-undelivered",
  CONFLICTING_PR_WORKER_IDLE: "conflicting-pr-worker-idle",
  SESSION_PR_CLASSED_OUTSIDE: "session-pr-classed-outside", // agent-org#1667: a same-repository pull request with a `session:` label classed OUTSIDE for SESSION_PR_OUTSIDE_MINUTES (`outside-session-pr.ts`)
  BOARD_TRUTH: "board-disagrees-with-reality", // agent-org#1670: a row or question the board disagrees with reality on (`boardTruthReadings`); sampled as the offers the tick made, see `machineryValues` (a11ign#5681)
});
/** How long a same-repository pull request with a `session:` label may be classed OUTSIDE before `session-pr-classed-outside` counts it (agent-org#1667). */
export const SESSION_PR_OUTSIDE_MINUTES = 10;
