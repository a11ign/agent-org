// `chairman:reply` (a11ign/a11ign#3071, row 11b): THE ONLY WAY AN AGENT SPEAKS TO THE CHAIRMAN (design #2899 decision 2(e)). `reply.mjs` checks a reply as a library;
// this is the command that builds its four inputs from the host and calls it, so `ceo`'s brief (#2911) names a command that exists.
//
//   pnpm run chairman:reply -- "Row {{issue:3071.state}}" --to 4172     (or the text on stdin)
//   pnpm run chairman:reply -- --dry-run "{{ready.count}} rows are ready"   (checks and resolves it, prints what WOULD go, sends and writes nothing)
//
// **TEXT THAT LOOKS LIKE A FLAG IS REFUSED, WHICHEVER WAY IT ARRIVED (#3564).** The chairman was once sent `--session=liaison` as a message: the `liaison` typed it
// because every other org command asks which session it is. `parseArgs` already throws on an unknown `--x` in argv, so the text that got through did not come
// through that door: a `--` separator or stdin hands the words over unparsed. The check therefore sits on the TEXT, after argv and stdin have both been
// resolved, and not in the parser.
//
// **THE ONLY PROVIDER IS THE CONFIGURED ONE, AND THE ONLY READERS ARE `createGhReaders`.** `PROVIDERS` is keyed by `messaging.provider`, so a project that
// configured nothing reaches nothing; the reads go through `gh` and `systemctl` runners that refuse every argv a reader does not build (`assertReadOnlyGh`),
// so a placeholder cannot become a write. `reply-cli.test.mjs` scans this file for both.
//
// **OFF IS A REFUSAL HERE, NOT A SILENT SUCCESS.** `messaging:listen` exits 0 when messaging is off because nothing was expected of it; a caller of THIS
// command believes it is speaking to the chairman, so exit 0 would be a lie. It sends nothing, says so, and exits 2.
//
// **A REFUSAL FOR A `#N` PRINTS THE FIX, WITH THE ROW'S OWN VALUES IN IT (#3565).** `reply.mjs` reads the row, so a text that says `#3542 is closed` is refused with
// `#{{issue:3542.number}}` and `{{issue:3542.state}}` named and, when only those stood in the way, the corrected text on a `corrected, send this instead:` line.
// Pasting it is the second and last attempt. `--dry-run` prints the same lines, so a probe shows the road too.
//
// EXIT CODES, the outcome of `createReply(...).send`: 0 `sent`, 2 `refused` (every problem as written, and the `sendable` "could not check" text, on stderr;
// NOTHING is written to the ledger), 1 `failed` (the provider threw; the ledger holds the failed line). 2 also covers a command that could not start
// (usage, config, secrets, no declared GitHub account): none of those mends itself by retrying.

import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs, promisify } from "node:util";

import { completionPath } from "../lib/tick-completion.ts";
import { MessagingConfigRefusal, readMessagingConfig } from "./config.ts";
import { createLedger, describeError, readLedgerLines } from "./ledger.ts";
import { createGhReaders } from "./placeholders.ts";
import { createTelegramProvider } from "./providers/telegram/send.ts";
import { createReply, prepareReply } from "./reply.ts";
import { readSecretFile, SecretFileRefusal } from "./secret.ts";
import { accountIsDeclared, defaultLedgerPath, readChairman, trackerRepo } from "./state.ts";

export const EXIT = Object.freeze({ ok: 0, failed: 1, refused: 2 });
const GH_TIMEOUT_MS = 60_000;
const GH_MAX_BUFFER = 8_000_000;
const execFileAsync = promisify(execFile);

/** What `createGhReaders` is allowed to ask `gh`: a GET of a repository path, or a pull request's review decision. */
const READ_PATH = /^repos\/[\w.-]+\/[\w.-]+\/[\w./?=&,%:-]+$/;
const PR_VIEW_FLAGS = new Set(["--repo", "--json"]);

/**
 * `gh api <path>` and nothing after the path (a GET is the default, and every flag that changes it is a token this refuses), or `gh pr view <n> --repo R --json F`.
 * `argv`: the arguments after `gh`
 * @throws {Error} on anything else
 */
export function assertReadOnlyGh(argv: readonly string[]) {
  const isApiRead = argv.length === 2 && argv[0] === "api" && READ_PATH.test(argv[1]);
  const isPrView = argv[0] === "pr" && argv[1] === "view" && /^\d+$/.test(argv[2] ?? "") && argv.slice(3).every((token, at) => (at % 2 === 0 ? PR_VIEW_FLAGS.has(token) : !token.startsWith("-")));
  if (!isApiRead && !isPrView) throw new Error(`chairman:reply reads only: \`gh ${argv.join(" ")}\` is not a read it makes`);
}

/** @throws {Error} unless it is `--user show <unit> -p <properties>`, the one question `createGhReaders` asks systemd */
export function assertReadOnlySystemctl(argv: readonly string[]) {
  if (argv[0] !== "--user" || argv[1] !== "show") throw new Error(`chairman:reply reads only: \`systemctl ${argv.join(" ")}\` is not a read it makes`);
}

function guardedRunner(file: string, assertRead: (argv: readonly string[]) => void): (argv: string[]) => Promise<string> {
  return async (argv) => {
    assertRead(argv);
    const { stdout } = await execFileAsync(file, argv, { timeout: GH_TIMEOUT_MS, maxBuffer: GH_MAX_BUFFER, encoding: "utf8" });
    return stdout;
  };
}

/** The providers this command can reach, keyed by `messaging.provider`. */
const PROVIDERS: Record<string, (config: import("./config.ts").MessagingOn, deps: { fetch?: typeof fetch; }) => any> = {
  telegram: (config, { fetch: fetchImpl }) => createTelegramProvider({
    token: readSecretFile(config.tokenFile), chatId: readChairman(config.chairmanFile).chatId, fetch: fetchImpl,
  }),
};

/** Returns what is on stdin; "" for a terminal, which would otherwise hang waiting for a person */
async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * `--to` names the chairman's message this answers, and `messaging:measure` reads time-to-answer off it, so a ref no inbound line holds would be a reply that answers nothing.
 * Returns true when it is absent (recorded as null) or the ref of a message the ledger took in
 */
function isKnownInbound(replyTo: string | undefined, ledgerPath: string): boolean {
  return replyTo === undefined || readLedgerLines(ledgerPath).some((line) => line.direction === "in" && line.messageRef === replyTo);
}

/** Returns the parsed arguments; the text is undefined when it is to be read from stdin */
function parseCommandLine(argv: string[]): { text: string | undefined; replyTo: string | undefined; dryRun: boolean; } {
  const { values, positionals } = parseArgs({ args: argv, options: { to: { type: "string" }, "dry-run": { type: "boolean" } }, allowPositionals: true });
  return { text: positionals.length > 0 ? positionals.join(" ") : undefined, replyTo: values.to, dryRun: values["dry-run"] === true };
}

/**
 * A word is flag-shaped when it is `--` and a letter: `--session=liaison`, `--to`. ANY word, not only the first, because `as of 20:59Z --session=liaison` is the same
 * mistake with a sentence in front of it. `--` followed by a letter and not `--` alone, so an em-dash typed as ` -- ` or a rule of dashes is still prose.
 * Returns the first such word
 */
function flagShapedWord(text: string): string | undefined {
  return text.split(/\s+/).find((word) => /^--[A-Za-z]/.test(word));
}

function flagRefusal(word: string): string {
  return `chairman:reply: REFUSED ${JSON.stringify(word)}: it starts with "--", so it reads as a flag and not as words to the chairman. This command takes \`--to <ref>\`, \`--dry-run\` and the text, `
    + "and nothing else (it asks no session); reword the text. Nothing was sent";
}

/** What `--dry-run` prints for a text that WOULD send: the stamped text, then what each placeholder resolved to. */
function dryRunLines({ text, values }: Extract<Awaited<ReturnType<typeof prepareReply>>, { outcome: "checked"; }>): string[] {
  const resolved = Object.entries(values).map(([placeholder, value]) => `chairman:reply:   ${placeholder} = ${value}`);
  return ["chairman:reply: dry run, would send:", text, ...resolved, "chairman:reply: dry run: nothing was sent and nothing was written to the ledger"];
}

/**
 * Everything `send` does short of the provider and the ledger: the same checks, the same readers.
 * Returns the exit code
 */
async function dryRun(text: string, deps: Parameters<typeof prepareReply>[1], { out, err }: { out: (line: string) => void; err: (line: string) => void; }): Promise<number> {
  const prepared = await prepareReply(text, deps);
  if (prepared.outcome === "refused") return report({ ...prepared }, { out, err });
  for (const line of dryRunLines(prepared)) out(line);
  return EXIT.ok;
}

/** Returns one line per problem, then the corrected text when the readers' values make it pass, then the sendable text */
function refusalLines({ problems, sendable, corrected }: Extract<Awaited<ReturnType<ReturnType<typeof createReply>["send"]>>, { outcome: "refused"; }>): string[] {
  const lines = problems.map(({ placeholder, reason }) => `chairman:reply: REFUSED ${placeholder ?? "(free text)"}: ${reason}`);
  if (corrected !== undefined) lines.push(`chairman:reply: corrected, send this instead (every fact in it is re-read when it goes): ${corrected}`);
  if (sendable !== undefined) lines.push(`chairman:reply: sendable instead: ${sendable}`);
  return lines;
}

/** Returns the exit code */
function report(result: Awaited<ReturnType<ReturnType<typeof createReply>["send"]>>, { out, err }: { out: (line: string) => void; err: (line: string) => void; }): number {
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

/**
 * Where the tick writes its completion record, resolved the way `watch.mjs` does (`stateEntryPath("wake-ledger")`). IMPORTED WHEN ASKED, not at the top:
 * `host-config.ts` resolves the checkout at import, and this command is a leaf that loads outside a configured host (`state.mjs`), so a host that cannot answer
 * must cost `{{gate.*}}` and nothing else.
 */
async function hostWakeLedgerPath({ home, env }: { home: string; env: Record<string, string | undefined>; }): Promise<string> {
  const { stateEntryPath } = await import("../host-config.ts");
  return stateEntryPath("wake-ledger", { home, env });
}

/**
 * The files `{{fleet.*}}` and `{{gate.*}}` read, named the way `watch.mjs`'s `hostReaders` names them for the watcher: the two files `fleet-watch` writes under the
 * project's `runs/`, and the tick's completion record beside the wake ledger. Without them those placeholders refuse ("this host named no fleet-watch state files").
 * Returns no `gateRecordPath` when the host could not name one, said on `err`
 */
async function hostFiles({ root, wakeLedger, err }: { root: string; wakeLedger: () => Promise<string>; err: (line: string) => void; }): Promise<{ fleet: { statePath: string; capturesPath: string; }; gateRecordPath?: string; }> {
  const fleet = { statePath: join(root, "runs", "fleet-watch-state.json"), capturesPath: join(root, "runs", "fleet-captures-state.json") };
  try {
    return { fleet, gateRecordPath: completionPath(await wakeLedger()) };
  } catch (error) {
    err(`chairman:reply: this host could not name the work-tick completion record, so {{gate.*}} will refuse: ${describeError(error)}`);
    return { fleet };
  }
}

/** What a caller may leave out. A spread and not parameter defaults, as `watch.mjs` does. */
const DEFAULT_DEPS = () => ({
  root: process.cwd(), env: process.env as Record<string, string | undefined>, home: homedir(), now: Date.now, fetch: globalThis.fetch,
  providers: PROVIDERS, readStdin, wakeLedgerPath: hostWakeLedgerPath, gh: guardedRunner("gh", assertReadOnlyGh), systemctl: guardedRunner("systemctl", assertReadOnlySystemctl),
  out: (line: string) => console.log(line), err: (line: string) => console.error(line),
});

/** The exit code: a refusal that retrying cannot mend (usage, config, secrets) is `refused`, anything else `failed` */
function exitCodeFor(error: Error): number {
  const isUsage = (error as NodeJS.ErrnoException).code?.startsWith?.("ERR_PARSE_ARGS") === true;
  return isUsage || error instanceof MessagingConfigRefusal || error instanceof SecretFileRefusal ? EXIT.refused : EXIT.failed;
}

/**
 * `argv`: the arguments after the script: the text (or stdin), `--to <message ref>` and `--dry-run`
 * Returns the exit code
 */
export async function main(argv: string[], deps: Partial<ReturnType<typeof DEFAULT_DEPS>> = {}): Promise<number> {
  const { root, env, home, now, fetch: fetchImpl, providers, readStdin: stdin, wakeLedgerPath, gh, systemctl, out, err } = { ...DEFAULT_DEPS(), ...deps };
  try {
    const { text: given, replyTo, dryRun: isDryRun } = parseCommandLine(argv);
    const text = given ?? await stdin();
    const flag = flagShapedWord(text);
    if (flag !== undefined) {
      err(flagRefusal(flag));
      return EXIT.refused;
    }
    const config = readMessagingConfig(resolve(root), { home });
    if (!config.enabled) {
      err("chairman:reply: messaging is OFF (no `messaging` key in .agent-org/project.json); nothing was sent");
      return EXIT.refused;
    }
    if (!accountIsDeclared(env)) {
      err("chairman:reply: no GitHub account is declared (GH_CONFIG_DIR, or an agent workspace); refusing to read as whoever `gh` last logged in as (#1967)");
      return EXIT.refused;
    }
    if (!isKnownInbound(replyTo, defaultLedgerPath(home))) {
      err(`chairman:reply: REFUSED --to ${replyTo}: no message from the chairman with that ref is in the ledger, so the reply would answer nothing; nothing was sent`);
      return EXIT.refused;
    }
    const readers = createGhReaders({ gh, systemctl, repo: trackerRepo(resolve(root)), ...await hostFiles({ root: resolve(root), wakeLedger: () => wakeLedgerPath({ home, env }), err }), now });
    // A dry run builds NO provider: that reads the token and the chairman's chat id, and a probe has no business holding either.
    if (isDryRun) return await dryRun(text, { readers, now }, { out, err });
    const provider = providers[config.provider](config, { fetch: fetchImpl });
    const reply = createReply({ send: (message) => provider.send(message), ledger: createLedger({ path: defaultLedgerPath(home), now }), readers, now });
    return report(await reply.send(text, { replyTo }), { out, err });
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    err(`chairman:reply: ${error instanceof MessagingConfigRefusal ? "MALFORMED -- " : ""}${describeError(error)}`);
    return exitCodeFor(error);
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
