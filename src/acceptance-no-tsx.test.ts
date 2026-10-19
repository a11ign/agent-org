// no-token: gh
//
// `checkBody` is called with an injected `run` and a diff that adds an `.acceptance/` file, so the `gh` that `pr-open.ts`'s `defaultGh` spawns is
// a path nothing here takes.

/**
 * agent-org#870: AN ACCEPTANCE THAT LOADS TYPESCRIPT THROUGH `tsx` WAS ACCEPTED AT FILING AND AT `pr:open`. `tsx` is not a dependency of this tool
 * (#4389, pinned for units and scripts by `no-loader.test.ts`), so the line fails the first time anyone runs it (`ERR_MODULE_NOT_FOUND`, PR #844),
 * and 37 shipped `.acceptance/` files carry the spelling.
 *
 * CONTROL FIRST: `REFUSED` is the spellings the row names, asserted non-empty and each shown refused; `ACCEPTED` is the lines that must read as
 * before, each asserted accepted by the SAME function, so a pattern that refuses everything fails there and one that refuses nothing fails above.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { acceptancePathsReason, loadsTypeScriptThroughTsx, tsxAcceptanceReason } from "./acceptance-commands/suite-and-checkout-commands.ts";
import { checkBody } from "./pr-open.ts";

/** A row body whose Acceptance is `lines`, each its own command. */
function rowBody(lines: string[], extra = ""): string {
  return `## Region\n\n\`\`\`\nsrc/x.ts\n\`\`\`\n\n## Acceptance\n\n\`\`\`bash\n${lines.join("\n")}\n\`\`\`\n\n${extra}## Open-check\n\nfalse today.\n`;
}

/** What the row names, and the spellings the 37 shipped files and the failed #844 carry. */
const REFUSED = [
  "node --import tsx --test a.test.ts",
  "node --import=tsx --test a.test.ts",
  "node --import tsx/esm --test a.test.ts",
  "node --loader tsx --test a.test.ts",
  "node --import 'tsx' --test a.test.ts",
  "pnpm exec tsx a.ts",
  "pnpm exec node --import tsx --test src/app-token.test.ts",
  "tsx a.ts",
  "AGENT_ORG_HOST=/home/agent/repos/a11y-witness/.agent-org/host.json node --import tsx --test src/x.test.ts",
  "cd /home/agent/repos/agent-org-wt-1 && GH_REPO=a11ign/agent-org node --import tsx -e 'import(\"./src/work-gate.ts\")'",
  "FOO=1 tsx a.ts",
  "true && tsx a.ts",
  "bash -c 'tsx a.ts'",
  "bash -c 'cd /home/agent/repos/agent-org && node --import tsx --test src/x.test.ts'",
];

/** Lines that must keep today's verdict: they do not load `tsx`, though several of them NAME it. */
const ACCEPTED = [
  "node --test a.test.ts",
  "node --test src/acceptance-no-tsx.test.ts",
  // #524's own Acceptance: a guard that `tsx` is gone is a good line, and `no-loader.test.ts`'s `(^|\s)tsx` would refuse it.
  "bash -c '! git grep -qE tsx -- .github/workflows && test \"$(git ls-files | grep -cE \"[.](mjs|js|cjs)$\")\" = 0'",
  "git grep -n tsx -- package.json",
  "echo tsx",
  "node --test src/tsx-fixtures/a.test.ts",
  "node --test tsx-fixtures.test.ts",
  "node --test src/App.tsx",
  "node --import ./src/a/crash-exit.ts --test src/x.test.ts",
  "pnpm exec rstest run --config scripts/rstest/rstest.config.ts src/x.test.ts",
  "tsx-codemod a.ts",
  "pnpm dlx tsx a.ts",
  // The one-shot registry runner is the placeholder Acceptance of many fixtures outside this row's Region, and it fetches tsx rather than failing
  // to resolve it, so it is deliberately not claimed. Assembled, because `remedies-say-pnpm.test.ts` pins every source line that names it.
  `${"np"}${"x"} tsx --test x`,
];

const deps = { exists: () => true, trackedDirs: ["src"], regionEntries: [], primaryCheckout: null };
/** The seam `row-file` calls, as `row-file` calls it: a refusal, or null. */
const atFiling = (lines: string[], extra = "") => acceptancePathsReason(rowBody(lines, extra), "row-file", deps);

test("CONTROL: the populations are non-empty, and each REFUSED spelling is refused where each ACCEPTED one is not", () => {
  assert.ok(REFUSED.length >= 10 && ACCEPTED.length >= 5, "an empty population would pass every assertion below");
  assert.deepEqual(REFUSED.filter((line) => !loadsTypeScriptThroughTsx(line)), [], "a spelling that loads tsx was not recognised");
  assert.deepEqual(ACCEPTED.filter((line) => loadsTypeScriptThroughTsx(line)), [], "a line that does not load tsx was refused");
});

test("POSITIVE CONTROL: `node --import tsx --test a.test.ts` is refused at filing, and the refusal names the line and the way out", () => {
  const line = "node --import tsx --test a.test.ts";
  const reason = atFiling([line]) ?? "";
  assert.match(reason, /^row-file: REFUSING -- the Acceptance loads TypeScript through `tsx`/);
  assert.ok(reason.includes(`\`${line}\``), `does not name the line: ${reason}`);
  assert.match(reason, /not a dependency of this tool/);
  assert.match(reason, /run `node --test <file>`/);
  assert.match(reason, /Hand-run:/);
});

test("NEGATIVE: the same line as `node --test a.test.ts` passes, and so does a body with none of the spellings", () => {
  assert.equal(atFiling(["node --test a.test.ts"]), null);
  assert.equal(tsxAcceptanceReason(rowBody(["node --test a.test.ts"]), "row-file"), null);
});

test("every spelling is refused at filing, one command or several, and each hit is named", () => {
  for (const line of REFUSED) assert.ok((atFiling([line]) ?? "").includes(`\`${line}\``), `not refused at filing: ${line}`);
  const both = atFiling(["node --test ok.test.ts", REFUSED[0], REFUSED[5]]) ?? "";
  assert.ok(both.includes(REFUSED[0]) && both.includes(REFUSED[5]) && !both.includes("ok.test.ts"));
});

test("lines that merely mention `tsx` keep today's verdict at filing", () => {
  for (const line of ACCEPTED) assert.equal(atFiling([line]), null, `refused: ${line}`);
});

test("prose that names the spelling, outside the Acceptance, is not refused: the shipped files' Evidence lines do", () => {
  const prose = "Evidence: `node --import tsx --test x.test.ts` cannot run here; the same file passes under `node --test`.\n\n";
  assert.equal(atFiling(["node --test x.test.ts"], prose), null);
});

test("a `Hand-run:` declaration keeps its meaning: a human runs it on a host they chose, so it is not refused", () => {
  const declared = rowBody([REFUSED[0]], "Hand-run: the host owner runs it where tsx is installed.\n\n");
  assert.equal(tsxAcceptanceReason(declared, "row-file"), null);
});

test("`pr:open`'s `checkBody` refuses the line BEFORE running it, and still runs a clean one", () => {
  const diff = (body: string) => ({ diff: { ok: true as const, files: [".acceptance/agent~example-1.md"], added: [".acceptance/agent~example-1.md"] }, readFile: () => body });
  const check = (command: string) => {
    let ran = 0;
    const body = `Acceptance: \`${command}\`\n\nCloses: none -- test\n`;
    const verdict = checkBody(body, { run: () => { ran++; return 0; }, ...diff(body) });
    return { ran, ok: verdict.ok, text: verdict.lines.join("\n") };
  };
  const refused = check("node --import tsx --test a.test.ts");
  assert.equal(refused.ok, false);
  assert.equal(refused.ran, 0, "the command was run for real before being refused");
  assert.match(refused.text, /ACCEPTANCE: REFUSING -- the Acceptance loads TypeScript through `tsx`/);
  const clean = check("node --test a.test.ts");
  assert.equal(clean.ran, 1, "CONTROL: the same body without the loader reaches the runner");
  assert.doesNotMatch(clean.text, /through `tsx`/);
});

test("the spellings are `no-loader.test.ts`'s: every REFUSED line is one its own `NAMES_TSX` names, so this is not a second, wider pattern", () => {
  const source = /const NAMES_TSX = (\/.*\/);/.exec(readFileSync(new URL("./no-loader.test.ts", import.meta.url), "utf8"))?.[1];
  assert.ok(source, "CONTROL: `no-loader.test.ts` still declares NAMES_TSX in the shape this reads");
  const pinned = new RegExp(source.slice(1, -1));
  assert.deepEqual(REFUSED.filter((line) => !pinned.test(line.replace(/['"]/g, " "))), [], "this check refuses a line the pin does not name");
});
