import path from "node:path";

import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import tsconfigPaths from "vite-tsconfig-paths";
import { defineConfig } from "vitest/config";

// Mirrors here.build/saas/server/api/vitest.config.ts — the minimal subset the toy needs.
export default defineConfig({
  plugins: [
    tsconfigPaths({ ignoreConfigErrors: true }),
    cloudflareTest({
      main: path.resolve(import.meta.dirname, "src/worker.ts"),
      wrangler: {
        configPath: path.resolve(import.meta.dirname, "wrangler.toml"),
        environment: "production",
      },
      miniflare: {
        compatibilityDate: "2026-03-17",
        compatibilityFlags: [
          "nodejs_compat",
          // The pool ships the test bundle over one WS frame; default 1 MiB is too small
          // for the model + plexus deps. Raises the cap to 128 MiB (see api's config).
          "increase_websocket_message_size",
        ],
        durableObjects: {
          TOY_PROJECT: "ToyProjectDO",
          TOY_LOG: "ToyLogDO",
        },
      },
    }),
  ],
  test: {
    globals: true,
    include: ["src/__tests__/**/*.test.ts"],
    testTimeout: 20000,
  },
  resolve: {
    conditions: ["workerd", "worker", "browser"],
  },
  ssr: {
    // workerd can't resolve tslib's bare specifier from nested dist — bundle it.
    noExternal: ["tslib"],
  },
});
