// @ts-check
// module: what the board says of a pull request it brings up to date with its base (A11-286) -- PURE
//
// ONE WORDING FOR THE CARD AND THE LOG. The run's Timeline words a `base-merge` event with it, and the server's log says the same line when the board does it.
import type { BaseMergeStep } from "../queue/run-log.ts";
import { pullLabel } from "./pull-label.ts";

/** What the board did about a pull request's base, in the card's words: "a11ign/agent-org #1921 conflicts with main: merging main in". `base` is the branch it merges into, or null when the host did not say. PURE. */
export function baseMergeWords(url: string, base: string | null, step: BaseMergeStep): string {
  const into = base ?? "its base";
  const pull = pullLabel(url);
  switch (step) {
    case "merging": return `${pull} conflicts with ${into}: merging ${into} in`;
    case "behind": return `${pull} is behind ${into}: merging ${into} in`;
    case "round": return `${pull} conflicts with ${into}: conflict round started`;
    case "waiting": return `${pull} conflicts with ${into}: waits for the running worker`;
    case "capped": return `${pull} conflicts with ${into}: the board's rounds are used up; Respond to review starts another`;
  }
}
