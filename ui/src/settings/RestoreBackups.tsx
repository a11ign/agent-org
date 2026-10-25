import type { EditFile, SettingsView } from "../api/types.ts";

/** A project's declaration is edited when this machine declares one, which its rows or its refusal show. */
export const projectDeclared = (view: SettingsView): boolean =>
  view.refusals.some(({ file }) => file === "project.json") || view.groups.some(({ rows }) => rows.some(({ file }) => file === "project.json"));

/** The files this machine has a backup of: the host file, and the project file when the machine declares a project. */
export const backupFiles = (view: SettingsView): readonly EditFile[] => (projectDeclared(view) ? ["host.json", "project.json"] : ["host.json"]);

/**
 * Restore the backup of a host file at any time, as `ui.html` offers: one button for each file, which swaps the file with its backup. The banner straight after a save has its own
 * "Restore previous"; this is the way back when that banner is long gone. What it came to is the page's restored or refused banner.
 */
export function RestoreBackups({ view, busy, onRestore }: Readonly<{ view: SettingsView; busy: boolean; onRestore: (file: EditFile) => void }>) {
  return (
    <div className="settings-restores">
      {backupFiles(view).map((file) => (
        <button key={file} type="button" className="ghost" disabled={busy} onClick={() => onRestore(file)}>Restore the backup of {file}</button>
      ))}
    </div>
  );
}
