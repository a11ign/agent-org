import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Browser, BrowserContext, Page } from "playwright-core";
import { captureName } from "../../src/ticket-mode/capture.ts";
import { HERE, PERSONAL, ticketsBoardStand, type InstanceAnswers, type Stand } from "./fixtures.ts";
import { serveInstance } from "./instance-routes.ts";
import { withWriter } from "./new-ticket/new-ticket-stand.ts";
import { overflowProblem, SCREENS, SCREENSHOT_DIR } from "./screenshots.ts";
import { launchBrowser, startSite, type Site } from "./site.ts";

// The Instance unreachable board over a stand-in SSH instance in Chromium: the last tickets beneath the alert, Check now, and the banner once it answers again.

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

const ROUTE = "/tickets";
const REFUSAL = "cannot reach personal over SSH: agents: Permission denied (publickey).";

/** The Tickets board's instance as an SSH connection that can be taken down, beside this machine's. */
function droppingStand(): { stand: Stand; link: { down: boolean } } {
  const base = ticketsBoardStand();
  const link = { down: false };
  const personal: InstanceAnswers = { ...base.instances!.personal, get queueFails() { return link.down ? { status: 502, error: REFUSAL } : undefined; } };
  return { stand: { connections: [HERE, PERSONAL], instances: { personal, here: base.instances!.personal } }, link };
}

/** The page on the SSH connection at `width`, with Backlog open as the board draws it, and the stand-in answering. */
async function opened(stand: Stand, width: number): Promise<{ page: Page; context: BrowserContext }> {
  const context = await browser.newContext({ viewport: { width, height: 900 } });
  await context.addInitScript(() => localStorage.setItem("ticket-mode.open", '["Backlog"]'));
  await serveInstance(context, withWriter({ stand }));
  const page = await context.newPage();
  await page.goto(`${site.origin}${ROUTE}?connection=personal`);
  await page.locator(".row").first().waitFor();
  return { page, context };
}

const opacityOfFirstRow = (page: Page) => page.locator(".row").first().evaluate((row) => getComputedStyle(row).opacity);
const countOfLastKnown = (page: Page) => page.getByText("Last known", { exact: true }).count();

/** The window gains focus, which makes the polls read at once. */
const refocus = (page: Page) => page.evaluate(() => window.dispatchEvent(new Event("focus")));

async function capture(page: Page, name: string, screen: (typeof SCREENS)[number]): Promise<void> {
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  const { scrollWidth, clientWidth } = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth }));
  expect(overflowProblem({ route: `${ROUTE}-${name}`, width: screen.width, scrollWidth, clientWidth })).toBeNull();
  mkdirSync(SCREENSHOT_DIR, { recursive: true });
  writeFileSync(join(SCREENSHOT_DIR, captureName(`${ROUTE}-${name}`, screen)), await page.screenshot({ fullPage: true }));
}

describe("the Instance unreachable board, built", () => {
  it.each(SCREENS)("draws the alert over the last tickets, then the reconnected banner after Check now, with no overflow at $width px", async (screen) => {
    const { stand, link } = droppingStand();
    const { page, context } = await opened(stand, screen.width);
    link.down = true;
    await refocus(page);
    const alert = page.getByRole("alert");
    await alert.waitFor();
    expect(await alert.textContent()).toContain(REFUSAL);
    expect(await alert.textContent()).toContain("The tickets below are the last ones it saw, and queueing is paused until it reconnects.");
    expect(await countOfLastKnown(page)).toBe(1);
    expect(await page.getByRole("button", { name: "Check now" }).isVisible()).toBe(true);
    expect(await page.getByRole("button", { name: "Switch to this machine" }).isVisible()).toBe(true);
    expect(await page.locator(".row").count()).toBe(25);
    expect(await page.locator(".row input[type=checkbox]:not(:disabled)").count()).toBe(0);
    expect(await page.getByRole("button", { name: "New ticket" }).isDisabled()).toBe(true);
    expect(await opacityOfFirstRow(page)).toBe("0.6");
    await capture(page, "unreachable", screen);
    link.down = false;
    await page.getByRole("button", { name: "Check now" }).click();
    await page.getByText("personal is reached over SSH again. Showing live tickets.").waitFor();
    expect(await page.getByRole("alert").count()).toBe(0);
    expect(await countOfLastKnown(page)).toBe(0);
    expect(await opacityOfFirstRow(page)).toBe("1");
    await capture(page, "reconnected", screen);
    await context.close();
  });
});
