import { createRequire } from "node:module";

import { defineConfig } from "vitest/config";

const require = createRequire(import.meta.url);
const yjs = require.resolve("yjs");
const mobx = require.resolve("mobx");

const tsconfigRaw = {
  compilerOptions: {
    target: "ES2022",
    experimentalDecorators: false,
    useDefineForClassFields: true,
  },
};

export default defineConfig({
  esbuild: { target: "es2022", tsconfigRaw },
  resolve: {
    dedupe: ["yjs", "mobx", "@here.build/plexus"],
    alias: { yjs, mobx },
  },
  test: {
    environment: "node",
  },
});
