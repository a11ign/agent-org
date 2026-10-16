// @ts-check
// module: a batch planning run's `order.json` -- which tickets of the batch wait on which, and the repository each lands in -- read and checked
//
// AN UNATTENDED RUN WROTE IT, AND THE BOARD WRITES IT TO THE TRACKER. So it is checked whole before any of it is used: every key is one of the
// batch's, no ticket waits on itself, and the order has no cycle. A file that fails any check is refused as a whole, and the board writes no
// relation from it. PURE: the caller reads the file.

/** Where one ticket of a batch stands: the repository its work lands in, or null, and the tickets of the batch it waits on. */
export type Place = Readonly<{ repo: string | null; after: readonly string[] }>;

/** A batch's order, by key. A ticket the file leaves out has no entry. */
export type Order = ReadonlyMap<string, Place>;

const PLACE_SHAPE = "{ \"repo\": \"<repository>\" or null, \"after\": [\"<key>\", ...] }";

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** A cycle in `order`, as the keys around it with the first repeated at the end, or null when it has none. */
function cycleIn(order: Order): string[] | null {
  const done = new Set<string>();
  const path: string[] = [];
  const visit = (key: string): string[] | null => {
    if (path.includes(key)) return [...path.slice(path.indexOf(key)), key];
    if (done.has(key)) return null;
    path.push(key);
    for (const next of order.get(key)?.after ?? []) {
      const cycle = visit(next);
      if (cycle !== null) return cycle;
    }
    path.pop();
    done.add(key);
    return null;
  };
  for (const key of order.keys()) {
    const cycle = visit(key);
    if (cycle !== null) return cycle;
  }
  return null;
}

/** The order in `text`, for a batch of `keys`, or why it is refused. */
export function parseOrder(text: string, keys: readonly string[]): { order: Order } | { refusal: string } {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { refusal: "it is not JSON" };
  }
  if (!isObject(value)) return { refusal: "it is not one object keyed by ticket" };
  const batch = new Set(keys);
  const order = new Map<string, Place>();
  for (const [key, place] of Object.entries(value)) {
    if (!batch.has(key)) return { refusal: `it names ${key}, which is not in the batch` };
    if (!isObject(place) || !(place.repo === null || typeof place.repo === "string") || !Array.isArray(place.after) || !place.after.every((k) => typeof k === "string")) {
      return { refusal: `its entry for ${key} is not ${PLACE_SHAPE}` };
    }
    const after = place.after as string[];
    const outside = after.find((k) => !batch.has(k));
    if (outside !== undefined) return { refusal: `${key} waits on ${outside}, which is not in the batch` };
    if (after.includes(key)) return { refusal: `${key} waits on itself` };
    order.set(key, { repo: place.repo, after: [...new Set(after)] });
  }
  const cycle = cycleIn(order);
  if (cycle !== null) return { refusal: `its order goes round in a cycle: ${cycle.join(" -> ")}` };
  return { order };
}
