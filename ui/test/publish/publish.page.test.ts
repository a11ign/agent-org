import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Browser, BrowserContext, Page } from "playwright-core";
import type { Stand } from "../fixtures.ts";
import { answeredAfter, serveInstance, type Asked } from "../instance-routes.ts";
import { overflowProblem, SCREENS } from "../screenshots.ts";
import { launchBrowser, startSite, UI_ROOT, type Site } from "../site.ts";
import { detailAddress, detailOf, MESSAGE, PUBLISHER_REASON, REFUSAL, selectOf, TICKABLE, type Board } from "./publish-stand.ts";

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

/** Where the screenshots go, beside the page's checks: this page's own folder. Each is the board's page at 1440px and at 390px. */
const CAPTURES = join(UI_ROOT, "captures", "publish");
const RUNS = "/runs";
/** How long the late stand-in holds a call before it records it: far longer than the page takes to send it. */
const LATE_MS = 300;

type Opened = Readonly<{ page: Page; context: BrowserContext; asked: Asked }>;

async function open(stand: Stand, address: string, width = 1440): Promise<Opened> {
  const context = await browser.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: 1 });
  const asked = await serveInstance(context, { stand });
  const page = await context.newPage();
  await page.goto(`${site.origin}${address}`);
  return { page, context, asked };
}

const widthOf = (page: Page) => page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth }));
/** What each board draws first, which the capture waits for: the run's breadcrumb on Run detail, and the ticked rows' bar on the Runs page. */
const drawn = (page: Page) => page.getByRole("navigation", { name: "Breadcrumb" }).waitFor();
const posted = (asked: Asked) => asked.requests.filter(({ method, path }) => method === "POST" && path.endsWith("/api/publish")).map(({ body }) => body);

describe("the five Publish boards in Chromium", () => {
  /** A board at `screen`: measured for overflow, and written as `publish-<board>-<W>x<H>.png`. */
  async function captured(board: Board, screen: (typeof SCREENS)[number]): Promise<void> {
    const runs = board === "select";
    const failedPost = board === "failed" ? { post: () => ({ status: 409, error: REFUSAL }) } : {};
    const { page, context } = await open(runs ? selectOf() : detailOf(board, failedPost), runs ? RUNS : detailAddress, screen.width);
    try {
      await page.setViewportSize(screen);
      if (runs) {
        await page.locator(".run-row").first().waitFor();
        for (const key of ["A11-180", "A11-29"]) await page.getByRole("checkbox", { name: `Select ${key} to publish` }).check();
        await page.getByRole("region", { name: "Selected runs" }).waitFor();
        // The bar sticks to the bottom of the viewport: a viewport as tall as the page shows it after the list, as the board draws it, and covers no row.
        await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
        await page.setViewportSize({ width: screen.width, height: await page.evaluate(() => document.documentElement.scrollHeight) });
      } else {
        await drawn(page);
      }
      await page.evaluate(() => document.fonts.ready.then(() => undefined));
      expect(overflowProblem({ route: `${runs ? RUNS : detailAddress} (${board})`, width: screen.width, ...(await widthOf(page)) })).toBeNull();
      mkdirSync(CAPTURES, { recursive: true });
      writeFileSync(join(CAPTURES, `publish-${board}-${screen.width}x${screen.height}.png`), await page.screenshot({ fullPage: true }));
    } finally {
      await context.close();
    }
  }

  it.each(["ready", "publishing", "published", "failed", "select"] as const)("%s fits at 1440px and at 390px", async (board) => {
    for (const screen of SCREENS) await captured(board, screen);
  });
});

describe("Publish, driven in Chromium", () => {
  it("posts a run's key from Run detail and the ticked keys from the Runs page", async () => {
    const detail = await open(detailOf("ready", { post: () => ({ entries: [] }) }), detailAddress);
    await drawn(detail.page);
    await answeredAfter(detail.page, "/api/publish", () => detail.page.getByRole("button", { name: "Publish" }).click());
    expect(posted(detail.asked)).toEqual([{ keys: ["A11-180"] }]);
    await detail.context.close();

    const list = await open(selectOf({ post: () => ({ entries: [] }) }), RUNS);
    await list.page.locator(".run-row").first().waitFor();
    for (const key of TICKABLE) await list.page.getByRole("checkbox", { name: `Select ${key} to publish` }).check();
    await answeredAfter(list.page, "/api/publish", () => list.page.getByRole("button", { name: "Publish selected (3)" }).click());
    expect(posted(list.asked)).toEqual([{ keys: [...TICKABLE] }]);
    await list.context.close();
  });

  it("reads the publish call only once the stand-in has recorded it, however late that is", async () => {
    const detail = await open(detailOf("ready", { post: () => ({ entries: [] }) }), detailAddress);
    await drawn(detail.page);
    // Registered after the stand-in, so it is asked first (Playwright runs the last route that matches): the page has sent the call, and the stand-in has not yet seen it.
    await detail.context.route("**/api/publish", async (route) => {
      await new Promise((done) => setTimeout(done, LATE_MS));
      await route.fallback();
    });
    await answeredAfter(detail.page, "/api/publish", () => detail.page.getByRole("button", { name: "Publish" }).click());
    expect(posted(detail.asked)).toEqual([{ keys: ["A11-180"] }]);
    await detail.context.close();
  });

  it("gives the tick a 44px hit area and the Publish button 44px, in the boards' colours", async () => {
    const list = await open(selectOf(), RUNS);
    await list.page.locator(".run-row").first().waitFor();
    const tick = await list.page.locator(".tick").first().boundingBox();
    expect([tick?.width, tick?.height]).toEqual([44, 44]);
    expect(await list.page.locator(".tick input").first().evaluate((box) => getComputedStyle(box).accentColor)).toBe("rgb(123, 131, 240)");
    await list.context.close();
    const detail = await open(detailOf("ready"), detailAddress);
    await drawn(detail.page);
    const publish = detail.page.getByRole("button", { name: "Publish" });
    const box = await publish.boundingBox();
    expect(Math.min(box?.width ?? 0, box?.height ?? 0)).toBeGreaterThanOrEqual(44);
    expect(await publish.evaluate((button) => [getComputedStyle(button).color, getComputedStyle(button).borderTopColor])).toEqual(["rgb(154, 161, 245)", "rgb(58, 62, 71)"]);
    await detail.context.close();
  });

  it("draws the Publishing board's Publish disabled, and the Published board's indigo status and message link", async () => {
    const publishing = await open(detailOf("publishing"), detailAddress);
    await drawn(publishing.page);
    const publish = publishing.page.getByRole("button", { name: "Publish" });
    expect(await publish.isDisabled()).toBe(true);
    expect(await publish.evaluate((button) => getComputedStyle(button).opacity)).toBe("0.55");
    await publishing.context.close();
    const published = await open(detailOf("published"), detailAddress);
    await drawn(published.page);
    expect(await published.page.locator(".run-head-status").evaluate((word) => getComputedStyle(word).color)).toBe("rgb(154, 161, 245)");
    expect(await published.page.locator(".callout-published").evaluate((callout) => [getComputedStyle(callout).backgroundColor, getComputedStyle(callout).borderTopColor])).toEqual(["rgb(16, 18, 40)", "rgb(47, 52, 112)"]);
    expect(await published.page.getByRole("link", { name: "Slack message" }).getAttribute("href")).toBe(MESSAGE);
    await published.context.close();
  });

  it("shows the publisher's reason in the banner of a failed publish run", async () => {
    const failed = await open(detailOf("failed"), detailAddress);
    await drawn(failed.page);
    const alert = failed.page.getByRole("alert");
    expect(await alert.textContent()).toContain(`Not published.Publishing 1 run failed: ${PUBLISHER_REASON}`);
    await failed.context.close();
  });
});
