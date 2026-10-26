// A11-270: how long each board page waits for its reads, through the same path the page's service sends them, for a pull request's before and after and the after-merge check.
//
//   node scripts/page-timing.ts [--connection <name>] [--runs <n>]
//
// WHAT RUNS. The connection is opened in this process, as `ticket:ui` opens it (`readConnections`, `createConnections`, `proxy`), so no browser and no paired session is needed, and an ssh
// connection's tunnel is this process's own. Each run reads every page's set of reads (the reads its island makes when it is drawn) at once, as the page does, and a page's time is the time
// its slowest read took. The first run of each page includes opening the connection: that is the first load. It prints, per page, the first run, p50 and p95, and any read that did not
// answer 200; then the size of each read. Nothing is written, and the tunnel is closed on exit. `timePages` takes any reader, so a measurement of a scratch instance can use it too.
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { boardKeyPath } from "../src/ticket-mode/board-key.ts";
import { createConnections, readConnections } from "../src/ticket-mode/connections.ts";
import { proxy } from "../src/ticket-mode/remote-proxy.ts";
import { readTicketSettings } from "../src/ticket-mode/settings.ts";

/** The reads the shell makes on every page, then each page's own. */
const SHELL = ["/api/config", "/api/queue"];
const SETTINGS = [...SHELL, "/api/settings", "/api/plugins"];
export const PAGES: Readonly<Record<string, readonly string[]>> = {
  Tickets: [...SHELL, "/api/tickets", "/api/writer"],
  Runs: SHELL,
  Settings: SETTINGS,
  Machine: SETTINGS,
  Models: SETTINGS,
  Workers: SETTINGS,
  Plugins: SETTINGS,
};

/** Reads one path of the instance: its status and its answer. */
export type ReadOf = (path: string) => Promise<readonly [number, unknown]>;

type PageTimes = Readonly<{ times: readonly number[]; failed: ReadonlySet<string> }>;
export type Timing = Readonly<{ runs: number; pages: Readonly<Record<string, PageTimes>>; sizes: ReadonlyMap<string, number> }>;

/** A page's reads, made at once; its time is the slowest's. */
async function timePage(readOf: ReadOf, paths: readonly string[]) {
  const started = performance.now();
  const reads = await Promise.all(paths.map(async (path) => {
    const [status, value] = await readOf(path);
    return { path, status, bytes: Buffer.byteLength(JSON.stringify(value)) };
  }));
  return { ms: performance.now() - started, reads };
}

/** A run's page: the shell's reads, and the run's own full read (A11-270). */
export const runPage = (key: string): readonly string[] => [...SHELL, `/api/queue/${encodeURIComponent(key)}`];

/** Every page's reads (`pages`: the pages above unless a test names its own), `runs` times over, one page after another. */
export async function timePages(readOf: ReadOf, runs: number, pages: Readonly<Record<string, readonly string[]>> = PAGES): Promise<Timing> {
  const timed = Object.fromEntries(Object.keys(pages).map((page) => [page, { times: [] as number[], failed: new Set<string>() }]));
  const sizes = new Map<string, number>();
  for (let run = 0; run < runs; run += 1) {
    for (const [page, paths] of Object.entries(pages)) {
      const { ms, reads } = await timePage(readOf, paths);
      timed[page].times.push(ms);
      for (const { path, status, bytes } of reads) {
        if (status !== 200) timed[page].failed.add(`${path} ${status}`);
        else sizes.set(path, bytes);
      }
    }
  }
  return { runs, pages: timed, sizes };
}

/** The nearest-rank percentile of `sorted`. */
export const percentile = (sorted: readonly number[], p: number): number => sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)];
const ms = (value: number): string => `${Math.round(value)}`.padStart(7);
const size = (bytes: number): string => (bytes >= 1_000_000 ? `${(bytes / 1_000_000).toFixed(2)} MB` : `${(bytes / 1000).toFixed(1)} KB`);

/** The report: a line per page with its first run, p50 and p95 in ms and any read that did not answer 200, then each read's size. */
export function reportOf(timing: Timing, heading: string): string {
  const lines = [`${heading}, ${timing.runs} runs of each page`, `${"page".padEnd(10)}${"first".padStart(7)}${"p50".padStart(7)}${"p95".padStart(7)}  ms`];
  for (const [page, { times, failed }] of Object.entries(timing.pages)) {
    const sorted = [...times].sort((a, b) => a - b);
    const failures = failed.size === 0 ? "" : `  not 200: ${[...failed].join(", ")}`;
    lines.push(`${page.padEnd(10)}${ms(times[0])}${ms(percentile(sorted, 50))}${ms(percentile(sorted, 95))}${failures}`);
  }
  lines.push(`sizes: ${[...timing.sizes].map(([path, bytes]) => `${path} ${size(bytes)}`).join(", ")}`);
  return lines.join("\n");
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { connection: { type: "string" }, runs: { type: "string", default: "20" } } });
  const runs = Number(values.runs);
  if (!Number.isInteger(runs) || runs < 1) throw new Error(`--runs must be a whole number of 1 or more, not ${values.runs}`);
  const settings = readTicketSettings();
  const read = readConnections();
  if (read.refusal !== null) throw new Error(read.refusal);
  const name = values.connection ?? read.connections[0]?.name;
  const connection = read.connections.find((candidate) => candidate.name === name);
  if (connection === undefined) throw new Error(`no connection ${name ?? ""}: the connections are ${read.connections.map((candidate) => candidate.name).join(", ")}`);
  const connections = createConnections(read.connections, { local: { port: settings.port, keyPath: boardKeyPath(settings.stateDir) } });
  try {
    const readOf: ReadOf = (path) => proxy(connections, connection.name, { method: "GET", path, body: null });
    // The newest run of the queue stands for the Run page, when the queue holds one.
    const [, queue] = await readOf("/api/queue");
    const key = (queue as { entries?: readonly { ticket: { key: string } }[] })?.entries?.at(-1)?.ticket.key;
    const timing = await timePages(readOf, runs, key === undefined ? PAGES : { ...PAGES, Run: runPage(key) });
    console.log(reportOf(timing, `connection ${connection.name} (${connection.kind})`));
  } finally {
    connections.close();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ? realpathSync(process.argv[1]) : "").href) {
  main().then(() => process.exit(0), (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
