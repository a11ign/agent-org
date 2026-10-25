import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Browser } from "playwright-core";
import { captureName } from "../../../src/ticket-mode/capture.ts";
import { boardSizedStand, HERE, type Stand } from "../fixtures.ts";
import { serveInstance } from "../instance-routes.ts";
import { overflowProblem, SCREENS } from "../screenshots.ts";
import { modelsConfig, routeSettings, standOf as settingsOf } from "../settings/settings-stand.ts";
import { launchBrowser, startSite, UI_ROOT, type Site } from "../site.ts";
import { answerOf, claudePlugin, failing, routePlugins, standOf as pluginsOf, type PluginsStand } from "./plugins-stand.ts";

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

const stand = (): Stand => {
  const sized = boardSizedStand(HERE);
  return { connections: [HERE], instances: { here: { ...sized.instances?.here, config: { ...modelsConfig(), viewer: { id: "u-me", name: "Me" }, pickDefault: "you" } as never } } };
};

/** The one failing check and the one Claude plugin whose contract names a connector tickets.connectors does not allow: the board's two. */
const ONE_FAILING: PluginsStand = pluginsOf({ answer: () => answerOf({ checks: { linear: [failing("token", "no token", "run agent-org doctor")] } }) });
const NOTHING_WRONG: PluginsStand = pluginsOf({ answer: () => answerOf({ claude: { readable: true, plugins: [claudePlugin()] } }) });

/** A Settings page in a fresh context at `screen`, its instance and plugin calls answered by the stand-ins, and the badge of its Plugins link. */
async function sidebarBadge(path: string, plugins: PluginsStand, screen: (typeof SCREENS)[number]) {
  const context = await browser.newContext({ viewport: screen, deviceScaleFactor: 1 });
  try {
    await serveInstance(context, { stand: stand() });
    await routeSettings(context, settingsOf());
    const asked = await routePlugins(context, plugins);
    const page = await context.newPage();
    await page.goto(`${site.origin}${path}`);
    await page.getByText("Host file", { exact: false }).first().waitFor();
    await page.waitForLoadState("networkidle");
    const link = page.getByRole("navigation", { name: "Settings sections" }).getByRole("link", { name: /^Plugins/ });
    const { scrollWidth, clientWidth } = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth }));
    const badge = link.locator(".attention-badge");
    const shown = await badge.count();
    const color = shown === 0 ? null : await badge.evaluate((element) => getComputedStyle(element).color);
    return { text: (await link.textContent()) ?? "", shown, color, asked, fit: { route: path, width: screen.width, scrollWidth, clientWidth }, png: await page.screenshot({ fullPage: true }) };
  } finally {
    await context.close();
  }
}

describe("the Plugins badge in Chromium, over the built site", () => {
  it.each(["/settings/models", "/settings/workers", "/settings/machine"])("%s shows '1 needs attention' on the Plugins link at 1440px and 390px with no horizontal overflow, with one /api/plugins request", async (path) => {
    for (const screen of SCREENS) {
      const seen = await sidebarBadge(path, ONE_FAILING, screen);
      expect(seen.text).toBe("Plugins 1 needs attention");
      expect(seen.asked).toHaveLength(1);
      expect(overflowProblem(seen.fit)).toBeNull();
      expect(seen.color).toBe("rgb(227, 179, 65)");
      if (path.endsWith("/models")) {
        mkdirSync(CAPTURES, { recursive: true });
        writeFileSync(join(CAPTURES, captureName("plugins-badge", screen)), seen.png);
      }
    }
  });

  it("shows no badge when every plugin is whole", async () => {
    const seen = await sidebarBadge("/settings/models", NOTHING_WRONG, SCREENS[0]);
    expect([seen.text, seen.shown]).toEqual(["Plugins", 0]);
  });

  it("shows no badge when the plugins cannot be read", async () => {
    const seen = await sidebarBadge("/settings/models", pluginsOf({ fails: { status: 500, error: "the doctor checks fell over" } }), SCREENS[0]);
    expect([seen.text, seen.shown]).toEqual(["Plugins", 0]);
  });
});
