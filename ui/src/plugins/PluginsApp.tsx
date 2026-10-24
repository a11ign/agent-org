import type { Fetch } from "../api/request.ts";
import { ShellFrame } from "../shell/ShellFrame.tsx";
import { ShellProvider } from "../shell/ShellProvider.tsx";
import { PluginsPage } from "./PluginsPage.tsx";
import { PluginsRead } from "./PluginsRead.tsx";

/**
 * The island of the Plugins route: the shell and, inside it, the plugins read that the page and the Settings sub-nav's badge share, and the page. `fetchWith` is for a test; the page uses the
 * browser's.
 */
export function PluginsApp({ fetchWith }: Readonly<{ fetchWith?: Fetch }>) {
  return (
    <ShellProvider {...(fetchWith === undefined ? {} : { fetchWith })}>
      <PluginsRead>
        <ShellFrame page="plugins">
          <PluginsPage />
        </ShellFrame>
      </PluginsRead>
    </ShellProvider>
  );
}
