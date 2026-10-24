import { useEffect, useSyncExternalStore } from "react";
import { Placeholder } from "./Placeholder.tsx";
import { pageOf, runKeyOf, TITLES, type Page } from "./routes.ts";
import { ShellFrame } from "./ShellFrame.tsx";
import { ShellProvider } from "./ShellProvider.tsx";

const noSubscription = () => () => undefined;
const pathOfPage = () => globalThis.location.pathname;
const pathBeforeHydration = () => "";

/** The path the browser is on. The built page has none, so the server render and the first client render agree, and the client's own path is read straight after. */
const usePathname = (): string => useSyncExternalStore(noSubscription, pathOfPage, pathBeforeHydration);

/**
 * The one island of every page: the shell and, inside it, the page. `section` is the page the Astro route builds. The runs route also serves `/next/runs/<key>`, which a static
 * build cannot list, so the path says whether it is the list or one run, and the document's title follows.
 */
export function App({ section }: Readonly<{ section: Page }>) {
  const pathname = usePathname();
  const page = pageOf(section, pathname);
  useEffect(() => {
    document.title = TITLES[page];
  }, [page]);
  return (
    <ShellProvider>
      <ShellFrame page={page}>
        <Placeholder page={page} runKey={runKeyOf(pathname)} />
      </ShellFrame>
    </ShellProvider>
  );
}
