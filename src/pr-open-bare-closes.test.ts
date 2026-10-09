// no-token: gh -- `checkRegion` is handed `rowBody` and `git` as seams, so nothing reaches the real `gh`
/**
 * #4469 (split from #4401): A BARE `Closes #N` IS REFUSED IN A LAYER REPOSITORY'S PR WHETHER OR NOT `--repo` WAS PASSED. #2995 made `checkRegion`
 * refuse it, but read the PR's repository from the flag alone and fell back to the tracker, so on lab#39 the body `Closes: #4305, #4372` went
 * through from a lab checkout: `declaredClosedRows` kept only the tracker's rows, #4372 was not the PR's own row, and B4 shelved it for 71 ticks.
 * The checkout's `origin` is the same fact `repoFlagHint` (#3149) already reads, and is read here for the bare-number test only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkRegion } from "./pr-open.ts";

const TRACKER = "a11ign/a11ign";
const LAB = "a11ign/lab";
const CODE = [{ key: "", repo: TRACKER }, { key: "lab", repo: LAB }];
const IN_REGION = ["src/x.ts"];
const ROW = "## Region\n\n```\nsrc/x.ts\n```\n\n## Acceptance\n\nx\n";
const body = (closes: string) => `## Acceptance\n\nnode -e "process.exit(0)"\n\n${closes}\nMutation: none -- these tests drive the Closes check\n`;

/** `git` answering the diff and `origin`; an `origin` of null throws, as a checkout with no remote does. */
const gitFor = (origin: string | null) => (args: string[]) => {
  if (args[0] === "remote") { if (origin === null) throw new Error("no origin"); return origin; }
  return IN_REGION.join("\0");
};

const check = (closes: string, { origin, rest = [] }: { origin: string | null; rest?: string[] }) =>
  checkRegion(body(closes), rest, { git: gitFor(origin), rowBody: () => ROW, rootFiles: new Set<string>(), code: CODE });

test("#4469: a bare `Closes: #4372` with no --repo, in a checkout whose origin is a11ign/lab, is refused and names the full form", () => {
  const { refusal } = check("Closes: #4372", { origin: `https://github.com/${LAB}.git` });
  assert.match(refusal ?? "", /`Closes #4372` names an issue of a11ign\/lab, not a row of a11ign\/a11ign/);
  assert.match(refusal ?? "", /a11ign\/a11ign#4372/);
  assert.match(refusal ?? "", /Nothing was sent/);
});

test("#4469 control: the same body in a checkout whose origin is the tracker is not refused", () => {
  assert.equal(check("Closes: #4372", { origin: `https://github.com/${TRACKER}` }).refusal, null);
});

test("#4469 control: the full form `Closes: a11ign/a11ign#4372` in the lab checkout is not refused", () => {
  assert.equal(check("Closes: a11ign/a11ign#4372", { origin: `git@github.com:${LAB}.git` }).refusal, null);
});

test("#4469 control: with --repo passed the bare number still refuses as before, and the flag outranks the origin", () => {
  const flagged = check("Closes: #4372", { origin: `https://github.com/${TRACKER}`, rest: ["--repo", LAB] });
  assert.match(flagged.refusal ?? "", /names an issue of a11ign\/lab/);
  const agree = check("Closes: #4372", { origin: `https://github.com/${LAB}`, rest: ["--repo", LAB] });
  assert.match(agree.refusal ?? "", /names an issue of a11ign\/lab/);
});

test("#4469 control: an origin that cannot be read, or is no declared repository, falls back to the tracker and refuses nothing", () => {
  for (const origin of [null, "https://github.com/someone/else", "deadbeef"]) {
    assert.equal(check("Closes: #4372", { origin }).refusal, null, String(origin));
  }
});

test("#4469: every bare number is found, not the first, and a full-form reference beside it does not hide it", () => {
  const { refusal } = check("Closes: a11ign/a11ign#4305, #4372", { origin: `https://github.com/${LAB}` });
  assert.match(refusal ?? "", /`Closes #4372`/);
});
