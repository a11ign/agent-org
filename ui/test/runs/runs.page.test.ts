import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Browser, BrowserContext, Page } from "playwright-core";
import { PERSONAL, type Stand } from "../fixtures.ts";
import { serveInstance, type Serving } from "../instance-routes.ts";
import { overflowProblem, SCREENS } from "../screenshots.ts";
import { launchBrowser, startSite, UI_ROOT, type Site } from "../site.ts";
import { boardRuns, queueWith, runsStand } from "./runs-stand.ts";

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

/** Where the screenshots go: this page's own folder. */
const CAPTURES = join(UI_ROOT, "captures", "runs");
const RUNS = "/runs";

/** The Runs page in a new context at `width`, its instance calls answered by `serving`. */
async function open(serving: Serving, width = 1440): Promise<{ page: Page; asked: Awaited<ReturnType<typeof serveInstance>>; context: BrowserContext }> {
  const context = await browser.newContext({ viewport: { width, height: 900 } });
  const asked = await serveInstance(context, serving);
  const page = await context.newPage();
  await page.goto(`${site.origin}${RUNS}`);
  return { page, asked, context };
}

const widthOf = (page: Page) => page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth }));

describe("the list, over a stand-in instance in Chromium", () => {
  it("draws the board's groups, the first 50 runs, the count line and the footer", async () => {
    const { page, context } = await open({ stand: runsStand() });
    await page.locator(".run-row").first().waitFor();
    expect(await page.locator(".run-row").count()).toBe(50);
    expect(await page.locator(".page-count").textContent()).toBe("90 total · 3 running");
    expect(await page.locator(".runs-head").allTextContents()).toEqual(["Running now3", "Ready to merge1", "Checked1", "Completed85"]);
    expect(await page.locator(".runs-footer span").textContent()).toBe("Showing the latest 50 of 90 runs");
    expect(await page.locator(".pool-busy").textContent()).toBe("3 of 10 busy");
    expect(await page.locator(".slot-planning").count()).toBe(1);
    expect(await page.locator(".slot-working").count()).toBe(2);
    expect(await page.locator(".slot").count()).toBe(10);
    await context.close();
  });

  it("draws the rail with every status, and chooses a status from it", async () => {
    const { page, context } = await open({ stand: runsStand() });
    const rail = page.getByRole("navigation", { name: "Run status" });
    await rail.waitFor();
    expect(await rail.getByRole("button").count()).toBe(17);
    await rail.getByRole("button", { name: /^Ready to merge/ }).click();
    expect(await page.locator(".run-row").count()).toBe(1);
    expect(await page.locator(".runs-footer").count()).toBe(0);
    expect(await rail.getByRole("button", { name: /^Ready to merge/ }).getAttribute("aria-pressed")).toBe("true");
    await rail.getByRole("button", { name: /^Failed/ }).click();
    expect(await page.getByText("No runs in this status right now.").count()).toBe(1);
    await context.close();
  });

  it("draws 50 more runs for Load more, and then no footer", async () => {
    const { page, context } = await open({ stand: runsStand() });
    await page.locator(".run-row").first().waitFor();
    await page.getByRole("button", { name: "Load more" }).click();
    expect(await page.locator(".run-row").count()).toBe(90);
    expect(await page.locator(".runs-footer").count()).toBe(0);
    await context.close();
  });

  it("posts a row's action to the queue and reads it again", async () => {
    const stand = runsStand({ post: () => queueWith(boardRuns().slice(0, 4)) });
    const { page, asked, context } = await open({ stand });
    await page.locator("#run-A11-179").getByRole("button", { name: "Dismiss from list" }).click();
    await page.waitForFunction(() => performance.getEntriesByType("resource").some((entry) => entry.name.endsWith("/api/queue/A11-179/dismiss")));
    expect(asked.requests.filter(({ method }) => method === "POST").map(({ path }) => path)).toEqual(["/c/personal/api/queue/A11-179/dismiss"]);
    await context.close();
  });

  it("styles the pool bar's button and Load more as the board does, over the shared ghost button", async () => {
    const { page, context } = await open({ stand: runsStand() });
    await page.locator(".run-row").first().waitFor();
    expect(await page.locator(".pool-bar .ghost").evaluate((element) => getComputedStyle(element).borderTopColor)).toBe("rgb(58, 62, 71)");
    expect(await page.getByRole("button", { name: "Load more" }).evaluate((element) => getComputedStyle(element).padding)).toBe("3px 12px");
    await context.close();
  });

  it("opens a run at its address in Run detail", async () => {
    const { page, context } = await open({ stand: runsStand() });
    expect(await page.locator("#run-A11-184 .run-title").getAttribute("href")).toBe("/runs/A11-184");
    await context.close();
  });
});

describe("no horizontal overflow, and the captures of the four boards", () => {
  /** What each board draws, and what it waits for: the list, the board's skeleton, nothing queued yet, workers paused, and a refused action over the list. */
  type State = Readonly<{ name: string; serving: () => Serving; ready: (page: Page) => Promise<void>; drive?: (page: Page) => Promise<void> }>;
  const refusing = (): Stand => runsStand({ post: () => ({ status: 409, error: "A11-179 is not a run the board can dismiss right now" }) });
  const STATES: readonly State[] = [
    { name: "ready", serving: () => ({ stand: runsStand() }), ready: (page) => page.locator(".run-row").first().waitFor() },
    { name: "loading", serving: () => ({ stand: { ...runsStand(), holdInstance: true } }), ready: (page) => page.getByRole("status", { name: "Loading runs" }).waitFor() },
    { name: "empty", serving: () => ({ stand: runsStand({ runs: [] }) }), ready: (page) => page.getByText("No runs yet").waitFor() },
    { name: "paused", serving: () => ({ stand: runsStand({ paused: true }) }), ready: (page) => page.getByText("Workers paused").waitFor() },
    {
      name: "error", serving: () => ({ stand: refusing() }), ready: (page) => page.locator(".run-row").first().waitFor(),
      drive: async (page) => {
        await page.locator("#run-A11-179").getByRole("button", { name: "Dismiss from list" }).click();
        await page.getByRole("alert").waitFor();
      },
    },
  ];

  /** The page in `state` at `screen`: measured for overflow, and written as `runs-<state>-<W>x<H>.png`. */
  async function captured({ name, serving, ready, drive }: State, screen: (typeof SCREENS)[number]): Promise<void> {
    const { page, context } = await open(serving(), screen.width);
    try {
      await page.setViewportSize(screen);
      await ready(page);
      await drive?.(page);
      await page.evaluate(() => document.fonts.ready.then(() => undefined));
      expect(overflowProblem({ route: `${RUNS}-${name}`, width: screen.width, ...(await widthOf(page)) })).toBeNull();
      mkdirSync(CAPTURES, { recursive: true });
      writeFileSync(join(CAPTURES, `runs-${name}-${screen.width}x${screen.height}.png`), await page.screenshot({ fullPage: true }));
    } finally {
      await context.close();
    }
  }

  it.each(STATES)("$name fits at 1440px and at 390px", async (state) => {
    for (const screen of SCREENS) await captured(state, screen);
  });

  it("fits at 390px with a long unbroken title and a long note", async () => {
    const long = { ...boardRuns()[2], title: `${"x".repeat(120)} and a title that goes on and on`, working: { reason: "background work ".repeat(30), stalled: true } };
    const stand = runsStand({ runs: [long as never] });
    const { page, context } = await open({ stand: { ...stand, connections: [PERSONAL] } }, 390);
    await page.locator(".run-row").first().waitFor();
    expect(overflowProblem({ route: RUNS, width: 390, ...(await widthOf(page)) })).toBeNull();
    await context.close();
  });
});
