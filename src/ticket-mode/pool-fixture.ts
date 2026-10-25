// no-token: gh -- herdr, git, the tracker and the clock are all injected; nothing is spawned
// module: a pool over fakes, for the tests of what a run is started on and how an update drains it (A11-169)
//
// IT IS `pool.test.ts`'s SETUP IN THE SMALL: a herdr that opens workspaces and reports the status a test sets, the tracker contract's in-memory fake, a queue held in memory, and a state folder of
// its own. A test names the `hook` the pool is created with (the version folder its runs are started on), the clock, and the drain store, and gets back the pool, its fakes and the queue.
import { join } from "node:path";
import { tmpDir } from "../lib/tmp-fixture.ts";
import { createFakeCodeHost } from "../plugins/fakes/code-host.ts";
import { createFakeTracker } from "../plugins/fakes/tracker.ts";
import { createPool, type PoolDeps, type QueueStore } from "./pool.ts";
import { enqueue, type Queue } from "./queue/queue-entries-and-outcomes.ts";
import { resumeQueue } from "./queue/queue-transitions.ts";
import { emptyQueue } from "./queue.ts";
import { parseTicketSettings } from "./settings.ts";
import type { Ticket, TicketSource } from "./source.ts";
import type { DrainStore } from "./pool-drain.ts";

const fake = createFakeTracker();
const source: TicketSource = { assigned: fake.assigned, read: fake.read, download: fake.download, keywords: fake.keywords };
const ticket = (key: string) => ({ key, title: key, description: "", url: `https://linear.app/x/${key}`, branch: key.toLowerCase(), status: "Backlog", statusOrder: 0, team: "NBF", project: null, priority: 0 }) as Ticket;

/** A herdr that opens a workspace per `workspace create`, lists the status a test sets per label, and records every call. */
export function fakeHerdr(status: Map<string, string>) {
  const calls: string[][] = [];
  /** Set to herdr's message to have it refuse every `workspace close` with it. */
  const closing: { refusal: string | null } = { refusal: null };
  let next = 0;
  const run = (args: string[]): string => {
    calls.push(args);
    if (closing.refusal !== null && args.includes("workspace") && args.includes("close")) throw Object.assign(new Error("herdr exited 1"), { stdout: JSON.stringify({ error: { message: closing.refusal } }) });
    if (args.includes("read")) return "";
    if (args.includes("create")) {
      next += 1;
      return JSON.stringify({ result: { root_pane: { pane_id: `w${next}:p1` }, workspace: { workspace_id: `w${next}` } } });
    }
    if (args.includes("agent") && args.includes("list")) {
      const own = [...status].map(([label, s]) => ({ name: null, workspace_id: `w${label.replace(/\D/g, "")}`, agent_session: { value: `session-${label}` }, agent_status: s }));
      return JSON.stringify({ result: { agents: own } });
    }
    if (args.includes("list")) return JSON.stringify({ result: { workspaces: [...status].map(([label, s]) => ({ label, agent_status: s, workspace_id: `w${label.replace(/\D/g, "")}` })) } });
    return JSON.stringify({ type: "ok" });
  };
  return { run, calls, closing };
}

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
}>;

/** A pool of `keys` queued and started, over fakes. `restart` is a pool over the same queue and state folder with another `hook`, as an instance restarted onto another version is. */
export function poolFixture({ keys = ["NBF-1"], max = 3, hook = { node: "/node", bin: "/tool/versions/v0.273.0/src/bin.ts" }, now = () => 100, tickets = {}, pluginRecord, drain, startUpdate, source: tracker = source }: FixtureOptions = {}) {
  const root = tmpDir("ticket-pin-");
  const settings = parseTicketSettings({ clones: { "nbl-ui-netbox": "/repos/nbl-ui-netbox" }, stateDir: join(root, "state"), tickets });
  let queue: Queue = resumeQueue(enqueue(emptyQueue(max), keys.map(ticket), { model: "sonnet", effort: "high" }, 0));
  const store: QueueStore = { get: () => queue, set: (next: Queue) => { queue = next; } };
  const status = new Map<string, string>();
  const herdr = fakeHerdr(status);
  const deps = (over: Partial<PoolDeps>): PoolDeps => ({ settings, source: tracker, hook, herdr: herdr.run, hostFile: "/work/.agent-org/host.json", now, load: () => ({ load: 1, cores: 14 }),
    transcriptsRoot: join(root, "transcripts"), wait: async () => {}, pluginRecord: pluginRecord ?? join(root, "no-plugin-record.json"), codeHost: createFakeCodeHost(),
    ...(drain === undefined ? {} : { drain }), ...(startUpdate === undefined ? {} : { startUpdate }), ...over });
  const pool = createPool(store, deps({}));
  return { root, settings, store, status, herdr, pool, restart: (over: Partial<PoolDeps>) => createPool(store, deps(over)), entry: (key: string) => queue.entries.find((e) => e.ticket.key === key)! };
}
