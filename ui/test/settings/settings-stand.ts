// module: a stand-in for the Settings routes of an instance -- `/api/settings`, its preview, save and restore, `/api/choice`, `/api/max` and `/api/paused` -- for this page's checks
//
// THE SHELL'S STAND-IN (`../fixtures.ts`) KNOWS NONE OF THESE ROUTES, and a page ticket does not edit it. This one wraps it: a `fetch` for the component checks, and a Playwright route for the
// page checks, both answering from the same `answerSettings`. The view is made by the real `settingsView` over the real schema's entries, so a row, its page, its default and its
// in-force words are the backend's. Every answer is data a check can replace; the defaults behave as the instance does (a save of a stale `base` is refused with its sentence).
import type { BrowserContext } from "playwright-core";
import type { SchemaEntry } from "../../../src/ticket-mode/config-schema.ts";
import { defaultSchema } from "../../../src/plugins/schema.ts";
import { PROJECT_NOTE } from "../../../src/ticket-mode/settings-edit.ts";
import { settingsView, type Section } from "../../../src/ticket-mode/settings-view.ts";
import type { Fetch } from "../../src/api/request.ts";
import type { Change, ChoiceView, ConfigView, QueueView, SavedChoice, SettingsPreview, SettingsRestored, SettingsSaved, SettingsView } from "../../src/api/types.ts";
import { CONFLICT_SENTENCE } from "../../src/settings/settings-model.ts";
import { queueingConfig, standFetch, type Failure, type Request, type Stand } from "../fixtures.ts";

type Entry = SchemaEntry;
const byKey = (keys: readonly string[]): Entry[] => defaultSchema().filter((entry) => keys.includes(entry.key));

/** The keys the three boards draw rows of, and a few more of each kind the page treats differently: a dangerous switch, a JSON list, a number, a role that nests, a project key. */
export const BOARD_KEYS: readonly string[] = [
  "tickets.writer.model", "tickets.writer.effort", "tickets.publish.model", "tickets.drafts", "tickets.capture", "tickets.max", "tickets.stallMinutes", "tickets.preflight",
  "tickets.designTools", "home", "tickets.providers.tracker.provider", "tickets.providers.codeHost.identity", "tickets.providers.codeHost.identity.<role>", "tickets.providers.codeHost.identity.<role>.mode",
  "tickets.providers.codeHost.identity.<role>.appId", "tickets.providers.reviewer.required", "tickets.providers.reviewer.provider", "tickets.deny", "units.prefix", "model", "effort", "planModel", "planEffort", "writerModel", "writerEffort",
];

const section = (file: string, raw: Record<string, unknown> | null, refusal: string | null = null): Section => ({ file, raw, refusal });

/** What the instance has in its files, as the boards' instance does: the writer on opus, the design tools off, and `/home/agents` as home. */
export type Files = Readonly<{ host: Record<string, unknown>; project: Record<string, unknown> | null; hostRefusal: string | null; notes: readonly string[] }>;

export const BOARD_FILES: Files = {
  host: { home: "/home/agents", tickets: { writer: { run: "write", model: "opus" }, stallMinutes: 45, providers: { codeHost: { identity: { reviewer: { mode: "github-apps" } } } } } },
  project: null, hostRefusal: null, notes: [],
};

/** The settings view of `files`, over the entries of `keys`, with the saved choice and the queue's number of workers. */
export function viewOf(files: Files = BOARD_FILES, { keys = BOARD_KEYS, max = 10, saved = {} }: Readonly<{ keys?: readonly string[]; max?: number; saved?: Partial<SavedChoice> }> = {}): SettingsView {
  const tickets = files.host.tickets as Record<string, unknown> | undefined;
  return settingsView({
    entries: byKey(keys), host: section("host.json", files.hostRefusal === null ? files.host : null, files.hostRefusal), tickets: section("host.json (tickets)", files.hostRefusal === null ? (tickets ?? {}) : null, files.hostRefusal),
    project: section("project.json", files.project), notes: files.notes, choice: { saved, host: {} }, queue: { max, source: "queue.json" }, plugins: { readable: true, plugins: [] }, exists: () => true,
  });
}

/** The models, efforts and writer defaults of the Models board. */
export const modelsConfig = (fields: Partial<ConfigView> = {}): ConfigView => queueingConfig({
  models: ["opus", "sonnet"], efforts: ["low", "medium", "high"], writerDefault: { model: "opus", effort: "high" },
  choice: { model: "opus", effort: "high", planModel: "opus", planEffort: "high", writerModel: "", writerEffort: "" }, ...fields,
});

/** The dangerous keys of the board's instance, with the schema's own sentence. */
export const dangerousOf = (key: string): string | null => {
  const edit = defaultSchema().find((entry) => entry.key === key && entry.file === "host.json")?.edit;
  return edit?.editable === true ? (edit.dangerous ?? null) : null;
};

/** What a call to a Settings route is answered with, or the failure the instance refuses it with. */
type Answered<T> = T | Failure;

/** The instance's state and answers. Every field is optional; the defaults behave as the instance does. */
export type SettingsStand = {
  /** The view `/api/settings` answers with, read each time so a check can change what the next read says. */
  view: () => SettingsView;
  viewFails?: Failure;
  /** The hash of the file the page reads: a save of any other `base` is the conflict. A check changes it to make the file change under the page. */
  base: string;
  /** The choice as saved, which `/api/choice` changes a part of. */
  choice: SavedChoice;
  max: number;
  paused: boolean;
  /** The runs `/api/queue` lists beside `max` and `paused`, which it reads from here so a change the page makes is what the next read says. */
  entries: readonly unknown[];
  /** Paths (by their end) whose request gets no answer at all, as when the browser cannot send it. */
  drops?: readonly string[];
  /** Replaces the instance's own answer to a call, by route. */
  answers: Partial<{
    preview: (body: { file: string; changes: readonly Change[] }) => Answered<SettingsPreview>;
    save: (body: { file: string; changes: readonly Change[]; base: string; confirmed?: readonly string[] }) => Answered<SettingsSaved>;
    restore: (body: { file: string }) => Answered<SettingsRestored>;
    choice: (body: Partial<SavedChoice>) => Answered<ChoiceView>;
    max: (body: { max: number }) => Answered<QueueView>;
    paused: (body: { paused: boolean }) => Answered<QueueView>;
  }>;
};

export const standOf = (fields: Partial<SettingsStand> = {}): SettingsStand => ({
  view: () => viewOf(), base: "base-1", choice: { model: "opus", effort: "high", planModel: "opus", planEffort: "high" }, max: 10, paused: false, entries: [], answers: {}, ...fields,
});

const IN_FORCE = "in force after the board restarts: ticket:serve and ticket:ui.";
const wordsOf = (value: unknown): string => (typeof value === "string" ? value : JSON.stringify(value));

/** A change as the instance shows it in a preview: the key, the new value in words, when it is in force, and the schema's sentence for a dangerous key. */
const shown = (change: Change): SettingsPreview["changes"][number] => ({
  key: change.key, old: "the old value", new: "remove" in change ? "returned to its default" : wordsOf(change.value), changed: true, applies: "board", inForce: IN_FORCE, dangerous: dangerousOf(change.key),
});

const queueAfter = (state: SettingsStand): QueueView => ({ entries: state.entries, max: state.max, paused: state.paused }) as unknown as QueueView;

type Reply = { status: number; body: string };
const reply = (body: unknown, status = 200): Reply => ({ status, body: JSON.stringify(body) });
const isFailure = (value: unknown): value is Failure => typeof value === "object" && value !== null && "status" in value && "error" in value;
const answer = (value: unknown): Reply => (isFailure(value) ? reply({ error: value.error }, value.status) : reply(value));
const refusal = (error: string): Failure => ({ status: 400, error });

/** The answer to a Settings call, or null for a route this stand-in does not know (the shell's stand-in answers it). */
export function answerSettings(state: SettingsStand, path: string, request: Readonly<{ method: string; body?: unknown }>): Reply | null {
  const route = /(\/api\/[^?]+)/.exec(path)?.[1];
  const body = (request.body ?? {}) as Record<string, unknown>;
  const { answers } = state;
  if (request.method === "GET" && route === "/api/queue") return reply(queueAfter(state));
  if (request.method === "GET" && route === "/api/settings") return state.viewFails === undefined ? reply(state.view()) : answer(state.viewFails);
  if (request.method !== "POST") return null;
  switch (route) {
    case "/api/settings/preview": {
      const { file, changes } = body as { file: string; changes: readonly Change[] };
      return answer(answers.preview?.({ file, changes }) ?? ({ file, base: state.base, changes: changes.map(shown), note: file === "project.json" ? PROJECT_NOTE : null } as SettingsPreview));
    }
    case "/api/settings/save": {
      const save = body as { file: string; changes: readonly Change[]; base: string; confirmed?: readonly string[] };
      const own = answers.save?.(save);
      if (own !== undefined) return answer(own);
      if (save.base !== state.base) return answer(refusal(CONFLICT_SENTENCE));
      const missing = save.changes.map(shown).find((change) => change.dangerous !== null && !(save.confirmed ?? []).includes(change.key));
      if (missing !== undefined) return answer(refusal(`${missing.key} is dangerous and needs a second confirmation that names it. It can break this: ${missing.dangerous}`));
      return answer({ file: save.file, changes: save.changes.map(shown), backup: `/home/agents/.agent-org/${save.file}.bak`, note: save.file === "project.json" ? PROJECT_NOTE : null } as SettingsSaved);
    }
    case "/api/settings/restore":
      return answer(answers.restore?.(body as { file: string }) ?? ({ file: (body as { file: string }).file, changes: [] } as SettingsRestored));
    case "/api/choice": {
      const own = answers.choice?.(body as Partial<SavedChoice>);
      if (own !== undefined) return answer(own);
      state.choice = { ...state.choice, ...(body as Partial<SavedChoice>) };
      return answer({ choice: state.choice });
    }
    case "/api/max": {
      const own = answers.max?.(body as { max: number });
      if (own !== undefined) return answer(own);
      state.max = Number(body.max);
      return answer(queueAfter(state));
    }
    case "/api/paused": {
      const own = answers.paused?.(body as { paused: boolean });
      if (own !== undefined) return answer(own);
      state.paused = body.paused === true;
      return answer(queueAfter(state));
    }
    default:
      return null;
  }
}

/** A `fetch` for the component checks: the Settings routes from `state`, every other route from the shell's stand-in. It records each request, with its method and body. */
export function settingsFetch(stand: Stand, state: SettingsStand): Fetch & Readonly<{ paths: string[]; requests: Request[] }> {
  const inner = standFetch(stand);
  const paths: string[] = [];
  const requests: Request[] = [];
  const serve = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const path = String(input);
    const request = { method: init?.method ?? "GET", body: typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined };
    paths.push(path);
    requests.push({ ...request, path });
    if (state.drops?.some((dropped) => path.endsWith(dropped)) === true) throw new TypeError("Failed to fetch");
    if (stand.holdInstance === true) return inner(input, init);
    const own = answerSettings(state, path, request);
    return own === null ? inner(input, init) : new Response(own.body, { status: own.status, headers: { "Content-Type": "application/json" } });
  };
  return Object.assign(serve as Fetch, { paths, requests });
}

/** Answers the Settings routes of a Playwright context, ahead of the shell's stand-in (`serveInstance`), which a call this stand-in does not know falls back to. */
export async function routeSettings(context: BrowserContext, state: SettingsStand, asked: Request[] = []): Promise<Request[]> {
  await context.route(/\/api\/(settings|choice|max|paused|queue$)/, async (route) => {
    const url = new URL(route.request().url());
    const request = { method: route.request().method(), body: route.request().postData() === null ? undefined : (route.request().postDataJSON() as unknown) };
    const own = answerSettings(state, `${url.pathname}${url.search}`, request);
    if (own === null) return route.fallback();
    asked.push({ ...request, path: `${url.pathname}${url.search}` });
    return route.fulfill({ status: own.status, contentType: "application/json", body: own.body });
  });
  return asked;
}
