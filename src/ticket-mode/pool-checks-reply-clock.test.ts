// no-token: gh -- A11-437: the rerun a worker's reply asks for (A11-300) is stamped with the time the board read once the code host took it, as before the state machine, so the next watch reads a failure from before it as the one that was rerun
import { test } from "node:test";
import assert from "node:assert/strict";
import { answerChecks } from "./pool-checks.ts";
import { createFakeCodeHost } from "../plugins/fakes/code-host.ts";
import type { PullFeedback } from "../plugins/contracts/code-host.ts";
import type { Entry } from "./queue/queue-entries-and-outcomes.ts";
import type { CheckHead } from "./board-view/view-types-and-filters.ts";
import type { PoolContext } from "./pool-context.ts";

const URL_1 = "https://github.com/a11ign/agent-org/pull/1946";
const HEAD = "fc707690".padEnd(40, "0");
const SUITE_JOB = "https://github.com/a11ign/agent-org/actions/runs/40382975143/job/2";
const NOW = Date.parse("2026-10-26T19:00:00Z");
const MINUTE = 60_000;
const WORKERS = "a11ign-workers";
const RERUN_TAKES = 2 * MINUTE;

const red = (over: Partial<PullFeedback> = {}): PullFeedback => ({
  state: "open", feedbackAt: null, authors: [], failing: ["suite (2)"], failures: [{ name: "suite (2)", detailsUrl: SUITE_JOB }], failedAt: null, conflicting: false,
  mergeable: true, head: HEAD, approvedAtHead: false, base: "main", files: [], filesComplete: true, pendingRequired: [], ...over,
});

test("A11-437: the rerun a reply asks for is stamped after the code host takes it, so a failure from while it was being made is still the one that was rerun", async () => {
  const host = createFakeCodeHost();
  host.checksAndClaims.logs.set(SUITE_JOB, "FAIL  src/a.test.ts > a test");
  host.seedPull("a11ign/agent-org", 1946, { head: HEAD });
  host.pullAt(URL_1)!.replies = [{ author: WORKERS, at: NOW - 5 * MINUTE, url: `${URL_1}#issuecomment-1`, text: "No change: this failure is unrelated to my change, it is the runner's." }];
  const clock = { at: NOW };
  const rerunFailedChecks = host.rerunFailedChecks.bind(host);
  // The rerun takes the host a while: the board reads the clock again once it is made.
  host.rerunFailedChecks = async (urls) => { clock.at += RERUN_TAKES; return rerunFailedChecks(urls); };
  const ctx = { codeHost: host, now: () => clock.at, flakes: { record: () => undefined, view: () => [] }, repliesRead: new Set<string>(), ownLogin: { value: WORKERS } } as unknown as PoolContext;
  const entry = (checkHeads: Readonly<Record<string, CheckHead>>): Entry =>
    ({ ticket: { key: "A11-294", description: "" }, paths: [], phase: "finished", startedAt: NOW - 30 * MINUTE, outcome: { kind: "reviewed", prs: [{ repo: "agent-org", url: URL_1 }] }, pullStates: { [URL_1]: "open" }, checkHeads }) as unknown as Entry;
  const rerun = await answerChecks(ctx, entry({ [URL_1]: { head: HEAD, step: "round" } }), [{ url: URL_1, read: red() }]);
  assert.deepEqual([rerun.heads[URL_1]?.rerun?.for, rerun.heads[URL_1]?.rerun?.at], ["reply", NOW + RERUN_TAKES], "stamped when the host had taken it");
  // A failure the host reports from while the rerun was being made is the one that was rerun: the board waits, and names no one.
  const next = await answerChecks(ctx, entry(rerun.heads), [{ url: URL_1, read: red({ failedAt: NOW + MINUTE }) }]);
  assert.deepEqual([next.heads[URL_1]?.step, host.checksAndClaims.reruns.length], ["rerun", 1]);
});
