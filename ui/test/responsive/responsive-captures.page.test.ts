import type { Browser } from "playwright-core";
import { captureName } from "../../../src/ticket-mode/capture.ts";
import { overflowProblem } from "../screenshots.ts";
import { launchBrowser, startSite, type Site } from "../site.ts";
import { compareWithBaseline } from "./baselines.ts";
import { fitOf, FRAMES, hitProblems } from "./layout.ts";
import { openScreenOf, SCREENS } from "./screens.ts";

// A11-427: every responsive screen at the canvas's three frames, in Chromium over the built site: it fits the screen's width, matches its baseline (ADR 0018), and on a phone takes every tap 20px
// above and below a control's centre.

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

describe("every screen at 390x844, 820x1180 and 1180x820", () => {
  const cases = SCREENS.flatMap((screen) => FRAMES.map((size) => ({ ...screen, size, label: `${screen.name} at ${size.width}x${size.height}` })));

  it.each(cases)("$label fits the screen's width and matches its baseline", async (screen) => {
    const { page, context } = await openScreenOf(browser, site.origin, screen, screen.size);
    try {
      expect(overflowProblem({ route: screen.name, width: screen.size.width, ...(await fitOf(page)) })).toBeNull();
      const png = await page.screenshot({ animations: "disabled", caret: "hide" });
      compareWithBaseline(captureName(`/${screen.name}`, screen.size), png);
    } finally {
      await context.close();
    }
  });

  it.each(SCREENS)("$name takes every tap 20px above and below a control's centre on a phone", async (screen) => {
    const { page, context } = await openScreenOf(browser, site.origin, screen);
    expect(await hitProblems(page, screen.taps)).toEqual([]);
    await context.close();
  });
});
