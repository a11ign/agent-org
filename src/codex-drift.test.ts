// no-token: none -- runs on text handed in; nothing here spawns `codex`, reads the host's `~/.codex` or reaches `gh`
/**
 * #4437 (class `tool-drift-interactive-prompt`): THE CODEX CLI AND THE CODEX DAEMON ARE TWO PROGRAMS ON TWO RELEASE SCHEDULES.
 *
 * Measured 2026-10-09: `codex app-server daemon version` printed `"cliVersion":"0.157.0","appServerVersion":"0.162.0"`, and exactly three
 * feature flags had a different default in the two builds (`api_key_model_discovery`, `write_stdin_approval`, `guardianv2.thread_context`).
 * `~/.codex/config.toml` had an empty `[features]` table, so nothing it said decided any of the three, and the first session that met the
 * disagreement stopped on a dialog. `host:check` read none of it. The fixtures below are that host's text, so the finding is asked of the
 * very bytes that went unread.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { CLIENT_DAEMON_DISAGREE, codexClientDaemonDrift, codexDeclaredFeatures, codexFeatureDefaults } from "./codex-drift.ts";

const HOME = "/h";
const CONFIG = "/h/.codex/config.toml";
const DAEMON_BINARY = "/h/.codex/packages/app-server-daemon/current/bin/codex";

/** `codex app-server daemon version` as the host printed it, the daemon at 0.162.0 and the CLI still at 0.157.0. */
const VERSION_JSON = JSON.stringify({ status: "running", backend: "pid", managedCodexPath: DAEMON_BINARY, managedCodexVersion: "0.162.0",
  socketPath: "/h/.codex/app-server-control/app-server-control.sock", cliVersion: "0.157.0", appServerVersion: "0.162.0" });
const AGREEING_JSON = VERSION_JSON.replace('"cliVersion":"0.157.0"', '"cliVersion":"0.162.0"');

/** The rows that are the same in both builds: a two-word stage and a one-word stage, so the default is read from the LAST column. */
const SHARED = `agent_message_board                      under development  false
analytics_plan_history                   experimental       false
apply_patch_freeform                     removed            false
guardianv2                               under development  false
shell_tool                               stable             true
`;
const CLI_FEATURES = `${SHARED}api_key_model_discovery                  under development  false
guardianv2.thread_context                stable             true
write_stdin_approval                     under development  false
`;
const DAEMON_FEATURES = `${SHARED}api_key_model_discovery                  under development  true
guardianv2.thread_context                stable             false
write_stdin_approval                     under development  true
`;

const THREE = ["api_key_model_discovery", "guardianv2.thread_context", "write_stdin_approval"];
const EMPTY_FEATURES_CONFIG = '[tui]\nscreen_reader_detection_done = true\n\n[features]\n\n[hooks.state]\n';
const DECLARING_ALL = '[features]\napi_key_model_discovery = false\nwrite_stdin_approval = false\nguardianv2.thread_context = true\n';

type Reads = { version?: string | Error, cli?: string | Error, daemon?: string | Error, config?: string | Error };

/** The deps, with every read answered from `reads` and every program the check ran recorded in `ran`. */
function host(reads: Reads) {
  const ran: string[] = [];
  const answer = (value: string | Error | undefined): string => {
    if (value === undefined) throw new Error("an unasked read");
    if (value instanceof Error) throw value;
    return value;
  };
  return { ran, home: HOME,
    run: (program: string, args: string[]) => {
      ran.push([program, ...args].join(" "));
      if (args.join(" ") === "app-server daemon version") return answer(reads.version);
      if (args.join(" ") === "features list") return answer(program === DAEMON_BINARY ? reads.daemon : reads.cli);
      throw new Error(`unexpected program: ${program} ${args.join(" ")}`);
    },
    readCodexConfig: (path: string) => {
      assert.equal(path, CONFIG, "the config read is the host's own");
      return answer(reads.config);
    } };
}
const errno = (code: string, message = "boom") => Object.assign(new Error(message), { code });
const FAILED = Object.assign(new Error("Command failed: codex app-server daemon version"), { status: 1, stderr: "daemon is not running\n" });

const TODAY: Reads = { version: VERSION_JSON, cli: CLI_FEATURES, daemon: DAEMON_FEATURES, config: EMPTY_FEATURES_CONFIG };
const drift = (reads: Reads) => codexClientDaemonDrift(host(reads));

test("#4437: the real version JSON and the real defaults raise the finding, naming the three flags with BOTH defaults", () => {
  const [finding, ...rest] = drift(TODAY);
  assert.deepEqual(rest, [], "one finding, not one per flag");
  assert.equal(finding?.problem, CLIENT_DAEMON_DISAGREE);
  assert.equal(finding.problem, "CODEX CLIENT AND DAEMON DISAGREE");
  assert.equal(finding.manualFix, true, "declaring a flag is a ruling, so `host:install` is not offered as the fix");
  assert.match(finding.detail, /the CLI is 0\.157\.0 and the daemon it talks to is 0\.162\.0/);
  assert.match(finding.detail, /`api_key_model_discovery` \(CLI false, daemon true\)/);
  assert.match(finding.detail, /`write_stdin_approval` \(CLI false, daemon true\)/);
  assert.match(finding.detail, /`guardianv2\.thread_context` \(CLI true, daemon false\)/);
  assert.doesNotMatch(finding.detail, /shell_tool|agent_message_board/, "a flag that is the same in both builds is not listed");
});

test("#4437: the remedy names the line to add and the value the CLIENT already runs with, and the check writes nothing", () => {
  const reads = host(TODAY);
  const [finding] = codexClientDaemonDrift(reads);
  assert.match(finding.detail, /`api_key_model_discovery = false`/, "the CLI's default, not the daemon's");
  assert.match(finding.detail, /`guardianv2\.thread_context = true`/, "and the other direction: the CLI's default is the true one here");
  assert.match(finding.detail, /`write_stdin_approval = false`/);
  assert.match(finding.detail, /under `\[features\]` in `\/h\/\.codex\/config\.toml`/);
  assert.match(finding.detail, /edits nothing/);
  assert.deepEqual(reads.ran.map((line) => line.replace(/^\S+/, "<program>")),
    ["<program> app-server daemon version", "<program> features list", "<program> features list"],
    "the only programs run are the read-only version and features-list questions");
  assert.equal(reads.ran[2]?.startsWith(DAEMON_BINARY), true, "the daemon's build is the one its own `version` output names");
});

test("#4437: a config that declares all three clears (b); equal versions clear (a); both together are a pass", () => {
  const declared = { ...TODAY, config: DECLARING_ALL };
  const [versionOnly, ...rest] = drift(declared);
  assert.deepEqual(rest, []);
  assert.equal(versionOnly?.problem, CLIENT_DAEMON_DISAGREE, "versions still differ: (a) alone raises");
  assert.match(versionOnly.detail, /the CLI is 0\.157\.0/);
  assert.doesNotMatch(versionOnly.detail, /not declared in `\[features\]`/, "(b) is cleared: no flag is named undeclared");
  assert.doesNotMatch(versionOnly.detail, /`write_stdin_approval` \(CLI/);

  const flagsOnly = drift({ ...TODAY, version: AGREEING_JSON });
  assert.equal(flagsOnly.length, 1, "(a) is cleared and (b) alone raises");
  assert.doesNotMatch(flagsOnly[0].detail, /the CLI is/);
  assert.match(flagsOnly[0].detail, /3 features default differently and are not declared/);

  assert.deepEqual(drift({ ...declared, version: AGREEING_JSON }), [], "equal versions and every differing flag declared: a pass");
});

test("#4437 NEGATIVE CONTROL: a config that declares only two of the three still raises, and names the third", () => {
  const two = '[features]\napi_key_model_discovery = false\nwrite_stdin_approval = false\n';
  const [finding, ...rest] = drift({ ...TODAY, version: AGREEING_JSON, config: two });
  assert.deepEqual(rest, []);
  assert.equal(finding?.problem, CLIENT_DAEMON_DISAGREE);
  assert.match(finding.detail, /1 feature defaults differently and is not declared/);
  assert.match(finding.detail, /`guardianv2\.thread_context` \(CLI true, daemon false\)/);
  assert.doesNotMatch(finding.detail, /`api_key_model_discovery` \(CLI|`write_stdin_approval` \(CLI/, "the declared two are not named");
  assert.match(finding.detail, /`guardianv2\.thread_context = true`/);
});

test("#4437: a flag declared outside `[features]`, or not as a boolean, is not a declaration", () => {
  const undeclared = (config: string) => drift({ ...TODAY, version: AGREEING_JSON, config })[0]?.detail ?? "";
  for (const config of [
    "[tui]\napi_key_model_discovery = false\n[features]\nwrite_stdin_approval = false\nguardianv2.thread_context = true\n",
    "[features]\napi_key_model_discovery = \"false\"\nwrite_stdin_approval = false\nguardianv2.thread_context = true\n",
    "api_key_model_discovery = false\n[features]\nwrite_stdin_approval = false\nguardianv2.thread_context = true\n",
  ]) assert.match(undeclared(config), /`api_key_model_discovery` \(CLI false, daemon true\)/, config);
  assert.deepEqual(drift({ ...TODAY, version: AGREEING_JSON,
    config: "[features]\nwrite_stdin_approval = false # ruled\n'api_key_model_discovery' = false\n[features.guardianv2]\nthread_context = true\n" }), [],
  "a comment, single quotes and a `[features.<name>]` sub-table are TOML too");
  assert.deepEqual([...codexDeclaredFeatures(DECLARING_ALL)].sort(), THREE);
});

test("#4437: `features list` is read from the LAST column, the stage being one or two words", () => {
  const defaults = codexFeatureDefaults(`${CLI_FEATURES}\nnot a feature row at all here\nheader only\n`);
  assert.equal(defaults.get("agent_message_board"), false, "`under development` is two tokens");
  assert.equal(defaults.get("shell_tool"), true);
  assert.equal(defaults.get("guardianv2.thread_context"), true);
  assert.equal(defaults.size, 8);
});

test("#4437: no `codex` is a finding that says so, never a pass", () => {
  const [finding, ...rest] = drift({ version: errno("ENOENT", "spawn codex ENOENT") });
  assert.deepEqual(rest, []);
  assert.equal(finding?.problem, "CODEX NOT FOUND");
  assert.match(finding.detail, /no `codex` on PATH=/);
  assert.match(finding.detail, /UNKNOWN rather than yes/);
});

test("#4437: `codex` found in the home's `.local/bin` when the PATH does not hold it, as a unit's PATH may not", () => {
  const seen: string[] = [];
  const reads = host(TODAY);
  const found = codexClientDaemonDrift({ ...reads, run: (program, args) => {
    seen.push(program);
    if (program === "codex") throw errno("ENOENT");
    return reads.run(program, args);
  } });
  assert.equal(found[0]?.problem, CLIENT_DAEMON_DISAGREE, "the fallback is asked and answered");
  assert.equal(seen.includes("/h/.local/bin/codex"), true);
});

test("#4437: a daemon that is not running is a finding that says so, whichever way it answers", () => {
  const stopped = JSON.stringify({ status: "stopped", cliVersion: "0.157.0" });
  for (const [why, version, said] of [
    ["the command fails", FAILED, /failed \(daemon is not running\)/],
    ["it reports another status", stopped, /reports the daemon as "stopped", not "running"/],
    ["it prints no JSON", "Error: no daemon\n", /not JSON/],
    ["it omits the daemon's version", JSON.stringify({ status: "running", cliVersion: "0.157.0" }), /did not report both/],
  ] as const) {
    const [finding, ...rest] = drift({ ...TODAY, version });
    assert.deepEqual(rest, [], why);
    assert.equal(finding?.problem, "CODEX DAEMON NOT RUNNING", why);
    assert.match(finding.detail, said, why);
    assert.match(finding.detail, /UNKNOWN rather than yes/, why);
  }
});

test("#4437: an unreadable config says it could not be read; an absent one declares nothing and says it does not exist", () => {
  const [unreadable, ...rest] = drift({ ...TODAY, version: AGREEING_JSON, config: errno("EACCES", "permission denied") });
  assert.deepEqual(rest, [], "unreadable is its own finding, not a guess about which flags are declared");
  assert.equal(unreadable?.problem, "CODEX CONFIG UNREADABLE");
  assert.equal(unreadable.unit, CONFIG);
  assert.match(unreadable.detail, /could not be read \(EACCES: permission denied\)/);
  assert.match(unreadable.detail, /UNKNOWN rather than all of them/);

  const [absent, ...others] = drift({ ...TODAY, version: AGREEING_JSON, config: errno("ENOENT") });
  assert.deepEqual(others, []);
  assert.equal(absent?.problem, CLIENT_DAEMON_DISAGREE, "an absent config declares nothing, so the three are still undeclared");
  assert.match(absent.detail, /does not exist, so nothing is declared/);
  assert.match(absent.detail, /`write_stdin_approval` \(CLI false, daemon true\)/);

  const both = drift({ ...TODAY, config: errno("EACCES") });
  assert.deepEqual(both.map((f) => f.problem).sort(), ["CODEX CLIENT AND DAEMON DISAGREE", "CODEX CONFIG UNREADABLE"],
    "a version skew is still reported when the config cannot be read");
});

test("#4437: a `features list` that cannot be read says which build, and is not read as 'no differing flags'", () => {
  const cliDown = drift({ ...TODAY, version: AGREEING_JSON, cli: errno("EACCES", "cannot execute") });
  assert.deepEqual(cliDown.map((f) => f.problem), ["CODEX FEATURES UNREADABLE"]);
  assert.match(cliDown[0].detail, /of the CLI build failed \(EACCES: cannot execute\)/);
  const daemonGone = drift({ ...TODAY, version: AGREEING_JSON, daemon: errno("ENOENT") });
  assert.deepEqual(daemonGone.map((f) => f.problem), ["CODEX FEATURES UNREADABLE"]);
  assert.match(daemonGone[0].detail, /of the daemon build is not there/);
});
