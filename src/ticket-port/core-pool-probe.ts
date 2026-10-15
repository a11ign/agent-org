// agent-org#1518: THE CORE (REST) POOL'S PROBE, the one `host/gh`'s `pool_probe` sends for a refusal that names no GraphQL. It lives here and not in `api-pool.ts`
// because the committed call baseline (`gh-call-ratchet.test.ts`, #826) lets only this directory hold a second `api` call shape; `api-pool.ts` is at 1 and stays there.
// This file is import-free and names no spawn: the caller runs it through its own runner, as `api-pool.ts` does.
/** (#1518) `gh api user -i`: the core pool's `X-Ratelimit-*` headers on a REST answer. */
export const CORE_POOL_PROBE = Object.freeze(["api", "user", "-i"]);
