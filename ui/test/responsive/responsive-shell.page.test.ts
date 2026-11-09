import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Browser, Page } from "playwright-core";
import { launchBrowser, startSite, UI_ROOT, type Site } from "../site.ts";
import { boxOf, drawn, hitProblems, LANDSCAPE, openAt, PHONE, TABLET } from "./layout.ts";
import { bell, expectStuckUnderBar, HIT_TARGET, openScreen, projectChip, rows, runRows, scopeDialog, searchButton, TAB_BAR, tabBar, TOP_BAR, topBar } from "./screens.ts";

// A11-427: the breakpoints, the top bar and the tab bar, the touch rules, and where the sidebar's content goes at 1024px and below, in Chromium over the built site.

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

describe("the breakpoints and the shell", () => {
  it("keeps the 248px sidebar beside the page at 1180px, with no top bar or tab bar", async () => {
    const { page, context } = await openAt(browser, site.origin, "/tickets", LANDSCAPE, { ready: rows });
    const sidebar = await boxOf(topBar(page));
    const main = await boxOf(page.getByRole("main"));
    expect([sidebar.x, sidebar.y, sidebar.width]).toEqual([0, 0, 248]);
    expect(sidebar.height).toBeGreaterThanOrEqual(LANDSCAPE.height);
    expect([main.x, main.y]).toEqual([248, 0]);
    expect(await drawn(tabBar(page))).toBe(false);
    expect(await drawn(page.locator(".topbar-brand"))).toBe(false);
    expect(await drawn(page.locator(".filter-group-projects"))).toBe(true);
    expect(await drawn(page.getByRole("group", { name: "Scope" }))).toBe(false);
    await context.close();
  });

  it("hides the sidebar at 820px for a sticky 57px top bar of the mark, the tabs, the instance chip, the search icon and the bell, over a page padded 20px", async () => {
    const { page, context } = await openAt(browser, site.origin, "/runs", TABLET, { ready: runRows });
    for (const hidden of [".main-nav", ".brand-name", ".loop-line", ".sidebar > .nav-link"]) expect(await drawn(page.locator(hidden))).toBe(false);
    const bar = await boxOf(topBar(page));
    expect([bar.x, bar.y, bar.width, bar.height]).toEqual([0, 0, TABLET.width, TOP_BAR]);
    expect(await topBar(page).evaluate((element) => getComputedStyle(element).position)).toBe("sticky");
    expect(await page.locator(".tabs .tab").allInnerTexts()).toEqual(["Tickets", "Runs", "Settings"]);
    for (const control of [page.locator(".topbar-brand"), tabBar(page), page.getByLabel("Instance"), searchButton(page), bell(page)]) {
      expect(await drawn(control)).toBe(true);
      const box = await boxOf(control);
      expect(box.y + box.height / 2).toBeCloseTo(28, -1);
    }
    expect(await page.getByRole("main").evaluate((main) => [getComputedStyle(main).paddingLeft, getComputedStyle(main).paddingRight])).toEqual(["20px", "20px"]);
    await page.mouse.wheel(0, 600);
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
    expect((await boxOf(topBar(page))).y).toBe(0);
    await context.close();
  });

  it("puts the tabs in a fixed bottom bar at 390px, 64px tall, with the 3 running on Runs, and keeps the last row clear of it", async () => {
    const { page, context } = await openAt(browser, site.origin, "/runs", PHONE, { ready: runRows });
    expect(await drawn(page.locator(".topbar-wordmark"))).toBe(false);
    const bar = await boxOf(tabBar(page));
    expect([bar.x, bar.y, bar.width, bar.height]).toEqual([0, PHONE.height - TAB_BAR, PHONE.width, TAB_BAR]);
    expect(await tabBar(page).evaluate((element) => getComputedStyle(element).position)).toBe("fixed");
    expect(await page.locator(".tabs .tab").allTextContents()).toEqual(["Tickets", "Runs3", "Settings"]);
    expect(await page.locator(".tab-badge").textContent()).toBe("3");
    const top = await boxOf(topBar(page));
    expect(bar.y).toBeGreaterThan(top.y + top.height);
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    const last = await page.getByRole("main").evaluate((main) => {
      const children = [...main.querySelectorAll(".shell-page > *")].filter((element) => element.getBoundingClientRect().height > 0);
      return children[children.length - 1]?.getBoundingClientRect().bottom ?? 0;
    });
    expect(last).toBeLessThanOrEqual(PHONE.height - TAB_BAR);
    await context.close();
  });

  it("serves a viewport that covers the safe areas", () => {
    for (const page of ["tickets", "runs", "settings/models"]) {
      const html = readFileSync(join(UI_ROOT, "dist", page, "index.html"), "utf8");
      expect(html).toMatch(/<meta name="viewport" content="[^"]*viewport-fit=cover[^"]*"/);
    }
  });

});

describe("a sheet or a modal at 390px", () => {
  it.each([
    ["the scope sheet", (page: Page) => projectChip(page).click(), "Project and goal"],
    ["New ticket", (page: Page) => page.getByRole("button", { name: "New ticket" }).click(), "New ticket"],
    ["the notification centre", (page: Page) => bell(page).click(), "Notifications"],
    ["the search palette", (page: Page) => searchButton(page).click(), "Search tickets"],
  ] as const)("hides the tab bar at 390px while %s is open, and nothing covers the dialog's controls", async (_what, show, dialog) => {
    const { page, context } = await openAt(browser, site.origin, "/tickets", PHONE, { ready: rows });
    expect(await drawn(tabBar(page))).toBe(true);
    await show(page);
    await page.getByRole("dialog", { name: dialog }).waitFor();
    expect(await drawn(tabBar(page))).toBe(false);
    expect(await hitProblems(page, "[role=dialog]")).toEqual([]);
    await context.close();
  });
});

describe("touch and input", () => {
  it("draws a text field 16px on a phone, and 13px wider than a tablet", async () => {
    const field = (page: Page) => page.getByPlaceholder("Filter by key, title or project");
    const phone = await openAt(browser, site.origin, "/tickets", PHONE, { ready: rows });
    expect(await field(phone.page).evaluate((input) => getComputedStyle(input).fontSize)).toBe("16px");
    await phone.context.close();
    const wide = await openAt(browser, site.origin, "/tickets", LANDSCAPE, { ready: rows });
    expect(await field(wide.page).evaluate((input) => getComputedStyle(input).fontSize)).toBe("13px");
    await wide.context.close();
  });

  it("draws the focus ring on the top bar, the tab bar, the chips and a page's buttons at 390px: 2px solid, 1px off", async () => {
    const { page, context } = await openAt(browser, site.origin, "/tickets", PHONE, { ready: rows });
    for (const selector of [".topbar-brand", ".tabs .tab", ".scope-chip", ".bell", ".tickets-header .ghost", ".switcher select"]) {
      const ring = await page.locator(selector).first().evaluate((element: HTMLElement) => {
        element.focus({ focusVisible: true } as FocusOptions);
        const { outlineStyle, outlineWidth, outlineColor, outlineOffset } = getComputedStyle(element);
        return { outlineStyle, outlineWidth, outlineColor, outlineOffset };
      });
      expect([selector, ring]).toEqual([selector, { outlineStyle: "solid", outlineWidth: "2px", outlineColor: "rgb(154, 161, 245)", outlineOffset: "1px" }]);
    }
    await context.close();
  });

  it("shows a search row's actions without a hover on a touch screen", async () => {
    const { page, context } = await openScreen(browser, site.origin, "search");
    expect(await page.evaluate(() => matchMedia("(hover: none)").matches)).toBe(true);
    const actions = page.locator(".search-row .search-actions");
    expect(await actions.count()).toBeGreaterThan(1);
    for (const shown of await actions.evaluateAll((elements) => elements.map((element) => getComputedStyle(element).display))) expect(shown).not.toBe("none");
    await context.close();
  });
});

describe("the sidebar's content at 1024px and below", () => {
  it("opens the Project chip's centred dialog at 820px, with the Projects, the Goals with counts and Done, keeps the focus in it and closes on Escape", async () => {
    const { page, context } = await openAt(browser, site.origin, "/tickets", TABLET, { ready: rows });
    await projectChip(page).click();
    const dialog = scopeDialog(page);
    await dialog.waitFor();
    expect(await dialog.getAttribute("aria-modal")).toBe("true");
    const box = await boxOf(dialog);
    expect(box.x + box.width / 2).toBeCloseTo(TABLET.width / 2, 0);
    expect(box.y + box.height / 2).toBeCloseTo(TABLET.height / 2, -1);
    expect(await dialog.getByRole("group", { name: "Projects" }).getByRole("button").allTextContents()).toEqual(["a11ign37", "agent-org8", "announcement-emulator1", "auth-capture-check1"]);
    expect(await dialog.getByRole("group", { name: "Goals" }).getByRole("button").first().textContent()).toBe("All goals37");
    expect(await dialog.getByRole("button", { name: "Done" }).count()).toBe(1);
    for (let press = 0; press < 20; press += 1) {
      await page.keyboard.press("Tab");
      expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
    }
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "detached" });
    await context.close();
  });

  it("is a bottom sheet at 390px, and choosing agent-org and Done lists agent-org's tickets as the sidebar does", async () => {
    const { page, context } = await openAt(browser, site.origin, "/tickets", PHONE, { ready: rows });
    await projectChip(page).click();
    const box = await boxOf(scopeDialog(page));
    expect([box.x + box.width, box.y + box.height]).toEqual([PHONE.width, PHONE.height]);
    await scopeDialog(page).getByRole("button", { name: /^agent-org/ }).click();
    await scopeDialog(page).getByRole("button", { name: "Done" }).click();
    await page.locator(".row-project").filter({ hasText: "agent-org" }).first().waitFor();
    expect(new Set(await page.locator(".row-project").allTextContents())).toEqual(new Set(["agent-org"]));
    expect(await page.locator(".page-count").textContent()).toBe("8 assigned to you");
    await context.close();
  });

  it("moves the whole UI to the other connection from the top bar's instance chip at 820px", async () => {
    const { page, context } = await openAt(browser, site.origin, "/tickets", TABLET, { ready: rows });
    const asked: string[] = [];
    page.on("request", (request) => asked.push(new URL(request.url()).pathname));
    const chip = await boxOf(page.locator(".switcher"));
    expect(chip.y + chip.height / 2).toBeCloseTo(TOP_BAR / 2, -1);
    expect(chip.height).toBe(HIT_TARGET);
    await page.getByLabel("Instance").selectOption("personal");
    await page.getByText("Nothing is assigned to you", { exact: false }).or(page.locator(".page-count").filter({ hasText: /^0 / })).first().waitFor();
    expect(asked.some((path) => path.startsWith("/c/personal/api/"))).toBe(true);
    expect(asked.filter((path) => path.startsWith("/c/")).every((path) => path.startsWith("/c/personal/"))).toBe(true);
    await context.close();
  });

  it("opens the search palette from the top bar's search icon at 820px", async () => {
    const { page, context } = await openAt(browser, site.origin, "/tickets", TABLET, { ready: rows });
    const icon = await boxOf(searchButton(page));
    expect([icon.width, icon.height]).toEqual([HIT_TARGET, HIT_TARGET]);
    await searchButton(page).click();
    await page.getByRole("dialog", { name: "Search tickets" }).waitFor();
    await context.close();
  });

  it("filters the runs from the sticky status strip at 390px, which leaves out a status with no runs and scrolls sideways", async () => {
    const { page, context } = await openAt(browser, site.origin, "/runs", PHONE, { ready: runRows });
    const strip = page.getByRole("navigation", { name: "Run status" });
    const pills = await strip.locator("button").evaluateAll((buttons) => buttons.filter((button) => button.checkVisibility()).map((button) => button.textContent ?? ""));
    expect(pills.length).toBeGreaterThan(3);
    for (const pill of pills) expect(Number(/(\d+)$/.exec(pill)?.[1])).toBeGreaterThan(0);
    expect(await strip.evaluate((element) => [getComputedStyle(element).overflowX, element.scrollWidth > element.clientWidth])).toEqual(["auto", true]);
    const top = await boxOf(strip);
    expect(top.y).toBe(TOP_BAR);
    await strip.getByRole("button", { name: /^Failed/ }).click();
    expect(new Set(await page.locator(".run-state").allTextContents())).toEqual(new Set(["Failed"]));
    expect(await page.locator(".run-row").count()).toBe(2);
    await expectStuckUnderBar(page, strip);
    await context.close();
  });
});
