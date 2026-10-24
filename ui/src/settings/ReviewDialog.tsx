import { useState } from "react";
import { useModalFocus } from "../lifecycle/use-modal-focus.ts";
import { dangerousIn, sentenceOf } from "./settings-model.ts";
import type { Review } from "./use-host-file.ts";

/**
 * The review of the staged changes of one file: each change's key, what it was and what it becomes and when it is in force, from the instance's own preview. A dangerous change says why and
 * must be ticked by its key before Save is offered; the save names exactly the ticked keys. Back keeps every staged change.
 */
export function ReviewDialog({ review, busy, onBack, onSave }: Readonly<{ review: Review; busy: boolean; onBack: () => void; onSave: (confirmed: ReadonlySet<string>) => void }>) {
  const { file, preview } = review;
  const [ticked, setTicked] = useState<ReadonlySet<string>>(new Set());
  const { dialog, onKeyDown } = useModalFocus(onBack);
  const dangerous = dangerousIn(preview);
  const ready = dangerous.every((key) => ticked.has(key));
  const toggleTick = (key: string) => setTicked((before) => new Set(before.has(key) ? [...before].filter((name) => name !== key) : [...before, key]));
  return (
    <div className="dialog-overlay">
      <div ref={dialog} tabIndex={-1} role="dialog" aria-modal="true" aria-label="Review changes" className="dialog" onKeyDown={onKeyDown}>
        <div className="dialog-head">
          <h2 className="dialog-title">Review changes <span className="dialog-file">· {file}</span></h2>
        </div>
        <div className="dialog-body">
          {preview.changes.map((change) => (
            <div key={change.key} className="review-change">
              <code className="setting-key">{change.key}</code>
              <div className="review-values">
                <span className="review-old">{change.old}</span>
                <span aria-hidden="true" className="review-arrow">→</span>
                <span className="review-new">{change.new}</span>
              </div>
              <span className="review-force">{sentenceOf(change.inForce)}</span>
              {dangerous.includes(change.key) ? (
                <div className="review-danger">
                  <strong className="review-danger-heading">Dangerous.</strong> {change.dangerous}
                  <label className="review-tick">
                    <input type="checkbox" checked={ticked.has(change.key)} onChange={() => toggleTick(change.key)} />
                    <span>I am changing <code>{change.key}</code></span>
                  </label>
                </div>
              ) : null}
            </div>
          ))}
          {preview.note === null ? null : <p className="review-note">{preview.note}</p>}
        </div>
        <div className="dialog-foot">
          <button type="button" className="ghost ghost-body" onClick={onBack}>Back</button>
          <button type="button" className="primary" disabled={!ready || busy} onClick={() => onSave(ticked)}>Save to {file}</button>
        </div>
      </div>
    </div>
  );
}
