// no-token: gh -- every `gh` here is an injected seam (`read`, `classify`); nothing imported reaches the real one
/**
 * agent-org#1185 (half 2 of #1166): A SAME-HEAD RE-FAIL REACHES THE OWNER A SECOND TIME, AND WITH THE ASSERTION THAT FAILED.
 *
 * The gate's half (the key a re-fail is given, behind `checks.sameHeadRefail`) is `work-gate/same-head-refail.test.ts`. This file is the wake tick's: the delivered ledger
 * (`undelivered`) is what dropped the second order, and `withCiFailureClass` is the one place that reads the failing job's log before delivery, so it is where the order gains the
 * assertion. With NO provider declared the class note is silent (the rule's class is the gate's own order), and a re-fail's order is the exception: it must carry what failed.
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CiFailure } from "./ci-failure-class.ts";

// A RECORDED PROJECT AND A HOST THAT DECLARES NO PROVIDER, set BEFORE `wake.ts` is imported (`wake-ci-class-review-depth.test.ts`'s prelude): it resolves the declaration at import.
const SCRATCH = mkdtempSync(join(tmpdir(), "wake-same-head-refail-"));
after(() => rmSync(SCRATCH, { recursive: true, force: true }));
const PROJECT = join(SCRATCH, "project");
cpSync(fileURLToPath(new URL("./packaging/fixtures/row-claim-file-overlap-rule/project", import.meta.url)), PROJECT, { recursive: true });
mkdirSync(join(PROJECT, "node_modules", "left-pad"), { recursive: true });
const HOST_FILE = join(SCRATCH, "host.json");
writeFileSync(HOST_FILE, JSON.stringify({ schema: 1, home: SCRATCH, binDir: join(SCRATCH, "bin"), primary: "fixture", projects: [{ id: "fixture", checkout: PROJECT }],
  gh: { workers: join(SCRATCH, "workers"), leads: join(SCRATCH, "leads"), leadsHeader: [], leadsWorkspaces: [] } }));
process.env.AGENT_ORG_HOST = HOST_FILE;
const { undelivered } = await import("./wake/reset.ts");
const { withCiFailureClass } = await import("./wake/with-ci-failure-class.ts");
const { classifyCiFailure } = await import("./ci-failure-class.ts");

const FIRST = { session: "worker-7", cause: "pr-checks-failing", causeKey: "worker-7/pr-checks-failing/pr-77/abcdef12", prompt: "PR 77 has FAILING checks." };
const AGAIN = { ...FIRST, causeKey: `${FIRST.causeKey}/refail-1`, prompt: "PR 77 FAILED AGAIN at this same head." };
const ASSERTION = "AssertionError [ERR_ASSERTION]: expected 'quiet', got 'backlog'";
const FACTS: CiFailure = { errorLines: ["ok 1 - the backoff", "# API rate limit exceeded", "not ok 2 - A REAL TICK OVER A QUIET QUEUE", `  ${ASSERTION}`],
  redOnMain: false, redOnOtherPrs: false, readsOutsideRepository: false, rateLimitOrRunnerLost: false, rerunAlready: true };
const classify = (failure: CiFailure, deps: Parameters<typeof classifyCiFailure>[1]) => classifyCiFailure(failure, deps);
const enrich = (orders: typeof FIRST[], facts: CiFailure | null = FACTS) =>
  withCiFailureClass(orders, { host: {}, ledgerPath: "/nonexistent/ledger", read: () => facts, classify });

test("the ledger drops a second order at the first one's key, and delivers one at its own: the key is what decides whether the owner hears twice", () => {
  assert.deepEqual(undelivered([{ ...FIRST }], new Set([FIRST.causeKey])), [], "the old key: already delivered, dropped");
  assert.deepEqual(undelivered([AGAIN], new Set([FIRST.causeKey])), [AGAIN], "the re-fail's key: delivered, to the same session");
});

test("a re-fail's order is read by the classifier and carries the failing assertion and not the passing test's output, even with no provider", async () => {
  const [first, again] = await enrich([FIRST, AGAIN]);
  assert.equal(first.prompt, FIRST.prompt, "the first failure's order is the gate's, byte for byte (no provider, no wait): the control that the note is the re-fail's alone");
  assert.ok(again.prompt.startsWith(AGAIN.prompt), "the gate's words come first");
  assert.ok(again.prompt.includes(ASSERTION), "the assertion that failed is in the order");
  assert.ok(!again.prompt.includes("rate limit"), "a passing test's printed text is not the failure");
});

test("a re-fail whose log could not be read is the gate's order as written, which already says it failed again", async () => {
  const [again] = await enrich([AGAIN], null);
  assert.equal(again.prompt, AGAIN.prompt);
});

test("a re-fail beyond the per-tick classification cap still carries the failing assertion, and the cap still holds for everything else", async () => {
  const { ENRICH_AHEAD } = await import("./wake/is-release-line.ts");
  const plain = Array.from({ length: ENRICH_AHEAD }, (_, i) => ({ ...FIRST, causeKey: `worker-7/pr-checks-failing/pr-${100 + i}/abcdef1${i}`, prompt: `PR ${100 + i} has FAILING checks.` }));
  const beyond = { ...FIRST, causeKey: "worker-7/pr-checks-failing/pr-200/abcdef20", prompt: "PR 200 has FAILING checks." };
  const refail = { ...AGAIN, causeKey: "worker-7/pr-checks-failing/pr-201/abcdef21/refail-1", prompt: "PR 201 FAILED AGAIN at this same head." };
  const classified: string[] = [];
  const counting = (failure: CiFailure, deps: Parameters<typeof classifyCiFailure>[1]) => { classified.push(deps.id ?? ""); return classifyCiFailure(failure, deps); };
  const out = await withCiFailureClass([...plain, beyond, refail], { host: {}, ledgerPath: "/nonexistent/ledger", read: () => FACTS, classify: counting });
  assert.equal(classified.length, ENRICH_AHEAD, "POSITIVE CONTROL: only the first ENRICH_AHEAD orders were classified, a first failure past the cap is not");
  assert.ok(!classified.includes(refail.causeKey), "the re-fail past the cap was read, not classified");
  assert.equal(out[ENRICH_AHEAD].prompt, beyond.prompt, "a first failure past the cap is the gate's order, byte for byte");
  assert.ok(out[ENRICH_AHEAD + 1].prompt.startsWith(refail.prompt), "the gate's words come first");
  assert.ok(out[ENRICH_AHEAD + 1].prompt.includes(ASSERTION), "the re-fail past the cap names the assertion that failed");
});
