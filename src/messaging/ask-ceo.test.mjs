// @ts-check
// `chairman:ask-ceo` (a11ign/a11ign#3490, B4b). **THE LIAISON ASKS `ceo`, AND ONLY `ceo`, AND A QUESTION NAMING NOTHING THAT CLEARS IT SENDS NOTHING.**
//
// **POSITIVE CONTROLS, NAMED.** Case 1 (a ref the ledger holds, a question with a `Waiting-for:` line) is the non-empty case that cases 2 and 3 are read against: each refusal is the
// SAME fixture with one thing taken away, and the runner is shown to be called in case 1, so "nothing was sent" in cases 2 to 4 is not a runner that never ran. The predicate (case 3)
// is a pair, and a second pair shows it is the gate's grammar and not a look for the word: `Waiting-for: soon` and a bare `#3490` in a sentence are refused, as `manual` is.
//
// Run with the host's declaration (`AGENT_ORG_HOST`), because the predicate IS the gate's own parser, `wait-condition.mjs`, which reads it at import. Without it the cases that need the
// parser are skipped, NAMING the reason, and the last case fails if they were skipped for any reason but the host's absence.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";

import { RECIPIENT, main, namesWhatClearsIt, orderText } from "./ask-ceo.mjs";
import { VERBS } from "./correct.mjs";
import { createLedger, describeError, readLedgerLines } from "./ledger.mjs";
import { EXIT } from "./record.mjs";
import { defaultLedgerPath } from "./state.mjs";

const NOW = Date.parse("2026-10-04T15:00:00Z");
const REPO = "a11ign/a11ign";
const ROW = 3490;
const REF = "45";
const CHAIRMAN_WORDS = "Ask ceo whether the freeze applies.";
const GH_ACCOUNT = { GH_CONFIG_DIR: "/leads/gh", HERDR_WORKSPACE_ID: "w9" };
const CLEARS = `Waiting-for: unlabelled answer:ceo #${ROW}`;
const QUESTION = `Does the freeze in #3333 apply to the messaging rows?\nThe answer is yes or no.\n${CLEARS}`;
const WITHOUT_CLEARS = QUESTION.replace(`\n${CLEARS}`, "");

/** @type {import("./ask-ceo.mjs").Invocation[]} */
let seen = [];
/** @type {{parseWaits: import("./ask-ceo.mjs").ParseWaits} | {reason: string}} */
const gate = await import("../wait-condition.mjs").then((module) => ({ parseWaits: module.parseWaits }), (error) => ({ reason: describeError(error) }));
const skip = "reason" in gate ? gate.reason : false;

const scratch = mkdtempSync(join(tmpdir(), "messaging-ask-ceo-"));
after(() => rmSync(scratch, { recursive: true, force: true }));
let nextCase = 0;

/** @param {string} text @returns {string} */
const sha256Of = (text) => createHash("sha256").update(text, "utf8").digest("hex");

/**
 * The command with everything injected, as `record.test.mjs` does. `ran` is what `prompt:session` is made to return; every invocation is kept in `seen`.
 * @param {string[]} argv @param {{messaging?: boolean, env?: Record<string, string | undefined>, stdin?: string, inbound?: boolean, ran?: Partial<import("./ask-ceo.mjs").Ran>}} [options]
 */
async function run(argv, { messaging = true, env = GH_ACCOUNT, stdin = QUESTION, inbound = true, ran = { status: 2, stderr: "QUEUED handoff/ceo/abc12345 -- the next work:tick delivers it.\n", stdout: "" } } = {}) {
  const base = join(scratch, `command-${nextCase += 1}`);
  const [root, home] = [join(base, "root"), join(base, "home")];
  mkdirSync(join(root, ".agent-org"), { recursive: true });
  const messagingKey = { provider: "telegram", tokenFile: "~/.config/agent-org/token", chairmanFile: "~/.config/agent-org/chairman.json" };
  writeFileSync(join(root, ".agent-org", "project.json"), JSON.stringify({ tracker: [{ key: "", repo: REPO }], ...(messaging ? { messaging: messagingKey } : {}) }));
  const ledgerPath = defaultLedgerPath(home);
  const ledger = createLedger({ path: ledgerPath, now: () => NOW });
  if (inbound) {
    ledger.append({ direction: "in", updateId: 11, verdict: "forward", reason: null, kind: "message", userId: 7, chatId: 7, chatType: "private", length: CHAIRMAN_WORDS.length, sha256: sha256Of(CHAIRMAN_WORDS) });
    ledger.append({ direction: "in", origin: "converse", updateId: 11, messageRef: REF, verdict: "queued", handoff: "handoff/liaison/x", ackRef: "46", error: null });
  }
  const [out, err] = [/** @type {string[]} */ ([]), /** @type {string[]} */ ([])];
  seen = [];
  const code = await main(argv, {
    root, home, env, now: () => NOW, stdin: async () => stdin, out: (line) => out.push(line), err: (line) => err.push(line),
    parseWaits: "parseWaits" in gate ? gate.parseWaits : () => [],
    run: (invocation) => { seen.push(invocation); return { status: 0, stdout: "", stderr: "", ...ran }; },
  });
  return { code, out, err, ledgerLines: () => readLedgerLines(ledgerPath) };
}

const VERB_COUNT = 3;
const GOOD = [`--row=${ROW}`, `--message=${REF}`];

describe("chairman:ask-ceo", { skip }, () => {
  test("1. a ref the ledger holds and a question that names what clears it queues ONE order to ceo, as a decision, from the liaison (the positive control)", async () => {
    const result = await run(GOOD);
    assert.deepEqual([result.code, result.err], [EXIT.ok, []]);
    assert.equal(seen.length, 1, "one order, and the runner DID run: the refusals below are read against this");
    assert.deepEqual(seen[0].args, ["run", "prompt:session", "--", "ceo", "--needs-decision"]);
    assert.equal(seen[0].env.HERDR_WORKSPACE_ID, "w9", "the caller's environment travels, which is how prompt:session derives the sender from the caller's own workspace");
    assert.match(seen[0].input, /^Asked of you by the liaison, for a ruling; not from a session and not written by the chairman\./);
    assert.match(seen[0].input, new RegExp(`Row: ${REPO}#${ROW}`));
    assert.ok(seen[0].input.includes(QUESTION), "the question is carried whole, its Waiting-for line in it");
    assert.match(result.out[0], /^chairman:ask-ceo: queued for ceo/);
  });

  test("2. a ref the ledger does not hold is refused, and nothing is queued", async () => {
    const result = await run([`--row=${ROW}`, "--message=99"]);
    assert.equal(result.code, EXIT.refused);
    assert.match(result.err[0], /no message from the chairman with ref 99/);
    assert.deepEqual(seen, []);
    const empty = await run(GOOD, { inbound: false });
    assert.equal(empty.code, EXIT.refused, "an empty ledger holds no ref at all");
    assert.deepEqual(seen, []);
  });

  test("3. THE PREDICATE, AS A PAIR: the question without its Waiting-for line is refused, the same question with it is queued", async () => {
    const without = await run(GOOD, { stdin: WITHOUT_CLEARS });
    assert.equal(without.code, EXIT.refused);
    assert.match(without.err[0], /names nothing that clears it, so nothing was sent/);
    assert.deepEqual(seen, [], "nothing reached prompt:session");
    const withIt = await run(GOOD, { stdin: `${WITHOUT_CLEARS}\n${CLEARS}` });
    assert.equal(withIt.code, EXIT.ok);
    assert.equal(seen.length, 1);
  });

  test("3b. what is NOT a clearing clause: prose naming a row, a wait outside the grammar, `manual`, and a Waiting-for line inside a code fence", async () => {
    const refused = [
      `${WITHOUT_CLEARS}\nPlease rule on #${ROW}: does it apply?`,
      `${WITHOUT_CLEARS}\nWaiting-for: soon`,
      `${WITHOUT_CLEARS}\nWaiting-for: manual`,
      `${WITHOUT_CLEARS}\nWaiting-for: closed the freeze row`,
      `${WITHOUT_CLEARS}\n\`\`\`\n${CLEARS}\n\`\`\``,
    ];
    for (const stdin of refused) assert.equal((await run(GOOD, { stdin })).code, EXIT.refused, stdin);
    assert.deepEqual(seen, []);
    for (const wait of ["closed #3333", "merged #3333", "labelled needs:ruling #3333", `unlabelled answer:ceo #${ROW}`]) {
      assert.equal((await run(GOOD, { stdin: `${WITHOUT_CLEARS}\nWaiting-for: ${wait}` })).code, EXIT.ok, wait);
      assert.equal(seen.length, 1, `${wait}: queued`);
    }
  });

  test("3c. an empty question is refused; so is one that is only whitespace", async () => {
    for (const stdin of ["", "  \n"]) assert.equal((await run(GOOD, { stdin })).code, EXIT.refused);
    assert.deepEqual(seen, []);
  });

});

describe("chairman:ask-ceo, its target and what `prompt:session` answers", { skip }, () => {
  test("4. the target is ceo only: no argument names another session, and a flag or a positional is refused before anything is sent", async () => {
    assert.equal(RECIPIENT, "ceo");
    for (const extra of [["--to=worker-1"], ["--session=worker-1"], ["--label=reviewer-3"], ["--target", "product-manager"], ["worker-1"], ["--needs-decision"]]) {
      const result = await run([...GOOD, ...extra]);
      assert.equal(result.code, EXIT.refused, extra.join(" "));
    }
    assert.deepEqual(seen, [], "none of them reached the runner");
    await run(GOOD);
    assert.equal(/** @type {import("./ask-ceo.mjs").Invocation[]} */ (seen)[0].args.filter((arg) => !arg.startsWith("-") && !["run", "prompt:session"].includes(arg)).join(), "ceo", "the one session named in the invocation is ceo");
  });

  test("4b. the source names ceo once, as the constant, and takes no target from argv", () => {
    const code = readFileSync(new URL("./ask-ceo.mjs", import.meta.url), "utf8").split("\n").filter((line) => !/^\s*(\/\/|\/?\*)/.test(line)).join("\n");
    assert.match(code, /export const RECIPIENT = "ceo";/);
    assert.equal((code.match(/"ceo"/g) ?? []).length, 1, "the literal appears once");
    assert.match(code, /const args = \["run", "prompt:session", "--", RECIPIENT, DECISION_FLAG\];/, "the invocation names the constant");
    assert.equal(/process\.argv\.slice\(2\)/.test(code), true, "argv reaches only main, whose parseArgs is strict");
    assert.equal(/values\.(to|session|label|target)/.test(code), false, "no option is read as a target");
  });

  test("5. prompt:session's exit 2 is reported as queued, exits 0, and is run ONCE; a refusal exits 2 with its words; a crash exits 1", async () => {
    const queued = await run(GOOD, { ran: { status: 2, stderr: "QUEUED handoff/ceo/aa -- DO NOT RETRY\n" } });
    assert.deepEqual([queued.code, queued.err, seen.length], [EXIT.ok, [], 1], "queued is not a failure and is not retried");
    assert.match(queued.out[0], /queued for ceo \(prompt:session exit 2 is QUEUED, not a failure; do not retry\)/);

    const delivered = await run(GOOD, { ran: { status: 0, stdout: "PROMPTED ceo, cleared first\n", stderr: "" } });
    assert.deepEqual([delivered.code, seen.length], [EXIT.ok, 1]);
    assert.match(delivered.out[0], /delivered to ceo: PROMPTED ceo/);

    const refused = await run(GOOD, { ran: { status: 1, stderr: "NOT PROMPTED, AND NOT QUEUED: no session named \"ceo\".\n" } });
    assert.deepEqual([refused.code, seen.length], [EXIT.refused, 1], "refused by the queue: still one call, never a second");
    assert.ok(refused.err[0].includes("NOT PROMPTED, AND NOT QUEUED: no session named \"ceo\"."), "the queue's words, verbatim");

    const crashed = await run(GOOD, { ran: { status: null, error: new Error("spawn pnpm ENOENT") } });
    assert.deepEqual([crashed.code, seen.length], [EXIT.failed, 1]);
    assert.match(crashed.err[0], /could not run prompt:session \(spawn pnpm ENOENT\).*do not assume it was/);
  });

  test("a command that cannot start sends nothing: messaging off, no account, no --message, no --row", async () => {
    const cases = [["messaging off", GOOD, { messaging: false }], ["no declared account", GOOD, { env: {} }], ["no --message", [`--row=${ROW}`], undefined], ["no --row", [`--message=${REF}`], undefined]];
    for (const [name, argv, options] of cases) {
      assert.equal((await run(/** @type {string[]} */ (argv), /** @type {any} */ (options))).code, EXIT.refused, String(name));
    }
    assert.deepEqual(seen, []);
  });

  test("a refused or queued question writes no ledger line of its own and no row comment (it reaches `prompt:session` and nothing else)", async () => {
    const result = await run(GOOD);
    assert.equal(result.ledgerLines().filter((line) => line.direction !== "in").length, 0);
  });

  test("6. package.json carries chairman:ask-ceo, and the verb set of chairman:correct is unchanged", () => {
    const scripts = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).scripts;
    assert.equal(scripts["chairman:ask-ceo"], "node src/messaging/ask-ceo.mjs");
    assert.deepEqual(VERBS, ["withdraw", "reroute", "re-ask"]);
    assert.equal(VERBS.length, VERB_COUNT, "VERBS is still three: ask-ceo is a command of its own and not a fourth correction");
  });
});

describe("the predicate and the order text, without a host", () => {
  test("namesWhatClearsIt reads only readable waits, and the order names the liaison as its author", () => {
    const waits = (/** @type {string} */ text) => [...text.matchAll(/^Waiting-for: (\w+)/gm)].map((match) => ({ state: match[1] }));
    assert.equal(namesWhatClearsIt(QUESTION, waits), true);
    assert.equal(namesWhatClearsIt(WITHOUT_CLEARS, waits), false);
    assert.equal(namesWhatClearsIt("Waiting-for: manual", waits), false);
    assert.match(orderText({ ref: REF, row: { repo: REPO, number: ROW }, text: ` ${QUESTION}\n\n` }), /^Asked of you by the liaison.*message 45\.\nRow: a11ign\/a11ign#3490\n\nDoes the freeze/);
  });

  test("the cases above ran: they were skipped for no reason but a host's absence, and with the host they were not skipped at all (the control for the skip)", () => {
    if (skip === false) return;
    assert.match(skip, /project\.json|AGENT_ORG_HOST|\.agent-org|declaration/i, `skipped for a reason that is not the host's absence: ${skip}`);
  });
});
