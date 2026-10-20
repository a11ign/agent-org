import { READY_LABEL, CLAIM_LABEL } from "../../claim-labels.ts";
import { subjectMention, subjectRef } from "../../review-attribution.ts";
import { BACKLOG_LABEL, OUT_OF_RELEASE_LABEL } from "../../project-vocabulary.ts";
import { PROJECT_NUMBER } from "../../board-snapshot-scope.ts";
import type { OpenItemsReader } from "../../ticket-port/port.ts";
import { githubTicketAdapter } from "../../ticket-port/github-adapter.ts";
import { defaultRun, repoNow } from "../reads/read-memo-and-exit.ts";

/**
 * A ROW FILED WITHOUT `row-file` IS INVISIBLE ON PROJECT 1, AND THE CHECK THAT SEES IT WOKE NOBODY (#2075). `row-file` is the only path that boards a row and nothing requires it. Measured 2026-09-23: 9 of 50 open rows had no Project 1 item, two of them `ready` (claimable on the label, invisible in every Status view), and 28 of the 121 rows filed since 2026-09-22T00:00Z (23%) never reached the board. `ready-label-audit`'s `reportAbsentFromBoard` asked exactly this and answered correctly -- on a daily schedule, into a nightly that is red by design, so #1889 was still absent twenty hours after it printed `ABSENT`. This is that question asked where `agent-practices.md` says such a question belongs: in the gate, on an API call rather than a model turn and not a day late. IT ASKS EACH ROW FOR ITS OWN MEMBERSHIP AND NEVER READS THE BOARD LISTING, and that is the load-bearing choice. Measured 2026-09-23 (the row's own comment): `gh project item-list` did NOT contain #2075 and #2076 about four minutes after they were added, while `repository.issue(n).projectItems` reported both on the board seconds later. A tick runs every two minutes, so a listing-based cause would wake `product-manager` for rows `row-file` had just boarded correctly -- the noisiest possible false positive, on the one path that works. One connection query carries every open row's `projectItems` in a single call, so this costs no more than the listing would have. `onBoard` IS TRI-STATE: `true`, `false`, or `null` for "could not tell" -- a row with more items than the page returned and none of them Project 1, which is not the same claim as "not on the board" and is never reported as one.
 */
// agent-org#490: `boardedAs` is set only by `settleOffBoardRows`, on a row the gate boarded THIS TICK that still declares no release, so the order can ask for the one thing the gate does not do.
export type BoardFacts = { number: number, title: string, createdMs: number, onBoard: boolean | null, boardedAs?: string };

/**
 * HOW YOUNG A ROW IS TOO YOUNG TO CALL OFF THE BOARD. Not a lag allowance -- the read above has none -- but the window in
 * which `row-file` itself is between `gh issue create` and the board: the `item-add` of #2028 landed 3s after its creation and
 * the Status and label 8s and 9s after it (a timeline read from GitHub, ONE observation, not a bound). Five minutes is thirty
 * times that observation and one third of a wake's expiry window; a row genuinely left off is reported five minutes later than
 * it could have been, which nobody can measure against a defect that ran for twenty hours. CHOSEN WITH MARGIN, NOT DERIVED --
 * so it is a named constant beside its reason, and the freshness case in `work-gate.test.ts` pins that a row younger than
 * it is not reported.
 */
export const ROW_OFF_BOARD_GRACE_MS = 5 * 60_000;

/**
 * Every open row's Project 1 membership, read PER ISSUE, or `null` when the read was refused or is not a whole list.
 *
 * `null` MEANS COULD NOT ASK, NEVER "NOTHING IS OFF THE BOARD" -- #1286's rule, for its reason: a refused `gh` exits non-zero
 * with empty stdout, and an empty answer would read as a clean board. `errors` beside `data` is refused too (#555), and so is
 * a list still paging at the adapter's page cap.
 *
 * #3448: THE GRAPHQL POOL THE ANSWER NAMES IS PUSHED ONTO `pools` (the first page's: one budget, read once), so the tick learns its own account's budget from the
 * read it was making. A refused read pushes nothing, and the pool-low signal then says it was not read.
 *
 * agent-org#484: THE FIRST CONSUMER OF THE TICKET PORT. It asks the tracker only through `OpenItemsReader` (`ticket-port/port.ts`), and the GitHub adapter
 * holds the query, the paging and the Project 1 test that used to live here; the facts it returns are unchanged.
 */
export function readRowsOffBoard(run: (args: string[]) => string = defaultRun, pools: import("../../org-health/claim-and-tick-readings.ts").PoolReading[] = []): BoardFacts[] | null {
  const reader: OpenItemsReader = githubTicketAdapter({ run, scope: repoNow() });
  const items = reader.readOpenItems({ onBudget: (budget) => pools.push(budget) });
  return items === null ? null : items.map(({ ref, title, openedAtMs, onBoard }) => ({ number: ref.id, title, createdMs: openedAtMs, onBoard }));
}

/**
 * The open rows that are provably off Project 1, oldest number first: no item there, and old enough that `row-file` cannot
 * still be on its way to adding one.
 */
export function rowsOffBoard(facts: BoardFacts[], nowMs: number = Date.now()): { number: number; repoKey?: string; title: string; }[] {
  return facts
    .filter((f) => f.onBoard === false && nowMs - f.createdMs >= ROW_OFF_BOARD_GRACE_MS)
    .map(({ number, title }) => ({ number, title }))
    .sort((a, b) => a.number - b.number);
}

/**
 * THE CAUSE: an open row has no item on Project 1, and `product-manager` is asked to board it (#2075).
 *
 * KEYED ON THE SET OF ABSENT ROW NUMBERS, `fleetBatchOrders`'s shape and for its reason: the key changes when the set
 * changes, so a row newly off the board is a new question, and it is the same string while the set is unchanged, so the wake
 * ledger's dedupe does not re-ask a settled one (#1433/#1435's defect from the other side). An EMPTY set is no order: this org
 * is normally clean, and a cause that could not go quiet would fire on every tick for ever. `null` (could not ask) is also no
 * order -- silence that is NOT a clean board, which the tick says on stderr.
 *
 * PLACED BESIDE `hostDriftOrders` in `decide`, AND FOR ITS REASON: a tracker that has drifted from what was filed is finished work
 * that has not taken effect (the row exists; nobody can see it) -- more urgent than a supply question, less urgent than a named
 * red build, and not withheld by a drain (see `START_CAUSES`).
 *
 * IT DOES NOT BOARD THE ROW. Boarding carries a Status judgment (#1990 is `In progress`, #2068 is `Ready`) and this repository's
 * audits report the debris rather than act on the tracker.
 *
 * agent-org#490 NARROWED WHAT REACHES IT, NOT WHAT IT DOES: `settleOffBoardRows` boards a row whose label names a Status before this is
 * called, so the facts it is given are the rows that did not have one (and a row the gate boarded that declares no release, `boardedAs`).
 * THE TWO ARE TWO ORDERS, each keyed on its own set: the rows still off the board keep the key they always had, so they are not asked again when only
 * the boarded rows left the facts (the review of #685); the boarded ones that need a release declaration are one order, once, under `.../boarded/<set>`.
 *
 * @param facts `readRowsOffBoard`'s result, as `settleOffBoardRows` left it; OMITTED AND `null` MEAN "NOT ASKED"
 */
export function rowOffBoardOrders(facts: BoardFacts[] | null | undefined, nowMs: number = Date.now()): {
    session: string; cause: string; subject: string; discriminator: string;
    prompt: string; causeKey: string;
}[] {
  const absent = rowsOffBoard(facts ?? [], nowMs);
  if (absent.length === 0) return [];
  const boardedAs = new Map((facts ?? []).filter((f) => f.boardedAs !== undefined).map((f) => [f.number, f.boardedAs as string]));
  const unboarded = absent.filter((r) => !boardedAs.has(r.number));
  const boarded = absent.filter((r) => boardedAs.has(r.number));
  const keyOf = (rows: typeof absent) => rows.map((r) => subjectRef(r.repoKey, r.number)).join(".");
  const orders: ReturnType<typeof rowOffBoardOrders> = [];
  // agent-org#490, THE REVIEW OF #685: THE KEY IS THE UNBOARDED SET ALONE. A row the gate boarded is gone from `readRowsOffBoard` on the next tick, so a key
  // built from both would change when only the boarded rows left, and the unchanged remainder would be asked again. Its own order, its own key, once.
  if (unboarded.length > 0) orders.push({ session: "product-manager", cause: "row-off-board", subject: "project-1", discriminator: keyOf(unboarded),
    causeKey: `product-manager/row-off-board/${keyOf(unboarded)}`, prompt: `${unboarded.length} open row(s) have NO item on Project ${PROJECT_NUMBER}, so they are invisible in every Status view:\n`
      + unboarded.map((r) => `  ${subjectMention(r)} ${r.title}`).join("\n") + "\n"
      + "A row filed with a bare `gh issue create` never reaches the board: only `row-file` boards one, and a board label applied "
      + `AT CREATION (\`${READY_LABEL}\` or \`${BACKLOG_LABEL}\` one second after the row exists) is the fingerprint of that path. Each was read from `
      + "the ISSUE's own `projectItems`, not from a board listing (which lags minutes behind an add), and none is younger than "
      + `${ROW_OFF_BOARD_GRACE_MS / 60_000} minutes.\n`
      + `For each: add it to Project 1 at the Status its label says (\`${READY_LABEL}\` -> Ready, \`${BACKLOG_LABEL}\` -> Backlog, \`${CLAIM_LABEL}\` -> `
      + `In progress), and give it a release declaration (a milestone or \`${OUT_OF_RELEASE_LABEL}\`) if it has none -- \`row-file\` would have `
      + "refused a filing without one. An `epic` cannot be claimed, so it is boarded with `row-file --board=<n> --lane=any`, which puts it at Backlog "
      + "(#4456) -- never raw `gh project item-add`. THIS ORDER DOES NOT BOARD THE ROW FOR YOU: the Status is a judgment and it is yours.\n"
      + "THIS ARRIVES WHEN THE SET CHANGES. A row you leave off stays in the set and this order returns unchanged." });
  // agent-org#490: the gate boarded these itself, and the order names them for the one thing it does not do.
  if (boarded.length > 0) orders.push({ session: "product-manager", cause: "row-off-board", subject: "project-1-release", discriminator: `boarded.${keyOf(boarded)}`,
    causeKey: `product-manager/row-off-board/boarded/${keyOf(boarded)}`, prompt: `${boarded.length} open row(s) were off Project ${PROJECT_NUMBER} and the gate BOARDED them this tick, each at the Status its label says, `
      + "but each declares no release:\n"
      + boarded.map((r) => `  ${subjectMention(r)} ${r.title} (boarded at ${boardedAs.get(r.number)})`).join("\n") + "\n"
      + `Give each a release declaration (a milestone or \`${OUT_OF_RELEASE_LABEL}\`) -- \`row-file\` would have refused a filing without one. `
      + "The gate does not choose one: which release a row belongs to is a judgment, and the ticket port has no milestone write. "
      + "THEY ARE ON THE BOARD NOW, so this order does not return for them." });
  return orders;
}
