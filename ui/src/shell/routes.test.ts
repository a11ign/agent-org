import { isSettingsPage, pageOf, runKeyOf, SETTINGS_SECTIONS, settingsHref, settingsSectionHref, TITLES } from "./routes.ts";

describe("runKeyOf", () => {
  it("is the key in /next/runs/<key>", () => {
    expect(runKeyOf("/next/runs/A11-1")).toBe("A11-1");
    expect(runKeyOf("/next/runs/A11-1/")).toBe("A11-1");
  });

  it("decodes a key that was encoded", () => {
    expect(runKeyOf("/next/runs/A11%2D1")).toBe("A11-1");
  });

  it("keeps a key that is not valid percent-encoding as it is", () => {
    expect(runKeyOf("/next/runs/100%")).toBe("100%");
  });

  it.each(["/next/runs", "/next/runs/", "/next/tickets", "/next/runs/A11-1/more", ""])("is null for %j", (path) => {
    expect(runKeyOf(path)).toBeNull();
  });
});

describe("pageOf", () => {
  it("is Run detail when the runs page is served for a run's path", () => {
    expect(pageOf("runs", "/next/runs/A11-1")).toBe("run");
  });

  it("is Runs for the list", () => {
    expect(pageOf("runs", "/next/runs")).toBe("runs");
    expect(pageOf("runs", "")).toBe("runs");
  });

  it("is the section the route builds for every other page", () => {
    expect(pageOf("tickets", "/next/tickets")).toBe("tickets");
    expect(pageOf("models", "/next/runs/A11-1")).toBe("models");
  });
});

describe("the addresses", () => {
  it("are the ticket's", () => {
    expect(settingsHref).toBe("/next/settings/models");
    expect(SETTINGS_SECTIONS.map(({ id }) => settingsSectionHref(id))).toEqual(["/next/settings/models", "/next/settings/workers", "/next/settings/machine", "/next/settings/plugins"]);
  });

  it("know which pages are Settings sections", () => {
    expect(["tickets", "runs", "run"].some((page) => isSettingsPage(page as never))).toBe(false);
    expect(SETTINGS_SECTIONS.every(({ id }) => isSettingsPage(id))).toBe(true);
  });

  it("give each page the boards' document title", () => {
    expect(TITLES).toEqual({
      tickets: "Atomaut: Tickets", runs: "Atomaut: Runs", run: "Atomaut: Run detail", models: "Atomaut: Settings, Models", workers: "Atomaut: Settings, Workers",
      machine: "Atomaut: Settings, Machine", plugins: "Atomaut: Plugins",
    });
  });
});
