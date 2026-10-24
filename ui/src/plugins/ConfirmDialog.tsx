import { useModalFocus } from "../lifecycle/use-modal-focus.ts";
import { backupLine, RESTART_NOTE } from "./plugins-model.ts";
import type { Pending } from "./use-changes.ts";

/**
 * The dialog that asks before a change the backend asks to have confirmed: an uninstall, a switch of a concern's plugin, a dangerous key of the host file. Its body is the backend's own
 * sentence, then the restart note and where the previous file is kept, as the boards have them. Cancel sends nothing.
 */
export function ConfirmDialog({ pending, onCancel, onConfirm }: Readonly<{ pending: Pending; onCancel: () => void; onConfirm: () => void }>) {
  const { dialog, onKeyDown } = useModalFocus(onCancel);
  return (
    <div className="dialog-overlay dialog-overlay-confirm">
      <div ref={dialog} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="confirm-title" className="dialog dialog-confirm" onKeyDown={onKeyDown}>
        <div className="dialog-head">
          <h2 id="confirm-title" className="dialog-title">{pending.heading}</h2>
        </div>
        <div className="dialog-body dialog-body-words">
          <span>{pending.sentence} {RESTART_NOTE}</span>
          <span className="dialog-note">{backupLine(pending.file)}</span>
        </div>
        <div className="dialog-foot">
          <button type="button" className="ghost ghost-body" onClick={onCancel}>Cancel</button>
          <button type="button" className="primary" onClick={onConfirm}>{pending.confirm}</button>
        </div>
      </div>
    </div>
  );
}
