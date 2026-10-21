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
import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { PROVIDER_BLOCKS, type ProviderBlock } from "./concerns.ts";
import { isActive, type Providers } from "../ticket-mode/providers.ts";
import type { PickScope } from "../ticket-mode/settings.ts";
import type { CodeHost } from "./contracts/code-host.ts";
import type { Exposure } from "./contracts/exposure.ts";
import type { Publisher } from "./contracts/publisher.ts";
import type { Reviewer } from "./contracts/reviewer.ts";
import type { TicketSource } from "./contracts/tracker.ts";
import { type ImportModule, loadDefault, loadEnabled } from "./loader.ts";
import type { Catalog, CodeHostPolicy, ExecOptions, ExecResult, HostPlaceReading, LoadedPlugin, PluginDeps, ProbeRequest, ReviewerHelpers } from "./manifest.ts";
import { messagingHelpers } from "../messaging/plugin-helpers.ts";
import { corePolicy } from "./policy.ts";
import { publishingHelpers } from "./publishing-helpers.ts";
import { gateHelpers } from "./reviewing-gate.ts";

/** A plugin that cannot run the host, or a concern with nothing to run it: the start is refused with the reason, naming the concern and the plugin. */
export class PluginActivationRefusal extends Error {}

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
/** What the activation answered, once it has: the synchronous accessors read it. */
let activated: Active | null = null;
/** A code host a test put in place of the activated one. */
let substitute: CodeHost | null = null;

/** {@link loadActive}, once per process. `blocks` narrows what is built to some blocks (`ticket:review` builds the code host alone). */
export function activatePlugins(providers: Providers, catalog: Catalog, deps: PluginDeps, importModule?: ImportModule, blocks?: readonly ProviderBlock[]): Promise<Active> {
  activation ??= loadActive(providers, catalog, deps, importModule, blocks).then((active) => (activated = active));
  return activation;
}

/** Forgets the activation, and any code host a test substituted, so a test starts from none. */
export function forgetActivation(): void {
  activation = null;
  activated = null;
  substitute = null;
}

/**
 * THE CODE HOST FOR CODE WITH NO DEPS CHAIN TO CARRY IT (A11-160): the host's own programs (`host:install`, `host:check`, the instance's start-up check) reach GitHub's wrapper from many places that are
 * called, not constructed. The entry point that needs one awaits {@link activatePlugins} (or `activateCodeHost`, which reads the host file's providers) first; this answers the implementation it built,
 * and REFUSES by name when nothing was activated, so a caller that forgot is told and never silently given a default.
 */
export function activeCodeHost(): CodeHost {
  if (substitute !== null) return substitute;
  if (activated === null) throw new PluginActivationRefusal("no code host is active in this process: its entry point activates the plugins before it asks (agent-org plugin list shows the code host)");
  return activated.codeHost();
}

/** Puts `host` where {@link activeCodeHost} answers it, for a test; `null` takes it away. {@link forgetActivation} takes it away too. */
export function substituteCodeHost(host: CodeHost | null): void {
  substitute = host;
}

/** How long a program may run when its caller names no limit: a Keychain prompt a person is reading, or a marketplace add, takes minutes. */
const DEFAULT_EXEC_MS = 600_000;

/** The most a program may print: the GitHub CLI's listings are large, and the default of one megabyte would cut a long one off as a failure. */
const EXEC_MAX_BUFFER = 64 * 1024 * 1024;

/**
 * Runs `file` for real: the program's exit status (null when it could not start, with the reason in stderr) and what it printed. `inherit` gives it this process's terminal, and `env` is
 * laid over this process's environment for the run.
 */
export function realExec(file: string, args: readonly string[], options: ExecOptions = {}): ExecResult {
  const timeout = options.timeoutMs ?? DEFAULT_EXEC_MS;
  const env = { ...process.env, ...options.env };
  const result = options.inherit === true
    ? spawnSync(file, [...args], { stdio: "inherit", encoding: "utf8", env })
    : spawnSync(file, [...args], { encoding: "utf8", timeout, env, maxBuffer: EXEC_MAX_BUFFER, stdio: ["ignore", "pipe", "pipe"] });
  if (result.error !== undefined) return { status: null, stdout: "", stderr: result.error.message };
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/** A file's permission bits, or null when it cannot be read. */
export function realMode(path: string): number | null {
  try {
    return statSync(path).mode & 0o777;
  } catch {
    return null;
  }
}

/**
 * GETs `/` of `host:port` for real: the status, or null when nothing answered within the time (a refused connection, a failed handshake, a timeout). `servername` and `hostHeader` let a
 * plugin reach a machine by its address and still name it, as a browser does by its name.
 */
export function realProbe({ host, port, tls, servername, hostHeader, timeoutMs }: ProbeRequest): Promise<number | null> {
  return new Promise((done) => {
    const options = { host, port, path: "/", method: "GET", timeout: timeoutMs, ...(servername === undefined ? {} : { servername }), ...(hostHeader === undefined ? {} : { headers: { Host: hostHeader } }) };
    const call = (tls ? httpsRequest : httpRequest)(options, (response) => {
      response.resume();
      done(response.statusCode ?? null);
    });
    call.on("timeout", () => call.destroy());
    call.on("error", () => done(null));
    call.end();
  });
}

/** Where this machine's host file says it keeps what a code host's wrapper is rendered from: read when asked, so the host file's reader is imported only by a process that asks (doctor's rows). */
export const realPlace = (): Promise<HostPlaceReading> => import("./host-place.ts").then(({ readHostPlace }) => readHostPlace());

/**
 * The deps core gives a plugin on this machine: the real `fetch`, programs and files. `pick` is the board's `tickets.pick`, `clones` the host's checkouts, `review` how a reviewer
 * judges a pull request, which only a process that loaded the gate can give (`corePolicy` says what the others do), and `reviewing` the reviewer's helpers with the board's collaborators
 * (a process that is not a board gives none, and a reviewer that asks for them is refused by name).
 */
export function realPluginDeps({ env, stateDir, pick, clones = {}, review, reviewing }: Readonly<{ env: Readonly<Record<string, string | undefined>>; stateDir: string; pick: PickScope; clones?: Readonly<Record<string, string>>; review?: CodeHostPolicy["review"]; reviewing?: ReviewerHelpers }>): PluginDeps {
  return { env, stateDir, pick, clones, policy: corePolicy(review), log: (line) => process.stderr.write(`${line}\n`), fetch: (input, init) => fetch(input, init), exec: realExec, readFile: (path) => readFileSync(path, "utf8"), mode: realMode, probe: realProbe, messaging: messagingHelpers(),
    publishing: publishingHelpers(), reviewing: reviewing ?? gateHelpers(), place: realPlace };
}
