import type { ConfigView } from "../api/types.ts";
import { ErrorState } from "../lifecycle/ErrorState.tsx";
import { useShell } from "../shell/ShellProvider.tsx";
import { NewTicketDialog } from "./NewTicketDialog.tsx";
import { manualOptionsOf } from "./new-ticket-model.ts";
import { RunCard } from "./RunCard.tsx";
import { useNewTicketRequest } from "./use-new-ticket-request.ts";
import { useWriterRuns } from "./use-writer-runs.ts";

/**
 * The New ticket request strip and its dialog, for an instance that writes tickets. The page mounts it for as long as it is shown, so the request goes on if the dialog is closed, and
 * the dialog shows where it is when it is opened again. `open` is the page's choice to show the dialog, and `onClose` asks the page to hide it. `paused` names the SSH connection that cannot be
 * reached: nothing is sent to it, and a request kept in the dialog waits until it answers.
 */
export function NewTicket({ config, paused, open, onClose }: Readonly<{ config: ConfigView; paused: string | null; open: boolean; onClose: () => void }>) {
  const { allTickets } = useShell();
  const writers = useWriterRuns();
  const request = useNewTicketRequest((view) => {
    const run = view.runs.at(-1);
    if (run !== undefined) writers.learn(run);
    onClose();
  });
  return (
    <>
      {writers.failure === null ? null : <ErrorState refusal={writers.failure} onRetry={writers.retry} onDismiss={writers.dismissFailure} />}
      {writers.runs.map((run) => <RunCard key={run.id} run={run} readAt={writers.readAt} busy={paused !== null || writers.cached || writers.acting.has(run.id)} onStop={writers.stop} onDismiss={writers.dismiss} />)}
      {open ? <NewTicketDialog request={request} config={config} paused={paused} options={manualOptionsOf(config, allTickets)} onClose={onClose} /> : null}
    </>
  );
}
