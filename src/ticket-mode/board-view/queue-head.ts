// @ts-check
// module: the record of what the board did about a pull request's removals from the merge queue (A11-264)

/**
 * What the board did about the merge queue's removals of one pull request at one head (A11-264): a fix round was started for the first one (`round`), they are named for a person and no round is started (`named`), or the pull
 * request was removed three times for failed checks with no push between and is held from the arm bot (`held`). `removals` counts the removals for `failed_checks` at this head, `jobs` names the jobs that failed in the `merge_group` run behind the newest, `note` is the line the card
 * shows (a round has none), and `held` says the `hold:board` label is on the pull request until a new head lifts it.
 */
export type QueueHead = Readonly<{ head: string; step: "round" | "named" | "held"; removals: number; jobs?: readonly string[]; note?: string; held?: boolean }>;
