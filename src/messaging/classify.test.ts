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

import { classifyText, REASON, REPLIES, VERDICT } from "./classify.ts";

const GITHUB_TOKEN = ["gh", "p_", "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8"].join("");
const PRIVATE_KEY_HEADER = ["-----BEGIN ", "OPENSSH PRIVATE", " KEY-----"].join("");
const TELEGRAM_TOKEN = ["123456789", ":", "AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw"].join("");

/** @param {string} text @returns {string} */
function verdictOf(text: string): string {
  return classifyText(text).verdict;
}

/** @param {string} text @returns {string | undefined} why the text was not forwarded; undefined when it was */
function reasonOf(text: string): string | undefined {
  const result = classifyText(text);
  return "reason" in result ? result.reason : undefined;
}

describe("secrets are dropped (done-when 2)", () => {
  test("the three shapes of the done-when, together and each alone", () => {
    const together = `here: ${GITHUB_TOKEN}\n${PRIVATE_KEY_HEADER}\npassword: hunter2`;
    assert.equal(classifyText(together).verdict, VERDICT.drop);
    assert.equal(reasonOf(together), REASON.secret);
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

// ---- #3442: the #2913 live miss, and the class it belongs to ------------------------------------------------------------------------
// X is an obviously fake value and NOT the one the chairman sent: the repository must never hold that.
const X = "zq-fake-value-0";
const ZERO_WIDTH = "​";

/** @param {string} text @returns {string} the same text in full-width letters, which NFKC folds back */
const fullWidth = (text: string): string => [...text].map((char) => (char > " " && char <= "~" ? String.fromCodePoint(/** @type {number} */ (char.codePointAt(0)) + 0xFEE0) : char)).join("");
/** @param {string} text @returns {string} the text with a zero-width space in the middle of its first word */
const splitFirstWord = (text: string): string => `${text.slice(0, 3)}${ZERO_WIDTH}${text.slice(3)}`;
/** @param {string} text @returns {string[]} the plain spelling and the two dressed-up ones */
const spellings = (text: string): string[] => [text, splitFirstWord(text), fullWidth(text)];

/** The real miss's family, each with the value `X` and the credential word in the place the sentence puts it. */
const REAL_MISS_FAMILY = [
  `My password is: ${X}`, `password is ${X}`, `password: ${X}`, `password = ${X}`, `pw: ${X}`, `pwd=${X}`,
  `here's my password ${X}`, `my password ${X}`, `${X} is my password`,
];

/** One of each known shape of the row's list 2, assembled from parts so this file holds no contiguous token. */
const KNOWN_SHAPES = {
  "ghp_": ["gh", "p_", "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8"].join(""),
  "gho_": ["gh", "o_", "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8"].join(""),
  "ghs_": ["gh", "s_", "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8"].join(""),
  "ghu_": ["gh", "u_", "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8"].join(""),
  "ghr_": ["gh", "r_", "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8"].join(""),
  "github_pat_": ["github", "_pat_", "11ABCDEFG0abcdefghijkl_MNOPQRSTUVWXYZ0123456789abcdefghij"].join(""),
  "npm_": ["npm", "_", "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8"].join(""),
  "sk-": ["sk", "-", "a1B2c3D4e5F6g7H8i9J0k1L2"].join(""),
  "xoxb-": ["xox", "b-", "1234567890-abcdefghijkl"].join(""),
  "xoxp-": ["xox", "p-", "1234567890-abcdefghijkl"].join(""),
  "xoxa-": ["xox", "a-", "1234567890-abcdefghijkl"].join(""),
  "xoxr-": ["xox", "r-", "1234567890-abcdefghijkl"].join(""),
  "xoxs-": ["xox", "s-", "1234567890-abcdefghijkl"].join(""),
  "AKIA": ["AK", "IA", "ABCDEFGHIJKLMNOP"].join(""),
  "PEM block": ["-----BEGIN ", "OPENSSH PRIVATE", " KEY-----"].join(""),
  "JWT": ["ey", "JhbGciOiJIUzI1NiJ9", ".", "eyJzdWIiOiIxMjM0NTY3ODkwIn0", ".", "c2lnbmF0dXJlMDEyMzQ"].join(""),
  "connection string": ["postgres", "://admin:", "fake-pw-1", "@db.example.test/prod"].join(""),
};

describe("#3442: a credential typed in plain words is dropped, in every spelling of the real miss", () => {
  test("the live miss itself: `My password is: <X>` is a drop (the colon after `is` ended the old pattern)", () => {
    assert.equal(classifyText(`My password is: ${X}`).verdict, VERDICT.drop);
  });

  test("the whole family of the real miss, plain and dressed up with a zero-width character and in full-width letters", () => {
    assert.equal(REAL_MISS_FAMILY.length, 9, "the family is the row's nine, and this count is the positive control for the loop below");
    for (const text of REAL_MISS_FAMILY.flatMap(spellings)) assert.equal(verdictOf(text), VERDICT.drop, `not dropped: ${text.replace(X, "<X>")}`);
  });

  test("every separator the row names: is, was, are, a colon, =, a dash, an arrow, or only whitespace, with up to two filler words", () => {
    const sentences = [
      `password was ${X}`, `passwords are ${X}`, `password - ${X}`, `password -> ${X}`, `password => ${X}`, `passphrase: ${X}`, `passwd=${X}`,
      `pass: ${X}`, `pin: 4821`, `pin 4821`, `token -> ${X}`, `login: ${X}`, `credentials are ${X}`, `api key ${X}`, `private key: ${X}`,
      `the password is now ${X}`, `my password is actually: ${X}`, `password to the box is ${X}`, `the password for the server is ${X}`,
      `DB_PASSWORD=${X}`, `Password:\n${X}`, `here is my password ${X}, please keep it`,
    ];
    for (const text of sentences) assert.equal(verdictOf(text), VERDICT.drop, `not dropped: ${text.replace(X, "<X>")}`);
  });

  test("a plain lowercase word is a credential after a strong word and a separator, as it was before", () => {
    for (const text of ["password is hunter", "password: dragon", "my secret was swordfish"]) assert.equal(verdictOf(text), VERDICT.drop, text);
  });

  test("the value first: `<X> is my password` and its neighbours; a pronoun is not a value", () => {
    for (const text of [`${X} is my password`, `${X} was the passphrase`, `hunter is my password`, `${X} is my new pin`]) assert.equal(verdictOf(text), VERDICT.drop, text);
    for (const text of ["that is my password", "this is the secret", "it was my pin"]) assert.equal(verdictOf(text), VERDICT.forward, text);
  });
});

describe("#3442: known credential shapes are dropped on their own, with no keyword", () => {
  test("each shape of the row's list, plain and dressed up", () => {
    assert.equal(Object.keys(KNOWN_SHAPES).length, 17, "the positive control for the loop below: it is not an empty population");
    for (const [name, token] of Object.entries(KNOWN_SHAPES)) {
      for (const text of spellings(token)) assert.equal(verdictOf(text), VERDICT.drop, `${name} not dropped when spelled ${JSON.stringify(text.slice(0, 8))}`);
    }
  });

  test("a shape in the middle of a sentence is still found, and the reply says nothing of it", () => {
    for (const token of Object.values(KNOWN_SHAPES)) {
      const result = /** @type {any} */ (classifyText(`here you go ${token} thanks`));
      assert.equal(result.verdict, VERDICT.drop);
      assert.equal(result.reply, REPLIES.secret);
    }
  });

  test("the temporary AWS key shape, which `redact` does not hold", () => {
    assert.equal(verdictOf(["AS", "IA", "ABCDEFGHIJKLMNOP"].join("")), VERDICT.drop);
  });
});

describe("#3442: the unsure tier is withheld, and 'not a secret' releases it and nothing else", () => {
  const MIXED_TOKEN = "Aq9Zx7Lm2Kp4Vb8Nc3Jd5Hs6";

  test("a 24-character token mixing lower, upper and digit is withheld with the 'looks like a credential' reply, which quotes nothing", () => {
    assert.equal(MIXED_TOKEN.length, 24);
    const result = /** @type {any} */ (classifyText(MIXED_TOKEN));
    assert.equal(result.verdict, VERDICT.withhold);
    assert.equal(result.reason, REASON.unsure);
    assert.match(result.reply, /looks like a credential, so I haven't passed it on; send it again with 'not a secret' if it isn't/);
    assert.ok(!result.reply.includes(MIXED_TOKEN) && !result.reply.includes("\n"));
    assert.equal(result.reply, REPLIES.unsure);
  });

  test("a token with a symbol in place of the digit or the capital, and one inside a sentence, are withheld too", () => {
    for (const text of ["Aq9!Zx7@Lm2#Kp4$Vb8", "aq9zx7lm2kp4vb8nc3!jd5hs6", `here is the thing: ${MIXED_TOKEN}.`, `"${MIXED_TOKEN}"`]) {
      assert.equal(verdictOf(text), VERDICT.withhold, text);
    }
  });

  test("the same message with 'not a secret' is forwarded: the phrase releases the second tier", () => {
    for (const text of [`${MIXED_TOKEN} not a secret`, `not a secret: ${MIXED_TOKEN}`, `NOT A SECRET ${MIXED_TOKEN}`, `${MIXED_TOKEN} not a${ZERO_WIDTH} secret`]) {
      assert.equal(verdictOf(text), VERDICT.forward, text);
    }
  });

  test("'not a secret' beside a definite shape is still a drop: every keyed form and every known shape", () => {
    const keyed = [...REAL_MISS_FAMILY, `my secret is ${X}`, `the secret: ${X}`];
    for (const text of [...keyed, ...Object.values(KNOWN_SHAPES)]) {
      assert.equal(verdictOf(`${text} not a secret`), VERDICT.drop, `released: ${text.replace(X, "<X>").slice(0, 24)}`);
      assert.equal(verdictOf(`not a secret: ${text}`), VERDICT.drop, `released: ${text.replace(X, "<X>").slice(0, 24)}`);
    }
  });

  test("a definite shape beside an unsure token is a drop (the stronger verdict wins)", () => {
    assert.equal(verdictOf(`${MIXED_TOKEN} password: ${X}`), VERDICT.drop);
  });
});

describe("#3442: benign sentences beside each pattern are forwarded: the positive controls for everything above", () => {
  const BENIGN = [
    "the password reset page is slow", "rotate the token tomorrow", "my password manager is slow", "what's the password policy?", "do you know my password?", "can you reset my password please",
    "the login page is broken", "pin the version of node", "the pass rate is 98%", "a secret santa for the team", "we need a token budget for the model",
    "agent/chairman-messaging-a-credential-3442", "chairman-messaging-a-credential-3442", "ab8753d91c3f2e1d0a9b8c7d6e5f4a3b2c1d0e9f",
    "https://github.com/a11ign/agent-org/pull/138", "https://github.com/a11ign/a11ign/issues/3442#issuecomment-4172938475618",
    "packages/lab/CLAUDE.md", "classify.test.mjs", "Report_Final_v2.pdf", "docs/what-asserted-versus-referred-was-measured-at",
    "internationalisation", "that is my password", "dan.beck@example.com", "createInboundForwarder",
  ];

  test("every one is forwarded, alone and inside a sentence", () => {
    assert.ok(BENIGN.length > 20, "the positive control: the list is not empty");
    for (const text of BENIGN) {
      assert.equal(verdictOf(text), VERDICT.forward, text);
      assert.equal(verdictOf(`can you look at ${text} please`), VERDICT.forward, `in a sentence: ${text}`);
    }
  });

  test("a 64-hex git object name is forwarded, and a 32-hex run (the length of an API key) is not", () => {
    assert.equal(verdictOf("a".repeat(64)), VERDICT.forward);
    assert.equal(verdictOf("0123456789abcdef0123456789abcdef"), VERDICT.drop);
  });

  test("a slug that holds a token's prefix is not exempt: the specific shape still wins", () => {
    assert.equal(verdictOf(["xox", "b-1234567890-1234567890-abcdefghij-klmn"].join("")), VERDICT.drop);
  });
});

describe("deletions and force-pushes are refused (done-when 3)", () => {
  test("the three sentences of the done-when: two are refused, and say why", () => {
    for (const [text, reason] of [["delete the agent-org repo", REASON.deletion], ["force-push main", REASON.deletion], ["buy the pro plan", REASON.spending]]) {
      const result = /** @type {any} */ (classifyText(text));
      assert.equal(result.verdict, VERDICT.refuse, text);
      assert.equal(result.reason, reason, text);
      assert.equal(result.reply, /** @type {Record<string, string>} */ (REPLIES)[reason]);
    }
  });

  test("a hyphen that is not U+002D is still a hyphen: NFKC does not fold the Unicode dashes, so they are folded here (review of 4113f67, 3)", () => {
    const dashes = { hyphen: "\u2010", nonBreaking: "\u2011", figure: "\u2012", en: "\u2013", em: "\u2014", bar: "\u2015", minus: "\u2212", twoEm: "\u2E3A", smallEm: "\uFE58" };
    assert.equal(verdictOf("force-push main"), VERDICT.refuse, "control: the ASCII hyphen is refused");
    for (const [name, dash] of Object.entries(dashes)) {
      assert.equal(reasonOf(`force${dash}push main`), REASON.deletion, `force${name}push`);
      assert.equal(reasonOf(`git push ${dash}${dash}force origin main`), REASON.deletion, `push ${name}${name}force`);
      assert.equal(reasonOf(`rm ${dash}rf runs`), REASON.deletion, `rm ${name}rf`);
    }
    assert.equal(verdictOf("a well\u2010known \u2014 and ordinary \u2013 sentence"), VERDICT.forward, "control: a dash in prose is not a refusal");
  });

  test("a verb on each thing the design names: repository, branch, row, data, file", () => {
    const refused = [
      "delete the repository", "please delete the branch agent/foo-1", "remove row 2885", "wipe all the data", "erase that file",
      "destroy the old repo", "purge the corpus", "nuke the ledger", "drop the database", "get rid of my old branches",
      "git push --force origin main", "git push -f", "force push it", "rm -rf runs", "git reset --hard HEAD~3", "git clean -fdx",
    ];
    for (const text of refused) assert.equal(reasonOf(text), REASON.deletion, text);
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
    for (const text of refused) assert.equal(reasonOf(text), REASON.spending, text);
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

  test("the verdicts are exactly four, and a refusal always carries a reply and a reason", () => {
    assert.deepEqual(Object.values(VERDICT).sort(), ["drop", "forward", "refuse", "withhold"]);
    for (const text of ["delete the repo", "password: x1", "buy it"]) {
      const result = /** @type {any} */ (classifyText(text));
      assert.equal(typeof result.reply, "string");
      assert.ok(result.reply.length > 0 && !result.reply.includes("\n"));
      assert.ok(Object.values(REASON).includes(result.reason));
    }
  });
});
