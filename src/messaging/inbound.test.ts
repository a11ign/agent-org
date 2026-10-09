// @ts-check
// WHO MAY SPEAK TO THE ORGANISATION, AND WHAT BECOMES OF IT (a11ign/a11ign#2906 done-whens 1, 2, 4 and 5), on plain objects shaped like
// Telegram's `getUpdates` and a real ledger file in a temp directory. Nothing here reaches a network.
//
// POSITIVE CONTROLS, because "dropped" is also what an `acceptUpdate` that drops everything reports: the chairman's clean message is
// accepted, forwarded and recorded FIRST, and every drop below is the same update with ONE field changed.
//
// Ids are made-up integers. The fixtures that look like credentials are assembled from parts (this repository is public).

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { pathToFileURL } from "node:url";

import { createLedger, readLedgerLines } from "./ledger.mjs";
import { acceptUpdate, actionData, BUTTON_ACTIONS, createInbound, DROP_REASON, isAccepted, optionData, parseButtonData } from "./inbound.mjs";
import { parseChairmanOptions } from "./sources/requests.mjs";

// The scan of the module graph below imports modules that reach the project's declaration when they load, so it must be findable: the same fallback
// `listen.test.mjs` makes, because the Acceptance of this row runs the two files in separate processes and only that one set it.
const HOST_FILE = join(homedir(), "repos", "a11y-witness", ".agent-org", "host.json");
if (!process.env.AGENT_ORG_HOST && existsSync(HOST_FILE)) process.env.AGENT_ORG_HOST = HOST_FILE;

const CHAIRMAN = Object.freeze({ userId: 4242, chatId: 4242 });
const STRANGER_ID = 9001;
const GROUP_ID = -1001234;
const CHANNEL_ID = -1005678;
const GITHUB_TOKEN = ["gh", "p_", "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8"].join("");
const PRIVATE_KEY_HEADER = ["-----BEGIN ", "RSA PRIVATE", " KEY-----"].join("");
const PASSWORD_LINE = "password: hunter2";

const scratch = mkdtempSync(join(tmpdir(), "messaging-inbound-"));
after(() => rmSync(scratch, { recursive: true, force: true }));
let nextLedger = 0;

/** @param {Record<string, any>} [more] a message from the chairman in their own private chat; `more` overrides fields */
function message(more: Record<string, any> = {}) {
  return { message_id: 7, from: { id: CHAIRMAN.userId, is_bot: false }, chat: { id: CHAIRMAN.chatId, type: "private" }, text: "why did the merge queue stall?", ...more };
}

/** @param {number} id @param {Record<string, any>} [more] */
function update(id: number, more: Record<string, any> = {}) {
  return { update_id: id, message: message(more) };
}

/** @param {number} id @param {Record<string, any>} [more] a button press under one of the bot's messages */
function press(id: number, more: Record<string, any> = {}) {
  return { update_id: id, callback_query: { id: "cbq-1", from: { id: CHAIRMAN.userId }, data: "ans:A", message: message({ text: "row 2885 needs you" }), ...more } };
}

/** An inbound over a fresh ledger file. `restart()` is a NEW process over the SAME file. */
function harness() {
  const path = join(scratch, `ledger-${nextLedger += 1}.jsonl`);
  let at = Date.parse("2026-10-02T10:00:00Z");
  const ledger = () => createLedger({ path, now: () => at += 1000 });
  let inbound = createInbound({ ledger: ledger(), chairman: CHAIRMAN });
  return { path, lines: () => readLedgerLines(path), raw: () => readFileSync(path, "utf8"), handle: (/** @type {unknown} */ u: unknown) => inbound.handle(u), restart() { inbound = createInbound({ ledger: ledger(), chairman: CHAIRMAN }); } };
}

describe("identity (done-when 1)", () => {
  test("the chairman's private message IS accepted, forwarded and recorded: the positive control for every drop below", () => {
    const result = acceptUpdate(update(1), { chairman: CHAIRMAN });
    assert.ok(result.ok);
    assert.equal(isAccepted(result.ok && result.accepted, CHAIRMAN), false, "identity alone does not mint: only `handle` does, after the classifier");
    assert.deepEqual(
      result.ok && { kind: result.accepted.kind, text: result.accepted.text, userId: result.accepted.userId, chatId: result.accepted.chatId, messageId: result.accepted.messageId },
      { kind: "message", text: "why did the merge queue stall?", userId: CHAIRMAN.userId, chatId: CHAIRMAN.chatId, messageId: 7 },
    );
    const run = harness();
    const handled = run.handle(update(1));
    assert.equal(handled.action, "forward");
    assert.equal(handled.action === "forward" && handled.accepted.text, "why did the merge queue stall?");
    assert.ok(handled.action === "forward" && isAccepted(handled.accepted, CHAIRMAN), "what `handle` forwards is the minted value");
    assert.equal(run.lines().length, 1, "one ledger line per verdict");
    assert.equal(run.lines()[0].verdict, "forward");
  });

  test("a button press from the chairman is accepted too, and carries the data and the query id", () => {
    const result = acceptUpdate(press(2), { chairman: CHAIRMAN });
    assert.ok(result.ok);
    assert.equal(result.ok && result.accepted.kind, "button");
    assert.equal(result.ok && result.accepted.data, "ans:A");
    assert.equal(result.ok && result.accepted.callbackQueryId, "cbq-1");
    const handled = harness().handle(press(2));
    assert.equal(handled.action, "forward");
    assert.ok(handled.action === "forward" && isAccepted(handled.accepted, CHAIRMAN));
  });

  test("a button's data and query id must be strings: an object, a number, an empty string or a missing query id is malformed", () => {
    const bad = [{ data: { evil: 1 } }, { data: 7 }, { data: ["approve:1"] }, { data: null }, { data: "" }, { id: 5 }, { id: undefined }];
    for (const [index, fields] of bad.entries()) {
      const result = acceptUpdate(press(40 + index, fields), { chairman: CHAIRMAN });
      assert.equal(result.ok, false, JSON.stringify(fields));
      assert.equal(!result.ok && result.reason, DROP_REASON.malformed, JSON.stringify(fields));
      const run = harness();
      assert.equal(run.handle(press(40 + index, fields)).action, "ignore");
      assert.equal(run.lines()[0].verdict, "drop");
    }
    assert.equal(acceptUpdate(press(50), { chairman: CHAIRMAN }).ok, true, "control: the clean press is accepted");
  });

  /** The five cases of the done-when, each the clean update with one thing changed. */
  const FIVE = /** @type {[string, unknown, string][]} */ ([
    ["another user id", update(10, { from: { id: STRANGER_ID }, chat: { id: STRANGER_ID, type: "private" } }), DROP_REASON.wrongUser],
    ["the right user in a group", update(11, { chat: { id: GROUP_ID, type: "group" } }), DROP_REASON.notPrivateChat],
    ["an edited message", { update_id: 12, edited_message: message({ text: "edited" }) }, DROP_REASON.edited],
    ["a forward", update(13, { forward_origin: { type: "user", date: 1 } }), DROP_REASON.forwarded],
    ["a channel post", { update_id: 14, channel_post: message({ from: undefined, chat: { id: CHANNEL_ID, type: "channel" } }) }, DROP_REASON.channelPost],
  ]);

  test("the five cases each DROP, and each with a reason of its own", () => {
    const reasons = new Set();
    for (const [name, input, expected] of FIVE) {
      const result = acceptUpdate(input, { chairman: CHAIRMAN });
      assert.equal(result.ok, false, `${name} was accepted`);
      assert.equal(!result.ok && result.reason, expected, name);
      reasons.add(!result.ok && result.reason);
    }
    assert.equal(reasons.size, FIVE.length, "five distinct reasons");
  });

  test("through `handle`, each is ignored (nothing forwarded, nothing said to a stranger) and leaves one line with its reason", () => {
    const run = harness();
    for (const [name, input, expected] of FIVE) {
      const handled = run.handle(input);
      assert.equal(handled.action, "ignore", name);
      assert.equal(handled.action === "ignore" && handled.reason, expected, name);
    }
    assert.deepEqual(run.lines().map((line) => line.reason), FIVE.map(([, , reason]) => reason));
    assert.ok(run.lines().every((line) => line.verdict === "drop" && line.direction === "in"));
  });

  test("a drop in a group names the chat so the listener can leave it", () => {
    const handled = harness().handle(update(20, { chat: { id: GROUP_ID, type: "supergroup" } }));
    assert.deepEqual(handled.action === "ignore" && [handled.chatId, handled.chatType], [GROUP_ID, "supergroup"]);
  });

  test("a button press is held to the same identity: another user, a group, a forward-less stranger", () => {
    assert.equal(!acceptUpdate(press(30, { from: { id: STRANGER_ID } }), { chairman: CHAIRMAN }).ok, true);
    const inGroup = acceptUpdate(press(31, { message: message({ chat: { id: GROUP_ID, type: "group" } }) }), { chairman: CHAIRMAN });
    assert.equal(!inGroup.ok && inGroup.reason, DROP_REASON.notPrivateChat);
    const noMessage = acceptUpdate({ update_id: 32, callback_query: { id: "x", from: { id: CHAIRMAN.userId }, data: "approve:1" } }, { chairman: CHAIRMAN });
    assert.equal(noMessage.ok, false, "an inline-mode button has no chat to check, so it is not the chairman's private chat");
  });

  test("the rest of the update types, and the odd shapes, are dropped with a reason and never throw", () => {
    const cases = /** @type {[unknown, string][]} */ ([
      [{ update_id: 40, inline_query: { id: "q", from: { id: CHAIRMAN.userId }, query: "x" } }, DROP_REASON.unsupportedType],
      [{ update_id: 41, my_chat_member: {} }, DROP_REASON.unsupportedType],
      [{ update_id: 42, message: message(), edited_message: message() }, DROP_REASON.malformed],
      [{ update_id: 43 }, DROP_REASON.malformed],
      [{ update_id: 44, message: "text" }, DROP_REASON.malformed],
      [null, DROP_REASON.malformed],
      ["a string", DROP_REASON.malformed],
      [update(45, { from: undefined }), DROP_REASON.noSender],
      [update(46, { from: { id: "4242" } }), DROP_REASON.noSender],
      [update(47, { chat: { id: 77, type: "private" } }), DROP_REASON.wrongChat],
      [update(48, { text: undefined, photo: [{}] }), DROP_REASON.notText],
      [update(49, { text: "" }), DROP_REASON.notText],
    ]);
    for (const [input, expected] of cases) {
      const result = acceptUpdate(input, { chairman: CHAIRMAN });
      assert.equal(!result.ok && result.reason, expected, JSON.stringify(input)?.slice(0, 60));
    }
  });

  test("a chairman with an id missing refuses to run, rather than accepting an update that also has no id", () => {
    const sendersWithoutId = update(50, { from: {} });
    for (const chairman of [{ userId: undefined, chatId: 1 }, { userId: 1, chatId: undefined }, {}, null, { userId: "4242", chatId: "4242" }]) {
      assert.throws(() => acceptUpdate(sendersWithoutId, { chairman: /** @type {any} */ (chairman) }), TypeError);
      assert.throws(() => createInbound({ ledger: createLedger({ path: join(scratch, "unused.jsonl"), now: Date.now }), chairman: /** @type {any} */ (chairman) }), TypeError);
    }
  });
});

describe("the reply target travels in the minted value (a11ign/a11ign#3062 done-whens 1 and 4)", () => {
  /** @param {unknown} u @returns {Record<string, any>} */
  const minted = (u: unknown): Record<string, any> => {
    const handled = harness().handle(u);
    assert.equal(handled.action, "forward", `the update was not forwarded: ${JSON.stringify(handled)}`);
    return handled.action === "forward" ? handled.accepted : {};
  };

  test("a reply to bot message 501 IS minted with replyToMessageId 501: the positive control, so a value that drops it fails here", () => {
    const accepted = minted(update(1, { reply_to_message: { message_id: 501 } }));
    assert.equal(accepted.replyToMessageId, 501);
    assert.ok(isAccepted(accepted, CHAIRMAN), "the field rides on the branded value, not on a copy of it");
  });

  test("everything that is not a reply to a message is null, never undefined and never what the sender wrote", () => {
    for (const [what, input] of /** @type {[string, unknown][]} */ ([
      ["a plain message", update(2)],
      ["a button press", press(3, { message: message({ reply_to_message: { message_id: 501 } }) })],
      ["a reply whose target is not an integer", update(4, { reply_to_message: { message_id: "501" } })],
      ["a reply whose target is a float", update(5, { reply_to_message: { message_id: 5.5 } })],
      ["a reply that is not an object", update(6, { reply_to_message: "501" })],
      ["a reply with no id", update(7, { reply_to_message: {} })],
    ])) {
      assert.equal(minted(input).replyToMessageId, null, what);
    }
  });

  test("the target is not in the ledger line: ids and a verdict only, as for every other field", () => {
    const run = harness();
    run.handle(update(8, { reply_to_message: { message_id: 501 } }));
    assert.ok(!run.raw().includes("replyToMessageId"), run.raw());
  });
});

describe("secrets and refusals (done-whens 2 and 3), through `handle`", () => {
  const SECRET_TEXT = `token ${GITHUB_TOKEN}\n${PRIVATE_KEY_HEADER}\n${PASSWORD_LINE}`;

  test("a message holding a token, a key header and a password is not forwarded, is deleted, and the verdict line holds no part of it", () => {
    const run = harness();
    const handled = run.handle(update(60, { text: SECRET_TEXT }));
    assert.equal(handled.action, "reply");
    assert.equal(handled.action === "reply" && handled.reason, "secret");
    assert.deepEqual(handled.action === "reply" && handled.deleteMessage, { chatId: CHAIRMAN.chatId, messageId: 7 });
    for (const fragment of [GITHUB_TOKEN, "PRIVATE KEY", "hunter2", "BEGIN", GITHUB_TOKEN.slice(4, 20)]) {
      assert.ok(!run.raw().includes(fragment), `the ledger holds ${fragment.slice(0, 6)}...`);
      assert.ok(!JSON.stringify(handled).includes(fragment), `the result holds ${fragment.slice(0, 6)}...`);
    }
    const [line] = run.lines();
    assert.equal(line.verdict, "drop");
    assert.equal(line.reason, "secret");
    assert.equal(line.length, SECRET_TEXT.length);
    assert.equal(line.sha256, null, "no hash of a secret: a bare password would be a dictionary away");
  });

  test("#3442: the real miss and a withheld token are deleted, replied to by reason alone, and leave a line with no hash and no word of the value", () => {
    const FAKE = "zq-fake-value-0";
    const MIXED = "Aq9Zx7Lm2Kp4Vb8Nc3Jd5Hs6";
    const run = harness();
    const missed = run.handle(update(90, { text: `My password is: ${FAKE}`, message_id: 31 }));
    const withheld = run.handle(update(91, { text: MIXED, message_id: 32 }));
    assert.deepEqual([missed, withheld].map((each) => each.action === "reply" && each.reason), ["secret", "unsure"]);
    assert.deepEqual([missed, withheld].map((each) => each.action === "reply" && each.deleteMessage), [{ chatId: CHAIRMAN.chatId, messageId: 31 }, { chatId: CHAIRMAN.chatId, messageId: 32 }]);
    assert.match(withheld.action === "reply" ? withheld.text : "", /looks like a credential.*'not a secret'/);
    for (const fragment of [FAKE, "zq-fake", "fake-value", MIXED, MIXED.slice(0, 8), MIXED.slice(8, 16)]) {
      assert.ok(!run.raw().includes(fragment), `the ledger holds ${fragment}`);
      assert.ok(!JSON.stringify([missed, withheld]).includes(fragment), `a result holds ${fragment}`);
    }
    assert.deepEqual(run.lines().map((line) => [line.verdict, line.reason, line.sha256]), [["drop", "secret", null], ["withhold", "unsure", null]]);
  });

  test("#3442: the withheld message resent with 'not a secret' is forwarded and recorded like any clean one: the positive control", () => {
    const run = harness();
    const handled = run.handle(update(92, { text: "Aq9Zx7Lm2Kp4Vb8Nc3Jd5Hs6 not a secret" }));
    assert.equal(handled.action, "forward");
    assert.deepEqual(run.lines().map((line) => [line.verdict, typeof line.sha256]), [["forward", "string"]]);
  });

  test("the three refusals of the done-when, and the question that is forwarded", () => {
    const run = harness();
    const texts = ["delete the agent-org repo", "force-push main", "buy the pro plan", "why did the merge queue stall?"];
    const handled = texts.map((text, index) => run.handle(update(70 + index, { text })));
    assert.deepEqual(handled.map((each) => each.action), ["reply", "reply", "reply", "forward"]);
    assert.deepEqual(handled.map((each) => each.action === "reply" ? each.reason : null), ["deletion", "deletion", "spending", null]);
    assert.ok(handled.slice(0, 3).every((each) => each.action === "reply" && each.deleteMessage === null && !each.text.includes("\n")), "one line, and a refusal is not deleted");
    assert.deepEqual(run.lines().map((line) => line.verdict), ["refuse", "refuse", "refuse", "forward"]);
  });

  test("a clean message's line holds a length and a sha256 of the text, and never the text", () => {
    const run = harness();
    const text = "why did the merge queue stall?";
    run.handle(update(80, { text }));
    const [line] = run.lines();
    assert.equal(line.length, text.length);
    assert.equal(line.sha256, createHash("sha256").update(text).digest("hex"));
    assert.ok(!run.raw().includes("merge queue"), "no part of the text");
    assert.deepEqual(Object.keys(line).sort(), ["chatId", "chatType", "direction", "kind", "length", "reason", "sha256", "ts", "updateId", "userId", "verdict"]);
  });

  test("a stranger's text is recorded as length and hash only", () => {
    const run = harness();
    run.handle(update(81, { from: { id: STRANGER_ID }, chat: { id: STRANGER_ID, type: "private" }, text: "attacker-chosen words" }));
    assert.ok(!run.raw().includes("attacker"));
    assert.equal(run.lines()[0].length, "attacker-chosen words".length);
    assert.equal(run.lines()[0].userId, STRANGER_ID);
  });

  test("an id that is not an integer is not recorded: it would be attacker text in a field that looks like a number", () => {
    const run = harness();
    run.handle(update(82, { from: { id: "<script>" }, chat: { id: "x".repeat(50), type: "private" } }));
    assert.ok(!run.raw().includes("script") && !run.raw().includes("xxxx"));
    assert.equal(run.lines()[0].userId, null);
  });
});

describe("a replayed update id is acted on once (done-when 4)", () => {
  test("the same batch handed over twice forwards once and writes one line per update", () => {
    const run = harness();
    const batch = [update(90), update(91, { text: "delete the repo" }), update(92, { chat: { id: GROUP_ID, type: "group" } })];
    const first = batch.map((each) => run.handle(each).action);
    const again = batch.map((each) => run.handle(each).action);
    assert.deepEqual(first, ["forward", "reply", "ignore"]);
    assert.deepEqual(again, ["replayed", "replayed", "replayed"]);
    assert.equal(run.lines().length, 3, "a replay writes no line: 100 replays must not write 100");
  });

  test("it holds across a restart, because the ledger is the memory", () => {
    const run = harness();
    assert.equal(run.handle(update(100)).action, "forward");
    run.restart();
    assert.deepEqual(run.handle(update(100)), { action: "replayed", updateId: 100 });
    assert.equal(run.handle(update(101)).action, "forward", "a NEW id still goes through after the restart");
    assert.equal(run.lines().length, 2);
  });

  test("a different update id with the same text is a new update, and the same id with different text is a replay (dedupe is by id)", () => {
    const run = harness();
    assert.equal(run.handle(update(110)).action, "forward");
    assert.equal(run.handle(update(111)).action, "forward");
    assert.equal(run.handle(update(110, { text: "something else entirely" })).action, "replayed");
  });

  test("an update with no usable id cannot be deduplicated, so each is judged and recorded", () => {
    const run = harness();
    assert.equal(run.handle({ message: message() }).action, "ignore");
    assert.equal(run.handle({ message: message() }).action, "ignore");
    assert.equal(run.lines().length, 2);
  });

  test("if the ledger cannot be written the update is NOT forwarded", () => {
    const failing = { read: () => [], append: () => { throw new Error("disk full"); } };
    const inbound = createInbound({ ledger: failing, chairman: CHAIRMAN });
    assert.throws(() => inbound.handle(update(120)), /disk full/);
  });
});

describe("no other module can produce the branded value (done-when 5)", () => {
  const here = new URL(".", import.meta.url);
  const modules = readdirSync(here).filter((name) => name.endsWith(".mjs") && !name.endsWith(".test.mjs"));
  const accepted = /** @type {any} */ (harness().handle(update(130))).accepted;

  test("the population is real: this scan sees inbound.mjs and the other modules", () => {
    assert.ok(modules.includes("inbound.mjs"));
    assert.ok(modules.length >= 6, `only ${modules.length} modules found`);
  });

  test("nothing a module exports is the brand, the registry or the minted value; only inbound.mjs exports a way to mint one", async () => {
    // BOTH COPIES FROM ONE KIND OF IMPORT: the scan below `import()`s each module natively, so `inbound.mjs` there is Node's copy and the static import above is rstest's, and
    // `value === createInbound` is false across the two. The minter, the checker and the brand all come from the copy the scan reads.
    const native = await import(pathToFileURL(join(here.pathname, "inbound.mjs")).href);
    const nativeAccepted = native.createInbound({ ledger: createLedger({ path: join(scratch, "native-brand.jsonl"), now: Date.now }), chairman: CHAIRMAN }).handle(update(130)).accepted;
    const brand = Object.getOwnPropertySymbols(nativeAccepted)[0];
    assert.ok(brand, "a minted value carries a symbol (control: the scan below has something to look for)");
    const mintersByModule = /** @type {Record<string, string[]>} */ ({});
    for (const name of modules) {
      const exported = await import(pathToFileURL(join(here.pathname, name)).href);
      for (const [exportName, value] of Object.entries(exported)) {
        assert.notEqual(value, brand, `${name} exports the brand as ${exportName}`);
        assert.ok(!(value instanceof WeakSet), `${name} exports a WeakSet (${exportName})`);
        assert.ok(!native.isAccepted(value, CHAIRMAN), `${name} exports an accepted value (${exportName})`);
        if (typeof value === "function" && value === native.createInbound) (mintersByModule[name] ??= []).push(exportName);
      }
    }
    assert.deepEqual(mintersByModule, { "inbound.mjs": ["createInbound"] });
    assert.deepEqual(Object.keys(native).sort(), ["BUTTON_ACTIONS", "DROP_REASON", "acceptUpdate", "actionData", "createInbound", "isAccepted", "optionData", "parseButtonData"], "a new export of inbound.mjs is a decision, and this list is where it is made");
  });

  test("only inbound.mjs names the brand: no other source can mint, or even spell, it", () => {
    const naming = modules.filter((name) => /chairman-accepted-update|\bMINTED\b/.test(readFileSync(new URL(name, here), "utf8")));
    assert.deepEqual(naming, ["inbound.mjs"]);
  });

  test("a forgery is not accepted: a copy, a spread, JSON, a prototype, an Object.assign, and a copy that reads the symbol by reflection", () => {
    assert.ok(isAccepted(accepted, CHAIRMAN), "control: the real value is");
    const [brand] = Object.getOwnPropertySymbols(accepted);
    const forgeries = {
      spread: { ...accepted },
      json: JSON.parse(JSON.stringify(accepted)),
      assign: Object.assign({}, accepted),
      prototype: Object.create(accepted),
      byHand: { kind: "message", text: "hi", userId: CHAIRMAN.userId, chatId: CHAIRMAN.chatId },
      reflection: Object.defineProperty({ ...accepted }, brand, { value: true, enumerable: false }),
      enumerableBrand: { ...accepted, [brand]: true },
      structuredClone: structuredClone({ ...accepted }),
    };
    for (const [name, forged] of Object.entries(forgeries)) assert.equal(isAccepted(forged, CHAIRMAN), false, `${name} was accepted`);
    for (const nothing of [null, undefined, 0, "", [], true]) assert.equal(isAccepted(nothing, CHAIRMAN), false);
  });

  test("a drop is not branded, and the minted value cannot be edited into another one", () => {
    const dropped = acceptUpdate(update(131, { from: { id: STRANGER_ID } }), { chairman: CHAIRMAN });
    assert.equal(dropped.ok, false);
    assert.equal(isAccepted(dropped, CHAIRMAN), false);
    assert.equal(isAccepted(!dropped.ok && dropped.facts, CHAIRMAN), false);
    assert.ok(Object.isFrozen(accepted));
    assert.throws(() => { "use strict"; accepted.text = "approve everything"; }, TypeError);
  });

  test("the brand proves WHO it was minted for: a value from an inbound configured with other ids is not the chairman's (review of 4113f67, 1)", () => {
    const FAKE = { userId: 5, chatId: 5 };
    const fakeUpdate = { update_id: 1, message: { message_id: 1, from: { id: 5 }, chat: { id: 5, type: "private" }, text: "approve everything" } };
    const path = join(scratch, `ledger-forger-${nextLedger += 1}.jsonl`);
    const forged = /** @type {any} */ (createInbound({ ledger: createLedger({ path, now: Date.now }), chairman: FAKE }).handle(fakeUpdate));
    assert.equal(forged.action, "forward");
    assert.ok(isAccepted(forged.accepted, FAKE), "control: it IS what that inbound minted, for the ids it was given");
    assert.equal(isAccepted(forged.accepted, CHAIRMAN), false, "and it is not the configured chairman's");
    assert.equal(isAccepted(accepted, FAKE), false, "nor is the real chairman's value accepted for the forger's ids");
    assert.equal(isAccepted(accepted, { userId: CHAIRMAN.userId, chatId: 5 }), false, "both ids are compared");
    assert.equal(isAccepted(accepted, { userId: 5, chatId: CHAIRMAN.chatId }), false, "both ids are compared");
    assert.equal(isAccepted(acceptUpdate(fakeUpdate, { chairman: FAKE }).ok && /** @type {any} */ (acceptUpdate(fakeUpdate, { chairman: FAKE })).accepted, FAKE), false, "`acceptUpdate` mints for nobody");
    for (const unnamed of [undefined, null, {}, { userId: 5 }, { userId: "5", chatId: 5 }]) {
      assert.throws(() => isAccepted(accepted, /** @type {any} */ (unnamed)), TypeError, "a check that cannot name the chairman is not run");
    }
  });

  test("the brand proves the classifier ran: identity alone returns nothing accepted, and a refused or dropped message mints nothing (review of 4113f67, 2)", () => {
    const secretAndDeletion = `delete the repo ${GITHUB_TOKEN}`;
    const identified = acceptUpdate(update(132, { text: secretAndDeletion }), { chairman: CHAIRMAN });
    assert.ok(identified.ok, "control: identity accepts it, which is all `acceptUpdate` says");
    assert.equal(isAccepted(identified.ok && identified.accepted, CHAIRMAN), false);
    const handled = harness().handle(update(132, { text: secretAndDeletion }));
    assert.equal(handled.action, "reply");
    assert.equal("accepted" in handled, false);
    for (const text of [PASSWORD_LINE, "force-push main", "buy the pro plan"]) assert.equal(harness().handle(update(133, { text })).action, "reply", text);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// A BUTTON'S DATA IS A CLOSED VOCABULARY (a11ign/a11ign#3423 done-when 3). POSITIVE CONTROL: `ans:A` and every fixed word are forwarded in the same
// harness, so "dropped" below is the vocabulary refusing and not a harness that refuses every button.

describe("a button's callback_data is a closed vocabulary", () => {
  test("the control: an option id and each of the six fixed words are forwarded, and each parses to what it names", () => {
    const run = harness();
    const forwarded = [optionData("A"), ...BUTTON_ACTIONS.map((name) => actionData(name))];
    assert.deepEqual(BUTTON_ACTIONS, ["approve", "done", "stuck", "later", "explain", "forme"], "the set is the chairman's point 5, and this pins it");
    for (const [index, data] of forwarded.entries()) {
      assert.equal(run.handle(press(300 + index, { data })).action, "forward", data);
    }
    assert.deepEqual(parseButtonData("ans:A"), { kind: "option", id: "A" });
    assert.deepEqual(parseButtonData("act:later"), { kind: "action", name: "later" });
  });

  test("anything else is dropped with its own reason and a hash of the data, and is never forwarded", () => {
    const unknown = ["approve:2885", "ans:", "ans:A B", `ans:${"A".repeat(17)}`, "ANS:A", "act:", "act:rm", "act:Approve", "later", "ans:A\n", "ans: A", "ans:<!--", "x"];
    const run = harness();
    for (const [index, data] of unknown.entries()) {
      const handled = run.handle(press(400 + index, { data }));
      assert.equal(handled.action, "ignore", JSON.stringify(data));
      assert.equal(/** @type {any} */ (handled).reason, DROP_REASON.unknownCallbackData, JSON.stringify(data));
    }
    const lines = run.lines();
    assert.equal(lines.length, unknown.length, "one ledger line per press");
    for (const line of lines) {
      assert.equal(line.verdict, "drop");
      assert.equal(line.reason, "unknown-callback-data");
      assert.match(line.sha256, /^[0-9a-f]{64}$/, "logged with a hash");
    }
    assert.ok(!run.raw().includes("approve:2885") && !run.raw().includes("act:rm"), "and never with the data itself");
  });

  test("the option-id shape is the one a brief's options block accepts: they cannot drift, because this module cannot import it", () => {
    const ids = ["A", "B", "a-1", "x_y", "0", "A".repeat(16), "A".repeat(17), "", "a b", "a;b", "é", "a.b"];
    for (const id of ids) {
      const parsedByBrief = parseChairmanOptions(`<!-- chairman-options: ${id}=label -->`).options.length === 1;
      assert.equal(parseButtonData(optionData(id)) !== null, parsedByBrief, JSON.stringify(id));
    }
  });
});
