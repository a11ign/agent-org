// no-token: none -- runs the real `pr:hold` over the fake code host in a child process; the child has no `gh` on its PATH and starts none
// A test-support module (A11-160, step 9): RUN THE REAL `pr:hold` COMMAND OVER THE FAKE CODE HOST. A test says which pull requests, rows and labels each repository holds (and which write is refused), runs the command
// with a command line, and reads what it said, how it ended, which operations of the code host it asked (with the repository each named) and what each repository holds afterwards. It stubs no `gh` answer: the
// child (`pr-hold-cli-child.test.support.ts`) installs the fake code host, so what the command DECIDES is what is read, and how GitHub words its answers and which argument lists are built are the plugin's own tests
// (`plugins/github/rows/pullwork-rows.test.ts`).
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { HOME_CHECKOUT, PROJECT_DECLARATION_PATH } from "../../project-config.ts";

const CHILD = fileURLToPath(new URL("./pr-hold-cli-child.test.support.ts", import.meta.url));
const CLI = fileURLToPath(new URL("../../pr-hold.ts", import.meta.url));

/** A pull request one repository holds. `closes` are the rows it closes: by number in its own repository (`1300`), or as `owner/repo#number` in another. */
export type HoldPull = { labels?: string[]; comments?: string[]; armed?: boolean; body?: string; closes?: (number | string)[] };
/** A row: in the repository itself by its number (`"1325"`), in another by `owner/repo#number`. */
export type HoldRow = { state?: "OPEN" | "CLOSED"; labels?: string[]; body?: string; comments?: string[] };

export type HoldRepoSpec = {
  pulls?: Record<string | number, HoldPull>;
  rows?: Record<string | number, HoldRow>;
  /** The labels the repository holds: a label added that is not among them is refused as `not found` unless the caller asked for it to be made. Absent: the repository holds every label. */
  repoLabels?: string[];
  /** A write refused with this message, named as the fake notes it (`editHeldPullLabel #9001 add hold:worker-judge`). */
  refuse?: Record<string, string>;
  /** Pull requests GitHub lists as closing a row (`owner/repo#number`) that cannot be read. */
  closingUnread?: Record<string, { number: number; repo: string }[]>;
};

/** `home` is the repository a call that names none is aimed at; `repos` is one fake world for each repository the command may be aimed at. */
export type HoldSpec = { home: string; repos: Record<string, HoldRepoSpec> };

/** The project the command reads its declared repositories from: the first, and each other repository by its key. */
export type HoldProject = { first: string; keyed: Record<string, string> };

export type HoldRepoAfter = { pulls: Record<number, { labels: string[]; comments: string[]; armed: boolean }>; repoLabels: string[] | null; written: string[] };
export type HoldRun = { status: number | null; stdout: string; stderr: string; asked: string[]; repos: Record<string, HoldRepoAfter> };

/** The host's own declaration with `tracker` and `code` replaced, so the keys the test names are declared exactly as the first repository is; returns the host file. */
export function declareProject(dir: string, { first, keyed }: HoldProject): string {
  mkdirSync(join(dir, ".agent-org"), { recursive: true });
  const own = JSON.parse(readFileSync(join(HOME_CHECKOUT, PROJECT_DECLARATION_PATH), "utf8")) as Record<string, unknown>;
  writeFileSync(join(dir, PROJECT_DECLARATION_PATH), JSON.stringify({ ...own, tracker: [{ key: "", repo: first, board: { owner: "a11ign", number: 1 } }],
    code: [{ key: "", repo: first }, ...Object.entries(keyed).map(([key, repo]) => ({ key, repo }))] }));
  const host = join(dir, ".agent-org", "host.json");
  writeFileSync(host, JSON.stringify({ schema: 1, home: dir, binDir: dir, primary: "fx", tool: dir, projects: [{ id: "fx", checkout: dir }] }));
  return host;
}

/** Runs `pr-hold.ts` with `argv` over the fake code host `spec` describes, in the project `project` declares. */
export function holdOverFake(project: HoldProject, spec: HoldSpec, ...argv: string[]): HoldRun {
  const dir = mkdtempSync(join(tmpdir(), "pr-hold-fake-"));
  try {
    const out = join(dir, "after.json");
    writeFileSync(join(dir, "spec.json"), JSON.stringify({ ...spec, cli: CLI, out }));
    // The PATH holds no `gh`: a command that reached for one would fail where it stands instead of reaching GitHub.
    const result = spawnSync(process.execPath, [CHILD, ...argv], { encoding: "utf8",
      env: { PATH: dir, HOME: dir, PR_HOLD_FAKE_SPEC: join(dir, "spec.json"), AGENT_ORG_HOST: declareProject(dir, project) } });
    const after = JSON.parse(readFileSync(out, "utf8")) as Pick<HoldRun, "asked" | "repos">;
    return { status: result.status, stdout: result.stdout, stderr: result.stderr, ...after };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
