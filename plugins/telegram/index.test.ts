// no-token: none -- Telegram is a fake `fetch` that answers every method with success; the token and chairman files are made in a scratch folder
//
// THE PLUGIN AS CORE USES IT (A11-162): the registry finds it from its manifest, `create` builds the provider from the files the project's `messaging` key resolves to, through the secret
// helpers core gives it, and the provider passes the messaging contract's suite as the plugin builds it. Its doctor rows are what `messaging:check` checks.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMessagingConformance } from "../../src/plugins/conformance/messaging.ts";
import { fakePluginDeps } from "../../src/plugins/fakes/deps.ts";
import { defaultCatalog, pluginNamed } from "../../src/plugins/registry.ts";
import { SecretFileRefusal } from "../../src/messaging/secret.ts";
import { create, doctorChecks, onboardSteps, pair } from "./index.ts";

const TOKEN = "123456789:AAFk3x9Q-test_token_value_ZZ";

const scratch = mkdtempSync(join(tmpdir(), "telegram-plugin-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

/** A secret file of `text` with `mode`, in the scratch folder. */
function secret(name: string, text: string, mode = 0o600): string {
  const path = join(scratch, name);
  writeFileSync(path, text);
  chmodSync(path, mode);
  return path;
}

const FILES = { tokenFile: secret("token", TOKEN), chairmanFile: secret("chairman.json", JSON.stringify({ userId: 4242, chatId: 4242 })) };

/** A fake Telegram: every method succeeds, each message gets a fresh id, and a poll answers nothing. */
function telegram() {
  const urls: string[] = [];
  let id = 100;
  const fetchImpl = (async (url: string) => {
    urls.push(url);
    const method = url.split("/").pop();
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ ok: true, result: method === "getUpdates" ? [] : { message_id: id += 1 } }) };
  }) as unknown as typeof fetch;
  return { fetch: fetchImpl, urls };
}

test("the registry finds the plugin as the bundled messaging telegram, from its manifest alone, and the manifest names the three files of the project's messaging key", () => {
  const plugin = pluginNamed(defaultCatalog(), "telegram");
  assert.ok(plugin !== undefined);
  assert.deepEqual([plugin.concern, plugin.where, plugin.contract, plugin.entry, plugin.movedBy], ["messaging", "bundled", "1.1", "index.ts", null]);
  assert.deepEqual(Object.keys(plugin.settings), ["tokenFile", "chairmanFile", "announcementsFile"]);
  for (const [name, entry] of Object.entries(plugin.settings)) assert.deepEqual([entry.key, entry.file], [`messaging.${name}`, "project.json"]);
  assert.deepEqual(onboardSteps, [], "the token is the person's to put in a file, and pairing stays `agent-org messaging:pair`");
  assert.equal(typeof pair, "function");
});

test("the provider the plugin builds passes the messaging contract's suite, sending only", async () => {
  const fake = telegram();
  const provider = create(FILES, fakePluginDeps({ fetch: fake.fetch }));
  const { passed, skipped } = await runMessagingConformance(provider);
  assert.ok(passed.includes("send-returns-message-ref") && passed.includes("actions-are-accepted"));
  assert.deepEqual(skipped.map(({ check }) => check), ["poll-returns-updates-and-honours-abort"], "a sender does not poll");
  assert.equal(provider.capabilities.conversation, false);
  assert.equal(provider.listen, undefined, "and offers no inbound loop");
  assert.ok(fake.urls.every((url) => url.startsWith(`https://api.telegram.org/bot${TOKEN}/`)));
});

test("with conversation in its settings it is the polling provider, which polls and listens, and passes the suite with its poll check run", async () => {
  const provider = create({ ...FILES, conversation: true }, fakePluginDeps({ fetch: telegram().fetch }));
  assert.equal(provider.capabilities.conversation, true);
  assert.equal(typeof provider.listen, "function");
  const { passed, skipped } = await runMessagingConformance(provider);
  assert.ok(passed.includes("poll-returns-updates-and-honours-abort"));
  assert.deepEqual(skipped, []);
});

test("the announcements channel is read when a file names it, and an announcement then goes to it", async () => {
  const channel = secret("announcements", "-1005678\n");
  const bodies: Record<string, unknown>[] = [];
  const fetchImpl = (async (_url: string, init: { body: string }) => {
    bodies.push(JSON.parse(init.body));
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ ok: true, result: { message_id: bodies.length } }) };
  }) as unknown as typeof fetch;
  const provider = create({ ...FILES, announcementsFile: channel }, fakePluginDeps({ fetch: fetchImpl }));
  await provider.send({ text: "an incident", audience: "announcement" });
  await provider.send({ text: "a question" });
  assert.deepEqual(bodies.map((body) => body.chat_id), [-1005678, 4242]);
});

test("a token file others can read is refused by name, with the path and the mode and never the token, when the provider is built", () => {
  const loose = secret("loose-token", TOKEN, 0o644);
  assert.throws(() => create({ ...FILES, tokenFile: loose }, fakePluginDeps()), (error: unknown) => error instanceof SecretFileRefusal && error.message.includes(loose) && /mode 0644/.test(error.message) && !error.message.includes(TOKEN));
});

test("a settings with no file for the token or the chairman is refused by name", () => {
  assert.throws(() => create({ chairmanFile: FILES.chairmanFile }, fakePluginDeps()), /messaging\.tokenFile names no file/);
  assert.throws(() => create({ tokenFile: FILES.tokenFile }, fakePluginDeps()), /messaging\.chairmanFile names no file/);
});

test("doctor: a token file readable by no one else and a chairman who has paired are two passing rows", () => {
  const rows = doctorChecks(FILES, fakePluginDeps({ mode: () => 0o600 }));
  assert.deepEqual(rows.map(({ name, ok }) => [name, ok]), [["telegram token file", true], ["telegram chat", true]]);
  assert.match(rows[0].detail, /readable by no one else \(mode 0600/);
  assert.equal(JSON.stringify(rows).includes(TOKEN), false, "no row holds the token");
});

test("doctor: a chairman who has not paired yet is not a failure, and the row names the command that pairs", () => {
  const rows = doctorChecks({ tokenFile: FILES.tokenFile, chairmanFile: join(scratch, "not-yet.json") }, fakePluginDeps());
  assert.deepEqual(rows.map(({ ok }) => ok), [true, true]);
  assert.match(rows[1].detail, /NOT YET PAIRED: .*not-yet\.json is absent, and the pairing command writes it: run `agent-org messaging:pair`/);
});

test("doctor: an unsafe token file or chairman file fails its row with the path and mode, and the fix", () => {
  const loose = secret("loose-token-2", TOKEN, 0o644);
  const [token] = doctorChecks({ ...FILES, tokenFile: loose }, fakePluginDeps({ mode: () => 0o600 }));
  assert.equal(token.ok, false);
  assert.match(token.detail, new RegExp(`${loose}.*mode 0644`));
  assert.equal(token.fix, `put the bot's token alone in ${loose} with mode 600 (chmod 600 ${loose})`);
  const looseChairman = secret("loose-chairman.json", "{}", 0o666);
  const rows = doctorChecks({ ...FILES, chairmanFile: looseChairman }, fakePluginDeps({ mode: () => 0o666 }));
  assert.equal(rows[1].ok, false);
  assert.match(rows[1].fix ?? "", /chmod 600 .*loose-chairman\.json, or pair again/);
});

test("doctor: a messaging key with no token file or chairman file is one failing row that says what to set", () => {
  const rows = doctorChecks({}, fakePluginDeps());
  assert.deepEqual(rows.map(({ name, ok }) => [name, ok]), [["telegram settings", false]]);
  assert.match(rows[0].fix ?? "", /agent-org plugin config telegram tokenFile=<path> chairmanFile=<path>/);
});
