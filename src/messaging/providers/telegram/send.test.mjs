// @ts-check
// THE TELEGRAM PROVIDER'S SEND (a11ign/a11ign#2902 done-whens 1-4 and 6), against an INJECTED `fetch` and an INJECTED sleep: no network,
// and nothing here waits. Every request the provider makes is recorded, so each test asserts what Telegram would have RECEIVED, which
// is the one thing `runProviderConformance` cannot see.
//
// POSITIVE CONTROLS: the first test sends and conformance passes with its checks RUN, not skipped; the retry test sits beside the
// 400 test (a provider that never retries and one that always retries are each caught by one of them); the token tests send the same
// failure shapes with the token present, and assert the scrubbed marker is there, so "the token is absent" is not "nothing was logged".

import assert from "node:assert/strict";
import { test } from "node:test";

import { runProviderConformance } from "../../provider-contract.mjs";
import { createSecret } from "../../secret.mjs";
import { MAX_PARTS, TELEGRAM_MAX_MESSAGE, TelegramSendError, createTelegramProvider, splitText } from "./send.mjs";

const TOKEN = "123456789:AAFk3x9Q-test_token_value_ZZ";
const CHAT_ID = 4242;
const RETRY_AFTER_SECONDS = 7;
const MS = 1000;

/** @typedef {{ url: string, body: Record<string, any> }} Request */
/** @typedef {{ status?: number, body?: Record<string, any>, headers?: Record<string, string> } | Error} Reply */

/**
 * A fetch that answers from a script, then with success. `requests` is what was sent; each success carries a fresh message id.
 * @param {Reply[]} [script]
 */
function fakeTelegram(script = []) {
  /** @type {Request[]} */
  const requests = [];
  let nextMessageId = 100;
  const fetchImpl = /** @type {typeof fetch} */ (/** @type {unknown} */ (async (/** @type {string} */ url, /** @type {{ body: string }} */ init) => {
    requests.push({ url, body: JSON.parse(init.body) });
    const reply = script.shift();
    if (reply instanceof Error) throw reply;
    const status = reply?.status ?? 200;
    const body = reply?.body ?? { ok: true, result: { message_id: nextMessageId += 1 } };
    const headers = reply?.headers ?? {};
    return { ok: status >= 200 && status < 300, status, json: async () => body, headers: { get: (/** @type {string} */ name) => headers[name.toLowerCase()] ?? null } };
  }));
  return { fetch: fetchImpl, requests };
}

/** @param {{ script?: Reply[], token?: string }} [options] */
function harness({ script, token = TOKEN } = {}) {
  const telegram = fakeTelegram(script);
  /** @type {number[]} */
  const sleeps = [];
  /** @type {string[]} */
  const logged = [];
  const provider = createTelegramProvider({
    token: createSecret(token), chatId: CHAT_ID, fetch: telegram.fetch,
    sleep: async (ms) => { sleeps.push(ms); }, log: (line) => { logged.push(line); },
  });
  return { provider, requests: telegram.requests, sleeps, logged };
}

/** @param {() => Promise<unknown>} action @returns {Promise<any>} what it rejected with, failing if it did not */
async function rejection(action) {
  try {
    await action();
  } catch (error) {
    return error;
  }
  return assert.fail("expected a rejection and there was none");
}

test("done-when 1: the provider passes runProviderConformance, and the checks it names actually RAN", async () => {
  const { provider } = harness();
  const { passed, skipped } = await runProviderConformance(provider);
  for (const check of ["send-returns-message-ref", "message-refs-are-distinct", "silent-is-honoured", "max-text-is-enforced", "max-text-is-accepted-at-the-limit", "reply-to-is-accepted"]) {
    assert.ok(passed.includes(check), `${check} did not run: ${JSON.stringify({ passed, skipped })}`);
  }
  // Declared absent and not half-built: rows 8 and 9. They are skipped WITH their reasons, never silently passed.
  assert.deepEqual(skipped.map((entry) => entry.check).sort(), ["actions-are-accepted", "poll-returns-updates-and-honours-abort"]);
});

test("done-when 2: a silent message carries disable_notification: true on the wire, an ordinary one carries no such key", async () => {
  const { provider, requests } = harness();
  const quiet = await provider.send({ text: "the summary", silent: true });
  const loud = await provider.send({ text: "a request" });
  assert.equal(requests.length, 2);
  assert.equal(requests[0].body.disable_notification, true);
  assert.equal(quiet.silent, true);
  assert.equal("disable_notification" in requests[1].body, false);
  assert.equal(loud.silent, false);
});

test("the request is PLAIN TEXT: no parse_mode, whatever the text holds, and it is addressed to the paired chat", async () => {
  const { provider, requests } = harness();
  await provider.send({ text: "*bold* _x_ <b>y</b> [link](http://x) `code` \\ & </a>" });
  assert.equal("parse_mode" in requests[0].body, false);
  assert.equal(requests[0].body.text, "*bold* _x_ <b>y</b> [link](http://x) `code` \\ & </a>");
  assert.equal(requests[0].body.chat_id, CHAT_ID);
  assert.equal(requests[0].url, `https://api.telegram.org/bot${TOKEN}/sendMessage`);
});

test("a reply names the message it answers, and a first part only", async () => {
  const { provider, requests } = harness();
  await provider.send({ text: `${"a".repeat(TELEGRAM_MAX_MESSAGE)}\nsecond`, replyTo: "77" });
  assert.equal(requests.length, 2);
  assert.equal(requests[0].body.reply_parameters.message_id, 77);
  assert.equal("reply_parameters" in requests[1].body, false);
});

/** 91 lines of 99 characters and a newline: 9,100 characters in all, 9,009 without the last newline. */
const NINE_THOUSAND = Array.from({ length: 91 }, (_, line) => String(line).padStart(2, "0").padEnd(99, "x")).join("\n");

test("done-when 3: a 9,000-character message is sent as three, each at most 4,096, split on a newline", async () => {
  assert.ok(NINE_THOUSAND.length >= 9000 && NINE_THOUSAND.length < 9100);
  const { provider, requests, sleeps } = harness();
  const result = await provider.send({ text: NINE_THOUSAND });
  assert.equal(requests.length, 3);
  const texts = requests.map((request) => request.body.text);
  for (const text of texts) assert.ok(text.length <= TELEGRAM_MAX_MESSAGE, `a part is ${text.length} characters`);
  // On a newline: no line is cut, and putting the newlines back reproduces the original exactly.
  for (const text of texts) assert.ok(text.split("\n").every((/** @type {string} */ line) => line.length === 99), "a line was cut in the middle");
  assert.equal(texts.join("\n"), NINE_THOUSAND);
  // The parts keep to Telegram's one-a-second pace, and the message's ref is its first part's.
  assert.deepEqual(sleeps, [MS, MS]);
  assert.equal(result.messageRef, "101");
  assert.deepEqual(result.messageRefs, ["101", "102", "103"]);
});

test("splitText: a line longer than the limit is cut at the limit, a surrogate pair is never halved, and nothing is lost", () => {
  const tall = "y".repeat(10);
  assert.deepEqual(splitText(tall, 4), ["yyyy", "yyyy", "yy"]);
  assert.deepEqual(splitText("ab\ncd\nef", 5), ["ab\ncd", "ef"]);
  const pairs = "😀".repeat(5);
  for (const part of splitText(pairs, 3)) assert.ok(!/[\ud800-\udbff]$/.test(part) && !/^[\udc00-\udfff]/.test(part), "a pair was cut in half");
  assert.equal(splitText("😀".repeat(5), 3).join(""), pairs);
  assert.deepEqual(splitText("short"), ["short"]);
  assert.deepEqual(splitText(`${"z".repeat(3)}\n\n${"w".repeat(3)}`, 4), ["zzz\n", "www"]);
});

test("a text that would need more than the declared parts is refused whole, not cut; empty text is refused", async () => {
  const { provider, requests } = harness();
  assert.equal(provider.capabilities.maxText, TELEGRAM_MAX_MESSAGE * MAX_PARTS);
  await rejection(() => provider.send({ text: "x".repeat(provider.capabilities.maxText + 1) }));
  await rejection(() => provider.send({ text: "" }));
  assert.equal(requests.length, 0, "a refused text reached the network");
});

test("a part that fails after earlier parts went says so, so a retried send's duplicate has a visible cause", async () => {
  const { provider, requests } = harness({ script: [{}, { status: 400, body: { ok: false, error_code: 400, description: "Bad Request: nope" } }] });
  const error = await rejection(() => provider.send({ text: NINE_THOUSAND }));
  assert.ok(error instanceof TelegramSendError);
  assert.match(error.message, /part 2 of 3; the 1 before it WERE delivered/);
  assert.equal(requests.length, 2, "the third part was sent after the second failed");
});

test("done-when 4: a 429 with retry_after 7 waits 7 seconds on the injected clock and sends once more", async () => {
  const { provider, requests, sleeps, logged } = harness({
    script: [{ status: 429, body: { ok: false, error_code: 429, description: "Too Many Requests: retry after 7", parameters: { retry_after: RETRY_AFTER_SECONDS } } }],
  });
  const result = await provider.send({ text: "hello" });
  assert.deepEqual(sleeps, [RETRY_AFTER_SECONDS * MS]);
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[1].body, requests[0].body, "the retry is the same message");
  assert.equal(result.messageRef, "101");
  assert.match(logged.join("\n"), /429, waiting 7s/);
});

test("a 429 that is still a 429 after the one retry fails and does not loop; a retry_after beyond a tick is not waited for", async () => {
  const tooMany = (/** @type {number} */ seconds) => ({ status: 429, body: { ok: false, error_code: 429, description: "Too Many Requests", parameters: { retry_after: seconds } } });
  const twice = harness({ script: [tooMany(1), tooMany(1)] });
  const error = await rejection(() => twice.provider.send({ text: "hello" }));
  assert.equal(error.status, 429);
  assert.equal(twice.requests.length, 2, "more than one retry");
  assert.deepEqual(twice.sleeps, [MS]);

  const long = harness({ script: [tooMany(3600)] });
  await rejection(() => long.provider.send({ text: "hello" }));
  assert.equal(long.requests.length, 1);
  assert.deepEqual(long.sleeps, [], "an hour was waited for inside a tick");
});

test("retry_after may arrive as a Retry-After header when the body has none", async () => {
  const { provider, sleeps } = harness({ script: [{ status: 429, body: { ok: false, error_code: 429, description: "Too Many Requests" }, headers: { "retry-after": "3" } }] });
  await provider.send({ text: "hello" });
  assert.deepEqual(sleeps, [3 * MS]);
});

test("done-when 4: a 400 is logged and NOT retried (nor is a 403, or a 500)", async () => {
  for (const status of [400, 403, 500]) {
    const { provider, requests, sleeps, logged } = harness({ script: [{ status, body: { ok: false, error_code: status, description: `Telegram says ${status}` } }] });
    const error = await rejection(() => provider.send({ text: "hello" }));
    assert.equal(error.status, status);
    assert.equal(requests.length, 1, `a ${status} was retried`);
    assert.deepEqual(sleeps, []);
    assert.equal(logged.length, 1);
    assert.match(logged[0], new RegExp(`${status} Telegram says ${status}`));
    assert.match(logged[0], /not retried/);
  }
});

test("a reply that is not Telegram's JSON is a failure with its status, not a crash", async () => {
  const fetchImpl = /** @type {typeof fetch} */ (/** @type {unknown} */ (async () => ({ ok: false, status: 502, json: async () => { throw new SyntaxError("<html>"); }, headers: { get: () => null } })));
  const provider = createTelegramProvider({ token: createSecret(TOKEN), chatId: CHAT_ID, fetch: fetchImpl, sleep: async () => {}, log: () => {} });
  const error = await rejection(() => provider.send({ text: "hello" }));
  assert.match(error.message, /502/);
});

/** @param {string[]} strings @returns {string[]} the ones that hold the token or a recognisable piece of it */
const leaking = (strings) => strings.filter((text) => text.includes(TOKEN) || text.includes("AAFk3x9Q") || text.includes("123456789:"));

test("done-when 6: the token is in no logged or thrown string when fetch itself fails, cause chain included", async () => {
  const cause = new Error(`getaddrinfo ENOTFOUND api.telegram.org (request to https://api.telegram.org/bot${TOKEN}/sendMessage failed)`);
  const failure = new TypeError(`fetch failed for https://api.telegram.org/bot${TOKEN}/sendMessage`, { cause });
  const { provider, logged } = harness({ script: [failure] });
  const error = await rejection(() => provider.send({ text: "hello" }));
  const everything = [error.message, String(error), error.stack ?? "", JSON.stringify(error), ...logged];
  assert.deepEqual(leaking(everything), []);
  assert.equal(error.cause, undefined, "a cause would carry the unscrubbed URL one property away");
  assert.match(error.message, /ENOTFOUND/, "the scrub removed the cause as well as the token, so 'no token' proves nothing");
  assert.match(logged[0] ?? error.message, /redacted/);
});

test("done-when 6: the token is in no string when Telegram's own description or a 429 path echoes it", async () => {
  const echoing = { status: 401, body: { ok: false, error_code: 401, description: `Unauthorized: bot${TOKEN} revoked, token=${TOKEN}` } };
  const first = harness({ script: [echoing] });
  const error = await rejection(() => first.provider.send({ text: "hello" }));
  assert.deepEqual(leaking([error.message, ...first.logged]), []);
  assert.match(error.message, /Unauthorized/, "the description was dropped wholesale, so this proves nothing");

  const second = harness({ script: [{ status: 429, body: { ok: false, error_code: 429, description: `retry ${TOKEN}`, parameters: { retry_after: 1 } } }, echoing] });
  const afterRetry = await rejection(() => second.provider.send({ text: "hello" }));
  assert.deepEqual(leaking([afterRetry.message, ...second.logged]), []);
  assert.ok(second.logged.length >= 2, "the 429 path logged nothing, so it was not exercised");
});

test("the token is scrubbed by its own value even when it has no shape a pattern knows", async () => {
  const odd = "plainsecret-9";
  const { provider, logged } = harness({ token: odd, script: [new Error(`connect to https://api.telegram.org/bot${odd}/sendMessage refused`)] });
  const error = await rejection(() => provider.send({ text: "hello" }));
  assert.equal([error.message, ...logged].some((text) => text.includes(odd)), false);
  assert.match(error.message, /refused/);
});

test("a provider is built from a Secret and a chat, and refuses a bare string token", () => {
  assert.throws(() => createTelegramProvider({ token: /** @type {any} */ (TOKEN), chatId: CHAT_ID }), /Secret/);
  assert.throws(() => createTelegramProvider({ token: createSecret(TOKEN), chatId: /** @type {any} */ (undefined) }), /chatId/);
});
