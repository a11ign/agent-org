// @ts-check
// library: the `fetch` the test suite runs with. Loopback and `data:` go through, GitHub's status page answers that all is well, and anything else
// fails as a dropped network does
//
// WHY. The suite made live calls. The gate, run as a process by eight test files, asked githubstatus.com once a tick, 16 times a run, and one
// review-depth case reached api.typesafe.ai through the real `fetch`. On a laptop that is a test reading the internet. In CI a GitHub incident
// changes what a test about something else sees: agent-org#1178 read one from a log, and stubbed that one test.
//
// THE STATUS URL COMES FROM ITS LEAF (`work-gate/github-status-url.ts`), never the gate's cause module: this file is preloaded into every Node
// process a test starts, and that module imports half the tool.
import { GITHUB_STATUS_URL } from "./work-gate/github-status-url.ts";

/** GitHub's status page on a quiet day: the three components the gate reads, operational, and no incident. */
export const CALM_GITHUB_STATUS = Object.freeze({
  components: ["Actions", "API Requests", "Git Operations"].map((name) => ({ name, status: "operational" })),
  incidents: [],
});

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** `real`, kept off the network. A refused call throws what `fetch` throws for a dropped network, so the code under test takes its own offline path. */
export function offlineFetch(real: typeof fetch): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.protocol === "data:" || LOOPBACK.has(url.hostname)) return real(input, init);
    if (url.href === GITHUB_STATUS_URL) {
      return new Response(JSON.stringify(CALM_GITHUB_STATUS), { status: 200, headers: { "content-type": "application/json" } });
    }
    throw new TypeError("fetch failed", { cause: new Error(`the network is off in tests: ${url.origin}${url.pathname}`) });
  }) as typeof fetch;
}
