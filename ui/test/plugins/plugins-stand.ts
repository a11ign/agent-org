// module: a stand-in for `/api/plugins` of an instance -- the answer the Plugins page and the Settings sub-nav's badge read -- for this page's checks
//
// THE SHELL'S STAND-IN (`../fixtures.ts`) KNOWS NO PLUGINS ROUTE, and a page ticket does not edit it. This one wraps it. The answer is made by the real `pluginHealth` over the real catalog and
// counted by the real `attentionOf`, so a plugin's state, its words and the number the badge shows are the backend's.
import type { BrowserContext } from "playwright-core";
import { attentionOf, type ClaudePlugin, type ClaudePlugins } from "../../../src/plugins/attention.ts";
import { pluginHealth } from "../../../src/plugins/health.ts";
import type { PluginCheck } from "../../../src/plugins/manifest.ts";
import { defaultCatalog } from "../../../src/plugins/registry.ts";
import { resolveProviders } from "../../../src/ticket-mode/providers.ts";
import type { Fetch } from "../../src/api/request.ts";
import type { PluginsAnswer } from "../../src/api/types.ts";
import { standFetch, type Failure, type Request, type Stand } from "../fixtures.ts";

/** What a fresh machine's onboard writes: explicit tracker and code host blocks, and the exposure on Tailscale. */
export const BOARD_HOST = { tickets: { providers: { tracker: { provider: "linear", enabled: true }, codeHost: { provider: "github", enabled: true }, exposure: { provider: "tailscale", enabled: true } } } };

export const NO_CLAUDE: ClaudePlugins = { readable: true, plugins: [] };

/** A Claude plugin that a worker gets, with no contract; `fields` change it. */
export const claudePlugin = (fields: Partial<ClaudePlugin> = {}): ClaudePlugin => ({ entry: "a11ign@applied-ai", name: "a11ign", loads: true, why: null, installs: [{ scope: "user", projectPath: null }], contract: null, rows: [], ...fields });

/** The answer of `/api/plugins` for a host, the doctor checks of each plugin by name, and the Claude plugins the host lists. */
export function answerOf({ host = BOARD_HOST, checks = {}, claude = NO_CLAUDE, note = null }: Readonly<{ host?: unknown; checks?: Readonly<Record<string, readonly PluginCheck[]>>; claude?: ClaudePlugins; note?: string | null }> = {}): PluginsAnswer {
  const catalog = defaultCatalog();
  const health = pluginHealth({ catalog, providers: resolveProviders(host, catalog), messaging: { provider: null, why: "this machine declares no project" }, load: { loaded: [], unbuilt: [], refusals: [] }, checks, version: "v0.289.0" });
  return { ...health, claude, attention: attentionOf(health, claude), note, bases: { "host.json": "base-1" } };
}

/** A failing doctor check, as a plugin reports one. */
export const failing = (name: string, detail: string, fix: string): PluginCheck => ({ name, ok: false, detail, fix });

export type PluginsStand = {
  /** The answer `GET /api/plugins` gives, read each time so a check can change what the next read says. */
  answer: () => PluginsAnswer;
  fails?: Failure;
};

export const standOf = (fields: Partial<PluginsStand> = {}): PluginsStand => ({ answer: () => answerOf(), ...fields });

/** A `fetch` for the component checks: `/api/plugins` from `state`, every other route from the shell's stand-in. It records each request. */
export function pluginsFetch(stand: Stand, state: PluginsStand): Fetch & Readonly<{ paths: string[]; requests: Request[] }> {
  const inner = standFetch(stand);
  const paths: string[] = [];
  const requests: Request[] = [];
  const serve = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const path = String(input);
    const method = init?.method ?? "GET";
    paths.push(path);
    requests.push({ method, path });
    if (method === "GET" && /\/api\/plugins$/.test(path)) {
      return state.fails === undefined ? new Response(JSON.stringify(state.answer()), { status: 200, headers: { "Content-Type": "application/json" } })
        : new Response(JSON.stringify({ error: state.fails.error }), { status: state.fails.status });
    }
    return inner(input, init);
  };
  return Object.assign(serve as Fetch, { paths, requests });
}

/** Answers `GET /api/plugins` of a Playwright context from `state`, ahead of the shell's stand-in, and records the paths it was asked. */
export async function routePlugins(context: BrowserContext, state: PluginsStand, asked: string[] = []): Promise<string[]> {
  await context.route(/\/api\/plugins$/, async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    const url = new URL(route.request().url());
    asked.push(`${url.pathname}${url.search}`);
    if (state.fails !== undefined) return route.fulfill({ status: state.fails.status, contentType: "application/json", body: JSON.stringify({ error: state.fails.error }) });
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(state.answer()) });
  });
  return asked;
}
