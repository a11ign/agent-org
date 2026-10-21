// @ts-check
// module: the six concerns an agent-org plugin can serve, and where each one's settings are written in the host file (A11-158)
//
// DATA ONLY, AND IT IMPORTS NOTHING. A concern is what a plugin is for: `tracker`, `codeHost`, `publisher`, `reviewer`, `exposure` or `messaging`. Five of them
// are a block under `tickets.providers`; the publisher's block keeps the name A11-144 gave it, `publish`. Messaging is configured in the project's
// `project.json` (`messaging`), and has no block until A11-162 moves it.
//
// "AGENT-ORG PLUGIN" AND "CLAUDE PLUGIN" ARE TWO THINGS. A Claude plugin is what `tickets.plugins` lists (skills and conventions, A11-133); an agent-org plugin is a
// code module behind one of these contracts. Wherever both could be meant, the words say which.

/** The concerns, in the order the CLI and doctor list them. */
export const CONCERNS = ["tracker", "codeHost", "publisher", "reviewer", "exposure", "messaging"] as const;
export type Concern = (typeof CONCERNS)[number];

/** The blocks under `tickets.providers`, one per concern that has one. */
export const PROVIDER_BLOCKS = ["tracker", "codeHost", "publish", "reviewer", "exposure"] as const;
export type ProviderBlock = (typeof PROVIDER_BLOCKS)[number];

/** The concern a block is configured for. */
export const CONCERN_OF_BLOCK: Readonly<Record<ProviderBlock, Concern>> = { tracker: "tracker", codeHost: "codeHost", publish: "publisher", reviewer: "reviewer", exposure: "exposure" };

/** The block a concern is configured in, or null for messaging, which `project.json` holds. */
export const blockOf = (concern: Concern): ProviderBlock | null => PROVIDER_BLOCKS.find((block) => CONCERN_OF_BLOCK[block] === concern) ?? null;

/** What a person calls a concern, in a sentence. */
export const CONCERN_LABEL: Readonly<Record<Concern, string>> = {
  tracker: "tracker", codeHost: "code host", publisher: "publisher", reviewer: "reviewer", exposure: "exposure", messaging: "messaging",
};

/** The concerns of which exactly one plugin must be enabled (Decision 6 of A11-157): disabling or uninstalling the only one is refused by name. */
export const REQUIRED_CONCERNS: readonly Concern[] = ["tracker", "codeHost"];
