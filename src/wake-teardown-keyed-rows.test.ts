// no-token: gh -- every `gh` and `herdr` call here is an injected seam (`read`, `gh`, `run`); nothing imported reaches the real one
/**
 * agent-org#4893 (a11ign#4893): AN ENGINEER KEYED TO ANOTHER TRACKER (`worker-agent-org-<n>`) IS READ, WOKEN AND ENDED LIKE ANY OTHER, AND
 * A READ THAT FAILS SAYS WHY.
 *
 * The row's premise was that the gate "cannot read the rows an agent-org-keyed engineer holds". The journal said otherwise: 15 sessions,
 * keyed and unkeyed alike, logged `could not read the rows ... leaving it running` through the two windows the workers account's GraphQL
 * pool was exhausted, and not once between them. What the log lacked was the cause, so a dead pool read as a keyed-tracker bug. These pin
 * the three things the row asked for as already true (the keyed read, the keyed owner wake, the keyed teardown) and the one it was right
 * about (a failed read names its cause), each with the mutation that turns it red in the PR.
 *
 * The project is a RECORDED one (`wake-spawn-worktree.test.ts`'s shape): the host file is set FIRST and the tool imported AFTER it, because
 * a keyed name is a member of a spare family only for a key the project declares (`familyMember`).
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRATCH = mkdtempSync(join(tmpdir(), "wake-teardown-keyed-"));
after(() => rmSync(SCRATCH, { recursive: true, force: true }));
const PROJECT = join(SCRATCH, "project");
cpSync(fileURLToPath(new URL("./packaging/fixtures/row-claim-file-overlap-rule/project", import.meta.url)), PROJECT, { recursive: true });
const DECLARATION = join(PROJECT, ".agent-org", "project.json");
const declared = JSON.parse(readFileSync(DECLARATION, "utf8")) as { tracker: { key: string; repo: string; board: { owner: string; number: number } }[] };
declared.tracker.push({ key: "agent-org", repo: "a11ign/agent-org", board: { owner: "a11ign", number: 2 } });
writeFileSync(DECLARATION, JSON.stringify(declared));
const HOST_FILE = join(SCRATCH, "host.json");
writeFileSync(HOST_FILE, JSON.stringify({ schema: 1, home: SCRATCH, binDir: join(SCRATCH, "bin"), primary: "fixture",
  projects: [{ id: "fixture", checkout: PROJECT }], clones: { "agent-org": "/clones/agent-org" },
  gh: { workers: join(SCRATCH, "workers"), leads: join(SCRATCH, "leads"), leadsHeader: [], leadsWorkspaces: [] } }));
process.env.AGENT_ORG_HOST = HOST_FILE;

const { heldRowsOfSpare, endFinishedSpares, spareInstances } = await import("./wake.ts");
const { withScopedPrOwners } = await import("./work-gate.ts");
const { ownerOfPr } = await import("./work-gate/pr-orders.ts");
const { homeProjectDeclaration } = await import("./project-config.ts");

const AGENT_ORG = "a11ign/agent-org";
const KEYED = "worker-agent-org-522";
const UNKEYED = "worker-4874";
const T0 = Date.UTC(2026, 9, 10, 20, 0, 0);

type ReadDeps = { repo?: string; run?: (args: string[]) => string };
/** A reader that records what it was asked and answers `rows`; or, with `fail`, drives the runner it was handed and lets the failure through as `null`. */
function reader(rows: number[] | null, fail?: Error) {
  const asked: { session: string; exclude: number; deps: ReadDeps }[] = [];
  const read = (session: string, exclude: number, deps: ReadDeps = {}) => {
    asked.push({ session, exclude, deps });
    if (fail === undefined) return rows;
    try {
      deps.run?.(["issue", "list"]);
    } catch {
      return null;
    }
    return rows;
  };
  return { asked, read: read as never };
}

test("positive control: the fixture project DECLARES agent-org, so a keyed name is a spare-family member and not a stranger", () => {
  assert.equal(homeProjectDeclaration().tracker.find((t) => t.key === "agent-org")?.repo, AGENT_ORG);
  assert.deepEqual(spareInstances([{ label: KEYED }, { label: UNKEYED }]), [KEYED, UNKEYED]);
});

test("agent-org#4893 (1): a keyed holder's rows are read in ITS tracker, and an unkeyed one's in the first", () => {
  const keyed = reader([522]);
  assert.deepEqual(heldRowsOfSpare(KEYED, new Map(), { read: keyed.read }), [522]);
  assert.equal(keyed.asked[0].session, KEYED);
  assert.equal(keyed.asked[0].deps.repo, AGENT_ORG, "the row lives in agent-org, so the first tracker's list would answer `holds nothing` and end a working engineer");

  const unkeyed = reader([]);
  assert.deepEqual(heldRowsOfSpare(UNKEYED, new Map(), { read: unkeyed.read }), []);
  assert.equal(unkeyed.asked[0].deps.repo, undefined, "NEGATIVE CONTROL: the first tracker's engineer is read where it always was");
});

test("agent-org#4893 (4): a read that fails leaves a CAUSE -- the failing call's own stderr line -- never only `could not read`", () => {
  const down = Object.assign(new Error("Command failed: gh issue list --repo a11ign/agent-org --state open"),
    { stderr: "\nGraphQL: API rate limit already exceeded for user ID 328832207.\nmore\n" });
  const causes = new Map<string, string>();
  const failing = reader(null, down);
  assert.equal(heldRowsOfSpare(KEYED, causes, { read: failing.read, gh: () => { throw down; } }), null, "still null: a read that could not ask ends nothing");
  assert.equal(causes.get(KEYED), `${AGENT_ORG}: GraphQL: API rate limit already exceeded for user ID 328832207.`);

  const healthy = reader([522]);
  assert.deepEqual(heldRowsOfSpare(KEYED, causes, { read: healthy.read }), [522]);
  assert.equal(causes.has(KEYED), false, "a later good read clears the cause, so a stale one is never quoted");
});

test("agent-org#4893 (4): the line that leaves a session running names the session AND the cause", () => {
  const warned: string[] = [];
  const listed = [{ label: KEYED, status: "idle" }];
  endFinishedSpares(listed, { spares: [KEYED], registry: {}, now: T0, run: () => "{}", heldRows: () => null,
    unreadBecause: () => `${AGENT_ORG}: GraphQL: API rate limit already exceeded`, rowState: () => null, worktrees: () => [],
    record: () => {}, warn: (line: string) => warned.push(line) } as never);
  assert.equal(warned.length, 1);
  assert.match(warned[0], /could not read the rows "worker-agent-org-522" holds -- leaving it running \(a11ign\/agent-org: GraphQL: API rate limit already exceeded\)\./);
});

test("agent-org#4893 (3): a keyed session whose row is CLOSED is ended and its ledger line is written", () => {
  const closed: string[] = [];
  const cycles: { role: string; clean: boolean }[] = [];
  const run = (args: string[]) => {
    const said = args.join(" ");
    if (said.endsWith("workspace list")) return JSON.stringify({ result: { workspaces: [{ label: KEYED, workspace_id: "wK", agent_status: "idle" }] } });
    if (said.includes("workspace close")) closed.push(said);
    return "{}";
  };
  const listed = [{ label: KEYED, status: "idle" }];
  const got = endFinishedSpares(listed, { spares: spareInstances(listed), registry: { [KEYED]: { spawnedAt: T0 - 3_600_000, rows: [522] } }, now: T0, run,
    heldRows: () => [], rowState: () => "CLOSED", worktrees: () => [], record: (c: never) => cycles.push(c), warn: () => {} } as never);
  assert.deepEqual(closed, ["--session org workspace close wK"]);
  assert.deepEqual(got.ended.map((c) => c.role), [KEYED]);
  assert.equal(cycles[0].clean, true);
});

test("agent-org#4893 (2): a red agent-org pull request with no label is OWNED by the keyed session holding the row it closes", () => {
  const rows = [{ number: 522, labels: [{ name: "in-progress" }, { name: `session:${KEYED}` }] }];
  const pr = { number: 713, repo: AGENT_ORG, headRefName: "agent/agent-org-deletes-its-agent-org-522", labels: [], closingIssuesReferences: [] };
  const [owned] = withScopedPrOwners([{ ...pr, body: "Closes agent-org#522" }], rows, { rowsRepo: AGENT_ORG });
  assert.deepEqual(ownerOfPr(owned), { session: KEYED, source: "closing-row" });

  const [other] = withScopedPrOwners([{ ...pr, body: "Closes agent-org#522" }], rows, { rowsRepo: "a11ign/a11ign" });
  assert.equal(ownerOfPr(other).source, "branch-row", "NEGATIVE CONTROL: read as the first tracker's rows the body line no longer names it, and only the branch suffix does");
});
