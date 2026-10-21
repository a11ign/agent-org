// @ts-check
// module: the Settings page's Plugins section -- the words of a row, which settings a plugin's Configure draws, and where each control sits (A11-163)
//
// PURE, AND SENT TO THE BROWSER AS IT IS, like `settings-search.ts`: `ui-server.ts` serves it as `/plugins-section.js` with the types stripped, so it imports nothing and uses no Node
// API. The page draws what `GET /api/plugins` answers (`plugins/health.ts`'s account) with these rules, and they are tested here without a browser. A state is always said in words,
// never by colour alone; a control a plan refused is drawn off with the refusal's sentence beside it; a secret is a command with a copy button, never a field.

/** The plugin concerns the page lists, in its order, and what each is called on the page. */
export const CONCERNS = [
  { concern: "tracker", title: "Tracker", group: "Tracker" },
  { concern: "codeHost", title: "Code host", group: "Code host" },
  { concern: "publisher", title: "Publisher", group: "Publisher" },
  { concern: "reviewer", title: "Reviewer", group: "Reviewer" },
  { concern: "exposure", title: "Exposure", group: "Exposure" },
  { concern: "messaging", title: "Messaging", group: null },
] as const;

/** The groups of the Settings page's rows that the Plugins section draws under their concern, once it has been read. */
export const PLUGIN_GROUPS: readonly string[] = CONCERNS.flatMap(({ group }) => (group === null ? [] : [group]));

/** The concern a group of rows belongs to, or null for a group the Plugins section does not draw. */
export const concernOfGroup = (group: string): string | null => CONCERNS.find((entry) => entry.group === group)?.concern ?? null;

/** What the controls are called. */
export const CONTROL_LABEL = { install: "Install", enable: "Enable", disable: "Disable", uninstall: "Uninstall", configure: "Configure" } as const;

export type ControlName = keyof typeof CONTROL_LABEL;

/** The part of a plugin's entry the page's words read. */
export type Described = Readonly<{ name: string; version: string; contract: string; state: string; where: string; description: string }>;

/** A plugin's row in words: its name, version, contract version and state. */
export const rowWords = (plugin: Described): string => `${plugin.name}. Version ${plugin.version}. Contract ${plugin.contract}. State: ${plugin.state}.`;

/** A row the Plugins section does not draw as a setting: the plugin and `enabled` lines, which the state and the controls show. */
export const isProviderLine = (key: string): boolean => /^tickets\.providers\.[^.]+\.(?:provider|enabled)$/.test(key);

const escaped = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Whether a row's key is one a schema key stands for: its `<name>` takes one segment, and a list's `[]` takes the same marker the row carries. */
export function keyMatches(pattern: string, key: string): boolean {
  const source = pattern.split(/(<[a-z]+>)/).map((part, index) => (index % 2 === 1 ? "[^.]+" : escaped(part))).join("");
  return new RegExp(`^${source}$`).test(key);
}

/** The slice of a plugin's entry that says which settings are its own and whether it runs. */
export type Owner = Readonly<{ installed: boolean; enabled: boolean; settingKeys: readonly string[] }>;

/**
 * Whether a row of a concern's group is the settings of a plugin that is not the one in force: a setting only another plugin of the concern declares (Tailscale's tailnet ports while
 * `local` runs). It does not matter now, as an alias that is not set does not: the page hides it, and a search still finds it. A row no plugin declares (an old key, a row-mode key) is the
 * concern's, and is always drawn.
 */
export function ofAnotherPlugin(plugins: readonly Owner[], key: string): boolean {
  const owners = plugins.filter(({ settingKeys }) => settingKeys.some((pattern) => keyMatches(pattern, key)));
  return owners.length > 0 && !owners.some(({ installed, enabled }) => installed || enabled);
}

/** The words a concern with no plugin running shows: the sentence, then how to add or enable one. */
export const emptyWords = (empty: Readonly<{ text: string; commands: readonly string[] }>): string => `${empty.text}. ${empty.commands.length === 0 ? "" : `Run ${empty.commands.join(" or ")}.`}`.trim();

/** The controls a row draws as buttons, in order: every one the entry offers, `configure` last. */
export const controlsOf = (offered: readonly ControlName[]): readonly ControlName[] => [...offered.filter((name) => name !== "configure"), ...offered.filter((name) => name === "configure")];

/** What the page says an action did: the sentence the action answered, then when it is in force. */
export const outcomeWords = (done: Readonly<{ said: string; inForce: readonly string[] }>): string => [done.said, ...done.inForce].join(". ").replace(/\.\./g, ".");

/** The words that say a plugin's secrets are set by the CLI. */
export const SECRET_WORDS = "A secret is never typed in this page. Set it with the command below, then run `agent-org doctor`.";
