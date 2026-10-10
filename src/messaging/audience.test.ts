// EVERY CHAIRMAN MESSAGE DECLARES WHO IT IS FOR, AND THE SENDER ROUTES BY IT (a11ign/a11ign#4742, row 1 of 5 of #928's split).
//
// The chairman's direction: one chat filling with everything makes it "really hard to keep track of what I'm needed for". So a kind is an
// ASK (needs him: one message per ask, in the existing chat) or an ANNOUNCEMENT (told to him, asks nothing: a one-way channel).
//
// WHAT EACH BLOCK CAN FAIL ON: the routing is read off the WIRE (`chat_id` of the request Telegram would have received), not off what the core
// believes it did, and every routing assertion is run once against a provider that IGNORES the audience to show it goes red (the control).

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";

import { MessagingConfigRefusal, parseMessagingConfig } from "./config.ts";
import { DEFAULT_CONFIG, createMessenger, planNotification, resolveConfig } from "./core.ts";
import { EVENT_KINDS } from "./event.ts";
import { createFakeProvider } from "./fake-provider.ts";
import { createLedger, readLedgerLines } from "./ledger.ts";
import { AUDIENCE, ConformanceError, runProviderConformance } from "./provider-contract.ts";
import { createSecret } from "./secret.ts";
import { createTelegramProvider } from "./providers/telegram/send.ts";

const START = Date.parse("2026-10-10T09:00:00Z");
const TOKEN = "123456789:AAFk3x9Q-test_token_value_ZZ";
const ASK_CHAT = 4242;
const CHANNEL_CHAT = -1009876543210;
const EVERY_ASK_KIND = ["request", "stall"];

const scratch = mkdtempSync(join(tmpdir(), "messaging-audience-"));
after(() => rmSync(scratch, { recursive: true, force: true }));
let nextLedger = 0;

type Wire = { url: string; body: Record<string, any> };

/** A fetch that records each request and answers every one with a fresh message id. */
function fakeTelegram() {
  const requests: Wire[] = [];
  let nextMessageId = 100;
  const fetchImpl = (async (url: string, init: { body: string }) => {
    requests.push({ url, body: JSON.parse(init.body) });
    return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: nextMessageId += 1 } }), headers: { get: () => null } };
  }) as unknown as typeof fetch;
  return { fetch: fetchImpl, requests };
}

function telegram({ announcementsChatId }: { announcementsChatId?: number } = {}) {
  const wire = fakeTelegram();
  const real = createTelegramProvider({
    token: createSecret(TOKEN), chatId: ASK_CHAT, announcementsChatId, fetch: wire.fetch, sleep: async () => {}, log: () => {},
  });
  // These tests pin where each message goes, so they run the lifecycle without the asks' record (a11ign/a11ign#4745): the pinned list is a message of its own.
  const provider = { ...real, capabilities: { ...real.capabilities, edit: false, pin: false } };
  return { provider, requests: wire.requests };
}

/** A messenger over `provider`, with the clock fixed at START so a kind's hold-down is the only thing that can delay a send. */
function messengerOver(provider: any, config?: Parameters<typeof resolveConfig>[0]) {
  const path = join(scratch, `ledger-${nextLedger += 1}.jsonl`);
  const messenger = createMessenger({ provider, ledger: createLedger({ path, now: () => START }), now: () => START, config });
  return { tick: (events: unknown[]) => messenger.tick(events), lines: () => readLedgerLines(path) };
}

/** A request's key carries its row (`#1`): an ask with no row is refused at send (a11ign/a11ign#4745), and none of these tests is about that. */
function event(kind: string, more: Record<string, unknown> = {}) {
  const row = kind === "request" ? "#1" : "";
  return { key: `${kind}:audience-test${row}`, kind, severity: "info", firstSeenAt: START, text: `a ${kind} the chairman is told`, links: [], ...more };
}

/** The chat ids the requests went to, in order. */
const chatsOf = (requests: Wire[]) => requests.map((request) => request.body.chat_id);

describe("each kind declares its audience, and the plan carries it", () => {
  test("request and stall are asks; every other kind is an announcement -- and no kind is left undeclared", () => {
    const declared: Record<string, string | undefined> = Object.fromEntries(Object.entries(DEFAULT_CONFIG.kinds).map(([kind, policy]) => [kind, (policy as { audience?: string }).audience]));
    const asks = Object.keys(declared).filter((kind) => declared[kind] === "ask").sort();
    assert.deepEqual(declared, {
      request: "ask", incident: "announcement", stall: "ask", summary: "announcement", release: "announcement", milestone: "announcement", watch: "announcement",
    });
    // The positive control for the line above AND the population check: every kind the event door admits has an entry, so a kind added to
    // EVENT_KINDS without an audience is a red test here and not a refusal found in production.
    assert.deepEqual(Object.keys(declared).sort(), [...EVENT_KINDS].sort());
    assert.deepEqual(asks, EVERY_ASK_KIND);
  });

  test("planNotification carries the audience of the event's kind on a send, and only on a send", () => {
    const config = resolveConfig();
    const plan = (kind: string, resolved = false) =>
      planNotification({ key: "k", kind, severity: "info", firstSeenAt: START, text: "t", links: [], resolved, state: "", actions: [] }, undefined, START, config);
    assert.deepEqual(plan("request"), { action: "send", kind: "first", audience: "ask" });
    assert.deepEqual(plan("release"), { action: "send", kind: "first", audience: "announcement" });
    assert.deepEqual(plan("request", true), { action: "none", why: "resolved-before-sent" }, "a plan that sends nothing names no audience");
  });
});

describe("a kind with no audience is refused at send, never defaulted", () => {
  test("nothing is sent, the line names the kind, and a declared kind beside it still goes (the positive control)", async () => {
    const provider = createFakeProvider({ capabilities: { edit: false, pin: false } });
    const run = messengerOver(provider, { kinds: { request: { audience: undefined } } });
    const decisions = await run.tick([event("request"), event("release")]);
    assert.deepEqual(decisions.map((decision) => decision.action), ["invalid", "sent"]);
    assert.equal(provider.sent.length, 1, "only the declared kind was sent");
    assert.equal(provider.sent[0].audience, "announcement");
    const refusal = run.lines().find((line) => line.status === "invalid");
    assert.match(refusal?.error, /^alert not sent: kind "request" declares no audience/, "the line names the kind and begins as every refusal of an ask does");
    assert.equal(refusal?.key, "request:audience-test#1");
  });

  test("an audience that is neither ask nor announcement is refused the same way, not passed through", async () => {
    const provider = createFakeProvider({ capabilities: { edit: false, pin: false } });
    const run = messengerOver(provider, { kinds: { stall: { audience: "everyone" } } });
    const [decision] = await run.tick([event("stall")]);
    assert.equal(decision.action, "invalid");
    assert.deepEqual(provider.sent, []);
    assert.match(run.lines()[0].error, /kind "stall" declares no audience/);
  });
});

describe("routing: with one destination both audiences reach the same chat, with two each reaches its own", () => {
  /** What every routing claim below asserts, given a way to send one ask and one announcement and read where each went. */
  async function routedTo(provider: any, requests: () => number[]) {
    const run = messengerOver(provider);
    const decisions = await run.tick([event("request"), event("release")]);
    assert.deepEqual(decisions.map((decision) => decision.action), ["sent", "sent"], "the positive control: both were sent");
    return requests();
  }

  test("only chairmanFile (no announcements chat): both audiences go to the chairman chat, exactly as today", async () => {
    const { provider, requests } = telegram();
    assert.equal(provider.capabilities.destinations, 1, "a provider with one destination says so");
    assert.deepEqual(await routedTo(provider, () => chatsOf(requests)), [ASK_CHAT, ASK_CHAT]);
  });

  test("with both files: the ask goes to the chairman chat and the announcement to the channel", async () => {
    const { provider, requests } = telegram({ announcementsChatId: CHANNEL_CHAT });
    assert.equal(provider.capabilities.destinations, 2);
    assert.deepEqual(await routedTo(provider, () => chatsOf(requests)), [ASK_CHAT, CHANNEL_CHAT]);
  });

  test("the same routing through the fake provider, where a test reads `destination` off what was sent", async () => {
    const provider = createFakeProvider({ capabilities: { destinations: 2, edit: false, pin: false } });
    await routedTo(provider, () => []);
    assert.deepEqual(provider.sent.map((message) => message.destination), ["ask", "announcement"]);
    const single = createFakeProvider({ capabilities: { edit: false, pin: false } });
    await routedTo(single, () => []);
    assert.deepEqual(single.sent.map((message) => message.destination), ["ask", "ask"]);
  });

  test("CONTROL: the routing assertion goes red when the audience is ignored", async () => {
    const { provider, requests } = telegram({ announcementsChatId: CHANNEL_CHAT });
    const deaf = { ...provider, send: (message: { text: string }) => provider.send({ ...message, audience: undefined }) };
    const chats = await routedTo(deaf, () => chatsOf(requests));
    assert.notDeepEqual(chats, [ASK_CHAT, CHANNEL_CHAT], "an ignored audience sends the announcement to the ask chat, and the test above would have failed");
    assert.deepEqual(chats, [ASK_CHAT, ASK_CHAT]);
  });
});

describe("an announcement is one-way", () => {
  test("an announcement with actions is refused by the provider, in either configuration, and nothing is put on the wire", async () => {
    for (const announcementsChatId of [undefined, CHANNEL_CHAT]) {
      const { provider, requests } = telegram({ announcementsChatId });
      await assert.rejects(() => provider.send({ text: "told", audience: AUDIENCE.announcement, actions: [{ label: "Yes", data: "yes" }] }), /one-way and carries no actions/);
      assert.equal(requests.length, 0, "nothing was put on the wire");
      await provider.send({ text: "asked", audience: AUDIENCE.ask, actions: [{ label: "Yes", data: "yes" }] });
      assert.equal(requests.length, 1, "the positive control: the same buttons on an ask are drawn");
      assert.equal(requests[0].body.reply_markup.inline_keyboard.length, 1);
    }
  });

  test("through the core: an announcement that carries actions is a recorded failure, and the ask beside it is unharmed", async () => {
    const { provider, requests } = telegram({ announcementsChatId: CHANNEL_CHAT });
    const actions = [{ label: "Yes", data: "yes" }];
    const run = messengerOver(provider);
    const decisions = await run.tick([event("release", { actions }), event("request", { actions })]);
    assert.deepEqual(decisions.map((decision) => decision.action), ["failed", "sent"]);
    assert.deepEqual(chatsOf(requests), [ASK_CHAT], "the announcement never reached the channel");
    assert.match(run.lines().find((line) => line.status === "failed")?.error, /one-way and carries no actions/);
  });

  test("a reply into the channel is refused; the same reply with no channel threads, as an incident's cleared always did", async () => {
    const withChannel = telegram({ announcementsChatId: CHANNEL_CHAT });
    await assert.rejects(() => withChannel.provider.send({ text: "cleared", audience: AUDIENCE.announcement, replyTo: "101" }), /one-way and carries no replyTo/);
    assert.deepEqual(withChannel.requests, []);
    const single = telegram();
    await single.provider.send({ text: "cleared", audience: AUDIENCE.announcement, replyTo: "101" });
    assert.equal(single.requests[0].body.reply_parameters.message_id, 101);
  });

  test("an incident's 'cleared' in the channel stands alone (no replyTo) and goes there; in one chat it threads as before", async () => {
    for (const announcementsChatId of [CHANNEL_CHAT, undefined]) {
      const { provider, requests } = telegram({ announcementsChatId });
      const run = messengerOver(provider, { kinds: { incident: { holdDownMs: 0 } } });
      await run.tick([event("incident")]);
      const [cleared] = await run.tick([event("incident", { resolved: true, firstSeenAt: START + 1 })]);
      assert.equal(cleared.action, "cleared", "the positive control: the clear was delivered, not failed");
      const [original, clear] = requests as [Wire, Wire];
      const expected = announcementsChatId ?? ASK_CHAT;
      assert.deepEqual([original.body.chat_id, clear.body.chat_id], [expected, expected]);
      assert.equal(clear.body.reply_parameters !== undefined, announcementsChatId === undefined);
    }
  });

  test("the ledger records which audience each line was for", async () => {
    const run = messengerOver(createFakeProvider({ capabilities: { destinations: 2, edit: false, pin: false } }));
    await run.tick([event("request"), event("release")]);
    assert.deepEqual(run.lines().map((line) => [line.key, line.audience]), [["request:audience-test#1", "ask"], ["release:audience-test", "announcement"]]);
  });
});

describe("the contract holds a provider to the audience", () => {
  test("the fake and the Telegram provider (with and without a channel) pass, and the audience checks RAN", async () => {
    const providers = [createFakeProvider({ capabilities: { edit: false, pin: false } }), createFakeProvider({ capabilities: { destinations: 2, edit: false, pin: false } }), telegram().provider, telegram({ announcementsChatId: CHANNEL_CHAT }).provider];
    for (const provider of providers) {
      const { passed } = await runProviderConformance(provider);
      for (const check of ["audience-is-honoured", "unknown-audience-is-refused", "announcement-refuses-actions", "announcement-reply-to-follows-its-destination"]) {
        assert.ok(passed.includes(check), `${check} did not run for destinations=${provider.capabilities.destinations}`);
      }
    }
  });

  test("FAILS a provider that ignores the audience, and one that lets a channel announcement carry actions or a reply", async () => {
    const failedChecks = async (provider: any) => {
      try {
        await runProviderConformance(provider);
      } catch (error) {
        if (error instanceof ConformanceError) return error.failures.map((failure) => failure.check).sort();
        throw error;
      }
      return assert.fail("expected a ConformanceError and there was none");
    };
    const real = createFakeProvider({ capabilities: { destinations: 2, edit: false, pin: false } });
    const ignores = { ...real, send: async (message: any) => ({ ...(await real.send({ ...message, audience: undefined })) }) };
    // Ignoring the audience sends everything as an ask: an announcement's buttons and reply are accepted, and an unknown audience is not told apart.
    assert.deepEqual(await failedChecks(ignores), ["announcement-refuses-actions", "announcement-reply-to-follows-its-destination", "audience-is-honoured", "unknown-audience-is-refused"]);
    const permissive = createFakeProvider({ capabilities: { destinations: 2, edit: false, pin: false } });
    const noOneWay = { ...permissive, send: async (message: any) => permissive.send({ text: message.text, silent: message.silent, audience: message.audience }) };
    // `actions` and `replyTo` are dropped before the fake sees them, so nothing is refused: the two one-way checks must notice.
    assert.deepEqual(await failedChecks(noOneWay), ["announcement-refuses-actions", "announcement-reply-to-follows-its-destination"]);
    const unknownOk = { ...real, send: async (message: any) => real.send({ ...message, audience: message.audience === "everyone" ? "ask" : message.audience }) };
    assert.deepEqual(await failedChecks(unknownOk), ["unknown-audience-is-refused"]);
  });

  test("a provider that declares more destinations than there are audiences fails the shape check", async () => {
    const odd = createFakeProvider({ capabilities: { destinations: 3, edit: false, pin: false } });
    await assert.rejects(() => runProviderConformance(odd), (error: unknown) => error instanceof ConformanceError
      && error.failures.some((failure) => failure.check === "capabilities-shape" && /destinations/.test(failure.message)));
  });
});

describe("messaging.announcementsFile is the second destination, optional, and a secret reference like chairmanFile", () => {
  const HOME = join(scratch, "home");
  const base = { provider: "telegram", tokenFile: "~/.config/agent-org/telegram-token", chairmanFile: "~/.config/agent-org/telegram-chairman.json" };
  const parse = (messaging: Record<string, unknown>) => parseMessagingConfig({ messaging: { ...base, ...messaging } }, { home: HOME, root: scratch }) as any;

  test("absent is null (one destination); present resolves under ~/.config/agent-org like chairmanFile", () => {
    assert.equal(parse({}).announcementsFile, null);
    assert.equal(parse({ announcementsFile: "~/.config/agent-org/telegram-announcements.json" }).announcementsFile, join(HOME, ".config/agent-org/telegram-announcements.json"));
  });

  test("a path outside the secret directory, an empty string and a non-string are each a named refusal", () => {
    for (const bad of ["/etc/shadow", "~/.config/elsewhere/announcements.json", "", 7, null]) {
      assert.throws(() => parse({ announcementsFile: bad }), (error: unknown) => error instanceof MessagingConfigRefusal && error.field === "messaging.announcementsFile", String(bad));
    }
  });

  test("the key is known: it is not refused as an unknown key, and a misspelling still is", () => {
    assert.doesNotThrow(() => parse({ announcementsFile: "~/.config/agent-org/telegram-announcements.json" }));
    assert.throws(() => parse({ announcementFile: "~/.config/agent-org/x.json" }), (error: unknown) => error instanceof MessagingConfigRefusal && /unknown key/.test(error.message));
  });
});
