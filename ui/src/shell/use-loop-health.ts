import { useEffect, useState } from "react";
import type { HealthFigures } from "../../../src/ticket-mode/health-figures.ts";
import type { LoopReading } from "../../../src/ticket-mode/loop-delay.ts";
import type { WatchdogView } from "../../../src/ticket-mode/watchdog-record.ts";
import { send, type Fetch } from "../api/request.ts";
import type { ViewConnection } from "../api/types.ts";
import type { LoopHealth } from "./loop-line.ts";

/** How often the loop line is read again, in ms. */
export const LOOP_POLL_MS = 10_000;

/** What the instance's `/api/health` and the page service's root one answer, as far as the line reads them. */
type HealthAnswer = Readonly<{ loop?: Readonly<{ requests?: LoopReading; board?: LoopReading; page?: LoopReading }>; figures?: HealthFigures | null; watchdog?: WatchdogView | null }>;

/**
 * The loop readings of the connection shown and of the page's own service (A11-282), read now and every LOOP_POLL_MS. A read that fails, or a service from
 * before `/api/health` (a 404), gives no reading, so the line is not drawn. A change of connection starts again from no reading.
 */
export function useLoopHealth(connection: ViewConnection | null, fetch: Fetch): LoopHealth {
  const [health, setHealth] = useState<LoopHealth>({});
  useEffect(() => {
    setHealth({});
    const reading = new AbortController();
    let inFlight = false;
    const read = async () => {
      // A read still waiting on a slow instance is left to finish, so reads never pile up behind it.
      if (inFlight) return;
      inFlight = true;
      const call = { method: "GET", path: "/api/health", signal: reading.signal } as const;
      const [instance, page] = await Promise.all([send<HealthAnswer>({ connection, fetch }, call), send<HealthAnswer>({ connection, fetch, atRoot: true }, call)]);
      inFlight = false;
      if (reading.signal.aborted) return;
      const loop = instance.ok ? instance.data.loop : undefined;
      const pageLoop = page.ok ? page.data.loop?.page : undefined;
      const figures = instance.ok ? instance.data.figures : undefined;
      const watchdog = instance.ok ? instance.data.watchdog : undefined;
      setHealth({ ...(loop?.requests ? { requests: loop.requests } : {}), ...(loop?.board ? { board: loop.board } : {}), ...(pageLoop ? { page: pageLoop } : {}), ...(figures ? { figures } : {}), ...(watchdog ? { watchdog } : {}) });
    };
    void read();
    const timer = setInterval(() => void read(), LOOP_POLL_MS);
    return () => {
      reading.abort();
      clearInterval(timer);
    };
  }, [connection, fetch]);
  return health;
}
