// module: a stand-in for `/api/plugins` of an instance -- the answer the Plugins page and the Settings sub-nav's badge read -- for this page's checks
//
// THE SHELL'S STAND-IN (`../fixtures.ts`) KNOWS NO PLUGINS ROUTE, and a page ticket does not edit it. This one wraps it. The answer is made by the real `pluginHealth` over the real catalog and
// counted by the real `attentionOf`, so a plugin's state, its words and the number the badge shows are the backend's.
import type { BrowserContext } from "playwright-core";
import { attentionOf, type ClaudePlugin, type ClaudePlugins } from "../../../src/plugins/attention.ts";
import { pluginHealth } from "../../../src/plugins/health.ts";
import type { PluginCheck } from "../../../src/plugins/manifest.ts";
import { defaultCatalog } from "../../../src/plugins/registry.ts";
import type { MessagingState } from "../../../src/plugins/view.ts";
import { defaultSchema } from "../../../src/plugins/schema.ts";
import { resolveProviders } from "../../../src/ticket-mode/providers.ts";
import type { Fetch } from "../../src/api/request.ts";
import type { PluginActionDone, PluginsAnswer } from "../../src/api/types.ts";
import { CONFLICT_SENTENCE } from "../../src/settings/settings-model.ts";
import { settingsFetch, standOf as settingsOf, viewOf, type Files, type SettingsStand } from "../settings/settings-stand.ts";
import { standFetch, type Failure, type Request, type Stand } from "../fixtures.ts";

/** What a fresh machine's onboard writes: explicit tracker and code host blocks, and the exposure on Tailscale. */
export const BOARD_HOST = { tickets: { providers: { tracker: { provider: "linear", enabled: true }, codeHost: { provider: "github", enabled: true }, exposure: { provider: "tailscale", enabled: true } } } };

export const NO_CLAUDE: ClaudePlugins = { readable: true, plugins: [] };

const PLUGIN_GROUPS = ["Tracker", "Code host", "Publisher", "Reviewer", "Exposure"];

/** The host-file keys the Plugins page reads rows of: every setting of the five provider groups, and the three keys the Claude plugins tab changes. */
export const PLUGIN_KEYS: readonly string[] = [
  ...defaultSchema().filter((entry) => entry.file === "host.json" && PLUGIN_GROUPS.includes(entry.group)).map((entry) => entry.key),
  "tickets.plugins", "tickets.writer.run", "tickets.prReview", "tickets.plan", "tickets.connectors",
];

/** The host file the board's instance has: the three providers of a fresh machine, the writer on the a11ign plugin's skill, and that plugin listed. */
export const PLUGIN_FILES: Files = {
  host: { tickets: { ...BOARD_HOST.tickets, writer: { run: "Run the a11ign:create-ticket skill for this request: {request}, in {dir}." }, prReview: "a11ign:clean-code-review", plugins: ["a11ign@applied-ai"] } },
  project: null, hostRefusal: null, notes: [],
};

/** The Settings stand-in of the Plugins page: its view holds the provider groups' rows and the Claude plugins' keys. */
export const pluginsSettings = (files: Files = PLUGIN_FILES, fields: Partial<SettingsStand> = {}): SettingsStand => settingsOf({ view: () => viewOf(files, { keys: PLUGIN_KEYS }), ...fields });

/** A Claude plugin that a worker gets, with no contract; `fields` change it. */
export const claudePlugin = (fields: Partial<ClaudePlugin> = {}): ClaudePlugin => ({ entry: "a11ign@applied-ai", name: "a11ign", loads: true, why: null, installs: [{ scope: "user", projectPath: null }], contract: null, rows: [], ...fields });

/** The contract of the board's Claude plugin: the skills it provides for the writer, the planner and the review, and the connector and command it needs. */
export const A11IGN_CONTRACT: NonNullable<ClaudePlugin["contract"]> = {
  contract: "1.0", agentOrg: ">=0.258.0 <1.0.0",
  provides: { writer: { skill: "a11ign:create-ticket" }, prReview: { skill: "a11ign:clean-code-review" }, planner: { skill: "a11ign:plan", planFile: "<issue-id>-0001-plan-<slug>.md" } },
  needs: { connectors: ["^mcp__linear__(get|list|search|extract)_"], commands: ["gh"] },
};

/** The Claude plugin of the boards, with its contract. */
export const a11ign = (fields: Partial<ClaudePlugin> = {}): ClaudePlugin => claudePlugin({ contract: A11IGN_CONTRACT, ...fields });

const NO_PROJECT: MessagingState = { provider: null, why: "this machine declares no project" };


/**
 * The answer of `/api/plugins` for a host, the doctor checks of each plugin by name, the Claude plugins the host lists, and what the project says of messaging, with when the checks finished
 * (just now, unless a check says otherwise) and whether they are running again.
 */
export function answerOf({ host = BOARD_HOST, checks = {}, claude = NO_CLAUDE, note = null, messaging = NO_PROJECT, refused = [], checkedAt = new Date().toISOString(), checking = false }: Readonly<{
  host?: unknown; checks?: Readonly<Record<string, readonly PluginCheck[]>>; claude?: ClaudePlugins; note?: string | null; messaging?: MessagingState; refused?: readonly Readonly<{ plugin: string; why: string }>[];
  checkedAt?: string | null; checking?: boolean;
}> = {}): PluginsAnswer {
  const catalog = defaultCatalog();
  const health = pluginHealth({ catalog: { ...catalog, refusals: [...catalog.refusals, ...refused] }, providers: resolveProviders(host, catalog), messaging, load: { loaded: [], unbuilt: [], refusals: [] }, checks, version: "v0.289.0" });
  return { ...health, claude, attention: attentionOf(health, claude), note, bases: { "host.json": "base-1", "project.json": "base-p1" }, checkedAt, checking };
}

/** A failing doctor check, as a plugin reports one. */
export const failing = (name: string, detail: string, fix: string): PluginCheck => ({ name, ok: false, detail, fix });

/** What a request to act on a plugin carries. */
export type ActionBody = Readonly<{ action: "install" | "enable" | "disable" | "uninstall"; name: string; base: string; confirmed?: boolean }>;

export type PluginsStand = {
  /** The answer `GET /api/plugins` gives, read each time so a check can change what the next read says. */
  answer: () => PluginsAnswer;
  fails?: Failure;
  /** Leaves `GET /api/plugins` unanswered, as a read that is slow to answer does: for ever when true, until the promise settles when it is one. */
  hold?: boolean | Promise<unknown>;
  /** The hash of the host file the page read: an action that sends any other `base` is the conflict. A check changes it to make the file change under the page. */
  base: string;
  /** Replaces the instance's own answer to an action. */
  action?: (body: ActionBody) => PluginActionDone | Failure;
  /** The queue's failure, as an SSH instance that cannot be reached answers it: this is what turns the page to Health unknown. */
  queueFails?: Failure;
};

export const standOf = (fields: Partial<PluginsStand> = {}): PluginsStand => ({ answer: () => answerOf(), base: "base-1", ...fields });

const IN_FORCE = "in force after the board restarts: ticket:serve and ticket:ui.";
const PAST: Readonly<Record<ActionBody["action"], string>> = { install: "installed", enable: "enabled", disable: "disabled", uninstall: "uninstalled" };

const isFailure = (value: unknown): value is Failure => typeof value === "object" && value !== null && "status" in value && "error" in value;

/** A read of the plugins: the page's own, and the one that asks the instance to run the checks again (`?check`, A11-270), which a hold holds alike. */
const PLUGINS_READ = /\/api\/plugins(\?check)?$/;

/** The answer the instance gives to an action: what `runAction` decides, without writing a file. A stale `base` is the conflict, an unconfirmed uninstall or replacing install is refused, and so is a control the plan refuses. */
export function answerAction(state: PluginsStand, body: ActionBody): PluginActionDone | Failure {
  const own = state.action?.(body);
  if (own !== undefined) return own;
  const refusal = (error: string): Failure => ({ status: 400, error });
  const answer = state.answer();
  const plugin = answer.concerns.flatMap((concern) => concern.plugins).find(({ name }) => name === body.name);
  if (plugin === undefined) return refusal(`no plugin is named ${body.name}: \`agent-org plugin list\` shows the plugins`);
  const refused = plugin.controls.refused[body.action as keyof typeof plugin.controls.refused];
  if (refused !== undefined) return refusal(refused);
  const asks = body.action === "uninstall" || (body.action === "install" && plugin.controls.confirm.install !== undefined);
  if (asks && body.confirmed !== true) return refusal(`${body.action} ${body.name} needs the person's confirmation first: ask again with it`);
  if (body.base !== state.base) return refusal(CONFLICT_SENTENCE);
  return { said: `${PAST[body.action]} ${body.name}`, changed: true, inForce: [IN_FORCE], backup: "/home/agents/.agent-org/host.json.bak" };
}

const reply = (body: unknown, status = 200): { status: number; body: string } => ({ status, body: JSON.stringify(body) });
/** A failure is answered with its sentence, and with the last answer the proxy kept when it names one. */
const answered = (value: unknown): { status: number; body: string } => (isFailure(value) ? reply({ error: value.error, ...(value.lastKnown === undefined ? {} : { lastKnown: value.lastKnown }) }, value.status) : reply(value));

/** What a read answers: the answer, with the host file's `base` as the file is now, which is what an action of the page is checked against. */
const read = (state: PluginsStand): PluginsAnswer => {
  const answer = state.answer();
  return { ...answer, bases: { ...answer.bases, "host.json": state.base } };
};

/** The answer to a plugins call (`GET /api/plugins`, `POST /api/plugins/action`, and the queue when it fails), or null for a route this stand-in does not know. */
export function answerPlugins(state: PluginsStand, path: string, request: Readonly<{ method: string; body?: unknown }>): { status: number; body: string } | null {
  const route = /(\/api\/[^?]+)/.exec(path)?.[1];
  if (request.method === "GET" && route === "/api/queue" && state.queueFails !== undefined) return answered(state.queueFails);
  if (request.method === "GET" && route === "/api/plugins") return state.fails === undefined ? reply(read(state)) : answered(state.fails);
  if (request.method === "POST" && route === "/api/plugins/action") return answered(answerAction(state, request.body as ActionBody));
  return null;
}

/**
 * A `fetch` for the component checks: the plugins routes from `state`, the Settings routes (`/api/settings` and its preview, save and restore) from `settings`, and every other route from the shell's
 * stand-in. It records each request, with its method and body.
 */
export function pluginsFetch(stand: Stand, state: PluginsStand, settings: SettingsStand = settingsOf()): Fetch & Readonly<{ paths: string[]; requests: Request[] }> {
  const inner = standFetch(stand);
  const settled = settingsFetch(stand, settings);
  const paths: string[] = [];
  const requests: Request[] = [];
  const serve = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const path = String(input);
    const request = { method: init?.method ?? "GET", body: typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined };
    paths.push(path);
    requests.push({ ...request, path });
    if (state.hold === true && request.method === "GET" && PLUGINS_READ.test(path)) return new Promise<Response>(() => undefined);
    if (state.hold instanceof Promise && request.method === "GET" && PLUGINS_READ.test(path)) await state.hold;
    const own = answerPlugins(state, path, request);
    if (own !== null) return new Response(own.body, { status: own.status, headers: { "Content-Type": "application/json" } });
    return /\/api\/settings(\/|\?|$)/.test(path) ? settled(input, init) : inner(input, init);
  };
  return Object.assign(serve as Fetch, { paths, requests });
}

/** Answers the plugins calls of a Playwright context from `state`, ahead of the shell's stand-in and the Settings stand-in, and records the requests. */
export async function routePlugins(context: BrowserContext, state: PluginsStand, asked: Request[] = []): Promise<Request[]> {
  await context.route(/\/api\/(plugins|queue$)/, async (route) => {
    const url = new URL(route.request().url());
    const request = { method: route.request().method(), body: route.request().postData() === null ? undefined : (route.request().postDataJSON() as unknown) };
    if (state.hold === true && request.method === "GET" && url.pathname.endsWith("/api/plugins")) return;
    if (state.hold instanceof Promise && request.method === "GET" && url.pathname.endsWith("/api/plugins")) await state.hold;
    const own = answerPlugins(state, `${url.pathname}${url.search}`, request);
    if (own === null) return route.fallback();
    asked.push({ ...request, path: `${url.pathname}${url.search}` });
    return route.fulfill({ status: own.status, contentType: "application/json", body: own.body });
  });
  return asked;
}
