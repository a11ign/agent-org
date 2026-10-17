Closes a11ign/agent-org#1713

Acceptance: grep -q "a pull request in another repository of the row's Region satisfies the stop" src/worker-stop-hook.test.ts && node_modules/.bin/rstest run --config scripts/rstest/rstest.config.ts src/worker-stop-hook.test.ts

Mutation: the cross-repository loop never satisfies (`if (listed.some(ownedByRow))` forced false): the cross-repository test and the twin that reads the unnamed repository fail, 1 of 20 tests red. The loop also asks a repository the Region does not name (`"a11ign/unnamed"` prepended to the repositories asked): 3 of 20 red, the unnamed-repository refusal among them, on its read list. Each restored and confirmed byte-identical with cmp. Before the change (the original hook, the new tests): 4 of 20 fail, the own-tracker test passing as it does today.
