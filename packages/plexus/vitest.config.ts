import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Regular test configuration
    globals: true,
    environment: "node",
    include: ["src/__tests__/**/*.test.{ts,tsx}"],
    // A test that throws between vi.spyOn and its explicit mockRestore
    // must not leak the spy into later tests.
    restoreMocks: true,
  }
});
