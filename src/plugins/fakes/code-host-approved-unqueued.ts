// @ts-check
// module: the in-memory code host's reads for the daily approved-unqueued reading (agent-org#893, A11-160 step 9, part B): the reviews of a pull request and the window of merged pull requests, over the world
//
// The world holds ONE account of a pull request's reviews (`FakeRowPull.reviews`, `state` and `submittedAt`) and of when it entered the merge queue (`queuedAt`); the two operations present it the way the
// plugin's two reads do: the REST list spells a review's time `submitted_at`, and the GraphQL window spells it `submittedAt` and carries only the approving reviews' state and time beside the queue entries.
import type { CodeHostRows } from "../contracts/code-host-rows.ts";
import type { FakeRowsWorld } from "./code-host-rows.ts";

/** The reviews and merge-queue reads of the approved-unqueued reading, over `world`. */
export function approvedUnqueuedOperations(world: FakeRowsWorld): Pick<CodeHostRows, "reviewsOf" | "mergedWindowOf"> {
  return {
    reviewsOf: ({ number }) => {
      const pull = world.pulls.get(number);
      if (pull === undefined) throw new Error(`the fake holds no pull request #${number}`);
      return (pull.reviews ?? []).map(({ state, submittedAt }) => ({ state, submitted_at: submittedAt }));
    },
    // The most recently UPDATED merged pull requests first (a pull request that was never updated since it merged is as old as its merge), as the plugin's GraphQL read orders them.
    mergedWindowOf: ({ window }) => [...world.pulls.values()]
      .filter((pull) => pull.merged && pull.mergedAt !== null)
      .sort((a, b) => Date.parse(b.updatedAt ?? b.mergedAt!) - Date.parse(a.updatedAt ?? a.mergedAt!))
      .slice(0, window)
      .map((pull) => ({ number: pull.number, mergedAt: pull.mergedAt, reviews: [...(pull.reviews ?? [])], queuedAt: [...(pull.queuedAt ?? [])] })),
  };
}
