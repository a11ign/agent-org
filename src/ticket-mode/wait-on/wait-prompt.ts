// A leaf of ticket mode, run by no command: the one prompt the board sends a worker's pane when a wait it declared ends or passes its deadline, and the sending of it (A11-245). The text is one line, as the board's other prompts are: a new
// line typed into a pane would submit it early. It says what happened per item, with the reason first on a failure, and tells the worker to act on it and not to declare the same wait again. The prompt goes through herdr's `agent prompt`,
// as A11-85's does, from a helper of this folder.
import { herdrReason } from "../../herdr-agents.ts";
import type { Verdict } from "./wait-verdict.ts";
import type { Woke } from "./wait-types.ts";

/** What every wake ends with: act on it, and do not wait on the same thing again. */
const ACT = "Act on it: write the outcome the run ended on, or a new working outcome for anything you still wait on, and do not declare the same wait again.";

/** The one line sent to a worker woken for a declared wait: what each item came to, from the latest reading. PURE. */
function declaredPrompt(woke: Woke, verdict: Verdict, deadline: string): string {
  const lines = verdict.lines.join("; ");
  if (verdict.outcome === "failed") return `Your wait failed: ${verdict.reason}. All of it: ${lines}. ${ACT}`;
  if (woke.why === "late") return `Your wait passed its deadline (${deadline}) with these still pending: ${lines}. Check them, then carry on, or write a new working outcome with a new until if they are still worth waiting for.`;
  return `What you waited on has finished: ${lines}. ${ACT}`;
}

/** The line sent to a worker whose own background work, held by its shell or Monitor, passed the bound of its wait. PURE. */
const undeclaredPrompt = (deadline: string): string => `your wait has passed its bound (${deadline}); check it and carry on`;

/**
 * What to tell a worker the board woke, as one line: for a declared wait the verdict it was woken on (the latest reading), for an undeclared one the bound it passed. `verdict` is null for an undeclared wait, which has no
 * reading. `deadline` is the wait's, as an ISO time. PURE.
 */
export const wakePrompt = (woke: Woke, verdict: Verdict | null, deadline: number): string =>
  verdict === null ? undeclaredPrompt(new Date(deadline).toISOString()) : declaredPrompt(woke, verdict, new Date(deadline).toISOString());

/** Sends the prompt to the run's agent, by its herdr name: null when herdr took it, or why it refused. */
export function sendWake(herdr: (args: string[]) => string, session: string, name: string, text: string): string | null {
  try {
    herdr(["--session", session, "agent", "prompt", name, text]);
    return null;
  } catch (error) {
    return herdrReason(error);
  }
}
