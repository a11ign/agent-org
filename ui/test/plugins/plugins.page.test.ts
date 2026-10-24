import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Browser, Page } from "playwright-core";
import { captureName } from "../../../src/ticket-mode/capture.ts";
import type { MessagingState } from "../../../src/plugins/view.ts";
import type { ViewConnection } from "../../src/api/types.ts";
import { boardSizedStand, HERE, PERSONAL, type Stand } from "../fixtures.ts";
import { serveInstance } from "../instance-routes.ts";
import { overflowProblem, SCREENS } from "../screenshots.ts";
import { modelsConfig, routeSettings, type SettingsStand } from "../settings/settings-stand.ts";
import { launchBrowser, startSite, UI_ROOT, type Site } from "../site.ts";
import { a11ign, answerOf, BOARD_HOST, failing, pluginsSettings, routePlugins, standOf as pluginsOf, type PluginsStand } from "./plugins-stand.ts";

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
const CAPTURES = join(UI_ROOT, "captures", "plugins");

const PATH = "/next/settings/plugins";

/** An instance sized as the boards' (37 tickets, three runs running) on a connection. */
function standOn(connection: ViewConnection): Stand {
  const sized = boardSizedStand(connection);
  const instance = { ...sized.instances?.[connection.name], config: { ...modelsConfig(), viewer: { id: "u-me", name: "Me" }, pickDefault: "you" } as never };
  return { connections: [connection], instances: { [connection.name]: instance } };
}

/** The host the boards' instance has: the three providers of a fresh machine, Slack as the publisher, the reviewer on, Tailscale exposed, and Telegram as the project's messaging. */
const BOARD_PLUGINS_HOST = { tickets: { ...BOARD_HOST.tickets, providers: { ...BOARD_HOST.tickets.providers, publish: { provider: "slack", enabled: true }, reviewer: { provider: "atomic", enabled: true } } } };
const TELEGRAM: MessagingState = { provider: "telegram", enabled: true, settings: {} };
const UNPAIRED = { telegram: [failing("messaging (telegram)", "The chairman has not paired, so nothing can be sent or asked.", "agent-org messaging:pair")] };
/** The Claude plugin of the boards, whose connector the host does not allow. */
const CONNECTOR_NOT_ALLOWED = a11ign({
  rows: [{ plugin: "a11ign@applied-ai", kind: "connector-need", why: "a11ign@applied-ai needs the connector tools matched by ^mcp__linear__(get|list|search|extract)_, which tickets.connectors does not allow: add the pattern to tickets.connectors." }],
});

/** The plugins of the first board: one failing check and one Claude plugin with an unmet need, so the badge counts two. */
const withAttention = (): PluginsStand => pluginsOf({ answer: () => answerOf({ host: BOARD_PLUGINS_HOST, messaging: TELEGRAM, checks: UNPAIRED, claude: { readable: true, plugins: [CONNECTOR_NOT_ALLOWED] } }) });

type Board = Readonly<{
  name: string;
  /** What the screenshot is called: `plugins-<file>-<W>x<H>.png`. */
  file: string;
  connection?: ViewConnection;
  plugins?: () => PluginsStand;
  drive?: (page: Page, plugins: PluginsStand, settings: SettingsStand) => Promise<void>;
}>;

/** Waits until the plugins are drawn: the tabs are on the Loading board too, so a card is what says they are read. */
const ready = (page: Page) => page.getByRole("region", { name: "Tracker" }).waitFor();
const open = (page: Page, name: string) => page.getByRole("button", { name: new RegExp(`^${name}`) }).click();
/** Opens a concern's card and presses the control that asks first, to reach the dialog of `heading`. */
async function askedBy(page: Page, concern: string, control: ReturnType<Page["getByRole"]>, heading: string) {
  await ready(page);
  await open(page, concern);
  await control.click();
  await page.getByRole("dialog", { name: heading }).waitFor();
}
const publisherDisable = async (page: Page) => {
  await open(page, "Publisher");
  await page.getByRole("button", { name: "Disable slack" }).click();
};

const BOARDS: readonly Board[] = [
  { name: "AtomautPlugins", file: "ready" },
  { name: "AtomautPluginsLoading", file: "loading", plugins: () => pluginsOf({ ...withAttention(), hold: true }), drive: (page) => page.getByRole("status", { name: "Loading plugins" }).waitFor() },
  {
    name: "AtomautPluginsUnknown", file: "unknown", connection: PERSONAL,
    drive: async (page, plugins) => {
      await ready(page);
      plugins.queueFails = { status: 502, error: "cannot reach personal over SSH: agents: Permission denied (publickey)" };
      await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
      await page.getByText("Plugin health is unknown.").waitFor();
    },
  },
  {
    name: "AtomautPluginsConfirm", file: "confirm",
    drive: (page) => askedBy(page, "Publisher", page.getByRole("button", { name: "Uninstall slack" }), "Uninstall slack?"),
  },
  {
    name: "AtomautPluginsReplace", file: "replace",
    drive: (page) => askedBy(page, "Exposure", page.getByRole("radio", { name: /^local/ }), "Switch the exposure to another plugin?"),
  },
  {
    name: "AtomautPluginsApplied", file: "applied",
    plugins: () => pluginsOf({ ...withAttention(), action: () => ({ said: "disabled slack: nothing is published, and its settings are kept for `enable`", changed: true, inForce: ["in force after the board restarts: ticket:serve and ticket:ui."], backup: "/home/agents/.agent-org/host.json.bak" }) }),
    drive: async (page) => {
      await ready(page);
      await publisherDisable(page);
      await page.getByText("Nothing is published", { exact: false }).waitFor();
    },
  },
  {
    name: "AtomautPluginsRefused", file: "refused",
    plugins: () => pluginsOf({ ...withAttention(), action: () => ({ status: 400, error: "the host file is refused, so no plugin can be changed: ticket mode: `tickets.workers` in the host file must be a whole number of 1 or more, not 0." }) }),
    drive: async (page) => {
      await ready(page);
      await publisherDisable(page);
      await page.getByText("Nothing was changed.").waitFor();
    },
  },
  {
    name: "AtomautPluginsConflict", file: "conflict",
    drive: async (page, plugins) => {
      await ready(page);
      plugins.base = "base-2";
      await publisherDisable(page);
      await page.getByRole("button", { name: "Read the plugins again" }).waitFor();
    },
  },
  {
    name: "Plugins: the Claude plugins tab", file: "claude",
    drive: async (page) => {
      await ready(page);
      await page.getByRole("tab", { name: /^Claude plugins/ }).click();
      await page.getByRole("region", { name: "a11ign" }).waitFor();
    },
  },
];

/** One board's state at one screen: opened, driven, measured for horizontal overflow, and written as `plugins-<state>-<W>x<H>.png` in this page's captures. */
async function captured(board: Board, screen: (typeof SCREENS)[number]): Promise<void> {
  const plugins = board.plugins?.() ?? withAttention();
  const settings = pluginsSettings();
  const context = await browser.newContext({ viewport: screen, deviceScaleFactor: 1 });
  try {
    await serveInstance(context, { stand: standOn(board.connection ?? HERE) });
    await routeSettings(context, settings);
    await routePlugins(context, plugins);
    const page = await context.newPage();
    await page.goto(`${site.origin}${PATH}`);
    await (board.drive?.(page, plugins, settings) ?? ready(page));
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    const { scrollWidth, clientWidth } = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth }));
    expect(overflowProblem({ route: `${PATH} (${board.name})`, width: screen.width, scrollWidth, clientWidth })).toBeNull();
    mkdirSync(CAPTURES, { recursive: true });
    writeFileSync(join(CAPTURES, captureName(`plugins-${board.file}`, screen)), await page.screenshot({ fullPage: true }));
  } finally {
    await context.close();
  }
}

describe("each of the eight boards' states, and the Claude plugins tab, at 1440px and at 390px, with no horizontal overflow", () => {
  it.each(BOARDS)("$name", async (board) => {
    for (const screen of SCREENS) await captured(board, screen);
  });
});

