import type { Answer } from "./answer.ts";
import { mutate } from "./mutate.ts";
import { send, type Fetch, type Target } from "./request.ts";
import type {
  Change, CheckAnswer, ChoiceView, CloseRequest, ConfigView, ConnectionsView, EditFile, InterventionsView, People, PickView, PluginActionDone, PluginActionRequest, PluginsAnswer, QueueChildrenView, QueueView, RunAction, RunChoice,
  SavedChoice, SettingsPreview, SettingsRestored, SettingsSaved, SettingsView, Ticket, TicketsPageView, TicketView, ViewConnection, WritersView,
} from "./types.ts";

/** What a queued run is started with: the model and effort, and whether it is planned first. */
export type QueueRequest = RunChoice & Readonly<{ plan?: boolean }>;

/** The body of a new-ticket request, as `writerBody` in `board-view.ts` builds it from the form. */
export type WriterRequest = Readonly<Record<string, string>>;

/** A Settings save: the edit, the file's hash as the page read it, and the warnings the person confirmed. */
export type SettingsSave = Readonly<{ file: EditFile; changes: readonly Change[]; base: string; confirmed?: readonly string[] }>;

/** A plugin action; `confirmed` is for an uninstall, or an install that replaces another plugin. */
export type PluginRequest = Omit<PluginActionRequest, "confirmed"> & Readonly<{ confirmed?: boolean }>;

/** A read: the signal of the poll that asked, so a connection change drops the answer. It names its path, under which the tab keeps its answer (`session-cache.ts`). */
export type Read<T> = ((signal?: AbortSignal) => Promise<Answer<T>>) & Readonly<{ path: string }>;

/**
 * One typed method per route the board calls on an instance: what `remote-proxy.ts` passes on, and `ticket:ui`'s own `/api/connections`. `connection` is the
 * one chosen on the page (null addresses `/api/...` at the root, as the dev server's proxy does). Every method resolves to an `Answer` and never throws.
 */
export function createClient(connection: ViewConnection | null, { fetch: fetchWith = (...args) => globalThis.fetch(...args) }: Readonly<{ fetch?: Fetch }> = {}) {
  const target: Target = { connection, fetch: fetchWith };
  const read = <T>(path: string, at: Target = target): Read<T> => Object.assign((signal?: AbortSignal) => send<T>(at, { method: "GET", path, signal }), { path });
  const post = <T>(path: string, body?: unknown) => mutate<T>(target, path, body);
  const keyed = (key: string) => `/api/queue/${encodeURIComponent(key)}`;
  // An After-merge check's id is `<KEY>#<n>`, which its routes name as `<KEY>/<n>` (A11-277).
  const checked = (id: string) => `/api/after-merge/${id.split("#").map(encodeURIComponent).join("/")}`;
  return {
    /** `ticket:ui`'s own answer: the connections the page offers, always at the root. */
    connections: read<ConnectionsView>("/api/connections", { ...target, atRoot: true }),
    config: read<ConfigView>("/api/config"),
    tickets: read<TicketView[]>("/api/tickets"),
    /** One page of the scope the Assignee row chose, from the page `after` names or from the first. */
    ticketsPage: (assignee: string, after: string | null = null, signal?: AbortSignal) =>
      read<TicketsPageView>(`/api/tickets?${new URLSearchParams({ assignee, ...(after === null ? {} : { after }) })}`)(signal),
    people: read<People>("/api/people"),
    parents: read<Ticket[]>("/api/parents"),
    pick: read<PickView>("/api/pick"),
    queue: read<QueueView>("/api/queue"),
    writer: read<WritersView>("/api/writer"),
    /** The person-interventions of the last 7 days and today's total (A11-257): the board's health number. */
    interventions: read<InterventionsView>("/api/interventions"),
    settings: read<SettingsView>("/api/settings"),
    plugins: read<PluginsAnswer>("/api/plugins"),
    /** The plugins, with the instance asked to run their checks again (A11-270): what a person's Retry and "Read the plugins again" send. */
    pluginsCheckedAgain: read<PluginsAnswer>("/api/plugins?check"),

    enqueue: (keys: readonly string[], choice: QueueRequest) => post<QueueView>("/api/queue", { keys, ...choice }),
    enqueueChildren: (key: string, choice: QueueRequest) => post<QueueChildrenView>("/api/queue-children", { key, ...choice }),
    publish: (keys: readonly string[]) => post<QueueView>("/api/publish", { keys }),
    pause: () => post<QueueView>("/api/paused", { paused: true }),
    resume: () => post<QueueView>("/api/paused", { paused: false }),
    setMax: (max: number) => post<QueueView>("/api/max", { max }),
    saveChoice: (change: Partial<SavedChoice>) => post<ChoiceView>("/api/choice", change),
    /** respond, retry, dismiss, remove, talk, start-anyway, approve, stop, close, apply-edit and discard-edit: a run's own buttons. */
    runAction: (key: string, action: RunAction) => post<QueueView>(`${keyed(key)}/${action}`),
    amend: (key: string, change: Partial<RunChoice>) => post<QueueView>(`${keyed(key)}/amend`, change),
    /** Close an After-merge check, passed, failed or superseded, with one line of evidence (A11-277). */
    closeCheck: (id: string, close: CloseRequest) => post<CheckAnswer>(checked(id), close),
    /** Record a failed check's follow-up: the writer request it was filed by, or null for none. */
    decideFollowUp: (id: string, writer: string | null) => post<CheckAnswer>(`${checked(id)}/follow-up`, { writer }),

    writeTickets: (request: WriterRequest) => post<WritersView>("/api/writer", request),
    grillTicket: (key: string) => post<WritersView>("/api/grill-ticket", { key }),
    stopWriterRun: (run: string) => post<WritersView>(`/api/writer/${encodeURIComponent(run)}/stop`),
    dismissWriterRun: (run: string) => post<WritersView>(`/api/writer/${encodeURIComponent(run)}/dismiss`),

    previewSettings: (file: EditFile, changes: readonly Change[]) => post<SettingsPreview>("/api/settings/preview", { file, changes }),
    saveSettings: (save: SettingsSave) => post<SettingsSaved>("/api/settings/save", save),
    restoreSettings: (file: EditFile) => post<SettingsRestored>("/api/settings/restore", { file }),
    pluginAction: (request: PluginRequest) => post<PluginActionDone>("/api/plugins/action", request),
  };
}

/** The client for one connection. */
export type Client = ReturnType<typeof createClient>;
