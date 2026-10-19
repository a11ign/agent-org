// no-token: productRegionsOf -- the child reads a scratch host.json and productRegionsOf is a pure filter over its lists; no gh call runs
// POSITIVE CONTROL: this file's refusal must fire on the row's own clone before any negative case means anything. The first test below
// asserts the refusal on a `cd` into the built-in clone, and the population assertions carry their own non-empty control.
/**
 * #852: AN ACCEPTANCE THAT `cd`s INTO THE CLONE OF THE REPOSITORY THE ROW IS BUILT IN is refused at filing, as #4322 refuses the primary
 * checkout. A row filed into a second tracker (agent-org's own, which `row-file` files org rows by) has its pull request land in that
 * repository, and its Acceptance runs in that clone's PRIMARY checkout, which carries the change only after the merge.
 *
 * The built-in clone comes from the host's `clones.<key>` for the tracker `rowTracker` picks off the Region. The home tracker has no
 * such clone (its checkout is #4322's), and a host with no declaration cannot tell, so the check is skipped rather than passed.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

import { primaryCheckoutCdReason } from "./acceptance-commands/suite-scripts-for.ts";
import { productRegionsOf } from "./work-gate/causes/rows-offer.ts";
import { sandboxGitEnv } from "./lib/git-env.ts";

const PRIMARY = "/home/agent/repos/a11y-witness";
const KEYED = "/home/agent/repos/agent-org";
const OTHER = "/home/agent/repos/acme-widgets";
const scratch = mkdtempSync(join(tmpdir(), "keyed-cd-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

/** A row body whose Region is `scripts/x.mjs` (an org row when the declaration has no product repository) and whose Acceptance is `lines`. */
function rowBody(lines: string[], extra = ""): string {
  return `## Region\n\n\`\`\`\nscripts/x.mjs\n\`\`\`\n\n## Acceptance\n\n\`\`\`bash\n${lines.join("\n")}\n\`\`\`\n\n${extra}## Open-check\n\nfalse today.\n`;
}

/** A row with no Region section at all, the shape of the Open-check's own row: `rowTracker` reads it as unreadable, so the org tracker. */
function acceptanceOnly(lines: string[]): string {
  return `## Acceptance\n\n\`\`\`bash\n${lines.join("\n")}\n\`\`\`\n\n## Open-check\n\nfalse today.\n`;
}

const CD_KEYED = `cd ${KEYED} && node --import tsx --test src/x.test.ts`;

// POSITIVE CONTROL (a): the refusal fires for the built-in clone, with the clone named and the remedy said. Everything after is a negative
// case, so this is the case that must be able to turn the file red by itself.
test("POSITIVE CONTROL: a `cd` into the built-in (keyed) clone is refused, naming the clone and the remedy", () => {
  const reason = primaryCheckoutCdReason(rowBody([CD_KEYED]), "row-file", { primaryCheckout: PRIMARY, builtInCheckout: KEYED });
  assert.notEqual(reason, null, "the positive control: a refusal must come back for the row's own clone");
  assert.ok((reason ?? "").includes(`(${KEYED})`), "the refusal names the clone");
  assert.ok((reason ?? "").includes(`\`${CD_KEYED}\``), "the refusal names the line");
  assert.match(reason ?? "", /the clone of the repository this row is built in/);
  assert.match(reason ?? "", /Run the command from the worktree root/);
});

test("the built-in refusal also fires for a subdirectory of the clone and for the `bash -c` spelling, as #4322's does", () => {
  const sub = `bash -c 'cd ${KEYED}/packages/x && ls'`;
  assert.notEqual(primaryCheckoutCdReason(rowBody([sub]), "row-file", { primaryCheckout: PRIMARY, builtInCheckout: KEYED }), null);
});

test("a `cd` into ANOTHER repository's checkout is not refused by the built-in check", () => {
  const body = rowBody([`cd ${OTHER} && node --test x.test.ts`]);
  assert.equal(primaryCheckoutCdReason(body, "row-file", { primaryCheckout: PRIMARY, builtInCheckout: KEYED }), null);
});

test("a `Hand-run:` body that cds into the built-in clone is not refused", () => {
  const body = rowBody([CD_KEYED], "Hand-run: the host owner runs it in the tool's clone.\n\n");
  assert.equal(primaryCheckoutCdReason(body, "row-file", { primaryCheckout: PRIMARY, builtInCheckout: KEYED }), null);
});

test("`null` built-in checkout is `cannot tell` (no declaration names a clone): the check is skipped, not passed as a refusal", () => {
  assert.equal(primaryCheckoutCdReason(rowBody([CD_KEYED]), "row-file", { primaryCheckout: PRIMARY, builtInCheckout: null }), null);
});

test("the primary-checkout refusal is unchanged when a built-in clone is also declared: the primary message wins for the primary", () => {
  const reason = primaryCheckoutCdReason(rowBody([`cd ${PRIMARY} && ls`]), "row-file", { primaryCheckout: PRIMARY, builtInCheckout: KEYED });
  assert.match(reason ?? "", /^row-file: REFUSING -- the Acceptance `cd`s into this project's own primary checkout \(/);
});

// The row-file resolution, in a child process: the built-in clone is READ FROM THE HOST AND THE DECLARATION, as `row-file` reads them. The
// host is read once per process, at import, so each variant is its own child.
const HERE = fileURLToPath(new URL(".", import.meta.url));

/** The project declaration with the second tracker: the home tracker (the empty key, first) and agent-org's own. */
const DECLARATION = {
  schema: 1,
  roles: { dir: "roles" },
  tracker: [
    { key: "", repo: "acme/widgets", board: { owner: "acme", number: 1 } },
    { key: "agent-org", repo: "a11ign/agent-org", board: { owner: "a11ign", number: 2 } },
  ],
  code: [{ key: "", repo: "acme/widgets" }],
  units: { prefix: "acme-", boardReportWorkflow: "board.yml", own: [] },
  vocabulary: {
    labels: { backlog: "backlog", needsChairman: "needs:chairman", outOfRelease: "out-of-release", blocked: "blocked" },
    prefixes: { lane: "lane:", session: "session:", answer: "answer:" },
    milestones: { roadToVersionOne: "Road to one", outOfRelease: "Out of release" },
    lanesFile: "lanes.json",
    templateFields: { acceptance: "Acceptance", closes: "Closes", fleet: "Fleet" },
    fleetQuestion: "Does it need the fleet?",
    resources: [],
  },
};

/**
 * Builds the host (a primary project at a scratch checkout, and `clones.agent-org` at a scratch clone unless `declared` is false), takes the
 * row bodies `bodiesFor` makes of those two paths, and runs `primaryCheckoutCdReason` on each in a child, with the host it reads. `git`
 * (default true) makes the checkout a repository, as a host's primary checkout is; `false` is the case that cannot list the Region.
 */
function verdictsUnderHost(bodiesFor: (paths: { checkout: string; clone: string; }) => Record<string, string>, { declared = true, git = true }: { declared?: boolean; git?: boolean; } = {}): { verdicts: Record<string, string | null> | null; status: number | null; stderr: string; } {
  const checkout = mkdtempSync(join(scratch, "checkout-"));
  if (git) assert.equal(spawnSync("git", ["init", "-q", checkout], { env: sandboxGitEnv() }).status, 0, "the fixture checkout");
  mkdirSync(join(checkout, ".agent-org"));
  mkdirSync(join(checkout, "roles"));
  writeFileSync(join(checkout, "roles/sessions.json"), JSON.stringify({ live: [{ name: "ceo" }], retired: [] }));
  writeFileSync(join(checkout, ".agent-org/project.json"), JSON.stringify(DECLARATION));
  const clone = mkdtempSync(join(scratch, "agent-org-clone-"));
  const hostFile = join(scratch, `host-${basename(checkout)}.json`);
  writeFileSync(hostFile, JSON.stringify({
    schema: 1, home: "/home/agent", binDir: "/home/agent/.local/bin", primary: "proj",
    projects: [{ id: "proj", checkout }], gh: { workers: "/home/agent/workers", leads: "/home/agent/leads", leadsHeader: [], leadsWorkspaces: [] },
    ...(declared ? { clones: { "agent-org": clone } } : {}),
  }));
  const bodies = bodiesFor({ checkout, clone });
  const script = `import { primaryCheckoutCdReason as r } from "./acceptance-commands/suite-scripts-for.ts";
    import { builtInCheckoutOf } from "./built-in-checkout.ts";
    const bodies = ${JSON.stringify(bodies)};
    console.log(JSON.stringify(Object.fromEntries(Object.entries(bodies).map(([name, body]) => [name, r(body, "row-file", { builtInCheckout: builtInCheckoutOf(body) })]))));`;
  const run = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: HERE, encoding: "utf8", env: sandboxGitEnv({ AGENT_ORG_HOST: hostFile }),
  });
  // stdout only for the verdicts: git writes its own noise to stderr, and that line is not a verdict.
  const verdicts = run.status === 0 ? JSON.parse(run.stdout.trim().split("\n").pop() ?? "{}") : null;
  return { verdicts, status: run.status, stderr: run.stderr };
}

/** The five row bodies the host-declared cases judge: a keyed org row, the same without a Region, another repository, a Hand-run, and the primary. */
function fiveBodies({ checkout, clone }: { checkout: string; clone: string; }): Record<string, string> {
  return {
    keyedRegion: rowBody([`cd ${clone} && node --test src/x.test.ts`]),
    keyedNoRegion: acceptanceOnly([`cd ${clone} && node --test src/x.test.ts`]),
    other: rowBody([`cd ${OTHER} && node --test src/x.test.ts`]),
    handRun: rowBody([`cd ${clone} && node --test src/x.test.ts`], "Hand-run: the host owner runs it.\n\n"),
    primary: rowBody([`cd ${checkout} && ls`]),
  };
}

/** The verdicts of `fiveBodies` under the host; the child must have run, or the assertion says why. */
function judged(options: { declared?: boolean } = {}): Record<string, string | null> {
  const { verdicts, status, stderr } = verdictsUnderHost(fiveBodies, options);
  assert.equal(status, 0, stderr);
  return verdicts ?? {};
}

test("under a host that names the keyed clone, an org row's Acceptance that cds into it is refused, with the clone named", () => {
  let clone = "";
  const { verdicts, status, stderr } = verdictsUnderHost((paths) => { clone = paths.clone; return fiveBodies(paths); });
  assert.equal(status, 0, stderr);
  assert.notEqual(verdicts?.keyedRegion ?? null, null, "the row's own clone is not refused");
  assert.ok((verdicts?.keyedRegion ?? "").includes(`(${clone})`), "the refusal does not name the clone");
  assert.match(verdicts?.keyedRegion ?? "", /the clone of the repository this row is built in/);
});

test("under the same host, the Open-check's own shape (no Region) that cds into the keyed clone is refused too", () => {
  assert.notEqual(judged().keyedNoRegion ?? null, null, "a row with no Region reads as the org tracker, so its clone is the one refused");
});

test("under the same host, another repository, a Hand-run body and the primary are judged as before: the primary by #4322's message", () => {
  const verdicts = judged();
  assert.equal(verdicts.other, null, "a cd into another repository's checkout was refused");
  assert.equal(verdicts.handRun, null, "a Hand-run body was refused");
  assert.match(verdicts.primary ?? "", /^row-file: REFUSING -- the Acceptance `cd`s into this project's own primary checkout \(/);
});

test("a host that names no clone for the org tracker cannot tell, so the keyed body is not refused", () => {
  const verdicts = judged({ declared: false });
  assert.equal(verdicts.keyedRegion, null);
  assert.equal(verdicts.keyedNoRegion, null);
});

test("a git that cannot list the Region is an error, not `cannot tell`: a checkout that is not a repository does not pass the row", () => {
  const { status, verdicts } = verdictsUnderHost(fiveBodies, { git: false });
  assert.notEqual(status, 0, "the keyed row passed unchecked because the Region could not be read");
  assert.equal(verdicts, null);
});
