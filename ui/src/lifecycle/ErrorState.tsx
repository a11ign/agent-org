import { AlertIcon } from "./icons.tsx";

/**
 * The boards' error banner: a `role="alert"` in the danger colours with the backend's own sentence, verbatim, and a Retry that reads again. Dismiss is for the pages whose
 * boards have it (Tickets and Runs): it is drawn only when the page gives `onDismiss`, which is also the page's to remember.
 */
export function ErrorState({ refusal, onRetry, onDismiss }: Readonly<{ refusal: string; onRetry: () => void; onDismiss?: () => void }>) {
  return (
    <div role="alert" className="alert-banner">
      <AlertIcon />
      <div className="alert-banner-text">{refusal}</div>
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
