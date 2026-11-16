// @ts-check
// module: the headless worker of an eval (A11-431) -- its brief (the CURRENT `briefText`), its settings, its command line and the tokens its run reports
//
// THE BRIEF IS THE ONE A BOARD WOULD WRITE TODAY, from `briefText` itself, with the host's notes, plugins, draft choice, pre-PR review skill and the tracker's keywords: measuring
// a change to the brief is the harness's reason for being, so it never keeps a copy. What differs is only what must, for nothing to leave the machine: the worktree and pull-request
// commands are the eval's stand-ins (`sandbox.ts`), no connector is listed, and no design tool or screenshot is offered. The ticket's comments are left out: read after the
// merge, they name the merged pull request, which is the answer. So is the board's own run state (blockers, stacks, earlier steps), which a first run of a ticket has none of.
//
// THE SETTINGS ARE `workerSettings`' WITHOUT THE BOARD'S HOOKS: the ticket hook reads and writes the board's run state, which an eval has none of. The host's `gh` and `agent-org`
// are denied by their paths, as the hook's protected paths are for a real worker.
import { type Keywords, type Ticket } from "../ticket-mode/source.ts";
import { ticketReadOf } from "../ticket-mode/ticket-read.ts";
import { firstPrompt, briefText, protectedPaths, workerFlags, workerSettings, type ParentTicket } from "../ticket-mode/worker-files.ts";
import { type Tokens, tokensOf } from "../trace/tokens.ts";

/** What the host says about how its workers behave, read from its host file. */
export type HostBrief = Readonly<{ notes?: string; plugins: readonly string[]; drafts: boolean; prReview: string | null; keywords: Keywords; binDir: string }>;

/** Where the eval's worker works: its folder (the cwd), the ticket's directory (brief and attachments), the clones by name and the stand-ins' directory. */
export type Place = Readonly<{ folder: string; ticketDir: string; clones: Readonly<Record<string, string>>; standIns: string }>;

/** The worker's brief, as the board would write it for `ticket` today, pointing at the eval's clone and stand-ins. PURE but for `now`. */
export function evalBrief({ ticket, attachments, parent, place, host, repo, now }: {
  ticket: Ticket; attachments: readonly string[]; parent: ParentTicket | null; place: Place; host: HostBrief; repo: string; now: number;
}): string {
  return briefText({
    ticket, folder: place.folder, ticketDir: place.ticketDir, attachments, parent, clones: place.clones, repo,
    worktreeCommand: `${place.standIns}/eval-worktree`, prOpenCommand: `${place.standIns}/eval-pr-open`,
    ...(host.notes === undefined ? {} : { notes: host.notes }), connectors: [], drafts: host.drafts, designTools: false, capture: false, prReview: host.prReview, keywords: host.keywords,
    read: ticketReadOf(ticket, now),
  });
}

/** The folder's `.claude/settings.local.json`: a worker's settings, with no hooks, and the host's own `gh` and `agent-org` denied by their paths. PURE. */
export function evalSettings({ model, place, host }: { model: string; place: Place; host: HostBrief }): Record<string, unknown> {
  const { hooks: _hooks, ...settings } = workerSettings({ model, ticketDir: place.ticketDir, readDirs: Object.values(place.clones), hook: { node: "node", bin: "none" }, plugins: host.plugins });
  const permissions = settings.permissions as Record<string, unknown>;
  return { ...settings, permissions: { ...permissions, deny: protectedPaths(host.binDir).map((path) => `Bash(${path}:*)`) } };
}

/**
 * The `claude` command line: the first prompt, headless (`-p`) with its result as JSON, no MCP server, and then the board's own worker flags, which end with the one list flag
 * (`workerFlags` says why it is last). PURE.
 */
export function workerArgs({ name, model, effort, ticketDir }: { name: string; model: string; effort: string; ticketDir: string }): string[] {
  return [firstPrompt(ticketDir), "-p", "--output-format", "json", "--strict-mcp-config", ...workerFlags({ name, model, effort, addDirs: [ticketDir] })];
}

const sum = (tokens: Tokens): number => tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite5m + tokens.cacheWrite1h;

/**
 * The tokens a headless run spent, from its JSON result: every model's (`modelUsage`, which counts subagents and a second model too), else the main thread's `usage`, read the
 * way the trace store reads it (`tokensOf`). `null` when the output is not a result, so a run whose tokens are unknown never reads as 0. PURE.
 */
export function tokensOfResult(stdout: string): number | null {
  let result: { modelUsage?: Record<string, Record<string, number>>; usage?: unknown; type?: string };
  try {
    result = JSON.parse(stdout.trim().split("\n").pop() ?? "");
  } catch {
    return null;
  }
  if (result === null || typeof result !== "object") return null;
  const models = Object.values(result.modelUsage ?? {});
  if (models.length > 0) return models.reduce((total, used) => total + (used.inputTokens ?? 0) + (used.outputTokens ?? 0) + (used.cacheReadInputTokens ?? 0) + (used.cacheCreationInputTokens ?? 0), 0);
  return result.usage === undefined ? null : sum(tokensOf(result.usage));
}
