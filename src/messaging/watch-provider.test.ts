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
 * @param {{ tokenMode?: number, paired?: boolean, summary?: { at?: string, timezone?: string } }} [options] `summary` is the opt-in key, absent unless given
 * @returns {{ root: string, home: string }}
 */
function host({ tokenMode = OWNER_ONLY, paired = true, summary = undefined }: { tokenMode?: number; paired?: boolean; summary?: { at?: string; timezone?: string; }; } = {}): { root: string; home: string; } {
  const root = mkdtempSync(join(scratch, "root-"));
  const home = mkdtempSync(join(scratch, "home-"));
  mkdirSync(join(root, ".agent-org"));
  const messaging = { provider: "telegram", tokenFile: "~/.config/agent-org/telegram-token", chairmanFile: "~/.config/agent-org/telegram-chairman" };
  writeFileSync(join(root, ".agent-org", "project.json"), JSON.stringify({ tracker: [{ key: "", repo: REPO }], messaging: summary === undefined ? messaging : { ...messaging, summary } }));
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
  issuesLabelled: async (/** @type {{ label: string }} */ query: { label: string; }) => (query.label === "needs:chairman"
    ? [{ number: 2885, title: "Row 2885 needs a decision", url: `https://github.com/${REPO}/issues/2885`, comments: [] }] : []),
  issueComments: async () => [],
  mergedPullsSince: async () => [],
  redPulls: async () => [],
});

/** A Telegram that answers every `sendMessage`. `requests` is the URLs it received and `bodies` the payloads. */
function fakeTelegram() {
  const requests = /** @type {string[]} */ ([]);
  const bodies = /** @type {Record<string, any>[]} */ ([]);
  const fetchImpl = /** @type {typeof fetch} */ (/** @type {unknown} */ (async (/** @type {string} */ url: string, /** @type {{ body?: string }} */ init: { body?: string; }) => {
    requests.push(url);
    bodies.push(JSON.parse(init?.body ?? "{}"));
    return { ok: true, status: 200, headers: new Headers(), json: async () => ({ ok: true, result: { message_id: requests.length } }), text: async () => "" };
  }));
  return { requests, bodies, fetchImpl };
}

/** @param {{ root: string, home: string }} world @param {typeof fetch} fetchImpl */
async function run({ root, home }: { root: string; home: string; }, fetchImpl: typeof fetch) {
  const sink = { out: /** @type {string[]} */ ([]), err: /** @type {string[]} */ ([]) };
  const code = await main({ root, home, env: { GH_CONFIG_DIR: "/x/gh" }, github, fetch: fetchImpl, now: () => NOW, out: (l) => sink.out.push(l), err: (l) => sink.err.push(l) });
  return { code, ...sink, lines: [...sink.out, ...sink.err].join("\n") };
}

describe("main with the registry it SHIPS (no `providers` argument)", () => {
  test("it builds the Telegram provider from the two files and sends: the request goes to /sendMessage, and the token is in no line it writes", async () => {
    const world = host({ summary: {} }); // the summary is opt-in (#3410), and it is what this fixture sends
    const telegram = fakeTelegram();
    const result = await run(world, telegram.fetchImpl);
    assert.equal(result.code, EXIT.ok, result.lines);
    assert.ok(telegram.requests.length >= 1, "something was sent: the declared summary is due");
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

/** @param {string} home @returns {string[]} the keys of the `summary:` lines in the ledger */
function summaryKeys(home: string): string[] {
  return readLedgerLines(defaultLedgerPath(home)).map((line) => String(line.key)).filter((key) => key.startsWith("summary:"));
}

// NOW is 10:00 London on 2026-10-02: past 08:00, so a summary that was going to be sent is due. The `github` fixture's request is NOT sendable (the row
// has no brief from an org account), so before #3410 the summary was the one thing these runs sent, and it is what the first test above now declares.
describe("the daily summary is opt-in: absent means off (#3410, chairman 2026-10-04)", () => {
  test("a config with no `summary` key sends NO summary, though 08:00 London has passed (fails on the code that defaulted to it)", async () => {
    const world = host();
    const telegram = fakeTelegram();
    const result = await run(world, telegram.fetchImpl);
    assert.equal(result.code, EXIT.ok, result.lines);
    assert.deepEqual(telegram.requests, [], "nothing at all was sent");
    assert.deepEqual(summaryKeys(world.home), []);
    assert.ok(readLedgerLines(defaultLedgerPath(world.home)).length >= 1, "the run did read and write the ledger (the fixture's unsendable request is noted), so the empty list above is not an unrun watcher");
  });

  test("a config WITH `summary` sends exactly one per local date, and it is silent (the control that keeps the opt-in from being deleted)", async () => {
    const world = host({ summary: { at: "08:00", timezone: "Europe/London" } });
    const telegram = fakeTelegram();
    await run(world, telegram.fetchImpl);
    await run(world, telegram.fetchImpl);
    assert.deepEqual(summaryKeys(world.home), ["summary:2026-10-02"], "one key, though the watcher ran twice on that date");
    const silent = telegram.bodies.filter((body) => body.disable_notification === true);
    assert.equal(silent.length, 1, "exactly one message was sent silent, and it is the summary");
  });

  test("a summary key before its time sends nothing yet, and `{}` declares the 08:00 London one", async () => {
    const early = host({ summary: { at: "23:59", timezone: "Europe/London" } });
    await run(early, fakeTelegram().fetchImpl);
    assert.deepEqual(summaryKeys(early.home), [], "declared but not yet due");
    const declared = host({ summary: {} });
    await run(declared, fakeTelegram().fetchImpl);
    assert.deepEqual(summaryKeys(declared.home), ["summary:2026-10-02"]);
  });

  test("a malformed `summary` is still refused, and nothing is sent", async () => {
    const world = host({ summary: { at: "8am" } });
    const telegram = fakeTelegram();
    const result = await run(world, telegram.fetchImpl);
    assert.equal(result.code, 2);
    assert.match(result.err.join("\n"), /messaging\.summary\.at/);
    assert.equal(telegram.requests.length, 0);
  });
});
