// @ts-check
// module: activation -- the plugins a host enables, loaded once, and the accessor core asks for the implementation of a concern (A11-159)
//
// THE LOADER IS ASYNC AND THE CONTRACTS ARE NOT. A plugin's entry module is imported with `import()`, but the tracker contract's `TicketSource` is used by code that already holds
// one (`createBoard`'s `ctx.source`). So an entry that needs a plugin awaits `activatePlugins` once, at its start, and asks the result for the implementation: `ticket:serve`
// for the board (its tracker and its code host), `pr:open` for the tracker it reads, `ticket:review` for the code host alone, and nothing else on a call path. A
// plugin's refusal refuses the start by name, as a refused host file does. Each concern has its accessor here (A11-159, A11-162, A11-161); the publisher and the reviewer are optional, and
// an accessor answers null for one that is "none": no enabled plugin.
//
// MEMOIZED PER PROCESS: the second call returns the first's result, whatever it is given. A test calls `forgetActivation`.
import { PROVIDER_BLOCKS, type ProviderBlock } from "./concerns.ts";
import { isActive, type Providers } from "../ticket-mode/providers.ts";
import type { PickScope } from "../ticket-mode/settings.ts";
import type { CodeHost } from "./contracts/code-host.ts";
import type { Exposure } from "./contracts/exposure.ts";
import type { Publisher } from "./contracts/publisher.ts";
import type { Reviewer } from "./contracts/reviewer.ts";
import type { TicketSource } from "./contracts/tracker.ts";
import { type ImportModule, loadDefault, loadEnabled } from "./loader.ts";
import { activatedHost, forgetSlot, lightPluginDeps, PluginActivationRefusal, setActivated, substituteHost, substitutedHost } from "./code-host-slot.ts";
import type { Catalog, CodeHostPolicy, LoadedPlugin, PluginDeps, ReviewerHelpers } from "./manifest.ts";
import { gateHelpers } from "./reviewing-gate.ts";

export { coreRowsHelpers, loadedCodeHost } from "./code-host-slot.ts";
export { realExec, realExecAsync, realMode, realPlace, realProbe } from "./real-seams.ts";

export { PluginActivationRefusal };

/** The plugins the host enabled, loaded: ask for a concern's implementation. */
export type Active = Readonly<{
  loaded: readonly LoadedPlugin[];
  /** The enabled tracker plugin's source. REFUSES when the tracker block names a plugin with no code to run on a host (a fake, or a built-in). */
  tracker(): TicketSource;
  /** The enabled code host plugin's implementation. REFUSES when the code host block names a plugin with no code to run on a host (a fake). */
  codeHost(): CodeHost;
  /**
   * The enabled exposure plugin's implementation, or the concern's default (`local`) when the block is disabled or names none: an exposure always resolves, since serving on
   * loopback needs nothing installed. REFUSES when the exposure block names a plugin with no code to run on a host (a fake), and when this activation did not build the exposure.
   */
  exposure(): Exposure;
  /**
   * The enabled publisher plugin's implementation, or null when there is none: the block names `none`, or its plugin is disabled (A11-161). REFUSES when the block is on and names a plugin
   * with no code to run on a host (a fake), and when this activation did not build the publisher.
   */
  publisher(): Publisher | null;
  /** The enabled reviewer plugin's implementation, or null when there is none (A11-161). Refuses as {@link Active.publisher} does. */
  reviewer(): Reviewer | null;
}>;

const refused = (message: string): never => {
  throw new PluginActivationRefusal(message);
};

/** The implementation of the enabled plugin of `concern`, or the refusal that names the block and the plugin it holds. */
function implementationOf<Implementation>(providers: Providers, loaded: readonly LoadedPlugin[], concern: "tracker" | "codeHost", label: string): Implementation {
  const { provider } = providers.blocks[concern];
  const plugin = loaded.find(({ plugin: candidate }) => candidate.concern === concern);
  if (plugin === undefined) return refused(`the ${label} is ${provider}, which has no code to run on a host: name a bundled ${label} plugin in tickets.providers.${concern} (\`agent-org plugin list\`)`);
  return plugin.implementation as Implementation;
}

/**
 * The implementation of the enabled plugin of an OPTIONAL concern (the publisher, the reviewer), or null when the block is none or disabled: "none" is the absence of an enabled plugin. The
 * refusal names the block and the plugin it holds, as {@link implementationOf} does.
 */
function optionalImplementationOf<Implementation>(providers: Providers, loaded: readonly LoadedPlugin[], block: "publish" | "reviewer", blocks: readonly ProviderBlock[], label: string): Implementation | null {
  const report = providers.blocks[block];
  if (!isActive(report)) return null;
  if (!blocks.includes(block)) return refused(`the ${label} was not built by this process: it asked for the other plugins only`);
  const plugin = loaded.find(({ plugin: candidate }) => candidate.name === report.provider);
  if (plugin === undefined) return refused(`the ${label} is ${report.provider}, which has no code to run on a host: name a bundled ${label} plugin in tickets.providers.${block} (\`agent-org plugin list\`)`);
  return plugin.implementation as Implementation;
}

/** Loads the bundled plugins `providers` enables and answers their implementations. REFUSES, naming each plugin, any the loader refuses. Not memoized: see {@link activatePlugins}. */
export async function loadActive(providers: Providers, catalog: Catalog, deps: PluginDeps, importModule?: ImportModule, blocks: readonly ProviderBlock[] = PROVIDER_BLOCKS): Promise<Active> {
  const { loaded: enabled, refusals } = await loadEnabled(providers, catalog, deps, importModule, blocks);
  if (refusals.length > 0) return refused(refusals.map(({ plugin, concern, why }) => `the ${concern} plugin ${plugin} was refused: ${why}`).join("; "));
  // An exposure always resolves: a block that is switched off runs the concern's default, so the readers never ask whether there is one. A block that is on and names a plugin with
  // no code to run (a fake) is not defaulted: the host file would say one thing while core did another, and `exposure()` refuses it by name.
  const needsDefault = blocks.includes("exposure") && !providers.blocks.exposure.enabled;
  const fallback = needsDefault ? await loadDefault("exposure", providers, catalog, deps, importModule) : null;
  if (fallback?.refusal !== undefined) return refused(`the exposure plugin ${fallback.refusal.plugin} was refused: ${fallback.refusal.why}`);
  const loaded = fallback?.loaded === undefined ? enabled : [...enabled, fallback.loaded];
  return {
    loaded,
    tracker: () => implementationOf<TicketSource>(providers, loaded, "tracker", "tracker"),
    codeHost: () => implementationOf<CodeHost>(providers, loaded, "codeHost", "code host"),
    exposure: () => {
      const { provider } = providers.blocks.exposure;
      const plugin = loaded.find(({ plugin: candidate }) => candidate.concern === "exposure");
      if (plugin !== undefined) return plugin.implementation as Exposure;
      return refused(blocks.includes("exposure") ? `the exposure is ${provider}, which has no code to run on a host: name a bundled exposure plugin in tickets.providers.exposure (\`agent-org plugin list\`)`
        : "the exposure was not built by this process: it asked for the other plugins only");
    },
    publisher: () => optionalImplementationOf<Publisher>(providers, loaded, "publish", blocks, "publisher"),
    reviewer: () => optionalImplementationOf<Reviewer>(providers, loaded, "reviewer", blocks, "reviewer"),
  };
}

let activation: Promise<Active> | null = null;

/** {@link loadActive}, once per process. `blocks` narrows what is built to some blocks (`ticket:review` builds the code host alone). */
export function activatePlugins(providers: Providers, catalog: Catalog, deps: PluginDeps, importModule?: ImportModule, blocks?: readonly ProviderBlock[]): Promise<Active> {
  activation ??= loadActive(providers, catalog, deps, importModule, blocks).then((active) => { setActivated(active); return active; });
  return activation;
}

/** Forgets the activation, and any code host a test substituted, so a test starts from none. */
export function forgetActivation(): void {
  activation = null;
  forgetSlot();
}

/**
 * THE CODE HOST FOR CODE WITH NO DEPS CHAIN TO CARRY IT (A11-160): the host's own programs (`host:install`, `host:check`, the instance's start-up check) reach GitHub's wrapper from many places that are
 * called, not constructed. The entry point that needs one awaits {@link activatePlugins} (or `activateCodeHost`, which reads the host file's providers) first; this answers the implementation it built,
 * and REFUSES by name when nothing was activated, so a caller that forgot is told and never silently given a default.
 */
export function activeCodeHost(): CodeHost {
  const substitute = substitutedHost();
  if (substitute !== null) return substitute;
  const activated = activatedHost();
  if (activated === null) throw new PluginActivationRefusal("no code host is active in this process: its entry point activates the plugins before it asks (agent-org plugin list shows the code host)");
  return activated.codeHost();
}

/** Puts `host` where {@link activeCodeHost} answers it, for a test; `null` takes it away. {@link forgetActivation} takes it away too. */
export function substituteCodeHost(host: CodeHost | null): void {
  substituteHost(host);
}

/**
 * The deps core gives a plugin on this machine: the real `fetch`, programs and files. `pick` is the board's `tickets.pick`, `clones` the host's checkouts, `review` how a reviewer
 * judges a pull request, which only a process that loaded the gate can give (`corePolicy` says what the others do), and `reviewing` the reviewer's helpers with the board's collaborators
 * (a process that is not a board gives none, and a reviewer that asks for them is refused by name).
 */
export function realPluginDeps({ env, stateDir, pick, clones = {}, review, reviewing, recordCalls }: Readonly<{ env: Readonly<Record<string, string | undefined>>; stateDir: string; pick: PickScope; clones?: Readonly<Record<string, string>>; review?: CodeHostPolicy["review"]; reviewing?: ReviewerHelpers; recordCalls?: boolean }>): PluginDeps {
  return { ...lightPluginDeps({ env, stateDir, pick, clones, recordCalls, ...(review === undefined ? {} : { review }) }), reviewing: reviewing ?? gateHelpers() };
}
