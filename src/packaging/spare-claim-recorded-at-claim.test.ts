// no-token: gh -- every `gh` here is a stub on PATH; nothing imported reaches the real one
/**
 * #4387: A SPARE'S CLAIM IS RECORDED WHEN IT IS MADE (#2407). `worker-4069` claimed #4069, released it ninety seconds later and
 * claimed #4274 two minutes after that, and `oneRowReason` did not refuse the second claim: `instanceNow` reads the registry and the
 * open `session:<name>` labels, the registry was written only by a tick, and a row released before the tick left neither.
 *
 * Driven as a PROCESS, in a copy of the tool's own closure as `row-claim-one-row.test.ts` does and for its reason: an injected `instance`
 * is exactly what a deleted `recordHeldRow` goes around. The `gh` is a small stateful stub, so a claim LANDS here (the label it writes is the
 * label the next read sees) and a release is the label going away, which is all `instanceNow` can see of one.
 */
import { TSX_IMPORT } from "../tsx-import.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, chmodSync, readFileSync, readdirSync, copyFileSync, existsSync } from "node:fs";
import { spawnSync, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { sandboxGitEnv } from "../lib/git-env.mjs";
import { sparePathsFrom } from "../wake.ts";
import { HOME_CHECKOUT } from "../project-config.ts";
import { copyToolAndProject, importClosure, toolFile } from "./copied-tool-fixture.ts";

const FIRST = 4069;
const SECOND = 4274;
const REFUSAL = /NOT CLAIMED: one instance, one row: worker-9 holds or has held #4069/;
const ENTRY = fileURLToPath(new URL("../row-claim.ts", import.meta.url));
const SESSIONS_JSON = ".agent-org/roles/sessions.json";

// Rows are `ready` until a write labels them; `issue list` answers the rows labelled with the asking session RIGHT NOW from the same state.
const GH_STUB = `#!/usr/bin/env node
const fs = require("node:fs");
const [, , ...args] = process.argv;
fs.appendFileSync(process.env.GH_STATE + ".log", args.join(" ") + "\\n");
const state = process.env.GH_STATE;
const read = () => (fs.existsSync(state) ? JSON.parse(fs.readFileSync(state, "utf8")) : {});
const labelsOf = (number) => read()[number] ?? ["ready"];
if (args[0] === "issue" && args[1] === "view" && args.join(" ").includes("number,title,labels,state")) {
  process.stdout.write(JSON.stringify({ number: Number(args[2]), title: "A row", state: "OPEN", labels: labelsOf(args[2]).map((name) => ({ name })) }));
} else if (args[0] === "issue" && args[1] === "list") {
  const session = args[args.indexOf("--label") + 1];
  const held = Object.entries(read()).filter(([, labels]) => labels.includes(session)).map(([number]) => ({ number: Number(number) }));
  process.stdout.write(JSON.stringify(held));
} else if (args[0] === "issue" && args[1] === "edit") {
  const next = new Set(labelsOf(args[2]));
  const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1].split(",") : []);
  for (const label of flag("--add-label")) next.add(label);
  for (const label of flag("--remove-label")) next.delete(label);
  fs.writeFileSync(state, JSON.stringify({ ...read(), [args[2]]: [...next] }));
} else if (args[0] === "api" && args.includes("PUT")) {
  // the claiming write replaces the row's labels, which is what makes it atomic
  const number = args.find((a) => /issues\\/\\d+\\/labels$/.test(a)).split("/").at(-2);
  const labels = args.filter((a) => a.startsWith("labels[]=")).map((a) => a.slice("labels[]=".length));
  fs.writeFileSync(state, JSON.stringify({ ...read(), [number]: labels }));
} else if (args[0] === "pr" && args[1] === "list") {
  process.stdout.write("[]");
} else if (args[0] === "label" || (args[0] === "issue" && args[1] === "comment")) {
  // label creates and the claim record comment: written, never read back by this fixture
} else {
  process.exit(1);
}
`;

type Fixture = { dir: string; checkout: string; env: Record<string, string>; entry: string; registry: string };

/** One HOME for the whole life of an instance: the registry and the labels outlive each CLI process, as they do on the host. */
function makeFixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "spare-claim-recorded-"));
  const checkout = join(dir, "checkout");
  const rules = readdirSync(toolFile("src/row-claim")).map((name) => toolFile(`src/row-claim/${name}`));
  const copy = copyToolAndProject(ENTRY, importClosure(ENTRY, rules), checkout);
  mkdirSync(join(checkout, dirname(SESSIONS_JSON)), { recursive: true });
  copyFileSync(join(HOME_CHECKOUT, SESSIONS_JSON), join(checkout, SESSIONS_JSON));
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: checkout, env: sandboxGitEnv(), stdio: "pipe" });
  git("init", "--quiet");
  git("config", "maintenance.auto", "false");
  git("config", "gc.auto", "0");
  git("add", "-A");
  git("commit", "--quiet", "-m", "copy");
  git("update-ref", "refs/remotes/origin/main", "HEAD");
  writeFileSync(join(dir, "gh"), GH_STUB);
  chmodSync(join(dir, "gh"), 0o755);
  mkdirSync(join(dir, ".cache/a11ign"), { recursive: true });
  const registry = sparePathsFrom(join(dir, ".cache/a11ign/wake-ledger")).registry;
  return { dir, checkout, entry: copy.entry, env: copy.env, registry };
}

const teardown = (fixture: Fixture) => rmSync(fixture.dir, { recursive: true, force: true, maxRetries: 5 });

function claim(fixture: Fixture, session: string, row: number) {
  return spawnSync(process.execPath, [...TSX_IMPORT, fixture.entry, "claim", String(row), `--session=${session}`], {
    encoding: "utf8",
    env: { ...sandboxGitEnv(), ...fixture.env, HOME: fixture.dir, GH_STATE: join(fixture.dir, "gh-state.json"),
      PATH: `${fixture.dir}:${process.env.PATH ?? ""}`, A11Y_POLICY_LAUNCH_REASON: "#4387 drives the CLI" },
  });
}

/** The label going away is the whole of a release as far as `instanceNow` can see; the registry is not touched by one. */
function release(fixture: Fixture, session: string, row: number) {
  const state = join(fixture.dir, "gh-state.json");
  const all = JSON.parse(readFileSync(state, "utf8")) as Record<string, string[]>;
  writeFileSync(state, JSON.stringify({ ...all, [row]: ["ready"] }));
  assert.ok(all[row].includes(`session:${session}`), `${session} held #${row} before the release, so the release is of a real claim`);
}

const registered = (fixture: Fixture) => JSON.parse(readFileSync(fixture.registry, "utf8")) as Record<string, { rows: number[] }>;

test("#4387 THE INCIDENT: a spare claims A, releases A and claims B before any tick -- B is refused, naming A", () => {
  const fixture = makeFixture();
  try {
    writeFileSync(fixture.registry, `${JSON.stringify({ "worker-9": { spawnedAt: 1, rows: [] } })}\n`);
    const first = claim(fixture, "worker-9", FIRST);
    assert.doesNotMatch(first.stdout, /NOT CLAIMED/, `the first claim lands; stdout ${first.stdout} stderr ${first.stderr}`);
    release(fixture, "worker-9", FIRST);
    const second = claim(fixture, "worker-9", SECOND);
    assert.match(second.stdout, REFUSAL, `stdout ${second.stdout} stderr ${second.stderr}`);
    assert.equal(second.status, 1);
    assert.deepEqual(registered(fixture)["worker-9"].rows, [FIRST], "the refused claim wrote nothing to the registry");
  } finally {
    teardown(fixture);
  }
});

test("#4387 POSITIVE CONTROLS: a spare with no earlier row claims, and one RESUMING its row claims again without recording it twice", () => {
  const fixture = makeFixture();
  try {
    writeFileSync(fixture.registry, `${JSON.stringify({ "worker-9": { spawnedAt: 1, rows: [] } })}\n`);
    const first = claim(fixture, "worker-9", FIRST);
    assert.doesNotMatch(first.stdout, /NOT CLAIMED/, `no earlier row: nothing to refuse; stdout ${first.stdout} stderr ${first.stderr}`);
    assert.deepEqual(registered(fixture)["worker-9"], { spawnedAt: 1, rows: [FIRST] }, "the claim is on the registry from the first second, spawnedAt untouched");
    const again = claim(fixture, "worker-9", FIRST);
    assert.doesNotMatch(again.stdout, /NOT CLAIMED: one instance/, `resuming its own row is not a second one; stdout ${again.stdout}`);
    assert.deepEqual(registered(fixture)["worker-9"].rows, [FIRST], "a row is recorded once");
  } finally {
    teardown(fixture);
  }
});

test("#4387 POSITIVE CONTROL: a spare no tick has registered yet is recorded too, and a standing engineer is never recorded or refused", () => {
  const fixture = makeFixture();
  try {
    claim(fixture, "worker-9", FIRST);
    assert.deepEqual(registered(fixture)["worker-9"].rows, [FIRST], "a registry with no line for the instance gets one");
    const standing = claim(fixture, "worker-tooling", SECOND);
    assert.doesNotMatch(standing.stdout, /NOT CLAIMED/, `stdout ${standing.stdout} stderr ${standing.stderr}`);
    release(fixture, "worker-tooling", SECOND);
    const next = claim(fixture, "worker-tooling", FIRST + 1);
    assert.doesNotMatch(next.stdout, /NOT CLAIMED: one instance/, "the standing three claim by hand: the roster's spare mark decides");
    assert.equal(registered(fixture)["worker-tooling"], undefined, "a standing engineer is not a registry line");
  } finally {
    teardown(fixture);
  }
});

test("#4387: a registry that cannot be read or written does not stop the claim, and stderr says so", () => {
  const fixture = makeFixture();
  try {
    writeFileSync(fixture.registry, "not json\n");
    const unreadable = claim(fixture, "worker-9", FIRST);
    assert.doesNotMatch(unreadable.stdout, /NOT CLAIMED/, `stdout ${unreadable.stdout} stderr ${unreadable.stderr}`);
    assert.match(unreadable.stderr, new RegExp(`could not record #${FIRST} as a row worker-9 holds`), "an unreadable registry is named");
    assert.equal(readFileSync(fixture.registry, "utf8"), "not json\n", "and left as it was found");

    rmSync(fixture.registry);
    release(fixture, "worker-9", FIRST); // the labels would refuse the second row on their own, and this case is about the registry
    chmodSync(dirname(fixture.registry), 0o555);
    const unwritable = claim(fixture, "worker-9", SECOND);
    chmodSync(dirname(fixture.registry), 0o755);
    assert.doesNotMatch(unwritable.stdout, /NOT CLAIMED/, `stdout ${unwritable.stdout} stderr ${unwritable.stderr}`);
    assert.match(unwritable.stderr, new RegExp(`could not record #${SECOND} as a row worker-9 holds`), "an unwritable one is named");
    assert.equal(existsSync(fixture.registry), false, "nothing was half-written");
  } finally {
    chmodSync(dirname(fixture.registry), 0o755);
    teardown(fixture);
  }
});
