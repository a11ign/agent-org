import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Browser, BrowserContext, Locator, Page } from "playwright-core";
import { captureName } from "../../../src/ticket-mode/capture.ts";
import type { QueueView } from "../../src/api/types.ts";
import { HERE, queueingConfig, ticket, type Stand } from "../fixtures.ts";
import { serveInstance } from "../instance-routes.ts";
import { overflowProblem, SCREENS } from "../screenshots.ts";
import { launchBrowser, startSite, UI_ROOT, type Site } from "../site.ts";

// A11-387: the "Search tickets" palette in Chromium -- its layout on a 390px touch screen, its focus ring, and its skeleton under reduced motion.

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

const CAPTURES = join(UI_ROOT, "captures", "search");
const [DESKTOP, PHONE] = SCREENS;
const RING = { width: "2px", colour: "rgb(154, 161, 245)" };
/** The smallest a control may be on a touch screen, either way. */
const HIT_TARGET = 44;

const A11_312 = ticket({ key: "A11-312", title: "Fleet status reads three worktree hashes, with workers 5, 6 and 13 off the rest of the fleet", project: "agent-org", assignee: null, goals: ["Fleet"] });
const A11_301 = ticket({ key: "A11-301", title: "Rotate the worktree keys", project: "control" });

/** An instance whose tracker finds A11-312 and A11-301, and whose queue runs A11-312. */
const STAND: Stand = {
  connections: [HERE],
  instances: {
    here: {
      config: queueingConfig({ search: true } as never), tickets: [A11_312, A11_301], writer: { runs: [] }, search: () => [A11_312, A11_301],
      queue: { entries: [{ ticket: { key: "A11-312", title: A11_312.title, url: "" }, phase: "running", queuedAt: Date.now(), startedAt: Date.now() }], paused: false } as unknown as QueueView,
    },
  },
};

type Opened = Readonly<{ page: Page; context: BrowserContext }>;

/** A page of the board at `width`, a touch screen when `touch`, with motion reduced when `reduced`; `holdSearch` leaves every search unanswered. */
type Screen = Readonly<{ route?: string; width?: number; touch?: boolean; reduced?: boolean; holdSearch?: boolean }>;

async function open({ route = "/runs", width = DESKTOP.width, touch = false, reduced = false, holdSearch = false }: Screen = {}): Promise<Opened> {
  const context = await browser.newContext({
    viewport: { width, height: width === DESKTOP.width ? DESKTOP.height : PHONE.height }, deviceScaleFactor: 1, hasTouch: touch, isMobile: touch, reducedMotion: reduced ? "reduce" : "no-preference",
  });
  await context.addInitScript(() => localStorage.setItem("ticket-mode.open", '["Backlog"]'));
  await serveInstance(context, { stand: STAND });
  // Added after, so it is asked first.
  if (holdSearch) await context.route("**/api/search?*", () => undefined);
  const page = await context.newPage();
  await page.goto(`${site.origin}${route}`);
  await searchButton(page).waitFor();
  return { page, context };
}

const searchButton = (page: Page) => page.getByRole("button", { name: "Search tickets", exact: true });
const palette = (page: Page) => page.getByRole("dialog", { name: "Search tickets" });
const fit = (page: Page) => page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth }));

async function searchFor(page: Page, text: string): Promise<void> {
  await searchButton(page).click();
  await palette(page).getByRole("combobox").fill(text);
}

/** The width and height of every control `locator` matches that is shown. */
async function sizes(locator: Locator): Promise<{ name: string; width: number; height: number }[]> {
  return locator.evaluateAll((elements) => elements.filter((element) => (element as HTMLElement).offsetParent !== null).map((element) => {
    const box = element.getBoundingClientRect();
    return { name: element.getAttribute("aria-label") ?? element.textContent?.trim() ?? "", width: box.width, height: box.height };
  }));
}

/** Checks the page does not scroll sideways at 390px, captures it, and closes it. */
async function fitsPhone({ page, context }: Opened, name: string): Promise<void> {
  const { scrollWidth, clientWidth } = await fit(page);
  expect(overflowProblem({ route: name, width: PHONE.width, scrollWidth, clientWidth })).toBeNull();
  await capture(page, name, PHONE);
  await context.close();
}

async function capture(page: Page, name: string, screen: (typeof SCREENS)[number]): Promise<void> {
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  mkdirSync(CAPTURES, { recursive: true });
  writeFileSync(join(CAPTURES, captureName(`search-${name}`, screen)), await page.screenshot({ fullPage: false }));
}

describe("the palette on a 390px touch screen", () => {
  it("makes every new control at least 44x44, shows both actions of a row, and does not scroll sideways", async () => {
    const opened = await open({ width: PHONE.width, touch: true });
    const { page } = opened;
    const small = (found: { width: number; height: number }[]) => found.filter(({ width, height }) => Math.min(width, height) < HIT_TARGET);
    expect(small(await sizes(searchButton(page)))).toEqual([]);
    await searchFor(page, "worktree");
    await palette(page).getByRole("option").first().waitFor();
    const row = palette(page).getByRole("option").filter({ hasText: "A11-312" });
    expect(await row.locator(".search-action").evaluateAll((actions) => actions.map((action) => [action.textContent, (action as HTMLElement).offsetParent !== null]))).toEqual([["Open ticket", true], ["View run", true]]);
    // A row that is not the active one shows its action too: there is no hover to show it by.
    expect(await palette(page).getByRole("option").filter({ hasText: "A11-301" }).getByText("Open ticket").isVisible()).toBe(true);
    const controls = await sizes(palette(page).locator("button, a[href]"));
    expect(controls.map(({ name }) => name)).toEqual(["Close search", "Open ticket", "View run", "Open ticket"]);
    expect(small(controls)).toEqual([]);
    await fitsPhone(opened, "results");
  });

  it("makes Back to my tickets at least 44x44 on the banner, which fits the screen", async () => {
    const opened = await open({ route: "/tickets", width: PHONE.width, touch: true });
    const { page } = opened;
    await searchFor(page, "worktree");
    await palette(page).getByRole("option").filter({ hasText: "A11-312" }).getByRole("button", { name: "Open ticket" }).click();
    const back = page.getByRole("button", { name: "Back to my tickets" });
    await back.waitFor();
    const box = await back.boundingBox();
    expect(Math.min(box?.width ?? 0, box?.height ?? 0)).toBeGreaterThanOrEqual(HIT_TARGET);
    await fitsPhone(opened, "from-search");
  });
});

describe("the focus ring", () => {
  /** The outline the focused element draws, and its name. */
  const focused = (page: Page) => page.evaluate(() => {
    const element = document.activeElement as HTMLElement;
    const style = getComputedStyle(element);
    return { name: element.getAttribute("aria-label") ?? element.textContent?.trim() ?? "", width: style.outlineWidth, colour: style.outlineColor, style: style.outlineStyle };
  });

  it("is the 2px #9aa1f5 ring on the button, the palette's controls and the banner's, from the keyboard", async () => {
    const { page, context } = await open({ route: "/tickets" });
    await page.locator(".pill").click();
    const reached: string[] = [];
    // From the pill, the button is the next stop but the loop line's, which has nothing to focus.
    for (let step = 0; step < 3 && !reached.includes("Search tickets"); step++) {
      await page.keyboard.press("Tab");
      const state = await focused(page);
      if (state.name === "Search tickets") {
        expect(state).toEqual({ name: "Search tickets", width: RING.width, colour: RING.colour, style: "solid" });
        reached.push(state.name);
      }
    }
    expect(reached).toEqual(["Search tickets"]);
    await page.keyboard.press("Enter");
    await palette(page).getByRole("combobox").fill("worktree");
    await palette(page).getByRole("option").first().waitFor();
    // The input's ring is the box's underline, as the board draws it.
    expect(await palette(page).locator(".search-box").evaluate((box) => getComputedStyle(box).boxShadow)).toBe(`${RING.colour} 0px -2px 0px 0px inset`);
    for (const name of ["Close search", "Open ticket", "View run"]) {
      await page.keyboard.press("Tab");
      expect(await focused(page)).toEqual({ name, width: RING.width, colour: RING.colour, style: "solid" });
    }
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Enter");
    await page.getByRole("button", { name: "Back to my tickets" }).waitFor();
    await page.getByRole("button", { name: "Back to my tickets" }).focus();
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Tab");
    expect(await focused(page)).toEqual({ name: "Back to my tickets", width: RING.width, colour: RING.colour, style: "solid" });
    await capture(page, "from-search", DESKTOP);
    await context.close();
  });
});

describe("the skeleton", () => {
  const animation = (page: Page) => palette(page).locator(".search-skeleton-row .sk").first().evaluate((block) => getComputedStyle(block).animationName);

  it("shimmers while the search is out", async () => {
    const { page, context } = await open({ holdSearch: true });
    await searchFor(page, "work");
    expect(await animation(page)).toBe("skeleton-shimmer");
    await capture(page, "loading", DESKTOP);
    await context.close();
  });

  it("does not shimmer for a person who prefers reduced motion", async () => {
    const { page, context } = await open({ holdSearch: true, reduced: true });
    await searchFor(page, "work");
    expect(await animation(page)).toBe("none");
    await context.close();
  });
});
