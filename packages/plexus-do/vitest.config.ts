import path from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const packageDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "cloudflare:workers": path.resolve(packageDir, "src/__tests__/stubs/cloudflare-workers.ts"),
    },
  },
  test: {
    globals: true,
    environment: "node",
    include: ["src/__tests__/**/*.test.ts"],
    setupFiles: [path.resolve(packageDir, "src/__tests__/setup.ts")],
  },
});