import { EmptyState } from "../lifecycle/EmptyState.tsx";
import { Lifecycle, type LifecycleView } from "../lifecycle/Lifecycle.tsx";
import { DetailSkeleton, ListSkeleton } from "../lifecycle/Skeleton.tsx";
import type { Page } from "./routes.ts";
import { useShell } from "./ShellProvider.tsx";

type Empty = Readonly<{ title: string; text: string }>;

/** What a page of the shell shows until its own ticket lands: the board's h1, what its skeleton is labelled, which ticket builds it, and the empty panel where its board has one. */
type PagePlaceholder = Readonly<{ heading: string | null; loading: string; builtBy: string; empty?: Empty }>;

/** The pages that still have a placeholder: every page but Tickets, which is drawn (A11-196). */
type PlaceholderPage = Exclude<Page, "tickets">;

const PLACEHOLDERS: Readonly<Record<PlaceholderPage, PagePlaceholder>> = {
  runs: { heading: "Runs", loading: "Loading runs", builtBy: "A11-197", empty: { title: "No runs yet", text: "Queue tickets from the Tickets page and each one shows up here as it runs." } },
  run: { heading: null, loading: "Loading run", builtBy: "A11-198" },
  models: { heading: "Settings", loading: "Loading settings", builtBy: "A11-200" },
  workers: { heading: "Settings", loading: "Loading settings", builtBy: "A11-200" },
  machine: { heading: "Settings", loading: "Loading settings", builtBy: "A11-200" },
  plugins: { heading: "Plugins", loading: "Loading plugins", builtBy: "A11-201" },
};

/**
 * A page of the shell until its own ticket lands: the board's h1, and the lifecycle of the queue read, so the skeleton, the empty panel, the error banner and the unreachable frame are
 * all shown in the frame already. `runKey` is the run's key, which is the h1 of the Run detail page.
 */
export function Placeholder({ page, runKey }: Readonly<{ page: PlaceholderPage; runKey: string | null }>) {
  const { queue, connection } = useShell();
  const { heading, loading, builtBy, empty } = PLACEHOLDERS[page];
  // A placeholder draws no data, so it takes the read as it is.
  const view: LifecycleView<unknown> = queue;
  const note = <p className="placeholder-note">This page is built in {builtBy}.</p>;
  return (
    <>
      <h1 className="page-heading">{heading ?? runKey ?? "Run"}</h1>
      <Lifecycle
        view={view}
        skeleton={page === "run" ? <DetailSkeleton label={loading} /> : <ListSkeleton label={loading} />}
        empty={empty === undefined ? note : <EmptyState title={empty.title} text={empty.text} />}
        connection={connection?.name ?? ""}
      >
        {() => note}
      </Lifecycle>
    </>
  );
}
