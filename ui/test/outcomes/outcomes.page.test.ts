import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Browser, BrowserContext } from "playwright-core";
import { outcomesAnswer } from "../../../src/ticket-mode/outcomes/route.ts";
import { captureName } from "../../../src/ticket-mode/capture.ts";
import { boardSizedStand } from "../fixtures.ts";
import { serveInstance } from "../instance-routes.ts";
import { overflowProblem, SCREENS } from "../screenshots.ts";
import { launchBrowser, startSite, UI_ROOT, type Site } from "../site.ts";
import { DAY, NOW, outcomesFiles, type OutcomesFiles } from "./outcomes-stand.ts";

// THE OUTCOMES PAGE IN CHROMIUM (A11-430, step 3 of 3): the built page, its `/api/outcomes` answered by the instance's own route over a scratch log (`outcomes-stand.ts`), every other call by the
// shell's stand-in. It fits a desktop and a phone with no horizontal scroll (a wide table scrolls in its own box), and a figure lists its runs. The PNGs are this pull request's screenshots.

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

const CAPTURES = join(UI_ROOT, "captures", "outcomes");
const WEEK = `/outcomes?from=${NOW - 7 * DAY}&to=${NOW}`;

/** Answers `/api/outcomes` with the real route over `files`; every other instance call as the board-sized stand-in does. Routes added later are matched first. */
async function serveOutcomes(context: BrowserContext, files: OutcomesFiles): Promise<void> {
  await serveInstance(context, { stand: boardSizedStand() });
  await context.route(/\/api\/outcomes(\?|$)/, (route) => {
    const [status, body] = outcomesAnswer({ stateDir: files.stateDir, hostPath: files.hostPath, now: NOW }, new URL(route.request().url()).searchParams);
    return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
  });
}

describe("the Outcomes page at 1440px and at 390px", () => {
  it.each(SCREENS)("draws the week's tables and the runs behind a figure, with no horizontal overflow, at $width px", async (screen) => {
    const context = await browser.newContext({ viewport: screen, deviceScaleFactor: 1 });
    try {
      await serveOutcomes(context, outcomesFiles());
      const page = await context.newPage();
      await page.goto(`${site.origin}${WEEK}`);
      await page.getByRole("heading", { name: "By model and effort" }).waitFor();
      expect(await page.locator(".page-count").first().textContent()).toBe("3 runs");
      await page.getByRole("button", { name: /^opus\/high, Cost:/ }).click();
      await page.getByRole("heading", { name: "Cost, opus/high" }).waitFor();
      expect(await page.locator(".outcomes-run").allTextContents()).toEqual(["A11-1", "A11-2"]);
      const { scrollWidth, clientWidth } = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth }));
      expect(overflowProblem({ route: WEEK, width: screen.width, scrollWidth, clientWidth })).toBeNull();
      mkdirSync(CAPTURES, { recursive: true });
      writeFileSync(join(CAPTURES, captureName("outcomes", screen)), await page.screenshot({ fullPage: true }));
    } finally {
      await context.close();
    }
  });
});
