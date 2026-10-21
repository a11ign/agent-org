// @ts-check
// module: a round and a Talk never share a session -- before a queued review round or talk session starts, whatever else in herdr holds its Claude session or its name is waited for or closed (A11-154)

import { herdrRefusal } from "./pool-herdr.ts";
import { forgetRun, log, messageOf, runPlace, update } from "./pool-state.ts";
import { talkSession, sessionToResume } from "./pool-prepare.ts";
import { holdForSession } from "./queue/queue-transitions.ts";
import { type Entry } from "./queue/queue-entries-and-outcomes.ts";
import { type PoolContext } from "./pool-context.ts";

/** An agent's statuses that mean it is not doing anything: its workspace is a leftover, and is closed. Any other status (working, blocked on a person) holds the start back. */
const LEFTOVER: ReadonlySet<string> = new Set(["idle", "done", "unknown"]);

/** One herdr workspace and the agent in it: its id, its label, its agent's name and Claude session, and what its agent is doing. */
type Occupant = Readonly<{ workspace: string; label: string; name: string | null; session: string | null; status: string }>;

/** Whether the run is one that resumes a Claude session when it starts: a review round, or a talk session. */
const resumes = (entry: Entry): boolean => entry.phase === "queued" && (entry.review !== undefined || entry.talk === true);

/** Every workspace herdr lists with its agent, or null when herdr could not be asked. An agent with no workspace id is not listed: it cannot be closed. */
function readOccupants(ctx: PoolContext): Occupant[] | null {
  const { herdr, settings } = ctx;
  try {
    const workspaces = JSON.parse(herdr(["--session", settings.herdrSession, "workspace", "list"]))?.result?.workspaces;
    const agents = JSON.parse(herdr(["--session", settings.herdrSession, "agent", "list"]))?.result?.agents;
    if (!Array.isArray(workspaces) || !Array.isArray(agents)) return null;
    const known = new Map<string, Occupant>(workspaces.filter((w) => typeof w?.workspace_id === "string").map((w) => [String(w.workspace_id),
      { workspace: String(w.workspace_id), label: String(w.label ?? ""), name: null, session: null, status: String(w.agent_status ?? "unknown") }]));
    for (const agent of agents.filter((a) => typeof a?.workspace_id === "string")) {
      const before = known.get(String(agent.workspace_id));
      known.set(String(agent.workspace_id), { workspace: String(agent.workspace_id), label: before?.label ?? "", name: typeof agent.name === "string" ? agent.name : null,
        session: typeof agent.agent_session?.value === "string" ? agent.agent_session.value : null, status: String(agent.agent_status ?? before?.status ?? "unknown") });
    }
    return [...known.values()];
  } catch {
    return null;
  }
}

/** The occupants that hold what `entry`'s start needs: its herdr name, as a workspace's label or an agent's name, or its Claude session. */
function holdersOf(ctx: PoolContext, entry: Entry, occupants: readonly Occupant[]): Occupant[] {
  const { name } = runPlace(ctx, entry);
  const session = entry.talk === true ? talkSession(ctx, entry) : sessionToResume(ctx, entry);
  return occupants.filter((o) => o.label === name || o.name === name || (session !== undefined && o.session === session));
}

/** Close the workspace of a leftover agent. Returns why herdr would not, or null once it is closed. */
function closeLeftover(ctx: PoolContext, entry: Entry, occupant: Occupant): string | null {
  const { herdr, settings } = ctx;
  try {
    herdr(["--session", settings.herdrSession, "workspace", "close", occupant.workspace]);
    forgetRun(ctx, runPlace(ctx, entry).name);
    return null;
  } catch (err) {
    return herdrRefusal(err);
  }
}

/**
 * Settle one queued round or talk session against what holds its session: a working agent holds it back, with the wait recorded on the run; an agent that is idle, done or
 * has no pane is the run's own leftover, and its workspace is closed first, said in the log and on the run. A workspace herdr will not close holds it back too.
 */
function settleSession(ctx: PoolContext, entry: Entry, holders: readonly Occupant[]): void {
  const key = entry.ticket.key;
  const what = entry.talk === true ? "this talk session" : "this round";
  const working = holders.find((o) => !LEFTOVER.has(o.status));
  const closed: string[] = [];
  let refused: { workspace: string; why: string } | null = null;
  if (working === undefined) {
    for (const occupant of holders) {
      const why = closeLeftover(ctx, entry, occupant);
      if (why === null) closed.push(occupant.workspace);
      else refused = { workspace: occupant.workspace, why };
    }
  }
  const wait = working !== undefined ? `Waits for the Talk session in ${working.workspace} to end`
    : refused !== null ? `Waits for the Talk session in ${refused.workspace}: herdr would not close it (${refused.why})` : undefined;
  const note = closed.length > 0 ? `Closed the Talk session in ${closed.join(", ")} before ${what}` : undefined;
  if (note !== undefined) log(`${key}: ${note}`);
  const recorded = ctx.store.get().entries.find((e) => e.ticket.key === key)?.sessionWait;
  // Written only when the wait changed or something was closed, so a pass that finds the same hold does not rewrite the queue.
  if (wait !== recorded || note !== undefined) update(ctx, (queue) => holdForSession(queue, key, wait, note));
}

/**
 * Before the pool starts what is queued: each queued review round and talk session is settled against herdr's workspaces ({@link settleSession}), so a round never
 * starts beside a Talk session that holds its Claude session or its name, and a Talk never starts beside a round. Nothing is read when no such run is queued, or the queue is
 * paused, and herdr that cannot be asked changes nothing.
 */
export function settleSessions(ctx: PoolContext): void {
  const queue = ctx.store.get();
  const waiting = queue.entries.filter(resumes);
  if (waiting.length === 0 || queue.paused) return;
  const occupants = readOccupants(ctx);
  if (occupants === null) return;
  for (const entry of waiting) {
    try {
      settleSession(ctx, entry, holdersOf(ctx, entry, occupants));
    } catch (err) {
      log(`${entry.ticket.key}: what holds its session could not be settled: ${messageOf(err)}`);
    }
  }
}
