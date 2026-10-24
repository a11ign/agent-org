import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { looksLikeRestart } from "../../../src/ticket-mode/board-view/reconnect.ts";
import type { Answer } from "../api/answer.ts";
import type { Client } from "../api/client.ts";
import type { PluginsAnswer } from "../api/types.ts";
import type { PollState, PollView } from "../api/use-poll.ts";
import type { ViewConnection } from "../api/types.ts";
import { useShell } from "../shell/ShellProvider.tsx";

/** The plugins as the instance last answered them: `/api/plugins`, with `refresh` to read them again. The shape the shared lifecycle components take. */
export type PluginsReadValue = PollView<PluginsAnswer> & Readonly<{ refresh: () => void }>;

const PluginsReadContext = createContext<PluginsReadValue | null>(null);

type Held = Readonly<{ client: Client; view: PollView<PluginsAnswer> }>;

/** The state a failed answer makes: unreachable for an SSH remote its proxy cannot reach, reconnecting for a restart, and an error for anything the server answered with. */
function failureOf(connection: ViewConnection | null, answer: Extract<Answer<unknown>, { ok: false }>): PollState {
  if (answer.unreachable) return "unreachable";
  return looksLikeRestart(connection, answer.status, answer.refusal) ? "reconnecting" : "error";
}

/** The view an answer makes after the one before it: a failure keeps the last good data, as the polling hook does. */
function viewAfter(before: PollView<PluginsAnswer>, answer: Answer<PluginsAnswer>, connection: ViewConnection | null): PollView<PluginsAnswer> {
  if (answer.ok) return { state: "ready", data: answer.data, refusal: null };
  return { state: failureOf(connection, answer), data: before.data, refusal: answer.refusal };
}

const LOADING: PollView<PluginsAnswer> = { state: "loading", data: null, refusal: null };

/**
 * `/api/plugins`, read once per connection and again only when `refresh` asks (the page's Retry and "Read the plugins again", and after an action). It is NOT polled and a failure is NOT
 * retried on a backoff, which `usePoll` does even with `repeat: false`: the read runs the plugins' doctor checks (`security`, `claude mcp list`, `gh`), and trying again by itself would run them
 * every minute for as long as a page stays open. The shell's own queue poll is what notices the instance has gone. Never an empty answer: an instance with no plugin still has its concerns.
 */
export function usePluginsRead(): PluginsReadValue {
  const { client, connection } = useShell();
  const [held, setHeld] = useState<Held>({ client, view: LOADING });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const reading = new AbortController();
    void client.plugins(reading.signal).then((answer) => {
      if (reading.signal.aborted) return;
      setHeld((before) => ({ client, view: viewAfter(before.client === client ? before.view : LOADING, answer, connection) }));
    });
    return () => reading.abort();
  }, [client, connection, attempt]);
  return { ...(held.client === client ? held.view : LOADING), refresh: () => setAttempt((count) => count + 1) };
}

/** What the plugins are before the connections are known: nothing read, and nothing to read it of. */
export const NOT_READ_YET: PluginsReadValue = { ...LOADING, refresh: () => undefined };

function ReadOfInstance({ children }: Readonly<{ children: ReactNode }>) {
  return <PluginsReadContext.Provider value={usePluginsRead()}>{children}</PluginsReadContext.Provider>;
}

/**
 * The page's one read of the plugins, for the page and the badge beside it to share. It starts when the shell knows which instance it is showing: a read made before that would go to this
 * machine's board, whatever instance is chosen. (The shell's own provider swaps its element type at that moment too, so everything beneath it starts afresh then anyway.)
 */
export function PluginsRead({ children }: Readonly<{ children: ReactNode }>) {
  const { connectionsReady } = useShell();
  return connectionsReady ? <ReadOfInstance>{children}</ReadOfInstance> : <PluginsReadContext.Provider value={NOT_READ_YET}>{children}</PluginsReadContext.Provider>;
}

/** The read the page provides, or null on a page that does not (a Settings page, whose badge reads for itself). */
export const useProvidedPluginsRead = (): PluginsReadValue | null => useContext(PluginsReadContext);
