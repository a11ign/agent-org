"agent-org": patch

`pnpm test` refuses from a standalone clone. It ran the suite there, and most of its files need the project laid around them, so it printed a red count that CI never shows. The script is now `scripts/test-entry.ts`: it names CI's laid-out command and the narrow form that works in a clone, and inside a laid project it runs the suite as before.
