// module: the screens of the responsive checks (A11-427) -- what each one opens and does before it is captured, the locators of the shell, and the measures the checks share
import type { Browser, Locator, Page } from "playwright-core";
import type { Size } from "../../../src/ticket-mode/capture.ts";
import { boxOf, drawn, openAt, PHONE, type Opened } from "./layout.ts";
import { DETAIL_KEY } from "./responsive-stand.ts";

export const rows = (page: Page) => page.locator("[data-key]").first().waitFor();
export const runRows = (page: Page) => page.locator(".run-row").first().waitFor();
export const bell = (page: Page) => page.getByRole("button", { name: /^Notifications, \d+$/ });
export const searchButton = (page: Page) => page.getByRole("button", { name: "Search tickets", exact: true });
export const tabBar = (page: Page) => page.locator(".tabs");
export const topBar = (page: Page) => page.getByRole("complementary", { name: "Atomaut" });
export const projectChip = (page: Page) => page.getByRole("group", { name: "Scope" }).getByRole("button", { name: /^Project/ });
export const scopeDialog = (page: Page) => page.getByRole("dialog", { name: "Project and goal" });

/**
 * A screen the checks capture: the page, what is done on it before the capture, what it has drawn once it is ready, and where its taps are checked: a screen with a dialog open checks the dialog's,
 * as the page's controls lie under its overlay.
 */
export type Screen = Readonly<{ name: string; route: string; ready: (page: Page) => Promise<unknown>; act?: (page: Page) => Promise<unknown>; taps?: string }>;

export const SCREENS: readonly Screen[] = [
  { name: "tickets", route: "/tickets", ready: rows },
  { name: "runs", route: "/runs", ready: runRows },
  { name: "run-detail", route: `/runs/${DETAIL_KEY}`, ready: (page) => page.getByRole("heading", { level: 1 }).filter({ hasText: "The fleet is split" }).waitFor() },
  {
    name: "new-ticket", route: "/tickets", ready: rows, taps: "[role=dialog]",
    act: async (page) => {
      await page.getByRole("button", { name: "New ticket" }).click();
      await page.getByRole("dialog", { name: "New ticket" }).waitFor();
    },
  },
  { name: "settings", route: "/settings/models", ready: (page) => page.locator("#new-runs-model").waitFor() },
  { name: "plugins", route: "/settings/plugins", ready: (page) => page.getByRole("button", { name: /^Publisher/ }).waitFor() },
  {
    // The sidebar's projects and goals are the desktop's own: the chips that open the sheet are drawn at 1024px and below.
    name: "tickets-scope", route: "/tickets", ready: rows, taps: "[role=dialog]",
    act: async (page) => {
      if (!(await drawn(projectChip(page)))) return;
      await projectChip(page).click();
      await scopeDialog(page).waitFor();
    },
  },
  {
    name: "notifications", route: "/tickets", ready: rows, taps: "[role=dialog]",
    act: async (page) => {
      await bell(page).click();
      await page.getByRole("dialog", { name: "Notifications" }).waitFor();
    },
  },
  {
    name: "search", route: "/tickets", ready: rows, taps: "[role=dialog]",
    act: async (page) => {
      await searchButton(page).click();
      await page.getByRole("combobox", { name: "Search tickets" }).fill("fleet");
      await page.getByRole("listbox", { name: "Matching tickets" }).getByRole("option").first().waitFor();
    },
  },
];

/** Opens `screen` at `size` on the site at `origin`, and does what it does before it is captured. */
export async function openScreenOf(browser: Browser, origin: string, { route, ready, act }: Screen, size: Size = PHONE): Promise<Opened> {
  const opened = await openAt(browser, origin, route, size, { ready });
  await act?.(opened.page);
  return opened;
}

/** Opens the screen named `name`, as `openScreenOf` does. */
export function openScreen(browser: Browser, origin: string, name: string, size: Size = PHONE): Promise<Opened> {
  const screen = SCREENS.find((candidate) => candidate.name === name);
  if (screen === undefined) throw new Error(`no screen is named ${name}`);
  return openScreenOf(browser, origin, screen, size);
}

/** The height of the top bar, which a strip under it hangs from. */
export const TOP_BAR = 57;
/** The tab bar's height, with no safe-area inset in Chromium. */
export const TAB_BAR = 64;
/** The smallest a tap may be. */
export const HIT_TARGET = 44;
/** How far a bar that stands over the tab bar is from the bottom of the screen. */
export const OVER_TAB_BAR = 76;
/** A checkbox's square on a tablet or a phone. */
export const CHECK_BOX = 40;
/** A phone's page padding. */
export const PHONE_PADDING = 16;

/** Fails unless `dialog` is a bottom sheet the phone's full width. */
export async function expectBottomSheet(dialog: Locator): Promise<void> {
  const sheet = await boxOf(dialog);
  expect([sheet.x, sheet.width, sheet.y + sheet.height]).toEqual([0, PHONE.width, PHONE.height]);
}

/** Fails unless `element` fills the phone's screen. */
export async function expectFullScreen(element: Locator): Promise<void> {
  const box = await boxOf(element);
  expect([box.x, box.y, box.width, box.height]).toEqual([0, 0, PHONE.width, PHONE.height]);
}

/** Scrolls the page and fails unless `strip` still hangs under the top bar. */
export async function expectStuckUnderBar(page: Page, strip: Locator): Promise<void> {
  await page.mouse.wheel(0, 600);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
  expect((await boxOf(strip)).y).toBe(TOP_BAR);
}

