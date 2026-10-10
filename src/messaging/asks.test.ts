// @ts-check
// THE ASKS' RECORD, TICK AND LIST, AGAINST THE REAL CORE (a11ign/a11ign#4745, row 3 of 5 of #928). Every claim is read off what the in-memory
// provider RECEIVED (`sent`, `edits`, `pinned`) and off the ledger file, because "the message was ticked and nothing was sent" is a property
// of the core and the provider together, and a test of the pure fold alone would pass while the core sent a second message.
//
// POSITIVE CONTROLS: each "nothing was sent" sits beside the case where the same row IS sent, and the resolve test has a CONTROL that goes red
// when the edit is replaced by a send (the last describe), which is how the test is known to be able to fail.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";

import { TICK, firstLineOf, foldAsks, listFingerprint, openAsks, renderList, rowOf, tickedText } from "./asks.ts";
import { DEFAULT_CONFIG, createMessenger } from "./core.ts";
import { createFakeProvider } from "./fake-provider.ts";
import { ASKS_LIST_KIND, createLedger, deliveredTimestamps, foldLedger, readLedgerLines } from "./ledger.ts";
import { observeRequests, parseRequestKey, requestKey } from "./sources/requests.ts";

const REPO = "a11ign/a11ign";
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const START = Date.parse("2026-10-10T09:00:00Z");
const NO_OPEN_ASKS = "No open asks.";

const scratch = mkdtempSync(join(tmpdir(), "messaging-asks-"));
after(() => rmSync(scratch, { recursive: true, force: true }));
let nextLedger = 0;

const audienceOf = (/** @type {string} */ key: string) => (DEFAULT_CONFIG.kinds as Record<string, { audience?: string }>)[key.split(":")[0]]?.audience;

/** The required lines of a brief (`sources/requests.ts`): without them the source emits no event, and a row with no event is not what this file is about. */
const BRIEF_LINES = [
  "What is happening: worker 4 is switched off and a capture is waiting on it",
  "Ask: switch worker 4 on",
  "Only you because: the switch is behind your account",
  "Checked: 20:03Z, gh api repos/x/y printed false",
  "How long: two minutes",
  "Unblocks: the 20:30 capture",
  "Not the chairman's Claude session because: the switch is a button on a box in his house",
].join("\n");

/** A labelled row, as the request source reads it, whose newest comment is a complete brief. */
function labelled(number: number) {
  const body = `**ceo — BRIEF for the chairman: decide row ${number}.**\n${BRIEF_LINES}`;
  return {
    number, title: `Row ${number} needs a decision`, url: `https://github.com/${REPO}/issues/${number}`,
    comments: [{ body, createdAt: "2026-10-09T18:00:00Z", authorAssociation: "MEMBER" }],
  };
}

/**
 * A world: a clock, a ledger file, a provider and a `tick(numbers)` that does what the watcher does for requests, so "removing the label" is
 * the row's number leaving the list and nothing else. `restart()` is a new process over the same ledger; `capabilities` may be changed between.
 */
function world({ capabilities = {} }: { capabilities?: Record<string, unknown>; } = {}) {
  let at = START;
  const path = join(scratch, `ledger-${nextLedger += 1}.jsonl`);
  const provider = createFakeProvider({ capabilities });
  const ledger = () => createLedger({ path, now: () => at });
  let messenger = createMessenger({ provider, ledger: ledger(), now: () => at });
  return {
    provider,
    path,
    lines: () => readLedgerLines(path),
    advance: (/** @type {number} */ ms: number) => { at += ms; },
    restart() { messenger = createMessenger({ provider, ledger: ledger(), now: () => at }); },
    /** The rows that carry `needs:chairman` this tick, by number; what the ledger holds open and the list lacks is resolved by the source. */
    async tick(numbers: number[]) {
      const openKeys = [...foldLedger(ledger().read())].filter(([key, record]) => record.open && parseRequestKey(key)).map(([key]) => key);
      const observed = observeRequests({ repo: REPO, rows: numbers.map(labelled), openKeys, now: at });
      return messenger.tick(observed.events);
    },
    /** Events the source does not produce (a stall, a row-less request): straight to the core. */
    tickEvents: (/** @type {unknown[]} */ events: unknown[]) => messenger.tick(events),
    asks: () => foldAsks(readLedgerLines(path), audienceOf),
  };
}

type World = ReturnType<typeof world>;
const listLines = (run: World) => run.lines().filter((line) => line.kind === ASKS_LIST_KIND);

describe("an ask keeps a record, written when it is first sent, keyed by its row", () => {
  test("a new ask writes ONE message and ONE record: {askId, messageRef, row, state, outcome}", async () => {
    const run = world();
    const [decision] = await run.tick([7]);
    assert.equal(decision.action, "sent", "the positive control: the ask went");
    const [first] = run.provider.sent;
    assert.equal(first.messageRef, "fake-1");
    assert.match(first.text, /^What is happening: worker 4 is switched off/);
    const asks = [...run.asks().asks.values()];
    assert.equal(asks.length, 1, "one record");
    assert.deepEqual(
      { askId: asks[0].askId, messageRef: asks[0].messages[0].ref, row: asks[0].row, state: asks[0].state, outcome: asks[0].outcome },
      { askId: `${requestKey(REPO, 7)}:1`, messageRef: "fake-1", row: `${REPO}#7`, state: "open", outcome: null },
    );
    const askLine = run.lines().find((line) => line.key === requestKey(REPO, 7));
    assert.equal(askLine?.askId, `${requestKey(REPO, 7)}:1`, "the record is on the line the core wrote, not a second file");
    assert.equal(askLine?.row, `${REPO}#7`);
  });

  test("the record is rebuilt from the ledger by a NEW process, and the same tick is not a second ask", async () => {
    const run = world();
    await run.tick([7]);
    run.restart();
    const decisions = await run.tick([7]);
    assert.deepEqual(decisions.map((decision) => decision.action), ["listed"], "a kept ask's reminder is the list, so the plan says so");
    assert.equal(run.provider.sent.filter((message) => !message.text.startsWith("Open asks")).length, 1);
    assert.equal(openAsks(run.asks()).length, 1);
  });

  test("an ask with no row is REFUSED at send, naming why; a kind that declares it has none (a stall) is not", async () => {
    const run = world();
    const rowless = { key: "request:no-row-here", kind: "request", severity: "warning", firstSeenAt: START, text: "a decision nobody can tick", links: [] };
    const [refused] = await run.tickEvents([rowless]);
    assert.equal(refused.action, "invalid");
    assert.deepEqual(run.provider.sent, [], "nothing reached the chat, and no list for an ask that does not exist");
    assert.match(run.lines()[0].error, /^ask not sent: key "request:no-row-here" names no row/);

    const stall = { key: "stall:all-idle", kind: "stall", severity: "critical", firstSeenAt: START, text: "every seat is idle", links: [] };
    const [passed] = await run.tickEvents([stall]);
    assert.equal(passed.action, "sent", "the positive control: a kind with a declared reason passes");
    const stallAsk = run.asks().asks.get("stall:all-idle");
    assert.equal(stallAsk?.row, null);
    assert.match(String(stallAsk?.rowLess), /belongs to no one row/);
  });

  test("rowOf agrees with the key the request source writes, for every shape it parses (the leaf may not import it)", () => {
    for (const [repo, number] of [["a11ign/a11ign", 4745], ["a11ign/agent-org", 1], ["x/y-z.w", 99999]] as [string, number][]) {
      assert.equal(rowOf(requestKey(repo, number)), `${repo}#${number}`);
      assert.deepEqual(parseRequestKey(requestKey(repo, number)), { repo, number });
    }
    assert.equal(rowOf("stall:all-idle"), null);
    assert.equal(rowOf("incident:trunk-red"), null);
  });

  test("a ledger from BEFORE this row (no askId, no row) folds: the episode is counted and the row derived from the key", () => {
    const key = requestKey(REPO, 12);
    const legacy = [
      { ts: "2026-10-01T09:00:00.000Z", key, status: "sent", kind: "first", providerMessageId: "old-1", text: "row 12 needs the chairman\nhttps://x", audience: "ask" },
      { ts: "2026-10-02T09:00:00.000Z", key, status: "sent", kind: "reminder", providerMessageId: "old-2", text: "Reminder 1 of 3: row 12 needs the chairman" },
    ];
    const [ask] = [...foldAsks(legacy, audienceOf).asks.values()];
    assert.deepEqual({ askId: ask.askId, row: ask.row, state: ask.state }, { askId: `${key}:1`, row: `${REPO}#12`, state: "open" });
    assert.equal(ask.messages[0].ref, "old-1");
    assert.equal(ask.messages[0].firstLine, "row 12 needs the chairman", "the first line is the original's, not the reminder's");
  });
});

describe("the message is ticked in place when the row's state changes, and nothing is sent", () => {
  test("removing needs:chairman resolves the ask on the NEXT tick: the original is edited to ✅ outcome — first line, no second message", async () => {
    const run = world();
    await run.tick([3]);
    const original = run.provider.sent[0].text;
    const sentBefore = run.provider.sent.length;
    assert.equal(run.provider.edits.filter((edit) => edit.messageRef === "fake-1").length, 0, "the positive control: an untouched ask has no edit");

    const [cleared] = await run.tick([]);
    assert.equal(cleared.action, "cleared");
    assert.equal(run.provider.sent.length, sentBefore, "no second message");
    const [tick] = run.provider.edits.filter((edit) => edit.messageRef === "fake-1");
    assert.equal(tick.from, original);
    assert.equal(tick.to, `${TICK} ${REPO}#3 no longer needs you — ${firstLineOf(original)}`);
    const [ask] = [...run.asks().asks.values()];
    assert.equal(ask.state, "resolved");
    assert.equal(ask.outcome, `${REPO}#3 no longer needs you`);
  });

  test("it is still open while the label stays, across many ticks and a restart: no edit, no send", async () => {
    const run = world();
    await run.tick([3]);
    for (let tick = 0; tick < 5; tick += 1) {
      run.advance(HOUR);
      run.restart();
      await run.tick([3]);
    }
    assert.deepEqual(run.provider.edits, []);
    assert.equal(openAsks(run.asks()).length, 1);
  });

  test("the tick line is `sent` + `edited`, so what reads 'this key was cleared' still does, and the hourly cap does not count it", async () => {
    const run = world();
    await run.tick([3]);
    await run.tick([]);
    const key = requestKey(REPO, 3);
    assert.equal(foldLedger(run.lines()).get(key)?.open, false, "the ledger's own reading of the key is: cleared");
    const tickLine = run.lines().find((line) => line.key === key && line.kind === "cleared");
    assert.equal(tickLine?.status, "sent");
    assert.equal(tickLine?.edited, true);
    assert.equal(tickLine?.outcome, `${REPO}#3 no longer needs you`);
    const sentLines = run.lines().filter((line) => line.status === "sent" && line.edited !== true);
    assert.equal(deliveredTimestamps(run.lines()).length, sentLines.length, "an edit is not a delivery");
  });

  test("a re-labelled row is a NEW ask: the old message stays ticked and the new one is a new message with a new askId", async () => {
    const run = world();
    await run.tick([5]);
    await run.tick([]);
    run.advance(HOUR);
    await run.tick([5]);
    await run.tick([]);
    run.advance(HOUR);
    await run.tick([5]);
    const key = requestKey(REPO, 5);
    const asked = run.provider.sent.filter((message) => !message.text.startsWith("Open asks") && message.text !== NO_OPEN_ASKS);
    assert.equal(asked.length, 3, "three messages for the row: one per time it was labelled");
    assert.ok(asked[0].text.startsWith(TICK) && asked[1].text.startsWith(TICK), "the earlier two stay ticked");
    assert.ok(!asked[2].text.startsWith(TICK), "the newest is open and unticked");
    const ask = run.asks().asks.get(key);
    assert.equal(ask?.askId, `${key}:3`, "a third episode, so a count that restarted at the second would show");
    assert.equal(ask?.state, "open");
    assert.equal(ask?.messages[0].ref, asked[2].messageRef);
  });

  test("an ask sent BEFORE this row (by a provider that could not edit) is ticked once the provider can", async () => {
    const run = world({ capabilities: { edit: false, pin: false } });
    await run.tick([8]);
    assert.equal(run.provider.sent.length, 1, "the legacy lifecycle: one message, no list");
    Object.assign(run.provider.capabilities, { edit: true, pin: true });
    run.restart();
    await run.tick([]);
    assert.ok(run.provider.sent[0].text.startsWith(`${TICK} `), "the old message was edited");
    assert.equal(run.provider.sent.length, 1, "…and nothing else is sent: no list is made for a chat whose asks are all resolved");
  });
});

describe("the pinned list is rewritten only when the SET changes, pinned once, and says so when empty", () => {
  test("it is created with the first ask, pinned, and lists its row number, first line and age", async () => {
    const run = world();
    await run.tick([4]);
    const list = run.provider.sent[1];
    assert.equal(list.silent, true, "bookkeeping does not ring");
    assert.match(list.text, /^Open asks \(1\), as of 2026-10-10 09:00Z:\n• #4 .+ \(0m\)$/);
    assert.deepEqual(run.provider.pinned, [list.messageRef]);
  });

  test("the same set on 20 ticks over a day is NO edit and no second pin: the positive control is the tick that adds a row", async () => {
    const run = world();
    await run.tick([4]);
    const editsAfterFirst = run.provider.edits.length;
    for (let tick = 0; tick < 20; tick += 1) {
      run.advance(HOUR);
      await run.tick([4]);
    }
    assert.equal(run.provider.edits.length, editsAfterFirst, "the age moving is not a change of the set");
    assert.equal(listLines(run).filter((line) => line.status === "pinned").length, 1);

    await run.tick([4, 6]);
    const [edit] = run.provider.edits.slice(editsAfterFirst);
    assert.match(edit.to, /^Open asks \(2\)/);
    assert.match(edit.to, /• #4 .+ \(\d+h\)\n• #6 /, "the older ask first, with its age");
    assert.equal(listLines(run).filter((line) => line.status === "pinned").length, 1, "an edit does not re-pin: the ref did not change");
  });

  test("when the last ask resolves the list says so in one line; and no list is ever made for a chat that never had an ask", async () => {
    const quiet = world();
    await quiet.tick([]);
    assert.deepEqual(quiet.provider.sent, [], "nothing to say, nothing sent");

    const run = world();
    await run.tick([4]);
    await run.tick([]);
    const list = run.provider.sent[1];
    assert.equal(list.text, NO_OPEN_ASKS);
    assert.equal(renderList({ open: [], nowMs: START, maxText: 4096 }), NO_OPEN_ASKS);
  });

  test("a list whose message is gone is sent fresh and the NEW ref is pinned (re-pinned only because its ref changed)", async () => {
    const run = world();
    await run.tick([4]);
    const goneRef = run.provider.sent[1].messageRef;
    const realEdit = run.provider.edit;
    run.provider.edit = async (message: { messageRef: string; text: string; audience?: string }) => {
      if (message.messageRef === goneRef) throw new Error("message to edit not found");
      return realEdit(message);
    };
    await run.tick([4, 6]);
    const refs = run.provider.sent.map((message) => message.messageRef);
    assert.equal(refs.length, 4, "the first ask, its list, the second ask, and the fresh list");
    assert.deepEqual(run.provider.pinned, [goneRef, refs[3]]);
    assert.ok(listLines(run).some((line) => line.status === "failed"), "the failed edit is on a line, not swallowed");
  });

  test("the fingerprint is the set and the first lines, and not the age", () => {
    const base = { askId: "a:1", key: "a", row: "r#1", rowLess: null, state: "open" as const, outcome: null, messages: [{ ref: "m", firstLine: "one" }], openedAt: 0 };
    assert.equal(listFingerprint([base]), listFingerprint([{ ...base, openedAt: 99 * HOUR }]));
    assert.notEqual(listFingerprint([base]), listFingerprint([{ ...base, messages: [{ ref: "m", firstLine: "two" }] }]));
    assert.notEqual(listFingerprint([base]), listFingerprint([]));
  });

  test("tickedText keeps the tick and the outcome when the room is short, and cuts the first line", () => {
    const text = tickedText({ outcome: "done", firstLine: "x".repeat(200), maxText: 40 });
    assert.equal(text.length, 40);
    assert.ok(text.startsWith(`${TICK} done — x`));
    assert.ok(text.endsWith("…"));
  });
});

describe("the old lifecycle's reminders stop for asks that are kept, and only for those", () => {
  async function remindedOver(run: World) {
    for (let hour = 0; hour <= 6 * 24; hour += 1) {
      await run.tick([9]);
      run.advance(HOUR);
    }
    return run.lines().filter((line) => line.kind === "reminder").length;
  }

  test("a provider that can edit and pin sends NO reminder message; one that cannot still sends the three (the positive control)", async () => {
    assert.equal(await remindedOver(world({ capabilities: { edit: false, pin: false } })), 3, "the legacy lifecycle is unchanged");
    const kept = world();
    assert.equal(await remindedOver(kept), 0);
    assert.equal(kept.provider.sent.filter((message) => message.text.startsWith("Reminder")).length, 0);
  });

  test("an announcement is still reminded as before: the change is the ask's alone", async () => {
    const run = world();
    const release = { key: "release:v1", kind: "release", severity: "info", firstSeenAt: START, text: "v1 is out", links: [] };
    await run.tickEvents([release]);
    assert.equal(run.lines().filter((line) => line.key === "release:v1").length, 1);
    assert.equal(openAsks(run.asks()).length, 0, "an announcement is never an ask, so never listed");
    assert.deepEqual(run.provider.sent.map((message) => message.audience), ["announcement"], "and it makes no list");
  });
});

describe("an edit that fails does not leave a resolved ask unticked AND unannounced", () => {
  test("the failure is a line, and the old 'Cleared:' message is the answer, once", async () => {
    const run = world();
    await run.tick([2]);
    const realEdit = run.provider.edit;
    run.provider.edit = async (message: { messageRef: string; text: string; audience?: string }) => {
      if (message.messageRef === "fake-1") throw new Error("message can't be edited");
      return realEdit(message);
    };
    const [decision] = await run.tick([]);
    assert.equal(decision.action, "cleared");
    const key = requestKey(REPO, 2);
    assert.ok(run.lines().some((line) => line.key === key && line.status === "failed" && /can't be edited/.test(line.error)));
    const cleared = run.provider.sent.filter((message) => message.text.startsWith("Cleared: "));
    assert.equal(cleared.length, 1);
    await run.tick([]);
    assert.equal(run.provider.sent.filter((message) => message.text.startsWith("Cleared: ")).length, 1, "and not once per tick");
  });
});

describe("CONTROL: the resolve assertion goes red when the edit is replaced by a send", () => {
  /** What the resolve test above claims, as a function of a world that has an open ask and has been ticked once more with the label gone. */
  async function resolveClaims(run: World) {
    await run.tick([3]);
    const sentBefore = run.provider.sent.length;
    await run.tick([]);
    assert.equal(run.provider.sent.length, sentBefore, "no second message");
    assert.ok(run.provider.sent[0].text.startsWith(TICK), "the original reads ticked");
  }

  test("the honest provider satisfies it", async () => {
    await resolveClaims(world());
  });

  test("a provider whose edit SENDS a new message instead does not", async () => {
    const run = world();
    run.provider.edit = async ({ text }: { messageRef: string; text: string }) => ({ messageRef: (await run.provider.send({ text })).messageRef, unchanged: false });
    await assert.rejects(resolveClaims(run), /no second message/);
  });
});
