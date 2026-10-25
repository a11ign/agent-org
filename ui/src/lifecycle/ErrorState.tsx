import { AlertIcon } from "./icons.tsx";

/**
 * The boards' error banner: a `role="alert"` in the danger colours with the backend's own sentence, verbatim, and a Retry that reads again. Dismiss is for the pages whose
 * boards have it (Tickets and Runs): it is drawn only when the page gives `onDismiss`, which is also the page's to remember. A `title` is the banner's bold first line over the sentence ("Not published." on the
 * Publish boards).
 */
export function ErrorState({ refusal, title, onRetry, onDismiss }: Readonly<{ refusal: string; title?: string; onRetry: () => void; onDismiss?: () => void }>) {
  return (
    <div role="alert" className="alert-banner">
      <AlertIcon />
      {title === undefined ? (
        <div className="alert-banner-text">{refusal}</div>
      ) : (
        <div className="alert-banner-text alert-banner-stack">
          <strong className="alert-banner-heading">{title}</strong>
          <span>{refusal}</span>
        </div>
      )}
      <div className="alert-banner-actions">
        <button type="button" className="alert-button" onClick={onRetry}>
          Retry
        </button>
        {onDismiss === undefined ? null : (
          <button type="button" className="alert-button alert-button-quiet" onClick={onDismiss}>
            Dismiss
          </button>
        )}
      </div>
    </div>
  );
}
