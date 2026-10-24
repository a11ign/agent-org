## What it is

`agent-org onboard` reads like a setup wizard (A11-222). Space ticks and unticks in every list, the filtered one included, and the list's last line says so. The Linear key step is "Connect to Linear": no location question, a hidden key prompt, the key checked against Linear (stubbed in the tests) and stored on `security -i`'s standard input or in a mode-600 file. The clone confirmation lists repositories by name, each clone is one ✓ or ✗ line, the summary is printed once. Plugins are one ✓ or ✗ line in the setup words of `agentOrg.setUp`, a step may add a `summary` line, and onboard ends with `agent-org is set up on this machine.` (or the count of steps to fix) and the `Next:` commands. `--verbose` shows the internal wording.

## What it checks

`prompts.test.ts` drives the real list with key bytes: Space ticks and unticks in the plain and the filtered list (before any arrow key, and never typed into the filter), Enter confirms, each list draws its exact hint line. `plugins/linear/onboard.test.ts` shows "Connect to Linear" on a Mac and on Linux, asks no location question, checks the key with Linear stubbed (accepted, refused and asked again, unreachable), and keeps the key out of every argument. `onboard-repos.test.ts` holds the clone offer to names, one line per clone, the table once, and the commands to `--verbose`. `onboard.test.ts` (the plugin wording, the ending and its `Next:` block, a failing doctor check, the whole flow with the real prompts) and `onboard-demo.test.ts` (onboard as a process over a scratch HOME with Linear stubbed) need the project's history, which the acceptance job lacks; they run in CI's `suite` job.

Acceptance:
```bash
npx rstest run --config scripts/rstest/rstest.config.ts src/install/prompts.test.ts src/install/onboard-output.test.ts src/install/onboard-repos.test.ts plugins/linear/onboard.test.ts plugins/github/onboard.test.ts plugins/tailscale/onboard.test.ts src/plugins/registry.test.ts
```

Consumer-declaration: none -- no option is added to a project declaration; `--verbose` is a new flag of `onboard` and `agentOrg.setUp` and `StepResult.summary` are optional.
