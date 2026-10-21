// @ts-check
// module: today's providers as catalog entries, and the pin that keeps core on them until each concern moves (A11-158)
//
// A BUILT-IN IS A PLUGIN WHOSE CODE STILL LIVES IN CORE. A live host names `linear`, `github`, `slack` and the rest in its host file, and no host file is migrated
// (A11-157 Decision 7), so the catalog must know them. Each row names the ticket that moves its code into `plugins/<name>`; that ticket deletes the row and its concern's
// pin. The settings each declares are exactly what `providers.ts` read for its block before the catalog, described by the entries of `config-schema.ts`.
//
// THE PIN. Core still runs the built-in of each concern, wired unconditionally (the tracker at `server.ts`, the code host at `pool-context.ts`). A host file that
// enabled a fake while core ran Linear would say one thing and do another, so while a concern is pinned the reader refuses any other plugin enabled for it, naming the
// ticket that moves it.
import { SCHEMA, type SchemaEntry } from "../ticket-mode/config-schema.ts";
import { blockOf, CONCERNS, type Concern } from "./concerns.ts";
import { CODE_HOST_CONTRACT_VERSION } from "./contracts/code-host.ts";
import { EXPOSURE_CONTRACT_VERSION } from "./contracts/exposure.ts";
import { MESSAGING_CONTRACT_VERSION } from "./contracts/messaging.ts";
import { PUBLISHER_CONTRACT_VERSION } from "./contracts/publisher.ts";
import { REVIEWER_CONTRACT_VERSION } from "./contracts/reviewer.ts";
import { TRACKER_CONTRACT_VERSION } from "./contracts/tracker.ts";
import { type CatalogPlugin, NO_TOOLING, type Pin } from "./manifest.ts";

/** The version of each concern's contract in this release: what a plugin written now declares. */
export const CONTRACT_VERSIONS: Readonly<Record<Concern, string>> = {
  tracker: TRACKER_CONTRACT_VERSION, codeHost: CODE_HOST_CONTRACT_VERSION, publisher: PUBLISHER_CONTRACT_VERSION,
  reviewer: REVIEWER_CONTRACT_VERSION, exposure: EXPOSURE_CONTRACT_VERSION, messaging: MESSAGING_CONTRACT_VERSION,
};

type Row = Readonly<{ name: string; concern: Concern; description: string; settings: readonly string[]; movedBy: string }>;

const EXPOSURE_SETTINGS = ["port", "uiPort", "terminal", "tailnetPorts"] as const;

const ROWS: readonly Row[] = [
  { name: "linear", concern: "tracker", description: "Linear: where tickets are kept and read.", settings: ["key", "connectors", "workingState", "plannedState", "takenStates"], movedBy: "A11-159" },
  { name: "github", concern: "codeHost", description: "GitHub: pull requests, reviews and checks.", settings: ["identity", "gh", "stack"], movedBy: "A11-160" },
  { name: "slack", concern: "publisher", description: "Slack: announces the pull requests a person chose, through a publish run.", settings: ["run", "model", "effort", "connectors"], movedBy: "A11-161" },
  { name: "atomic", concern: "reviewer", description: "The gate's codex reviewer, started for each ready pull request.", settings: [], movedBy: "A11-161" },
  { name: "local", concern: "exposure", description: "Serves the board on loopback only.", settings: EXPOSURE_SETTINGS, movedBy: "A11-162" },
  { name: "tailscale", concern: "exposure", description: "Serves the board and the worker terminal on the tailnet.", settings: EXPOSURE_SETTINGS, movedBy: "A11-162" },
  { name: "telegram", concern: "messaging", description: "Telegram: asks and announcements for the chairman. Configured in project.json's messaging key.", settings: [], movedBy: "A11-162" },
];

/** The schema entry of a block's own setting, as the Settings page describes it. A setting with no entry is a drift the schema test names. */
function entryOf(concern: Concern, setting: string): SchemaEntry {
  const key = `tickets.providers.${blockOf(concern)}.${setting}`;
  const entry = SCHEMA.find((candidate) => candidate.key === key);
  if (entry === undefined) throw new Error(`built-in plugin setting ${key} has no entry in config-schema.ts`);
  return entry;
}

/** The built-in plugins: today's providers, whose code is still in core. `none` is no plugin, and is not listed. */
export const BUILT_IN: readonly CatalogPlugin[] = Object.freeze(ROWS.map(({ name, concern, description, settings, movedBy }): CatalogPlugin => Object.freeze({
  name, concern, description, contract: CONTRACT_VERSIONS[concern], entry: null, tooling: NO_TOOLING, where: "core", dir: null, movedBy,
  settings: Object.freeze(Object.fromEntries(settings.map((setting) => [setting, entryOf(concern, setting)]))),
})));

/** The fakes, one per concern: in-memory implementations (`src/plugins/fakes/`) that pass their concern's suite and that core's own tests use. They run no host. */
export const FAKES: readonly CatalogPlugin[] = Object.freeze(CONCERNS.map((concern): CatalogPlugin => Object.freeze({
  name: `fake-${concern}`, concern, description: `An in-memory ${concern} that passes the ${concern} contract suite, for core's tests.`,
  contract: CONTRACT_VERSIONS[concern], entry: null, settings: Object.freeze({}), tooling: NO_TOOLING, where: "fake", dir: null, movedBy: null,
})));

/** What core still runs, by concern. A sibling ticket removes its concern's row when it moves the code. Messaging has no block, so no pin. */
export const CORE_RUNS: Readonly<Partial<Record<Concern, Pin>>> = Object.freeze({
  tracker: { runs: ["linear"], until: "A11-159" },
  codeHost: { runs: ["github"], until: "A11-160" },
  publisher: { runs: ["slack"], until: "A11-161" },
  reviewer: { runs: ["atomic"], until: "A11-161" },
  exposure: { runs: ["local", "tailscale"], until: "A11-162" },
});
