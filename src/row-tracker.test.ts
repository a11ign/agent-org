// no-token: none
//
// #4078: which tracker a row belongs in. `rowTracker` is PURE, so every case states its own declaration: a function that quietly read
// the host's declaration would answer the host's trackers whatever these say, and the cases below would not agree with it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ORG_TRACKER_REPO, rowTracker, trackerNamed } from "./row-tracker.ts";
import { productRegionsOf, rowKind } from "./work-gate/causes/rows-offer.ts";
import { workGateSource } from "./lib/work-gate-source.ts";

const HOME = { key: "", repo: "example/product", board: { owner: "example", number: 1 } };
const ORG = { key: "agent-org", repo: "a11ign/agent-org", board: { owner: "example", number: 9 } };
const TWO = [HOME, ORG];

/** A declaration that is NOT a11ign's, so a hidden read of the host's would disagree with it. */
const DECLARATION = {
  code: [{ key: "", repo: "example/product" }, { key: "agent-org", repo: "a11ign/agent-org" }, { key: "worker", repo: "example/worker" }, { key: "control", repo: "example/control" }],
  dora: [
    { repo: "example/product", release: { kind: "tag" }, releasablePaths: ["packages/cli/"] },
    { repo: "a11ign/agent-org", release: { kind: "tag" }, releasablePaths: ["src/"] },
    { repo: "example/worker", release: { kind: "tag" }, releasablePaths: ["packages/nvda/"] },
    { repo: "example/control", release: { kind: "tag" }, releasablePaths: ["ansible/"], adopterFacing: false },
  ],
};

const keyOf = (entries: any, trackers = TWO) => rowTracker(entries, DECLARATION, trackers).tracker.key;

test("#4078: a Region with ONE entry under a product repository's releasable path files in the product tracker, even beside agent-org paths", () => {
  assert.equal(keyOf(["packages/cli/src/index.ts"]), "");
  assert.equal(keyOf(["agent-org:src/row-file.ts", "packages/cli/src/index.ts"]), "", "the other entries are agent-org's and the one product entry decides");
  assert.equal(keyOf(["agent-org:src/row-file.ts", "worker:packages/nvda/x.mjs"]), "", "a KEYED product repository counts as well as the bare one");
  assert.equal(rowTracker(["packages/cli/src/index.ts"], DECLARATION, TWO).unreadable, false);
});

test("#4078: a Region of only agent-org paths files in the agent-org tracker", () => {
  const { tracker, unreadable } = rowTracker(["agent-org:src/row-tracker.ts", "agent-org:src/row-file.ts"], DECLARATION, TWO);
  assert.equal(tracker, ORG);
  assert.equal(unreadable, false);
});

test("#4078: a path in a product repository that is NOT releasable is an org row, as #3820's rule has it", () => {
  assert.equal(keyOf(["docs/runbook.md"]), "agent-org", "a BARE path is not read as the home repository's, so it files as it did");
  for (const entries of [["docs/runbook.md"], ["worker:docs/x.md"]]) {
    assert.equal(rowKind(entries, productRegionsOf(DECLARATION)).kind, "org", `${entries[0]}: the share's reading is #3820's and is not this file's to change`);
  }
});

test("#773: a Region of only a control repository's paths (a declared code repository that is not the tool's) files in the home tracker", () => {
  for (const entries of [["control:ansible/patch.yml"], ["control:ansible/patch.yml", "control:docs/x.md"], ["worker:docs/x.md"], ["control:ansible/patch.yml", "worker:docs/x.md"]]) {
    const { tracker, unreadable } = rowTracker(entries, DECLARATION, TWO);
    assert.equal(tracker, HOME, JSON.stringify(entries));
    assert.equal(unreadable, false, JSON.stringify(entries));
  }
  assert.equal(rowKind(["control:ansible/patch.yml"], productRegionsOf(DECLARATION)).kind, "org", "rowKind is left alone: the row is org by the share's rule and home by the tracker's");
});

test("#773: a Region that names the tool's own paths, any bare path or a key nothing declares is not a control repository's, so it files as it did", () => {
  assert.equal(keyOf(["agent-org:src/row-tracker.ts"]), "agent-org", "the tool's own key");
  assert.equal(keyOf(["control:ansible/patch.yml", "agent-org:src/row-tracker.ts"]), "agent-org", "a mix with the tool's paths");
  assert.equal(keyOf(["control:ansible/patch.yml", "docs/runbook.md"]), "agent-org", "a mix with a bare path, which is not counted");
  assert.equal(keyOf(["docs/runbook.md"]), "agent-org", "a bare path alone");
  assert.equal(keyOf(["lab:scripts/x.sh"]), "agent-org", "a key the declaration does not name");
  assert.equal(keyOf(["control:ansible/patch.yml", "lab:scripts/x.sh"]), "agent-org", "one entry whose key is undeclared spoils it");
});

test("#773: an empty Region is still the org tracker's and still unreadable, beside a control repository's rows", () => {
  for (const entries of [[], null]) {
    const { tracker, unreadable } = rowTracker(entries, DECLARATION, TWO);
    assert.equal(tracker, ORG, JSON.stringify(entries));
    assert.equal(unreadable, true, JSON.stringify(entries));
  }
});

test("#773: a control repository's row with ONE declared tracker, and a product entry beside it, both give the home tracker", () => {
  assert.equal(rowTracker(["control:ansible/patch.yml"], DECLARATION, [HOME]).tracker, HOME);
  assert.equal(keyOf(["control:ansible/patch.yml", "packages/cli/src/index.ts"]), "", "a product entry decides, as before");
});

test("#4078: an empty or absent Region files in the agent-org tracker AND says it could not be read", () => {
  for (const entries of [[], null]) {
    const { tracker, unreadable } = rowTracker(entries, DECLARATION, TWO);
    assert.equal(tracker, ORG, JSON.stringify(entries));
    assert.equal(unreadable, true, JSON.stringify(entries));
  }
});

test("#4078: with ONE declared tracker every Region gives that tracker, so the change is nothing until a second is declared", () => {
  for (const entries of [["packages/cli/src/index.ts"], ["agent-org:src/x.mjs"], ["docs/x.md"], [], null]) {
    assert.equal(rowTracker(entries, DECLARATION, [HOME]).tracker, HOME, JSON.stringify(entries));
  }
  assert.equal(rowTracker([], DECLARATION, [HOME]).unreadable, true, "the reading is still reported; whether to SAY it is the caller's, who has no choice to describe");
});

test("#4078: two trackers and none of them agent-org's: an org row goes to the first, and nothing is guessed", () => {
  const other = { key: "second", repo: "example/other", board: { owner: "example", number: 2 } };
  assert.equal(rowTracker(["agent-org:src/x.mjs"], DECLARATION, [HOME, other]).tracker, HOME);
});

test("#4078: no tracker at all is refused rather than answered with nothing", () => {
  assert.throws(() => rowTracker(["packages/cli/x.ts"], DECLARATION, []), /names no tracker/);
});

test("#4078: it is pure -- the same arguments give the same answer and none of them is changed", () => {
  const entries = ["agent-org:src/x.mjs", "packages/cli/x.ts"];
  const frozen = structuredClone({ entries, DECLARATION, TWO });
  assert.deepEqual(rowTracker(entries, DECLARATION, TWO), rowTracker(entries, DECLARATION, TWO));
  assert.deepEqual({ entries, DECLARATION, TWO }, frozen);
});

test("#4078: `--tracker=<key>` names a declared tracker, the home one by the empty key", () => {
  assert.deepEqual(trackerNamed(TWO, "agent-org"), { tracker: ORG });
  assert.deepEqual(trackerNamed(TWO, ""), { tracker: HOME });
});

test("#4078: a key that is not declared is refused, naming every key that IS", () => {
  const named = trackerNamed(TWO, "typo");
  assert.ok("refusal" in named);
  assert.match(named.refusal, /`--tracker=typo` names no declared tracker/);
  assert.match(named.refusal, /"" \(example\/product\), "agent-org" \(a11ign\/agent-org\)/);
});

test("#4078: ORG_TRACKER_REPO is the repository work-gate.ts calls the tool's own", () => {
  const source = workGateSource();
  const declared = /^const TOOL_REPO = "([^"]+)";$/m.exec(source);
  assert.ok(declared, "the positive control: the pattern finds work-gate's constant, so an equality below is not between two nothings");
  assert.equal(ORG_TRACKER_REPO, declared[1]);
});
