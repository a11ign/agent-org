// @ts-check
// CONVERSATION OUT (a11ign/a11ign#2910 done-whens 1-5): a reply is sent only as checked facts. Placeholders are re-read at send time and the message ends
// with the as-of stamp; a reader that throws refuses the send and names the placeholder, in a refusal that is itself sendable; a `#<number>`, a state word
// or a count outside a placeholder is refused; text after `My read:` is exempt and the same text without the marker is not; the ledger line holds the
// values it was rendered with.
//
// **THE POSITIVE CONTROLS ARE THE POINT OF THE SHAPE.** Every "refused" case asserts the provider's `sent` is still empty, and the cases that expect a
// send assert it holds exactly what was said: a checker that refuses everything fails the second kind, and one that allows everything fails the first.
// The rules table at the end runs both sides of every pattern, so a pattern broken either way fails by name.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";

import { createFakeProvider } from "./fake-provider.mjs";
import { createLedger, deliveredTimestamps, foldLedger, readLedgerLines } from "./ledger.mjs";
import { MASK, QUOTE_LIMIT, createGhReaders, describeAge, parsePlaceholders } from "./placeholders.mjs";
import { createReply, prepareReply } from "./reply.mjs";

const NOW = Date.parse("2026-10-02T14:05:30Z");
const STAMP = "as of 14:05Z";
const REPO = "a11ign/a11ign";
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const scratch = mkdtempSync(join(tmpdir(), "messaging-reply-"));
after(() => rmSync(scratch, { recursive: true, force: true }));
let nextLedger = 0;

/**
 * Fixture readers that count their calls. `overrides` replace a reader whole, so a case can make one throw or return nothing.
 * @param {Partial<import("./placeholders.mjs").Readers>} [overrides]
 */
function fixtureReaders(overrides = {}) {
  /** @type {Record<string, number>} */
  const calls = {};
  const counted = (/** @type {string} */ name, /** @type {Function} */ read) => async (/** @type {any[]} */ ...args) => {
    calls[name] = (calls[name] ?? 0) + 1;
    return read(...args);
  };
  /** @type {import("./placeholders.mjs").Readers} */
  const readers = {
    issue: counted("issue", async (/** @type {number} */ number) => ({ number, state: "open", labels: ["ready", "lane:any", "in-progress"] })),
    pr: counted("pr", async (/** @type {number} */ number) => ({ number, state: "merged", review: "APPROVED" })),
    run: counted("run", async () => ({ conclusion: "failure" })),
    ready: counted("ready", async () => ({ count: 7 })),
    lastMerge: counted("lastMerge", async () => ({ at: NOW - (3 * HOUR + 12 * MINUTE) })),
    unit: counted("unit", async () => ({ state: "active" })),
    comment: counted("comment", async () => ({ body: "Ruled: hold.\nUntil Monday.", url: `https://github.com/${REPO}/issues/2910#issuecomment-5` })),
    ...Object.fromEntries(Object.entries(overrides).map(([name, read]) => [name, counted(name, /** @type {Function} */ (read))])),
  };
  return { readers, calls };
}

/** @param {Partial<import("./placeholders.mjs").Readers>} [overrides] @param {{maxText?: number}} [options] */
function harness(overrides = {}, { maxText } = {}) {
  const provider = createFakeProvider();
  const ledger = createLedger({ path: join(scratch, `ledger-${nextLedger += 1}.jsonl`), now: () => NOW });
  const { readers, calls } = fixtureReaders(overrides);
  const reply = createReply({ send: (message) => provider.send(message), ledger, readers, now: () => NOW, maxText });
  return { provider, ledger, reply, calls };
}

const PLACEHOLDERS_ONLY = "#{{pr:2881.number}} is {{pr:2881.state}}, review {{pr:2881.review}}; {{ready.count}} ready.";

describe("done-when 1: a placeholder renders what its reader returns, and the message ends with the as-of stamp", () => {
  test("{{pr:2881.state}} renders the fixture's state, and the stamp is the last line", async () => {
    const { reply, provider } = harness();
    const result = await reply.send("Status: {{pr:2881.state}}");
    assert.equal(result.outcome, "sent");
    assert.deepEqual(provider.sent.map((message) => message.text), [`Status: merged\n\n${STAMP}`]);
  });

  test("the state is READ, not remembered: a different fixture answer is a different message (the positive control against a hard-coded render)", async () => {
    const { reply, provider } = harness({ pr: async (number) => ({ number, state: "open", review: "REVIEW_REQUIRED" }) });
    await reply.send("Status: {{pr:2881.state}}");
    assert.equal(provider.sent[0].text, `Status: open\n\n${STAMP}`);
  });

  test("every kind in the vocabulary renders its field", async () => {
    const { reply, provider } = harness();
    const text = ["{{issue:2910.labels}}", "{{issue:2910.state}}", "{{issue:2910.number}}", "{{pr:2881.review}}", "{{run:36891064128.conclusion}}",
      "{{ready.count}}", "{{last-merge.age}}", "{{unit:work-tick.state}}"].join("|");
    await reply.send(text);
    assert.equal(provider.sent[0].text, `in-progress, lane:any, ready|open|2910|APPROVED|failure|7|3h 12m|active\n\n${STAMP}`);
  });

  test("a row comment is quoted verbatim, line by line, followed by its link", async () => {
    const { reply, provider } = harness();
    await reply.send("The ruling:\n{{comment:5.quote}}");
    assert.equal(provider.sent[0].text, `The ruling:\n> Ruled: hold.\n> Until Monday.\nhttps://github.com/${REPO}/issues/2910#issuecomment-5\n\n${STAMP}`);
  });

  test("a quote over the limit is refused rather than cut", async () => {
    const { reply, provider } = harness({ comment: async () => ({ body: "x".repeat(QUOTE_LIMIT + 1), url: "https://example.test/c" }) });
    const result = await reply.send("{{comment:5.quote}}");
    assert.equal(result.outcome, "refused");
    assert.match(JSON.stringify(result), /over the 1000/);
    assert.deepEqual(provider.sent, []);
  });

  test("a thing is read ONCE however many of its fields the text uses, and every distinct thing is read", async () => {
    const { reply, calls } = harness();
    await reply.send("{{pr:1.state}} {{pr:1.review}} {{pr:1.number}} {{pr:1.state}} {{pr:2.state}} {{ready.count}}");
    assert.deepEqual(calls, { pr: 2, ready: 1 });
  });

  test("labels read as a sorted list, and none reads as 'no labels' (an empty render would look like nothing to report)", async () => {
    const empty = harness({ issue: async (number) => ({ number, state: "open", labels: [] }) });
    await empty.reply.send("{{issue:1.labels}}");
    assert.equal(empty.provider.sent[0].text, `no labels\n\n${STAMP}`);
  });

  test("an age is the two most significant units", () => {
    assert.equal(describeAge(0), "0m");
    assert.equal(describeAge(59 * MINUTE + 59_000), "59m");
    assert.equal(describeAge(HOUR), "1h 0m");
    assert.equal(describeAge(26 * HOUR + 30 * MINUTE), "1d 2h");
    assert.throws(() => describeAge(-1), /not an age/);
  });
});

describe("done-when 2: a reader that fails REFUSES the send and names the placeholder; the refusal is itself sendable", () => {
  const failing = { pr: async () => { throw new Error("HTTP 502 from the pulls endpoint"); } };

  test("the refusal names the placeholder as written and the reader's reason, and nothing is sent", async () => {
    const { reply, provider } = harness(failing);
    const result = await reply.send("Status: {{pr:2881.state}}");
    assert.equal(result.outcome, "refused");
    assert.equal(/** @type {any} */ (result).problems.length, 1);
    assert.equal(/** @type {any} */ (result).problems[0].placeholder, "{{pr:2881.state}}");
    assert.match(/** @type {any} */ (result).problems[0].reason, /502/);
    assert.deepEqual(provider.sent, []);
  });

  test("the refusal's `sendable` text passes the same checker and says it could not check", async () => {
    const { reply, provider } = harness(failing);
    const refusal = /** @type {any} */ (await reply.send("Status: {{pr:2881.state}}"));
    const told = await reply.send(refusal.sendable);
    assert.equal(told.outcome, "sent");
    assert.deepEqual(provider.sent.map((message) => message.text), [`Could not check, so not stated: [pr:2881.state].\n\n${STAMP}`]);
  });

  test("EVERY failed placeholder is named, in one refusal, and the ones that read fine are not", async () => {
    const { reply } = harness({ pr: async () => { throw new Error("no"); }, ready: async () => { throw new Error("no"); } });
    const refusal = /** @type {any} */ (await reply.send("{{pr:1.state}} {{issue:2.state}} {{ready.count}}"));
    assert.deepEqual(refusal.problems.map((/** @type {any} */ problem) => problem.placeholder), ["{{pr:1.state}}", "{{ready.count}}"]);
    assert.equal(refusal.sendable, "Could not check, so not stated: {{unchecked:pr:1.state}}, {{unchecked:ready.count}}.");
  });

  test("a reader that answers with nothing is a failure too: a blank render would read as 'nothing to report'", async () => {
    for (const empty of ["", "   ", null, undefined]) {
      const { reply, provider } = harness({ pr: async (number) => /** @type {any} */ ({ number, state: empty, review: "x" }) });
      const result = await reply.send("{{pr:1.state}}");
      assert.equal(result.outcome, "refused", `a ${JSON.stringify(empty)} state refuses`);
      assert.deepEqual(provider.sent, []);
    }
  });

  test("a reader's reason is redacted: a token in an error message does not reach the caller's refusal", async () => {
    const token = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
    const { reply } = harness({ pr: async () => { throw new Error(`request failed, token=${token}`); } });
    const refusal = /** @type {any} */ (await reply.send("{{pr:1.state}}"));
    assert.ok(!JSON.stringify(refusal).includes(token));
    assert.match(refusal.problems[0].reason, /redacted/);
  });

  test("{{unchecked:...}} reads nothing, and it takes a placeholder, not words (it cannot carry a claim)", async () => {
    const { reply, provider, calls } = harness();
    assert.equal((await reply.send("{{unchecked:ready.count}}")).outcome, "sent");
    assert.deepEqual(calls, {}, "no reader was asked");
    for (const claim of ["{{unchecked:2881 is merged}}", "{{unchecked:pr:2881}}", "{{unchecked:the build is green.state}}"]) {
      assert.equal((await reply.send(claim)).outcome, "refused", claim);
    }
    assert.equal(provider.sent.length, 1);
  });
});

describe("done-when 3: a claim in free text is refused, and the same sentence through placeholders passes", () => {
  test("'#2881 is merged' with no placeholder is refused, with both claims named, and nothing is sent", async () => {
    const { reply, provider } = harness();
    const result = /** @type {any} */ (await reply.send("#2881 is merged"));
    assert.equal(result.outcome, "refused");
    assert.equal(result.problems.length, 2);
    assert.match(result.problems[0].reason, /"#2881" is a row or pull request number/);
    assert.match(result.problems[1].reason, /"merged" is a state word/);
    assert.deepEqual(provider.sent, []);
  });

  test("'#{{pr:2881.number}} is {{pr:2881.state}}' passes and says '#2881 is merged' (the positive control)", async () => {
    const { reply, provider } = harness();
    const result = await reply.send("#{{pr:2881.number}} is {{pr:2881.state}}");
    assert.equal(result.outcome, "sent");
    assert.deepEqual(provider.sent.map((message) => message.text), [`#2881 is merged\n\n${STAMP}`]);
  });

  test("a message made only of placeholders and plain words IS sent", async () => {
    const { reply, provider } = harness();
    assert.equal((await reply.send(PLACEHOLDERS_ONLY)).outcome, "sent");
    assert.equal(provider.sent[0].text, `#2881 is merged, review APPROVED; 7 ready.\n\n${STAMP}`);
  });

  test("the value a placeholder RENDERS is not judged: 'merged' and '2881' come from a read, and only the writer's own words are free text", async () => {
    const { reply } = harness();
    assert.equal((await reply.send("{{pr:2881.state}}")).outcome, "sent");
  });
});

describe("done-when 4: text after `My read:` is exempt, and the same text without the marker is not", () => {
  const CLAIM = "I think #2881 is merged, and all 3 checks are green.";

  test("under the marker it is sent, with the marker still in the message so the chairman sees it is an opinion", async () => {
    const { reply, provider } = harness();
    const result = await reply.send(`Here is what I checked: {{pr:2881.state}}.\nMy read: ${CLAIM}`);
    assert.equal(result.outcome, "sent");
    assert.equal(provider.sent[0].text, `Here is what I checked: merged.\nMy read: ${CLAIM}\n\n${STAMP}`);
  });

  test("the same text without the marker is refused", async () => {
    const { reply, provider } = harness();
    const result = await reply.send(`Here is what I checked: {{pr:2881.state}}.\n${CLAIM}`);
    assert.equal(result.outcome, "refused");
    assert.deepEqual(provider.sent, []);
  });

  test("the marker must start a line: 'My read:' in the middle of a sentence exempts nothing", async () => {
    const { reply } = harness();
    assert.equal((await reply.send(`Well, My read: ${CLAIM}`)).outcome, "refused");
  });

  test("the exemption starts at the marker and does not reach back: a claim BEFORE it is still refused", async () => {
    const { reply } = harness();
    assert.equal((await reply.send(`#2881 is merged.\nMy read: fine.`)).outcome, "refused");
  });

  test("placeholders under the marker still resolve, and a failed read there still refuses", async () => {
    const { reply, provider } = harness({ pr: async () => { throw new Error("down"); } });
    const result = await reply.send("My read: it looks like {{pr:2881.state}}.");
    assert.equal(result.outcome, "refused");
    assert.deepEqual(provider.sent, []);
    const fine = harness();
    await fine.reply.send("My read: it looks like {{pr:2881.state}}.");
    assert.equal(fine.provider.sent[0].text, `My read: it looks like merged.\n\n${STAMP}`);
  });
});

describe("done-when 5: the ledger line carries the values it was rendered with", () => {
  test("a sent reply: the placeholders as written and what each said, the time of the reads, the text, the message ref and the message it answered", async () => {
    const { reply, ledger } = harness();
    await reply.send("#{{pr:2881.number}} is {{pr:2881.state}}, {{ready.count}} ready", { replyTo: "77" });
    const [line] = readLedgerLines(ledger.path);
    assert.equal(line.direction, "reply");
    assert.equal(line.status, "replied");
    assert.deepEqual(line.values, { "{{pr:2881.number}}": "2881", "{{pr:2881.state}}": "merged", "{{ready.count}}": "7" });
    assert.equal(line.asOf, "2026-10-02T14:05:30.000Z");
    assert.equal(line.text, `#2881 is merged, 7 ready\n\n${STAMP}`);
    assert.equal(line.providerMessageId, "fake-1");
    assert.equal(line.replyTo, "77");
    assert.equal(line.error, null);
  });

  test("a refused reply writes no line (nothing went out), and the provider is not asked", async () => {
    const { reply, ledger, provider } = harness();
    await reply.send("#2881 is merged");
    assert.deepEqual(readLedgerLines(ledger.path), []);
    assert.deepEqual(provider.sent, []);
  });

  test("a provider that throws: the reply is a `failed` outcome, the line says so with the error REDACTED, and the values are still on it", async () => {
    const { reply, ledger, provider } = harness();
    provider.failNext(new Error("fetch failed for https://api.telegram.org/bot123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef/sendMessage"));
    const result = /** @type {any} */ (await reply.send("{{pr:2881.state}}"));
    assert.equal(result.outcome, "failed");
    const [line] = readLedgerLines(ledger.path);
    assert.equal(line.status, "failed");
    assert.deepEqual(line.values, { "{{pr:2881.state}}": "merged" });
    assert.ok(!JSON.stringify([result, line]).includes("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef"));
  });

  test("a provider that returns no message ref is a failure, not a send the log claims", async () => {
    const ledger = createLedger({ path: join(scratch, "no-ref.jsonl"), now: () => NOW });
    const reply = createReply({ send: async () => /** @type {any} */ ({}), ledger, readers: fixtureReaders().readers, now: () => NOW });
    assert.equal((await reply.send("{{ready.count}}")).outcome, "failed");
    assert.equal(readLedgerLines(ledger.path)[0].status, "failed");
  });

  test("a ledger that cannot be written throws to the caller, and is NOT recorded as a failed send (the message went out)", async () => {
    const provider = createFakeProvider();
    const ledger = { append: () => { throw new Error("disk full"); } };
    const reply = createReply({ send: (message) => provider.send(message), ledger, readers: fixtureReaders().readers, now: () => NOW });
    await assert.rejects(() => reply.send("{{ready.count}}"), /disk full/);
    assert.equal(provider.sent.length, 1);
  });

  test("a reply line is invisible to the core: not counted against the hourly cap, and no key state is folded from it (a real send line IS counted: the control)", async () => {
    const { reply, ledger } = harness();
    await reply.send("{{ready.count}}");
    const lines = readLedgerLines(ledger.path);
    assert.deepEqual(deliveredTimestamps(lines), []);
    assert.equal(foldLedger(lines).size, 0);
    assert.equal(deliveredTimestamps([{ key: "k", status: "sent", ts: "2026-10-02T14:05:30.000Z" }]).length, 1);
  });
});

describe("the vocabulary is closed", () => {
  const REFUSED = [
    ["an unknown kind", "{{weather:1.state}}"],
    ["an unknown field", "{{pr:2881.title}}"],
    ["a field of another kind", "{{pr:2881.labels}}"],
    ["an id of the wrong shape", "{{pr:latest.state}}"],
    ["a zero id", "{{pr:0.state}}"],
    ["an id where none is taken", "{{ready:3.count}}"],
    ["no id where one is needed", "{{pr.state}}"],
    ["a unit name that could be a flag", "{{unit:--help.state}}"],
    ["spaces inside the braces", "{{ pr:2881.state }}"],
    ["an unclosed placeholder", "{{pr:2881.state"],
    ["a stray close", "pr:2881.state}}"],
    ["an empty placeholder", "{{}}"],
    ["a prototype key as a kind", "{{constructor:1.state}}"],
  ];
  for (const [what, text] of REFUSED) {
    test(`${what} is refused before any read: ${text}`, async () => {
      const { reply, provider, calls } = harness();
      const result = /** @type {any} */ (await reply.send(text));
      assert.equal(result.outcome, "refused");
      assert.ok(result.problems.length > 0);
      assert.deepEqual(calls, {}, "no reader was asked");
      assert.deepEqual(provider.sent, []);
    });
  }

  test("a refusal for an unknown kind lists the kinds that exist", async () => {
    const { reply } = harness();
    const result = /** @type {any} */ (await reply.send("{{weather:1.state}}"));
    assert.match(result.problems[0].reason, /issue, pr, run, ready, last-merge, unit, comment/);
  });

  test("a unit name with dots parses (the field is the LAST segment)", () => {
    const parsed = parsePlaceholders("{{unit:a11ign-work-tick.service.state}}");
    assert.deepEqual(parsed.problems, []);
    assert.equal(parsed.placeholders[0].id, "a11ign-work-tick.service");
    assert.equal(parsed.placeholders[0].field, "state");
    assert.equal(parsed.masked, MASK);
  });
});

describe("the free-text rules, each side of each pattern", () => {
  /** @type {[string, boolean][]} text, whether it is refused */
  const CASES = [
    ["#12", true], ["see #12 for it", true], ["# 12", true],
    ["3 rows", true], ["14:05", true], ["3rd", true], ["a11ign is the org", false], ["the a11y-witness tool", false], ["W3C", false],
    ["two rows", true], ["twenty", true], ["a dozen", true], ["no one is waiting", false], ["this one", false], ["Zero", true],
    ["merged", true], ["MERGED", true], ["it is green", true], ["red", true], ["passing", true], ["passed", true], ["failed", true], ["failing", true],
    ["done", true], ["closed", true], ["approved", true],
    ["emerged", false], ["reddish", false], ["undone", false], ["greenfield", false], ["I am looking into it now", false], ["Waiting on a reply", false],
  ];
  for (const [text, refused] of CASES) {
    test(`${JSON.stringify(text)} is ${refused ? "refused" : "allowed"}`, async () => {
      const { reply, provider } = harness();
      const result = await reply.send(text);
      assert.equal(result.outcome, refused ? "refused" : "sent");
      assert.equal(provider.sent.length, refused ? 0 : 1);
    });
  }

  test("a repeated claim is named once", async () => {
    const result = /** @type {any} */ (await harness().reply.send("merged merged merged"));
    assert.equal(result.problems.length, 1);
  });

  test("an empty or non-string reply is refused", async () => {
    for (const empty of ["", "  \n ", undefined, 7]) {
      assert.equal((await harness().reply.send(/** @type {any} */ (empty))).outcome, "refused");
    }
  });

  test("a message too long once the facts are in is refused, not cut: the stamp and the link are what a cut would lose", async () => {
    const { reply, provider } = harness({}, { maxText: 40 });
    const result = /** @type {any} */ (await reply.send("{{comment:5.quote}}"));
    assert.equal(result.outcome, "refused");
    assert.match(result.problems[0].reason, /over the 40/);
    assert.deepEqual(provider.sent, []);
  });

  test("prepareReply alone sends nothing and reports the facts and the time", async () => {
    const { readers } = fixtureReaders();
    const prepared = /** @type {any} */ (await prepareReply("{{pr:1.state}}", { readers, now: () => NOW }));
    assert.deepEqual([prepared.outcome, prepared.at, prepared.values], ["checked", NOW, { "{{pr:1.state}}": "merged" }]);
  });
});

describe("createGhReaders: the real reads, over a fake gh and a fake systemctl", () => {
  const API = (/** @type {string} */ path) => `api ${path}`;
  /** @param {Record<string, unknown>} routes `gh`'s argv joined by a space -> the JSON it prints; an unrouted command throws, so an extra call is a failure */
  function ghFor(routes) {
    /** @type {string[]} */
    const asked = [];
    const gh = async (/** @type {string[]} */ argv) => {
      asked.push(argv.join(" "));
      const answer = routes[argv.join(" ")];
      if (answer === undefined) throw new Error(`no route for: gh ${argv.join(" ")}`);
      return JSON.stringify(answer);
    };
    return { gh, asked };
  }
  const systemctlOf = (/** @type {string} */ output) => async () => output;
  const noSystemctl = systemctlOf("");

  test("issue: its state and label names; a PULL REQUEST number is refused with the remedy (the issues endpoint answers for both)", async () => {
    const { gh } = ghFor({
      [API(`repos/${REPO}/issues/10`)]: { number: 10, state: "open", labels: [{ name: "ready" }, { name: "lane:any" }] },
      [API(`repos/${REPO}/issues/11`)]: { number: 11, state: "open", labels: [], pull_request: {} },
    });
    const readers = createGhReaders({ gh, systemctl: noSystemctl, repo: REPO });
    assert.deepEqual(await readers.issue(10), { number: 10, state: "open", labels: ["ready", "lane:any"] });
    await assert.rejects(() => readers.issue(11), /ask for \{\{pr:11\.state\}\}/);
  });

  test("pr: merged reads 'merged' (not 'closed'), and an EMPTY reviewDecision reads 'none'", async () => {
    const { gh } = ghFor({
      [API(`repos/${REPO}/pulls/1`)]: { number: 1, state: "closed", merged_at: "2026-10-02T10:00:00Z" },
      [`pr view 1 --repo ${REPO} --json reviewDecision`]: { reviewDecision: "APPROVED" },
      [API(`repos/${REPO}/pulls/2`)]: { number: 2, state: "open", merged_at: null },
      [`pr view 2 --repo ${REPO} --json reviewDecision`]: { reviewDecision: "" },
    });
    const readers = createGhReaders({ gh, systemctl: noSystemctl, repo: REPO });
    assert.deepEqual(await readers.pr(1), { number: 1, state: "merged", review: "APPROVED" });
    assert.deepEqual(await readers.pr(2), { number: 2, state: "open", review: "none" });
  });

  test("run: the conclusion; a run that has not concluded THROWS rather than reading as nothing", async () => {
    const { gh } = ghFor({
      [API(`repos/${REPO}/actions/runs/5`)]: { conclusion: "success", status: "completed" },
      [API(`repos/${REPO}/actions/runs/6`)]: { conclusion: null, status: "in_progress" },
    });
    const readers = createGhReaders({ gh, systemctl: noSystemctl, repo: REPO });
    assert.deepEqual(await readers.run(5), { conclusion: "success" });
    await assert.rejects(() => readers.run(6), /has not concluded \(status in_progress\)/);
  });

  test("ready counts the rows the watcher counts as waiting, and the last merge is the newest merged_at", async () => {
    const { gh } = ghFor({
      [API(`repos/${REPO}/issues?labels=ready&state=open&per_page=100`)]: [
        { number: 1, labels: [{ name: "ready" }] }, { number: 2, labels: [{ name: "ready" }, { name: "hold" }] }, { number: 3, labels: [{ name: "ready" }], pull_request: {} },
      ],
      [API(`repos/${REPO}/pulls?state=closed&base=main&sort=updated&direction=desc&per_page=30`)]: [
        { merged_at: "2026-10-02T10:00:00Z" }, { merged_at: null }, { merged_at: "2026-10-02T11:00:00Z" },
      ],
    });
    const readers = createGhReaders({ gh, systemctl: noSystemctl, repo: REPO });
    assert.deepEqual(await readers.ready(), { count: 1 });
    assert.deepEqual(await readers.lastMerge(), { at: Date.parse("2026-10-02T11:00:00Z") });
  });

  test("unit: ActiveState; a unit systemd does not know THROWS (its show prints ActiveState=inactive for a name it never heard of)", async () => {
    const known = createGhReaders({ gh: ghFor({}).gh, systemctl: systemctlOf("ActiveState=active\nLoadState=loaded\n"), repo: REPO });
    assert.deepEqual(await known.unit("work-tick"), { state: "active" });
    const unknown = createGhReaders({ gh: ghFor({}).gh, systemctl: systemctlOf("ActiveState=inactive\nLoadState=not-found\n"), repo: REPO });
    await assert.rejects(() => unknown.unit("nonesuch"), /no unit named nonesuch/);
  });

  test("unit: only `--user show <name> -p ...` is ever asked of systemctl", async () => {
    /** @type {string[][]} */
    const argvs = [];
    const readers = createGhReaders({ gh: ghFor({}).gh, systemctl: async (argv) => { argvs.push(argv); return "ActiveState=active\nLoadState=loaded"; }, repo: REPO });
    await readers.unit("work-tick");
    assert.deepEqual(argvs, [["--user", "show", "work-tick", "-p", "ActiveState,LoadState"]]);
  });

  test("end to end over the real readers: a reply through createGhReaders says what the fake GitHub says, and a GitHub that fails refuses it", async () => {
    const routes = {
      [API(`repos/${REPO}/pulls/2881`)]: { number: 2881, state: "closed", merged_at: "2026-10-02T10:00:00Z" },
      [`pr view 2881 --repo ${REPO} --json reviewDecision`]: { reviewDecision: "APPROVED" },
    };
    const provider = createFakeProvider();
    const ledger = createLedger({ path: join(scratch, "e2e.jsonl"), now: () => NOW });
    const reply = createReply({ send: (m) => provider.send(m), ledger, readers: createGhReaders({ gh: ghFor(routes).gh, systemctl: noSystemctl, repo: REPO }), now: () => NOW });
    assert.equal((await reply.send(PLACEHOLDERS_ONLY.replace("; {{ready.count}} ready", ""))).outcome, "sent");
    assert.equal(provider.sent[0].text, `#2881 is merged, review APPROVED.\n\n${STAMP}`);
    const down = createReply({ send: (m) => provider.send(m), ledger, readers: createGhReaders({ gh: ghFor({}).gh, systemctl: noSystemctl, repo: REPO }), now: () => NOW });
    assert.equal((await down.send("{{pr:2881.state}}")).outcome, "refused");
    assert.equal(provider.sent.length, 1);
  });
});
