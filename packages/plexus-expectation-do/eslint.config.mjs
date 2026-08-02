import { shared } from "@here.build/eslint-configs";

export default [
  // Tooling configs aren't in the tsconfig program (same as plexus-expectation).
  { ignores: ["dist/*", "node_modules/*", "vitest.config.ts", "eslint.config.mjs"] },
  ...shared,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
  },
  {
    files: ["src/__tests__/**/*.ts"],
    rules: {
      "no-console": "off",
      "sonarjs/no-nested-functions": "off",
      "sonarjs/no-element-overwrite": "off",
      "sonarjs/constructor-for-side-effects": "off",
      "sonarjs/no-unused-vars": "off",
      "sonarjs/no-dead-store": "off",
      "sonarjs/no-alphabetical-sort": "off",
      "unicorn/no-useless-undefined": "off",
      // Side-effect mobx register must run first; import-x wants package root first.
      "import-x/order": "off",
    },
  },
];
