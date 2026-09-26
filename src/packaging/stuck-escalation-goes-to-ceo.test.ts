// no-token: gh -- every `gh` here is the injected `run` seam `escalateStuck` and `deliver` already take; nothing imported reaches the real one
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
import { test } from "node:test";
import assert from "node:assert/strict";
import { escalateStuck, deliver, ESCALATION_LABEL, MAX_DELIVERIES } from "../wake.mjs";
import { CHAIRMAN_LABEL, ANSWER_PREFIX, answerOrders, rowsOwingAnswers } from "../work-gate.mjs";
import { trunkRedOrders } from "../trunk-red.mjs";

const CHAIRMAN_CALL = ["--add-label", "needs:chairman"];
const CEO_CALL = ["--add-label", "answer:ceo"];

/** One escalation, with every `gh` call it made recorded. */
function escalate(stuck: string[], memory: Parameters<typeof escalateStuck>[3] = {}) {
  const calls: string[][] = [];
  const log: string[] = [];
  const labelled = escalateStuck(stuck, (a: string[]) => { calls.push(a); return ""; }, (l: string) => log.push(l), memory);
  return { calls, log: log.join(""), labelled };
}

/** The shapes `answerOrders` reads: `readPrs` and `readOpenRows` rows, reduced to what those readers touch. */
type Labelled = { number: number; labels: { name: string }[]; state?: string; isDraft?: boolean; headRefOid?: string };
type Order = { session: string; cause: string; causeKey: string; subject: string; prompt: string };

const flat = (calls: string[][]) => calls.map((c) => c.join(" "));

test("a key at the cap escalates and no gh call names the chairman's label", () => {
  const { calls, labelled } = escalate(["ceo/lane-backlog-unpromoted/row-1234: delivered 6 times"]);
  assert.deepEqual(labelled, [1234], "POSITIVE CONTROL: the escalation happened, so the absence below means something");
  assert.equal(calls.length, 1);
  assert.ok(!flat(calls).some((c) => c.includes(CHAIRMAN_LABEL)), `no call may carry ${CHAIRMAN_LABEL}: ${flat(calls)}`);
  assert.ok(!calls.some((c) => c.join(" ").includes(CHAIRMAN_CALL.join(" "))));
});

test("the same call DOES set the ceo-bound label on that row", () => {
  const { calls } = escalate(["ceo/lane-backlog-unpromoted/row-1234: delivered 6 times"]);
  assert.deepEqual(calls, [["issue", "edit", "1234", ...CEO_CALL]]);
  assert.equal(ESCALATION_LABEL, "answer:ceo");
  assert.notEqual(ESCALATION_LABEL, CHAIRMAN_LABEL);
  assert.ok(ESCALATION_LABEL.startsWith(ANSWER_PREFIX), "it is an answer label, so the answer-owed reader owns it");
});

test("a pull request subject is escalated the same way, on its own number", () => {
  const { calls, log } = escalate(["reviewer/draft-awaiting-verdict/pr-1837/abc12345: delivered 6 times"]);
  assert.deepEqual(calls, [["issue", "edit", "1837", ...CEO_CALL]], "`gh issue edit` takes a PR number for labels");
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
  assert.deepEqual(control.calls, [["issue", "edit", "1234", ...CEO_CALL]], "CONTROL: another key's mark changes nothing");
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
  assert.deepEqual(calls, [["issue", "edit", "2372", ...CEO_CALL]]);
});

/**
 * THE READER SIDE (done-when 5). What `escalateStuck` writes is fed to what `answerOrders` reads, so a label the
 * reader could not see would fail here rather than reach nobody. A pull request has the shape `readPrs` returns
 * (`isDraft`, `headRefOid`, `labels`); an issue the shape `readOpenRows` returns.
 */
test("an escalation label on an open PR, or an open row, reaches ceo as an answer-owed order", () => {
  const written = escalate(["worker-9/verdict-not-convinced/pr-2376/deadbeef: delivered 6 times"]).calls[0];
  const label = written[written.indexOf("--add-label") + 1];
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
