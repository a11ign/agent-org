// @ts-check
// `messaging:pair` (a11ign/a11ign#2902 done-when 5), against an INJECTED `fetch` that plays Telegram's `getUpdates`, an INJECTED clock
// and a real temp directory, so the file mode asserted is the one the operating system actually gave. Nothing waits and nothing
// reaches a network.
//
// POSITIVE CONTROL (the row names it): the first test pairs and READS THE FILE BACK, so a pairing that always refuses cannot pass, and
// each refusal test is built from the same fixture with ONE thing changed (the code, the clock, the chat, the second use), so what
// differs between "written" and "not written" is that one thing.

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { createSecret } from "../../secret.mjs";
import { PAIRING_TTL_MS, REFUSAL, createPairingSession, generateCode, runPairing, writeChairmanFile } from "./pair.mjs";

const TOKEN = "123456789:AAFk3x9Q-test_token_value_ZZ";
const CODE = "K7M2QX9P4A";
const START = Date.parse("2026-10-02T10:00:00Z");
const MINUTE = 60_000;
const OWNER_ONLY = 0o600;

const scratch = mkdtempSync(join(tmpdir(), "messaging-pair-"));
after(() => rmSync(scratch, { recursive: true, force: true }));
let nextDirectory = 0;

/** @param {{ id?: number, chat?: number, type?: string, text: string, updateId: number }} fields */
function message({ id = 11, chat = id, type = "private", text, updateId }: { id?: number; chat?: number; type?: string; text: string; updateId: number; }) {
  return { update_id: updateId, message: { message_id: updateId, from: { id, is_bot: false }, chat: { id: chat, type }, text } };
}

/**
 * A pairing run on a clock the test owns. `batches` are what successive `getUpdates` calls return; a call after the script ends returns
 * nothing, and every sleep moves the clock, so a run with no correct code reaches its expiry instead of waiting for it.
 * @param {{ batches?: (any[] | Error)[], ttlMs?: number, onCall?: (call: number, clock: { advance(ms: number): void }) => void, token?: string }} [options]
 */
function harness({ batches = [], ttlMs, onCall, token = TOKEN }: { batches?: (any[] | Error)[]; ttlMs?: number; onCall?: (call: number, clock: { advance(ms: number): void; }) => void; token?: string; } = {}) {
  let at = START;
  const clock = { now: () => at, advance: (/** @type {number} */ ms: number) => { at += ms; } };
  const directory = join(scratch, `run-${nextDirectory += 1}`);
  const chairmanFile = join(directory, "telegram-chairman");
  /** @type {Record<string, any>[]} */
  const requests: Record<string, any>[] = [];
  /** @type {string[]} */
  const printed: string[] = [];
  const script = [...batches];
  const fetchImpl = /** @type {typeof fetch} */ (/** @type {unknown} */ (async (/** @type {string} */ url: string, /** @type {{ body: string }} */ init: { body: string; }) => {
    requests.push({ url, ...JSON.parse(init.body) });
    onCall?.(requests.length, clock);
    const next = script.shift() ?? [];
    if (next instanceof Error) throw next;
    return { ok: true, status: 200, json: async () => ({ ok: true, result: next }) };
  }));
  const run = () => runPairing({
    token: createSecret(token), chairmanFile, fetch: fetchImpl, now: clock.now, ttlMs, code: CODE,
    sleep: async (ms) => { clock.advance(ms); }, print: (line) => { printed.push(line); },
  });
  return { run, clock, chairmanFile, directory, requests, printed };
}

/** @param {string} file @returns {{ userId: number, chatId: number, pairedAt: string }} */
const readChairman = (file: string): { userId: number; chatId: number; pairedAt: string; } => JSON.parse(readFileSync(file, "utf8"));

test("done-when 5: the right code from a sender writes chairmanFile, mode 0600, with that sender's user id and chat id", async () => {
  const pairing = harness({ batches: [[message({ id: 5150, chat: 5150, text: `/pair ${CODE}`, updateId: 900 })]] });
  const result = await pairing.run();
  assert.deepEqual(result, { paired: true, userId: 5150, chatId: 5150 });
  assert.equal(statSync(pairing.chairmanFile).mode & 0o777, OWNER_ONLY);
  const written = readChairman(pairing.chairmanFile);
  assert.equal(written.userId, 5150);
  assert.equal(written.chatId, 5150);
  assert.equal(written.pairedAt, new Date(START).toISOString());
  assert.ok(pairing.printed[0].includes(`/pair ${CODE}`), "the host did not print the code to send");
});

test("the file is 0600 under a permissive umask, replaces an older one, and leaves no temporary file beside it", () => {
  const { directory, chairmanFile } = harness();
  const previous = process.umask(0);
  try {
    writeChairmanFile(chairmanFile, { userId: 1, chatId: 2 }, { now: () => START });
    writeChairmanFile(chairmanFile, { userId: 3, chatId: 4 }, { now: () => START });
  } finally {
    process.umask(previous);
  }
  assert.equal(statSync(chairmanFile).mode & 0o777, OWNER_ONLY);
  assert.equal(readChairman(chairmanFile).userId, 3);
  assert.deepEqual(readdirSync(directory), ["telegram-chairman"]);
});

test("done-when 5: a wrong code writes nothing and says why, and does not stop the right sender from pairing afterwards", async () => {
  const wrong = harness({ batches: [[message({ id: 666, text: "/pair AAAAAAAAAA", updateId: 1 })]], ttlMs: 2 * MINUTE });
  const refused = await wrong.run();
  assert.equal(refused.paired, false);
  assert.equal(existsSync(wrong.chairmanFile), false);
  assert.ok(wrong.printed.some((line) => line.includes(REFUSAL.wrong) && line.includes("nothing was written")), wrong.printed.join("\n"));
  assert.ok(wrong.printed.every((line) => !line.includes("AAAAAAAAAA")), "the stranger's guess was echoed");

  const afterwards = harness({ batches: [[message({ id: 666, text: "/pair AAAAAAAAAA", updateId: 1 })], [message({ id: 5150, text: `/pair ${CODE}`, updateId: 2 })]] });
  assert.deepEqual(await afterwards.run(), { paired: true, userId: 5150, chatId: 5150 });
  assert.equal(readChairman(afterwards.chairmanFile).userId, 5150, "the wrong sender's ids were recorded");
});

test("done-when 5: an expired code writes nothing and says so, even when it is the right code", async () => {
  // The first poll finds nothing and the clock then passes the ten minutes; the right code arrives on the poll after.
  const late = harness({
    batches: [[], [message({ text: `/pair ${CODE}`, updateId: 3 })]],
    onCall: (call, clock) => { if (call === 2) clock.advance(PAIRING_TTL_MS + 1); },
  });
  const result = await late.run();
  assert.deepEqual(result, { paired: false, reason: REFUSAL.expired });
  assert.equal(existsSync(late.chairmanFile), false);
  assert.ok(late.printed.some((line) => line.includes(REFUSAL.expired)));
});

test("an expired session refuses BEFORE comparing the code: a late guess learns 'expired', never 'wrong'", () => {
  let at = START;
  const session = createPairingSession({ code: CODE, now: () => at });
  at += PAIRING_TTL_MS;
  const verdict = session.attempt(message({ text: "/pair NOTTHECODE", updateId: 1 }));
  assert.deepEqual(verdict, { outcome: "refused", reason: REFUSAL.expired });
  const rightOne = createPairingSession({ code: CODE, now: () => at });
  at += PAIRING_TTL_MS - 1;
  assert.equal(rightOne.attempt(message({ text: `/pair ${CODE}`, updateId: 2 })).outcome, "paired", "the code was refused one millisecond before it expires");
});

test("done-when 5: a reused code writes nothing: the session pairs once, and two correct codes in one batch pair the first sender only", async () => {
  const session = createPairingSession({ code: CODE, now: () => START });
  assert.equal(session.attempt(message({ id: 1, text: `/pair ${CODE}`, updateId: 1 })).outcome, "paired");
  assert.deepEqual(session.attempt(message({ id: 1, text: `/pair ${CODE}`, updateId: 2 })), { outcome: "refused", reason: REFUSAL.used });
  assert.deepEqual(session.attempt(message({ id: 2, text: `/pair ${CODE}`, updateId: 3 })), { outcome: "refused", reason: REFUSAL.used });

  const race = harness({ batches: [[message({ id: 111, text: `/pair ${CODE}`, updateId: 1 }), message({ id: 222, text: `/pair ${CODE}`, updateId: 2 })]] });
  assert.equal((await race.run()).paired, true);
  assert.equal(readChairman(race.chairmanFile).userId, 111, "the second sender displaced the first");
  assert.ok(race.printed.some((line) => line.includes(REFUSAL.used)));
});

test("a /pair from a group, and messages that are not /pair at all, are not accepted; the group one is refused with its reason", async () => {
  const group = harness({ batches: [[message({ id: 5150, chat: -100, type: "supergroup", text: `/pair ${CODE}`, updateId: 1 })]], ttlMs: MINUTE });
  assert.equal((await group.run()).paired, false);
  assert.equal(existsSync(group.chairmanFile), false);
  assert.ok(group.printed.some((line) => line.includes(REFUSAL.notPrivate)));

  const chatter = harness({ batches: [[message({ text: "hello", updateId: 1 }), message({ text: `${CODE}`, updateId: 2 }), message({ text: `please /pair ${CODE}`, updateId: 3 }), { update_id: 4, edited_message: {} }]], ttlMs: MINUTE });
  assert.equal((await chatter.run()).paired, false);
  assert.ok(chatter.printed.every((line) => !/refused/.test(line)), "ordinary chat was reported as a refused pairing");
});

test("the /pair@botname form works, a trailing space is allowed, and the code must match whole (a prefix or a longer string is wrong)", () => {
  const session = () => createPairingSession({ code: CODE, now: () => START });
  assert.equal(session().attempt(message({ text: `/pair@my_bot ${CODE} `, updateId: 1 })).outcome, "paired");
  assert.equal(session().attempt(message({ text: `/pair ${CODE.slice(0, -1)}`, updateId: 1 })).outcome, "refused");
  assert.equal(session().attempt(message({ text: `/pair ${CODE}Z`, updateId: 1 })).outcome, "refused");
  assert.equal(session().attempt(message({ text: `/pair ${CODE.toLowerCase()}`, updateId: 1 })).outcome, "refused");
});

test("updates are acknowledged by offset as they are read, and the batch with /pair is confirmed so the listener never sees it", async () => {
  const pairing = harness({ batches: [[message({ text: "hi", updateId: 40 })], [message({ text: `/pair ${CODE}`, updateId: 41 })]] });
  await pairing.run();
  assert.deepEqual(pairing.requests.map((request) => request.offset), [undefined, 41, 42]);
  assert.equal(pairing.requests.at(-1)?.timeout, 0, "the confirming call must not long-poll");
  assert.ok(pairing.requests.every((request) => request.url.endsWith("/getUpdates") && JSON.stringify(request.allowed_updates) === '["message"]'));
});

test("the token is in no thrown or printed string when getUpdates fails (its URL carries it), and a 409 says another poller is running", async () => {
  const cause = new Error(`connect failed: https://api.telegram.org/bot${TOKEN}/getUpdates`);
  const down = harness({ batches: [new TypeError(`fetch failed for https://api.telegram.org/bot${TOKEN}/getUpdates`, { cause })] });
  const error = await down.run().then(() => assert.fail("expected a rejection"), (caught: any) => caught);
  assert.deepEqual([error.message, String(error.stack), ...down.printed].filter((text) => text.includes(TOKEN) || text.includes("AAFk3x9Q")), []);
  assert.match(error.message, /connect failed/, "the scrub dropped the whole message, so 'no token' proves nothing");
  assert.equal(error.cause, undefined);

  const conflict = harness({ token: TOKEN });
  const refusing = /** @type {typeof fetch} */ (/** @type {unknown} */ (async () => ({ ok: false, status: 409, json: async () => ({ ok: false, error_code: 409, description: "Conflict: terminated by other getUpdates request" }) })));
  const clash = await runPairing({ token: createSecret(TOKEN), chairmanFile: conflict.chairmanFile, fetch: refusing, print: () => {}, code: CODE }).then(() => assert.fail("expected a rejection"), (caught: any) => caught);
  assert.match(clash.message, /409/);
  assert.match(clash.message, /another process is polling/);
});

test("a code is ten characters from an alphabet without look-alikes, and two codes differ", () => {
  const codes = Array.from({ length: 50 }, () => generateCode());
  for (const code of codes) assert.match(code, /^[2-9A-HJKMNP-Z]{10}$/);
  assert.ok(new Set(codes).size > 45, "codes repeat");
  assert.ok(!/[01OIL]/.test(codes.join("")));
});

test("a session refuses an empty code, so 'every guess matches' cannot be configured", () => {
  assert.throws(() => createPairingSession({ code: "", now: () => START }), /non-empty/);
});
