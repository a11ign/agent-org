import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { HERE, PERSONAL } from "../../test/fixtures.ts";
import { STAGES, writerBoard, writerRun } from "./new-ticket-fixtures.ts";
import { dialog, inDialog, openDialog, pageWith, sent, strips, typeRequest, writeButton } from "./new-ticket-harness.tsx";

// An SSH connection that drops while the dialog is open: what was typed stays, nothing is sent until it answers, and the strip waits.

const REFUSAL = "cannot reach personal over SSH: agents: Permission denied (publickey).";

/** The page on an SSH connection that can be taken down: while `link.down` is set the queue read finds it unreachable. */
async function pageOnSsh(runs = [STAGES.writing]) {
  const board = writerBoard(runs);
  const link = { down: false };
  Object.defineProperty(board.instance, "queueFails", { get: () => (link.down ? { status: 502, error: REFUSAL } : undefined) });
  history.replaceState(null, "", "/next/tickets?connection=personal");
  const page = await pageWith({ connections: [HERE, PERSONAL], instances: { personal: board.instance, here: board.instance } });
  await screen.findAllByRole("region", { name: "New ticket request" });
  return { ...page, link };
}

const refocus = () => act(async () => { window.dispatchEvent(new Event("focus")); });

describe("a connection that drops with the dialog open", () => {
  it("keeps the dialog, the draft and the strip, and holds Write ticket and Stop until it answers again", async () => {
    const { link, base } = await pageOnSsh();
    openDialog();
    typeRequest("A request typed before the link dropped");
    link.down = true;
    await refocus();
    await screen.findByText("Can't reach personal over SSH.");
    expect((inDialog().getByLabelText("What is the ticket for?") as HTMLTextAreaElement).value).toBe("A request typed before the link dropped");
    expect(writeButton().disabled).toBe(true);
    expect(writeButton().title).toBe("Paused until personal is reachable");
    expect((within(strips()[0] as HTMLElement).getByRole("button", { name: "Stop" }) as HTMLButtonElement).disabled).toBe(true);
    link.down = false;
    fireEvent.click(screen.getByRole("button", { name: "Check now" }));
    await waitFor(() => expect(writeButton().disabled).toBe(false));
    expect(writeButton().title).toBe("");
    expect(sent(base)).toEqual([]);
    expect(dialog()).toBeTruthy();
    expect((within(strips()[0] as HTMLElement).getByRole("button", { name: "Stop" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("keeps the strip's request across the drop, so a request in the strip is the same one after it", async () => {
    const { link } = await pageOnSsh([writerRun({ id: "w9", phase: "queued", status: "queued" })]);
    const before = strips()[0];
    link.down = true;
    await refocus();
    await screen.findByText("Can't reach personal over SSH.");
    expect(strips()[0]).toBe(before);
  });
});
