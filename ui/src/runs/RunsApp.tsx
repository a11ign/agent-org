import { useEffect } from "react";
import type { Fetch } from "../api/request.ts";
import { RunDetailPage } from "../run-detail/RunDetailPage.tsx";
import { runKeyOf, TITLES } from "../shell/routes.ts";
import { ShellFrame } from "../shell/ShellFrame.tsx";
import { ShellProvider } from "../shell/ShellProvider.tsx";
import { RunsPage } from "./RunsPage.tsx";
import { StatusRail } from "./StatusRail.tsx";
import { useRunFilter } from "./use-run-filter.ts";
import { usePathname } from "./use-pathname.ts";

/** The runs list in the shell: the status rail in the sidebar and the list beside it share the rail's choice. */
function RunsInShell() {
  const { filter, choose } = useRunFilter();
  return (
    <ShellFrame page="runs" middle={<StatusRail filter={filter} onChoose={choose} />}>
      <RunsPage filter={filter} />
    </ShellFrame>
  );
}

/**
 * The island of the runs route. The route also serves `/runs/<key>`, which a static build cannot list: that path is Run detail, which the page draws in the shell and titles as the board does. `fetchWith` is for a test;
 * the page uses the browser's.
 */
export function RunsApp({ fetchWith }: Readonly<{ fetchWith?: Fetch }>) {
  const pathname = usePathname();
  const runKey = runKeyOf(pathname);
  useEffect(() => {
    if (runKey !== null) document.title = TITLES.run;
  }, [runKey]);
  return (
    <ShellProvider {...(fetchWith === undefined ? {} : { fetchWith })}>
      {runKey === null ? <RunsInShell /> : <ShellFrame page="run"><RunDetailPage runKey={runKey} /></ShellFrame>}
    </ShellProvider>
  );
}
