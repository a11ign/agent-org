import { useState } from "react";
import type { EditFile, SettingsView } from "../api/types.ts";
import type { SettingsPage } from "../../../src/ticket-mode/settings-view.ts";
import { SearchIcon } from "./icons.tsx";
import { SettingRow } from "./SettingRow.tsx";
import { EDIT_FILES, idOf, matchCount, pageGroups, searchWords, visibleGroups, type Drafts, type RowGroup, type Staged } from "./settings-model.ts";

const HOST_WORDS = "What this instance has enabled, as its file says now. The instance read it when it started, except the brief and review notes, which are read for each run. Changes are reviewed, then saved.";

/** What the rows of the page need to draw and to stage a change on. */
export type Editing = Readonly<{
  drafts: Drafts;
  staged: readonly Staged[];
  problems: Readonly<Record<string, string>>;
  type: (id: string, text: string) => void;
  /** Null for a local instance. For a remote one, the sentence that its files are changed on that machine: every input is then read-only. */
  remote: string | null;
}>;

/** The search box and the switch for settings at their defaults, as the boards draw them. */
function SearchRow({ query, setQuery, showDefaults, setShowDefaults }: Readonly<{ query: string; setQuery: (query: string) => void; showDefaults: boolean; setShowDefaults: (show: boolean) => void }>) {
  return (
    <div className="settings-search-row">
      <label className="settings-search">
        <span className="visually-hidden">Search settings by key or description</span>
        <SearchIcon />
        <input type="text" value={query} placeholder="Search by key or description" onChange={(event) => setQuery(event.target.value)} />
      </label>
      <label className="settings-check">
        <input type="checkbox" checked={showDefaults} onChange={(event) => setShowDefaults(event.target.checked)} />
        Show settings at their defaults
      </label>
    </div>
  );
}

/** The id of a group's heading, which names its section. */
const headingId = (group: string): string => `h-g-${group.toLowerCase().replace(/[^a-z]+/g, "-")}`;

/** The groups of one file, each with its rows. */
function Groups({ groups, editing }: Readonly<{ groups: readonly RowGroup[]; editing: Editing }>) {
  const stagedIds = new Set(editing.staged.map(({ id }) => id));
  return (
    <>
      {groups.map(({ group, rows }) => (
        <section key={group} aria-labelledby={headingId(group)} className="settings-section">
          <h3 id={headingId(group)} className="settings-section-title">{group}</h3>
          <div className="settings-card">
            {rows.map((row) => {
              const id = idOf(row);
              const edit = row.editable && row.input !== null ? { draft: editing.drafts[id], onType: (text: string) => editing.type(id, text), readOnly: editing.remote !== null } : null;
              return <SettingRow key={id} row={row} edit={edit} staged={stagedIds.has(id)} problem={editing.problems[id]} />;
            })}
          </div>
        </section>
      ))}
    </>
  );
}

const ofFile = (groups: readonly RowGroup[], file: EditFile): RowGroup[] =>
  groups.map(({ group, rows }) => ({ group, rows: rows.filter((row) => row.file === file) })).filter(({ rows }) => rows.length > 0);

/** The heading of a file's rows: "Host file host.json", or "Project file project.json". */
function FileHeading({ title, file, words }: Readonly<{ title: string; file: EditFile; words: string | null }>) {
  return (
    <div className="settings-divider settings-divider-file">
      <h2 className="settings-heading">{title} <code className="settings-file">{file}</code></h2>
      {words === null ? null : <p className="settings-lede">{words}</p>}
    </div>
  );
}

/**
 * The host file's keys on one page of the split, over the rows `page` owns: the heading and sentence of the boards, the search and "Show settings at their defaults", and the keys by group.
 * The project file's keys sit under their own heading in the same pattern, since a review and a save are one file each.
 */
export function HostFileSection({ view, page, editing }: Readonly<{ view: SettingsView; page: SettingsPage; editing: Editing }>) {
  const [query, setQuery] = useState("");
  // The boards draw the keys at their defaults, so they start shown.
  const [showDefaults, setShowDefaults] = useState(true);
  const groups = visibleGroups(pageGroups(view, page), { query, showDefaults });
  const [hostGroups, projectGroups] = EDIT_FILES.map((file) => ofFile(groups, file));
  const words = searchWords(query, matchCount(view, page, query));
  return (
    <>
      <FileHeading title="Host file" file="host.json" words={HOST_WORDS} />
      {editing.remote === null ? null : <p className="settings-remote">{editing.remote}</p>}
      <SearchRow query={query} setQuery={setQuery} showDefaults={showDefaults} setShowDefaults={setShowDefaults} />
      <p role="status" className="settings-search-status">{words}</p>
      <Groups groups={hostGroups} editing={editing} />
      {projectGroups.length === 0 ? null : (
        <>
          <FileHeading title="Project file" file="project.json" words={null} />
          <Groups groups={projectGroups} editing={editing} />
        </>
      )}
    </>
  );
}
