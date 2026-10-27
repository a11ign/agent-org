// @ts-check
// module: the files a round-cap planner round is given or leaves beside its outcome file (A11-343)

/**
 * What the board leaves beside the outcome file of the planner's round for a run at the board's round cap (A11-343), which no worker may write. The round has the mark `cap-planner-run`, and its Stop is refused until it has written `cap-decision.json`:
 * `{ "decision": "round", "reason": "<the Decision, in words>" }` to record a Decision and start one more round with it, or `{ "decision": "waiting", "ticket": "<KEY>", "reason": "..." }` to mark the run as waiting on a named ticket. A round that
 * escalates writes no decision: it ends `needs-human`, naming an item of the escalation list.
 */
/** The mark the board leaves for the planner's round at the cap. */
export const CAP_PLANNER_FILE = "cap-planner-run";
/** What the planner's round at the cap writes: its decision and the reason. */
export const CAP_DECISION_FILE = "cap-decision.json";
