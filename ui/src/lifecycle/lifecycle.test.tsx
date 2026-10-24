import { fireEvent, render, screen, within } from "@testing-library/react";
import type { PollView } from "../api/use-poll.ts";
import { EmptyState } from "./EmptyState.tsx";
import { ErrorState } from "./ErrorState.tsx";
import { Lifecycle, type LifecycleView } from "./Lifecycle.tsx";
import { DetailSkeleton, ListSkeleton, SidebarSkeleton, Skeleton, SkeletonBlock } from "./Skeleton.tsx";
import { UnreachableFrame } from "./UnreachableFrame.tsx";

const textOf = (element: HTMLElement): string => element.textContent ?? "";

function viewOf<T>(state: PollView<T>["state"], data: T | null = null, refusal: string | null = null): LifecycleView<T> & Readonly<{ refreshed: () => number }> {
  let refreshes = 0;
  return { state, data, refusal, refresh: () => { refreshes += 1; }, refreshed: () => refreshes };
}

const page = (data: readonly string[]) => <ul>{data.map((item) => <li key={item}>{item}</li>)}</ul>;

function lifecycleOf(view: LifecycleView<readonly string[]>, extra: Readonly<{ onDismiss?: () => void }> = {}) {
  return render(
    <Lifecycle view={view} connection="personal" skeleton={<Skeleton label="Loading things"><SkeletonBlock /></Skeleton>} empty={<EmptyState title="Nothing here" text="Add one." />} {...extra}>
      {page}
    </Lifecycle>,
  );
}

describe("Lifecycle, driven by the polling hook's state", () => {
  it("shows the skeleton while loading", () => {
    lifecycleOf(viewOf("loading"));
    expect(screen.getByRole("status", { name: "Loading things" }).getAttribute("aria-busy")).toBe("true");
    expect(screen.queryByRole("list")).toBeNull();
  });

  it("shows the empty panel when the read came back with nothing", () => {
    lifecycleOf(viewOf("empty", []));
    expect(screen.getByText("Nothing here")).toBeTruthy();
    expect(screen.getByText("Add one.")).toBeTruthy();
  });

  it("shows the page when ready", () => {
    lifecycleOf(viewOf("ready", ["A11-1", "A11-2"]));
    expect(screen.getAllByRole("listitem").map(textOf)).toEqual(["A11-1", "A11-2"]);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows the error banner with the backend's sentence verbatim, above the last good data", () => {
    const view = viewOf("error", ["A11-1"], "No answer within 30 seconds. Is `agent-org ticket:serve` running there?");
    lifecycleOf(view);
    expect(textOf(screen.getByRole("alert"))).toContain("No answer within 30 seconds. Is `agent-org ticket:serve` running there?");
    expect(screen.getAllByRole("listitem").map(textOf)).toEqual(["A11-1"]);
  });

  it("shows only the banner for an error before any success", () => {
    lifecycleOf(viewOf("error", null, "boom"));
    expect(textOf(screen.getByRole("alert"))).toContain("boom");
    expect(screen.queryByRole("list")).toBeNull();
  });

  it("calls refresh when Retry is pressed", () => {
    const view = viewOf("error", null, "boom");
    lifecycleOf(view);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(view.refreshed()).toBe(1);
  });

  it("draws Dismiss only when the page gives onDismiss", () => {
    lifecycleOf(viewOf("error", null, "boom"));
    expect(screen.queryByRole("button", { name: "Dismiss" })).toBeNull();
  });

  it("calls onDismiss when Dismiss is pressed", () => {
    let dismissed = 0;
    lifecycleOf(viewOf("error", null, "boom"), { onDismiss: () => { dismissed += 1; } });
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(dismissed).toBe(1);
  });

  it("shows the unreachable frame naming the connection over SSH, with the sentence and the last good data beneath it", () => {
    lifecycleOf(viewOf("unreachable", ["A11-1"], "agents: Permission denied (publickey)."));
    const alert = screen.getByRole("alert");
    expect(textOf(alert)).toContain("Can't reach personal over SSH.");
    expect(textOf(alert)).toContain("agents: Permission denied (publickey).");
    expect(screen.getAllByRole("listitem").map(textOf)).toEqual(["A11-1"]);
    expect(alert.compareDocumentPosition(screen.getByRole("list")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("has no Retry on the unreachable frame, whose actions are the next ticket's", () => {
    lifecycleOf(viewOf("unreachable", null, "no"));
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("UnreachableFrame", () => {
  it("keeps slots for an explanation and for actions, which the next ticket fills", () => {
    render(<UnreachableFrame name="personal" refusal="no" explanation="Atomaut keeps trying." actions={<button type="button">Check now</button>}><p>last known</p></UnreachableFrame>);
    const alert = screen.getByRole("alert");
    expect(textOf(alert)).toContain("Atomaut keeps trying.");
    expect(within(alert).getByRole("button", { name: "Check now" })).toBeTruthy();
    expect(screen.getByText("last known")).toBeTruthy();
  });
});

describe("EmptyState", () => {
  it("shows its title and text, and its actions when it has them", () => {
    render(<EmptyState title="No runs yet" text="Queue tickets." actions={<a href="/next/tickets">Go to Tickets</a>} />);
    expect(screen.getByText("No runs yet")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Go to Tickets" }).getAttribute("href")).toBe("/next/tickets");
  });
});

describe("ErrorState", () => {
  it("is a role=alert", () => {
    render(<ErrorState refusal="boom" onRetry={() => undefined} />);
    expect(screen.getByRole("alert")).toBeTruthy();
  });
});

describe("the page skeletons", () => {
  it("are one status group each, labelled, and busy", () => {
    render(<><ListSkeleton label="Loading tickets" rows={3} /><DetailSkeleton label="Loading run" /><SidebarSkeleton label="Loading projects and goals" /></>);
    for (const label of ["Loading tickets", "Loading run", "Loading projects and goals"]) {
      expect(screen.getByRole("status", { name: label }).getAttribute("aria-busy")).toBe("true");
    }
  });

  it("draws the rows asked for", () => {
    const { container } = render(<ListSkeleton label="Loading tickets" rows={3} />);
    expect(container.querySelectorAll(".skeleton-panel-row")).toHaveLength(3);
  });
});
