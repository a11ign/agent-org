import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Browser, BrowserContext, Page } from "playwright-core";
import type { QueueView } from "../../src/api/types.ts";
import { ticketsBoardStand, type Stand } from "../fixtures.ts";
import { serveInstance } from "../instance-routes.ts";
import { runsStand } from "../runs/runs-stand.ts";
import { overflowProblem, SCREENS } from "../screenshots.ts";
import { launchBrowser, startSite, UI_ROOT, type Site } from "../site.ts";

// The update in progress, in Chromium over the built site: the four Updating screens on the page that was open, and the drain banner on Tickets and Runs, at 1440px and at 390px. The instance is a
// stand-in that goes down and comes back on a new version; the page's clock is Playwright's, so the minute that makes it Slow passes at once. Each state writes its capture beside the others.
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

const CAPTURES = join(UI_ROOT, "captures", "updating");
const NOTE = { target: "v0.280.0", deadline: new Date(2026, 9, 24, 14, 30).getTime(), finishing: 3, forced: false, stopped: 0 };
const NORMAL = { version: "v0.273.0", note: null, next: "v0.280.0" };
const BREAKING = { version: "v0.273.0", note: NOTE, next: null };
const BACK = { version: "v0.280.0", note: null, next: null };

/** The instance the page is left open on: the Tickets board's, whose queue says `update` and whose service answers 503 while `down` is set. */
function instance(update: object) {
  const link = { down: false, update };
  const base = ticketsBoardStand();
  const answers = base.instances!.personal;
  const live = { ...answers };
  Object.defineProperty(live, "queue", { enumerable: true, get: () => ({ ...answers.queue, update: link.update }) });
  Object.defineProperty(live, "queueFails", { enumerable: true, get: () => (link.down ? { status: 503, error: "service unavailable" } : undefined) });
  return { link, stand: { ...base, instances: { personal: live } } satisfies Stand };
}

type Opened = Readonly<{ page: Page; context: BrowserContext; link: ReturnType<typeof instance>["link"] }>;

/** The Tickets page open on `update`, at `width`, with the clock the test drives, once its sidebar has the instance's counts. */
async function openOn(update: object, width: number, path = "/next/tickets"): Promise<Opened> {
  const { link, stand } = instance(update);
  const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 900 } });
  await serveInstance(context, { stand });
  const page = await context.newPage();
  await page.clock.install({ time: new Date(2026, 9, 24, 14, 0) });
  await page.goto(`${site.origin}${path}`);
  await page.locator(".nav-count").filter({ hasText: "37" }).waitFor();
  return { page, context, link };
}

/** Lets the page's polls run for `ms` of its clock, a second at a time, so each read settles before the next timer. */
async function runFor(page: Page, ms: number): Promise<void> {
  for (let elapsed = 0; elapsed < ms; elapsed += 1000) {
    await page.clock.runFor(1000);
    await page.waitForTimeout(20);
  }
}

const title = (page: Page) => page.getByRole("heading", { level: 1 });
const fits = (page: Page) => page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth }));

/** The service goes down and the page finds it. */
async function goDown({ page, link }: Opened): Promise<void> {
  link.down = true;
  await runFor(page, 5000);
  await page.locator(".updating-card").waitFor();
}

/** The service answers again on the new version, and the page shows Back. */
async function comeBack({ page, link }: Opened): Promise<void> {
  link.down = false;
  link.update = BACK;
  await runFor(page, 6000);
  await title(page).filter({ hasText: "Updated to v0.280" }).waitFor();
}

type Stage = Readonly<{ name: string; update: object; drive: (opened: Opened) => Promise<void>; heading: string }>;
const STAGES: readonly Stage[] = [
  { name: "updating", update: NORMAL, heading: "Updating Atomaut", drive: goDown },
  { name: "updating-breaking", update: BREAKING, heading: "Updating Atomaut", drive: goDown },
  {
    name: "updating-slow", update: NORMAL, heading: "Still updating",
    drive: async (opened) => {
      await goDown(opened);
      await opened.page.clock.fastForward(61_000);
      await title(opened.page).filter({ hasText: "Still updating" }).waitFor();
    },
  },
  {
    name: "updating-back", update: NORMAL, heading: "Updated to v0.280",
    drive: async (opened) => {
      await goDown(opened);
      await comeBack(opened);
    },
  },
];

describe("the four Updating screens, in Chromium", () => {
  it.each(STAGES)("$name fits at 1440px and at 390px, with the card the board draws", async ({ name, update, drive, heading }) => {
    mkdirSync(CAPTURES, { recursive: true });
    for (const screen of SCREENS) {
      const opened = await openOn(update, screen.width);
      try {
        await drive(opened);
        expect(await title(opened.page).textContent()).toBe(heading);
        const card = await opened.page.locator(".updating-card").boundingBox();
        expect(card?.width).toBe(Math.min(520, screen.width - 48));
        expect(overflowProblem({ route: `/next/tickets (${name})`, width: screen.width, ...(await fits(opened.page)) })).toBeNull();
        await opened.page.evaluate(() => document.fonts.ready.then(() => undefined));
        writeFileSync(join(CAPTURES, `${name}-${screen.width}x${screen.height}.png`), await opened.page.screenshot({ fullPage: true }));
      } finally {
        await opened.context.close();
      }
    }
  });

  it("keeps the sidebar as it was, with the pill amber while updating and green when back", async () => {
    const opened = await openOn(NORMAL, 1440);
    expect(await opened.page.locator(".pill").textContent()).toBe("Connected");
    await goDown(opened);
    expect(await opened.page.locator(".pill").textContent()).toBe("Updating");
    expect(await opened.page.locator(".pill").evaluate((pill) => getComputedStyle(pill).color)).toBe("rgb(227, 179, 65)");
    expect(await opened.page.locator(".nav-count").first().textContent()).toBe("37");
    await comeBack(opened);
    expect(await opened.page.locator(".pill").textContent()).toBe("Connected");
    expect(await opened.page.getByRole("link", { name: "Back to Tickets" }).getAttribute("href")).toBe("/next/tickets");
    await opened.context.close();
  });

  it("reloads the page onto the new version five seconds after Back", async () => {
    const opened = await openOn(NORMAL, 1440);
    await goDown(opened);
    await comeBack(opened);
    const loads = opened.page.waitForEvent("load");
    await opened.page.clock.runFor(5000);
    await loads;
    await opened.page.locator(".nav-count").filter({ hasText: "37" }).waitFor();
    expect(await opened.page.locator(".updating-card").count()).toBe(0);
    await opened.context.close();
  });
});

describe("the drain banner, in Chromium", () => {
  const PAGES = [
    { name: "tickets-draining", path: "/next/tickets", ready: (page: Page) => page.getByRole("heading", { level: 1, name: "Tickets" }).waitFor() },
    { name: "runs-draining", path: "/next/runs", ready: (page: Page) => page.locator(".run-row").first().waitFor() },
  ] as const;

  /** The page `path` over a stand whose queue carries the drain note. */
  async function drainingOn(path: string, width: number): Promise<{ page: Page; context: BrowserContext }> {
    const stand = path === "/next/runs" ? runsStand() : ticketsBoardStand();
    const connection = Object.keys(stand.instances!)[0];
    const answers = stand.instances![connection];
    const queue = { ...answers.queue, update: BREAKING } as unknown as QueueView;
    const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 900 } });
    await serveInstance(context, { stand: { ...stand, instances: { [connection]: { ...answers, queue } } } });
    const page = await context.newPage();
    await page.goto(`${site.origin}${path}`);
    return { page, context };
  }

  it.each(PAGES)("$name fits at 1440px and at 390px, with the amber banner above the header", async ({ name, path, ready }) => {
    mkdirSync(CAPTURES, { recursive: true });
    for (const screen of SCREENS) {
      const { page, context } = await drainingOn(path, screen.width);
      try {
        await ready(page);
        const banner = page.locator(".drain-banner");
        expect(await banner.textContent()).toBe("Updating to v0.280 (breaking): no new runs start; 3 runs finishing; forced at 14:30");
        expect(await banner.evaluate((element) => { const style = getComputedStyle(element); return [style.backgroundColor, style.borderTopColor, style.color, style.borderTopLeftRadius]; })).toEqual(["rgb(26, 22, 8)", "rgb(90, 74, 26)", "rgb(240, 217, 138)", "8px"]);
        expect(await page.locator(".drain-banner-dot").evaluate((dot) => getComputedStyle(dot).backgroundColor)).toBe("rgb(227, 179, 65)");
        const [bannerBox, headingBox] = await Promise.all([banner.boundingBox(), page.getByRole("heading", { level: 1 }).boundingBox()]);
        expect(bannerBox!.y).toBeLessThan(headingBox!.y);
        expect(overflowProblem({ route: `${path} (${name})`, width: screen.width, ...(await fits(page)) })).toBeNull();
        await page.evaluate(() => document.fonts.ready.then(() => undefined));
        writeFileSync(join(CAPTURES, `${name}-${screen.width}x${screen.height}.png`), await page.screenshot({ fullPage: true }));
      } finally {
        await context.close();
      }
    }
  });
});
