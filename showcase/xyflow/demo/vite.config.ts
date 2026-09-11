import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

function findPkg(name: string): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    const candidate = join(dir, "node_modules", name);
    if (existsSync(join(candidate, "package.json"))) return candidate;
    dir = dirname(dir);
  }
  throw new Error(`cannot find ${name}`);
}

const yjs = findPkg("yjs");
const mobx = findPkg("mobx");
const xyflow = findPkg("@xyflow/react");

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
    port: 5174,
    proxy: {
      "/docs": { target: "http://127.0.0.1:8788", ws: true },
    },
  },
  esbuild: { target: "es2022", tsconfigRaw },
  optimizeDeps: {
    include: ["@xyflow/react"],
    exclude: ["@here.build/plexus-xyflow", "@here.build/plexus-xyflow-models"],
    esbuildOptions: { tsconfigRaw },
  },
  worker: { format: "es" },
  resolve: {
    dedupe: ["yjs", "mobx", "@xyflow/react", "@here.build/plexus", "@here.build/y-messageport"],
    alias: { yjs, mobx, "@xyflow/react": xyflow },
  },
  test: {
    environment: "node",
  },
});
