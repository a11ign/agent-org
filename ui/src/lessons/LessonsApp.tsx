import type { Fetch } from "../api/request.ts";
import { ShellFrame } from "../shell/ShellFrame.tsx";
import { ShellProvider } from "../shell/ShellProvider.tsx";
import { LessonsPage } from "./LessonsPage.tsx";

/** The island of the Lessons route (A11-432): the shell and, inside it, the Lessons page. `fetchWith` is for a test; the page uses the browser's. */
export function LessonsApp({ fetchWith }: Readonly<{ fetchWith?: Fetch }>) {
  return (
    <ShellProvider {...(fetchWith === undefined ? {} : { fetchWith })}>
      <ShellFrame page="lessons">
        <LessonsPage />
      </ShellFrame>
    </ShellProvider>
  );
}
