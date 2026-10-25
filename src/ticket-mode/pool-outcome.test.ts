// no-token: none -- pure functions over a read
// module: what the pool quotes of a conflicting pull request to a worker, given what the board did about its base (A11-286)
import { test } from "node:test";
import assert from "node:assert/strict";
import type { PullFeedback } from "../plugins/contracts/code-host.ts";
import { baseMergeLines, conflictLines, feedbackSince, type BaseMerge } from "./pool-outcome.ts";

const URL = "https://github.com/a11ign/agent-org/pull/1921";
const HEAD = "a".repeat(40);
const LINE = `${URL} conflicts with its base branch main.`;
const COMMAND = "Merge it with: git fetch origin main && git merge origin/main, resolve the files above, run the tests and push.";
const read = (more: Partial<PullFeedback> = {}): PullFeedback => ({ state: "open", feedbackAt: null, authors: [], failing: [], failures: [], failedAt: null, conflicting: true, mergeable: false, head: HEAD, approvedAtHead: false, base: "main", files: [], filesComplete: true, ...more }) as PullFeedback;
const merges = (record: BaseMerge): ReadonlyMap<string, BaseMerge> => new Map([[URL, record]]);

test("A11-286: a pull request the board is merging the base into gives no conflict line, and one whose files are being listed none either", () => {
  for (const step of ["merging", "listing"] as const) {
    assert.equal(feedbackSince([{ url: URL, read: read() }], 0, merges({ head: HEAD, step })), null, step);
    assert.equal(conflictLines([{ url: URL, read: read() }], merges({ head: HEAD, step })), null, step);
  }
});

test("A11-286: a pull request whose merge found a real conflict gives the conflict line, the files and the merge command", () => {
  const found = merges({ head: HEAD, step: "round", files: ["src/a.ts", "src/b.ts"] });
  const expected = [LINE, "Merging main into it conflicted in src/a.ts, src/b.ts.", COMMAND].join("\n");
  assert.equal(feedbackSince([{ url: URL, read: read() }], 0, found), expected);
  assert.equal(conflictLines([{ url: URL, read: read() }], found), expected);
  const unlisted = merges({ head: HEAD, step: "round", files: null });
  assert.equal(conflictLines([{ url: URL, read: read() }], unlisted), [LINE, "Merging main into it conflicted, and the board could not list the files.", COMMAND].join("\n"));
});

test("A11-286: every other record, a record for another head, and no record give the plain conflict line, as before", () => {
  for (const record of [{ head: HEAD, step: "waiting" }, { head: HEAD, step: "refused", reason: "no" }, { head: HEAD, step: "capped" }, { head: "b".repeat(40), step: "merging" }, { head: "b".repeat(40), step: "round", files: ["x"] }] as const) {
    assert.equal(feedbackSince([{ url: URL, read: read() }], 0, merges(record)), LINE, JSON.stringify(record));
  }
  assert.equal(feedbackSince([{ url: URL, read: read() }], 0), LINE, "no records at all");
  assert.equal(conflictLines([{ url: URL, read: read() }]), LINE);
});

test("A11-286: a pull request that does not conflict, or is merged, is named for nothing the board did", () => {
  const found = merges({ head: HEAD, step: "round", files: ["x"] });
  assert.equal(feedbackSince([{ url: URL, read: read({ conflicting: false }) }], 0, found), null);
  assert.equal(conflictLines([{ url: URL, read: read({ state: "merged" }) }], found), null);
  assert.equal(feedbackSince([{ url: URL, read: read({ conflicting: false, feedbackAt: 5, authors: ["carol"] }) }], 0, found), `New review feedback on ${URL}, the newest from carol.`, "review feedback is named as it was");
});

test("A11-286: a base the host did not say is worded as the base", () => {
  assert.deepEqual(baseMergeLines(null, ["x"]), ["Merging its base into it conflicted in x.", "Merge it with: git fetch origin <base> && git merge origin/<base>, resolve the files above, run the tests and push."]);
});
