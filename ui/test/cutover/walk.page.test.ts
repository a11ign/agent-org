import type { Browser } from "playwright-core";
import { boardSizedStand, HERE, type Stand } from "../fixtures.ts";
import { serveInstance } from "../instance-routes.ts";
import { modelsConfig, routeSettings, standOf as settingsOf } from "../settings/settings-stand.ts";
import { launchBrowser, startSite, type Site } from "../site.ts";

// WHAT THE CANVAS WALK OF A11-202 FOUND AND FIXED IN CHROMIUM: each is a difference of a page from its board that a component check in a DOM cannot see (a stylesheet's order, a width).
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

const standOn = (): Stand => {
  const sized = boardSizedStand(HERE);
  return { connections: [HERE], instances: { here: { ...sized.instances?.here, config: { ...modelsConfig(), viewer: { id: "u-me", name: "Me" }, pickDefault: "you" } as never } } };
};

describe("the Settings: refused by the readers board", () => {
  it("draws its heading and its sentence at the left of the banner, with the key as code", async () => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await serveInstance(context, { stand: standOn() });
    await routeSettings(context, settingsOf({ answers: { preview: () => ({ status: 400, error: "ticket mode: `tickets.plan` in the host file is not a regular expression: \"(PLAN\". Nothing was written." }) } }));
    const page = await context.newPage();
    await page.goto(`${site.origin}/settings/models`);
    await page.locator("#new-runs-model").waitFor();
    await page.getByLabel("tickets.writer.model", { exact: true }).fill("sonnet");
    await page.getByRole("button", { name: "Review changes" }).click();
    const banner = page.getByRole("alert").filter({ hasText: "Not saved. The host file would be refused." });
    await banner.waitFor();
    expect(await banner.evaluate((element) => getComputedStyle(element).alignItems)).toBe("flex-start");
    expect(await banner.locator("code").allTextContents()).toEqual(["tickets.plan"]);
    expect(await banner.textContent()).toContain("ticket mode: tickets.plan in the host file");
    await context.close();
  });
});

describe("the Tickets header of the Instance unreachable board, at 390px", () => {
  it("keeps the count on one line beside the title, with Last known and the buttons wrapping beneath it", async () => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const stand: Stand = { connections: [{ name: "personal", kind: "ssh" }], instances: { personal: { config: modelsConfig(), tickets: [], queue: { entries: [] } as never, queueFails: { status: 502, error: "cannot reach personal over SSH: agents: Permission denied (publickey)", lastKnown: { value: { entries: [] }, readAt: "2026-10-25T09:00:00.000Z" } } } } };
    await serveInstance(context, { stand });
    const page = await context.newPage();
    await page.goto(`${site.origin}/tickets`);
    await page.getByRole("heading", { level: 1, name: "Tickets" }).waitFor();
    const count = page.locator(".page-count");
    await count.waitFor();
    const lines = await count.evaluate((element) => Math.round(element.getBoundingClientRect().height / Number.parseFloat(getComputedStyle(element).lineHeight)));
    expect(lines).toBe(1);
    await context.close();
  });
});
