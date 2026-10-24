import { fireEvent, render, screen } from "@testing-library/react";
import { Counter } from "./Counter.tsx";

describe("Counter", () => {
  it("starts at no presses and counts each press", () => {
    render(<Counter />);
    const button = screen.getByRole("button");
    expect(button.textContent).toBe("Pressed 0 times");
    fireEvent.click(button);
    expect(button.textContent).toBe("Pressed 1 time");
    fireEvent.click(button);
    expect(button.textContent).toBe("Pressed 2 times");
  });
});
