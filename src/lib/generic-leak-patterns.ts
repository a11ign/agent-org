// @ts-check
// THE TWO LEAK PATTERNS TRUE OF ANY PUBLIC REPOSITORY, in a file that imports NOTHING (#3039). `leak-patterns.ts` imports `project-config.mjs`,
// which refuses at import when the tool is in no project (`AGENT_ORG_HOST` unset and no declaration beside it), and this repository's own `gate`
// runs `.github/scripts/leak-scan.ts` BEFORE any project exists: a scan that needs only these two must not need a project to import them.

/**
 * The two patterns true of any public repository. The IPv4 branches each spell a FULL four-octet shape: an earlier form required only three
 * for the bare-`10` branch and matched an Intel driver INF's platform-version decoration and ordinary npm semver, neither of which is an address.
 * @type {ReadonlyArray<{ name: string; pattern: RegExp }>}
 */
export const GENERIC_LEAK_PATTERNS: ReadonlyArray<{ name: string; pattern: RegExp; }> = Object.freeze([
  { name: "private LAN IPv4 address", pattern:
    /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b/ },
  { name: "a named SSH private key file", pattern: /~?\/?\.ssh\/[\w.-]+_ed25519\b|~?\/?\.ssh\/id_\w+\b/ },
]);
