// no-token: gh -- every `gh` here is a fake first on PATH that keeps its state in a JSON file, and no test lets the real one run.
/**
 * `pr-hold.ts` AND THE GATE'S HOLD-LIFT FOR A PULL REQUEST OF ANY REPOSITORY THE PROJECT DECLARES, #3479.
 *
 * THE INCIDENT (2026-10-04): `a11ign/agent-org` #149 and #150 had to wait for #148, and the remedy that clears itself, a hold, did not exist for them. `pr-hold.ts`
 * built every `gh` call from the first repository, so `pr:hold 149` held `a11ign/a11ign#149`; `ceo` created `hold:ceo` in `agent-org` and wrote the marker comment
 * by hand, and the gate, which refused any keyed pull request, would have ordered `ceo` to remove it again once #148 merged.
 *
 * THE POSITIVE CONTROLS are the non-empty cases every refusal below is read against: a take and a release that DO land on `a11ign/agent-org` (and, in the same
 * run, leave the same-numbered pull request of `a11ign/a11ign` untouched), and a keyed lift that DOES release. Without them every "nothing was written"
 * would pass for a command that writes nothing anywhere. The CLI half runs against a fixture project so its declared keys are exact; the lift half reads the
 * host's declaration like its sibling `gate-lifts-resolved-holds.test.ts`, and asserts first that it declares `agent-org`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { WAIT_MARKER, waitItemOf, staleWaits, liftableHolds, referencesOf } from "../wait-condition.ts";
import { homeProjectDeclaration, HOME_CHECKOUT, PROJECT_DECLARATION_PATH } from "../project-config.ts";
import { liftResolvedHolds, readRefFacts, releaseHoldViaModule } from "../work-gate/org-health.mjs";

const EXECUTABLE = 0o755;
const FIRST = "a11ign/a11ign";
const KEYED = "a11ign/agent-org";
const CLI = fileURLToPath(new URL("../pr-hold.ts", import.meta.url));
const PR = "149";

// --- the CLI, against a fake `gh` that keeps one pull request PER REPOSITORY under the same number ---------------------------------

type FakePr = { labels: string[]; comments: string[]; armed: boolean };
type FakeState = { repos: Record<string, { prs: Record<string, FakePr> }>; calls: string[][] };

/** Answers `pr-hold.ts`'s calls for the repository `--repo` names, or the first's when a call carries none (a real `gh` would use the working directory's). */
const FAKE_GH = `#!/usr/bin/env node
const fs = require("node:fs");
const file = process.env.FAKE_GH_STATE;
const state = JSON.parse(fs.readFileSync(file, "utf8"));
const args = process.argv.slice(2);
const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
state.calls.push(args);
const save = () => fs.writeFileSync(file, JSON.stringify(state));
const pr = (state.repos[flag("--repo") ?? "${FIRST}"] ?? { prs: {} }).prs[args.find((a) => /^\\d+$/.test(a))];
if (!pr) { save(); process.stderr.write("fake gh: no such pull request: " + args.join(" ")); process.exit(1); }
const json = flag("--json");
if (args[0] === "pr" && args[1] === "view") {
  process.stdout.write(JSON.stringify(json === "labels" ? { labels: pr.labels.map((name) => ({ name })) }
    : json === "comments" ? { comments: pr.comments.map((body) => ({ body })) }
    : { autoMergeRequest: pr.armed ? { enabledAt: "now" } : null, state: "OPEN" }));
} else if (args[0] === "pr" && args[1] === "edit") {
  if (args.includes("--remove-label")) pr.labels = pr.labels.filter((l) => l !== flag("--remove-label"));
  if (args.includes("--add-label")) pr.labels.push(flag("--add-label"));
} else if (args[0] === "pr" && args[1] === "comment") {
  pr.comments.push(flag("--body"));
} else if (args[0] === "pr" && args[1] === "merge") {
  pr.armed = args.includes("--auto");
} else { save(); process.stderr.write("fake gh: unexpected " + args.join(" ")); process.exit(1); }
save();
`;

/**
 * A project declaring the first repository and `agent-org`, so a key the refusals try (`nowhere`) is genuinely undeclared. It is the host's own declaration
 * with `tracker` and `code` replaced: the rest (the vocabulary, the leak patterns) is what every module reads at import and is not what this test is about.
 */
function fixtureProject(dir: string): string {
  mkdirSync(join(dir, ".agent-org"), { recursive: true });
  const own = JSON.parse(readFileSync(join(HOME_CHECKOUT, PROJECT_DECLARATION_PATH), "utf8")) as Record<string, unknown>;
  writeFileSync(join(dir, PROJECT_DECLARATION_PATH), JSON.stringify({ ...own, tracker: [{ key: "", repo: FIRST, board: { owner: "a11ign", number: 1 } }],
    code: [{ key: "", repo: FIRST }, { key: "agent-org", repo: KEYED }] }));
  const host = join(dir, ".agent-org", "host.json");
  writeFileSync(host, JSON.stringify({ schema: 1, home: dir, binDir: dir, primary: "fx", tool: dir, projects: [{ id: "fx", checkout: dir }] }));
  return host;
}

const heldPr = (): FakePr => ({ labels: ["hold:ceo", "rearm-on-release"], comments: [], armed: false });
const BOTH_HELD = (): FakeState["repos"] => ({ [FIRST]: { prs: { [PR]: heldPr() } }, [KEYED]: { prs: { [PR]: heldPr() } } });
const BOTH_FREE = (): FakeState["repos"] => ({ [FIRST]: { prs: { [PR]: { labels: [], comments: [], armed: true } } }, [KEYED]: { prs: { [PR]: { labels: [], comments: [], armed: true } } } });

/** Runs `pr-hold.ts` with the fake first on PATH, and returns what it said and what the fake's repositories hold afterwards. */
function hold(repos: FakeState["repos"], ...argv: string[]) {
  const dir = mkdtempSync(join(tmpdir(), "pr-hold-3479-"));
  try {
    const state = join(dir, "state.json");
    writeFileSync(state, JSON.stringify({ repos, calls: [] }));
    writeFileSync(join(dir, "gh"), FAKE_GH);
    chmodSync(join(dir, "gh"), EXECUTABLE);
    const result = spawnSync(process.execPath, [CLI, ...argv], { encoding: "utf8",
      env: { PATH: `${dir}:${process.env.PATH ?? ""}`, HOME: dir, FAKE_GH_STATE: state, AGENT_ORG_HOST: fixtureProject(dir) } });
    const after = JSON.parse(readFileSync(state, "utf8")) as FakeState;
    return { status: result.status, stdout: result.stdout, stderr: result.stderr, repos: after.repos, calls: after.calls.map((c) => c.join(" ")) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const UNTIL = "merged a11ign/agent-org#148";
const markerBody = (until: string) => `${WAIT_MARKER}\nHeld by \`ceo\`.\nWaiting-for: ${until}`;

test("POSITIVE CONTROL (1) TAKE: `--repo-key=agent-org` writes the label and the marker on `a11ign/agent-org`, on no other repository, and every call is aimed there", () => {
  const taken = hold(BOTH_FREE(), PR, "--repo-key=agent-org", "--session=ceo", `--until=${UNTIL}`);
  assert.equal(taken.status, 0, `${taken.stderr}\n${taken.calls.join("\n")}`);
  assert.deepEqual(taken.repos[KEYED].prs[PR].labels, ["hold:ceo", "rearm-on-release"], "the hold, and the mark that makes the release re-arm what the take disarmed");
  assert.deepEqual(taken.repos[KEYED].prs[PR].comments, [markerBody(UNTIL)], "the marker, in the exact shape the gate reads");
  assert.equal(taken.repos[KEYED].prs[PR].armed, false, "the take disarmed THAT pull request");
  assert.deepEqual(taken.repos[FIRST].prs[PR], { labels: [], comments: [], armed: true }, "the same number in the first repository is exactly as it was");
  assert.match(taken.stdout, /agent-org#149 is now held by ceo/, "the message names the repository's pull request, not `#149`");
  assert.ok(taken.calls.length >= 8, "the read-back, the marker and the disarm all ran");
  assert.deepEqual(taken.calls.filter((c) => !c.includes(`--repo ${KEYED}`)), [], "no call falls back to the first repository, the merge and the auto-merge read included");
});

test("`owner/repo#n` names the same pull request as the key, and a report with no session reads the keyed one", () => {
  const taken = hold(BOTH_FREE(), `${KEYED}#${PR}`, "--session=ceo");
  assert.equal(taken.status, 0, taken.stderr);
  assert.deepEqual(taken.repos[KEYED].prs[PR].labels, ["hold:ceo", "rearm-on-release"]);
  assert.deepEqual(taken.repos[FIRST].prs[PR].labels, []);
  const report = hold(BOTH_HELD(), "--repo-key=agent-org", PR);
  assert.equal(report.stdout, "agent-org#149 is held by ceo.\n");
  assert.equal(report.calls.length, 1, "a report writes nothing");
});

test("(2) THE FIRST REPOSITORY IS UNCHANGED: no key writes on `a11ign/a11ign` with exactly the calls it made before", () => {
  const expected = [
    `pr view ${PR} --repo ${FIRST} --json labels`,
    `pr edit ${PR} --repo ${FIRST} --add-label hold:ceo`,
    `pr view ${PR} --repo ${FIRST} --json labels`,
    `pr comment ${PR} --repo ${FIRST} --body ${markerBody("closed #148")}`,
    `pr view ${PR} --repo ${FIRST} --json comments`,
    `pr view ${PR} --repo ${FIRST} --json autoMergeRequest,state`,
    `pr merge --disable-auto ${PR}`,
    `pr view ${PR} --json autoMergeRequest`,
    `pr edit ${PR} --repo ${FIRST} --add-label rearm-on-release`,
    `pr view ${PR} --repo ${FIRST} --json labels`,
  ];
  const taken = hold(BOTH_FREE(), PR, "--session=ceo", "--until=closed #148");
  assert.equal(taken.status, 0, taken.stderr);
  assert.deepEqual(taken.calls, expected);
  assert.deepEqual(taken.repos[FIRST].prs[PR].labels, ["hold:ceo", "rearm-on-release"]);
  assert.deepEqual(taken.repos[KEYED].prs[PR], { labels: [], comments: [], armed: true }, "and the keyed repository is untouched");
  assert.match(taken.stdout, /^#149: it was unheld$/m, "a first-repository message still says `#149`");
});

test("(2) the empty key IS the first repository: `--repo-key=` makes exactly the calls no key makes", () => {
  const plain = hold(BOTH_FREE(), PR, "--session=ceo", "--until=closed #148");
  const spelled = hold(BOTH_FREE(), PR, "--repo-key=", "--session=ceo", "--until=closed #148");
  assert.equal(spelled.status, 0, spelled.stderr);
  assert.deepEqual(spelled.calls, plain.calls);
});

test("(3) REFUSAL: a key or a repository the project does not declare is refused naming the declared ones, with nothing written and no `gh` run", () => {
  const refusals: [string, string[]][] = [
    ["a key", [PR, "--repo-key=nowhere", "--session=ceo"]],
    ["an `owner/repo#n` form", ["someone/else#149", "--session=ceo"]],
    ["a key and a repository that are two repositories", [`${FIRST}#${PR}`, "--repo-key=agent-org", "--session=ceo"]],
  ];
  const control = hold(BOTH_FREE(), PR, "--repo-key=agent-org", "--session=ceo");
  assert.equal(control.status, 0, "the same line with a declared key writes, so the refusals below are not a command that cannot write");
  for (const [name, argv] of refusals) {
    const refused = hold(BOTH_FREE(), ...argv);
    assert.equal(refused.status, 2, `${name}: ${refused.stdout}${refused.stderr}`);
    assert.match(refused.stderr, /REFUSING/, name);
    assert.deepEqual(refused.calls, [], `${name}: nothing was asked of GitHub`);
    assert.deepEqual(refused.repos, BOTH_FREE(), `${name}: nothing was written`);
  }
  const unknown = hold(BOTH_FREE(), PR, "--repo-key=nowhere", "--session=ceo");
  assert.match(unknown.stderr, /Declared: \(none: the first\) = a11ign\/a11ign, agent-org = a11ign\/agent-org\./, "it names the declared keys");
});

test("(4) RELEASE with the key removes the label and re-arms in `a11ign/agent-org` only", () => {
  const released = hold(BOTH_HELD(), PR, "--repo-key=agent-org", "--session=ceo", "--release");
  assert.equal(released.status, 0, `${released.stderr}\n${released.calls.join("\n")}`);
  assert.deepEqual(released.repos[KEYED].prs[PR], { labels: [], comments: [], armed: true }, "released, re-armed, and the mark spent");
  assert.deepEqual(released.repos[FIRST].prs[PR], heldPr(), "the first repository's pull request keeps its hold and its mark");
  assert.deepEqual(released.calls.filter((c) => !c.includes(`--repo ${KEYED}`)), [], "the re-arm's merge and read-back are aimed too");
  assert.ok(released.calls.some((c) => c.startsWith("pr merge --auto --merge")), "and the re-arm ran, so the line above is not vacuous");
});

// --- the gate's lift ------------------------------------------------------------------------------------------------------------

const HOUR_MS = 3_600_000;
const NOW = Date.parse("2026-10-04T16:00:00Z");
type Fact = { state: "open" | "closed" | "merged"; labels: string[]; resolvedAt: number | null; changedAt: number | null };
const resolved = (state: "closed" | "merged"): Fact => ({ state, labels: [], resolvedAt: NOW - HOUR_MS, changedAt: NOW - HOUR_MS });
const OPEN: Fact = { state: "open", labels: [], resolvedAt: null, changedAt: NOW - HOUR_MS };

/** A held pull request of `agent-org`, as the gate tags it, declaring `waits` in its hold marker. */
function keyedPr(labels: string[], waits: string[], extra: Record<string, unknown> = {}) {
  return { number: 149, repoKey: "agent-org", repo: KEYED, labels: labels.map((name) => ({ name })), body: "", updatedAt: new Date(NOW - 2 * HOUR_MS).toISOString(),
    comments: waits.length ? [{ createdAt: new Date(NOW - 3 * HOUR_MS).toISOString(), body: `${WAIT_MARKER}\nHeld by \`ceo\`.\n${waits.map((w) => `Waiting-for: ${w}`).join("\n")}` }] : [],
    ...extra };
}

/** What the gate lifts over `raw`, recording each release with the key it was given. */
function lift(raw: Record<string, unknown>, facts: Record<string, Fact>, { ok = true }: { ok?: boolean } = {}) {
  const asked: [number, string, string | undefined][] = [];
  const said: string[] = [];
  const stale = staleWaits({ items: [waitItemOf(raw, "pr")], facts: { items: facts }, now: NOW });
  const remaining = liftResolvedHolds(stale, { now: NOW, release: (n: number, s: string, key?: string) => { asked.push([n, s, key]); return ok; }, log: (l: string) => said.push(l) });
  return { asked, said, remaining, stale };
}

test("the host's declaration declares `agent-org`, which the lift tests below are read against", () => {
  assert.ok(homeProjectDeclaration().code.some((entry) => entry.key === "agent-org" && entry.repo === KEYED), "set AGENT_ORG_HOST to a host whose project declares `agent-org`");
});

test("POSITIVE CONTROL (5) THE GATE'S LIFT: a keyed pull request holding `hold:ceo` whose `merged a11ign/agent-org#148` is MERGED is lifted, and the release is given the KEY", () => {
  const { asked, said, remaining, stale } = lift(keyedPr(["hold:ceo"], [UNTIL]), { "a11ign/agent-org#148": resolved("merged") });
  assert.equal(stale.length, 1, "the wait is stale, so what follows is the lift's decision");
  assert.deepEqual(asked, [[149, "ceo", "agent-org"]]);
  assert.deepEqual(remaining, [], "no session is ordered to remove the label");
  assert.match(said.join(""), /DID lift-hold pr-agent-org#149 \(ceo\)/);
});

test("a first-repository lift is still released with NO key, and a failed keyed release falls back to the setter's order", () => {
  const first = lift({ ...keyedPr(["hold:ceo"], ["closed #3220"]), repoKey: undefined, repo: undefined }, { "#3220": resolved("closed") });
  assert.deepEqual(first.asked, [[149, "ceo", undefined]]);
  const failed = lift(keyedPr(["hold:ceo"], [UNTIL]), { "a11ign/agent-org#148": resolved("merged") }, { ok: false });
  assert.equal(failed.remaining.length, 1);
  assert.equal(failed.said.join(""), "", "no DID line for a lift that did not happen");
});

const NEGATIVES: { name: string; raw: Record<string, unknown>; facts: Record<string, Fact> }[] = [
  { name: "`merged` on a referent that closed UNMERGED", raw: keyedPr(["hold:ceo"], [UNTIL]), facts: { "a11ign/agent-org#148": resolved("closed") } },
  { name: "a referent still open", raw: keyedPr(["hold:ceo"], [UNTIL]), facts: { "a11ign/agent-org#148": OPEN } },
  { name: "a label condition", raw: keyedPr(["hold:ceo"], ["unlabelled needs:chairman a11ign/agent-org#7"]), facts: { "a11ign/agent-org#7": OPEN } },
  { name: "`Waiting-for: manual`", raw: keyedPr(["hold:ceo"], ["manual"]), facts: {} },
  { name: "an `answer:*` label whose condition is true", raw: keyedPr(["answer:ceo"], [UNTIL]), facts: { "a11ign/agent-org#148": resolved("merged") } },
  { name: "a pull request of a repository the project does NOT declare", raw: keyedPr(["hold:ceo"], [UNTIL], { repoKey: "nowhere", repo: "a11ign/nowhere" }), facts: { "a11ign/agent-org#148": resolved("merged") } },
];

for (const { name, raw, facts } of NEGATIVES) {
  test(`(6) NEGATIVE CONTROL, no lift: ${name}`, () => {
    const { asked, remaining, stale } = lift(raw, facts);
    assert.deepEqual(asked, [], "the gate released nothing");
    assert.equal(remaining.length, stale.length, "every stale wait there is still goes to a session");
  });
}

test("`liftableHolds` lifts a keyed item only for a key it is told is declared", () => {
  const stale = staleWaits({ items: [waitItemOf(keyedPr(["hold:ceo"], [UNTIL]), "pr")], facts: { items: { "a11ign/agent-org#148": resolved("merged") } }, now: NOW });
  assert.equal(liftableHolds(stale, NOW, new Set(["agent-org"])).lifts.length, 1);
  assert.equal(liftableHolds(stale, NOW).lifts.length, 0, "with no declared keys it is the old behaviour");
  assert.equal(liftableHolds(stale, NOW, new Set(["documents"])).lifts.length, 0, "another repository's key declares nothing for this one");
});

test("(7) A BARE `#148` ON A KEYED PULL REQUEST IS `agent-org#148`, and a cross-repository reference resolves against THAT repository's facts, never the first's", () => {
  const bare = keyedPr(["hold:ceo"], ["merged #148"]);
  const merged = { "#148": OPEN, "a11ign/agent-org#148": resolved("merged") };
  assert.deepEqual(lift(bare, merged).asked, [[149, "ceo", "agent-org"]], "agent-org#148 merged, the first repository's #148 open: lifted");
  const open = { "#148": resolved("merged"), "a11ign/agent-org#148": OPEN };
  assert.deepEqual(lift(bare, open).asked, [], "the first repository's #148 merged and agent-org#148 open: NOT lifted, which is the answer a first-repository read would have got wrong");
  assert.deepEqual(referencesOf([waitItemOf(bare, "pr")]).map((r) => r.key), ["a11ign/agent-org#148"], "and that is the reference the gate reads");
  const first = lift({ ...bare, repoKey: undefined, repo: undefined }, { "#148": resolved("merged") });
  assert.deepEqual(first.asked, [[149, "ceo", undefined]], "while a first-repository item's bare reference is still `#148`");
});

test("an open pull request of `agent-org` does not answer for the first repository's same-numbered reference", () => {
  const items = [waitItemOf({ number: 3000, labels: [{ name: "hold:ceo" }], comments: [], body: "Waiting-for: closed #148" }, "pr")];
  const open = [{ number: 148, repoKey: "agent-org", repo: KEYED, labels: [], updatedAt: new Date(NOW).toISOString() }];
  const asked: string[] = [];
  const run = (args: string[]) => {
    asked.push(args[1]);
    return JSON.stringify({ state: "closed", closed_at: new Date(NOW).toISOString(), updated_at: new Date(NOW).toISOString(), merged_at: null, labels: [] });
  };
  const facts = readRefFacts({ refs: referencesOf(items), open, run });
  assert.deepEqual(asked, [`repos/${homeProjectDeclaration().repo}/issues/148`], "the first repository's #148 is READ, not taken from the open list's agent-org#148");
  assert.equal(facts.items["#148"].state, "closed");
  const held = readRefFacts({ refs: [{ key: `${KEYED}#148`, repo: KEYED, number: 148 }], open, run: () => { throw new Error("read"); } });
  assert.equal(held.items[`${KEYED}#148`].state, "open", "and a keyed reference IS answered from the open list under its own key");
});

test("THROUGH THE REAL RELEASE: `releaseHoldViaModule` given the key releases and re-arms `a11ign/agent-org`'s pull request and not the first's", () => {
  const dir = mkdtempSync(join(tmpdir(), "pr-hold-3479-lift-"));
  const previous = { PATH: process.env.PATH, FAKE_GH_STATE: process.env.FAKE_GH_STATE };
  try {
    const state = join(dir, "state.json");
    writeFileSync(state, JSON.stringify({ repos: BOTH_HELD(), calls: [] }));
    writeFileSync(join(dir, "gh"), FAKE_GH);
    chmodSync(join(dir, "gh"), EXECUTABLE);
    process.env.PATH = `${dir}:${process.env.PATH}`;
    process.env.FAKE_GH_STATE = state;
    assert.equal(releaseHoldViaModule(Number(PR), "ceo", "agent-org"), true);
    const after = JSON.parse(readFileSync(state, "utf8")) as FakeState;
    assert.deepEqual(after.repos[KEYED].prs[PR], { labels: [], comments: [], armed: true });
    assert.deepEqual(after.repos[FIRST].prs[PR], heldPr(), "the first repository's pull request of the same number is untouched");
    assert.ok(existsSync(state));
  } finally {
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    rmSync(dir, { recursive: true, force: true });
  }
});
