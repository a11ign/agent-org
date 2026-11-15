// no-token: none -- the reviewer's Codex sessions are fixture rollouts in a scratch folder; the queue is an in-memory store
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "../../lib/tmp-fixture.ts";
import { recordReview } from "../pool-reviewers.ts";
import type { PoolContext } from "../pool-context.ts";
import type { Entry, Queue } from "../queue/queue-entries-and-outcomes.ts";
import { latestOutcomes, outcomesPath, readOutcomes } from "./outcome-record.ts";
import { dayFolders, reviewerTurns } from "./reviewer-tokens.ts";

const PR = "https://github.com/a11ign/agent-org/pull/7";
const LABEL = "reviewer-agent-org-7";
const T0 = Date.parse("2026-11-10T10:00:00Z");
const MIN = 60_000;

/** A Codex rollout of a reviewer that ran in `cwd`, with one request per `[at, input, cached, output]`, written in the date folder of its first request. */
function rollout(dir: string, name: string, cwd: string, requests: readonly (readonly [number, number, number, number])[]): void {
  const folder = join(dir, dayFolders(requests[0][0], requests[0][0])[1]);
  mkdirSync(folder, { recursive: true });
  const lines = [
    { timestamp: new Date(requests[0][0] - 1_000).toISOString(), type: "session_meta", payload: { cwd } },
    { timestamp: new Date(requests[0][0] - 1_000).toISOString(), type: "turn_context", payload: { model: "gpt-5.6-luna" } },
    ...requests.map(([at, input, cached, output], index) => ({ timestamp: new Date(at).toISOString(), type: "token_usage_record",
      payload: { response_id: `${name}-${index}`, usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output } } })),
  ];
  writeFileSync(join(folder, `rollout-${name}.jsonl`), `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
}

/** A pool context holding one finished run of A11-7 whose first round has ended, with the reviewer's seat for `head` remembered. */
function heldRun(heads: ReadonlyMap<string, string>, now: { at: number }) {
  const stateDir = tmpDir("review-end-");
  const codexSessions = tmpDir("codex-sessions-");
  const entry = {
    ticket: { key: "A11-7", labels: [{ name: "Feature" }] }, model: "opus", effort: "high", repos: ["agent-org"], phase: "finished",
    outcome: { kind: "ready-pr", prs: [{ repo: "a11ign/agent-org", url: PR }] },
    outcomeRun: { since: T0, rounds: [{ startedAt: T0, endedAt: T0 + 10 * MIN, outcome: "ready-pr", tokens: { "claude-opus-5-5": { input: 1, output: 1, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 } } }] },
  } as unknown as Entry;
  let queue = { entries: [entry] } as unknown as Queue;
  const ctx = { settings: { stateDir }, codexSessions, now: () => now.at, reviewerMemory: { heads: new Map(heads) },
    store: { get: () => queue, set: (next: Queue) => { queue = next; } } } as unknown as PoolContext;
  return { ctx, stateDir, codexSessions, queue: () => queue };
}

test("A11-430: a pull request the reviewer reviewed twice leaves both reviews' tokens on the run's outcome record, each turn in the review that made it", async () => {
  const now = { at: T0 + 30 * MIN };
  const run = heldRun(new Map([[LABEL, "h1"]]), now);
  // The first review: a session of the seat, started after the run's first round, and a session of another seat at the same time, which is not this run's.
  rollout(run.codexSessions, "first", `/home/agent/reviews/${LABEL}`, [[T0 + 20 * MIN, 1_000, 400, 50], [T0 + 21 * MIN, 2_000, 1_500, 60]]);
  rollout(run.codexSessions, "other", "/home/agent/reviews/reviewer-agent-org-8", [[T0 + 20 * MIN, 9_999, 0, 9_999]]);
  await recordReview(run.ctx, { pr: PR, head: "h1", verdict: "not-convinced", posted: T0 + 22 * MIN });
  // A look of the same verdict again records nothing more.
  await recordReview(run.ctx, { pr: PR, head: "h1", verdict: "not-convinced", posted: T0 + 22 * MIN });
  // The re-review at the next head resumes the same session: its rollout holds the first review's requests again, and one of its own.
  now.at = T0 + 60 * MIN;
  (run.ctx.reviewerMemory.heads as Map<string, string>).set(LABEL, "h2");
  rollout(run.codexSessions, "first", `/home/agent/reviews/${LABEL}`, [[T0 + 20 * MIN, 1_000, 400, 50], [T0 + 21 * MIN, 2_000, 1_500, 60], [T0 + 50 * MIN, 3_000, 2_000, 70]]);
  await recordReview(run.ctx, { pr: PR, head: "h2", verdict: "convinced", posted: T0 + 51 * MIN });

  const [record] = latestOutcomes(readOutcomes(outcomesPath(run.stateDir)));
  const luna = (tokens: Record<string, { input: number; cacheRead: number; output: number }> | undefined) => [tokens?.["gpt-5.6-luna"]?.input, tokens?.["gpt-5.6-luna"]?.cacheRead, tokens?.["gpt-5.6-luna"]?.output];
  assert.deepEqual(record.reviews?.map(({ head, verdict }) => [head, verdict]), [["h1", "not-convinced"], ["h2", "convinced"]], "both reviews, once each");
  assert.deepEqual(luna(record.reviews?.[0].tokens), [600 + 500, 400 + 1_500, 50 + 60], "the first review: its own seat's two requests, input less the cached part");
  assert.deepEqual(luna(record.reviews?.[1].tokens), [1_000, 2_000, 70], "the second: only the request made after the first was recorded");
  assert.deepEqual(luna(record.reviewerTokens), [2_100, 3_900, 180], "the record's reviewer total is both reviews");
  assert.deepEqual(record.prs, [PR]);
  assert.equal(run.queue().entries[0].outcomeRun?.reviews?.length, 2, "the queue keeps the reviews, so the next round's record carries them");
});

test("A11-430: a review whose reviewer turns cannot be found is unread, never 0, and a run with no record yet gets none", async () => {
  const run = heldRun(new Map([[LABEL, "h1"]]), { at: T0 + 30 * MIN });
  await recordReview(run.ctx, { pr: PR, head: "h1", verdict: "convinced", posted: T0 + 22 * MIN });
  const [record] = latestOutcomes(readOutcomes(outcomesPath(run.stateDir)));
  assert.match(record.reviews?.[0].unread ?? "", /no Codex turn of reviewer-agent-org-7/);
  assert.equal(record.reviews?.[0].tokens, undefined);

  const fresh = heldRun(new Map([[LABEL, "h1"]]), { at: T0 + 30 * MIN });
  const { outcomeRun: _none, ...unrecorded } = fresh.queue().entries[0];
  fresh.ctx.store.set({ entries: [unrecorded] } as unknown as Queue);
  await recordReview(fresh.ctx, { pr: PR, head: "h1", verdict: "convinced", posted: T0 + 22 * MIN });
  assert.deepEqual(readOutcomes(outcomesPath(fresh.stateDir)), [], "no round of the run has ended, so there is no record to add a review to");
});

test("A11-430: a reviewer's rollout with a broken line in its middle is unreadable, and one with a half-written last line is read", async () => {
  const dir = tmpDir("codex-broken-");
  rollout(dir, "a", `/r/${LABEL}`, [[T0 + MIN, 10, 0, 1]]);
  const folder = join(dir, dayFolders(T0 + MIN, T0 + MIN)[1]);
  writeFileSync(join(folder, "rollout-a.jsonl"), `${JSON.stringify({ timestamp: new Date(T0).toISOString(), type: "session_meta", payload: { cwd: `/r/${LABEL}` } })}\n`
    + `${JSON.stringify({ timestamp: new Date(T0 + MIN).toISOString(), type: "token_usage_record", payload: { response_id: "r1", usage: { input_tokens: 10, output_tokens: 1 } } })}\n{"half`);
  assert.equal("turns" in await reviewerTurns({ dir, label: LABEL, after: T0, now: T0 + 2 * MIN }), true, "a half-written last line is a live session's");
  writeFileSync(join(folder, "rollout-a.jsonl"), `${JSON.stringify({ timestamp: new Date(T0).toISOString(), type: "session_meta", payload: { cwd: `/r/${LABEL}` } })}\nnot json\n`
    + `${JSON.stringify({ timestamp: new Date(T0 + MIN).toISOString(), type: "token_usage_record", payload: { response_id: "r1", usage: { input_tokens: 10, output_tokens: 1 } } })}\n`);
  const read = await reviewerTurns({ dir, label: LABEL, after: T0, now: T0 + 2 * MIN });
  assert.match("unreadable" in read ? read.unreadable : "", /has a line that is not JSON/);
});

test("A11-430: a review appended to a batch-planned run's record keeps the batch the round's record named", async () => {
  const run = heldRun(new Map([[LABEL, "h1"]]), { at: T0 + 30 * MIN });
  const [entry] = run.queue().entries;
  run.ctx.store.set({ entries: [{ ...entry, outcomeRun: { ...entry.outcomeRun, batch: { id: "batch-1", share: 2, of: 3 } } }] } as unknown as Queue);
  rollout(run.codexSessions, "first", `/home/agent/reviews/${LABEL}`, [[T0 + 20 * MIN, 1_000, 400, 50]]);
  await recordReview(run.ctx, { pr: PR, head: "h1", verdict: "convinced", posted: T0 + 22 * MIN });
  const [record] = latestOutcomes(readOutcomes(outcomesPath(run.stateDir)));
  assert.deepEqual(record.batch, { id: "batch-1", share: 2, of: 3 });
});
