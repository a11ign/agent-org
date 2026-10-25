import { fireEvent, screen, within } from "@testing-library/react";
import { OTHER, queueingConfig, ticket } from "../../test/fixtures.ts";
import { STAGES, writingConfig } from "./new-ticket-fixtures.ts";
import { dialog, inDialog, openDialog, pageOver, textOf, typeRequest, writeButton } from "./new-ticket-harness.tsx";

// The New ticket, Manual placement and No terminal for Grill boards: the dialog the Tickets page's New ticket button opens.

describe("the dialog", () => {
  it("opens from the header's New ticket, over the page, with the board's words", async () => {
    await pageOver();
    expect(screen.queryByRole("dialog")).toBeNull();
    openDialog();
    expect(dialog().getAttribute("aria-modal")).toBe("true");
    expect(textOf(inDialog().getByRole("heading", { level: 2 }))).toBe("New ticket");
    expect(inDialog().getByLabelText("What is the ticket for?")).toBeTruthy();
    expect((inDialog().getByLabelText("What is the ticket for?") as HTMLTextAreaElement).placeholder).toBe("Describe it in plain words. The writer turns it into one or more tickets.");
    expect(textOf(document.getElementById("new-ticket-count"))).toBe("0 / 8000 · one request can become up to 10 tickets");
  });

  it("counts the request against the limits the server enforces", async () => {
    await pageOver();
    openDialog();
    typeRequest("Add a retry button");
    expect(textOf(document.getElementById("new-ticket-count"))).toBe("18 / 8000 · one request can become up to 10 tickets");
    expect((inDialog().getByLabelText("What is the ticket for?") as HTMLTextAreaElement).maxLength).toBe(8000);
  });

  it("opens from the empty panel's New ticket too", async () => {
    await pageOver([], { tickets: [ticket({ key: "A11-9", title: "Someone else's", assignee: OTHER })] });
    await screen.findByText("Nothing is assigned to you");
    const [header, panel] = screen.getAllByRole("button", { name: "New ticket" });
    expect((panel as HTMLButtonElement).disabled).toBe(false);
    expect(header).not.toBe(panel);
    fireEvent.click(panel as HTMLElement);
    expect(dialog()).toBeTruthy();
  });

  it("takes the focus into the request, and gives it back to the button that opened it on Escape", async () => {
    await pageOver();
    const opener = screen.getByRole("button", { name: "New ticket" });
    opener.focus();
    openDialog();
    expect(document.activeElement).toBe(inDialog().getByLabelText("What is the ticket for?"));
    fireEvent.keyDown(document.activeElement as Element, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it("closes with Close and with Cancel", async () => {
    await pageOver();
    openDialog();
    fireEvent.click(inDialog().getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    openDialog();
    fireEvent.click(inDialog().getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("keeps Tab inside: past the last control it goes to the first, and Shift+Tab past the first to the last", async () => {
    await pageOver();
    openDialog();
    const [close, cancel] = [inDialog().getByRole("button", { name: "Close" }), inDialog().getByRole("button", { name: "Cancel" })];
    cancel.focus();
    expect(fireEvent.keyDown(cancel, { key: "Tab" })).toBe(false);
    expect(document.activeElement).toBe(close);
    expect(fireEvent.keyDown(close, { key: "Tab", shiftKey: true })).toBe(false);
    expect(document.activeElement).toBe(cancel);
  });

  it("keeps the draft when it is closed without sending, and shows it when it is opened again", async () => {
    await pageOver();
    openDialog();
    typeRequest("A draft");
    fireEvent.click(inDialog().getByRole("button", { name: "Cancel" }));
    openDialog();
    expect((inDialog().getByLabelText("What is the ticket for?") as HTMLTextAreaElement).value).toBe("A draft");
  });
});

describe("Quick or Grill", () => {
  it("offers both with their words, Quick chosen", async () => {
    await pageOver();
    openDialog();
    const group = inDialog().getByRole("radiogroup", { name: "How to write it" });
    const [quick, grill] = within(group).getAllByRole("radio") as HTMLInputElement[];
    expect(quick?.checked).toBe(true);
    expect(grill?.checked).toBe(false);
    expect(textOf(quick?.closest("label"))).toBe("QuickThe writer files it straight away. No questions.");
    expect(textOf(grill?.closest("label"))).toBe("GrillOpens a terminal where the writer asks you questions first.");
    expect(quick?.closest("label")?.className).toContain("nt-mode-chosen");
  });

  it("chooses Grill, and the chosen card takes the accent", async () => {
    await pageOver();
    openDialog();
    const grill = inDialog().getByRole("radio", { name: /^Grill/ }) as HTMLInputElement;
    fireEvent.click(grill);
    expect(grill.checked).toBe(true);
    expect(grill.closest("label")?.className).toContain("nt-mode-chosen");
    expect((inDialog().getByRole("radio", { name: /^Quick/ }) as HTMLInputElement).checked).toBe(false);
  });

  it("no terminal: Grill is disabled and says what to name in the host file", async () => {
    await pageOver([], {}, writingConfig({ writerGrill: false }));
    openDialog();
    const grill = inDialog().getByRole("radio", { name: /^Grill/ }) as HTMLInputElement;
    expect(grill.disabled).toBe(true);
    expect(textOf(grill.closest("label"))).toBe("GrillNeeds a terminal: name tickets.terminal in the host file.");
    expect((inDialog().getByRole("radio", { name: /^Quick/ }) as HTMLInputElement).checked).toBe(true);
  });
});

describe("Auto or Manual placement", () => {
  it("opens on Auto, and says the writer picks", async () => {
    await pageOver();
    openDialog();
    const [auto, manual] = within(inDialog().getByRole("radiogroup", { name: "Placement" })).getAllByRole("radio");
    expect(auto?.getAttribute("aria-checked")).toBe("true");
    expect(manual?.getAttribute("aria-checked")).toBe("false");
    expect(textOf(auto)).toBe("Auto");
    expect(inDialog().getByText("The writer picks the project, repository, goal and priority from your request. You can change any of them on the ticket afterwards.")).toBeTruthy();
    expect(inDialog().queryByLabelText("Project")).toBeNull();
  });

  it("Manual shows the board's five fields, each on Not set, with the options the page reads", async () => {
    await pageOver();
    openDialog();
    fireEvent.click(inDialog().getByRole("radio", { name: "Manual" }));
    expect(inDialog().queryByText(/The writer picks/)).toBeNull();
    const optionsOf = (label: string) => [...(inDialog().getByLabelText(label) as HTMLSelectElement).options].map((option) => option.textContent);
    expect(optionsOf("Project")).toEqual(["Not set", "a11ign", "agent-org"]);
    expect(optionsOf("Repository")).toEqual(["Not set", "agent-org", "a11ign"]);
    expect(optionsOf("Goal")).toEqual(["Not set", "Capture quality", "Clean boundaries", "Fleet"]);
    expect(optionsOf("Priority")).toEqual(["Not set", "Urgent", "High", "Medium", "Low", "No priority"]);
    for (const label of ["Project", "Repository", "Goal", "Priority"]) expect((inDialog().getByLabelText(label) as HTMLSelectElement).value).toBe("");
    const parent = inDialog().getByLabelText(/^Parent ticket/) as HTMLInputElement;
    expect(parent.placeholder).toBe("A11-24");
    expect(textOf(parent.closest("label"))).toBe("Parent ticket (optional, makes this a sub-issue)");
    expect(inDialog().getByRole("radio", { name: "Manual" }).getAttribute("aria-checked")).toBe("true");
  });

  it("keeps what was set in Manual when Auto is chosen and Manual again", async () => {
    await pageOver();
    openDialog();
    fireEvent.click(inDialog().getByRole("radio", { name: "Manual" }));
    fireEvent.change(inDialog().getByLabelText("Project"), { target: { value: "agent-org" } });
    fireEvent.click(inDialog().getByRole("radio", { name: "Auto" }));
    fireEvent.click(inDialog().getByRole("radio", { name: "Manual" }));
    expect((inDialog().getByLabelText("Project") as HTMLSelectElement).value).toBe("agent-org");
  });

  it("offers the instance's own priorities, and the board's defaults to an instance that names none", async () => {
    const older = { ...queueingConfig({ terminal: null } as never) } as never;
    await pageOver([], {}, older);
    openDialog();
    fireEvent.click(inDialog().getByRole("radio", { name: "Manual" }));
    expect([...(inDialog().getByLabelText("Priority") as HTMLSelectElement).options].map((option) => option.textContent)).toEqual(["Not set", "Urgent", "High", "Medium", "Low", "No priority"]);
    expect([...(inDialog().getByLabelText("Repository") as HTMLSelectElement).options].map((option) => option.textContent)).toEqual(["Not set"]);
  });
});

describe("the writer pill and the buttons", () => {
  it("shows the writer's model and effort from the Settings choice, linking to Settings", async () => {
    await pageOver([], {}, writingConfig({ choice: { model: "sonnet", effort: "high", planModel: "opus", planEffort: "low", writerModel: "opus", writerEffort: "low" } } as never));
    openDialog();
    const pill = inDialog().getByRole("link", { name: "Ticket writer: opus, low effort. Change in Settings" });
    expect(textOf(pill)).toBe("Writer" + "opus · low");
    expect(pill.getAttribute("href")).toBe("/settings/models");
    expect(pill.getAttribute("title")).toBe("Ticket writer model and effort. Change in Settings");
  });

  it("falls back to the host file's model and effort where Settings holds none", async () => {
    await pageOver([], {}, writingConfig({ writerDefault: { model: "haiku", effort: "medium" } }));
    openDialog();
    expect(textOf(inDialog().getByRole("link", { name: "Ticket writer: haiku, medium effort. Change in Settings" }))).toBe("Writerhaiku · medium");
  });

  it("disables Write ticket while the request is empty, with the reason as its title, and enables it once there is a request", async () => {
    await pageOver();
    openDialog();
    expect(writeButton().disabled).toBe(true);
    expect(writeButton().title).toBe("Write what the ticket is for, in plain words");
    typeRequest("   ");
    expect(writeButton().disabled).toBe(true);
    typeRequest("Add a retry button");
    expect(writeButton().disabled).toBe(false);
    expect(writeButton().title).toBe("");
    expect(textOf(writeButton())).toBe("Write ticket");
  });

  it("does not draw a stale request strip under the dialog for an idle instance", async () => {
    await pageOver([STAGES.done]);
    openDialog();
    expect(screen.getAllByRole("region", { name: "New ticket request" }).length).toBe(1);
  });
});
