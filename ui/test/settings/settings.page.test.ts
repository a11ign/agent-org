import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Browser, Page } from "playwright-core";
import { captureName } from "../../../src/ticket-mode/capture.ts";
import type { ViewConnection } from "../../src/api/types.ts";
import { boardSizedStand, HERE, PERSONAL, queueOf, type Stand } from "../fixtures.ts";
import { serveInstance } from "../instance-routes.ts";
import { overflowProblem, SCREENS } from "../screenshots.ts";
import { launchBrowser, startSite, UI_ROOT, type Site } from "../site.ts";
import { BOARD_FILES, modelsConfig, routeSettings, standOf as settingsOf, viewOf, type SettingsStand } from "./settings-stand.ts";

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
const CAPTURES = join(UI_ROOT, "captures", "settings");

const MODELS = "/settings/models";
const WORKERS = "/settings/workers";
const MACHINE = "/settings/machine";

/** An instance sized as the boards draw it (37 tickets, three runs running), on a connection, that offers models, a planner and a writer. */
function standOn(connection: ViewConnection, hold = false): Stand {
  const sized = boardSizedStand(connection);
  const instance = { ...sized.instances?.[connection.name], config: { ...modelsConfig(), viewer: { id: "u-me", name: "Me" }, pickDefault: "you" } as never };
  return { connections: [connection], instances: { [connection.name]: instance }, ...(hold ? { holdInstance: true } : {}) };
}

const RUNNING = queueOf("running", "running", "running", "queued").entries;

/** What the page does after it has opened, to reach a board's state; and the instance it opens against. */
type Board = Readonly<{
  name: string;
  /** What the screenshot is called: `settings-<file>-<W>x<H>.png`. */
  file: string;
  path: string;
  connection?: ViewConnection;
  hold?: boolean;
  state?: () => SettingsStand;
  drive?: (page: Page, state: SettingsStand) => Promise<void>;
}>;

const stateOf = (fields: Partial<SettingsStand> = {}): SettingsStand => settingsOf({ entries: RUNNING, ...fields });
const READY = (page: Page) => page.getByText("Host file", { exact: false }).first().waitFor();

/** Opens a path of the page and waits until its settings are drawn. */
async function opened(page: Page, path: string): Promise<void> {
  await page.goto(`${site.origin}${path}`);
  await READY(page);
  if (path === MODELS) await page.locator("#new-runs-model").waitFor();
}

const type = (page: Page, key: string, value: string) => page.getByLabel(key, { exact: true }).fill(value);

/** Stages `tickets.writer.model` on Models and the dangerous `tickets.drafts` on Workers, as the Edited and Review boards have them, and ends on `path`. */
async function stagedTwo(page: Page, path: string): Promise<void> {
  await opened(page, MODELS);
  await type(page, "tickets.writer.model", "sonnet");
  await opened(page, WORKERS);
  await page.getByLabel("tickets.drafts", { exact: true }).uncheck();
  if (path !== WORKERS) await opened(page, path);
}

const review = (page: Page) => page.getByRole("button", { name: "Review changes" }).click();

/** Opens Models, stages the writer's model and asks for the review of it. */
async function reviewingWriter(page: Page): Promise<void> {
  await opened(page, MODELS);
  await type(page, "tickets.writer.model", "sonnet");
  await review(page);
}

const BOARDS: readonly Board[] = [
  { name: "AtomautSettings", file: "models", path: MODELS },
  { name: "AtomautSettingsWorkers", file: "workers", path: WORKERS },
  { name: "AtomautSettingsMachine", file: "machine", path: MACHINE },
  { name: "AtomautSettingsLoading", file: "loading", path: MODELS, hold: true, drive: (page) => page.getByRole("status", { name: "Loading settings" }).waitFor() },
  { name: "AtomautSettingsEdited", file: "edited", path: MODELS, drive: async (page) => { await stagedTwo(page, WORKERS); await page.getByRole("region", { name: "Unsaved changes" }).waitFor(); } },
  {
    name: "AtomautSettingsReview", file: "review", path: MODELS,
    drive: async (page) => {
      await stagedTwo(page, MODELS);
      await review(page);
      await page.getByRole("dialog", { name: "Review changes" }).waitFor();
    },
  },
  {
    name: "AtomautSettingsSaved", file: "saved", path: MODELS,
    drive: async (page, state) => {
      await reviewingWriter(page);
      await page.getByRole("button", { name: "Save to host.json" }).click();
      state.view = () => viewOf({ ...BOARD_FILES, host: { ...BOARD_FILES.host, tickets: { ...(BOARD_FILES.host.tickets as object), writer: { run: "write", model: "sonnet" } } } });
      await page.getByText("Saved to host.json.").waitFor();
    },
  },
  {
    name: "AtomautSettingsRefused", file: "refused", path: MODELS,
    state: () => stateOf({ answers: { preview: () => ({ status: 400, error: "ticket mode: `tickets.plan` in the host file is not a regular expression: \"(PLAN\". Nothing was written." }) } }),
    drive: async (page) => {
      await reviewingWriter(page);
      await page.getByText("Not saved. The host file would be refused.").waitFor();
    },
  },
  {
    name: "AtomautSettingsConflict", file: "conflict", path: MODELS,
    drive: async (page, state) => {
      await reviewingWriter(page);
      await page.getByRole("button", { name: "Save to host.json" }).waitFor();
      state.base = "base-2";
      await page.getByRole("button", { name: "Save to host.json" }).click();
      await page.getByRole("button", { name: "Read the file again" }).waitFor();
    },
  },
  {
    name: "AtomautSettingsUnreachable", file: "unreachable", path: MODELS, connection: PERSONAL,
    drive: async (page, state) => {
      await opened(page, MODELS);
      state.viewFails = { status: 502, error: "cannot reach personal over SSH: agents: Permission denied (publickey)" };
      await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
      await page.getByText("Can't reach personal over SSH.").waitFor();
    },
  },
];

/** One board's state at one screen: opened, driven, measured for horizontal overflow, and written as `settings-<board>-<W>x<H>.png` in this page's captures. */
async function captured(board: Board, screen: (typeof SCREENS)[number]): Promise<void> {
  const state = board.state?.() ?? stateOf();
  const context = await browser.newContext({ viewport: screen, deviceScaleFactor: 1 });
  try {
    await serveInstance(context, { stand: standOn(board.connection ?? HERE, board.hold) });
    // The Loading board is every read still out, the settings' among them: a held instance answers none of them.
    if (board.hold !== true) await routeSettings(context, state);
    const page = await context.newPage();
    if (board.drive === undefined) await opened(page, board.path);
    else {
      await page.goto(`${site.origin}${board.path}`);
      await board.drive(page, state);
    }
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    const { scrollWidth, clientWidth } = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth }));
    expect(overflowProblem({ route: `${board.path} (${board.name})`, width: screen.width, scrollWidth, clientWidth })).toBeNull();
    mkdirSync(CAPTURES, { recursive: true });
    writeFileSync(join(CAPTURES, captureName(`settings-${board.file}`, screen)), await page.screenshot({ fullPage: true }));
  } finally {
    await context.close();
  }
}

describe("each of the ten boards' states, at 1440px and at 390px, with no horizontal overflow", () => {
  it.each(BOARDS)("$name", async (board) => {
    for (const screen of SCREENS) await captured(board, screen);
  });
});

describe("the page in Chromium, over the built site", () => {
  /** A page of the built site in a fresh context, its instance calls answered by the stand-ins. */
  async function open(path: string, { state = stateOf(), connection = HERE }: Readonly<{ state?: SettingsStand; connection?: ViewConnection }> = {}) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const asked = await serveInstance(context, { stand: standOn(connection) });
    const settingsAsked = await routeSettings(context, state);
    const page = await context.newPage();
    await opened(page, path);
    return { page, context, asked, settingsAsked, state };
  }

  it("saves a model on change with one /api/choice call carrying only that part, and says Saved beside it", async () => {
    const { page, context, settingsAsked } = await open(MODELS);
    await page.locator("#new-runs-model").selectOption("sonnet");
    await page.getByText("Saved", { exact: true }).waitFor();
    expect(settingsAsked.filter(({ method, path }) => method === "POST" && path.endsWith("/api/choice")).map(({ body }) => body)).toEqual([{ model: "sonnet" }]);
    expect(settingsAsked.some(({ path }) => path.endsWith("/api/settings/preview"))).toBe(false);
    await context.close();
  });

  it("goes from the sub-nav's Plugins entry to the Plugins page", async () => {
    const { page, context } = await open(WORKERS);
    await page.getByRole("navigation", { name: "Settings sections" }).getByRole("link", { name: "Plugins" }).click();
    await page.waitForURL("**/settings/plugins");
    expect(await page.getByRole("heading", { level: 1 }).textContent()).toBe("Plugins");
    await context.close();
  });

  it("keeps a staged change when the tab moves to another page of Settings", async () => {
    const { page, context } = await open(WORKERS);
    await type(page, "tickets.stallMinutes", "60");
    await page.getByRole("region", { name: "Unsaved changes" }).waitFor();
    await page.getByRole("navigation", { name: "Settings sections" }).getByRole("link", { name: "Machine" }).click();
    await page.waitForURL("**/settings/machine");
    await READY(page);
    expect(await page.getByRole("region", { name: "Unsaved changes" }).textContent()).toContain("1 unsaved change");
    await context.close();
  });

  it("reviews a dangerous key with its tick box, and saves it confirmed by name", async () => {
    const { page, context, settingsAsked } = await open(WORKERS);
    await page.getByLabel("tickets.drafts", { exact: true }).uncheck();
    await review(page);
    const dialog = page.getByRole("dialog", { name: "Review changes" });
    await dialog.waitFor();
    const save = dialog.getByRole("button", { name: "Save to host.json" });
    expect(await save.isDisabled()).toBe(true);
    await dialog.getByLabel("I am changing tickets.drafts").check();
    expect(await save.isDisabled()).toBe(false);
    await save.click();
    await page.getByText("Saved to host.json.").waitFor();
    expect(settingsAsked.filter(({ path }) => path.endsWith("/api/settings/save")).map(({ body }) => body)).toEqual([
      { file: "host.json", changes: [{ key: "tickets.drafts", value: false }], base: "base-1", confirmed: ["tickets.drafts"] },
    ]);
    await context.close();
  });

  it("is styled under the instance's policy, which allows inline styles only: the page is dark and its cards are drawn", async () => {
    const { page, context } = await open(WORKERS);
    const card = await page.locator(".settings-card").first().evaluate((element) => {
      const style = getComputedStyle(element);
      return { border: style.borderTopWidth, radius: style.borderTopLeftRadius, background: style.backgroundColor };
    });
    expect(card).toEqual({ border: "1px", radius: "10px", background: "rgb(17, 18, 22)" });
    await context.close();
  });
});
