// @ts-check
// module: the worker eval's plain-text tables (A11-431) -- columns padded to their widest cell, two spaces apart, so the run's table and the comparison read alike

/** The columns of both tables, in order: the tests and the verdict before similarity, which is a weak signal (the plan). */
export const COLUMNS = ["ticket", "tests", "verdict", "similarity", "outside", "tokens", "wall"] as const;

/** `rows` (the header first) as lines, each cell padded to its column's widest, two spaces between, no trailing space. PURE. */
export function layOut(rows: readonly (readonly string[])[]): string[] {
  const widths = rows[0].map((_, at) => Math.max(...rows.map((row) => row[at].length)));
  return rows.map((row) => row.map((cell, at) => cell.padEnd(widths[at])).join("  ").trimEnd());
}
