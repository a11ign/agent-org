import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { OTHER, queueingConfig, ticket, type InstanceAnswers } from "../../test/fixtures.ts";
import { answers, keysShown, openPage, pageOn, standOf, textOf } from "./tickets-harness.tsx";

describe("the Assignee group", () => {
  const tickets = [ticket({ key: "A11-1" }), ticket({ key: "A11-2", assignee: OTHER }), ticket({ key: "A11-3", assignee: null }), ticket({ key: "A11-4", assignee: OTHER })];
  const group = () => screen.getByRole("group", { name: "Assignee" });

  it("lists Mine, Anyone, Unassigned and each other person, with the count on the pressed one", async () => {
    await pageOn(standOf(answers(tickets)));
    expect(within(group()).getAllByRole("button").map((button) => textOf(button))).toEqual(["Mine1", "Anyone", "Unassigned", "Someone"]);
    expect(within(group()).getByRole("button", { name: /^Mine/ }).getAttribute("aria-pressed")).toBe("true");
  });

  it("moves the list, the count and the sidebar to the scope chosen", async () => {
    await openPage(standOf(answers(tickets)));
    fireEvent.click(within(group()).getByRole("button", { name: "Anyone" }));
    expect(within(group()).getByRole("button", { name: /^Anyone/ }).textContent).toBe("Anyone4");
    expect(keysShown()).toEqual(["A11-1", "A11-2", "A11-3", "A11-4"]);
    expect(textOf(document.querySelector(".page-count"))).toBe("4 open");
    expect(textOf(screen.getByRole("link", { name: /Tickets/ }))).toContain("4");
    fireEvent.click(within(group()).getByRole("button", { name: "Unassigned" }));
    expect(keysShown()).toEqual(["A11-3"]);
    expect(textOf(document.querySelector(".page-count"))).toBe("1 unassigned");
    fireEvent.click(within(group()).getByRole("button", { name: "Someone" }));
    expect(textOf(document.querySelector(".page-count"))).toBe("2 assigned to Someone");
  });

  it("is not drawn on an instance that names no assignees, which lists every ticket as it did", async () => {
    await pageOn(standOf(answers(tickets, { config: { ...queueingConfig(), viewer: undefined } as never })));
    expect(screen.queryByRole("group", { name: "Assignee" })).toBeNull();
    expect(textOf(document.querySelector(".page-count"))).toBe("4 assigned to you");
  });

  it("says why there is no Mine when the tracker could not say whose key the board reads with", async () => {
    await pageOn(standOf(answers(tickets, { config: queueingConfig({ viewer: null }) })));
    expect(group().getAttribute("title")).toContain("Linear could not say whose key this board reads with");
    expect(within(group()).getAllByRole("button").map((button) => textOf(button))).toEqual(["Anyone4", "Unassigned", "Someone", "Me"]);
  });

  it("reads another person's pages when this instance reads scopes on demand, and joins them to the list", async () => {
    const page = (keys: readonly string[]) => ({ tickets: keys.map((key) => ticket({ key, assignee: OTHER })), next: null });
    const instance = answers([ticket({ key: "A11-1" })], {
      config: queueingConfig({ scopes: true } as never), people: { people: [{ ...OTHER, count: 2 }, { id: "u-me", name: "Me", count: 1 }], unassigned: 0, total: 3 },
      pages: { [OTHER.id]: [{ tickets: [ticket({ key: "A11-2", assignee: OTHER })], next: "1" }, page(["A11-3"])] as never },
    });
    const { fetchWith } = await openPage(standOf(instance));
    await waitFor(() => expect(within(group()).getAllByRole("button").map((button) => textOf(button))).toContain("Someone"));
    fireEvent.click(within(group()).getByRole("button", { name: "Someone" }));
    await waitFor(() => expect(keysShown()).toEqual(["A11-2", "A11-3"]));
    expect(fetchWith.paths).toEqual(expect.arrayContaining([`/c/here/api/tickets?assignee=${OTHER.id}`, `/c/here/api/tickets?assignee=${OTHER.id}&after=1`]));
  });

  it("shows the instance's refusal of a scope in the banner, keeps the list, and reads the scope again on Retry", async () => {
    let refuse = true;
    const instance: InstanceAnswers = {
      ...answers([ticket({ key: "A11-1" })], { config: queueingConfig({ scopes: true } as never), pages: { anyone: [{ tickets: [ticket({ key: "A11-1" }), ticket({ key: "A11-2", assignee: OTHER })], next: null }] as never } }),
      get pagesFail() { return refuse ? { status: 500, error: "tracker refused the page" } : undefined; },
    };
    await openPage(standOf(instance));
    fireEvent.click(within(group()).getByRole("button", { name: "Anyone" }));
    const alert = await screen.findByRole("alert");
    expect(textOf(alert)).toContain("tracker refused the page");
    expect(keysShown()).toEqual(["A11-1"]);
    refuse = false;
    fireEvent.click(within(alert).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(keysShown()).toEqual(["A11-1", "A11-2"]));
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

const MENU_TICKETS = [
  ticket({ key: "A11-1", priority: 1, uploads: ["plan.md"], labels: [{ name: "bug", group: "Type" }], goals: ["Fleet"] } as never),
  ticket({ key: "A11-2", priority: 3, labels: [{ name: "bug", group: "Type" }] }),
  ticket({ key: "A11-3", priority: 3 }),
];
const openMenu = (name: string) => {
  fireEvent.click(screen.getByRole("button", { name: new RegExp(`^${name}`) }));
  return screen.getByRole("group", { name });
};
const itemsOf = (menu: HTMLElement, type: "checkbox" | "radio"): string[] => within(menu).getAllByRole(type).map((input) => textOf(input.parentElement));
const rememberedUnder = (name: string): unknown => JSON.parse(localStorage.getItem(name) ?? "[]");

type MenuCase = Readonly<{ menu: string; type: "checkbox" | "radio"; items: readonly string[]; pick: RegExp; clear: string; shown: readonly string[]; chosenButton: RegExp; storedKey: string; stored: readonly string[] }>;

const MENU_CASES: readonly MenuCase[] = [
  { menu: "Priority", type: "checkbox", items: ["All priorities", "Urgent1", "Medium2"], pick: /^Medium/, clear: "All priorities", shown: ["A11-2", "A11-3"], chosenButton: /^Priority: Medium/, storedKey: "ticket-mode.priorities", stored: ["3"] },
  { menu: "Plan", type: "radio", items: ["All", "With a plan1", "Without a plan2"], pick: /^With a plan/, clear: "All", shown: ["A11-1"], chosenButton: /^Plan: With a plan/, storedKey: "ticket-mode.plan", stored: ["with"] },
  { menu: "Type", type: "checkbox", items: ["All", "bug2", "(no Type)1"], pick: /^bug/, clear: "All", shown: ["A11-1", "A11-2"], chosenButton: /^Type: bug/, storedKey: "ticket-mode.labels", stored: [JSON.stringify(["Type", "bug"])] },
];

describe("the Priority, Plan and label menus", () => {
  it.each(MENU_CASES)("the $menu menu lists its items with their counts, keeps what is chosen, and remembers it under $storedKey", async (menuCase) => {
    await openPage(standOf(answers(MENU_TICKETS)));
    const menu = openMenu(menuCase.menu);
    expect(itemsOf(menu, menuCase.type)).toEqual(menuCase.items);
    fireEvent.click(within(menu).getByLabelText(menuCase.pick));
    expect(keysShown()).toEqual(menuCase.shown);
    expect(screen.getByRole("button", { name: menuCase.chosenButton })).toBeTruthy();
    expect(rememberedUnder(menuCase.storedKey)).toEqual(menuCase.stored);
    fireEvent.click(within(menu).getByLabelText(menuCase.clear));
    expect(keysShown()).toHaveLength(3);
    expect(rememberedUnder(menuCase.storedKey)).toEqual([]);
  });

  it("has no Plan menu on a machine that names no plan pattern", async () => {
    await pageOn(standOf(answers(MENU_TICKETS, { config: queueingConfig({ plan: null } as never) })));
    expect(screen.queryByRole("button", { name: /^Plan/ })).toBeNull();
  });

  it("has no menu for the Goal group, which the sidebar's Goals choose", async () => {
    await openPage(standOf(answers(MENU_TICKETS)));
    expect(screen.queryByRole("button", { name: /^Goal/ })).toBeNull();
  });
});

describe("closing a menu, and the sidebar's goal", () => {
  it("closes on Escape and gives the focus back to its button, and on a click outside", async () => {
    await openPage(standOf(answers(MENU_TICKETS)));
    openMenu("Priority");
    expect(screen.getByRole("button", { name: /^Priority/ }).getAttribute("aria-expanded")).toBe("true");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("group", { name: "Priority" })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: /^Priority/ }));
    openMenu("Priority");
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("group", { name: "Priority" })).toBeNull();
  });

  it("applies the goal the sidebar chooses", async () => {
    await openPage(standOf(answers(MENU_TICKETS)));
    fireEvent.click(within(screen.getByRole("complementary", { name: "Atomaut" })).getByRole("button", { name: /^Fleet/ }));
    expect(keysShown()).toEqual(["A11-1"]);
  });
});
