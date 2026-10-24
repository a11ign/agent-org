import { useEffect, type RefObject } from "react";

/**
 * Closes what the caller shows (it calls this only while it is shown) when the person presses Escape or clicks outside `container`, as the boards' popover and menus do. Escape also
 * gives the focus back to `opener`, the control that opened it; a click elsewhere leaves the focus where the click put it.
 */
export function useDismiss(close: () => void, container: RefObject<HTMLElement | null>, opener: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (!container.current?.contains(event.target as Node)) close();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      close();
      opener.current?.focus();
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [close, container, opener]);
}
