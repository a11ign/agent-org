// module: the screenshot helper -- a route at 1440px and at 390px wide, a full-page PNG at each, and a failure when the page is wider than the screen
//
// IT REUSES A11-151's `ticket:capture` WHERE THAT FITS: `captureName` names each file `<route>-<W>x<H>.png`, and `pngSize` reads each PNG's width from its header
// to hold it to the width asked (both are pure, and `capture.ts` imports nothing). It does not reuse `ticket:capture` itself: that starts an instance and
// a paired `ui.html` board and waits on that page's own selectors, which a static build has none of.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Browser, BrowserContext } from "playwright-core";
import { captureName, pngSize, type Size } from "../../src/ticket-mode/capture.ts";
import { UI_ROOT } from "./site.ts";

/** The two screens a page is shown at: a desktop's and a phone's. Only the widths are fixed; the full-page capture shows the whole page at either height. */
export const SCREENS: readonly Size[] = [{ width: 1440, height: 900 }, { width: 390, height: 844 }];

/** Where the PNGs are written, which git ignores. */
export const SCREENSHOT_DIR = join(UI_ROOT, "screenshots");

/** What a page measured at a width: the document's `scrollWidth` and the viewport's `clientWidth`. */
export type Fit = Readonly<{ route: string; width: number; scrollWidth: number; clientWidth: number }>;

/** The failure for a document wider than the viewport, naming the route, the width, `scrollWidth` and `clientWidth`, or null when it fits. PURE. */
export function overflowProblem({ route, width, scrollWidth, clientWidth }: Fit): string | null {
  if (scrollWidth <= clientWidth) return null;
  return `${route} overflows horizontally at ${width}px: scrollWidth ${scrollWidth} is wider than clientWidth ${clientWidth}`;
}


/** A route of the site at an address: `url` is what is opened, `route` is how it is named in a file and in a failure. */
export type Page = Readonly<{ route: string; url: string }>;

/** Set up before the page is opened: the requests a page makes are answered here, for a page that reads an instance. */
export type Prepare = (context: BrowserContext) => Promise<void>;

/** Opens `page` at `screen`, and measures it and takes a full-page PNG once the network is idle. `prepare` runs on the new context first. */
export async function look(browser: Browser, { route, url }: Page, screen: Size, prepare?: Prepare): Promise<{ fit: Fit; png: Buffer }> {
  const context = await browser.newContext({ viewport: screen, deviceScaleFactor: 1 });
  try {
    await prepare?.(context);
    const page = await context.newPage();
    await page.goto(url);
    await page.waitForLoadState("networkidle");
    const { scrollWidth, clientWidth } = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth }));
    return { fit: { route, width: screen.width, scrollWidth, clientWidth }, png: await page.screenshot({ fullPage: true }) };
  } finally {
    await context.close();
  }
}

/** Captures `route` of the site at `origin` at each screen, writes `<route>-<W>x<H>.png` into `outDir`, and REFUSES a page wider than a screen or a PNG not as wide as asked. @returns the files written. */
export async function captureScreens(browser: Browser, { origin, route, prepare }: Readonly<{ origin: string; route: string; prepare?: Prepare }>, outDir: string = SCREENSHOT_DIR): Promise<string[]> {
  mkdirSync(outDir, { recursive: true });
  const written: string[] = [];
  for (const screen of SCREENS) {
    const { fit, png } = await look(browser, { route, url: `${origin}${route}` }, screen, prepare);
    const problem = overflowProblem(fit);
    if (problem !== null) throw new Error(problem);
    const made = pngSize(png);
    if (made?.width !== screen.width) throw new Error(`${route} at ${screen.width}px was captured ${made?.width ?? "as no PNG"} wide`);
    const path = join(outDir, captureName(route, screen));
    writeFileSync(path, png);
    written.push(path);
  }
  return written;
}
