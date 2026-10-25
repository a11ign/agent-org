import { useMemo, useState, type ReactNode } from "react";
import { connectionLabel } from "../../../src/ticket-mode/board-view.ts";
import type { EditFile, PluginsAnswer, SettingsView } from "../api/types.ts";
import { usePoll } from "../api/use-poll.ts";
import { Lifecycle } from "../lifecycle/Lifecycle.tsx";
import { OutcomeBanner } from "../settings/Banners.tsx";
import type { Editing } from "../settings/HostFileSection.tsx";
import { ReviewDialog } from "../settings/ReviewDialog.tsx";
import { editableRows, filesStaged, idOf, remoteNote, stagedIn } from "../settings/settings-model.ts";
import { UnsavedBars } from "../settings/UnsavedBar.tsx";
import { useDrafts } from "../settings/use-drafts.ts";
import { useHostFile } from "../settings/use-host-file.ts";
import { useShell } from "../shell/ShellProvider.tsx";
import { ClaudeTab } from "./ClaudeTab.tsx";
import { ConcernCard, RefusedPackage } from "./ConcernCard.tsx";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import { PageProvider } from "./PageContext.ts";
import { HostNote, NoticeBanner, UnknownBanner } from "./PluginBanners.tsx";
import { NOT_READ_YET, useProvidedPluginsRead } from "./PluginsRead.tsx";
import { PluginsSkeleton } from "./PluginsSkeleton.tsx";
import { panelId, PluginTabs, tabId, type Tab } from "./PluginTabs.tsx";
import { checkedWords, isLocal, NOT_CHECKED_YET, notChecked } from "./plugins-model.ts";
import { useChanges, type Changes } from "./use-changes.ts";

const BLANK_COUNTS: Readonly<Record<Tab, number | null>> = { integrations: null, claude: null };

/** The h1 and the sentence under it that tell the two kinds of plugin apart: they are on every state of the page. */
function Header() {
  return (
    <div className="plugins-head">
      <h1 className="page-heading">Plugins</h1>
      <p className="plugins-lede">
        Two kinds. <strong className="plugins-kind">Integrations</strong> are code agent-org runs to reach other systems: tracker, code host, chat.{" "}
        <strong className="plugins-kind">Claude plugins</strong> are skills and conventions your workers load.
      </p>
    </div>
  );
}

/** What the page draws while the plugins are being read: the tabs with no counts, and the Plugins Loading board's cards. */
function Reading() {
  return (
    <>
      <PluginTabs tab="integrations" counts={BLANK_COUNTS} onChoose={() => undefined} />
      <PluginsSkeleton />
    </>
  );
}

const INTEGRATIONS_WORDS = "One plugin is active for each concern. Installing a plugin and setting its secrets happen on the host, so this page shows the command and never takes a secret. A change here applies after the instance restarts.";

/** The Integrations tab: a card for each concern, then the packages the registry refused. */
function Integrations({ answer, open, onOpen }: Readonly<{ answer: PluginsAnswer; open: string | null; onOpen: (concern: string | null) => void }>) {
  return (
    <div className="plugin-tab">
      <p className="plugin-lede">{INTEGRATIONS_WORDS}</p>
      <div className="plugin-cards">
        {answer.concerns.map((concern) => <ConcernCard key={concern.concern} concern={concern} open={open === concern.concern} onToggle={() => onOpen(open === concern.concern ? null : concern.concern)} />)}
        {answer.refused.map(({ plugin, failure }) => <RefusedPackage key={plugin} plugin={plugin} failure={failure} />)}
      </div>
    </div>
  );
}

type Views = Readonly<{ tab: Tab; setTab: (tab: Tab) => void; open: string | null; setOpen: (concern: string | null) => void }>;

type LoadedProps = Readonly<{ answer: PluginsAnswer; unknown: boolean; view: SettingsView | null; viewWords: string; changes: Changes; editing: Omit<Editing, "remote">; onRetry: () => void; onReadAgain: () => void; flowBanner: ReactNode } & Views>;

/** The page once the plugins are read: the banners that say how the last change went, the two tabs, and the tab chosen. */
function Loaded({ answer, unknown, view, viewWords, changes, editing, onRetry, onReadAgain, flowBanner, tab, setTab, open, setOpen }: LoadedProps) {
  const { connection } = useShell();
  const remote = connection === null || isLocal(connection) ? null : remoteNote(connectionLabel(connection));
  const controls = remote === null && answer.note === null;
  const instance = unknown ? (connection?.name ?? "") : null;
  const unchecked = instance !== null ? notChecked(instance) : answer.checkedAt === null ? NOT_CHECKED_YET : null;
  const page = { answer, instance, unchecked, controls, changes, view, viewWords, editing: { ...editing, remote: controls ? null : (remote ?? answer.note) } };
  const age = checkedWords(answer, Date.now());
  return (
    <PageProvider value={page}>
      {age === null ? null : <p className="plugins-checked">{age}</p>}
      {unknown ? <UnknownBanner instance={connection?.name ?? ""} onRetry={onRetry} /> : null}
      <NoticeBanner notice={changes.notice} busy={changes.busy} onReadAgain={onReadAgain} />
      {flowBanner}
      {remote === null ? null : <p className="plugins-remote">{remote}</p>}
      {answer.note === null ? null : <HostNote note={answer.note} />}
      <PluginTabs tab={tab} counts={{ integrations: answer.concerns.length, claude: answer.claude.plugins.length }} onChoose={setTab} />
      <div role="tabpanel" id={panelId(tab)} aria-labelledby={tabId(tab)} className="plugin-panel-tab">
        {tab === "integrations" ? <Integrations answer={answer} open={open} onOpen={setOpen} /> : <ClaudeTab />}
      </div>
    </PageProvider>
  );
}

/**
 * The page once the connections are read. It reads the plugins once (the shell's shared read, which the badge uses too) and the settings once, and holds the changes: an agent-org plugin's action, a
 * Claude plugin's key of the host file, and a concern's own settings edited through the Settings flow. A failed first read is the shared error banner with Retry; an instance that cannot be reached
 * after an answer is the Unknown board: every status unknown over the last answer.
 */
function Content() {
  const { client, connection, queue, checkNow } = useShell();
  const plugins = useProvidedPluginsRead() ?? NOT_READ_YET;
  const settings = usePoll<SettingsView>(client.settings, { connection, repeat: false, isEmpty: () => false });
  const state = useDrafts(connection?.name ?? "");
  const rows = useMemo(() => (settings.data === null ? [] : editableRows(settings.data)), [settings.data]);
  const readAgain = () => {
    settings.refresh();
    plugins.refresh();
  };
  const flow = useHostFile({ client, read: readAgain, rows, drafts: state.drafts, discard: state.discard });
  const changes = useChanges({ client, read: readAgain, held: { answer: plugins.data, state: plugins.state }, started: flow.clearOutcome });
  const [tab, setTab] = useState<Tab>("integrations");
  const [open, setOpen] = useState<string | null>("tracker");
  const local = isLocal(connection);
  // The queue the shell polls is what notices the instance has gone: the plugins are read again by themselves only while the instance runs their checks.
  const unknown = plugins.data !== null && (queue.state === "unreachable" || plugins.state === "unreachable");
  const bars = local ? filesStaged(flow.staging.staged).map((file) => ({ file, count: stagedIn(flow.staging.staged, file).length })) : [];
  const discard = (file: EditFile) => state.discard(rows.filter((row) => row.file === file && state.drafts[idOf(row)] !== undefined).map(idOf));
  const retry = () => {
    checkNow();
    plugins.refresh();
  };
  const viewWords = settings.refusal ?? "Reading the settings…";
  return (
    <>
      <div className="plugins">
        <Header />
        <Lifecycle view={unknown ? { ...plugins, state: "ready" } : plugins} skeleton={<Reading />} empty={null} connection={connection?.name ?? ""}>
          {(answer) => (
            <Loaded answer={answer} unknown={unknown} view={settings.data} viewWords={viewWords} changes={changes} onRetry={retry} onReadAgain={() => { changes.clear(); readAgain(); }} tab={tab} setTab={setTab} open={open} setOpen={setOpen}
              editing={{ drafts: state.drafts, staged: flow.staging.staged, problems: flow.staging.problems, type: state.type }}
              flowBanner={<OutcomeBanner outcome={flow.outcome} actions={{ busy: flow.busy, onRestore: () => { changes.clear(); if (flow.outcome?.kind === "saved") flow.restore(flow.outcome.file); }, onReadAgain: () => { changes.clear(); flow.readAgain(); } }} />} />
          )}
        </Lifecycle>
      </div>
      <UnsavedBars files={bars} busy={flow.busy || changes.busy} onDiscard={discard} onReview={(file) => { changes.clear(); flow.openReview(file); }} />
      {flow.review === null ? null : <ReviewDialog review={flow.review} busy={flow.busy} onBack={flow.closeReview} onSave={flow.save} />}
      {changes.pending === null ? null : <ConfirmDialog pending={changes.pending} onCancel={changes.cancel} onConfirm={changes.confirm} />}
    </>
  );
}

/** The Plugins page, inside the shell and the plugins read the island provides. */
export function PluginsPage() {
  return useShell().connectionsReady ? <Content /> : <div className="plugins"><Header /><Reading /></div>;
}
