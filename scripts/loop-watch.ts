// A11-282: whether this machine's instance keeps its loop free, read over a stretch of time: the after-merge check of the ticket's Done-when.
//
//   node scripts/loop-watch.ts [--minutes 60] [--every 30] [--json]
//
// It reads the instance this machine's host file names (`readTicketSettings`, so `AGENT_ORG_HOST` points it at another, such as one started from a branch), with the key
// `ticket:pair` reads, every `--every` seconds for `--minutes`. Each time it times one read each of `/api/config`, `/api/tickets` and `/api/queue`, and records `/api/health`.
// At the end it prints the worst p99 the board's line showed (the request thread's reading, or the board loop's on an instance that has no request thread), the worst read,
// and the five call sites that held the loop the longest. It exits 0 when the shown p99 never reached SHOWN_LIMIT_MS, and 1 otherwise, or when no reading came at all.
// It only reads: nothing is written, and the instance is not restarted.
import { boardKeyPath, readBoardKey } from "../src/ticket-mode/board-key.ts";
import type { BlockingSite } from "../src/ticket-mode/blocking-ledger.ts";
import type { LoopReading } from "../src/ticket-mode/loop-delay.ts";
import { readTicketSettings } from "../src/ticket-mode/settings.ts";

/** The after-merge target: the p99 the board shows stays under this, in ms. */
export const SHOWN_LIMIT_MS = 100;
const TIMED = ["/api/config", "/api/tickets", "/api/queue"];
const READ_TIMEOUT_MS = 90_000;

/** What `/api/health` answers, from this release's instance (`board` only) or a later one's (`requests` beside it). */
type Health = Readonly<{ loop: Readonly<{ requests?: LoopReading; board?: LoopReading }>; blocking?: readonly BlockingSite[] }>;

/** One look at the instance: each timed read's ms (null when it got no answer), and its health, or null when it gave none. */
export type Sample = Readonly<{ at: number; reads: Readonly<Record<string, number | null>>; health: Health | null }>;

export type Summary = Readonly<{
  samples: number;
  /** The worst p99 the board's line showed, in ms, or null when no health was read. */
  worstShownP99Ms: number | null;
  worstRead: Readonly<{ route: string; ms: number }> | null;
  /** Reads that got no answer. */
  unanswered: number;
  blocking: readonly BlockingSite[];
  pass: boolean;
}>;

/** The reading the board's line shows: the request thread's, else the board loop's. PURE. */
export const shownReading = (health: Health): LoopReading | undefined => health.loop.requests ?? health.loop.board;

/** What the samples come to. The blocking sites are the last health's: the ledger counts from the instance's start. PURE. */
export function summarise(samples: readonly Sample[]): Summary {
  const shown = samples.flatMap((sample) => {
    const reading = sample.health === null ? undefined : shownReading(sample.health);
    return reading === undefined ? [] : [reading.p99Ms];
  });
  const reads = samples.flatMap((sample) => Object.entries(sample.reads));
  const answered = reads.flatMap(([route, ms]) => (ms === null ? [] : [{ route, ms: Math.round(ms) }]));
  const worstRead = answered.reduce<Summary["worstRead"]>((worst, read) => (worst === null || read.ms > worst.ms ? read : worst), null);
  const worstShownP99Ms = shown.length === 0 ? null : Math.max(...shown);
  const last = samples.findLast((sample) => sample.health !== null)?.health;
  return { samples: samples.length, worstShownP99Ms, worstRead, unanswered: reads.length - answered.length, blocking: (last?.blocking ?? []).slice(0, 5),
    pass: worstShownP99Ms !== null && worstShownP99Ms < SHOWN_LIMIT_MS };
}

/** The summary as a person reads it. PURE. */
export function report(summary: Summary): string {
  const { samples, worstShownP99Ms, worstRead, unanswered, blocking, pass } = summary;
  const lines = [
    `${samples} looks at the instance`,
    `the worst p99 the board showed: ${worstShownP99Ms === null ? "none read (the instance answers no /api/health)" : `${worstShownP99Ms} ms`}`,
    `the worst read: ${worstRead === null ? "none answered" : `${worstRead.route}, ${worstRead.ms} ms`}${unanswered === 0 ? "" : ` (${unanswered} reads got no answer)`}`,
    "the five sites that held the board loop the longest:",
    ...blocking.map((site) => `  ${site.site} (${site.program}): ${site.count} calls, ${site.totalMs} ms in all, the longest ${site.maxMs} ms`),
    pass ? `PASS: the p99 the board showed stayed under ${SHOWN_LIMIT_MS} ms` : `FAIL: the p99 the board showed reached ${SHOWN_LIMIT_MS} ms, or was never read`,
  ];
  return `${lines.join("\n")}\n`;
}

/** The value of `--name` in `argv` as a positive number, or `fallback`. */
function numberFlag(argv: readonly string[], name: string, fallback: number): number {
  const at = argv.indexOf(name);
  const value = at === -1 ? fallback : Number(argv[at + 1]);
  if (!(value > 0)) throw new Error(`${name} takes a number above 0, not ${argv[at + 1]}`);
  return value;
}

const sleep = (ms: number): Promise<void> => new Promise((done) => { setTimeout(done, ms); });

async function look(port: number, key: string): Promise<Sample> {
  const read = async (path: string) => {
    const started = performance.now();
    try {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, { headers: { "x-ticket-token": key }, signal: AbortSignal.timeout(READ_TIMEOUT_MS) });
      const body = await response.text();
      return { ms: performance.now() - started, ok: response.ok, body };
    } catch {
      return null;
    }
  };
  const timed = await Promise.all(TIMED.map(async (route) => [route, (await read(route))?.ms ?? null] as const));
  const health = await read("/api/health");
  return { at: Date.now(), reads: Object.fromEntries(timed), health: health?.ok === true ? (JSON.parse(health.body) as Health) : null };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const argv = process.argv.slice(2);
    const minutes = numberFlag(argv, "--minutes", 60);
    const everyMs = numberFlag(argv, "--every", 30) * 1000;
    const settings = readTicketSettings();
    const key = readBoardKey(boardKeyPath(settings.stateDir));
    const samples: Sample[] = [];
    const until = Date.now() + minutes * 60_000;
    while (Date.now() < until) {
      samples.push(await look(settings.port, key));
      await sleep(Math.max(0, Math.min(everyMs, until - Date.now())));
    }
    const summary = summarise(samples);
    process.stdout.write(argv.includes("--json") ? `${JSON.stringify(summary, null, 2)}\n` : report(summary));
    process.exitCode = summary.pass ? 0 : 1;
  } catch (err) {
    process.stderr.write(`loop-watch: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 2;
  }
}
