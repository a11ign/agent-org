import { AlertIcon } from "../lifecycle/icons.tsx";
import { sentenceOf } from "../settings/settings-model.ts";
import { fileWords } from "./plugins-model.ts";
import type { Notice } from "./use-changes.ts";

/** The Unknown board's banner: nothing could be checked because the instance cannot be reached, and what is drawn is the last it sent. Retry reads again. */
export function UnknownBanner({ instance, onRetry }: Readonly<{ instance: string; onRetry: () => void }>) {
  return (
    <div role="alert" className="alert-banner">
      <AlertIcon />
      <div className="alert-banner-text">
        <strong className="alert-banner-heading">Plugin health is unknown.</strong> Can't reach {instance}, so no check has run. Settings shown are the last the instance sent.
      </div>
      <div className="alert-banner-actions">
        <button type="button" className="alert-button" onClick={onRetry}>Retry</button>
      </div>
    </div>
  );
}

/** What a note of the plugins read says plainly: the host file the reader refuses, so the plugins are shown as their defaults. */
export function HostNote({ note }: Readonly<{ note: string }>) {
  return (
    <div role="status" className="status-banner">
      <div className="status-banner-text">{note}</div>
    </div>
  );
}

/**
 * How the last change came out, in the boards' banners: applied (the backend's words, when it is in force and the file it kept), refused with the server's sentence, or the file changed since the
 * page looked. A change that was refused or whose file changed made no change, and says so.
 */
export function NoticeBanner({ notice, busy, onReadAgain }: Readonly<{ notice: Notice | null; busy: boolean; onReadAgain: () => void }>) {
  if (notice === null) return null;
  switch (notice.kind) {
    case "applied":
      return (
        <div role="status" className="notice notice-success">
          <strong className="banner-heading banner-heading-success">{sentenceOf(notice.said).replace(/\.?$/, ".")}</strong>{" "}
          {notice.inForce.map((words) => sentenceOf(words)).join(" ")}
          {notice.backup === null ? null : <> The previous {fileWords(notice.file)} is kept as <code>{notice.backup}</code>.</>}
        </div>
      );
    case "refused":
      return (
        <div role="alert" className="notice notice-danger">
          <strong className="banner-heading banner-heading-danger">Nothing was changed.</strong> {notice.sentence}
        </div>
      );
    case "conflict":
      return (
        <div role="alert" className="notice notice-warn">
          <div className="notice-text">
            <strong className="banner-heading banner-heading-warn">Nothing was changed.</strong> The file changed since you looked: read it again.
          </div>
          <button type="button" className="banner-button banner-button-warn" disabled={busy} onClick={onReadAgain}>Read the plugins again</button>
        </div>
      );
    case "failed":
      return (
        <div role="alert" className="notice notice-danger">{notice.sentence}</div>
      );
  }
}
