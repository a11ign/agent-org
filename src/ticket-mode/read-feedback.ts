// @ts-check
// module: the one read of a pull request's feedback that feeds the board -- the accounts whose feedback is not the worker's to answer, and the review comments the card names (`tickets.reviewComments`, code host contract 4.1)
//
// Every caller whose read reaches the board reads through here, so none can leave out the review comments and lose the card's clause for them. A caller that deliberately reads with neither says so where it calls the code host.
import type { PullFeedback } from "../plugins/contracts/code-host.ts";
import type { PoolContext } from "./pool-context.ts";

/** The feedback on the pull request at `url`, leaving out what `self` and the reviewer wrote, with the review comment the host file names at its head, or null for "could not ask". */
export const readFeedbackOf = (ctx: Pick<PoolContext, "codeHost" | "feedbackIgnores" | "settings">, url: string, self: string): Promise<PullFeedback | null> =>
  ctx.codeHost.readPullFeedback(url, self, ctx.feedbackIgnores, ctx.settings.reviewComments);
