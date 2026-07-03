/**
 * Varianced test config — THIS IS THE DEFAULT `pnpm test` for plexus.
 *
 * Historically ran the suite under two UUID modes (feistel/arbitrary); the
 * arbitrary axis was retired in 2026-07 (UUIDs are feistel-only now — test
 * determinism comes from `.localID`/`resetLocalIDs()` instead). The file and
 * script wiring stay so a future variance axis (e.g. a yjs major, an
 * alternative clock) drops in as another project entry.
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "feistel",
          globals: true,
          environment: "node",
          include: ["src/__tests__/**/*.test.{ts,tsx}"],
          // A test that throws between vi.spyOn and its explicit mockRestore
          // must not leak the spy into later tests.
          restoreMocks: true,
        },
      },
    ],
  },
});
