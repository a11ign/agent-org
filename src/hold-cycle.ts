// @ts-check
// module: a hold whose `--until=closed #N` names a row that waits, through its pull request, on the held pull request (a11ign/agent-org#1396, the a11ign/a11ign#928 class 1 deadlock)
//
// `pr:hold --until=closed #N` says the held pull request waits on row N. When row N's open pull request (or row N itself) waits on the held one, `merged <held>`, or on a row the held
// pull request closes, `closed <row>`, neither can move: agent-org#1365 was held `closed #1325` while #1378, which closes #1325, waited `merged #1365`, and both sat for about 2 h.
// `take` refuses a hold that would close such a cycle before anything is written.
//
// A LEAF like `b4-cycle.ts`: pure, no `gh` call, and no knowledge of how a refusal is worded. The caller reads the parties and hands them over. An edge the caller could not read is not an
// edge: a cycle is named only on a path that was actually read. It walks ONE hop past the target (the target's waits and its open pull requests' waits), which is what the row names.

import { isItemWait } from "./wait-condition.ts";
import type { Wait } from "./wait-condition.ts";

/**
 * A row or pull request as the cycle sees it. `key` and every `closes` entry are `owner/repo#n`, lower-cased; `home` is the repository a bare `#n` in `waits` names (the party's own).
 * `closes` lists the rows a pull request closes (a row has none).
 */
export type CycleParty = { key: string, home: string, waits: Wait[], closes: string[] };

/**
 * `owner/repo#n` for a reference, lower-cased: GitHub's names are case-insensitive and `closedRefsOf` lower-cases the repository it reads. A bare `#n` (`repo` `null`) names `home`.
 * @param {string | null} repo @param {number} number @param {string} home @returns {string}
 */
export function refKey(repo: string | null, number: number, home: string): string {
  return `${(repo ?? home).toLowerCase()}#${number}`;
}

/**
 * The chain that closes the cycle, or `null` when the hold closes none. `held` is the pull request the hold is taken on, `target` the row its `--until=closed` names, and `closing`
 * the open pull requests that close the target. The path starts and ends at the held pull request: `[held, target, closing, held]` when a closing pull request waits on it, or
 * `[held, target, held]` when the target itself does. The held pull request is excluded from `closing` (a pull request that closes its own target is not a second party).
 * @param {CycleParty} held @param {CycleParty} target @param {CycleParty[]} closing @returns {string[] | null}
 */
export function holdCycleOf(held: CycleParty, target: CycleParty, closing: CycleParty[]): string[] | null {
  const direct = leadsBack(target, held);
  if (direct !== null) return [held.key, ...direct];
  for (const pr of closing) {
    if (pr.key === held.key) continue;
    const back = leadsBack(pr, held);
    if (back !== null) return [held.key, target.key, ...back];
  }
  return null;
}

/**
 * The waiter's own path to `held`: `[waiter, held]` for `merged <held>`, or `[waiter, row, held]` for `closed <row>` where `held` closes `row`. Only the two item states
 * name a cycle: a release fact or a label is not a wait on a pull request's merge.
 * @param {CycleParty} waiter @param {CycleParty} held @returns {string[] | null}
 */
function leadsBack(waiter: CycleParty, held: CycleParty): string[] | null {
  for (const wait of waiter.waits) {
    if (!isItemWait(wait)) continue;
    const key = refKey(wait.repo, wait.number, waiter.home);
    if (wait.state === "merged" && key === held.key) return [waiter.key, held.key];
    if (wait.state === "closed" && held.closes.includes(key)) return [waiter.key, key, held.key];
  }
  return null;
}

/**
 * The cycle as prose for a refusal: `a11ign/agent-org#1365, which waits on a11ign/a11ign#1325, which waits on a11ign/agent-org#1378, which waits on a11ign/agent-org#1365`. Every step is a
 * wait in the sense that matters here: a row closed by a pull request cannot be done before that pull request merges.
 * @param {string[]} path @returns {string}
 */
export function holdCycleText(path: string[]): string {
  const [first, ...waits] = path;
  return `${first}${waits.map((key) => `, which waits on ${key}`).join("")}`;
}
