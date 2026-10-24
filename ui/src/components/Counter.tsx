import { useState } from "react";

/** The placeholder page's one React island: a button that counts its presses, so a component test and a page check both see a state change. */
export function Counter() {
  const [presses, setPresses] = useState(0);
  return (
    <button type="button" className="counter" onClick={() => setPresses(presses + 1)}>
      Pressed {presses} {presses === 1 ? "time" : "times"}
    </button>
  );
}
