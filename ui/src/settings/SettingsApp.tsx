import type { SettingsPage as Section } from "../../../src/ticket-mode/settings-view.ts";
import type { Fetch } from "../api/request.ts";
import { ShellFrame } from "../shell/ShellFrame.tsx";
import { ShellProvider } from "../shell/ShellProvider.tsx";
import { SettingsPage } from "./SettingsPage.tsx";

/** The island of the Models, Workers and Machine routes: the shell and, inside it, the Settings page of that section. `fetchWith` is for a test; the page uses the browser's. */
export function SettingsApp({ section, fetchWith }: Readonly<{ section: Section; fetchWith?: Fetch }>) {
  return (
    <ShellProvider {...(fetchWith === undefined ? {} : { fetchWith })}>
      <ShellFrame page={section}>
        <SettingsPage section={section} />
      </ShellFrame>
    </ShellProvider>
  );
}
