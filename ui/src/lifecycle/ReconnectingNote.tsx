/** The quiet line a page shows while its instance restarts (A11-211): no red, and the poll tries again by itself. `refusal` is what the last read said, kept as the line's tooltip. */
export function ReconnectingNote({ refusal }: Readonly<{ refusal: string | null }>) {
  return (
    <p role="status" className="reconnecting-note" title={refusal ?? ""}>
      Reconnecting…
    </p>
  );
}
