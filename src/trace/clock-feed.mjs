// @ts-check
// a11ign/a11ign#3517 (#3494's done-when 5): THE TRACE STORE IS THE ONE SOURCE FOR "HOW LONG" ON A ROW OR PULL REQUEST. The outcome clock (#3486, `org-health.mjs`) and
// the store each date an item from GitHub, by separate paths: the clock from `pr list`'s `createdAt` and from the newest claim-record comment, the store from
// `issues/{n}.created_at` and the same comment (`github-events.mjs`). Left alone they are two stopwatches that happen to start together, and nothing says so the day
// one of them moves.
//
// THIS IS A PURE READ OF THE STORE'S RECORDS: no `gh`, no clock, no file. It is what a figure about a row's time is taken from, and the test beside it holds the outcome
// clock's `since` to it for the same rows. The clock itself is NOT fed from here at run time: the gate does not ingest the store on each tick, so a clock that read a
// store file would age every item from the last ingest and look quiet about it.
//
// WHAT THE STORE DOES NOT HOLD, so what this cannot say: a reopen (`GITHUB_KINDS` has no `reopened`), so an item that was closed and opened again reads as stopped.
// The clock only runs on OPEN items, so that gap never reaches a comparison, and it is named here because a reader of a closed item's figure would meet it.
import { eventsForRow } from "./store.mjs";

/**
 * @typedef {{ repo: string, kind: "pr" | "row", number: number }} ClockSubject
 * @typedef {{ bornAt: number | null, since: number | null, stoppedAt: number | null }} RowClock
 * `bornAt` is when the row was FILED or the pull request OPENED; `since` is when the outcome clock starts (the same instant for a pull request, the newest claim for a
 * row) and `null` when the store holds nothing that dates it (an unknown, never an age); `stoppedAt` is when a merge or a close stopped it, `null` while it runs.
 */

/**
 * The store's github records of ONE item, in the order GitHub wrote them. The id prefix names the repository: `eventsForRow` finds a number in any repository, and a
 * row and a pull request of another repository with the same number would otherwise date this one.
 * @param {import("./store.mjs").TraceEvent[]} events @param {ClockSubject} subject
 * @returns {import("./store.mjs").TraceEvent[]}
 */
function recordsOf(events, { repo, kind, number }) {
  const ofItem = eventsForRow(events, kind === "pr" ? { rows: [], prs: [number] } : { rows: [number], prs: [] });
  return ofItem.filter((event) => event.source === "github" && event.id.startsWith(`gh:${repo}#${number}:`));
}

/** When the row was filed or the pull request opened. @param {import("./store.mjs").TraceEvent[]} records @returns {number | null} */
const bornOf = (records) => records.find((event) => event.kind === "filed" || event.kind === "opened")?.at ?? null;

/**
 * When the clock starts. A pull request's is when it was OPENED. A row's is its NEWEST claim record, as the clock's own `claimRecordOf` reads it: a newest record that
 * is a RELEASE is no claim, so the row has no age (`null`) and is not read as young.
 * @param {import("./store.mjs").TraceEvent[]} records @param {"pr" | "row"} kind @returns {number | null}
 */
function startOf(records, kind) {
  if (kind === "pr") return bornOf(records);
  const newest = records.filter((event) => event.kind === "claimed" || event.kind === "released").at(-1);
  return newest?.kind === "claimed" ? newest.at : null;
}

/**
 * When a merge or a close stopped it: a merge if there was one, else the newest close. A comment, a label, a push and a hold are not in this answer, which is the
 * clock's own rule: only a merge or a close stops it.
 * @param {import("./store.mjs").TraceEvent[]} records @returns {number | null}
 */
function stopOf(records) {
  const merged = records.find((event) => event.kind === "merged");
  return merged?.at ?? records.filter((event) => event.kind === "closed").at(-1)?.at ?? null;
}

/**
 * THE CLOCK OF ONE ROW OR PULL REQUEST, from the store's records alone.
 * @param {import("./store.mjs").TraceEvent[]} events the store's events (`readStore`), any number of items
 * @param {ClockSubject} subject
 * @returns {RowClock}
 */
export function clockFeedOf(events, subject) {
  const records = recordsOf(events, subject);
  return { bornAt: bornOf(records), since: startOf(records, subject.kind), stoppedAt: stopOf(records) };
}

/**
 * How long, in milliseconds: to the stop where a merge or a close stopped it, else to `now`. `null` when nothing dates the item, never zero.
 * @param {RowClock} clock @param {number} now @returns {number | null}
 */
export function openMsOf({ since, stoppedAt }, now) {
  return since === null ? null : (stoppedAt ?? now) - since;
}
