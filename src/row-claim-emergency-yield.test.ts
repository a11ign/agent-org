// no-token: gh -- every `gh` call is an injected `run`; nothing here reaches the network (agent-org#989)
/**
 * agent-org#989: THE CLAIM HONOURS THE GATE'S `priority:emergency`, AS IT HONOURS THE CHAIRMAN'S ROW (a11ign#4793).
 *
 * The gate honours a `priority:emergency` row only while `emergencyPriority.enabled` is on, its newest `labeled` event is by a setter, its body names an OPEN
 * org-blocking incident (#5032). B4 at the claim refused such a row over a holder of its files, while the gate offered it. The claim now asks the gate's own
 * `readEmergencyPriority` which rows it honours, and yields to exactly those -- a label the gate ignores gives no yield.
 *
 * POSITIVE CONTROLS: each refusal differs from the claim in ONE fact (the setter, the incident, the option, the link), so none passes by B4 doing nothing.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sandboxGitEnv } from "./lib/git-env.ts";
import { connectionOf, readsRowsByLabel } from "./packaging/rows-by-label-fixtures.ts";

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

/** One `gh`, routed the way `row-claim-chairman-yield.test.ts` routes it, plus the emergency reads. `calls` is every argv it was asked. */
function fakeGh(world: World, calls: string[][] = []) {
  return (_cmd: string, args: string[]): string => {
    calls.push(args);
    if (args[0] === "issue" && args[1] === "view") {
      return JSON.stringify({ number: ASKER, title: "A row", body: bodyOf(SHARED), state: "OPEN", labels: [{ name: "ready" }],
        blockedBy: { nodes: (world.blockedBy ?? []).map((number) => ({ number, state: "OPEN" })) } });
    }
    const byLabel = readsRowsByLabel(args);
    if (byLabel?.label === EMERGENCY_PRIORITY_LABEL) {
      return connectionOf(Object.entries(world.emergency ?? {}).map(([number, row]) => ({ number: Number(number), body: row.body, labels: [{ name: EMERGENCY_PRIORITY_LABEL }] })));
    }
    if (byLabel?.label === CHAIRMAN_PRIORITY_LABEL) {
      return connectionOf(Object.keys(world.labelled ?? {}).map((number) => ({ number: Number(number), labels: [{ name: CHAIRMAN_PRIORITY_LABEL }] })));
    }
    if (byLabel?.label === "in-progress") {
      return connectionOf((world.claimed ?? []).map((row) => ({ number: row.number, labels: [{ name: "in-progress" }], body: bodyOf(...row.files), blockedBy: { nodes: [] } })));
    }
    // agent-org#1302: the asker's labels and state are read over REST
    if (args[0] === "api" && args[1] === `repos/${TRACKER}/issues/${ASKER}`) return JSON.stringify({ number: ASKER, title: "A row", labels: [{ name: "ready" }], state: "open" });
    if (args[0] === "api") return apiAnswer(world, args);
    if (args[0] === "pr" && args[1] === "list") {
      return JSON.stringify(args.includes(AGENT_ORG.repo) ? (world.prs ?? []).map((pr) => ({ number: pr.number, changedFiles: 1, files: [{ path: pr.path }],
        body: pr.closes === undefined ? "" : `Closes ${TRACKER}#${pr.closes}\n` })) : []);
    }
    return "[]";
  };
}

/** The tracker's `issues/<n>/events` (the login that added the label last, or a refusal) and `issues/<n>` (an incident item, or a refusal). */
function apiAnswer(world: World, args: string[]): string {
  const events = /^repos\/([^/]+\/[^/]+)\/issues\/(\d+)\/events$/.exec(args[1] ?? "");
  if (events !== null) {
    assert.equal(events[1], TRACKER, "the placeholder is filled with the TRACKER, never left for `gh` to fill from the working directory");
    const number = Number(events[2]);
    if (args.join(" ").includes(EMERGENCY_PRIORITY_LABEL)) {
      const actor = world.emergency?.[number]?.actor;
      if (actor === null || actor === undefined) throw new Error("HTTP 502");
      return `${actor}\n`;
    }
    const actor = (world.labelled ?? {})[number];
    if (actor === undefined) throw new Error("HTTP 502");
    return `${actor}\n`;
  }
  const item = /^repos\/([^/]+\/[^/]+)\/issues\/(\d+)$/.exec(args[1] ?? "");
  if (item !== null) {
    const found = (world.incidents ?? {})[Number(item[2])];
    if (found === undefined) throw new Error("HTTP 502");
    return JSON.stringify(found);
  }
  return "[]";
}

const verdict = (world: World, calls?: string[][], option: "on" | "off" | "absent" = "on") => {
  declare(option);
  return sessionEligibility(ASKER, `worker-${ASKER}`, { run: fakeGh(world, calls), repo: TRACKER, repos: [AGENT_ORG] });
};
const readsEmergencyLabel = (calls: string[][]) => calls.filter((args) => readsRowsByLabel(args)?.label === EMERGENCY_PRIORITY_LABEL);
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
  const calls: string[][] = [];
  const world: World = { ...honoured(), claimed: [{ number: HOLDER, files: [SHARED] }] };
  const { reason, walked } = verdict(world, calls, "absent");
  assert.match(reason ?? "", new RegExp(`overlaps the Region of #${HOLDER}, a row already claimed`));
  assert.deepEqual(walked, []);
  assert.deepEqual(readsEmergencyLabel(calls), [], "an option that is unset reads nothing");
});

test("(a) the control: with `enabled` set to false the honoured row is refused, and nothing about the label is read", () => {
  const calls: string[][] = [];
  const { reason } = verdict({ ...honoured(), claimed: [{ number: HOLDER, files: [SHARED] }] }, calls, "off");
  assert.match(reason ?? "", new RegExp(`overlaps the Region of #${HOLDER}`));
  assert.deepEqual(readsEmergencyLabel(calls), []);
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

const claimWith = (world: World, calls: string[][], option: "on" | "off" | "absent" = "on") => {
  declare(option);
  return claimRow(ASKER, `worker-${ASKER}`, {
    run: fakeGh(world, calls), moveStatus: () => ({ moved: true }), drained: [], instance: { spare: false, rows: [] }, persistent: false,
    tracker: { key: "", repo: TRACKER },
  } as never);
};
const commentsOn = (calls: string[][]) => calls.filter((args) => args[0] === "issue" && args[1] === "comment").map((args) => args[args.indexOf("--body") + 1]);

test("(d) an honoured emergency row's claim goes ahead and leaves a note naming the incident and the holder it walked past", () => {
  const calls: string[][] = [];
  const result = claimWith({ ...honoured(), claimed: [{ number: HOLDER, files: [SHARED] }] }, calls) as { claimed: boolean; };
  assert.equal(result.claimed, true);
  const notes = commentsOn(calls).filter((body) => /B4 yielded to an emergency row/.test(body));
  assert.equal(notes.length, 1, "one note, on the row");
  assert.match(notes[0], new RegExp(`row #${HOLDER}`));
  assert.match(notes[0], new RegExp(`#${INCIDENT}`));
});

test("(d) the control: the same claim with the option unset is NOT claimed, and writes no emergency note", () => {
  const calls: string[][] = [];
  const result = claimWith({ ...honoured(), claimed: [{ number: HOLDER, files: [SHARED] }] }, calls, "absent") as { claimed: boolean; reason?: string; };
  assert.equal(result.claimed, false);
  assert.match(result.reason ?? "", new RegExp(`overlaps the Region of #${HOLDER}`));
  assert.deepEqual(commentsOn(calls).filter((body) => /B4 yielded/.test(body)), []);
});

test("(d) with no overlap the claim reads no emergency label at all", () => {
  const calls: string[][] = [];
  const { reason } = verdict({ ...honoured(), claimed: [{ number: HOLDER, files: ["agent-org:src/elsewhere.ts"] }] }, calls);
  assert.equal(reason, null);
  assert.deepEqual(readsEmergencyLabel(calls), [], "a claim that overlaps nothing asks nothing new");
  const overlapping: string[][] = [];
  verdict({ ...honoured(), claimed: [{ number: HOLDER, files: [SHARED] }] }, overlapping);
  assert.ok(readsEmergencyLabel(overlapping).length > 0, "the control: an overlap DOES ask, so the emptiness above is a reading");
});
