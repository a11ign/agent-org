// agent-org#1205: THE FLOOR IS SET FROM WHAT THE DECISION LED TO, NOT FROM ONE FLAT NUMBER. Every answer carries the provider's confidence, and what came of the routing that
// answer belonged to (its outcome line in the decision log) is the only evidence of whether that confidence was right. For each question this reads the routings and picks the
// LOWEST floor at which the answers at or above it were right at {@link RIGHT_RATE}. Where the sample is too small, or no floor reaches the rate, the flat floor stands and the
// reading SAYS so: a floor is never invented.
//
// PURE. The log lines come in as parsed JSON; nothing here reads a file, a switch or the provider. The result is data, and a caller writes it where the floor code reads it.
//
// WHAT IS RIGHT. A routing's own outcome is applied to each of its answers: `merged-first-pass` is right, `not-first-pass` and `escalated` are wrong. Every other outcome is no
// verdict: a reused route, a refusal, an override, or a route closed without a merge, which says nothing about the route. A routing with a confidence and no verdict is UNJOINED,
// and it is counted and named.
//
// COMPACTIONS. A first-pass merge whose session compacted more than {@link COMPACTIONS_TOO_MANY} times had a window too small for it, so it is wrong. The count is measured in the
// trace store (engineer-route.ts), and the log line does not carry it: this module does not read the store, so the caller passes the counts in by routing id. A routing with no count
// is judged by its outcome alone, and a count only ever turns a right verdict wrong, never a missing verdict into one. TURNS are not read.
//
// THE JOIN. A routing is its REQUEST line and the outcome lines written after it for the same `use` and `id`, up to the next request for that id. The request is the routing; an
// outcome written later closes nothing else, and a later request starts a new routing of its own.

/** The flat floor every question has now: the routing's own floor (`engineer-route.ts`). The host's `triage.minConfidence` defaults to 0.9, which is a separate floor. */
export const FLAT_FLOOR = 0.7;
/** The share of answers at or above a floor that must be right for the floor to be set there. */
export const RIGHT_RATE = 0.8;
/** The fewest judged answers a reading may rest on, counted above the floor it sets; under it the flat floor stands. */
export const MIN_SAMPLE = 30;
/** The candidate floors, lowest first: 0.50 to 0.95 in steps of 0.05. Integer steps, so 0.7 is exactly 70 / 100 and the comparison is exact. */
export const FLOOR_GRID: readonly number[] = Object.freeze(Array.from({ length: 10 }, (_, i) => (50 + i * 5) / 100));

/** The outcome label a first pass that merged writes (`recordRouteOutcome`'s). The one verdict that is right. */
export const FIRST_PASS_MERGED = "merged-first-pass";
const WRONG_OUTCOMES: ReadonlySet<string> = new Set(["not-first-pass", "escalated"]);
/** The most compactions one session may take and still have had a window big enough. Mirrors `WINDOW_TOO_SMALL_COMPACTIONS` (engineer-route.ts), which this module does not import. */
export const COMPACTIONS_TOO_MANY = 2;

/** Right (`true`), wrong (`false`), or no verdict (`undefined`) for one outcome label. */
export function verdictOf(outcome: string): boolean | undefined {
  if (outcome === FIRST_PASS_MERGED) return true;
  return WRONG_OUTCOMES.has(outcome) ? false : undefined;
}

/** A routing: one request line, with the outcome labels written for it after, in file order. `at` names the request when it has no `id`. */
type Routing = { id?: string; at: number; answers: Record<string, unknown>; outcomes: string[] };
/** A routing that carries a confidence and could not be judged: the name is its `id`, or the request's time when it has none. */
export type Unjoined = { name: string; reason: string };
/** One question's reading: the floor to set, whether it was measured (`calibrated`), why, and what it rests on. */
export type FloorReading = { floor: number; calibrated: boolean; reason: string; sample: number; rightRate?: number };
export type Calibration = { judged: number; floors: Record<string, FloorReading>; unjoined: Unjoined[] };
type Sample = { confidence: number; right: boolean };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** The routings of `use` in file order. A request opens one; an outcome line closes nothing, it is added to the routing its `id` last opened. */
function routingsIn(lines: readonly unknown[], use: string): Routing[] {
  const routings: Routing[] = [];
  const open = new Map<string, Routing>();
  for (const line of lines) {
    if (!isRecord(line) || line.use !== use) continue;
    const id = typeof line.id === "string" ? line.id : undefined;
    if (isRecord(line.answers)) {
      const routing: Routing = { ...(id === undefined ? {} : { id }), at: typeof line.at === "number" ? line.at : 0, answers: line.answers, outcomes: [] };
      routings.push(routing);
      if (id !== undefined) open.set(id, routing);
    } else if (typeof line.outcome === "string" && id !== undefined) {
      open.get(id)?.outcomes.push(line.outcome);
    }
  }
  return routings;
}

/** The last verdict the routing's outcomes give: a later judged outcome is what it led to, and a reuse written after it is not. */
function verdictOfRouting(outcomes: readonly string[]): boolean | undefined {
  for (const outcome of [...outcomes].reverse()) {
    const verdict = verdictOf(outcome);
    if (verdict !== undefined) return verdict;
  }
  return undefined;
}

function confidenceOf(routing: Routing, question: string): number | undefined {
  const answer = routing.answers[question];
  return isRecord(answer) && typeof answer.confidence === "number" ? answer.confidence : undefined;
}

/** The one reading for a question's judged answers: the lowest floor on the grid that keeps at least {@link MIN_SAMPLE} answers, right at {@link RIGHT_RATE}. */
function readingFor(samples: readonly Sample[], flat: number): FloorReading {
  if (samples.length < MIN_SAMPLE) {
    return { floor: flat, calibrated: false, reason: `${samples.length} judged answers, under the minimum of ${MIN_SAMPLE}: the flat ${flat} stands`, sample: samples.length };
  }
  for (const floor of FLOOR_GRID) {
    const above = samples.filter((s) => s.confidence >= floor);
    // Higher floors keep fewer answers, so once one is short every higher one is too.
    if (above.length < MIN_SAMPLE) break;
    const rightRate = above.filter((s) => s.right).length / above.length;
    if (rightRate >= RIGHT_RATE) {
      return { floor, calibrated: true, reason: `the lowest floor at which the answers at or above it are right at ${RIGHT_RATE} or more`, sample: above.length, rightRate };
    }
  }
  return { floor: flat, calibrated: false, reason: `no floor keeps ${RIGHT_RATE} right over ${MIN_SAMPLE} answers: the flat ${flat} stands`, sample: samples.length };
}

/**
 * THE FLOOR OF EACH QUESTION OF `options.use`, read from the decision log's parsed lines. Every routing is either judged (its outcome gives a verdict, applied to each of its
 * answers) or unjoined (it carries a confidence and no verdict, so it is named and counted). A question with no judged answers gets the flat floor with a reason, never a guess.
 * `compactions` maps a routing's `id` to the compactions its session took (measured in the trace store by the caller); see the header.
 */
export function calibrateFloors(lines: readonly unknown[], options: { use: string; flatFloor?: number; compactions?: ReadonlyMap<string, number> }): Calibration {
  const flat = options.flatFloor ?? FLAT_FLOOR;
  const routings = routingsIn(lines, options.use);
  const questions = [...new Set(routings.flatMap((routing) => Object.keys(routing.answers)))];
  const unjoined: Unjoined[] = [];
  const judged: { routing: Routing; right: boolean }[] = [];
  for (const routing of routings) {
    const outcomeVerdict = verdictOfRouting(routing.outcomes);
    const compacted = routing.id === undefined ? undefined : options.compactions?.get(routing.id);
    const right = outcomeVerdict === true && compacted !== undefined && compacted > COMPACTIONS_TOO_MANY ? false : outcomeVerdict;
    if (right !== undefined) {
      judged.push({ routing, right });
      continue;
    }
    if (questions.every((question) => confidenceOf(routing, question) === undefined)) continue;
    const name = routing.id ?? `the request at ${routing.at}`;
    const last = routing.outcomes.at(-1);
    unjoined.push({ name, reason: last === undefined ? "no outcome has been recorded" : `no outcome that judges it (last: ${last})` });
  }
  const floors = Object.fromEntries(questions.map((question) => {
    const samples = judged.flatMap(({ routing, right }): Sample[] => {
      const confidence = confidenceOf(routing, question);
      return confidence === undefined ? [] : [{ confidence, right }];
    });
    return [question, readingFor(samples, flat)];
  }));
  return { judged: judged.length, floors, unjoined };
}
