import { render, screen, waitFor } from "@testing-library/react";
import { standFetch } from "../../test/fixtures.ts";
import { PERSONAL, queueingConfig } from "../../test/fixtures.ts";
import { completed, queueWith } from "../../test/runs/runs-stand.ts";
import { RunsApp } from "./RunsApp.tsx";

// A11-302: the pool bar counts the After-merge checks the org itself has open past three days, and the person's list shows only their own.
beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  history.replaceState(null, "", "/runs");
});

const MINUTE = 60_000;
const run = { ...completed({ key: "A11-70", title: "A merged run", startedAgo: 40 * MINUTE }), afterMerge: [{ line: "The chairman chooses the name.", owner: null }] };

const standOf = (org?: { open: number; stale: number }, unreadable?: string) =>
  ({ connections: [PERSONAL], instances: { personal: { config: queueingConfig(), queue: { ...queueWith([run], { org }), ...(unreadable === undefined ? {} : { afterMergeChecks: undefined, afterMergeUnreadable: unreadable }) } as never } } });

const poolBar = async (): Promise<HTMLElement> => {
  await waitFor(() => expect(document.querySelector(".pool-bar")).not.toBeNull());
  return document.querySelector<HTMLElement>(".pool-bar")!;
};

/** The pool bar's note about the org's checks, once the page has drawn it. */
async function orgNote(): Promise<HTMLElement> {
  const bar = await poolBar();
  return waitFor(() => {
    const found = [...bar.querySelectorAll<HTMLElement>(".pool-note")].find((each) => /Org checks/.test(each.textContent ?? ""));
    expect(found).toBeDefined();
    return found!;
  });
}

describe("the org's own checks on the pool bar", () => {
  it("reads 'Org checks open over 3 days: N', and its title says how many are open in all", async () => {
    render(<RunsApp fetchWith={standFetch(standOf({ open: 41, stale: 12 }))} />);
    const note = await orgNote();
    expect(note.textContent).toBe("Org checks open over 3 days: 12");
    expect(note.getAttribute("title")).toBe("41 After-merge checks the org verifies are open; this counts those older than 3 days and outside their window");
  });

  it("reads 0 when the org keeps up, and says nothing from an instance that sends no count", async () => {
    const { unmount } = render(<RunsApp fetchWith={standFetch(standOf({ open: 3, stale: 0 }))} />);
    await waitFor(() => expect(screen.getByText("Org checks open over 3 days: 0")).toBeTruthy());
    unmount();
    render(<RunsApp fetchWith={standFetch(standOf())} />);
    await poolBar();
    expect(screen.queryByText(/Org checks open over/)).toBeNull();
  });
});

describe("an After-merge checks file the board cannot read", () => {
  it("is said on the pool bar and over the list, and is not drawn as no checks or a count of 0", async () => {
    render(<RunsApp fetchWith={standFetch(standOf(undefined, "the After-merge checks cannot be read, so none is listed: Unexpected token"))} />);
    const note = await orgNote();
    expect(note.textContent).toBe("Org checks: cannot be read");
    expect(note.getAttribute("title")).toBe("the After-merge checks cannot be read, so none is listed: Unexpected token");
    expect((await screen.findByRole("alert")).textContent).toBe("the After-merge checks cannot be read, so none is listed: Unexpected token");
    expect(screen.queryByText(/Org checks open over/)).toBeNull();
  });
});
