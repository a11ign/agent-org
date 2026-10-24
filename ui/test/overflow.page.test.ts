import type { Browser } from "playwright-core";
import { look, overflowProblem, SCREENS } from "./screenshots.ts";
import { launchBrowser } from "./site.ts";

let browser: Browser;
beforeAll(async () => { browser = await launchBrowser(); });
afterAll(async () => { await browser?.close(); });

const PHONE = SCREENS[1];

/** A document served as data, so no site is needed: `width` pixels wide, whatever the screen. */
const pageWide = (width: number) => `data:text/html,<body style="margin:0"><div style="width:${width}px;height:20px">x</div></body>`;

describe("the screenshot helper's overflow check, on a fixture page", () => {
  it("fails a page 500px wide at 390px, naming both widths", async () => {
    const { fit } = await look(browser, "/fixture", pageWide(500), PHONE);
    expect(fit).toEqual({ route: "/fixture", width: 390, scrollWidth: 500, clientWidth: 390 });
    expect(overflowProblem(fit)).toBe("/fixture overflows horizontally at 390px: scrollWidth 500 is wider than clientWidth 390");
  });

  it("passes a page that fits", async () => {
    const { fit } = await look(browser, "/fixture", pageWide(300), PHONE);
    expect(overflowProblem(fit)).toBeNull();
  });
});
