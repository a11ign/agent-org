import { readdirSync, readFileSync } from "node:fs";
import type { Browser } from "playwright-core";
import { pngSize } from "../../src/ticket-mode/capture.ts";
import { captureScreens, SCREENSHOT_DIR } from "./screenshots.ts";
import { launchBrowser, startSite, type Site } from "./site.ts";

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

describe("the placeholder page, built", () => {
  it("hydrates its React island: a press changes the count", async () => {
    const page = await browser.newPage();
    await page.goto(`${site.origin}/next/`);
    const button = page.getByRole("button");
    await button.waitFor();
    await button.click();
    expect(await button.textContent()).toBe("Pressed 1 time");
    await page.close();
  });

  it("makes every request to its own origin, and loads both self-hosted fonts", async () => {
    const page = await browser.newPage();
    const requested: string[] = [];
    page.on("request", (request) => requested.push(request.url()));
    await page.goto(`${site.origin}/next/`);
    await page.waitForLoadState("networkidle");
    const loaded = await page.evaluate(async () => ({
      inter: (await document.fonts.load('1em "Inter Variable"')).length,
      mono: (await document.fonts.load('1em "JetBrains Mono Variable"')).length,
    }));
    expect(loaded.inter).toBeGreaterThan(0);
    expect(loaded.mono).toBeGreaterThan(0);
    expect(requested.filter((url) => !url.startsWith(`${site.origin}/`))).toEqual([]);
    expect(requested.some((url) => /inter-.*\.woff2$/.test(url))).toBe(true);
    expect(requested.some((url) => /jetbrains-mono-.*\.woff2$/.test(url))).toBe(true);
    await page.close();
  });

  it("is captured at 1440px and at 390px, each PNG as wide as asked, with no horizontal overflow", async () => {
    const written = await captureScreens(browser, { origin: site.origin, route: "/next/" });
    expect(written.map((path) => path.slice(SCREENSHOT_DIR.length + 1)).sort()).toEqual(["next-1440x900.png", "next-390x844.png"]);
    expect(written.map((path) => pngSize(readFileSync(path))?.width)).toEqual([1440, 390]);
    expect(readdirSync(SCREENSHOT_DIR)).toEqual(expect.arrayContaining(["next-1440x900.png", "next-390x844.png"]));
  });
});
