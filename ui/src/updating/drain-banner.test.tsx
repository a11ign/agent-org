import { render, screen } from "@testing-library/react";
import { updateBanner, type UpdateNote } from "../../../src/ticket-mode/board-view/update-banner.ts";
import { HERE, queueOf, standFetch, type Stand } from "../../test/fixtures.ts";
import type { QueueView } from "../api/types.ts";
import type { Page } from "../shell/routes.ts";
import { ShellFrame } from "../shell/ShellFrame.tsx";
import { ShellProvider } from "../shell/ShellProvider.tsx";

const DEADLINE = new Date(2026, 9, 24, 14, 30).getTime();
export const NOTE: UpdateNote = { target: "v0.280.0", deadline: DEADLINE, finishing: 3, forced: false, stopped: 0 };

/** A stand-in instance whose queue carries `update`. */
const standWith = (update: unknown): Stand => ({ connections: [HERE], instances: { here: { queue: { ...queueOf("running"), update } as unknown as QueueView } } });

/** The shell on `page` over a queue with `update`, resolved once the sidebar has been drawn from it. */
async function shellOn(page: Page, update: unknown) {
  history.replaceState(null, "", "/tickets");
  render(
    <ShellProvider fetchWith={standFetch(standWith(update))}>
      <ShellFrame page={page}>
        <h1>The page</h1>
      </ShellFrame>
    </ShellProvider>,
  );
  await screen.findByText("1", { selector: ".run-badge" });
}

describe("the drain banner", () => {
  it("is the backend's banner text in an amber box with a dot, above the page, on Tickets", async () => {
    await shellOn("tickets", { version: "v0.273.0", note: NOTE, next: null });
    const banner = screen.getByText("Updating to v0.280 (breaking): no new runs start; 3 runs finishing; forced at 14:30").closest(".drain-banner") as HTMLElement;
    expect(banner.getAttribute("role")).toBe("status");
    expect(banner.querySelector(".drain-banner-dot")).toBeTruthy();
    expect(screen.getByText("The page").compareDocumentPosition(banner) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
    expect(banner.parentElement?.tagName).toBe("MAIN");
    expect(banner.parentElement?.firstElementChild).toBe(banner);
  });

  it("says what the backend says for every wording of the note, never its own", async () => {
    const forced: UpdateNote = { ...NOTE, forced: true, stopped: 2, finishing: 0 };
    await shellOn("tickets", { version: "v0.273.0", note: forced, next: null });
    expect(screen.getByText(updateBanner(forced) ?? "")).toBeTruthy();
    expect(updateBanner(forced)).toBe("Updating to v0.280 (breaking): no new runs start; 2 runs stopped at 14:30 and queued again; applying now");
  });

  it("is on the Runs page too", async () => {
    await shellOn("runs", { version: "v0.273.0", note: NOTE, next: null });
    expect(screen.getByText("Updating to v0.280 (breaking): no new runs start; 3 runs finishing; forced at 14:30")).toBeTruthy();
  });

  it("is not drawn without a drain note: a calm instance, a normal update under way, and an older instance with no update field", async () => {
    for (const update of [{ version: "v0.273.0", note: null, next: null }, { version: "v0.273.0", note: null, next: "v0.280.0" }, null, undefined]) {
      await shellOn("tickets", update);
      expect(document.querySelector(".drain-banner")).toBeNull();
      document.body.innerHTML = "";
    }
  });

  it("is on no page the boards draw none on: a run's page, and Settings", async () => {
    for (const page of ["run", "models", "plugins"] as const) {
      await shellOn(page, { version: "v0.273.0", note: NOTE, next: null });
      expect(document.querySelector(".drain-banner")).toBeNull();
      document.body.innerHTML = "";
    }
  });
});
