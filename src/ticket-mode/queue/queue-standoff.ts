// @ts-check
// module: the stand-off of a re-review that stays not convinced at an unchanged head, and the two rounds that settle it (A11-290) -- PURE
//
// THE DESIGN HAD NO ROUTE FOR A REVIEWER AND A WORKER WHO STILL DISAGREE AFTER ONE EXCHANGE. A worker answers a block with no commit (a description edit and a reply); the board re-reviews the same head (A11-156, A11-235); the verdict door refuses a
// second review at an equal patch, so a re-review that stays not convinced left nothing: no result, no round, and, thirty minutes later, a card for a person (A11-213). Now the door's refusal is RECORDED (`recordRereview`: a `rereview` event with
// the reasons, and the stand-off on the run), and the stand-off is routed ONCE FOR EACH HEAD: to the planner first when the worker's reply disputes a decision of the plan or the ticket (the only one who can change such a decision), then to the worker.
// A person sees it only after both routes have ended (`staleBlockNote`, A11-213). The two rounds are review rounds of the run, queued by {@link standoffRound}, and they count toward no cap: a stand-off is routed once for each head, so it cannot repeat.
import { openPulls } from "../board-view/view-types-and-filters.ts";
import { find, replace, reviewRound, type Entry, type Queue } from "./queue-entries-and-outcomes.ts";
import type { PlannerDecision, Standoff } from "./standoff-types.ts";
import { logEvent, logOf, REREVIEW_REASONS_MAX, shortReason } from "./run-log.ts";

/** What a re-review that the verdict door refused came to: the pull request and head, the reviewer's block the worker answered (null when its text was not read), the verdict the re-reviewer wrote, its file as it wrote it, and the worker's replies on the pull request (null when none was read). */
export type RereviewResult = Readonly<{ url: string; head: string; review: string | null; verdict: "convinced" | "not-convinced"; reasons: string; reply: string | null }>;

/** The text cut to `chars` characters, with an ellipsis when it was longer. PURE. */
const cut = (text: string, chars: number): string => (text.length > chars ? `${text.slice(0, chars - 1).trimEnd()}…` : text);

/** Whether the stand-off on `entry` is for pull request `url` at `head`. PURE. */
const isFor = (standoff: Standoff | undefined, url: string, head: string): standoff is Standoff => standoff?.url === url && standoff.head === head;

/**
 * A re-review of pull request `result.url` at `result.head` ended with the verdict door refusing it: the result is logged as a `rereview` event, with the reasons, and a `not-convinced` one opens the stand-off on the run that holds the pull
 * request (a finished one; any other run is mid-round, and its round reads the pull request itself). A stand-off already open for that head keeps its stage and takes the newest reasons and reply. PURE.
 */
export function recordRereview(queue: Queue, key: string, result: RereviewResult, now?: number): Queue {
  const { url, head, review, verdict, reasons, reply } = result;
  const logged = logEvent(queue, key, now, { kind: "rereview", url, head, verdict, reasons: cut(reasons.trim(), REREVIEW_REASONS_MAX) });
  if (verdict !== "not-convinced") return logged;
  return replace(logged, key, (entry) => {
    if (entry.phase !== "finished") return entry;
    const standoff: Standoff = isFor(entry.standoff, url, head) ? { ...entry.standoff, review, reasons, reply } : { url, head, review, reasons, reply, stage: "open" };
    return { ...entry, standoff };
  });
}

/** Whether a stand-off round of kind `stage` may start from the stand-off's stage now: the planner's only from `open`, the worker's from `open` (no decision disputed, or no planner) or `planned` (the planner has decided). PURE. */
const startsFrom = (standoff: Standoff, stage: "planner" | "worker"): boolean => (stage === "planner" ? standoff.stage === "open" : standoff.stage === "open" || standoff.stage === "planned");

/** Whether `entry` is a finished run whose stand-off a round of kind `stage` may start from. PURE. */
const mayRoute = (entry: Entry | undefined, stage: "planner" | "worker"): entry is Entry & { standoff: Standoff } => entry?.phase === "finished" && entry.standoff !== undefined && startsFrom(entry.standoff, stage);

/**
 * The run's round for its stand-off, as a review round of the same worker's pull requests that carries `feedback`: the planner's (`stage: "planner"`, the run starts as the planner, with the review, the reply and the re-review) or the worker's
 * (`stage: "worker"`, with the re-reviewer's reasons and what the planner decided). It counts toward no cap, so `rounds` is carried as it is. A run that is not finished, or has no stand-off a round of that kind may start from, is left alone. PURE.
 */
export function standoffRound(queue: Queue, key: string, stage: "planner" | "worker", feedback: string, now: number): Queue {
  const entry = find(queue, key);
  if (!mayRoute(entry, stage)) return queue;
  const { standoff } = entry;
  const round: Entry = { ...reviewRound(entry, openPulls(entry), now), feedback, ...(entry.rounds === undefined ? {} : { rounds: entry.rounds }), standoff: { ...standoff, stage } };
  const queued = { ...queue, entries: [...queue.entries.filter((each) => each.ticket.key !== key), round] };
  const routed = logEvent(queued, key, now, { kind: "round", cause: stage === "planner" ? "standoff-planner" : "standoff-worker", reason: shortReason(feedback) });
  return logEvent(routed, key, now, { kind: "standoff", url: standoff.url, head: standoff.head, step: stage, detail: stage === "worker" && standoff.planner !== undefined ? `the planner ${standoff.planner.decision} the decision` : null });
}

/** The planner's round ended having decided (`decision`, with its `reason`): the stand-off is `planned`, and what the planner decided is kept for the worker's round and the card. PURE. */
export function plannerDecided(queue: Queue, key: string, decision: PlannerDecision, now: number): Queue {
  const entry = find(queue, key);
  const standoff = entry?.standoff;
  if (entry === undefined || standoff === undefined || standoff.stage !== "planner") return queue;
  const decided = replace(queue, key, (held) => ({ ...held, standoff: { ...standoff, stage: "planned" as const, planner: decision, decidedAt: now } }));
  return logEvent(decided, key, now, { kind: "standoff", url: standoff.url, head: standoff.head, step: "decided", detail: `${decision.decision}: ${shortReason(decision.reason) ?? "no reason given"}` });
}

/** The worker's round for the stand-off ended: both routes that apply have ended, and the A11-213 flag may stand behind them. PURE. */
export function workerRoundEnded(queue: Queue, key: string): Queue {
  return replace(queue, key, (entry) => (entry.standoff?.stage === "worker" ? { ...entry, standoff: { ...entry.standoff, stage: "done" as const } } : entry));
}

/**
 * The stand-off ended with no person (A11-290, the health number): the pull request is now at another head, or approved at the head the stand-off was about. The stand-off goes, and a `settled` event is logged once, with how. Read
 * on every watch of the run's heads, so a stand-off whose pull request merged or closed is dropped with its record. PURE.
 */
export function settleStandoff(queue: Queue, key: string, now?: number): Queue {
  const entry = find(queue, key);
  const standoff = entry?.standoff;
  const read = entry?.pullHeads?.[standoff?.url ?? ""];
  if (entry === undefined || standoff === undefined || read === undefined) return queue;
  const how = read.head !== standoff.head ? "a new head" : read.review === "approved" ? "an approval" : null;
  if (how === null) return queue;
  const { standoff: _settled, ...rest } = entry;
  const dropped = replace(queue, key, () => rest);
  return logEvent(dropped, key, now, { kind: "standoff", url: standoff.url, head: standoff.head, step: "settled", detail: `by ${how}` });
}

/** The stand-offs the logs show settled with no person, with the time each was: the health number's count (A11-290). PURE. */
export function standoffsSettled(queue: Queue): readonly number[] {
  return Object.keys(queue.runLog ?? {}).flatMap((key) => logOf(queue, key).filter((event) => event.kind === "standoff" && event.step === "settled").map(({ at }) => at)).sort((a, b) => a - b);
}
