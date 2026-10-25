import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Browser, BrowserContext, Page } from "playwright-core";
import { captureName } from "../../../src/ticket-mode/capture.ts";
import { serveInstance, type Asked } from "../instance-routes.ts";
import { overflowProblem, SCREENS } from "../screenshots.ts";
import { launchBrowser, startSite, UI_ROOT, type Site } from "../site.ts";
import { REQUEST, RUNS, writingStand, type Run, type Writing } from "./new-ticket-stand.ts";

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

/** Where the screenshots go, beside the page's checks: this page's own folder. */
const CAPTURES = join(UI_ROOT, "captures", "new-ticket");
const TICKETS = "/tickets";

type Opened = Readonly<{ page: Page; asked: Asked; context: BrowserContext; view: { runs: Run[] } }>;

/** The Tickets page at `screen`'s width over a machine that writes tickets, with Backlog open as the boards draw it. `hold` leaves a post to /api/writer unanswered. */
async function open(writing: Writing = {}, width = 1440, hold = false): Promise<Opened> {
  const stand = writingStand(writing);
  const context = await browser.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: 1 });
  await context.addInitScript(() => localStorage.setItem("ticket-mode.open", '["Backlog"]'));
  const asked = await serveInstance(context, { stand });
  if (hold) await context.route("**/api/writer", (route) => (route.request().method() === "POST" ? undefined : route.fallback()));
  const page = await context.newPage();
  await page.goto(`${site.origin}${TICKETS}`);
  await page.locator(".row").first().waitFor();
  return { page, asked, context, view: stand.view };
}

const dialog = (page: Page) => page.getByRole("dialog", { name: "New ticket" });
const request = (page: Page) => dialog(page).getByLabel("What is the ticket for?");
const write = (page: Page) => dialog(page).getByRole("button", { name: /^(Write ticket|Sending…)$/ });
const posted = (asked: Asked) => asked.requests.filter(({ method, path }) => method === "POST" && path.endsWith("/api/writer")).map(({ body }) => body);

async function openDialog(page: Page): Promise<void> {
  await page.getByRole("button", { name: "New ticket" }).click();
  await dialog(page).waitFor();
}

/** Opens the dialog, writes the request, and sets Manual placement's choices by their labels. */
async function fillManual(page: Page, choices: Readonly<Record<string, string>>): Promise<void> {
  await openDialog(page);
  await request(page).fill(REQUEST);
  await dialog(page).getByRole("radio", { name: "Manual" }).click();
  for (const [label, value] of Object.entries(choices)) {
    const field = dialog(page).getByLabel(new RegExp(`^${label}`));
    await (label === "Parent" ? field.fill(value) : field.selectOption(value));
  }
}

describe("the dialog, in Chromium", () => {
  it("opens from New ticket, takes the focus in, and closes on Escape with the focus back on the button", async () => {
    const { page, context } = await open();
    await openDialog(page);
    expect(await request(page).evaluate((element) => element === document.activeElement)).toBe(true);
    await page.keyboard.press("Escape");
    expect(await dialog(page).count()).toBe(0);
    expect(await page.getByRole("button", { name: "New ticket" }).evaluate((element) => element === document.activeElement)).toBe(true);
    await context.close();
  });

  it("places a ticket manually end to end: the five choices are posted as given and the request is in the strip", async () => {
    const { page, asked, context } = await open({ post: "accepting" });
    await fillManual(page, { Project: "agent-org", Repository: "a11ign", Goal: "Fleet", Priority: "low", Parent: "A11-24" });
    await write(page).click();
    const strip = page.getByRole("region", { name: "New ticket request" });
    await strip.waitFor();
    expect(await dialog(page).count()).toBe(0);
    expect(posted(asked)).toEqual([{ request: REQUEST, mode: "quick", placement: "manual", project: "agent-org", repo: "a11ign", goal: "Fleet", priority: "low", parent: "A11-24" }]);
    expect(await strip.locator(".run-label").textContent()).toBe("Queued");
    await context.close();
  });

  it("is refused: the server's sentence, 'Your request is still here.', and everything entered kept", async () => {
    const sentence = "this machine names no tickets.writer, so it writes no tickets: name one in the host file";
    const { page, context } = await open({ post: () => ({ status: 400, error: sentence }) });
    await fillManual(page, { Project: "agent-org" });
    await write(page).click();
    const alert = dialog(page).getByRole("alert");
    await alert.waitFor();
    expect(await alert.textContent()).toBe(`Not sent. ${sentence}. Your request is still here.`);
    expect(await request(page).inputValue()).toBe(REQUEST);
    expect(await dialog(page).getByLabel("Project").inputValue()).toBe("agent-org");
    await context.close();
  });
});

/** What a board draws: the page it is on, and what the page does after it has opened to reach the state. */
type Board = Readonly<{ name: string; file: string; writing?: Writing; hold?: boolean; drive: (page: Page) => Promise<void> }>;

const fillRequest = async (page: Page) => {
  await openDialog(page);
  await request(page).fill(REQUEST);
};
const stripShows = (label: string) => (page: Page) => page.getByRole("region", { name: "New ticket request" }).getByText(label, { exact: true }).waitFor();

const BOARDS: readonly Board[] = [
  { name: "AtomautNewTicket", file: "form", drive: fillRequest },
  { name: "AtomautNewTicketSubmitting", file: "submitting", hold: true, writing: { post: "accepting" }, drive: async (page) => { await fillRequest(page); await write(page).click(); await write(page).getByText("Sending…").waitFor(); } },
  {
    name: "AtomautNewTicketError", file: "error", writing: { post: () => ({ status: 400, error: "this machine names no tickets.writer, so it writes no tickets: name one in the host file" }) },
    drive: async (page) => { await fillRequest(page); await write(page).click(); await dialog(page).getByRole("alert").waitFor(); },
  },
  { name: "AtomautNewTicketNoTerminal", file: "noterminal", writing: { config: { writerGrill: false } }, drive: fillRequest },
  { name: "AtomautNewTicketManual", file: "manual", drive: async (page) => { await fillRequest(page); await dialog(page).getByRole("radio", { name: "Manual" }).click(); } },
  { name: "AtomautNewTicketQueued", file: "queued", writing: { runs: [RUNS.queued] }, drive: stripShows("Queued") },
  { name: "AtomautNewTicketWriting", file: "writing", writing: { runs: [RUNS.writing] }, drive: stripShows("Writing") },
  { name: "AtomautNewTicketWaiting", file: "waiting", writing: { runs: [RUNS.waiting] }, drive: stripShows("Waiting for you") },
  { name: "AtomautNewTicketDone", file: "done", writing: { runs: [RUNS.done] }, drive: stripShows("Done") },
  { name: "AtomautNewTicketFailed", file: "failed", writing: { runs: [RUNS.failed] }, drive: stripShows("Failed") },
];

/** One board at one screen: driven to its state, measured for horizontal overflow, and written as `new-ticket-<board>-<W>x<H>.png` in this page's captures. */
async function captured(board: Board, screen: (typeof SCREENS)[number]): Promise<void> {
  const { page, context } = await open(board.writing, screen.width, board.hold);
  try {
    await board.drive(page);
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    const { scrollWidth, clientWidth } = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth }));
    expect(overflowProblem({ route: `${board.name}`, width: screen.width, scrollWidth, clientWidth })).toBeNull();
    const box = (await dialog(page).count()) === 0 ? null : await dialog(page).boundingBox();
    if (box !== null) {
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(screen.width);
    }
    mkdirSync(CAPTURES, { recursive: true });
    writeFileSync(join(CAPTURES, captureName(`new-ticket-${board.file}`, screen)), await page.screenshot({ fullPage: true }));
  } finally {
    await context.close();
  }
}

describe("the ten boards fit at 1440px and at 390px", () => {
  it.each(BOARDS)("$name", async (board) => {
    for (const screen of SCREENS) await captured(board, screen);
  });
});
