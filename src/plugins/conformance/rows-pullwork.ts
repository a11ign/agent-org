// @ts-check
// module: the code host contract suite's checks of the pullwork section of `rows` (A11-160, step 9)
import type { CodeHostRows } from "../contracts/code-host-rows.ts";
import type { RowsPullwork } from "../contracts/code-host-rows-pullwork.ts";
import type { Conditional } from "./suite.ts";
import { expect } from "./suite.ts";
import { refused, throws, withRunRows, type Subject } from "./rows-support.ts";

/** The operations of this section, each a function of the rows. */
export const PULLWORK_OPERATIONS = [
  "pullWriteArgs", "armArgsAfterCreate", "labelArgsAfterCreate", "labelCreateArgs", "labelExistsForOpening", "pullHeadForOpening", "rowBodyForOpening", "branchHeadForOpening", "authoringLoginOf",
  "heldPullLabelsOf", "editHeldPullLabel", "autoMergeOfHeldPull", "autoMergeRequestOfHeldPull", "armHeldPull", "disarmHeldPull", "holdTargetRowOf", "openPullNumberOfBranch", "pullHeadRefsPageOf", "openPullsForSweep",
  "commentOnCheckoutPull", "closeCheckoutPull", "pullsListedForStop",
] as const satisfies readonly (keyof RowsPullwork & keyof CodeHostRows)[];

/** The checks of this section: a refused read throws or answers null, a refused write throws. Each is `withRunRows(...)` or `withRows(...)` of `rows-support.ts`. */
export const PULLWORK_CHECKS: Readonly<Record<string, Conditional<Subject>>> = {
  "a read the rows could not make for opening a pull request throws, never an empty answer": withRunRows("no refused read is asked", ({ rows, probe }) => {
    const { repository: repo } = probe;
    const reads: Record<string, () => unknown> = {
      labelExistsForOpening: () => rows.labelExistsForOpening({ name: "x", repo, run: refused }), pullHeadForOpening: () => rows.pullHeadForOpening({ repo, number: "1", run: refused }),
      rowBodyForOpening: () => rows.rowBodyForOpening({ repo, number: 1, run: refused }),
      branchHeadForOpening: () => rows.branchHeadForOpening({ repo, branch: "b", run: refused }),
    };
    for (const [name, read] of Object.entries(reads)) expect(throws(read), `${name} must throw when the read is refused: "could not ask" is never "absent" or an empty answer`);
    const login = rows.authoringLoginOf({ run: refused });
    expect("failures" in login && login.failures.length > 0, "a login that no read could say must answer why, never a login");
  }),
  "a read the rows could not make for a hold answers null, never nobody holds it": withRunRows("no refused read is asked", ({ rows, probe }) => {
    const { repository: repo } = probe;
    expect(rows.heldPullLabelsOf({ repo, number: 1, run: refused }) === null, "the labels of a pull request that could not be read must be null: an empty list is the answer that hands out a hold");
    expect(rows.autoMergeOfHeldPull({ repo, number: 1, run: refused }) === null && rows.holdTargetRowOf({ repo, number: 1, run: refused }) === null, "an auto-merge request or a row that could not be read must be null");
    expect(throws(() => rows.autoMergeRequestOfHeldPull({ number: 1, repo, run: refused })), "the auto-merge request read back after a disarm must throw when it cannot be read: unverified is not disarmed");
  }),
  "a read the rows could not make for the branch tools and the Stop hook throws, never an empty listing": withRunRows("no refused read is asked", ({ rows, probe }) => {
    const { repository: repo } = probe;
    const reads: Record<string, () => unknown> = {
      openPullNumberOfBranch: () => rows.openPullNumberOfBranch({ repo, branch: "b", run: refused }), pullHeadRefsPageOf: () => rows.pullHeadRefsPageOf({ repo, page: 1, pageSize: 100, run: refused }),
      openPullsForSweep: () => rows.openPullsForSweep({ limit: 400, run: refused }), pullsListedForStop: () => rows.pullsListedForStop({ repo, limit: 100, run: refused }),
    };
    for (const [name, read] of Object.entries(reads)) expect(throws(read), `${name} must throw when the read is refused: a listing that could not be made is never an empty one`);
  }),
  "a write the rows could not make for a hold, the sweep and the daily post throws, so no caller reads it as done": withRunRows("no refused write is asked", ({ rows, probe }) => {
    const { repository: repo } = probe;
    const writes: Record<string, () => unknown> = {
      editHeldPullLabel: () => rows.editHeldPullLabel({ repo, number: 1, label: "x", how: "add", run: refused }), armHeldPull: () => rows.armHeldPull({ number: 1, repo, run: refused }),
      disarmHeldPull: () => rows.disarmHeldPull({ number: 1, repo, run: refused }), commentOnCheckoutPull: () => rows.commentOnCheckoutPull({ number: 1, body: "b", run: refused }),
      closeCheckoutPull: () => rows.closeCheckoutPull({ number: 1, run: refused }),
    };
    for (const [name, write] of Object.entries(writes)) expect(throws(write), `${name} must throw when the write is refused`);
  }),
};
