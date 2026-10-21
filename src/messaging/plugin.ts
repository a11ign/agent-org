// @ts-check
// module: the messaging plugin a project enables, loaded and built for the commands that talk to the chairman (A11-162)
//
// THE PROVIDER IS THE PLUGIN'S, NOT A DIRECT IMPORT. `messaging.provider` names an agent-org plugin of the messaging concern (`plugins/telegram`); this loads its module from the registry's
// catalog and builds the provider with the files the project's `messaging` key resolves to. `reply-cli.ts`, `watch.ts`, `listen.ts`, `route-guard.ts` and `decision-confidence-post.ts` get
// theirs here, and import no provider. A command that injects its own (`providers` in a test) keeps doing so: the registry below is only what they default to.
//
// A SECRET FILE THAT IS WRONG IS REFUSED BY THE CORE'S OWN READER (`SecretFileRefusal`), since the plugin reads it through `deps.messaging`, so every caller's handling of that refusal is unchanged.
import { homedir } from "node:os";
import { join } from "node:path";
import { realPluginDeps } from "../plugins/active.ts";
import { importPlugin } from "../plugins/loader.ts";
import type { Catalog, CatalogPlugin, PluginDeps, PluginModule, PluginSettings } from "../plugins/manifest.ts";
import { defaultCatalog, pluginNamed } from "../plugins/registry.ts";
import { type MessagingOn, knownProviders } from "./config.ts";
import { messagingHelpers } from "./plugin-helpers.ts";
import type { MessagingProvider } from "./provider-contract.ts";

/** What a caller may inject: its `fetch`, its clock and where its lines go (the real ones when absent), and a test's own catalog and importer. */
export type MessagingContext = Readonly<{
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
  env?: Readonly<Record<string, string | undefined>>;
  home?: string;
  catalog?: Catalog;
  importModule?: (url: string) => Promise<unknown>;
}>;

/** A messaging plugin the project names that cannot run here: not a bundled plugin of this checkout, or one the loader refuses. */
export class MessagingPluginRefusal extends Error {}

/** The plugin a configuration names, and its module: REFUSED by name when it is not a bundled plugin. */
export async function loadMessagingModule(provider: string, { catalog = defaultCatalog(), importModule }: Pick<MessagingContext, "catalog" | "importModule"> = {}): Promise<Readonly<{ plugin: CatalogPlugin; module: PluginModule }>> {
  const plugin = pluginNamed(catalog, provider);
  if (plugin === undefined || plugin.concern !== "messaging" || plugin.where !== "bundled") {
    throw new MessagingPluginRefusal(`messaging.provider ${JSON.stringify(provider)} is not a messaging plugin this checkout runs: \`agent-org plugin list\` shows them`);
  }
  try {
    return { plugin, module: await importPlugin(plugin, importModule) };
  } catch (error) {
    throw new MessagingPluginRefusal(`the messaging plugin ${provider} was refused: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** The settings the plugin takes from a configuration: the files its `messaging` key names, already resolved. `summary` and `milestones` are the core's and are not given. */
export function pluginSettingsOf(config: MessagingOn, extra: PluginSettings = {}): PluginSettings {
  return { tokenFile: config.tokenFile, chairmanFile: config.chairmanFile, announcementsFile: config.announcementsFile, ...extra };
}

/** The deps a messaging plugin runs with: the real programs and files, the caller's `fetch`, clock and log, and the secret helpers. */
export function messagingPluginDeps({ fetch: fetchImpl, sleep, log, env = process.env, home = homedir() }: MessagingContext = {}): PluginDeps {
  const base = realPluginDeps({ env, stateDir: join(home, ".local", "state", "agent-org"), pick: "assigned" });
  return { ...base, fetch: fetchImpl ?? base.fetch, log: log ?? base.log, messaging: messagingHelpers(sleep) };
}

/**
 * The provider for a configuration that is on, built by the plugin it names: the token, the chairman's chat id and, when `announcementsFile` is declared, the channel's are read HERE, at the
 * moment of building.
 */
export async function messagingProvider(config: MessagingOn, context: MessagingContext = {}): Promise<MessagingProvider> {
  const { module } = await loadMessagingModule(config.provider, context);
  return module.create(pluginSettingsOf(config), messagingPluginDeps(context)) as MessagingProvider;
}

/** The provider that also listens (`listen`, messaging contract 1.1), for the listener: it reads the token and the chairman's chat id, and not the announcements channel, since a listener never announces. */
export async function messagingListener(config: MessagingOn, context: MessagingContext = {}): Promise<MessagingProvider> {
  const { module } = await loadMessagingModule(config.provider, context);
  return module.create(pluginSettingsOf({ ...config, announcementsFile: null }, { conversation: true }), messagingPluginDeps(context)) as MessagingProvider;
}

/** How a command builds the provider its configuration names: what `providers[config.provider]` was. */
export type ProviderFactory = (config: MessagingOn, context?: Readonly<{ fetch?: typeof fetch; log?: (line: string) => void }>) => Promise<MessagingProvider>;

/**
 * The providers the registry holds, keyed by name: each builds through its plugin. A command's default `providers`; a test replaces it. `announcements: false` is for a command that only
 * speaks to the chairman's chat (`chairman:reply`): it does not read the announcements channel's file, as it never did.
 */
export function pluginProviders({ announcements = true }: Readonly<{ announcements?: boolean }> = {}): Record<string, ProviderFactory> {
  return Object.fromEntries(knownProviders().map((name): [string, ProviderFactory] => [name, (config, context = {}) => messagingProvider(announcements ? config : { ...config, announcementsFile: null }, context)]));
}
