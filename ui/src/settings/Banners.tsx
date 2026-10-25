import type { ReactNode } from "react";
import { CodeWords } from "../lifecycle/CodeWords.tsx";
import { AlertIcon } from "../lifecycle/icons.tsx";
import type { SettingsView } from "../api/types.ts";
import { CONFLICT_SENTENCE, refusedHeading, sentenceOf } from "./settings-model.ts";
import type { Outcome } from "./use-host-file.ts";

/** The files the readers refused when the page read them, each with the reader's own sentence, in the boards' alert. */
export function ReadRefusals({ refusals }: Readonly<{ refusals: SettingsView["refusals"] }>) {
  if (refusals.length === 0) return null;
  return (
    <div role="alert" className="alert-banner">
      <AlertIcon />
      <div className="alert-banner-text">
        {refusals.map(({ file, message }) => <p key={file} className="banner-line">{file}: {message}</p>)}
      </div>
    </div>
  );
}

/** What the page says plainly, not as an error: such as that the machine declares no project. */
export function Notes({ notes }: Readonly<{ notes: readonly string[] }>) {
  return (
    <>
      {notes.map((note) => (
        <div key={note} role="status" className="status-banner">
          <div className="status-banner-text">{note}</div>
        </div>
      ))}
    </>
  );
}

function SavedBanner({ children, action }: Readonly<{ children: ReactNode; action?: ReactNode }>) {
  return (
    <div role="status" className="success-banner">
      <div className="success-banner-text">{children}</div>
      {action}
    </div>
  );
}

type Actions = Readonly<{ busy: boolean; onRestore: () => void; onReadAgain: () => void }>;

/** What the last save, restore or review came to, in the boards' banners: saved, refused by the readers, the file changed, or a restore the instance refused. */
export function OutcomeBanner({ outcome, actions }: Readonly<{ outcome: Outcome | null; actions: Actions }>) {
  if (outcome === null) return null;
  switch (outcome.kind) {
    case "saved":
      return (
        <SavedBanner action={<button type="button" className="banner-button banner-button-success" disabled={actions.busy} onClick={actions.onRestore}>Restore previous</button>}>
          <strong className="banner-heading banner-heading-success">Saved to {outcome.file}.</strong> The previous file is kept as <code>{outcome.backup}</code>. {outcome.inForce.join(" ")}
          {outcome.note === null ? null : ` ${outcome.note}`}
        </SavedBanner>
      );
    case "restored":
      return <SavedBanner>{outcome.text}</SavedBanner>;
    case "refused":
      return (
        <div role="alert" className="alert-banner alert-banner-column">
          <strong className="alert-banner-heading">{refusedHeading(outcome.file)}</strong>
          <span><CodeWords text={outcome.sentence} /></span>
        </div>
      );
    case "conflict":
      return (
        <div role="alert" className="status-banner">
          <div className="status-banner-text">
            <strong className="banner-heading banner-heading-warn">Not saved.</strong> {sentenceOf(CONFLICT_SENTENCE)}. Your edits are still here.
          </div>
          <button type="button" className="banner-button banner-button-warn" disabled={actions.busy} onClick={actions.onReadAgain}>Read the file again</button>
        </div>
      );
    case "failed":
      return (
        <div role="alert" className="alert-banner alert-banner-column">
          <span><CodeWords text={outcome.sentence} /></span>
        </div>
      );
  }
}
