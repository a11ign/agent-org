import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Browser, BrowserContext, Page } from "playwright-core";
import { serveInstance } from "../instance-routes.ts";
import { overflowProblem, SCREENS } from "../screenshots.ts";
import { launchBrowser, startSite, UI_ROOT, type Site } from "../site.ts";
import { modelsConfig, routeSettings, standOf as settingsOf } from "../settings/settings-stand.ts";
import { detailOn, LONG_LINE, machineStand, machineView, PROPOSING_KEY, proposing, QUEUED_KEY, queuedChanged, runsNoticesStand, ticketsStand } from "./parity-stand.ts";

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

// The features `ui.html` has that the boards do not draw (A11-220), over stand-in instances in Chromium: each captured at 1440px and at 390px, with no horizontal overflow.

/** Where the screenshots go: this ticket's own folder. */
const CAPTURES = join(UI_ROOT, "captures", "parity");

type Open = Readonly<{ page: Page; context: BrowserContext }>;
type Scene = Readonly<{ name: string; path: string; stand: () => Parameters<typeof serveInstance>[1]; settings?: boolean; ready: (page: Page) => Promise<void>; drive?: (page: Page) => Promise<void> }>;

const widthOf = (page: Page) => page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth }));

/** The `path` of the site in a new context at `width`, its instance calls answered by the scene's stand. */
async function open(scene: Scene, width: number): Promise<Open> {
  const context = await browser.newContext({ viewport: { width, height: 900 } });
  await context.addInitScript(() => localStorage.setItem("ticket-mode.open", JSON.stringify(["Backlog"])));
  await serveInstance(context, scene.stand());
  if (scene.settings === true) await routeSettings(context, settingsOf({ view: machineView }));
  const page = await context.newPage();
  await page.goto(`${site.origin}${scene.path}`);
  await scene.ready(page);
  await scene.drive?.(page);
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  return { page, context };
}

const openAll = (page: Page) => page.evaluate(() => document.querySelectorAll("details").forEach((node) => { node.open = true; }));

const SCENES: readonly Scene[] = [
  {
    name: "runs-notices-and-lists", path: "/next/runs", stand: () => ({ stand: runsNoticesStand() }),
    ready: (page) => page.getByRole("region", { name: "After-merge checks" }).waitFor(),
  },
  {
    name: "run-detail-queued-open", path: `/next/runs/${QUEUED_KEY}`, stand: () => ({ stand: detailOn(queuedChanged) }),
    ready: (page) => page.getByRole("region", { name: "More about this run" }).waitFor(), drive: openAll,
  },
  {
    name: "run-detail-proposal-open", path: `/next/runs/${PROPOSING_KEY}`, stand: () => ({ stand: detailOn(proposing) }),
    ready: (page) => page.getByRole("region", { name: "More about this run" }).waitFor(), drive: openAll,
  },
  {
    name: "tickets-held-and-labels", path: "/next/tickets", stand: () => ({ stand: ticketsStand() }),
    ready: (page) => page.locator("[data-key=A11-301]").waitFor(),
  },
  {
    name: "settings-machine-restore", path: "/next/settings/machine", stand: () => ({ stand: { ...machineStand(), instances: { here: { ...machineStand().instances?.here, config: modelsConfig() } } } }), settings: true,
    ready: (page) => page.getByRole("button", { name: "Restore the backup of host.json" }).waitFor(), drive: openAll,
  },
];

describe("the restored features, captured", () => {
  it.each(SCENES)("$name fits at 1440px and at 390px", async (scene) => {
    for (const screen of SCREENS) {
      const { page, context } = await open(scene, screen.width);
      try {
        await page.setViewportSize(screen);
        expect(overflowProblem({ route: `${scene.path} (${scene.name})`, width: screen.width, ...(await widthOf(page)) })).toBeNull();
        mkdirSync(CAPTURES, { recursive: true });
        writeFileSync(join(CAPTURES, `${scene.name}-${screen.width}x${screen.height}.png`), await page.screenshot({ fullPage: true }));
      } finally {
        await context.close();
      }
    }
  });

  it("draws the Runs notices above the pool bar and the lists below the runs", async () => {
    const { page, context } = await open(SCENES[0], 1440);
    const order = await page.evaluate(() => {
      const top = (selector: string) => (document.querySelector(selector) as HTMLElement).getBoundingClientRect().top;
      return [top(".status-banner"), top(".pool-bar"), top(".runs-list"), top("[aria-label='Pull requests']"), top("[aria-label='After-merge checks']")];
    });
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(await page.locator(".status-banner").count()).toBe(3);
    await context.close();
  });

  it("keeps a long unbroken diff line inside its disclosure at 390px", async () => {
    const { page, context } = await open(SCENES[1], 390);
    const body = page.locator(".disclosure-diff");
    expect(await body.textContent()).toContain(LONG_LINE);
    const box = await body.boundingBox();
    expect(box === null ? 0 : box.x + box.width).toBeLessThanOrEqual(390);
    await context.close();
  });

  it("wraps the label tags of a row inside it at 390px, and draws the Goal label once", async () => {
    const { page, context } = await open(SCENES[3], 390);
    expect(await page.locator("[data-key=A11-301] .label-tag").allTextContents()).toEqual(["Windows", "Bug", "x".repeat(60)]);
    const right = await page.locator("[data-key=A11-301] .label-tag").last().evaluate((element) => element.getBoundingClientRect().right);
    expect(right).toBeLessThanOrEqual(390);
    await context.close();
  });
});
