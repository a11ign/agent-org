// no-token: none -- a test fixture: it only keeps the text a fake terminal was drawn; nothing is written to a real one
/** What a terminal shows after it has drawn `chunks`: the lines, with the cursor moves the library makes (up, down, to the left edge, erase a line, erase below) applied. */
export class Screen {
  private rows: string[] = [""];
  private row = 0;
  feed(chunk: string): void {
    for (const part of chunk.split(/(\x1b\[[0-9;?]*[A-Za-z]|\n)/)) this.apply(part);
  }
  private apply(part: string): void {
    const move = /^\x1b\[(\d*)([ABJKGD])$/.exec(part);
    if (part === "\n") this.goto(this.row + 1);
    else if (move?.[2] === "A") this.row = Math.max(0, this.row - Number(move[1] || 1));
    else if (move?.[2] === "B") this.goto(this.row + Number(move[1] || 1));
    else if (part === "\x1b[2K") this.rows[this.row] = "";
    else if (part === "\x1b[J") this.rows.length = this.row + 1, this.rows[this.row] = "";
    else if (!part.startsWith("\x1b")) this.rows[this.row] += part;
  }
  private goto(row: number): void {
    while (this.rows.length <= row) this.rows.push("");
    this.row = row;
  }
  lines(): string[] {
    return this.rows.map((line) => line.trimEnd());
  }
}
