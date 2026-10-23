// agent-org#1518: THE CORE (REST) POOL'S PROBE, the one `plugins/github/wrapper/gh`'s `pool_probe` sends for a refusal that names no GraphQL. The command is the GitHub plugin's (A11-160), behind the code host's `rows`;
// this is core's delegate, asked when a refusal is diagnosed and not when the module loads, since the code host is reached by `rows()`.
import { rows } from "../plugins/rows.ts";

/** (#1518) `gh api user -i`: the core pool's `X-Ratelimit-*` headers on a REST answer. */
export const corePoolProbe = (): readonly string[] => rows().corePoolProbe;
