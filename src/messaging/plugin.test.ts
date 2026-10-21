// no-token: none -- the plugin is loaded from this checkout and handed a fake `fetch`, and its token and chairman files are made in a scratch folder
//
// THE MESSAGING PLUGIN A PROJECT ENABLES, LOADED FOR THE COMMANDS (A11-162): the name `messaging.provider` gives is looked up in the registry, a name that is no bundled messaging plugin is
// refused by name, and the provider is built by the plugin from the files the key resolves to.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCatalog } from "../plugins/registry.ts";
import type { MessagingOn } from "./config.ts";
import { loadMessagingModule, messagingListener, messagingPluginDeps, messagingProvider, MessagingPluginRefusal, pluginProviders, pluginSettingsOf } from "./plugin.ts";
import { SecretFileRefusal } from "./secret.ts";

const TOKEN = "123456789:AAFk3x9Q-test_token_value_ZZ";
const scratch = mkdtempSync(join(tmpdir(), "messaging-plugin-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

function secret(name: string, text: string, mode = 0o600): string {
  const path = join(scratch, name);
  writeFileSync(path, text);
  chmodSync(path, mode);
  return path;
}

const CONFIG: MessagingOn = { enabled: true, provider: "telegram", tokenFile: secret("token", TOKEN), chairmanFile: secret("chairman.json", JSON.stringify({ userId: 4242, chatId: 4242 })),
  announcementsFile: null, summary: null, milestones: null };

/** A fake Telegram: every method succeeds; the polling variant's poll answers nothing. */
function telegram() {
  const urls: string[] = [];
  const bodies: Record<string, unknown>[] = [];
  let id = 100;
  const fetchImpl = (async (url: string, init: { body: string }) => {
    urls.push(url);
    bodies.push(JSON.parse(init.body));
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ ok: true, result: url.endsWith("getUpdates") ? [] : { message_id: id += 1 } }) };
  }) as unknown as typeof fetch;
  return { fetch: fetchImpl, urls, bodies };
}

test("the settings the plugin takes from a configuration are its files, resolved, and not the core's summary or milestones", () => {
  assert.deepEqual(pluginSettingsOf({ ...CONFIG, summary: { at: "08:00", timezone: "Europe/London" }, milestones: "/p/m.json" }), { tokenFile: CONFIG.tokenFile, chairmanFile: CONFIG.chairmanFile, announcementsFile: null });
  assert.deepEqual(pluginSettingsOf(CONFIG, { conversation: true }).conversation, true);
});

test("a provider name is looked up in the registry: a bundled messaging plugin loads, and anything else is refused by name", async () => {
  const { plugin, module } = await loadMessagingModule("telegram");
  assert.deepEqual([plugin.name, plugin.where, typeof module.create, typeof module.pair], ["telegram", "bundled", "function", "function"]);
  for (const name of ["fake-messaging", "linear", "carrier-pigeon"]) {
    await assert.rejects(loadMessagingModule(name), (error: unknown) => error instanceof MessagingPluginRefusal && error.message.startsWith(`messaging.provider "${name}" is not a messaging plugin this checkout runs`), name);
  }
});

test("a plugin whose module the loader refuses is refused by name, with the loader's words", async () => {
  await assert.rejects(loadMessagingModule("telegram", { importModule: async () => ({ create: () => ({}) }) }), /the messaging plugin telegram was refused: plugin telegram: index\.ts must export create, doctorChecks and onboardSteps/);
  const unread = buildCatalog({ files: { directories: (path) => (path.endsWith("/plugins") ? ["telegram"] : []),
    text: (path) => (path.endsWith("/telegram/package.json") ? JSON.stringify({ agentOrg: { concern: "messaging", contract: "2.0", description: "A messaging.", entry: "index.ts" } }) : null), isFile: () => true } });
  await assert.rejects(loadMessagingModule("telegram", { catalog: unread }), /the messaging plugin telegram was refused: plugin telegram implements messaging contract 2\.0; this agent-org reads messaging 1\.x/);
});

test("messagingProvider builds the provider the plugin gives, reading the token and the chairman's chat id then, and sends through the caller's fetch", async () => {
  const wire = telegram();
  const provider = await messagingProvider(CONFIG, { fetch: wire.fetch, log: () => undefined });
  assert.equal(provider.id, "telegram");
  const sent = await provider.send({ text: "hello" });
  assert.equal(sent.audience, "ask");
  assert.equal(wire.urls[0], `https://api.telegram.org/bot${TOKEN}/sendMessage`);
  assert.equal(wire.bodies[0].chat_id, 4242);
  assert.equal(provider.listen, undefined, "a sender does not listen");
});

test("the listener's provider is the one that listens, and a listener never reads the announcements channel", async () => {
  const bad = { ...CONFIG, announcementsFile: secret("announcements", "notachatid") };
  await assert.rejects(messagingProvider(bad, { fetch: telegram().fetch }), (error: unknown) => error instanceof SecretFileRefusal && /holds no chat id/.test(error.message), "the sender reads it, as it always did");
  const listening = await messagingListener(bad, { fetch: telegram().fetch });
  assert.equal(listening.capabilities.conversation, true);
  assert.equal(typeof listening.listen, "function");
});

test("a token file others can read is refused by the core's own reader, so every caller's handling of that refusal is unchanged", async () => {
  const loose = { ...CONFIG, tokenFile: secret("loose", TOKEN, 0o644) };
  await assert.rejects(messagingProvider(loose, { fetch: telegram().fetch }), (error: unknown) => error instanceof SecretFileRefusal && error.message.includes("mode 0644") && !error.message.includes(TOKEN));
});

test("pluginProviders keys a factory by each known provider, which builds through its plugin", async () => {
  const providers = pluginProviders();
  assert.deepEqual(Object.keys(providers), ["telegram"]);
  const provider = await providers.telegram(CONFIG, { fetch: telegram().fetch });
  assert.equal(provider.id, "telegram");
});

test("the deps a messaging plugin runs with carry the caller's fetch, clock and log, and the secret helpers", async () => {
  const lines: string[] = [];
  const slept: number[] = [];
  const deps = messagingPluginDeps({ log: (line) => lines.push(line), sleep: async (ms) => { slept.push(ms); }, fetch: telegram().fetch });
  deps.log("a line");
  await deps.messaging.sleep?.(5);
  assert.deepEqual([lines, slept], [["a line"], [5]]);
  assert.deepEqual(Object.keys(deps.messaging).sort(), ["readAnnouncementsChatId", "readChairman", "readSecretFile", "redactingFetch", "secretFileProblem", "sleep"]);
});

test("a command that speaks only to the chairman's chat builds its provider without reading the announcements channel, as chairman:reply never did", async () => {
  const bad = { ...CONFIG, announcementsFile: secret("announcements-bad", "notachatid") };
  await assert.rejects(pluginProviders().telegram(bad, { fetch: telegram().fetch }), SecretFileRefusal, "the default reads it");
  const provider = await pluginProviders({ announcements: false }).telegram(bad, { fetch: telegram().fetch });
  assert.equal(provider.id, "telegram");
});
