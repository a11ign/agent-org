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
// THE CALLS THAT OPEN A WORKSPACE, START AN AGENT IN IT AND CLOSE IT LIVE HERE TOO (`openPane`, `agentStartArgs`, `closedNote`, with the
// `herdrReason` they quote a failure through), moved out of `wake.ts` unchanged so that ticket mode (`src/ticket-mode/`) runs the same
// spelling. Every call here takes a `session`, and every one defaults to {@link ORG_SESSION}, so the org's callers pass nothing and are
// unchanged; ticket mode passes its own, and its workers never appear in the org's listing.
//
// NOT in `./lib/`: that directory is #2658's (ADR 0040) fixed set of byte-identical copies of files from OTHER
// packages, pinned exactly by `agent-org-outward-edges.test.ts`'s "#2658: the seven copies ... no other file sits
// in lib/" -- a directory listing it reads literally. This file is native to `agent-org` (code moved within the
// package, not copied in from outside it), so it sits beside `claim-labels.ts` and `project-vocabulary.ts` instead.
import { execFileSync } from "node:child_process";

/** The herdr session the org runs in, and the default of every call in this file. */
export const ORG_SESSION = "org";

/** Which herdr session a call is made in. Absent means {@link ORG_SESSION}. */
export type SessionOption = { session?: string };

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
 * An entry whose pane herdr no longer has is still LISTED (it stays in this array, in status `unknown`), marked `paneless: true` -- see
 * {@link markPaneless}. Presence decides "a seat exists", so dropping it here would read a live seat as absent and start a second one.
 *
 * @param {(args: string[]) => string} [run]
 * @returns {{label: string, status: string, paneless?: boolean}[] | null}
 */
export function readAgents(run: (args: string[]) => string = defaultRun, { session = ORG_SESSION }: SessionOption = {}): ListedAgent[] | null {
  let raw;
  try {
    raw = run(["--session", session, "workspace", "list"]);
  } catch {
    return null;
  }
  let agents: ListedAgent[];
  let panes: Map<string, string>;
  try {
    const parsed = JSON.parse(raw);
    const workspaces = parsed?.result?.workspaces;
    if (!Array.isArray(workspaces)) return null;
    agents = workspaces.map((w) => ({ label: String(w.label ?? ""), status: String(w.agent_status ?? "unknown") }));
    panes = new Map(workspaces.flatMap((w): [string, string][] => (typeof w?.workspace_id === "string" ? [[String(w.label ?? ""), rootPaneOf(w.workspace_id)]] : [])));
  } catch {
    return null;
  }
  if (agents.some((a) => a.status === "unknown")) markPaneless(agents, panes, run, session);
  return agents;
}

/** One listed agent as {@link readAgents} reports it. `paneless` is set only when herdr has shown its pane gone (agent-org#1413). */
export type ListedAgent = { label: string; status: string; paneless?: boolean; };

/**
 * A workspace's root pane, by herdr's own naming: every agent's pane is `<workspace>:p1` (measured live 2026-10-15 for all 17 listed agents, and
 * `openPane` takes the root pane from `workspace create`). A pane named this way that herdr does not have is then `pane_not_found` and marks nothing
 * else, so a convention that ever failed would leave an agent unmarked, never ended.
 */
function rootPaneOf(workspace: string): string {
  return `${workspace}:p1`;
}

/**
 * agent-org#1413: A LISTED AGENT WHOSE PANE HERDR NO LONGER HAS IS ENDED, NOT LIVE. Its workspace stays in `workspace list` with status `unknown`, so
 * the status alone cannot tell it from a seat still starting; what can is its pane. `herdr pane read <pane>` answers `pane_not_found` for a pane that is
 * gone (measured live 2026-10-15 on `worker-agent-org-1325`, whose pane `w4KZ:p1` is still in `pane list`, so `pane list` cannot say so; `pane read` can).
 *
 * ONLY `pane_not_found` MARKS. Every other failure -- herdr not answering, a timeout, an answer that is not JSON -- is UNKNOWN, which is never read as ended:
 * a pane that cannot be read now may be one the org still needs. Only an `unknown` status is looked at, so a working or idle seat costs no call.
 */
function markPaneless(agents: ListedAgent[], panes: Map<string, string>, run: (args: string[]) => string, session: string): void {
  for (const agent of agents) {
    const pane = panes.get(agent.label);
    if (agent.status === "unknown" && pane !== undefined && paneNotFound(run, pane, session)) agent.paneless = true;
  }
}

/** Whether `herdr pane read` says the pane does not exist. Anything else (readable, or herdr failing for another reason) is `false`. */
function paneNotFound(run: (args: string[]) => string, pane: string, session: string): boolean {
  try {
    run(["--session", session, "pane", "read", pane, "--source", "visible"]);
    return false;
  } catch (err) {
    return `${(err as any)?.stderr ?? ""}${(err as any)?.stdout ?? ""}${(err as any)?.message ?? ""}`.includes("pane_not_found");
  }
}

/**
 * Each listed agent's CLAUDE SESSION ID by name (`herdr agent list`: `name`, and `agent_session.value`, which is a new id after a restart), or `null`
 * when herdr could not be asked. A name that carries no id is absent from the map: an unknown id is never read as a changed one (#458).
 * @param {(args: string[]) => string} [run]
 * @returns {Map<string, string> | null}
 */
export function readAgentSessions(run: (args: string[]) => string = defaultRun, { session = ORG_SESSION }: SessionOption = {}): Map<string, string> | null {
  try {
    const agents = JSON.parse(run(["--session", session, "agent", "list"]))?.result?.agents;
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

/** How much of a thrown thing's first line a refusal quotes -- enough to name the failure, not a stack. */
export const REFUSAL_EXCERPT = 120;

/**
 * The first line of whatever was thrown, bounded.
 *
 * herdr's failures arrive as a multi-line `execFileSync` error whose first line is the only part that says
 * what went wrong; the rest is a stack and the command's own stderr. Extracted because three refusal paths
 * quoted it with the same expression written out three times, and a fourth would have been written the
 * same way.
 */
export function firstLine(err: unknown, max: number = REFUSAL_EXCERPT) {
  return String((err as any)?.message ?? err).split("\n")[0].slice(0, max);
}

/**
 * WHY a failed `herdr` command failed (#3032): its own stderr's first non-empty line, bounded, else {@link firstLine}.
 *
 * `execFileSync` puts `Command failed: <argv>` on the first line of `err.message` and the child's stderr on
 * `err.stderr`, so {@link firstLine} alone quoted the command we had just sent -- and a reviewer start herdr refused
 * repeated for an hour (28 `UNDELIVERED` lines, 2026-10-02) without one of them saying whether herdr was down, the
 * flag was bad or the model was rejected. An error with no stderr (a timeout, a spawn failure, a test's plain
 * `Error`) falls back to its first message line, which for those IS the reason.
 */
export function herdrReason(err: unknown, max: number = REFUSAL_EXCERPT) {
  const stderr = (err as any)?.stderr;
  const line = (typeof stderr === "string" || Buffer.isBuffer(stderr) ? String(stderr) : "")
    .split("\n").map((l) => l.trim()).find((l) => l !== "");
  return line === undefined ? firstLine(err, max) : line.slice(0, max);
}

/**
 * THE ONE `agent start` the tick has: an agent of `kind` named `name` in an existing pane, everything after herdr's `--` reaching the agent.
 * A persistent seat's start ({@link startSeat}) and a spawned engineer's ({@link spawnInvocation}) both go through it, so there is one spelling to
 * keep right and `wake-reviewer-instance.test.ts` (2b) still counts one. It lives here, beside the listing, so a caller outside the tick (ticket mode)
 * starts an agent with the same spelling, in its own `session`.
 */
export function agentStartArgs(name: string, kind: string, pane: string, agentTail: string[], { session = ORG_SESSION }: SessionOption = {}): string[] {
  return ["--session", session, "agent", "start", name, "--kind", kind, "--pane", pane, "--", ...agentTail];
}

/**
 * A new workspace for `label`, and the pane to start an agent in -- or a refusal.
 *
 * MEASURED AGAINST THE LIVE ORG, 2026-09-23: `herdr --session org workspace create --label X --no-focus`
 * answers with `result.root_pane.pane_id` and `result.workspace.workspace_id`, and `workspace close <id>`
 * answers `{"type":"ok"}`.
 *
 * THE PANE STARTS IN A NAMED DIRECTORY WHEN THE CALLER HAS ONE (#2405, #2401). Without `--cwd` herdr's default is
 * `/home/agent/repos/a11y-witness`, the PRIMARY checkout, which is the one directory `launchGate` (#1352) refuses
 * every policy script from -- so a spawned engineer began in the place it was forbidden to work, and its order
 * then named a directory that usually did not exist. The spawner has claimed the row by now (`spawnWorker`), so
 * the worktree exists and the agent's cwd is its unit of work; it never touches the primary and never borrows a
 * peer's tree. A REVIEWER passes its verified checkout (#2401: its whole task is one pull request's tree, prepared before the
 * pane opens). A `cwd` of `undefined` is the old default, kept for a caller that has claimed nothing.
 *
 * `--no-focus` because a tick must not steal the display from whoever is watching it.
 *
 * `--env` IS HOW THE SPAWN DECIDES WHO IT ACTS AS (#2323). herdr's server starts the pane's shell, so the
 * ticking process's own environment never reaches it -- measured 2026-09-24: `workspace create --env
 * GH_CONFIG_DIR=...` and `echo $GH_CONFIG_DIR` in that pane answers the value. See {@link spawnEnvironment}.
 *
 *
 *
 *
 * @param [cwd] the directory the pane's shell starts in
 */
export function openPane(run: (args: string[]) => string, label: string, env: Record<string, string>, cwd?: string, { session = ORG_SESSION }: SessionOption = {}): { pane: string; workspace: string; } | { refusal: string; } {
  let created;
  try {
    created = JSON.parse(run(["--session", session, "workspace", "create", "--label", label, "--no-focus",
      ...(cwd === undefined ? [] : ["--cwd", cwd]),
      ...Object.entries(env).flatMap(([key, value]) => ["--env", `${key}=${value}`])]));
  } catch (err) {
    return { refusal: `herdr could not open a pane for "${label}" (${herdrReason(err)})` };
  }
  const pane = created?.result?.root_pane?.pane_id;
  const workspace = created?.result?.workspace?.workspace_id;
  // A WORKSPACE WITH NO PANE ID IS STILL A WORKSPACE, so it is closed rather than left behind: an
  // unreadable answer is the one case where the thing to clean up is the thing we cannot describe.
  if (typeof pane !== "string" || typeof workspace !== "string") {
    return { refusal: `herdr's workspace for "${label}" named no pane`
      + `${workspace ? closedNote(run, String(workspace), { session }) : ""}` };
  }
  return { pane, workspace };
}

/**
 * Close a workspace this tick opened, and say so in the same breath as whatever failed.
 *
 * THIS TEARDOWN IS FOR A HALF-STARTED SPAWN; A FINISHED INSTANCE IS ENDED BY `endFinishedSpares` (#2323). A
 * workspace whose agent started IS the role's workspace while its row is open -- its label is the role's own
 * name, so `route` finds it and follow-up causes reach it. Only the window between `workspace create` and a
 * successful `agent start` leaves a pane nobody will ever use, and that is what this closes. Once the row
 * that instance claimed has closed (or been released) the tick ends it, on a rule read from `sessions.json`'s
 * `spare` mark and not from this comment -- the old bound ("nothing orphaned to collect") was true of the
 * pane and false of the ROLE: a spawned engineer that was never ended became a standing seat the first time
 * it claimed, and #1950's clean-cycle count could not count it.
 *
 * AND LEAVING ONE IS NOT A TIDINESS PROBLEM. A workspace with no agent reports `agent_status: "unknown"`,
 * which `WAKEABLE` excludes and `spawnableRole` refuses -- so an abandoned pane carrying a role's label
 * makes that role permanently unwakeable and unspawnable. It would silently remove an engineer from the
 * org, which is the 2026-09-08 shape this whole file exists to prevent.
 *
 * NEVER THROWS: it is called from the failure path, and a teardown that can fail the way its caller just
 * did would replace a reported refusal with an unreported one.
 *
 *
 * @returns a clause to append to the refusal being reported
 */
export function closedNote(run: (args: string[]) => string, workspace: string, { session = ORG_SESSION }: SessionOption = {}): string {
  try {
    run(["--session", session, "workspace", "close", workspace]);
    return ` -- the workspace it opened (${workspace}) was closed`;
  } catch (err) {
    return ` -- AND the workspace it opened (${workspace}) could NOT be closed (${herdrReason(err)}): close `
      + "it by hand, or that role reads `unknown` to every tick and is never woken again";
  }
}
