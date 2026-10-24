import { instanceOf, keysShown, pageOn, PERSONAL, screen, standOf, within } from "./settings-harness.tsx";
import { standOf as settingsOf, viewOf } from "../../test/settings/settings-stand.ts";

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

async function waitForNoAlert(): Promise<void> {
  const { waitFor } = await import("@testing-library/react");
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
}
