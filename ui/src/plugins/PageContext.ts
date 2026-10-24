import { createContext, useContext } from "react";
import type { PluginsAnswer, SettingsView } from "../api/types.ts";
import type { Editing } from "../settings/HostFileSection.tsx";
import type { Changes } from "./use-changes.ts";

/** What the cards and the Claude tab draw from, once the plugins are read: the answer, what to say of health, whether the page offers controls, and the page's changes and settings. */
export type PageValue = Readonly<{
  answer: PluginsAnswer;
  /** The instance's name while it cannot be reached and every status is unknown, else null. */
  instance: string | null;
  /** Whether the page draws controls: not for a remote instance (its files are changed on that machine), and not for a host file the reader refuses. */
  controls: boolean;
  changes: Changes;
  /** The Settings view the cards' own settings are rows of, or null until it is read. */
  view: SettingsView | null;
  /** What to say where a row needs the Settings view and it is not read: that it is being read, or the sentence it was refused with. */
  viewWords: string;
  editing: Editing;
}>;

const PageContext = createContext<PageValue | null>(null);

export const PageProvider = PageContext.Provider;

/** The page's values. Used only inside the page's tabs. */
export function usePage(): PageValue {
  const value = useContext(PageContext);
  if (value === null) throw new Error("usePage was used outside the Plugins page");
  return value;
}
