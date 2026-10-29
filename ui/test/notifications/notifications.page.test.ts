import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Browser, BrowserContext, Page } from "playwright-core";
import { captureName } from "../../../src/ticket-mode/capture.ts";
import { serveInstance } from "../instance-routes.ts";
import { RUNS, REQUEST, writingStand, type Run } from "../new-ticket/new-ticket-stand.ts";
import { overflowProblem, SCREENS } from "../screenshots.ts";
import { launchBrowser, startSite, UI_ROOT, type Site } from "../site.ts";

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
const CAPTURES = join(UI_ROOT, "captures", "notifications");
const [DESKTOP, PHONE] = SCREENS;

const finished = (fields: Partial<Run>, minutesAgo: number): Run => ({ ...RUNS.done, ...fields, finishedAt: Date.now() - minutesAgo * 60_000 }) as Run;

/** The requests the Notifications boards list: the Done and Failed ones of the board, a long one, and the failures the writer gave. */
const LISTED: readonly Run[] = [
  finished({ id: "n1", request: "Follow-up to A11-179: its after-merge check failed. The check: on the next board release, a run whose pull request is unreviewed or red no longer reads Ready to merge." }, 14),
  finished({ id: "n2", request: "Follow-up to A11-199: its after-merge check failed. The check: one Quick ticket and one Grill ticket written from the dialog on the agents host, one of them placed manually." }, 60),
  { ...RUNS.failed, id: "n3", failure: "A11-314 could not be read from the tracker: fetch failed", finishedAt: Date.now() - 120 * 60_000 } as Run,
];

type Opened = Readonly<{ page: Page; context: BrowserContext; view: { runs: Run[] } }>;

/** A page of the board at `width` over a machine that writes tickets whose writer lists `runs`; a dismiss or Clear all removes what it names from them. */
async function open(runs: readonly Run[], route = "/tickets", width = DESKTOP.width): Promise<Opened> {
  const stand = writingStand({
    runs,
    post: (path, body) => {
      const one = /\/api\/writer\/([^/]+)\/dismiss$/.exec(path);
      if (one !== null) stand.view.runs = stand.view.runs.filter((run) => run.id !== one[1]);
      if (path === "/api/writer/dismiss-finished") stand.view.runs = stand.view.runs.filter((run) => run.phase !== "finished" || !(body as { ids: string[] }).ids.includes(run.id));
      return { runs: stand.view.runs };
    },
  });
  const context = await browser.newContext({ viewport: { width, height: width === DESKTOP.width ? DESKTOP.height : PHONE.height }, deviceScaleFactor: 1 });
  await context.addInitScript(() => localStorage.setItem("ticket-mode.open", '["Backlog"]'));
  await serveInstance(context, { stand });
  const page = await context.newPage();
  await page.goto(`${site.origin}${route}`);
  // The bell is in the static page: it is the page's own once it counts the finished requests, which are read after the page has hydrated.
  await page.getByRole("button", { name: `Notifications, ${runs.filter(({ phase }) => phase === "finished").length}`, exact: true }).waitFor();
  return { page, context, view: stand.view };
}

const bell = (page: Page) => page.getByRole("button", { name: /^Notifications, \d+$/ });
const panel = (page: Page) => page.getByRole("dialog", { name: "Notifications" });
const fit = (page: Page) => page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth }));

async function capture(page: Page, name: string, screen: (typeof SCREENS)[number]): Promise<void> {
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  mkdirSync(CAPTURES, { recursive: true });
  writeFileSync(join(CAPTURES, captureName(`notifications-${name}`, screen)), await page.screenshot({ fullPage: true }));
}

describe("the panel, in Chromium", () => {
  it("opens from the bell on the Settings page without leaving it, under the sidebar header", async () => {
    const { page, context } = await open(LISTED.slice(0, 1), "/settings");
    await bell(page).click();
    await panel(page).waitFor();
    expect(new URL(page.url()).pathname).toContain("settings");
    const bellBox = await bell(page).boundingBox();
    const panelBox = await panel(page).boundingBox();
    expect(panelBox?.y).toBeGreaterThan((bellBox?.y ?? 0) + (bellBox?.height ?? 0));
    expect(panelBox?.width).toBe(420);
    await context.close();
  });

  it("fits a window 390px wide: no wider than the window less 24px, and the page does not scroll sideways", async () => {
    const { page, context } = await open(LISTED, "/tickets", PHONE.width);
    await bell(page).click();
    await panel(page).waitFor();
    const box = await panel(page).boundingBox();
    expect(box?.width).toBeLessThanOrEqual(PHONE.width - 24);
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(PHONE.width);
    const { scrollWidth, clientWidth } = await fit(page);
    expect(overflowProblem({ route: "/tickets with the panel open", width: PHONE.width, scrollWidth, clientWidth })).toBeNull();
    await context.close();
  });

  it("shows a visible focus ring on every control as the person tabs through it", async () => {
    const { page, context } = await open(LISTED);
    await bell(page).focus();
    await page.keyboard.press("Enter");
    await panel(page).waitFor();
    const reached: string[] = [];
    for (let step = 0; step < 14; step++) {
      await page.keyboard.press("Tab");
      const state = await page.evaluate(() => {
        const element = document.activeElement as HTMLElement;
        const inside = element.closest("[role=dialog]") !== null;
        const style = getComputedStyle(element);
        return { inside, name: element.getAttribute("aria-label") ?? element.textContent?.trim() ?? "", ring: style.outlineStyle !== "none" && parseFloat(style.outlineWidth) > 0 };
      });
      if (!state.inside) continue;
      expect(state.name).not.toBe("");
      expect(state.ring).toBe(true);
      reached.push(state.name);
    }
    expect(reached).toContain("Clear all");
    expect(reached).toContain("Clear notification: done, 14 min ago");
    await context.close();
  });

  it("closes on Escape with the focus on the bell", async () => {
    const { page, context } = await open(LISTED);
    await bell(page).click();
    await panel(page).getByRole("button", { name: "Clear all" }).focus();
    await page.keyboard.press("Escape");
    expect(await panel(page).count()).toBe(0);
    expect(await bell(page).evaluate((element) => element === document.activeElement)).toBe(true);
    await context.close();
  });

  it("keeps a cleared request gone after a reload", async () => {
    const { page, context } = await open(LISTED);
    await bell(page).click();
    await panel(page).getByRole("button", { name: "Clear notification: done, 14 min ago" }).click();
    await page.getByRole("button", { name: "Notifications, 2" }).waitFor();
    await page.reload();
    await page.getByRole("button", { name: "Notifications, 2" }).waitFor();
    await context.close();
  });
});

type Board = Readonly<{ name: string; file: string; runs: readonly Run[]; drive: (page: Page, view: { runs: Run[] }) => Promise<void> }>;

/** Reads the requests again, as the poll does every 5 s. */
const readAgain = (page: Page) => page.evaluate(() => window.dispatchEvent(new Event("focus")));

const BOARDS: readonly Board[] = [
  { name: "AtomautTicketsNotifications", file: "all", runs: LISTED, drive: async (page) => { await bell(page).click(); await panel(page).waitFor(); } },
  {
    name: "AtomautTicketsNotificationsFailed", file: "failed", runs: LISTED,
    drive: async (page) => { await bell(page).click(); await panel(page).getByRole("button", { name: /^Failed/ }).click(); await panel(page).getByText("A11-314 could not be read", { exact: false }).waitFor(); },
  },
  {
    name: "AtomautTicketsNotificationsEmpty", file: "empty", runs: LISTED,
    drive: async (page) => { await bell(page).click(); await panel(page).getByRole("button", { name: "Clear all" }).click(); await panel(page).getByText("You are all caught up").waitFor(); },
  },
  {
    name: "AtomautNewTicketDone", file: "just-done", runs: [...LISTED, { ...RUNS.writing, id: "nx", request: REQUEST } as Run],
    drive: async (page, view) => {
      await page.getByRole("region", { name: "New ticket request" }).waitFor();
      view.runs = view.runs.map((run) => (run.id === "nx" ? ({ ...RUNS.done, id: "nx", request: REQUEST, finishedAt: Date.now() } as Run) : run));
      await readAgain(page);
      await panel(page).getByText("New", { exact: true }).waitFor();
    },
  },
  {
    name: "AtomautNewTicketFailed", file: "just-failed", runs: [...LISTED, { ...RUNS.writing, id: "nx", request: REQUEST } as Run],
    drive: async (page, view) => {
      await page.getByRole("region", { name: "New ticket request" }).waitFor();
      view.runs = view.runs.map((run) => (run.id === "nx" ? ({ ...RUNS.failed, id: "nx", finishedAt: Date.now() }) : run) as Run);
      await readAgain(page);
      await panel(page).getByText("New", { exact: true }).waitFor();
    },
  },
];

describe("the boards fit at 1440px and at 390px", () => {
  it.each(BOARDS)("$name", async (board) => {
    for (const screen of SCREENS) {
      const { page, context, view } = await open(board.runs, "/tickets", screen.width);
      try {
        await board.drive(page, view);
        const { scrollWidth, clientWidth } = await fit(page);
        expect(overflowProblem({ route: board.name, width: screen.width, scrollWidth, clientWidth })).toBeNull();
        await capture(page, board.file, screen);
      } finally {
        await context.close();
      }
    }
  });
});
