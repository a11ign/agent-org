import { isSettingsPage, pageOf, runKeyOf, SETTINGS_SECTIONS, settingsHref, settingsSectionHref, TITLES } from "./routes.ts";

describe("runKeyOf", () => {
  it("is the key in /runs/<key>", () => {
    expect(runKeyOf("/runs/A11-1")).toBe("A11-1");
    expect(runKeyOf("/runs/A11-1/")).toBe("A11-1");
  });

  it("decodes a key that was encoded", () => {
    expect(runKeyOf("/runs/A11%2D1")).toBe("A11-1");
  });

  it("keeps a key that is not valid percent-encoding as it is", () => {
    expect(runKeyOf("/runs/100%")).toBe("100%");
  });

  it.each(["/runs", "/runs/", "/tickets", "/runs/A11-1/more", ""])("is null for %j", (path) => {
    expect(runKeyOf(path)).toBeNull();
  });
});

describe("pageOf", () => {
  it("is Run detail when the runs page is served for a run's path", () => {
    expect(pageOf("runs", "/runs/A11-1")).toBe("run");
  });

  it("is Runs for the list", () => {
    expect(pageOf("runs", "/runs")).toBe("runs");
    expect(pageOf("runs", "")).toBe("runs");
  });

  it("is the section the route builds for every other page", () => {
    expect(pageOf("tickets", "/tickets")).toBe("tickets");
    expect(pageOf("models", "/runs/A11-1")).toBe("models");
  });
});

describe("the addresses", () => {
  it("are the ticket's", () => {
    expect(settingsHref).toBe("/settings/models");
    expect(SETTINGS_SECTIONS.map(({ id }) => settingsSectionHref(id))).toEqual(["/settings/models", "/settings/workers", "/settings/machine", "/settings/plugins"]);
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
