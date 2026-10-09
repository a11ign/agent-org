// @ts-check
// `chairman:queue` (a11ign/a11ign#3427, D1): THE QUEUE FOR THE CHAIRMAN'S OWN SESSION. The ledger and the queue file are real files in a scratch directory; the clock is the test's.
//
// POSITIVE CONTROLS, named where they are used: (1) is the control for every refusal after it (a refusal that left the file unchanged is shown against a file that CAN grow);
// (3)'s secret is a shape `classifyText` itself drops, asserted in the test, and the same ask without it is queued; (7)'s scan names the file it must find, and its fixture
// is a module that does spawn, which the scan must refuse.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, test } from "node:test";

import { classifyText } from "./classify.ts";
import { createLedger } from "./ledger.ts";
import { formatReport, measure } from "./measure.ts";
import { ASK_FIELDS, createSessionQueue, defaultQueuePath, EXIT, FORME_STEP, main, readAsks, statusLine } from "./session-queue.ts";
import { defaultLedgerPath } from "./state.ts";

const scratch = mkdtempSync(join(tmpdir(), "messaging-session-queue-"));
after(() => rmSync(scratch, { recursive: true, force: true }));
let nextCase = 0;

const START = Date.parse("2026-10-04T12:00:00Z");
const MESSAGE = "45";
const WORDS = "yes, go ahead and bring worker-6 back";
const THE_ASK = { what: "re-enable worker-6's switch port", why: "worker-6 has not answered since 10:00 and the fleet runs on five", resultWanted: "the port's state, one line" };
/** A token shape `classifyText` drops: built here so no secret-looking literal sits in the file. */
const TOKEN = `ghp_${"a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8"}`;

/** @param {string} text @returns {string} */
const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

/**
 * A home of its own whose ledger holds the chairman's message `MESSAGE` as the listener writes it (the receipt with its hash, then the converse line), and the queue over it.
 * Every minute the clock moves is the test's.
 *
 * @param {{ press?: string }} [options] `press`: the ref of a "Do it for me" press the ledger also holds
 */
function freshQueue({ press }: { press?: string; } = {}) {
  const home = join(scratch, `case-${nextCase += 1}`);
  let clock = START;
  const now = () => clock;
  const ledger = createLedger({ path: defaultLedgerPath(home), now });
  ledger.append({ direction: "in", updateId: 1, verdict: "forward", reason: null, kind: "message", sha256: sha256(WORDS) });
  ledger.append({ direction: "in", origin: "converse", updateId: 1, messageRef: MESSAGE, verdict: "queued" });
  if (press !== undefined) ledger.append({ direction: "answer", request: "request:a11ign/a11ign#3333", messageRef: press, step: FORME_STEP, via: "button" });
  let issued = 0;
  const path = defaultQueuePath(home);
  const queue = createSessionQueue({ path, ledger, now, newId: () => `q-${issued += 1}` });
  return { home, path, ledger, queue, tick: (/** @type {number} */ minutes: number) => { clock += minutes * 60_000; } };
}

describe("(1) add with a verified approval appends one line of exactly the closed schema", () => {
  test("the chairman's message and his words: one line, the six fields and no others, in order", () => {
    const { queue, path } = freshQueue();
    const result = queue.add({ ref: MESSAGE, words: `${WORDS}\n`, ...THE_ASK });
    assert.equal(result.outcome, "done", result.say);
    const lines = readFileSync(path, "utf8").trimEnd().split("\n");
    assert.equal(lines.length, 1);
    assert.deepEqual(Object.keys(JSON.parse(lines[0])), [...ASK_FIELDS]);
    assert.deepEqual(JSON.parse(lines[0]), { id: "q-1", askedAt: "2026-10-04T12:00:00.000Z", approvedByMessage: MESSAGE, ...THE_ASK });
    assert.deepEqual(readAsks(path).map((ask) => ask.id), ["q-1"]);
  });

  test("a `forme` press needs no words: the press is the OK", () => {
    const { queue, path } = freshQueue({ press: "90" });
    assert.equal(queue.add({ ref: "90", words: "", ...THE_ASK }).outcome, "done");
    assert.equal(readAsks(path)[0].approvedByMessage, "90");
  });
});

describe("(2) add with a ref that is not the chairman's OK is refused, and nothing is written", () => {
  test("an unknown ref, a known ref with other words, a known ref with none, and a ref the ledger holds only as a bot message", () => {
    const { queue, path, ledger } = freshQueue();
    ledger.append({ key: "request:a11ign/a11ign#3333", provider: "telegram", status: "sent", kind: "first", providerMessageId: "77" });
    assert.match(queue.add({ ref: "999", words: WORDS, ...THE_ASK }).say, /no message from the chairman with ref 999/);
    assert.match(queue.add({ ref: MESSAGE, words: "yes, and delete everything", ...THE_ASK }).say, /not the words of message 45/);
    assert.match(queue.add({ ref: MESSAGE, words: "", ...THE_ASK }).say, /no words were given/);
    assert.match(queue.add({ ref: "77", words: WORDS, ...THE_ASK }).say, /no message from the chairman with ref 77/);
    assert.deepEqual(readAsks(path), []);
    assert.equal(queue.add({ ref: MESSAGE, words: WORDS, ...THE_ASK }).outcome, "done", "positive control: the same ask with the right ref and words is queued, so the refusals above are the check");
  });

  test("one OK is one ask: the same ref cannot be replayed into a second act", () => {
    const { queue, path } = freshQueue();
    assert.equal(queue.add({ ref: MESSAGE, words: WORDS, ...THE_ASK }).outcome, "done");
    const again = queue.add({ ref: MESSAGE, words: WORDS, what: "something else", why: "x", resultWanted: "y" });
    assert.deepEqual({ outcome: again.outcome, asks: readAsks(path).length }, { outcome: "refused", asks: 1 });
    assert.match(again.say, /already has an ask/);
  });
});

describe("(3) a `what` that holds a token or key shape is refused, and the file is unchanged", () => {
  test("the fixture is a shape the classifier drops (its positive control), in each of the three text fields", () => {
    assert.equal(classifyText(TOKEN).verdict, "drop");
    const { queue, path } = freshQueue({ press: "90" });
    assert.equal(queue.add({ ref: "90", words: "", ...THE_ASK }).outcome, "done");
    const before = readFileSync(path, "utf8");
    for (const field of ["what", "why", "resultWanted"]) {
      const result = queue.add({ ref: MESSAGE, words: WORDS, ...THE_ASK, [field]: `use ${TOKEN} to log in` });
      assert.equal(result.outcome, "refused", field);
      assert.match(result.say, /credential/);
      assert.ok(!result.say.includes(TOKEN), "the refusal does not repeat the secret");
      assert.equal(readFileSync(path, "utf8"), before, `${field}: the file is byte-for-byte unchanged`);
    }
  });

  test("a deletion or a purchase is NOT refused here: the chairman's session may be asked to do either with his OK", () => {
    const { queue } = freshQueue();
    assert.equal(queue.add({ ref: MESSAGE, words: WORDS, what: "delete the stale worker-6 DHCP lease", why: "it blocks the new one", resultWanted: "done or not" }).outcome, "done");
  });
});

describe("(4) list and take write lastRead, and the status line says `never read` or `not read since <time>`", () => {
  test("never read, then asked, read, asked again, taken", () => {
    const { queue, ledger, tick } = freshQueue({ press: "90" });
    assert.equal(queue.status(), "0 open; the chairman's session has never read the queue");
    queue.add({ ref: "90", words: "", ...THE_ASK });
    assert.equal(queue.status(), "1 open; the chairman's session has never read the queue");
    tick(5);
    assert.equal(queue.list().length, 1);
    assert.equal(queue.status(), "1 open; last read 2026-10-04T12:05:00.000Z");
    tick(10);
    ledger.append({ direction: "answer", request: "request:a11ign/a11ign#3334", messageRef: "91", step: FORME_STEP, via: "button" });
    assert.equal(queue.add({ ref: "91", words: "", ...THE_ASK }).outcome, "done");
    assert.equal(queue.status(), "2 open; not read since 2026-10-04T12:05:00.000Z");
    tick(1);
    assert.equal(queue.take("q-1").outcome, "done");
    assert.equal(queue.status(), "2 open; last read 2026-10-04T12:16:00.000Z", "a take is a read too");
  });

  test("a take of an id the queue does not hold is refused, still counts as a read, and writes no take line", () => {
    const { queue, ledger } = freshQueue();
    assert.equal(queue.take("q-nope").outcome, "refused");
    assert.deepEqual(ledger.read().filter((line) => line.direction === "queue").map((line) => line.op), ["read"]);
  });

  test("statusLine is a function of the file and the ledger and never says the session is up", () => {
    assert.doesNotMatch(statusLine({ asks: [], lines: [] }), /running|up\b|alive/i);
  });
});

describe("(5) done records the result, and --hand-fix raises the measure's count by one", () => {
  const window = { since: START - 3_600_000, until: START + 3_600_000 };
  /** @param {Record<string, any>[]} lines @returns {number} */
  const handFixes = (lines: Record<string, any>[]): number => /** @type {any} */ (measure(lines, window)).handFixes;

  test("a plain done leaves the count, a hand-fix raises it by one, and the same id cannot be done twice", () => {
    const { queue, ledger } = freshQueue({ press: "90" });
    queue.add({ ref: "90", words: "", ...THE_ASK });
    ledger.append({ direction: "answer", request: "request:a11ign/a11ign#3334", messageRef: "91", step: FORME_STEP, via: "button" });
    queue.add({ ref: "91", words: "", ...THE_ASK });
    const before = handFixes(ledger.read());
    assert.equal(queue.done({ id: "q-1", result: "port re-enabled", handFix: false }).outcome, "done");
    assert.equal(handFixes(ledger.read()), before, "a done that is not a hand-fix is not counted");
    assert.equal(queue.done({ id: "q-2", result: "worker-6 is serving again: switch config fixed by hand", handFix: true }).outcome, "done");
    assert.equal(handFixes(ledger.read()), before + 1);
    assert.deepEqual(ledger.read().filter((line) => line.op === "done").map((line) => [line.id, line.result, line.handFix]), [["q-1", "port re-enabled", false], ["q-2", "worker-6 is serving again: switch config fixed by hand", true]]);
    assert.equal(queue.done({ id: "q-2", result: "again", handFix: true }).outcome, "refused");
    assert.equal(handFixes(ledger.read()), before + 1, "a refused second done is not a second hand-fix");
    assert.ok(formatReport(/** @type {any} */ (measure(ledger.read(), window)), window).includes("hand-fixes by the chairman's session: 1"));
    assert.equal(queue.list()[0], "nothing is open");
  });

  test("an unknown id, an empty or multi-line result, and a secret-shaped result are refused and write no done line", () => {
    const { queue, ledger } = freshQueue({ press: "90" });
    queue.add({ ref: "90", words: "", ...THE_ASK });
    for (const [id, result] of [["q-9", "ok"], ["q-1", ""], ["q-1", "line one\nline two"], ["q-1", `token is ${TOKEN}`]]) {
      assert.equal(queue.done({ id, result, handFix: false }).outcome, "refused", `${id} ${JSON.stringify(result)}`);
    }
    assert.deepEqual(ledger.read().filter((line) => line.op === "done"), []);
    assert.equal(queue.done({ id: "q-1", result: "done", handFix: false }).outcome, "done", "positive control: the id and a clean result are accepted");
  });
});

describe("(6) the file is created 0600", () => {
  test("a new file is 0600 and its directory 0700; a file left readable by others is refused rather than written to", () => {
    const { queue, path } = freshQueue({ press: "90" });
    assert.equal(queue.add({ ref: "90", words: "", ...THE_ASK }).outcome, "done");
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal(statSync(join(path, "..")).mode & 0o777, 0o700);
    chmodSync(path, 0o644);
    const before = readFileSync(path, "utf8");
    const refused = queue.add({ ref: MESSAGE, words: WORDS, ...THE_ASK });
    assert.equal(refused.outcome, "refused");
    assert.match(refused.say, /mode 644, not 600/);
    assert.equal(readFileSync(path, "utf8"), before);
  });

  test("a directory that already exists readable by others is refused, never written into, and not re-moded", () => {
    const { queue, path } = freshQueue();
    const directory = join(path, "..");
    chmodSync(directory, 0o755);
    const refused = queue.add({ ref: MESSAGE, words: WORDS, ...THE_ASK });
    assert.equal(refused.outcome, "refused");
    assert.match(refused.say, /mode 755, not 700/);
    assert.equal(existsSync(path), false);
    assert.equal(statSync(directory).mode & 0o777, 0o755);
    chmodSync(directory, 0o700);
    assert.equal(queue.add({ ref: MESSAGE, words: WORDS, ...THE_ASK }).outcome, "done", "the same ask queues once the directory is private: the refusal was the directory's");
  });

  test("a line that is not exactly the schema is a refusal to read, never a skip", () => {
    const { path } = freshQueue();
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, `${JSON.stringify({ id: "q-1", askedAt: "x", approvedByMessage: "1", what: "a", why: "b", resultWanted: "c", extra: "d" })}\n`);
    assert.throws(() => readAsks(path), /is not exactly id, askedAt/);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// (7) THE "NO EXECUTOR" SCAN: no module under `src/messaging/` that touches the queue file may spawn a process.

const MESSAGING = fileURLToPath(new URL(".", import.meta.url));
/** What reaches the queue file: its name, or the module that owns it. */
const TOUCHES_QUEUE = /chairman-session-queue|session-queue\.mjs|\bQUEUE_FILE\b|\bdefaultQueuePath\b/;
/** What spawns a process, or runs code the module did not contain: every way into one that Node offers. */
const SPAWNS = /\b(?:node:)?child_process\b|\b(?:spawn|spawnSync|exec|execSync|execFile|execFileSync|fork)\s*\(|\bworker_threads\b|\bprocess\.binding\b|\bnew Worker\b/;

/** @param {string} dir @param {string} [base] @returns {string[]} every non-test `.mjs` under `dir`, relative to `base` */
function sourceFiles(dir: string, base: string = dir): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path, base);
    return entry.name.endsWith(".mjs") && !entry.name.includes(".test.") ? [relative(base, path)] : [];
  });
}

/** @param {string} source @returns {string} the code with comment lines removed: a module is judged by what it does and not by what its header says */
function withoutComments(source: string): string {
  return source.split("\n").filter((line) => !/^\s*(\/\/|\/?\*)/.test(line)).join("\n");
}

/** @param {string} dir @returns {{touching: string[], executors: string[]}} the modules that touch the queue file, and those of them that spawn */
function scan(dir: string): { touching: string[]; executors: string[]; } {
  const touching = sourceFiles(dir).filter((file) => TOUCHES_QUEUE.test(withoutComments(readFileSync(join(dir, file), "utf8"))));
  return { touching, executors: touching.filter((file) => SPAWNS.test(withoutComments(readFileSync(join(dir, file), "utf8")))) };
}

describe("(7) no executor: nothing under src/messaging/ that touches the queue file spawns a process", () => {
  test("the scan finds the module it is meant to find (its positive control), and the matcher notices each way to spawn", () => {
    assert.ok(sourceFiles(MESSAGING).length > 10, "the walk reached the messaging sources");
    assert.ok(scan(MESSAGING).touching.includes("session-queue.mjs"), "session-queue.mjs is the module the scan exists to bound");
    for (const sample of ["import { execFile } from 'node:child_process';", "spawn('claude', [])", "execSync(`gh api`)", "import { Worker } from 'node:worker_threads'", "const w = new Worker(file)"]) {
      assert.ok(SPAWNS.test(sample), `the matcher notices ${sample}`);
    }
    assert.ok(!SPAWNS.test("const spawned = lines.filter(Boolean); // exec is a word"), "and not a name that merely contains one");
  });

  test("the real tree has no executor", () => {
    assert.deepEqual(scan(MESSAGING).executors, []);
  });

  test("THE CONTROL THE SCAN CAN FAIL: a copy of the module with a fixture that touches the queue AND spawns is refused, and without the fixture the copy passes", () => {
    const fixture = join(scratch, "scan-fixture");
    mkdirSync(fixture, { recursive: true });
    copyFileSync(join(MESSAGING, "session-queue.mjs"), join(fixture, "session-queue.mjs"));
    assert.deepEqual(scan(fixture), { touching: ["session-queue.mjs"], executors: [] }, "without the fixture the copy passes, so the next failure is the fixture's");
    writeFileSync(join(fixture, "executor.mjs"), 'import { execFile } from "node:child_process";\nimport { readAsks } from "./session-queue.ts";\nfor (const ask of readAsks(p)) execFile("claude", ["-p", ask.what]);\n');
    assert.deepEqual(scan(fixture).executors, ["executor.mjs"]);
  });

  test("the module names no directory a credential lives in", () => {
    assert.doesNotMatch(withoutComments(readFileSync(join(MESSAGING, "session-queue.mjs"), "utf8")), /\.config|agent-org\/(?:secrets|credentials)|token|chairman\.json/i);
  });
});

describe("chairman:queue as a command", () => {
  /** @param {{ messaging?: boolean }} [options] @returns {{home: string, root: string}} a project and a home of their own, the ledger holding the chairman's message */
  function place({ messaging = true }: { messaging?: boolean; } = {}): { home: string; root: string; } {
    const base = mkdtempSync(join(scratch, "cli-"));
    const [root, home] = [join(base, "root"), join(base, "home")];
    mkdirSync(join(root, ".agent-org"), { recursive: true });
    const key = { provider: "telegram", tokenFile: "~/.config/agent-org/token", chairmanFile: "~/.config/agent-org/chairman.json" };
    writeFileSync(join(root, ".agent-org", "project.json"), JSON.stringify({ tracker: [{ key: "", repo: "a11ign/a11ign" }], ...(messaging ? { messaging: key } : {}) }));
    const ledger = createLedger({ path: defaultLedgerPath(home), now: () => START });
    ledger.append({ direction: "in", updateId: 1, verdict: "forward", reason: null, kind: "message", sha256: sha256(WORDS) });
    ledger.append({ direction: "in", origin: "converse", updateId: 1, messageRef: MESSAGE, verdict: "queued" });
    return { home, root };
  }

  /** @param {{home: string, root: string}} where @param {string[]} argv @param {string} [stdin] */
  async function run({ home, root }: { home: string; root: string; }, argv: string[], stdin: string = "") {
    const [out, err] = [/** @type {string[]} */ ([]), /** @type {string[]} */ ([])];
    const code = await main(argv, { root, home, now: () => START, stdin: async () => stdin, out: (line) => out.push(line), err: (line) => err.push(line) });
    return { code, out, err };
  }

  test("add, status, list, take, done --hand-fix, end to end, with the exit codes", async () => {
    const where = place();
    const add = ["add", `--message=${MESSAGE}`, `--what=${THE_ASK.what}`, `--why=${THE_ASK.why}`, `--result-wanted=${THE_ASK.resultWanted}`];
    assert.equal((await run(where, add, `${WORDS}\n`)).code, EXIT.ok);
    assert.match((await run(where, ["status"])).out[0], /^1 open; the chairman's session has never read the queue$/);
    const listed = await run(where, ["list"]);
    const id = listed.out[0].split("\t")[0];
    assert.match(id, /^q-[0-9a-f]{6}$/);
    assert.equal((await run(where, ["take", id])).code, EXIT.ok);
    assert.equal((await run(where, ["done", id, "--result=worker-6 is serving again", "--hand-fix"])).code, EXIT.ok);
    assert.equal((await run(where, ["list"])).out[0], "nothing is open");
    assert.equal((await run(where, ["take", "q-none"])).code, EXIT.refused);
  });

  test("a secret, no words, an unknown verb and messaging off each exit 2 and write no ask", async () => {
    const where = place();
    const add = ["add", `--message=${MESSAGE}`, `--what=${THE_ASK.what}`, `--why=${THE_ASK.why}`, `--result-wanted=${THE_ASK.resultWanted}`];
    assert.equal((await run(where, ["add", ...add.slice(1, 3), `--why=${TOKEN}`, add[4]], WORDS)).code, EXIT.refused);
    assert.equal((await run(where, add, "")).code, EXIT.refused);
    assert.equal((await run(where, ["frobnicate"])).code, EXIT.refused);
    assert.equal((await run(place({ messaging: false }), add, WORDS)).code, EXIT.refused);
    assert.deepEqual(readAsks(defaultQueuePath(where.home)), []);
    assert.equal((await run(where, add, WORDS)).code, EXIT.ok, "positive control: the same command with his words is queued");
  });
});
