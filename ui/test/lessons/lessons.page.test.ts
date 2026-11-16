import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Browser, BrowserContext } from "playwright-core";
import { captureName } from "../../../src/ticket-mode/capture.ts";
import { lessonsRoute } from "../../../src/ticket-mode/retro/lessons-route.ts";
import { boardSizedStand } from "../fixtures.ts";
import { serveInstance } from "../instance-routes.ts";
import { overflowProblem, SCREENS } from "../screenshots.ts";
import { launchBrowser, startSite, UI_ROOT, type Site } from "../site.ts";
import { CHANGESET, lessonsState } from "./lessons-stand.ts";

// THE LESSONS PAGE IN CHROMIUM (A11-432, step 2 of 3): the built page, its `/api/lessons` routes answered by the instance's own route over scratch lessons files (`lessons-stand.ts`), every other
// call by the shell's stand-in. It fits a desktop and a phone with no horizontal scroll, and an edit is saved. The PNGs are this pull request's screenshots.

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

const CAPTURES = join(UI_ROOT, "captures", "lessons");

/** Answers `/api/lessons` and its edits with the real route over `stateDir`; every other instance call as the board-sized stand-in does. Routes added later are matched first. */
async function serveLessons(context: BrowserContext, stateDir: string): Promise<void> {
  await serveInstance(context, { stand: boardSizedStand() });
  await context.route(/\/api\/lessons(\/[a-z]+)?$/, (route) => {
    const request = route.request();
    const path = /(\/api\/lessons(?:\/[a-z]+)?)$/.exec(request.url())?.[1] ?? "";
    const [status, body] = lessonsRoute({ stateDir, on: true }, request.method(), path, request.postDataJSON() ?? {}) ?? [404, { error: "no route" }];
    return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
  });
}

describe("the Lessons page at 1440px and at 390px", () => {
  it.each(SCREENS)("lists each repository's lessons and saves an edit, with no horizontal overflow, at $width px", async (screen) => {
    const context = await browser.newContext({ viewport: screen, deviceScaleFactor: 1 });
    try {
      await serveLessons(context, lessonsState());
      const page = await context.newPage();
      await page.goto(`${site.origin}/lessons`);
      await page.getByRole("heading", { name: "agent-org" }).waitFor();
      expect(await page.locator(".page-count").first().textContent()).toBe("2 lessons");
      const lesson = page.locator(".lesson", { hasText: CHANGESET });
      await lesson.getByRole("button", { name: "Edit" }).click();
      const { scrollWidth, clientWidth } = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth }));
      expect(overflowProblem({ route: "/lessons", width: screen.width, scrollWidth, clientWidth })).toBeNull();
      mkdirSync(CAPTURES, { recursive: true });
      writeFileSync(join(CAPTURES, captureName("lessons-editing", screen)), await page.screenshot({ fullPage: true }));
      await page.getByRole("textbox", { name: "Lesson text, agent-org" }).fill("Add a changeset for every change to a published package.");
      await page.getByRole("button", { name: "Save" }).click();
      await page.getByText("Add a changeset for every change to a published package.").waitFor();
      writeFileSync(join(CAPTURES, captureName("lessons", screen)), await page.screenshot({ fullPage: true }));
    } finally {
      await context.close();
    }
  });
});
