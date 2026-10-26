// @ts-check
// module: the files a stand-off round is given or leaves beside its outcome file (A11-290)

/**
 * What the board leaves beside the outcome file of a stand-off round (A11-290), which no worker may write. The planner's round has the mark `standoff-planner-run`, and its Stop is refused until it has written `standoff-decision.json`
 * (`{ "decision": "amended" | "upheld", "reason": "..." }`). The worker's round has `standoff-round.json`, the head and the description each pull request had when the round began, by address: a `reviewed` that leaves both as they were is refused.
 */
/** The mark the board leaves for the planner's round. */
export const STANDOFF_PLANNER_FILE = "standoff-planner-run";
/** The head and description hash of each pull request, left for the worker's round. */
export const STANDOFF_ROUND_FILE = "standoff-round.json";
/** What the planner's round writes: its decision and the reason. */
export const STANDOFF_DECISION_FILE = "standoff-decision.json";
