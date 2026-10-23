// @ts-check
// module: seeding a pull request into the in-memory code host's world (A11-160, step 5)
//
// A TEST SAYS WHAT IT CARES ABOUT and gets an open pull request against `main` for the rest: no labels, not a draft, not armed, no author, no comments. The fields it can set are
// {@link FakeRowPull}'s, including the ones arming and the merge guard read (author, head, base, check runs, review decision, ejection, closing rows, how far behind `main` it is).
import type { FakeRowPull, FakeRowsWorld } from "./code-host-rows.ts";

/** Puts pull request `number` into `world` with `over` laid on the plain open one, and answers it, so a test may change it afterwards. */
export function fakePull(world: FakeRowsWorld, number: number, over: Partial<FakeRowPull> = {}): FakeRowPull {
  const pull: FakeRowPull = { number, body: "", headRefName: `branch-${number}`, labels: [], isDraft: false, armed: false, merged: false, mergedAt: null, createdAt: new Date(world.now()).toISOString(), comments: [], ...over };
  world.pulls.set(number, pull);
  return pull;
}
