import { BOARD_FILES, standOf as settingsOf, viewOf } from "../../test/settings/settings-stand.ts";
import type { SettingsView } from "../api/types.ts";
import { fireEvent, inputOf, instanceOf, keysShown, pageOn, PERSONAL, posts, reads, rowOf, screen, standOf, waitFor, within } from "./settings-harness.tsx";

// What `ui.html`'s Settings page does that A11-200's pages left off (A11-220): restore a host file's backup at any time, a row's Details, a provider's hint, return a key to its default, and
// what the Conventions plugin says besides its keys.

const RESTORED = { file: "host.json", changes: [{ key: "tickets.stallMinutes", old: "60", new: "45", changed: true, applies: "board", inForce: "in force after the board restarts: ticket:serve and ticket:ui.", dangerous: null }] };
const declaresProject = (): SettingsView => ({ ...viewOf(), refusals: [{ file: "project.json", message: "project.json is not valid JSON" }] });

describe("restoring a host file's backup at any time", () => {
  it("is one button for the host file at the foot of Machine, with no save before it", async () => {
    await pageOn("machine");
    expect(screen.getAllByRole("button", { name: /^Restore the backup of / }).map((button) => button.textContent)).toEqual(["Restore the backup of host.json"]);
  });

  it("adds the project file's when the machine declares a project, by a refusal or by a row", async () => {
    await pageOn("machine", { state: settingsOf({ view: declaresProject }) });
    expect(screen.getAllByRole("button", { name: /^Restore the backup of / }).map((button) => button.textContent)).toEqual(["Restore the backup of host.json", "Restore the backup of project.json"]);
  });

  it("posts the file, says what the restore changed in the restored banner, and reads the settings again", async () => {
    const { fetchWith } = await pageOn("machine", { state: settingsOf({ answers: { restore: () => RESTORED as never } }) });
    const before = reads(fetchWith, "/api/settings").length;
    fireEvent.click(screen.getByRole("button", { name: "Restore the backup of host.json" }));
    await screen.findByText(/^Restored host.json from its backup\./);
    expect(posts(fetchWith, "/api/settings/restore").map((request) => request.body)).toEqual([{ file: "host.json" }]);
    expect(screen.getByText(/tickets.stallMinutes: 60 → 45\./)).toBeTruthy();
    expect(reads(fetchWith, "/api/settings").length).toBeGreaterThan(before);
  });

  it("posts the project file's name for its button", async () => {
    const { fetchWith } = await pageOn("machine", { state: settingsOf({ view: declaresProject, answers: { restore: () => ({ ...RESTORED, file: "project.json" }) as never } }) });
    fireEvent.click(screen.getByRole("button", { name: "Restore the backup of project.json" }));
    await screen.findByText(/^Restored project.json from its backup\./);
    expect(posts(fetchWith, "/api/settings/restore").map((request) => request.body)).toEqual([{ file: "project.json" }]);
  });

  it("says the instance's sentence for a restore it refuses", async () => {
    await pageOn("machine", { state: settingsOf({ answers: { restore: () => ({ status: 400, error: "there is no backup of host.json to restore" }) } }) });
    fireEvent.click(screen.getByRole("button", { name: "Restore the backup of host.json" }));
    expect((await screen.findByRole("alert")).textContent).toBe("there is no backup of host.json to restore");
  });

  it("is not offered on a remote instance, whose files are changed on that machine", async () => {
    await pageOn("machine", { stand: standOf(instanceOf(), PERSONAL) });
    expect(screen.queryByRole("button", { name: /^Restore the backup of / })).toBeNull();
  });

  it("is not on the Models or Workers pages", async () => {
    await pageOn("workers");
    expect(screen.queryByRole("button", { name: /^Restore the backup of / })).toBeNull();
  });
});

describe("a row's Details", () => {
  it("is a closed disclosure with the row's state and source and what breaks if it is wrong", async () => {
    await pageOn("workers");
    const details = rowOf("tickets.stallMinutes").querySelector("details") as HTMLDetailsElement;
    expect(details.open).toBe(false);
    expect(details.textContent).toContain("State: enabled. Source: host.json.");
    expect(details.textContent).toMatch(/If it is wrong: \S/);
  });
});

describe("a provider's row", () => {
  it("says the provider is changed from the Plugins section or the CLI", async () => {
    await pageOn("machine");
    expect(within(rowOf("tickets.providers.tracker.provider")).getByText("Change the provider with the Plugins section or agent-org plugin.")).toBeTruthy();
  });
});

describe("returning a key to its default", () => {
  it("stages the key's removal from a row the file holds, and the button goes", async () => {
    await pageOn("workers");
    fireEvent.click(within(rowOf("tickets.stallMinutes")).getByRole("button", { name: /^Return \S+ to default$/ }));
    expect(screen.getByRole("region", { name: /^Unsaved changes/ }).textContent).toContain("1 unsaved change");
    expect(inputOf("tickets.stallMinutes").value).toBe("");
    expect(within(rowOf("tickets.stallMinutes")).queryByRole("button", { name: /^Return \S+ to default$/ })).toBeNull();
  });

  it("sends the removal when saved", async () => {
    const { fetchWith } = await pageOn("workers");
    fireEvent.click(within(rowOf("tickets.stallMinutes")).getByRole("button", { name: /^Return \S+ to default$/ }));
    fireEvent.click(within(screen.getByRole("region", { name: /^Unsaved changes/ })).getByRole("button", { name: "Review changes" }));
    await screen.findByRole("button", { name: "Save to host.json" });
    expect(posts(fetchWith, "/api/settings/preview").map((request) => request.body)).toEqual([{ file: "host.json", changes: [{ key: "tickets.stallMinutes", remove: true }] }]);
  });

  it("takes a switch back to its default, which the switch itself cannot", async () => {
    const files = { ...BOARD_FILES, host: { ...BOARD_FILES.host, tickets: { ...(BOARD_FILES.host.tickets as object), drafts: true } } };
    const { fetchWith } = await pageOn("workers", { state: settingsOf({ view: () => viewOf(files) }) });
    expect((inputOf("tickets.drafts") as HTMLInputElement).checked).toBe(true);
    fireEvent.click(within(rowOf("tickets.drafts")).getByRole("button", { name: /^Return \S+ to default$/ }));
    expect(within(rowOf("tickets.drafts")).getByText("default")).toBeTruthy();
    fireEvent.click(within(screen.getByRole("region", { name: /^Unsaved changes/ })).getByRole("button", { name: "Review changes" }));
    await screen.findByRole("button", { name: "Save to host.json" });
    expect(posts(fetchWith, "/api/settings/preview").map((request) => request.body)).toEqual([{ file: "host.json", changes: [{ key: "tickets.drafts", remove: true }] }]);
  });

  it("puts focus on the row's input, so a keyboard user is not left on the page when the button goes", async () => {
    await pageOn("workers");
    fireEvent.click(within(rowOf("tickets.stallMinutes")).getByRole("button", { name: "Return tickets.stallMinutes to default" }));
    expect(document.activeElement).toBe(inputOf("tickets.stallMinutes"));
  });

  it("settles when the switch is saved removed: the file holds no value, so nothing stays staged", async () => {
    const files = { ...BOARD_FILES, host: { ...BOARD_FILES.host, tickets: { ...(BOARD_FILES.host.tickets as object), drafts: true } } };
    const state = settingsOf({ view: () => viewOf(files) });
    await pageOn("workers", { state });
    fireEvent.click(within(rowOf("tickets.drafts")).getByRole("button", { name: "Return tickets.drafts to default" }));
    fireEvent.click(within(screen.getByRole("region", { name: /^Unsaved changes/ })).getByRole("button", { name: "Review changes" }));
    fireEvent.click(await screen.findByLabelText("I am changing tickets.drafts"));
    fireEvent.click(screen.getByRole("button", { name: "Save to host.json" }));
    state.view = () => viewOf(BOARD_FILES);
    await screen.findByText("Saved to host.json.");
    await waitFor(() => expect(screen.queryByRole("region", { name: /^Unsaved changes/ })).toBeNull());
  });

  it("is not offered on a key the file does not hold", async () => {
    await pageOn("workers");
    expect(within(rowOf("tickets.preflight")).queryByRole("button", { name: /^Return \S+ to default$/ })).toBeNull();
  });
});

describe("what the Conventions plugin says besides its keys", () => {
  const withNotes = (): SettingsView => ({
    ...viewOf(),
    plugins: [{ plugin: "conventions@a11ign", installed: "installed for every folder", loads: "a worker's session loads it" }],
    contract: [{ plugin: "conventions@a11ign", kind: "connector-need", why: "it needs the connector `linear`, which tickets.connectors does not allow" }],
    words: ["A command matching `rm -rf` is refused, because it deletes."],
  } as never);

  it("is a closed disclosure on Machine with the plugins, the mismatches and the connector and deny words", async () => {
    await pageOn("machine", { state: settingsOf({ view: withNotes }) });
    const node = document.querySelector<HTMLDetailsElement>("details.settings-conventions") as HTMLDetailsElement;
    expect(node.open).toBe(false);
    const lines = [...node.querySelectorAll("li")].map((item) => item.textContent);
    expect(lines).toEqual([
      "conventions@a11ign: installed for every folder; a worker's session loads it",
      "Mismatch: it needs the connector `linear`, which tickets.connectors does not allow",
      "A command matching `rm -rf` is refused, because it deletes.",
    ]);
  });

  it("is not drawn when the instance sends none of them", async () => {
    await pageOn("machine");
    expect(document.querySelector("details.settings-conventions")).toBeNull();
  });

  it("is not on the Workers page", async () => {
    await pageOn("workers", { state: settingsOf({ view: withNotes }) });
    await waitFor(() => expect(screen.getByRole("heading", { name: "Settings" })).toBeTruthy());
    expect(document.querySelector("details.settings-conventions")).toBeNull();
  });
});

// The quiet Reconnecting line of every page (A11-211, PARITY.md): the Settings pages had a skeleton and an error banner but no line for an instance that is restarting.
describe("the Settings page while the instance restarts", () => {
  it("shows the Reconnecting line and the page's skeleton, with no red, when the first read finds the instance gone", async () => {
    const state = settingsOf({ viewFails: { status: 502, error: "no answer within 30 seconds" } });
    await pageOn("workers", { state, ready: false });
    const line = await screen.findByText("Reconnecting…");
    expect(line.getAttribute("role")).toBe("status");
    expect(line.getAttribute("title")).toBe("no answer within 30 seconds");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("status", { name: "Loading settings" })).toBeTruthy();
  });

  it("keeps the settings it read, under the line, once they were read and the instance goes", async () => {
    const state = settingsOf();
    await pageOn("workers", { state });
    state.viewFails = { status: 503, error: "service unavailable" };
    document.dispatchEvent(new Event("visibilitychange"));
    await screen.findByText("Reconnecting…");
    expect(keysShown()).toContain("tickets.drafts");
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
