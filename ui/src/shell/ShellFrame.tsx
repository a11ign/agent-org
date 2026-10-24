import type { ReactNode } from "react";
import { ErrorState } from "../lifecycle/ErrorState.tsx";
import { isSettingsPage, type Page } from "./routes.ts";
import { ProjectsAndGoals } from "./ProjectsAndGoals.tsx";
import { SettingsNav } from "./SettingsNav.tsx";
import { Sidebar } from "./Sidebar.tsx";
import { useShell } from "./ShellProvider.tsx";
import { DrainBanner } from "../updating/DrainBanner.tsx";
import { UpdatingScreen } from "../updating/UpdatingScreen.tsx";

/** The padding and spacing of a page's main column: a list page, the run's, or Settings', as the boards have them. */
export type Layout = "list" | "detail" | "settings";

/** Which layout a page has. */
export function layoutOf(page: Page): Layout {
  if (page === "run") return "detail";
  return isSettingsPage(page) ? "settings" : "list";
}

/** The sidebar's middle section of each page: the projects and goals on Tickets, the Settings sub-nav on Settings and Plugins, and nothing on a run. The Runs page gives its own (the status rail). */
function MiddleSection({ page }: Readonly<{ page: Page }>) {
  if (page === "tickets") return <ProjectsAndGoals />;
  if (isSettingsPage(page)) return <SettingsNav page={page} />;
  return null;
}

/** A connections file the service refused: its own sentence in the shared error banner, with Retry reading the connections again, as today's page says it. */
function ConnectionsRefusal() {
  const { connectionsRefusal, retryConnections } = useShell();
  return connectionsRefusal === null ? null : <ErrorState refusal={connectionsRefusal} onRetry={retryConnections} />;
}

/** The pages that carry the drain banner: the two the Draining boards draw. */
const hasDrainBanner = (page: Page): boolean => page === "tickets" || page === "runs";

/**
 * The frame every page sits in: the sidebar of the boards and the page's main column beside it. At 820px and below the sidebar takes the full width and the page goes beneath
 * (`shell.css`). While the page is in the middle of an update (A11-217) the main column shows the Updating card and keeps the page, hidden, and the sidebar stays as the last known state; otherwise the Tickets and
 * Runs pages carry the drain banner above the page. `children` is the page. `middle`, when a page gives it, is the sidebar's middle section in place of the one the frame knows for that page: the Runs page's status rail.
 */
export function ShellFrame({ page, middle, children }: Readonly<{ page: Page; middle?: ReactNode; children: ReactNode }>) {
  const { update } = useShell();
  const updating = update.kind !== "none";
  return (
    <div className="shell">
      <Sidebar page={page}>
        {middle ?? <MiddleSection page={page} />}
      </Sidebar>
      <main className={`shell-main shell-main-${layoutOf(page)}${updating ? " shell-main-updating" : ""}`}>
        {update.kind === "none" ? null : <UpdatingScreen view={update} />}
        {updating || !hasDrainBanner(page) ? null : <DrainBanner />}
        {updating ? null : <ConnectionsRefusal />}
        {/* The page stays mounted, hidden, while the card shows: what a person has typed or ticked is still there if the board comes back with nothing to say. */}
        <div className="shell-page" hidden={updating}>
          {children}
        </div>
      </main>
    </div>
  );
}
