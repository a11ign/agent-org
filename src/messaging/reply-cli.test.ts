// @ts-check
// `chairman:reply` (a11ign/a11ign#3071 done-whens 1-4): the command that calls `createReply`, and THE EXIT CODE FOR EACH OUTCOME. A command that exits 0 on a
// refusal fails the refused cases below, and one that exits 2 on a send fails the sent ones.
//
// **EVERY "NOT SENT" CASE ASSERTS THREE THINGS: the exit code, that the provider's `sent` is still empty, and that the ledger holds no line it should not.** A
// refusal writes none; a failed send writes the ONE `failed` line; messaging off writes nothing, not even the file. The cases that expect a send assert it holds
// exactly what was said, so a command that refuses everything fails those.
//
// **DONE-WHEN 4 IS A SCAN, AND THE SCAN HAS ITS POSITIVE CONTROL:** `scanProblems` is run over the real file (expecting none) and over synthetic sources that each
// break one rule (expecting that rule), so a scan that finds nothing in everything fails by name.

import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { completionPath, writeCompletion } from "../lib/tick-completion.mjs";
import { createFakeProvider } from "./fake-provider.ts";
import { readLedgerLines } from "./ledger.mjs";
import { EXIT, assertReadOnlyGh, assertReadOnlySystemctl, main } from "./reply-cli.mjs";
import { defaultLedgerPath } from "./state.mjs";

const NOW = Date.parse("2026-10-02T14:05:30Z");
const STAMP = "as of 14:05Z";
const REPO = "a11ign/a11ign";
const TOKEN = "123456:fixture-token";
const CHAT_ID = 4242;
const PRIVATE_MODE = 0o600;
const SOURCE = fileURLToPath(new URL("./reply-cli.mjs", import.meta.url));

const scratch = mkdtempSync(join(tmpdir(), "messaging-reply-cli-"));
after(() => rmSync(scratch, { recursive: true, force: true }));
let nextCase = 0;

/** @param {string} path @param {string} content */
function writePrivate(path: string, content: string) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content, { mode: PRIVATE_MODE });
  chmodSync(path, PRIVATE_MODE);
}

/**
 * A project and a home, as the command finds them: `<root>/.agent-org/project.json` and the secret files under `<home>/.config/agent-org/`.
 * @param {{messaging?: boolean}} [options] `messaging: false` is a project that declares none
 */
function project({ messaging = true }: { messaging?: boolean; } = {}) {
  const base = join(scratch, `case-${nextCase += 1}`);
  const [root, home] = [join(base, "root"), join(base, "home")];
  const declaration = { tracker: [{ key: "", repo: REPO }], ...(messaging ? { messaging: { provider: "telegram", tokenFile: "~/.config/agent-org/token", chairmanFile: "~/.config/agent-org/chairman.json" } } : {}) };
  writePrivate(join(root, ".agent-org", "project.json"), JSON.stringify(declaration));
  writePrivate(join(home, ".config", "agent-org", "token"), `${TOKEN}\n`);
  writePrivate(join(home, ".config", "agent-org", "chairman.json"), JSON.stringify({ userId: 7, chatId: CHAT_ID }));
  return { root, home, ledgerPath: defaultLedgerPath(home) };
}

/** `gh` as the readers call it, over a pull request that merged. Every argv goes through the command's own guard first, as the real runner does. @param {string[]} argv */
async function fixtureGh(argv: string[]) {
  assertReadOnlyGh(argv);
  if (argv[0] === "pr") return JSON.stringify({ reviewDecision: "APPROVED" });
  const path = argv[1];
  if (path.startsWith(`repos/${REPO}/pulls/`)) return JSON.stringify({ number: 2881, state: "closed", merged_at: "2026-10-02T13:00:00Z" });
  if (path.startsWith(`repos/${REPO}/pulls?`)) return JSON.stringify([{ merged_at: "2026-10-02T11:00:00Z" }]);
  if (path.startsWith(`repos/${REPO}/issues?`)) return JSON.stringify([{ number: 1, labels: [{ name: "ready" }] }, { number: 2, labels: [{ name: "ready" }] }]);
  if (path.startsWith(`repos/${REPO}/issues/comments/`)) return JSON.stringify({ body: "Ruled: hold.", html_url: "https://github.com/x/y#c" });
  if (path.startsWith(`repos/${REPO}/issues/`)) return JSON.stringify({ number: 3071, state: "open", labels: [{ name: "ready" }] });
  if (path.startsWith(`repos/${REPO}/actions/runs/`)) return JSON.stringify({ conclusion: "success", status: "completed" });
  throw new Error(`fixture gh: unexpected ${argv.join(" ")}`);
}

/** @param {string[]} argv @returns {Promise<string>} */
async function fixtureSystemctl(argv: string[]): Promise<string> {
  assertReadOnlySystemctl(argv);
  return "ActiveState=active\nLoadState=loaded\n";
}

/**
 * Runs the command with everything injected and collects what it said.
 * @param {string[]} argv
 * @param {{messaging?: boolean, env?: Record<string, string | undefined>, stdin?: string, gh?: typeof fixtureGh, provider?: ReturnType<typeof createFakeProvider>,
 *   providers?: Record<string, any>, fetch?: typeof fetch, home?: string, root?: string, wakeLedgerPath?: () => Promise<string>, inbound?: string[]}} [options] `inbound` seeds the ledger with a message from the chairman
 *   under each ref, which is what `--to` is checked against (`ledger` in the result is what the command wrote AFTER those); with `fetch` given and no `providers`, the command builds the
 *   REAL Telegram provider, which is how the secret-file wiring is exercised; otherwise it is handed `provider`
 */
async function run(argv: string[], { messaging = true, env = { GH_CONFIG_DIR: "/workers/gh" }, stdin = "", gh = fixtureGh, provider = createFakeProvider(), providers, fetch, inbound = [], ...where }: {
    messaging?: boolean; env?: Record<string, string | undefined>; stdin?: string; gh?: typeof fixtureGh; provider?: ReturnType<typeof createFakeProvider>;
    providers?: Record<string, any>; fetch?: typeof fetch; home?: string; root?: string; wakeLedgerPath?: () => Promise<string>; inbound?: string[];
} = {}) {
  const fixture = project({ messaging });
  if (inbound.length > 0) writePrivate(fixture.ledgerPath, inbound.map((messageRef) => `${JSON.stringify({ direction: "in", origin: "converse", messageRef, ackRef: "0", ts: "2026-10-02T14:00:00.000Z" })}\n`).join(""));
  const [root, home] = [where.root ?? fixture.root, where.home ?? fixture.home];
  const [out, err] = [/** @type {string[]} */ ([]), /** @type {string[]} */ ([])];
  const code = await main(argv, {
    root, home, env, now: () => NOW, gh, systemctl: fixtureSystemctl, readStdin: async () => stdin, ...(where.wakeLedgerPath === undefined ? {} : { wakeLedgerPath: where.wakeLedgerPath }),
    ...(fetch === undefined ? { providers: providers ?? { telegram: () => provider } } : { fetch }),
    out: (line) => out.push(line), err: (line) => err.push(line),
  });
  return { code, out: out.join("\n"), err: err.join("\n"), provider, ledger: readLedgerLines(defaultLedgerPath(home)).slice(inbound.length), ledgerPath: defaultLedgerPath(home) };
}

describe("done-when 2: with a fake provider and fixture readers it sends one message and exits 0", () => {
  test("the text argument, re-read at send time, goes out once with the stamp and the reply-to, exit 0", async () => {
    const { code, out, provider, ledger } = await run(["PR #{{pr:2881.number}} is {{pr:2881.state}}", "--to", "77"], { inbound: ["77"] });
    assert.equal(code, EXIT.ok);
    assert.deepEqual(provider.sent.map(({ text, replyTo }) => ({ text, replyTo })), [{ text: `PR #2881 is merged\n\n${STAMP}`, replyTo: "77" }]);
    assert.match(out, /sent fake-1/);
    assert.deepEqual(ledger.map(({ direction, status, replyTo, providerMessageId }) => ({ direction, status, replyTo, providerMessageId })),
      [{ direction: "reply", status: "replied", replyTo: "77", providerMessageId: "fake-1" }]);
  });

  test("with no text argument the text is read from stdin", async () => {
    const { code, provider } = await run([], { stdin: "Row {{issue:3071.state}}\n" });
    assert.equal(code, EXIT.ok);
    assert.deepEqual(provider.sent.map(({ text }) => text), [`Row open\n\n${STAMP}`]);
  });

  test("every placeholder kind is read through the read-only guard, so no reader builds an argv the guard refuses", async () => {
    const text = ["{{issue:3071.state}}", "{{pr:2881.review}}", "{{run:36891064128.conclusion}}", "{{ready.count}}", "{{last-merge.age}}", "{{unit:work-tick.state}}", "{{comment:5.quote}}"].join("|");
    const { code, err, provider } = await run([text]);
    assert.equal(code, EXIT.ok, err);
    assert.match(provider.sent[0].text, /^open\|APPROVED\|success\|2\|3h 5m\|active\|/);
  });
});

describe("done-when 2: with messaging off the command sends nothing and says so", () => {
  test("no `messaging` key: exit 2 (a caller believes it spoke to the chairman), a stderr line saying OFF, no provider built, no ledger file", async () => {
    const { code, err, provider, ledgerPath } = await run(["Row {{issue:3071.state}}"], { messaging: false, providers: { telegram: () => { throw new Error("a provider was built while messaging is off"); } } });
    assert.equal(code, EXIT.refused);
    assert.match(err, /messaging is OFF.*nothing was sent/);
    assert.deepEqual(provider.sent, []);
    assert.equal(existsSync(ledgerPath), false);
  });
});

describe("done-when 3: a refused reply exits 2, names the placeholder or the claim, and writes no ledger line", () => {
  const refusals = /** @type {[string, string, RegExp][]} */ ([
    ["a state word in free text", "PR {{pr:2881.number}} merged", /REFUSED \(free text\): "merged" is a state word outside a placeholder/],
    ["a number in free text", "7 rows are ready", /REFUSED \(free text\): "7" is a number outside a placeholder/],
    ["a row number outside a placeholder", "See #2881", /REFUSED \(free text\): "#2881" is a row or pull request number/],
    ["a placeholder outside the vocabulary", "{{pr:2881.colour}}", /REFUSED \{\{pr:2881\.colour\}\}: .*no field "colour"/],
    ["an empty reply", "", /REFUSED \(free text\): the reply is empty/],
  ]);
  for (const [name, text, message] of refusals) {
    test(`${name}: exit 2, the problem on stderr, nothing sent, no ledger line`, async () => {
      const { code, err, provider, ledger } = await run([text]);
      assert.equal(code, EXIT.refused);
      assert.match(err, message);
      assert.deepEqual(provider.sent, []);
      assert.deepEqual(ledger, []);
    });
  }

  test("a read that fails prints the placeholder AS WRITTEN and the sendable text; exit 2, nothing sent, no ledger line", async () => {
    const gh = async (/** @type {string[]} */ argv: string[]) => {
      if (argv[1]?.startsWith(`repos/${REPO}/pulls/`)) throw new Error("HTTP 502");
      return fixtureGh(argv);
    };
    const { code, err, provider, ledger } = await run(["{{pr:2881.state}} and {{ready.count}}"], { gh });
    assert.equal(code, EXIT.refused);
    assert.match(err, /REFUSED \{\{pr:2881\.state\}\}: .*HTTP 502/);
    assert.doesNotMatch(err, /REFUSED \{\{ready\.count\}\}/);
    assert.match(err, /sendable instead: Could not check, so not stated: \{\{unchecked:pr:2881\.state\}\}/);
    assert.deepEqual(provider.sent, []);
    assert.deepEqual(ledger, []);
  });

  test("opinion under `My read:` is not refused, and the same words above it are", async () => {
    assert.equal((await run(["My read: 7 rows is a lot"])).code, EXIT.ok);
    assert.equal((await run(["7 rows is a lot"])).code, EXIT.refused);
  });
});

describe("done-when 3: a failed send exits 1 and writes the ONE failed line", () => {
  test("the provider throws: exit 1, the cause on stderr, nothing sent, one `failed` ledger line holding the error", async () => {
    const provider = createFakeProvider();
    provider.failNext(new Error("telegram sendMessage failed: 502 bad gateway"));
    const { code, err, ledger } = await run(["Row {{issue:3071.state}}"], { provider });
    assert.equal(code, EXIT.failed);
    assert.match(err, /FAILED.*502 bad gateway/);
    assert.deepEqual(provider.sent, []);
    assert.deepEqual(ledger.map(({ status, direction }) => ({ status, direction })), [{ status: "failed", direction: "reply" }]);
    assert.match(ledger[0].error, /502 bad gateway/);
  });
});

describe("the command refuses to START, with exit 2, rather than guess", () => {
  test("no GitHub account declared: it would read as whoever `gh` last logged in as (#1967); nothing sent, no ledger", async () => {
    const { code, err, provider, ledgerPath } = await run(["Row {{issue:3071.state}}"], { env: {} });
    assert.equal(code, EXIT.refused);
    assert.match(err, /no GitHub account is declared/);
    assert.deepEqual(provider.sent, []);
    assert.equal(existsSync(ledgerPath), false);
  });

  test("an unknown flag is a usage refusal, not a send of the flag as text", async () => {
    const { code, provider } = await run(["--surprise", "hello"]);
    assert.equal(code, EXIT.refused);
    assert.deepEqual(provider.sent, []);
  });

  test("a project.json that cannot be read is MALFORMED, not off", async () => {
    const { code, err } = await run(["x"], { root: join(scratch, "no-such-project") });
    assert.equal(code, EXIT.refused);
    assert.match(err, /MALFORMED/);
  });
});

describe("#3411 `--to` records the inbound message a reply answers, and refuses one nobody sent", () => {
  test("a ref an inbound line holds is written as `replyTo`", async () => {
    const { code, ledger } = await run(["Row {{issue:3071.state}}", "--to=45"], { inbound: ["44", "45"] });
    assert.equal(code, EXIT.ok);
    assert.deepEqual(ledger.map(({ replyTo }) => replyTo), ["45"]);
  });

  test("a ref no inbound line holds is refused (exit 2), nothing is sent and the ledger gains no line", async () => {
    const { code, err, provider, ledger } = await run(["Row {{issue:3071.state}}", "--to", "999"], { inbound: ["44", "45"] });
    assert.equal(code, EXIT.refused);
    assert.match(err, /REFUSED --to 999: no message from the chairman with that ref/);
    assert.deepEqual(provider.sent, []);
    assert.deepEqual(ledger, []);
  });

  test("with no ledger at all every ref is unknown, and the refusal does not create the file", async () => {
    const { code, ledgerPath } = await run(["Row {{issue:3071.state}}", "--to", "1"]);
    assert.equal(code, EXIT.refused);
    assert.equal(existsSync(ledgerPath), false);
  });

  test("omitting `--to` still sends and writes `replyTo: null`", async () => {
    const { code, ledger } = await run(["Row {{issue:3071.state}}"], { inbound: ["45"] });
    assert.equal(code, EXIT.ok);
    assert.deepEqual(ledger.map(({ replyTo }) => replyTo), [null]);
  });
});

describe("#3564 text that looks like a flag is refused, and `--dry-run` does everything but send", () => {
  /** @param {Awaited<ReturnType<typeof run>>} result the three things every not-sent case asserts */
  function assertNothingSent({ code, provider, ledger }: Awaited<ReturnType<typeof run>>) {
    assert.equal(code, EXIT.refused);
    assert.deepEqual(provider.sent, []);
    assert.deepEqual(ledger, []);
  }

  test("`--session=liaison` after a `--` separator, the path argv takes it by, is refused naming the token", async () => {
    const result = await run(["--", "--session=liaison"]);
    assertNothingSent(result);
    assert.match(result.err, /REFUSED "--session=liaison"/);
    assert.match(result.err, /--to <ref>/);
  });

  test("the ledgered text, `--session=liaison` then a blank line then the stamp, arrives by stdin and is refused too", async () => {
    const result = await run([], { stdin: "--session=liaison\n\nas of 20:59Z" });
    assertNothingSent(result);
    assert.match(result.err, /REFUSED "--session=liaison"/);
  });

  test("a flag-shaped word AFTER words is the same mistake: `as of 20:59Z --session=liaison` is refused", async () => {
    const result = await run(["--", "as of 20:59Z --session=liaison"]);
    assertNothingSent(result);
    assert.match(result.err, /REFUSED "--session=liaison"/);
  });

  test("CONTROL: ordinary text still sends, and so do a spaced `--` and a rule of dashes, which are prose and not flags", async () => {
    for (const text of ["as of now", "Thanks -- noted", "---", "wait -- or not"]) {
      const { code, provider, ledger } = await run(["--", text]);
      assert.equal(code, EXIT.ok, text);
      assert.deepEqual(provider.sent.map((message) => message.text), [`${text}\n\n${STAMP}`]);
      assert.equal(ledger.length, 1);
    }
  });

  test("`--dry-run` on a sendable text prints it with what each placeholder resolved to, exits 0, calls no provider and leaves the ledger as it was", async () => {
    const { code, out, provider, ledger, ledgerPath } = await run(["--dry-run", "--", "{{ready.count}} rows are ready"], { inbound: ["77"] });
    assert.equal(code, EXIT.ok);
    assert.match(out, new RegExp(`2 rows are ready\\n\\n${STAMP}`));
    assert.match(out, /\{\{ready\.count\}\} = 2/);
    assert.deepEqual(provider.sent, []);
    assert.deepEqual(ledger, []);
    assert.equal(readLedgerLines(ledgerPath).length, 1, "the ledger holds only the seeded inbound line");
  });

  test("`--dry-run` builds no provider at all, so a probe holds neither the token nor the chat id", async () => {
    const { code } = await run(["--dry-run", "hello"], { providers: { telegram: () => { throw new Error("a dry run built the provider"); } } });
    assert.equal(code, EXIT.ok);
  });

  test("`--dry-run` on a refused text exits 2 and prints the refusal", async () => {
    const flagged = await run(["--dry-run", "--", "--session=liaison"]);
    assertNothingSent(flagged);
    assert.match(flagged.err, /REFUSED "--session=liaison"/);
    const unreadable = await run(["--dry-run", "PR #{{pr:2881.nonsense}}"]);
    assertNothingSent(unreadable);
    assert.match(unreadable.err, /REFUSED/);
  });

  test("`--dry-run` with a `--to` no inbound line holds is refused as a send would be", async () => {
    const { code, err, provider, ledger } = await run(["--dry-run", "hello", "--to", "999"], { inbound: ["77"] });
    assert.equal(code, EXIT.refused);
    assert.match(err, /REFUSED --to 999/);
    assert.deepEqual(provider.sent, []);
    assert.deepEqual(ledger, []);
  });

  test("`--dry-run` still refuses a project that declares no messaging, rather than printing a send that could not happen", async () => {
    const { code, err } = await run(["--dry-run", "hello"], { messaging: false });
    assert.equal(code, EXIT.refused);
    assert.match(err, /messaging is OFF/);
  });
});

describe("the real Telegram provider, built from the configured secret files, with a fake `fetch`", () => {
  /** @param {{ok?: boolean}} [options] @returns {{fetch: typeof fetch, calls: {url: string, body: any}[]}} */
  function fakeTelegram({ ok = true }: { ok?: boolean; } = {}): { fetch: typeof fetch; calls: { url: string; body: any; }[]; } {
    /** @type {{url: string, body: any}[]} */
    const calls: { url: string; body: any; }[] = [];
    const fetchImpl = /** @type {typeof fetch} */ (async (url, init) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify(ok ? { ok: true, result: { message_id: 555 } } : { ok: false, error_code: 400, description: "bad request" }), { status: ok ? 200 : 400 });
    });
    return { fetch: fetchImpl, calls };
  }

  test("one sendMessage to the chairman's chat as a reply, carrying the token; exit 0 and the ledger holds Telegram's message id", async () => {
    const telegram = fakeTelegram();
    const { code, ledger } = await run(["Row {{issue:3071.state}}", "--to", "77"], { fetch: telegram.fetch, inbound: ["77"] });
    assert.equal(code, EXIT.ok);
    assert.equal(telegram.calls.length, 1);
    assert.equal(telegram.calls[0].url, `https://api.telegram.org/bot${TOKEN}/sendMessage`);
    assert.deepEqual(
      { chat_id: telegram.calls[0].body.chat_id, text: telegram.calls[0].body.text, reply: telegram.calls[0].body.reply_parameters?.message_id },
      { chat_id: CHAT_ID, text: `Row open\n\n${STAMP}`, reply: 77 },
    );
    assert.deepEqual(ledger.map(({ status, providerMessageId }) => ({ status, providerMessageId })), [{ status: "replied", providerMessageId: "555" }]);
  });

  test("Telegram refusing the send is `failed`: exit 1, the token is nowhere in what was printed", async () => {
    const { code, err } = await run(["Row {{issue:3071.state}}"], { fetch: fakeTelegram({ ok: false }).fetch });
    assert.equal(code, EXIT.failed);
    assert.match(err, /400 bad request/);
    assert.doesNotMatch(err, new RegExp(TOKEN));
  });

  test("a token file that is not private is refused (exit 2) before any request, and nothing is written", async () => {
    const telegram = fakeTelegram();
    const fixture = project();
    chmodSync(join(fixture.home, ".config", "agent-org", "token"), 0o644);
    const { code, err, ledgerPath } = await run(["Row {{issue:3071.state}}"], { fetch: telegram.fetch, ...fixture });
    assert.equal(code, EXIT.refused);
    assert.match(err, /mode 0644/);
    assert.deepEqual(telegram.calls, []);
    assert.equal(existsSync(ledgerPath), false);
  });
});

describe("#3446 the fleet-watch files and the gate record reach the readers, so {{fleet.*}} and {{gate.*}} can be stated by the real command", () => {
  const MINUTE = 60_000;
  const FACTS = "Up: {{fleet.workers-up}}. Gate: {{gate.last-tick.age}}.";

  /**
   * A project with the two files `fleet-watch` writes under `<root>/runs/` (polled 10 minutes ago) and, unless `gate` is false, a tick that completed 4 minutes ago,
   * recorded beside a wake ledger the injected `wakeLedgerPath` names: the test never resolves the host, and never touches the host's own state directory.
   * @param {{files?: boolean, gate?: boolean}} [options]
   */
  function withHostFiles({ files = true, gate = true }: { files?: boolean; gate?: boolean; } = {}) {
    const fixture = project();
    const wakeLedger = join(fixture.root, "..", "state", "wake-ledger");
    if (files) {
      const wroteAt = NOW - 10 * MINUTE;
      const stamp = { captures: 0, seenAt: wroteAt, lastRoseAt: null, rises: [] };
      const [statePath, capturesPath] = ["fleet-watch-state.json", "fleet-captures-state.json"].map((name) => join(fixture.root, "runs", name));
      mkdirSync(join(fixture.root, "runs"), { recursive: true });
      writeFileSync(statePath, JSON.stringify({}));
      writeFileSync(capturesPath, JSON.stringify({ since: 1, workers: { "worker-a": stamp } }));
      for (const path of [statePath, capturesPath]) utimesSync(path, wroteAt / 1000, wroteAt / 1000);
    }
    if (gate) writeCompletion(completionPath(wakeLedger), { at: NOW - 4 * MINUTE, exit: 0 });
    return { root: fixture.root, home: fixture.home, wakeLedgerPath: async () => wakeLedger };
  }

  test("with the files in place the message states who is up and how long since a tick, and goes out (exit 0)", async () => {
    const { code, err, provider } = await run([FACTS], withHostFiles());
    assert.equal(code, EXIT.ok, err);
    assert.equal(provider.sent[0].text, `Up: worker-a (fleet-watch poll 10m ago). Gate: 4m.\n\n${STAMP}`);
  });

  test("CONTROL for the one above: with the files absent it exits 2 naming the placeholder, sends nothing and writes no ledger line", async () => {
    const { code, err, provider, ledger } = await run([FACTS], withHostFiles({ files: false, gate: false }));
    assert.equal(code, EXIT.refused);
    assert.match(err, /REFUSED \{\{fleet\.workers-up\}\}/);
    assert.match(err, /REFUSED \{\{gate\.last-tick\.age\}\}/);
    assert.deepEqual(provider.sent, []);
    assert.deepEqual(ledger, []);
  });

  test("a host that cannot name the state directory costs {{gate.*}} alone: the diagnostic is on stderr and the fleet and every other placeholder still read", async () => {
    const wakeLedgerPath = async () => { throw new Error("no host resolved"); };
    const gateOnly = await run([FACTS], { ...withHostFiles(), wakeLedgerPath });
    assert.equal(gateOnly.code, EXIT.refused);
    assert.match(gateOnly.err, /could not name the work-tick completion record.*no host resolved/);
    assert.match(gateOnly.err, /REFUSED \{\{gate\.last-tick\.age\}\}/);
    assert.doesNotMatch(gateOnly.err, /REFUSED \{\{fleet\./);
    const fleetOnly = await run(["Up: {{fleet.workers-up}}."], { ...withHostFiles(), wakeLedgerPath });
    assert.equal(fleetOnly.code, EXIT.ok, fleetOnly.err);
    assert.equal(fleetOnly.provider.sent[0].text, `Up: worker-a (fleet-watch poll 10m ago).\n\n${STAMP}`);
  });
});

const SHARED_HELPERS = ["defaultLedgerPath", "accountIsDeclared", "trackerRepo", "readChairman"];

describe("done-when 4: the command reaches no provider but the configured one, and no reader but `createGhReaders`", () => {
  const ALLOWED_IMPORTS = new Set(["node:child_process", "node:fs", "node:os", "node:path", "node:url", "node:util", "../lib/tick-completion.mjs", "./config.mjs", "./ledger.mjs", "./placeholders.mjs",
    "./providers/telegram/send.mjs", "./reply.mjs", "./secret.mjs", "./state.mjs"]);

  /** @param {string} source @returns {string[]} what breaks the done-when, one string per rule broken */
  function scanProblems(source: string): string[] {
    const imports = [...source.matchAll(/^import .* from "([^"]+)";$/gm)].map((match) => match[1]);
    const problems = imports.filter((specifier) => !ALLOWED_IMPORTS.has(specifier)).map((specifier) => `imports ${specifier}`);
    const code = source.split("\n").filter((line) => !line.trimStart().startsWith("//") && !line.trimStart().startsWith("*") && !line.trimStart().startsWith("/**")).join("\n");
    for (const name of SHARED_HELPERS) {
      if (new RegExp(`\\bfunction ${name}\\b`).test(code)) problems.push(`defines ${name} itself, which state.mjs owns`);
    }
    if (!/createGhReaders\(\{ gh, systemctl, repo:/.test(code)) problems.push("does not build its readers with createGhReaders");
    if (/\bcreateGhReader\b/.test(code) || /\bcreateReaders\b/.test(code)) problems.push("builds a reader that is not createGhReaders");
    if (/\bfetch\(|globalThis\.fetch\(|https?:\/\//.test(code)) problems.push("calls the network itself");
    if (/\b(?:spawn|spawnSync|exec|execSync|execFileSync)\(/.test(code)) problems.push("runs a command outside the guarded runners");
    const execFileCalls = code.match(/\bexecFileAsync\(/g) ?? [];
    if (execFileCalls.length !== 1) problems.push(`runs ${execFileCalls.length} execFile calls, not the one inside guardedRunner`);
    for (const runner of ['guardedRunner("gh", assertReadOnlyGh)', 'guardedRunner("systemctl", assertReadOnlySystemctl)']) {
      if (!code.includes(runner)) problems.push(`the default runner ${runner} is not wired`);
    }
    return problems;
  }

  test("the real file breaks no rule", () => {
    assert.deepEqual(scanProblems(readFileSync(SOURCE, "utf8")), []);
  });

  test("positive control: a source that breaks each rule is found, by that rule", () => {
    const real = readFileSync(SOURCE, "utf8");
    /** @type {[string, string, RegExp][]} */
    const mutations: [string, string, RegExp][] = [
      ["another provider", `import { createFakeProvider } from "./fake-provider.ts";\n${real}`, /imports \.\/fake-provider\.ts/],
      ["another reader", `import { createGhReader } from "./watch.mjs";\n${real}`, /imports \.\/watch\.mjs/],
      ["the watcher's reader", real.replace("createGhReaders({ gh,", "createGhReader({ gh,"), /does not build its readers with createGhReaders/],
      ["a local copy of a shared helper", `${real}\nfunction trackerRepo(root) { return root; }\n`, /defines trackerRepo itself/],
      ["its own network call", `${real}\nawait fetch("https://example.com");\n`, /calls the network itself/],
      ["its own command", `${real}\nexecSync("gh pr merge 1");\n`, /runs a command outside/],
      ["an unguarded gh", real.replace('guardedRunner("gh", assertReadOnlyGh)', 'guardedRunner("gh", () => {})'), /default runner guardedRunner\("gh"/],
    ];
    for (const [name, source, expected] of mutations) {
      assert.ok(scanProblems(source).some((problem) => expected.test(problem)), `${name} was not found: ${JSON.stringify(scanProblems(source))}`);
    }
  });

  test("the read-only guard refuses every write a `gh` or `systemctl` argv could make, and allows the reads the readers build", () => {
    const refused = [
      ["api", "-X", "POST", `repos/${REPO}/issues/1/comments`], ["api", `repos/${REPO}/issues/1/comments`, "-f", "body=x"], ["api", `repos/${REPO}/issues/1`, "--method", "PATCH"],
      ["api", "graphql"], ["api", "user"], ["issue", "comment", "1", "--body", "x"], ["pr", "merge", "1"], ["pr", "view", "x", "--repo", REPO], ["pr", "view", "1", "--web"],
      ["pr", "view", "1", "--repo", "--json"], [],
    ];
    for (const argv of refused) assert.throws(() => assertReadOnlyGh(argv), /reads only/, argv.join(" "));
    for (const argv of [["api", `repos/${REPO}/pulls/1`], ["api", `repos/${REPO}/pulls?state=closed&per_page=30`], ["pr", "view", "1", "--repo", REPO, "--json", "reviewDecision"]]) {
      assert.doesNotThrow(() => assertReadOnlyGh(argv), argv.join(" "));
    }
    for (const argv of [["--user", "restart", "x"], ["--user", "stop", "x"], ["stop", "x"], ["--user", "kill", "x"]]) assert.throws(() => assertReadOnlySystemctl(argv), /reads only/);
    assert.doesNotThrow(() => assertReadOnlySystemctl(["--user", "show", "work-tick.service", "-p", "ActiveState,LoadState"]));
  });
});

describe("state.mjs is a leaf: nothing it loads resolves the checkout or reads the project declaration", () => {
  const FORBIDDEN = /(?:^|\/)(?:host-config|project-config)\.mjs$/;

  /** @param {string} file @param {Set<string>} seen @returns {string[]} every module reachable from `file` through relative imports that is forbidden */
  function forbiddenReachableFrom(file: string, seen: Set<string> = new Set()): string[] {
    if (seen.has(file)) return [];
    seen.add(file);
    const source = readFileSync(file, "utf8");
    const specifiers = [...source.matchAll(/^(?:import|export)\s+(?:.*?\s+from\s+)?"(\.[^"]+)";$/gm)].map((match) => match[1]);
    return specifiers.flatMap((specifier) => {
      const target = fileURLToPath(new URL(specifier, `file://${file}`));
      return FORBIDDEN.test(target) ? [target] : forbiddenReachableFrom(target, seen);
    });
  }

  const STATE = fileURLToPath(new URL("./state.mjs", import.meta.url));

  test("state.mjs reaches neither host-config.mjs nor project-config.mjs", () => {
    assert.deepEqual(forbiddenReachableFrom(STATE), []);
  });

  test("positive control: the walk finds a forbidden module one hop away, and sees through a re-export and a bare side-effect import", () => {
    const dir = mkdtempSync(join(scratch, "leaf-"));
    writeFileSync(join(dir, "host-config.mjs"), "export const x = 1;\n");
    writeFileSync(join(dir, "middle.mjs"), 'export { x } from "./host-config.mjs";\n');
    writeFileSync(join(dir, "top.mjs"), 'import { x } from "./middle.mjs";\n');
    writeFileSync(join(dir, "bare.mjs"), 'import "./host-config.mjs";\n');
    for (const entry of ["top.mjs", "bare.mjs"]) assert.deepEqual(forbiddenReachableFrom(join(dir, entry)).map((path) => path.split("/").pop()), ["host-config.mjs"], entry);
  });
});

describe("#3565 a refusal for a '#N' prints the corrected text with the row's values, and pasting it sends", () => {
  /** `gh` over a row #3542 that is closed; the pull request read of the same number is a 404, as GitHub answers for an issue. @param {string[]} argv */
  async function closedRowGh(argv: string[]) {
    assertReadOnlyGh(argv);
    if (argv[1] === `repos/${REPO}/issues/3542`) return JSON.stringify({ number: 3542, state: "closed", labels: [] });
    if (argv[1] === `repos/${REPO}/pulls/3542` || argv[0] === "pr") throw new Error("HTTP 404");
    return fixtureGh(argv);
  }

  test("'#3542 is closed' exits 2 with the placeholders named and the corrected text printed, nothing sent or written; that text exits 0 and says it", async () => {
    const refused = await run(["#3542 is closed"], { gh: closedRowGh });
    assert.equal(refused.code, EXIT.refused);
    assert.match(refused.err, /REFUSED \(free text\): "#3542" is a row or pull request number outside a placeholder \(write #\{\{issue:3542\.number\}\}/);
    assert.match(refused.err, /corrected, send this instead.*: #\{\{issue:3542\.number\}\} is \{\{issue:3542\.state\}\}$/m);
    assert.deepEqual([refused.provider.sent, refused.ledger], [[], []]);

    const pasted = await run(["#{{issue:3542.number}} is {{issue:3542.state}}"], { gh: closedRowGh });
    assert.equal(pasted.code, EXIT.ok, pasted.err);
    assert.deepEqual(pasted.provider.sent.map(({ text }) => text), [`#3542 is closed\n\n${STAMP}`]);
  });

  test("`--dry-run` shows the same corrected text, and the corrected text probes clean", async () => {
    const probe = await run(["--dry-run", "#3542 is closed"], { gh: closedRowGh });
    assert.equal(probe.code, EXIT.refused);
    assert.match(probe.err, /corrected, send this instead.*: #\{\{issue:3542\.number\}\} is \{\{issue:3542\.state\}\}$/m);
    const clean = await run(["--dry-run", "#{{issue:3542.number}} is {{issue:3542.state}}"], { gh: closedRowGh });
    assert.equal(clean.code, EXIT.ok, clean.err);
    assert.match(clean.out, /would send:\n#3542 is closed/);
  });

  test("a state the row does not read is refused, names what the reader returned, and prints no corrected text", async () => {
    const { code, err, provider } = await run(["#3542 is merged"], { gh: closedRowGh });
    assert.equal(code, EXIT.refused);
    assert.match(err, /the reader returned "closed" for #3542, not "merged"/);
    assert.doesNotMatch(err, /corrected, send this instead/);
    assert.deepEqual(provider.sent, []);
  });
});
