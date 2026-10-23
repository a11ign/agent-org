// no-token: none -- the fake code host's rows hold the world in memory; nothing here reaches `gh` or the network (agent-org#989)
/**
 * agent-org#989: THE CLAIM HONOURS THE GATE'S `priority:emergency`, AS IT HONOURS THE CHAIRMAN'S ROW (a11ign#4793).
 *
 * The gate honours a `priority:emergency` row only while `emergencyPriority.enabled` is on, its newest `labeled` event is by a setter, its body names an OPEN
 * org-blocking incident (#5032). B4 at the claim refused such a row over a holder of its files, while the gate offered it. The claim now asks the gate's own
 * `readEmergencyPriority` which rows it honours, and yields to exactly those -- a label the gate ignores gives no yield.
 *
 * POSITIVE CONTROLS: each refusal differs from the claim in ONE fact (the setter, the incident, the option, the link), so none passes by B4 doing nothing.
 */
import { test, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sandboxGitEnv } from "./lib/git-env.ts";
import { forgetActivation, substituteCodeHost } from "./plugins/active.ts";
import { createFakeCodeHost } from "./plugins/fakes/code-host.ts";
import { fakeRow } from "./plugins/fakes/code-host-rows.ts";
import { watchedRows, type WatchedCall } from "./plugins/fakes/watched-rows.test.support.ts";

// THE PROJECT THIS RUNS AGAINST IS A RECORDED ONE, as `row-claim-chairman-yield.test.ts` does it: the host file first, the tool imported after it.
const SCRATCH = mkdtempSync(join(tmpdir(), "row-claim-emergency-yield-"));
after(() => rmSync(SCRATCH, { recursive: true, force: true }));
const PROJECT = join(SCRATCH, "project");
cpSync(fileURLToPath(new URL("./packaging/fixtures/row-claim-file-overlap-rule/project", import.meta.url)), PROJECT, { recursive: true });
const HOST_FILE = join(SCRATCH, "host.json");
process.env.AGENT_ORG_HOST = HOST_FILE;
/** The host declaration with the emergency option ON, OFF, or absent. Read at each call (`hostConfigPath` reads `$AGENT_ORG_HOST` then), so a test sets it. */
function declare(option: "on" | "off" | "absent") {
  const emergencyPriority = option === "absent" ? {} : { emergencyPriority: { enabled: option === "on" } };
  writeFileSync(HOST_FILE, JSON.stringify({ schema: 1, home: SCRATCH, binDir: join(SCRATCH, "bin"), primary: "fixture",
    projects: [{ id: "fixture", checkout: PROJECT }],
    gh: { workers: join(SCRATCH, "workers"), leads: join(SCRATCH, "leads"), leadsHeader: [], leadsWorkspaces: [] }, ...emergencyPriority }));
}
declare("on");
for (const dir of ["packages", "scripts", "docs", ".github", ".claude"]) {
  mkdirSync(join(PROJECT, dir), { recursive: true });
  writeFileSync(join(PROJECT, dir, "tracked"), "");
}
execFileSync("git", ["init", "--quiet"], { cwd: PROJECT, env: sandboxGitEnv() });
execFileSync("git", ["add", "-A"], { cwd: PROJECT, env: sandboxGitEnv() });
process.chdir(PROJECT);

const { sessionEligibility, claimRow } = await import("./row-claim.ts");
const { CHAIRMAN_LOGINS, CHAIRMAN_PRIORITY_LABEL } = await import("./work-gate/vocabulary.ts");
const { EMERGENCY_PRIORITY_LABEL, EMERGENCY_SETTER_LOGINS } = await import("./work-gate/causes/rows-offer.ts");

const TRACKER = "a11ign/a11ign";
const AGENT_ORG = { key: "agent-org", repo: "a11ign/agent-org" };
const CHAIRMAN = CHAIRMAN_LOGINS[0];
const CEO = EMERGENCY_SETTER_LOGINS[0];
const AGENT = "a11ign-ai-workers";
const ASKER = 4764;
const HOLDER = 4738;
const INCIDENT = 889;
const SHARED = "agent-org:src/row-claim.ts";
const TEMPLATE = "\n## Acceptance\n\n```bash\ntrue\n```\n\n## Open-check\n\n```\n$ true\n```\n";
const bodyOf = (...files: string[]) => `## Region\n\n\`\`\`\n${files.join("\n")}\n\`\`\`\n${TEMPLATE}`;
/** A row's body, with the `Incident:` line that names the incident it fixes (or none). */
const emergencyBody = (incident: string | null = `#${INCIDENT}`) => `${bodyOf(SHARED)}${incident === null ? "" : `\nIncident: ${incident}\n`}`;
const OPEN_BLOCKING = { state: "open", labels: ["incident"], body: "Incident: incident:claim-refusal-storm\n" };

type World = {
  /** rows carrying `priority:emergency`: who added it last (`null`: unreadable), and the body */
  emergency?: Record<number, { actor: string | null; body: string; }>;
  /** the tracker's incident items, by number */
  incidents?: Record<number, { state: string; labels: string[]; body: string; }>;
  /** rows carrying `priority:chairman`, by number (the newest labeller is `CHAIRMAN`) */
  labelled?: Record<number, string>;
  claimed?: { number: number; files: string[]; }[];
  prs?: { number: number; path: string; closes?: number; }[];
  blockedBy?: number[];
};

/**
 * The fake code host holding `world` (A11-160, step 7), as `row-claim-chairman-yield.test.ts` holds it, plus the emergency reads: the rows carrying `priority:emergency` with who added it last and their bodies, and
 * the tracker's incident items. The host is watched: `calls` are the operations the claim asked of it, with their requests, in order.
 */
function fakeGh(world: World): WatchedCall[] {
  const host = createFakeCodeHost();
  const w = host.rowsWorld;
  w.repo = TRACKER;
  const labelled = world.labelled ?? {};
  const emergency = world.emergency ?? {};
  const claimed = new Map((world.claimed ?? []).map((row) => [row.number, row]));
  for (const number of new Set([ASKER, ...Object.keys(labelled).map(Number), ...Object.keys(emergency).map(Number), ...claimed.keys()])) {
    const row = claimed.get(number);
    const labels = [...(number === ASKER ? ["ready"] : []), ...(number in labelled ? [CHAIRMAN_PRIORITY_LABEL] : []), ...(number in emergency ? [EMERGENCY_PRIORITY_LABEL] : []), ...(row === undefined ? [] : ["in-progress"])];
    const body = number in emergency ? emergency[number].body : number === ASKER ? bodyOf(SHARED) : row === undefined ? "" : bodyOf(...row.files);
    w.rows.set(number, fakeRow(w, number, { title: "A row", labels, body, blockedBy: number === ASKER ? world.blockedBy ?? [] : [] }));
  }
  for (const [number, actor] of Object.entries(labelled)) {
    w.gate.events.set(Number(number), [{ event: "labeled", label: CHAIRMAN_PRIORITY_LABEL, actor, at: "2026-10-10T08:00:00Z" }]);
  }
  for (const [number, { actor }] of Object.entries(emergency)) {
    const events = w.gate.events.get(Number(number));
    const added = actor === null ? new Error("HTTP 502") : [{ event: "labeled" as const, label: EMERGENCY_PRIORITY_LABEL, actor, at: "2026-10-10T08:00:00Z" }];
    w.gate.events.set(Number(number), added instanceof Error ? added : [...(Array.isArray(events) ? events : []), ...added]);
  }
  for (const [number, item] of Object.entries(world.incidents ?? {})) {
    w.rows.set(Number(number), fakeRow(w, Number(number), { title: "An incident", labels: item.labels, body: item.body, state: item.state === "open" ? "OPEN" : "CLOSED" }));
  }
  w.rules.otherRepos.set(AGENT_ORG.repo, new Map((world.prs ?? []).map((pr) => [pr.number, { number: pr.number, body: pr.closes === undefined ? "" : `Closes ${TRACKER}#${pr.closes}\n`, headRefName: `agent/x-${pr.number}`,
    labels: [], isDraft: false, armed: false, merged: false, mergedAt: null, createdAt: "2026-10-10T08:00:00Z", comments: [], files: [pr.path] }])));
  const watched = watchedRows(host);
  substituteCodeHost(watched.host);
  return watched.calls;
}

/** The claim's `run`: for `git` and the board snapshot, so a `gh` through it is a loud mistake. */
const noGh = (cmd: string): string => { throw new Error(`a claim reached \`${cmd}\` through its run: GitHub is the code host's`); };

afterEach(() => forgetActivation());

const verdict = (world: World, calls?: WatchedCall[][], option: "on" | "off" | "absent" = "on") => {
  declare(option);
  calls?.push(fakeGh(world));
  if (calls === undefined) fakeGh(world);
  return sessionEligibility(ASKER, `worker-${ASKER}`, { repo: TRACKER, repos: [AGENT_ORG] });
};
const readsEmergencyLabel = (calls: WatchedCall[]) => calls.filter((call) => call.op === "readRowsByLabel" && call.request.label === EMERGENCY_PRIORITY_LABEL);
const honoured = (): World => ({ emergency: { [ASKER]: { actor: CEO, body: emergencyBody() } }, incidents: { [INCIDENT]: OPEN_BLOCKING } });

// --- (a) an honoured emergency row yields over a plain claimed row ---------------------------------------------------------------------

test("(a) an emergency row the gate honours, overlapping a plain CLAIMED row, is not refused, and the holder and the incident are named", () => {
  const { reason, walked, emergency } = verdict({ ...honoured(), claimed: [{ number: HOLDER, files: [SHARED] }] });
  assert.equal(reason, null);
  assert.deepEqual(walked, [{ kind: "row", number: HOLDER }]);
  assert.match(emergency ?? "", new RegExp(`#${INCIDENT}$`));
});

test("(a) the control: the SAME emergency row with an actor the gate does not count is refused with today's message", () => {
  const world: World = { emergency: { [ASKER]: { actor: AGENT, body: emergencyBody() } }, incidents: { [INCIDENT]: OPEN_BLOCKING }, claimed: [{ number: HOLDER, files: [SHARED] }] };
  const { reason, walked } = verdict(world);
  assert.match(reason ?? "", new RegExp(`overlaps the Region of #${HOLDER}, a row already claimed`));
  assert.deepEqual(walked, []);
});

test("(a) the control: the SAME emergency row whose incident is CLOSED is refused -- the label is expired, so it buys nothing", () => {
  const world: World = { ...honoured(), incidents: { [INCIDENT]: { ...OPEN_BLOCKING, state: "closed" } }, claimed: [{ number: HOLDER, files: [SHARED] }] };
  assert.match(verdict(world).reason ?? "", new RegExp(`overlaps the Region of #${HOLDER}`));
});

test("(a) the control: an OPEN incident that is not org-blocking buys nothing", () => {
  const world: World = { ...honoured(), incidents: { [INCIDENT]: { state: "open", labels: ["incident"], body: "Incident: incident:unrelated\n" } }, claimed: [{ number: HOLDER, files: [SHARED] }] };
  assert.match(verdict(world).reason ?? "", new RegExp(`overlaps the Region of #${HOLDER}`));
});

test("(a) the control: a row with no `Incident:` line buys nothing", () => {
  const world: World = { emergency: { [ASKER]: { actor: CEO, body: emergencyBody(null) } }, incidents: { [INCIDENT]: OPEN_BLOCKING }, claimed: [{ number: HOLDER, files: [SHARED] }] };
  assert.match(verdict(world).reason ?? "", new RegExp(`overlaps the Region of #${HOLDER}`));
});

test("(a) the control: a history that cannot be read FAILS CLOSED -- the row is refused, not honoured", () => {
  const world: World = { emergency: { [ASKER]: { actor: null, body: emergencyBody() } }, incidents: { [INCIDENT]: OPEN_BLOCKING }, claimed: [{ number: HOLDER, files: [SHARED] }] };
  assert.match(verdict(world).reason ?? "", new RegExp(`overlaps the Region of #${HOLDER}`));
});

test("(a) the control: with `emergencyPriority.enabled` unset, the honoured row is refused exactly as before, and nothing about the label is read", () => {
  const calls: WatchedCall[][] = [];
  const world: World = { ...honoured(), claimed: [{ number: HOLDER, files: [SHARED] }] };
  const { reason, walked } = verdict(world, calls, "absent");
  assert.match(reason ?? "", new RegExp(`overlaps the Region of #${HOLDER}, a row already claimed`));
  assert.deepEqual(walked, []);
  assert.deepEqual(readsEmergencyLabel(calls[0]), [], "an option that is unset reads nothing");
});

test("(a) the control: with `enabled` set to false the honoured row is refused, and nothing about the label is read", () => {
  const calls: WatchedCall[][] = [];
  const { reason } = verdict({ ...honoured(), claimed: [{ number: HOLDER, files: [SHARED] }] }, calls, "off");
  assert.match(reason ?? "", new RegExp(`overlaps the Region of #${HOLDER}`));
  assert.deepEqual(readsEmergencyLabel(calls[0]), []);
});

// --- (b) two priority rows still exclude each other ------------------------------------------------------------------------------------

test("(b) an honoured emergency row overlapping an emergency row that is ALSO honoured is refused, naming it", () => {
  const world: World = { emergency: { [ASKER]: { actor: CEO, body: emergencyBody() }, [HOLDER]: { actor: CEO, body: emergencyBody() } },
    incidents: { [INCIDENT]: OPEN_BLOCKING }, claimed: [{ number: HOLDER, files: [SHARED] }] };
  const { reason, walked } = verdict(world);
  assert.match(reason ?? "", new RegExp(`overlaps the Region of #${HOLDER}`));
  assert.deepEqual(walked, []);
});

test("(b) an honoured emergency row overlapping a claimed CHAIRMAN row is refused, naming it (the two priority rows exclude each other)", () => {
  const world: World = { ...honoured(), labelled: { [HOLDER]: CHAIRMAN }, claimed: [{ number: HOLDER, files: [SHARED] }] };
  assert.match(verdict(world).reason ?? "", new RegExp(`overlaps the Region of #${HOLDER}`));
});

// --- (c) the chairman's row beside it is unchanged -------------------------------------------------------------------------------------

test("(c) a chairman row overlapping a plain claimed row is still not refused with the option ON, and its yield is named as the chairman's", () => {
  const { reason, walked, emergency } = verdict({ labelled: { [ASKER]: CHAIRMAN }, claimed: [{ number: HOLDER, files: [SHARED] }] });
  assert.equal(reason, null);
  assert.deepEqual(walked, [{ kind: "row", number: HOLDER }]);
  assert.equal(emergency, null, "the chairman's yield is not an emergency one");
});

test("(c) a chairman row with the emergency option ON and no emergency row gives the same verdict as with the option absent", () => {
  const world: World = { labelled: { [ASKER]: CHAIRMAN }, claimed: [{ number: HOLDER, files: [SHARED] }] };
  assert.deepEqual(verdict(world, undefined, "on"), verdict(world, undefined, "absent"));
});

// --- (d) the claim itself: the note on the row names the incident --------------------------------------------------------------------

const claimWith = (world: World, calls: WatchedCall[][], option: "on" | "off" | "absent" = "on") => {
  declare(option);
  calls.push(fakeGh(world));
  return claimRow(ASKER, `worker-${ASKER}`, {
    run: noGh as never, moveStatus: () => ({ moved: true }), drained: [], instance: { spare: false, rows: [] }, persistent: false,
    tracker: { key: "", repo: TRACKER },
  } as never);
};
const commentsOn = (calls: WatchedCall[][]) => calls[0].filter((call) => call.op === "postRowComment").map((call) => call.request.body as string);

test("(d) an honoured emergency row's claim goes ahead and leaves a note naming the incident and the holder it walked past", () => {
  const calls: WatchedCall[][] = [];
  const result = claimWith({ ...honoured(), claimed: [{ number: HOLDER, files: [SHARED] }] }, calls) as { claimed: boolean; };
  assert.equal(result.claimed, true);
  const notes = commentsOn(calls).filter((body) => /B4 yielded to an emergency row/.test(body));
  assert.equal(notes.length, 1, "one note, on the row");
  assert.match(notes[0], new RegExp(`row #${HOLDER}`));
  assert.match(notes[0], new RegExp(`#${INCIDENT}`));
});

test("(d) the control: the same claim with the option unset is NOT claimed, and writes no emergency note", () => {
  const calls: WatchedCall[][] = [];
  const result = claimWith({ ...honoured(), claimed: [{ number: HOLDER, files: [SHARED] }] }, calls, "absent") as { claimed: boolean; reason?: string; };
  assert.equal(result.claimed, false);
  assert.match(result.reason ?? "", new RegExp(`overlaps the Region of #${HOLDER}`));
  assert.deepEqual(commentsOn(calls).filter((body) => /B4 yielded/.test(body)), []);
});

test("(d) with no overlap the claim reads no emergency label at all", () => {
  const calls: WatchedCall[][] = [];
  const { reason } = verdict({ ...honoured(), claimed: [{ number: HOLDER, files: ["agent-org:src/elsewhere.ts"] }] }, calls);
  assert.equal(reason, null);
  assert.deepEqual(readsEmergencyLabel(calls[0]), [], "a claim that overlaps nothing asks nothing new");
  const overlapping: WatchedCall[][] = [];
  verdict({ ...honoured(), claimed: [{ number: HOLDER, files: [SHARED] }] }, overlapping);
  assert.ok(readsEmergencyLabel(overlapping[0]).length > 0, "the control: an overlap DOES ask, so the emptiness above is a reading");
});
