// A test-support module (A11-160, step 9, part B): the fake code host's world for the tests of the daily approved-unqueued reading (agent-org#893). `seeded` holds the pull requests of the tick's list (open, armed or not),
// the merged ones the p90 is over, and the comments on the reading's row, WATCHES the rows (`calls`: every operation asked, with its request) and puts the code host where core finds it; a test calls `forgetActivation()`
// after each case. `run` is for the one read core still parses itself, whose arguments the code host builds: the arming read of a pull request, answered from the world's pull request.
import type { MergedPr, OpenPr } from "../../approved-unqueued.ts";
import { rows } from "../rows.ts";
import { fakeRow, messagingHost, type FakeRowsWorld } from "./messaging-world.test.support.ts";
import type { FakeRowPull } from "./code-host-rows.ts";

export { forgetActivation } from "./messaging-world.test.support.ts";

const MINUTE = 60_000;
export type DaysWorld = { repo: string; now: number; readingRow: number };

const openPull = ({ number, armed, createdAt }: { number: number; armed: boolean; createdAt: string }): FakeRowPull => ({ number, body: "", headRefName: `agent/pull-${number}`, labels: [], isDraft: false, armed, merged: false, mergedAt: null, createdAt, comments: [] });
const mergedPull = (done: MergedPr, createdAt: string): FakeRowPull => ({ ...openPull({ number: done.number, armed: false, createdAt }), merged: true, mergedAt: done.mergedAt ?? null,
  reviews: (done.reviews ?? []).map((review) => ({ state: String(review.state), submittedAt: String(review.submittedAt) })), queuedAt: (done.queuedAt ?? []).filter((at): at is string => at !== null) });

/** What a case seeds: the comments on the reading's row, the numbers of the pull requests auto-merge is requested on, the merged ones, and the tick's open list. */
export type Seed = { comments?: { id: number; body: string }[]; armed?: number[]; merged?: MergedPr[]; prs?: OpenPr[] };

export function seeded({ repo, now, readingRow }: DaysWorld, { comments = [], armed = [], merged = [], prs = [] }: Seed = {}) {
  const createdAt = new Date(now - 300 * MINUTE).toISOString();
  const { world, calls } = messagingHost(repo, (held: FakeRowsWorld) => {
    held.now = () => now;
    held.nextCommentId = 1000;
    held.rows.set(readingRow, fakeRow(held, readingRow, { comments: comments.map((comment) => ({ ...comment, createdAt: new Date(now).toISOString() })) }));
    for (const { number } of prs) held.pulls.set(number, openPull({ number, armed: armed.includes(number), createdAt }));
    for (const done of merged) held.pulls.set(done.number, mergedPull(done, createdAt));
  });
  const run = (args: string[]): string => {
    if (args[0] === "fake-armed-query") return JSON.stringify(rows().armedNodeOf({ repo: args[1], number: Number(args[2]) }));
    throw new Error(`no gh: ${args.join(" ").slice(0, 80)}`);
  };
  const asked = (operation: string) => calls.filter((call) => call.op === operation).map((call) => call.request);
  const writes = () => calls.filter((call) => call.op === "postRowComment" || call.op === "editComment");
  return { run, held: world, calls, asked, writes, comments: () => world.rows.get(readingRow)!.comments };
}
