import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { looksLikeRestart } from "../../../src/ticket-mode/board-view/reconnect.ts";
import type { Answer } from "../api/answer.ts";
import type { Client } from "../api/client.ts";
import type { PluginsAnswer } from "../api/types.ts";
import type { PollState, PollView } from "../api/use-poll.ts";
import type { ViewConnection } from "../api/types.ts";
import { nextDelay } from "../api/poll-schedule.ts";
import { useShell } from "../shell/ShellProvider.tsx";

/** The plugins as the instance last answered them: `/api/plugins`, with `refresh` to read them again. The shape the shared lifecycle components take. */
export type PluginsReadValue = PollView<PluginsAnswer> & Readonly<{ refresh: () => void }>;

const PluginsReadContext = createContext<PluginsReadValue | null>(null);

type Held = Readonly<{ client: Client; view: PollView<PluginsAnswer>; misses: number }>;

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

/** How often the plugins are read again while the instance runs their checks (A11-270). */
export const CHECKING_MS = 2_000;

/** Whether the instance is still running the checks of the view's answer: it has none yet, or is running them again. */
const isChecking = (view: PollView<PluginsAnswer>): boolean => view.state === "ready" && view.data !== null && (view.data.checking || view.data.checkedAt === null);

/**
 * `/api/plugins`, read once per connection and again when `refresh` asks (the page's Retry and "Read the plugins again", and after an action). It is NOT polled on the shell's cadence and a
 * failure is NOT retried on a backoff, which `usePoll` does even with `repeat: false`: a read can start the plugins' doctor checks (`security`, `claude mcp list`, `gh`) on the instance, and
 * reading again by itself would start them over and over for as long as a page stays open. The shell's own queue poll is what notices the instance has gone. Never an empty answer: an instance with no plugin still has its concerns.
 * ONE FAILURE IS RETRIED: the instance that did not answer (it is restarting, or took longer than the page's service waits). The page says "Reconnecting…", which promises it, so it reads again after
 * 2 seconds, and after twice as long each time it still finds nothing, up to a minute (A11-211's backoff), and stops at the first answer. An answer that is a refusal is not retried.
 * AN ANSWER WHOSE CHECKS ARE STILL RUNNING IS READ AGAIN (A11-270): the instance answers its last checks at once and runs them again behind the page, so the page reads again every
 * `CHECKING_MS` while the answer says `checking` or has no checks yet, and stops at the first that has finished them. The checks have a time limit, so this ends. A `refresh` (a person's
 * Retry or "Read the plugins again", or after a change) asks the instance to run them again, since they are kept for a minute; a read of its own does not.
 */
export function usePluginsRead(): PluginsReadValue {
  const { client, connection } = useShell();
  const [held, setHeld] = useState<Held>({ client, view: LOADING, misses: 0 });
  const [attempt, setAttempt] = useState({ count: 0, check: false });
  useEffect(() => {
    const reading = new AbortController();
    void (attempt.check ? client.pluginsCheckedAgain : client.plugins)(reading.signal).then((answer) => {
      if (reading.signal.aborted) return;
      setHeld((before) => {
        const view = viewAfter(before.client === client ? before.view : LOADING, answer, connection);
        return { client, view, misses: view.state === "reconnecting" ? (before.client === client ? before.misses : 0) + 1 : 0 };
      });
    });
    return () => reading.abort();
  }, [client, connection, attempt]);
  const waiting = held.client === client && held.view.state === "reconnecting";
  const checking = held.client === client && isChecking(held.view);
  useEffect(() => {
    if (!waiting && !checking) return undefined;
    const timer = setTimeout(() => setAttempt(({ count }) => ({ count: count + 1, check: false })), waiting ? nextDelay(held.misses) : CHECKING_MS);
    return () => clearTimeout(timer);
  }, [waiting, checking, held.misses, held.view]);
  return { ...(held.client === client ? held.view : LOADING), refresh: () => setAttempt(({ count }) => ({ count: count + 1, check: true })) };
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
