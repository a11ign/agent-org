// @ts-check
// THE CORE'S BEHAVIOUR, ONE DESIGN NUMBER AT A TIME (a11ign/a11ign#2900 done-whens 1-4), every one against an INJECTED clock, a real
// ledger file in a temp directory and the in-memory provider, so nothing here waits, reaches a network or reads a project checkout.
//
// POSITIVE CONTROLS, because "nothing was sent" is also what a core that never sends reports: each suppression below sits beside a
// case where the same event IS sent, and the first test of every group asserts the send happens at all.

import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";

import { composeDigest, composeText, createMessenger, planNotification, resolveConfig } from "./core.ts";
import { createFakeProvider } from "./fake-provider.ts";
import { createLedger, describeError, readLedgerLines, redact } from "./ledger.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const START = Date.parse("2026-10-02T09:00:00Z");

const scratch = mkdtempSync(join(tmpdir(), "messaging-core-"));
after(() => rmSync(scratch, { recursive: true, force: true }));
let nextLedger = 0;

/** A messenger on a clock the test owns. `restart()` is a NEW process over the SAME ledger file. */
function harness({ config, capabilities } = /** @type {{config?: any, capabilities?: any}} */ ({})) {
  let at = START;
  const clock = { now: () => at, advance: (/** @type {number} */ ms: number) => { at += ms; }, set: (/** @type {number} */ ms: number) => { at = ms; } };
  const path = join(scratch, `ledger-${nextLedger += 1}.jsonl`);
  const provider = createFakeProvider({ capabilities: { edit: false, pin: false, ...capabilities } });
  const build = () => createMessenger({ provider, ledger: createLedger({ path, now: clock.now }), now: clock.now, config });
  const lines = () => readLedgerLines(path);
  let messenger = build();
  return { clock, provider, lines, path, tick: (/** @type {unknown[]} */ events: unknown[]) => messenger.tick(events), restart() { messenger = build(); } };
}

/** @param {number} number @param {Record<string, unknown>} [more] */
function request(number: number, more: Record<string, unknown> = {}) {
  return { key: `request:a11ign/a11ign#${number}`, kind: "request", severity: "warning", firstSeenAt: START, text: `row ${number} needs the chairman`, links: [`https://example.test/${number}`], ...more };
}

/** @param {Record<string, unknown>} [more] */
function incident(more: Record<string, unknown> = {}) {
  return { key: "incident:trunk-red", kind: "incident", severity: "critical", firstSeenAt: START, text: "trunk is red", links: [], ...more };
}

describe("dedupe is by key, never by text (done-when 1)", () => {
  test("a key observed once IS sent: the positive control for every 'nothing was sent' below", async () => {
    const run = harness();
    const [decision] = await run.tick([request(1)]);
    assert.equal(decision.action, "sent");
    assert.equal(run.provider.sent.length, 1);
    assert.match(run.provider.sent[0].text, /row 1 needs the chairman/);
    assert.match(run.provider.sent[0].text, /https:\/\/example\.test\/1/, "the link rides with the text");
  });

  test("the same key observed on 100 ticks is sent ONCE", async () => {
    const run = harness();
    for (let tick = 0; tick < 100; tick += 1) {
      await run.tick([request(2)]);
      run.clock.advance(MINUTE);
    }
    assert.equal(run.provider.sent.length, 1);
    assert.equal(run.lines().length, 1, "100 observations are not 100 attempts: the 99 duplicates write no line");
  });

  test("a changed text under the same key is still the same fact", async () => {
    const run = harness();
    await run.tick([request(3, { text: "waiting 5 minutes" })]);
    run.clock.advance(MINUTE);
    await run.tick([request(3, { text: "waiting 6 minutes" })]);
    assert.equal(run.provider.sent.length, 1);
  });

  test("a different key is a different fact and is sent", async () => {
    const run = harness();
    await run.tick([request(4), request(5)]);
    assert.equal(run.provider.sent.length, 2);
  });

  test("it holds across a restart: the ledger is the memory, so a restarted watcher does not ask again", async () => {
    const run = harness();
    await run.tick([request(6)]);
    run.restart();
    run.clock.advance(MINUTE);
    await run.tick([request(6)]);
    assert.equal(run.provider.sent.length, 1);
  });
});

describe("an incident waits 30 minutes, unresolved (done-when 1)", () => {
  test("unresolved for 29 minutes is NOT sent, and at 30 IS", async () => {
    const run = harness();
    run.clock.set(START + 29 * MINUTE);
    const [held] = await run.tick([incident()]);
    assert.equal(held.action, "held");
    assert.equal(run.provider.sent.length, 0);
    assert.equal(run.lines().length, 0, "a held event is not an attempt");
    run.clock.set(START + 30 * MINUTE);
    const [sent] = await run.tick([incident()]);
    assert.equal(sent.action, "sent");
    assert.equal(run.provider.sent.length, 1);
  });

  test("one resolved at 20 minutes sends nothing at all, not even a 'cleared'", async () => {
    const run = harness();
    run.clock.set(START + 10 * MINUTE);
    await run.tick([incident()]);
    run.clock.set(START + 20 * MINUTE);
    const [decision] = await run.tick([incident({ resolved: true })]);
    assert.equal(decision.action, "resolved-before-sent");
    run.clock.set(START + 40 * MINUTE);
    await run.tick([incident({ resolved: true })]);
    assert.equal(run.provider.sent.length, 0);
    assert.equal(run.lines().length, 0);
  });

  test("one resolved AFTER it was sent produces ONE 'cleared', replying to the original, and then nothing more", async () => {
    const run = harness();
    run.clock.set(START + 30 * MINUTE);
    await run.tick([incident()]);
    run.clock.set(START + 50 * MINUTE);
    const [cleared] = await run.tick([incident({ resolved: true })]);
    assert.equal(cleared.action, "cleared");
    assert.equal(run.provider.sent.length, 2);
    assert.match(run.provider.sent[1].text, /^Cleared: trunk is red/);
    assert.equal(run.provider.sent[1].replyTo, run.provider.sent[0].messageRef);
    run.clock.set(START + 70 * MINUTE);
    await run.tick([incident({ resolved: true }), incident()]);
    assert.equal(run.provider.sent.length, 2, "the episode is over: neither the resolved nor a stale re-observation sends again");
  });

  test("a recurrence after it cleared is a NEW episode and is held down again", async () => {
    const run = harness();
    run.clock.set(START + 30 * MINUTE);
    await run.tick([incident()]);
    run.clock.set(START + 50 * MINUTE);
    await run.tick([incident({ resolved: true })]);
    const again = START + 3 * HOUR;
    run.clock.set(again + 10 * MINUTE);
    const [held] = await run.tick([incident({ firstSeenAt: again })]);
    assert.equal(held.action, "held");
    run.clock.set(again + 30 * MINUTE);
    const [sent] = await run.tick([incident({ firstSeenAt: again })]);
    assert.equal(sent.action, "sent");
  });

  test("the hold-down is config: a request has none and the incident's can be moved", async () => {
    const run = harness({ config: { kinds: { incident: { holdDownMs: 5 * MINUTE } } } });
    run.clock.set(START + 5 * MINUTE);
    assert.equal((await run.tick([incident()]))[0].action, "sent");
    assert.equal(resolveConfig().kinds.incident.holdDownMs, 30 * MINUTE, "the default is the design's 30 minutes");
    assert.equal(resolveConfig({ kinds: { incident: { holdDownMs: 1 } } }).kinds.request.remind, true, "overriding one kind keeps the others");
  });
});

describe("a request is reminded at 24, 48 and 72 hours, then never until its state changes (done-when 2)", () => {
  test("sent at once, reminded exactly three times, 24 hours apart", async () => {
    const run = harness();
    for (let hour = 0; hour <= 6 * 24; hour += 1) {
      run.clock.set(START + hour * HOUR);
      await run.tick([request(10)]);
    }
    const sent = run.provider.sent;
    assert.equal(sent.length, 4, "the original plus three reminders over six days, and not a fifth");
    assert.deepEqual(sent.map((message) => /^Reminder \d of 3|^row 10 needs the chairman/.exec(message.text)?.[0]),
      ["row 10 needs the chairman", "Reminder 1 of 3", "Reminder 2 of 3", "Reminder 3 of 3"]);
    assert.deepEqual(run.lines().map((line) => (Date.parse(line.ts) - START) / HOUR), [0, 24, 48, 72]);
  });

  test("not a minute early", async () => {
    const run = harness();
    await run.tick([request(11)]);
    run.clock.set(START + DAY - MINUTE);
    await run.tick([request(11)]);
    assert.equal(run.provider.sent.length, 1);
  });

  test("a changed state is sent at once, and re-arms the reminders", async () => {
    const run = harness();
    for (let hour = 0; hour <= 4 * 24; hour += 1) {
      run.clock.set(START + hour * HOUR);
      await run.tick([request(12, { state: "needs:chairman" })]);
    }
    assert.equal(run.provider.sent.length, 4);
    run.clock.set(START + 4 * DAY + HOUR);
    const [updated] = await run.tick([request(12, { state: "needs:chairman answer:ceo" })]);
    assert.equal(updated.action, "updated");
    assert.equal(run.provider.sent.length, 5);
    run.clock.set(START + 5 * DAY + HOUR);
    const [reminded] = await run.tick([request(12, { state: "needs:chairman answer:ceo" })]);
    assert.equal(reminded.action, "reminded");
    assert.match(run.provider.sent[5].text, /^Reminder 1 of 3/, "the count restarted");
  });

  test("a summary is never reminded, and is the only silent message", async () => {
    const run = harness();
    const summary = { key: "summary:2026-10-02", kind: "summary", severity: "info", firstSeenAt: START, text: "yesterday: 14 merged", links: [] };
    await run.tick([summary, request(13)]);
    for (let day = 1; day <= 4; day += 1) {
      run.clock.set(START + day * DAY);
      await run.tick([summary]);
    }
    const summaries = run.provider.sent.filter((message) => /yesterday/.test(message.text));
    assert.equal(summaries.length, 1);
    assert.equal(summaries[0].silent, true);
    const request13 = run.provider.sent.find((message) => /row 13/.test(message.text));
    assert.ok(request13, "the request was sent");
    assert.equal(request13.silent, false, "no quiet hours: everything else notifies");
  });
});

describe("thirteen events in an hour send 12 messages and ONE digest naming the 13th (done-when 3)", () => {
  test("twelve are sent, the thirteenth is held for the digest and not dropped", async () => {
    const run = harness();
    for (let number = 1; number <= 13; number += 1) {
      await run.tick([request(100 + number, { firstSeenAt: run.clock.now() })]);
      run.clock.advance(3 * MINUTE);
    }
    assert.equal(run.provider.sent.length, 12);
    const held = run.lines().filter((line) => line.status === "digested");
    assert.equal(held.length, 1);
    assert.equal(held[0].key, "request:a11ign/a11ign#113");
  });

  test("once the hour has room, ONE digest goes out and names the 13th; it is never sent twice", async () => {
    const run = harness();
    const events = [];
    for (let number = 1; number <= 13; number += 1) {
      events.push(request(100 + number, { firstSeenAt: run.clock.now() }));
      await run.tick(events);
      run.clock.advance(3 * MINUTE);
    }
    assert.equal(run.provider.sent.length, 12, "within the hour the digest has no room either");
    run.clock.set(START + HOUR);
    const decisions = await run.tick(events);
    assert.deepEqual(decisions.filter((decision) => decision.action.startsWith("digest")).map((decision) => decision.action), ["digest-sent"]);
    assert.equal(run.provider.sent.length, 13);
    const digest = run.provider.sent[12];
    assert.match(digest.text, /^1 notification held back by the hourly cap/);
    assert.match(digest.text, /row 113 needs the chairman/);
    assert.equal(digest.text.includes("row 112"), false, "it names only what was held");
    for (let later = 1; later <= 5; later += 1) {
      run.clock.advance(HOUR);
      await run.tick(events);
    }
    assert.equal(run.provider.sent.filter((message) => /held back/.test(message.text)).length, 1);
  });

  test("overflow of several events is still ONE digest line naming every one", async () => {
    const run = harness({ config: { rate: { hourlyCap: 2 } } });
    const events = [1, 2, 3, 4, 5].map((number) => request(200 + number));
    for (const event of events) {
      await run.tick([event]);
      run.clock.advance(5 * MINUTE);
    }
    assert.equal(run.provider.sent.length, 2);
    run.clock.set(START + HOUR + MINUTE);
    await run.tick([]);
    const digests = run.provider.sent.filter((message) => /held back/.test(message.text));
    assert.equal(digests.length, 1);
    for (const number of [3, 4, 5]) assert.match(digests[0].text, new RegExp(`row 20${number} needs`));
  });

  test("the hourly allowance survives a restart: it is what the ledger says went out", async () => {
    const run = harness({ config: { rate: { hourlyCap: 2 } } });
    await run.tick([request(301)]);
    run.restart();
    run.clock.advance(MINUTE);
    await run.tick([request(302)]);
    run.restart();
    run.clock.advance(MINUTE);
    const [decision] = await run.tick([request(303)]);
    assert.equal(decision.action, "digested");
    assert.equal(run.provider.sent.length, 2);
  });

  test("a resolution before the digest goes out withdraws the entry, so the digest does not name what has cleared", async () => {
    const run = harness({ config: { rate: { hourlyCap: 1 } } });
    await run.tick([request(401)]);
    run.clock.advance(MINUTE);
    await run.tick([request(402), request(403)]);
    run.clock.advance(MINUTE);
    const [withdrawn] = await run.tick([request(402, { resolved: true })]);
    assert.equal(withdrawn.action, "withdrawn");
    run.clock.set(START + HOUR + MINUTE);
    await run.tick([]);
    const digest = run.provider.sent.find((message) => /held back/.test(message.text));
    assert.ok(digest, "the held-back digest was sent");
    assert.match(digest.text, /row 403/);
    assert.equal(digest.text.includes("row 402"), false);
  });

  test("the token bucket defers a burst instead of dropping it, and the next tick sends the rest", async () => {
    const run = harness();
    const burst = [1, 2, 3, 4, 5].map((number) => request(500 + number));
    const first = await run.tick(burst);
    assert.deepEqual(first.map((decision) => decision.action), ["sent", "sent", "sent", "deferred", "deferred"]);
    run.clock.advance(2000);
    const second = await run.tick(burst);
    assert.deepEqual(second.map((decision) => decision.action), ["duplicate", "duplicate", "duplicate", "sent", "sent"]);
    assert.equal(run.provider.sent.length, 5);
  });
});

describe("every attempt is one ledger line (done-when 4)", () => {
  test("sent, deferred, digested and failed each write exactly one, with every design field present", async () => {
    const run = harness({ config: { rate: { burst: 2, hourlyCap: 3 } } });
    run.provider.failNext(new Error("boom"));
    await run.tick([request(601), request(602), request(603)]); // failed, sent, deferred
    run.clock.advance(5 * MINUTE);
    await run.tick([request(601), request(603)]); // sent, sent: three delivered in the hour, which is the cap
    run.clock.advance(MINUTE);
    await run.tick([request(604)]); // over the hourly cap: digested
    const lines = run.lines();
    assert.deepEqual(lines.map((line) => line.status), ["failed", "sent", "deferred", "sent", "sent", "digested"]);
    for (const line of lines) {
      for (const field of ["ts", "key", "provider", "status", "providerMessageId", "error"]) assert.ok(field in line, `${field} is on every line`);
      assert.equal(line.provider, "fake");
    }
    assert.equal(lines[1].providerMessageId, "fake-1", "a sent line carries the provider's messageRef");
    assert.equal(lines[0].providerMessageId, null);
  });

  test("a failed send is retried on the next tick, because it never counted as sent", async () => {
    const run = harness();
    run.provider.failNext(new Error("network down"));
    assert.equal((await run.tick([request(701)]))[0].action, "failed");
    run.clock.advance(MINUTE);
    assert.equal((await run.tick([request(701)]))[0].action, "sent");
    assert.equal(run.provider.sent.length, 1);
  });

  test("a provider that returns no messageRef is a failure the core records, not a send", async () => {
    const run = harness();
    // deliberately breaks the port's contract (no `messageRef`): the point of the test is that the core notices
    run.provider.send = /** @type {any} */ (async () => ({ silent: false }));
    const [decision] = await run.tick([request(702)]);
    assert.equal(decision.action, "failed");
    assert.match(run.lines()[0].error, /no messageRef/);
  });

  test("a redacted error carries no token-shaped string, even through a cause chain", async () => {
    const run = harness();
    const token = `${"123456789"}:${"AAH".concat("x".repeat(32))}`;
    const cause = new Error(`getaddrinfo ENOTFOUND while fetching https://api.example.test/bot${token}/sendMessage`);
    run.provider.failNext(new Error("fetch failed", { cause }));
    await run.tick([request(801)]);
    const [line] = run.lines();
    assert.equal(line.status, "failed");
    assert.ok(line.error.length > 0 && /fetch failed/.test(line.error), "the error is recorded, only its secret is not");
    assert.equal(line.error.includes(token), false);
    assert.equal(/\d{6,}:[A-Za-z0-9_-]{20,}/.test(line.error), false);
    assert.match(line.error, /bot<redacted>/);
    assert.equal(readFileSync(run.path, "utf8").includes(token), false, "nor anywhere else in the file");
  });

  test("describeError redacts on its own, so the boundary in `append` is a second layer and not the only one", () => {
    const token = `${"555555555"}:${"Z".repeat(35)}`;
    const described = describeError(new Error("fetch failed", { cause: new Error(`GET /bot${token}/getUpdates`) }));
    assert.equal(described.includes(token), false);
    assert.match(described, /fetch failed <- Error: GET \/bot<redacted>\/getUpdates/, "the chain survives, only the secret goes");
  });

  test("the ledger redacts at its own boundary, so a caller that forgot is still covered", () => {
    const ledger = createLedger({ path: join(scratch, "boundary.jsonl"), now: () => START });
    const line = ledger.append({ key: "k", status: "failed", error: `Bearer ${"a".repeat(30)}` });
    assert.equal(/a{30}/.test(line.error), false);
    assert.equal(/a{30}/.test(readFileSync(ledger.path, "utf8")), false);
  });

  test("redact removes each token shape and leaves ordinary text alone (positive control for the check above)", () => {
    const shapes = {
      telegram: `${"987654321"}:${"A".repeat(35)}`,
      "telegram url": `/bot${"987654321"}:${"B".repeat(35)}/getUpdates`,
      github: `ghp_${"c".repeat(36)}`,
      "github fine-grained": `github_pat_${"d".repeat(40)}`,
      slack: `xoxb-${"1".repeat(12)}-${"e".repeat(12)}`,
      jwt: `eyJ${"f".repeat(12)}.${"g".repeat(12)}.${"h".repeat(12)}`,
      assignment: `password=${"hunter22"}`,
      "long opaque": "k".repeat(40),
    };
    for (const [name, secret] of Object.entries(shapes)) {
      const out = redact(`call failed: ${secret} (retry)`);
      assert.equal(out.includes(secret.replace(/^password=/, "").replace(/^\/bot/, "")), false, `${name} survived: ${out}`);
    }
    assert.equal(redact("ECONNRESET talking to api.example.test"), "ECONNRESET talking to api.example.test");
  });

  test("a malformed event is recorded and does not stop the well-formed ones behind it", async () => {
    const run = harness();
    const decisions = await run.tick([{ key: "request:bad", kind: "nonsense" }, request(901)]);
    assert.deepEqual(decisions.map((decision) => decision.action), ["invalid", "sent"]);
    assert.equal(run.lines()[0].status, "invalid");
    assert.match(run.lines()[0].error, /event\.kind/);
  });
});

describe("a ledger the core cannot read", () => {
  test("a line that is not JSON stops the core and names the line, rather than being skipped (a skipped line could send twice)", async () => {
    const run = harness();
    await run.tick([request(1001)]);
    appendFileSync(run.path, "{not json\n");
    assert.throws(() => run.restart(), /line 2 is not JSON/);
  });

  test("a ledger that does not exist yet is an empty history, not an error", () => {
    assert.deepEqual(readLedgerLines(join(scratch, "never-written.jsonl")), []);
  });
});

describe("the planner and the composers", () => {
  const config = resolveConfig();
  const event = { key: "k", kind: "request", severity: "info", firstSeenAt: START, text: "t", links: [], resolved: false, state: "", actions: [] };

  test("planNotification is pure: the same inputs give the same plan and touch nothing", () => {
    const first = planNotification(event, undefined, START, config);
    assert.deepEqual(first, { action: "send", kind: "first", audience: "ask" }, "a request is an ask (a11ign/a11ign#4742)");
    assert.deepEqual(planNotification(event, undefined, START, config), first);
  });

  test("an over-long text is cut to maxText but the links are kept whole", () => {
    const withLink = { ...event, text: "w".repeat(500), links: ["https://example.test/keep-me"] };
    const text = composeText(withLink, { action: "send", kind: "first" }, 100, 3);
    assert.equal(text.length, 100);
    assert.ok(text.endsWith("\nhttps://example.test/keep-me"));
    assert.ok(text.includes("…"));
  });

  test("a brief cut to maxText keeps its opening line and its link whole and LAST, for every kind of send (a11ign/a11ign#3412 (5))", () => {
    const link = "https://github.com/a11ign/a11ign/issues/3229";
    const lines = ["What is happening: worker 4 is off", ...["Ask", "Only you because", "Checked", "How long", "Unblocks"].map((label) => `${label}: ${"w".repeat(80)}`)];
    const brief = { ...event, text: lines.join("\n"), links: [link] };
    const whole = composeText(brief, { action: "send", kind: "first" }, 10_000, 3);
    assert.equal(whole, `${lines.join("\n")}\n${link}`, "POSITIVE CONTROL: with room, the text is the brief then the link, unchanged");
    for (const plan of [{ action: "send", kind: "first" }, { action: "send", kind: "update" }, { action: "send", kind: "reminder", reminder: 2 }]) {
      const cut = composeText(brief, /** @type {any} */ (plan), 200, 3);
      assert.ok(cut.length <= 200, `${plan.kind}: ${cut.length} characters`);
      assert.equal(cut.split("\n").at(-1), link, `${plan.kind}: the link is the last line, whole`);
      assert.ok(cut.includes("…"), `${plan.kind}: the text is what gave way`);
    }
    assert.ok(composeText(brief, { action: "send", kind: "first" }, 200, 3).startsWith("What is happening: worker 4 is off\n"));
  });

  test("the ledger holds the text AS SENT, link included, so a reading of it needs nothing rebuilt", async () => {
    const run = harness();
    await run.tick([request(801)]);
    assert.equal(run.lines()[0].text, run.provider.sent[0].text);
    assert.ok(run.lines()[0].text.endsWith("\nhttps://example.test/801"));
  });

  test("the digest says how many it could not fit, and never exceeds maxText", () => {
    const entries = Array.from({ length: 30 }, (_, index) => ({ key: `k${index}`, kind: "first", text: `event number ${index} with some words` }));
    const text = composeDigest(entries, 300);
    assert.ok(text.length <= 300);
    assert.match(text, /and \d+ more \(see the delivery log\)$/);
    assert.match(text, /^30 notifications held back/);
  });
});

describe("an event's actions reach a provider that draws buttons (a11ign/a11ign#3423)", () => {
  const actions = [{ label: "A: publish now", data: "ans:A" }, { label: "Later", data: "act:later" }];

  test("a first message, an update and a reminder carry them; the control is an event with none, whose message has no `actions` key at all", async () => {
    const run = harness({ config: { reminders: { max: 3, spacingMs: HOUR } } });
    await run.tick([request(901, { actions, state: "one" })]);
    await run.tick([request(901, { actions, state: "two" })]);
    run.clock.advance(DAY);
    await run.tick([request(901, { actions, state: "two" })]);
    assert.deepEqual(run.lines().map((line) => line.kind), ["first", "update", "reminder"], "the three kinds of send ran");
    for (const sent of run.provider.sent) assert.deepEqual(sent.actions, actions);
    await run.tick([incident()]);
    assert.equal("actions" in (run.provider.sent.at(-1) ?? {}) && run.provider.sent.at(-1)?.actions !== undefined, false);
  });

  test("a cleared notice carries none, whatever the event holds: it would answer a request that is gone", async () => {
    const run = harness();
    await run.tick([request(902, { actions })]);
    await run.tick([request(902, { actions, resolved: true })]);
    const cleared = run.provider.sent.at(-1);
    assert.match(cleared?.text ?? "", /^Cleared: /);
    assert.equal(cleared?.actions, undefined);
  });

  test("a provider that declares no buttons is handed none, and the message is still sent", async () => {
    const run = harness({ capabilities: { buttons: false } });
    await run.tick([request(903, { actions })]);
    assert.equal(run.provider.sent.length, 1);
    assert.equal(run.provider.sent[0].actions, undefined);
  });

  test("an event whose actions are not {label, data} strings is invalid, loudly, and the others behind it still go", async () => {
    const run = harness();
    const decisions = await run.tick([request(904, { actions: [{ label: "x" }] }), request(905)]);
    assert.deepEqual(decisions.map((decision) => decision.action), ["invalid", "sent"]);
  });
});
