// module: where a ticket's own files live on this machine, shared by the pool that makes them and the pull request check that reads them
//
// Kept apart from `pool.ts` so `pr-open` can name a ticket's folder without importing the whole pool.
import { join } from "node:path";
import type { TicketSettings } from "./settings.ts";

/** The folder of a ticket's files, beside its worker's brief and outcome: `<stateDir>/tickets/<key>`. */
export const ticketDir = (settings: TicketSettings, key: string): string => join(settings.stateDir, "tickets", key);

/** The folder a ticket's worker starts in, and makes its worktrees in: `<worktreeRoot>/<key>`. */
export const ticketFolder = (settings: TicketSettings, key: string): string => join(settings.worktreeRoot, key);
