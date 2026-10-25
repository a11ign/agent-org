import { useMemo } from "react";
import { connectionLabel } from "../../../src/ticket-mode/board-view.ts";
import type { SettingsPage as Section } from "../../../src/ticket-mode/settings-view.ts";
import type { EditFile, SettingsView } from "../api/types.ts";
import { usePoll } from "../api/use-poll.ts";
import { useShell } from "../shell/ShellProvider.tsx";
import { Notes, OutcomeBanner, ReadRefusals } from "./Banners.tsx";
import { ConventionsNotes } from "./ConventionsNotes.tsx";
import { HostFileSection, type Editing } from "./HostFileSection.tsx";
import { Models, Workers } from "./PageControls.tsx";
import { ReadFailure } from "./ReadFailure.tsx";
import { RestoreBackups } from "./RestoreBackups.tsx";
import { ReviewDialog } from "./ReviewDialog.tsx";
import { editableRows, filesStaged, idOf, PAGE_WORDS, remoteNote, stagedIn } from "./settings-model.ts";
import { SettingsSkeleton } from "./SettingsSkeleton.tsx";
import { UnsavedBars } from "./UnsavedBar.tsx";
import { useDrafts } from "./use-drafts.ts";
import { useHostFile, type HostFile } from "./use-host-file.ts";

/** The h1 of every state of the page, and the subtitle of the page of the split it is. */
function Header({ section }: Readonly<{ section: Section }>) {
  return (
    <div className="settings-head">
      <h1 className="page-heading">Settings</h1>
      <p className="settings-lede">{PAGE_WORDS[section]}</p>
    </div>
  );
}

/** The sections of the page once the settings are read: the banners that say how the last action went, the page's own controls, and the host file's keys. */
function Sections({ section, view, flow, editing, local, onRestore }: Readonly<{ section: Section; view: SettingsView; flow: HostFile; editing: Editing; local: boolean; onRestore: () => void }>) {
  return (
    <>
      <ReadRefusals refusals={view.refusals} />
      <Notes notes={view.notes} />
      <OutcomeBanner outcome={flow.outcome} actions={{ busy: flow.busy, onRestore, onReadAgain: flow.readAgain }} />
      {section === "models" ? <Models /> : null}
      {section === "workers" ? <Workers /> : null}
      <HostFileSection view={view} page={section} editing={editing} />
      {section === "machine" ? <ConventionsNotes view={view} /> : null}
      {section === "machine" && local ? <RestoreBackups view={view} busy={flow.busy} onRestore={flow.restore} /> : null}
    </>
  );
}

/**
 * The page once the connections are read. It holds what the settings read gives and what is typed over it: the staged changes, and the review, save and restore of the host files. A
 * failed read is above the last one read, if any; with none the page is its skeleton, while it loads and while the instance restarts.
 */
function Content({ section }: Readonly<{ section: Section }>) {
  const { client, connection } = useShell();
  // Read every 5s like the rest of the shell, and backed off while the instance cannot be reached. What is typed is kept apart from what is read, so a new read never moves it.
  const read = usePoll<SettingsView>(client.settings, { connection, isEmpty: () => false });
  const view = read.data;
  const local = connection === null || connection.kind === "local";
  const state = useDrafts(connection?.name ?? "");
  const rows = useMemo(() => (view === null ? [] : editableRows(view)), [view]);
  const flow = useHostFile({ client, read: read.refresh, rows, drafts: state.drafts, discard: state.discard });
  const { staging, outcome } = flow;
  const editing: Editing = {
    drafts: state.drafts, staged: staging.staged, problems: staging.problems, type: state.type,
    remote: local || connection === null ? null : remoteNote(connectionLabel(connection)),
  };
  const bars = local ? filesStaged(staging.staged).map((file) => ({ file, count: stagedIn(staging.staged, file).length })) : [];
  const discard = (file: EditFile) => state.discard(rows.filter((row) => row.file === file && state.drafts[idOf(row)] !== undefined).map(idOf));
  return (
    <>
      <div className="settings">
        <Header section={section} />
        <ReadFailure read={read} name={connection?.name ?? ""} hasSettings={view !== null} />
        {view === null ? (read.state === "loading" || read.state === "reconnecting" ? <SettingsSkeleton /> : null) : <Sections section={section} view={view} flow={flow} editing={editing} local={local} onRestore={() => outcome?.kind === "saved" && flow.restore(outcome.file)} />}
      </div>
      <UnsavedBars files={bars} busy={flow.busy} onDiscard={discard} onReview={flow.openReview} />
      {flow.review === null ? null : <ReviewDialog review={flow.review} busy={flow.busy} onBack={flow.closeReview} onSave={flow.save} />}
    </>
  );
}

/** The Settings page of one section of the split. */
export function SettingsPage({ section }: Readonly<{ section: Section }>) {
  return useShell().connectionsReady ? <Content section={section} /> : <div className="settings"><Header section={section} /><SettingsSkeleton /></div>;
}
