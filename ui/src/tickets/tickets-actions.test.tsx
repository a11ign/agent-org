import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { queueingConfig, ticket } from "../../test/fixtures.ts";
import { answers, openPage, posts, rowOf, standOf, textOf } from "./tickets-harness.tsx";

describe("Queue its children and Grill", () => {
  const epic = ticket({ key: "A11-5", title: "An epic", children: ["A11-6", "A11-7"] } as never);
  const decision = ticket({ key: "A11-2", title: "Needs a ruling", needsDecision: { kind: "open", reason: "why" } } as never);

  it("queues a parent's children on the batch's choice, and says what was queued above the list", async () => {
    const post = (path: string) => (path === "/api/queue-children" ? { queue: { entries: [], paused: false }, keys: ["A11-6", "A11-7"], note: "ordered by identifier" } : undefined);
    const { fetchWith } = await openPage(standOf(answers([epic], { post })));
    fireEvent.click(within(rowOf("A11-5")).getByRole("button", { name: "Queue its children" }));
    const notice = await screen.findByText("Queued A11-5's children: A11-6, A11-7. Note: ordered by identifier.");
    expect(notice.closest("[role=status]")).toBeTruthy();
    expect(posts(fetchWith, "/api/queue-children")[0].body).toEqual({ key: "A11-5", model: "sonnet", effort: "high", plan: true });
  });

  it("says when none of them could be queued", async () => {
    const post = () => ({ queue: { entries: [], paused: false }, keys: [], note: null });
    await openPage(standOf(answers([epic], { post })));
    fireEvent.click(within(rowOf("A11-5")).getByRole("button", { name: "Queue its children" }));
    expect(await screen.findByText("None of A11-5's sub-issues could be queued.")).toBeTruthy();
  });

  it("shows the server's sentence when it refuses to queue the children", async () => {
    await openPage(standOf(answers([epic], { post: () => ({ status: 400, error: "A11-5 has no open sub-issues" }) })));
    fireEvent.click(within(rowOf("A11-5")).getByRole("button", { name: "Queue its children" }));
    expect(textOf(await screen.findByRole("alert"))).toContain("A11-5 has no open sub-issues");
  });

  it("starts a Grill in a blank tab opened in the click, and points the tab at the run's terminal once it has one", async () => {
    const tab = { closed: false, close: rstest.fn(), location: { href: "" } };
    const open = rstest.spyOn(window, "open").mockReturnValue(tab as never);
    const run = { id: "grill-1", request: "Grill A11-2", mode: "grill", placement: "auto", phase: "running", status: "writing", form: {}, workspace: "w1", pane: "p1", tickets: [], ticket: "A11-2" };
    const post = (path: string) => (path === "/api/grill-ticket" ? { runs: [run] } : undefined);
    const instance = answers([decision], { config: queueingConfig({ terminal: "https://terminal.example/{workspace}/{pane}" } as never), post, writer: { runs: [run] } as never });
    const { fetchWith } = await openPage(standOf(instance));
    fireEvent.click(within(rowOf("A11-2")).getByRole("button", { name: "Grill" }));
    expect(open).toHaveBeenCalledWith("", "_blank");
    await waitFor(() => expect(tab.location.href).toBe(`/c/here/terminal?link=${encodeURIComponent("https://terminal.example/w1/p1")}`));
    expect(posts(fetchWith, "/api/grill-ticket")[0].body).toEqual({ key: "A11-2" });
    open.mockRestore();
  });

  it("closes the blank tab when the Grill is refused, and says why", async () => {
    const tab = { closed: false, close: rstest.fn(), location: { href: "" } };
    const open = rstest.spyOn(window, "open").mockReturnValue(tab as never);
    await openPage(standOf(answers([decision], { post: () => ({ status: 400, error: "no terminal" }) })));
    fireEvent.click(within(rowOf("A11-2")).getByRole("button", { name: "Grill" }));
    expect(textOf(await screen.findByRole("alert"))).toContain("no terminal");
    expect(tab.close).toHaveBeenCalled();
    open.mockRestore();
  });

  it("disables Grill, with the reason, where the machine writes no tickets or has no terminal", async () => {
    const { unmount } = await openPage(standOf(answers([decision], { config: queueingConfig({ writer: false }) })));
    const grill = within(rowOf("A11-2")).getByRole("button", { name: "Grill" }) as HTMLButtonElement;
    expect(grill.disabled).toBe(true);
    expect(grill.title).toContain("names no tickets.writer");
    unmount();
    await openPage(standOf(answers([decision], { config: queueingConfig({ writerGrill: false }) })));
    expect((within(rowOf("A11-2")).getByRole("button", { name: "Grill" }) as HTMLButtonElement).title).toBe("Grill needs a terminal: name tickets.terminal in the host file");
  });
});
