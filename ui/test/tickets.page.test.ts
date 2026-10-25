import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Browser, BrowserContext, Page } from "playwright-core";
import { captureName } from "../../src/ticket-mode/capture.ts";
import { HERE, OTHER, queueingConfig, queueOf, ticket, ticketsBoardStand, type Stand } from "./fixtures.ts";
import { serveInstance, type Serving } from "./instance-routes.ts";
import { withWriter } from "./new-ticket/new-ticket-stand.ts";
import { overflowProblem, SCREENS, SCREENSHOT_DIR } from "./screenshots.ts";
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

const TICKETS = "/tickets";
const OPEN_BACKLOG = (context: BrowserContext) => context.addInitScript(() => localStorage.setItem("ticket-mode.open", '["Backlog"]'));

/** The Tickets page in a new context at `width`, its instance calls answered by `serving`, with the Backlog section open as the board draws it. */
async function open(serving: Serving, width = 1440): Promise<{ page: Page; asked: Awaited<ReturnType<typeof serveInstance>>; context: BrowserContext }> {
  const context = await browser.newContext({ viewport: { width, height: 900 } });
  await OPEN_BACKLOG(context);
  const asked = await serveInstance(context, withWriter(serving));
  const page = await context.newPage();
  await page.goto(`${site.origin}${TICKETS}`);
  return { page, asked, context };
}

const small: Stand = {
  connections: [HERE],
  instances: { here: { config: queueingConfig(), tickets: [ticket({ key: "A11-1", title: "First", goals: ["Fleet"] }), ticket({ key: "A11-2", title: "Second" }), ticket({ key: "A11-3", title: "Third", assignee: OTHER })], queue: { ...queueOf(), paused: false } as never } },
};

describe("the states, over a stand-in instance in Chromium", () => {
  it("draws the list: Backlog open with its rows, the count and the footer", async () => {
    const { page, context } = await open({ stand: ticketsBoardStand() });
    await page.getByRole("region", { name: "Backlog" }).waitFor();
    expect(await page.locator(".row").count()).toBe(25);
    expect(await page.locator(".page-count").textContent()).toBe("37 assigned to you");
    expect(await page.locator(".section-foot").textContent()).toBe("Showing 25 of 25 backlog tickets");
    expect(await page.getByRole("region", { name: "Todo" }).locator(".row").count()).toBe(0);
    await context.close();
  });

  it("draws the board's skeleton while the tickets load, with the header already drawn", async () => {
    const { page, context } = await open({ stand: { ...ticketsBoardStand(), holdInstance: true } });
    const skeleton = page.getByRole("status", { name: "Loading tickets" });
    await skeleton.waitFor();
    expect(await skeleton.getAttribute("aria-busy")).toBe("true");
    expect(await skeleton.locator(".skeleton-panel-row").count()).toBe(8);
    expect(await page.getByRole("heading", { level: 1 }).textContent()).toBe("Tickets");
    expect(await page.locator(".page-header .sk").count()).toBe(1);
    await context.close();
  });

  it("draws the empty panel when nothing is assigned to you, and Show anyone's tickets chooses Anyone", async () => {
    const { page, context } = await open({ stand: ticketsBoardStand({ assigned: false }) });
    await page.getByText("Nothing is assigned to you").waitFor();
    expect(await page.locator(".page-count").textContent()).toBe("0 assigned to you");
    await page.getByRole("button", { name: "Show anyone's tickets" }).click();
    await page.getByRole("region", { name: "Backlog" }).waitFor();
    expect(await page.getByRole("group", { name: "Assignee" }).getByRole("button", { name: /^Anyone/ }).getAttribute("aria-pressed")).toBe("true");
    await context.close();
  });

  it("draws the paused banner with its link to Runs", async () => {
    const { page, context } = await open({ stand: ticketsBoardStand({ paused: true }) });
    const banner = page.getByRole("status").filter({ hasText: "Workers are paused. Tickets you queue wait until you start workers." });
    await banner.waitFor();
    expect(await banner.getByRole("link", { name: "Start workers on Runs" }).getAttribute("href")).toBe("/runs");
    await context.close();
  });

  it("draws the error banner with the server's sentence, and Retry reads the tickets again", async () => {
    const failing: Stand = { connections: [HERE], instances: { here: { ...small.instances?.here, ticketsFail: { status: 500, error: "tracker refused" } } } };
    const { page, asked, context } = await open({ stand: failing });
    const alert = page.getByRole("alert");
    await alert.waitFor();
    expect(await alert.textContent()).toContain("tracker refused");
    const reads = asked.filter((path) => path === "/c/here/api/tickets").length;
    await alert.getByRole("button", { name: "Retry" }).click();
    await page.waitForFunction((count) => performance.getEntriesByType("resource").filter((entry) => entry.name.endsWith("/c/here/api/tickets")).length > count, reads);
    await alert.getByRole("button", { name: "Dismiss" }).click();
    expect(await page.getByRole("alert").count()).toBe(0);
    await context.close();
  });

  it("opens the New ticket dialog from the header button", async () => {
    const { page, context } = await open({ stand: small });
    const button = page.getByRole("button", { name: "New ticket" });
    await button.waitFor();
    await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>(".page-header .primary")?.disabled);
    await button.click();
    expect(await page.getByRole("dialog", { name: "New ticket" }).isVisible()).toBe(true);
    await context.close();
  });
});

describe("queueing from the Run options popover, end to end", () => {
  it("posts the keys, model, effort and plan the popover chose, then clears the selection and reads the queue again", async () => {
    const queued = { entries: [{ ticket: { key: "A11-1" }, phase: "queued" }, { ticket: { key: "A11-2" }, phase: "queued" }], paused: false };
    const stand: Stand = { connections: [HERE], instances: { here: { ...small.instances?.here, post: () => queued } } };
    const { page, asked, context } = await open({ stand });
    await page.getByLabel("Select A11-1").check();
    await page.getByLabel("Select A11-2").check();
    const bar = page.getByRole("region", { name: "Queue selected tickets" });
    expect(await bar.textContent()).toContain("2 selected");
    await bar.getByRole("button", { name: "Run options" }).click();
    const dialog = page.getByRole("dialog", { name: "Run options" });
    await dialog.getByLabel("Model").selectOption("opus");
    await dialog.getByLabel("Effort").selectOption("low");
    expect(await bar.getByText(/^Custom/).textContent()).toBe("Custom · Plan first · opus/low");
    const reads = asked.filter((path) => path === "/c/here/api/queue").length;
    await bar.getByRole("button", { name: "Queue 2 tickets" }).click();
    await page.getByRole("region", { name: "Queue selected tickets" }).waitFor({ state: "detached" });
    expect(asked.requests.filter(({ method, path }) => method === "POST" && path === "/c/here/api/queue").map(({ body }) => body)).toEqual([{ keys: ["A11-1", "A11-2"], model: "opus", effort: "low", plan: true }]);
    expect(asked.filter((path) => path === "/c/here/api/queue").length).toBeGreaterThan(reads);
    await context.close();
  });

  it("opens the popover above the cog and closes it on Escape, with the focus back on the cog", async () => {
    const { page, context } = await open({ stand: small });
    await page.getByLabel("Select A11-1").check();
    const cog = page.getByRole("button", { name: "Run options" });
    await cog.click();
    const dialog = page.getByRole("dialog", { name: "Run options" });
    const [box, cogBox] = [await dialog.boundingBox(), await cog.boundingBox()];
    expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThanOrEqual(cogBox?.y ?? 0);
    await page.keyboard.press("Escape");
    expect(await dialog.count()).toBe(0);
    expect(await cog.evaluate((element) => element === document.activeElement)).toBe(true);
    await context.close();
  });
});

describe("no horizontal overflow, and the captures of the four boards", () => {
  /** What each board draws: the Tickets board with two rows ticked as the board has them, loading, nothing assigned, and workers paused. */
  type State = Readonly<{ name: string; serving: Serving; ready: (page: Page) => Promise<void>; ticked?: readonly string[] }>;
  const STATES: readonly State[] = [
    { name: "ready", serving: { stand: ticketsBoardStand() }, ready: (page) => page.locator(".row").first().waitFor(), ticked: ["A11-65", "A11-32"] },
    { name: "loading", serving: { stand: { ...ticketsBoardStand(), holdInstance: true } }, ready: (page) => page.getByRole("status", { name: "Loading tickets" }).waitFor() },
    { name: "empty", serving: { stand: ticketsBoardStand({ assigned: false }) }, ready: (page) => page.getByText("Nothing is assigned to you").waitFor() },
    { name: "paused", serving: { stand: ticketsBoardStand({ paused: true }) }, ready: (page) => page.getByText("Workers are paused.").waitFor() },
  ];

  /** The page in `state` at `screen`: measured for overflow, and written as `tickets-<state>-<W>x<H>.png` beside the other screenshots. */
  async function captured({ name, serving, ready, ticked = [] }: State, screen: (typeof SCREENS)[number]): Promise<void> {
    const context = await browser.newContext({ viewport: screen, deviceScaleFactor: 1 });
    try {
      await OPEN_BACKLOG(context);
      await serveInstance(context, withWriter(serving));
      const page = await context.newPage();
      await page.goto(`${site.origin}${TICKETS}`);
      await ready(page);
      for (const key of ticked) await page.getByLabel(`Select ${key}`).check();
      await page.evaluate(() => document.fonts.ready.then(() => undefined));
      const { scrollWidth, clientWidth } = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth }));
      expect(overflowProblem({ route: `${TICKETS}-${name}`, width: screen.width, scrollWidth, clientWidth })).toBeNull();
      mkdirSync(SCREENSHOT_DIR, { recursive: true });
      writeFileSync(join(SCREENSHOT_DIR, captureName(`${TICKETS}-${name}`, screen)), await page.screenshot({ fullPage: true }));
    } finally {
      await context.close();
    }
  }

  it.each(STATES)("$name fits at 1440px and at 390px", async (state) => {
    for (const screen of SCREENS) await captured(state, screen);
  });

  it.each(SCREENS)("fits with the popover and a filter menu open at $width px", async (screen) => {
    const { page, context } = await open({ stand: ticketsBoardStand() }, screen.width);
    await page.getByLabel("Select A11-65").check();
    await page.getByLabel("Select A11-32").check();
    await page.getByRole("button", { name: "Priority" }).click();
    const menu = await page.getByRole("group", { name: "Priority" }).boundingBox();
    expect((menu?.x ?? -1)).toBeGreaterThanOrEqual(0);
    expect((menu?.x ?? 0) + (menu?.width ?? 0)).toBeLessThanOrEqual(screen.width);
    await page.getByRole("button", { name: "Run options" }).click();
    const { scrollWidth, clientWidth } = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth }));
    expect(overflowProblem({ route: TICKETS, width: screen.width, scrollWidth, clientWidth })).toBeNull();
    const dialog = await page.getByRole("dialog", { name: "Run options" }).boundingBox();
    expect(dialog?.x ?? -1).toBeGreaterThanOrEqual(0);
    expect((dialog?.x ?? 0) + (dialog?.width ?? 0)).toBeLessThanOrEqual(screen.width);
    await context.close();
  });
});
