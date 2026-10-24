import { useCallback, useState } from "react";
import type { Drafts } from "./settings-model.ts";

/** The browser's `sessionStorage`, or null where it is refused (a private window, a blocked site): the drafts are then kept for this page alone. */
function tabStorage(): Storage | null {
  try {
    return globalThis.sessionStorage;
  } catch {
    return null;
  }
}

/** What a tab remembers of the changes staged for one instance, so moving between Models, Workers and Machine (a page load each) does not lose them. */
export const draftsKey = (connection: string): string => `ticket-mode.settings-drafts.${connection}`;

function recalled(key: string): Drafts {
  try {
    const stored: unknown = JSON.parse(tabStorage()?.getItem(key) ?? "{}");
    return typeof stored === "object" && stored !== null && !Array.isArray(stored) ? Object.fromEntries(Object.entries(stored).filter((entry): entry is [string, string] => typeof entry[1] === "string")) : {};
  } catch {
    return {};
  }
}

function remembered(key: string, drafts: Drafts): void {
  try {
    if (Object.keys(drafts).length === 0) tabStorage()?.removeItem(key);
    else tabStorage()?.setItem(key, JSON.stringify(drafts));
  } catch {
    // The drafts are still held by the page; only moving to another page forgets them.
  }
}

export type DraftState = Readonly<{
  drafts: Drafts;
  /** Sets what a row's input says. */
  type: (id: string, text: string) => void;
  /** Takes the drafts of `ids` back, so those rows show what the file holds. */
  discard: (ids: readonly string[]) => void;
}>;

/** What has been typed into the rows of the instance `connection`, kept for the tab. The page is keyed by the connection, so another instance never shows these. */
export function useDrafts(connection: string): DraftState {
  const key = draftsKey(connection);
  const [drafts, setDrafts] = useState<Drafts>(() => recalled(key));
  const update = useCallback((next: (before: Drafts) => Drafts) => {
    setDrafts((before) => {
      const after = next(before);
      remembered(key, after);
      return after;
    });
  }, [key]);
  return {
    drafts,
    type: (id, text) => update((before) => ({ ...before, [id]: text })),
    discard: (ids) => update((before) => Object.fromEntries(Object.entries(before).filter(([id]) => !ids.includes(id)))),
  };
}
