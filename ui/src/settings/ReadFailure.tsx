import type { SettingsView } from "../api/types.ts";
import type { usePoll } from "../api/use-poll.ts";
import { ErrorState } from "../lifecycle/ErrorState.tsx";
import { UnreachableFrame } from "../lifecycle/UnreachableFrame.tsx";

/** What the unreachable frame says besides the instance's own sentence: that the page keeps trying, and that what is shown below is the last it read. */
function UnreachableWords({ hasSettings }: Readonly<{ hasSettings: boolean }>) {
  return (
    <>
      Atomaut keeps trying, up to once a minute. {hasSettings ? "These are the last settings it read. " : ""}Is <code>agent-org ticket:serve</code> running there?
    </>
  );
}

/** The failure of the settings read, above whatever was last read: the unreachable frame for an SSH instance that cannot be reached, else the error banner. Both have Retry. */
export function ReadFailure({ read, name, hasSettings }: Readonly<{ read: Pick<ReturnType<typeof usePoll<SettingsView>>, "state" | "refusal" | "refresh">; name: string; hasSettings: boolean }>) {
  const refusal = read.refusal ?? "";
  if (read.state === "unreachable") {
    return <UnreachableFrame name={name} refusal={refusal} explanation={<UnreachableWords hasSettings={hasSettings} />} actions={<button type="button" className="alert-button" onClick={read.refresh}>Retry</button>} />;
  }
  return read.state === "error" ? <ErrorState refusal={refusal} onRetry={read.refresh} /> : null;
}

