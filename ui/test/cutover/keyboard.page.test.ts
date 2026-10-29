import type { Browser, BrowserContext, Page } from "playwright-core";
import { boardSizedStand, HERE, ticketsBoardStand, type Stand } from "../fixtures.ts";
import { serveInstance, type Serving } from "../instance-routes.ts";
import { writingStand } from "../new-ticket/new-ticket-stand.ts";
import { withWriter } from "../new-ticket/new-ticket-stand.ts";
import { a11ign, answerOf, BOARD_HOST, pluginsSettings, routePlugins, standOf as pluginsOf } from "../plugins/plugins-stand.ts";
import { selectOf, detailOf, detailAddress, TICKABLE } from "../publish/publish-stand.ts";
import { detailStand, addressOf, TERMINAL } from "../run-detail/run-detail-stand.ts";
import { runsStand } from "../runs/runs-stand.ts";
import { modelsConfig, routeSettings, standOf as settingsOf } from "../settings/settings-stand.ts";
import { launchBrowser, startSite, type Site } from "../site.ts";
import { focusIsIn, tabThrough, unreached } from "./keyboard.ts";

// THE KEYBOARD WALK OF EVERY PAGE (A11-202): Tab from the top of the page, and the focus must reach every control the page draws, each with a visible ring; a dialog keeps the focus inside it and gives it back on Escape.
// The same walk is run on the agents host's live data for the pull request, with the same helpers.
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

/** The host of the Plugins boards: Slack is the publisher, which is a plugin a person can uninstall. */
const BOARD_PLUGINS_HOST = { tickets: { ...BOARD_HOST.tickets, providers: { ...BOARD_HOST.tickets.providers, publish: { provider: "slack", enabled: true } } } };

const OPEN_BACKLOG = (context: BrowserContext) => context.addInitScript(() => localStorage.setItem("ticket-mode.open", '["Backlog"]'));

/** A page of the built site in a fresh context at 1440px, its instance calls answered by `serving`; `routes` adds the stand-ins a page reads beside the instance. */
async function open(path: string, serving: Serving, routes: (context: BrowserContext) => Promise<unknown> = async () => undefined) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await OPEN_BACKLOG(context);
  await serveInstance(context, serving);
  await routes(context);
  const page = await context.newPage();
  await page.goto(`${site.origin}${path}`);
  return { page, context };
}

/** The settings and plugins stand-ins sit on an instance that offers models, a planner and a writer. */
const settingsStand = (): Stand => {
  const sized = boardSizedStand(HERE);
  return { connections: [HERE], instances: { here: { ...sized.instances?.here, config: { ...modelsConfig(), viewer: { id: "u-me", name: "Me" }, pickDefault: "you" } as never } } };
};

/** Walks the page and holds it to the rules: it stops on at least `least` elements, every one rings, and no control the page draws is left out. */
async function walked(page: Page, least: number): Promise<string[]> {
  const stops = await tabThrough(page);
  expect(stops.length).toBeGreaterThanOrEqual(least);
  expect(stops.filter(({ ringed }) => !ringed).map(({ name }) => name)).toEqual([]);
  expect(await unreached(page)).toEqual([]);
  return stops.map(({ name }) => name);
}

/** The dialog named `name` keeps the focus: `presses` Tabs and as many Shift+Tabs never leave it, and Escape closes it with the focus on the control that opened it. */
async function holdsFocus(page: Page, dialogSelector: string, opener: () => Promise<boolean>): Promise<void> {
  for (const key of ["Tab", "Shift+Tab"]) {
    for (let press = 0; press < 30; press += 1) {
      await page.keyboard.press(key);
      expect(await focusIsIn(page, dialogSelector)).toBe(true);
    }
  }
  await page.keyboard.press("Escape");
  expect(await page.locator(dialogSelector).count()).toBe(0);
  expect(await opener()).toBe(true);
}

const isFocused = (page: Page, name: string | RegExp) => () => page.getByRole("button", { name }).evaluate((element) => element === document.activeElement);

describe("Tickets", () => {
  it("is reached by the keyboard from the sidebar to the last row, each control with a ring", async () => {
    const { page, context } = await open("/tickets", withWriter({ stand: ticketsBoardStand() }));
    await page.getByRole("region", { name: "Backlog" }).waitFor();
    const names = await walked(page, 40);
    // The bell is the sidebar's first control, then the instance switcher.
    expect(names[0]).toMatch(/^Notifications, 0/);
    expect(names[1]).toMatch(/^Instance/);
    expect(names).toContain("New ticket");
    await context.close();
  });

  it("reaches the queue bar and the Run options popover, which keeps the focus and gives it back on Escape", async () => {
    const { page, context } = await open("/tickets", withWriter({ stand: ticketsBoardStand() }));
    await page.getByLabel("Select A11-24").waitFor();
    await page.getByLabel("Select A11-65").check();
    const names = await walked(page, 30);
    expect(names).toEqual(expect.arrayContaining(["Run options", "Queue 1 ticket"]));
    await page.getByRole("button", { name: "Run options" }).click();
    const popover = page.getByRole("dialog", { name: "Run options" });
    await popover.waitFor();
    // A non-modal popover (it is not aria-modal): the keyboard goes on into it and out of it, and Escape closes it with the focus on the cog.
    await page.keyboard.press("Tab");
    await page.keyboard.press("Escape");
    expect(await popover.count()).toBe(0);
    expect(await isFocused(page, "Run options")()).toBe(true);
    await context.close();
  });
});

describe("New ticket", () => {
  it("is a dialog that takes the focus, reaches every one of its controls in both placements, and gives the focus back on Escape", async () => {
    const stand = writingStand();
    const { page, context } = await open("/tickets", { stand });
    await page.locator(".row").first().waitFor();
    await page.getByRole("button", { name: "New ticket" }).click();
    const dialog = page.getByRole("dialog", { name: "New ticket" });
    await dialog.waitFor();
    for (const placement of ["Auto", "Manual"]) {
      await dialog.getByRole("radio", { name: placement }).click();
      const stops = await tabThrough(page, "[role=dialog]");
      expect(stops.length).toBeGreaterThanOrEqual(6);
      expect(stops.filter(({ ringed }) => !ringed).map(({ name }) => name)).toEqual([]);
      expect(await unreached(page, "[role=dialog]")).toEqual([]);
    }
    await page.evaluate(() => (document.activeElement as HTMLElement).blur());
    await holdsFocus(page, "[role=dialog]", isFocused(page, "New ticket"));
    await context.close();
  });
});

describe("Runs and Run detail", () => {
  it("Runs is reached from the sidebar to the last row", async () => {
    const { page, context } = await open("/runs", { stand: runsStand() });
    await page.locator(".run-row").first().waitFor();
    const names = await walked(page, 40);
    expect(names).toEqual(expect.arrayContaining(["Change limit", "Pause"]));
    await context.close();
  });

  it("Runs on a machine with a publisher reaches the tick boxes and the Publish bar", async () => {
    const { page, context } = await open("/runs", { stand: selectOf() });
    await page.locator(".run-row").first().waitFor();
    for (const key of TICKABLE.slice(0, 2)) await page.getByRole("checkbox", { name: `Select ${key} to publish` }).check();
    await page.getByRole("region", { name: "Selected runs" }).waitFor();
    const names = await walked(page, 20);
    expect(names.some((name) => /^Publish/.test(name))).toBe(true);
    await context.close();
  });

  it.each([
    ["a running run", () => detailStand("running", { terminal: TERMINAL }), addressOf("running")],
    ["a run ready to merge, with Publish", () => detailOf("ready"), detailAddress],
    ["a failed run", () => detailStand("failed"), addressOf("failed")],
  ])("Run detail of %s is reached from the breadcrumb to the Properties", async (_name, stand, address) => {
    const { page, context } = await open(address, { stand: stand() });
    await page.getByRole("navigation", { name: "Breadcrumb" }).waitFor();
    const names = await walked(page, 8);
    expect(names).toContain("Runs");
    await context.close();
  });
});

describe("Settings", () => {
  const opened = async (path: string) => {
    const state = settingsOf({});
    const made = await open(path, { stand: settingsStand() }, (context) => routeSettings(context, state));
    await made.page.getByText("Host file", { exact: false }).first().waitFor();
    return made;
  };

  it.each(["/settings/models", "/settings/workers", "/settings/machine"])("%s is reached from the sidebar to its last control", async (path) => {
    const { page, context } = await opened(path);
    await walked(page, 12);
    await context.close();
  });

  it("the review dialog keeps the focus and gives it back on Escape", async () => {
    const { page, context } = await opened("/settings/models");
    await page.getByLabel("tickets.writer.model", { exact: true }).fill("sonnet");
    await page.getByRole("button", { name: "Review changes" }).click();
    await page.getByRole("dialog", { name: "Review changes" }).waitFor();
    await holdsFocus(page, "[role=dialog]", isFocused(page, "Review changes"));
    await context.close();
  });
});

describe("Plugins", () => {
  const opened = async () => {
    const plugins = pluginsOf({ answer: () => answerOf({ host: BOARD_PLUGINS_HOST, claude: { readable: true, plugins: [a11ign()] } }) });
    const made = await open("/settings/plugins", { stand: settingsStand() }, async (context) => { await routeSettings(context, pluginsSettings()); await routePlugins(context, plugins); });
    await made.page.getByRole("region", { name: "Tracker" }).waitFor();
    return made;
  };

  it("Integrations is reached from the sidebar to its last control, with every card open", async () => {
    const { page, context } = await opened();
    for (const head of await page.locator(".plugin-head[aria-expanded=false]").all()) await head.click();
    await walked(page, 20);
    await context.close();
  });

  it("Claude plugins is reached too, and the tabs are one stop each way with the arrow keys", async () => {
    const { page, context } = await opened();
    await page.getByRole("tab", { name: /^Claude plugins/ }).click();
    await page.getByRole("region", { name: "a11ign" }).waitFor();
    await walked(page, 12);
    await context.close();
  });

  it("a confirmation dialog keeps the focus and gives it back on Escape", async () => {
    const { page, context } = await opened();
    await page.getByRole("button", { name: /^Publisher/ }).click();
    const uninstall = page.getByRole("button", { name: "Uninstall slack" });
    await uninstall.waitFor();
    await uninstall.click();
    await page.getByRole("dialog").waitFor();
    await holdsFocus(page, "[role=dialog]", () => uninstall.evaluate((element) => element === document.activeElement));
    await context.close();
  });
});
