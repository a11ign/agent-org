import react from "@astrojs/react";
import type { AstroIntegration } from "astro";
import { defineConfig } from "astro/config";
import { fileURLToPath } from "node:url";
import { instanceProxy, runRemoteInfo } from "./dev/instance-proxy.ts";

const CHECKOUT = fileURLToPath(new URL("../", import.meta.url));

// The dev server only: `/api/*` goes to this machine's instance, with its key, so a page can be built against live data. A build has no server and no proxy.
const instanceApi: AstroIntegration = {
  name: "instance-api",
  hooks: {
    "astro:server:setup": ({ server }) => {
      const proxy = instanceProxy(runRemoteInfo(CHECKOUT));
      server.middlewares.use(proxy.handle);
      proxy.warm();
    },
  },
};

// Static output, no adapter: the instance's own server (`ui-server.ts`) is the only server, and it serves `dist/` under `/next` (A11-190).
export default defineConfig({
  output: "static",
  base: "/next",
  integrations: [react(), instanceApi],
});
