import type { SaveState } from "./use-choices.ts";

/** The quiet word beside a control that saves as it changes: "Saved" once the instance has answered, or its refusal in its own words. Nothing before the first change. */
export function SaveStateText({ state }: Readonly<{ state: SaveState }>) {
  const failed = state.kind === "failed";
  return (
    <span role="status" className={failed ? "save-state save-state-failed" : "save-state"}>
      {state.kind === "saved" ? "Saved" : failed ? state.sentence : ""}
    </span>
  );
}
