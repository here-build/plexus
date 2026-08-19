import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    testTimeout: 180_000,
    hookTimeout: 180_000,
    include: ["src/__benchmarks__/**/*.test.ts"],
  },
});
