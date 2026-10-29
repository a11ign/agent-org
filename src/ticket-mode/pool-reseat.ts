// @ts-check
// module: a run whose restored pane lost its environment is started again where it is, with the environment the board set at start and the resume prompt (A11-279)
//
// WHY A RESTART AND NOT AN `export`. herdr restores a pane's directory and Claude session and not the `--env` of `workspace create` (its `session.json` holds `cwd` and `agent_session`), and the gh wrapper reads the Claude
// process's own environment. Variables typed into the pane's shell never reach a Claude that is already running, so the run is started again the way a review run resumes a worker: close its workspace, open one with
// {@link runEnvOf}'s environment, and start `claude --resume <session>` in the same folder, its first prompt the resume prompt. The conversation, the worktree and the plan are all where they were.
import { readAgentsAsync } from "../herdr-agents.ts";
import { closeWorkspaceLater } from "./pool-close.ts";
import { type PoolContext } from "./pool-context.ts";
import { type RunPlace } from "./pool-paths.ts";
import { talkSession } from "./pool-prepare.ts";
import { resumePrompt, resumeRun } from "./pool-resume.ts";
import { end } from "./pool-settle.ts";
import { crashed, log, messageOf, runMembers, runPlace, updateEach } from "./pool-state.ts";
import { settleStart, start } from "./pool-start.ts";
import { markRunning } from "./queue/queue-transitions.ts";
import { replace, type Entry, type Queue, type ResumeNote } from "./queue/queue-entries-and-outcomes.ts";

/** The Claude session to resume: the one herdr last reported for the run's workspace (a restored session has a new id), else the run's recorded one, else the newest of its folder. Undefined when there is none. */
function sessionOf(ctx: PoolContext, entry: Entry): string | undefined {
  const live = entry.workspace === undefined ? undefined : ctx.claudeSessions.get(entry.workspace);
  return live ?? talkSession(ctx, entry);
}

/** The workspace to close: the one the run's record holds, else the one herdr lists under its label. */
async function workspaceOf(ctx: PoolContext, entry: Entry, place: RunPlace): Promise<string | undefined> {
  return entry.workspace ?? (await readAgentsAsync((args) => ctx.herdrCall(args, HERDR_MS), ctx.session))?.find((agent) => agent.label === place.name)?.workspace;
}

/** How long the board waits for herdr to list or close, in ms: the cut the synchronous call had. The wait holds no loop (A11-282). */
const HERDR_MS = 30_000;

/** Record the board's resume of a run, from the pane it is now in. PURE. */
const recordRestored = (workspace: string, pane: string, note: ResumeNote) => (queue: Queue, key: string): Queue =>
  replace(queue, key, ({ idleSince: _idle, ...entry }) => ({ ...entry, workspace, pane, resume: note }));

/**
 * Start a run again with its environment: close its workspace, start Claude in a new one with `--resume` and the resume prompt, and record the new workspace and pane with the note "environment restored". A run with no
 * session to resume, or whose workspace herdr will not close, is not killed: it is sent the resume prompt where it is, and its card says its environment is missing. A start that fails after the close ends the run `crashed`,
 * so a person sees it. The run is never started a second time beside the first.
 */
async function reseatRun(ctx: PoolContext, entry: Entry, note: ResumeNote): Promise<void> {
  const who = entry.batch ?? entry.ticket.key;
  const place = runPlace(ctx, entry);
  const session = sessionOf(ctx, entry);
  const workspace = await workspaceOf(ctx, entry, place);
  const missing = (why: string): Promise<void> => {
    log(`${who} keeps the pane that lost its environment: ${why}`);
    return resumeRun(ctx, entry, place, { ...note, environment: "missing" });
  };
  if (session === undefined) return missing("it has no Claude session to resume");
  if (workspace === undefined) return missing("herdr lists no workspace for it");
  try {
    await ctx.herdrCall(["--session", ctx.settings.herdrSession, "workspace", "close", workspace], HERDR_MS);
  } catch (err) {
    return missing(`herdr would not close its workspace ${workspace} (${messageOf(err).split("\n")[0]})`);
  }
  let started: { workspace: string; pane: string };
  try {
    started = await start(ctx, entry, place.folder, place.dir, session, resumePrompt(entry));
  } catch (err) {
    log(`${who}: its workspace ${workspace} was closed, but Claude could not be started again in it (${messageOf(err).split("\n")[0]})`);
    return end(ctx, entry, crashed(err));
  }
  // A person who stopped the run while it started has the last word: the workspace just opened is closed and the run stays stopped.
  if (ctx.store.get().entries.find((e) => e.ticket.key === entry.ticket.key)?.phase !== "running") return void closeWorkspaceLater(ctx, started.workspace);
  updateEach(ctx, runMembers(ctx, entry), recordRestored(started.workspace, started.pane, { ...note, environment: "restored" }));
  log(`${who} was started again in ${started.workspace} with its environment, resuming session ${session}, at ${new Date(ctx.now()).toISOString().slice(11, 16)}Z`);
  ctx.answered.delete(place.name);
  try {
    await settleStart(ctx, runPlace(ctx, entry));
  } catch (err) {
    log(`${who}: it was started again, but its start dialogs could not be read (${messageOf(err).split("\n")[0]})`);
  }
}

/**
 * Start again every run the watch queued because its pane lost the environment the board set at start ({@link resumeOrReseat}), one after the other: the starts are slow, and each is a herdr workspace of its own.
 * A run that has since ended or been stopped is not started. Null when no run is queued, so a pass with nothing to restart gives up no turn of the event loop (a caller awaits only a promise).
 */
export function reseatRuns(ctx: PoolContext): Promise<void> | null {
  return ctx.reseating.size === 0 ? null : startAgainOneByOne(ctx);
}

async function startAgainOneByOne(ctx: PoolContext): Promise<void> {
  for (const [name, { key, note }] of [...ctx.reseating]) {
    ctx.reseating.delete(name);
    const entry = ctx.store.get().entries.find((e) => e.ticket.key === key);
    if (entry !== undefined && entry.phase === "running") await reseatRun(ctx, entry, note);
  }
}
