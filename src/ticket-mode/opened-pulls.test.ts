// no-token: gh -- the code host is the fake, and herdr, the tracker and the clock are injected; the pool is driven over fakes
// A11-240: a run that is queued again is told what its ticket has opened on the code host, and Respond answers a pull request the board never recorded
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { poolFixture } from "./pool-fixture.ts";
import { ticketDir } from "./ticket-paths.ts";
import { loadReviewerGate, reviewedRepositoriesOf } from "./reviewer-port.ts";
import { createFakeCodeHost } from "../plugins/fakes/code-host.ts";
import { replace, type Entry } from "./queue/queue-entries-and-outcomes.ts";
import { finish } from "./queue/queue-transitions.ts";

const CRASHED = { kind: "crashed", reason: "the pool restarted while it was running" } as const;
const SECTION = "## Pull requests already opened for this ticket";

type Fixture = ReturnType<typeof poolFixture>;
type Host = ReturnType<typeof createFakeCodeHost>;

/** A fake code host that can be asked about every repository the board reviews, and the first of them. */
async function hostOf(made: Fixture): Promise<{ host: Host; repo: string }> {
  await loadReviewerGate();
  const host = createFakeCodeHost("worker-bot");
  const [repo] = reviewedRepositoriesOf(made.settings.clones);
  for (const repository of reviewedRepositoriesOf(made.settings.clones)) host.seedRepository(repository);
  return { host, repo };
}

/** A host that holds one open pull request naming NBF-1. */
async function hostWithOpenPull(made: Fixture): Promise<Host> {
  const { host, repo } = await hostOf(made);
  host.seedPull(repo, 140, { body: "Refs NBF-1" });
  return host;
}

const briefOf = (made: Fixture, key = "NBF-1"): string => readFileSync(join(ticketDir(made.settings, key), "brief.md"), "utf8");

/** NBF-1's run, started over `host`: its brief is written, and its record holds no pull request. */
async function started(made: Fixture, host: Host): Promise<string> {
  await made.restart({ codeHost: host }).tick();
  return briefOf(made);
}

test("a brief for a run started again lists an open pull request the board never recorded, with its head, its failing checks and its Partial step, and a merged one with its state", async () => {
  const made = poolFixture();
  const { host, repo } = await hostOf(made);
  const open = host.seedPull(repo, 140, { head: "0123456789abcdef", body: "Refs NBF-1\n\nPartial: step 1 of 2: the second half", feedback: { failing: ["lint", "types"] } });
  const merged = host.seedPull(repo, 139, { state: "merged", body: "Closes NBF-1" });
  const brief = await started(made, host);
  const section = brief.slice(brief.indexOf(SECTION), brief.indexOf("## Where the work lands"));
  assert.ok(section.startsWith(SECTION), "the section is in the brief");
  assert.match(section, new RegExp(`- ${open.url} \\(${repo}\\): open; head 012345678; failing checks: lint, types; Partial: step 1 of 2: the second half`));
  assert.match(section, new RegExp(`- ${merged.url} \\(${repo}\\): merged; completes the ticket`));
  assert.match(section, /continue from there: fix an open pull request on its own branch, and never do again a step whose pull request merged\. A closed one was not merged/);
});

test("a pull request that only mentions the key, or names another ticket, is not the ticket's and is not in the brief", async () => {
  const made = poolFixture();
  const { host, repo } = await hostOf(made);
  host.seedPull(repo, 150, { body: "The plan holds step 2 until NBF-1 has merged." });
  host.seedPull(repo, 151, { body: "Refs NBF-10" });
  host.seedPull(repo, 152, { body: "Closes NBF-2\n\nIt follows the design of NBF-1." });
  const brief = await started(made, host);
  assert.equal(brief.includes(SECTION), false);
});

test("a brief with no pull request found has no such section, and neither has one written when the code host cannot be asked", async () => {
  const made = poolFixture();
  const { host } = await hostOf(made);
  assert.equal((await started(made, host)).includes(SECTION), false, "none names the ticket");
  const unaskable = poolFixture();
  assert.equal((await started(unaskable, createFakeCodeHost("worker-bot"))).includes(SECTION), false, "a repository the host cannot read: null, and the run still starts");
  assert.equal(unaskable.entry("NBF-1").phase, "running");
});

test("a code host without the read gives no list, and the run starts as it did", async () => {
  const made = poolFixture();
  const { host, repo } = await hostOf(made);
  host.seedPull(repo, 140, { body: "Refs NBF-1" });
  const { pullsNaming, ...older } = host;
  assert.equal(typeof pullsNaming, "function");
  assert.equal((await started(made, older as unknown as Host)).includes(SECTION), false);
  assert.equal(made.entry("NBF-1").phase, "running");
});

test("the pull request of a plan step already merged is listed by the steps section, not twice", async () => {
  const made = poolFixture();
  const { host, repo } = await hostOf(made);
  const first = host.seedPull(repo, 139, { state: "merged", body: "Refs NBF-1\n\nPartial: step 1 of 2: the second half" });
  const stray = host.seedPull(repo, 141, { body: "Refs NBF-1" });
  made.store.set(replace(made.store.get(), "NBF-1", (entry) => ({ ...entry, steps: [{ step: 1, of: 2, prs: [first.url] }] })));
  const brief = await started(made, host);
  const section = brief.slice(brief.indexOf(SECTION), brief.indexOf("## Where the work lands"));
  assert.equal(section.includes(first.url), false);
  assert.match(section, new RegExp(stray.url));
  assert.equal(brief.split(first.url).length - 1, 1, "the steps section names it once");
});

/** NBF-1 run and ended crashed with nothing on record, as the restart that emptied the board's record leaves it. */
async function crashedWithNothingOnRecord(made: Fixture): Promise<void> {
  await made.pool.tick();
  made.store.set(finish(made.store.get(), "NBF-1", CRASHED, 50));
}

test("Respond on a crashed run with nothing on record, whose ticket has an open pull request on the code host, queues a review round on it", async () => {
  const made = poolFixture();
  const { host, repo } = await hostOf(made);
  const open = host.seedPull(repo, 140, { body: "Refs NBF-1" });
  host.seedPull(repo, 139, { state: "merged", body: "Refs NBF-1" });
  await crashedWithNothingOnRecord(made);
  made.restart({ codeHost: host }).respond("NBF-1");
  const round: Entry = made.entry("NBF-1");
  assert.deepEqual([round.phase, round.asked], ["queued", true]);
  assert.deepEqual(round.review, [{ repo, url: open.url }], "the round answers the open pull request, and not the merged one");
});

test("Respond on a crashed run with nothing on record and nothing open on the code host is refused as before", async () => {
  const made = poolFixture();
  const { host, repo } = await hostOf(made);
  host.seedPull(repo, 139, { state: "merged", body: "Refs NBF-1" });
  host.seedPull(repo, 150, { body: "mentions NBF-1 only" });
  await crashedWithNothingOnRecord(made);
  assert.throws(() => made.restart({ codeHost: host }).respond("NBF-1"), /NBF-1 has no pull request open, so there is no feedback to answer/);
  assert.throws(() => made.pool.respond("NBF-1"), /has no pull request open/, "and a host that cannot be asked refuses as it did");
  assert.equal(made.entry("NBF-1").phase, "finished", "nothing was queued");
});

test("Respond on a run with a pull request on record answers the record's, and does not ask the code host", async () => {
  const made = poolFixture();
  const { host, repo } = await hostOf(made);
  host.seedPull(repo, 140, { body: "Refs NBF-1" });
  await made.pool.tick();
  const recorded = { repo: "nbl-ui-netbox", url: "https://github.com/x/nbl-ui-netbox/pull/1" };
  made.store.set(finish(made.store.get(), "NBF-1", { kind: "ready-pr", prs: [recorded] }, 50));
  host.calls.length = 0;
  made.restart({ codeHost: host }).respond("NBF-1");
  assert.deepEqual(made.entry("NBF-1").review, [recorded]);
  assert.deepEqual(host.calls.filter((call) => call.startsWith("pullsNaming")), []);
});

test("Respond on a run that ended on drafts with none open on record is refused as before, and the code host's pull requests are not approved in its place", async () => {
  const made = poolFixture();
  const host = await hostWithOpenPull(made);
  await made.pool.tick();
  made.store.set(finish(made.store.get(), "NBF-1", { kind: "draft-pr", prs: [{ repo: "nbl-ui-netbox", url: "https://github.com/x/nbl-ui-netbox/pull/1" }] }, 50));
  made.store.set(replace(made.store.get(), "NBF-1", (entry) => ({ ...entry, pullStates: { "https://github.com/x/nbl-ui-netbox/pull/1": "merged" } })));
  assert.throws(() => made.restart({ codeHost: host }).respond("NBF-1"), /NBF-1 has no pull request open, so there is no feedback to answer/);
  assert.equal(made.entry("NBF-1").phase, "finished");
});

test("a code host whose read of a pull request throws does not stop the run starting: the brief just has no section", async () => {
  const made = poolFixture();
  const host = await hostWithOpenPull(made);
  const throwing = { ...host, readPullFeedback: async () => { throw new Error("rate limited"); } } as unknown as Host;
  const brief = await started(made, throwing);
  assert.equal(brief.includes(SECTION), false);
  assert.equal(made.entry("NBF-1").phase, "running");
});
