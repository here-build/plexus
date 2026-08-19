import { defineConfig } from "vitest/config";

const tsconfigRaw = {
  compilerOptions: {
    target: "ES2022",
    experimentalDecorators: false,
    useDefineForClassFields: true,
  },
};

export default defineConfig({
  esbuild: { target: "es2022", tsconfigRaw },
  test: { environment: "node" },
});
