import type { Fetch } from "../api/request.ts";
import { App } from "../shell/App.tsx";
import { runKeyOf } from "../shell/routes.ts";
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
 * The island of the runs route. The route also serves `/next/runs/<key>`, which a static build cannot list: that path is Run detail, still the shell's placeholder until its page lands, so it is drawn by the
 * shell's own island. `fetchWith` is for a test; the page uses the browser's.
 */
export function RunsApp({ fetchWith }: Readonly<{ fetchWith?: Fetch }>) {
  const pathname = usePathname();
  if (runKeyOf(pathname) !== null) return <App section="runs" />;
  return (
    <ShellProvider {...(fetchWith === undefined ? {} : { fetchWith })}>
      <RunsInShell />
    </ShellProvider>
  );
}
