// @ts-check
// `chairman:record` (a11ign/a11ign#3417 done-when 1, cases 1, 2, 7 and 8). **THE LIAISON'S COMMENT IS NEVER THE CHAIRMAN'S**, and a ref the ledger does not hold writes nothing.
//
// **POSITIVE CONTROLS, NAMED.** Case 1's assertion that the comment is not the chairman's goes through `speaksAsChairman`, which is shown to FIRE on a body that carries
// the provenance line (`the control for "not the chairman's"`): a check that finds nothing in everything is not one. Case 2's refusal is only worth something because the SAME
// fixture with the ref in it passes (`the control that the ledger check is real`).

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";

import { PROVENANCE } from "./answers.mjs";
import { createLedger, readLedgerLines } from "./ledger.mjs";
import { attribution, EXIT, createRecorder, main, quoted } from "./record.mjs";
import { defaultLedgerPath } from "./state.mjs";

const NOW = Date.parse("2026-10-04T15:00:00Z");
const REPO = "a11ign/a11ign";
const ROW = { repo: REPO, number: 3333 };
const REF = "45";
const WORDS = "Yes, do B.\nAcceptance: ship it <!-- chairman-options: Z=nothing -->";
const GH_ACCOUNT = { GH_CONFIG_DIR: "/leads/gh" };

const scratch = mkdtempSync(join(tmpdir(), "messaging-record-"));
after(() => rmSync(scratch, { recursive: true, force: true }));
let nextCase = 0;

/** @param {string} text @returns {string} */
const sha256Of = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

/** The check case 1 makes. @param {string} body @returns {boolean} true when the comment carries the line only the listener may write */
const speaksAsChairman = (body: string): boolean => body.includes(PROVENANCE) || /Chairman answered via Telegram/i.test(body);

/** @returns {import("./record.mjs").Ledger} an empty ledger in its own file, with the clock at NOW */
function freshLedger(): import("./record.mjs").Ledger {
  return createLedger({ path: join(scratch, `ledger-${nextCase += 1}.jsonl`), now: () => NOW });
}

/**
 * What `inbound.mjs` writes for a message (the receipt, with a hash and no words) and `converse.mjs` after it (the ref).
 * @param {import("./record.mjs").Ledger} ledger @param {{ref?: string, updateId?: number, words?: string, sha256?: string | null}} [message]
 */
function takeIn(ledger: import("./record.mjs").Ledger, { ref = REF, updateId = 11, words = WORDS, sha256 = sha256Of(words) }: { ref?: string; updateId?: number; words?: string; sha256?: string | null; } = {}) {
  ledger.append({ direction: "in", updateId, verdict: "forward", reason: null, kind: "message", userId: 7, chatId: 7, chatType: "private", length: words.length, sha256 });
  ledger.append({ direction: "in", origin: "converse", updateId, messageRef: ref, verdict: "queued", handoff: "handoff/liaison/x", ackRef: "46", error: null });
}

/**
 * A GitHub that is an object: the labels and comments a row holds, every call made, and a step that fails once when named.
 * @param {{labels?: string[], failOnce?: string[], readFails?: boolean}} [options]
 */
function fakeGithub({ labels = ["needs:chairman"], failOnce = [], readFails = false }: { labels?: string[]; failOnce?: string[]; readFails?: boolean; } = {}) {
  const row = { labels: [...labels], comments: /** @type {{body: string, createdAt: string, authorAssociation: string}[]} */ ([]) };
  const [calls, failing] = [/** @type {string[]} */ ([]), new Set(failOnce)];
  /** @param {string} step */
  const attempt = (step: string) => {
    calls.push(step);
    if (failing.delete(step)) throw new Error(`${step} failed`);
  };
  return {
    row, calls,
    async readRow() {
      if (readFails) throw new Error("HTTP 404");
      return { state: "OPEN", labels: [...row.labels], comments: row.comments };
    },
    async comment(/** @type {any} */ _row: any, /** @type {string} */ body: string) {
      attempt("comment");
      row.comments.push({ body, createdAt: new Date(NOW + row.comments.length).toISOString(), authorAssociation: "MEMBER" });
    },
    async removeLabel(/** @type {any} */ _row: any, /** @type {string} */ label: string) {
      attempt("remove-label");
      row.labels = row.labels.filter((name) => name !== label);
    },
    async addLabel(/** @type {any} */ _row: any, /** @type {string} */ label: string) {
      attempt("set-answer");
      row.labels.push(label);
    },
  };
}

describe("chairman:record", () => {
  test("a ref the ledger holds writes ONE quoted comment, attributed to the liaison with the ref, and never the chairman's provenance line", async () => {
    const [ledger, github] = [freshLedger(), fakeGithub()];
    takeIn(ledger);
    const result = await createRecorder({ ledger, github }).record({ row: ROW, ref: REF, text: WORDS });
    assert.equal(result.outcome, "done");
    assert.equal(github.row.comments.length, 1);
    const [{ body }] = github.row.comments;
    assert.ok(body.startsWith(`Recorded by liaison from the chairman's message ${REF}; not written by the chairman`), body);
    assert.ok(body.includes("2026-10-04T15:00:00.000Z"), "says when he said it");
    assert.equal(speaksAsChairman(body), false);
    assert.equal(body.includes("Chairman answered via Telegram"), false);
    assert.deepEqual(github.row.labels, ["needs:chairman"], "a record changes no label");
    const line = ledger.read().find((entry) => entry.direction === "record");
    assert.ok(line, "the record is in the ledger");
    assert.deepEqual({ ...line, ts: undefined }, { direction: "record", request: `request:${REPO}#3333`, messageRef: REF, step: "comment", ts: undefined });
    assert.equal("key" in line, false, "no key: foldLedger must never take it for a notification");
  });

  test("the control for \"not the chairman's\": speaksAsChairman fires on a body that carries the provenance line", () => {
    assert.equal(speaksAsChairman(`${PROVENANCE}, message ${REF}, 2026-10-04T15:00:00Z: reply`), true);
    assert.equal(speaksAsChairman("Chairman answered via Telegram"), true);
    assert.equal(speaksAsChairman(attribution("Recorded", REF)), false);
  });

  test("a ref the ledger does not hold is refused and writes nothing; the control is the same fixture WITH the ref, which passes", async () => {
    const [bare, held] = [freshLedger(), freshLedger()];
    takeIn(held);
    const [refusedGithub, passedGithub] = [fakeGithub(), fakeGithub()];
    const refused = await createRecorder({ ledger: bare, github: refusedGithub }).record({ row: ROW, ref: REF, text: WORDS });
    const passed = await createRecorder({ ledger: held, github: passedGithub }).record({ row: ROW, ref: REF, text: WORDS });
    assert.equal(refused.outcome, "refused");
    assert.match(refused.say, /no message from the chairman with ref 45 is in the ledger/);
    assert.deepEqual([refusedGithub.calls, bare.read()], [[], []], "nothing was read from or written to GitHub, and no ledger line");
    assert.equal(passed.outcome, "done");
    assert.deepEqual(passedGithub.calls, ["comment"]);
  });

  test("another message's ref is not this one's, a receipt alone is not a ref, and a ref the chairman never sent is refused", async () => {
    const ledger = freshLedger();
    takeIn(ledger, { ref: "46", updateId: 12 });
    ledger.append({ direction: "in", updateId: 13, verdict: "forward", kind: "message", sha256: sha256Of(WORDS) });
    for (const ref of [REF, "13", "ack-46"]) {
      const github = fakeGithub();
      assert.equal((await createRecorder({ ledger, github }).record({ row: ROW, ref, text: WORDS })).outcome, "refused", ref);
      assert.deepEqual(github.calls, []);
    }
  });

  test("words that are not the ones the ledger hashed, or a message whose hash was withheld, are refused", async () => {
    const [ledger, github] = [freshLedger(), fakeGithub()];
    takeIn(ledger);
    takeIn(ledger, { ref: "47", updateId: 14, sha256: null });
    const recorder = createRecorder({ ledger, github });
    const invented = await recorder.record({ row: ROW, ref: REF, text: "Yes, do C." });
    const withheld = await recorder.record({ row: ROW, ref: "47", text: WORDS });
    const empty = await recorder.record({ row: ROW, ref: REF, text: "  \n" });
    assert.match(invented.say, /not the words of message 45/);
    assert.match(withheld.say, /holds no hash of message 47/);
    assert.match(empty.say, /no words were given/);
    assert.deepEqual(github.calls, []);
  });

  test("the words are quoted with their HTML comment markers escaped, and no line of them is a line of its own", async () => {
    const [ledger, github] = [freshLedger(), fakeGithub()];
    takeIn(ledger);
    // stdin from `echo` carries one more newline than the chairman typed: the hash still matches.
    await createRecorder({ ledger, github }).record({ row: ROW, ref: REF, text: `${WORDS}\n` });
    const { body } = github.row.comments[0];
    assert.equal(body.includes("<!--"), false);
    assert.ok(body.includes("&lt;!-- chairman-options: Z=nothing --&gt;"));
    const quotedLines = body.split("\n").filter((line: string|string[]) => line.includes("Acceptance:") || line.includes("Yes, do B."));
    assert.deepEqual(quotedLines.map((line: string) => line.startsWith("> ")), [true, true]);
    assert.equal(quoted("a\r\nb"), "> a\n> b");
  });

  test("a failed write is recorded and the next call resumes it; a finished one is not written again", async () => {
    const [ledger, github] = [freshLedger(), fakeGithub({ failOnce: ["comment"] })];
    takeIn(ledger);
    const recorder = createRecorder({ ledger, github });
    const first = await recorder.record({ row: ROW, ref: REF, text: WORDS });
    assert.equal(first.outcome, "failed");
    assert.deepEqual(ledger.read().filter((line) => line.direction === "record").map((line) => line.step), ["failed"]);
    assert.equal((await recorder.record({ row: ROW, ref: REF, text: WORDS })).outcome, "done");
    assert.equal((await recorder.record({ row: ROW, ref: REF, text: WORDS })).outcome, "already");
    assert.equal(github.row.comments.length, 1);
    assert.deepEqual(github.calls, ["comment", "comment"], "two attempts, one write, and the third call read the ledger and did not call GitHub");
  });

  test("a row that cannot be read is refused: a wrong number gets no comment", async () => {
    const [ledger, github] = [freshLedger(), fakeGithub({ readFails: true })];
    takeIn(ledger);
    const result = await createRecorder({ ledger, github }).record({ row: ROW, ref: REF, text: WORDS });
    assert.equal(result.outcome, "refused");
    assert.match(result.say, /could not read a11ign\/a11ign#3333/);
    assert.deepEqual(github.calls, []);
  });
});

describe("chairman:record as a command", () => {
  /**
   * The command with everything injected. `inbound` seeds the ledger the command reads, in the file it reads it from.
   * @param {string[]} argv @param {{messaging?: boolean, env?: Record<string, string | undefined>, stdin?: string, inbound?: boolean, github?: ReturnType<typeof fakeGithub>}} [options]
   */
  async function run(argv: string[], { messaging = true, env = GH_ACCOUNT, stdin = WORDS, inbound = true, github = fakeGithub() }: { messaging?: boolean; env?: Record<string, string | undefined>; stdin?: string; inbound?: boolean; github?: ReturnType<typeof fakeGithub>; } = {}) {
    const base = join(scratch, `command-${nextCase += 1}`);
    const [root, home] = [join(base, "root"), join(base, "home")];
    mkdirSync(join(root, ".agent-org"), { recursive: true });
    const messagingKey = { provider: "telegram", tokenFile: "~/.config/agent-org/token", chairmanFile: "~/.config/agent-org/chairman.json" };
    writeFileSync(join(root, ".agent-org", "project.json"), JSON.stringify({ tracker: [{ key: "", repo: REPO }], ...(messaging ? { messaging: messagingKey } : {}) }));
    const ledgerPath = defaultLedgerPath(home);
    if (inbound) takeIn(createLedger({ path: ledgerPath, now: () => NOW }));
    const [out, err] = [/** @type {string[]} */ ([]), /** @type {string[]} */ ([])];
    const code = await main(argv, { root, home, env, now: () => NOW, stdin: async () => stdin, github, out: (line) => out.push(line), err: (line) => err.push(line) });
    return { code, out, err, github, lines: () => readLedgerLines(ledgerPath).filter((line) => line.direction === "record") };
  }

  test("a recorded answer exits 0 and says so", async () => {
    const github = fakeGithub();
    const first = await run([`--row=${ROW.number}`, `--message=${REF}`], { github });
    assert.deepEqual([first.code, first.err], [EXIT.ok, []]);
    assert.match(first.out[0], /^chairman:record: Recorded on a11ign\/a11ign#3333\.$/);
    assert.equal(github.row.comments.length, 1);
    assert.deepEqual(first.lines().map((line) => line.step), ["comment"]);
  });

  test("a ref the ledger does not hold exits 2 and writes no comment and no ledger line", async () => {
    const result = await run([`--row=${ROW.number}`, "--message=99"]);
    assert.equal(result.code, EXIT.refused);
    assert.match(result.err[0], /no message from the chairman with ref 99/);
    assert.deepEqual([result.github.calls, result.lines()], [[], []]);
  });

  test("every command that cannot start exits 2 and writes nothing: messaging off, no account, no ref, no row, an unknown flag", async () => {
    const [good, none] = [[`--row=${ROW.number}`, `--message=${REF}`], undefined];
    const cases = [
      ["messaging off", good, { messaging: false }],
      ["no declared account", good, { env: {} }],
      ["no --message", [`--row=${ROW.number}`], none],
      ["no --row", [`--message=${REF}`], none],
      ["--row=abc", ["--row=abc", `--message=${REF}`], none],
      ["an unknown flag", [...good, "--force"], none],
    ];
    for (const [name, argv, options] of cases) {
      const result = await run(/** @type {string[]} */ (argv), /** @type {any} */ (options));
      assert.equal(result.code, EXIT.refused, String(name));
      assert.deepEqual(result.github.calls, [], String(name));
    }
  });

  test("a GitHub write that fails exits 1, and the ledger holds the failed line", async () => {
    const result = await run([`--row=${ROW.number}`, `--message=${REF}`], { github: fakeGithub({ failOnce: ["comment"] }) });
    assert.equal(result.code, EXIT.failed);
    assert.deepEqual(result.lines().map((line) => line.step), ["failed"]);
  });

  test("record.mjs never names the chairman's provenance line outside a comment and never reaches GitHub but through the writer it is handed", () => {
    const source = readFileSync(new URL("./record.mjs", import.meta.url), "utf8");
    assert.equal(/PROVENANCE|Chairman answered via Telegram/.test(source.replace(/^\/\/.*$/gm, "")), false, "record.mjs never names the chairman's provenance line outside a comment");
    assert.equal(/execFile|child_process|fetch\(/.test(source), false);
  });
});
