// @ts-check
// WHAT IS LEFT IN THE POOL WE ARE ABOUT TO SPEND -- a LEAF module, deliberately: no import but node's own,
// so anything reaching for this one fact does not also drag in whatever else its original owner needed.
//
// This started life inside `queue-table.mjs` as a module-private `poolFromHeaders`, and moving it here
// (#2003) is not a style choice. `work-gate.mjs` needs the identical reading on its refusal path, and its
// own header states the constraint that forbids importing the owner: **it must run before any `npm ci` or
// build**. `queue-table.mjs` reaches `queue-stalled.mjs`, `newest-check-run.mjs`, `pr-hold-state.mjs`,
// `repo-identity.mjs` and `git-env.mjs`; the gate runs 720 times a day and would pay that graph on every
// one of them to use a function it calls only when already refusing. `region-paths.mjs`'s own header
// records this exact trade being made before, for the same reason.
//
// A SECOND COPY OF "HOW TO READ A POOL" IS REFUSED, which is the other half of why this is a move rather
// than a reimplementation: #2003's Region says so outright, and the copy would be the one place the two
// readers could silently disagree about what "exhausted" looks like.

/**
 * How a budget line reads. A remaining count with no window is not a measurement -- 4000 left with fifty
 * minutes to go and 4000 left with two are different states -- so the reset is always beside it.
 *
 * `resource` and `resetAt` joined the shape for #2003. The gate's refusal has to name WHICH pool refused
 * and WHEN it comes back in absolute terms: a reader arriving at the journal an hour later cannot use
 * "in 52m", because the minutes were counted when the line was written, not when it is read.
 *
 * `resource` and `resetAt` are OPTIONAL, and that is not laxity. Every pool this module READS carries
 * both; a pool built by hand to exercise the rendering does not, and `renderBudget` has never needed
 * either. Optional says exactly that -- a reading always supplies them, a fixture need not -- and keeps
 * `queue-table.test.ts`'s eleven budget-line pins about the words they were written to protect.
 *
 * @typedef {{remaining: number, limit: number, used: number, resetInMinutes: number | null,
 *            resource?: string | null, resetAt?: string | null}} Pool
 */

/**
 * The GRAPHQL pool's own probe, and the cheapest one there is: one point, and the body names the account.
 *
 * `gh pr list` and `gh issue list` -- every read the gate makes -- spend GRAPHQL, so this is the pool that
 * dies when the gate goes deaf. Measured 2026-09-23: the `X-Ratelimit-*` headers ARE on the `gh pr list`
 * response (`GH_DEBUG=api` prints them) but `gh` discards them; `pr list` has no `-i`/`--include` flag,
 * and a forced non-zero `pr list` carries no `X-Ratelimit-*` on stdout OR stderr. So the pool cannot be
 * read off the call that failed, and naming it costs a call of its own.
 */
export const GRAPHQL_POOL_PROBE = Object.freeze(["api", "graphql", "-f", "query=query { viewer { login } }", "-i"]);

/**
 * WHO WE ARE, ASKED ON THE OTHER POOL -- and it is needed exactly when the first probe cannot answer.
 *
 * A rate-limited response names the account as a USER ID and nothing else (`API rate limit already
 * exceeded for user ID 328832207`), so the probe above stops naming the login at the moment the login
 * matters most. This spends CORE, a separate pool with a separate counter and reset, which is why it can
 * answer while graphql is dead: measured 2026-09-09, graphql reached 0 of 5000 while core sat at 2110.
 *
 * REST, not `gh auth status`, although that command names the login and the very `hosts.yml` it resolved:
 * its output is prose for a human and `.login` is a contract. Both cost the same single core call.
 */
export const LOGIN_PROBE = Object.freeze(["api", "user", "-i"]);

/**
 * One `gh ... -i` call's raw response, WHETHER OR NOT IT SUCCEEDED. `null` when there is no response at all.
 *
 * THE HEADERS COME BACK ON THE 403, AND THE CALL FAILS EXACTLY WHEN THE POOL IS EXHAUSTED. Measured
 * 2026-09-09: with graphql at 0 of 5000, `gh api graphql -i` exits non-zero -- so a plain `ask()` here
 * returned null and the line read `graphql UNREADABLE` during the one outage it exists to report.
 *
 * An instrument that fails precisely when its subject fails reports the alarming state as no state.
 * `execFileSync` puts the response on the thrown error's `stdout`, and GitHub sends `X-Ratelimit-*` on a
 * rate-limited response like any other, so the answer is there either way.
 *
 * @param {readonly string[]} args @param {(args: string[]) => string} run
 * @returns {string | null}
 */
export function rawResponse(args, run) {
  try {
    return run([...args]) || null;
  } catch (error) {
    return /** @type {{stdout?: string}} */ (error).stdout || null;
  }
}

/** @param {string} raw @param {string} name @returns {string | null} */
function header(raw, name) {
  const found = new RegExp(`^${name}:[ \\t]*(.+?)[ \\t]*$`, "im").exec(raw);
  return found ? found[1] : null;
}

/** @param {string} raw @param {string} name @returns {number | null} */
function numericHeader(raw, name) {
  const value = header(raw, name);
  return value !== null && /^\d+$/.test(value) ? Number(value) : null;
}

const MS_PER_MINUTE = 60_000;

/**
 * One pool, read from the `X-Ratelimit-*` headers of a real call. `null` when there is no response or the
 * headers cannot be parsed -- NEVER a zero, because "I could not ask" and "nothing is left" are the two
 * states this whole module exists to keep apart.
 *
 * @param {string | null} raw @param {number} [now]
 * @returns {Pool | null}
 */
export function poolFromResponse(raw, now = Date.now()) {
  if (!raw) return null;
  const remaining = numericHeader(raw, "X-Ratelimit-Remaining");
  const limit = numericHeader(raw, "X-Ratelimit-Limit");
  const reset = numericHeader(raw, "X-Ratelimit-Reset");
  if (remaining === null || limit === null) return null;
  return {
    remaining,
    limit,
    used: limit - remaining,
    // THE POOL NAMES ITSELF. Reading `graphql` off the response rather than off the args is what lets the
    // refusal say which pool answered: `agent-practices.md` records two sessions burning a cycle on a
    // reading from the wrong pool, and `X-Ratelimit-Resource` is the header that settles it.
    resource: header(raw, "X-Ratelimit-Resource"),
    resetAt: reset === null ? null : new Date(reset * 1000).toISOString(),
    resetInMinutes: reset === null ? null : Math.max(0, Math.round((reset * 1000 - now) / MS_PER_MINUTE)),
  };
}

/**
 * One pool, from a call made here. The spelling `queue-table.mjs`'s `apiBudget` has always used.
 *
 * @param {string[]} args @param {(args: string[]) => string} run
 * @returns {Pool | null}
 */
export function poolFromHeaders(args, run) {
  return poolFromResponse(rawResponse(args, run));
}

/**
 * The login a `gh ... -i` response names, or `null`.
 *
 * TWO SPELLINGS BECAUSE THERE ARE TWO PROBES: GraphQL answers `{data:{viewer:{login}}}` and REST answers
 * `{login}`. Neither appears on a rate-limited response, and that absence is the whole reason
 * `LOGIN_PROBE` exists -- so `null` here means "this response did not say", never "there is no account".
 *
 * @param {string | null} raw
 * @returns {string | null}
 */
export function loginFromResponse(raw) {
  if (!raw) return null;
  // The body follows the blank line that ends the headers. Splitting on the FIRST one is what keeps a
  // `\r\n\r\n` inside a body from being read as the separator.
  const separated = raw.split(/\r?\n\r?\n/);
  if (separated.length < 2) return null;
  const body = separated.slice(1).join("\n\n");
  try {
    const parsed = JSON.parse(body);
    const login = parsed?.data?.viewer?.login ?? parsed?.login;
    return typeof login === "string" && login ? login : null;
  } catch {
    // NOT AN EMPTY CATCH: a body that is not JSON is a real answer -- "this response did not name an
    // account" -- and the caller renders it as UNREADABLE. There is no diagnostic to lose here, because
    // the response itself has already been written to stderr by the call that produced it.
    return null;
  }
}

/**
 * WHICH ACCOUNT, WHICH POOL, AND WHEN IT COMES BACK -- the three facts a refusal cannot state without a
 * call, gathered for the price of one when the pool is alive.
 *
 * THE SECOND CALL IS CONDITIONAL, AND ON THE ONE CONDITION THAT NEEDS IT. #2003's done-when asks for at
 * most one extra request; one is all a healthy pool costs, because its probe's own body names the login.
 * A DEAD pool cannot name its own account -- GitHub gives a user ID -- so naming it takes a second probe
 * on CORE, a pool that by construction is not the one that just refused. That second point is spent only
 * on a tick that has already refused both of its reads, and never on a healthy one.
 *
 * @param {{run: (args: string[]) => string}} deps
 * @returns {{login: string | null, pool: Pool | null, calls: number}}
 */
export function poolDiagnosis({ run }) {
  if (typeof run !== "function") {
    throw new Error("poolDiagnosis: no run given -- it is required, because a defaulted one is a live gh "
      + "call (#1405: apiBudget's default reached them on every run of queue-table.test.ts).");
  }
  const raw = rawResponse(GRAPHQL_POOL_PROBE, run);
  const pool = poolFromResponse(raw);
  const login = loginFromResponse(raw);
  if (login !== null) return { login, pool, calls: 1 };
  return { login: loginFromResponse(rawResponse(LOGIN_PROBE, run)), pool, calls: 2 };
}

/** @param {Pool} pool */
function poolPhrase(pool) {
  // `?? null` because `resetAt` is optional: an ABSENT reset and a null one are the same answer here --
  // the window is unreadable -- and a bare `=== null` would print `undefined` for the first of them.
  const window = (pool.resetAt ?? null) === null
    ? "no reset header, so the window is UNREADABLE"
    : `resets at ${pool.resetAt}`
      + (pool.resetInMinutes === null ? "" : ` (${pool.resetInMinutes}m after this line was written)`);
  // EVERY NUMBER CARRIES ITS WORD, AND A BARE FRACTION IS BANNED HERE -- `renderBudget`'s rule, for its
  // reason: `4961/5000` reads as used-of-limit, and on 2026-09-09 that misreading froze eight sessions.
  return `pool ${pool.resource ?? "UNNAMED"}, ${pool.used} used, ${pool.remaining} remaining `
    + `of ${pool.limit}, ${window}`;
}

/**
 * The line the journal needs, and the one the 2026-09-22 outage did not have.
 *
 * `CANNOT ASK` was correct and loud for eight minutes of ticks and still left the reader unable to tell a
 * dead pool from a quiet queue: `328832207` is a user ID, not a login, and the answer to "for how long" --
 * 52 minutes -- was sitting in the headers of the call that had just failed.
 *
 * EACH FACT MAY BE UNREADABLE ON ITS OWN, and none of them is ever guessed. An instrument that cannot
 * answer must not answer zero: a missing pool prints UNREADABLE, never `0 remaining`, because a reader who
 * takes that for an exhausted pool waits for a reset that is not coming.
 *
 * @param {{login: string | null, pool: Pool | null}} diagnosis
 * @returns {string}
 */
export function refusalPoolLine({ login, pool }) {
  const account = `account ${login ?? "UNREADABLE"}`;
  if (pool === null) {
    return `REFUSED ON: ${account}, pool UNREADABLE -- the probe could not be read either, so this tick `
      + "CANNOT say whether the pool is exhausted or something else refused both reads.";
  }
  const verdict = pool.remaining === 0
    ? "THE POOL IS EXHAUSTED: the org is deaf until that reset, and every session on this account shares "
      + "the one counter."
    : "THE POOL IS NOT THE CAUSE -- it has budget left, so something else refused both reads.";
  return `REFUSED ON: ${account}, ${poolPhrase(pool)}. ${verdict}`;
}
