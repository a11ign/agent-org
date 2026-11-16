import { writeFileSync } from "node:fs";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { briefLessons, lessonsText } from "../../../src/ticket-mode/retro/lessons-brief.ts";
import { lessonsPath, readLessons } from "../../../src/ticket-mode/retro/lessons-store.ts";
import { CHANGESET, lessonsFetch, lessonsState } from "../../test/lessons/lessons-stand.ts";
import { LessonsApp } from "./LessonsApp.tsx";

// THE LESSONS PAGE (A11-432, step 2 of 3) over the instance's own route: the stand answers `/api/lessons` with `lessonsRoute` over lessons files in a scratch state folder (`lessons-stand.ts`), so
// an edit or a delete made on the page is in the files the next brief reads.

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  history.replaceState(null, "", "/lessons");
});
afterEach(cleanup);

/** The Lessons page over `stateDir`; resolves once agent-org's lessons are drawn. */
async function pageOn(stateDir = lessonsState(), on = true) {
  const fetchWith = lessonsFetch(stateDir, { on });
  render(<LessonsApp fetchWith={fetchWith} />);
  await screen.findByRole("heading", { name: "agent-org" });
  return { stateDir, fetchWith };
}

/** The lesson item whose text is `text`. */
const lessonItem = (text: string): HTMLElement => {
  const item = screen.getByText(text).closest("li");
  if (item === null) throw new Error(`no lesson ${text}`);
  return item;
};

/** What the next brief of a run in agent-org carries of its lessons. */
const nextBrief = (stateDir: string): string => lessonsText(briefLessons({ stateDir, repos: ["agent-org"], log: () => {} }), "worker");

describe("the Lessons page", () => {
  it("lists each repository's lessons with the runs they cite, each a link to its run, and says briefs carry them", async () => {
    await pageOn();
    expect(screen.getByText("2 lessons")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "toolchain" })).toBeTruthy();
    const item = lessonItem(CHANGESET);
    expect(within(item).getAllByRole("link").map((link) => [link.textContent, link.getAttribute("href")])).toEqual([["A11-1", "/runs/A11-1"], ["A11-2", "/runs/A11-2"], ["A11-3", "/runs/A11-3"]]);
    expect(item.textContent).toContain("Confirmed 2026-11-14.");
    expect(screen.getByText(/Worker and planner briefs carry these lessons: tickets.lessons is on/)).toBeTruthy();
  });

  it("says no brief carries the lessons while tickets.lessons is off, and still lists them", async () => {
    await pageOn(lessonsState(), false);
    expect(screen.getByText(/tickets.lessons is off, so no brief carries these lessons yet/)).toBeTruthy();
    expect(screen.getByText(CHANGESET)).toBeTruthy();
  });

  it("saves a person's edit, and the next brief carries the lesson as they wrote it", async () => {
    const { stateDir } = await pageOn();
    fireEvent.click(within(lessonItem(CHANGESET)).getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Lesson text, agent-org" }), { target: { value: "Add a changeset for every change to a published package." } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText("Add a changeset for every change to a published package.");
    expect(readLessons(stateDir, "agent-org").map(({ text }) => text)).toEqual(["Add a changeset for every change to a published package."]);
    expect(nextBrief(stateDir)).toContain("- Add a changeset for every change to a published package. (runs: A11-1@1000, A11-2@2000, A11-3@3000)");
    expect(nextBrief(stateDir)).not.toContain(CHANGESET);
  });

  it("deletes a lesson only once the person confirms, and the next brief carries none", async () => {
    const { stateDir } = await pageOn();
    fireEvent.click(within(lessonItem(CHANGESET)).getByRole("button", { name: "Delete" }));
    fireEvent.click(screen.getByRole("button", { name: "Keep it" }));
    expect(readLessons(stateDir, "agent-org")).toHaveLength(1);
    fireEvent.click(within(lessonItem(CHANGESET)).getByRole("button", { name: "Delete" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete lesson" }));
    await waitFor(() => expect(screen.queryByText(CHANGESET)).toBeNull());
    expect(readLessons(stateDir, "agent-org")).toEqual([]);
    expect(nextBrief(stateDir)).toBe("");
    expect(screen.getByText("1 lesson")).toBeTruthy();
  });

  it("shows the instance's refusal under the lesson, in its own words, and keeps the edit open", async () => {
    await pageOn();
    fireEvent.click(within(lessonItem(CHANGESET)).getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Lesson text, agent-org" }), { target: { value: "   " } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect((await screen.findByRole("alert")).textContent).toBe("a lesson needs some text; delete it to drop it");
    expect(screen.getByRole("textbox", { name: "Lesson text, agent-org" })).toBeTruthy();
  });

  it("names a lessons file the instance cannot read, rather than showing it as empty", async () => {
    const stateDir = lessonsState();
    writeFileSync(lessonsPath(stateDir, "corpus"), "{ not json");
    await pageOn(stateDir);
    expect(screen.getByText(/^corpus's lessons cannot be read, so none is shown or briefed: .*is not JSON/)).toBeTruthy();
  });

  it("says there are no lessons yet when no repository has one", async () => {
    render(<LessonsApp fetchWith={lessonsFetch(lessonsState({}))} />);
    expect(await screen.findByText("No lessons yet")).toBeTruthy();
  });
});
