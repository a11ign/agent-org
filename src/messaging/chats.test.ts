// @ts-check
// `messaging:chats` (a11ign/a11ign#4743): THE ID OF A CHAT THE BOT WAS PUT IN, READ ON THE HOST WITH NO TOKEN IN SIGHT. The ledger is real, in a temp HOME, and the lines
// are written by `createInbound` from Telegram-shaped updates, so the command is read against what the listener really writes and not against a hand-made line.
//
// POSITIVE CONTROLS: the channel's id IS printed (the no-token assertions are made over output that holds a chat, so an empty output cannot pass them), and the
// source scan is shown to find an import it is looking for before it is trusted to find none.

import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { EXIT, main, NONE_SEEN } from "./chats.ts";
import { createInbound } from "./inbound.ts";
import { createLedger } from "./ledger.ts";
import { defaultLedgerPath } from "./state.ts";

const CHAIRMAN = Object.freeze({ userId: 4242, chatId: 4242 });
const CHANNEL_ID = -1005678;
const GROUP_ID = -1001234;
// Assembled from parts: this repository is public, and a token-shaped literal is what the secret scanners look for.
const TOKEN = ["123456789", ":", "AAFk3x9Q-test_token_value_ZZ"].join("");

const scratch = mkdtempSync(join(tmpdir(), "messaging-chats-"));
after(() => rmSync(scratch, { recursive: true, force: true }));
let nextHome = 0;

/** @returns {string} a HOME of its own, so no test reads another's ledger */
function freshHome(): string {
  const home = join(scratch, `home-${nextHome += 1}`);
  mkdirSync(home, { recursive: true });
  return home;
}

/** @param {string} home @param {Record<string, any>[]} updates what Telegram sent the listener, handled as the listener handles them */
function listenerSaw(home: string, updates: Record<string, any>[]): void {
  const inbound = createInbound({ ledger: createLedger({ path: defaultLedgerPath(home), now: () => Date.parse("2026-10-10T10:00:00Z") }), chairman: CHAIRMAN });
  for (const update of updates) inbound.handle(update);
}

/** @param {number} id @param {Record<string, any>} [chat] */
function added(id: number, chat: Record<string, any> = {}) {
  return { update_id: id, my_chat_member: { chat: { id: CHANNEL_ID, type: "channel", title: "announcements", ...chat }, from: { id: CHAIRMAN.userId }, date: 1, new_chat_member: { status: "administrator" } } };
}

/** @param {string} home @param {string[]} [argv] @returns {{ code: number, out: string[], err: string[] }} */
function run(home: string, argv: string[] = []): { code: number; out: string[]; err: string[]; } {
  const out: string[] = [];
  const err: string[] = [];
  const code = main(argv, { home, out: (line) => out.push(line), err: (line) => err.push(line) });
  return { code, out, err };
}

describe("messaging:chats prints what the listener recorded", () => {
  test("the id and the type of each chat, in the order first seen, and nothing else", () => {
    const home = freshHome();
    listenerSaw(home, [added(1), added(2, { id: GROUP_ID, type: "supergroup", title: "a group" }), { update_id: 3, channel_post: { message_id: 1, chat: { id: CHANNEL_ID, type: "channel" }, text: "hi" } }]);
    const { code, out, err } = run(home);
    assert.deepEqual({ code, out, err }, { code: EXIT.ok, out: [`${CHANNEL_ID}\tchannel`, `${GROUP_ID}\tsupergroup`], err: [] });
  });

  test("nothing seen yet says so, and is not an error", () => {
    assert.deepEqual(run(freshHome()), { code: EXIT.ok, out: [NONE_SEEN], err: [] });
  });

  test("an ordinary conversation records no chat, so it lists none", () => {
    const home = freshHome();
    listenerSaw(home, [{ update_id: 1, message: { message_id: 1, from: { id: CHAIRMAN.userId }, chat: { id: CHAIRMAN.chatId, type: "private" }, text: "hello" } }]);
    assert.deepEqual(run(home).out, [NONE_SEEN]);
  });
});

describe("its output holds no token", () => {
  test("not in a title, not in the line's other fields, and not the token file or its path, with a chat on the list", () => {
    const home = freshHome();
    const tokenFile = join(home, ".config", "agent-org", "telegram-token");
    mkdirSync(dirname(tokenFile), { recursive: true });
    writeFileSync(tokenFile, `${TOKEN}\n`, { mode: 0o600 });
    // A title is a stranger's text and may be anything, a token included; and a line may carry one in a field nobody meant it to.
    listenerSaw(home, [added(1, { title: TOKEN })]);
    appendFileSync(defaultLedgerPath(home), `${JSON.stringify({ direction: "chat-seen", chatId: GROUP_ID, type: "group", title: TOKEN, error: `fetch ${tokenFile} ${TOKEN}` })}\n`);
    const { code, out, err } = run(home);
    assert.equal(code, EXIT.ok);
    assert.deepEqual(out, [`${CHANNEL_ID}\tchannel`, `${GROUP_ID}\tgroup`], "the control: the chats ARE listed, so the absences below are not an empty output");
    const everything = [...out, ...err].join("\n");
    for (const forbidden of [TOKEN, tokenFile, "telegram-token", "AAFk3x9Q"]) assert.ok(!everything.includes(forbidden), `the output holds ${forbidden}`);
  });

  test("a ledger it cannot read is reported without the token or the line, and exits 1", () => {
    const home = freshHome();
    mkdirSync(dirname(defaultLedgerPath(home)), { recursive: true });
    writeFileSync(defaultLedgerPath(home), `{"direction":"chat-seen"}\nnot json ${TOKEN}\n`);
    const { code, out, err } = run(home);
    assert.equal(code, EXIT.failed);
    assert.deepEqual(out, []);
    assert.match(err.join("\n"), /line 2 is not JSON/);
    assert.ok(!err.join("\n").includes(TOKEN));
  });

  test("an argument is refused and nothing is read: the command has no flag to point it at another file", () => {
    const home = freshHome();
    listenerSaw(home, [added(1)]);
    for (const argv of [["--token-file=/x"], ["extra"]]) {
      const { code, out } = run(home, argv);
      assert.equal(code, EXIT.refused, argv.join(" "));
      assert.deepEqual(out, []);
    }
  });
});

describe("it has no route to the secret", () => {
  const SOURCE = readFileSync(fileURLToPath(new URL("./chats.ts", import.meta.url)), "utf8");
  /** @param {string} source @returns {string[]} every module the file imports, as written */
  const importsOf = (source: string): string[] => [...source.matchAll(/^import\s[^;]*?from\s+"([^"]+)";/gm)].map((match) => match[1]);

  test("the scan finds the imports it is looking for: the control for the absence below", () => {
    assert.ok(importsOf(SOURCE).includes("./ledger.ts"));
    assert.ok(importsOf(SOURCE).includes("./inbound.ts"));
    assert.deepEqual(importsOf('import { x } from "./secret.ts";\nimport y from "./config.ts";'), ["./secret.ts", "./config.ts"]);
  });

  test("it imports neither the secret's module nor the configuration's", () => {
    const reaching = importsOf(SOURCE).filter((path) => /(^|\/)(secret|config|project-config|host-config)\.ts$/.test(path));
    assert.deepEqual(reaching, []);
  });
});
