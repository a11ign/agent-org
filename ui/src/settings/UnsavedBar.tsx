import type { EditFile } from "../api/types.ts";
import { unsavedWords } from "./settings-model.ts";

type Props = Readonly<{ files: readonly Readonly<{ file: EditFile; count: number }>[]; busy: boolean; onDiscard: (file: EditFile) => void; onReview: (file: EditFile) => void }>;

/**
 * The bar that stays at the foot of the page while changes are staged: how many, in which file, Discard to take them back and Review changes to see what the instance's readers say.
 * One bar for each file with a change, since a review and a save are one file each.
 */
export function UnsavedBars({ files, busy, onDiscard, onReview }: Props) {
  if (files.length === 0) return null;
  return (
    <div className="unsaved-stack">
      {files.map(({ file, count }) => (
        <div key={file} role="region" aria-label={files.length > 1 ? `Unsaved changes in ${file}` : "Unsaved changes"} className="unsaved-bar">
          <span className="unsaved-count">{unsavedWords(count)}</span>
          <span className="unsaved-file">{file}</span>
          <span className="unsaved-spacer" />
          <button type="button" className="ghost" onClick={() => onDiscard(file)}>Discard</button>
          <button type="button" className="primary" disabled={busy} onClick={() => onReview(file)}>Review changes</button>
        </div>
      ))}
    </div>
  );
}
