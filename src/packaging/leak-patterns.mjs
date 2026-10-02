// @ts-check
/**
 * What a public repo must never carry in tracked prose: real internal addresses, named SSH key files, and
 * the retired `pct exec` container-hop idiom (ADR 0013). This repo went public on 2026-09-06.
 *
 * ONE set, shared by every leak guard in this repo. `.agent-org/roles/memory/nvda-worker-vm-access.md`'s own
 * guard (`roles-memory.test.ts`) and this repo-wide sweep (`tracked-prose-leak-guard.test.ts`) both drive
 * these — never a second, independently-typed copy of the same three regexes, which is exactly the
 * "a fact stated twice, and the copies drifted" shape this repo's own CLAUDE.md names as its most
 * expensive recurring defect.
 */

/** @type {Array<{ name: string; pattern: RegExp }>} */
export const LEAK_PATTERNS = [
  // A REAL IPv4 address has FOUR octets. This used to read `(?:10|192\.168|172\...)\.\d{1,3}\.\d{1,3}`,
  // which requires only THREE for the bare-`10` branch — `10` plus two more groups is `10.x.y`, one
  // octet short of an address, and `\b` after the second `\d{1,3}` is satisfied by any non-word
  // character (a `.` included), so the pattern happily stopped there instead of continuing. Found
  // widening #86's sweep to every tracked file rather than an extension allowlist: an Intel driver INF's
  // Windows platform-version decorations (`NTamd64.10.0.1..17763`) and ordinary npm semver
  // (`package-lock.json`'s `"10.0.0"`) both satisfy three octets and neither is an address. Each branch
  // now spells its own full four-octet shape rather than sharing one truncated suffix.
  { name: "private LAN IPv4 address", pattern:
    /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b/ },
  { name: "a named SSH private key file", pattern: /~?\/?\.ssh\/[\w.-]+_ed25519\b|~?\/?\.ssh\/id_\w+\b/ },
  // #1875: the control plane's GitHub token file, beside the fleet key and guarded for the same reason --
  // where a credential sits on a real box is somebody's infrastructure written down. The code that reads
  // it (`fleet-playbook.mjs`'s `GH_TOKEN_FILE`) is outside every population this set is swept over in prose.
  { name: "a named credential file on a fleet host", pattern: /\.config\/a11y-witness\/[\w.-]+/ },
  { name: "a live pct exec container-hop command", pattern: /\bpct exec \d/ },
];

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
  for (const { name, pattern } of LEAK_PATTERNS) {
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

/**
 * EVERY SCRIPT THAT SENDS A BODY TO GITHUB — the declared population, #1053.
 *
 * A list a human edits deliberately, beside a walk that fails on a script carrying a body flag and absent
 * from it. **Prose does not fail when a fourth writer appears**, which is what `tracker-leak-refusal.test.ts`
 * named three writers in until this row.
 *
 * Measured 2026-09-12: eleven scripts spawn `gh` with a body flag; #1052 guarded three of them and eight
 * sent a body nothing had checked. None demonstrably carried a leak — every one composes its body from
 * computed values — so this is not a live hole. **It is filed because the class was stated as closed and
 * was not, and the statement is what the next person reads.**
 *
 * The guard is REACHABILITY, not text: a writer is guarded when its local-import closure reaches this
 * module, because five spawn helpers serve these eleven writers and guarding a helper covers its consumers
 * and every call added to them tomorrow. A `grep` for the function name would report four correctly
 * guarded writers as unguarded — the same defect as counting writers by the shape of their `gh` call.
 * BARE NAMES, NOT PATHS, and that is not cosmetic. `spawned-paths.test.ts` refuses a repo-relative program
 * path in source, because a program spawned by one breaks when the cwd moves -- a real defect, whose check
 * is "a string that looks like a path to a script". **This list is eleven such strings that are never
 * spawned**, so it fired eleven times on a declaration. The remedy it names (resolve from
 * `import.meta.url`) would turn a readable list into eleven absolute paths for no gain, so the string the
 * guard matches is removed instead of argued with: the walk prefixes `TRACKER_WRITER_DIR`.
 *
 * *The thing declared is not the thing done* -- and a checker that cannot tell a declaration from an
 * invocation is right to be shallow and wrong to be obeyed literally. (worker-judge, on #1066.)
 * @type {Readonly<string[]>}
 */
export const TRACKER_WRITERS = Object.freeze([
  "board-report.mjs",
  "board-schedule-liveness.mjs",
  "board-summary-check.mjs",
  "carry-branch.mjs",
  "close-rows-for-merged-pr.mjs",
  "fleet-gated-nightly.mjs",
  "npm-token-liveness.mjs",
  // #2126: B2's review-health clause posts the review DISPUTE on the row it labels `answer:ceo`, so this
  // rule module became a body sender. It reaches this guard through `merge-guard/lookups.mjs`'s own `gh`
  // helper, which is the reachability the second test asserts -- the call site adds nothing.
  "own-pr-health-rule.mjs",
  "pr-open.mjs",
  "row-claim.mjs",
  "row-file.mjs",
  "stranded-branches.mjs",
  "tracker-comment.mjs",
  // #2470: `performRelease` comments on the row it takes a claim back from, so the tick's performer became a body sender. It
  // reaches this guard through its own `guardedGh`, which is the reachability the second test asserts.
  "wake.mjs",
]);

/** Where a declared writer may live. The prefixes are here so the registry above holds no path-shaped
 * string -- the reason stated above, unchanged. TWO roots since the org tooling moved to
 * `@a11ign/agent-org`: ten of the eleven writers went with it and `npm-token-liveness.mjs` did not,
 * because it guards the publish token rather than the tracker. A single prefix would have silently
 * stopped finding whichever one it did not name. */
export const TRACKER_WRITER_DIRS = Object.freeze([
  "packages/agent-org/src/", "scripts/",
  // #2126: THREE roots now, for the reason the paragraph above gives about two. `own-pr-health-rule.mjs`
  // lives a directory deeper than every other declared writer, and the registry holds BARE NAMES -- so
  // `row-claim/own-pr-health-rule.mjs` cannot go in the list without reintroducing the path-shaped string
  // that fired `spawned-paths.test.ts` eleven times. The prefix carries the directory instead.
  "packages/agent-org/src/row-claim/",
]);

/**
 * Does this source text spawn `gh` with a body flag? The population predicate, keyed on the FLAG.
 *
 * Not on the call's shape, for the reason `bodyFromArgv` gives: a shape match missed two of the three
 * writers that were already guarded. `--body-file` counts even though `bodyFromArgv` will not read it —
 * a writer sending a file is still a writer, and it must check the text before it writes the file.
 * @param {string} text
 * @returns {boolean}
 */
export function sendsABody(text) {
  return /"--body"|"--body-file"|["\x27]-f["\x27],\s*[`"\x27]body=|--body-file=/.test(text);
}
