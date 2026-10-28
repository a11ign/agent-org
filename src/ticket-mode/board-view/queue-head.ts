// @ts-check
// module: the record of what the board did about a pull request's removals from the merge queue (A11-264, A11-295, A11-371)

import type { FlakeCandidate } from "./check-rerun-record.ts";

/**
 * The rerun of a merge group's failed jobs (A11-371), made before any worker is asked: when (`at`, epoch milliseconds), the runs rerun (`runs`, ids) and the tests or steps that failed (`candidates`), which the flake log records
 * if the rerun passes.
 */
export type QueueRetry = Readonly<{ at: number; runs: readonly number[]; candidates: readonly FlakeCandidate[] }>;

/**
 * What the board did about the merge queue's removals of one pull request at one head (A11-264): a fix round was started for the first one (`round`), they are named for a person and no round is started (`named`), or the pull
 * request was removed three times for failed checks with no push between and is held from the arm bot (`held`). A11-295 adds `rearmed`: the arm bot was asked to arm the pull request again, because the removal was not the change's
 * (its failed jobs failed before the code ran) or because the round it started ended with no push. `removals` counts the removals for `failed_checks` at this head, `jobs` names the jobs that failed in the `merge_group` run behind the newest,
 * `note` is the line the card shows (a round has none), and `held` says the `hold:board` label is on the pull request until a new head lifts it.
 * A11-371 adds `retrying`: the removal's failed jobs were rerun (`retry`) and the board waits for them before it asks a worker or the arm bot; `retried` says the rerun was made for this head (it is made once, so a second removal goes to the run), and `rerunPassed` that it passed and the arm bot was asked. A round for a removal the board reran the jobs of carries the note "sent to the run".
 * `rearms` counts the times the arm bot was asked at this head (at most `MAX_REARMS` (`pool-merge-queue.ts`)), `roundStarted` says a round was started at this head (it is started once for a head), `roundEnded` that the board handled the end of that round (it put the pull request back in the queue, or said in the log why it did not), and `refused` is why the arm bot could not be asked, which the next watch asks again.
 */
export type QueueHead = Readonly<{ head: string; step: "round" | "named" | "held" | "rearmed" | "retrying"; removals: number; jobs?: readonly string[]; note?: string; held?: boolean; rearms?: number; roundStarted?: boolean; roundEnded?: boolean; refused?: string; retried?: boolean; retry?: QueueRetry; rerunPassed?: boolean }>;
