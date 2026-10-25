import { act, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { useModalFocus } from "./use-modal-focus.ts";

function Dialog({ close }: Readonly<{ close: () => void }>) {
  const { dialog, onKeyDown } = useModalFocus(close);
  return (
    <div ref={dialog} tabIndex={-1} role="dialog" aria-label="Asked" onKeyDown={onKeyDown}>
      <button type="button">Inside</button>
    </div>
  );
}

/** A button that asks the instance before it opens its dialog, as Review changes does: it is disabled while it waits, which drops the focus to the page. */
function Asker({ answer }: Readonly<{ answer: Promise<void> }>) {
  const [phase, setPhase] = useState<"idle" | "asking" | "open">("idle");
  const ask = async () => {
    // What a browser does when the focused button is disabled: the focus drops to the page.
    (document.activeElement as HTMLElement).blur();
    setPhase("asking");
    await answer;
    setPhase("open");
  };
  return (
    <>
      <button type="button" disabled={phase === "asking"} onClick={() => void ask()}>Ask</button>
      {phase === "open" ? <Dialog close={() => setPhase("idle")} /> : null}
    </>
  );
}

describe("useModalFocus", () => {
  it("gives the focus back to the button that opened the dialog, though that button was disabled while the dialog was being asked for", async () => {
    let answered: () => void = () => undefined;
    render(<Asker answer={new Promise<void>((done) => { answered = done; })} />);
    const ask = screen.getByRole("button", { name: "Ask" });
    ask.focus();
    fireEvent.click(ask);
    expect(document.activeElement).toBe(document.body);
    await act(async () => { answered(); });
    await screen.findByRole("dialog", { name: "Asked" });
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(ask);
  });
});
