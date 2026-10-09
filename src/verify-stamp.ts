// A PULL REQUEST IS MARKED READY ONLY ON A GREEN VERIFY STAMP FOR ITS HEAD (a11ign/a11ign#3215, chairman's class 1 on #928).
//
// WHY. The first-run pass rate was 35%: authors ran "the affected files" and CI runs the whole of what its `gate` waits
// for. `pnpm run verify` in the project is the ONE local command that equals CI and it writes a stamp (the head, a hash of
// the body, the result of every step). This is the reader of that stamp for the two doors that make a pull request READY:
// `pr:open` (a create without `--draft`) and the gate's own `gh pr ready` after a `convinced` verdict.
//
// IT NEVER RE-RUNS `verify`, AND IT DOES NOT RE-IMPLEMENT ITS VERDICT. The project's `verify` script answers `--check`
// from the stamp alone (exit 0 green, 1 red, one `  - <reason>` line each), and it is the only reader that knows which
// steps CI would never skip. A second copy of that rule here would drift from it, so this runs the project's own check and
// reports what it said. `--draft-body=<file>` is how the body being sent reaches it, because the stamp holds the body's hash.
//
// WHERE THE STAMP IS. Git's own per-worktree path (`.git/worktrees/<name>/verify-stamp.json`), so it is untracked and
// never shared between worktrees. The gate is another session on the same host, so it finds the worktree whose HEAD is the
// pull request's head (`git worktree list`) and asks THAT tree: a stamp is keyed by the head it was made for and an
// author's push after it leaves no worktree at the new head until they verify again, which is the property that matters --
// the thing marked ready is the thing that was verified.
//
// A PROJECT WITH NO `verify` SCRIPT IS NOT REFUSED. It is declared by having one in `package.json`, the platform's own
// place for "the project's commands"; agent-org has none yet and has its own `gate`. The caller is told so BY NAME
// (`no-verify`), because a silent pass is how a gap stays invisible.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { homeHostConfig } from "./host-config.ts";
import { sandboxGitEnv } from "./lib/git-env.mjs";
import { HOME_CHECKOUT } from "./project-config.ts";

export const VERIFY_STATE = Object.freeze({ GREEN: "green", RED: "red", NO_VERIFY: "no-verify" });

/** What `verify --check` prints for each reason: `  - <reason>`. */
const REASON_LINE = /^\s+- (.+)$/;
const SHORT_SHA = 9;
const CHECK_TIMEOUT_MS = 60_000;

/**
 * `project` names the repository the reading is about, for the line that says "no verify declared for <project>".
 */
export type VerifyReading = { state: "green" | "red" | "no-verify", reasons: string[], project: string };

/**
 * The project's `verify` script and its name, or `script: null` when it declares none. A `package.json` that is missing
 * declares none; one that cannot be parsed THROWS, since reading it as "none" would let every pull request through.
 * @param {string} dir @param {(path: string, encoding: "utf8") => string} [read]
 * @returns {{ script: string | null, project: string }}
 */
export function verifyDeclaration(dir: string, read: (path: string, encoding: "utf8") => string = readFileSync): { script: string | null; project: string; } {
  let text;
  try {
    text = read(join(dir, "package.json"), "utf8");
  } catch (cause) {
    if ((cause as any)?.code === "ENOENT") return { script: null, project: basename(dir) };
    throw new Error(`${join(dir, "package.json")} cannot be read: ${(cause as any)?.message ?? cause}`, { cause });
  }
  const manifest = JSON.parse(text);
  const script = manifest?.scripts?.verify;
  return { script: typeof script === "string" && script !== "" ? script : null, project: String(manifest?.name ?? basename(dir)) };
}

/**
 * PURE. The reading a `verify --check` run amounts to.
 * @param {{ status: number | null, stdout: string, stderr: string }} result @param {string} project
 * @returns {VerifyReading}
 */
export function readingFromCheck({ status, stdout, stderr }: { status: number | null; stdout: string; stderr: string; }, project: string): VerifyReading {
  if (status === 0) return { state: VERIFY_STATE.GREEN, reasons: [], project };
  const reasons = stdout.split("\n").map((line) => REASON_LINE.exec(line)?.[1]).filter((reason) => reason !== undefined);
  if (status === 1 && reasons.length > 0) return { state: VERIFY_STATE.RED, reasons: (reasons as string[]), project };
  // The check did not answer in its own words (exit 2, a missing command, a timeout): that is red and says so, never green.
  const said = `${stderr}${stdout}`.trim().split("\n").at(-1) ?? "";
  return { state: VERIFY_STATE.RED, project, reasons: [`the project's verify check did not answer (exit ${status ?? "none"})${said ? `: ${said}` : ""}`] };
}

/**
 * @param {string} command @param {string} cwd
 * @returns {{ status: number | null, stdout: string, stderr: string }}
 */
const defaultSpawn = (command: string, cwd: string): { status: number | null; stdout: string; stderr: string; } => {
  const done = spawnSync(command, { cwd, shell: true, encoding: "utf8", env: sandboxGitEnv(), timeout: CHECK_TIMEOUT_MS });
  return { status: done.status, stdout: done.stdout ?? "", stderr: done.stderr ?? "" };
};

/**
 * THE STAMP IN `dir` READ AGAINST `body`, through the project's own `verify --check`.
 * @param {{ dir: string, body: string, spawn?: typeof defaultSpawn, read?: Parameters<typeof verifyDeclaration>[1] }} where
 * @returns {VerifyReading}
 */
export function readVerifyStamp({ dir, body, spawn = defaultSpawn, read }: { dir: string; body: string; spawn?: typeof defaultSpawn; read?: Parameters<typeof verifyDeclaration>[1]; }): VerifyReading {
  const { script, project } = verifyDeclaration(dir, read);
  if (script === null) return { state: VERIFY_STATE.NO_VERIFY, reasons: [], project };
  const scratch = mkdtempSync(join(tmpdir(), "verify-stamp-"));
  try {
    const bodyFile = join(scratch, "body.md");
    writeFileSync(bodyFile, body);
    return readingFromCheck(spawn(`${script} --check --draft-body=${bodyFile}`, dir), project);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * The worktree of `checkout`'s repository whose HEAD is `head`, or null when none is. `git worktree list` names every linked
 * tree and the primary one, so the author's tree is found wherever it lives.
 * @param {{ checkout: string, head: string, git: (args: string[]) => string }} where
 * @returns {string | null}
 */
export function worktreeAtHead({ checkout, head, git }: { checkout: string; head: string; git: (args: string[]) => string; }): string | null {
  const listing = git(["-C", checkout, "worktree", "list", "--porcelain"]);
  for (const entry of listing.split("\n\n")) {
    const dir = /^worktree (.+)$/m.exec(entry)?.[1];
    if (dir !== undefined && /^HEAD (\S+)$/m.exec(entry)?.[1] === head) return dir;
  }
  return null;
}

/**
 * The checkout whose worktrees the stamps of a scope's pull requests live in: the tick's own for the primary (`key` ""), the host's
 * declared clone for a keyed repository, and `undefined` -- never a guess -- for a key the host gives none or a host it cannot read.
 * @param {string} key @param {() => { clones?: Readonly<Record<string, string>> }} [host]
 * @returns {string | undefined}
 */
export function verifyCheckoutOf(key: string, host: () => { clones?: Readonly<Record<string, string>>; } = homeHostConfig): string | undefined {
  if (key === "") return HOME_CHECKOUT;
  try {
    const clones = host().clones;
    return clones !== undefined && Object.hasOwn(clones, key) ? clones[key] : undefined;
  } catch {
    return undefined; // an unreadable host declaration leaves the pull requests unstamped, which accuses nobody
  }
}

/**
 * THE GATE'S SIDE: stamp `verifyStamp` on each DRAFT, the only pull requests the ready action reaches, so `settledVerdictOrder`
 * -- which reads only the pull request -- can withhold it. A pull request nobody read stays unstamped and is NOT accused
 * (`stallReasonOf`'s rule for `armed` and `ejection`), and a project with no verify script is stamped `no-verify`.
 * `body` is the pull request's body from the list the gate already holds, so an edited body reads stale.
 * @param {any[]} prs
 * @param {{ checkout: string | undefined, git?: (args: string[]) => string, read?: typeof readVerifyStamp }} where
 */
export function withVerifyStamps(prs: any[], { checkout, git = defaultGit, read = readVerifyStamp }: { checkout: string | undefined; git?: (args: string[]) => string; read?: typeof readVerifyStamp; }) {
  if (checkout === undefined || !prs.some((pr) => pr?.isDraft === true)) return prs;
  const stampOf: (pr: any) => VerifyReading = (pr): VerifyReading => {
    const head = String(pr.headRefOid ?? "");
    const { script, project } = verifyDeclaration(checkout);
    if (script === null) return { state: VERIFY_STATE.NO_VERIFY, reasons: [], project };
    const dir = head === "" ? null : worktreeAtHead({ checkout, head, git });
    if (dir === null) {
      return { state: VERIFY_STATE.RED, project, reasons: [`no worktree of ${project} is at head ${head.slice(0, SHORT_SHA)}, so there is no stamp for it`] };
    }
    return read({ dir, body: String(pr.body ?? "") });
  };
  // An unreadable manifest or a failed `git` is RED with its reason and never a thrown error: the tick must survive it, and
  // "could not read" is not "green".
  const safely: (pr: any) => VerifyReading = (pr): VerifyReading => {
    try {
      return stampOf(pr);
    } catch (cause) {
      return { state: VERIFY_STATE.RED, project: basename(checkout), reasons: [`the stamp could not be read: ${(cause as any)?.message ?? cause}`] };
    }
  };
  return prs.map((pr) => (pr?.isDraft === true ? { ...pr, verifyStamp: safely(pr) } : pr));
}

/** @param {string[]} args */
function defaultGit(args: string[]) {
  const done = spawnSync("git", args, { encoding: "utf8", env: sandboxGitEnv() });
  if (done.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${done.stderr.trim()}`);
  return done.stdout;
}

/**
 * THE COMMAND THAT MAKES A STAMP GREEN, as a refusal must name it.
 * @param {string | null} bodyFile the body file the caller is sending, when it has one
 */
export function verifyCommand(bodyFile: string | null) {
  return `pnpm run verify -- --draft-body=${bodyFile ?? "<the body file>"}`;
}

/**
 * The one line a reading is reported in, for the door that refuses on it (`pr:open`).
 * @param {VerifyReading} reading @param {{ bodyFile: string | null }} where
 */
export function verifyRefusalLine(reading: VerifyReading, { bodyFile }: { bodyFile: string | null; }) {
  return `pr-open: REFUSED -- a READY pull request needs a green verify stamp for this head and this body, and ${reading.reasons.join("; ")}. `
    + `Run \`${verifyCommand(bodyFile)}\`, then open again; a DRAFT opens without one. Nothing was sent (a11ign/a11ign#3215).`;
}
