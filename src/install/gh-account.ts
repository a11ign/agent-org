// module: the GitHub CLI as an account, for the calls onboard still makes itself -- the clone of a repository, and the install of the conventions plugin (A11-160)
//
// The stacking extension's install and checks moved into `plugins/github` with the rest of the code host's code; these two are not ticket mode's, and stay here until the calls that
// need them move (the last step of A11-160). The runner is the instance's own (`defaultGh`, which spawns): `asAccount` sets the account for the one call it makes.

/** A program's answer: a null status when it could not start, and its output otherwise. */
export type Program = { status: number | null; stdout: string; stderr: string };
/** Runs the GitHub CLI with `args`, and answers what it printed. */
export type ProgramRunner = (args: string[]) => Program;
/** The account a runner acts as: its config directory, when the host names one (`GH_CONFIG_DIR`). */
export type Account = Readonly<{ GH_CONFIG_DIR?: string }>;

/**
 * A runner that acts as `account`, from a runner that throws on a failure (`defaultGh`). The directory is set on this process's environment for the one call, and put back after it: the
 * call is synchronous, so nothing else runs in between. A failure is its status and its error output, and never a throw.
 */
export function asAccount(run: (args: string[]) => string, account: Account): ProgramRunner {
  return (args) => {
    const saved = process.env.GH_CONFIG_DIR;
    if (account.GH_CONFIG_DIR !== undefined) process.env.GH_CONFIG_DIR = account.GH_CONFIG_DIR;
    try {
      return { status: 0, stdout: run(args), stderr: "" };
    } catch (err) {
      const failure = err as { status?: number | null; stderr?: string | Buffer; message?: string };
      return { status: failure.status ?? null, stdout: "", stderr: String(failure.stderr || failure.message || "") };
    } finally {
      if (saved === undefined) delete process.env.GH_CONFIG_DIR;
      else process.env.GH_CONFIG_DIR = saved;
    }
  };
}
