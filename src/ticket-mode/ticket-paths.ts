// module: where a ticket's own files live on this machine, shared by the pool that makes them and the pull request check that reads them
//
// Kept apart from `pool.ts` so `pr-open` can name a ticket's folder without importing the whole pool.
import { join } from "node:path";
import type { TicketSettings } from "./settings.ts";

/** The folder of a ticket's files, beside its worker's brief and outcome: `<stateDir>/tickets/<key>`. */
export const ticketDir = (settings: TicketSettings, key: string): string => join(settings.stateDir, "tickets", key);

/** The folder a ticket's worker starts in, and makes its worktrees in: `<worktreeRoot>/<key>`. */
export const ticketFolder = (settings: TicketSettings, key: string): string => join(settings.worktreeRoot, key);

/** The folder a new-ticket request's run keeps its brief, its drafts and its outcome in: `<stateDir>/tickets/writer/<id>`. */
export const writerDir = (settings: TicketSettings, id: string): string => join(settings.stateDir, "tickets", "writer", id);

/**
 * The folder a new-ticket run starts in, one per run: it reads the repositories and changes none, but its settings file names its own hooks, so runs
 * that share a folder would overwrite each other's (up to three run at once).
 */
export const writerFolder = (settings: TicketSettings, id: string): string => join(settings.worktreeRoot, "writer", id);
