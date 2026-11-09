import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { Page } from "../shell/routes.ts";
import { useShell } from "../shell/ShellProvider.tsx";
import { SearchIcon } from "./SearchIcon.tsx";
import { SearchPalette } from "./SearchPalette.tsx";

/** Whether the browser runs on an Apple system, whose shortcut is ⌘K rather than Ctrl+K. */
const onApple = (): boolean => /Mac|iPhone|iPad/.test(globalThis.navigator?.platform ?? "");

/** Whether a dialog is open already (New ticket, Run options, the notification panel): the shortcut opens nothing over it, so one Esc never closes two. */
const dialogOpen = (): boolean => document.querySelector("[role=dialog]") !== null;

/** Whether a key is held that commands rather than types: ⌘, or Ctrl off an Apple system, where Ctrl+K in a text field deletes to the end of the line. */
const commanding = (event: KeyboardEvent): boolean => event.metaKey || (event.ctrlKey && !onApple());
/** Whether a key is held that makes K another shortcut. */
const otherModifier = (event: KeyboardEvent): boolean => event.altKey || event.shiftKey;
/** Whether the key is the palette's shortcut: Ctrl+K, or ⌘K. */
const isShortcut = (event: KeyboardEvent): boolean => event.key.toLowerCase() === "k" && commanding(event) && !otherModifier(event);

/** Ctrl+K, or ⌘K, anywhere on the page calls `open`; nothing does while `open` is null. */
function useShortcut(open: (() => void) | null): void {
  useEffect(() => {
    if (open === null) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (!isShortcut(event) || dialogOpen()) return;
      event.preventDefault();
      open();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);
}

/**
 * The sidebar's "Search tickets" button, with its ⌘K / Ctrl+K hint, and the palette it opens over the page (A11-387). Only an instance whose tracker can search (`config.search`) has either:
 * on any other, neither the button nor the shortcut exists.
 */
export function TicketSearch({ page }: Readonly<{ page: Page }>) {
  const searchable = useShell().config?.search === true;
  const [open, setOpen] = useState(false);
  const show = useCallback(() => setOpen(true), []);
  useShortcut(searchable ? show : null);
  if (!searchable) return null;
  return (
    <>
      <button type="button" className="search-button" aria-haspopup="dialog" aria-label="Search tickets" aria-keyshortcuts="Control+K Meta+K" onClick={show}>
        <SearchIcon size={14} />
        <span className="search-button-label">Search tickets</span>
        <kbd className="search-button-key">{onApple() ? "⌘K" : "Ctrl+K"}</kbd>
      </button>
      {open ? createPortal(<SearchPalette page={page} onClose={() => setOpen(false)} />, document.body) : null}
    </>
  );
}
