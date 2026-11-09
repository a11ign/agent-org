// module: what the responsive checks measure in the page (A11-427) -- the hit area of every control, the boxes of the shell, and the opening of a page at one of the canvas's frames
import type { Browser, BrowserContext, Locator, Page } from "playwright-core";
import type { Size } from "../../../src/ticket-mode/capture.ts";
import { serveResponsive, type Options } from "./responsive-stand.ts";

/** The canvas's frames: a phone, a tablet upright and a tablet on its side. */
export const PHONE: Size = { width: 390, height: 844 };
export const TABLET: Size = { width: 820, height: 1180 };
export const LANDSCAPE: Size = { width: 1180, height: 820 };
export const FRAMES: readonly Size[] = [PHONE, TABLET, LANDSCAPE];

/** How far above and below a control's centre a tap must still land on it: half the 44px hit area, less the pixel at its edge. */
export const REACH = 20;

/** The clock the pages are drawn at, so the ages and times a capture shows are the same on every run. */
export const FROZEN_AT = Date.UTC(2026, 10, 9, 9, 0, 0);

/** Runs `make` as if it were `FROZEN_AT`, so a stand's times are counted from the time the page is drawn at. */
export function atFrozenTime<T>(make: () => T): T {
  const real = Date.now;
  Date.now = () => FROZEN_AT;
  try {
    return make();
  } finally {
    Date.now = real;
  }
}

export type Opened = Readonly<{ page: Page; context: BrowserContext }>;
type OpenOptions = Options & Readonly<{ touch?: boolean; ready?: (page: Page) => Promise<unknown> }>;

/**
 * Opens `route` at `size` over the responsive stand, with the clock frozen, motion reduced and a touch screen at tablet and phone widths, once the page has drawn what it read. The Tickets list
 * opens on Backlog, as the boards draw it.
 */
export async function openAt(browser: Browser, origin: string, route: string, size: Size, { touch = size.width <= TABLET.width, ready, ...options }: OpenOptions = {}): Promise<Opened> {
  const context = await browser.newContext({ viewport: size, deviceScaleFactor: 1, hasTouch: touch, isMobile: touch, reducedMotion: "reduce", timezoneId: "UTC", locale: "en-GB" });
  await context.addInitScript(() => localStorage.setItem("ticket-mode.open", '["Backlog"]'));
  await atFrozenTime(() => serveResponsive(context, route, options));
  const page = await context.newPage();
  await page.clock.setFixedTime(FROZEN_AT);
  await page.goto(`${origin}${route}`);
  await (ready?.(page) ?? page.getByRole("heading", { level: 1 }).waitFor());
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  return { page, context };
}

/** The document's `scrollWidth` and the viewport's `clientWidth`. */
export const fitOf = (page: Page) => page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth }));

/** A box the page draws, rounded to the pixel; fails when the element is not drawn. */
export async function boxOf(locator: Locator): Promise<{ x: number; y: number; width: number; height: number }> {
  const box = await locator.boundingBox();
  if (box === null) throw new Error(`${String(locator)} is not drawn`);
  return { x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height) };
}

/** Whether any element `locator` matches is drawn: in the layout and not hidden. False, without waiting, when none is in the page. */
export const drawn = (locator: Locator): Promise<boolean> => locator.evaluateAll((elements) => elements.some((element) => element.checkVisibility() && element.getBoundingClientRect().width > 0));

/** The controls a tap must reach: the tab bar's items, every button, select and input. */
export const CONTROLS = ".tabs a, button, select, input";

/**
 * Every control under `scope` that is drawn, hit-tested `REACH` px above and below its centre once it is scrolled to the middle of the screen: each point must land on the control, inside it, or on
 * its own label. @returns the controls that miss, each named with where its taps landed.
 */
export function hitProblems(page: Page, scope = "body"): Promise<string[]> {
  return page.evaluate(({ scope: root, selector, reach }) => {
    const nameOf = (element: Element) => `${element.tagName.toLowerCase()} "${(element.getAttribute("aria-label") ?? element.textContent ?? "").trim().slice(0, 40)}"`;
    const reaches = (control: Element, hit: Element | null): boolean => {
      if (hit === null) return false;
      if (hit === control || control.contains(hit)) return true;
      const label = hit.closest("label");
      return label !== null && (label.control === control || label.contains(control));
    };
    const controls = [...document.querySelectorAll(`${root} :is(${selector})`)].filter((element) => element.checkVisibility() && element.getBoundingClientRect().width > 0 && (element as HTMLInputElement).type !== "hidden");
    const problems: string[] = [];
    for (const control of controls) {
      control.scrollIntoView({ block: "center", inline: "center" });
      const box = control.getBoundingClientRect();
      const [x, y] = [box.left + box.width / 2, box.top + box.height / 2];
      const [above, below] = [document.elementFromPoint(x, y - reach), document.elementFromPoint(x, y + reach)];
      if (!reaches(control, above) || !reaches(control, below)) problems.push(`${nameOf(control)} (${Math.round(box.height)}px): above ${above === null ? "nothing" : nameOf(above)}, below ${below === null ? "nothing" : nameOf(below)}`);
    }
    window.scrollTo(0, 0);
    return problems;
  }, { scope, selector: CONTROLS, reach: REACH });
}
