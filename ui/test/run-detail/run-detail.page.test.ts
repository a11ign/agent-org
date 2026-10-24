import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Browser, BrowserContext, Page } from "playwright-core";
import { PERSONAL } from "../fixtures.ts";
import { serveInstance, type Serving } from "../instance-routes.ts";
import { overflowProblem, SCREENS } from "../screenshots.ts";
import { launchBrowser, startSite, UI_ROOT, type Site } from "../site.ts";
import { addressOf, detailStand, RUNS_OF, STATES, TERMINAL, type State } from "./run-detail-stand.ts";

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
const CAPTURES = join(UI_ROOT, "captures", "run-detail");

/** Run detail in a new context at `width`, its instance calls answered by `serving`. */
async function open(serving: Serving, address: string, width = 1440): Promise<{ page: Page; context: BrowserContext }> {
  const context = await browser.newContext({ viewport: { width, height: 900 } });
  await serveInstance(context, serving);
  const page = await context.newPage();
  await page.goto(`${site.origin}${address}`);
  return { page, context };
}

const widthOf = (page: Page) => page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth }));

/** The breadcrumb of a run: the page's own, which is not drawn before the island has read the address and its run (until then the shell is the Runs page's list). */
const drawn = (page: Page) => page.getByRole("navigation", { name: "Breadcrumb" }).waitFor();

/** What each board draws first, which the capture waits for. */
const READY: Readonly<Record<State, (page: Page) => Promise<unknown>>> = {
  loading: (page) => page.getByRole("status", { name: "Loading run", exact: true }).waitFor(),
  missing: (page) => page.getByText("This run is no longer on the board").waitFor(),
  running: drawn,
  queued: drawn,
  blocked: drawn,
  needs: drawn,
  handback: drawn,
  awaiting: drawn,
  ready: drawn,
  done: drawn,
  failed: drawn,
  cancelled: drawn,
};

describe("Run detail in Chromium, over a stand-in instance", () => {
  it("opens a run at its address, with the title the board gives it", async () => {
    const { page, context } = await open({ stand: detailStand("running", { terminal: TERMINAL }) }, addressOf("running"));
    await READY.running(page);
    expect(await page.title()).toBe("Atomaut: Run detail");
    expect(await page.locator("h1").textContent()).toBe((RUNS_OF.running.runs[0].ticket as { title: string }).title);
    expect(await page.locator(".step").count()).toBe(5);
    await context.close();
  });

  it("has the header's buttons in the board's colours", async () => {
    const { page, context } = await open({ stand: detailStand("failed") }, addressOf("failed"));
    await READY.failed(page);
    const colours = await page.locator(".run-buttons button").evaluateAll((buttons) => buttons.map((button) => [button.textContent, getComputedStyle(button).color, getComputedStyle(button).borderTopColor]));
    expect(colours).toEqual([["Retry", "rgb(231, 232, 236)", "rgb(58, 62, 71)"], ["Talk to it", "rgb(231, 232, 236)", "rgb(58, 62, 71)"], ["Dismiss", "rgb(180, 183, 192)", "rgb(46, 49, 56)"]]);
    await context.close();
    const running = await open({ stand: detailStand("running", { terminal: TERMINAL }) }, addressOf("running"));
    await READY.running(running.page);
    expect(await running.page.locator(".run-buttons button").evaluate((button) => [getComputedStyle(button).color, getComputedStyle(button).borderTopColor])).toEqual(["rgb(244, 163, 168)", "rgb(90, 43, 47)"]);
    await running.context.close();
  });
});

describe("no horizontal overflow, and the captures of the twelve boards", () => {
  /** The page in `state` at `screen`: measured for overflow, and written as `run-detail-<state>-<W>x<H>.png`. */
  async function captured(state: State, screen: (typeof SCREENS)[number]): Promise<void> {
    const { page, context } = await open({ stand: detailStand(state, { terminal: TERMINAL }) }, addressOf(state), screen.width);
    try {
      await page.setViewportSize(screen);
      await READY[state](page);
      await page.evaluate(() => document.fonts.ready.then(() => undefined));
      expect(overflowProblem({ route: `${addressOf(state)} (${state})`, width: screen.width, ...(await widthOf(page)) })).toBeNull();
      mkdirSync(CAPTURES, { recursive: true });
      writeFileSync(join(CAPTURES, `run-detail-${state}-${screen.width}x${screen.height}.png`), await page.screenshot({ fullPage: true }));
    } finally {
      await context.close();
    }
  }

  it.each(STATES)("%s fits at 1440px and at 390px", async (state) => {
    for (const screen of SCREENS) await captured(state, screen);
  });

  it("fits at 390px with a long unbroken title, callout, step, repository and worker", async () => {
    const long = "x".repeat(140);
    const running = { ...RUNS_OF.running.runs[0], ticket: { key: "A11-183", title: `${long} and a title that goes on`, url: "https://linear.app/a11ign/issue/A11-183" }, repos: [long], working: { reason: `background ${long}`, stalled: true },
      plannedSteps: [{ n: 1, title: long }, { n: 2, title: "two" }], worker: { instance: "agents", host: long } };
    const { page, context } = await open({ stand: { ...detailStand("running", { runs: [running] }), connections: [PERSONAL] } }, addressOf("running"), 390);
    await READY.running(page);
    expect(overflowProblem({ route: addressOf("running"), width: 390, ...(await widthOf(page)) })).toBeNull();
    await context.close();
  });

  it("fits at 390px with a long unbroken pull request name and a long refusal in the banner", async () => {
    const long = "y".repeat(140);
    const done = { ...RUNS_OF.done.runs[0], outcome: { kind: "ready-pr", prs: [{ repo: `a11ign/${long}`, url: `https://github.com/a11ign/${long}/pull/149` }] }, pullStates: {} };
    const stand = detailStand("done", { runs: [done], post: () => ({ status: 409, error: long }) });
    const { page, context } = await open({ stand }, addressOf("done"), 390);
    await READY.done(page);
    await page.getByRole("button", { name: "Dismiss" }).click();
    await page.getByRole("alert").waitFor();
    expect(overflowProblem({ route: addressOf("done"), width: 390, ...(await widthOf(page)) })).toBeNull();
    await context.close();
  });
});
