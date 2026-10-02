// @ts-check
// `chairman:reply` (a11ign/a11ign#3071, row 11b): THE ONLY WAY AN AGENT SPEAKS TO THE CHAIRMAN (design #2899 decision 2(e)). `reply.mjs` checks a reply as a library;
// this is the command that builds its four inputs from the host and calls it, so `ceo`'s brief (#2911) names a command that exists.
//
//   pnpm run chairman:reply -- "Row {{issue:3071.state}}" --reply-to 4172     (or the text on stdin)
//
// **THE ONLY PROVIDER IS THE CONFIGURED ONE, AND THE ONLY READERS ARE `createGhReaders`.** `PROVIDERS` is keyed by `messaging.provider`, so a project that
// configured nothing reaches nothing; the reads go through `gh` and `systemctl` runners that refuse every argv a reader does not build (`assertReadOnlyGh`),
// so a placeholder cannot become a write. `reply-cli.test.mjs` scans this file for both.
//
// **OFF IS A REFUSAL HERE, NOT A SILENT SUCCESS.** `messaging:listen` exits 0 when messaging is off because nothing was expected of it; a caller of THIS
// command believes it is speaking to the chairman, so exit 0 would be a lie. It sends nothing, says so, and exits 2.
//
// EXIT CODES, the outcome of `createReply(...).send`: 0 `sent`, 2 `refused` (every problem as written, and the `sendable` "could not check" text, on stderr;
// NOTHING is written to the ledger), 1 `failed` (the provider threw; the ledger holds the failed line). 2 also covers a command that could not start
// (usage, config, secrets, no declared GitHub account): none of those mends itself by retrying.

import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs, promisify } from "node:util";

import { MessagingConfigRefusal, PROJECT_FILE, readMessagingConfig } from "./config.mjs";
import { createLedger, describeError } from "./ledger.mjs";
import { createGhReaders } from "./placeholders.mjs";
import { createTelegramProvider } from "./providers/telegram/send.mjs";
import { createReply } from "./reply.mjs";
import { readSecretFile, secretFileProblem, SecretFileRefusal } from "./secret.mjs";

export const EXIT = Object.freeze({ ok: 0, failed: 1, refused: 2 });
const GH_TIMEOUT_MS = 60_000;
const GH_MAX_BUFFER = 8_000_000;
const execFileAsync = promisify(execFile);

// FOUR SMALL FUNCTIONS THAT BELONG TO `watch.mjs` AND `listen.mjs`, written out here and not imported: both import `host-config.mjs`, which resolves the
// checkout and reads the project's whole declaration AT IMPORT, so a command that imports them cannot even load outside a configured host (the acceptance
// command runs with no `AGENT_ORG_HOST`; `sources/readers.test.mjs`, which imports `watch.mjs`, does not load there either). `reply-cli.test.mjs` pins each
// against the original's source, so a drift fails by name. Extracting them into a leaf both import is a row (the follow-up to #3071), and deletes this block.

/** @param {string} home @returns {string} where the delivery log lives: the one `watch.mjs`'s `defaultLedgerPath` names */
export function defaultLedgerPath(home) {
  return join(home, ".local", "state", "agent-org", "messaging", "ledger.jsonl");
}

/** @param {Record<string, string | undefined>} env @returns {boolean} some account is DECLARED (`watch.mjs`'s `accountIsDeclared`), so `gh` will not fall back to a person's */
export function accountIsDeclared(env) {
  return Boolean(env.GH_CONFIG_DIR) || Boolean(env.HERDR_WORKSPACE_ID);
}

/** @param {string} root @returns {string} the first tracker's repository, as `watch.mjs`'s `trackerRepo` reads it */
export function trackerRepo(root) {
  const path = join(root, PROJECT_FILE);
  const declared = JSON.parse(readFileSync(path, "utf8"))?.tracker?.[0]?.repo;
  if (typeof declared !== "string" || !/^[\w.-]+\/[\w.-]+$/.test(declared)) throw new Error(`${path}: tracker[0].repo is not an owner/name`);
  return declared;
}

/** @param {string} path the file `messaging:pair` wrote @returns {number} the chairman's chat, which is where a reply goes (`listen.mjs`'s `readChairman`, the one id it needs) */
export function readChairmanChat(path) {
  const problem = secretFileProblem(path);
  if (problem !== null) throw new SecretFileRefusal(path, `the chairman file is not usable (${problem}); has \`messaging:pair\` been run?`);
  /** @type {any} */
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (cause) {
    throw new SecretFileRefusal(path, "it is not valid JSON; pair again", { cause });
  }
  if (!Number.isSafeInteger(parsed?.chatId)) throw new SecretFileRefusal(path, "it holds no integer chatId; pair again");
  return parsed.chatId;
}

/** What `createGhReaders` is allowed to ask `gh`: a GET of a repository path, or a pull request's review decision. */
const READ_PATH = /^repos\/[\w.-]+\/[\w.-]+\/[\w./?=&,%:-]+$/;
const PR_VIEW_FLAGS = new Set(["--repo", "--json"]);

/**
 * `gh api <path>` and nothing after the path (a GET is the default, and every flag that changes it is a token this refuses), or `gh pr view <n> --repo R --json F`.
 * @param {readonly string[]} argv the arguments after `gh`
 * @throws {Error} on anything else
 */
export function assertReadOnlyGh(argv) {
  const isApiRead = argv.length === 2 && argv[0] === "api" && READ_PATH.test(argv[1]);
  const isPrView = argv[0] === "pr" && argv[1] === "view" && /^\d+$/.test(argv[2] ?? "") && argv.slice(3).every((token, at) => (at % 2 === 0 ? PR_VIEW_FLAGS.has(token) : !token.startsWith("-")));
  if (!isApiRead && !isPrView) throw new Error(`chairman:reply reads only: \`gh ${argv.join(" ")}\` is not a read it makes`);
}

/** @param {readonly string[]} argv @throws {Error} unless it is `--user show <unit> -p <properties>`, the one question `createGhReaders` asks systemd */
export function assertReadOnlySystemctl(argv) {
  if (argv[0] !== "--user" || argv[1] !== "show") throw new Error(`chairman:reply reads only: \`systemctl ${argv.join(" ")}\` is not a read it makes`);
}

/** @param {string} file @param {(argv: readonly string[]) => void} assertRead @returns {(argv: string[]) => Promise<string>} */
function guardedRunner(file, assertRead) {
  return async (argv) => {
    assertRead(argv);
    const { stdout } = await execFileAsync(file, argv, { timeout: GH_TIMEOUT_MS, maxBuffer: GH_MAX_BUFFER, encoding: "utf8" });
    return stdout;
  };
}

/** The providers this command can reach, keyed by `messaging.provider`. @type {Record<string, (config: import("./config.mjs").MessagingOn, deps: {fetch?: typeof fetch}) => any>} */
const PROVIDERS = {
  telegram: (config, { fetch: fetchImpl }) => createTelegramProvider({
    token: readSecretFile(config.tokenFile), chatId: readChairmanChat(config.chairmanFile), fetch: fetchImpl,
  }),
};

/** @returns {Promise<string>} what is on stdin; "" for a terminal, which would otherwise hang waiting for a person */
async function readStdin() {
  if (process.stdin.isTTY) return "";
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

/** @param {string[]} argv @returns {{text: string | undefined, replyTo: string | undefined}} the text is undefined when it is to be read from stdin */
function parseCommandLine(argv) {
  const { values, positionals } = parseArgs({ args: argv, options: { "reply-to": { type: "string" } }, allowPositionals: true });
  return { text: positionals.length > 0 ? positionals.join(" ") : undefined, replyTo: values["reply-to"] };
}

/** @param {Extract<Awaited<ReturnType<ReturnType<typeof createReply>["send"]>>, {outcome: "refused"}>} refusal @returns {string[]} one line per problem, then the sendable text */
function refusalLines({ problems, sendable }) {
  const lines = problems.map(({ placeholder, reason }) => `chairman:reply: REFUSED ${placeholder ?? "(free text)"}: ${reason}`);
  if (sendable !== undefined) lines.push(`chairman:reply: sendable instead: ${sendable}`);
  return lines;
}

/**
 * @param {Awaited<ReturnType<ReturnType<typeof createReply>["send"]>>} result
 * @param {{out: (line: string) => void, err: (line: string) => void}} sinks @returns {number} the exit code
 */
function report(result, { out, err }) {
  if (result.outcome === "sent") {
    out(`chairman:reply: sent ${result.messageRef}`);
    return EXIT.ok;
  }
  if (result.outcome === "refused") {
    for (const line of refusalLines(result)) err(line);
    return EXIT.refused;
  }
  err(`chairman:reply: FAILED, the provider did not deliver it: ${result.error}`);
  return EXIT.failed;
}

/** What a caller may leave out. A spread and not parameter defaults, as `watch.mjs` does. */
const DEFAULT_DEPS = () => ({
  root: process.cwd(), env: /** @type {Record<string, string | undefined>} */ (process.env), home: homedir(), now: Date.now, fetch: globalThis.fetch,
  providers: PROVIDERS, readStdin, gh: guardedRunner("gh", assertReadOnlyGh), systemctl: guardedRunner("systemctl", assertReadOnlySystemctl),
  out: (/** @type {string} */ line) => console.log(line), err: (/** @type {string} */ line) => console.error(line),
});

/** @param {Error} error @returns {number} a refusal that retrying cannot mend (usage, config, secrets) is `refused`, anything else `failed` */
function exitCodeFor(error) {
  const isUsage = /** @type {any} */ (error).code?.startsWith?.("ERR_PARSE_ARGS") === true;
  return isUsage || error instanceof MessagingConfigRefusal || error instanceof SecretFileRefusal ? EXIT.refused : EXIT.failed;
}

/**
 * @param {string[]} argv the arguments after the script: the text (or stdin) and `--reply-to <message ref>`
 * @param {Partial<ReturnType<typeof DEFAULT_DEPS>>} [deps]
 * @returns {Promise<number>} the exit code
 */
export async function main(argv, deps = {}) {
  const { root, env, home, now, fetch: fetchImpl, providers, readStdin: stdin, gh, systemctl, out, err } = { ...DEFAULT_DEPS(), ...deps };
  try {
    const { text, replyTo } = parseCommandLine(argv);
    const config = readMessagingConfig(resolve(root), { home });
    if (!config.enabled) {
      err("chairman:reply: messaging is OFF (no `messaging` key in .agent-org/project.json); nothing was sent");
      return EXIT.refused;
    }
    if (!accountIsDeclared(env)) {
      err("chairman:reply: no GitHub account is declared (GH_CONFIG_DIR, or an agent workspace); refusing to read as whoever `gh` last logged in as (#1967)");
      return EXIT.refused;
    }
    const provider = providers[config.provider](config, { fetch: fetchImpl });
    const readers = createGhReaders({ gh, systemctl, repo: trackerRepo(resolve(root)) });
    const reply = createReply({ send: (message) => provider.send(message), ledger: createLedger({ path: defaultLedgerPath(home), now }), readers, now });
    return report(await reply.send(text ?? await stdin(), { replyTo }), { out, err });
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    err(`chairman:reply: ${error instanceof MessagingConfigRefusal ? "MALFORMED -- " : ""}${describeError(error)}`);
    return exitCodeFor(error);
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
