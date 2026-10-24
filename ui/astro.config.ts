import react from "@astrojs/react";
import type { AstroIntegration } from "astro";
import { defineConfig } from "astro/config";
import { fileURLToPath } from "node:url";
import { instanceProxy, runRemoteInfo } from "./dev/instance-proxy.ts";
import { BASE } from "./src/shell/routes.ts";

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
  base: BASE,
  // The instance serves its pages under a content security policy whose `style-src` is `'unsafe-inline'` alone (`PAGE_CSP` in `ui-server.ts`), which blocks a linked stylesheet. So every page carries its
  // styles inline. The fonts they name are the page's own files, which `default-src 'self'` allows.
  build: { inlineStylesheets: "always" },
  // Vite would put a font small enough (under 4kB) into the stylesheet as a `data:` address, which the same policy refuses for a font (`font-src` falls back to `default-src 'self'`). So no asset is inlined.
  vite: { build: { assetsInlineLimit: 0 } },
  integrations: [react(), instanceApi],
});
