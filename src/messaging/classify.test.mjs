// @ts-check
// WHAT THE CLASSIFIER REFUSES, ONE PATTERN AT A TIME (a11ign/a11ign#2906 done-whens 2 and 3).
//
// POSITIVE CONTROLS, because a classifier that refuses everything also "refuses" every case below: the benign list at the end MUST be
// forwarded, and each refusal group sits beside the sentence a careless pattern would also have caught.
//
// The fixtures that look like credentials are assembled from parts, so this file (in a PUBLIC repository) never carries a contiguous
// string a secret scanner would take for one.

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { classifyText, REASON, REPLIES, VERDICT } from "./classify.mjs";

const GITHUB_TOKEN = ["gh", "p_", "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8"].join("");
const PRIVATE_KEY_HEADER = ["-----BEGIN ", "OPENSSH PRIVATE", " KEY-----"].join("");
const TELEGRAM_TOKEN = ["123456789", ":", "AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw"].join("");

/** @param {string} text @returns {string} */
function verdictOf(text) {
  return classifyText(text).verdict;
}

describe("secrets are dropped (done-when 2)", () => {
  test("the three shapes of the done-when, together and each alone", () => {
    const together = `here: ${GITHUB_TOKEN}\n${PRIVATE_KEY_HEADER}\npassword: hunter2`;
    assert.equal(classifyText(together).verdict, VERDICT.drop);
    assert.equal(classifyText(together).reason, REASON.secret);
    for (const text of [GITHUB_TOKEN, PRIVATE_KEY_HEADER, "password: hunter2"]) {
      assert.equal(verdictOf(text), VERDICT.drop, `not dropped: ${text.slice(0, 12)}`);
    }
  });

  test("the other shapes the pattern list names", () => {
    const shapes = [
      TELEGRAM_TOKEN,
      "my password is hunter2",
      "api_key=abcd1234",
      "postgres://admin:s3cret@db.example.test/prod",
      ["Bearer ", "abcdefghijklmnop1234"].join(""),
      ["AK", "IA", "ABCDEFGHIJKLMNOP"].join(""),
      ["npm", "_", "a".repeat(36)].join(""),
      ["sk", "_live_", "a1b2c3d4e5f6g7h8i9j0"].join(""),
    ];
    for (const text of shapes) assert.equal(verdictOf(text), VERDICT.drop, `not dropped: ${text.slice(0, 14)}`);
  });

  test("a secret is still found when the message is dressed up: zero-width characters, odd whitespace, full-width forms", () => {
    assert.equal(verdictOf(`pass​word: hunter2`), VERDICT.drop);
    assert.equal(verdictOf(`${PRIVATE_KEY_HEADER.slice(0, 5)}​${PRIVATE_KEY_HEADER.slice(5)}`), VERDICT.drop);
    assert.equal(verdictOf("ｐａｓｓｗｏｒｄ: hunter2"), VERDICT.drop, "NFKC folds the full-width letters");
  });

  test("the reply says what will not be done and where, and quotes none of the message", () => {
    const result = /** @type {any} */ (classifyText(`password: hunter2 ${GITHUB_TOKEN}`));
    assert.equal(result.reply, REPLIES.secret);
    assert.doesNotMatch(result.reply, /hunter2/);
    assert.ok(!result.reply.includes(GITHUB_TOKEN));
    assert.match(result.reply, /credentials/);
    assert.match(result.reply, /~\/\.config\/agent-org\//, "where he does it himself");
  });
});

describe("deletions and force-pushes are refused (done-when 3)", () => {
  test("the three sentences of the done-when: two are refused, and say why", () => {
    for (const [text, reason] of [["delete the agent-org repo", REASON.deletion], ["force-push main", REASON.deletion], ["buy the pro plan", REASON.spending]]) {
      const result = /** @type {any} */ (classifyText(text));
      assert.equal(result.verdict, VERDICT.refuse, text);
      assert.equal(result.reason, reason, text);
      assert.equal(result.reply, REPLIES[reason]);
    }
  });

  test("a verb on each thing the design names: repository, branch, row, data, file", () => {
    const refused = [
      "delete the repository", "please delete the branch agent/foo-1", "remove row 2885", "wipe all the data", "erase that file",
      "destroy the old repo", "purge the corpus", "nuke the ledger", "drop the database", "get rid of my old branches",
      "git push --force origin main", "git push -f", "force push it", "rm -rf runs", "git reset --hard HEAD~3", "git clean -fdx",
    ];
    for (const text of refused) assert.equal(classifyText(text).reason, REASON.deletion, text);
  });

  test("the words that merely sit near a verb are not a deletion: a question about one, a different object, no verb", () => {
    const forwarded = [
      "who deleted the branch?", "I deleted a file yesterday", "delete the needs:chairman label", "remove the blocked label",
      "the repository is public", "what is in the file?",
    ];
    for (const text of forwarded) assert.equal(verdictOf(text), VERDICT.forward, text);
  });

  test("a deletion buried in a long message is still found, and the refusal is one line", () => {
    const result = /** @type {any} */ (classifyText(`${"thanks for the update. ".repeat(20)}and then delete the repo.`));
    assert.equal(result.verdict, VERDICT.refuse);
    assert.ok(!result.reply.includes("\n"), "one line");
  });
});

describe("spending is refused", () => {
  test("purchase, subscribe, a plan, an amount", () => {
    const refused = [
      "purchase a licence", "subscribe to the newsletter service", "upgrade my plan", "switch to the paid tier", "get the team plan",
      "pay for the server", "put it on the credit card", "it costs $20 a month", "spend £15 on it", "that is 50 dollars", "budget of 30 EUR",
      "renew the domain",
    ];
    for (const text of refused) assert.equal(classifyText(text).reason, REASON.spending, text);
  });

  test("the word 'plan' alone, and numbers without a currency, are not spending", () => {
    for (const text of ["what is the plan for tomorrow?", "the plan is on track", "row 2905 has 3 blockers", "it took 20 minutes"]) {
      assert.equal(verdictOf(text), VERDICT.forward, text);
    }
  });
});

describe("a message with none of it is forwarded: the positive control for every refusal above", () => {
  test("the question of the done-when", () => {
    assert.deepEqual(classifyText("why did the merge queue stall?"), { verdict: VERDICT.forward });
  });

  test("a spread of ordinary things the chairman says", () => {
    const ordinary = [
      "approve 2885", "yes", "no, hold it until Monday", "what is blocking row 2906?", "show me the board", "is trunk green?",
      "can you summarise the day?", "why is the lab idle", "ok", "https://github.com/a11ign/a11ign/pull/2966 looks right to me",
    ];
    for (const text of ordinary) assert.equal(verdictOf(text), VERDICT.forward, text);
  });

  test("the verdicts are exactly three, and a refusal always carries a reply and a reason", () => {
    assert.deepEqual(Object.values(VERDICT).sort(), ["drop", "forward", "refuse"]);
    for (const text of ["delete the repo", "password: x1", "buy it"]) {
      const result = /** @type {any} */ (classifyText(text));
      assert.equal(typeof result.reply, "string");
      assert.ok(result.reply.length > 0 && !result.reply.includes("\n"));
      assert.ok(Object.values(REASON).includes(result.reason));
    }
  });
});
