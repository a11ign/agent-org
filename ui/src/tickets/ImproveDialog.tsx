import type { ConfigView, ReadinessView, TicketView } from "../api/types.ts";
import { NewTicketDialog } from "../new-ticket/NewTicketDialog.tsx";
import { manualOptionsOf } from "../new-ticket/new-ticket-model.ts";
import { useNewTicketRequest } from "../new-ticket/use-new-ticket-request.ts";
import { useShell } from "../shell/ShellProvider.tsx";
import { improveRequest } from "./readiness-model.ts";

/** What "Improve with the writer" was pressed on: the ticket and its score. */
export type Improving = Readonly<{ ticket: TicketView; view: Extract<ReadinessView, { state: "scored" }> }>;

/**
 * The New ticket dialog, filled in with the ticket a low readiness score was pressed on, its score and its reasons (A11-443). The person reads the request and sends it, or changes it first;
 * nothing is sent on the press. Once the board queued the writer, its run shows in the strip as any request's does.
 */
export function ImproveDialog({ improving, config, onClose }: Readonly<{ improving: Improving; config: ConfigView; onClose: () => void }>) {
  const { allTickets, unreachable, connection, writers } = useShell();
  const request = useNewTicketRequest((view) => {
    const run = view.runs.at(-1);
    if (run !== undefined) writers.learn(run);
    onClose();
  }, improveRequest(improving.ticket, improving.view));
  return <NewTicketDialog request={request} config={config} paused={unreachable === null ? null : (connection?.name ?? "")} options={manualOptionsOf(config, allTickets)} onClose={onClose} />;
}
