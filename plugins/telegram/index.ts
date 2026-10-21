// @ts-check
// module: the Telegram plugin -- the messaging provider, behind the messaging contract (A11-162)
//
// A BUNDLED AGENT-ORG PLUGIN (`plugins/README.md`). `package.json`'s `agentOrg` field is the manifest's data half, which the registry reads without importing this file: the three
// settings the plugin takes from the project's `messaging` key (`tokenFile`, `chairmanFile`, `announcementsFile`). This is the code half, imported only when a project enables the
// plugin: `create` builds the provider, `doctorChecks` are the rows doctor shows, and `pair` is the one step of `messaging:pair` that is Telegram's. It has no onboard steps: the bot's
// token is the person's to put in a file, and pairing stays `agent-org messaging:pair`, which its check names. EVERY CALL TO api.telegram.org IS MADE IN THIS FOLDER AND NOWHERE ELSE.
//
// IT IMPORTS CORE'S TYPES ONLY (ADR 0001). The secret by reference, the fetch that cannot leak it and the chairman's ids arrive in `deps.messaging`, so core's tests and the contract suite run
// it against a fake Telegram.
import type { MessagingPair, MessagingProvider } from "../../src/plugins/contracts/messaging.ts";
import type { PluginCheck, PluginDeps, PluginSettings } from "../../src/plugins/manifest.ts";
import { telegramChecks } from "./checks.ts";
import { runPairing } from "./pair.ts";
import { createTelegramPollingProvider } from "./poll.ts";
import { createTelegramProvider } from "./send.ts";

const fileOf = (setting: unknown, name: string): string => {
  if (typeof setting !== "string" || setting === "") throw new TypeError(`telegram: messaging.${name} names no file`);
  return setting;
};

/**
 * The Telegram provider for the project's `messaging` key (its paths already resolved): the token, the chairman's chat id and, when `announcementsFile` is declared, the channel's are read
 * HERE, at the moment of building, so a file that has gone wrong since the last check is refused on the run that needed it. With `conversation: true` in the settings (the caller says
 * so, since it is not a setting of the key) it is the polling variant, which also listens. REFUSES a file that is not 0600 and the running user's, naming the path and never its content.
 */
export function create(settings: PluginSettings, deps: PluginDeps): MessagingProvider {
  const { readSecretFile, readChairman, readAnnouncementsChatId, redactingFetch, sleep } = deps.messaging;
  const token = readSecretFile(fileOf(settings.tokenFile, "tokenFile"));
  const { chatId } = readChairman(fileOf(settings.chairmanFile, "chairmanFile"));
  const announcementsChatId = readAnnouncementsChatId(typeof settings.announcementsFile === "string" ? settings.announcementsFile : null);
  const options = { token, chatId, announcementsChatId, fetch: deps.fetch, log: deps.log, ...(sleep === undefined ? {} : { sleep }), redactingFetch };
  return settings.conversation === true ? createTelegramPollingProvider(options) : createTelegramProvider(options);
}

/** The rows doctor shows for the plugin: the token file is readable by no one else, and the chairman has paired. */
export const doctorChecks = (settings: PluginSettings, deps: PluginDeps): readonly PluginCheck[] => telegramChecks(settings, deps);

export const onboardSteps = [] as const;

/** Prints a one-time code the chairman sends the bot from their own chat, and writes the chairman file when it comes back right. Exit 0 paired, 1 not. */
export const pair: MessagingPair = async ({ tokenFile, chairmanFile, print }, deps) => {
  const result = await runPairing({ token: deps.messaging.readSecretFile(tokenFile), chairmanFile, fetch: deps.fetch, print, redactingFetch: deps.messaging.redactingFetch,
    ...(deps.messaging.sleep === undefined ? {} : { sleep: deps.messaging.sleep }) });
  return result.paired ? 0 : 1;
};
