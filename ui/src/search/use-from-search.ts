import { useCallback, useEffect, useRef, useState } from "react";
import { ANYONE, type Person } from "../../../src/ticket-mode/assignee-filter.ts";
import type { ShellValue } from "../shell/ShellProvider.tsx";
import { browserStorage } from "../shell/storage.ts";
import type { BatchState, Selection } from "../tickets/use-queue-state.ts";
import { HANDOFF_EVENT, takeHandoff, wasInScope, type Handoff } from "./search-memory.ts";

/**
 * The ticket the Tickets page shows from search, and the view it moved to for it: the banner goes as soon as the project, the scope or the selection is not that view's. `project` is
 * undefined until the page has drawn the move, since an instance with no project picker shows the project its tickets in scope lead with, which the move to Anyone can change.
 */
type Shown = Readonly<{ handoff: Handoff; project?: string | null; moved: boolean; ticksBefore: readonly string[] }>;

/** The banner's words and its Back to my tickets, or null while no ticket is shown from search. */
export type FromSearch = Readonly<{ key: string; sentence: string; back: () => void }> | null;

/** Where the ticket is, as the banner says it: "in agent-org", or "in no project". */
const whereOf = (handoff: Handoff): string => (handoff.project === null ? "in no project" : `in ${handoff.project}`);

/** Whose the ticket is, as the banner says it. */
function ownerOf(handoff: Handoff, viewer: Person | null): string {
  if (handoff.assignee === null) return "unassigned";
  return handoff.assignee.id === viewer?.id ? "assigned to you" : `assigned to ${handoff.assignee.name}`;
}

/** The banner's sentence after "Showing <key> from search.": where the ticket is and whose, that the scope the person came from would not have listed it (when it would not), and what the page shows now. */
export function fromSearchSentence(handoff: Handoff, viewer: Person | null): string {
  const outside = wasInScope(handoff, viewer) ? "" : `, so it sits outside ${handoff.fromScopeName}`;
  return `It is ${whereOf(handoff)} and ${ownerOf(handoff, viewer)}${outside}. Everyone's tickets are shown here.`;
}

/** Takes a handoff the palette left, on load and whenever the palette hands one over on this page. */
function useHandoff(): [Handoff | null, () => void] {
  const [handoff, setHandoff] = useState<Handoff | null>(null);
  useEffect(() => {
    const take = () => {
      const taken = takeHandoff(browserStorage(), Date.now());
      if (taken !== null) setHandoff(taken);
    };
    take();
    globalThis.addEventListener(HANDOFF_EVENT, take);
    return () => globalThis.removeEventListener(HANDOFF_EVENT, take);
  }, []);
  const done = useCallback(() => setHandoff(null), []);
  return [handoff, done];
}

/**
 * The Tickets page's side of the palette (A11-387). A ticket opened from search moves the page to the ticket's project (where the instance picks projects) and to Anyone, and ticks it alone, so
 * "Queue 1 ticket" is ready. The project is chosen first, because choosing a project resets the scope. Back to my tickets puts the project, the scope and the ticks back as they were.
 */
export function useFromSearch(shell: ShellValue, selection: Selection, batch: BatchState): FromSearch {
  const [pending, done] = useHandoff();
  const [shown, setShown] = useState<Shown | null>(null);
  // The shell's choosers are new on every render: the effects read the latest through this, and run only when a handoff arrives or the view changes.
  const latest = useRef({ shell, selection, batch });
  latest.current = { shell, selection, batch };
  const ready = shell.config !== null;
  useEffect(() => {
    if (pending === null || !ready) return;
    const { shell: now, selection: ticks, batch: options } = latest.current;
    // Only an instance that picks projects moves to the ticket's; the scope is chosen after it, which resets it.
    const target = now.config?.projects === true ? pending.project : null;
    if (target !== null) now.chooseProject(target);
    now.chooseScope(ANYONE);
    // The searched ticket is the batch, alone and on the default options, as the queue bar's Clear leaves it; the ticks it replaces come back with Back to my tickets.
    const ticksBefore = [...ticks.selected];
    ticks.clear();
    options.reset();
    ticks.pick([pending.key]);
    setShown((before) => ({ handoff: pending, moved: target !== null, ticksBefore: before?.ticksBefore ?? ticksBefore }));
    done();
  }, [pending, ready, done]);
  const { project, scope } = shell;
  const { selected } = selection;
  useEffect(() => {
    if (shown === null) return;
    if (shown.project === undefined) {
      setShown({ ...shown, project });
      return;
    }
    const same = project === shown.project && scope === ANYONE && selected.size === 1 && selected.has(shown.handoff.key);
    if (!same) setShown(null);
  }, [shown, project, scope, selected]);
  if (shown === null) return null;
  const { handoff } = shown;
  const back = () => {
    const { shell: now, selection: ticks } = latest.current;
    if (shown.moved && handoff.fromProject !== null) now.chooseProject(handoff.fromProject);
    now.chooseScope(handoff.fromScope);
    ticks.clear();
    ticks.pick(shown.ticksBefore);
    setShown(null);
  };
  return { key: handoff.key, sentence: fromSearchSentence(handoff, shell.config?.viewer ?? null), back };
}
