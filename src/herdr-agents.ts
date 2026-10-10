// @ts-check
// HERDR'S OWN WORKSPACE LISTING, SHARED -- moved out of `wake.ts` for #2747.
//
// `readAgents` and `listingIsComplete` (the reviewer teardown's own "is this listing the whole org" check, #2465)
// used to live only in `wake.ts`. #2747 needs the SAME read from `claim-stall.ts`, which is a LEAF (`node:*`, the
// git-env scrubber and `claim-labels.ts` only, so `work-gate.ts` -- which runs before any `pnpm install` -- and
// `wake.ts` can both import it without one importing the other). `wake.ts` is not importable from a leaf: it
// already imports `claim-stall.ts` (line 76 there), and a leaf that imported its own importer would be a cycle.
// So this file is the shared home instead: `node:*` only, importable from both.
//
// NOT in `./lib/`: that directory is #2658's (ADR 0040) fixed set of byte-identical copies of files from OTHER
// packages, pinned exactly by `agent-org-outward-edges.test.ts`'s "#2658: the seven copies ... no other file sits
// in lib/" -- a directory listing it reads literally. This file is native to `agent-org` (code moved within the
// package, not copied in from outside it), so it sits beside `claim-labels.ts` and `project-vocabulary.ts` instead.
import { execFileSync } from "node:child_process";

/** @param {string[]} args */
const defaultRun = (args: string[]) => execFileSync("herdr", args, { encoding: "utf8", timeout: 30_000 });

/**
 * Every workspace herdr knows, as `{ label, status }`, or `null` when herdr could not be asked.
 *
 * `null` and `[]` are different answers and must stay different: `[]` is "herdr answered, and the org has
 * no workspaces", which is a real and reportable state; `null` is "herdr did not answer", which must never
 * read as an empty org -- that would report every order as undeliverable and, worse, read as quiet.
 *
 * CONFIRMED LIVE (2026-09-28, #2747's Open-check): `herdr --session org workspace list` answers
 * `{"result":{"workspaces":[{"label":"worker-2747","agent_status":"working",...}, ...]}}`, one entry per open
 * workspace -- a CLOSED workspace's label is simply absent from the array, not present with a "closed" status.
 *
 * @param {(args: string[]) => string} [run]
 * @returns {{label: string, status: string}[] | null}
 */
export function readAgents(run: (args: string[]) => string = defaultRun): { label: string; status: string; }[] | null {
  let raw;
  try {
    raw = run(["--session", "org", "workspace", "list"]);
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw);
    const workspaces = parsed?.result?.workspaces;
    if (!Array.isArray(workspaces)) return null;
    return workspaces.map((w) => ({ label: String(w.label ?? ""), status: String(w.agent_status ?? "unknown") }));
  } catch {
    return null;
  }
}

/**
 * Each listed agent's CLAUDE SESSION ID by name (`herdr agent list`: `name`, and `agent_session.value`, which is a new id after a restart), or `null`
 * when herdr could not be asked. A name that carries no id is absent from the map: an unknown id is never read as a changed one (#458).
 * @param {(args: string[]) => string} [run]
 * @returns {Map<string, string> | null}
 */
export function readAgentSessions(run: (args: string[]) => string = defaultRun): Map<string, string> | null {
  try {
    const agents = JSON.parse(run(["--session", "org", "agent", "list"]))?.result?.agents;
    if (!Array.isArray(agents)) return null;
    return new Map(agents.filter((a) => a?.name && a?.agent_session?.value).map((a) => [String(a.name), String(a.agent_session.value)]));
  } catch {
    return null;
  }
}

/** The two panes that are always running. A listing that shows neither of them is not a listing of the org. */
const STANDING_PANES = Object.freeze(["ceo", "orchestrator"]);

/**
 * IS THIS LISTING THE WHOLE ORG, as far as a listing can say so: it shows every standing pane. This is the test
 * that separates "herdr gave a complete list and this instance is not in it" from a partial list, which reads
 * EVERY instance as absent -- the standing panes included. A listing missing `ceo` or `orchestrator` is missing
 * things that exist, so what else it lacks is unproven. WHAT IT DOES NOT PROVE: a listing that dropped only some
 * workspaces and happened to keep both panes -- which is why one complete listing finding a label absent is never
 * enough on its own (each caller times its own confirmation window; see `wake.ts`'s reviewer teardown and
 * `claim-stall.ts`'s `goneReading` for the two that do).
 * @param {{label: string}[]} agents
 */
export function listingIsComplete(agents: { label: string; }[]) {
  return STANDING_PANES.every((pane) => agents.some((a) => a.label === pane));
}

/**
 * THE PERSISTENT SEATS THAT ARE NOT RUNNING: those no workspace in herdr's listing carries the label of. PRESENT MEANS LISTED, IN
 * ANY STATUS (`working`, `blocked`, `unknown`, `idle`), because a second start would be two seats with one name, and a status says
 * what a seat is doing and not whether it exists. A role that is not persistent is never named: a `worker-<n>` that is not up or a
 * `reviewer-<n>` is absent by design and is started for a cause, not for a roster line.
 *
 * `agents` is `readAgents`'s answer and must be a COMPLETE listing: a caller holding `null` or a partial list has no right to call
 * this (a partial list reads every seat as absent), which is why the start step checks {@link listingIsComplete} first.
 *
 * @param {readonly string[]} seats the persistent roster names
 * @param {readonly { label: string, status?: string }[]} agents `readAgents`'s answer: the labels decide, the status is carried and ignored
 * @returns {string[]}
 */
export function absentSeats(seats: readonly string[], agents: readonly { label: string; status?: string; }[]): string[] {
  const listed = new Set(agents.map((a) => a.label));
  return seats.filter((seat) => !listed.has(seat));
}
