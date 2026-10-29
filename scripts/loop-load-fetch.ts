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

/** A server on a port of its own that answers every request with a 401. It does not keep the process alive, and is listening before anything else runs. */
const refusing = http.createServer((_request, response) => { response.writeHead(401, { "content-type": "application/json" }).end(REFUSAL); }).unref();
await new Promise<void>((listening) => { refusing.listen(0, "127.0.0.1", listening); });
const refusalPort = (refusing.address() as { port: number }).port;

const offline = offlineFetch(globalThis.fetch);
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  try {
    return await offline(input, init);
  } catch {
    return new Response(REFUSAL, { status: 401, headers: { "content-type": "application/json" } });
  }
}) as typeof fetch;

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/** The host a request is for, from the URL, the address or the options it was made with, or null when none is named. */
function hostOf(first: unknown): { hostname: string; path: string } | null {
  if (first instanceof URL || typeof first === "string") {
    const url = first instanceof URL ? first : new URL(first);
    return { hostname: url.hostname, path: `${url.pathname}${url.search}` };
  }
  const options = first as { hostname?: string; host?: string; path?: string } | null;
  const hostname = options?.hostname ?? options?.host;
  return typeof hostname === "string" ? { hostname, path: options?.path ?? "/" } : null;
}

/** A request made to refuse: for any host but loopback it is made to the stand-in server instead, whatever form the caller gave the address in. */
function refusingRequest(real: typeof http.request): typeof http.request {
  return ((...args: Parameters<typeof http.request>) => {
    const target = hostOf(args[0]);
    if (target === null || LOOPBACK.has(target.hostname)) return real(...args);
    const options = args.find((argument): argument is http.RequestOptions => typeof argument === "object" && !(argument instanceof URL) && argument !== null);
    const onResponse = args.find((argument): argument is (response: http.IncomingMessage) => void => typeof argument === "function");
    return http.request({ ...options, protocol: "http:", hostname: "127.0.0.1", host: undefined, port: refusalPort, path: target.path, agent: false }, ...(onResponse === undefined ? [] : [onResponse]));
  }) as typeof http.request;
}

const [realHttp, realHttps] = [http.request, https.request];
(http as { request: unknown }).request = refusingRequest(realHttp);
(https as { request: unknown }).request = refusingRequest(realHttps as typeof http.request);
syncBuiltinESMExports();
