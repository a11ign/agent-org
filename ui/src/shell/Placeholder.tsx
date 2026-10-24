import { EmptyState } from "../lifecycle/EmptyState.tsx";
import { Lifecycle, type LifecycleView } from "../lifecycle/Lifecycle.tsx";
import { DetailSkeleton, ListSkeleton } from "../lifecycle/Skeleton.tsx";
import type { Page } from "./routes.ts";
import { useShell } from "./ShellProvider.tsx";

type Empty = Readonly<{ title: string; text: string }>;

/** What a page of the shell shows until its own ticket lands: the board's h1, what its skeleton is labelled, which ticket builds it, and the empty panel where its board has one. */
type PagePlaceholder = Readonly<{ heading: string | null; loading: string; builtBy: string; empty?: Empty }>;

const PLACEHOLDERS: Readonly<Record<Page, PagePlaceholder>> = {
  tickets: {
    heading: "Tickets", loading: "Loading tickets", builtBy: "A11-196",
    empty: { title: "Nothing is assigned to you", text: "Describe what you need and the ticket writer will file it. Or look at tickets assigned to anyone, or to no one." },
  },
  runs: { heading: "Runs", loading: "Loading runs", builtBy: "A11-197", empty: { title: "No runs yet", text: "Queue tickets from the Tickets page and each one shows up here as it runs." } },
  run: { heading: null, loading: "Loading run", builtBy: "A11-198" },
  models: { heading: "Settings", loading: "Loading settings", builtBy: "A11-200" },
  workers: { heading: "Settings", loading: "Loading settings", builtBy: "A11-200" },
  machine: { heading: "Settings", loading: "Loading settings", builtBy: "A11-200" },
  plugins: { heading: "Plugins", loading: "Loading plugins", builtBy: "A11-201" },
};

/**
 * A page of the shell until its own ticket lands: the board's h1, and the lifecycle of the read that page starts from (the tickets for Tickets, the queue for the rest), so the
 * skeleton, the empty panel, the error banner and the unreachable frame are all shown in the frame already. `runKey` is the run's key, which is the h1 of the Run detail page.
 */
export function Placeholder({ page, runKey }: Readonly<{ page: Page; runKey: string | null }>) {
  const { tickets, queue, connection } = useShell();
  const { heading, loading, builtBy, empty } = PLACEHOLDERS[page];
  // A placeholder draws no data, so it takes whichever read the page starts from as it is.
  const view: LifecycleView<unknown> = page === "tickets" ? tickets : queue;
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
