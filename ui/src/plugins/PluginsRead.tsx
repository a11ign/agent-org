import { createContext, useContext, type ReactNode } from "react";
import type { PluginsAnswer } from "../api/types.ts";
import { usePoll, type Poll } from "../api/use-poll.ts";
import { useShell } from "../shell/ShellProvider.tsx";

/** The plugins as the instance last answered them: `/api/plugins`, with `refresh` to read them again. */
export type PluginsReadValue = Poll<PluginsAnswer>;

const PluginsReadContext = createContext<PluginsReadValue | null>(null);

/**
 * `/api/plugins`, read once per connection and again on `refresh`. It is not polled: the read runs the plugins' doctor checks (`security`, `claude mcp list`, `gh`), and the shell's own
 * queue poll is what notices the instance has gone. Never an empty answer: an instance with no plugin still has its concerns.
 */
export function usePluginsRead(): PluginsReadValue {
  const { client, connection } = useShell();
  return usePoll<PluginsAnswer>(client.plugins, { connection, repeat: false, isEmpty: () => false });
}

/** What the plugins are before the connections are known: nothing read, and nothing to read it of. */
export const NOT_READ_YET: PluginsReadValue = { state: "loading", data: null, refusal: null, readAt: null, refresh: () => undefined, current: async () => null };

function ReadOfInstance({ children }: Readonly<{ children: ReactNode }>) {
  return <PluginsReadContext.Provider value={usePluginsRead()}>{children}</PluginsReadContext.Provider>;
}

/**
 * The page's one read of the plugins, for the page and the badge beside it to share. It starts when the shell knows which instance it is showing: a read made before that would go to this
 * machine's board, whatever instance is chosen.
 */
export function PluginsRead({ children }: Readonly<{ children: ReactNode }>) {
  const { connectionsReady } = useShell();
  return connectionsReady ? <ReadOfInstance>{children}</ReadOfInstance> : <PluginsReadContext.Provider value={NOT_READ_YET}>{children}</PluginsReadContext.Provider>;
}

/** The read the page provides, or null on a page that does not (a Settings page, whose badge reads for itself). */
export const useProvidedPluginsRead = (): PluginsReadValue | null => useContext(PluginsReadContext);
