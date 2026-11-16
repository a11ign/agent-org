// no-token: gh -- the code host and the clock are injected fakes; nothing is spawned
// module: a pull request the board put back in the merge queue, then removed from it for another reason, says why on the card (A11-437) -- before, its record kept no line, and it sat out of the queue with no reason shown
import { test } from "node:test";
import assert from "node:assert/strict";
import { createFakeCodeHost } from "../plugins/fakes/code-host.ts";
import type { PullFeedback, QueueRemoval } from "../plugins/contracts/code-host.ts";
import type { QueueHead } from "./board-view/queue-head.ts";
import { answerQueue } from "./pool-merge-queue.ts";
import type { PoolContext } from "./pool-context.ts";
import type { Entry } from "./queue/queue-entries-and-outcomes.ts";

const URL = "https://github.com/a11ign/agent-org/pull/7";
const HEAD = "c3f2b457e09fb02e0e46763028d538694c498674";
const FAILED: QueueRemoval = { at: Date.parse("2026-11-15T10:00:00Z"), reason: "failed_checks", actor: "github-merge-queue", groupCommit: "3a79176dacf2b6c34571d8c490daf1cb946dee88" };

/** The record of a head the board re-armed once, after the pull request went back in the queue: the card's line is cleared, the re-arm stays counted. */
const PUT_BACK: QueueHead = { head: HEAD, step: "rearmed", removals: 1, jobs: ["install"], rearms: 1 };

const feedback = (removals: QueueRemoval[]): PullFeedback => ({
  state: "open", feedbackAt: null, authors: [], failing: [], failures: [], failedAt: null, conflicting: false, mergeable: true, head: HEAD, approvedAtHead: true, base: "main", files: ["src/a.ts"], filesComplete: true,
  queue: { queued: false, removals },
});

/** The pool context over a fake code host that holds the pull request, so it can be held from the arm bot. */
function contextOf(): PoolContext {
  const host = createFakeCodeHost();
  host.seedPull("a11ign/agent-org", 7, { head: HEAD });
  return { codeHost: host, now: () => Date.parse("2026-11-15T11:00:00Z"), flakes: { record: () => undefined } } as unknown as PoolContext;
}

/** The answer to one watch of the pull request, the entry holding `known` for it and the queue having removed it `removals` since its head last moved. */
async function answeredFrom(known: QueueHead, removals: QueueRemoval[]) {
  const entry = { ticket: { key: "A11-437" }, phase: "finished", queueHeads: { [URL]: known } } as unknown as Entry;
  return answerQueue(contextOf(), entry, [{ url: URL, read: feedback(removals) }]);
}

const LATER = Date.parse("2026-11-15T10:30:00Z");
const answered = (removal: QueueRemoval) => answeredFrom(PUT_BACK, [FAILED, removal]);

test("A11-437: a re-armed pull request a person then removes from the queue says so on the card, and keeps its re-arms", async () => {
  const answer = await answered({ at: LATER, reason: "dequeued", actor: "a-person", groupCommit: null });
  assert.deepEqual(answer.heads[URL], { ...PUT_BACK, note: "removed from the merge queue by a-person: dequeued" });
  assert.deepEqual([answer.feedback, answer.conflict], [null, null], "no round is started");
});

test("A11-437: a re-armed pull request the queue then removes for a conflict says so on the card", async () => {
  const answer = await answered({ at: LATER, reason: "merge_conflict", actor: "github-merge-queue", groupCommit: null });
  assert.equal(answer.heads[URL]?.note, "removed from the merge queue: merge_conflict");
});

test("A11-437: a pull request whose round was started, removed a third time for failed checks and then for a conflict, is still counted and held, as before", async () => {
  const known: QueueHead = { head: HEAD, step: "rearmed", removals: 2, jobs: ["ui"], roundStarted: true, rearms: 1 };
  const answer = await answeredFrom(known, [FAILED, FAILED, FAILED, { at: LATER, reason: "merge_conflict", actor: "github-merge-queue", groupCommit: null }]);
  assert.deepEqual(answer.heads[URL], { ...known, step: "held", removals: 3, held: true, note: "removed from the merge queue 3 times: ui" });
});

test("A11-437: a re-armed pull request whose round was started is counted before the card names a removal by a person", async () => {
  const known: QueueHead = { head: HEAD, step: "rearmed", removals: 1, jobs: ["ui"], roundStarted: true, rearms: 1 };
  const answer = await answeredFrom(known, [FAILED, FAILED, { at: LATER, reason: "dequeued", actor: "someone", groupCommit: null }]);
  assert.deepEqual(answer.heads[URL], { ...known, removals: 2, note: "removed from the merge queue by someone: dequeued" });
});
