// no-token: gh -- every `gh` call is an injected read, or a stub on PATH that records the call and fails; nothing here reaches the network (a11ign/a11ign#4799)
/**
 * a11ign/a11ign#4799: `row-claim check` PREDICTS THE CHAIRMAN'S YIELD, SO ITS PREDICTION AND THE CLAIM STOP DISAGREEING ON THE ROWS THE CHAIRMAN WANTS STARTED.
 *
 * The defect (found by worker-4793 while building a11ign#4793): the claim lets a `priority:chairman` row past a holder that is not itself a chairman row, and
 * `reportB4` -- which takes its reads by injection and has no tracker history to ask who labelled the row -- printed `B4 REFUSES THIS CLAIM` for exactly that overlap.
 *
 * POSITIVE CONTROLS: every case that asserts the yield is read beside a twin that differs in ONE fact and asserts today's refusal, and (6) drives the claim and
 * `check` over the SAME world, so a `check` taught a rule of its own would disagree with the claim in that table rather than in a sentence.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sandboxGitEnv } from "./lib/git-env.ts";

// THE PROJECT THIS RUNS AGAINST IS A RECORDED ONE, as `row-claim-chairman-yield.test.ts` does it: the host file first, the tool imported after it.
const SCRATCH = mkdtempSync(join(tmpdir(), "row-claim-check-chairman-yield-"));
after(() => rmSync(SCRATCH, { recursive: true, force: true }));
const PROJECT = join(SCRATCH, "project");
cpSync(fileURLToPath(new URL("./packaging/fixtures/row-claim-file-overlap-rule/project", import.meta.url)), PROJECT, { recursive: true });
const HOST_FILE = join(SCRATCH, "host.json");
writeFileSync(HOST_FILE, JSON.stringify({ schema: 1, home: SCRATCH, binDir: join(SCRATCH, "bin"), primary: "fixture",
  projects: [{ id: "fixture", checkout: PROJECT }],
  gh: { workers: join(SCRATCH, "workers"), leads: join(SCRATCH, "leads"), leadsHeader: [], leadsWorkspaces: [] } }));
process.env.AGENT_ORG_HOST = HOST_FILE;
for (const dir of ["packages", "scripts", "docs", ".github", ".claude"]) {
  mkdirSync(join(PROJECT, dir), { recursive: true });
  writeFileSync(join(PROJECT, dir, "tracked"), "");
}
execFileSync("git", ["init", "--quiet"], { cwd: PROJECT, env: sandboxGitEnv() });
execFileSync("git", ["add", "-A"], { cwd: PROJECT, env: sandboxGitEnv() });
process.chdir(PROJECT);

// A `gh` ON PATH that records every call and fails: a `check` whose reads were all injected must never reach it (5), and the control in (5) proves it is reachable.
const STUB_BIN = join(SCRATCH, "stub-bin");
const STUB_LOG = join(SCRATCH, "gh-calls.log");
mkdirSync(STUB_BIN);
writeFileSync(join(STUB_BIN, "gh"), `#!/bin/sh\necho "$@" >> '${STUB_LOG}'\nexit 1\n`);
chmodSync(join(STUB_BIN, "gh"), 0o755);
process.env.PATH = `${STUB_BIN}:${process.env.PATH ?? ""}`;

const { reportB4, sessionEligibility } = await import("./row-claim.ts");
const { lookupOpenPrFiles, lookupClaimedRegions } = await import("./row-claim/file-overlap-rule.ts");
const { CHAIRMAN_LOGINS } = await import("./work-gate.ts");

const TRACKER = "a11ign/a11ign";
const AGENT_ORG = { key: "agent-org", repo: "a11ign/agent-org" };
const CHAIRMAN = CHAIRMAN_LOGINS[0];
const ASKER = 4799;
const HOLDER = 4738;
const SHARED = "agent-org:src/row-claim.ts";
const TEMPLATE = "\n## Acceptance\n\n```bash\ntrue\n```\n\n## Open-check\n\n```\n$ true\n```\n";
const bodyOf = (...files: string[]) => `## Region\n\n\`\`\`\n${files.join("\n")}\n\`\`\`\n${TEMPLATE}`;

type World = {
  /** rows carrying the label, with who added it last (`null`: the history cannot be read) */
  labelled?: Record<number, string | null>;
  claimed?: { number: number; files: string[]; }[];
  prs?: { number: number; path: string; closes?: number; }[];
};

/** The claim's `gh`, as `row-claim-chairman-yield.test.ts` routes it. */
function fakeGh(world: World) {
  return (_cmd: string, args: string[]): string => {
    if (args[0] === "issue" && args[1] === "view") {
      return JSON.stringify({ number: ASKER, title: "A row", body: bodyOf(SHARED), state: "OPEN", labels: [{ name: "ready" }], blockedBy: { nodes: [] } });
    }
    if (args[0] === "issue" && args[1] === "list" && args.includes("priority:chairman")) {
      return JSON.stringify(Object.keys(world.labelled ?? {}).map((number) => ({ number: Number(number), labels: [{ name: "priority:chairman" }] })));
    }
    if (args[0] === "issue" && args[1] === "list" && args.includes("number,labels,body,blockedBy")) {
      return JSON.stringify((world.claimed ?? []).map((row) => ({ number: row.number, labels: [{ name: "in-progress" }], body: bodyOf(...row.files), blockedBy: { nodes: [] } })));
    }
    if (args[0] === "api") {
      const asked = /^repos\/[^/]+\/[^/]+\/issues\/(\d+)\/events$/.exec(args[1] ?? "");
      const actor = asked === null ? undefined : (world.labelled ?? {})[Number(asked[1])];
      if (actor === null || actor === undefined) throw new Error("HTTP 502");
      return `${actor}\n`;
    }
    if (args[0] === "pr" && args[1] === "list") {
      return JSON.stringify(args.includes(AGENT_ORG.repo) ? (world.prs ?? []).map((pr) => ({ number: pr.number, changedFiles: 1, files: [{ path: pr.path }],
        body: pr.closes === undefined ? "" : `Closes ${TRACKER}#${pr.closes}\n` })) : []);
    }
    return "[]";
  };
}

/** What the claim says of the world. */
const claimSays = (world: World) => sessionEligibility(ASKER, `worker-${ASKER}`, { run: fakeGh(world), repo: TRACKER, repos: [AGENT_ORG] });

/** The rows the chairman labelled, as the gate's reading of the history gives them: `null` actor and a stranger's login are not the chairman's. */
const chairmanRowsOf = (world: World): ReadonlySet<number> => new Set(Object.entries(world.labelled ?? {}).filter(([, actor]) => actor === CHAIRMAN).map(([number]) => Number(number)));

/** What `check` says of the same world: the REAL reads of the same `gh`, handed over as the injections `reportB4` takes. `null` hands over no chairman read at all. */
function checkSays(world: World, chairmanRows: ((where?: { repo?: string; }) => ReadonlySet<number> | null) | null = () => chairmanRowsOf(world)): string {
  const gh = (args: string[]) => fakeGh(world)("gh", args);
  const out: string[] = [];
  reportB4(ASKER, {
    write: (text: string) => out.push(text), repo: TRACKER, mine: () => [SHARED],
    others: () => lookupOpenPrFiles({ run: gh, trackerRepo: TRACKER, repos: [AGENT_ORG] }),
    claimed: () => lookupClaimedRegions({ run: gh, repo: TRACKER }), sweeps: () => [],
    ...(chairmanRows === null ? {} : { chairmanRows }),
  });
  return out.join("");
}

const YIELDS = /^B4: yields to the chairman's row \(a11ign#4793\); would walk past /m;
const REFUSES = /B4 REFUSES THIS CLAIM/;
const OVER_ROW = { claimed: [{ number: HOLDER, files: [SHARED] }] };
const OVER_PR = { prs: [{ number: 900, path: "src/row-claim.ts", closes: 4800 }] };

// --- (1) a chairman row over a plain claimed row -------------------------------------------------------------------------------------

test("(1) `check` on a chairman row over a plain CLAIMED row prints the yield line, names the holder, and does NOT print the refusal", () => {
  const said = checkSays({ labelled: { [ASKER]: CHAIRMAN }, ...OVER_ROW });
  assert.match(said, YIELDS);
  assert.match(said, new RegExp(`would walk past row #${HOLDER}\\n$`));
  assert.doesNotMatch(said, REFUSES);
});

test("(1) the control: the SAME overlap on a row nobody labelled prints today's refusal, byte for byte as before the change", () => {
  const said = checkSays({ ...OVER_ROW });
  assert.match(said, new RegExp(`B4 REFUSES THIS CLAIM: overlaps the Region of #${HOLDER}, a row already claimed`));
  assert.doesNotMatch(said, YIELDS);
  assert.equal(said, checkSays({ ...OVER_ROW }, null), "a caller that supplies no chairman read gets the same text as one whose read found no chairman row");
});

// --- (2) a chairman row over a plain open pull request --------------------------------------------------------------------------------

test("(2) `check` on a chairman row over a plain open PULL REQUEST prints the yield line naming the pull request", () => {
  const said = checkSays({ labelled: { [ASKER]: CHAIRMAN }, ...OVER_PR });
  assert.match(said, YIELDS);
  assert.match(said, /would walk past pull request #900 in a11ign\/agent-org/);
  assert.doesNotMatch(said, REFUSES);
});

test("(2) the control: the same pull request refuses a row nobody labelled", () => {
  assert.match(checkSays({ ...OVER_PR }), /B4 REFUSES THIS CLAIM: overlaps #900 in a11ign\/agent-org/);
});

// --- (3) two chairman rows still exclude each other -----------------------------------------------------------------------------------

test("(3) a chairman row over a CHAIRMAN row's claim, or over a pull request closing one, still prints the refusal", () => {
  const both = { [ASKER]: CHAIRMAN, [HOLDER]: CHAIRMAN };
  const overRow = checkSays({ labelled: both, ...OVER_ROW });
  assert.match(overRow, new RegExp(`B4 REFUSES THIS CLAIM: overlaps the Region of #${HOLDER}`));
  assert.doesNotMatch(overRow, YIELDS);
  const overPr = checkSays({ labelled: both, prs: [{ number: 900, path: "src/row-claim.ts", closes: HOLDER }] });
  assert.match(overPr, /B4 REFUSES THIS CLAIM: overlaps #900/);
  assert.doesNotMatch(overPr, YIELDS);
});

// --- (4) the label is the chairman's, and an unreadable history fails closed -----------------------------------------------------------

test("(4) a label somebody else added, and a history that could not be read, both print the refusal", () => {
  const stranger = checkSays({ labelled: { [ASKER]: "a11ign-ai-workers" }, ...OVER_ROW });
  assert.match(stranger, REFUSES);
  const unreadable = checkSays({ labelled: { [ASKER]: CHAIRMAN }, ...OVER_ROW }, () => null);
  assert.match(unreadable, REFUSES);
  assert.doesNotMatch(unreadable, YIELDS);
});

test("(4) a sweep's freeze is not the chairman's to walk past: with a plain pull request ALSO overlapping, the refusal stands and it is the freeze's", () => {
  // The pull request is what makes the control meaningful: without it the freeze is B4's only refusal, and a `check` that ignored the freeze would print today's
  // refusal for want of anything to yield over. With it, the only thing between the row and a false "yields" is the freeze.
  const sweep = { number: 4389, session: "worker-4389", files: ["src/x.ts"], claimedAt: Date.now() - 30 * 60_000, prOpenedAt: null, reported: { stalled: false, overrun: false } };
  const say = (sweeps: () => typeof sweep[]) => {
    const out: string[] = [];
    reportB4(ASKER, { write: (t: string) => out.push(t), repo: TRACKER, mine: () => ["src/x.ts"], others: () => [{ number: 900, files: ["src/x.ts"], changedFiles: 1, closes: [4800] }],
      claimed: () => [], sweeps, chairmanRows: () => new Set([ASKER]) });
    return out.join("");
  };
  const frozen = say(() => [sweep]);
  assert.match(frozen, /B4 REFUSES THIS CLAIM: overlaps the Region of #4389, a declared SWEEP/);
  assert.doesNotMatch(frozen, YIELDS);
  assert.match(say(() => []), YIELDS, "the control: the same world with no sweep claimed DOES yield, over the pull request");
});

// --- (5) `check` reads nothing the caller did not hand it, and asks nothing when there is nothing to refuse ---------------------------

test("(5) with every read injected and no chairman read, `check` never reaches `gh` and prints the refusal -- and the control reaches it", () => {
  const out: string[] = [];
  reportB4(ASKER, { write: (t: string) => out.push(t), repo: TRACKER, mine: () => [SHARED], others: () => [], claimed: () => [{ number: HOLDER, files: [SHARED], blockedBy: [] }], sweeps: () => [] });
  assert.match(out.join(""), REFUSES);
  assert.equal(existsSync(STUB_LOG), false, "nothing reached gh");
  reportB4(ASKER, { write: () => undefined, repo: TRACKER });
  assert.ok(existsSync(STUB_LOG) && readFileSync(STUB_LOG, "utf8").length > 0, "the control: a `check` that injects nothing DOES reach it, so the absence above is a reading");
});

test("(5) the chairman's rows are asked ONLY after a refusal", () => {
  let asked = 0;
  const reader = () => { asked += 1; return new Set([ASKER]); };
  checkSays({ labelled: { [ASKER]: CHAIRMAN }, claimed: [{ number: HOLDER, files: ["agent-org:src/elsewhere.ts"] }] }, reader);
  assert.equal(asked, 0, "no overlap, no question");
  checkSays({ labelled: { [ASKER]: CHAIRMAN }, ...OVER_ROW }, reader);
  assert.equal(asked, 1, "the control: an overlap asks, once");
});

// --- (6) THE PREDICTION IS THE CLAIM ---------------------------------------------------------------------------------------------------

const WORLDS: [string, World][] = [
  ["chairman over a plain claimed row", { labelled: { [ASKER]: CHAIRMAN }, ...OVER_ROW }],
  ["chairman over a plain pull request", { labelled: { [ASKER]: CHAIRMAN }, ...OVER_PR }],
  ["plain row over a claimed row", { ...OVER_ROW }],
  ["plain row over a pull request", { ...OVER_PR }],
  ["two chairman rows, claimed", { labelled: { [ASKER]: CHAIRMAN, [HOLDER]: CHAIRMAN }, ...OVER_ROW }],
  ["two chairman rows, pull request", { labelled: { [ASKER]: CHAIRMAN, [HOLDER]: CHAIRMAN }, prs: [{ number: 900, path: "src/row-claim.ts", closes: HOLDER }] }],
  ["a stranger's label", { labelled: { [ASKER]: "a11ign-ai-workers" }, ...OVER_ROW }],
  ["an unreadable history", { labelled: { [ASKER]: null }, ...OVER_ROW }],
  ["chairman row, nothing overlaps", { labelled: { [ASKER]: CHAIRMAN }, claimed: [{ number: HOLDER, files: ["agent-org:src/elsewhere.ts"] }] }],
  ["chairman over a plain row AND a plain pull request", { labelled: { [ASKER]: CHAIRMAN }, ...OVER_ROW, ...OVER_PR }],
];

test("(6) over the same world, `check` says it yields exactly when the claim lets the row past, and names the holders the claim walks past", () => {
  let yielded = 0;
  for (const [name, world] of WORLDS) {
    const { reason, walked } = claimSays(world);
    const said = checkSays(world);
    assert.equal(YIELDS.test(said), reason === null && walked.length > 0, `${name}: yield line iff the claim walked past a holder`);
    assert.equal(REFUSES.test(said), reason !== null, `${name}: refusal line iff the claim refuses`);
    if (reason === null && walked.length > 0) {
      yielded += 1;
      for (const holder of walked) {
        const named = holder.kind === "row" ? `row #${holder.number}` : `pull request #${holder.number} in ${holder.repo}`;
        assert.ok(said.includes(named), `${name}: names ${named}`);
      }
    }
  }
  assert.equal(yielded, 3, "the control: three of the worlds yield, so the loop above compared something");
});
