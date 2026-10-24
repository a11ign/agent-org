import { fireEvent, instanceOf, pageOn, PERSONAL, posts, reads, screen, section, standOf, waitFor, within } from "./settings-harness.tsx";
import { standOf as settingsOf } from "../../test/settings/settings-stand.ts";

const selectIn = (group: string, name: "Model" | "Effort"): HTMLSelectElement => within(section(group)).getByLabelText(name) as HTMLSelectElement;
const stateIn = (group: string): string[] => [...section(group).querySelectorAll(".save-state")].map((element) => element.textContent ?? "");

describe("model and effort choices save as soon as they change", () => {
  it("sends the one part that changed to /api/choice, says Saved beside it, and never previews", async () => {
    const { fetchWith } = await pageOn("models");
    expect(selectIn("New runs", "Model").value).toBe("opus");
    fireEvent.change(selectIn("New runs", "Model"), { target: { value: "sonnet" } });
    await waitFor(() => expect(stateIn("New runs")).toEqual(["Saved", ""]));
    expect(posts(fetchWith, "/api/choice").map((request) => request.body)).toEqual([{ model: "sonnet" }]);
    expect(posts(fetchWith, "/api/settings/preview")).toEqual([]);
    expect(posts(fetchWith, "/api/settings/save")).toEqual([]);
    expect(selectIn("New runs", "Model").value).toBe("sonnet");
    expect(screen.queryByRole("region", { name: "Unsaved changes" })).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("saves the effort, and each of planning and the ticket writer, part by part", async () => {
    const { fetchWith } = await pageOn("models");
    fireEvent.change(selectIn("New runs", "Effort"), { target: { value: "low" } });
    fireEvent.change(selectIn("Planning", "Model"), { target: { value: "sonnet" } });
    fireEvent.change(selectIn("Planning", "Effort"), { target: { value: "medium" } });
    fireEvent.change(selectIn("Ticket writer", "Model"), { target: { value: "sonnet" } });
    fireEvent.change(selectIn("Ticket writer", "Effort"), { target: { value: "low" } });
    await waitFor(() => expect(posts(fetchWith, "/api/choice")).toHaveLength(5));
    expect(posts(fetchWith, "/api/choice").map((request) => request.body)).toEqual([{ effort: "low" }, { planModel: "sonnet" }, { planEffort: "medium" }, { writerModel: "sonnet" }, { writerEffort: "low" }]);
  });

  it("offers the host file's writer values first, and saves \"\" to set the writer back to them", async () => {
    const { fetchWith } = await pageOn("models");
    const model = selectIn("Ticket writer", "Model");
    const effort = selectIn("Ticket writer", "Effort");
    expect([...model.options].map((option) => option.textContent)).toEqual(["Host default: opus", "opus", "sonnet"]);
    expect([...effort.options].map((option) => option.textContent)).toEqual(["Host default: high", "low", "medium", "high"]);
    expect(model.value).toBe("");
    fireEvent.change(model, { target: { value: "sonnet" } });
    await waitFor(() => expect(model.value).toBe("sonnet"));
    fireEvent.change(model, { target: { value: "" } });
    await waitFor(() => expect(posts(fetchWith, "/api/choice")).toHaveLength(2));
    expect(posts(fetchWith, "/api/choice").map((request) => request.body)).toEqual([{ writerModel: "sonnet" }, { writerModel: "" }]);
  });

  it("shows only the groups the instance has: no Planning without a planner, no Ticket writer without a writer", async () => {
    await pageOn("models", { stand: standOf(instanceOf({ config: { ...instanceOf().config!, planner: false, writer: false } })) });
    expect(screen.getByRole("heading", { name: "New runs" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Planning" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Ticket writer" })).toBeNull();
  });

  it("says the server's refusal beside the select, puts the select back to what is saved, and reads the choice again", async () => {
    const state = settingsOf({ answers: { choice: () => ({ status: 400, error: "A model the board does not offer is not saved; the saved one stands." }) } });
    const { fetchWith } = await pageOn("models", { state });
    const reading = reads(fetchWith, "/api/config").length;
    fireEvent.change(selectIn("New runs", "Model"), { target: { value: "sonnet" } });
    await waitFor(() => expect(stateIn("New runs")[0]).toBe("A model the board does not offer is not saved; the saved one stands."));
    await waitFor(() => expect(selectIn("New runs", "Model").value).toBe("opus"));
    expect(reads(fetchWith, "/api/config").length).toBeGreaterThan(reading);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("gives each select its own state: one saved, another refused", async () => {
    const state = settingsOf({ answers: { choice: (body) => ("effort" in body ? { status: 400, error: "An effort the board does not offer is not saved." } : { choice: { ...state.choice, ...body } }) } });
    await pageOn("models", { state });
    fireEvent.change(selectIn("New runs", "Model"), { target: { value: "sonnet" } });
    fireEvent.change(selectIn("New runs", "Effort"), { target: { value: "low" } });
    await waitFor(() => expect(stateIn("New runs")).toEqual(["Saved", "An effort the board does not offer is not saved."]));
    expect(stateIn("Planning")).toEqual(["", ""]);
  });

  it("still saves the choices of a remote instance, whose files are read-only", async () => {
    const { fetchWith } = await pageOn("models", { stand: standOf(instanceOf(), PERSONAL) });
    fireEvent.change(selectIn("New runs", "Model"), { target: { value: "sonnet" } });
    await waitFor(() => expect(stateIn("New runs")[0]).toBe("Saved"));
    expect(posts(fetchWith, "/api/choice").map((request) => request.path)).toEqual(["/c/personal/api/choice"]);
  });
});

describe("the worker pool saves as it changes", () => {
  const maxInput = () => screen.getByLabelText("Workers at once") as HTMLInputElement;
  const poolState = () => [...section("Worker pool").querySelectorAll(".save-state")].map((element) => element.textContent ?? "");

  it("shows the number of workers, saves a new one on change, and says Saved", async () => {
    const { fetchWith } = await pageOn("workers");
    await waitFor(() => expect(maxInput().value).toBe("10"));
    fireEvent.change(maxInput(), { target: { value: "4" } });
    await waitFor(() => expect(poolState()[0]).toBe("Saved"));
    expect(posts(fetchWith, "/api/max").map((request) => request.body)).toEqual([{ max: 4 }]);
    expect(maxInput().value).toBe("4");
    expect(posts(fetchWith, "/api/settings/preview")).toEqual([]);
  });

  it("says the refusal, and shows the number the instance holds again", async () => {
    const state = settingsOf({ answers: { max: () => ({ status: 400, error: "workers at once must be a whole number of at least 1" }) } });
    const { fetchWith } = await pageOn("workers", { state });
    await waitFor(() => expect(maxInput().value).toBe("10"));
    const queueReads = reads(fetchWith, "/api/queue").length;
    fireEvent.change(maxInput(), { target: { value: "0" } });
    await waitFor(() => expect(poolState()[0]).toBe("workers at once must be a whole number of at least 1"));
    await waitFor(() => expect(maxInput().value).toBe("10"));
    expect(reads(fetchWith, "/api/queue").length).toBeGreaterThan(queueReads);
  });

  it("pauses and starts the workers, in the words of the state", async () => {
    const { fetchWith } = await pageOn("workers");
    expect(await screen.findByText("Workers are started")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    await screen.findByText("Workers are paused");
    fireEvent.click(screen.getByRole("button", { name: "Start workers" }));
    await screen.findByText("Workers are started");
    expect(posts(fetchWith, "/api/paused").map((request) => request.body)).toEqual([{ paused: true }, { paused: false }]);
    expect(screen.getByText("While paused, tickets you queue wait until workers are started.")).toBeTruthy();
  });
});
