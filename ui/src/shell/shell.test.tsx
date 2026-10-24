import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { config, HERE, OTHER, PERSONAL, queueOf, standFetch, ticket, WORK, type Stand } from "../../test/fixtures.ts";
import { Placeholder } from "./Placeholder.tsx";
import type { Page } from "./routes.ts";
import { ShellFrame } from "./ShellFrame.tsx";
import { ShellProvider } from "./ShellProvider.tsx";

beforeEach(() => {
  localStorage.clear();
  history.replaceState(null, "", "/next/tickets");
});

/** The shell on `page`, reading from a stand-in instance; resolves once the sidebar has its first answers. */
async function shellOn(page: Page, stand: Stand = {}) {
  const fetchWith = standFetch(stand);
  const view = render(
    <ShellProvider fetchWith={fetchWith}>
      <ShellFrame page={page}>
        <Placeholder page={page} runKey={page === "run" ? "A11-7" : null} />
      </ShellFrame>
    </ShellProvider>,
  );
  await waitFor(() => expect((screen.getByLabelText("Instance") as HTMLSelectElement).disabled).toBe(false));
  return { ...view, fetchWith };
}

const textOf = (element: HTMLElement): string => element.textContent ?? "";
const sidebar = () => screen.getByRole("complementary", { name: "Atomaut" });
/** The connection pill: the sidebar's status that says Connected or Unreachable (a skeleton is a status too). */
const pill = (): HTMLElement => {
  const found = within(sidebar()).getAllByRole("status").find((status) => /^(Connected|Unreachable)/.test(textOf(status)));
  if (found === undefined) throw new Error("no connection pill in the sidebar");
  return found;
};
const mainNav = () => within(screen.getByRole("navigation", { name: "Main" }));

describe("the instance switcher", () => {
  const stand: Stand = {
    connections: [HERE, PERSONAL, WORK],
    instances: { here: { tickets: [ticket({ key: "A11-1" })] }, personal: { tickets: [ticket({ key: "A11-2" }), ticket({ key: "A11-3" })], queue: queueOf("running") } },
  };

  it("lists this instance and the configured connections by the backend's own labels", async () => {
    await shellOn("tickets", stand);
    const options = within(screen.getByLabelText("Instance")).getAllByRole("option");
    expect(options.map((option) => option.textContent)).toEqual(["here (this machine)", "personal", "work"]);
  });

  it("is drawn with one connection as well", async () => {
    await shellOn("tickets");
    expect(within(screen.getByLabelText("Instance")).getAllByRole("option")).toHaveLength(1);
  });

  it("opens on this machine's instance and reads under /c/<name>/api", async () => {
    const { fetchWith } = await shellOn("tickets", stand);
    await waitFor(() => expect(fetchWith.paths).toContain("/c/here/api/queue"));
    expect(fetchWith.paths).toEqual(expect.arrayContaining(["/api/connections", "/c/here/api/config", "/c/here/api/tickets"]));
  });

  it("opens on the connection a link names, over the one remembered", async () => {
    localStorage.setItem("ticket-mode.connection", JSON.stringify(["work"]));
    history.replaceState(null, "", "/next/tickets?connection=personal");
    await shellOn("tickets", stand);
    expect((screen.getByLabelText("Instance") as HTMLSelectElement).value).toBe("personal");
  });

  it("opens on the connection this browser remembers", async () => {
    localStorage.setItem("ticket-mode.connection", JSON.stringify(["work"]));
    await shellOn("tickets", stand);
    expect((screen.getByLabelText("Instance") as HTMLSelectElement).value).toBe("work");
  });

  it("remembers a choice and moves every read to the other instance, with its own data", async () => {
    const { fetchWith } = await shellOn("tickets", stand);
    await waitFor(() => expect(textOf(mainNav().getByRole("link", { name: /Tickets/ }))).toContain("1"));
    fireEvent.change(screen.getByLabelText("Instance"), { target: { value: "personal" } });
    expect(JSON.parse(localStorage.getItem("ticket-mode.connection") ?? "[]")).toEqual(["personal"]);
    await waitFor(() => expect(textOf(mainNav().getByRole("link", { name: /Tickets/ }))).toContain("2"));
    expect(fetchWith.paths).toEqual(expect.arrayContaining(["/c/personal/api/config", "/c/personal/api/tickets", "/c/personal/api/queue"]));
    await waitFor(() => expect(textOf(mainNav().getByRole("link", { name: /Runs/ }))).toContain("1"));
  });

  it("starts the reads again from loading on a switch, so the other instance's counts never show on this one", async () => {
    await shellOn("tickets", { connections: [HERE, PERSONAL], instances: { here: { tickets: [ticket({ key: "A11-1" })] } } });
    await waitFor(() => expect(textOf(mainNav().getByRole("link", { name: /Tickets/ }))).toBe("Tickets1"));
    fireEvent.change(screen.getByLabelText("Instance"), { target: { value: "personal" } });
    expect(textOf(mainNav().getByRole("link", { name: /Tickets/ }))).toBe("Tickets");
    expect(within(sidebar()).getByRole("status", { name: "Loading projects and goals" })).toBeTruthy();
    await waitFor(() => expect(textOf(mainNav().getByRole("link", { name: /Tickets/ }))).toBe("Tickets0"));
  });

  it("shows a connections file the service refused, in its own words, beside this machine's instance", async () => {
    await shellOn("tickets", { refusal: "connections: work has no host" });
    expect(textOf(screen.getByRole("alert"))).toContain("connections: work has no host");
    expect(within(screen.getByLabelText("Instance")).getAllByRole("option")).toHaveLength(1);
  });

  it("reads the connections again on Retry", async () => {
    const { fetchWith } = await shellOn("tickets", { refusal: "connections: work has no host" });
    const before = fetchWith.paths.filter((path) => path === "/api/connections").length;
    fireEvent.click(within(screen.getByRole("alert")).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(fetchWith.paths.filter((path) => path === "/api/connections").length).toBe(before + 1));
  });

  it("leaves an empty list when the connections cannot be read, and reads /api at the root", async () => {
    const { fetchWith } = await render_failedConnections();
    expect(within(screen.getByLabelText("Instance")).queryAllByRole("option")).toHaveLength(0);
    expect(screen.queryByRole("alert")).toBeNull();
    await waitFor(() => expect(fetchWith.paths).toContain("/api/queue"));
  });
});

async function render_failedConnections() {
  const fetchWith = standFetch({ connectionsFail: true });
  const view = render(<ShellProvider fetchWith={fetchWith}><ShellFrame page="tickets"><Placeholder page="tickets" runKey={null} /></ShellFrame></ShellProvider>);
  await waitFor(() => expect(fetchWith.paths).toContain("/api/queue"));
  return { ...view, fetchWith };
}

describe("the connection pill", () => {
  const sshDown: Stand = { connections: [PERSONAL], instances: { personal: { queueFails: { status: 502, error: "cannot reach personal: ssh: Permission denied" } } } };

  it("reads Unreachable · retrying when an SSH instance cannot be reached", async () => {
    await shellOn("tickets", sshDown);
    await waitFor(() => expect(textOf(pill())).toContain("Unreachable · retrying"));
  });

  it("reads Connected when the instance answers", async () => {
    await shellOn("tickets");
    await waitFor(() => expect(textOf(pill())).toBe("Connected"));
  });

  it("reads Connected while the queue is still loading", async () => {
    render(<ShellProvider fetchWith={standFetch({})}><ShellFrame page="tickets"><div /></ShellFrame></ShellProvider>);
    expect(textOf(pill())).toBe("Connected");
  });

  it("reads Connected when a local instance fails, because Unreachable is only for SSH", async () => {
    const { fetchWith } = await shellOn("runs", { instances: { here: { queueFails: { status: 500, error: "boom" } } } });
    await waitFor(() => expect(fetchWith.paths).toContain("/c/here/api/queue"));
    await waitFor(() => expect(textOf(screen.getByRole("alert"))).toContain("boom"));
    expect(textOf(pill())).toBe("Connected");
  });

  it("is a status the pill's text sits in, with the dot beside the words", async () => {
    await shellOn("tickets");
    expect(pill().textContent).toBe("Connected");
  });
});

describe("the main navigation", () => {
  const pages: readonly (readonly [Page, string, string])[] = [
    ["tickets", "Tickets", "Tickets"], ["runs", "Runs", "Runs"], ["run", "Runs", "Runs"], ["models", "", "Settings"], ["workers", "", "Settings"], ["machine", "", "Settings"], ["plugins", "", "Settings"],
  ];

  it.each(pages)("marks the active item on %s", async (page, mainItem, bottomItem) => {
    await shellOn(page);
    const current = within(sidebar()).queryAllByRole("link").filter((link) => link.getAttribute("aria-current") === "page").map((link) => link.textContent?.replace(/\d+$/, ""));
    const expected = page === "tickets" || page === "runs" || page === "run" ? [mainItem] : [bottomItem];
    const section = ["models", "workers", "machine", "plugins"].includes(page) ? [page[0].toUpperCase() + page.slice(1)] : [];
    expect(current.sort()).toEqual([...expected, ...section].sort());
  });

  it("links Tickets, Runs and Settings to their routes", async () => {
    await shellOn("tickets");
    expect(screen.getByRole("link", { name: /Tickets/ }).getAttribute("href")).toBe("/next/tickets");
    expect(screen.getByRole("link", { name: /Runs/ }).getAttribute("href")).toBe("/next/runs");
    expect(screen.getByRole("link", { name: "Settings" }).getAttribute("href")).toBe("/next/settings/models");
  });

  it("shows the number of runs running beside Runs", async () => {
    await shellOn("tickets", { fallback: { queue: queueOf("running", "queued", "running", "running") } });
    await waitFor(() => expect(textOf(screen.getByRole("link", { name: /Runs/ }))).toContain("3"));
  });

  it("hides the Runs badge when nothing is running", async () => {
    await shellOn("runs", { fallback: { queue: queueOf("queued", "finished") } });
    await screen.findByText("This page is built in A11-197.");
    expect(textOf(screen.getByRole("link", { name: /Runs/ }))).toBe("Runs");
  });

  it("leaves both counts blank while their reads are loading", () => {
    render(<ShellProvider fetchWith={standFetch({})}><ShellFrame page="tickets"><div /></ShellFrame></ShellProvider>);
    expect(screen.getByRole("link", { name: /Tickets/ }).textContent).toBe("Tickets");
    expect(screen.getByRole("link", { name: /Runs/ }).textContent).toBe("Runs");
  });
});

describe("the Settings sub-nav", () => {
  it.each([["models", "Models"], ["workers", "Workers"], ["machine", "Machine"], ["plugins", "Plugins"]] as const)("lists the four sections and marks %s", async (page, label) => {
    await shellOn(page);
    const nav = within(screen.getByRole("navigation", { name: "Settings sections" }));
    expect(nav.getAllByRole("link").map((link) => link.textContent)).toEqual(["Models", "Workers", "Machine", "Plugins"]);
    expect(nav.getAllByRole("link").filter((link) => link.getAttribute("aria-current") === "page").map((link) => link.textContent)).toEqual([label]);
    expect(nav.getByRole("link", { name: label }).getAttribute("href")).toBe(`/next/settings/${page}`);
  });

  it("is not drawn on Tickets, Runs or a run", async () => {
    for (const page of ["tickets", "runs", "run"] as const) {
      const { unmount } = await shellOn(page);
      expect(screen.queryByRole("navigation", { name: "Settings sections" })).toBeNull();
      unmount();
    }
  });
});

describe("projects and goals", () => {
  const tickets = [
    ticket({ key: "A11-1", project: "a11ign", goals: ["Fleet"] }), ticket({ key: "A11-2", project: "a11ign", goals: ["Fleet"] }), ticket({ key: "A11-3", project: "a11ign", goals: ["Clean boundaries"] }),
    ticket({ key: "A11-4", project: "a11ign" }), ticket({ key: "A11-5", project: "agent-org", goals: ["Fleet"] }),
    ticket({ key: "A11-6", project: "agent-org", assignee: OTHER }), ticket({ key: "A11-7", project: null }),
  ];
  const stand: Stand = { fallback: { tickets }, instances: { here: { tickets } } };
  const group = (name: string) => within(screen.getByText(name).parentElement as HTMLElement);
  const rows = (name: string) => group(name).queryAllByRole("button").map((button) => button.textContent);

  it("lists the projects of the tickets assigned to you, most first, with the first pressed", async () => {
    await shellOn("tickets", stand);
    await waitFor(() => expect(rows("Projects")).toEqual(["a11ign4", "(no project)1", "agent-org1"]));
    expect(group("Projects").getByRole("button", { name: /^a11ign/ }).getAttribute("aria-pressed")).toBe("true");
  });

  it("counts the chosen project's tickets in the Tickets item and in All goals", async () => {
    await shellOn("tickets", stand);
    await waitFor(() => expect(textOf(mainNav().getByRole("link", { name: /Tickets/ }))).toContain("4"));
    expect(rows("Goals")).toEqual(["All goals4", "Fleet2", "Clean boundaries1", "(no Goal)1"]);
  });

  it("presses the goal chosen, and presses All goals again when the project changes to one without it", async () => {
    await shellOn("tickets", stand);
    await waitFor(() => expect(rows("Goals")).toHaveLength(4));
    fireEvent.click(group("Goals").getByRole("button", { name: /^Clean boundaries/ }));
    expect(group("Goals").getByRole("button", { name: /^Clean boundaries/ }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(group("Projects").getByRole("button", { name: /^agent-org/ }));
    expect(rows("Goals")).toEqual(["All goals1", "Fleet1"]);
    expect(group("Goals").getByRole("button", { name: /^All goals/ }).getAttribute("aria-pressed")).toBe("true");
  });

  it("remembers a project under ticket-mode.project and opens on it", async () => {
    const { unmount } = await shellOn("tickets", stand);
    await waitFor(() => expect(rows("Projects")).toHaveLength(3));
    fireEvent.click(group("Projects").getByRole("button", { name: /^agent-org/ }));
    expect(JSON.parse(localStorage.getItem("ticket-mode.project") ?? "[]")).toEqual(["agent-org"]);
    unmount();
    await shellOn("tickets", stand);
    await waitFor(() => expect(group("Projects").getByRole("button", { name: /^agent-org/ }).getAttribute("aria-pressed")).toBe("true"));
  });

  it("is the boards' skeleton while the tickets load", () => {
    render(<ShellProvider fetchWith={standFetch(stand)}><ShellFrame page="tickets"><div /></ShellFrame></ShellProvider>);
    expect(within(sidebar()).getByRole("status", { name: "Loading projects and goals" }).getAttribute("aria-busy")).toBe("true");
  });

  it("keeps both headings with no tickets: Projects lists nothing and Goals lists All goals at 0", async () => {
    await shellOn("tickets", { fallback: { tickets: [] } });
    await waitFor(() => expect(rows("Goals")).toEqual(["All goals0"]));
    expect(rows("Projects")).toEqual([]);
    expect(textOf(mainNav().getByRole("link", { name: /Tickets/ }))).toMatch(/^Tickets0$/);
  });

  it("is not drawn on the other pages", async () => {
    await shellOn("runs", stand);
    expect(screen.queryByText("Projects")).toBeNull();
  });
});

describe("the sidebar's order", () => {
  it("runs the mark, the switcher, the pill, Tickets, Runs, Projects, Goals, then Settings", async () => {
    await shellOn("tickets", { fallback: { tickets: [ticket({ key: "A11-1", goals: ["Fleet"] })] } });
    await waitFor(() => expect(within(sidebar()).queryAllByRole("button").length).toBeGreaterThan(0));
    const focusable = [...sidebar().querySelectorAll<HTMLElement>("select, a, button")].map((element) => element.tagName === "SELECT" ? "select" : element.textContent);
    expect(focusable).toEqual(["select", "Tickets1", "Runs", "a11ign1", "All goals1", "Fleet1", "Settings"]);
  });

  it("is an aside named Atomaut that holds the Main navigation", async () => {
    await shellOn("tickets");
    expect(within(sidebar()).getByRole("navigation", { name: "Main" })).toBeTruthy();
    expect(screen.getByRole("main")).toBeTruthy();
  });
});
