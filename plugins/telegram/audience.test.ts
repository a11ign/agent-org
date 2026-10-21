// no-token: none -- the token is a fixture string, the chat ids are made up, and `fetch` is a function that records its requests
//
// THE AUDIENCE OF A CHAIRMAN MESSAGE OVER TELEGRAM'S WIRE (a11ign/a11ign#4742, moved here by A11-162 from core's `messaging/audience.test.ts`, which now routes through the fake provider).
//
// The routing is read off the WIRE (`chat_id` of the request Telegram would have received), not off what the core believes it did, and the routing assertion is run once against a provider that
// IGNORES the audience to show it goes red (the control).
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";

import { createMessenger } from "../../src/messaging/core.ts";
import { createLedger } from "../../src/messaging/ledger.ts";
import { AUDIENCE, runProviderConformance } from "../../src/messaging/provider-contract.ts";
import { createSecret, redactingFetch } from "../../src/messaging/secret.ts";
import { createTelegramProvider as create } from "./send.ts";

/** The provider, with the core's `redactingFetch` that a plugin is given in `deps.messaging` (A11-162). */
const createTelegramProvider = (options: Omit<Parameters<typeof create>[0], "redactingFetch">) => create({ ...options, redactingFetch });

const START = Date.parse("2026-10-10T09:00:00Z");
const TOKEN = "123456789:AAFk3x9Q-test_token_value_ZZ";
const ASK_CHAT = 4242;
const CHANNEL_CHAT = -1009876543210;

const scratch = mkdtempSync(join(tmpdir(), "telegram-audience-"));
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
  const real = createTelegramProvider({ token: createSecret(TOKEN), chatId: ASK_CHAT, announcementsChatId, fetch: wire.fetch, sleep: async () => {}, log: () => {} });
  // These tests pin where each message goes, so they run the lifecycle without the asks' record (a11ign/a11ign#4745): the pinned list is a message of its own.
  const provider = { ...real, capabilities: { ...real.capabilities, edit: false, pin: false } };
  return { provider, requests: wire.requests };
}

/** A messenger over `provider`, with the clock fixed at START so a kind's hold-down is the only thing that can delay a send. */
function messengerOver(provider: any, config?: Parameters<typeof createMessenger>[0]["config"]) {
  const ledger = createLedger({ path: join(scratch, `ledger-${nextLedger += 1}.jsonl`), now: () => START });
  return createMessenger({ provider, ledger, now: () => START, config });
}

/** A request's key carries its row (`#1`): an ask with no row is refused at send (a11ign/a11ign#4745), and none of these tests is about that. */
function event(kind: string, more: Record<string, unknown> = {}) {
  const row = kind === "request" ? "#1" : "";
  return { key: `${kind}:audience-test${row}`, kind, severity: "info", firstSeenAt: START, text: `a ${kind} the chairman is told`, links: [], ...more };
}

/** The chat ids the requests went to, in order. */
const chatsOf = (requests: Wire[]) => requests.map((request) => request.body.chat_id);

describe("routing over the wire: with one destination both audiences reach the same chat, with two each reaches its own", () => {
  /** One ask and one announcement through the core, and where each went. */
  async function routedTo(provider: any, requests: Wire[]) {
    const decisions = await messengerOver(provider).tick([event("request"), event("release")]);
    assert.deepEqual(decisions.map((decision) => decision.action), ["sent", "sent"], "the positive control: both were sent");
    return chatsOf(requests);
  }

  test("only chairmanFile (no announcements chat): both audiences go to the chairman chat, exactly as today", async () => {
    const { provider, requests } = telegram();
    assert.equal(provider.capabilities.destinations, 1, "a provider with one destination says so");
    assert.deepEqual(await routedTo(provider, requests), [ASK_CHAT, ASK_CHAT]);
  });

  test("with both files: the ask goes to the chairman chat and the announcement to the channel", async () => {
    const { provider, requests } = telegram({ announcementsChatId: CHANNEL_CHAT });
    assert.equal(provider.capabilities.destinations, 2);
    assert.deepEqual(await routedTo(provider, requests), [ASK_CHAT, CHANNEL_CHAT]);
  });

  test("CONTROL: the routing assertion goes red when the audience is ignored", async () => {
    const { provider, requests } = telegram({ announcementsChatId: CHANNEL_CHAT });
    const deaf = { ...provider, send: (message: { text: string }) => provider.send({ ...message, audience: undefined }) };
    const chats = await routedTo(deaf, requests);
    assert.notDeepEqual(chats, [ASK_CHAT, CHANNEL_CHAT], "an ignored audience sends the announcement to the ask chat, and the test above would have failed");
    assert.deepEqual(chats, [ASK_CHAT, ASK_CHAT]);
  });
});

describe("an announcement is one-way on the wire", () => {
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

  test("a reply into the channel is refused; the same reply with no channel threads, as an incident's cleared always did", async () => {
    const withChannel = telegram({ announcementsChatId: CHANNEL_CHAT });
    await assert.rejects(() => withChannel.provider.send({ text: "cleared", audience: AUDIENCE.announcement, replyTo: "101" }), /one-way and carries no replyTo/);
    assert.deepEqual(withChannel.requests, []);
    const single = telegram();
    await single.provider.send({ text: "cleared", audience: AUDIENCE.announcement, replyTo: "101" });
    assert.equal(single.requests[0].body.reply_parameters.message_id, 101);
  });

  test("an incident's 'cleared' in the channel stands alone (no reply_parameters) and goes there; in one chat it threads as before", async () => {
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
});

describe("the contract holds the Telegram provider to the audience", () => {
  test("with and without a channel it passes, and the audience checks RAN", async () => {
    for (const provider of [telegram().provider, telegram({ announcementsChatId: CHANNEL_CHAT }).provider]) {
      const { passed } = await runProviderConformance(provider);
      for (const check of ["audience-is-honoured", "unknown-audience-is-refused", "announcement-refuses-actions", "announcement-reply-to-follows-its-destination"]) {
        assert.ok(passed.includes(check), `${check} did not run for destinations=${provider.capabilities.destinations}`);
      }
    }
  });
});
