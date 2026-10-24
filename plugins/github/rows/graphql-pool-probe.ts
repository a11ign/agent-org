// module: the GraphQL pool's probe (A11-160, step 9; moved from `src/api-pool.ts`, where `GRAPHQL_POOL_PROBE` was core's copy of a `gh` command line)
//
// This file is import-free and names no spawn: the caller runs it through its own runner (`api-pool.ts` reads the answer's headers, `plugins/github/wrapper/gh` sends the same call as `pool_probe`).

/**
 * The GRAPHQL pool's own probe, and the cheapest one there is: one point, and the body names the account.
 *
 * `gh pr list` and `gh issue list` -- every read the gate makes -- spend GRAPHQL, so this is the pool that
 * dies when the gate goes deaf. Measured 2026-09-23: the `X-Ratelimit-*` headers ARE on the `gh pr list`
 * response (`GH_DEBUG=api` prints them) but `gh` discards them; `pr list` has no `-i`/`--include` flag,
 * and a forced non-zero `pr list` carries no `X-Ratelimit-*` on stdout OR stderr. So the pool cannot be
 * read off the call that failed, and naming it costs a call of its own.
 *
 * WHY THERE IS NO SECOND PROBE, THOUGH THE LOGIN IS WHAT #2003 ASKED FOR FIRST: a rate-limited response names
 * the account as a USER ID and nothing else, and no single `gh` call yields both the login and the graphql pool
 * (`api graphql ... -i`: pool and reset, a user ID; `api user -i` and `auth status`: the login, but the `core` pool;
 * `pr list`: no headers at all; `api rate_limit`: forbidden as a gauge, #1275, #1967). So **the reset wins the single
 * call**, and the account is reported UNREADABLE beside the user ID the dead response did name (`refusalPoolLine`,
 * `api-pool.ts`), the login being bought at zero calls from `gh-identity.ts` (#1984).
 */
export const GRAPHQL_POOL_PROBE: readonly string[] = Object.freeze(["api", "graphql", "-f", "query=query { viewer { login } }", "-i"]);
