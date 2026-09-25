// no-token: gh -- every `gh` and `herdr` here is a stub on PATH or an injected seam; nothing imported reaches the real one
/**
 * `packages/agent-org/src/work-gate.mjs`, #2401 ruling 2: THE DETECTOR that ships with per-PR reviewers.
 *
 * The chairman's ruling was that the token-refresh reading does NOT gate the row -- the credential is valid to
 * 2026-10-03T18:47Z, forcing a refresh could log out live reviewers -- so a failure is DETECTED and RECOVERED
 * instead, and "the first real refresh is the measurement". Both halves are pinned in BOTH DIRECTIONS here, because
 * a detector whose only tests are the failure is satisfied by one that always fires: a healthy reviewer is the
 * positive control for every empty result below.
 *
 * WHICH SIGNAL COULD BE MEASURED (the row asks the writer to say): (a) codex's own auth-failure text WAS obtainable
 * without forcing a refresh -- it is in the installed binary's strings, and the provenance test below re-reads it
 * from that binary where one is installed. What is NOT measured is whether it RENDERS in a pane as written, which
 * needs a live failure; `docs/known-gaps.md` says so. (b) `last_refresh` needs no codex at all and is measured
 * from the credential file's real shape.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync, chmodSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import {
  CAUSES, JUDGMENT_CAUSES, START_CAUSES, CODEX_AUTH_FAILURE_TEXT, CODEX_LOGGED_OUT_SCREEN, REVIEWER_SILENCE_MS, REVIEWER_REGISTRY_FILE,
  REVIEWER_REFRESH_LEDGER_FILE, authFailureShownIn, readLastRefresh, readReviewerRegistry, reviewerAuthFailures,
  reviewerAuthOrders, reviewerAuthTick, refreshLedgerLines, herdrPaneReader, sessionsOwingVerdict,
} from "./work-gate.mjs";
import { profileFor } from "./worker-profile.mjs";

const T0 = Date.UTC(2026, 8, 24, 12, 0, 0);
const MIN = 60_000;
const GATE_ENTRY = fileURLToPath(new URL("./work-gate.mjs", import.meta.url));
const STUB_MODE = 0o755;
const noPane = () => null;
/** One ledger line, as the tests read it back. */
interface Line { type: string; session?: string; lastRefresh?: string; live?: number; firstRecorded?: boolean }
const OWES = (n: number) => ({ session: `reviewer-${n}`, cause: "draft-awaiting-verdict" });

/** The credential's real SHAPE, measured 2026-09-24: `last_refresh` beside the tokens, which no reader may touch. */
const authFile = (lastRefresh: string) => JSON.stringify({ auth_mode: "chatgpt", OPENAI_API_KEY: null,
  tokens: { access_token: "SECRET-DO-NOT-READ", refresh_token: "SECRET-DO-NOT-READ" }, last_refresh: lastRefresh });

function withDir<T>(body: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "reviewer-auth-"));
  try {
    return body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// --- the credential and the registry -------------------------------------------------------------------------

test("#2401: `last_refresh` is read from the credential file's real shape -- and only that field", () => {
  withDir((dir) => {
    const path = join(dir, "auth.json");
    writeFileSync(path, authFile("2026-09-23T18:47:26.390642137Z"));
    assert.equal(readLastRefresh(path), Date.parse("2026-09-23T18:47:26.390Z"), "the nanosecond spelling parses");
    const seen: string[] = [];
    readLastRefresh(path, ((p: string, enc: "utf8") => { seen.push(p); return readFileSync(p, enc); }) as never);
    assert.deepEqual(seen, [path], "it opens the one file and returns a number, never a token");
    assert.equal(typeof readLastRefresh(path), "number");
  });
});

test("#2401: an unreadable or unstamped credential is `null` -- 'could not ask' -- and never a time", () => {
  withDir((dir) => {
    assert.equal(readLastRefresh(join(dir, "missing.json")), null);
    writeFileSync(join(dir, "garbage.json"), "not json");
    assert.equal(readLastRefresh(join(dir, "garbage.json")), null);
    writeFileSync(join(dir, "nostamp.json"), JSON.stringify({ tokens: {} }));
    assert.equal(readLastRefresh(join(dir, "nostamp.json")), null);
    assert.deepEqual(readReviewerRegistry(join(dir, "missing")), {}, "no registry means nothing was started");
    writeFileSync(join(dir, "reg"), "{");
    assert.deepEqual(readReviewerRegistry(join(dir, "reg")), {});
  });
});

// --- signal (a): codex's own text --------------------------------------------------------------------------

test("#2401 (a): codex's auth-failure text is matched verbatim as codex spells it -- and a healthy pane matches none", () => {
  const codexSays = "Your access token could not be refreshed. Please log out and sign in again.";
  assert.equal(authFailureShownIn(`> review #2398\n■ ${codexSays}\n`), "Your access token could not be refreshed");
  assert.equal(authFailureShownIn("Your authentication session could not be refreshed automatically. Please log out and sign in again."),
    "Your authentication session could not be refreshed automatically");
  assert.equal(authFailureShownIn("Failed to refresh token: 401"), "Failed to refresh token");
  // THE POSITIVE CONTROL for every `null` in this file: a pane mid-review reads healthy, and so does no pane at all.
  assert.equal(authFailureShownIn("• Reading packages/agent-org/src/wake.mjs\n› Ask Codex to do anything"), null);
  assert.equal(authFailureShownIn(null), null);
  assert.equal(authFailureShownIn(""), null);
});

// PROVENANCE OF THE FIXTURE, a comment and not an assertion: codex 0.157.0, its TUI started in tmux with a REJECTED
// credential (expired, structurally valid, private CODEX_HOME, 401), 2026-09-25. It does NOT establish what a pane
// that loses its login MID-SESSION renders; that stays unseen (`docs/known-gaps.md` §49).
const LOGGED_OUT_STARTUP = "Welcome to Codex, OpenAI's command-line coding agent\n  Sign in with ChatGPT\n  or connect an API key";

test("#2555 (a): codex's logged-out startup screen is recognised by its welcome line -- and quoting the sign-in phrase is not it", () => {
  assert.equal(authFailureShownIn(LOGGED_OUT_STARTUP), CODEX_LOGGED_OUT_SCREEN.anchor);
  assert.equal(authFailureShownIn(`  ${LOGGED_OUT_STARTUP}\n`), CODEX_LOGGED_OUT_SCREEN.anchor);
  // The four phrases still win where a pane shows one, so their answers are unchanged.
  assert.equal(authFailureShownIn(`${LOGGED_OUT_STARTUP}\nFailed to refresh token: 401`), "Failed to refresh token");
  // FALSE-POSITIVE CONTROLS: a reviewer DISCUSSING the screen, and each half alone, read healthy.
  assert.equal(authFailureShownIn("• The docs say to choose \"Sign in with ChatGPT\" or connect an API key.\n› Ask Codex to do anything"), null);
  assert.equal(authFailureShownIn("Sign in with ChatGPT"), null);
  assert.equal(authFailureShownIn("Welcome to Codex, OpenAI's command-line coding agent"), null);
  // Positive control for those nulls: the same healthy pane as above, and an invented phrase, are absent.
  assert.equal(authFailureShownIn("• Reading packages/agent-org/src/wake.mjs\n› Ask Codex to do anything"), null);
  assert.ok(!LOGGED_OUT_STARTUP.includes("Nothing in codex says this, invented"), "and the fixture can fail: an invented phrase is absent");
});

/** The codex binary this host runs, or `null` -- the provenance of signal (a)'s text is read FROM IT. */
function installedCodexBinary(): string | null {
  const root = join(homedir(), ".codex/packages/standalone/releases");
  if (!existsSync(root)) return null;
  const releases = readdirSync(root).sort();
  const bin = releases.length > 0 ? join(root, releases[releases.length - 1], "bin/codex") : "";
  return existsSync(bin) ? bin : null;
}

test("#2401 (a) PROVENANCE: every phrase the detector matches IS in the installed codex binary -- read from codex, not invented",
  { skip: installedCodexBinary() === null && "no codex binary on this host: the row's reading was taken on the agent host" }, () => {
    const binary = readFileSync(installedCodexBinary() as string).toString("latin1");
    for (const phrase of CODEX_AUTH_FAILURE_TEXT) {
      assert.ok(binary.includes(phrase), `codex's binary carries no "${phrase}" -- a new codex reworded it; re-read and update`);
    }
    assert.ok(!binary.includes("Nothing in codex says this, invented"), "and the check can fail: an invented phrase is absent");
  });

// --- signal (b) and the two-directional core ---------------------------------------------------------------

const FRESH = { "reviewer-2398": { spawnedAt: T0 } };
const facts = (over: Record<string, unknown> = {}) => ({ instances: FRESH, owing: new Set(["reviewer-2398"]),
  lastRefresh: T0 + 5 * MIN, paneText: noPane, now: T0 + 5 * MIN + REVIEWER_SILENCE_MS + MIN, ...over });

test("#2401 (b): a credential refresh AFTER the instance started, with a verdict still owed for longer than the bound, is a failure", () => {
  assert.deepEqual(reviewerAuthFailures(facts() as never),
    [{ session: "reviewer-2398", signals: ["refresh-silence"] }]);
});

test("#2401 (b) CONTROLS: each condition removed, in turn, makes the failure go away -- so the one above is the AND", () => {
  // NO refresh since the instance started: it lived through no refresh, so it has nothing to fail on.
  assert.deepEqual(reviewerAuthFailures(facts({ lastRefresh: T0 - MIN }) as never), []);
  assert.deepEqual(reviewerAuthFailures(facts({ lastRefresh: T0 }) as never), [], "a refresh AT the start is not after it");
  // The credential could not be read: says nothing.
  assert.deepEqual(reviewerAuthFailures(facts({ lastRefresh: null }) as never), []);
  // The verdict is NOT owed (posted, PR waiting to merge): an idle instance is not a failed one.
  assert.deepEqual(reviewerAuthFailures(facts({ owing: new Set() }) as never), []);
  // Inside the bound: a healthy reviewer that refreshed mid-review is still answering.
  assert.deepEqual(reviewerAuthFailures(facts({ now: T0 + 5 * MIN + REVIEWER_SILENCE_MS - 1 }) as never), []);
  assert.deepEqual(reviewerAuthFailures(facts({ now: T0 + 5 * MIN + REVIEWER_SILENCE_MS }) as never), [],
    "exactly at the bound is not past it");
});

test("#2401 (a)+(b): the pane signal needs no bound and no refresh -- and both signals are named on the instance that showed them", () => {
  const sick = () => "Your access token could not be refreshed. Please log out and sign in again.";
  assert.deepEqual(reviewerAuthFailures(facts({ paneText: sick, lastRefresh: null, owing: new Set(), now: T0 }) as never),
    [{ session: "reviewer-2398", signals: ["pane"] }]);
  assert.deepEqual(reviewerAuthFailures(facts({ paneText: sick }) as never),
    [{ session: "reviewer-2398", signals: ["pane", "refresh-silence"] }]);
  // Two instances, one sick: only that one is named -- the healthy one is the positive control for the empty half.
  const two = { ...FRESH, "reviewer-2399": { spawnedAt: T0 } };
  const failures = reviewerAuthFailures(facts({ instances: two, owing: new Set(), lastRefresh: null,
    paneText: (s: string) => (s === "reviewer-2399" ? sick() : "working") }) as never);
  assert.deepEqual(failures.map((f) => f.session), ["reviewer-2399"]);
});

test("#2401: which reviewers OWE a verdict is read from this tick's orders -- reviewer causes to `reviewer-<n>` only", () => {
  const owing = sessionsOwingVerdict([OWES(1), { session: "reviewer-2", cause: "draft-awaiting-verdict" },
    { session: "reviewer-3", cause: "verdict-comment-unreviewed" }, { session: "reviewer-4", cause: "pr-checks-failing" },
    { session: "worker-5", cause: "draft-awaiting-verdict" }, { session: "ceo", cause: "chairman-blocked" }]);
  assert.deepEqual([...owing].sort(), ["reviewer-1", "reviewer-3"],
    "`reviewer-2` is the retired standing pane, and a non-verdict cause owes no verdict");
});

// --- the order --------------------------------------------------------------------------------------------

test("#2401 (Acceptance 3): a reviewer whose `last_refresh` moved while it produced no verdict yields the incident "
  + "order to `ceo`; a healthy reviewer yields none", () => {
  withDir((dir) => {
    writeFileSync(join(dir, REVIEWER_REGISTRY_FILE), JSON.stringify(FRESH));
    writeFileSync(join(dir, "auth.json"), authFile(new Date(T0 + 5 * MIN).toISOString()));
    const late = T0 + 5 * MIN + REVIEWER_SILENCE_MS + MIN;
    const run = () => { throw new Error("herdr is not running"); };
    const failed = reviewerAuthTick({ orders: [OWES(2398)], dir, authFile: join(dir, "auth.json"), now: late, run, log: () => {} });
    assert.equal(failed.length, 1);
    assert.equal(failed[0].session, "ceo");
    assert.equal(failed[0].cause, "reviewer-auth-failed");
    assert.match(failed[0].prompt, /reviewer-2398/);
    assert.match(failed[0].prompt, /RE-LOGIN OF THE REVIEWER'S CODEX ACCOUNT/, "the remedy is named -- it is the chairman's");
    assert.ok(CAUSES.includes(failed[0].cause), "a declared cause, so `wake` can route it");

    // THE POSITIVE CONTROL FOR THE EMPTY HALF: the SAME instance and credential, verdict no longer owed.
    const healthy = reviewerAuthTick({ orders: [], dir, authFile: join(dir, "auth.json"), now: late, run, log: () => {} });
    assert.deepEqual(healthy, [], "a reviewer that owes nothing is healthy whatever the credential did");
    // And the same tick with the refresh BEFORE the instance started.
    writeFileSync(join(dir, "auth.json"), authFile(new Date(T0 - MIN).toISOString()));
    assert.deepEqual(reviewerAuthTick({ orders: [OWES(2398)], dir, authFile: join(dir, "auth.json"), now: late, run,
      log: () => {} }), []);
  });
});

test("#2401: the incident is a JUDGMENT keyed on the failed set and the refresh, so the same failure is not re-asked and a new one is", () => {
  const a = reviewerAuthOrders([{ session: "reviewer-1", signals: ["pane"] }], T0)[0];
  const same = reviewerAuthOrders([{ session: "reviewer-1", signals: ["pane", "refresh-silence"] }], T0)[0];
  const moved = reviewerAuthOrders([{ session: "reviewer-1", signals: ["pane"] }], T0 + MIN)[0];
  const other = reviewerAuthOrders([{ session: "reviewer-1", signals: ["pane"] }, { session: "reviewer-3", signals: ["pane"] }], T0)[0];
  assert.equal(a.causeKey, same.causeKey, "one failed instance, one refresh: one question however many signals");
  assert.notEqual(a.causeKey, moved.causeKey);
  assert.notEqual(a.causeKey, other.causeKey);
  assert.deepEqual(reviewerAuthOrders([], T0), []);
  assert.ok(JUDGMENT_CAUSES.includes("reviewer-auth-failed"));
  assert.ok(!START_CAUSES.includes("reviewer-auth-failed"), "it starts no work, so a drain does not withhold it");
  assert.equal("refusal" in profileFor("reviewer-auth-failed"), false, "and it has a profile, or it cannot be dispatched");
});

// --- the ledger -------------------------------------------------------------------------------------------

test("#2401: EVERY `last_refresh` change is a ledger line with the live-instance count, and a failure is its own line naming the refresh", () => {
  const live = ["reviewer-2398", "reviewer-2399", "reviewer-2400"];
  const first = refreshLedgerLines({ ledger: [], lastRefresh: T0, live, failures: [], now: T0 + MIN });
  assert.deepEqual(first, [{ type: "refresh", at: new Date(T0 + MIN).toISOString(), lastRefresh: new Date(T0).toISOString(),
    live: 3, liveSessions: live, firstRecorded: true }]);
  const ledger = first as never;
  assert.deepEqual(refreshLedgerLines({ ledger, lastRefresh: T0, live, failures: [], now: T0 + 2 * MIN }), [],
    "the same refresh is recorded once, however many ticks read it");
  const failing = refreshLedgerLines({ ledger, lastRefresh: T0, live,
    failures: [{ session: "reviewer-2399", signals: ["refresh-silence"] }], now: T0 + 40 * MIN });
  assert.deepEqual((failing as Line[]).map((l) => [l.type, l.session, l.lastRefresh]),
    [["failure", "reviewer-2399", new Date(T0).toISOString()]], "the failure names the refresh it followed");
  const next = refreshLedgerLines({ ledger: [...first, ...failing] as never, lastRefresh: T0 + 3_600_000, live: live.slice(0, 1),
    failures: [], now: T0 + 3_600_000 });
  assert.deepEqual((next as Line[]).map((l) => [l.type, l.live, l.firstRecorded]), [["refresh", 1, false]]);
  assert.deepEqual(refreshLedgerLines({ ledger: [], lastRefresh: null, live, failures: [], now: T0 }), [],
    "an unreadable credential records nothing rather than a refresh at no time");
  assert.deepEqual(refreshLedgerLines({ ledger: [...first, ...failing] as never, lastRefresh: T0, live,
    failures: [{ session: "reviewer-2399", signals: ["pane"] }], now: T0 + 50 * MIN }), [], "and one failure is one line");
});

test("#2401: the tick appends the ledger file -- one `refresh` line per change, then one `failure` line -- and a broken append still returns the order", () => {
  withDir((dir) => {
    writeFileSync(join(dir, REVIEWER_REGISTRY_FILE), JSON.stringify(FRESH));
    const auth = join(dir, "auth.json");
    writeFileSync(auth, authFile(new Date(T0 + 5 * MIN).toISOString()));
    const run = () => "{}";
    const early = T0 + 6 * MIN;
    reviewerAuthTick({ orders: [OWES(2398)], dir, authFile: auth, now: early, run, log: () => {} });
    reviewerAuthTick({ orders: [OWES(2398)], dir, authFile: auth, now: early + MIN, run, log: () => {} });
    const late = T0 + 5 * MIN + REVIEWER_SILENCE_MS + MIN;
    reviewerAuthTick({ orders: [OWES(2398)], dir, authFile: auth, now: late, run, log: () => {} });
    reviewerAuthTick({ orders: [OWES(2398)], dir, authFile: auth, now: late + MIN, run, log: () => {} });
    const lines = readFileSync(join(dir, REVIEWER_REFRESH_LEDGER_FILE), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(lines.map((l) => [l.type, l.live ?? l.session]), [["refresh", 1], ["failure", "reviewer-2398"]]);
    assert.ok(!JSON.stringify(lines).includes("SECRET"), "no token reaches the ledger");

  });
});

test("#2401: a ledger that cannot be appended is SAID and the order is still returned -- a detector must not stop the gate", () => {
  withDir((dir) => {
    writeFileSync(join(dir, REVIEWER_REGISTRY_FILE), JSON.stringify(FRESH));
    const auth = join(dir, "auth.json");
    writeFileSync(auth, authFile(new Date(T0 + 5 * MIN).toISOString()));
    mkdirSync(join(dir, REVIEWER_REFRESH_LEDGER_FILE)); // a directory where the ledger file should be
    const said: string[] = [];
    const orders = reviewerAuthTick({ orders: [OWES(2398)], dir, authFile: auth,
      now: T0 + 5 * MIN + REVIEWER_SILENCE_MS + MIN, run: () => "{}", log: (l) => said.push(l) });
    assert.equal(orders.length, 1, "the incident still reaches `ceo`");
    assert.match(said.join(""), /could not append .*reviewer-refreshes/);
  });
});

test("#2401: the pane reader asks herdr for the workspace, then its pane, then the pane's recent output -- and says `null` for anything herdr won't", () => {
  const calls: string[] = [];
  const run = (args: string[]) => {
    calls.push(args.join(" "));
    const said = args.join(" ");
    if (said.endsWith("workspace list")) return JSON.stringify({ result: { workspaces: [{ label: "reviewer-2398", workspace_id: "wR" }] } });
    if (said.includes("pane list --workspace wR")) return JSON.stringify({ result: { panes: [{ pane_id: "wR:p1" }] } });
    if (said.includes("pane read wR:p1")) return "Your access token could not be refreshed.";
    throw new Error("unexpected");
  };
  assert.equal(herdrPaneReader(run)("reviewer-2398"), "Your access token could not be refreshed.");
  assert.ok(calls.some((c) => c.includes("pane read wR:p1 --lines")), calls.join(" | "));
  assert.equal(herdrPaneReader(run)("reviewer-9999"), null, "no such workspace");
  assert.equal(herdrPaneReader(() => { throw new Error("down"); })("reviewer-2398"), null, "herdr down is not an empty pane");
});

// --- THE WIRING, AS A PROCESS -----------------------------------------------------------------------------------
//
// The gate's `main` must call the detector, and a test that injects the seam cannot see a deleted call. This runs the
// real gate against a stub `gh` that lists one GREEN DRAFT with no verdict and a stub `herdr` that shows codex's own
// failure text, in a HOME whose credential and registry say the instance is failing.

test("#2401 THE GATE: `main` emits the incident to `ceo` beside the reviewer's own order, and records the refresh", () => {
  withDir((home) => {
    const bin = join(home, "bin");
    mkdirSync(bin);
    const pr = { number: 9001, isDraft: true, headRefOid: "abc12345deadbeefcafe000011112222",
      statusCheckRollup: [{ name: "ci", status: "COMPLETED", conclusion: "SUCCESS" }],
      author: { login: "worker-judge" }, comments: [], labels: [], files: [], reviews: [] };
    writeFileSync(join(bin, "gh"), `#!/bin/sh\ncase "$*" in\n  "pr list"*) printf '%s' '${JSON.stringify([pr])}' ;;\n  *) printf '%s' '[]' ;;\nesac\n`);
    writeFileSync(join(bin, "herdr"), "#!/bin/sh\ncase \"$*\" in\n  *'workspace list') printf '%s' "
      + "'{\"result\":{\"workspaces\":[{\"label\":\"reviewer-9001\",\"workspace_id\":\"wR\"}]}}' ;;\n"
      + "  *'pane list'*) printf '%s' '{\"result\":{\"panes\":[{\"pane_id\":\"wR:p1\"}]}}' ;;\n"
      + "  *'pane read'*) printf '%s' 'Your access token could not be refreshed. Please log out and sign in again.' ;;\n  *) : ;;\nesac\n");
    chmodSync(join(bin, "gh"), STUB_MODE);
    chmodSync(join(bin, "herdr"), STUB_MODE);
    mkdirSync(join(home, ".cache/a11ign"), { recursive: true });
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(join(home, ".cache/a11ign", REVIEWER_REGISTRY_FILE), JSON.stringify({ "reviewer-9001": { spawnedAt: T0 } }));
    writeFileSync(join(home, ".codex/auth.json"), authFile(new Date(T0 + MIN).toISOString()));
    const ran = spawnSync(process.execPath, [GATE_ENTRY], { encoding: "utf8",
      env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH ?? ""}` } });
    const orders = ran.stdout.split("\n").filter(Boolean).map((l) => JSON.parse(l));
    assert.ok(orders.some((o) => o.session === "reviewer-9001" && o.cause === "draft-awaiting-verdict"),
      `the reviewer's own order is addressed to reviewer-<n>; got ${ran.stdout} ${ran.stderr}`);
    const incident = orders.find((o) => o.cause === "reviewer-auth-failed");
    assert.ok(incident, `the detector ran inside the gate; got ${ran.stdout} ${ran.stderr}`);
    assert.equal(incident.session, "ceo");
    assert.match(incident.prompt, /reviewer-9001 {2}\(pane \+ refresh-silence\)/);
    const ledger = readFileSync(join(home, ".cache/a11ign", REVIEWER_REFRESH_LEDGER_FILE), "utf8");
    assert.match(ledger, /"type":"refresh".*"live":1/);
  });
});
