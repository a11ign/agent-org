import { SettingRow } from "../settings/SettingRow.tsx";
import { idOf, type RowGroup } from "../settings/settings-model.ts";
import { usePage } from "./PageContext.ts";

/** A concern's own settings, as the boards draw them under its checks: a card of the host file's rows, each edited in place through the Settings flow (staged, reviewed, saved). */
export function ConcernSettings({ groups }: Readonly<{ groups: readonly RowGroup[] }>) {
  const { editing } = usePage();
  const staged = new Set(editing.staged.map(({ id }) => id));
  const rows = groups.flatMap((group) => group.rows);
  if (rows.length === 0) return null;
  return (
    <div className="settings-card">
      {rows.map((row) => {
        const id = idOf(row);
        const edit = row.editable && row.input !== null ? { draft: editing.drafts[id], onType: (text: string) => editing.type(id, text), readOnly: editing.remote !== null } : null;
        return <SettingRow key={id} row={row} edit={edit} staged={staged.has(id)} problem={editing.problems[id]} />;
      })}
    </div>
  );
}
