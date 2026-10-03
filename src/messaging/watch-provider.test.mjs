// @ts-check
// THE SHIPPED COMPOSITION OF `messaging:watch` CAN SEND (a11ign/a11ign#3164). Every other test of `main` injects its own provider, which is how
// the real default stayed EMPTY until the `chairman-watch` unit's first firing: it exited 1 with "no implementation of it yet" and the chairman had
// nothing on Telegram. Here `main` is called with NO `providers` argument, over a real token file and a real chairman file in a temporary home, and
// only the network is replaced: an injected `fetch` that records what Telegram would have received.
//
// POSITIVE CONTROLS: the first test sends, so "the token is in no line" and "nothing was fetched" below are not a run that never reached the provider.
// The refusals each sit beside it with the SAME fixture but for the one file made wrong, so a refusal that fires on every run is caught by the first test.

import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";

import { readLedgerLines } from "./ledger.mjs";
import { defaultLedgerPath } from "./state.mjs";
import { main } from "./watch.mjs";

const REPO = "a11ign/a11ign";
const TOKEN = "123456789:AAFk3x9Q-test_token_value_ZZ";
const CHAT_ID = 4242;
const OWNER_ONLY = 0o600;
const GROUP_READABLE = 0o644;
const EXIT = { ok: 0, failed: 1 };
const NOW = Date.parse("2026-10-02T09:00:00Z");

const scratch = mkdtempSync(join(tmpdir(), "messaging-watch-provider-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

/**
 * A checkout whose `messaging` key is on, and a home holding the two files that key names.
 * @param {{ tokenMode?: number, paired?: boolean }} [options]
 * @returns {{ root: string, home: string }}
 */
function host({ tokenMode = OWNER_ONLY, paired = true } = {}) {
  const root = mkdtempSync(join(scratch, "root-"));
  const home = mkdtempSync(join(scratch, "home-"));
  mkdirSync(join(root, ".agent-org"));
  const messaging = { provider: "telegram", tokenFile: "~/.config/agent-org/telegram-token", chairmanFile: "~/.config/agent-org/telegram-chairman" };
  writeFileSync(join(root, ".agent-org", "project.json"), JSON.stringify({ tracker: [{ key: "", repo: REPO }], messaging }));
  const secrets = join(home, ".config", "agent-org");
  mkdirSync(secrets, { recursive: true });
  writeFileSync(join(secrets, "telegram-token"), `${TOKEN}\n`);
  chmodSync(join(secrets, "telegram-token"), tokenMode);
  if (paired) {
    writeFileSync(join(secrets, "telegram-chairman"), JSON.stringify({ userId: CHAT_ID, chatId: CHAT_ID }));
    chmodSync(join(secrets, "telegram-chairman"), OWNER_ONLY);
  }
  return { root, home };
}

/** A GitHub reader with one row waiting on the chairman: the same rows `requests.test.mjs` sends for, so exactly one request is due. */
const github = /** @type {any} */ ({
  issuesLabelled: async (/** @type {{ label: string }} */ query) => (query.label === "needs:chairman"
    ? [{ number: 2885, title: "Row 2885 needs a decision", url: `https://github.com/${REPO}/issues/2885`, comments: [] }] : []),
  issueComments: async () => [],
  mergedPullsSince: async () => [],
  redPulls: async () => [],
});

/** A Telegram that answers every `sendMessage`. `requests` is what it received. */
function fakeTelegram() {
  const requests = /** @type {string[]} */ ([]);
  const fetchImpl = /** @type {typeof fetch} */ (/** @type {unknown} */ (async (/** @type {string} */ url) => {
    requests.push(url);
    return { ok: true, status: 200, headers: new Headers(), json: async () => ({ ok: true, result: { message_id: requests.length } }), text: async () => "" };
  }));
  return { requests, fetchImpl };
}

/** @param {{ root: string, home: string }} world @param {typeof fetch} fetchImpl */
async function run({ root, home }, fetchImpl) {
  const sink = { out: /** @type {string[]} */ ([]), err: /** @type {string[]} */ ([]) };
  const code = await main({ root, home, env: { GH_CONFIG_DIR: "/x/gh" }, github, fetch: fetchImpl, now: () => NOW, out: (l) => sink.out.push(l), err: (l) => sink.err.push(l) });
  return { code, ...sink, lines: [...sink.out, ...sink.err].join("\n") };
}

describe("main with the registry it SHIPS (no `providers` argument)", () => {
  test("it builds the Telegram provider from the two files and sends: the request goes to /sendMessage, and the token is in no line it writes", async () => {
    const world = host();
    const telegram = fakeTelegram();
    const result = await run(world, telegram.fetchImpl);
    assert.equal(result.code, EXIT.ok, result.lines);
    assert.ok(telegram.requests.length >= 1, "something was sent: the chairman has a request waiting");
    for (const url of telegram.requests) assert.match(url, /\/sendMessage$/);
    assert.ok(telegram.requests[0].includes(`/bot${TOKEN}/`), "the token is in the URL by Telegram's design, and so it is the only place");
    assert.doesNotMatch(result.lines, new RegExp(TOKEN.split(":")[1]), "no line carries the token");
    assert.ok(readLedgerLines(defaultLedgerPath(world.home)).length >= 1, "the delivery was recorded");
  });

  test("a token file at mode 0644 is refused with a line naming the file, exit 1, nothing fetched, the token in no line", async () => {
    const world = host({ tokenMode: GROUP_READABLE });
    const telegram = fakeTelegram();
    const result = await run(world, telegram.fetchImpl);
    assert.equal(result.code, EXIT.failed);
    assert.match(result.err.join("\n"), /telegram-token/);
    assert.doesNotMatch(result.lines, new RegExp(TOKEN.split(":")[1]));
    assert.equal(telegram.requests.length, 0);
  });

  test("a checkout never paired is refused with a line naming the chairman file, exit 1, nothing fetched", async () => {
    const world = host({ paired: false });
    const telegram = fakeTelegram();
    const result = await run(world, telegram.fetchImpl);
    assert.equal(result.code, EXIT.failed);
    assert.match(result.err.join("\n"), /telegram-chairman/);
    assert.equal(telegram.requests.length, 0);
  });
});
