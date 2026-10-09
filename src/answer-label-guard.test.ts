// no-token: gh -- a pure function over fixtures; nothing reaches `gh`, `git` or the network
/**
 * a11ign/a11ign#4679: `answer:<session>` WITH NO QUESTION. The 2026-10-09T23:00Z replay put `answer:orchestrator` and `answer:product-manager` on closed rows whose newest
 * comment was a report. POSITIVE CONTROLS: the two ALLOWED cases (an open row asking the session, a claim-release note naming it) are the non-empty side the refusals are read
 * against, so a guard that refuses everything fails here.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { answerLabelRefusal } from "./answer-label-guard.ts";
import { CLAIM_RECORD_MARKER } from "./claim-labels.ts";

// The two shapes `claimRecordComment` writes (row-claim.ts), spelled here so the test does not load the project declaration.
const claimRecordComment = ({ session, released = false }: { session: string; released?: boolean }) =>
  `${CLAIM_RECORD_MARKER}\n**Claim record** -- ${released ? "released" : "claimed"} by \`${session}\`.\n\nClaimed-branch: b`;

const ask = (body: string, state = "OPEN", session = "orchestrator") => answerLabelRefusal({ state, lastComment: { body }, session });

test("a closed row is refused, even when its newest comment asks the session", () => {
  assert.match(String(ask("`orchestrator`, can you confirm the fleet is clean?", "CLOSED")), /closed row/);
  assert.match(String(ask("orchestrator, is it done?", "closed")), /closed row/);
});

test("an open row whose newest comment is a plain report is refused", () => {
  assert.match(String(ask("Merged in abc123. orchestrator should know the suite is green.")), /asks nothing/);
});

test("a question inside a code fence is not a question", () => {
  assert.match(String(ask("orchestrator:\n```\nls *.md?\n```\nDone.")), /asks nothing/);
});

test("a question that names another session is refused for this one", () => {
  assert.match(String(ask("product-manager, which Region do you want?")), /does not name orchestrator/);
});

test("a row with no comment, or an unreadable state, is refused", () => {
  assert.match(String(answerLabelRefusal({ state: "OPEN", lastComment: null, session: "orchestrator" })), /no comment/);
  assert.match(String(answerLabelRefusal({ state: "", lastComment: { body: "orchestrator?" }, session: "orchestrator" })), /unknown state/);
});

test("CONTROL: an open row whose newest comment asks the session is allowed", () => {
  assert.equal(ask("`orchestrator`: does the lab corpus carry protocol 21 captures?"), null);
  assert.equal(ask("What is the Region, product-manager?", "OPEN", "product-manager"), null);
});

test("CONTROL: a claim-release note naming the session is allowed, and a claim note is not", () => {
  assert.equal(answerLabelRefusal({ state: "OPEN", lastComment: { body: claimRecordComment({ session: "worker-1", released: true }) }, session: "worker-1" }), null);
  assert.match(String(answerLabelRefusal({ state: "OPEN", lastComment: { body: claimRecordComment({ session: "worker-1" }) }, session: "worker-1" })), /asks nothing/);
});
