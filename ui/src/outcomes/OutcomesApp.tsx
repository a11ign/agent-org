import type { Fetch } from "../api/request.ts";
import { ShellFrame } from "../shell/ShellFrame.tsx";
import { ShellProvider } from "../shell/ShellProvider.tsx";
import { OutcomesPage } from "./OutcomesPage.tsx";

/** The island of the Outcomes route (A11-430): the shell and, inside it, the Outcomes page. `fetchWith` is for a test; the page uses the browser's. */
export function OutcomesApp({ fetchWith }: Readonly<{ fetchWith?: Fetch }>) {
  return (
    <ShellProvider {...(fetchWith === undefined ? {} : { fetchWith })}>
      <ShellFrame page="outcomes">
        <OutcomesPage />
      </ShellFrame>
    </ShellProvider>
  );
}
