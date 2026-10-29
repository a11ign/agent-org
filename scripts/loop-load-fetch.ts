// preload: the network of loop-load's throwaway instance (A11-282). Nothing in it reaches the internet, and what would is REFUSED by an answer, a 401 with a GraphQL error, at once and from this machine.
//
// THE TRACKER DOES NOT GO THROUGH `globalThis.fetch`. The board gives the Linear client `freshFetch` (`src/fresh-fetch.ts`, A11-359), which opens its own connection with `node:https`, so the suite's offline `fetch` (`src/offline-fetch.ts`) never saw
// it, and the instance's tracker reads went to api.linear.app with the placeholder key, each one a round trip of 300 ms over the internet: the script timed the internet, and its reads of the tracker were over its 200 ms bound whatever the
// instance did. So `node:https` is patched here too (the way `src/ticket-mode/blocking-ledger.ts` patches `node:child_process`): a request for any host but loopback is made to a stand-in server of this process's own, which answers the refusal.
// A refusal is the right answer for the retry as well: the tracker tries a dropped connection three times, waiting 200, 800 and 2 000 ms (`plugins/linear/linear.ts`), and a refusal it never tries again.
import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import { offlineFetch } from "../src/offline-fetch.ts";

const REFUSAL = JSON.stringify({ errors: [{ message: "loop-load: the network is off" }] });

/** A server on a port of its own that answers every request with a 401. It does not keep the process alive. */
const refusing = http.createServer((_request, response) => { response.writeHead(401, { "content-type": "application/json" }).end(REFUSAL); }).listen(0, "127.0.0.1").unref();

const offline = offlineFetch(globalThis.fetch);
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  try {
    return await offline(input, init);
  } catch {
    return new Response(REFUSAL, { status: 401, headers: { "content-type": "application/json" } });
  }
}) as typeof fetch;

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);
/** Whether a request is for a host this process must not reach: any address but loopback. */
const isRefused = (url: URL | null): url is URL => url !== null && !LOOPBACK.has(url.hostname);
const realHttps = https.request;
(https as { request: unknown }).request = (...args: Parameters<typeof https.request>) => {
  const [first, ...rest] = args;
  const url = first instanceof URL ? first : typeof first === "string" ? new URL(first) : null;
  const address = refusing.address();
  if (!isRefused(url) || address === null || typeof address === "string") return realHttps(...args);
  return http.request(new URL(`${url.pathname}${url.search}`, `http://127.0.0.1:${address.port}`), ...(rest as [http.RequestOptions?]));
};
syncBuiltinESMExports();
