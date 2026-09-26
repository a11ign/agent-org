// @ts-check
// THE TOOL'S LEAK POLICY (#2658, child 3g of #69; ADR 0040, decision 4). SPLIT from `packages/lab/src/packaging/leak-patterns.mjs` at cd4bdb7dc,
// which the product keeps whole: this is NOT a byte copy, and `agent-org-outward-edges.test.ts` pins what it is instead.
//
//   - the TWO GENERIC patterns stay here, because they are true of any public repository: a private LAN IPv4 address and a named SSH private
//     key file. They are the floor every project gets.
//   - the TWO a11ign-SPECIFIC ones (`.config/a11y-witness/...`, a live `pct exec`) moved to `.agent-org/project.json`'s `leakPatterns`, read
//     through `project-config.mjs`, so a project that is not a11ign is not held to a11ign's paths and a11ign is held to exactly the four it
//     was. The union of the two lists equals the product's set, which the test asserts by name and by source.
//   - `allLeaksIn`, `leakRefusalReason`, `bodyFromArgv` and `assertNoLeakInArgv` are the original's text, unchanged; the two declared-writer
//     registries (`TRACKER_WRITERS`, `TRACKER_WRITER_DIRS`) and `sendsABody` are the PRODUCT's guards over which of ITS scripts send a body
//     and stay in its file, because no tool module reads them.
//   - the LAN exemption below (`192.168.64.`, UTM's host-only bridge) is a11ign's too and stays in the function that applies it, because moving
//     it into the declaration would change what a refusal decides; it is the next thing a later row of #69 moves, and it is named here so it
//     is found rather than rediscovered.
//
// THE DECLARATION IS READ WHEN A BODY IS CHECKED, NOT WHEN THIS FILE IS IMPORTED. `board-data.mjs`, `wake.mjs` and eight more import this, and
// several tests copy an import closure into a scratch directory that has no `.agent-org/project.json`; a read at import would refuse there
// for a reason that has nothing to do with the test.

import { homeProjectDeclaration } from "../project-config.mjs";

/**
 * The two patterns true of any public repository. The IPv4 branches each spell a FULL four-octet shape: an earlier form required only three
 * for the bare-`10` branch and matched an Intel driver INF's platform-version decoration and ordinary npm semver, neither of which is an address.
 * @type {ReadonlyArray<{ name: string; pattern: RegExp }>}
 */
export const GENERIC_LEAK_PATTERNS = Object.freeze([
  { name: "private LAN IPv4 address", pattern:
    /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b/ },
  { name: "a named SSH private key file", pattern: /~?\/?\.ssh\/[\w.-]+_ed25519\b|~?\/?\.ssh\/id_\w+\b/ },
]);

/**
 * EVERY pattern this project's prose is held to: the tool's generic two, then the project's own from its declaration.
 * @returns {Array<{ name: string; pattern: RegExp }>}
 */
export function leakPatterns() {
  const own = homeProjectDeclaration().leakPatterns.map(({ name, pattern }) => ({ name, pattern: new RegExp(pattern) }));
  return [...GENERIC_LEAK_PATTERNS, ...own];
}

/**
 * Every match of every pattern in COLLAPSED text, unfiltered by any exemption — the caller applies its
 * own (file, value) allowlist. Shared so `tracked-prose-leak-guard.test.ts` (`.md`) and
 * `tracked-source-leak-guard.test.ts` (`.mjs/.ts/.py/.ps1/.sh/.yml`, #83) walk different populations
 * through the identical matching logic, rather than two copies that can drift.
 *
 * @param {string} text already collapsed (`.replace(/\s+/g, " ")`) so a match split across a hard-wrapped
 *   line is not missed.
 * @returns {Array<{ name: string; value: string }>}
 */
export function allLeaksIn(text) {
  const found = [];
  for (const { name, pattern } of leakPatterns()) {
    const global = new RegExp(pattern.source, "g");
    for (const match of text.matchAll(global)) found.push({ name, value: match[0] });
  }
  return found;
}

/**
 * #891: THE TRACKER'S OWN value-class exemption -- narrower than, and separate from, the tree's
 * `(file, value)` EXEMPT table (`tracked-source-leak-guard.test.ts:120-145`), which a tracker body cannot
 * use at all (it has no file to key on). UTM's local VM host-only bridge, documented TWICE in CLAUDE.md
 * as the `npm run capture:check -- --worker=http://192.168.64.x:8765` command, and reachable from nowhere
 * but the single Mac it runs on.
 *
 * `ceo`'s ruling, 2026-09-09: this ONE `/24`, and nothing broader. A value-class exemption is weaker than
 * the tree's key -- the tree can say "this value, in this file" and still catch the SAME value appearing
 * somewhere new; a tracker body exempts the value everywhere it appears, a real loss of resolution taken
 * deliberately because the alternative (refusing every row that quotes CLAUDE.md's own documented
 * command) is a guard people route around. Widening it is a finding for `ceo`, never a local tweak --
 * #705's own lesson is that a broad `EXEMPT` entry is the failure this class produces, not the fix.
 */
const TRACKER_EXEMPT_IPV4_PREFIX = "192.168.64.";

/**
 * Is `value` inside the tracker's one exempt `/24`? String-prefixed rather than full CIDR arithmetic --
 * the ruling is exactly one `/24` on a `192.168.` octet pair the pattern already requires, so the third
 * octet is the only thing left to check, and a literal prefix says so without inventing a general-purpose
 * subnet calculator this repo has no other use for.
 * @param {string} value
 * @returns {boolean}
 */
function isTrackerExemptAddress(value) {
  return value.startsWith(TRACKER_EXEMPT_IPV4_PREFIX);
}

/**
 * #891: THE ONE PLACE that decides whether a body may reach GitHub at all. Every writer wrapper
 * (`row-file`, `pr-open`/`pr-edit`, `tracker-comment`) calls this before its own `gh` call, never a
 * second hand-rolled pattern -- the argument tonight's redaction sweep made directly: a hand-rolled sweep
 * for "addresses" found one of `LEAK_PATTERNS`' three categories and missed the other two (named SSH key
 * files, all four hits) entirely, because the second copy is always narrower than the first.
 *
 * Checked LINE BY LINE, not on the whole collapsed body: the refusal has to name a line a filer can find
 * and fix, and a tracker body is typed prose, not a hard-wrapped Markdown file where a match could
 * legitimately span a line break (the reason `allLeaksIn`'s own callers collapse a whole FILE first).
 * Each line is still whitespace-collapsed on its own, so a leak split across incidental double spaces
 * within one line is not missed.
 *
 * `null` means the body is clear to send.
 *
 * @param {string} body
 * @returns {string | null}
 */
export function leakRefusalReason(body) {
  /** @type {Array<{ line: string; leak: { name: string; value: string } }>} */
  const offenders = [];
  for (const line of body.split("\n")) {
    for (const leak of allLeaksIn(line.replace(/\s+/g, " "))) {
      if (leak.name === "private LAN IPv4 address" && isTrackerExemptAddress(leak.value)) continue;
      offenders.push({ line, leak });
    }
  }
  if (offenders.length === 0) return null;
  const named = offenders
    .map(({ line, leak }) => `  ${leak.name}: "${leak.value}"\n    in: ${line.trim()}`)
    .join("\n");
  return "REFUSING -- this body carries what looks like a real internal detail, and nothing has checked "
    + `the tracker for one before now (#891):\n${named}\n`
    + "The documentation ranges (192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24) and the local VM bridge's "
    + "own /24 (192.168.64.x, CLAUDE.md's documented `capture:check --worker=` command) are allowed and "
    + "never flagged. Replace the real value above and try again.";
}

/**
 * The body a `gh` argv carries, or `null` when it carries none — #1053.
 *
 * KEYED ON THE BODY FLAG, NEVER ON THE CALL'S SHAPE. worker-judge's first count of the writer population
 * matched a `gh` argv by shape and **missed two of the three writers #1052 had already guarded**, because
 * `pr-open` builds `pr create` elsewhere and `tracker-comment` uses `gh api -f body=`. A guard whose
 * population is defined by how a call is written is routed around by writing the next one differently.
 *
 * `--body-file` is deliberately NOT read from disk here: this is a pure function of the argv, and a writer
 * passing a file passes a path this cannot see. Those writers check the body themselves before building
 * the argv (that is what `pr-open` does), so the file case is covered where the text exists.
 * @param {string[]} args
 * @returns {string | null}
 */
export function bodyFromArgv(args) {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--body" && i + 1 < args.length) return args[i + 1];
    // FUSED FORMS, BOTH OF THEM. `gh` takes a body three ways and this saw two: the `-f body=` branch
    // below carried the comment "the value is fused to the key, so a flag-name match alone does not find
    // it", and that sentence is equally true of `--body=<text>` -- which this returned `null` for, so a
    // leaking body went out unchecked. worker-judge, reviewing #1066. No writer uses the fused long form
    // today (every `--body=` in the tree is a script parsing its own argv), so it was not a live leak;
    // it was the row's own thesis one level in, with the next writer two characters away from it.
    if (arg.startsWith("--body=")) return arg.slice("--body=".length);
    // `gh api -f body=<text>`. `-F` is excluded for the same reason as `--body-file`: it names a file.
    if (arg === "-f" && i + 1 < args.length && args[i + 1].startsWith("body=")) {
      return args[i + 1].slice("body=".length);
    }
  }
  return null;
}

/**
 * THROWS if a `gh` argv carries a body with a leak in it — #1053, and it is wired into the SPAWN HELPERS
 * rather than the call sites.
 *
 * Eleven call sites across eight scripts, and five spawn helpers between them: guarding the helper covers
 * every call in its consumers AND every call somebody adds tomorrow, where a per-call-site edit covers
 * exactly the eleven that exist today. That is the difference between fixing the instances and fixing the
 * class, and this repository's most expensive recurring shape is the first one.
 *
 * It THROWS rather than returning a reason because a spawn helper has no other channel: its callers expect
 * output or an exception, and a helper that returned a refusal string would have it written into the
 * tracker as the body.
 * @param {string} cmd
 * @param {string[]} args
 * @returns {void}
 */
export function assertNoLeakInArgv(cmd, args) {
  if (cmd !== "gh") return;
  const body = bodyFromArgv(args);
  if (body === null) return;
  const reason = leakRefusalReason(body);
  if (reason) throw new Error(reason);
}
