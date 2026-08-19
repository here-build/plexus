import { createRequire } from "node:module";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const require = createRequire(import.meta.url);
const yjs = require.resolve("yjs");
const mobx = require.resolve("mobx");

/** Stage-3 only. esbuild reads this; `experimentalDecorators` off is the pin. */
const tsconfigRaw = {
  compilerOptions: {
    target: "ES2022",
    experimentalDecorators: false,
    useDefineForClassFields: true,
    jsx: "react-jsx",
  },
};

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/docs": { target: "http://127.0.0.1:8787", ws: true },
    },
  },
  // Do not add @babel/plugin-proposal-decorators. Even `version: "2023-11"`
  // rewrites accessors and breaks @syncing / MobX @computed. es2022 makes
  // esbuild lower TC39 decorators instead of passing them through as esnext.
  esbuild: { target: "es2022", tsconfigRaw },
  optimizeDeps: { esbuildOptions: { tsconfigRaw } },
  worker: { format: "es" },
  resolve: {
    // Plexus throws if a second yjs copy constructs the Doc.
    dedupe: ["yjs", "mobx", "@here.build/plexus", "@here.build/y-messageport"],
    alias: { yjs, mobx },
  },
  test: {
    environment: "node",
  },
});
