import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Browser, BrowserContext, Page } from "playwright-core";
import type { LoopReading } from "../../../src/ticket-mode/loop-delay.ts";
import { ticketsBoardStand } from "../fixtures.ts";
import { serveInstance } from "../instance-routes.ts";
import { withWriter } from "../new-ticket/new-ticket-stand.ts";
import { overflowProblem, SCREENS } from "../screenshots.ts";
import { launchBrowser, startSite, UI_ROOT, type Site } from "../site.ts";

// The loop line under the connection pill (A11-282), in Chromium over the built site, on the Tickets board at 1440px and at 390px: a quiet instance, one whose sweeps hold its loop,
// and one from before `/api/health`, which draws no line. The instance is the Tickets board's stand-in; its `/api/health` and the page service's own are answered here, beside it.
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

const CAPTURES = join(UI_ROOT, "captures", "shell-loop");
const reading = (p50Ms: number, p99Ms: number, maxMs: number): LoopReading => ({ p50Ms, p99Ms, maxMs, windowMs: 60_000, sinceStartMaxMs: maxMs, at: Date.UTC(2026, 9, 25, 17, 0) });
const PAGE = reading(0, 1, 3);

type Loop = Readonly<{ name: string; board: LoopReading | null; text: string | null; warn: boolean; title: string | null }>;
const LOOPS: readonly Loop[] = [
  { name: "normal", board: reading(2, 18, 41), text: "Loop p99 18 ms", warn: false, title: "Board p50 2 ms / p99 18 ms / max 41 ms, Page p50 0 ms / p99 1 ms / max 3 ms" },
  { name: "slow", board: reading(1_004, 1_213, 6_680), text: "Loop p99 1.2 s: background work is holding the board", warn: true, title: "Board p50 1.0 s / p99 1.2 s / max 6.7 s, Page p50 0 ms / p99 1 ms / max 3 ms" },
];

/** The Tickets board at `width`, its instance answering `board` on `/api/health` (or nothing, as one from before it), once its sidebar has the instance's counts. */
async function openOn(board: LoopReading | null, width: number): Promise<Readonly<{ page: Page; context: BrowserContext; healthReads: () => number }>> {
  let healthReads = 0;
  const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 900 } });
  await serveInstance(context, withWriter({ stand: ticketsBoardStand() }));
  // Registered after the stand-in, so it is asked first (Playwright runs the last route that matches).
  await context.route("**/api/health", (route) => {
    healthReads += 1;
    const atRoot = new URL(route.request().url()).pathname === "/api/health";
    if (atRoot) return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ loop: { page: PAGE } }) });
    if (board === null) return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "no route GET /api/health" }) });
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ loop: { board }, blocking: [] }) });
  });
  const page = await context.newPage();
  await page.goto(`${site.origin}/tickets`);
  await page.locator(".nav-count").filter({ hasText: "37" }).waitFor();
  return { page, context, healthReads: () => healthReads };
}

const fits = (page: Page) => page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth }));

describe("the loop line under the connection pill, in Chromium", () => {
  it.each(LOOPS)("$name: the line says the p99, in the pill's own size, and fits at 1440px and at 390px", async ({ name, board, text, warn, title }) => {
    mkdirSync(CAPTURES, { recursive: true });
    for (const screen of SCREENS) {
      const { page, context } = await openOn(board, screen.width);
      try {
        const line = page.locator(".sidebar-head .loop-line");
        await line.waitFor();
        expect(await line.textContent()).toBe(text);
        expect(await line.getAttribute("title")).toBe(title);
        expect(await line.evaluate((element) => element.classList.contains("loop-line-warn"))).toBe(warn);
        const sizes = await page.evaluate(() => [".loop-line", ".pill"].map((selector) => getComputedStyle(document.querySelector(selector)!).fontSize));
        expect(sizes[0]).toBe(sizes[1]);
        expect(overflowProblem({ route: `/tickets (loop ${name})`, width: screen.width, ...(await fits(page)) })).toBeNull();
        await page.evaluate(() => document.fonts.ready.then(() => undefined));
        writeFileSync(join(CAPTURES, `loop-${name}-${screen.width}x${screen.height}.png`), await page.screenshot({ fullPage: true }));
      } finally {
        await context.close();
      }
    }
  });

  it("an instance from before /api/health draws no line, and the pill stands as it did", async () => {
    const { page, context, healthReads } = await openOn(null, 1440);
    try {
      for (let waited = 0; healthReads() < 2 && waited < 5_000; waited += 50) await page.waitForTimeout(50);
      expect(healthReads()).toBe(2);
      await page.waitForTimeout(200);
      expect(await page.locator(".loop-line").count()).toBe(0);
      expect(await page.locator(".pill").textContent()).toBe("Connected");
    } finally {
      await context.close();
    }
  });
});
