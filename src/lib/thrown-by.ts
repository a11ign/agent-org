// no-token: none -- catches what a call throws; nothing here reaches `gh`, `herdr` or `git`
/** What `spawn` threw, or `undefined` when it returned: the exit status and stderr of a child that failed. */
export function thrownBy(spawn: () => unknown): { status?: number, stderr?: string } | undefined {
  try {
    spawn();
    return undefined;
  } catch (cause) {
    return cause as { status?: number, stderr?: string };
  }
}
