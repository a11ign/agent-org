import type { Browser, BrowserContext, Page } from "playwright-core";
import { serveInstance } from "./instance-routes.ts";
import { runsStand } from "./runs/runs-stand.ts";
import { launchBrowser, startSite, type Site } from "./site.ts";

// A PAGE THE TAB HAS DRAWN BEFORE, IN CHROMIUM (A11-270): every route is a page load of its own, served as static HTML whose island is the page's skeleton until it hydrates. A
// return visit draws the runs the tab kept while every read is still in flight, paints no frame with a skeleton on the way, and hydrates without React throwing its HTML away.

let site: Site;
let browser: Browser;
beforeAll(async () => {
  site = await startSite();
  browser = await launchBrowser();
});
afterAll(async () => {
  await browser?.close();
  await site?.stop();
});

/** How long a page may take to draw before the check gives up on it. */
const DRAW_MS = 10_000;

/** The frames a page has drawn with a skeleton showing, counted from its first, and the errors it has logged. */
type Seen = Readonly<{ skeletonFrames: () => Promise<number>; errors: string[] }>;

/** Counts every frame of every page of `context` that shows a skeleton, and collects what `page` logs as an error. */
async function watch(context: BrowserContext, page: Page): Promise<Seen> {
  await context.addInitScript(() => {
    const seen = { frames: 0 };
    (window as unknown as { skeletonFrames: typeof seen }).skeletonFrames = seen;
    const frame = () => {
      if ([...document.querySelectorAll('[aria-busy="true"]')].some((element) => getComputedStyle(element).visibility !== "hidden")) seen.frames += 1;
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });
  const errors: string[] = [];
  page.on("console", (message) => message.type() === "error" && errors.push(message.text()));
  page.on("pageerror", (error) => errors.push(error.message));
  return { skeletonFrames: () => page.evaluate(() => (window as unknown as { skeletonFrames: { frames: number } }).skeletonFrames.frames), errors };
}

describe("a page the tab has drawn before", () => {
  it("draws its last runs while every read is held, with no frame of skeleton and no hydration error", async () => {
    const context = await browser.newContext();
    await serveInstance(context, { stand: runsStand() });
    // Registered last, so it runs first: once `held`, every call to the instance, the connections list too, is left unanswered.
    const reads = { held: false };
    await context.route(/\/api\//, (route) => (reads.held ? undefined : route.fallback()));
    const page = await context.newPage();
    const seen = await watch(context, page);
    await page.goto(`${site.origin}/runs`);
    await page.locator(".run-row").first().waitFor({ timeout: DRAW_MS });
    reads.held = true;
    await page.goto(`${site.origin}/settings/workers`);
    await page.goto(`${site.origin}/runs`);
    await page.locator(".run-row").first().waitFor({ timeout: DRAW_MS });
    expect(await seen.skeletonFrames()).toBe(0);
    expect(seen.errors).toEqual([]);
    await context.close();
  });

  it("draws the skeleton on the tab's first visit, while nothing is kept", async () => {
    const context = await browser.newContext();
    await serveInstance(context, { stand: runsStand(), hold: true });
    const page = await context.newPage();
    await page.goto(`${site.origin}/runs`);
    await page.getByRole("status", { name: "Loading runs" }).waitFor({ timeout: DRAW_MS });
    await context.close();
  });
});
