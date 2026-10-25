import { render, screen, waitFor, within } from "@testing-library/react";
import { standFetch, type Stand } from "../../test/fixtures.ts";
import { addressOf, detailStand, type State } from "../../test/run-detail/run-detail-stand.ts";
import { RunsApp } from "../runs/RunsApp.tsx";

// What the Run detail page's component checks share: the page drawn inside the shell over a stand-in instance at a run's address, and the ways to look at what it drew.
beforeEach(() => {
  localStorage.clear();
});

/** Waits for what a board draws first: the run's h1, the skeleton, or the "run gone" panel. */
const drawn = (state: State) => {
  if (state === "loading") return screen.findByRole("status", { name: "Loading run" });
  return state === "missing" ? screen.findByText("This run is no longer on the board") : screen.findByRole("heading", { level: 1 });
};

/** Run detail for the board `state` (or at `address`), reading from a stand-in instance; resolves once a run, "run gone" or the skeleton has been drawn. */
export async function pageFor(state: State, stand: Stand = detailStand(state), address: string = addressOf(state)) {
  history.replaceState(null, "", address);
  const fetchWith = standFetch(stand);
  const view = render(<RunsApp fetchWith={fetchWith} />);
  await drawn(state);
  return { ...view, fetchWith };
}

export const textOf = (element: Element | null): string => element?.textContent ?? "";
/** The names of the header's buttons, in the order they are drawn: the terminal link too, which is a link and not a button. */
export const headerButtons = (): string[] => [...document.querySelectorAll<HTMLElement>(".run-buttons > *")].map((button) => textOf(button).trim());
export const callout = () => within(screen.getByRole("region", { name: "Current state" }));
export const posts = (fetchWith: ReturnType<typeof standFetch>, path: string) => fetchWith.requests.filter((request) => request.method === "POST" && request.path.endsWith(path));
export { screen, waitFor, within };
