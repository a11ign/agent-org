import { fileURLToPath } from "node:url";
import { defineToolchainConfig } from "@a11ign/toolchain/rstest-config";

const root = fileURLToPath(new URL("./", import.meta.url));

// The toolchain's shared config (ADR 0043) is the base, run from `ui/`. Three projects share it, each with its own files and environment:
//   components: the React islands, in a DOM (happy-dom);
//   node:       the dev proxy, the config and the harness's own checks;
//   pages:      the built site driven in Chromium (`*.page.test.ts`), which refuses to start before `pnpm ui:build`.
// What the toolchain sets for every test and a project does not inherit.
const project = { root, globals: true, testTimeout: 30_000, hookTimeout: 60_000 };

export default {
  ...defineToolchainConfig({ root, include: ["src/**/*.test.{ts,tsx}", "dev/**/*.test.ts", "test/**/*.test.ts"] }),
  projects: [
    { name: "components", ...project, include: ["src/**/*.test.{ts,tsx}"], setupFiles: ["./test/clear-tab-storage.ts"], testEnvironment: "happy-dom", tools: { swc: { jsc: { transform: { react: { runtime: "automatic" } } } } } },
    { name: "node", ...project, include: ["dev/**/*.test.ts", "test/**/*.test.ts"], exclude: ["test/**/*.page.test.ts"], testEnvironment: "node" },
    { name: "pages", ...project, include: ["test/**/*.page.test.ts"], testEnvironment: "node" },
  ],
};
