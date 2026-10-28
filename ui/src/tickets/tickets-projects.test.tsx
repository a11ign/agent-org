import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { OTHER, queueingConfig, ticket, type InstanceAnswers } from "../../test/fixtures.ts";
import { MY_TICKETS_LABEL } from "../shell/shell-model.ts";
import { answers, keysShown, openPage, posts, standOf, textOf, tick, bar } from "./tickets-harness.tsx";

// A11-378: an instance whose tracker lists its projects reads one project at a time, and searches the whole workspace. No choice on the page asks for every open ticket of the workspace.

const MINE = [ticket({ key: "A11-1", project: "web" }), ticket({ key: "A11-2", project: "api" })];
const WEB = [ticket({ key: "A11-1", project: "web" }), ticket({ key: "A11-5", project: "web", assignee: OTHER }), ticket({ key: "A11-6", project: "web", assignee: null })];
const projectsGroup = () => document.querySelector<HTMLElement>(".filter-group-projects")!;
const projectButton = (name: string) => within(projectsGroup()).getByRole("button", { name: new RegExp(`^${name}`) });
const assignee = () => screen.getByRole("group", { name: "Assignee" });

/** An instance that reads a project at a time: the person's own tickets first, the tracker's projects, and the pages of `web`. */
const byProject = (more: InstanceAnswers = {}): InstanceAnswers => answers(MINE, {
  config: queueingConfig({ projects: true, search: true, scopes: false } as never),
  projects: [{ id: "p-api", name: "api" }, { id: "p-web", name: "web" }, { id: "p-docs", name: "docs" }],
  pages: { "project:web": [{ tickets: WEB, next: null }] as never },
  ...more,
});

describe("the project picker", () => {
  it("opens on My tickets, all projects, then lists every project the tracker has, and reads no project until one is picked", async () => {
    const { fetchWith } = await openPage(standOf(byProject()));
    await waitFor(() => expect(within(projectsGroup()).getAllByRole("button").map((button) => textOf(button))).toEqual([`${MY_TICKETS_LABEL}2`, "api", "web", "docs"]));
    expect(projectButton(MY_TICKETS_LABEL).getAttribute("aria-pressed")).toBe("true");
    expect(keysShown()).toEqual(["A11-1", "A11-2"]);
    expect(fetchWith.paths.some((path) => path.includes("project=") || path.includes("assignee=") || path.endsWith("/api/people"))).toBe(false);
  });

  it("reads the project picked, a page at a time, and the Assignee row filters only that project's tickets", async () => {
    const { fetchWith } = await openPage(standOf(byProject()));
    await waitFor(() => projectButton("web"));
    fireEvent.click(projectButton("web"));
    await waitFor(() => expect(keysShown()).toEqual(["A11-1", "A11-5", "A11-6"]));
    expect(fetchWith.paths).toContain("/c/here/api/tickets?project=web");
    expect(within(assignee()).getByRole("button", { name: /^Anyone/ }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(within(assignee()).getByRole("button", { name: "Unassigned" }));
    expect(keysShown()).toEqual(["A11-6"]);
    expect(fetchWith.paths.some((path) => path.includes("assignee=") || path.endsWith("/api/people"))).toBe(false);
  });

  it("opens on the project this browser picked last", async () => {
    localStorage.setItem("ticket-mode.project", JSON.stringify(["web"]));
    await openPage(standOf(byProject()));
    await waitFor(() => expect(keysShown()).toEqual(["A11-1", "A11-5", "A11-6"]));
    expect(projectButton("web").getAttribute("aria-pressed")).toBe("true");
  });
});

describe("the workspace search", () => {
  const ELSEWHERE = ticket({ key: "OPS-7", title: "Rotate the keys", project: "ops", assignee: OTHER });

  it("finds an open ticket outside the list, not the person's and in no project shown, and it can be queued", async () => {
    const asked: string[] = [];
    const instance = byProject({ search: (text) => { asked.push(text); return [ELSEWHERE, MINE[0]]; }, post: () => ({ entries: [], paused: false }) });
    const { fetchWith } = await openPage(standOf(instance));
    fireEvent.change(screen.getByPlaceholderText("Filter by key, title or project"), { target: { value: "rotate" } });
    const found = await screen.findByRole("region", { name: "Elsewhere in the tracker" });
    expect(asked).toEqual(["rotate"]);
    expect(textOf(found)).toContain("1 open ticket elsewhere in the tracker");
    expect(textOf(found)).toContain("Someone");
    expect(textOf(found)).toContain("ops");
    tick("OPS-7");
    fireEvent.click(within(bar()).getByRole("button", { name: /^Queue/ }));
    await waitFor(() => expect(posts(fetchWith, "/api/queue").map((request) => (request.body as { keys: string[] }).keys)).toEqual([["OPS-7"]]));
  });

  it("asks the tracker nothing for one character", async () => {
    const asked: string[] = [];
    await openPage(standOf(byProject({ search: (text) => { asked.push(text); return []; } })));
    fireEvent.change(screen.getByPlaceholderText("Filter by key, title or project"), { target: { value: "r" } });
    await new Promise((done) => setTimeout(done, 400));
    expect(asked).toEqual([]);
  });
});
