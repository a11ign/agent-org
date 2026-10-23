// no-token: none -- the labels `escalateStuck` puts on rows are written to the fake code host's rows (A11-160, step 7), and `deliver` is handed a `run` that throws; nothing imported reaches `gh`
/**
 * #2636: A STUCK ROW IS `ceo`'S TO UNSTICK, NOT THE CHAIRMAN'S. `escalateStuck` labelled every cause that six deliveries
 * did not clear `needs:chairman`, which now means only what the chairman alone can do (an account, admin, money, a legal
 * act). It labels `answer:ceo` instead: the org's own "a named session owes an answer here", read by the `answer-owed`
 * cause, cleared by removing it.
 *
 * Its own file for #2280's reason (`wake.test.ts` reaches `gh`, so the token-less acceptance job refuses it).
 *
 * The negative test (no chairman label) and the positive control (the ceo label IS set on the same call) share ONE
 * fixture, so the negative cannot pass for an escalation that never happens. Mutate `ESCALATION_LABEL` back to
 * `CHAIRMAN_LABEL` and the negative goes red; delete the `run(...)` call and the control does.
 */
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { escalateStuck, ESCALATION_LABEL } from "../wake/merge-queue-wait.ts";
import { deliver } from "../wake/fyi-queue.ts";
import { MAX_DELIVERIES } from "../wake/fyi-delivery-and-limits.ts";
import { NEEDS_CHAIRMAN_LABEL as CHAIRMAN_LABEL } from "../project-vocabulary.ts";
import { ANSWER_PREFIX } from "../waiting-condition.ts";
import { answerOrders, rowsOwingAnswers } from "../work-gate/causes/rows-answers.ts";
import { trunkRedOrders } from "../trunk-red.ts";
import { forgetActivation, substituteCodeHost } from "../plugins/active.ts";
import { createFakeCodeHost } from "../plugins/fakes/code-host.ts";
import { fakeRow } from "../plugins/fakes/code-host-rows.ts";

afterEach(() => forgetActivation());

/** The `run` the tick is handed: the rows are the fake's, so nothing may reach it. */
const noRun = (args: string[]): string => { throw new Error(`the fake code host answers every write; nothing may run ${args.join(" ")}`); };

/** The rows the stuck keys of these tests name, which the fake holds open and unlabelled. */
const ROWS = [1234, 1837, 2372, 2376];

/** One escalation over a fake code host holding the rows above, with every label it put on a row recorded as `[number, label]`. */
function escalate(stuck: string[], memory: Parameters<typeof escalateStuck>[3] = {}) {
  const host = createFakeCodeHost();
  const { rowsWorld: world } = host;
  for (const number of ROWS) world.rows.set(number, fakeRow(world, number));
  substituteCodeHost(host);
  const log: string[] = [];
  const labelled = escalateStuck(stuck, noRun, (l: string) => log.push(l), memory);
  const calls = [...world.rows.values()].flatMap((row) => row.labels.map((label) => [row.number, label] as const));
  return { calls, log: log.join(""), labelled };
}

/** The shapes `answerOrders` reads: `readPrs` and `readOpenRows` rows, reduced to what those readers touch. */
type Labelled = { number: number; labels: { name: string }[]; state?: string; isDraft?: boolean; headRefOid?: string };
type Order = { session: string; cause: string; causeKey: string; subject: string; prompt: string };

test("a key at the cap escalates and no gh call names the chairman's label", () => {
  const { calls, labelled } = escalate(["ceo/lane-backlog-unpromoted/row-1234: delivered 6 times"]);
  assert.deepEqual(labelled, [1234], "POSITIVE CONTROL: the escalation happened, so the absence below means something");
  assert.equal(calls.length, 1);
  assert.ok(!calls.some(([, label]) => label === CHAIRMAN_LABEL), `no label may be ${CHAIRMAN_LABEL}: ${JSON.stringify(calls)}`);
});

test("the same call DOES set the ceo-bound label on that row", () => {
  const { calls } = escalate(["ceo/lane-backlog-unpromoted/row-1234: delivered 6 times"]);
  assert.deepEqual(calls, [[1234, "answer:ceo"]]);
  assert.equal(ESCALATION_LABEL, "answer:ceo");
  assert.notEqual(ESCALATION_LABEL, CHAIRMAN_LABEL);
  assert.ok(ESCALATION_LABEL.startsWith(ANSWER_PREFIX), "it is an answer label, so the answer-owed reader owns it");
});

test("a pull request subject is escalated the same way, on its own number", () => {
  const { calls, log } = escalate(["reviewer/draft-awaiting-verdict/pr-1837/abc12345: delivered 6 times"]);
  assert.deepEqual(calls, [[1837, "answer:ceo"]], "a pull request is labelled by its own number");
  assert.match(log, /ESCALATED #1837 -> answer:ceo/);
});

test("#2462 is kept: an escalated key stays off, and an outage is not escalated", () => {
  const key = "ceo/lane-backlog-unpromoted/row-1234";
  const answered = escalate([`${key}: delivered 6 times`], { escalated: new Set([key]) });
  assert.deepEqual([answered.calls, answered.labelled], [[], []]);
  assert.match(answered.log, /ALREADY ESCALATED #1234/);

  const out = escalate([`${key}: delivered 6 times`], { unavailable: () => "out of usage allowance" });
  assert.deepEqual(out.calls, []);
  assert.match(out.log, /NOT ESCALATED #1234 .*cannot answer/);

  const control = escalate([`${key}: delivered 6 times`], { escalated: new Set(["some/other/row-1"]) });
  assert.deepEqual(control.calls, [[1234, "answer:ceo"]], "CONTROL: another key's mark changes nothing");
});

test("a red main nobody fixes escalates its merged pull request to ceo, through the real breaker path", () => {
  const [order] = trunkRedOrders({
    runId: 1, url: "https://example.invalid/run/1", sha: "0123456789abcdef", failedJobs: ["trunkBuildTest / run"],
    failingTests: ["a test"], parentFailingTests: [], recheck: "pass",
    originPr: { number: 2372, title: "a merged change", session: "worker-9" },
  } as Parameters<typeof trunkRedOrders>[0]);
  const counts = new Map([[order.causeKey, MAX_DELIVERIES]]);
  const { stuck } = deliver([order], [], [], { counts, run: () => { throw new Error("nothing may be sent"); } });
  assert.equal(stuck.length, 1, "POSITIVE CONTROL: at the cap the trunk-red order is stuck");
  const { calls } = escalate(stuck);
  assert.deepEqual(calls, [[2372, "answer:ceo"]]);
});

/**
 * THE READER SIDE (done-when 5). What `escalateStuck` writes is fed to what `answerOrders` reads, so a label the
 * reader could not see would fail here rather than reach nobody. A pull request has the shape `readPrs` returns
 * (`isDraft`, `headRefOid`, `labels`); an issue the shape `readOpenRows` returns.
 */
test("an escalation label on an open PR, or an open row, reaches ceo as an answer-owed order", () => {
  const [[, label]] = escalate(["worker-9/verdict-not-convinced/pr-2376/deadbeef: delivered 6 times"]).calls;
  const pr: Labelled = { number: 2376, isDraft: false, headRefOid: "deadbeef", labels: [{ name: label }] };
  const issue: Labelled = { number: 1234, state: "OPEN", labels: [{ name: label }] };

  const orders: Order[] = answerOrders(rowsOwingAnswers({ openRows: [issue], openPrs: [pr], closedRows: [] }));
  assert.deepEqual(orders.map((o) => [o.session, o.cause, o.causeKey]).sort(), [
    ["ceo", "answer-owed", "ceo/answer-owed/row-1234"],
    ["ceo", "answer-owed", "ceo/answer-owed/row-2376"],
  ]);
  assert.match(orders.find((o) => o.subject === "row-2376")?.prompt ?? "", /IS A PULL REQUEST/);

  const unlabelled = { ...pr, labels: [] };
  assert.deepEqual(answerOrders(rowsOwingAnswers({ openRows: [], openPrs: [unlabelled], closedRows: [] })), [],
    "CONTROL: the same PR without the label owes nobody an answer");
});
