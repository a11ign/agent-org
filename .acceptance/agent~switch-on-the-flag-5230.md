Switch on the flag of agent-org#1180 (a11ign#5230): `CI_RERUN_ON_5XX.enabled` is `true`, so a required check red on a GitHub 5xx is rerun once by default. The explicit `{ enabled: false }` passed to `rerunRedOn5xx` is today's route, and it still passes its own test.

Acceptance: `node --test src/ci-rerun-on-5xx.test.ts`
