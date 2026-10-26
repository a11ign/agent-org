import type { QueueView } from "../api/types.ts";
import { StatusBanner } from "../tickets/Banners.tsx";

/** The time an alert began, as the board words every time: UTC, to the minute. */
const sinceText = (since: number): string => `${new Date(since).toISOString().slice(11, 16)}Z`;

/**
 * What is wrong with the host itself (A11-279), one banner for each alert above the runs: its sentence and when it began. There is no Dismiss: the board clears an alert when its condition clears, so none goes stale. Nothing
 * is drawn while the host has none, and an instance older than the alerts sends none.
 */
export function HostAlerts({ alerts }: Readonly<{ alerts: QueueView["hostAlerts"] | undefined }>) {
  return (
    <>
      {(alerts ?? []).map(({ id, sentence, since }) => <StatusBanner key={id}>{sentence} Since {sinceText(since)}.</StatusBanner>)}
    </>
  );
}
