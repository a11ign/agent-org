// @ts-check
// module: where a run's files live -- the folders and brief directories of a ticket, a batch, a publish run and a ticket's worktrees

import { type TicketSettings } from "./settings.ts";
import { join } from "node:path";
import { existsSync, readdirSync } from "node:fs";

/** Where a batch's planning run keeps its brief, its outcome and its plan folder. A ticket's own files stay in its {@link ticketDir}. */
export const batchDir = (settings: TicketSettings, batch: string): string => join(settings.stateDir, "tickets", "batches", batch);

/** The folder a batch's planning run starts in, among the person's repositories as a ticket's is. */
export const batchFolder = (settings: TicketSettings, batch: string): string => join(settings.worktreeRoot, batch);

/** Where a publish run keeps its brief, its outcome and the links to what it posted. */
export const publishDir = (settings: TicketSettings, id: string): string => join(settings.stateDir, "tickets", "publish", id);

/** The folder every publish run starts in, one at a time: it reads no repository. */
export const publishFolder = (settings: TicketSettings): string => join(settings.worktreeRoot, "publish");

/**
 * Where a run lives: the herdr name of its workspace (its label), the folder holding its brief and outcome, the folder its agent starts in, and the pane its agent is in once the run has one. herdr 0.9.3 lists
 * Claude agents with no name, so the agent is reached by its pane (`agentTarget`, A11-279), never by the name.
 */
export type RunPlace = Readonly<{ name: string; dir: string; folder: string; pane?: string }>;

/** The repositories a worker has made worktrees in: the folder's directories that hold a git worktree. */
export function worktreesIn(folder: string): string[] {
  if (!existsSync(folder)) return [];
  return readdirSync(folder, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(folder, entry.name, ".git")))
    .map((entry) => entry.name)
    .sort();
}
