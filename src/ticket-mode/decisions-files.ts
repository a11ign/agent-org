// @ts-check
// module: the file a round that answers a change of the ticket's Decisions is given beside its outcome file (A11-305)

/**
 * What the board leaves beside the outcome file of a round whose brief opens with a change of the Decisions (A11-305), which no worker may write: `{ "added": [<the new lines>], "heads": { <pull request address>: <head> | null } }`, the head each pull request had when
 * the round began. A `reviewed` that leaves every head as it was is refused unless the final message quotes the new lines (`decisionsStop` in `hook.ts`).
 */
export const DECISIONS_ROUND_FILE = "decisions-round.json";
