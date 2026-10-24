import { useEffect, useRef, type KeyboardEvent } from "react";

const FOCUSABLE = "button:not(:disabled), input:not(:disabled), a[href], select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex='-1'])";

/** Takes the focus into the dialog while it is open, keeps Tab inside it, closes on Escape, and gives the focus back to the control that opened it. */
export function useModalFocus<Dialog extends HTMLElement = HTMLDivElement>(close: () => void) {
  const dialog = useRef<Dialog>(null);
  useEffect(() => {
    const opener = document.activeElement;
    dialog.current?.focus();
    return () => {
      if (opener instanceof HTMLElement) opener.focus();
    };
  }, []);
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") return close();
    if (event.key !== "Tab" || dialog.current === null) return;
    const inside = [...dialog.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
    const [first, last] = [inside[0], inside[inside.length - 1]];
    if (first === undefined || last === undefined) return;
    const edge = event.shiftKey ? first : last;
    if (document.activeElement === edge || document.activeElement === dialog.current) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
    }
  };
  return { dialog, onKeyDown };
}
