// @ts-check
// module: where a process keeps its code host, and how row mode gets one on its own (A11-160, step 4)
//
// `active.ts` is the activation: it loads the plugins a host enables, and its module graph holds the gate (the reviewer's helpers). Row mode's GitHub operations are reached from about 150 programs and from
// the tests of the code that calls them, and a program that reaches for one must not load the activation to do it. So the process's code host lives HERE, in a module whose graph is light:
//   - `active.ts` puts into it what it activated (`setActivated`) and what a test substituted (`substituteHost`);
//   - row mode asks it (`loadedCodeHost`), and when nothing is there it loads the host file's code host by `require` (`activate-host-sync.ts`) with deps that name no reviewer helpers;
//   - core registers what it owns of row mode (`registerRowsHelpers`, called by `rows.ts`), and the code host's deps ask for it when an operation needs it (`coreRowsHelpers`).
import { readFileSync } from "node:fs";
import { messagingHelpers } from "../messaging/plugin-helpers.ts";
import type { PickScope } from "../ticket-mode/settings.ts";
import { loadCodeHostSync } from "./activate-host-sync.ts";
import type { CodeHost } from "./contracts/code-host.ts";
import type { RowsHelpers, RowsProjectHelpers, RowsReadHelpers } from "./contracts/code-host-rows.ts";
import type { CodeHostPolicy, LoadedPlugin, PluginDeps, ReviewerHelpers } from "./manifest.ts";
import { countedFetch } from "../ticket-mode/call-outcomes.ts";
import { corePolicy } from "./policy.ts";
import { publishingHelpers } from "./publishing-helpers.ts";
import { realExec, realExecAsync, realMode, realPlace, realProbe } from "./real-seams.ts";

/** A plugin that cannot run the host, or a concern with nothing to run it: the start is refused with the reason, naming the concern and the plugin. */
export class PluginActivationRefusal extends Error {}

/** What an activation answers that the slot reads: the plugins it loaded and the code host among them. */
export type ActivatedHost = Readonly<{ loaded: readonly LoadedPlugin[]; codeHost(): CodeHost }>;

/** What the activation answered, once it has: the synchronous accessors read it. */
let activated: ActivatedHost | null = null;
/** A code host a test put in place of the activated one. */
let substitute: CodeHost | null = null;
/** The code host row mode loaded on its own because nothing activated one (`activate-host-sync.ts`). */
let loadedForRows: CodeHost | null = null;
/** What core owns of row mode that reads nothing of the project, registered by `rows.ts`, and what reads the project, registered by `row-mode.ts`. */
let rowsReadSource: (() => RowsReadHelpers) | null = null;
let rowsProjectSource: (() => RowsProjectHelpers) | null = null;

/** Reads the host file where `$AGENT_ORG_HOST` names it, and nothing else: a host file with no such variable is the defaults. Row mode registers the full reader (`registerHostFileReader`). */
const envOnlyHostFile = (env: NodeJS.ProcessEnv): string | null => {
  const path = env.AGENT_ORG_HOST;
  if (path === undefined || path === "") return null;
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
};
let hostFileReader: (env: NodeJS.ProcessEnv) => string | null = envOnlyHostFile;

/**
 * Registers how the host file is found when `$AGENT_ORG_HOST` names none (the file of the checkout the tool runs from), which reads the project's declaration and so is row mode's alone to import
 * (`row-mode.ts`). Without it, the host file is the one the variable names.
 */
export function registerHostFileReader(read: (env: NodeJS.ProcessEnv) => string | null): void {
  hostFileReader = read;
}

/** The host file's text as row mode reads it, or null when it cannot be read (the defaults then name the code host). */
export const hostFileTextForRows = (env: NodeJS.ProcessEnv): string | null => hostFileReader(env);

export const activatedHost = (): ActivatedHost | null => activated;
export const substitutedHost = (): CodeHost | null => substitute;

export function setActivated(host: ActivatedHost): void {
  activated = host;
}

export function substituteHost(host: CodeHost | null): void {
  substitute = host;
}

/** Forgets what was activated, substituted and loaded on row mode's own, so a test starts from none. */
export function forgetSlot(): void {
  activated = null;
  substitute = null;
  loadedForRows = null;
}

/** Registers what core owns of row mode that reads nothing of the project. `rows.ts` does it when it loads. */
export function registerRowsReadHelpers(source: () => RowsReadHelpers): void {
  rowsReadSource = source;
}

/**
 * Registers what core owns of row mode that reads the project. `row-mode.ts` does it when it loads, so the modules that hold the project's vocabulary and board are imported by the delegates whose operations
 * read them and by nothing else: ticket mode, doctor, onboard and a read of rows by label run on a host with no project declaration, and importing them there is a refusal.
 */
export function registerRowsProjectHelpers(source: () => RowsProjectHelpers): void {
  rowsProjectSource = source;
}

/**
 * `PluginDeps.rows`: core's row-mode helpers, as registered. The part that reads the project is read when an operation asks for it, and THROWS, naming the file that registers it, in a program that
 * never loaded it. The part that reads nothing of the project is `rows.ts`'s, which every program that reaches the code host's rows loads.
 */
export const coreRowsHelpers = (): RowsHelpers => {
  if (rowsReadSource === null) throw new Error("row mode's helpers are not registered in this process: they are registered by src/plugins/rows.ts, which every delegate to the code host's rows loads");
  const project = (): RowsProjectHelpers => {
    if (rowsProjectSource === null) throw new Error("row mode's project helpers are not registered in this process: they are registered by src/plugins/row-mode.ts, which every delegate whose operation reads the project loads");
    return rowsProjectSource();
  };
  return { ...rowsReadSource(), get labels() { return project().labels; }, get board() { return project().board; }, homeTracker: () => project().homeTracker(), get waits() { return project().waits; } };
};

/** The reviewer's helpers a code host loaded on row mode's own is given: none, and a plugin that asks for one is refused by name. */
const NO_REVIEWER_HELPERS = new Proxy({}, {
  get: (_target, name) => {
    throw new Error(`the reviewer's helper ${String(name)} is not loaded: the code host row mode loads on its own is given none, and a program that starts reviewers activates its plugins first`);
  },
}) as ReviewerHelpers;

/** Every dep a plugin is given except the reviewer's helpers, which are the gate's and so are `active.ts`'s to give. */
export function lightPluginDeps({ env, stateDir, pick, clones = {}, review }: Readonly<{ env: Readonly<Record<string, string | undefined>>; stateDir: string; pick: PickScope; clones?: Readonly<Record<string, string>>; review?: CodeHostPolicy["review"] }>): Omit<PluginDeps, "reviewing"> {
  return { env, stateDir, pick, clones, policy: corePolicy(review), log: (line) => process.stderr.write(`${line}\n`), fetch: countedFetch((input, init) => fetch(input, init)), exec: realExec, execAsync: realExecAsync, readFile: (path) => readFileSync(path, "utf8"), mode: realMode,
    probe: realProbe, messaging: messagingHelpers(), publishing: publishingHelpers(), rows: coreRowsHelpers, place: realPlace };
}

/**
 * THE CODE HOST FOR CODE THAT CANNOT AWAIT ONE (A11-160, step 4): row mode's operations, and the argument lists onboard and the conventions install ask of it. the one a test substituted, else the one an activation built, else the host file's code host, loaded once by `require` (`activate-host-sync.ts`). Row mode's
 * GitHub operations are reached from about 150 programs that are synchronous from their first line, so none can await an activation first. REFUSES, naming the plugin, a code host that cannot be loaded.
 */
export function loadedCodeHost(env: NodeJS.ProcessEnv = process.env): CodeHost {
  if (substitute !== null) return substitute;
  if (activated !== null && activated.loaded.some(({ plugin }) => plugin.concern === "codeHost")) return activated.codeHost();
  loadedForRows ??= loadCodeHostSync(hostFileReader(env), env, (own) => ({ ...lightPluginDeps({ env: own, stateDir: "", pick: "assigned" }), reviewing: NO_REVIEWER_HELPERS }));
  return loadedForRows;
}
