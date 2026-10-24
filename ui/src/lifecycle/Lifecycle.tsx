import type { ReactNode } from "react";
import type { PollView } from "../api/use-poll.ts";
import { ErrorState } from "./ErrorState.tsx";
import { UnreachableFrame } from "./UnreachableFrame.tsx";

/** What `Lifecycle` needs of the polling hook's result: its state, the last good data, the last refusal, and how to read again. */
export type LifecycleView<T> = PollView<T> & Readonly<{ refresh: () => void }>;

export type LifecycleProps<T> = Readonly<{
  view: LifecycleView<T>;
  /** The page's loading layout. */
  skeleton: ReactNode;
  /** The page's empty panel, drawn when the read came back with nothing. */
  empty: ReactNode;
  /** What the unreachable frame names: the SSH connection the read is for. */
  connection: string;
  /** Present for the pages whose boards have a Dismiss on the error banner. */
  onDismiss?: () => void;
  /** The page, drawn from the data. After a failure it is the last good data, beneath the banner; before any success there is none and it is not drawn. */
  children: (data: T) => ReactNode;
}>;

/**
 * One page's lifecycle, driven by the polling hook's state: `loading` is the skeleton, `empty` the empty panel, `ready` the page, `error` the error banner with Retry above the
 * last good data, `unreachable` the unreachable frame above it, and `reconnecting` (the instance is restarting) a quiet "Reconnecting..." line above it, with the skeleton
 * before any data. The pages pick the words and layouts; this picks which one is shown.
 */
export function Lifecycle<T>({ view, skeleton, empty, connection, onDismiss, children }: LifecycleProps<T>) {
  const lastGood = () => (view.data === null ? null : children(view.data));
  switch (view.state) {
    case "loading":
      return <>{skeleton}</>;
    case "empty":
      return <>{empty}</>;
    case "ready":
      return <>{lastGood()}</>;
    case "error":
      return (
        <>
          <ErrorState refusal={view.refusal ?? ""} onRetry={view.refresh} {...(onDismiss === undefined ? {} : { onDismiss })} />
          {lastGood()}
        </>
      );
    case "reconnecting":
      return (
        <>
          <p role="status" className="reconnecting-note" title={view.refusal ?? ""}>
            Reconnecting…
          </p>
          {view.data === null ? skeleton : lastGood()}
        </>
      );
    case "unreachable":
      return (
        <UnreachableFrame name={connection} refusal={view.refusal ?? ""}>
          {lastGood()}
        </UnreachableFrame>
      );
  }
}
