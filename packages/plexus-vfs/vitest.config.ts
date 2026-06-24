import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/__tests__/**/*.test.ts"],
    // Deterministic Plexus UUID minting — the iso-git Stats `ino` derives from
    // each entity's PlexusUUID, so reproducibility requires the seeded counter.
    env: { PLEXUS_UUID_MODE: "arbitrary" },
  },
});
