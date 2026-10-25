import { cleanup, render } from "@testing-library/react";
import { answerOf, pluginsFetch, pluginsSettings, standOf as pluginsOf } from "../../test/plugins/plugins-stand.ts";
import { instanceOf, keysShown, pageOn, PERSONAL, screen, standOf, within } from "./settings-harness.tsx";
import { standOf as settingsOf, viewOf } from "../../test/settings/settings-stand.ts";
import { PluginsApp } from "../plugins/PluginsApp.tsx";

// The Settings board for an SSH remote that cannot be reached (A11-195): Retry and no Last known pill, above the last settings the proxy kept.
describe("the Settings page of an SSH remote that cannot be reached", () => {
  const REFUSAL = "cannot reach personal over SSH: Permission denied (publickey)";

  it("shows the last settings the proxy kept above the frame when the page opens while it is down, with Retry and no Last known pill, and no age", async () => {
    const state = settingsOf({ viewFails: { status: 502, error: REFUSAL, lastKnown: { value: viewOf(), readAt: "2026-10-24T10:00:00.000Z" } } });
    await pageOn("workers", { stand: standOf(instanceOf(), PERSONAL), state, ready: false });
    const frame = await screen.findByRole("alert");
    expect(frame.textContent).toContain("Can't reach personal over SSH.");
    expect(frame.textContent).toContain("These are the last settings it read.");
    expect(within(frame).getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(screen.queryByText("Last known")).toBeNull();
    expect(screen.queryByRole("button", { name: "Check now" })).toBeNull();
    expect(keysShown()).toContain("tickets.drafts");
    expect(document.body.textContent).not.toContain("2026-10-24");
  });

  it("returns to the live settings when Retry's read is answered", async () => {
    const state = settingsOf({ viewFails: { status: 502, error: REFUSAL, lastKnown: { value: viewOf(), readAt: "2026-10-24T10:00:00.000Z" } } });
    await pageOn("workers", { stand: standOf(instanceOf(), PERSONAL), state, ready: false });
    const frame = await screen.findByRole("alert");
    delete state.viewFails;
    within(frame).getByRole("button", { name: "Retry" }).click();
    await waitForNoAlert();
    expect(keysShown()).toContain("tickets.drafts");
  });

  it("is the error state, with no unreachable frame, for a local instance that fails", async () => {
    const state = settingsOf({ viewFails: { status: 502, error: REFUSAL, lastKnown: { value: viewOf(), readAt: "2026-10-24T10:00:00.000Z" } } });
    await pageOn("workers", { state, ready: false });
    await new Promise((done) => setTimeout(done, 100));
    expect(screen.queryByText("Can't reach personal over SSH.")).toBeNull();
    expect(keysShown()).toEqual([]);
  });
});

// A PAGE THE TAB HAS DRAWN, OPENED AGAIN WHILE ITS REMOTE CANNOT BE REACHED (A11-270): the settings it last read are drawn under the frame, never the refusal in their place, and so are
// the proxy's last known plugins on a Plugins page that holds none of its own yet.
describe("a Settings page whose SSH remote drops between two visits", () => {
  const HUNG_UP = { status: 502, error: "cannot reach personal over SSH: socket hung up" };
  const live = () => standOf(instanceOf(), PERSONAL);
  const down = () => standOf(instanceOf({ configFail: HUNG_UP, queueFails: HUNG_UP }), PERSONAL);
  const framed = async () => (await screen.findAllByRole("alert")).map((alert) => alert.textContent ?? "").join(" ");

  /** Draw `section` with its remote answering, then again with the remote gone, as a click back to it after a drop does: resolves to the keys the first visit drew. */
  async function reopenedWhileDown(section: "machine" | "models" | "workers"): Promise<string[]> {
    await pageOn(section, { stand: live() });
    const shown = keysShown();
    cleanup();
    await pageOn(section, { stand: down(), state: settingsOf({ viewFails: HUNG_UP }), ready: false });
    expect(await framed()).toContain("Can't reach personal over SSH.");
    return shown;
  }

  it.each(["machine", "models", "workers"] as const)("%s draws the settings it last read under the frame, with the proxy keeping nothing", async (section) => {
    const shown = await reopenedWhileDown(section);
    expect(shown.length).toBeGreaterThan(0);
    expect(keysShown()).toEqual(shown);
  });

  it.each([["models", "new-runs-model"], ["workers", "workers-at-once"]] as const)("%s draws its own control under the frame too", async (section, control) => {
    await reopenedWhileDown(section);
    expect(document.getElementById(control)).not.toBeNull();
  });

  it("Plugins draws the proxy's last known plugins as the Unknown board when the tab holds none, not the frame alone", async () => {
    history.replaceState(null, "", "/settings/plugins");
    const kept = { lastKnown: { value: answerOf(), readAt: "2026-10-24T10:00:00.000Z" } };
    const plugins = pluginsOf({ fails: { ...HUNG_UP, ...kept }, queueFails: HUNG_UP });
    render(<PluginsApp fetchWith={pluginsFetch(standOf(instanceOf(), PERSONAL), plugins, pluginsSettings())} />);
    await screen.findByText("Plugin health is unknown.");
    expect(screen.getByRole("region", { name: "Tracker" })).toBeTruthy();
  });
});

async function waitForNoAlert(): Promise<void> {
  const { waitFor } = await import("@testing-library/react");
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
}
