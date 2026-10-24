import { instanceOf, keysShown, pageOn, PERSONAL, rowOf, screen, section, standOf, within } from "./settings-harness.tsx";
import { settingsFetch, standOf as settingsOf, viewOf, BOARD_FILES } from "../../test/settings/settings-stand.ts";
import { render, waitFor } from "@testing-library/react";
import { SettingsApp } from "./SettingsApp.tsx";

describe("the three pages of the split", () => {
  it("Models: the defaults for new work, then the host file's model and effort keys alone", async () => {
    await pageOn("models");
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Settings");
    expect(screen.getByText("Which model and effort each kind of work runs on.")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Defaults for new work" })).toBeTruthy();
    expect(screen.getByText("These save as you change them. A run already on the queue keeps its own.")).toBeTruthy();
    for (const name of ["New runs", "Planning", "Ticket writer"]) expect(screen.getByRole("heading", { name })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Host file host.json" })).toBeTruthy();
    expect(keysShown()).toEqual(["tickets.writer.model", "tickets.writer.effort"]);
    expect(screen.queryByRole("heading", { name: "Worker pool" })).toBeNull();
  });

  it("Workers: the worker pool, then the Workers group's keys alone, without the number of workers drawn twice", async () => {
    await pageOn("workers");
    expect(screen.getByText("How many runs work at once, and how workers open pull requests.")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Worker pool" })).toBeTruthy();
    expect(keysShown()).toEqual(["tickets.stallMinutes", "tickets.preflight", "tickets.drafts", "tickets.capture"]);
    expect(screen.queryByRole("heading", { name: "Defaults for new work" })).toBeNull();
  });

  it("Machine: the host file's keys alone, with the groups the boards place no key of beside their neighbours", async () => {
    await pageOn("machine");
    expect(screen.getByText("Tools and paths on the machine this instance runs on.")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Worker pool" })).toBeNull();
    expect(keysShown()).toEqual(expect.arrayContaining(["home", "tickets.designTools", "tickets.providers.tracker.provider"]));
    expect(keysShown()).not.toContain("tickets.drafts");
    expect(keysShown()).not.toContain("tickets.writer.model");
    expect(screen.getAllByRole("heading", { level: 3 }).map((heading) => heading.textContent)).toEqual(expect.arrayContaining(["Machine", "Conventions plugin", "Tracker", "Code host"]));
  });

  it("the Settings sub-nav goes to the four pages, and Plugins to the Plugins page", async () => {
    await pageOn("workers");
    const nav = screen.getByRole("navigation", { name: "Settings sections" });
    expect(within(nav).getAllByRole("link").map((link) => [link.textContent, link.getAttribute("href")])).toEqual([
      ["Models", "/next/settings/models"], ["Workers", "/next/settings/workers"], ["Machine", "/next/settings/machine"], ["Plugins", "/next/settings/plugins"],
    ]);
    expect(within(nav).getByRole("link", { name: "Workers" }).getAttribute("aria-current")).toBe("page");
  });

});

describe("the rows of a page", () => {
  it("shows each row as the boards do: its key, what it does, its default and when it is in force, and an input of the kind its key takes", async () => {
    await pageOn("workers");
    const drafts = rowOf("tickets.drafts");
    expect(drafts.textContent).toContain("Whether a worker opens its pull request as a draft");
    expect(drafts.textContent).toContain("Default: true · in force after the board restarts: ticket:serve and ticket:ui");
    expect((within(drafts).getByLabelText("tickets.drafts") as HTMLInputElement).checked).toBe(true);
    expect(within(drafts).getByText("true")).toBeTruthy();
    expect((within(rowOf("tickets.stallMinutes")).getByLabelText("tickets.stallMinutes") as HTMLInputElement).value).toBe("45");
    expect(within(rowOf("tickets.preflight")).getByLabelText("tickets.preflight").tagName).toBe("TEXTAREA");
    const capture = rowOf("tickets.capture");
    expect(capture.textContent).toContain("Read-only: onboard sets it once both Chromium builds start");
    expect(within(capture).queryByRole("checkbox")).toBeNull();
  });

  it("starts with the settings at their defaults shown, as the boards draw them, and the search keeps the keys or explanations that contain the query", async () => {
    await pageOn("machine");
    const search = screen.getByLabelText("Search settings by key or description") as HTMLInputElement;
    const defaults = screen.getByLabelText("Show settings at their defaults") as HTMLInputElement;
    expect(defaults.checked).toBe(true);
    expect(keysShown()).toContain("tickets.designTools");
    defaults.click();
    await waitFor(() => expect(keysShown()).not.toContain("tickets.designTools"));
    expect(keysShown()).toContain("home");
    search.focus();
    const typed = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    typed?.call(search, "design");
    search.dispatchEvent(new Event("input", { bubbles: true }));
    await waitFor(() => expect(keysShown()).toEqual(["tickets.designTools"]));
    expect(screen.getByText("1 setting matches")).toBeTruthy();
    typed?.call(search, "no such setting");
    search.dispatchEvent(new Event("input", { bubbles: true }));
    await screen.findByText("No setting matches");
  });

  it("nests a role's keys under the role's row, and hides a role's App fields while the role uses none", async () => {
    await pageOn("machine");
    expect(keysShown()).toContain("tickets.providers.codeHost.identity.reviewer");
    expect(rowOf("tickets.providers.codeHost.identity.reviewer.mode").className).toContain("setting-row-nested");
    expect(rowOf("tickets.providers.codeHost.identity.reviewer").className).not.toContain("setting-row-nested");
  });

});

describe("the states of the page's read", () => {
  it("is the skeleton while the settings load, with the h1 and the page's sentence already drawn", async () => {
    render(<SettingsApp section="workers" fetchWith={settingsFetch({ ...standOf(), holdInstance: true }, settingsOf())} />);
    const skeleton = await screen.findByRole("status", { name: "Loading settings" });
    expect(skeleton.getAttribute("aria-busy")).toBe("true");
    expect(skeleton.querySelectorAll(".skeleton-settings-card")).toHaveLength(4);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Settings");
    expect(screen.getByText("How many runs work at once, and how workers open pull requests.")).toBeTruthy();
  });

  it("says the readers' refusals of a file when it was read, and the notes, above the rest", async () => {
    const files = { ...BOARD_FILES, hostRefusal: "host.json is not valid JSON", notes: ["this machine declares no project, so there is no project.json"] };
    await pageOn("machine", { state: settingsOf({ view: () => viewOf(files) }) });
    expect(screen.getByRole("alert").textContent).toContain("host.json: host.json is not valid JSON");
    expect(screen.getByText("this machine declares no project, so there is no project.json")).toBeTruthy();
    expect(keysShown()).toEqual([]);
  });

  it("draws the project file's keys under their own heading when the machine declares a project", async () => {
    const files = { ...BOARD_FILES, project: { units: { prefix: "a11" } } };
    await pageOn("machine", { state: settingsOf({ view: () => viewOf(files) }) });
    expect(screen.getByRole("heading", { name: "Project file project.json" })).toBeTruthy();
    expect(section("Project").textContent).toContain("units.prefix");
  });

  it("shows the failure of the read with Retry, and the page again when it answers", async () => {
    const state = settingsOf({ viewFails: { status: 500, error: "the host file could not be read" } });
    const { fetchWith } = await pageOn("workers", { state, ready: false });
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("the host file could not be read");
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Settings");
    delete state.viewFails;
    alert.querySelector<HTMLButtonElement>("button")?.click();
    await screen.findByText(/^Host file/);
    expect(fetchWith.requests.filter((request) => request.path.endsWith("/api/settings")).length).toBeGreaterThan(1);
  });

  it("is the unreachable frame, with the board's words and Retry, alone when nothing was read and above the last settings when something was", async () => {
    const ssh = standOf(instanceOf(), PERSONAL);
    const state = settingsOf({ viewFails: { status: 502, error: "cannot reach personal over SSH: Permission denied (publickey)" } });
    await pageOn("workers", { stand: ssh, state, ready: false });
    const frame = await screen.findByRole("alert");
    expect(frame.textContent).toContain("Can't reach personal over SSH.");
    expect(frame.textContent).toContain("Permission denied (publickey)");
    expect(frame.textContent).toContain("Atomaut keeps trying, up to once a minute. Is agent-org ticket:serve running there?");
    expect(frame.querySelector("code")?.textContent).toBe("agent-org ticket:serve");
    expect(screen.queryByText(/^Host file/)).toBeNull();
    delete state.viewFails;
    within(frame).getByRole("button", { name: "Retry" }).click();
    await screen.findByText(/^Host file/);
    expect(screen.queryByRole("alert")).toBeNull();
    // The next read fails: the frame comes back above the settings that were read.
    state.viewFails = { status: 502, error: "cannot reach personal over SSH: timed out" };
    document.dispatchEvent(new Event("visibilitychange"));
    const again = await screen.findByRole("alert");
    expect(again.textContent).toContain("These are the last settings it read.");
    expect(screen.getByText(/^Host file/)).toBeTruthy();
    expect(keysShown()).toContain("tickets.drafts");
  });
});
