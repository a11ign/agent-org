// agent-org#1649: A WRITTEN REVIEWER VERDICT THAT NEVER REACHES ITS PULL REQUEST, AND A CONFLICTING PULL REQUEST WHOSE WORKER IS IDLE.
//
// THE DROP (a11ign#1615, the evidence): the outside reviewer wrote two complete verdict blocks in its pane (`1bc5c7e1`, then `716b6ce3`). The gate read the
// pane and found no verdict: the strict reader (`outsideVerdictBlock`) rejected the `• BEGIN ...` line, because Codex puts a bullet in front of the first
// line of a final message. So `postOutsideVerdict` and the door were never called, and #1615 had no review. `reviews.verdictDelivery` (review-trust.ts)
// is the switch that reads the bulleted block and posts it.
//
// THE TWO SIGNALS, read by the machinery canary (org-health.ts) once a tick like every other standard signal:
//   `verdict-written-undelivered`: a verdict block an outside reviewer WROTE and that is not on its pull request, at the head it names, 15 minutes after
//     it was first seen. Wake records every block it sees, read BULLETED, so the detector sees the block the strict reader misses (the signal must
//     trip while the flag is OFF; that is the gap). The gate reconciles the record against GitHub: a verdict of the same word at the written head is
//     delivered; a pull request that is no longer open, or whose head has moved on, is done with, and both leave the record.
//   `conflicting-pr-worker-idle`: an open pull request that conflicts with `main` whose owner's pane is idle (`IDLE_STATUSES`). The clock is the
//     canary's own memo, as `approved-unqueued`'s is.
//
// Both signals read NOTHING while `reviews.verdictDelivery` is OFF: the gate passes `null` (unread) for each, and wake neither records nor reads the bulleted
// blocks. So with the flag off the gate and the wake behave as they do today, and the canary has no clock running for either signal.
//
// THE RECORD is `verdict-written.json` in the state directory: `{ "<session>@<head>": { session, pr, head, verdict, seenAt } }`, and it holds only what is
// still undelivered. A file that does not parse THROWS (a record read wrong would forget a verdict that is owed), and the caller reads that as unread.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { IDLE_STATUSES, type Agent } from "./idle-claimant.ts";
import { headMatches, verdictAtHead, verdictBearers } from "./review-verdict.ts";
import { conflictStateOf, CONFLICT_STATE } from "./work-gate/pr-state.ts";

export const VERDICT_LEDGER_FILE = "verdict-written.json";

export type Verdict = "convinced" | "not-convinced";
/** One verdict block a pane shows, as the record keeps it: who wrote it, for which pull request and head, and the word, and the time it was first seen. */
export type WrittenVerdict = { session: string; pr: number; head: string; verdict: Verdict; seenAt: number };
export type VerdictLedger = Record<string, WrittenVerdict>;

/** The key of a written verdict: one per reviewer and head, as `postedOutside` keys them. */
export const ledgerKey = ({ session, head }: { session: string; head: string }): string => `${session}@${head}`;

/** @returns the record of a file's text; an absent file is empty, and one that is not an object THROWS. */
export function parseVerdictLedger(text: string | null): VerdictLedger {
  if (text === null || text.trim() === "") return {};
  const raw = JSON.parse(text) as unknown;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error(`${VERDICT_LEDGER_FILE} is not an object of written verdicts`);
  return raw as VerdictLedger;
}

/** The record with every verdict seen now added. A verdict already in the record keeps its first time: the clock starts when it was first written. PURE. */
export function withWrittenVerdicts(ledger: VerdictLedger, written: Omit<WrittenVerdict, "seenAt">[], now: number): VerdictLedger {
  const next = { ...ledger };
  for (const verdict of written) {
    const key = ledgerKey(verdict);
    if (!(key in next)) next[key] = { ...verdict, seenAt: now };
  }
  return next;
}

/** What GitHub says of one pull request, or `null` when the read was refused. */
export type PullRead = { open: boolean; head: string; comments: any[]; reviews: any[] } | null;

/**
 * THE RECORD AGAINST GITHUB. A written verdict is DELIVERED when the newest verdict at its head is of its word (wherever it was posted: the door, a
 * reviewer's own comment, or another reviewer's); it is DONE WITH when its pull request is no longer open or its head has moved on. What remains is
 * UNDELIVERED, and `undelivered` is the time each was first written. A refused read of any pull request the record names is `null`: nothing is said of it.
 * PURE.
 */
export function reconcileVerdictLedger(ledger: VerdictLedger, pulls: ReadonlyMap<number, PullRead | undefined>): { ledger: VerdictLedger; undelivered: number[] | null } {
  const kept: VerdictLedger = {};
  const undelivered: number[] = [];
  for (const [key, written] of Object.entries(ledger)) {
    const pull = pulls.get(written.pr);
    if (pull === undefined || pull === null) return { ledger, undelivered: null };
    if (!pull.open || !headMatches(written.head, pull.head)) continue;
    const at = verdictAtHead({ comments: verdictBearers({ comments: pull.comments, reviews: pull.reviews }), head: written.head });
    if (at.verdict === written.verdict) continue;
    kept[key] = written;
    undelivered.push(written.seenAt);
  }
  return { ledger: kept, undelivered };
}

/**
 * THE CONFLICTING PULL REQUESTS WHOSE OWNER'S PANE IS IDLE, by number. An owner that is not in the listing is not counted (that is `owner-gone`'s
 * question, not this one's). `agents` is `null` when herdr was not asked, and the answer is `null`: unread, not none. PURE.
 */
export function conflictingIdlePrs({ prs, agents, ownerOf }: { prs: any[]; agents: Agent[] | null; ownerOf: (pr: any) => { session: string | null }; }): number[] | null {
  if (agents === null) return null;
  return prs
    .filter((pr) => conflictStateOf(pr) === CONFLICT_STATE.CONFLICTING)
    .filter((pr) => {
      const session = ownerOf(pr).session;
      const status = session === null ? null : agents.find((agent) => agent.label === session)?.status ?? null;
      return status !== null && IDLE_STATUSES.includes(status);
    })
    .map((pr) => Number(pr.number));
}

/** The record as the file holds it, or an empty one when the file is not there yet. */
function readLedgerFile(dir: string): VerdictLedger {
  const path = join(dir, VERDICT_LEDGER_FILE);
  return parseVerdictLedger(existsSync(path) ? readFileSync(path, "utf8") : null);
}

/** Write the record through a rename, so a killed tick leaves the old record whole (`realCanaryIo`'s rule). */
function writeLedgerFile(dir: string, ledger: VerdictLedger): void {
  const path = join(dir, VERDICT_LEDGER_FILE);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.tmp`, `${JSON.stringify(ledger, null, 1)}\n`);
  renameSync(`${path}.tmp`, path);
}

/**
 * WAKE'S SIDE: record the verdict blocks the outside panes show this tick. A tick that wrote nothing and has no record does not create one.
 * Never throws to the caller's tick: a record that cannot be written is one line for the log, and the verdict is still posted.
 */
export function recordWrittenVerdicts({ dir, written, now }: { dir: string; written: Omit<WrittenVerdict, "seenAt">[]; now: number; }): string | null {
  if (written.length === 0) return null;
  try {
    const before = readLedgerFile(dir);
    const after = withWrittenVerdicts(before, written, now);
    if (Object.keys(after).length !== Object.keys(before).length) writeLedgerFile(dir, after);
    return null;
  } catch (error) {
    return `verdict-written not recorded (${String((error as Error).message).split("\n")[0]})`;
  }
}

/**
 * THE GATE'S SIDE, once a tick: read the record, reconcile it against GitHub through `pull` (one read per pull request the record names), and write back
 * what is still undelivered. Returns the times the undelivered verdicts were written, or `null` when the record or any pull request could not be read.
 */
export function reconcileLedgerNow({ dir, pull }: { dir: string; pull: (pr: number) => PullRead; }): number[] | null {
  let ledger: VerdictLedger;
  try {
    ledger = readLedgerFile(dir);
  } catch {
    return null;
  }
  if (Object.keys(ledger).length === 0) return [];
  const pulls = new Map<number, PullRead | undefined>();
  for (const written of Object.values(ledger)) if (!pulls.has(written.pr)) pulls.set(written.pr, pull(written.pr));
  const reconciled = reconcileVerdictLedger(ledger, pulls);
  if (reconciled.undelivered === null) return null;
  if (Object.keys(reconciled.ledger).length !== Object.keys(ledger).length) writeLedgerFile(dir, reconciled.ledger);
  return reconciled.undelivered;
}

/**
 * THE GATE'S SIDE, FLAG-GATED: with `reviews.verdictDelivery` OFF nothing is read and the answer is `null` (unread), so the canary keeps its clocks and
 * trips nothing. The row's rule: with the flag off, neither signal reads anything.
 */
export function verdictUndeliveredNow({ on, dir, pull }: { on: boolean; dir: string; pull: (pr: number) => PullRead; }): number[] | null {
  return on ? reconcileLedgerNow({ dir, pull }) : null;
}

/** The conflicting pull requests whose owner is idle, read only while `reviews.verdictDelivery` is ON; `null` when it is OFF or the pull requests are unread. */
export function conflictingIdleNow({ on, prs, agents, ownerOf }: { on: boolean; prs: any[] | null; agents: Agent[] | null; ownerOf: (pr: any) => { session: string | null }; }): number[] | null {
  return on && prs !== null ? conflictingIdlePrs({ prs, agents, ownerOf }) : null;
}

/** `gh pr view` for the reconciliation: the state, the head and the verdict-bearing fields, or `null` when the read was refused. */
export function pullReadOf(run: (args: string[]) => string, repo: string): (pr: number) => PullRead {
  return (pr) => {
    try {
      const raw = JSON.parse(run(["pr", "view", String(pr), "--repo", repo, "--json", "state,headRefOid,comments,reviews"])) as Record<string, any>;
      return { open: raw.state === "OPEN", head: String(raw.headRefOid ?? ""), comments: raw.comments ?? [], reviews: raw.reviews ?? [] };
    } catch {
      return null;
    }
  };
}
