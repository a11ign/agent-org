import { TicketsPage } from "../tickets/TicketsPage.tsx";
import { ShellFrame } from "./ShellFrame.tsx";
import { ShellProvider } from "./ShellProvider.tsx";

/**
 * The island of the Tickets route: the shell and, inside it, the Tickets page. Every other route has an island of its own (`RunsApp` for the list and one run, `SettingsApp`, `PluginsApp`), which draws
 * its page in the same shell. The shell's placeholder pages, which stood in for those until their tickets landed, are gone with A11-202.
 */
export function App() {
  return (
    <ShellProvider>
      <ShellFrame page="tickets">
        <TicketsPage />
      </ShellFrame>
    </ShellProvider>
  );
}
