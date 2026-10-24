// no-token: gh -- herdr, git, the tracker and the clock are all injected; nothing is spawned
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "../lib/tmp-fixture.ts";
import { createFakeCodeHost } from "../plugins/fakes/code-host.ts";
import { createFakeTracker } from "../plugins/fakes/tracker.ts";
import { createPool, herdrName, type QueueStore } from "./pool.ts";
import { fakeHerdr } from "./pool-fixture.ts";
import { enqueue, type Outcome, type Queue } from "./queue/queue-entries-and-outcomes.ts";
import { pauseQueue, resumeQueue } from "./queue/queue-transitions.ts";
import { emptyQueue } from "./queue.ts";
import { parseTicketSettings } from "./settings.ts";
import type { Ticket, TicketSource } from "./source.ts";
import { ticketDir } from "./ticket-paths.ts";
import { CLAIMS_GIVEN_FILE, CLAIMS_RETRIED_FILE } from "./path-claims.ts";

const fake = createFakeTracker();
const ticket = (key: string) => ({ key, title: key, description: "", url: `https://linear.app/x/${key}`, branch: key.toLowerCase(), status: "Backlog", statusOrder: 0, team: "NBF", project: null, priority: 0 }) as Ticket;
const reasonOf = (outcome: Outcome | undefined): string => (outcome?.kind === "needs-human" ? outcome.reason : "");
const settled = async () => { for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve)); };

/** What A11-196 (Tickets) holds in the plan its worker was given: whole folders, as on the morning A11-200 sat queued. */
const HELD_PLAN = "## Paths\n\n- `agent-org:ui/src/shell/`\n- `agent-org:ui/test/`\n- `agent-org:ui/captures/`\n";
const planOf = (...paths: string[]): string => `# Plan\n\n## Approach\n\nSettings page.\n\n## Paths\n\n${paths.map((path) => `- \`${path}\``).join("\n")}\n`;

/** A pool with A11-196 holding folders (its plan is read for its paths) and A11-212 planning; the tracker records what it is asked to attach. */
async function planning() {
  const root = tmpDir("ticket-claims-settle-");
  const settings = parseTicketSettings({ clones: { "agent-org": "/repos/agent-org" }, stateDir: join(root, "state"),
    tickets: { plan: "-plan-[^/]*\\.md$", planner: { run: "Run the planner with: unattended: plan {key} into {dir}", state: "Planned" } } });
  const attached: { key: string; files: string[] }[] = [];
  const source: TicketSource = { assigned: fake.assigned, read: fake.read, keywords: fake.keywords,
    download: async (held, dir) => {
      if (held.key !== "A11-196") return [];
      const file = join(dir, "A11-196-0001-plan-tickets.md");
      writeFileSync(file, HELD_PLAN);
      return [file];
    },
    attachPlan: async (key, files) => { attached.push({ key, files: [...files] }); return null; } };
  let queue: Queue = resumeQueue(enqueue(emptyQueue(2), [ticket("A11-196"), ticket("A11-212")], { model: "sonnet", effort: "high" }, 0, { keys: new Set(["A11-212"]), choice: { model: "opus", effort: "max" }, batch: false }));
  const store: QueueStore = { get: () => queue, set: (next: Queue) => { queue = next; } };
  const status = new Map<string, string>();
  const herdr = fakeHerdr(status);
  const pool = createPool(store, { settings, source, hook: { node: "/node", bin: "/tool/src/bin.ts" }, herdr: herdr.run, hostFile: "/work/.agent-org/host.json", now: () => 100, load: () => ({ load: 1, cores: 14 }),
    transcriptsRoot: join(root, "transcripts"), wait: async () => {}, pluginRecord: join(root, "no-plugin-record.json"), codeHost: createFakeCodeHost() });
  await pool.tick();
  store.set(pauseQueue(store.get()));
  const dir = ticketDir(settings, "A11-212");
  const entry = (key: string) => queue.entries.find((e) => e.ticket.key === key)!;
  /** The planner writes `plan` and ends on planned; the board settles it. */
  const end = async (plan: string) => {
    writeFileSync(join(dir, "plan", "A11-212-0001-plan-settings.md"), plan);
    writeFileSync(join(dir, "outcome.json"), JSON.stringify({ kind: "planned" }));
    status.set(herdrName("A11-212"), "idle");
    await pool.tick();
    await settled();
  };
  return { dir, entry, attached, end };
}

test("A11-212: the brief and the run's claims file hold the paths another ticket holds, written from one array", async () => {
  const { dir } = await planning();
  const given = JSON.parse(readFileSync(join(dir, CLAIMS_GIVEN_FILE), "utf8")) as { key: string; state: string; paths: string[] }[];
  assert.equal(given.length, 1);
  assert.equal(given[0].key, "A11-196");
  assert.deepEqual(given[0].paths, ["agent-org:ui/src/shell/", "agent-org:ui/test/", "agent-org:ui/captures/"]);
  const brief = readFileSync(join(dir, "brief.md"), "utf8");
  assert.ok(brief.includes(`- A11-196 (${given[0].state}): \`agent-org:ui/src/shell/\`, \`agent-org:ui/test/\`, \`agent-org:ui/captures/\``), "the brief prints the same array");
  assert.ok(brief.includes("## Paths other tickets hold"));
});

test("A11-212: a plan that claims a folder another ticket writes into is refused, with the narrower paths named, and nothing is attached", async () => {
  const { entry, attached, end } = await planning();
  await end(planOf("agent-org:ui/src/shell/", "agent-org:ui/test/", "agent-org:ui/captures/settings/"));
  assert.equal(entry("A11-212").outcome?.kind, "needs-human");
  const reason = reasonOf(entry("A11-212").outcome);
  assert.match(reason, /^the plan claims a folder that other queued or running tickets also write into\./);
  assert.ok(reason.includes("`agent-org:ui/src/shell/` is a folder A11-196 (`ui/src/shell/`) also writes into"));
  assert.ok(reason.includes("`agent-org:ui/test/` is a folder A11-196 (`ui/test/`) also writes into"));
  assert.ok(reason.includes("a folder of its own such as `ui/test/<feature>/`"));
  assert.equal(reason.includes("captures/settings"), false, "a folder only this ticket writes in is not named");
  assert.equal(reason.includes("automatic retry"), false, "no retry was made");
  assert.deepEqual(attached, []);
});

test("A11-212: when the stop hook's retry was made, the refusal says the planner was asked once", async () => {
  const { dir, entry, end } = await planning();
  writeFileSync(join(dir, CLAIMS_RETRIED_FILE), `${JSON.stringify({ at: 1, folders: ["agent-org:ui/test/"] })}\n`);
  await end(planOf("agent-org:ui/test/"));
  assert.match(reasonOf(entry("A11-212").outcome), /One automatic retry was made, asking for narrower paths, and the plan still claims `agent-org:ui\/test\/`$/);
});

test("A11-212: a plan of per-feature folders and files is attached, whatever else another ticket holds", async () => {
  const { entry, attached, end } = await planning();
  await end(planOf("agent-org:ui/src/pages/settings/", "agent-org:ui/test/settings/", "agent-org:ui/captures/settings/", "agent-org:ui/src/shell/App.tsx"));
  assert.equal(entry("A11-212").outcome, undefined, "nothing went to a person");
  assert.equal(entry("A11-212").phase, "queued", "the ticket is queued again to be worked");
  assert.deepEqual(attached.map(({ key }) => key), ["A11-212"]);
});

test("A11-212: a run briefed before this check, with no claims file, is not refused for a folder", async () => {
  const { dir, entry, end } = await planning();
  rmSync(join(dir, CLAIMS_GIVEN_FILE), { force: true });
  await end(planOf("agent-org:ui/test/"));
  assert.equal(entry("A11-212").outcome, undefined);
});
