// a11ign/a11ign#4187 Change 4 (agent-org#465): THE JEV SHEET SCORER. `ceo` scored Jev on #4074's frozen sheet with a script that was run once by hand and not kept, so "run the Jev score
// now" had nothing to run. This is that script: it reads the frozen sheet, asks Jev one `choice` question per row, and writes the predictions file `triage-sample.ts --score` reads,
// each row's confidence kept beside its label.
//
// IT CARRIES NO CLIENT OF ITS OWN. Every request goes through `askProvider` in `src/triage-provider.ts` (#4384, the one Jev client in the tool): the URL, the model, the timeout and the
// one read of the key are that module's. What is here is the sheet, the question, the threshold and the pool of at most {@link MAX_IN_FLIGHT} requests.
//
// WHAT JEV SEES is what the labeller saw and what `triage-sample.ts --prompt` prints: the row's printed columns (`session`, `cause`, `causeKey`, `cost`) as the `state`, and one question
// whose `criteria` are the fixture's three label definitions. No order text exists on the sheet, so none can be sent.
//
// A ROW IS NEVER ROUTED AWAY ON A GUESS. Below the confidence, on a provider failure, on an answer that is not a label with a confidence, and for a row with no `cause` (which is not even
// asked: an order that cannot be read is never routed, whatever the model would say), the row is written `wake`: the manager wakes as it does today. `asked` keeps what Jev said, so the
// threshold can be re-read from the file without a second run.
//
// THE KEY is read by the seam, once, and is never printed: nothing here receives it, and a failure is recorded as the seam's own reason, which never names it.
import { realpathSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { readHostConfig } from "../host-config.ts";
import { askProvider, freshState, type Label, type ProviderQuestion, type TriageDeps } from "../triage-provider.ts";
import { LABELS, loadLabels, NO_CAUSE, renderScore, scoreTriage } from "./triage-sample.ts";

/** The ceiling on requests at once: a sheet of 100 rows is read in ten waves, not a hundred sockets. */
export const MAX_IN_FLIGHT = 10;
const QUESTION_NAME = "label";
const INSTRUCTIONS = `Each event is one wake of a manager seat in an agent organisation: the session woken, the cause of the wake, its cause key and what the wake cost. Label the wake as one of: ${LABELS.join(" | ")}.`;

type Sheet = ReturnType<typeof loadLabels>;
type SheetRow = Sheet["rows"][number];
type Host = TriageDeps["host"];

/**
 * One row's reading. `label` is what is WRITTEN; `asked` is what Jev said (null when it was not asked or did not answer), and `confidence` is Jev's, null when it gave none.
 * `outcome` says why the label is what it is: `kept` (at or over the threshold), `under` (a label under it, written `wake`), `failed` (no usable answer) or `no-cause` (not asked).
 */
export type Reading = { position: number; label: Label; asked: Label | null; confidence: number | null; outcome: "kept" | "under" | "failed" | "no-cause"; reason: string };
/** What the run cost, as the API reported it. `unreported` counts replies that carried no `usage`, so a total over fewer replies is not read as a total over all of them. */
export type Usage = { requests: number; inputTokens: number; outputTokens: number; unreported: number };

const isLabel = (value: unknown): value is Label => typeof value === "string" && (LABELS as readonly string[]).includes(value);
const hasCause = (row: SheetRow): boolean => typeof row.cause === "string" && row.cause !== "" && row.cause !== NO_CAUSE;
const wakeWith = (row: SheetRow, outcome: Reading["outcome"], reason: string, rest: Partial<Reading> = {}): Reading => ({ position: row.position, label: "wake", asked: null, confidence: null, outcome, reason, ...rest });

/** The question as the provider is given it: the fixture's definitions are the `criteria`, so the labeller's own words are what the model chooses between. */
function questionFor(definitions: Sheet["definitions"]): ProviderQuestion {
  return { type: "choice", instructions: INSTRUCTIONS, criteria: Object.fromEntries(LABELS.map((label) => [label, definitions[label]])) };
}

/** Jev's reading of one answer, or why it is not one: a label this sheet allows and a confidence from 0 to 1. */
function readLabel(raw: unknown): { asked: Label; confidence: number } | undefined {
  const { choice, confidence } = (typeof raw === "object" && raw !== null ? raw : {}) as { choice?: unknown; confidence?: unknown };
  if (!isLabel(choice) || typeof confidence !== "number" || !(confidence >= 0 && confidence <= 1)) return undefined;
  return { asked: choice, confidence };
}

/**
 * The seam's `fetch`, wrapped to count: it adds to `usage` and hands the seam a reply that still has only what the seam reads (`ok`, `status`, `json`). It is a count and never a second
 * client: the request, its header and its timeout are the seam's, and the key is in none of what is kept here.
 */
function counting(fetchFn: typeof fetch, usage: Usage): typeof fetch {
  const tokens = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined);
  return (async (url: string, init: RequestInit) => {
    usage.requests += 1;
    const response = await fetchFn(url, init);
    return {
      ok: response.ok, status: response.status,
      json: async () => {
        const body = await response.json();
        const reported = (body as { usage?: { input_tokens?: unknown; output_tokens?: unknown } } | null)?.usage;
        const [input, output] = [tokens(reported?.input_tokens), tokens(reported?.output_tokens)];
        if (input === undefined || output === undefined) usage.unreported += 1;
        else { usage.inputTokens += input; usage.outputTokens += output; }
        return body;
      },
    } as Response;
  }) as typeof fetch;
}

/** Run `work` over `items` with at most `limit` in flight; results come back in the items' order. */
async function pooled<T, R>(items: readonly T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const lane = async () => {
    while (next < items.length) {
      const at = next++;
      out[at] = await work(items[at]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
  return out;
}

/**
 * Score every row of the sheet. Never throws for a provider's sake: a row whose request failed is `wake` with the reason, and the run finishes.
 * @param threshold the confidence a label needs to be kept; below it (strictly) the row is `wake`
 * @param concurrency how many requests may be in flight (the row's ceiling is {@link MAX_IN_FLIGHT}; a test passes more to show its counter notices)
 */
export async function scoreSheet({ sheet, deps, threshold, concurrency = MAX_IN_FLIGHT }: { sheet: Sheet; deps: TriageDeps; threshold: number; concurrency?: number; }): Promise<{ readings: Reading[]; usage: Usage; }> {
  const usage: Usage = { requests: 0, inputTokens: 0, outputTokens: 0, unreported: 0 };
  const counted = { ...deps, fetch: counting(deps.fetch ?? fetch, usage), state: deps.state ?? freshState() };
  const questions = { [QUESTION_NAME]: questionFor(sheet.definitions) };
  const read = async (row: SheetRow): Promise<Reading> => {
    if (!hasCause(row)) return wakeWith(row, "no-cause", "the row has no cause, and a row that cannot be read is never routed");
    const state = { session: row.session, cause: row.cause, causeKey: row.causeKey, cost: row.cost };
    const reply = await askProvider({ state, questions }, counted);
    if ("failed" in reply) return wakeWith(row, "failed", `the provider did not answer: ${reply.failed}`);
    const answer = readLabel(reply.answers[QUESTION_NAME]);
    if (answer === undefined) return wakeWith(row, "failed", "the API's answer was not a label with a confidence");
    if (answer.confidence < threshold) return wakeWith(row, "under", `${answer.asked} at ${answer.confidence}, under the threshold ${threshold}`, answer);
    return { position: row.position, label: answer.asked, asked: answer.asked, confidence: answer.confidence, outcome: "kept", reason: `${answer.asked} at ${answer.confidence}` };
  };
  return { readings: await pooled(sheet.rows, concurrency, read), usage };
}

/** The request figures and the score (the unmodified #4183 scorer's own), as the text a row's Done-when posts. */
export function renderRun({ sheet, readings, usage, threshold }: { sheet: Sheet; readings: Reading[]; usage: Usage; threshold: number; }): string {
  const asked = readings.filter((r) => r.outcome !== "no-cause").length;
  const failed = readings.filter((r) => r.outcome === "failed").length;
  const routedAway = readings.filter((r) => r.label !== "wake").length;
  const readable = sheet.rows.filter((row) => !row.excluded).length;
  const routedReadable = readings.filter((r, index) => r.label !== "wake" && !sheet.rows[index].excluded).length;
  return [
    `threshold ${threshold}: ${readings.length} rows, ${asked} asked (a row with no cause is not), ${failed} of them not read (written wake)`,
    `routed away from the managers: ${routedAway} of ${readings.length}, ${routedReadable} of the ${readable} readable rows`,
    `requests ${usage.requests}, input tokens ${usage.inputTokens}, output tokens ${usage.outputTokens}${usage.unreported > 0 ? ` (${usage.unreported} repl${usage.unreported === 1 ? "y" : "ies"} reported no usage: a floor)` : ""}`,
    "", renderScore(scoreTriage(sheet.rows, readings)),
  ].join("\n");
}

/** The confidence a label needs: the flag, else the host's own declaration (`minConfidence` of its `triage` block, which the host reader defaults to 0.9). */
export const thresholdFor = (flag: number | null, host: { provider: "jev"; minConfidence: number; }): number => flag ?? host.minConfidence;

/** @returns the `--threshold` as a number from 0 to 1 */
export function parseThreshold(text: string): number {
  const value = text.trim() === "" ? Number.NaN : Number(text);
  if (!(value >= 0 && value <= 1)) throw new Error(`--threshold takes a number from 0 to 1, got ${JSON.stringify(text)}`);
  return value;
}

export function parseArgs(argv: string[]): { input: string | null; out: string; threshold: number | null; host: string | null; } {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (!["--input", "--out", "--threshold", "--host"].includes(flag)) throw new Error(`unexpected argument ${flag}`);
    const value = argv[++i];
    if (value === undefined || value.startsWith("--")) throw new Error(`${flag} takes a value`);
    flags.set(flag.slice(2), value);
  }
  if (!flags.has("out")) throw new Error("--out <predictions.json> is required: the predictions file is the product");
  return { input: flags.get("input") ?? null, out: flags.get("out") as string, threshold: flags.has("threshold") ? parseThreshold(flags.get("threshold") as string) : null, host: flags.get("host") ?? null };
}

async function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    const host = args.host === null ? readHostConfig() : readHostConfig(args.host);
    if (host.triage?.provider !== "jev") throw new Error("the host declares no `jev` triage provider, so there is nobody to ask: no request was made and no file was written");
    const sheet = args.input === null ? loadLabels() : loadLabels(pathToFileURL(args.input));
    const threshold = thresholdFor(args.threshold, host.triage);
    const { readings, usage } = await scoreSheet({ sheet, deps: { host }, threshold });
    writeFileSync(args.out, `${JSON.stringify(readings, null, 2)}\n`);
    process.stdout.write(`${renderRun({ sheet, readings, usage, threshold })}\npredictions written to ${args.out}\n`);
    // A run in which nothing that was asked came back readable (a key that cannot be read, a dead API) wrote 100 `wake`s and measured nothing: it must not look like a result.
    const asked = readings.filter((r) => r.outcome !== "no-cause");
    if (asked.length > 0 && asked.every((r) => r.outcome === "failed")) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`triage-jev: ${error instanceof Error ? error.message : String(error)}\nusage: node src/trace/triage-jev.ts --out <predictions.json> [--threshold <0..1>] [--input <sheet.json>] [--host <host.json>]\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) await main();
