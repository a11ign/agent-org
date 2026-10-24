import { readFileSync } from "node:fs";
import type { Browser, BrowserContext, Locator, Page } from "playwright-core";
import { pngSize } from "../../src/ticket-mode/capture.ts";
import { boardSizedStand, HERE, PERSONAL, queueOf, ticket, config, OTHER, type Stand } from "./fixtures.ts";
import { serveInstance, type Serving } from "./instance-routes.ts";
import { captureScreens, look, SCREENS, SCREENSHOT_DIR } from "./screenshots.ts";
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

/** An instance with two connections, tickets in two projects and three runs running. */
const STAND: Stand = {
  connections: [HERE, PERSONAL],
  instances: {
    here: {
      config: config(),
      tickets: [
        ticket({ key: "A11-1", project: "a11ign", goals: ["Fleet"] }), ticket({ key: "A11-2", project: "a11ign", goals: ["Clean boundaries"] }), ticket({ key: "A11-3", project: "a11ign" }),
        ticket({ key: "A11-4", project: "agent-org", goals: ["Fleet"] }), ticket({ key: "A11-5", project: "agent-org", assignee: OTHER }),
      ],
      queue: queueOf("running", "running", "running", "queued", "finished"),
    },
    personal: { config: config(), tickets: [ticket({ key: "A11-9", project: "elsewhere" })], queue: queueOf("queued") },
  },
};

const ROUTES = [
  { path: "/next/tickets", h1: "Tickets", title: "Atomaut: Tickets", current: ["Tickets"] },
  { path: "/next/runs", h1: "Runs", title: "Atomaut: Runs", current: ["Runs"] },
  { path: "/next/runs/A11-1", h1: "A11-1", title: "Atomaut: Run detail", current: ["Runs"] },
  { path: "/next/settings/models", h1: "Settings", title: "Atomaut: Settings, Models", current: ["Models", "Settings"] },
  { path: "/next/settings/workers", h1: "Settings", title: "Atomaut: Settings, Workers", current: ["Workers", "Settings"] },
  { path: "/next/settings/machine", h1: "Settings", title: "Atomaut: Settings, Machine", current: ["Machine", "Settings"] },
  { path: "/next/settings/plugins", h1: "Plugins", title: "Atomaut: Plugins", current: ["Plugins", "Settings"] },
] as const;

/** How long a page may take to hydrate before the check gives up on it. */
const HYDRATION_MS = 10_000;

/** A hold on the build's scripts: they wait for `release` before they are passed on, and `held` counts the requests waiting. */
type ScriptHold = Readonly<{ release: () => void; held: () => number }>;

/** Holds every script of the build until `release`, so the page can be read before its island hydrates. Registered after `serveInstance`, so it runs first and `fallback` hands the request on to it. */
async function holdScripts(context: BrowserContext): Promise<ScriptHold> {
  let held = 0;
  let release = (): void => undefined;
  const released = new Promise<void>((done) => { release = done; });
  await context.route("**/next/_astro/*.js", async (route) => {
    held += 1;
    await released;
    return route.fallback();
  });
  return { release, held: () => held };
}

/** A page of a new context at `width`, its instance calls answered by `serving`. Returns the page and the paths of the calls. */
async function open(path: string, serving: Serving = { stand: STAND }, width = 1440): Promise<{ page: Page; asked: string[]; context: BrowserContext }> {
  const context = await browser.newContext({ viewport: { width, height: 900 } });
  const asked = await serveInstance(context, serving);
  const page = await context.newPage();
  await page.goto(`${site.origin}${path}`);
  return { page, asked, context };
}

/** A page of a new context whose scripts are held, so it can be read before the island hydrates. */
async function openWithHeldScripts(path: string): Promise<{ page: Page; context: BrowserContext; hold: ScriptHold }> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await serveInstance(context, { stand: STAND });
  const hold = await holdScripts(context);
  const page = await context.newPage();
  await page.goto(`${site.origin}${path}`);
  return { page, context, hold };
}

/** The text of the page's level-1 heading, read now. */
const headingOf = (page: Page): Promise<string | null> => page.getByRole("heading", { level: 1 }).textContent();

/** Waits until the page's level-1 heading reads `h1` and its document title is `title`, and fails with the text it saw. A one-shot read of either races the island. */
async function expectSettled(page: Page, { h1, title }: { h1: string; title: string }): Promise<void> {
  await expect.poll(() => headingOf(page), { timeout: HYDRATION_MS }).toBe(h1);
  await expect.poll(() => page.title(), { timeout: HYDRATION_MS }).toBe(title);
}

const sidebarOf = (page: Page): Locator => page.getByRole("complementary", { name: "Atomaut" });
/** The text of every link the sidebar marks as the current page, number badges dropped. */
const currentItems = (page: Page): Promise<string[]> => sidebarOf(page).locator("[aria-current=page]").evaluateAll((elements) => elements.map((element) => (element.textContent ?? "").replace(/\d+$/, "")));

describe("every route renders inside the shell", () => {
  it.each(ROUTES)("$path: the sidebar, the page's heading, its title, and the active items marked", async ({ path, h1, title, current }) => {
    const { page, context } = await open(path);
    await sidebarOf(page).waitFor();
    // The sidebar is in the static HTML, but `/next/runs/<key>` is served as the runs page: its heading and title name the run only once the island has hydrated.
    await expectSettled(page, { h1, title });
    expect((await currentItems(page)).sort()).toEqual([...current].sort());
    await context.close();
  });

  it("names the run once the island hydrates, though the page was served as the runs list", async () => {
    const { page, context, hold } = await openWithHeldScripts("/next/runs/A11-1");
    try {
      await sidebarOf(page).waitFor();
      await expect.poll(hold.held, { timeout: HYDRATION_MS }).toBeGreaterThan(0);
      expect(await headingOf(page)).toBe("Runs");
      expect(await page.title()).toBe("Atomaut: Runs");
      hold.release();
      await expectSettled(page, { h1: "A11-1", title: "Atomaut: Run detail" });
    } finally {
      hold.release();
      await context.close();
    }
  });

  it("sends /next/ to Tickets and /next/settings to Models", async () => {
    for (const [from, to] of [["/next/", "/next/tickets"], ["/next/settings", "/next/settings/models"]] as const) {
      const { page, context } = await open(from);
      await page.waitForURL(`**${to}`);
      await sidebarOf(page).waitFor();
      await context.close();
    }
  });

  it("keeps ?connection= and the hash when it sends /next/ on, so a link to an instance still opens on it", async () => {
    const { page, context } = await open("/next/?connection=personal#A11-9");
    await page.waitForURL("**/next/tickets?connection=personal#A11-9");
    await page.waitForFunction(() => (document.querySelector("select") as HTMLSelectElement | null)?.value === "personal");
    await context.close();
  });

  it("falls back to Tickets for an unknown /next path, as ticket:ui answers it with the root page", async () => {
    const { page, context } = await open("/next/index.html");
    await page.waitForURL("**/next/tickets");
    await context.close();
  });
});

describe("the sidebar over a stand-in instance", () => {
  it("shows the counts, the projects and the goals of the tickets assigned to you", async () => {
    const { page, context } = await open("/next/tickets");
    const sidebar = sidebarOf(page);
    await sidebar.getByRole("button", { name: /^a11ign/ }).waitFor();
    expect(await sidebar.getByRole("link", { name: /Tickets/ }).textContent()).toBe("Tickets3");
    expect(await sidebar.getByRole("link", { name: /Runs/ }).textContent()).toBe("Runs3");
    expect(await sidebar.getByRole("button").allTextContents()).toEqual(["a11ign3", "agent-org1", "All goals3", "Clean boundaries1", "Fleet1", "(no Goal)1"]);
    expect(await sidebar.getByRole("status").filter({ hasText: "Connected" }).count()).toBe(1);
    await context.close();
  });

  it("moves its requests to the other instance on a switch, and keeps the choice on the next page", async () => {
    const { page, asked, context } = await open("/next/tickets");
    const select = page.getByLabel("Instance");
    await select.selectOption("personal");
    await page.getByRole("button", { name: /^elsewhere/ }).waitFor();
    expect(asked).toEqual(expect.arrayContaining(["/c/here/api/queue", "/c/personal/api/config", "/c/personal/api/tickets", "/c/personal/api/queue"]));
    await page.getByRole("link", { name: /Runs/ }).click();
    await page.waitForURL("**/next/runs");
    await page.getByRole("heading", { level: 1 }).waitFor();
    await page.waitForFunction(() => (document.querySelector("select") as HTMLSelectElement | null)?.value === "personal");
    const afterNavigation = asked.slice(asked.lastIndexOf("/api/connections") + 1);
    expect(afterNavigation.length).toBeGreaterThan(0);
    expect(afterNavigation.every((path) => path.startsWith("/c/personal/api/"))).toBe(true);
    await context.close();
  });

  it("makes every request to its own origin, and loads both self-hosted fonts", async () => {
    const { page, context } = await open("/next/tickets");
    const requested: string[] = [];
    page.on("request", (request) => requested.push(request.url()));
    await page.reload();
    await page.waitForLoadState("networkidle");
    const loaded = await page.evaluate(async () => ({ inter: (await document.fonts.load('1em "Inter Variable"')).length, mono: (await document.fonts.load('1em "JetBrains Mono Variable"')).length }));
    expect(loaded.inter).toBeGreaterThan(0);
    expect(loaded.mono).toBeGreaterThan(0);
    expect(requested.filter((url) => !url.startsWith(`${site.origin}/`))).toEqual([]);
    expect(requested.some((url) => /inter-.*\.woff2$/.test(url))).toBe(true);
    expect(requested.some((url) => /jetbrains-mono-.*\.woff2$/.test(url))).toBe(true);
    await context.close();
  });
});

describe("the collapse at 820px", () => {
  const boxes = async (page: Page) => {
    // The sidebar is drawn again when the connections arrive, so it is measured once they have.
    await page.waitForFunction(() => document.querySelector("select")?.disabled === false);
    const aside = await sidebarOf(page).boundingBox();
    const main = await page.getByRole("main").boundingBox();
    return { aside, main };
  };

  it("is 248px wide at 821px, with the page beside it", async () => {
    const { page, context } = await open("/next/tickets", { stand: STAND }, 821);
    const { aside, main } = await boxes(page);
    expect(aside?.width).toBe(248);
    expect(main?.y).toBe(aside?.y);
    await context.close();
  });

  it("is the full width at 820px, with the page beneath it", async () => {
    const { page, context } = await open("/next/tickets", { stand: STAND }, 820);
    const { aside, main } = await boxes(page);
    expect(aside?.width).toBe(820);
    expect(main?.y ?? 0).toBeGreaterThanOrEqual((aside?.y ?? 0) + (aside?.height ?? 0));
    await context.close();
  });
});

describe("no horizontal overflow, and the screenshots", () => {
  it.each(ROUTES)("$path fits at 1440px and at 390px", async ({ path }) => {
    const written = await captureScreens(browser, { origin: site.origin, route: path, prepare: (context) => serveInstance(context, { stand: boardSizedStand() }).then(() => undefined) });
    expect(written.map((file) => pngSize(readFileSync(file))?.width)).toEqual(SCREENS.map(({ width }) => width));
    expect(written.every((file) => file.startsWith(SCREENSHOT_DIR))).toBe(true);
  });

  it("fits with a long project name and a long goal in the sidebar at 390px", async () => {
    const long = "a-project-with-a-very-long-name-that-has-no-break-in-it-at-all-and-keeps-going";
    const stand: Stand = { instances: { here: { config: config(), tickets: [ticket({ key: "A11-1", project: long, goals: [long]})] } } };
    const { fit } = await look(browser, { route: "/next/tickets", url: `${site.origin}/next/tickets` }, SCREENS[1], (context) => serveInstance(context, { stand }).then(() => undefined));
    expect(fit.scrollWidth).toBeLessThanOrEqual(fit.clientWidth);
  });
});

describe("keyboard focus", () => {
  /** Tab from the top of the page `count` times and name each element that takes focus. */
  async function tabbed(page: Page, count: number): Promise<string[]> {
    const names: string[] = [];
    for (let index = 0; index < count; index += 1) {
      await page.keyboard.press("Tab");
      names.push(await page.evaluate(() => {
        const element = document.activeElement as HTMLElement;
        return element.tagName === "SELECT" ? "select" : (element.textContent ?? "").trim().slice(0, 40);
      }));
    }
    return names;
  }

  it("runs the switcher, Tickets, Runs, the projects, the goals, then Settings, then the page, as the boards lay them out", async () => {
    const stand: Stand = { instances: { here: { ...STAND.instances?.here, queueFails: { status: 500, error: "boom" } } } };
    const { page, context } = await open("/next/runs", { stand });
    await page.getByRole("alert").waitFor();
    expect(await tabbed(page, 4)).toEqual(["select", "Tickets3", "Runs", "Settings"]);
    expect(await tabbed(page, 1)).toEqual(["Retry"]);
    await context.close();
  });

  it("puts the projects and goals between Runs and Settings on Tickets", async () => {
    const { page, context } = await open("/next/tickets");
    await page.getByRole("button", { name: /^a11ign/ }).waitFor();
    expect(await tabbed(page, 10)).toEqual(["select", "Tickets3", "Runs3", "a11ign3", "agent-org1", "All goals3", "Clean boundaries1", "Fleet1", "(no Goal)1", "Settings"]);
    await context.close();
  });

  it("puts the Settings sub-nav between Runs and Settings on Settings", async () => {
    const { page, context } = await open("/next/settings/workers");
    await page.getByRole("link", { name: /^Tickets\s*3$/ }).waitFor();
    expect(await tabbed(page, 8)).toEqual(["select", "Tickets3", "Runs3", "Models", "Workers", "Machine", "Plugins", "Settings"]);
    await context.close();
  });

  it("draws the focus ring: 2px solid, in the accent's lightest step, 1px off", async () => {
    const { page, context } = await open("/next/tickets");
    await page.getByRole("button", { name: /^a11ign/ }).waitFor();
    await page.keyboard.press("Tab");
    for (const target of ["select", "a", "button"]) {
      const ring = await page.evaluate((tag) => {
        const element = document.querySelector<HTMLElement>(`aside ${tag}`) as HTMLElement;
        element.focus({ focusVisible: true } as FocusOptions);
        const { outlineStyle, outlineWidth, outlineColor, outlineOffset } = getComputedStyle(element);
        return { outlineStyle, outlineWidth, outlineColor, outlineOffset };
      }, target);
      expect(ring).toEqual({ outlineStyle: "solid", outlineWidth: "2px", outlineColor: "rgb(154, 161, 245)", outlineOffset: "1px" });
    }
    await context.close();
  });

  it("draws no ring on a press of the mouse", async () => {
    const { page, context } = await open("/next/tickets");
    const button = page.getByRole("button", { name: /^agent-org/ });
    await button.click();
    expect(await button.evaluate((element) => getComputedStyle(element).outlineStyle)).toBe("none");
    await context.close();
  });
});

describe("the skeleton and reduced motion", () => {
  const animationOf = (page: Page) => page.locator(".sk").first().evaluate((element) => getComputedStyle(element).animationName);

  it("shimmers while a read is out", async () => {
    const { page, context } = await open("/next/tickets", { hold: true });
    await page.getByRole("status", { name: "Loading tickets" }).waitFor();
    expect(await animationOf(page)).toBe("skeleton-shimmer");
    await context.close();
  });

  it("holds still when the browser asks for reduced motion", async () => {
    const { page, context } = await open("/next/tickets", { hold: true });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.getByRole("status", { name: "Loading tickets" }).waitFor();
    expect(await animationOf(page)).toBe("none");
    await context.close();
  });

  it("draws the sidebar's skeleton for the projects and goals while the tickets load", async () => {
    const { page, context } = await open("/next/tickets", { hold: true });
    const sidebarSkeleton = sidebarOf(page).getByRole("status", { name: "Loading projects and goals" });
    await sidebarSkeleton.waitFor();
    expect(await sidebarSkeleton.getAttribute("aria-busy")).toBe("true");
    await context.close();
  });
});
