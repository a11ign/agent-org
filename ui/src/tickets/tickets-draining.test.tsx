import { act, screen, waitFor } from "@testing-library/react";
import { queueOf } from "../../test/fixtures.ts";
import type { QueueView } from "../api/types.ts";
import { answers, pageOn, standOf } from "./tickets-harness.tsx";

// The Tickets page while a breaking update drains (A11-217): the banner `AtomautTicketsDraining` draws above the header, from the backend's own words.
const NOTE = { target: "v0.280.0", deadline: new Date(2026, 9, 24, 14, 30).getTime(), finishing: 3, forced: false, stopped: 0 };
const BANNER = "Updating to v0.280 (breaking): no new runs start; 3 runs finishing; forced at 14:30";

/** An instance whose queue carries the drain note while `link.note` is set. */
function draining() {
  const link: { note: typeof NOTE | null } = { note: NOTE };
  const instance = answers();
  Object.defineProperty(instance, "queue", { enumerable: true, get: () => ({ ...queueOf("running"), paused: false, update: { version: "v0.273.0", note: link.note, next: null } }) as unknown as QueueView });
  return { link, stand: standOf(instance) };
}

describe("the Tickets page while an update drains", () => {
  it("shows the banner above the page's header, in the shell's main column", async () => {
    await pageOn(draining().stand);
    const banner = screen.getByText(BANNER);
    const heading = screen.getByRole("heading", { level: 1, name: "Tickets" });
    expect(banner.closest(".drain-banner")?.compareDocumentPosition(heading)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(banner.closest("main")).toBe(heading.closest("main"));
  });

  it("goes away when the drain record does, on the next read of the queue", async () => {
    const { link, stand } = draining();
    await pageOn(stand);
    expect(screen.getByText(BANNER)).toBeTruthy();
    link.note = null;
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    await waitFor(() => expect(screen.queryByText(BANNER)).toBeNull());
    expect(screen.getByRole("heading", { level: 1, name: "Tickets" })).toBeTruthy();
  });

  it("is not there when nothing drains", async () => {
    const { link, stand } = draining();
    link.note = null;
    await pageOn(stand);
    expect(document.querySelector(".drain-banner")).toBeNull();
  });
});
