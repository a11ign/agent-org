import type { Browser } from "playwright-core";
import { overflowProblem } from "../screenshots.ts";
import { launchBrowser, startSite, type Site } from "../site.ts";
import { boxOf, drawn, fitOf, hitProblems, openAt, PHONE, TABLET } from "./layout.ts";
import { CHECK_BOX, expectBottomSheet, expectFullScreen, expectStuckUnderBar, HIT_TARGET, openScreen, OVER_TAB_BAR, PHONE_PADDING, rows, runRows, searchButton, tabBar, TOP_BAR, topBar } from "./screens.ts";

// A11-427: each page's tablet and phone layout, in Chromium over the built site, as the brief's sections lay them out.

/** The tablet's notification panel: its width, how far down it opens (the bar's 57px and 7px under it), and how far it stands from the screen's right edge. */
const NOTIFICATIONS_WIDTH = 420;
const NOTIFICATIONS_TOP = 64;
const NOTIFICATIONS_INSET = 12;
/** How far New ticket's modal stands from a tablet's edges. */
const MODAL_EDGE = 32;

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

describe("notifications", () => {
  it("fill the screen at 390px, with 44px clear buttons and ticket rows, and a Close button", async () => {
    const { page, context } = await openScreen(browser, site.origin, "notifications");
    const panel = page.getByRole("dialog", { name: "Notifications" });
    await expectFullScreen(panel);
    const clears = await panel.locator(".notification-clear").evaluateAll((buttons) => buttons.map((button) => [Math.round(button.getBoundingClientRect().width), Math.round(button.getBoundingClientRect().height)]));
    expect(clears.length).toBe(3);
    for (const size of clears) expect(size).toEqual([HIT_TARGET, HIT_TARGET]);
    const links = await panel.locator("a.notification-ticket").evaluateAll((anchors) => anchors.map((anchor) => Math.round(anchor.getBoundingClientRect().height)));
    expect(links.length).toBeGreaterThan(0);
    for (const height of links) expect(height).toBe(HIT_TARGET);
    await panel.getByRole("button", { name: "Close notifications" }).click();
    await panel.waitFor({ state: "detached" });
    await context.close();
  });

  it("open a 420px panel under the top bar, at its right, at 820px", async () => {
    const { page, context } = await openScreen(browser, site.origin, "notifications", TABLET);
    const box = await boxOf(page.getByRole("dialog", { name: "Notifications" }));
    expect([box.width, box.y, box.x + box.width]).toEqual([NOTIFICATIONS_WIDTH, NOTIFICATIONS_TOP, TABLET.width - NOTIFICATIONS_INSET]);
    expect(await drawn(page.getByRole("button", { name: "Close notifications" }))).toBe(false);
    await context.close();
  });
});

describe("the search palette at 390px on a touch screen", () => {
  it("fills the screen, reads Close for Esc, leaves out the footer of keys, and keeps the arrow keys, Enter and Shift+Enter", async () => {
    const { page, context } = await openScreen(browser, site.origin, "search");
    const palette = page.getByRole("dialog", { name: "Search tickets" });
    await expectFullScreen(palette);
    expect(await palette.getByRole("button", { name: "Close search" }).innerText()).toBe("Close");
    expect(await drawn(palette.locator(".search-foot"))).toBe(false);
    const input = palette.getByRole("combobox");
    const first = await input.getAttribute("aria-activedescendant");
    await page.keyboard.press("ArrowDown");
    expect(await input.getAttribute("aria-activedescendant")).not.toBe(first);
    await page.keyboard.press("ArrowUp");
    expect(await input.getAttribute("aria-activedescendant")).toBe(first);
    const key = await page.locator(`#${first ?? ""}`).getAttribute("data-key");
    await page.keyboard.press("Enter");
    await page.getByRole("status").filter({ hasText: `Showing ${key ?? ""} from search` }).waitFor();
    await searchButton(page).click();
    await page.getByRole("combobox", { name: "Search tickets" }).fill("lab's cross-repo");
    await page.getByRole("listbox", { name: "Matching tickets" }).getByRole("option").first().waitFor();
    await page.keyboard.press("Shift+Enter");
    await page.waitForURL("**/runs/A11-180");
    await context.close();
  });
});

describe("New ticket", () => {
  it("is a full-screen sheet at 390px: a body longer than the screen scrolls over a footer pinned to the bottom, Cancel and Write ticket as wide, the cards stacked", async () => {
    // A short phone, so the body is longer than the screen.
    const short = { width: PHONE.width, height: 560 };
    const { page, context } = await openScreen(browser, site.origin, "new-ticket", short);
    const dialog = page.getByRole("dialog", { name: "New ticket" });
    const box = await boxOf(dialog);
    expect([box.x, box.y, box.width, box.height]).toEqual([0, 0, short.width, short.height]);
    expect(await dialog.locator(".nt-body").evaluate((body) => body.scrollHeight > body.clientHeight && getComputedStyle(body).overflowY === "auto")).toBe(true);
    const foot = await boxOf(dialog.locator(".nt-foot"));
    expect(foot.y + foot.height).toBe(short.height);
    await dialog.locator(".nt-body").evaluate((body) => body.scrollTo(0, body.scrollHeight));
    const after = await boxOf(dialog.locator(".nt-foot"));
    expect(after.y + after.height).toBe(short.height);
    expect(await dialog.locator(".nt-body").evaluate((body) => body.scrollTop)).toBeGreaterThan(0);
    const cancel = await boxOf(dialog.getByRole("button", { name: "Cancel" }));
    const write = await boxOf(dialog.getByRole("button", { name: "Write ticket" }));
    expect(cancel.width).toBe(write.width);
    expect(cancel.y).toBe(write.y);
    const cards = await dialog.locator(".nt-mode").evaluateAll((labels) => labels.map((label) => label.getBoundingClientRect()).map(({ x, top, bottom }) => ({ x, top, bottom })));
    expect(cards.length).toBeGreaterThan(1);
    for (let index = 1; index < cards.length; index += 1) {
      expect(cards[index].x).toBe(cards[0].x);
      expect(cards[index].top).toBeGreaterThanOrEqual(cards[index - 1].bottom);
    }
    await context.close();
  });

  it("is a centred modal 32px from the screen's edges at 820px", async () => {
    const { page, context } = await openScreen(browser, site.origin, "new-ticket", TABLET);
    const box = await boxOf(page.getByRole("dialog", { name: "New ticket" }));
    expect([box.x, TABLET.width - (box.x + box.width)]).toEqual([MODAL_EDGE, MODAL_EDGE]);
    expect(box.y).toBeGreaterThanOrEqual(MODAL_EDGE);
    expect(Math.abs(box.y - (TABLET.height - (box.y + box.height)))).toBeLessThanOrEqual(1);
    await context.close();
  });
});

describe("Runs and a run's detail at 390px", () => {
  it("draws a run with a pull request: its icon in a 44px gutter, the words the full width, and the pull request, the time and 44px actions on one line", async () => {
    const { page, context } = await openAt(browser, site.origin, "/runs", PHONE, { ready: runRows });
    const row = page.locator("#run-A11-180");
    const [status, main, pull, time] = await Promise.all([".run-status", ".run-main", ".pr-pill", ".run-timing"].map((selector) => boxOf(row.locator(selector).first())));
    const actions = await row.locator(".icon-button").evaluateAll((buttons) => buttons.map((button) => button.getBoundingClientRect()).map(({ width, height, top, bottom, right }) => ({ width, height, middle: (top + bottom) / 2, right })));
    const rowBox = await boxOf(row);
    expect([status.x, status.width]).toEqual([rowBox.x, HIT_TARGET]);
    expect(main.x).toBe(rowBox.x + HIT_TARGET);
    expect(main.x + main.width).toBe(rowBox.x + rowBox.width - 12);
    expect(actions.length).toBeGreaterThan(0);
    for (const action of actions) {
      expect([action.width, action.height]).toEqual([HIT_TARGET, HIT_TARGET]);
      expect(Math.abs(action.middle - (pull.y + pull.height / 2))).toBeLessThanOrEqual(2);
    }
    expect(Math.abs(time.y + time.height / 2 - (pull.y + pull.height / 2))).toBeLessThanOrEqual(2);
    expect(Math.round(actions[actions.length - 1].right)).toBe(rowBox.x + rowBox.width - 12);
    await context.close();
  });

  it("draws a run's detail with 44px buttons and its properties full width beneath", async () => {
    const { page, context } = await openScreen(browser, site.origin, "run-detail");
    const buttons = await page.locator(".run-buttons button").evaluateAll((all) => all.map((button) => Math.round(button.getBoundingClientRect().height)));
    expect(buttons.length).toBeGreaterThan(0);
    for (const height of buttons) expect(height).toBe(HIT_TARGET);
    const main = await boxOf(page.locator(".detail-main"));
    const props = await boxOf(page.locator(".props"));
    expect(props.y).toBeGreaterThanOrEqual(main.y + main.height);
    expect([props.x, props.width]).toEqual([PHONE_PADDING, PHONE.width - 2 * PHONE_PADDING]);
    await context.close();
  });
});

describe("Settings at 390px", () => {
  it("draws the sections as a sticky strip of pills, 36px with a 44px tap, and its inputs, selects and buttons 44px", async () => {
    const { page, context } = await openScreen(browser, site.origin, "settings");
    const strip = page.getByRole("navigation", { name: "Settings sections" });
    expect(await strip.getByRole("link").allTextContents()).toEqual(["Models", "Workers", "Machine", "Plugins"]);
    expect((await boxOf(strip)).y).toBe(TOP_BAR);
    expect(await strip.evaluate((element) => getComputedStyle(element).overflowX)).toBe("auto");
    for (const height of await strip.getByRole("link").evaluateAll((links) => links.map((link) => Math.round(link.getBoundingClientRect().height)))) expect(height).toBe(36);
    expect(await hitProblems(page, "nav[aria-label='Settings sections']")).toEqual([]);
    const heights = await page.locator(".settings :is(select, button, input:not([type=checkbox]))").evaluateAll((all) => all.filter((element) => element.checkVisibility()).map((element) => Math.round(element.getBoundingClientRect().height)));
    expect(heights.length).toBeGreaterThan(3);
    for (const height of heights) expect(height).toBeGreaterThanOrEqual(HIT_TARGET);
    await expectStuckUnderBar(page, strip);
    await context.close();
  });

  it("stands the unsaved-changes bar over the tab bar, and opens Review changes as a full-width bottom sheet", async () => {
    const { page, context } = await openScreen(browser, site.origin, "settings");
    // A key of the host file is staged, not saved as it changes, as the Models defaults are.
    await page.getByLabel("tickets.writer.model", { exact: true }).fill("sonnet");
    const bar = page.getByRole("region", { name: "Unsaved changes" });
    await bar.waitFor();
    const box = await boxOf(page.locator(".unsaved-stack"));
    expect(PHONE.height - (box.y + box.height)).toBe(OVER_TAB_BAR);
    await bar.getByRole("button", { name: "Review changes" }).click();
    await expectBottomSheet(page.getByRole("dialog", { name: "Review changes" }));
    // The unsaved-changes bar, which stands over the tab bar, is under the sheet: every control of the sheet takes its taps.
    expect(await hitProblems(page, "[role=dialog]")).toEqual([]);
    await context.close();
  });

  it("opens Uninstall's confirm on Plugins as a full-width bottom sheet", async () => {
    const { page, context } = await openScreen(browser, site.origin, "plugins");
    await page.getByRole("button", { name: /^Publisher/ }).click();
    await page.getByRole("button", { name: "Uninstall slack" }).click();
    await expectBottomSheet(page.getByRole("dialog", { name: "Uninstall slack?" }));
    await context.close();
  });
});

describe("the Unreachable page at 390px", () => {
  it("keeps the top bar and the tab bar, with 44px buttons and 40px checkboxes", async () => {
    const link = { down: false };
    const { page, context } = await openAt(browser, site.origin, "/tickets", PHONE, { link, ready: rows });
    link.down = true;
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await page.getByRole("button", { name: "Check now" }).waitFor();
    expect(await drawn(topBar(page))).toBe(true);
    expect(await drawn(tabBar(page))).toBe(true);
    expect((await boxOf(page.getByRole("button", { name: "Check now" }))).height).toBe(HIT_TARGET);
    const check = await boxOf(page.locator(".row-check").first());
    expect([check.width, check.height]).toEqual([CHECK_BOX, CHECK_BOX]);
    expect(await hitProblems(page)).toEqual([]);
    expect(overflowProblem({ route: "/tickets (unreachable)", width: PHONE.width, ...(await fitOf(page)) })).toBeNull();
    await context.close();
  });
});
