// no-token: none -- reads this checkout's workflow file and nothing else
/**
 * (a11ign/a11ign#3886) `gate` READS A11IGN AT A COMMIT SHA, NEVER AT A BRANCH.
 *
 * `ci.yml` checks out a11ign/a11ign at `PROJECT_REF` and runs the tool's suite over it. At `main` an a11ign merge turned every pull request here red
 * (#3097: about 50 minutes), for a change none of them made. A full commit sha holds the project still until a pull request here moves it.
 *
 * POSITIVE CONTROL: `refProblem` is asked about a fixture whose pin is `main` (and a short sha, and a tag-like name) and must refuse each, so a reader
 * that accepted anything would fail here and not pass for a pinned workflow. The real workflow is read through the same function.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/** `.github` is copied with the tool into the project's tree by `gate`, so this path resolves both in this repository and there. */
const CI = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");

const FULL_SHA = /^[0-9a-f]{40}$/;
const PIN_LINE = /^ {2}PROJECT_REF: ([^\s#]+)\s*$/m;
const CHECKOUT_USES_THE_PIN = /repository: a11ign\/a11ign\n\s+ref: \$\{\{ env\.PROJECT_REF \}\}/;

/** Why this workflow's pin is not a full commit sha, or `null` when it is one. */
function refProblem(workflow: string): string | null {
  const pin = PIN_LINE.exec(workflow);
  if (!pin) return "no `PROJECT_REF:` line under `env:`";
  if (!FULL_SHA.test(pin[1])) return `PROJECT_REF is \`${pin[1]}\`, not a full 40-character commit sha`;
  if (!CHECKOUT_USES_THE_PIN.test(workflow)) return "the a11ign/a11ign checkout does not read `ref: ${{ env.PROJECT_REF }}`";
  return null;
}

const checkout = (ref: string) => `env:\n  PROJECT_REF: ${ref}\njobs:\n  gate:\n    steps:\n      - with:\n          repository: a11ign/a11ign\n          ref: \${{ env.PROJECT_REF }}\n`;

test("the project is read at a full commit sha, never a branch", () => {
  assert.equal(refProblem(CI), null);
});

test("the control: a branch name, a short sha, a tag and a missing pin are each refused, and a full sha is not", () => {
  assert.equal(refProblem(checkout("9915703d61d1e8e56968afe8574bf0b24927c076")), null, "the green control");
  for (const ref of ["main", "9915703d6", "v0.1.0", "9915703D61D1E8E56968AFE8574BF0B24927C076"]) {
    assert.match(refProblem(checkout(ref)) ?? "", /not a full 40-character commit sha/, ref);
  }
  assert.match(refProblem("env:\n  OTHER: 1\n") ?? "", /no `PROJECT_REF:` line/);
});

test("the checkout must read the pin: a sha nothing uses holds nothing still", () => {
  const unused = checkout("9915703d61d1e8e56968afe8574bf0b24927c076").replace("${{ env.PROJECT_REF }}", "main");
  assert.match(refProblem(unused) ?? "", /does not read `ref: \$\{\{ env\.PROJECT_REF \}\}`/);
});

export const redProbe3986: number = "not a number";
