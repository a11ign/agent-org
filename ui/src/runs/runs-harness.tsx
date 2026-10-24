import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { standFetch, type Stand } from "../../test/fixtures.ts";
import { runsStand } from "../../test/runs/runs-stand.ts";
import { RunsApp } from "./RunsApp.tsx";

// What the Runs page's component checks share: the page drawn inside the shell over a stand-in instance, and the ways to look at the rows and the rail.
beforeEach(() => {
  localStorage.clear();
  history.replaceState(null, "", "/next/runs");
});

/** The Runs page in the shell, reading from a stand-in instance; resolves once the list, the empty panel or the failure has been drawn. */
export async function pageOn(stand: Stand = runsStand(), { ready = true }: Readonly<{ ready?: boolean }> = {}) {
  const fetchWith = standFetch(stand);
  const view = render(<RunsApp fetchWith={fetchWith} />);
  if (ready) await waitFor(() => expect(screen.queryByRole("status", { name: "Loading runs" })).toBeNull());
  return { ...view, fetchWith };
}

export const textOf = (element: Element | null): string => element?.textContent ?? "";
/** The row of a run. */
export const rowOf = (key: string): HTMLElement => {
  const row = document.getElementById(`run-${key}`);
  if (row === null) throw new Error(`no row for ${key}`);
  return row;
};
export const keysShown = (): string[] => [...document.querySelectorAll<HTMLElement>(".run-row")].map((row) => row.id.replace(/^run-/, ""));
/** The headings of the groups drawn, with the count each shows. */
export const headings = (): string[] => [...document.querySelectorAll<HTMLElement>(".runs-head")].map((head) => textOf(head).replace(/(\D)(\d+)$/, "$1 $2"));
export const rail = () => within(screen.getByRole("navigation", { name: "Run status" }));
/** The names of the buttons of a row, in the order they are drawn. */
export const buttonsOf = (key: string): string[] => within(rowOf(key)).queryAllByRole("button").map((button) => button.getAttribute("aria-label") ?? "");
export const posts = (fetchWith: ReturnType<typeof standFetch>, path: string) => fetchWith.requests.filter((request) => request.method === "POST" && request.path.endsWith(path));
export { fireEvent, screen, waitFor, within };
