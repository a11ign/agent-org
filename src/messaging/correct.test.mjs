// @ts-check
// `chairman:correct` (a11ign/a11ign#3417 done-when 1, cases 3 to 7). **THREE VERBS AND NOTHING ELSE**, and each writes what it says and no more: `withdraw` the comment, the label and a
// `withdraw` ledger line with the reason; `reroute` the comment and `answer:product-manager` and NO other label; `re-ask` a brief the watcher's own reader takes as the newest.
//
// **POSITIVE CONTROLS, NAMED.** Case 4's "no other label" is read off the row's labels after BOTH writes, so a `reroute` that also removed `needs:chairman` fails it, and case 4's
// own control is `withdraw`, which the same fake shows DOES remove it. Case 5's "the newest" is `latestBrief` over the old brief and the new comment, and its control is a brief
// that lacks a line the watcher requires, which `latestBrief` still picks and `requestEvent` refuses (`a brief that would send no alert is not written`).

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";

import { PROVENANCE } from "./answers.mjs";
import { createCorrector, REROUTE_TO, VERBS, WITHDRAW_REASONS } from "./correct.mjs";
import { createLedger } from "./ledger.mjs";
import { latestBrief, requestEvent } from "./sources/requests.mjs";

const NOW = Date.parse("2026-10-04T15:00:00Z");
const REPO = "a11ign/a11ign";
const ROW = { repo: REPO, number: 3333 };
const REF = "45";
const WORDS = "That label is wrong, it is done already. <!-- hidden -->";
const REROUTE_LABEL = `answer:${REROUTE_TO}`;
const NEEDS = "needs:chairman";
const OLD_BRIEF = "BRIEF for the chairman\nWhat is happening: the first publish is ready.\nAsk: pick one.\nOnly you because: the token is yours.\nChecked: the registry.\nHow long: ten minutes.\nUnblocks: the release.\nNot the chairman's Claude session because: it holds no npm login.";
const NEW_BRIEF = OLD_BRIEF.replace("the first publish is ready", "the publish is already done, so only the tag is left").replace("Ask: pick one.", "Ask: push the tag.");

const scratch = mkdtempSync(join(tmpdir(), "messaging-correct-"));
after(() => rmSync(scratch, { recursive: true, force: true }));
let nextCase = 0;

/** @param {string} text @returns {string} */
const sha256Of = (text) => createHash("sha256").update(text, "utf8").digest("hex");

/** @returns {import("./record.mjs").Ledger} a ledger holding message 45 and its receipt, in its own file, with the clock at NOW */
function ledgerWithMessage() {
  const ledger = createLedger({ path: join(scratch, `ledger-${nextCase += 1}.jsonl`), now: () => NOW });
  ledger.append({ direction: "in", updateId: 11, verdict: "forward", reason: null, kind: "message", userId: 7, chatId: 7, chatType: "private", length: WORDS.length, sha256: sha256Of(WORDS) });
  ledger.append({ direction: "in", origin: "converse", updateId: 11, messageRef: REF, verdict: "queued", handoff: "handoff/liaison/x", ackRef: "46", error: null });
  return ledger;
}

/**
 * A GitHub that is an object: the labels and comments a row holds (an old brief to begin with), every call made, and a step that fails once when named.
 * @param {{labels?: string[], failOnce?: string[]}} [options]
 */
function fakeGithub({ labels = [NEEDS, "backlog"], failOnce = [] } = {}) {
  const row = { labels: [...labels], comments: [{ body: OLD_BRIEF, createdAt: new Date(NOW - 1000).toISOString(), authorAssociation: "MEMBER" }] };
  const [calls, failing] = [/** @type {string[]} */ ([]), new Set(failOnce)];
  /** @param {string} step */
  const attempt = (step) => {
    calls.push(step);
    if (failing.delete(step)) throw new Error(`${step} failed`);
  };
  return {
    row, calls,
    async readRow() { return { state: "OPEN", labels: [...row.labels], comments: row.comments }; },
    async comment(/** @type {any} */ _row, /** @type {string} */ body) {
      attempt("comment");
      row.comments.push({ body, createdAt: new Date(NOW + row.comments.length).toISOString(), authorAssociation: "MEMBER" });
    },
    async removeLabel(/** @type {any} */ _row, /** @type {string} */ label) {
      attempt("remove-label");
      row.labels = row.labels.filter((name) => name !== label);
    },
    async addLabel(/** @type {any} */ _row, /** @type {string} */ label) {
      attempt("set-answer");
      row.labels.push(label);
    },
  };
}

/** @param {{ledger?: import("./record.mjs").Ledger, github?: ReturnType<typeof fakeGithub>}} [ports] */
function corrector({ ledger = ledgerWithMessage(), github = fakeGithub() } = {}) {
  return { ledger, github, correct: createCorrector({ ledger, github, now: () => NOW, rerouteLabel: REROUTE_LABEL }).correct };
}

/** @param {import("./record.mjs").Ledger} ledger @param {string} verb */
const linesOf = (ledger, verb) => ledger.read().filter((line) => line.direction === verb);

describe("chairman:correct", () => {
  test("withdraw removes the label, comments with the reason and his words, and writes a `withdraw` ledger line with the reason", async () => {
    const { ledger, github, correct } = corrector();
    const result = await correct({ row: ROW, ref: REF, as: "withdraw", reason: "already-done", text: WORDS });
    assert.equal(result.outcome, "done");
    assert.deepEqual(github.row.labels, ["backlog"], "needs:chairman is gone and nothing else is");
    const [{ body }] = github.row.comments.slice(1);
    assert.ok(body.startsWith(`Withdrawn by liaison from the chairman's message ${REF}; not written by the chairman`), body);
    assert.match(body, /because it is already done/);
    assert.ok(body.includes("> That label is wrong, it is done already. &lt;!-- hidden --&gt;"), "his words, quoted, with the comment marker escaped");
    assert.equal(body.includes(PROVENANCE), false);
    assert.deepEqual(linesOf(ledger, "withdraw").map(({ step, reason, messageRef, request }) => ({ step, reason, messageRef, request })), [
      { step: "comment", reason: "already-done", messageRef: REF, request: `request:${REPO}#3333` },
      { step: "remove-label", reason: "already-done", messageRef: REF, request: `request:${REPO}#3333` },
    ]);
    assert.deepEqual(github.calls, ["comment", "remove-label"], "the comment is first: a failed comment leaves the row still asking");
  });

  test("withdraw takes only a reason from the closed three", async () => {
    for (const reason of [undefined, "", "because", "constructor"]) {
      const { github, correct } = corrector();
      const result = await correct({ row: ROW, ref: REF, as: "withdraw", reason, text: WORDS });
      assert.equal(result.outcome, "refused", String(reason));
      assert.deepEqual(github.calls, []);
    }
    assert.deepEqual(Object.keys(WITHDRAW_REASONS), ["stale", "wrongly-labelled", "already-done"]);
    for (const reason of Object.keys(WITHDRAW_REASONS)) assert.equal((await corrector().correct({ row: ROW, ref: REF, as: "withdraw", reason, text: WORDS })).outcome, "done", reason);
  });

  test("reroute sets answer:product-manager and NO other label, and says what the chairman said; the control is withdraw, which does remove one", async () => {
    const { ledger, github, correct } = corrector();
    const result = await correct({ row: ROW, ref: REF, as: "reroute", text: WORDS });
    assert.equal(result.outcome, "done");
    assert.deepEqual(github.row.labels, [NEEDS, "backlog", REROUTE_LABEL], "one label added, none removed");
    assert.deepEqual(github.calls, ["comment", "set-answer"]);
    assert.ok(github.row.comments[1].body.startsWith(`Rerouted by liaison from the chairman's message ${REF}; not written by the chairman`));
    assert.deepEqual(linesOf(ledger, "reroute").map(({ step, to }) => ({ step, to })), [{ step: "comment", to: REROUTE_TO }, { step: "set-answer", to: REROUTE_TO }]);
    const control = corrector();
    await control.correct({ row: ROW, ref: REF, as: "withdraw", reason: "stale", text: WORDS });
    assert.notDeepEqual(control.github.row.labels, [NEEDS, "backlog"], "the same fake shows a label leaving when one does");
  });

  test("re-ask writes a brief that latestBrief reads as the newest and the watcher's reader accepts", async () => {
    const { github, correct } = corrector();
    const result = await correct({ row: ROW, ref: REF, as: "re-ask", text: NEW_BRIEF });
    assert.equal(result.outcome, "done");
    const newest = latestBrief(github.row.comments);
    assert.ok(newest !== null && newest.body.startsWith("BRIEF for the chairman\nWhat is happening: the publish is already done"), "the new brief supersedes the old");
    assert.ok(newest.body.endsWith(`Re-asked by liaison from the chairman's message ${REF}; not written by the chairman`));
    const { event, problem } = requestEvent({ repo: REPO, row: { number: 3333, title: "", url: "u", comments: github.row.comments }, now: NOW });
    assert.equal(problem, null);
    assert.match(String(event?.text), /Ask: push the tag\./);
    assert.deepEqual(github.row.labels, [NEEDS, "backlog"], "re-ask touches no label: the row is still asking");
  });

  test("a brief the watcher would send no alert for is refused before it is written, though latestBrief would take it as the newest", async () => {
    const lacking = NEW_BRIEF.replace(/^Unblocks:.*$/m, "");
    for (const brief of [lacking, "no marker, no lines", "", `${NEW_BRIEF}\n<!-- chairman-options: A=one; A=two -->`]) {
      const { github, correct } = corrector();
      const result = await correct({ row: ROW, ref: REF, as: "re-ask", text: brief });
      assert.equal(result.outcome, "refused", brief.slice(0, 30));
      assert.deepEqual(github.calls, []);
    }
    const control = fakeGithub();
    control.row.comments.push({ body: lacking, createdAt: new Date(NOW + 5).toISOString(), authorAssociation: "MEMBER" });
    assert.equal(latestBrief(control.row.comments)?.body, lacking, "it WOULD have been the newest, which is why it is checked first");
  });

  test("a verb outside the three is refused, and so is no verb; nothing is written for either", async () => {
    assert.deepEqual(VERBS, ["withdraw", "reroute", "re-ask"]);
    for (const as of ["close", "approve", "answer", "relabel", "edit", "", "undefined", "WITHDRAW", "__proto__", "toString"]) {
      const { ledger, github, correct } = corrector();
      const before = ledger.read().length;
      const result = await correct({ row: ROW, ref: REF, as, reason: "stale", text: WORDS });
      assert.equal(result.outcome, "refused", as);
      assert.match(result.say, /is not one of withdraw, reroute, re-ask/);
      assert.deepEqual([github.calls, ledger.read().length], [[], before]);
    }
  });

  test("a ref the ledger does not hold, or words it did not hash, are refused by every verb", async () => {
    /** @type {[string, string | undefined][]} */
    const verbs = [["withdraw", "stale"], ["reroute", undefined], ["re-ask", undefined]];
    for (const [as, reason] of verbs) {
      const { github, correct } = corrector();
      const unknownRef = await correct({ row: ROW, ref: "99", as: String(as), reason, text: as === "re-ask" ? NEW_BRIEF : WORDS });
      assert.equal(unknownRef.outcome, "refused", `${as}: unknown ref`);
      if (as !== "re-ask") assert.equal((await correct({ row: ROW, ref: REF, as, reason, text: "something else" })).outcome, "refused", `${as}: other words`);
      assert.deepEqual(github.calls, [], String(as));
    }
  });

  test("a failure between the two steps is resumed by the next call, which does the second only; a third does nothing", async () => {
    for (const [as, second] of [["withdraw", "remove-label"], ["reroute", "set-answer"]]) {
      const { ledger, github, correct } = corrector({ github: fakeGithub({ failOnce: [String(second)] }) });
      const ask = () => correct({ row: ROW, ref: REF, as: String(as), reason: "stale", text: WORDS });
      assert.equal((await ask()).outcome, "failed", `${as}: first`);
      assert.deepEqual(linesOf(ledger, String(as)).map((line) => line.step), ["comment", "failed"]);
      assert.equal((await ask()).outcome, "done", `${as}: second`);
      assert.equal((await ask()).outcome, "already", `${as}: third`);
      assert.equal(github.row.comments.length, 2, `${as}: the old brief and ONE comment of ours`);
      assert.deepEqual(github.calls, ["comment", second, second], `${as}: the comment was not repeated`);
    }
  });

  test("a withdraw that failed at the label is finished even when the label is already gone; a fresh one on a row that is not asking is refused", async () => {
    const { github, correct } = corrector({ github: fakeGithub({ labels: ["backlog"] }) });
    const fresh = await correct({ row: ROW, ref: REF, as: "withdraw", reason: "stale", text: WORDS });
    assert.equal(fresh.outcome, "refused");
    assert.match(fresh.say, /is not asking the chairman anything now/);
    assert.deepEqual(github.calls, []);
    const started = corrector({ github: fakeGithub({ failOnce: ["remove-label"] }) });
    assert.equal((await started.correct({ row: ROW, ref: REF, as: "withdraw", reason: "stale", text: WORDS })).outcome, "failed");
    started.github.row.labels = ["backlog"];
    assert.equal((await started.correct({ row: ROW, ref: REF, as: "withdraw", reason: "stale", text: WORDS })).outcome, "done");
  });
});
