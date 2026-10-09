// @ts-check
// THE `messaging` KEY AND `messaging:check` (a11ign/a11ign#2901 done-whens 1 and 4), against a plain object or a project root in a temp
// directory and a stand-in home, so nothing here reads the real `~/.config`.
//
// POSITIVE CONTROLS: "off" is also what a reader that is always off reports, so the case that reads a present key ON sits beside every
// refusal, and the check's "ok" is asserted against a real 0600 file as well as its refusal against a 0644 one.

import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";

import { DEFAULT_SUMMARY, MessagingConfigRefusal, parseMessagingConfig, readMessagingConfig } from "./config.ts";
import { runMessagingCheck } from "./check.ts";

const scratch = mkdtempSync(join(tmpdir(), "messaging-config-"));
after(() => rmSync(scratch, { recursive: true, force: true }));
const HOME = join(scratch, "home");
const SECRETS = join(HOME, ".config/agent-org");
mkdirSync(SECRETS, { recursive: true });

const VALID = { provider: "telegram", tokenFile: "~/.config/agent-org/telegram-token", chairmanFile: "~/.config/agent-org/chairman.json" };

/** @param {unknown} messaging @returns {unknown} a whole `project.json` document holding it */
const documentWith = (messaging: unknown): unknown => ({ schema: 1, messaging });

/** @param {unknown} parsed */
const parse = (parsed: unknown) => parseMessagingConfig(parsed, { home: HOME });

/** @param {unknown} parsed @param {RegExp} field */
function refusedAt(parsed: unknown, field: RegExp) {
  assert.throws(() => parse(parsed), (error) => error instanceof MessagingConfigRefusal && field.test(error.field), `expected a refusal naming ${field}`);
}

describe("absent reads as OFF, and a present key reads ON (the pair is the positive control)", () => {
  test("no `messaging` key: off, carrying nothing a caller could construct from", () => {
    assert.deepEqual(parse({ schema: 1, tracker: [] }), { enabled: false });
  });

  test("a config WITH the key reads on, so a reader that is always off fails here", () => {
    const config = parse(documentWith(VALID));
    assert.equal(config.enabled, true);
    assert.equal(config.enabled && config.provider, "telegram");
  });

  test("the secret references come back resolved under the home directory", () => {
    const config = parse(documentWith(VALID));
    assert.ok(config.enabled);
    assert.equal(config.tokenFile, join(SECRETS, "telegram-token"));
    assert.equal(config.chairmanFile, join(SECRETS, "chairman.json"));
  });

  test("an absolute path under the secret directory is accepted too", () => {
    const config = parse(documentWith({ ...VALID, tokenFile: join(SECRETS, "t") }));
    assert.ok(config.enabled);
    assert.equal(config.tokenFile, join(SECRETS, "t"));
  });

  test("underscore keys are prose, as everywhere in project.json", () => {
    assert.equal(parse(documentWith({ ...VALID, _why: "the chairman's channel" })).enabled, true);
  });
});

describe("milestones is opt-in, a path inside the project (a11ign/a11ign#3414)", () => {
  const ROOT = join(scratch, "milestone-root");
  /** @param {unknown} milestones */
  const parseIn = (milestones: unknown) => parseMessagingConfig(documentWith({ ...VALID, ...(milestones === undefined ? {} : { milestones }) }), { home: HOME, root: ROOT });

  test("no `milestones` key reads back null: the source is opt-in and constructs nothing", () => {
    const config = parseIn(undefined);
    assert.ok(config.enabled);
    assert.equal(config.milestones, null);
  });

  test("a declared path comes back resolved against the project root (the positive control for the null above)", () => {
    const config = parseIn(".agent-org/chairman-milestones.json");
    assert.ok(config.enabled);
    assert.equal(config.milestones, join(ROOT, ".agent-org/chairman-milestones.json"));
  });

  for (const [name, value] of /** @type {[string, unknown][]} */ ([["a path that climbs out of the project", "../elsewhere.json"], ["an absolute path outside it", "/etc/passwd"], ["an empty string", ""], ["null", null], ["a number", 3]])) {
    test(`${name} is refused, naming messaging.milestones`, () => refusedAt(documentWith({ ...VALID, milestones: value }), /^messaging\.milestones$/));
  }
});

describe("summary is opt-in, its field defaults and its refusals (done-when 4)", () => {
  test("a config with NO summary key reads back with no summary: the summary is opt-in (chairman, 2026-10-04)", () => {
    const config = parse(documentWith(VALID));
    assert.ok(config.enabled);
    assert.equal(config.summary, null);
  });

  test("a DECLARED summary with neither field takes the field defaults: `{}` is how a host asks for 08:00 London", () => {
    const config = parse(documentWith({ ...VALID, summary: {} }));
    assert.ok(config.enabled);
    assert.deepEqual(config.summary, DEFAULT_SUMMARY);
  });

  test("one given and the other defaulted", () => {
    const config = parse(documentWith({ ...VALID, summary: { at: "07:30" } }));
    assert.ok(config.enabled);
    assert.deepEqual(config.summary, { at: "07:30", timezone: "Europe/London" });
  });

  test("an unknown timezone is refused BY NAME", () => {
    assert.throws(() => parse(documentWith({ ...VALID, summary: { timezone: "Mars/Olympus_Mons" } })),
      (error) => error instanceof MessagingConfigRefusal && error.field === "messaging.summary.timezone" && /Mars\/Olympus_Mons/.test(error.message));
  });

  test("a real timezone other than the default is accepted (positive control for the refusal above)", () => {
    const config = parse(documentWith({ ...VALID, summary: { timezone: "America/New_York" } }));
    assert.ok(config.enabled);
    assert.equal(config.summary?.timezone, "America/New_York");
  });

  for (const at of ["8:00", "24:00", "08:60", "0800", "", 800, null]) {
    test(`summary.at ${JSON.stringify(at)} is refused`, () => refusedAt(documentWith({ ...VALID, summary: { at } }), /^messaging\.summary\.at$/));
  }

  test("a summary that is not an object is refused", () => refusedAt(documentWith({ ...VALID, summary: "08:00" }), /^messaging\.summary$/));
  test("an unknown summary key is refused (a typo is not a silent default)", () => refusedAt(documentWith({ ...VALID, summary: { time: "08:00" } }), /^messaging\.summary\.time$/));
});

describe("a malformed key is a NAMED refusal, never a silent off", () => {
  for (const [label, messaging] of /** @type {[string, unknown][]} */ ([["null", null], ["a string", "on"], ["an array", []], ["true", true]])) {
    test(`the key being ${label}`, () => refusedAt(documentWith(messaging), /^messaging$/));
  }

  test("an empty object is refused for its missing provider, not read as off", () => refusedAt(documentWith({}), /^messaging\.provider$/));
  test("an unknown provider is refused by name", () => {
    assert.throws(() => parse(documentWith({ ...VALID, provider: "carrier-pigeon" })), /carrier-pigeon/);
  });
  test("a misspelt key is refused, naming it", () => refusedAt(documentWith({ ...VALID, tokenfile: "x" }), /^messaging\.tokenfile$/));
  test("a missing tokenFile is refused", () => refusedAt(documentWith({ provider: "telegram", chairmanFile: VALID.chairmanFile }), /^messaging\.tokenFile$/));
  test("a missing chairmanFile is refused", () => refusedAt(documentWith({ provider: "telegram", tokenFile: VALID.tokenFile }), /^messaging\.chairmanFile$/));

  for (const where of ["/etc/shadow", "~/.profile", "~/.config/agent-org/../../.profile", "relative/token", "~/.config/agent-org-evil/t"]) {
    test(`a reference outside the secret directory is refused: ${where}`, () => refusedAt(documentWith({ ...VALID, tokenFile: where }), /^messaging\.tokenFile$/));
  }

  test("a document that is not an object is refused", () => refusedAt([], /^\(file\)$/));
});

describe("reading the file, and messaging:check", () => {
  /** @param {string} name @param {unknown} document @returns {string} a project root holding it */
  function projectRoot(name: string, document: unknown): string {
    const root = join(scratch, name);
    mkdirSync(join(root, ".agent-org"), { recursive: true });
    writeFileSync(join(root, ".agent-org/project.json"), typeof document === "string" ? document : JSON.stringify(document));
    return root;
  }
  const tokenPath = join(SECRETS, "telegram-token");
  const chairmanPath = join(SECRETS, "chairman.json");
  const owner = process.getuid?.() ?? 0;

  test("readMessagingConfig reads a project root, off and on", () => {
    assert.deepEqual(readMessagingConfig(projectRoot("off", { schema: 1 }), { home: HOME }), { enabled: false });
    assert.equal(readMessagingConfig(projectRoot("on", documentWith(VALID)), { home: HOME }).enabled, true);
  });

  test("an unreadable or unparseable file is a refusal, not off", () => {
    assert.throws(() => readMessagingConfig(join(scratch, "no-such-root"), { home: HOME }), MessagingConfigRefusal);
    assert.throws(() => readMessagingConfig(projectRoot("broken", "{ not json"), { home: HOME }), /not valid JSON/);
  });

  test("check, with no key: OFF and exit 0, and it says nothing is installed", () => {
    const verdict = runMessagingCheck({ root: projectRoot("check-off", { schema: 1 }), home: HOME });
    assert.equal(verdict.exitCode, 0);
    assert.match(verdict.lines.join("\n"), /OFF/);
  });

  test("check, malformed: exit 1 naming the field", () => {
    const verdict = runMessagingCheck({ root: projectRoot("check-bad", documentWith({ ...VALID, provider: "x" })), home: HOME });
    assert.equal(verdict.exitCode, 1);
    assert.match(verdict.lines.join("\n"), /MALFORMED.*messaging\.provider/);
  });

  test("check, on with a 0600 token file owned by this user: exit 0 (positive control), unpaired chairman is not a failure", () => {
    writeFileSync(tokenPath, "123456:SECRET-TOKEN-VALUE\n", { mode: 0o600 });
    chmodSync(tokenPath, 0o600);
    const verdict = runMessagingCheck({ root: projectRoot("check-on", documentWith(VALID)), home: HOME });
    assert.equal(verdict.exitCode, 0, verdict.lines.join("\n"));
    assert.match(verdict.lines.join("\n"), /token file: ok/);
    assert.match(verdict.lines.join("\n"), /NOT YET PAIRED/);
    assert.match(verdict.lines[0], /no daily summary/, "no summary declared: the header says there is none, not a time");
  });

  test("check, a declared summary: the header names its time and zone (what keeps the line above from being a constant)", () => {
    writeFileSync(tokenPath, "123456:SECRET-TOKEN-VALUE\n", { mode: 0o600 });
    chmodSync(tokenPath, 0o600);
    const verdict = runMessagingCheck({ root: projectRoot("check-summary", documentWith({ ...VALID, summary: { at: "07:30" } })), home: HOME });
    assert.match(verdict.lines[0], /summary at 07:30 Europe\/London/);
  });

  test("check, token file 0644: exit 1, naming the mode, never the content", () => {
    chmodSync(tokenPath, 0o644);
    const verdict = runMessagingCheck({ root: projectRoot("check-0644", documentWith(VALID)), home: HOME });
    const text = verdict.lines.join("\n");
    assert.equal(verdict.exitCode, 1);
    assert.match(text, /0644/);
    assert.doesNotMatch(text, /SECRET-TOKEN-VALUE|123456/);
    chmodSync(tokenPath, 0o600);
  });

  test("check, token file missing: exit 1", () => {
    const verdict = runMessagingCheck({ root: projectRoot("check-missing", documentWith({ ...VALID, tokenFile: "~/.config/agent-org/absent" })), home: HOME });
    assert.equal(verdict.exitCode, 1);
    assert.match(verdict.lines.join("\n"), /token file: REFUSED/);
  });

  test("check, a chairman file that EXISTS is held to the same rule as the token's", () => {
    writeFileSync(chairmanPath, "{}", { mode: 0o600 });
    chmodSync(chairmanPath, 0o640);
    const verdict = runMessagingCheck({ root: projectRoot("check-chairman", documentWith(VALID)), home: HOME });
    assert.equal(verdict.exitCode, 1);
    assert.match(verdict.lines.join("\n"), /chairman file: REFUSED.*0640/);
    chmodSync(chairmanPath, 0o600);
    assert.equal(runMessagingCheck({ root: projectRoot("check-chairman-ok", documentWith(VALID)), home: HOME }).exitCode, 0);
  });

  test("check, a token file owned by someone else: exit 1, naming the owner", () => {
    const verdict = runMessagingCheck({ root: projectRoot("check-owner", documentWith(VALID)), home: HOME, uid: owner + 1 });
    assert.equal(verdict.exitCode, 1);
    assert.match(verdict.lines.join("\n"), new RegExp(`owned by uid ${owner}`));
  });

  test("check makes no network call", () => {
    const real = globalThis.fetch;
    globalThis.fetch = /** @type {typeof fetch} */ (() => { throw new Error("messaging:check reached the network"); });
    try {
      assert.equal(runMessagingCheck({ root: projectRoot("check-net", documentWith(VALID)), home: HOME }).exitCode, 0);
    } finally {
      globalThis.fetch = real;
    }
  });

  test("check, a declared file that parses: ok and its count; a malformed one: exit 1 naming the entry and field; an absent one: exit 1", () => {
    writeFileSync(tokenPath, "123456:SECRET-TOKEN-VALUE\n", { mode: 0o600 });
    chmodSync(tokenPath, 0o600);
    const root = projectRoot("check-milestones", documentWith({ ...VALID, milestones: ".agent-org/chairman-milestones.json" }));
    const file = join(root, ".agent-org/chairman-milestones.json");
    const entry = { key: "split-move-1", what: "nvda-worker has moved", when: { row: 2701, closed: true } };
    writeFileSync(file, JSON.stringify({ milestones: [entry] }));
    const ok = runMessagingCheck({ root, home: HOME });
    assert.equal(ok.exitCode, 0, ok.lines.join("\n"));
    assert.match(ok.lines.join("\n"), /milestones: ok \(1 declared/);
    writeFileSync(file, JSON.stringify({ milestones: [{ key: "split-move-1", when: entry.when }] }));
    const bad = runMessagingCheck({ root, home: HOME });
    assert.equal(bad.exitCode, 1);
    assert.match(bad.lines.join("\n"), /milestones: REFUSED.*milestones\[0\] \(split-move-1\): what: it is missing/);
    rmSync(file);
    const absent = runMessagingCheck({ root, home: HOME });
    assert.equal(absent.exitCode, 1);
    assert.match(absent.lines.join("\n"), /milestones: REFUSED.*cannot be read/);
  });

  test("check, no `milestones` key: no milestones line at all", () => {
    writeFileSync(tokenPath, "123456:SECRET-TOKEN-VALUE\n", { mode: 0o600 });
    chmodSync(tokenPath, 0o600);
    assert.doesNotMatch(runMessagingCheck({ root: projectRoot("check-no-milestones", documentWith(VALID)), home: HOME }).lines.join("\n"), /milestones/);
  });
});
