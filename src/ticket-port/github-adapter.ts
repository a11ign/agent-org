// THE GITHUB ADAPTER OF THE TICKET PORT (ADR 0046; agent-org#484). It lives in the GitHub plugin (`plugins/github/rows/adapter.ts`, A11-160) behind the code host's `rows`; this file is core's delegate, so a
// caller's import does not change (`src/plugins/rows.ts`). `run` is still the caller's: the gate's `defaultRun`, with its timeout, its identity and its call census.
import type { GithubAdapterOptions, GithubTicketAdapter } from "../plugins/contracts/code-host-rows.ts";
import { rows } from "../plugins/row-mode.ts";

export type { GithubAdapterOptions, GithubTicketAdapter };

/** The kind of tracker the adapter's items belong to: `ItemRef.tracker`. The code host's `rows.tracker` says the same (`rows.test.ts`). */
export const TRACKER = "github";

/** The query the adapter's open-items read sends, for a test that holds it to GitHub's GraphQL pool. */
export const openItemsQuery = (): string => rows().openItemsQuery;

/** The adapter. `TicketPort` is the four operations ADR 0046 rules; `OpenItemsReader` is the bulk read `port.ts` explains and keeps apart. */
export function githubTicketAdapter(options: GithubAdapterOptions): GithubTicketAdapter {
  return rows().ticketAdapter(options);
}
