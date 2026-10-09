// no-token: clearContext -- nothing here clears a session or calls gh; every herdr/gh call is absent or injected
// #2222 -- A SENDER DECLARES WHETHER AN ORDER ASKS FOR AN ANSWER; THE QUEUE RECORDS IT AND THE BUNDLE HEADER
// LISTS IT. `prompt-session.mjs` writes the declaration, `wake.mjs` reads it.
//
// ITS OWN FILE, AND THE REASON IS THE ACCEPTANCE JOB'S CAPABILITY GATE (#2221): the acceptance job has no
// `gh` token, and since #2221 reads a named test file's import closure, `wake.test.ts` and
// `prompt-session.test.ts` are both refused there (`route` and `clearContext` reach wake.mjs's `gh` runner).
// Nothing below calls either, so this file is the one the row's Acceptance can actually RUN.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { queueOrLose, deepQueueRefusal, DEEP_QUEUE, DECISION_FLAG, FYI_FLAG, NEEDS_DECISION_FLAG, STANCE,
  parseStance, stanceNote, EXIT, attributed } from "../prompt-session.ts";
import { handoffId, readHandoffs, queueHandoff, handoffOrder, handoffBacklog, backlogReport,
  handoffBatches, addressed, declaresDecision, decisionHeader, MAX_LISTED_DECISIONS, PROMPT_ARG_MAX,
  HANDOFF_BATCH_BYTES } from "../wake.ts";

const HANDOFF = { id: handoffId("reviewer", "Draft #1963"), session: "reviewer",
  prompt: "Draft #1963", queuedAt: 1_000 };

/** `n` queued orders for one session, oldest first. */
function backlogOf(session: string, n: number, now: number, gap = 10): {
  id: string; session: string; prompt: string; queuedAt: number;
}[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `handoff/${session}/${String(i).padStart(4, "0")}`,
    session,
    prompt: `report ${i}`,
    queuedAt: now - (n - i) * gap * 60_000,
  }));
}

/** Run `body` with stderr captured -- `queueOrLose` reports there by design. */
function withStderr<T>(body: () => T): { value: T; err: string } {
  const original = process.stderr.write.bind(process.stderr);
  let err = "";
  (process.stderr as unknown as { write: (s: string) => boolean }).write = (s: string) => {
    err += s; return true;
  };
  try {
    return { value: body(), err };
  } finally {
    (process.stderr as unknown as { write: typeof original }).write = original;
  }
}

/** A real directory, removed afterwards whatever `body` does. */
function inTempDir(body: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "decision-declaration-"));
  try {
    body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------------------------------
// #2222 -- THE SENDER DECLARES WHETHER AN ORDER ASKS FOR AN ANSWER, and the queue records it.
//
// On the 27-order delivery that filed the row, 22 of the 30 orders that OPENED as a routine report also
// asked for a decision, so nothing downstream can compute this: it is declared here or it is lost.

const PM = [{ label: "product-manager", status: "working" }];

test("THE DECLARATION IS RECORDED ON THE QUEUE ENTRY -- a decision as true, an FYI as false", () => {
  inTempDir((dir) => {
    const path = join(dir, "q");
    const send = (text: string, stance?: "decision" | "fyi" | "undeclared") => withStderr(() => queueOrLose({
      label: "product-manager", text, why: "is working", agents: PM, path, stance,
    }));
    send("Your call: 64 KiB, or nearer the ceiling?", STANCE.DECISION);
    send("Completion report on #2102.", STANCE.FYI);
    send("A report from a sender that has not adopted the flag.");

    const queued = readHandoffs(path);
    assert.equal(queued.length, 3, "the positive control: all three are on disk to be read");
    assert.deepEqual(queued.map((h) => h.decision), [true, false, false],
      "only a declared decision is recorded as one; FYI and no declaration are both `false`");
  });
});

test("RE-SENDING THE SAME WORDS WITH --decision UPGRADES THE ORDER RATHER THAN QUEUEING IT TWICE", () => {
  // The id hashes the target and the text, not the declaration. An author who sent it as FYI and then
  // realised it asks for an answer sends ONE order twice, and the first line must not win: that would
  // demote it -- the dangerous direction, and the reason the field exists.
  inTempDir((dir) => {
    const path = join(dir, "q");
    const send = (stance: "decision" | "fyi") => withStderr(() => queueOrLose({
      label: "product-manager", text: "Do you want #2057 declined?", why: "is working", agents: PM, path,
      stance,
    }));
    send(STANCE.FYI);
    send(STANCE.DECISION);
    const queued = readHandoffs(path);
    assert.equal(queued.length, 1, "one order");
    assert.equal(queued[0].decision, true, "and it is the declared decision");
  });
  // AND THE OTHER DIRECTION IS NOT AN UPGRADE: a decision re-sent as FYI stays a decision.
  inTempDir((dir) => {
    const path = join(dir, "q");
    const send = (stance: "decision" | "fyi") => withStderr(() => queueOrLose({
      label: "product-manager", text: "Do you want #2057 declined?", why: "is working", agents: PM, path,
      stance,
    }));
    send(STANCE.DECISION);
    send(STANCE.FYI);
    assert.equal(readHandoffs(path)[0].decision, true, "a later FYI never withdraws a declared ask");
  });
});

test("THE AUTHOR IS TOLD WHAT WAS RECORDED, and the default is STATED, not silent", () => {
  inTempDir((dir) => {
    const said = (stance: "decision" | "fyi" | "undeclared", text: string) => withStderr(() => queueOrLose({
      label: "product-manager", text, why: "is working", agents: PM, path: join(dir, "q"), stance,
    })).err;
    assert.match(said(STANCE.DECISION, "d"), /DECLARED DECISION[^\n]*bundle header/);
    assert.match(said(STANCE.DECISION, "d2"), /WHAT CLEARS IT[^\n]*answer:<session>[^\n]*#928/,
      "a decision is asked to name what clears it -- and pointed at the label where a row exists");
    assert.match(said(STANCE.FYI, "f"), /DECLARED FYI/);
    const silent = said(STANCE.UNDECLARED, "u");
    assert.match(silent, /NO DECLARATION, SO THIS IS RECORDED AS FYI \(the default\)/);
    assert.ok(silent.includes(DECISION_FLAG), "and names the flag that changes it");
  });
  assert.ok(stanceNote(STANCE.UNDECLARED).length > 0, "the default is never the empty string");
});

test("--decision, --fyi and the older --needs-decision are parsed, and NONE is left in the text", () => {
  assert.deepEqual(parseStance(["ceo", "hello", "there"]),
    { stance: STANCE.UNDECLARED, rest: ["ceo", "hello", "there"] }, "the default is FYI");
  assert.deepEqual(parseStance([DECISION_FLAG, "ceo", "hello"]),
    { stance: STANCE.DECISION, rest: ["ceo", "hello"] });
  assert.deepEqual(parseStance(["ceo", FYI_FLAG, "hello"]),
    { stance: STANCE.FYI, rest: ["ceo", "hello"] });
  assert.deepEqual(parseStance(["ceo", "hello", NEEDS_DECISION_FLAG]),
    { stance: STANCE.DECISION, rest: ["ceo", "hello"] },
    "#2167's spelling is the same declaration, kept as an alias so the rules file stays true");
  assert.deepEqual(parseStance(["--ledger=/tmp/l", "ceo", "x", DECISION_FLAG]),
    { stance: STANCE.DECISION, rest: ["ceo", "x"] }, "and --ledger is still stripped beside them");
});

test("BOTH --decision AND --fyi IS REFUSED, not resolved for the sender", () => {
  const both = parseStance(["ceo", "x", DECISION_FLAG, FYI_FLAG]);
  assert.match(String(both.refusal), /contradict/);
  assert.equal("stance" in both, false, "no stance is picked: choosing one would be inferring it");
  assert.match(String(parseStance(["ceo", "x", NEEDS_DECISION_FLAG, FYI_FLAG]).refusal), /contradict/,
    "the alias contradicts --fyi too");
});

test("the deep-queue refusal names the flag that is now the canonical spelling", () => {
  const mine = { session: "product-manager", waiting: DEEP_QUEUE, oldestMs: 3_600_000, stale: 0, decisions: 0 };
  const refusal = deepQueueRefusal(mine, { label: "product-manager", text: "r", decision: false });
  assert.ok(refusal?.includes(DECISION_FLAG), "the refusal tells the author to type --decision");
  assert.equal(deepQueueRefusal(mine, { label: "product-manager", text: "r", decision: true }), null);
});

test("END TO END: the real command records --decision on the queue and strips it from the text", () => {
  // The CLI, not its parts -- a flag can be parsed correctly and still never reach the entry. herdr is
  // absent here, so the roster read fails, which queues (`queueable(label, null)`): that is the path
  // that writes the entry we are reading back.
  inTempDir((dir) => {
    const run = (...args: string[]) => spawnSync(process.execPath,
      [fileURLToPath(new URL("../prompt-session.ts", import.meta.url)),
        `--ledger=${join(dir, "wake-ledger")}`, ...args],
      { encoding: "utf8", env: { ...process.env, PATH: dir }, timeout: 30_000 });
    const asked = run("ceo", "Ratify", "64", "KiB?", DECISION_FLAG);
    const fyi = run("ceo", "Completion", "report", "on", "#1");
    assert.equal(asked.status, EXIT.QUEUED, asked.stderr);
    assert.equal(fyi.status, EXIT.QUEUED, fyi.stderr);
    const queued = readHandoffs(join(dir, "prompt-session-handoffs"));
    assert.deepEqual(queued.map((h) => [h.prompt, h.decision]),
      [[attributed("Ratify 64 KiB?", null), true], [attributed("Completion report on #1", null), false]],
      "the flag reached the entry, and the text is what the author typed without it (behind the asker "
      + "line, #2344 -- herdr is absent here, so the sender is unknown)");
    assert.equal(run("ceo", "x", DECISION_FLAG, FYI_FLAG).status, EXIT.REFUSED);
  });
});

// ---------------------------------------------------------------------------------------------------
// #2222 -- A BUNDLED DELIVERY SAYS WHICH OF ITS ORDERS THEIR SENDERS DECLARED AS ASKING FOR AN ANSWER.
//
// Measured on the 27-order delivery that filed the row: 22 of the 30 orders that OPENED as a routine
// report also asked for a decision. So the fact is DECLARED by the sender and only READ here; every test
// below builds its orders with the text a classifier on the opening line would have got wrong.

/** `n` orders whose text always opens like a routine report, with `decisions` (1-based) declared asks. */
function declared(n: number, decisions: readonly number[], now: number) {
  return backlogOf("product-manager", n, now).map((h, i) => ({
    ...h,
    prompt: `Completion report from worker-judge on row #${2000 + i}. Your call: 64 KiB, or nearer the ceiling?`,
    decision: decisions.includes(i + 1),
  }));
}

test("ONLY A LITERAL `true` IS A DECLARED DECISION, and no field at all is FYI", () => {
  assert.equal(declaresDecision({ decision: true }), true);
  assert.equal(declaresDecision({ decision: false }), false);
  assert.equal(declaresDecision({}), false, "an entry written before the field existed is FYI");
  assert.equal(declaresDecision({ decision: "true" }), false, "a string is not a declaration");
  assert.equal(declaresDecision({ decision: 1 }), false);
  assert.equal(declaresDecision(undefined), false);
});

test("queueHandoff WRITES THE DECLARATION on every entry, FYI included", () => {
  const written: string[] = [];
  const write = ((_p: string, d: string) => { written.push(d); }) as never;
  const mkdir = (() => undefined) as never;
  const asked = queueHandoff("/q/h", { session: "ceo", prompt: "Ratify?", decision: true, write, mkdir });
  const plain = queueHandoff("/q/h", { session: "ceo", prompt: "Done.", write, mkdir });
  assert.equal(asked.decision, true);
  assert.equal(plain.decision, false, "the default is FYI, and it is written rather than left absent");
  assert.deepEqual(written.map((w) => JSON.parse(w).decision), [true, false],
    "and it is what reaches the file, not only what the function returns");
});

test("A DUPLICATE CANNOT DEMOTE A DECLARED DECISION, in either order, and the wait is still the first", () => {
  const fyi = { ...HANDOFF, decision: false, queuedAt: 1_000 };
  const asks = { ...HANDOFF, decision: true, queuedAt: 9_000 };
  const read = (...lines: object[]) =>
    readHandoffs("q", (() => lines.map((l) => JSON.stringify(l)).join("\n")) as never);
  for (const got of [read(fyi, asks), read(asks, fyi)]) {
    assert.equal(got.length, 1, "one order");
    assert.equal((got[0] as { decision?: boolean }).decision, true, "the declared ask survives");
  }
  assert.equal(read(fyi, asks)[0].queuedAt, 1_000, "an upgrade takes the flag, NOT the later clock");
  assert.equal(read(asks, fyi)[0].queuedAt, 9_000);
  // THE CONTROL: two FYI duplicates stay FYI, so the branch above is not simply "always true".
  assert.equal((read(fyi, { ...fyi, queuedAt: 2_000 })[0] as { decision?: boolean }).decision, false);
});

test("THE HEADER LISTS THE ORDERS THAT DECLARED, by the numbers their headings carry", () => {
  const now = 10 * 60 * 60 * 1000;
  const [batch] = handoffBatches(declared(27, [4, 9, 20], now), { now });
  const header = batch.prompt.split("--- ORDER 1 of 27")[0];

  assert.match(header, /DECISIONS DECLARED: 3 of 27 orders ask you for an answer -- ORDER 4, ORDER 9, ORDER 20/,
    "a count and the numbered list, ABOVE the orders");
  assert.ok(header.includes("Read those first"), "and what to do with it");
  assert.match(batch.prompt, /--- ORDER 9 of 27 \(DECISION\), queued/, "the number is the one on the heading");
  assert.match(batch.prompt, /--- ORDER 8 of 27, queued/, "an FYI heading carries no tag");
  // THE CLASSIFIER'S ERROR, PINNED: every order opens "Completion report", and only the declared ones
  // are listed. A header keyed on the opening line would list none, or all.
  assert.equal(batch.prompt.match(/\(DECISION\)/g)?.length, 3, "exactly the three declared headings are tagged");
});

test("A BUNDLE WITH NO DECLARED DECISION SAYS SO, AND SAYS WHAT THAT DOES NOT PROVE", () => {
  const now = 10 * 60 * 60 * 1000;
  const [batch] = handoffBatches(declared(5, [], now), { now });
  assert.match(batch.prompt, /DECISIONS DECLARED: none of these 5 orders/);
  assert.match(batch.prompt, /counted as FYI, so this is what was DECLARED, not proof that nothing here asks/,
    "silence is stated as a reading of declarations, never as 'nothing asks'");
  assert.match(batch.prompt, /`answer:` label/, "and points a row-attached ask at the label");
  assert.doesNotMatch(batch.prompt, /\(DECISION\)/);
});

test("THE LIST IS CAPPED, so a batch of all-decisions cannot spend the wrapper reserve", () => {
  const now = 10 * 60 * 60 * 1000;
  const all = decisionHeader(declared(200, Array.from({ length: 200 }, (_, i) => i + 1), now));
  assert.match(all, new RegExp(`200 of 200 orders ask you for an answer -- ORDER 1, ORDER 2,`));
  assert.ok(all.includes(`ORDER ${MAX_LISTED_DECISIONS}`) && !all.includes(`ORDER ${MAX_LISTED_DECISIONS + 1},`),
    "the list stops at the cap");
  assert.match(all, new RegExp(`and ${200 - MAX_LISTED_DECISIONS} more \\(each is tagged`),
    "and says how many it left out, and where to find them");
  assert.ok(Buffer.byteLength(all, "utf8") < 1_024, "so its size does not grow with the batch");
});

test("A BATCH OF ALL DECISIONS STILL RENDERS UNDER THE BUDGET, the tag and the header charged", () => {
  // The tag lengthens every heading and the header lengthens the wrapper. Both must be inside what
  // `fitBatch` charges, or a queue of asks -- the orders that must not stall -- is the one that E2BIGs.
  const now = 10 * 60 * 60 * 1000;
  const many = backlogOf("product-manager", 3_000, now, 0).map((h) => ({ ...h, prompt: "x", decision: true }));
  const [batch] = handoffBatches(many, { now });
  const argv = Buffer.byteLength(addressed(batch, "product-manager"), "utf8");
  assert.ok(batch.ids.length > 500, "the positive control: a large batch really was built");
  assert.ok(argv <= HANDOFF_BATCH_BYTES, `${argv} bytes rendered, inside the ${HANDOFF_BATCH_BYTES} budget`);
  assert.ok(argv < PROMPT_ARG_MAX);
});

test("ONE declared decision is still ONE order -- its wording is unchanged and nothing is bundled", () => {
  const [only] = handoffBatches([{ ...HANDOFF, decision: true }], { now: HANDOFF.queuedAt + 40 * 60_000 });
  assert.equal(only.causeKey, HANDOFF.id);
  assert.equal(only.prompt, handoffOrder(HANDOFF, HANDOFF.queuedAt + 40 * 60_000).prompt);
  assert.doesNotMatch(only.prompt, /DECISIONS DECLARED/, "a header is for a bundle, which a lone order is not");
});

test("THE BACKLOG COUNTS DECLARED DECISIONS PER TARGET, so the queue reads for what is owed", () => {
  const now = 10 * 60 * 60 * 1000;
  const [row] = handoffBacklog(declared(12, [2, 5, 7], now), now);
  assert.equal(row.waiting, 12);
  assert.equal(row.decisions, 3, "a floor on what is owed: undeclared orders are FYI");
  assert.match(backlogReport([row]).join(""), /12 authored order\(s\) waiting[^\n]*, 3 declared as asking for a decision/);
  // THE CONTROL: no declaration, no clause -- a reporter that always printed it would be noise.
  const [none] = handoffBacklog(backlogOf("product-manager", 4, now), now);
  assert.equal(none.decisions, 0);
  assert.doesNotMatch(backlogReport([none]).join(""), /declared as asking/);
});

test("pending is read off `delivered`, NOT off `id` -- a delivered decision is no longer owed", () => {
  // The ledger's ack lines key off `delivered`. Computing pending any other way overstated it badly
  // (182 queued / 172 acked / 10 truly pending), and a decision counted after delivery is owed to nobody.
  const asks = { ...HANDOFF, decision: true };
  const raw = [JSON.stringify(asks), JSON.stringify({ delivered: asks.id, at: 5 })].join("\n");
  assert.equal(handoffBacklog(readHandoffs("q", (() => raw) as never)).length, 0);
  const again = [raw, JSON.stringify({ ...asks, queuedAt: 7_000 })].join("\n");
  assert.equal(handoffBacklog(readHandoffs("q", (() => again) as never), 8_000)[0].decisions, 1,
    "and re-queued after delivery it is owed again");
});
