// @ts-check
// WHAT A RECORDED GATE SAID, AND WHICH ONE THE BOARD'S VERDICT SLOT MEANS -- pure, and in its own module (#429).
//
// Split out of `board-data.mjs` so a test of the SELECTION can run anywhere, CI's acceptance job included:
// `board-data.mjs` spawns `gh` and `git`, so anything importing it is classed as needing a token, and the
// row's own acceptance command would otherwise have been refused. Nothing here reads a file or starts a
// process. `board-data.mjs` re-exports every name, so no importer of it changes.

/** The verdicts a gate PRINTED, quoted from its own output and never retyped.
 *
 * THE BOARD'S DOCUMENT COULD NOT SAY WHETHER A CHECK PASSED. `board-report.mjs` prints the gate's whole
 * output verbatim into the GitHub edition; the PDF quoted only the COMMAND and the capture spread. So the
 * two editions would have disagreed about whether a check passed, and the silent one is the one the board
 * reads -- found 2026-09-07, the day before the first FAIL was due to be recorded.
 *
 * Quoted, never classified. A gate states its own verdict in its own sentence; this returns those
 * sentences. Deciding whether a FAIL blocks anything is a JUDGEMENT and is not derivable from the output,
 * which is why `note` on the entry carries it and why an unexplained FAIL renders as unexplained rather
 * than as an opinion this file invented.
 *
 * @param {string | undefined} gateOutput
 */
export function gateVerdicts(gateOutput) {
  const lines = String(gateOutput ?? "").split("\n");
  /** @type {{ verdict: string, line: string }[]} */
  const found = [];
  for (const raw of lines) {
    const line = raw.trim();
    // A verdict is the word at the head of its own clause, so `RULES: PASS -- ...` and `PASS -- ...`
    // both count and the word inside a sentence ("a page that FAILS this rule") does not.
    const m = /^(?:[A-Za-z: ]{0,24}?\b)?(PASS|FAIL|BLOCKED|INCONCLUSIVE)\b\s*(?:[—-]\s*(.*))?$/.exec(line);
    if (m) found.push({ verdict: m[1], line });
  }
  return found;
}

/** The single worst verdict a gate printed, or null when it printed none.
 * @param {string | undefined} gateOutput */
export function worstVerdict(gateOutput) {
  /** @type {Record<string, number>} */
  const order = { PASS: 0, INCONCLUSIVE: 1, BLOCKED: 2, FAIL: 3 };
  const all = gateVerdicts(gateOutput);
  if (all.length === 0) return null;
  return all.reduce((w, v) => (order[v.verdict] > order[w.verdict] ? v : w), all[0]);
}

/**
 * PURE. #429: is this entry the KIND of gate the appendix's "Most recent conformance check result" row
 * actually means -- a conformance run on real pages, whose PASS/FAIL is a claim about the PRODUCT's own
 * accessibility conformance. Every other recorded kind answers a DIFFERENT question with its own
 * PASS/FAIL or none at all: `-e job=promote` decides which TRAINED MODEL ships (a corpus/promotion
 * decision, not a conformance one); `-e job=capture-only`/`fleet-hours` measures throughput and prints no
 * verdict line at all; an ad-hoc operational diagnostic (a fleet-access postmortem, a PDF-render refusal,
 * a runway-window measurement) is not a gate run in this sense either. #429's own demonstration is
 * exactly a `promote` PASS recorded an hour after a `rules-real-pages` FAIL displacing it on the appendix
 * -- BOTH carry a verdict, so "does it carry a verdict" alone is necessary but not sufficient, which is
 * why this exists as its own, narrower question rather than folding into `worstVerdict`.
 *
 * `job=rules-real-pages` NAMED DIRECTLY rather than inferred, because inferring "conformance" from
 * anything else recorded on an entry (its note, its output's wording) risks being the exact wrong-taxonomy
 * mistake this row's own "What this row is NOT" warns against. The job name is this project's own stable
 * identifier for the one check that scores real pages against the shipped rules -- `ansible/lab-job.yml`'s
 * own catalogue -- and is a fact about WHICH CHECK RAN, not an interpretation of what it said.
 *
 * #1539: THE RELEASE GATE RUNS THE SAME CHECK AS ITS STAGE 11, and a record of that stage is the same reading. On
 * 2026-09-14 the lab release gate at `8efe61c413ba` read `PASS — all 86 of 86` in stage 11 (`rules:real-pages`),
 * recorded as `-e job=release-gate`, and this slot could not select it: a release-gate PASS would have lost to an
 * older standalone `rules-real-pages` FAIL had no separate run followed. It counts when its output is EXACTLY that
 * one stage -- see `isRulesRealPagesStage`.
 *
 * @param {any} gate
 * @returns {boolean}
 */
export function isConformanceGate(gate) {
  // THE NAME ENDS AT WHITESPACE OR THE END -- never at `\b`, which let `rules-real-pages-update` through: the
  // catalogue job that REWRITES the baseline, sharing the verdict contract, so its PASS took the slot
  // (worker-capture's review of #946). A quoted value (`job="rules-real-pages"`) is the same job.
  return /(?:^|\s)-e\s+job=(["']?)rules-real-pages\1(?=\s|$)/.test(String(gate?.command ?? ""))
    || (/(?:^|\s)-e\s+job=(["']?)release-gate\1(?=\s|$)/.test(String(gate?.command ?? ""))
      && isRulesRealPagesStage(gate?.output));
}

/** npm's own banner for each script it runs: `> <package>@<version> <script>`, one line per `npm run`. */
const NPM_SCRIPT_BANNER = /^> [^\s@]+@\S+ (\S+)$/gm;

/**
 * PURE. #1539: is this output ONE `rules:real-pages` stage and nothing else?
 *
 * Read from npm's banner -- WHICH SCRIPT RAN, the same kind of fact the job name above is -- never from the
 * verdict's wording. Exactly one banner, and it names `rules:real-pages` (the whole name, so
 * `rules:real-pages-update` is not it). A whole multi-stage journal is refused rather than read: the appendix
 * renders `worstVerdict` over the ENTIRE output, so another stage's FAIL would be printed as the conformance
 * result. Keeping the slot on an older standalone reading is the safe direction; mislabelling is not.
 *
 * @param {string | undefined} output
 * @returns {boolean}
 */
export function isRulesRealPagesStage(output) {
  const scripts = [...String(output ?? "").matchAll(NPM_SCRIPT_BANNER)].map((m) => m[1]);
  return scripts.length === 1 && scripts[0] === "rules:real-pages";
}

/**
 * PURE. #429: the newest CONFORMANCE gate that actually carries a verdict a reader can be told about --
 * never the newest entry of ANY kind. Picking "newest by `at`" across every recorded kind is exactly how
 * a promotion recorded an hour after a conformance run silently replaced its verdict on the page the
 * board reads (demonstrated on this row's own issue): adding one newer entry of a DIFFERENT KIND flipped
 * the appendix from FAIL to PASS with nothing wrong in either entry. See `isConformanceGate`'s own header
 * for what a gate IS here and why `promote`/throughput/diagnostic entries never compete for this slot.
 *
 * @param {any[]} gates
 * @returns {any | null}
 */
export function latestVerdictGate(gates) {
  const candidates = gates.filter(
    (/** @type {any} */ g) => isConformanceGate(g) && worstVerdict(g.output) !== null);
  return candidates.sort((/** @type {any} */ a, /** @type {any} */ b) => Date.parse(b.at) - Date.parse(a.at))[0]
    ?? null;
}
