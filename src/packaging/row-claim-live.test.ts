// no-token: defaultRun
//
// #1406: every `gh` answer in this file is RECORDED and handed to `fetchLabels` through `run`, never
// `row-claim.mjs`'s own `defaultRun`, the one function that spawns a real `gh`. The reason is kept on these lines;
// since #1465, `acceptance-commands.mjs`'s `NO_TOKEN_DECLARATION` would also read it after ` -- ` on the marker's.
/**
 * #513: split out of `row-claim.test.ts`, because these tests made real GitHub API calls and the other 52 made
 * none. #1406: they no longer do. worker-capture's census on #1275 (5655682618) found this file making 2 live
 * `gh issue view` calls on every local run (#55, then #737, stopping at the first refusal), spending the shared
 * pools from a test suite. Each call now reads a RECORDED copy of `gh`'s own stdout through an injected `run`.
 *
 * WHAT A RECORDED COPY CANNOT CATCH, said here rather than left for a reader to infer:
 * - An EDIT to #55, #737 or #758 after the fetch. #771's test is named for the prose those bodies carry; a
 *   recorded body keeps carrying it after the issue changes. The live check is DROPPED, not moved: the
 *   property under test is `filedByLine`'s, and a recorded body tests it exactly.
 * - A change in the SHAPE `gh issue view --json` answers with, or `gh` failing on auth or the network. The
 *   live smoke test caught those only as a red test with no attribution (#513's own incident), and the claim
 *   path itself refuses them loudly (`fetchLabels` never falls through to an empty list).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchLabels, filedByLine } from "../../../../scripts/row-claim.mjs";

const REPO = "DanBeckDev/a11y-witness";

/**
 * `gh`'s stdout, byte for byte, for the three calls these tests made live -- fetched 2026-09-13T20:21:41Z as
 * `a11ign-ai-workers`. The issues were last updated: #55 2026-09-08T00:08:16Z, #737 2026-09-09T15:20:40Z,
 * #758 2026-09-09T16:17:46Z. Faithful quotation: nothing in them is edited, trimmed or re-serialised.
 */
const RECORDED: Record<string, string> = {
  "issue view 55 --repo DanBeckDev/a11y-witness --json number,title,labels,state":
    "{\"labels\":[],\"number\":55,\"state\":\"CLOSED\",\"title\":\"A row can be claimed twice, because the collision check reads diffs and a claim does not live in a diff\"}\n",
  "issue view 737 --repo DanBeckDev/a11y-witness --json body":
    "{\"body\":\"Found in #685's control arm. Filed by `orchestrator`; **not claimed**. `worker-capture` and I both looked\\nat it and neither of us has a mechanism, which is why it is a row rather than a line on #685.\\n\\n## The measurement\\n\\n`https://calendly.com/`, `--probe-forms` **off**, fleet `691969f6a8f1dd11`, `domCensus.targetMatch:\\nmatched`, every sweep stopped `exhausted`:\\n\\n| type | sweep found | oracle (distinct names) |\\n|---|---|---|\\n| heading | 44 | 33 |\\n| landmark | 18 | 9 |\\n| link | 82 | 76 |\\n| **graphic** | **10** | **61** |\\n\\n**Headings, landmarks and links all OVERSHOOT slightly** — expected and understood: the sweep counts\\nannouncements and the oracle counts distinct names, so a page announcing the same name twice reads higher.\\n\\n**Graphics undershoot by six times**, in the same capture, on a page that held still.\\n\\n## Why it is neither of the two causes we now understand\\n\\n- **Not the deadline.** IKEA's case is `formField` hitting `deadline` and five sweeps never starting. Here\\n  every sweep including `graphic` ran to `exhausted`.\\n- **Not the page moving.** That is calendly's OTHER defect, and it is what the `--probe-forms` ON arm\\n  shows (graphic 1, link 5). **This is the arm where nothing submitted and nothing navigated**, and links\\n  came back at 82 — so the document was stable enough for the link sweep to walk it in full.\\n\\nA sweep that runs to exhaustion, on a stable document, reaching a sixth of one element type while reaching\\nall of another, is a third shape.\\n\\n## What would discriminate, none of which I have run\\n\\n1. **Is it deduplication?** `collectByType` dedupes by announcement (`seenKeys`), so 61 graphics sharing\\n   ten distinct alt texts would legitimately read 10. **The oracle already counts DISTINCT NAMES**, which\\n   is supposed to remove exactly this — but \\\"distinct name\\\" in the AX tree and \\\"distinct announcement\\\" from\\n   NVDA are not obviously the same reduction, and nobody has compared them for graphics specifically.\\n   Cheapest check, needs no capture: read `phrases` off the `graphic` sweep mark in the capture on disk\\n   against the census's own name list.\\n2. **Is it a quick-nav gap?** `g` walks graphics; an image with no accessible name may not be a quick-nav\\n   target at all while still being an element the tree reports.\\n3. **Is it calendly-specific?** IKEA's graphic sweep never ran and hubspot's reached 24. **One page is one\\n   page.**\\n\\nStart with (1) — it is a read of an artefact already on disk and it either explains the whole gap or rules\\nitself out.\\n\\n## Why it matters\\n\\n`graphicUnnamed` feeds 1.1.1, which is one of the **four subtypes this project may ASSERT** rather than\\nrefer. A sweep reaching a sixth of the graphics is a coverage gap under an asserting rule, and\\n`structureCrossCheck` has been reporting it all along — invisibly, because until #699 the oracle it\\ncompared against described the wrong document.\\n\\n**That is this row's real provenance:** the number was always there and could not be read. Fixing the\\noracle made a nonsense comparison into a legible one, and the first thing it says is this.\\n\\n## Region\\n\\n`packages/nvda-worker/src/capture-probes.mjs` (`collectByType`, `seenKeys`, the `graphic` sweep),\\n`crossCheckStructure`, and `runs/witness/2026-09-09T12-59-26-678Z-calendly-com.json` which holds the case.\\n\\nNo fleet for step 1.\\n\\n🤖 Generated with [Claude Code](https://claude.com/claude-code)\\n\\nhttps://claude.ai/code/session_01MfEpJWCGK9Nx1cKfx3GEjg\\n\\n## Acceptance\\n\\n```bash\\nnpx tsx --test packages/lab/src/gates/structure-cross-check.test.ts\\n```\\n\\n- The oracle's count of a type is the count of **elements**, not of distinct names, so N unnamed graphics count as N and not as one.\\n- A page with several **identically named** elements still counts them all — the fix must not swap one collapsing rule for another.\\n- The cross-check's own output states which quantity it compared, so a future reader is not left inferring it from the number.\\n\\n**Mutation:** give a page three graphics with no accessible name. The oracle must report three. Before the fix it reports one, which is what inflated every gap this check has ever announced.\\n\\n## Open-check — the command that shows this row is still open\\n\\n```bash\\ngrep -rn 'oracleDistinctNames\\\\|distinct names' packages/lab/src/gates/ scripts/ | head\\n```\\n\\nOpen while the oracle counts distinct NAMES against a sweep that counts ELEMENTS. **The two numbers describe different quantities**, so every gap the cross-check reports is inflated by however many unnamed elements the page has — this repository's own most expensive shape, two things compared that measure different alphabets.\\n\\n---\\n\\n*Sections written by the PM from the filing, filer to confirm — #735 backfill, 2026-09-09.*\\n\"}\n",
  "issue view 758 --repo DanBeckDev/a11y-witness --json body":
    "{\"body\":\"#685's remainder, filed at `ceo`'s instruction because a flagged gap with no row is the kind that gets\\nlost. Filed by `orchestrator`; **not claimed**.\\n\\n## What is known, and what cannot be established\\n\\n`domCensus.targetMatch` now tells you whether the **census** described the requested page (#699), and\\n`documentIdentity` (#687/#722) gives a **capture** one identity. **Neither says which document any given\\nSWEEP STEP was walking**, and that is what the calendly case turns on.\\n\\nMeasured 2026-09-09 on `https://calendly.com/`, same URL, task and worker, one flag apart, both\\n`targetMatch: matched`, **identical censuses** (33 headings, 76 links, 63 graphics):\\n\\n| sweep | `--probe-forms` ON | OFF |\\n|---|---|---|\\n| formField | 18 | 46 |\\n| graphic | 1 | 10 |\\n| link | 5 | 82 |\\n| wall clock | 254 s | 424 s |\\n\\n**Every sweep in both arms stopped `exhausted`. None hit `deadline`.** Nothing was starved of time — the\\nsweeps ran to completion and found different amounts, which means the document changed underneath them.\\n\\n## Why this is not #677 and not #685\\n\\n- **Not #677.** That row's budget is for IKEA's case: `formField` hitting `deadline` at 322 s of a 471 s\\n  run, with five sweeps never starting. **A budget does not fix an `exhausted` sweep**, and sizing one\\n  against these numbers would be sizing it against the wrong defect.\\n- **Not #685.** That row was the census describing a page the capture navigated to; it is fixed and\\n  closed. #699 stopped the navigation corrupting the oracle. **It did not stop the navigation.**\\n\\n## The candidate mechanism, explicitly NOT asserted\\n\\n`formField` is third of eight sweeps, before `link`, `graphic`, `list`, `frame` and `postSubmit`; the\\nform probe activates controls; `routeChange` records a move to a Google sign-in. That fits.\\n\\n**\\\"Fits\\\" has been wrong three times on this exact page in one day** — twice by me. It is a candidate and\\nthis row must not be built on it.\\n\\n## What would settle it\\n\\n**A per-step record of which document the sweep was on.** The `sweep` mark already carries `phrases`,\\n`found`, `prevStop`/`nextStop` and trip counts; what it does not carry is any identity of the document\\neach step walked. With one, the two arms above stop being a puzzle: either the later sweeps walked a\\ndifferent document or they did not, and the mark says so.\\n\\nCheapest shape worth considering, and this row should choose rather than inherit:\\n- a document fingerprint sampled **per sweep**, reusing `FINGERPRINT_KEYS` so it is comparable with\\n  `documentIdentity` rather than a second spelling;\\n- or a single `navigatedDuringSweep` flag per sweep, which is cheaper and answers less.\\n\\n## Acceptance\\n\\n1. On the two captures already on disk — `runs/witness/2026-09-09T12-49-29-716Z-calendly-com.json` and\\n   `…T12-59-26-678Z-…` — the evidence says whether the later sweeps walked a different document.\\n2. A mutation that drops the per-step record goes red.\\n3. It costs nothing measurable on a page that does not navigate. **The sweep is already the largest phase\\n   of a real page** (#397); an identity check per step must not become the next thing that is.\\n\\nAcceptance 1 and 2 need no fleet if the record can be derived from marks already taken; if it needs new\\ninstrumentation, acceptance 1 becomes a re-capture and is `orchestrator`'s to run.\\n\\n## Region\\n\\n`packages/nvda-worker/src/capture-probes.mjs` (`collectByType`, the `sweep` mark),\\n`packages/evidence/src/document-identity.ts` (`FINGERPRINT_KEYS`, for comparability).\\n\\n🤖 Generated with [Claude Code](https://claude.com/claude-code)\\n\\nhttps://claude.ai/code/session_01MfEpJWCGK9Nx1cKfx3GEjg\\n\\n## Open-check — the command that shows this row is still open\\n\\n```bash\\nnode -e \\\"const c=require('fs').readdirSync('runs',{recursive:true}).filter(f=>String(f).endsWith('capture.json')).slice(0,1); if(!c.length){console.log('no capture on disk here');process.exit(0)} const j=JSON.parse(require('fs').readFileSync('runs/'+c[0])); console.log('sweep steps carrying a document identity:', JSON.stringify(j.sweeps?.[0]?.documentIdentity ?? 'none'))\\\"\\n```\\n\\n**Run by whoever drives the fleet or the lab** — a `runs/` copy in any other checkout is only as fresh as its last sync, so this is a pre-check anywhere else.\\n\\nOpen while a sweep step carries no record of which document it was walking. `domCensus.targetMatch` answers it for the census and `documentIdentity` answers it for the capture; **neither answers it per step**, which is exactly what the calendly case turns on — two runs, identical censuses, and no way to say whether the same document was under both sweeps.\\n\\n---\\n\\n*Sections written by the PM from the filing, filer to confirm — #735 backfill, 2026-09-09.*\\n\"}\n",
};

/** A `run` that answers ONLY a recorded call, and keeps every call it was asked. */
function recordedRun() {
  const calls: string[][] = [];
  const run = (cmd: string, args: string[]) => {
    calls.push([cmd, ...args]);
    const answer = cmd === "gh" ? RECORDED[args.join(" ")] : undefined;
    if (answer === undefined) throw new Error(`no recorded answer for: ${cmd} ${args.join(" ")}`);
    return answer;
  };
  return { run, calls };
}

/**
 * The body of issue `n`, as the live test's `gh issue view <n> --repo ... --json body` returned it -- read by that
 * call's argv, straight from the recording. No runner in between: the body read never exercised product code, only
 * `filedByLine` reading its result does.
 */
function recordedBody(n: number): string {
  const answer = RECORDED[`issue view ${n} --repo ${REPO} --json body`];
  assert.ok(answer !== undefined, `#${n}'s body is recorded`);
  return JSON.parse(answer).body;
}

test("fetchLabels reads the recorded #55 through its injected run -- the same call the live test made", () => {
  const { run, calls } = recordedRun();
  const result = fetchLabels(55, { run });
  assert.deepEqual(calls, [["gh", "issue", "view", "55", "--repo", REPO, "--json", "number,title,labels,state"]],
    "the seam receives exactly the argv the live call used, so the recording answers the real question");
  assert.equal(result.number, 55);
  assert.ok(Array.isArray(result.labels));
});

// --- #771: filedByLine, against the recorded #737 and #758 -- the issue's own named fixtures ---

test("#771 ACCEPTANCE, RECORDED: #737 and #758 both carry only the OLDER 'Filed by `orchestrator`' prose "
  + "(no hyphen, no colon-value line) -- filedByLine must read both as absent, never infer from it", () => {
  for (const n of [737, 758]) {
    const body = recordedBody(n);
    assert.match(body, /Filed by `orchestrator`/,
      `#${n}'s recording no longer carries the prose this test is named for -- re-check the fixture`);
    assert.equal(filedByLine(body), null,
      `#${n}'s older prose must never be read as a Filed-by: line`);
  }
});

test("#1406 POSITIVE CONTROL: the same recorded body WITH a `Filed-by:` line reads that session -- the null "
  + "above is the body's, not a reader that answers null for everything", () => {
  assert.equal(filedByLine(`${recordedBody(737)}\n\nFiled-by: orchestrator`), "orchestrator");
});

test("#1406 the recorded run answers ONLY a recorded call -- a different argv is refused, never answered", () => {
  const { run } = recordedRun();
  assert.throws(() => fetchLabels(56, { run }), /could not read issue #56[\s\S]*no recorded answer for: gh issue view 56/);
});
