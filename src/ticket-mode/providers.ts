// module: ticket mode's provider blocks -- the named blocks under `tickets.providers`, which provider each concern uses, its own settings, and the old keys that still stand for them (A11-144)
//
// A CONCERN IS A BLOCK, AND A BLOCK NAMES ITS PROVIDER. `tracker` is the tracker (`linear`), `codeHost` the code host (`github`), `publish` what a person's
// chosen pull requests are announced with (`slack`, or `none`), `reviewer` the reviewer (`atomic`, or `none`) and `exposure` where the board and the
// worker terminal are served (`local`, or `tailscale`). A provider is built into agent-org and picked here by name, not a Claude plugin (A11-143
// Decision 1). A provider that is not named here is refused by name, and so is a setting its block does not take.
//
// EACH PROVIDER READS ITS OWN BLOCK, AND ITS OWN ALIASES. An alias is an old key this release still reads for a setting of a block (A11-143
// Decision 6); `doctor --fix` moves it. A block wins over an alias. Both naming a setting with the SAME value reads the alias as stale; with
// DIFFERENT values the file is refused naming both keys, because choosing one silently would change behaviour. A missing block with no alias is the
// provider's default, and it is reported as `default`, so doctor can say so.
//
// PURE: the caller passes the parsed host file, and nothing is read here. Each setting comes back as its RAW value and the key it was read from, so
// the validators in `settings.ts` check it under the name the person wrote, and so a refusal names where the bad value is.
import { TicketSettingsRefusal } from "./settings-refusal.ts";

/** The blocks under `tickets.providers`, one per concern. */
export const PROVIDER_BLOCKS = ["tracker", "codeHost", "publish", "reviewer", "exposure"] as const;

/**
 * The release that refuses the old keys by name (A11-143 Decision 6): until it, each old key is read as an alias. The next release sets this to its own
 * version and removes the alias reads; this release only records the version.
 */
export const ALIASES_REFUSED_FROM = "0.263.0";
export type ProviderBlock = (typeof PROVIDER_BLOCKS)[number];

/** The providers each block names, in the order the schema lists them. */
const PROVIDERS: Readonly<Record<ProviderBlock, readonly string[]>> = {
  tracker: ["linear"],
  codeHost: ["github"],
  publish: ["slack", "none"],
  reviewer: ["atomic", "none"],
  exposure: ["local", "tailscale"],
};

/** The provider a block with no block of its own, and no alias, is: what a machine with no `tickets.providers` runs today. */
export const DEFAULT_PROVIDER: Readonly<Record<ProviderBlock, string>> = {
  tracker: "linear",
  codeHost: "github",
  publish: "none",
  reviewer: "none",
  exposure: "local",
};

/** The settings each block takes, besides its `provider`. A key not listed is refused by name. */
const SETTINGS: Readonly<Record<ProviderBlock, readonly string[]>> = {
  tracker: ["key", "connectors", "workingState", "plannedState"],
  codeHost: ["identity", "gh", "stack"],
  publish: ["run", "model", "effort", "connectors"],
  reviewer: [],
  exposure: ["port", "uiPort", "terminal", "tailnetPorts"],
};

/** The settings a publisher takes, which only the `slack` provider reads. */
const PUBLISH_SETTINGS = ["run", "model", "effort", "connectors"] as const;

/** Where a block's settings came from: the block itself, an alias, or no key at all, which is the provider's default. */
export type Source = "block" | "aliases" | "default";

/** A setting's value as the file holds it (`undefined` when no key of it is in the file), and the key the value was read from. */
export type Setting = Readonly<{ value: unknown; at: string }>;

/**
 * An old key a setting is still read from, and the place it moves to. `stale` is set when the block already holds the same value, so moving the old key
 * changes nothing: `doctor --fix` then only removes it.
 */
export type AliasRead = Readonly<{ old: string; new: string; stale: boolean }>;

/** One block: its provider's name, where its settings came from, and each setting by its name in the block. */
export type BlockReport = Readonly<{ provider: string; from: Source; settings: Readonly<Record<string, Setting>> }>;

/** Every block, and every old key the file still reads. */
export type Providers = Readonly<{ blocks: Readonly<Record<ProviderBlock, BlockReport>>; aliases: readonly AliasRead[] }>;

/** The shape a publish block takes, named in each refusal of one. */
export const PUBLISHER_SHAPE = "must be { \"run\": \"<the publish run's instruction, naming {prs} and {dir}>\", \"model\": \"<optional, haiku>\", \"effort\": \"<optional, low>\", \"connectors\": [\"^mcp__...\"] }";

/** A Linear connector's pattern: the tracker's own reads, which move into the `tracker` block. */
const LINEAR_CONNECTOR = /^\^mcp__(linear__|claude_ai_Linear__)/;

/** Whether a connector pattern is one of the tracker's, as `tracker.connectors` takes them. */
export const isLinearConnector = (pattern: string): boolean => LINEAR_CONNECTOR.test(pattern);

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** A JSON value with its object keys sorted, so two values that hold the same entries are the same whatever order they were written in. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isObject(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value) ?? "undefined";
}

const sameValue = (left: unknown, right: unknown): boolean => canonical(left) === canonical(right);

/** Two lists hold the same patterns, in whatever order. */
const sameList = (left: unknown, right: unknown): boolean => {
  const sorted = (list: unknown) => (Array.isArray(list) ? [...list].map(canonical).sort() : list);
  return sameValue(sorted(left), sorted(right));
};

/** What a key of the file holds, and where: `undefined` when the file holds none of it. */
type Found = Readonly<{ value: unknown; at: string }>;
const found = (value: unknown, at: string): Found | undefined => (value === undefined ? undefined : { value, at });

/** Where one setting may be named: the block's key, the old key it still stands for, and the place it moves to. */
type Choice = Readonly<{ own: Found | undefined; alias: Found | undefined; newAt: string; same?: (left: unknown, right: unknown) => boolean }>;

/** A setting from the block, else from the alias, else with no value at its own key. Both: the same value is stale, another value is refused by name. */
function choose({ own, alias, newAt, same = sameValue }: Choice, read: AliasRead[]): Setting {
  if (own === undefined) {
    if (alias === undefined) return { value: undefined, at: newAt };
    read.push({ old: alias.at, new: newAt, stale: false });
    return alias;
  }
  if (alias === undefined) return own;
  if (!same(own.value, alias.value)) {
    throw new TicketSettingsRefusal(alias.at, `and ${own.at} both name the same setting with different values, so one would be chosen silently: remove ${alias.at}, or make it match ${own.at}`);
  }
  read.push({ old: alias.at, new: newAt, stale: true });
  return own;
}

/** A setting the block holds, with no alias for it: its value at its own key, or none. */
const plain = (own: Found | undefined, at: string): Setting => own ?? { value: undefined, at };

/** The blocks under `tickets`, refused by name when one is not a block of this release. */
function blocksOf(tickets: Record<string, unknown>): Record<string, unknown> {
  const providers = tickets.providers;
  if (providers === undefined) return {};
  if (!isObject(providers)) {
    throw new TicketSettingsRefusal("tickets.providers", "must be an object of named blocks, such as { \"tracker\": { \"provider\": \"linear\" } }");
  }
  for (const name of Object.keys(providers)) {
    if (!(PROVIDER_BLOCKS as readonly string[]).includes(name)) {
      throw new TicketSettingsRefusal(`tickets.providers.${name}`, `is not a provider block: the blocks are ${PROVIDER_BLOCKS.join(", ")}`);
    }
  }
  return providers;
}

/**
 * A block's provider, refused by name unless the block is an object that names one of its concern's providers, and it takes no setting it does not name.
 * Absent is undefined, so the caller says whether the default or an alias applies.
 */
function providerOf(block: ProviderBlock, value: unknown): string | undefined {
  if (value === undefined) return undefined;
  const at = `tickets.providers.${block}`;
  if (!isObject(value)) throw new TicketSettingsRefusal(at, `must be an object with a provider, such as { "provider": "${DEFAULT_PROVIDER[block]}" }, not ${JSON.stringify(value)}`);
  const { provider } = value;
  if (provider === undefined) {
    throw new TicketSettingsRefusal(`${at}.provider`, `is required: name the block's provider, one of ${PROVIDERS[block].map((name) => `"${name}"`).join(", ")}, as onboard does`);
  }
  if (typeof provider !== "string" || !PROVIDERS[block].includes(provider)) {
    throw new TicketSettingsRefusal(`${at}.provider`, `must be one of ${PROVIDERS[block].map((name) => `"${name}"`).join(", ")}, not ${JSON.stringify(provider)}`);
  }
  for (const key of Object.keys(value)) {
    if (key !== "provider" && !SETTINGS[block].includes(key)) {
      throw new TicketSettingsRefusal(`${at}.${key}`, `is not a setting of ${block}: its settings are ${["provider", ...SETTINGS[block]].join(", ")}`);
    }
  }
  return provider;
}

/** The block's own value of `name`, found at its key under `tickets.providers`. */
const ownOf = (value: unknown, block: ProviderBlock, name: string): Found | undefined => found(isObject(value) ? value[name] : undefined, `tickets.providers.${block}.${name}`);

/** Where a block's settings came from: the block when it has one, else an alias when it read one, else the default. */
const sourceOf = (block: unknown, read: readonly AliasRead[]): Source => (block !== undefined ? "block" : read.length > 0 ? "aliases" : "default");

/** The report of one block. */
function reportOf(provider: string, settings: Record<string, Setting>, from: Source): BlockReport {
  return Object.freeze({ provider, from, settings: Object.freeze(settings) });
}

function trackerOf(block: unknown, tickets: Record<string, unknown>, read: AliasRead[]): BlockReport {
  const provider = providerOf("tracker", block) ?? DEFAULT_PROVIDER.tracker;
  const own = (name: string) => ownOf(block, "tracker", name);
  const linear = Array.isArray(tickets.connectors) ? tickets.connectors.filter((pattern) => typeof pattern === "string" && isLinearConnector(pattern)) : [];
  const planner = isObject(tickets.planner) ? tickets.planner : {};
  const settings = {
    key: choose({ own: own("key"), alias: found(tickets.linearKey, "tickets.linearKey"), newAt: "tickets.providers.tracker.key" }, read),
    connectors: choose({ own: own("connectors"), alias: linear.length > 0 ? found(linear, "tickets.connectors") : undefined, newAt: "tickets.providers.tracker.connectors", same: sameList }, read),
    workingState: choose({ own: own("workingState"), alias: found(tickets.workingState, "tickets.workingState"), newAt: "tickets.providers.tracker.workingState" }, read),
    plannedState: choose({ own: own("plannedState"), alias: found(planner.state, "tickets.planner.state"), newAt: "tickets.providers.tracker.plannedState" }, read),
  };
  return reportOf(provider, settings, sourceOf(block, read));
}

function codeHostOf(block: unknown, root: Record<string, unknown>, read: AliasRead[]): BlockReport {
  const provider = providerOf("codeHost", block) ?? DEFAULT_PROVIDER.codeHost;
  const own = (name: string) => ownOf(block, "codeHost", name);
  // A `github` that is not an object is refused by the strict host reader, which reads the whole file, and not here: ticket settings ignore it.
  const github = isObject(root.github) ? root.github : {};
  const settings = {
    identity: choose({ own: own("identity"), alias: found(github.identity, "github.identity"), newAt: "tickets.providers.codeHost.identity" }, read),
    gh: choose({ own: ownOf(block, "codeHost", "gh"), alias: found(root.gh, "gh"), newAt: "tickets.providers.codeHost.gh" }, read),
    stack: plain(own("stack"), "tickets.providers.codeHost.stack"),
  };
  return reportOf(provider, settings, sourceOf(block, read));
}

/**
 * `tickets.publish` is one object, and its presence is the `slack` provider: the old reading. A block names its own provider, so a block of `none` with
 * the old object is refused, and a block of `slack` with the same object is read as stale.
 */
function publishOf(block: unknown, tickets: Record<string, unknown>, read: AliasRead[]): BlockReport {
  const alias = isObject(tickets.publish) ? tickets.publish : undefined;
  if (tickets.publish !== undefined && alias === undefined) throw new TicketSettingsRefusal("tickets.publish", PUBLISHER_SHAPE);
  const provider = providerOf("publish", block);
  if (provider === undefined) {
    if (alias === undefined) return reportOf(DEFAULT_PROVIDER.publish, {}, "default");
    read.push({ old: "tickets.publish", new: "tickets.providers.publish", stale: false });
    return reportOf("slack", fieldsOf(alias, "tickets.publish"), "aliases");
  }
  const own = isObject(block) ? block : {};
  if (provider === "none") {
    const stray = PUBLISH_SETTINGS.find((name) => own[name] !== undefined);
    if (stray !== undefined) throw new TicketSettingsRefusal(`tickets.providers.publish.${stray}`, "does not apply under provider none, which publishes nothing");
    if (alias !== undefined) throw new TicketSettingsRefusal("tickets.publish", "is set, but tickets.providers.publish names provider none: remove one of them");
    return reportOf(provider, {}, sourceOf(block, read));
  }
  const fromBlock = Object.fromEntries(PUBLISH_SETTINGS.filter((name) => own[name] !== undefined).map((name) => [name, own[name]]));
  if (alias !== undefined) {
    // Only the four settings the old object held are compared: a key the reader never took beside them is not a second value of the same setting.
    const fromAlias = Object.fromEntries(PUBLISH_SETTINGS.filter((name) => alias[name] !== undefined).map((name) => [name, alias[name]]));
    if (!sameValue(fromBlock, fromAlias)) {
      throw new TicketSettingsRefusal("tickets.publish", "and tickets.providers.publish both name the publish run with different values, so one would be chosen silently: remove tickets.publish, or make it match");
    }
    read.push({ old: "tickets.publish", new: "tickets.providers.publish", stale: true });
  }
  return reportOf(provider, fieldsOf(own, "tickets.providers.publish"), sourceOf(block, read));
}

/** The publish settings of an object, each at the key it was read from: `prefix` plus its name. */
function fieldsOf(source: Record<string, unknown>, prefix: string): Record<string, Setting> {
  return Object.fromEntries(PUBLISH_SETTINGS.map((name) => [name, { value: source[name], at: `${prefix}.${name}` }]));
}

function reviewerOf(block: unknown, tickets: Record<string, unknown>, read: AliasRead[]): BlockReport {
  const provider = providerOf("reviewer", block);
  const alias = tickets.reviewer;
  if (alias !== undefined && alias !== "atomic") throw new TicketSettingsRefusal("tickets.reviewer", `must be "atomic" or absent, not ${JSON.stringify(alias)}`);
  if (provider === undefined) {
    if (alias === undefined) return reportOf(DEFAULT_PROVIDER.reviewer, {}, "default");
    read.push({ old: "tickets.reviewer", new: "tickets.providers.reviewer", stale: false });
    return reportOf("atomic", {}, "aliases");
  }
  if (alias !== undefined) {
    if (provider !== "atomic") throw new TicketSettingsRefusal("tickets.reviewer", "is set, but tickets.providers.reviewer names provider none: remove one of them");
    read.push({ old: "tickets.reviewer", new: "tickets.providers.reviewer", stale: true });
  }
  return reportOf(provider, {}, sourceOf(block, read));
}

function exposureOf(block: unknown, tickets: Record<string, unknown>, read: AliasRead[]): BlockReport {
  const serve = found(tickets.serve, "tickets.serve");
  if (serve !== undefined && serve.value !== "tailscale") {
    throw new TicketSettingsRefusal("tickets.serve", `must be "tailscale", or absent to serve the board on loopback only, not ${JSON.stringify(serve.value)}`);
  }
  const named = providerOf("exposure", block);
  let provider: string;
  if (named !== undefined) {
    if (serve !== undefined && named !== "tailscale") {
      throw new TicketSettingsRefusal("tickets.serve", "is set, but tickets.providers.exposure names provider local: remove one of them");
    }
    provider = named;
    if (serve !== undefined) read.push({ old: "tickets.serve", new: "tickets.providers.exposure.provider", stale: true });
  } else {
    provider = serve === undefined ? DEFAULT_PROVIDER.exposure : "tailscale";
    if (serve !== undefined) read.push({ old: "tickets.serve", new: "tickets.providers.exposure.provider", stale: false });
  }
  const own = (name: string) => ownOf(block, "exposure", name);
  const settings: Record<string, Setting> = {
    port: choose({ own: own("port"), alias: found(tickets.port, "tickets.port"), newAt: "tickets.providers.exposure.port" }, read),
    uiPort: choose({ own: own("uiPort"), alias: found(tickets.uiPort, "tickets.uiPort"), newAt: "tickets.providers.exposure.uiPort" }, read),
    terminal: choose({ own: own("terminal"), alias: found(tickets.terminal, "tickets.terminal"), newAt: "tickets.providers.exposure.terminal" }, read),
  };
  if (provider === "local") {
    const tailnet = own("tailnetPorts");
    if (tailnet !== undefined) throw new TicketSettingsRefusal(tailnet.at, "is read only with provider tailscale, which this block does not name");
    if (tickets.servePorts !== undefined) {
      throw new TicketSettingsRefusal("tickets.servePorts", "is read only with a tailscale exposure, which is not named");
    }
    settings.tailnetPorts = { value: undefined, at: "tickets.providers.exposure.tailnetPorts" };
  } else {
    settings.tailnetPorts = choose({ own: own("tailnetPorts"), alias: found(tickets.servePorts, "tickets.servePorts"), newAt: "tickets.providers.exposure.tailnetPorts" }, read);
  }
  return reportOf(provider, settings, sourceOf(block, read));
}

/**
 * Each block's provider and settings, and each old key still read, from the parsed host file. PURE: the caller reads and parses the file. Refused by
 * name: a block that is not one of the five, a provider that is not one of its concern's, a setting its block does not take, and a block and an alias
 * that name one setting with different values.
 */
export function resolveProviders(host: unknown): Providers {
  const root = isObject(host) ? host : {};
  const tickets = isObject(root.tickets) ? root.tickets : {};
  const blocks = blocksOf(tickets);
  const read: AliasRead[] = [];
  const reports = {
    tracker: trackerOf(blocks.tracker, tickets, read),
    codeHost: codeHostOf(blocks.codeHost, root, read),
    publish: publishOf(blocks.publish, tickets, read),
    reviewer: reviewerOf(blocks.reviewer, tickets, read),
    exposure: exposureOf(blocks.exposure, tickets, read),
  };
  return Object.freeze({ blocks: Object.freeze(reports), aliases: Object.freeze(read) });
}
