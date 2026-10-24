// The types the instance API's answers and requests are made of, imported from the server's modules where they live and never copied here.
// A server change that renames or drops a field the client reads therefore fails `pnpm ui:typecheck`.
export type { ViewConnection } from "../../../src/ticket-mode/board-view.ts";
export type { RunAction } from "../../../src/ticket-mode/board-view/pull-status-and-notes.ts";
export type { ConfigView, ChoiceView, PickView, QueueChildrenView, QueueView, SavedChoice, TicketsPageView, TicketView, WritersView } from "../../../src/ticket-mode/server.ts";
export type { ConnectionsView } from "../../../src/ticket-mode/ui-server.ts";
export type { RunChoice } from "../../../src/ticket-mode/queue/queue-entries-and-outcomes.ts";
export type { People, Ticket } from "../../../src/ticket-mode/source.ts";
export type { View as SettingsView } from "../../../src/ticket-mode/settings-view.ts";
import type { restoreBackup, saveEdit } from "../../../src/ticket-mode/settings-edit.ts";
export type { Change, EditFile, Preview as SettingsPreview } from "../../../src/ticket-mode/settings-edit.ts";
/** What a Settings save and a restore answer, as the functions that make them return it. */
export type SettingsSaved = Awaited<ReturnType<typeof saveEdit>>;
export type SettingsRestored = Awaited<ReturnType<typeof restoreBackup>>;
export type { PluginsAnswer } from "../../../src/ticket-mode/plugins-api.ts";
export type { ActionDone as PluginActionDone, ActionRequest as PluginActionRequest } from "../../../src/plugins/page-actions.ts";
export type { PlannedStep } from "../../../src/ticket-mode/plan-step-sections.ts";
export type { RunWorker } from "../../../src/ticket-mode/queue/queue-run-detail.ts";
