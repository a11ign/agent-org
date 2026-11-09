import type { Browser } from "playwright-core";
import { launchBrowser, startSite, type Site } from "../site.ts";
import { boxOf, drawn, openAt, PHONE } from "./layout.ts";
import { CHECK_BOX, expectBottomSheet, OVER_TAB_BAR, PHONE_PADDING, rows, runRows, tabBar } from "./screens.ts";

// A11-427: the Tickets page at 390px, in Chromium over the built site: its header, filters, card rows, selection bar and the paused banner, as the brief's Tickets section lays them out.

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

describe("the Tickets header and filters at 390px", () => {
  it("draws one header row: Tickets over the count on the left, Expand and New ticket on the right", async () => {
    const { page, context } = await openAt(browser, site.origin, "/tickets", PHONE, { ready: rows });
    const header = page.locator(".tickets-header");
    const heading = await boxOf(header.getByRole("heading", { name: "Tickets" }));
    const count = await boxOf(header.locator(".page-count"));
    const expand = await boxOf(header.getByRole("button", { name: /^Expand/ }));
    const create = await boxOf(header.getByRole("button", { name: "New ticket" }));
    expect(await header.locator(".page-count").textContent()).toBe("37 assigned to you");
    expect(await header.getByRole("button", { name: /^Expand/ }).innerText()).toBe("Expand");
    expect(count.y).toBeGreaterThanOrEqual(heading.y + heading.height - 1);
    expect(Math.abs(count.x - heading.x)).toBeLessThanOrEqual(1);
    expect(expand.x).toBeGreaterThan(count.x + count.width);
    expect(create.x).toBeGreaterThan(expand.x + expand.width);
    expect(Math.abs(expand.y + expand.height / 2 - (create.y + create.height / 2))).toBeLessThanOrEqual(1);
    expect(create.x + create.width).toBe(PHONE.width - PHONE_PADDING);
    await context.close();
  });

  it("stacks the filters: the search full width and 40px, the Assignee group full width and about 36px, then Priority and Plan half and half, 10px apart", async () => {
    const { page, context } = await openAt(browser, site.origin, "/tickets", PHONE, { ready: rows });
    const row = await boxOf(page.locator(".filter-row"));
    const search = await boxOf(page.getByPlaceholder("Filter by key, title or project"));
    const group = await boxOf(page.getByRole("group", { name: "Assignee" }));
    const priority = await boxOf(page.getByRole("button", { name: "Priority" }));
    const plan = await boxOf(page.getByRole("button", { name: "Plan" }));
    expect([search.width, search.height]).toEqual([row.width, 40]);
    expect(group.width).toBe(row.width);
    expect(group.height).toBeGreaterThanOrEqual(34);
    expect(group.height).toBeLessThanOrEqual(38);
    expect(priority.y).toBe(plan.y);
    expect(Math.abs(priority.width - plan.width)).toBeLessThanOrEqual(1);
    expect(priority.width + plan.width).toBeGreaterThan(row.width - 20);
    expect(group.y - (search.y + search.height)).toBeGreaterThanOrEqual(10);
    expect(group.y - (search.y + search.height)).toBeLessThanOrEqual(14);
    expect(priority.y - (group.y + group.height)).toBe(10);
    await context.close();
  });

});

describe("the Tickets rows and bars at 390px", () => {
  it("draws a backlog ticket as a card: its checkbox in a 40px square, the priority and key, then the title in two lines of 14px, then the chips and the project", async () => {
    const { page, context } = await openAt(browser, site.origin, "/tickets", PHONE, { ready: rows });
    const row = page.locator('[data-key="A11-63"]');
    const check = await boxOf(row.locator(".row-check"));
    const key = await boxOf(row.locator(".row-key"));
    const priority = await boxOf(row.locator(".priority-mark"));
    const title = row.locator(".row-title");
    const chip = await boxOf(row.locator(".pill-tag").first());
    const project = await boxOf(row.locator(".row-project"));
    expect([check.width, check.height]).toEqual([CHECK_BOX, CHECK_BOX]);
    expect(await row.getByRole("checkbox", { name: "Select A11-63" }).evaluate((box) => box.parentElement?.classList.contains("row-check"))).toBe(true);
    expect(Math.abs(priority.y + priority.height / 2 - (key.y + key.height / 2))).toBeLessThanOrEqual(2);
    expect(Math.abs(check.y + check.height / 2 - (key.y + key.height / 2))).toBeLessThanOrEqual(2);
    const line = await title.evaluate((element) => ({ size: getComputedStyle(element).fontSize, clamp: getComputedStyle(element).webkitLineClamp, top: element.getBoundingClientRect().top }));
    expect([line.size, line.clamp]).toEqual(["14px", "2"]);
    expect(line.top).toBeGreaterThanOrEqual(key.y + key.height);
    const long = await boxOf(page.locator('[data-key="A11-65"] .row-title'));
    // Two lines of 19px and the 4px under them: a title of three lines is cut at two.
    expect(long.height).toBe(42);
    expect(chip.y).toBeGreaterThan(line.top + 14);
    expect(Math.abs(project.y - chip.y)).toBeLessThanOrEqual(2);
    const all = await boxOf(page.locator(".section-head .row-check").first());
    expect([all.width, all.height]).toEqual([CHECK_BOX, CHECK_BOX]);
    await context.close();
  });

  it("fixes the selection bar 76px above the bottom with two tickets selected, and opens Run options as a bottom sheet", async () => {
    const { page, context } = await openAt(browser, site.origin, "/tickets", PHONE, { ready: rows });
    // A tap on the 40px square: the label's hit area lies over the box, as a finger's does.
    for (const key of ["A11-63", "A11-62"]) await page.locator(`[data-key="${key}"] .row-check`).tap();
    expect(await page.getByRole("checkbox", { name: "Select A11-63" }).isChecked()).toBe(true);
    const bar = page.getByRole("region", { name: "Queue selected tickets" });
    const box = await boxOf(bar);
    expect(await bar.evaluate((element) => getComputedStyle(element).position)).toBe("fixed");
    expect(PHONE.height - (box.y + box.height)).toBe(OVER_TAB_BAR);
    await bar.getByRole("button", { name: "Run options" }).click();
    await expectBottomSheet(page.getByRole("dialog", { name: "Run options" }));
    expect(await drawn(tabBar(page))).toBe(false);
    await context.close();
  });

  it("draws a status dot on the same line as its words while workers are paused", async () => {
    const tickets = await openAt(browser, site.origin, "/tickets", PHONE, { paused: true, ready: rows });
    const banner = tickets.page.getByRole("status").filter({ hasText: "Workers are paused" });
    const text = await boxOf(banner.locator(".status-banner-text"));
    const link = await boxOf(banner.getByRole("link", { name: "Start workers on Runs" }));
    expect(link.y).toBeGreaterThanOrEqual(text.y + text.height - 1);
    await tickets.context.close();
    const runs = await openAt(browser, site.origin, "/runs", PHONE, { paused: true, ready: runRows });
    const head = runs.page.locator(".pool-title").first();
    await head.filter({ hasText: "Workers paused" }).waitFor();
    const dot = await boxOf(head.locator(".pool-dot"));
    const words = await boxOf(head.locator(".pool-title-text"));
    expect(Math.abs(dot.y + dot.height / 2 - (words.y + words.height / 2))).toBeLessThanOrEqual(2);
    expect(dot.x + dot.width).toBeLessThanOrEqual(words.x);
    await runs.context.close();
  });
});
