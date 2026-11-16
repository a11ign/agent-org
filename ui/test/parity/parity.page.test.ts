import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Browser, BrowserContext, Page, Request } from "playwright-core";
import { serveInstance } from "../instance-routes.ts";
import { overflowProblem, SCREENS } from "../screenshots.ts";
import { launchBrowser, startSite, UI_ROOT, type Site } from "../site.ts";
import { BOARD_FILES, modelsConfig, routeSettings, standOf as settingsOf, viewOf } from "../settings/settings-stand.ts";
import { answerOf, pluginsSettings, routePlugins, standOf as pluginsOf } from "../plugins/plugins-stand.ts";
import { HERE, PERSONAL, ticket, type Stand } from "../fixtures.ts";
import {
  DELIVERY_KEY, DELIVERY_NOTES, detailOn, DONE_KEY, EVIDENCE, LONG_LINE, machineStand, machineView, notesStand, PROPOSING_KEY, proposing, QUEUED_KEY, queuedChanged, runsNoticesStand, TALKING_KEY, ticketsStand, WAITING_KEY,
} from "./parity-stand.ts";

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

// The features `ui.html` has that the boards do not draw (A11-220), over stand-in instances in Chromium: each captured at 1440px and at 390px, with no horizontal overflow.

/** Where the screenshots go: this ticket's own folder. */
const CAPTURES = join(UI_ROOT, "captures", "parity");

type Open = Readonly<{ page: Page; context: BrowserContext }>;
/** One state: where the page opens, the instance it opens against, the Settings or Plugins answers it also needs (`routes`), what says it is drawn, and what drives it there. */
type Scene = Readonly<{
  name: string; path: string; stand: () => Parameters<typeof serveInstance>[1]; routes?: (context: BrowserContext) => Promise<unknown>; ready: (page: Page) => Promise<void>; drive?: (page: Page) => Promise<void>;
}>;

const widthOf = (page: Page) => page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth }));

/** The `path` of the site in a new context at `width`, its instance calls answered by the scene's stand. */
async function open(scene: Scene, width: number): Promise<Open> {
  const context = await browser.newContext({ viewport: { width, height: 900 } });
  await context.addInitScript(() => localStorage.setItem("ticket-mode.open", JSON.stringify(["Backlog"])));
  await serveInstance(context, scene.stand());
  await scene.routes?.(context);
  const page = await context.newPage();
  await page.goto(`${site.origin}${scene.path}`);
  await scene.ready(page);
  await scene.drive?.(page);
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  return { page, context };
}

const openAll = (page: Page) => page.evaluate(() => document.querySelectorAll("details").forEach((node) => { node.open = true; }));

/** This machine's instance, offering models, as the Settings and Plugins pages read it. */
const machineWithModels = (): Parameters<typeof serveInstance>[1] => ({ stand: { ...machineStand(), instances: { here: { ...machineStand().instances?.here, config: modelsConfig() } } } });

/** How long the page is given to draw an answer that has ended, before a check says it drew nothing of it: well over one render, and far under a poll (5 s). */
const SETTLE_MS = 300;

/** What "Everything this run noted" lists on Run detail. */
const notedOf = (page: Page) => page.locator(".disclosure", { hasText: "Everything this run noted" }).textContent();

/** Run detail of each run of `notesStand` with every disclosure open (A11-446): the notes PARITY.md's run-card rows name, drawn whole. */
function noteScenes(): Scene[] {
  const detail = (name: string, key: string): Scene => ({
    name, path: `/runs/${key}`, stand: () => ({ stand: notesStand() }), ready: (page) => page.getByRole("region", { name: "More about this run" }).waitFor(), drive: openAll,
  });
  return [detail("run-detail-delivery-notes-open", DELIVERY_KEY), detail("run-detail-done-evidence-open", DONE_KEY), detail("run-detail-waiting-notes-open", WAITING_KEY), detail("run-detail-talking-notes-open", TALKING_KEY)];
}

/** The sentence the service refuses a connections file with. */
const CONNECTIONS_REFUSAL = "connections.json is not valid JSON: Unexpected token } at line 4";
/** What a proxy answers while the instance restarts. */
const RESTARTING = { status: 503, contentType: "application/json", body: JSON.stringify({ error: "the instance is restarting" }) };

/** Two instances whose tickets differ, so a page shows which one it read. */
const twoInstances = (): Stand => ({
  connections: [HERE, PERSONAL],
  instances: {
    here: { ...ticketsStand().instances?.personal, tickets: [ticket({ key: "A11-1", title: "A ticket on this machine" }), ticket({ key: "A11-2", title: "Another ticket on this machine" })] },
    personal: { ...ticketsStand().instances?.personal, tickets: [ticket({ key: "A11-9", title: "A ticket on personal", project: "elsewhere" })] },
  },
});

/** The shell's states (A11-446): the connections file refused, the quiet reconnecting line the poll and a focus read draw, and an old board's link sent on to the run it names on the instance it names. */
function shellScenes(): Scene[] {
  return [
    {
      name: "tickets-connections-refused", path: "/tickets", stand: () => ({ stand: { ...ticketsStand(), refusal: CONNECTIONS_REFUSAL } }),
      ready: (page) => page.getByRole("alert").filter({ hasText: CONNECTIONS_REFUSAL }).waitFor(),
    },
    {
      name: "runs-reconnecting", path: "/runs", stand: () => ({ stand: runsNoticesStand() }), ready: (page) => page.locator(".run-row").first().waitFor(),
      drive: async (page) => {
        await page.route("**/api/queue*", (route) => route.fulfill(RESTARTING));
        await page.evaluate(() => window.dispatchEvent(new Event("focus")));
        await page.getByRole("status").filter({ hasText: "Reconnecting…" }).waitFor();
      },
    },
    {
      name: "old-link-run", path: `/?connection=personal#run-${QUEUED_KEY}`, stand: () => ({ stand: { ...detailOn(queuedChanged), connections: [HERE, PERSONAL] } }),
      ready: (page) => page.getByRole("region", { name: "More about this run" }).waitFor(),
    },
  ];
}

/** A note the settings read carries, and the plugins read's note about a host file it refuses. */
const SETTINGS_NOTE = "project.json names no project: the Project rows show their defaults";
const PLUGINS_NOTE = "host.json could not be read (Unexpected end of JSON input), so the plugins are shown as their defaults";

/** Settings and Plugins states (A11-446): the settings read's notes, an instance older than the page, and the plugins read's host note. */
function settingsScenes(): Scene[] {
  const instance = machineWithModels;
  return [
    {
      name: "settings-models-notes", path: "/settings/models", stand: instance, routes: (context) => routeSettings(context, settingsOf({ view: () => viewOf({ ...BOARD_FILES, notes: [SETTINGS_NOTE] }) })),
      ready: (page) => page.getByText(SETTINGS_NOTE).waitFor(),
    },
    {
      name: "settings-older-instance", path: "/settings/models", stand: instance, routes: (context) => routeSettings(context, settingsOf({ viewFails: { status: 404, error: "no route /api/settings" } })),
      ready: (page) => page.getByRole("alert").waitFor(),
    },
    {
      name: "plugins-host-note", path: "/settings/plugins", stand: instance,
      routes: async (context) => {
        await routeSettings(context, pluginsSettings());
        await routePlugins(context, pluginsOf({ answer: () => answerOf({ note: PLUGINS_NOTE }) }));
      },
      ready: (page) => page.getByRole("status").filter({ hasText: PLUGINS_NOTE }).waitFor(),
    },
  ];
}

const SCENES: readonly Scene[] = [
  {
    name: "runs-notices-and-lists", path: "/runs", stand: () => ({ stand: runsNoticesStand() }),
    ready: (page) => page.getByRole("region", { name: "After-merge checks" }).waitFor(),
  },
  {
    name: "run-detail-queued-open", path: `/runs/${QUEUED_KEY}`, stand: () => ({ stand: detailOn(queuedChanged) }),
    ready: (page) => page.getByRole("region", { name: "More about this run" }).waitFor(), drive: openAll,
  },
  {
    name: "run-detail-proposal-open", path: `/runs/${PROPOSING_KEY}`, stand: () => ({ stand: detailOn(proposing) }),
    ready: (page) => page.getByRole("region", { name: "More about this run" }).waitFor(), drive: openAll,
  },
  {
    name: "tickets-held-and-labels", path: "/tickets", stand: () => ({ stand: ticketsStand() }),
    ready: (page) => page.locator("[data-key=A11-301]").waitFor(),
  },
  {
    name: "settings-machine-restore", path: "/settings/machine", stand: machineWithModels,
    routes: (context) => routeSettings(context, settingsOf({ view: machineView })),
    ready: (page) => page.getByRole("button", { name: "Restore the backup of host.json" }).waitFor(), drive: openAll,
  },
  ...noteScenes(),
  ...shellScenes(),
  ...settingsScenes(),
];

describe("the restored features, captured", () => {
  it.each(SCENES)("$name fits at 1440px and at 390px", async (scene) => {
    for (const screen of SCREENS) {
      const { page, context } = await open(scene, screen.width);
      try {
        await page.setViewportSize(screen);
        expect(overflowProblem({ route: `${scene.path} (${scene.name})`, width: screen.width, ...(await widthOf(page)) })).toBeNull();
        mkdirSync(CAPTURES, { recursive: true });
        writeFileSync(join(CAPTURES, `${scene.name}-${screen.width}x${screen.height}.png`), await page.screenshot({ fullPage: true }));
      } finally {
        await context.close();
      }
    }
  });

  it("draws the Runs notices above the pool bar and the lists below the runs", async () => {
    const { page, context } = await open(SCENES[0], 1440);
    const order = await page.evaluate(() => {
      const top = (selector: string) => (document.querySelector(selector) as HTMLElement).getBoundingClientRect().top;
      return [top(".status-banner"), top(".pool-bar"), top(".runs-list"), top("[aria-label='Pull requests']"), top("[aria-label='After-merge checks']")];
    });
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(await page.locator(".status-banner").count()).toBe(3);
    await context.close();
  });

  it("keeps a long unbroken diff line inside its disclosure at 390px", async () => {
    const { page, context } = await open(SCENES[1], 390);
    const body = page.locator(".disclosure-diff");
    expect(await body.textContent()).toContain(LONG_LINE);
    const box = await body.boundingBox();
    expect(box === null ? 0 : box.x + box.width).toBeLessThanOrEqual(390);
    await context.close();
  });

  it("wraps the label tags of a row inside it at 390px, and draws the Goal label once", async () => {
    const { page, context } = await open(SCENES[3], 390);
    expect(await page.locator("[data-key=A11-301] .label-tag").allTextContents()).toEqual(["Windows", "Bug", "x".repeat(60)]);
    const right = await page.locator("[data-key=A11-301] .label-tag").last().evaluate((element) => element.getBoundingClientRect().right);
    expect(right).toBeLessThanOrEqual(390);
    await context.close();
  });
});

describe("the states A11-446 designs, as their captures show them", () => {
  const sceneNamed = (name: string): Scene => {
    const found = SCENES.find((scene) => scene.name === name);
    if (found === undefined) throw new Error(`no scene ${name}`);
    return found;
  };

  it.each([
    { name: "run-detail-delivery-notes-open", lines: ["publishing off", ...Object.values(DELIVERY_NOTES)] },
    { name: "run-detail-done-evidence-open", lines: [...EVIDENCE] },
    {
      name: "run-detail-waiting-notes-open",
      lines: ["Waits on A11-9 (In Progress)", "Stacked on A11-97 #1960", "re-queued", "A11-98 #1961 lists only part of its changed files"],
    },
    {
      name: "run-detail-talking-notes-open",
      lines: ["Planned together with A11-99: answer in the batch's terminal", "it was marked crashed (its pane did not answer), but its worker carried on", "Started anyway: it overlapped A11-98 #1961 on src/board.ts"],
    },
  ])("$name lists each of its notes in Everything this run noted", async ({ name, lines }) => {
    const { page, context } = await open(sceneNamed(name), 1440);
    const noted = await notedOf(page);
    expect(lines.filter((line) => !(noted ?? "").includes(line))).toEqual([]);
    await context.close();
  });

  it("draws the reconnecting line quietly, with no red alert, when the queue read fails as a restart does", async () => {
    const { page, context } = await open(sceneNamed("runs-reconnecting"), 1440);
    expect(await page.getByRole("alert").count()).toBe(0);
    await context.close();
  });

  it("sends an old board's link on to the run it names, on the instance it names", async () => {
    const { page, context } = await open(sceneNamed("old-link-run"), 1440);
    expect(new URL(page.url()).pathname).toBe(`/runs/${QUEUED_KEY}`);
    expect(await page.getByLabel("Instance").inputValue()).toBe("personal");
    await context.close();
  });

  it("drops the answer that comes for the instance it switched from, and draws the one it switched to", async () => {
    for (const screen of SCREENS) {
      const context = await browser.newContext({ viewport: screen });
      try {
        await context.addInitScript(() => localStorage.setItem("ticket-mode.open", JSON.stringify(["Backlog"])));
        await serveInstance(context, { stand: twoInstances() });
        // This machine's tickets answer only once the switch has been made, as a slow read does.
        let release = (): void => undefined;
        const released = new Promise<void>((done) => { release = done; });
        await context.route("**/c/here/api/tickets*", async (route) => {
          await released;
          await route.fallback();
        });
        const page = await context.newPage();
        await page.goto(`${site.origin}/tickets`);
        // The page may abort the read it no longer wants, or let it finish and drop its answer: either way it ends, and nothing of it is drawn.
        const isHeres = (request: Request) => new URL(request.url()).pathname === "/c/here/api/tickets";
        const ended = Promise.race([page.waitForEvent("requestfinished", isHeres), page.waitForEvent("requestfailed", isHeres)]);
        await page.getByLabel("Instance").selectOption("personal");
        await page.locator("[data-key=A11-9]").waitFor();
        release();
        await ended;
        await page.evaluate((wait) => new Promise((done) => setTimeout(done, wait)), SETTLE_MS);
        expect(await page.locator("[data-key=A11-1], [data-key=A11-2]").count()).toBe(0);
        expect(await page.locator("[data-key=A11-9]").count()).toBe(1);
        await page.evaluate(() => document.fonts.ready.then(() => undefined));
        expect(overflowProblem({ route: "/tickets (tickets-other-instance-dropped)", width: screen.width, ...(await widthOf(page)) })).toBeNull();
        mkdirSync(CAPTURES, { recursive: true });
        writeFileSync(join(CAPTURES, `tickets-other-instance-dropped-${screen.width}x${screen.height}.png`), await page.screenshot({ fullPage: true }));
      } finally {
        await context.close();
      }
    }
  });
});
