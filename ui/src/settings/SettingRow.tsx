import type { Row } from "../../../src/ticket-mode/settings-view.ts";
import { baselineOf } from "./settings-model.ts";

/** What the row says under its explanation: what the key is when its file does not hold it, and when a change is in force, in the schema's own words. */
export function metaOf(row: Row): string {
  const base = row.default === null ? "Not set by default" : `Default: ${row.default}`;
  return row.inForce === null ? base : `${base} · ${row.inForce.replace(/\.$/, "")}`;
}

type Edit = Readonly<{ draft: string | undefined; onType: (text: string) => void; readOnly: boolean }>;

/** The input of an editable row, by the kind of input the schema gives its key: a switch, a number or text field, or a textarea for JSON. */
function RowInput({ row, edit }: Readonly<{ row: Row; edit: Edit }>) {
  const text = edit.draft ?? baselineOf(row);
  const name = { "aria-label": row.key } as const;
  if (row.input === "boolean") {
    return (
      <label className="settings-switch">
        <input type="checkbox" {...name} checked={text === "true"} disabled={edit.readOnly} onChange={(event) => edit.onType(String(event.target.checked))} />
        <span>{text}</span>
      </label>
    );
  }
  if (row.input === "json") {
    return <textarea {...name} className="settings-input settings-input-json" rows={3} value={text} readOnly={edit.readOnly} onChange={(event) => edit.onType(event.target.value)} />;
  }
  return <input {...name} className="settings-input" type={row.input === "number" ? "number" : "text"} value={text} readOnly={edit.readOnly} onChange={(event) => edit.onType(event.target.value)} />;
}

/**
 * One host-file key as the boards draw it: the key, what it does, when it is by default and in force, and, on the right, the input that changes it. A key the page does not change in place
 * shows its value (or the alias text of an old key that is set) and says why it is read-only. A row with a staged change is tinted; a draft that does not read is said on its row.
 */
export function SettingRow({ row, edit, staged, problem }: Readonly<{ row: Row; edit: Edit | null; staged: boolean; problem: string | undefined }>) {
  const classes = ["setting-row", staged ? "setting-row-staged" : "", row.nest === null ? "" : "setting-row-nested"].filter((name) => name !== "").join(" ");
  const json = row.input === "json" && edit !== null;
  return (
    <div className={classes} data-key={row.key}>
      <div className="setting-text">
        <code className="setting-key">{row.key}</code>
        <span className="setting-words">{row.explanation}</span>
        {row.editable ? null : <span className="setting-meta">Read-only: {row.why}.</span>}
        <span className="setting-meta">{metaOf(row)}</span>
        {problem === undefined ? null : <span role="alert" className="setting-problem">{problem}</span>}
      </div>
      <div className={json ? "setting-control setting-control-wide" : "setting-control"}>
        {edit === null ? <span className="setting-value">{row.alias ?? row.value}</span> : <RowInput row={row} edit={edit} />}
      </div>
    </div>
  );
}
