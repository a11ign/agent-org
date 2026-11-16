// no-token: gh -- herdr, git, the tracker, the clock and the restart reads are all injected; nothing is spawned
// module: a pool over fakes, for the tests of what a run is started on and how an update drains it (A11-169)
//
// IT IS `pool.test.ts`'s SETUP IN THE SMALL: a herdr that opens workspaces and reports the status a test sets, the tracker contract's in-memory fake, a queue held in memory, and a state folder of
// its own. A test names the `hook` the pool is created with (the version folder its runs are started on), the clock, and the drain store, and gets back the pool, its fakes and the queue.
import { createSettledPool } from "./pool-settled-fixture.ts";
import { join } from "node:path";
import { tmpDir } from "../lib/tmp-fixture.ts";
import { createFakeCodeHost } from "../plugins/fakes/code-host.ts";
import { createFakeTracker } from "../plugins/fakes/tracker.ts";
import { type PoolDeps, type QueueStore } from "./pool.ts";
import { enqueue, type Queue } from "./queue/queue-entries-and-outcomes.ts";
import { resumeQueue } from "./queue/queue-transitions.ts";
import { emptyQueue } from "./queue.ts";
import { parseTicketSettings } from "./settings.ts";
import type { Ticket, TicketSource } from "./source.ts";
import type { DrainStore } from "./pool-drain.ts";
import { createCallLedger, type CallLedger } from "./call-outcomes.ts";
import { fakeHerdr } from "./fake-herdr.ts";

export { fakeHerdr };

const fake = createFakeTracker();
const source: TicketSource = { assigned: fake.assigned, read: fake.read, download: fake.download, keywords: fake.keywords };
const ticket = (key: string) => ({ key, title: key, description: "", url: `https://linear.app/x/${key}`, branch: key.toLowerCase(), status: "Backlog", statusOrder: 0, team: "NBF", project: null, priority: 0 }) as Ticket;

/** The drain store a test holds in memory, with every write kept. */
export function memoryDrain(): DrainStore & { current: ReturnType<DrainStore["read"]>; writes: Parameters<DrainStore["write"]>[0][] } {
  const held: { current: ReturnType<DrainStore["read"]>; writes: Parameters<DrainStore["write"]>[0][] } = { current: { kind: "none" }, writes: [] };
  return Object.assign(held, {
    read: () => held.current,
    write: (record: Parameters<DrainStore["write"]>[0]) => { held.writes.push(record); held.current = { kind: "draining", record }; },
  });
}

export type FixtureOptions = Readonly<{
  keys?: readonly string[];
  max?: number;
  hook?: PoolDeps["hook"];
  now?: () => number;
  tickets?: Record<string, unknown>;
  pluginRecord?: string;
  drain?: DrainStore;
  startUpdate?: () => void;
  /** The tracker the pool reads and writes; the in-memory fake's when absent. */
  source?: TicketSource;
  /** The keys planned first, by a planning run of their own on the planning choice (A11-250): the rest are worked as queued. */
  planFirst?: readonly string[];
  /** The description each queued ticket carries, by key; none for a key not named. */
  descriptions?: Readonly<Record<string, string>>;
  /** What the pool reads a restart from (A11-279): one boot and one herdr start that never change, unless a test gives its own. */
  restartReads?: PoolDeps["restartReads"];
  /** The repositories the host file's `clones` names, by repository name (A11-286): a test that has the board read a real clone names it here. */
  clones?: Readonly<Record<string, string>>;
  /** The directory each run's private `TMPDIR` is made under (A11-279): none, so a run gets none, unless a test names one. */
  privateTmpBase?: string;
  /** The ledger of the board's calls the pool reads to tell the network is back (A11-399): one of its own over the pool's clock, so a test records the calls and nothing else does. */
  calls?: CallLedger;
}>;

/** A pool of `keys` queued and started, over fakes. `restart` is a pool over the same queue and state folder with another `hook`, as an instance restarted onto another version is. */
export function poolFixture({ keys = ["NBF-1"], max = 3, hook = { node: "/node", bin: "/tool/versions/v0.273.0/src/bin.ts" }, now = () => 100, tickets = {}, pluginRecord, drain, startUpdate, source: tracker = source, planFirst = [], descriptions = {},
  restartReads = { bootId: () => "boot-1", herdrStart: () => "1" }, clones = { "nbl-ui-netbox": "/repos/nbl-ui-netbox" }, privateTmpBase, calls = createCallLedger(now) }: FixtureOptions = {}) {
  const root = tmpDir("ticket-pin-");
  const settings = parseTicketSettings({ clones, stateDir: join(root, "state"), tickets });
  const plan = planFirst.length === 0 ? null : { keys: new Set(planFirst), choice: { model: "opus", effort: "max" }, batch: false };
  let queue: Queue = resumeQueue(enqueue(emptyQueue(max), keys.map((key) => ({ ...ticket(key), description: descriptions[key] ?? "" })), { model: "sonnet", effort: "high" }, 0, plan));
  const store: QueueStore = { get: () => queue, set: (next: Queue) => { queue = next; } };
  const status = new Map<string, string>();
  const herdr = fakeHerdr(status);
  const deps = (over: Partial<PoolDeps>): PoolDeps => ({ settings, source: tracker, hook, herdr: herdr.run, hostFile: "/work/.agent-org/host.json", now, load: () => ({ load: 1, cores: 14 }),
    transcriptsRoot: join(root, "transcripts"), wait: async () => {}, pluginRecord: pluginRecord ?? join(root, "no-plugin-record.json"), codeHost: createFakeCodeHost(), restartReads, calls, paneEnv: (pane) => herdr.envs.get(pane) ?? null,
    ...(privateTmpBase === undefined ? {} : { privateTmpBase }),
    ...(drain === undefined ? {} : { drain }), ...(startUpdate === undefined ? {} : { startUpdate }), ...over });
  const pool = createSettledPool(store, deps({}));
  return { root, settings, store, status, herdr, pool, calls, restart: (over: Partial<PoolDeps>) => createSettledPool(store, deps(over)), entry: (key: string) => queue.entries.find((e) => e.ticket.key === key)! };
}
