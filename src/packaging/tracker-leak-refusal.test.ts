/**
 * #891: nothing checked what got written to GitHub -- the tree-wide guard runs on tracked FILES at push
 * time, and a tracker body is neither. `product-manager`'s own sweep, run with the tree guard's OWN
 * predicate (`allLeaksIn`), found four issue bodies and four comments carrying a named SSH key file --
 * NOT the address anybody's hand-rolled sweep was grepping for, which is the whole argument for calling
 * the shared predicate rather than writing a second one: the second copy is always narrower than the
 * first.
 *
 * Every writer wrapper -- `row-file` (`fileRefusalReason`), `pr-open`/`pr-edit` (`checkBody`),
 * `tracker-comment` (`editRefusal`) -- now calls `leakRefusalReason` (in `leak-patterns.mjs`, beside
 * `allLeaksIn`) BEFORE its own `gh` call. This file proves the wiring, not a second copy of the
 * predicate.
 *
 * `ceo`'s ruling on the one design question the row could not defer: a tracker body has no file, so the
 * tree's `(file, value)` EXEMPT table (`tracked-source-leak-guard.test.ts:120-145`) does not transfer.
 * The tracker instead gets exactly ONE value-class exemption -- UTM's local VM bridge's own /24 --
 * documented twice in CLAUDE.md's own `capture:check --worker=` command -- applied ONLY inside
 * `leakRefusalReason`, never inside `allLeaksIn` itself, so the tree-wide guards stay exactly as they
 * were (see the tests below that prove `allLeaksIn` still flags that address, unfiltered).
 *
 * THIS FILE'S OWN FIXTURES ARE BUILT VIA `ipv4(...)`, NEVER A LITERAL FOUR-OCTET STRING -- a fixture
 * cannot name itself: this is a tracked `.ts` file, so `tracked-source-leak-guard.test.ts`'s own
 * repo-wide sweep walks it too, and a private-LAN-shaped literal sitting in its source text would trip
 * that guard the moment this file is committed. Building the value at runtime keeps every fixture here
 * inert to that unrelated sweep without adding a single (file, value) EXEMPT entry to a file this row's
 * own Region deliberately leaves untouched.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { LEAK_PATTERNS, allLeaksIn, leakRefusalReason } from "./leak-patterns.mjs";
import { fileRefusalReason, createIssue } from "../../../../scripts/row-file.mjs";
import { checkBody } from "../../../../scripts/pr-open.mjs";
import { editRefusal, editComment, digest } from "../../../../scripts/tracker-comment.mjs";

const NEVER_RUN = () => { throw new Error("must never RUN a command for a body this test expects refused"); };

/** See this file's own header: never write a matching four-octet literal directly. */
const ipv4 = (a: number, b: number, c: number, d: number): string => [a, b, c, d].join(".");

const COMPLETE_ROW_BODY = "## Region\n\npackages/lab/src/packaging/foo.ts\n\n"
  + "## Acceptance\n\n```\nnpx tsx --test x\n```\n\n"
  + "## Open-check\n\n```\ngh issue view 735 --json state\n```\n";

/** A synthetic sample of each `LEAK_PATTERNS` shape, one leaking line each. */
const SAMPLE_LINE: Record<string, string> = {
  "private LAN IPv4 address": `reach the page server at ${ipv4(10, 20, 30, 40)}`,
  "a named SSH private key file": "load ~/.ssh/a11y-fixture_ed25519 first",
  "a live pct exec container-hop command": "run pct exec 121 -- bash -lc 'echo hi'",
};

// --- leakRefusalReason: all three patterns, named line and value, documentation ranges silent ---

test("#891 MUTATION: each of LEAK_PATTERNS fires through leakRefusalReason on a synthetic leak of its "
  + "own shape -- not just the address anybody's hand-rolled sweep greps for", () => {
  for (const { name } of LEAK_PATTERNS) {
    const sample = SAMPLE_LINE[name];
    assert.ok(sample, `no synthetic sample defined for "${name}" -- add one so this stays proven`);
    const reason = leakRefusalReason(`some body text\n${sample}\nmore text`);
    assert.ok(reason, `leakRefusalReason did not fire on "${name}"'s own shape`);
    assert.match(reason!, new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      `the refusal for "${name}" must name the pattern that fired`);
  }
});

test("#891 leakRefusalReason: names the offending line and the matched value", () => {
  const address = ipv4(10, 20, 30, 40);
  const body = "Intro paragraph, nothing wrong here.\n\n"
    + `The worker answered at ${address} during the run.\n\nMore prose after it.`;
  const reason = leakRefusalReason(body);
  assert.match(reason!, new RegExp(address.replace(/\./g, "\\.")),
    "the matched value must appear in the refusal");
  assert.match(reason!, new RegExp(`The worker answered at ${address.replace(/\./g, "\\.")} during the run\\.`),
    "the offending line itself must appear, so a filer can find it without re-deriving the match");
  assert.match(reason!, /documentation range/i, "must say the documentation ranges are allowed");
});

test("#891 leakRefusalReason: a clean body is null -- nothing to refuse", () => {
  assert.equal(leakRefusalReason(COMPLETE_ROW_BODY), null);
});

test("#891: the documentation ranges stay silent, exactly as `allLeaksIn` already guarantees -- "
  + "a TEST-NET-1 address must never fire, or the documentation ranges have been broken", () => {
  const docExample = ipv4(192, 0, 2, 10);
  assert.equal(leakRefusalReason(`see ${docExample} here`), null);
  assert.deepEqual(allLeaksIn(docExample), []);
});

// --- the tracker's own value-class exemption, applied ONLY inside leakRefusalReason ---

test("#891 ACCEPTANCE: ceo's ruling -- the local VM bridge (UTM's own, CLAUDE.md's documented command) "
  + "is silent through leakRefusalReason", () => {
  const bridge = ipv4(192, 168, 64, 4);
  const body = `Run \`npm run capture:check -- --worker=http://${bridge}:8765\` to verify.`;
  assert.equal(leakRefusalReason(body), null,
    "the tracker's value-class exemption must cover this exact address, or every row quoting CLAUDE.md's "
    + "own documented command would be refused");
});

test("#891 ACCEPTANCE, MUTATION TARGET: the exemption is applied ONLY inside leakRefusalReason -- "
  + "allLeaksIn itself, which the tree-wide guards drive unfiltered, still flags the SAME address", () => {
  const bridge = ipv4(192, 168, 64, 4);
  assert.deepEqual(allLeaksIn(bridge), [{ name: "private LAN IPv4 address", value: bridge }],
    "allLeaksIn must stay exactly as the tree-wide guards need it -- a tracker-only exemption filtered "
    + "in here, rather than into the shared predicate, would silently widen what the tree itself accepts");
});

test("#891: the exemption is the narrowest unit that buys it -- one /24, not the wider 192.168/16", () => {
  const justOutside = ipv4(192, 168, 65, 4); // one /24 over from the exempt bridge
  const reason = leakRefusalReason(`reach it at ${justOutside}`);
  assert.ok(reason, "the neighbouring /24 is NOT the exempt bridge and must still be flagged");
  assert.match(reason!, new RegExp(justOutside.replace(/\./g, "\\.")));
});

test("#891: the positive control from the row's own history -- the broadcast address of 10/8, "
  + "address-shaped but never a real host -- is still refused (it is outside the exempt /24 by "
  + "construction: only the UTM bridge's own /24 is exempt)", () => {
  const broadcast = ipv4(10, 255, 255, 255);
  const reason = leakRefusalReason(`the control value is ${broadcast}`);
  assert.ok(reason, "a positive control must be shaped like the thing and cannot be exempted as if it "
    + "were the documented VM bridge -- proving the exemption is scoped to that one /24 alone");
});

// --- #891 ACCEPTANCE: the predicate is imported, never restated -- each wrapper agrees with allLeaksIn ---

test("#891 ACCEPTANCE: row-file's fileRefusalReason names the SAME matched value allLeaksIn produces", () => {
  const body = `${COMPLETE_ROW_BODY}\nSeen at ${ipv4(10, 20, 30, 40)} in the run output.\n`;
  const [leak] = allLeaksIn(body.replace(/\s+/g, " "));
  const reason = fileRefusalReason(body);
  assert.ok(reason);
  assert.match(reason!, new RegExp(leak.value.replace(/\./g, "\\.")),
    "row-file's own refusal must quote the exact value the shared predicate matched, not a re-derived one");
});

test("#891 ACCEPTANCE: no issue is ever created for a leaking body, even with --session= present and "
  + "every template section complete -- spawnGh is NEVER called", () => {
  const argv = ["--title", "a real row", "--body",
    `${COMPLETE_ROW_BODY}\nSeen at ${ipv4(10, 20, 30, 40)} in the run output.\n`, "--session=worker-config"];
  let called = false;
  const code = createIssue(argv, { spawnGh: () => { called = true; return "https://x/issues/1"; } });
  assert.equal(code, 1);
  assert.equal(called, false, "gh issue create must never run when the body carries a leak");
});

test("#891 ACCEPTANCE: pr-open's checkBody refuses a leaking body and never runs the real Acceptance "
  + "command from it", () => {
  const body = "## Acceptance\n\n```\ntrue\n```\n\nSSH key at ~/.ssh/deploy_ed25519.\n\nCloses #1\n";
  const result = checkBody(body, { run: NEVER_RUN });
  assert.equal(result.ok, false);
  assert.match(result.lines.join("\n"), /a named SSH private key file/);
});

test("#891 ACCEPTANCE: tracker-comment's editRefusal refuses a leaking `next`, independent of --expect", () => {
  const refusal = editRefusal({ current: "old text", expect: undefined,
    next: "run pct exec 121 -- diagnose" });
  assert.ok(refusal);
  assert.match(refusal!, /pct exec/);
});

test("#891 ACCEPTANCE: no comment is ever PATCHed for a leaking replacement, even with a correct --expect "
  + "digest -- the PATCH call is never reached", () => {
  const calls: string[][] = [];
  const run = (args: string[]) => {
    calls.push(args);
    return JSON.stringify({ id: 1, body: "old text" });
  };
  const result = editComment(1, { next: "run pct exec 121 -- diagnose", expect: digest("old text"), run });
  assert.equal(result.written, false);
  assert.ok(!calls.some((c) => c.includes("PATCH")), "no PATCH call may be issued for a leaking body");
});

// --- #891 MUTATION: the check is load-bearing -- with the shared predicate emptied, detection stops too ---

test("#891 MUTATION TARGET: with LEAK_PATTERNS emptied, leakRefusalReason goes silent on a REAL leak -- "
  + "proving it has no second, independent check of its own", () => {
  const address = ipv4(10, 20, 30, 40);
  const saved = LEAK_PATTERNS.splice(0, LEAK_PATTERNS.length);
  try {
    assert.equal(leakRefusalReason(`the page server is at ${address}, and ~/.ssh/deploy_ed25519 too`),
      null, "with the shared predicate neutered, every leak must go undetected here as well");
  } finally {
    LEAK_PATTERNS.splice(0, LEAK_PATTERNS.length, ...saved);
  }
  // Restored -- the same real leak must be caught again, proving the splice above did not leave the
  // shared array (and therefore the tree-wide guards) permanently narrowed.
  assert.ok(leakRefusalReason(`the page server is at ${address}`));
});
