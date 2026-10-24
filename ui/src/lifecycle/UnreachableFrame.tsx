import type { ReactNode } from "react";
import { AlertIcon } from "./icons.tsx";

/**
 * The frame of the Instance unreachable board: the alert with its icon, "Can't reach <name> over SSH." and the backend's sentence, then the last good data beneath it. It
 * keeps `explanation` and `actions` as slots for the unreachable view (A11-195: what the page keeps doing, "Check now", "Switch to this machine"), which the shell does not draw.
 */
export function UnreachableFrame({ name, refusal, explanation, actions, children }: Readonly<{ name: string; refusal: string; explanation?: ReactNode; actions?: ReactNode; children?: ReactNode }>) {
  return (
    <>
      <div role="alert" className="alert-banner alert-banner-top">
        <AlertIcon />
        <div className="alert-banner-text alert-banner-stack">
          <strong className="alert-banner-heading">Can't reach {name} over SSH.</strong>
          <span>{refusal}</span>
          {explanation === undefined ? null : <span className="alert-banner-explanation">{explanation}</span>}
        </div>
        {actions === undefined ? null : <div className="alert-banner-actions">{actions}</div>}
      </div>
      {children}
    </>
  );
}
