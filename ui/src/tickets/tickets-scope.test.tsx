import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { ticket } from "../../test/fixtures.ts";
import { answers, keysShown, openPage, standOf, textOf } from "./tickets-harness.tsx";

// A11-427: at 1024px and below the sidebar's projects and goals are the Project and Goal chips under the Tickets header, which open one dialog with the same lists and handlers.

const TICKETS = [
  ticket({ key: "A11-1", project: "a11ign", goals: ["Fleet"] }), ticket({ key: "A11-2", project: "a11ign", goals: ["Clean boundaries"] }),
  ticket({ key: "A11-3", project: "agent-org", goals: ["Fleet"] }),
];

const chips = () => within(screen.getByRole("group", { name: "Scope" }));
const dialog = () => screen.getByRole("dialog", { name: "Project and goal" });
const sidebarProject = (name: string) => within(document.querySelector<HTMLElement>(".filter-group-projects")!).getByRole("button", { name: new RegExp(`^${name}`) });

async function openScope() {
  await openPage(standOf(answers(TICKETS)));
  await waitFor(() => chips().getByRole("button", { name: /^Project/ }));
  fireEvent.click(chips().getByRole("button", { name: /^Project/ }));
  return within(dialog());
}

describe("the Project and Goal chips", () => {
  it("name the project and the goal shown", async () => {
    await openPage(standOf(answers(TICKETS)));
    await waitFor(() => expect(chips().getAllByRole("button").map(textOf)).toEqual(["Project a11ign", "Goal All goals"]));
    expect(chips().getByRole("button", { name: /^Goal/ }).getAttribute("aria-haspopup")).toBe("dialog");
  });

  it("open a modal dialog with the Projects list, the Goals list with their counts, and Done, and take the focus into it", async () => {
    const inDialog = await openScope();
    expect(dialog().getAttribute("aria-modal")).toBe("true");
    expect(within(inDialog.getByRole("group", { name: "Projects" })).getAllByRole("button").map(textOf)).toEqual(["a11ign2", "agent-org1"]);
    expect(within(inDialog.getByRole("group", { name: "Goals" })).getAllByRole("button").map(textOf)).toEqual(["All goals2", "Clean boundaries1", "Fleet1"]);
    expect(inDialog.getByRole("button", { name: "Done" })).toBeTruthy();
    expect(dialog().contains(document.activeElement)).toBe(true);
    expect(chips().getAllByRole("button").map((chip) => chip.getAttribute("aria-expanded"))).toEqual(["true", "true"]);
  });

  it("choose a project as the sidebar does, and Done closes the dialog on the list of that project", async () => {
    const inDialog = await openScope();
    fireEvent.click(within(inDialog.getByRole("group", { name: "Projects" })).getByRole("button", { name: /^agent-org/ }));
    expect(sidebarProject("agent-org").getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(inDialog.getByRole("button", { name: "Done" }));
    expect(screen.queryByRole("dialog", { name: "Project and goal" })).toBeNull();
    await waitFor(() => expect(keysShown()).toEqual(["A11-3"]));
    expect(textOf(chips().getByRole("button", { name: /^Project/ }))).toBe("Project agent-org");
  });

  it("choose a goal as the sidebar does", async () => {
    const inDialog = await openScope();
    fireEvent.click(within(inDialog.getByRole("group", { name: "Goals" })).getByRole("button", { name: /^Fleet/ }));
    await waitFor(() => expect(keysShown()).toEqual(["A11-1"]));
    expect(textOf(chips().getByRole("button", { name: /^Goal/ }))).toBe("Goal Fleet");
  });

  it("closes on Escape and keeps Tab inside the dialog", async () => {
    const inDialog = await openScope();
    const done = inDialog.getByRole("button", { name: "Done" });
    const last = within(inDialog.getByRole("group", { name: "Goals" })).getAllByRole("button").at(-1)!;
    last.focus();
    fireEvent.keyDown(last, { key: "Tab" });
    expect(document.activeElement).toBe(done);
    fireEvent.keyDown(dialog(), { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Project and goal" })).toBeNull();
  });
});
