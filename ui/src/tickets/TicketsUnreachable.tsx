import type { ReactNode } from "react";
import { UnreachableFrame } from "../lifecycle/UnreachableFrame.tsx";
import { useShell } from "../shell/ShellProvider.tsx";

/** What the Instance unreachable board says besides the backend's sentence: that Atomaut keeps trying, and what the list below is. */
const KEEPS_TRYING = "Atomaut keeps trying: after 2 seconds, then less often, up to once a minute. The tickets below are the last ones it saw, and queueing is paused until it reconnects.";

/**
 * The Tickets page's unreachable view, drawn as the Instance unreachable board draws it: the alert with the backend's sentence, what the page keeps doing, Check now and, when a local
 * connection is listed, Switch to this machine, above the last tickets read. Once the connection answers again the alert gives way to the board's "reached over SSH again" banner, which
 * stays until the connection is switched or the page is left, as the board draws no timer and no dismiss.
 */
export function TicketsUnreachable({ children }: Readonly<{ children: ReactNode }>) {
  const { unreachable, reconnected, connection, connections, checkNow, switchConnection } = useShell();
  const name = connection?.name ?? "";
  const local = connections.find(({ kind }) => kind === "local");
  if (unreachable !== null) {
    const actions = (
      <>
        <button type="button" className="alert-button" onClick={checkNow}>Check now</button>
        {local === undefined ? null : <button type="button" className="alert-button alert-button-secondary" onClick={() => switchConnection(local.name)}>Switch to this machine</button>}
      </>
    );
    return <UnreachableFrame name={name} refusal={unreachable} explanation={KEEPS_TRYING} actions={actions}>{children}</UnreachableFrame>;
  }
  return (
    <>
      {reconnected ? <div role="status" className="reconnected-banner">{name} is reached over SSH again. Showing live tickets.</div> : null}
      {children}
    </>
  );
}
