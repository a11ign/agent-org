import { PERSONAL, queueingConfig, type InstanceAnswers, type Stand } from "../../test/fixtures.ts";
import { completed, queueWith, type RunFields } from "../../test/runs/runs-stand.ts";
import type { AfterMergeCheck, QueueView } from "../api/types.ts";
import { fireEvent, pageOn, posts, screen, textOf, waitFor, within } from "./runs-harness.tsx";

// A11-277: the After-merge list's rows carry their age and runner, close with one line of evidence, and a failed check offers a pre-filled follow-up.

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;
const LINE = "Chairman session: the next major arrives as a ticket.";
const run: RunFields = { ...completed({ key: "A11-235", title: "A merged run", startedAgo: DAY }), afterMerge: [{ line: LINE, owner: null }] };

const check = (fields: Partial<AfterMergeCheck>): AfterMergeCheck => ({
  id: "A11-235#1", key: "A11-235", url: "https://linear.app/a11ign/issue/A11-235", line: LINE, runner: "session", listedAt: Date.now() - 3 * DAY - HOUR, state: "open", owner: "Chairman session", role: null,
  followUpText: null, ...fields,
});

const FAILED = check({ id: "A11-236#1", key: "A11-236", state: "failed", result: "no ticket arrived", listedAt: Date.now() - 5 * HOUR, followUpText: "Follow-up to A11-236: its after-merge check failed." });

/** An instance whose queue lists `checks`, and whose posts `post` answers; `then` is the queue it lists once a post is taken. */
function standWith(checks: readonly AfterMergeCheck[], post: (path: string, body: unknown) => unknown, then: readonly AfterMergeCheck[] = checks): Stand {
  const instance: { -readonly [K in keyof InstanceAnswers]: InstanceAnswers[K] } = { config: queueingConfig(), queue: { ...queueWith([run]), afterMergeChecks: checks } as QueueView };
  instance.post = (path, body) => {
    const answer = post(path, body);
    if (!(typeof answer === "object" && answer !== null && "error" in answer)) instance.queue = { ...queueWith([run]), afterMergeChecks: then } as QueueView;
    return answer;
  };
  return { connections: [PERSONAL], instances: { personal: instance } };
}

const list = () => within(screen.getByRole("region", { name: "After-merge checks" }));

describe("an After-merge check's row", () => {
  it("shows who runs it, the runner the board sends it to, and its age", async () => {
    await pageOn(standWith([check({}), check({ id: "A11-240#1", key: "A11-240", owner: "The release manager", role: "The release manager", listedAt: Date.now() - 5 * HOUR })], () => ({})));
    expect(list().getByText("Runs it: Chairman session · the session · 3 d")).toBeTruthy();
    expect(list().getByText("Runs it: The release manager · the session for The release manager · 5 h")).toBeTruthy();
  });

  it("closes as passed with one line of evidence, by a person, and leaves the list", async () => {
    const { fetchWith } = await pageOn(standWith([check({})], () => ({ check: {}, followUpText: null }), []));
    fireEvent.click(list().getByRole("button", { name: "Passed" }));
    const field = list().getByRole("textbox", { name: "What did you see?" });
    const close = list().getByRole("button", { name: "Close" }) as HTMLButtonElement;
    expect(close.disabled).toBe(true);
    fireEvent.change(field, { target: { value: "A11-284 was filed by the dependency sweep" } });
    expect(close.disabled).toBe(false);
    fireEvent.click(close);
    await waitFor(() => expect(posts(fetchWith, "/api/after-merge/A11-235/1")).toHaveLength(1));
    expect(posts(fetchWith, "/api/after-merge/A11-235/1")[0].body).toEqual({ result: "passed", evidence: "A11-284 was filed by the dependency sweep", by: "person" });
    await waitFor(() => expect(screen.queryByRole("region", { name: "After-merge checks" })).toBeNull());
  });

  it("asks why for Superseded, and keeps Close off for evidence over 300 characters", async () => {
    await pageOn(standWith([check({})], () => ({})));
    fireEvent.click(list().getByRole("button", { name: "Superseded" }));
    fireEvent.change(list().getByRole("textbox", { name: "Why is it superseded?" }), { target: { value: "x".repeat(301) } });
    expect((list().getByRole("button", { name: "Close" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(list().getByRole("button", { name: "Cancel" }));
    expect(list().getByRole("button", { name: "Superseded" })).toBeTruthy();
  });

  it("keeps the row and its field when the board refuses the close, with the board's words", async () => {
    await pageOn(standWith([check({})], () => ({ status: 409, error: "A11-235#1 is already passed, closed by the person's session: seen" })));
    fireEvent.click(list().getByRole("button", { name: "Failed" }));
    fireEvent.change(list().getByRole("textbox", { name: "What did you see?" }), { target: { value: "no ticket" } });
    fireEvent.click(list().getByRole("button", { name: "Close" }));
    expect(textOf(await list().findByRole("alert"))).toBe("A11-235#1 is already passed, closed by the person's session: seen");
    expect(list().getByRole("textbox", { name: "What did you see?" })).toBeTruthy();
  });
});

describe("a failed check", () => {
  it("is listed under Failed: follow-up?, above the open checks, with what was seen", async () => {
    await pageOn(standWith([check({}), FAILED], () => ({})));
    const rows = [...screen.getByRole("region", { name: "After-merge checks" }).querySelectorAll(".runs-extra-row")].map(textOf);
    expect(rows[0]).toBe("Failed: follow-up?");
    expect(rows[1]).toContain("A11-236");
    expect(rows[2]).toContain("A11-235");
    expect(list().getByText("Failed: no ticket arrived · 5 h")).toBeTruthy();
  });

  it("records No follow-up as none, and leaves the list", async () => {
    const { fetchWith } = await pageOn(standWith([FAILED], () => ({ check: {}, followUpText: null }), []));
    fireEvent.click(list().getByRole("button", { name: "No follow-up" }));
    await waitFor(() => expect(posts(fetchWith, "/api/after-merge/A11-236/1/follow-up")).toHaveLength(1));
    expect(posts(fetchWith, "/api/after-merge/A11-236/1/follow-up")[0].body).toEqual({ writer: null });
    await waitFor(() => expect(screen.queryByRole("region", { name: "After-merge checks" })).toBeNull());
  });

  it("files a follow-up from the New ticket dialog, pre-filled, and records the writer request once it is queued", async () => {
    const writers = { runs: [{ id: "w-9", mode: "quick", request: "r", status: "queued", tickets: [] }] };
    const { fetchWith } = await pageOn(standWith([FAILED], (path) => (path === "/api/writer" ? writers : { check: {}, followUpText: null }), []));
    fireEvent.click(list().getByRole("button", { name: "File a follow-up" }));
    const dialog = within(screen.getByRole("dialog", { name: "New ticket" }));
    expect((dialog.getByRole("textbox", { name: "What is the ticket for?" }) as HTMLTextAreaElement).value).toBe("Follow-up to A11-236: its after-merge check failed.");
    fireEvent.click(dialog.getByRole("button", { name: "Write ticket" }));
    await waitFor(() => expect(posts(fetchWith, "/api/after-merge/A11-236/1/follow-up")).toHaveLength(1));
    expect(posts(fetchWith, "/api/writer")[0].body).toMatchObject({ request: "Follow-up to A11-236: its after-merge check failed.", mode: "quick" });
    expect(posts(fetchWith, "/api/after-merge/A11-236/1/follow-up")[0].body).toEqual({ writer: "w-9" });
  });
});
