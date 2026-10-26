// module: answers a page's calls in Chromium -- `/api/connections` and `/c/<name>/api/...` from a stand-in instance, and `/runs/<key>` as `ticket:ui` does
//
// THE BUILD IS STATIC AND `astro preview` KNOWS NO INSTANCE, so a page check answers the calls itself through `context.route` (the same stand-in the component checks use,
// `fixtures.ts`). `/runs/<key>` has no file of its own: `ticket:ui` answers it with the nearest page above (`ui-build.ts`'s `locate`), so this does too, from the same function.
// Every page is sent with the policy `ticket:ui` sends, so a page that needs more than it allows (a linked stylesheet, say) fails its check here.
import { join } from "node:path";
import type { BrowserContext, Page, Response, Route } from "playwright-core";
import { locate } from "../../src/ticket-mode/ui-build.ts";
import { answerFor, type Request, type Stand } from "./fixtures.ts";
import { UI_ROOT } from "./site.ts";

const DIST = join(UI_ROOT, "dist");
const RUNS = "/runs/";

/** The policy `ticket:ui` sends with every page (`PAGE_CSP` in `ui-server.ts`). */
export const PAGE_CSP = "default-src 'self'; style-src 'unsafe-inline'; script-src 'self' 'unsafe-inline'; img-src 'self' data:";

/** What the stand-in does with an instance call: answers it, or `hold`s it, which leaves every read loading. */
export type Serving = Readonly<{ stand?: Stand; hold?: boolean }>;

const isInstanceCall = (pathname: string): boolean => pathname === "/api/connections" || /^\/(c\/[^/]+\/)?api\//.test(pathname);

/** Answers a page of the build: `/runs/<key>` with the runs page, as `ticket:ui` does, and any other document as the preview serves it, with the page's policy. */
async function sendPage(route: Route, pathname: string): Promise<void> {
  const page = pathname.startsWith(RUNS) ? locate(DIST, pathname) : null;
  if (page !== null) return route.fulfill({ path: page.file, contentType: "text/html; charset=utf-8", headers: { "content-security-policy": PAGE_CSP } });
  const response = await route.fetch();
  return route.fulfill({ response, headers: { ...response.headers(), "content-security-policy": PAGE_CSP } });
}

/** The paths of the calls a stand-in was asked, in order, and each with its method and body in `requests`. */
export type Asked = string[] & { requests: Request[] };

const ANSWER_MS = 10_000;

/**
 * Runs `act` (a click, say) and resolves with the answer to the call it makes to the path ending `suffix`.
 *
 * WAIT FOR THE ANSWER, NOT FOR THE REQUEST. `page.waitForRequest` resolves the moment the page sends, and `serveInstance` records the call afterwards, in its route handler: a
 * test that read `Asked.requests` then found it empty (A11-299). The handler records the call before it answers, so once the answer is back the call is in `requests`.
 */
export async function answeredAfter(page: Page, suffix: string, act: () => Promise<void>): Promise<Response> {
  const [response] = await Promise.all([page.waitForResponse((answer) => new URL(answer.url()).pathname.endsWith(suffix), { timeout: ANSWER_MS }), act()]);
  return response;
}

/** Answers the instance calls of every page of `context`, and the client-side routes of the built site. Returns the paths of the calls it was asked, in order. */
export async function serveInstance(context: BrowserContext, { stand = {}, hold = false }: Serving = {}): Promise<Asked> {
  const requests: Request[] = [];
  const asked = Object.assign([] as string[], { requests });
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    const path = `${url.pathname}${url.search}`;
    if (isInstanceCall(url.pathname)) {
      asked.push(path);
      const request = { method: route.request().method(), body: route.request().postData() === null ? undefined : route.request().postDataJSON() };
      requests.push({ ...request, path });
      if (hold || (stand.holdInstance === true && url.pathname !== "/api/connections")) return;
      const answer = answerFor(stand, path, request);
      return route.fulfill({ status: answer?.status ?? 404, contentType: "application/json", body: answer?.body ?? JSON.stringify({ error: `no route ${path}` }) });
    }
    if (route.request().resourceType() === "document") return sendPage(route, url.pathname);
    return route.continue();
  });
  return asked;
}
