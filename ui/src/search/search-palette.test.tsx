import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { queueingConfig, ticket } from "../../test/fixtures.ts";
import type { Page } from "../shell/routes.ts";
import {
  A11_298, A11_301, A11_312, actionsOf, input, keysListed, optionOf, options, palette, press, pressCmdK, pressCtrlK, pressShifted, readyRun, running, searchFor, searching, shellOn, type,
} from "./search-harness.tsx";

// A11-387: the "Search tickets" palette, from every page of the shell.

const button = () => screen.getByRole("button", { name: "Search tickets" });
const scopeLine = () => palette().querySelector(".search-scope")?.textContent ?? "";
const listbox = () => within(palette()).getByRole("listbox");

describe("the entry point", () => {
  it("opens the palette on Ctrl+K on the Runs page, with the focus in its input", async () => {
    await shellOn(searching(() => []).instance);
    await waitFor(() => button());
    pressCtrlK();
    expect(palette()).toBeTruthy();
    expect(document.activeElement).toBe(input());
  });

  it("opens it on ⌘K too", async () => {
    await shellOn(searching(() => []).instance);
    await waitFor(() => button());
    pressCmdK();
    expect(document.activeElement).toBe(input());
  });

  it.each<Page>(["tickets", "runs", "models"])("ends the sidebar's top group on %s, below the connection pill, with a full-width Search tickets button and its shortcut", async (page) => {
    await shellOn(searching(() => []).instance, page);
    await waitFor(() => button());
    const head = document.querySelector(".sidebar-head")!;
    expect(head.lastElementChild).toBe(button());
    expect(button().previousElementSibling?.textContent).toBe("Connected");
    expect(button().className).toBe("search-button");
    expect(within(button()).getByText("Ctrl+K").tagName).toBe("KBD");
    expect(button().getAttribute("aria-keyshortcuts")).toBe("Control+K Meta+K");
  });

  it("leaves Ctrl+K to the text field on a Mac, where it deletes to the end of the line, and opens on ⌘K there", async () => {
    const platform = Object.getOwnPropertyDescriptor(Navigator.prototype, "platform");
    Object.defineProperty(navigator, "platform", { configurable: true, get: () => "MacIntel" });
    try {
      await shellOn(searching(() => []).instance);
      await waitFor(() => button());
      expect(within(button()).getByText("⌘K")).toBeTruthy();
      pressCtrlK();
      expect(screen.queryByRole("dialog", { name: "Search tickets" })).toBeNull();
      pressCmdK();
      expect(palette()).toBeTruthy();
    } finally {
      delete (navigator as { platform?: string }).platform;
      if (platform !== undefined) Object.defineProperty(Navigator.prototype, "platform", platform);
    }
  });

  it("opens nothing over a dialog already open, so one Esc never closes two", async () => {
    await shellOn(searching(() => []).instance);
    await waitFor(() => button());
    fireEvent.click(screen.getByRole("button", { name: /^Notifications/ }));
    expect(screen.getByRole("dialog", { name: "Notifications" })).toBeTruthy();
    pressCtrlK();
    expect(screen.queryByRole("dialog", { name: "Search tickets" })).toBeNull();
  });

  it("keeps its Esc to itself", async () => {
    await shellOn(searching(() => []).instance);
    await waitFor(() => button());
    const behind = rstest.fn();
    document.addEventListener("keydown", behind);
    pressCtrlK();
    behind.mockClear();
    fireEvent.keyDown(input(), { key: "Escape" });
    document.removeEventListener("keydown", behind);
    expect(screen.queryByRole("dialog", { name: "Search tickets" })).toBeNull();
    expect(behind).not.toHaveBeenCalled();
  });

  it("is neither drawn nor opened by Ctrl+K on an instance whose tracker cannot search", async () => {
    const { instance } = searching(() => []);
    await shellOn({ ...instance, config: queueingConfig() });
    pressCtrlK();
    expect(screen.queryByRole("dialog", { name: "Search tickets" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Search tickets" })).toBeNull();
  });
});

describe("the dialog", () => {
  it("closes on Esc and gives the focus back to the Search tickets button", async () => {
    await shellOn(searching(() => []).instance);
    await waitFor(() => button());
    button().focus();
    fireEvent.click(button());
    fireEvent.keyDown(input(), { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Search tickets" })).toBeNull();
    expect(document.activeElement).toBe(button());
  });

  it("wraps Tab from its last control to its first, past the actions of the rows that are not active", async () => {
    await shellOn(searching(() => [A11_312, A11_301, A11_298]).instance);
    await searchFor("worktree");
    const last = within(optionOf("A11-312")).getByRole("button", { name: "Open ticket" });
    last.focus();
    fireEvent.keyDown(last, { key: "Tab" });
    expect(document.activeElement).toBe(input());
    fireEvent.keyDown(input(), { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);
  });
});

describe("the results", () => {
  it("draws a match's status dot, key, highlighted title, project · goal · owner and status, under the line that says what it searches", async () => {
    await shellOn(searching(() => [A11_312]).instance);
    await searchFor("worktree");
    const row = optionOf("A11-312");
    expect(row.querySelector(".search-dot")?.className).toBe("search-dot tone-muted");
    expect(row.querySelector(".search-key")?.textContent).toBe("A11-312");
    expect([...row.querySelectorAll(".search-title mark")].map((mark) => mark.textContent)).toEqual(["worktree"]);
    expect(row.querySelector(".search-meta")?.textContent).toBe("agent-org · Fleet · Unassigned");
    expect(row.querySelector(".search-status")?.className).toBe("search-status tone-muted");
    expect(row.querySelector(".search-status")?.textContent).toBe("Backlog");
    expect(scopeLine()).toBe("Searching every project and everyone's tickets1 ticket");
  });

  it("moves the active row with ↓ and ↑, and names it in the input's aria-activedescendant", async () => {
    await shellOn(searching(() => [A11_312, A11_301, A11_298]).instance);
    await searchFor("worktree");
    expect(options().map((option) => option.getAttribute("aria-selected"))).toEqual(["true", "false", "false"]);
    press("ArrowDown");
    press("ArrowDown");
    press("ArrowUp");
    expect(options().map((option) => option.getAttribute("aria-selected"))).toEqual(["false", "true", "false"]);
    expect(input().getAttribute("aria-activedescendant")).toBe(options()[1].id);
    expect(input().getAttribute("aria-controls")).toBe(listbox().id);
  });

  it("goes to the active row's run on Shift+Enter", async () => {
    await shellOn(searching(() => [A11_312], [running("A11-312", A11_312.title)]).instance);
    await searchFor("worktree");
    pressShifted("Enter");
    expect(location.pathname).toBe("/runs/A11-312");
  });

  it("offers Open ticket and no View run for a ticket with no run in the queue", async () => {
    await shellOn(searching(() => [A11_312]).instance);
    await searchFor("worktree");
    expect(actionsOf("A11-312")).toEqual(["Open ticket"]);
  });
});

describe("the runs merged in (proposal)", () => {
  it("finds a Ready to merge run by its title though the tracker does not return its ticket, with View run", async () => {
    await shellOn(searching(() => [], [readyRun("A11-290", "Stamp the tool version on each run")]).instance);
    await searchFor("stamp the tool");
    expect(keysListed()).toEqual(["A11-290"]);
    expect(actionsOf("A11-290")).toEqual(["View run"]);
    expect(optionOf("A11-290").querySelector(".search-status")?.textContent).toBe("Ready to merge");
    expect(optionOf("A11-290").querySelector(".search-meta")).toBeNull();
  });

  it("lists a ticket the tracker matched and the queue runs once, with Open ticket and View run", async () => {
    await shellOn(searching(() => [A11_312], [running("A11-312", A11_312.title)]).instance);
    await searchFor("worktree");
    expect(keysListed()).toEqual(["A11-312"]);
    expect(actionsOf("A11-312")).toEqual(["Open ticket", "View run"]);
    expect(optionOf("A11-312").querySelector(".search-status")?.textContent).toBe("In progress");
  });

  it("lists a match by key above a match by title, whatever order the tracker gives", async () => {
    await shellOn(searching(() => [A11_298, A11_312]).instance);
    await searchFor("A11-31");
    expect(keysListed()).toEqual(["A11-312", "A11-298"]);
  });
});

describe("the states", () => {
  it("lists a ticket opened from it before under Recently opened, with an empty query", async () => {
    await shellOn(searching(() => [A11_312]).instance);
    await searchFor("worktree");
    fireEvent.click(within(optionOf("A11-312")).getByRole("button", { name: "Open ticket" }));
    expect(screen.queryByRole("dialog", { name: "Search tickets" })).toBeNull();
    pressCtrlK();
    expect(within(palette()).getByText("Recently opened")).toBeTruthy();
    expect(keysListed()).toEqual(["A11-312"]);
    expect(optionOf("A11-312").querySelector(".search-meta")?.textContent).toBe("agent-org · Fleet · Unassigned");
    expect(scopeLine()).toContain("Press a key to search");
  });

  it("keeps at most 3 tickets in Recently opened, the newest first", async () => {
    const found = [A11_312, A11_301, A11_298, ticket({ key: "A11-7", title: "Seventh worktree" })];
    await shellOn(searching(() => found).instance);
    for (const key of ["A11-312", "A11-301", "A11-298", "A11-7"]) {
      await searchFor("worktree");
      fireEvent.click(within(optionOf(key)).getByRole("button", { name: "Open ticket" }));
    }
    pressCtrlK();
    expect(keysListed()).toEqual(["A11-7", "A11-298", "A11-301"]);
  });

  it("shows the helper text in place of Recently opened when nothing was opened from it", async () => {
    await shellOn(searching(() => []).instance);
    await waitFor(() => button());
    pressCtrlK();
    expect(within(palette()).queryByText("Recently opened")).toBeNull();
    expect(palette().querySelector(".search-note")?.textContent).toBe("Search covers every project, goal and person. Try the ticket key, or a word from its title.");
  });

  it("says no ticket matches, with the hint to try the key or a word of the title", async () => {
    await shellOn(searching(() => []).instance);
    await searchFor("zzqx");
    expect(palette().querySelector(".search-note-title")?.textContent).toBe('No tickets match "zzqx"');
    expect(palette().querySelector(".search-note-text")?.textContent).toContain("Try the ticket key, or a word from its title.");
    expect(scopeLine()).toContain("No matches");
  });

  it("shows skeleton rows on a busy list while the search is out, and no row of the words before", async () => {
    await shellOn(searching(() => [A11_312]).instance);
    await searchFor("worktree");
    expect(keysListed()).toEqual(["A11-312"]);
    type("work");
    expect(listbox().getAttribute("aria-busy")).toBe("true");
    expect(options()).toEqual([]);
    expect(listbox().querySelectorAll(".search-skeleton-row .sk").length).toBeGreaterThan(0);
    expect(scopeLine()).toContain("Searching…");
  });

  it("shows the tracker's sentence in a red alert with Retry, which asks again", async () => {
    const { instance, asked } = searching(() => ({ status: 502, error: "Linear refused the search: rate limited" }));
    await shellOn(instance);
    await searchFor("worktree");
    const alert = within(palette()).getByRole("alert");
    expect(alert.className).toBe("search-refusal");
    expect(alert.textContent).toContain("Linear refused the search: rate limited");
    expect(asked).toEqual(["worktree"]);
    fireEvent.click(within(alert).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(asked).toEqual(["worktree", "worktree"]), { timeout: 2000 });
  });
});
