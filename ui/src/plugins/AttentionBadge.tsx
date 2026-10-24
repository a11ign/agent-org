import { useEffect, useState } from "react";
import type { Client } from "../api/client.ts";
import type { PluginsAnswer } from "../api/types.ts";
import { useShell } from "../shell/ShellProvider.tsx";
import { useProvidedPluginsRead, type PluginsReadValue } from "./PluginsRead.tsx";

/** What the badge says of the number of plugins that need attention, as the boards draw it: "1 needs attention", "2 need attention". */
export const attentionWords = (count: number): string => `${count} ${count === 1 ? "needs" : "need"} attention`;

/**
 * The count to show, or null to show none: only an answered read counts, and only above zero. A failed read and a read still loading have no count to show, since the last answer may no
 * longer be true.
 */
export function attentionShown(read: Pick<PluginsReadValue, "state" | "data">): number | null {
  const data: PluginsAnswer | null = read.data;
  if (read.state !== "ready" || data === null) return null;
  return data.attention > 0 ? data.attention : null;
}

/** The badge of one read. An instance that cannot be reached shows none either: what it last answered may no longer be true. */
function Badge({ read }: Readonly<{ read: Pick<PluginsReadValue, "state" | "data"> }>) {
  const { queue } = useShell();
  const count = queue.state === "unreachable" ? null : attentionShown(read);
  // The space keeps the link's name "Plugins 1 needs attention" for a screen reader, which would otherwise run the label into the count.
  return count === null ? null : <>{" "}<span className="attention-badge">{attentionWords(count)}</span></>;
}

type Held = Readonly<{ client: Client; data: PluginsAnswer | null }>;

/**
 * One read of the plugins for this connection, never repeated. The read runs the doctor checks (`security`, `claude mcp list`, `gh`), so a failure is not retried on the poll's backoff, which
 * would run them again every minute on every open Settings page: a failed read shows no badge, and the next page load reads again.
 */
function useReadOnce(): Pick<PluginsReadValue, "state" | "data"> {
  const { client } = useShell();
  const [held, setHeld] = useState<Held | null>(null);
  useEffect(() => {
    const reading = new AbortController();
    void client.plugins(reading.signal).then((answer) => {
      if (!reading.signal.aborted) setHeld({ client, data: answer.ok ? answer.data : null });
    });
    return () => reading.abort();
  }, [client]);
  return held?.client === client && held.data !== null ? { state: "ready", data: held.data } : { state: "loading", data: null };
}

/** The badge reads for itself: this is a Settings page, which does not hold the plugins. */
function OwnReadBadge() {
  return <Badge read={useReadOnce()} />;
}

/**
 * The "needs attention" badge of the Plugins link in the Settings sub-nav. On the Plugins page, which holds the plugins already, it shares that read; on any other Settings page it makes
 * the read itself, once per connection.
 */
export function AttentionBadge() {
  const provided = useProvidedPluginsRead();
  const { connectionsReady } = useShell();
  if (provided !== null) return <Badge read={provided} />;
  return connectionsReady ? <OwnReadBadge /> : null;
}
