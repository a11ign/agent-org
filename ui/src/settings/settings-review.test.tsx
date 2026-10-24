import { cleanup } from "@testing-library/react";
import { PROJECT_NOTE } from "../../../src/ticket-mode/settings-edit.ts";
import { BOARD_FILES, dangerousOf, standOf as settingsOf, viewOf } from "../../test/settings/settings-stand.ts";
import { fireEvent, inputOf, instanceOf, pageOn, PERSONAL, posts, reads, rowOf, screen, standOf, waitFor, within } from "./settings-harness.tsx";

const bar = () => screen.getByRole("region", { name: /^Unsaved changes/ });
const dialog = () => screen.getByRole("dialog", { name: "Review changes" });
const review = () => fireEvent.click(within(bar()).getByRole("button", { name: "Review changes" }));
const type = (key: string, value: string) => fireEvent.change(inputOf(key), { target: { value } });
const toggle = (key: string) => fireEvent.click(inputOf(key));
/** Stages a new stall time, reviews it and saves it. */
async function saveStall(): Promise<void> {
  type("tickets.stallMinutes", "60");
  review();
  fireEvent.click(await screen.findByRole("button", { name: "Save to host.json" }));
}
/** The refused banner with the server's reasons, no dialog, and the one change still staged. */
async function expectRefused(reasons: string): Promise<void> {
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("Not saved. The host file would be refused.");
  expect(alert.textContent).toContain(reasons);
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(bar().textContent).toContain("1 unsaved change");
}
/** Asks for the review of what is staged and gives the dialog's Save button. */
async function reviewed(): Promise<HTMLElement> {
  review();
  return screen.findByRole("button", { name: "Save to host.json" });
}
const DRAFTS_WHY = dangerousOf("tickets.drafts") ?? "";

describe("staging a change on a row", () => {
  it("tints the row and counts it in the unsaved-changes bar, with Discard and Review changes; setting it back unstages it", async () => {
    await pageOn("workers");
    expect(screen.queryByRole("region", { name: "Unsaved changes" })).toBeNull();
    type("tickets.stallMinutes", "60");
    expect(rowOf("tickets.stallMinutes").className).toContain("setting-row-staged");
    expect(bar().textContent).toContain("1 unsaved change");
    expect(bar().textContent).toContain("host.json");
    expect(within(bar()).getByRole("button", { name: "Discard" })).toBeTruthy();
    expect(rowOf("tickets.drafts").className).not.toContain("setting-row-staged");
    toggle("tickets.drafts");
    expect(rowOf("tickets.drafts").className).toContain("setting-row-staged");
    expect(bar().textContent).toContain("2 unsaved changes");
    toggle("tickets.drafts");
    expect(bar().textContent).toContain("1 unsaved change");
    type("tickets.stallMinutes", "45");
    expect(screen.queryByRole("region", { name: "Unsaved changes" })).toBeNull();
    expect(rowOf("tickets.stallMinutes").className).not.toContain("setting-row-staged");
  });

  it("stages an emptied field as returning the key to its default, and says a number or JSON that does not read on its row, staging nothing", async () => {
    await pageOn("workers");
    type("tickets.stallMinutes", "");
    expect(bar().textContent).toContain("1 unsaved change");
    cleanup();
    sessionStorage.clear();
    const { fetchWith } = await pageOn("workers");
    type("tickets.preflight", "[{");
    expect(rowOf("tickets.preflight").textContent).toContain("tickets.preflight needs JSON, such as a list or an object");
    expect(screen.queryByRole("region", { name: "Unsaved changes" })).toBeNull();
    expect(posts(fetchWith, "/api/settings/preview")).toEqual([]);
  });

  it("Discard takes the staged changes of the file back", async () => {
    await pageOn("workers");
    type("tickets.stallMinutes", "60");
    toggle("tickets.drafts");
    fireEvent.click(within(bar()).getByRole("button", { name: "Discard" }));
    expect(screen.queryByRole("region", { name: "Unsaved changes" })).toBeNull();
    expect(inputOf("tickets.stallMinutes").value).toBe("45");
  });

  it("keeps the staged changes when the tab moves to another page of Settings, and counts them there", async () => {
    await pageOn("workers");
    type("tickets.stallMinutes", "60");
    cleanup();
    await pageOn("machine");
    expect(bar().textContent).toContain("1 unsaved change");
  });
});

describe("the review, save and restore of the host file", () => {
  it("previews the staged change, lists it in the dialog from the preview, and saves it with the preview's base", async () => {
    const { fetchWith } = await pageOn("workers");
    type("tickets.stallMinutes", "60");
    review();
    await screen.findByRole("dialog", { name: "Review changes" });
    expect(posts(fetchWith, "/api/settings/preview").map((request) => request.body)).toEqual([{ file: "host.json", changes: [{ key: "tickets.stallMinutes", value: 60 }] }]);
    expect(dialog().querySelector("h2")?.textContent).toBe("Review changes · host.json");
    expect(dialog().textContent).toContain("tickets.stallMinutes");
    expect(dialog().textContent).toContain("the old value→60");
    expect(dialog().textContent).toContain("In force after the board restarts: ticket:serve and ticket:ui.");
    expect(dialog().textContent).not.toContain("Dangerous.");
    const save = within(dialog()).getByRole("button", { name: "Save to host.json" }) as HTMLButtonElement;
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    await screen.findByText("Saved to host.json.");
    expect(posts(fetchWith, "/api/settings/save").map((request) => request.body)).toEqual([
      { file: "host.json", changes: [{ key: "tickets.stallMinutes", value: 60 }], base: "base-1", confirmed: [] },
    ]);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("says the saved banner as the board does: the backup, what is in force, and Restore previous", async () => {
    await pageOn("workers");
    await saveStall();
    const banner = await screen.findByText("Saved to host.json.");
    const text = banner.closest("[role=status]")?.textContent ?? "";
    expect(text).toContain("The previous file is kept as host.json.bak.");
    expect(text).toContain("In force after the board restarts: ticket:serve and ticket:ui.");
    expect(within(banner.closest("[role=status]") as HTMLElement).getByRole("button", { name: "Restore previous" })).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole("region", { name: "Unsaved changes" })).toBeNull());
  });

  it("reads the settings again after a save, and the rows show the file as saved", async () => {
    const files = { ...BOARD_FILES, host: { ...BOARD_FILES.host, tickets: { ...(BOARD_FILES.host.tickets as object), stallMinutes: 60 } } };
    const state = settingsOf();
    const { fetchWith } = await pageOn("workers", { state });
    const before = reads(fetchWith, "/api/settings").length;
    await saveStall();
    await screen.findByText("Saved to host.json.");
    state.view = () => viewOf(files);
    await waitFor(() => expect(reads(fetchWith, "/api/settings").length).toBeGreaterThan(before));
    await waitFor(() => expect(inputOf("tickets.stallMinutes").value).toBe("60"));
    expect(screen.queryByRole("region", { name: "Unsaved changes" })).toBeNull();
  });

});

describe("restoring the previous file", () => {
  it("restores the previous file from the saved banner, and says what the restore changed", async () => {
    const restored = { file: "host.json", changes: [{ key: "tickets.stallMinutes", old: "60", new: "45", changed: true, applies: "board", inForce: "in force after the board restarts: ticket:serve and ticket:ui.", dangerous: null }] };
    const { fetchWith } = await pageOn("workers", { state: settingsOf({ answers: { restore: () => restored as never } }) });
    await saveStall();
    await screen.findByText("Saved to host.json.");
    const before = reads(fetchWith, "/api/settings").length;
    fireEvent.click(screen.getByRole("button", { name: "Restore previous" }));
    await screen.findByText(/^Restored host.json from its backup\./);
    expect(posts(fetchWith, "/api/settings/restore").map((request) => request.body)).toEqual([{ file: "host.json" }]);
    expect(screen.getByText(/tickets.stallMinutes: 60 → 45\. In force after the board restarts/)).toBeTruthy();
    expect(reads(fetchWith, "/api/settings").length).toBeGreaterThan(before);
  });

  it("says a restore that changed nothing, and the instance's sentence for one it refuses", async () => {
    const state = settingsOf();
    await pageOn("workers", { state });
    await saveStall();
    fireEvent.click(await screen.findByRole("button", { name: "Restore previous" }));
    await screen.findByText("Restored host.json from its backup. Nothing differed.");
    cleanup();
    sessionStorage.clear();
    await pageOn("workers", { state: settingsOf({ answers: { restore: () => ({ status: 400, error: "there is no backup of host.json to restore" }) } }) });
    await saveStall();
    fireEvent.click(await screen.findByRole("button", { name: "Restore previous" }));
    expect((await screen.findByRole("alert")).textContent).toBe("there is no backup of host.json to restore");
  });

});

describe("the review of one file and its dialog", () => {
  it("says the project file's note in the dialog, and reviews the two files one at a time with a bar for each", async () => {
    const files = { ...BOARD_FILES, project: { units: { prefix: "a11" } } };
    const { fetchWith } = await pageOn("machine", { state: settingsOf({ view: () => viewOf(files) }) });
    type("units.prefix", "agent");
    type("home", "/home/other");
    expect(screen.getAllByRole("region", { name: /^Unsaved changes in / }).map((region) => region.textContent)).toEqual([expect.stringContaining("host.json"), expect.stringContaining("project.json")]);
    fireEvent.click(within(screen.getByRole("region", { name: "Unsaved changes in project.json" })).getByRole("button", { name: "Review changes" }));
    await screen.findByRole("dialog", { name: "Review changes" });
    expect(posts(fetchWith, "/api/settings/preview").map((request) => request.body)).toEqual([{ file: "project.json", changes: [{ key: "units.prefix", value: "agent" }] }]);
    expect(dialog().textContent).toContain("Review changes · project.json");
    expect(dialog().textContent).toContain(PROJECT_NOTE);
    fireEvent.click(within(dialog()).getByRole("button", { name: "Save to project.json" }));
    await screen.findByText("Saved to project.json.");
    expect(screen.getByRole("region", { name: "Unsaved changes" }).textContent).toContain("host.json");
  });

  it("saves what was previewed, and keeps staged what was typed over it while the dialog was open", async () => {
    const { fetchWith } = await pageOn("workers");
    type("tickets.stallMinutes", "60");
    const save = await reviewed();
    type("tickets.stallMinutes", "70");
    fireEvent.click(save);
    await screen.findByText("Saved to host.json.");
    expect(posts(fetchWith, "/api/settings/save").map((request) => request.body)).toEqual([{ file: "host.json", changes: [{ key: "tickets.stallMinutes", value: 60 }], base: "base-1", confirmed: [] }]);
    expect(bar().textContent).toContain("1 unsaved change");
    expect(inputOf("tickets.stallMinutes").value).toBe("70");
  });

  it("Back and Escape close the dialog and keep every staged change", async () => {
    const { fetchWith } = await pageOn("workers");
    type("tickets.stallMinutes", "60");
    review();
    const opened = await screen.findByRole("dialog", { name: "Review changes" });
    fireEvent.click(within(opened).getByRole("button", { name: "Back" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(bar().textContent).toContain("1 unsaved change");
    review();
    fireEvent.keyDown(await screen.findByRole("dialog", { name: "Review changes" }), { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(posts(fetchWith, "/api/settings/save")).toEqual([]);
    expect(inputOf("tickets.stallMinutes").value).toBe("60");
  });
});

describe("a dangerous key", () => {
  it("says why it is dangerous, offers Save only once the key is ticked by name, and confirms exactly that key", async () => {
    const { fetchWith } = await pageOn("workers");
    toggle("tickets.drafts");
    type("tickets.stallMinutes", "60");
    review();
    await screen.findByRole("dialog", { name: "Review changes" });
    expect(dialog().textContent).toContain("Dangerous.");
    expect(dialog().textContent).toContain(DRAFTS_WHY);
    expect(dialog().querySelectorAll(".review-danger")).toHaveLength(1);
    const save = within(dialog()).getByRole("button", { name: "Save to host.json" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    const tick = within(dialog()).getByLabelText("I am changing tickets.drafts");
    fireEvent.click(tick);
    expect(save.disabled).toBe(false);
    fireEvent.click(tick);
    expect(save.disabled).toBe(true);
    fireEvent.click(tick);
    fireEvent.click(save);
    await screen.findByText("Saved to host.json.");
    expect(posts(fetchWith, "/api/settings/save").map((request) => request.body)).toEqual([
      { file: "host.json", changes: [{ key: "tickets.stallMinutes", value: 60 }, { key: "tickets.drafts", value: false }], base: "base-1", confirmed: ["tickets.drafts"] },
    ]);
  });

  it("does not save with the dialog's Back, and sends nothing for a dangerous key left unticked", async () => {
    const { fetchWith } = await pageOn("workers");
    toggle("tickets.drafts");
    review();
    await screen.findByRole("dialog", { name: "Review changes" });
    expect((within(dialog()).getByRole("button", { name: "Save to host.json" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(dialog()).getByRole("button", { name: "Back" }));
    expect(posts(fetchWith, "/api/settings/save")).toEqual([]);
  });
});

describe("a save that is not made", () => {
  it("is refused by the readers at the review: the banner says so with the server's reasons, and the changes stay staged", async () => {
    const reasons = "ticket mode: tickets.plan in the host file is not a regular expression: \"(PLAN\". Nothing was written.";
    const { fetchWith } = await pageOn("workers", { state: settingsOf({ answers: { preview: () => ({ status: 400, error: reasons }) } }) });
    type("tickets.stallMinutes", "60");
    review();
    await expectRefused(reasons);
    expect(posts(fetchWith, "/api/settings/save")).toEqual([]);
  });

  it("is refused by the readers at the save: the same banner, with the changes still staged", async () => {
    const reasons = "ticket mode: tickets.stallMinutes in the host file must be at least 1";
    await pageOn("workers", { state: settingsOf({ answers: { save: () => ({ status: 400, error: reasons }) } }) });
    type("tickets.stallMinutes", "0");
    review();
    fireEvent.click(await screen.findByRole("button", { name: "Save to host.json" }));
    await expectRefused(reasons);
    expect(inputOf("tickets.stallMinutes").value).toBe("0");
  });

  it("is not said to be refused by the readers when no answer came at all", async () => {
    await pageOn("workers", { state: settingsOf({ drops: ["/api/settings/preview"] }) });
    type("tickets.stallMinutes", "60");
    review();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("Failed to fetch");
    expect(bar().textContent).toContain("1 unsaved change");
  });

  it("is the file changing: the conflict banner keeps every change staged, and Read the file again reads the settings again", async () => {
    const state = settingsOf();
    const { fetchWith } = await pageOn("workers", { state });
    type("tickets.stallMinutes", "60");
    toggle("tickets.drafts");
    review();
    fireEvent.click(await screen.findByLabelText("I am changing tickets.drafts"));
    const save = await screen.findByRole("button", { name: "Save to host.json" });
    state.base = "base-2";
    fireEvent.click(save);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Not saved.");
    expect(alert.textContent).toContain("The file changed since you looked: read it again. Your edits are still here.");
    expect(screen.queryByText("Not saved. The host file would be refused.")).toBeNull();
    expect(bar().textContent).toContain("2 unsaved changes");
    const before = reads(fetchWith, "/api/settings").length;
    fireEvent.click(within(alert).getByRole("button", { name: "Read the file again" }));
    await waitFor(() => expect(reads(fetchWith, "/api/settings").length).toBeGreaterThan(before));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(bar().textContent).toContain("2 unsaved changes");
    // The next review previews against the file as it is now, and the save goes through with its new base.
    review();
    fireEvent.click(await screen.findByLabelText("I am changing tickets.drafts"));
    fireEvent.click(await screen.findByRole("button", { name: "Save to host.json" }));
    await screen.findByText("Saved to host.json.");
    expect(posts(fetchWith, "/api/settings/save").at(-1)?.body).toMatchObject({ base: "base-2" });
  });
});

describe("a remote instance", () => {
  it("keeps every host-file input read-only, says so, and offers no edit", async () => {
    await pageOn("workers", { stand: standOf(instanceOf(), PERSONAL) });
    expect(screen.getByText("This instance is personal. Its files are changed on that machine, so this page offers no edit here.")).toBeTruthy();
    expect(inputOf("tickets.stallMinutes").readOnly).toBe(true);
    expect(inputOf("tickets.drafts").disabled).toBe(true);
    expect(within(rowOf("tickets.preflight")).getByLabelText("tickets.preflight")).toHaveProperty("readOnly", true);
    fireEvent.change(inputOf("tickets.stallMinutes"), { target: { value: "60" } });
    expect(screen.queryByRole("region", { name: "Unsaved changes" })).toBeNull();
  });

  it("says nothing of the sort for this machine's own instance", async () => {
    await pageOn("workers");
    expect(screen.queryByText(/Its files are changed on that machine/)).toBeNull();
    expect(inputOf("tickets.stallMinutes").readOnly).toBe(false);
  });
});
